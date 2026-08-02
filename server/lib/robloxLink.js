// server/lib/robloxLink.js
// Finding an officer's Roblox account from their Discord one.
//
// RoVer is the intended answer and usually right, but it is not the only place
// this is written down, and "no Roblox account linked" on a disciplinary record
// is a real cost — it means no group exile, no demotion, no avatar, and a log
// that names nobody. So when RoVer has nothing, keep looking:
//
//   1. RoVer                        the link of record
//   2. their dashboard account         set at login, and it persists after a
//                                   RoVer outage or an unverify
//   3. their MET server nickname    "PC | realangeloo" — the convention the
//                                   whole server already runs on
//   4. their MetMemberProfile       what the bot last saw for them
//
// Every route is checked in order and the first that yields an id wins, with
// the id confirmed against Roblox so a stale nickname can't put somebody else's
// name on a punishment.

const prisma = require('./db');

/**
 * @param {string} discordId
 * @returns {Promise<{ robloxId: string|null, username: string|null, displayName: string|null, via: string|null }>}
 */
async function resolveRoblox(discordId) {
  const roblox = require('./roblox');
  const id = String(discordId || '');
  const none = { robloxId: null, username: null, displayName: null, via: null };
  if (!id) return none;

  // Confirm an id against Roblox and return the canonical username. A wrong
  // name on a disciplinary record is worse than no name.
  const finish = async (robloxId, via) => {
    if (!robloxId) return null;
    try {
      const info = await roblox.getRobloxUserInfo(String(robloxId));
      if (info) return { robloxId: String(info.id), username: info.username, displayName: info.displayName, via };
    } catch (err) { /* fall through to the raw id */ }
    return { robloxId: String(robloxId), username: null, displayName: null, via };
  };

  // 1. RoVer.
  try {
    const rid = await roblox.getRobloxIdFromDiscord(id);
    if (rid) { const hit = await finish(rid, 'rover'); if (hit) return hit; }
  } catch (err) { /* keep going */ }

  // 2. Their dashboard account.
  try {
    const user = await prisma.user.findUnique({
      where: { discordId: id },
      select: { robloxId: true, robloxUsername: true },
    });
    if (user && user.robloxId) { const hit = await finish(user.robloxId, 'dashboard'); if (hit) return hit; }
    if (user && user.robloxUsername) {
      const rid = await roblox.getRobloxIdFromUsername(user.robloxUsername).catch(() => null);
      if (rid) { const hit = await finish(rid, 'dashboard-username'); if (hit) return hit; }
    }
  } catch (err) { /* keep going */ }

  // 3. Their MET nickname — "RANK | RobloxUsername".
  try {
    const name = await require('./bot').getRobloxNameFromNick(id);
    if (name) {
      const rid = await roblox.getRobloxIdFromUsername(name).catch(() => null);
      if (rid) { const hit = await finish(rid, 'nickname'); if (hit) return hit; }
    }
  } catch (err) { /* keep going */ }

  // 4. Whatever the bot last recorded for them.
  try {
    const p = await prisma.metMemberProfile.findUnique({
      where: { discordId: id },
      select: { robloxId: true, robloxUsername: true },
    });
    if (p && p.robloxId) { const hit = await finish(p.robloxId, 'profile'); if (hit) return hit; }
    if (p && p.robloxUsername) {
      const rid = await roblox.getRobloxIdFromUsername(p.robloxUsername).catch(() => null);
      if (rid) { const hit = await finish(rid, 'profile-username'); if (hit) return hit; }
    }
  } catch (err) { /* nothing left to try */ }

  return none;
}

module.exports = { resolveRoblox };
