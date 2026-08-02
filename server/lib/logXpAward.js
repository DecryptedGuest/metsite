// server/lib/logXpAward.js
// XP awarded automatically when a patrol or event log is signed off.
//
// This is the single biggest source of manual /xp work, and the one place where
// forgetting has a cost somebody notices — "did anyone remember to award us"
// is a question nobody should have to ask. Ticking the log IS the award.
//
// The rules, exactly:
//
//   EVENT   every attendee gets EVENT_ATTENDEE_XP (2). The HOST gets none —
//           hosting is already worth a point on the FLP database, and paying
//           somebody XP for running an event they also attend is how you get
//           people hosting events for themselves. The MET database point per
//           attendee is unchanged and still written by awardEventPoints().
//   PATROL  the officer who filed it gets one XP per PATROL_XP_MINUTES (30) of
//           patrol, ROUNDED UP — 45 minutes is 2, not 1. Partial time counts;
//           the officer was on duty for it.
//
// Who can trigger it:
//
//   · the approver must hold the FLP officer role. Anybody can tick a log — the
//     sign-off system is deliberately open — but a tick from somebody with no
//     standing must not move XP.
//   · the approver must not be the host, and must not be whoever filed the log.
//     Signing off your own event to pay your own attendees is one step from
//     signing off your own patrol.
//
// Everything here is best-effort and never throws: an XP award failing must not
// leave a log unsigned.

const prisma = require('./db');
const XP = require('./xp');

const EVENT_ATTENDEE_XP = () => {
  const n = parseInt(process.env.EVENT_ATTENDEE_XP || '2', 10);
  return Number.isFinite(n) ? n : 2;
};
const PATROL_XP_MINUTES = () => {
  const n = parseInt(process.env.PATROL_XP_MINUTES || '30', 10);
  return Number.isFinite(n) && n > 0 ? n : 30;
};

/**
 * XP for a patrol of `minutes`. One per block, rounding UP: an officer who
 * patrolled 31 minutes did more than one block's work, and rounding down would
 * pay them for less time than they served. 0 and negatives pay nothing rather
 * than throwing.
 */
function patrolXpFor(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m) || m <= 0) return 0;
  return Math.ceil(m / PATROL_XP_MINUTES());
}

/**
 * May this approver's tick move XP?
 *
 * @param {object} o
 * @param {string[]|null} o.roleIds  the approver's roles, or null if unknown
 * @param {string} o.approverId
 * @param {object} o.log
 * @returns {{ ok: boolean, why: string|null }}
 */
function canAward({ roleIds, approverId, log }) {
  if (!approverId) return { ok: false, why: 'no approver' };
  // Unknown roles are not permission. A tick we cannot attribute to somebody
  // with standing does not pay out.
  if (!Array.isArray(roleIds)) return { ok: false, why: "couldn't read the approver's roles" };

  const allowed = require('./xpCommand').xpRoleIds().map(String);
  const held = roleIds.map(String);
  if (!allowed.some(r => held.includes(r))) return { ok: false, why: 'approver is not an FLP officer' };

  if (log && log.submitterDiscordId && String(log.submitterDiscordId) === String(approverId)) {
    return { ok: false, why: 'approver filed the log' };
  }
  const host = log && log.eventMeta && log.eventMeta.host;
  if (host && host.id && String(host.id) === String(approverId)) {
    return { ok: false, why: 'approver hosted the event' };
  }
  return { ok: true, why: null };
}

/**
 * Who gets what for this log, before anything is written. Separated from the
 * paying so the panel and the tests can ask "what would this do".
 * @returns {Array<{ discordId: string, amount: number, reason: string, name: string|null }>}
 */
function plannedAwards(log) {
  if (!log) return [];

  if (log.type === 'EVENT') {
    const meta = log.eventMeta || {};
    const hostId = (meta.host && meta.host.id) || null;
    const seen = new Set();
    const out = [];
    for (const a of (Array.isArray(meta.attendees) ? meta.attendees : [])) {
      if (!a || !a.id) continue;                       // no Discord id, no XP row to move
      if (hostId && String(a.id) === String(hostId)) continue;   // the host is not an attendee
      const key = String(a.id);
      if (seen.has(key)) continue;                     // listed twice is still one person
      seen.add(key);
      out.push({
        discordId: key,
        amount: EVENT_ATTENDEE_XP(),
        reason: `Attended ${meta.eventType ? String(meta.eventType).slice(0, 60) : 'an event'}`,
        name: a.nickname || a.roblox || a.discordUsername || null,
      });
    }
    return out;
  }

  // PATROL — the officer who filed it.
  const amount = patrolXpFor(log.totalMinutes);
  if (!amount || !log.submitterDiscordId) return [];
  return [{
    discordId: String(log.submitterDiscordId),
    amount,
    reason: `Patrol — ${log.totalMinutes} min`,
    name: log.submitterDisplayName || log.submitterUsername || null,
  }];
}

