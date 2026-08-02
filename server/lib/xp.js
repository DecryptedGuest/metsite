// server/lib/xp.js
// The MET XP system: a balance per officer, a ladder, and promotion off it.
//
// The thresholds are TOTALS, not costs. An officer with 15 XP is a Sergeant;
// they don't spend it. So the ladder is a set of bands:
//
//     0 – 1      Community Support Officer  (CSO)
//     2 – 14     Constable                  (CON)
//    15 – 39     Sergeant                   (SGT)
//    40 – 99     Inspector                  (INS)
//   100          Chief Inspector            (CINS)
//
// 100 is also the ceiling. XP exists to promote people up to Chief Inspector,
// so there is nothing above it to earn towards.
//
// XP rank follows GROUP rank, not the other way round. An officer is only a
// Community Support Officer here if that is what they actually are in the
// group; somebody joining the system already ranked starts at the floor of the
// rank they hold, and somebody whose group rank can't be placed on the ladder
// at all is unranked rather than being called a CSO. See rungForGroupRank.
//
// Rank is DERIVED from the balance rather than stored, so changing a threshold
// re-ranks everybody with no backfill. The one thing that is stored is
// `promotedRank` — the rank this system last moved somebody TO — because that
// is what stops the same promotion firing twice, and what stops an officer who
// was already a Sergeant before any of this existed being "promoted" to
// Sergeant the first time they earn a point.
//
// It moves both ways. Gaining XP across a threshold promotes; losing XP back
// across one demotes, in the group and on the record. The one thing a demotion
// will not touch is somebody ranked ABOVE the ladder — see applyGroupRank.
//
// Everything here is free of discord.js so it can be tested without a gateway.
// The panel is xpCommand.js.

const prisma = require('./db');

// ── The ladder ────────────────────────────────────────────────────
// `at` is the total XP needed to hold the rank. `match` finds the Roblox group
// roleset by name — group rank names vary ("Constable", "Police Constable"), so
// it's a pattern rather than an exact string.
const LADDER = [
  { code: 'CSO',  name: 'Community Support Officer', at: 0,   match: /community support officer|\bcso\b/i },
  { code: 'CON',  name: 'Constable',                 at: 2,   match: /(^|[^a-z])constable/i },
  { code: 'SGT',  name: 'Sergeant',                  at: 15,  match: /sergeant|\bsgt\b/i },
  { code: 'INS',  name: 'Inspector',                 at: 40,  match: /(^|[^a-z])inspector/i },
  { code: 'CINS', name: 'Chief Inspector',           at: 100, match: /chief\s*inspector|\bcins\b/i },
];

// Ranks ABOVE the ladder. XP tops out at Chief Inspector, so anyone senior to
// that sits at the ceiling — and recognising them BY NAME matters: the numeric
// fallback below needs an authenticated group-roles call, and when that is
// unavailable a Chief Superintendent was left unplaced on 0 XP. A name is
// always to hand.
const ABOVE_LADDER = /chief superintendent|superintendent|commander|deputy assistant commissioner|assistant commissioner|deputy commissioner|\bcommissioner\b|chief of|\b(csup|sup|comm|dac|acc?|dcc?|cc|cmsr)\b/i;

// Threshold overrides, so the numbers can be tuned without a deploy:
//   XP_THRESHOLDS="CON=2,SGT=15,INS=40,CINS=100"
function ladder() {
  const raw = process.env.XP_THRESHOLDS;
  if (!raw) return LADDER;
  const over = {};
  for (const part of String(raw).split(',')) {
    const [k, v] = part.split('=').map(s => String(s || '').trim());
    const n = parseInt(v, 10);
    if (k && Number.isFinite(n)) over[k.toUpperCase()] = n;
  }
  return LADDER
    .map(r => (over[r.code] != null ? { ...r, at: over[r.code] } : r))
    .sort((a, b) => a.at - b.at);
}

/**
 * The most XP anybody can hold: the top rung's threshold.
 *
 * XP exists to promote people up to Chief Inspector, so 100 (what it takes to
 * make CINS) is the ceiling. There is nothing above it to earn towards, and an
 * uncapped balance would put a Chief Inspector on 4,000 XP with nowhere to go
 * and make the leaderboard meaningless.
 */
function maxXp() {
  const l = ladder();
  return l[l.length - 1].at;
}

