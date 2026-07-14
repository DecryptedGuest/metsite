// server/lib/cad/dispatch.service.js
// The CAD state machine: incidents, assignment, on-scene, updates, closure and
// urgent-assistance (backup). PURE — no discord.js. Every method returns a typed
// result and logs to the incident timeline. Injectable prisma for testing.
const { ok, err } = require('./result');
const { normCallsign } = require('./units.service');

const GRADES = ['I', 'S', 'E', 'R'];
const GRADE_RANK = { I: 0, S: 1, E: 2, R: 3 }; // I = most urgent

function pad3(n) { return String(n).padStart(3, '0'); }
function refPrefix(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `INC-${y}${m}${day}-`;
}

function createDispatchService(prisma) {
  // Next daily CAD reference (INC-YYYYMMDD-NNN). Computed from today's existing
  // refs; retried on the unique constraint so concurrent creates don't collide.
  async function nextCadRef(now = new Date()) {
    const prefix = refPrefix(now);
    const todays = await prisma.cadIncident.findMany({
      where: { cadRef: { startsWith: prefix } }, select: { cadRef: true },
    });
    let max = 0;
    for (const t of todays) { const n = parseInt(t.cadRef.slice(prefix.length), 10); if (Number.isFinite(n) && n > max) max = n; }
    return prefix + pad3(max + 1);
  }

  async function log(incidentId, type, message, unitId = null) {
    try { await prisma.cadIncidentLog.create({ data: { incidentId, unitId, type, message: String(message).slice(0, 1000) } }); }
    catch (e) { /* logging is best-effort */ }
  }

  async function findIncident(ref) {
    const r = String(ref || '').trim().toUpperCase();
    if (!r) return null;
    return prisma.cadIncident.findUnique({ where: { cadRef: r } })
      .catch(() => null)
      || prisma.cadIncident.findFirst({ where: { cadRef: { endsWith: r } } }).catch(() => null);
  }

  // Create an incident. Grade must be I/S/E/R. Retries the ref on a race.
  async function createIncident({ grade, location, category, description, createdById = null, createdByName = null }) {
    const g = String(grade || '').trim().toUpperCase();
    if (!GRADES.includes(g)) return err('BAD_GRADE', 'Grade must be one of I, S, E or R.');
    if (!location) return err('NO_LOCATION', 'A location is required.');
    if (!category) return err('NO_CATEGORY', 'A category is required.');
    for (let attempt = 0; attempt < 4; attempt++) {
      const cadRef = await nextCadRef();
      try {
        const incident = await prisma.cadIncident.create({
          data: {
            cadRef, grade: g, category: String(category).slice(0, 120),
            location: String(location).slice(0, 200), description: String(description || '').slice(0, 1000),
            status: 'OPEN', createdById, createdByName,
          },
        });
        await log(incident.id, 'CREATED', `Incident created — Grade ${g}, ${category} at ${location}.`);
        return ok({ incident });
      } catch (e) {
        if (String(e.code) === 'P2002' && attempt < 3) continue; // ref collision → retry
        return err('CREATE_FAILED', 'Could not create the incident.');
      }
    }
    return err('CREATE_FAILED', 'Could not allocate a CAD reference.');
  }

  // Assign a unit to an incident: unit → EN_ROUTE, incident → ASSIGNED.
  async function assign({ ref, callsign }) {
    const incident = await findIncident(ref);
    if (!incident) return err('NO_INCIDENT', `No incident found for ${ref}.`);
    if (incident.status === 'CLOSED') return err('CLOSED', `${incident.cadRef} is already closed.`);
    const unit = await prisma.cadUnit.findUnique({ where: { callsign: normCallsign(callsign) } });
    if (!unit || unit.status === 'OFF_DUTY') return err('NO_UNIT', `${normCallsign(callsign)} is not booked on.`);

    await prisma.cadUnit.update({ where: { id: unit.id }, data: { status: 'EN_ROUTE', currentIncidentId: incident.id, lastStatusAt: new Date() } });
    const updated = await prisma.cadIncident.update({ where: { id: incident.id }, data: { status: incident.status === 'OPEN' ? 'ASSIGNED' : incident.status } });
    await log(incident.id, 'ASSIGNED', `${unit.callsign} assigned and shown en route.`, unit.id);
    return ok({ incident: updated, unit });
  }

  // A unit arrives: unit → ON_SCENE, incident → ON_SCENE.
  async function onScene({ callsign, discordUserId, ref = null }) {
    let unit = null;
    if (callsign) unit = await prisma.cadUnit.findUnique({ where: { callsign: normCallsign(callsign) } });
    else if (discordUserId) unit = await prisma.cadUnit.findFirst({ where: { discordUserId: String(discordUserId), status: { not: 'OFF_DUTY' } } });
    if (!unit || unit.status === 'OFF_DUTY') return err('NO_UNIT', 'You are not booked on.');
    const incidentId = unit.currentIncidentId || (ref ? (await findIncident(ref) || {}).id : null);
    await prisma.cadUnit.update({ where: { id: unit.id }, data: { status: 'ON_SCENE', currentIncidentId: incidentId || unit.currentIncidentId, lastStatusAt: new Date() } });
    let incident = null;
    if (incidentId) {
      incident = await prisma.cadIncident.update({ where: { id: incidentId }, data: { status: 'ON_SCENE' } }).catch(() => null);
      await log(incidentId, 'ON_SCENE', `${unit.callsign} on scene.`, unit.id);
    }
    return ok({ unit, incident });
  }

  // Free-text update logged against an incident.
  async function updateIncident({ ref, message, callsign = null }) {
    const incident = await findIncident(ref);
    if (!incident) return err('NO_INCIDENT', `No incident found for ${ref}.`);
    let unitId = null;
    if (callsign) { const u = await prisma.cadUnit.findUnique({ where: { callsign: normCallsign(callsign) } }); unitId = u ? u.id : null; }
    await log(incident.id, 'UPDATE', String(message || '').slice(0, 1000), unitId);
    return ok({ incident });
  }

  // Close an incident: free every attached unit, stamp the outcome.
  async function closeIncident({ ref, outcome }) {
    const incident = await findIncident(ref);
    if (!incident) return err('NO_INCIDENT', `No incident found for ${ref}.`);
    if (incident.status === 'CLOSED') return err('CLOSED', `${incident.cadRef} is already closed.`);
    const attached = await prisma.cadUnit.findMany({ where: { currentIncidentId: incident.id } });
    await prisma.cadUnit.updateMany({ where: { currentIncidentId: incident.id }, data: { status: 'AVAILABLE', currentIncidentId: null, lastStatusAt: new Date() } });
    const updated = await prisma.cadIncident.update({ where: { id: incident.id }, data: { status: 'CLOSED', closedAt: new Date(), closedOutcome: String(outcome || '').slice(0, 300) || null } });
    await log(incident.id, 'CLOSED', `Incident closed${outcome ? ` — ${outcome}` : ''}. ${attached.length} unit(s) released.`);
    return ok({ incident: updated, released: attached });
  }

  // Open incidents, ordered by grade (I→R) then oldest first.
  async function listOpen() {
    const incidents = await prisma.cadIncident.findMany({ where: { status: { not: 'CLOSED' } } });
    incidents.sort((a, b) => (GRADE_RANK[a.grade] - GRADE_RANK[b.grade]) || (new Date(a.createdAt) - new Date(b.createdAt)));
    return ok({ incidents });
  }

  // Urgent assistance: mark the unit URGENT_ASSISTANCE and return the details the
  // orchestrator needs to broadcast an all-units alert.
  async function requestBackup({ callsign, discordUserId, location = null }) {
    let unit = null;
    if (callsign) unit = await prisma.cadUnit.findUnique({ where: { callsign: normCallsign(callsign) } });
    else if (discordUserId) unit = await prisma.cadUnit.findFirst({ where: { discordUserId: String(discordUserId), status: { not: 'OFF_DUTY' } } });
    if (!unit || unit.status === 'OFF_DUTY') return err('NO_UNIT', 'You are not booked on.');
    const updated = await prisma.cadUnit.update({ where: { id: unit.id }, data: { status: 'URGENT_ASSISTANCE', lastStatusAt: new Date() } });
    let incident = null;
    if (unit.currentIncidentId) {
      incident = await prisma.cadIncident.findUnique({ where: { id: unit.currentIncidentId } }).catch(() => null);
      await log(unit.currentIncidentId, 'BACKUP', `URGENT ASSISTANCE requested by ${unit.callsign}.`, unit.id);
    }
    const lastLocation = location || (incident && incident.location) || 'last known location unknown';
    return ok({ unit: updated, incident, location: lastLocation });
  }

  async function getIncident(ref) {
    const incident = await findIncident(ref);
    if (!incident) return err('NO_INCIDENT', `No incident found for ${ref}.`);
    const logs = await prisma.cadIncidentLog.findMany({ where: { incidentId: incident.id }, orderBy: { createdAt: 'asc' } });
    const units = await prisma.cadUnit.findMany({ where: { currentIncidentId: incident.id } });
    return ok({ incident, logs, units });
  }

  return {
    nextCadRef, createIncident, assign, onScene, updateIncident, closeIncident,
    listOpen, requestBackup, getIncident, findIncident, GRADES, GRADE_RANK,
  };
}

module.exports = { createDispatchService, GRADES, GRADE_RANK };
