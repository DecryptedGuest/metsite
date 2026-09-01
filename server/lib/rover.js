// server/lib/rover.js
// RoVer-style member update. RoVer keeps every member nicknamed
// "RANK | RobloxUsername" and assigns Discord roles from their Roblox group
// rank. When the SITE changes a rank (any group panel) or a case approval
// terminates/re-ranks someone, we want that reflected on Discord immediately
// rather than waiting for RoVer's next sync cycle.
//
// There are TWO RoVer surfaces and they are easy to confuse. RoVer Plus's
// public API is lookup-only: it answers "who is this Roblox id on Discord" and
// nothing more. But self-hosted RoVer also has an optional Update Server, and
// that one CAN be told to re-run a verification:
//
//   GET {ROVER_UPDATE_URL}/update-user?apiKey=…&id=…&guilds=a,b,c
//
// where `id` is the DISCORD user id (it is passed to server.getMember) and
// guilds is a comma-separated list. That is the closest thing to "make RoVer
// fix this person now", and it sets their roles AND their nickname from their
// group rank, which is exactly what a rank change or a termination should do.
//
// One catch worth knowing: the endpoint answers "ok" BEFORE it does any of the
// work. A 200 means accepted, not done. So nothing here trusts the response;
// it waits, looks at the member again, and falls back to doing the job with
// our own bot if RoVer did not. Everything is best-effort and never throws.

const roblox = require('./roblox');

function enabled() { return process.env.ROVER_SYNC !== 'off'; }

// Reflect a rank change / termination on the member's Discord nickname.
//  opts.robloxId   — the Roblox user whose rank changed (preferred)
//  opts.discordId  — optional, skips the RoVer reverse lookup if known
//  opts.groupId    — the group that was changed (only the main nickname group
//                    drives the "RANK | Username" nickname)
//  opts.roleId     — the new Roblox role id (resolved to a rank name safely,
//                    avoiding stale per-user rank caches)
//  opts.terminated — true when the member was exiled/removed from the group
async function roverUpdate(opts = {}) {
  try {
    if (!enabled()) return;
    let { robloxId, discordId, groupId, roleId, terminated } = opts;
    if (!robloxId && !discordId) return;

    const bot = require('./bot');
    if (!bot.isReady || !bot.isReady()) return; // bot not connected → nothing to do

    // Resolve Discord id from Roblox id via RoVer if we weren't given it.
    if (!discordId && robloxId) {
      const members = await roblox.getDiscordFromRoblox(robloxId).catch(() => []);
      if (Array.isArray(members) && members.length) discordId = members[0].discordId || members[0].id;
    }
    if (!discordId) return;

    // Roblox username for the nickname (fall back to parsing their current nick).
    let username = null;
    if (robloxId) {
      const info = await roblox.getRobloxUserInfo(robloxId).catch(() => null);
      username = (info && (info.username || info.displayName)) || null;
    }
    if (!username) username = await bot.getRobloxNameFromNick(discordId).catch(() => null);
    if (!username) return; // can't safely build a nickname

    // Only the MAIN nickname group drives the server nickname; a change/removal
    // in a division group leaves the MET nickname untouched. Use the shared
    // main-group resolver (ROBLOX_GROUP_ID → GROUP_MET → default) so this fires
    // even when only GROUP_MET is configured.
    const mainGroup = roblox.mainGroupId();
    if (!mainGroup || (groupId && String(groupId) !== String(mainGroup))) return;

    if (terminated) {
      // Removed from the MAIN group → strip the rank prefix, leave the username.
      await bot.setMemberNickname(discordId, username);
      return;
    }

    // Resolve the NEW rank name from the group's stable role list (not the
    // per-user rank cache, which would still hold the pre-change value).
    let prefix = null;
    if (roleId) {
      const want = String(roleId).includes('/') ? String(roleId).split('/').pop() : String(roleId);
      const roles = await roblox.getGroupRolesPublic(mainGroup).catch(() => []);
      const role = (roles || []).find(r => String(r.id) === String(want));
      if (role && role.name) prefix = role.name;
    }
    if (!prefix) return; // couldn't confirm the new rank → let RoVer handle it (don't wipe)

    await bot.setMemberNickname(discordId, `${prefix} | ${username}`);
  } catch (e) { /* best-effort — never affects the rank change itself */ }
}