/** The rank an officer holds at this XP total. Never null — 0 XP is the bottom rung. */
function rankFor(xp) {
  const l = ladder();
  let hit = l[0];
  for (const r of l) if (Number(xp) >= r.at) hit = r;
  return hit;
}

/** The next rung up, or null at the top. */
function nextRank(xp) {
  const l = ladder();
  return l.find(r => r.at > Number(xp)) || null;
}

/** How far through the current band they are — for the progress bar. */
function progress(xp) {
  const now  = rankFor(xp);
  const next = nextRank(xp);
  if (!next) return { rank: now, next: null, need: 0, have: Number(xp) - now.at, span: 0, pct: 1 };
  const span = next.at - now.at;
  const have = Number(xp) - now.at;
  return { rank: now, next, need: next.at - Number(xp), have, span, pct: span > 0 ? have / span : 1 };
}

/**
 * Did moving from `before` to `after` cross a threshold upwards?
 * Returns the rank they should now be promoted to, or null.
 *
 * `lastPromoted` is what we already promoted them to. It's why this is not
 * simply "did the band change": the first time an existing Inspector earns any
 * XP their derived rank jumps from CSO to whatever their balance says, and
 * announcing that as a promotion would be wrong. See seed().
 */
function promotionFor(before, after, lastPromoted) {
  const to = rankFor(after);
  const from = rankFor(before);
  if (to.at <= from.at) return null;                       // no upward crossing
  if (lastPromoted && lastPromoted === to.code) return null; // already announced
  return { from, to };
}

/**
 * Did the same move cross a threshold DOWNWARDS?
 *
 * Losing XP demotes. There is no equivalent of `lastPromoted` guarding this,
 * because a downward crossing can only happen once per band — you have to climb
 * back up before you can fall through the same threshold again.
 */
function demotionFor(before, after) {
  const to = rankFor(after);
  const from = rankFor(before);
  if (to.at >= from.at) return null;
  return { from, to };
}

// ── Balances ──────────────────────────────────────────────────────
async function getBalance(discordId) {
  const row = await prisma.metXp.findUnique({ where: { discordId: String(discordId) } });
  return row || null;
}

/** The row, creating it at zero if this is the first time we've seen them. */
async function ensure(discordId, extra = {}) {
  const id = String(discordId);
  return prisma.metXp.upsert({
    where:  { discordId: id },
    update: Object.fromEntries(Object.entries(extra).filter(([, v]) => v != null)),
    create: { discordId: id, xp: 0, ...extra },
  });
}

/** Recent XP activity for an officer, newest first. */
async function history(discordId, take = 5) {
  return prisma.xpEvent.findMany({
    where: { discordId: String(discordId) },
    orderBy: { createdAt: 'desc' },
    take,
  });
}

/** Rank on the XP leaderboard (1-based), and how many officers have any XP. */
async function standing(discordId) {
  const row = await getBalance(discordId);
  const xp = row ? row.xp : 0;
  const [above, total] = await Promise.all([
    prisma.metXp.count({ where: { xp: { gt: xp } } }),
    prisma.metXp.count({ where: { xp: { gt: 0 } } }),
  ]);
  return { position: above + 1, total };
}

// ── Changing XP ───────────────────────────────────────────────────
const KINDS = new Set(['ADD', 'REMOVE', 'SET']);

/**
 * Apply an XP change and work out what it means.
 *
 * Does NOT touch Discord or Roblox — it returns what happened and lets the
 * caller (xpCommand) do the promoting, DMing and logging. That split is what
 * makes this testable, and it means a Discord outage can't lose an award.
 *
 * The balance change takes a row lock before it reads. A transaction alone is
 * not enough: Postgres defaults to READ COMMITTED, so two people running /xp on
 * the same officer at the same moment both read 14, both write 15, and one
 * award vanishes with nothing to show it ever happened. SELECT … FOR UPDATE
 * makes the second one wait for the first. The row is inserted first (ON
 * CONFLICT DO NOTHING) so there is always something to lock.
 *
 * @param {object} o
 * @param {string} o.discordId
 * @param {'ADD'|'REMOVE'|'SET'} o.kind
 * @param {number} o.value        always positive; REMOVE subtracts it
 * @param {string} [o.reason]
 * @param {string} [o.issuedById]
 * @param {string} [o.issuedBy]
 * @param {string} [o.robloxId]
 * @param {string} [o.robloxUsername]
 * @returns {Promise<{ before, after, delta, rank, promotion, event, capped }>}
 */
