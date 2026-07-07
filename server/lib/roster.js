// server/lib/roster.js
// Build a live roster of a Roblox group (members grouped by rank) and post/edit
// it as a Discord embed that the site keeps in sync. The site is the source of
// truth: syncRoster() enumerates the group, renders one field per rank
// (member count, plus names for small ranks), and edits the same message in
// place (message id persisted in SystemSetting) so it never spams a new post.
const prisma = require('./db');
const { listGroupMembers, cookieForDivision } = require('./roblox');
const { metGroupId, groupIdForKey } = require('./divisions');

const MAX_PAGES = 60;            // ~6000 members hard cap (safety, not a real limit)
const NAME_LIST_MAX = 12;        // ranks with ≤ this many members list names; larger show a count
const EMBED_FIELD_MAX = 24;      // Discord allows 25 fields per embed

// Which Roblox group a roster targets. Division key → group id; default MET.
function rosterGroupId(division) {
  const key = String(division || 'MET').toUpperCase();
  if (key === 'MET') return metGroupId();
  return groupIdForKey(key) || metGroupId();
}
function rosterChannelId(division) {
  const key = String(division || 'MET').toUpperCase();
  return process.env[`ROSTER_CHANNEL_ID_${key}`] || process.env.ROSTER_CHANNEL_ID || null;
}
const settingKey = (division) => `roster_msg_${String(division || 'MET').toUpperCase()}`;

// Enumerate the whole group, grouped by rank (highest first).
async function buildGroups(gid, cookie) {
  const byRank = new Map(); // roleName -> { name, rank, members: [] }
  let token = null, pages = 0, total = 0;
  do {
    const page = await listGroupMembers(token, gid, cookie);
    for (const m of page.members || []) {
      total++;
      const g = byRank.get(m.roleName) || { name: m.roleName, rank: m.roleRank, members: [] };
      g.members.push(m.displayName || m.username);
      byRank.set(m.roleName, g);
    }
    token = page.nextPageToken || null;
  } while (token && ++pages < MAX_PAGES);
  const groups = [...byRank.values()].sort((a, b) => b.rank - a.rank);
  return { groups, total };
}

function rosterEmbed(divisionLabel, groups, total) {
  const fields = groups.slice(0, EMBED_FIELD_MAX).map(g => {
    const value = g.members.length <= NAME_LIST_MAX
      ? (g.members.map(n => `• ${n}`).join('\n') || '—')
      : `${g.members.length} members`;
    return { name: `${g.name} (${g.members.length})`, value: value.slice(0, 1000), inline: g.members.length <= NAME_LIST_MAX };
  });
  if (groups.length > EMBED_FIELD_MAX) {
    fields.push({ name: '…', value: `+${groups.length - EMBED_FIELD_MAX} more ranks`, inline: false });
  }
  return {
    title: `${divisionLabel} Roster`,
    description: `**${total}** members · synced from the portal`,
    color: 0x2563eb,
    fields,
    footer: { text: 'Auto-synced by the MET portal' },
    timestamp: new Date().toISOString(),
  };
}

// Post or edit the roster message for a division. Returns { ok, total, messageId }.
async function syncRoster(division = 'MET') {
  const bot = require('./bot');
  const gid = rosterGroupId(division);
  const channelId = rosterChannelId(division);
  const cookie = cookieForDivision(division === 'MET' ? 'MET' : division);
  if (!gid || !channelId) return { ok: false, reason: 'ROSTER_CHANNEL_ID or group id not configured' };
  if (!bot.isReady()) return { ok: false, reason: 'bot not ready' };

  const { groups, total } = await buildGroups(gid, cookie);
  const label = division === 'MET' ? 'Metropolitan Police' : division;
  const embed = rosterEmbed(label, groups, total);

  // Reuse the persisted message if we can edit it; else post a fresh one.
  const key = settingKey(division);
  const existing = await prisma.systemSetting.findUnique({ where: { key } }).catch(() => null);
  if (existing && existing.value) {
    const ok = await bot.editChannelMessage(channelId, existing.value, { embeds: [embed] });
    if (ok) return { ok: true, total, messageId: existing.value };
  }
  const msgId = await bot.postChannelMessage(channelId, { embeds: [embed] });
  if (!msgId) return { ok: false, reason: 'failed to post roster' };
  await prisma.systemSetting.upsert({ where: { key }, update: { value: String(msgId) }, create: { key, value: String(msgId) } }).catch(() => {});
  return { ok: true, total, messageId: msgId };
}

module.exports = { syncRoster, buildGroups, rosterEmbed };