// ── The RoVer Update Server ──────────────────────────────────────────────

function updateServer() {
  const url = String(process.env.ROVER_UPDATE_URL || '').trim().replace(/\/+$/, '');
  const key = String(process.env.ROVER_UPDATE_KEY || '').trim();
  return url ? { url, key } : null;
}

/** Which guilds RoVer should be asked to re-sync this member in. */
function syncGuildIds() {
  return [...new Set([
    process.env.MET_GUILD_ID, process.env.DISCORD_GUILD_ID, process.env.IA_GUILD_ID,
  ].filter(Boolean).map(String))];
}

/**
 * Ask RoVer to re-verify somebody, which re-applies their roles and nickname
 * from their Roblox group rank. Returns whether the request was ACCEPTED, not
 * whether the work is done: the endpoint answers before doing it.
 */
async function roverPush(discordId, guildIds) {
  const cfg = updateServer();
  if (!cfg) return { attempted: false, why: 'ROVER_UPDATE_URL is not set' };
  const guilds = (guildIds && guildIds.length ? guildIds : syncGuildIds());
  if (!guilds.length) return { attempted: false, why: 'no guild ids configured' };

  const qs = new URLSearchParams({ id: String(discordId), guilds: guilds.join(',') });
  if (cfg.key) qs.set('apiKey', cfg.key);
  const url = `${cfg.url}/update-user?${qs.toString()}`;

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return { attempted: true, accepted: false, why: `RoVer answered ${res.status}` };
    return { attempted: true, accepted: true };
  } catch (e) {
    return { attempted: true, accepted: false, why: e.message };
  }
}

/**
 * Put somebody's Discord identity right after an administrative action.
 *
 * RoVer first, because letting the system that owns the mapping do the work is
 * better than a second system racing it. Then it CHECKS, because RoVer answers
 * before acting and may not be configured at all, and only does the job itself
 * if RoVer did not.
 *
 *   terminated  the rank prefix goes, the username stays: "EthanCaaden"
 *   ranked      "NewRank | EthanCaaden"
 *
 * @returns {{ nickname: string|null, via: 'rover'|'bot'|'none', note: string }}
 */
async function syncIdentity(opts = {}) {
  const { discordId, robloxId, terminated, rankName } = opts;
  if (!discordId) return { nickname: null, via: 'none', note: 'no Discord id' };
  const bot = require('./bot');
  if (!bot.isReady || !bot.isReady()) return { nickname: null, via: 'none', note: 'the bot is not connected' };

  // The username to build the nickname from, however we can get it.
  let username = null;
  if (robloxId) {
    const info = await roblox.getRobloxUserInfo(robloxId).catch(() => null);
    username = (info && (info.username || info.displayName)) || null;
  }
  if (!username) username = await bot.getRobloxNameFromNick(discordId).catch(() => null);

  const want = terminated ? (username || null)
             : (rankName && username) ? `${rankName} | ${username}` : null;

  const push = await roverPush(discordId);
  if (push.accepted) {
    // Give RoVer a moment, then look rather than assume.
    await new Promise(r => setTimeout(r, 2500));
    if (want) {
      const rec = await bot.getMemberRecord(discordId).catch(() => null);
      const now = rec && rec.displayName ? String(rec.displayName).trim() : null;
      if (now && now === want) return { nickname: now, via: 'rover', note: 'RoVer applied it' };
    } else {
      return { nickname: null, via: 'rover', note: 'RoVer asked to re-sync' };
    }
  }

  // RoVer is not configured, refused, or did not get there. Do it ourselves.
  if (!want) {
    return { nickname: null, via: 'none',
      note: push.attempted ? `RoVer did not apply it (${push.why || 'no change seen'}) and no nickname could be built`
                           : 'no Roblox username could be resolved, so the nickname was left alone' };
  }
  const ok = await bot.setMemberNickname(discordId, want).catch(() => false);
  return {
    nickname: ok ? want : null,
    via: ok ? 'bot' : 'none',
    note: ok ? (push.attempted ? `RoVer did not apply it (${push.why || 'no change seen'}); set directly`
                               : 'set directly (RoVer update server not configured)')
             : 'could not set the nickname (the bot may be below them)',
  };
}

module.exports = { roverUpdate, roverPush, syncIdentity, syncGuildIds, enabled };