async function applyXp(o) {
  const kind = String(o.kind || '').toUpperCase();
  if (!KINDS.has(kind)) throw new Error(`unknown XP action "${o.kind}"`);
  const value = Math.trunc(Number(o.value));
  if (!Number.isFinite(value)) throw new Error('XP value must be a number');
  if (value < 0) throw new Error('XP value must not be negative — use the remove action instead');

  const id = String(o.discordId);

  return prisma.$transaction(async (tx) => {
    // Make sure there is a row, then lock it. Everything below runs with the
    // officer's balance held against any other concurrent /xp.
    await tx.$executeRaw`
      INSERT INTO "met_xp" ("discordId", "xp", "updatedAt")
      VALUES (${id}, 0, NOW())
      ON CONFLICT ("discordId") DO NOTHING`;
    const locked = await tx.$queryRaw`
      SELECT "xp", "promotedRank", "firstEarnedAt"
      FROM "met_xp" WHERE "discordId" = ${id} FOR UPDATE`;
    const existing = locked[0] || null;
    const before = existing ? existing.xp : 0;

    let target;
    if (kind === 'ADD')    target = before + value;
    if (kind === 'REMOVE') target = before - value;
    if (kind === 'SET')    target = value;

    // XP never goes negative and never exceeds the top rung. Removing 10 from
    // an officer on 3 leaves them on zero; adding 50 to a Chief Inspector on
    // 100 leaves them on 100. Either way the caller is told it was capped, so
    // the panel can say so rather than silently doing something other than
    // what was asked.
    const ceiling = maxXp();
    const after  = Math.min(ceiling, Math.max(0, target));
    const capped = after !== target;
    const delta  = after - before;

    const promotion = promotionFor(before, after, existing ? existing.promotedRank : null);
    const demotion  = demotionFor(before, after);

    // The row is guaranteed to exist (we just locked it), so this is a plain
    // update rather than an upsert.
    const row = await tx.metXp.update({
      where: { discordId: id },
      data: {
        xp: after,
        ...(o.robloxId       ? { robloxId: String(o.robloxId) } : {}),
        ...(o.robloxUsername ? { robloxUsername: String(o.robloxUsername) } : {}),
        ...(after > 0 && !(existing && existing.firstEarnedAt) ? { firstEarnedAt: new Date() } : {}),
      },
    });

    const event = await tx.xpEvent.create({
      data: {
        discordId: id, kind, delta, before, after,
        reason: o.reason || null,
        issuedById: o.issuedById ? String(o.issuedById) : null,
        issuedBy: o.issuedBy || null,
      },
    });

    return { before, after, delta, capped, row, event, rank: rankFor(after), promotion, demotion };
  });
}

/**
 * Record that a promotion happened.
 *
 * Separate from applyXp because the promotion isn't real until the group rank
 * change and the DM have been attempted — and because marking it before those
 * run would mean a failure there could never be retried.
 */
async function recordPromotion({ discordId, from, to, groupResult, issuedById, issuedBy }) {
  const id = String(discordId);
  const row = await prisma.metXp.update({
    where: { discordId: id },
    data:  { promotedRank: to.code, promotedAt: new Date() },
  });
  const event = await prisma.xpEvent.create({
    data: {
      discordId: id, kind: 'PROMOTION', delta: 0,
      before: row.xp, after: row.xp,
      fromRank: from.name, toRank: to.name,
      reason: groupResult && groupResult.ok === false
        ? `Group rank not changed: ${groupResult.reason}`
        : null,
      issuedById: issuedById ? String(issuedById) : null,
      issuedBy: issuedBy || null,
    },
  });
  return { row, event };
}

/**
 * Record that a demotion happened.
 *
 * `promotedRank` is moved DOWN to the rank they've fallen to, not cleared —
 * clearing it would let the next award announce a promotion to a rank they
 * already hold. Set to the new rung, climbing back through the threshold
 * announces properly.
 */
