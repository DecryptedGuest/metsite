// server/lib/cad/pnc.service.js
// PNC lookups against the fictional roleplay records. PURE — no discord.js.
// Returns typed results with a `found` flag rather than throwing on a miss.
const { ok } = require('./result');

function normVrm(v) { return String(v || '').trim().toUpperCase().replace(/\s+/g, ''); }

function createPncService(prisma) {
  // Vehicle by VRM (number plate). Whitespace/case-insensitive.
  async function vehicle({ vrm }) {
    const q = normVrm(vrm);
    if (!q) return ok({ found: false, vrm: q, record: null });
    // Match ignoring spaces in the stored VRM too.
    const all = await prisma.cadVehicleRecord.findMany({ where: { vrm: { contains: q.slice(0, 3), mode: 'insensitive' } } }).catch(() => []);
    const record = all.find(r => normVrm(r.vrm) === q)
      || (await prisma.cadVehicleRecord.findFirst({ where: { vrm: { equals: q, mode: 'insensitive' } } }).catch(() => null));
    return ok({ found: !!record, vrm: q, record: record || null });
  }

  // Person by surname (+ optional forename). Returns all matches.
  async function person({ surname, forename = null }) {
    const s = String(surname || '').trim();
    if (!s) return ok({ found: false, records: [] });
    const where = { surname: { equals: s, mode: 'insensitive' } };
    if (forename) where.forename = { equals: String(forename).trim(), mode: 'insensitive' };
    let records = await prisma.cadPersonRecord.findMany({ where, orderBy: [{ surname: 'asc' }, { forename: 'asc' }] }).catch(() => []);
    // Fall back to a surname "contains" search if an exact match found nothing.
    if (!records.length) {
      records = await prisma.cadPersonRecord.findMany({ where: { surname: { contains: s, mode: 'insensitive' } }, take: 10 }).catch(() => []);
    }
    return ok({ found: records.length > 0, records });
  }

  return { vehicle, person, normVrm };
}

module.exports = { createPncService, normVrm };
