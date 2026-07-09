// server/lib/rover.js
// RoVer-style member update. RoVer keeps every member nicknamed
// "RANK | RobloxUsername" and assigns Discord roles from their Roblox group
// rank. When the SITE changes a rank (any group panel) or a case approval
// terminates/re-ranks someone, we want that reflected on Discord immediately
// rather than waiting for RoVer's next sync cycle.
//
// Note: RoVer Plus's public API is lookup-only — there is no endpoint to force
// a full re-verify remotely — so the reliable, immediate effect we can produce
// is re-applying the member's "RANK | RobloxUsername" nickname via our own bot
// (which we have here). RoVer's own periodic sync remains the backstop for its
// role bindings. Everything here is best-effort and never throws to the caller.

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

module.exports = { roverUpdate, enabled };