async function recordDemotion({ discordId, from, to, groupResult, issuedById, issuedBy }) {
  const id = String(discordId);
  const row = await prisma.metXp.update({
    where: { discordId: id },
    data:  { promotedRank: to.code, promotedAt: new Date() },
  });
  const event = await prisma.xpEvent.create({
    data: {
      discordId: id, kind: 'DEMOTION', delta: 0,
      before: row.xp, after: row.xp,
      fromRank: from.name, toRank: to.name,
      reason: groupResult && groupResult.ok === false
        ? `Group rank not changed: ${groupResult.reason}`
        : null,
      issuedById: issuedById ? String(issuedById) : null,
      issuedBy: issuedBy || null,
    },
  });
  return { row, event };
}

// The group's roleset list, cached briefly. Only the numeric-placement path
// below needs it, and several officers looked up in one /xp shouldn't each pay
// for the same call.
let _rolesCache = { at: 0, roles: null };
async function groupRoles() {
  if (_rolesCache.roles && Date.now() - _rolesCache.at < 10 * 60 * 1000) return _rolesCache.roles;
  const roles = await require('./roblox').listGroupRoles();
  _rolesCache = { at: Date.now(), roles };
  return roles;
}

/**
 * The ladder rung an officer's LIVE MET group rank puts them on, or null if
 * their group rank isn't on the ladder at all.
 *
 * Rank in the XP system follows rank in the group, not the other way round —
 * somebody is only a Community Support Officer here if that is genuinely what
 * they are over there.
 *
 * Two ways to place them, because a group has plenty of ranks the ladder does
 * not name:
 *
 *   by name    "Sergeant" → SGT. The HIGHEST match wins: "Chief Inspector"
 *              matches the CINS pattern and also contains "Inspector", and
 *              reading a Chief Inspector as an Inspector would hand them a
 *              promotion they already have the moment they hit 100 XP.
 *
 *   by number  Superintendent, Commander, Recruit — nothing on the ladder
 *              matches those names, so compare their group rank NUMBER against
 *              the numbers of the rolesets the ladder does match. The highest
 *              rung at or below them wins. Above everything → Chief Inspector,
 *              the top of what XP governs. Below everything (Recruit, Awaiting
 *              Training) → null: they are not on the ladder yet.
 *
 * @param {{name?: string, rank?: number}|string} groupRole
 */
async function rungForGroupRank(groupRole) {
  const name = typeof groupRole === 'string' ? groupRole : (groupRole && groupRole.name);
  const num  = (groupRole && typeof groupRole === 'object') ? groupRole.rank : null;
  if (!name && num == null) return null;

  const matches = ladder().filter(r => r.match.test(String(name || '')));
  if (matches.length) return matches.reduce((a, b) => (b.at > a.at ? b : a));

  // Senior to everything the ladder covers → the top rung, by name alone.
  const l = ladder();
  if (name && ABOVE_LADDER.test(String(name))) return l[l.length - 1];

  if (num == null) return null;

  let roles;
  try { roles = await groupRoles(); } catch (err) { return null; }

  // Where each ladder rung sits in the group's own numbering.
  const anchors = [];
  for (const rung of ladder()) {
    const cands = (roles || []).filter(r => r.rank > 0 && rung.match.test(String(r.name || '')));
    if (cands.length) anchors.push({ rung, groupRank: cands.reduce((a, b) => (b.rank < a.rank ? b : a)).rank });
  }
  if (!anchors.length) return null;
  anchors.sort((a, b) => a.groupRank - b.groupRank);

  let hit = null;
  for (const a of anchors) if (Number(num) >= a.groupRank) hit = a.rung;
  return hit;
}

/**
 * Set an officer's starting XP from the rank they ALREADY hold, without
 * announcing a promotion.
 *
 * Without this, the very first `/xp add 1` given to a serving Inspector reads
 * as "0 XP → 1 XP", and the moment they reach 2 they get congratulated on
 * making Constable — a demotion dressed as a promotion. So the first time we
 * see somebody, their balance starts at the floor of the rank they actually
 * hold, marked as already reached.
 *
 * Somebody whose group rank we cannot place gets NO row at all. That is the
 * point: an unplaceable officer is unranked, not a Community Support Officer.
 * A row appears the moment they are actually given XP.
 *
 * @param {string} discordId
 * @param {{name?: string, rank?: number}|string} groupRole their live MET group rank
 * @returns {Promise<object|null>} the row, or null if they could not be placed
 */
