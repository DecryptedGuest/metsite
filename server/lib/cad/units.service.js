// server/lib/cad/units.service.js
// Unit (officer) lifecycle: book on/off, status changes, the live board.
// PURE dispatch logic — ZERO discord.js imports — so it can be unit-tested with
// a mocked Prisma and later driven by speech-to-text. Injectable prisma via the
// factory; the app binds the real client in ./services.
const { ok, err } = require('./result');

const STATUSES = ['OFF_DUTY', 'AVAILABLE', 'EN_ROUTE', 'ON_SCENE', 'BUSY', 'MEAL_BREAK', 'URGENT_ASSISTANCE'];
// Board ordering: the states that need attention float to the top.
const STATUS_ORDER = { URGENT_ASSISTANCE: 0, ON_SCENE: 1, EN_ROUTE: 2, BUSY: 3, AVAILABLE: 4, MEAL_BREAK: 5, OFF_DUTY: 6 };

function normCallsign(cs) { return String(cs || '').trim().toUpperCase().replace(/\s+/g, '-'); }

function createUnitsService(prisma) {
  // Find a unit by callsign OR by the Discord user who owns it.
  async function findUnit({ callsign, discordUserId, id } = {}) {
    if (id) return prisma.cadUnit.findUnique({ where: { id } });
    if (callsign) return prisma.cadUnit.findUnique({ where: { callsign: normCallsign(callsign) } });
    if (discordUserId) return prisma.cadUnit.findFirst({ where: { discordUserId: String(discordUserId), status: { not: 'OFF_DUTY' } } });
    return null;
  }

  // Book a unit ON. Ties the callsign to this officer. A callsign already held
  // by a DIFFERENT on-duty officer is refused; the same officer re-booking (or a
  // previously off-duty row) is reactivated.
  async function bookOn({ callsign, discordUserId = null, userId = null, officerName }) {
    const cs = normCallsign(callsign);
    if (!cs) return err('BAD_CALLSIGN', 'A callsign is required, e.g. MP-1.');
    if (!officerName) return err('NO_NAME', 'An officer name is required to book on.');

    const existing = await prisma.cadUnit.findUnique({ where: { callsign: cs } });
    if (existing && existing.status !== 'OFF_DUTY' && discordUserId && existing.discordUserId && existing.discordUserId !== String(discordUserId)) {
      return err('CALLSIGN_TAKEN', `Callsign ${cs} is already booked on by ${existing.officerName}.`);
    }
    // Prevent one officer holding two live callsigns.
    if (discordUserId) {
      const other = await prisma.cadUnit.findFirst({ where: { discordUserId: String(discordUserId), status: { not: 'OFF_DUTY' }, callsign: { not: cs } } });
      if (other) return err('ALREADY_ON', `You are already booked on as ${other.callsign}. Book off first.`);
    }
    const data = {
      callsign: cs, discordUserId: discordUserId ? String(discordUserId) : null, userId: userId || null,
      officerName: String(officerName).slice(0, 80), status: 'AVAILABLE', currentIncidentId: null,
      bookedOnAt: new Date(), lastStatusAt: new Date(),
    };
    const unit = existing
      ? await prisma.cadUnit.update({ where: { callsign: cs }, data })
      : await prisma.cadUnit.create({ data });
    return ok({ unit });
  }

  // Book a unit OFF. Frees any incident it was attached to.
  async function bookOff({ callsign, discordUserId } = {}) {
    const unit = await findUnit({ callsign, discordUserId });
    if (!unit || unit.status === 'OFF_DUTY') return err('NOT_ON', 'You are not booked on.');
    const updated = await prisma.cadUnit.update({
      where: { id: unit.id },
      data: { status: 'OFF_DUTY', currentIncidentId: null, lastStatusAt: new Date() },
    });
    return ok({ unit: updated });
  }

  // Change a unit's status (UK PR-style). URGENT_ASSISTANCE is normally raised
  // via dispatch.requestBackup, but the enum is accepted here too.
  async function setStatus({ callsign, discordUserId, status }) {
    const st = String(status || '').trim().toUpperCase();
    if (!STATUSES.includes(st)) return err('BAD_STATUS', `Unknown status "${status}".`);
    const unit = await findUnit({ callsign, discordUserId });
    if (!unit || unit.status === 'OFF_DUTY') return err('NOT_ON', 'You are not booked on.');
    const data = { status: st, lastStatusAt: new Date() };
    if (st === 'AVAILABLE') data.currentIncidentId = null; // going available clears the current job
    const updated = await prisma.cadUnit.update({ where: { id: unit.id }, data });
    return ok({ unit: updated });
  }

  // The live board: every booked-on unit, ordered by attention then callsign.
  async function board() {
    const units = await prisma.cadUnit.findMany({ where: { status: { not: 'OFF_DUTY' } } });
    units.sort((a, b) => (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) || a.callsign.localeCompare(b.callsign, undefined, { numeric: true }));
    return ok({ units });
  }

  return { findUnit, bookOn, bookOff, setStatus, board, normCallsign, STATUSES };
}

module.exports = { createUnitsService, STATUSES, STATUS_ORDER, normCallsign };