/**
 * Pay the awards for an approved log.
 *
 * @param {object} log            the PatrolLog row
 * @param {object} approver       { id, name, roleIds }
 * @param {object} [opts]
 * @param {boolean} [opts.persist=true] write xpAwarded/xpAward back onto the log
 * @returns {Promise<{
 *   ok: boolean, skipped: string|null,
 *   awarded: Array<{discordId,amount,after,promoted,ok,error}>,
 *   total: number,
 * }>}
 */
async function awardForLog(log, approver, opts = {}) {
  const out = { ok: false, skipped: null, awarded: [], total: 0 };
  if (!log) { out.skipped = 'no log'; return out; }
  if (log.xpAwarded) { out.skipped = 'already awarded'; return out; }

  const gate = canAward({
    roleIds: approver && approver.roleIds,
    approverId: approver && approver.id,
    log,
  });
  if (!gate.ok) { out.skipped = gate.why; return out; }

  const plan = plannedAwards(log);
  if (!plan.length) { out.skipped = 'nothing to award'; return out; }

  for (const p of plan) {
    try {
      const res = await XP.applyXp({
        discordId: p.discordId,
        kind: 'ADD',
        value: p.amount,
        reason: p.reason,
        issuedById: approver && approver.id,
        issuedBy: (approver && approver.name) || 'Log sign-off',
      });
      out.awarded.push({
        discordId: p.discordId, name: p.name, amount: p.amount,
        after: res && res.after, promoted: !!(res && res.promotion), ok: true, error: null,
      });
      out.total += p.amount;
      // Announce it the same way a manual award is announced, so the XP log is
      // one history rather than "the ones somebody typed" and "the silent ones".
      await announce(res, p, approver, log).catch(() => {});
    } catch (err) {
      out.awarded.push({ discordId: p.discordId, name: p.name, amount: p.amount, ok: false, error: err.message });
    }
  }

  out.ok = out.awarded.some(a => a.ok);

  if (opts.persist !== false) {
    try {
      await prisma.patrolLog.update({
        where: { id: log.id },
        data: {
          xpAwarded: out.ok,
          xpAward: {
            at: new Date().toISOString(),
            by: (approver && approver.id) || null,
            byName: (approver && approver.name) || null,
            total: out.total,
            people: out.awarded.map(a => ({ id: a.discordId, name: a.name, xp: a.amount, ok: a.ok })),
          },
        },
      });
    } catch (e) { /* the XP is already given; a failed stamp must not undo it */ }
  }

  return out;
}

// Post the change to the XP log channel, and run the promotion if it crossed
// one. An automatic award has to promote exactly the way a typed one does —
// otherwise the officer whose event pushed them over a threshold is left
// holding the XP for a rank nobody gave them.
async function announce(res, p, approver, log) {
  if (!res) return;
  const xpLog = require('./xpLog');
  await xpLog.logChange({
    discordId: p.discordId,
    memberName: p.name,
    kind: 'ADD',
    delta: p.amount,
    before: res.before,
    after: res.after,
    reason: `${p.reason} · ${log.type === 'EVENT' ? 'event' : 'patrol'} log signed off`,
    rank: res.rank,
    issuedById: approver && approver.id,
    issuedBy: (approver && approver.name) || 'Log sign-off',
  }).catch(() => {});

  if (!res.promotion) return;
  try {
    const XC = require('./xpCommand');
    const officer = await XC.loadOfficer(p.discordId, null);
    await XC.promote({
      officer, promotion: res.promotion, xp: res.after,
      issuedById: approver && approver.id,
      issuedBy: (approver && approver.name) || 'Log sign-off',
    });
  } catch (e) {
    console.warn('[LogXP] promotion after an automatic award failed:', e.message);
  }
}

module.exports = {
  awardForLog, plannedAwards, canAward, patrolXpFor,
  EVENT_ATTENDEE_XP, PATROL_XP_MINUTES,
};
