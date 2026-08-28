// Sync a Discord role's membership to an in-game panel.
//
// Discord holds the truth about who is an instructor; the game needs it as
// Roblox user ids. The bridge is a DataStore entry the game reads.
const { env } = require('./env');
const roblox = require('./roblox');
const openCloud = require('./openCloud');

/**
 * A panel is one Discord role mirrored to one DataStore key.
 * Add more here as other panels need syncing — nothing else has to change.
 */
const PANELS = {
  cid_instructor: {
    label: 'CID Instructor',
    guildId: () => env('CID_GUILD_ID', '1438215998338760887'),
    roleId:  () => env('CID_INSTRUCTOR_ROLE_ID', '1438282078356504686'),
    key:     () => env('CID_INSTRUCTOR_KEY', 'CID_Instructors'),
  },
};

/**
 * Resolve every holder of the role to a Roblox id.
 *
 * Members with no Roblox link are reported rather than dropped silently — an
 * instructor missing from the panel because RoVer never knew them is exactly
 * the kind of thing that gets blamed on the game.
 */
async function resolveHolders(client, panel) {
  const guildId = panel.guildId();
  const roleId  = panel.roleId();
  if (!guildId || !roleId) throw new Error('Panel guild or role id is not configured.');

  const guild = await client.guilds.fetch(guildId);
  await guild.members.fetch();                    // populate role.members
  const role = await guild.roles.fetch(roleId);
  if (!role) throw new Error(`Role ${roleId} not found in guild ${guildId}.`);

  const resolved = [], unlinked = [];
  for (const [, member] of role.members) {
    const robloxId = await roblox.getRobloxIdFromDiscord(member.id);
    if (!robloxId) { unlinked.push(member.user.tag || member.id); continue; }
    const info = await roblox.getRobloxUserInfo(robloxId);
    resolved.push({
      robloxId: Number(robloxId),
      username: info?.name || null,
      discordId: member.id,
      discordName: member.displayName,
    });
  }
  return { resolved, unlinked, roleName: role.name, total: role.members.size };
}

/** Resolve and push. Returns everything the caller needs to report. */
async function syncPanel(client, panelKey) {
  const panel = PANELS[panelKey];
  if (!panel) throw new Error(`Unknown panel "${panelKey}".`);

  const { resolved, unlinked, roleName, total } = await resolveHolders(client, panel);

  const payload = {
    // Plain array of ids first: the cheapest thing for Lua to check against.
    userIds: resolved.map(r => r.robloxId),
    // Detail for panels that want to show names.
    members: resolved.map(r => ({ userId: r.robloxId, username: r.username })),
    role: roleName,
    syncedAt: new Date().toISOString(),
    source: 'METAdministration',
  };

  const write = await openCloud.setEntry(panel.key(), payload);
  return { panel, payload, write, resolved, unlinked, roleName, total };
}

module.exports = { PANELS, syncPanel, resolveHolders, startPanelWatcher };

/**
 * Keep the panel current without anyone running a command.
 *
 * Two triggers, deliberately:
 *  - a member's roles changing in the panel's guild (fast path, debounced so a
 *    bulk role edit does not fire fifty writes)
 *  - a periodic full re-sync, which repairs anything a missed gateway event or
 *    a failed write left stale
 */
function startPanelWatcher(client, { intervalMinutes = 30, debounceMs = 10_000 } = {}) {
  const timers = new Map();

  const queue = (panelKey, why) => {
    clearTimeout(timers.get(panelKey));
    timers.set(panelKey, setTimeout(async () => {
      timers.delete(panelKey);
      try {
        const r = await syncPanel(client, panelKey);
        if (r.write.ok) {
          console.log(`[panel] ${PANELS[panelKey].label} synced (${r.resolved.length} members) — ${why}`);
        } else {
          console.warn(`[panel] ${PANELS[panelKey].label} write failed: ${r.write.error}`);
        }
      } catch (err) {
        console.warn(`[panel] ${panelKey} sync failed: ${err.message}`);
      }
    }, debounceMs));
  };

  client.on('guildMemberUpdate', (oldM, newM) => {
    for (const [key, panel] of Object.entries(PANELS)) {
      if (newM.guild.id !== panel.guildId()) continue;
      const roleId = panel.roleId();
      const had = oldM.roles.cache.has(roleId);
      const has = newM.roles.cache.has(roleId);
      if (had !== has) queue(key, `${newM.user.tag} ${has ? 'gained' : 'lost'} the role`);
    }
  });

  // A member leaving the guild also changes who holds the role.
  client.on('guildMemberRemove', (member) => {
    for (const [key, panel] of Object.entries(PANELS)) {
      if (member.guild.id === panel.guildId() && member.roles.cache.has(panel.roleId())) {
        queue(key, `${member.user.tag} left the server`);
      }
    }
  });

  const tick = () => {
    for (const [key, panel] of Object.entries(PANELS)) {
      if (panel.guildId() && panel.roleId()) queue(key, 'scheduled re-sync');
    }
  };
  setInterval(tick, intervalMinutes * 60 * 1000);
  setTimeout(tick, 20_000);   // once shortly after boot
}