async function seedFromRank(discordId, groupRole) {
  const id = String(discordId);
  const existing = await prisma.metXp.findUnique({ where: { discordId: id } });

  // A row that has never been used carries no information: nobody has awarded
  // XP, nothing has been promoted, nothing has been earned. Seeding once and
  // never again meant a row created before their group rank could be read left
  // a Chief Superintendent stuck on 0 forever, with no way back short of
  // editing the database. An untouched row gets placed properly.
  const untouched = existing
    && existing.xp === 0 && !existing.promotedRank && !existing.firstEarnedAt;
  if (existing && !untouched) return existing;

  const hit = await rungForGroupRank(groupRole);
  if (!hit) return existing || null;

  const data = {
    xp: hit.at,
    // Marked as already at this rank, so reaching it again announces nothing.
    promotedRank: hit.code,
    promotedAt: new Date(),
  };
  return existing
    ? prisma.metXp.update({ where: { discordId: id }, data })
    : prisma.metXp.create({ data: { discordId: id, ...data } });
}

/**
 * Move somebody in the MET Roblox group to match their new XP rank.
 *
 * `direction` is 'up' for a promotion and 'down' for a demotion, and it is a
 * hard constraint rather than a hint: a promotion must never lower somebody and
 * a demotion must never raise them, whatever the group happens to say.
 *
 * A demotion has one extra guard, and it matters. If their current group rank
 * is NOT on the XP ladder — a Superintendent, a Commander, anyone above Chief
 * Inspector — they are left alone. XP tops out at Chief Inspector, so without
 * that check a Superintendent who lost a couple of XP would be dropped to
 * Constable by a system that has no business ranking them at all.
 *
 * Returns { ok, from, to } or { ok:false, reason } — never throws.
 */
async function applyGroupRank(robloxId, rank, direction = 'up') {
  const down = direction === 'down';
  if (!robloxId) return { ok: false, reason: 'no linked Roblox account' };
  if (process.env.XP_GROUP_PROMOTE === 'off') {
    return { ok: false, reason: `group ${down ? 'demotion' : 'promotion'} is turned off` };
  }
  try {
    const roblox = require('./roblox');
    const [membership, roles] = await Promise.all([
      roblox.getGroupMembership(String(robloxId)),
      roblox.listGroupRoles(),
    ]);
    if (!membership) return { ok: false, reason: 'not in the MET group' };

    const current = membership.role || {};
    // Among rolesets whose name matches the rank, take the LOWEST — "Inspector"
    // matches both "Inspector" and "Chief Inspector", and moving somebody two
    // rungs would be wrong in either direction.
    const candidates = (roles || []).filter(r => r.rank > 0 && rank.match.test(String(r.name || '')));
    if (!candidates.length) return { ok: false, reason: `no "${rank.name}" role in the group` };
    const target = candidates.reduce((a, b) => (b.rank < a.rank ? b : a));

    if (down) {
      // Are they even on the ladder XP governs?
      const onLadder = ladder().some(r => r.match.test(String(current.name || '')));
      if (!onLadder) {
        return { ok: false, reason: `${current.name || 'their rank'} is above the XP ranks — left alone` };
      }
      if (current.rank != null && Number(target.rank) >= Number(current.rank)) {
        return { ok: false, reason: `already ${current.name}, which is at or below ${target.name}` };
      }
    } else if (current.rank != null && Number(target.rank) <= Number(current.rank)) {
      return { ok: false, reason: `already ${current.name}, which is at or above ${target.name}` };
    }

    await roblox.changeGroupRank(String(robloxId), target.id);
    return { ok: true, from: current.name || 'unknown', to: target.name };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

const promoteInGroup = (robloxId, rank) => applyGroupRank(robloxId, rank, 'up');
const demoteInGroup  = (robloxId, rank) => applyGroupRank(robloxId, rank, 'down');

/** Top of the XP table, for the leaderboard on the panel. */
async function leaderboard(take = 10) {
  const rows = await prisma.metXp.findMany({
    where: { xp: { gt: 0 } },
    orderBy: [{ xp: 'desc' }, { updatedAt: 'asc' }],
    take,
  });
  return rows.map((r, i) => ({ ...r, position: i + 1, rank: rankFor(r.xp) }));
}

module.exports = {
  LADDER, ABOVE_LADDER, ladder, rankFor, nextRank, progress, promotionFor, demotionFor,
  getBalance, ensure, history, standing, leaderboard,
  maxXp,
  applyXp, recordPromotion, recordDemotion, seedFromRank, rungForGroupRank,
  applyGroupRank, promoteInGroup, demoteInGroup,
};
