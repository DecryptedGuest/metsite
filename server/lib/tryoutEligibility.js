'use strict';

const prisma = require('./db');

const MET_GROUP = () => String(process.env.GROUP_MET || '17275620');

function nullable(v) { return v === undefined ? null : v; }

async function linkedAccounts(robloxId) {
  const out = { users: [], viaRover: [] };
  try {
    out.users = await prisma.user.findMany({
      where: { robloxId: String(robloxId) },
      select: { id: true, discordId: true, discordUsername: true, robloxUsername: true },
    });
  } catch (e) { out.users = []; }
  try {
    const { getDiscordFromRoblox } = require('./roblox');
    const m = await getDiscordFromRoblox(String(robloxId));
    out.viaRover = Array.isArray(m) ? m.map(x => String(x.discordId || x.id)).filter(Boolean) : [];
  } catch (e) { out.viaRover = []; }
  return out;
}

async function otherRobloxOnSameDiscord(discordIds, robloxId) {
  if (!discordIds.length) return [];
  try {
    const rows = await prisma.user.findMany({
      where: { discordId: { in: discordIds }, robloxId: { not: null } },
      select: { discordId: true, robloxId: true, robloxUsername: true },
    });
    return rows.filter(r => String(r.robloxId) !== String(robloxId));
  } catch (e) { return []; }
}

async function metStanding(robloxId) {
  let accepted = null;
  try {
    const { getUserGroupRole } = require('./roblox');
    const role = await getUserGroupRole(String(robloxId), MET_GROUP());
    accepted = !!(role && (role.id || role.rank || role.name));
  } catch (e) { accepted = null; }

  let pending = null;
  try {
    const cookie = process.env.ROBLOX_COOKIE || process.env.ROBLOX_GROUP_COOKIE || null;
    if (cookie) {
      const { listJoinRequests } = require('./roblox');
      let token = null, found = false, pages = 0;
      do {
        const page = await listJoinRequests(token, MET_GROUP(), cookie);
        const data = (page && page.data) || [];
        if (data.some(r => String(r.requester && r.requester.userId) === String(robloxId))) { found = true; break; }
        token = page && page.nextPageCursor ? page.nextPageCursor : null;
        pages += 1;
      } while (token && pages < 20);
      pending = found;
    }
  } catch (e) { pending = null; }

  return { accepted, pending };
}

async function blacklistStanding(robloxId, username) {
  try {
    const { gatherRecord } = require('./evasion');
    const rec = await gatherRecord({ robloxId: String(robloxId), robloxUsername: username || null });
    const sources = (rec && rec.blacklistSources) || [];
    return {
      blacklisted: sources.length > 0,
      reason: sources.length ? (sources[0].reason || sources[0].ref || null) : null,
      linkedDiscordIds: (rec && rec.otherAccounts) || [],
    };
  } catch (e) {
    return { blacklisted: null, reason: null, linkedDiscordIds: [] };
  }
}

async function checkEligibility(robloxUserId, opts = {}) {
  const robloxId = String(robloxUserId || '').trim();
  if (!robloxId || !/^\d+$/.test(robloxId)) {
    return { ok: false, error: 'A numeric Roblox user id is required.' };
  }

  let username = opts.username || null;
  if (!username) {
    try {
      const { getRobloxUserInfo } = require('./roblox');
      const u = await getRobloxUserInfo(robloxId);
      username = (u && u.username) || null;
    } catch (e) { username = null; }
  }

  const [links, met, bl] = await Promise.all([
    linkedAccounts(robloxId),
    metStanding(robloxId),
    blacklistStanding(robloxId, username),
  ]);

  const discordIds = [...new Set([
    ...links.users.map(u => String(u.discordId)),
    ...links.viaRover,
  ].filter(Boolean))];

  const discordLinked = discordIds.length > 0;

  const otherRoblox = await otherRobloxOnSameDiscord(discordIds, robloxId);
  const manyDiscord = discordIds.length > 1;
  const manyRoblox  = otherRoblox.length > 0;
  const multiAccount = (manyDiscord || manyRoblox) || null;

  let multiAccountDetail = null;
  if (manyDiscord && manyRoblox) {
    multiAccountDetail = `This Roblox account is linked to ${discordIds.length} Discord accounts, and one of those is also linked to ${otherRoblox.length} other Roblox account(s).`;
  } else if (manyDiscord) {
    multiAccountDetail = `This Roblox account is linked to ${discordIds.length} different Discord accounts.`;
  } else if (manyRoblox) {
    const names = otherRoblox.map(r => r.robloxUsername || r.robloxId).slice(0, 3).join(', ');
    multiAccountDetail = `The Discord account linked here is also linked to another Roblox account (${names}).`;
  }

  const metPending = met.pending === null && met.accepted === null ? null
                   : !!(met.pending || met.accepted);

  const reasons = [];
  if (!discordLinked) {
    reasons.push('You have not linked a Discord account to the portal yet. Sign in at the portal once, then try again.');
  }
  if (metPending === false) {
    reasons.push('You are not in the MET group and you have no pending join request. Request to join the MET group first.');
  }
  if (bl.blacklisted === true) {
    reasons.push('You are blacklisted from the MET. You cannot attend a tryout.');
  }

  const eligible = discordLinked && metPending !== false && bl.blacklisted !== true;

  return {
    ok: true,
    eligible,
    robloxId,
    username,
    checks: {
      discordLinked,
      metPending,
      blacklisted: nullable(bl.blacklisted),
      multiAccount,
      multiAccountDetail,
    },
    undetermined: [
      met.accepted === null ? 'metAccepted' : null,
      met.pending === null ? 'metPending' : null,
      bl.blacklisted === null ? 'blacklisted' : null,
    ].filter(Boolean),
    reasons,
  };
}

module.exports = { checkEligibility };
