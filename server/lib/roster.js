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
  const title = `${divisionLabel} Roster`;
  const description = `**${total}** members · synced from the portal`;
  const footer = 'Auto-synced by the MET portal';
  // Discord caps an embed at 6000 total chars (title + description + footer +
  // every field name/value) AND 25 fields. Accumulate a running total and stop
  // adding ranks before either ceiling, then summarise the remainder.
  const CHAR_CEILING = 5500; // headroom under 6000
  let used = title.length + description.length + footer.length;
  const fields = [];
  let dropped = 0;
  for (const g of groups) {
    const name = `${g.name} (${g.members.length})`;
    const value = (g.members.length <= NAME_LIST_MAX
      ? (g.members.map(n => `• ${n}`).join('\n') || '—')
      : `${g.members.length} members`).slice(0, 1000);
    const cost = name.length + value.length;
    if (fields.length >= EMBED_FIELD_MAX || used + cost > CHAR_CEILING) { dropped++; continue; }
    used += cost;
    fields.push({ name, value, inline: g.members.length <= NAME_LIST_MAX });
  }
  if (dropped > 0) fields.push({ name: '…', value: `+${dropped} more ranks`, inline: false });
  return {
    title, description, color: 0x2563eb, fields,
    footer: { text: footer }, timestamp: new Date().toISOString(),
  };
}

// Per-division in-flight guard so two concurrent syncs (e.g. a double-clicked
// button before any message id is stored) can't both post and orphan one.
const _syncing = new Set();

// Post or edit the roster message for a division. Returns { ok, total, messageId }.
async function syncRoster(division = 'MET') {
  const key = settingKey(division);
  if (_syncing.has(key)) return { ok: false, reason: 'a sync is already in progress' };
  _syncing.add(key);
  try {
    const bot = require('./bot');
    const gid = rosterGroupId(division);
    const channelId = rosterChannelId(division);
    const cookie = cookieForDivision(division === 'MET' ? 'MET' : division);
    if (!gid || !channelId) return { ok: false, reason: 'ROSTER_CHANNEL_ID or group id not configured' };
    if (!bot.isReady()) return { ok: false, reason: 'bot not ready' };

    const { groups, total } = await buildGroups(gid, cookie);
    const label = division === 'MET' ? 'Metropolitan Police' : division;
    const embed = rosterEmbed(label, groups, total);

    // If we already track a message, edit it in place. Crucially, a failed edit
    // is treated as TRANSIENT — we do NOT post a new message (that would orphan
    // the old one and spam duplicates). The stored id is left intact so the next
    // sync retries the edit. A genuinely-deleted message can be recovered by
    // clearing the roster_msg_<div> SystemSetting.
    const existing = await prisma.systemSetting.findUnique({ where: { key } }).catch(() => null);
    if (existing && existing.value) {
      const ok = await bot.editChannelMessage(channelId, existing.value, { embeds: [embed] });
      return ok ? { ok: true, total, messageId: existing.value }
                : { ok: false, reason: 'roster edit failed (left in place — will retry next sync)' };
    }

    // First time (or no stored id): post once and persist the id.
    const msgId = await bot.postChannelMessage(channelId, { embeds: [embed] });
    if (!msgId) return { ok: false, reason: 'failed to post roster' };
    await prisma.systemSetting.upsert({ where: { key }, update: { value: String(msgId) }, create: { key, value: String(msgId) } }).catch(() => {});
    return { ok: true, total, messageId: msgId };
  } finally {
    _syncing.delete(key);
  }
}

module.exports = { syncRoster, buildGroups, rosterEmbed };
