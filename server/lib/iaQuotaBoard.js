// Internal Affairs quota leaderboard.
// The single Discord message is the sole source of truth for IA quota balances.
// No spreadsheet, quota database table, or external document is read or written.
const { EmbedBuilder } = require('discord.js');
const CHANNEL_ID = () => process.env.IA_QUOTA_BOARD_CHANNEL_ID || '1575970681865117716';
const TITLE = 'INTERNAL AFFAIRS | QUOTA POINTS';
const IA_LOGO = 'https://cdn.discordapp.com/icons/1574841102169669692/bdaf270aa78f376ce95c7a9ad6095858.webp?size=1024';
const FOOTER = 'Metropolitan Police Service - Internal Affairs';
const META_BASE = 0xE0000; // Unicode tag characters: invisible message-embedded metadata.
let activeClient = null;
let writeQueue = Promise.resolve();
let refreshQueued = false;

function withLock(fn) {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.catch(() => {});
  return run;
}
function encodeMeta(meta) {
  const raw = Buffer.from(JSON.stringify(meta), 'utf8');
  return Array.from(raw, byte => String.fromCodePoint(META_BASE + byte)).join('');
}
function decodeMeta(content) {
  try {
    const bytes = [];
    for (const ch of Array.from(String(content || ''))) {
      const cp = ch.codePointAt(0) - META_BASE;
      if (cp < 0 || cp > 255) continue;
      bytes.push(cp);
    }
    if (!bytes.length) return null;
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (_) { return null; }
}
function weekKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit',
    day: '2-digit', weekday: 'short',
  }).formatToParts(date);
  const get = type => parts.find(p => p.type === type)?.value;
  const d = new Date(Date.UTC(Number(get('year')), Number(get('month')) - 1, Number(get('day'))));
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}
function rankOrder(rank) {
  const r = String(rank || '').toLowerCase();
  if (/assistant\s+director/.test(r)) return 2;
  if (/deputy\s+director/.test(r)) return 1;
  if (/director|high command|administration|overseer/.test(r)) return 0;
  if (/supervisor/.test(r)) return 3;
  if (/senior\s*investigator/.test(r)) return 4;
  if (/junior\s*investigator/.test(r)) return 6;
  if (/probationary|trainee/.test(r)) return 7;
  if (/investigator/.test(r)) return 5;
  return 8;
}
function rankLabel(rank) { return String(rank || 'Unranked').trim() || 'Unranked'; }
function memberLine(member, index) {
  const name = String(member.username || 'Unknown').replace(/[`*_~|]/g, '').slice(0, 32);
  const identity = member.discordId ? `<@${member.discordId}> (${name})` : `**${name}**`;
  const points = Number.isFinite(Number(member.total)) ? Number(member.total) : 0;
  return `${index + 1}. ${identity} - **${points} QP**`;
}
function parseMemberLine(line, rank) {
  const s = String(line || '').trim();
  const m = s.match(/^\d+\.\s*(?:<@!?(\d+)>\s*)?(?:\(([^)]+)\)|\*\*([^*]+)\*\*)\s*-\s*\*\*(-?\d+)\s+QP\*\*$/i);
  if (!m) return null;
  const username = String(m[2] || m[3] || '').trim();
  if (!username) return null;
  const quota = require('./quota').quotaForRank(rank);
  return {
    discordId: m[1] || null, username, rank: rankLabel(rank),
    total: Number(m[4]) || 0, quota,
  };
}
function parseMembers(message) {
  const embed = message?.embeds?.find(e => String(e.title || '').startsWith(TITLE));
  if (!embed) throw new Error('The IA quota leaderboard message was not found or has no readable embed.');
  const out = [];
  for (const field of (embed.fields || [])) {
    const rank = String(field.name || '').replace(/\s*\(continued\)$/i, '').trim();
    for (const line of String(field.value || '').split('\n')) {
      const member = parseMemberLine(line, rank);
      if (member) out.push(member);
    }
  }
  return out;
}
function buildEmbed(members) {
  const sorted = [...members].sort((a, b) =>
    rankOrder(a.rank) - rankOrder(b.rank)
    || rankLabel(b.rank).localeCompare(rankLabel(a.rank))
    || (Number(b.total) || 0) - (Number(a.total) || 0)
    || String(a.username || '').localeCompare(String(b.username || ''))
  );
  const groups = [];
  for (const member of sorted) {
    const label = rankLabel(member.rank);
    let group = groups.find(g => g.rank === label);
    if (!group) { group = { rank: label, members: [] }; groups.push(group); }
    group.members.push(member);
  }
  const embed = new EmbedBuilder()
    .setColor(0x26384d)
    .setAuthor({ name: 'INTERNAL AFFAIRS', iconURL: IA_LOGO })
    .setTitle(TITLE)
    .setFooter({ text: FOOTER })
    .setTimestamp(new Date());
  const fields = [];
  let used = TITLE.length + FOOTER.length;
  for (const group of groups) {
    let chunk = [];
    let part = 1;
    const pushChunk = () => {
      if (!chunk.length) return;
      const name = part === 1 ? group.rank : `${group.rank} (continued)`;
      const value = chunk.join('\n');
      if (fields.length < 25 && used + name.length + value.length < 5700) {
        fields.push({ name, value });
        used += name.length + value.length;
      }
      chunk = [];
      part++;
    };
    for (const line of group.members.map((m, i) => memberLine(m, i))) {
      if (chunk.join('\n').length + line.length + 1 > 1000) pushChunk();
      chunk.push(line);
    }
    pushChunk();
  }
  if (!fields.length) fields.push({ name: 'No quota members found', value: 'No IA quota members have been added yet.' });
  embed.addFields(fields);
  return embed;
}
async function findBoardMessage(client) {
  const channel = await client.channels.fetch(String(CHANNEL_ID()));
  if (!channel?.messages) throw new Error('IA quota leaderboard channel is unavailable.');
  const recent = await channel.messages.fetch({ limit: 100 });
  let message = recent.find(m => m.author?.id === client.user.id
    && m.embeds?.some(e => String(e.title || '').startsWith(TITLE)));
  if (!message) {
    message = await channel.send({ embeds: [buildEmbed([])], content: encodeMeta({ v: 1, week: weekKey(), refs: [] }), allowedMentions: { parse: [] } });
  }
  return message;
}
async function readState(client) {
  const message = await findBoardMessage(client);
  let meta = decodeMeta(message.content) || { v: 1, week: weekKey(), refs: [] };
  let members = parseMembers(message);
  const currentWeek = weekKey();
  if (meta.week !== currentWeek) {
    members = members.map(m => ({ ...m, total: 0 }));
    meta = { v: 1, week: currentWeek, refs: [] };
    await message.edit({ content: encodeMeta(meta), embeds: [buildEmbed(members)], components: [] });
  } else if (!decodeMeta(message.content)) {
    // Adopt the existing leaderboard as-is on first conversion. The visible
    // balances are retained; only the invisible idempotency marker is added.
    await message.edit({ content: encodeMeta(meta), components: [] });
  }
  return { message, members, meta };
}
async function getAllMembersPoints(division = 'IA') {
  if (String(division || 'IA').toUpperCase() !== 'IA') return null;
  const client = activeClient || require('./bot').getClient();
  if (!client) return null;
  const { members } = await readState(client);
  return members;
}
async function getMemberPoints(member, division = 'IA') {
  if (String(division || 'IA').toUpperCase() !== 'IA') return null;
  const client = activeClient || require('./bot').getClient();
  if (!client) return null;
  const { members } = await readState(client);
  const id = String(member?.discordId || '').replace(/\D/g, '');
  const username = String(member?.robloxUsername || member?.username || '').trim().toLowerCase();
  const found = members.find(m => (id && String(m.discordId || '') === id)
    || (username && m.username.toLowerCase() === username));
  if (!found) return { found: false };
  const q = require('./quota').quotaForRank(found.rank);
  return { ...found, found: true, quota: q, remaining: q.exempt || q.target == null ? 0 : Math.max(0, q.target - found.total) };
}
async function applyAward({ refType, refId, discordId, robloxUsername, points, label }) {
  const client = activeClient || require('./bot').getClient();
  if (!client) return false;
  return withLock(async () => {
    const { message, members, meta } = await readState(client);
    const ref = require('crypto').createHash('sha256').update(`${refType}:${refId}`).digest('hex').slice(0, 10);
    if ((meta.refs || []).includes(ref)) return true;
    const id = String(discordId || '').replace(/\D/g, '');
    const username = String(robloxUsername || '').trim();
    let member = members.find(m => (id && String(m.discordId || '') === id)
      || (username && m.username.toLowerCase() === username.toLowerCase()));
    if (!member) {
      if (!id && !username) return false;
      let displayName = username;
      let rank = 'IA Member';
      if (id) {
        try {
          const user = await require('./db').user.findUnique({
            where: { discordId: id },
            select: { robloxUsername: true, iaRankName: true },
          });
          displayName = displayName || user?.robloxUsername || null;
          rank = user?.iaRankName || rank;
        } catch (_) {}
      }
      member = {
        discordId: id || null,
        username: displayName || (id ? `Discord-${id.slice(-4)}` : 'Unknown'),
        rank, total: 0,
      };
      members.push(member);
    }
    member.total = (Number(member.total) || 0) + Number(points || 0);
    member.quota = require('./quota').quotaForRank(member.rank);
    const refs = [...(meta.refs || []), ref].slice(-80);
    await message.edit({
      content: encodeMeta({ v: 1, week: meta.week || weekKey(), refs }),
      embeds: [buildEmbed(members)],
      components: [],
      allowedMentions: { parse: [] },
    });
    console.log(`[IA Quota Board] ${points > 0 ? '+' : ''}${points} QP applied to ${member.username} (${label || refType})`);
    return true;
  });
}
async function setMemberTotal({ discordId, robloxUsername, total }) {
  const client = activeClient || require('./bot').getClient();
  if (!client) return null;
  return withLock(async () => {
    const { message, members, meta } = await readState(client);
    const id = String(discordId || '').replace(/\D/g, '');
    const username = String(robloxUsername || '').trim().toLowerCase();
    const member = members.find(m => (id && String(m.discordId || '') === id)
      || (username && m.username.toLowerCase() === username));
    if (!member) return null;
    member.total = Math.max(0, Number(total) || 0);
    await message.edit({ content: encodeMeta({ v: 1, week: meta.week || weekKey(), refs: meta.refs || [] }), embeds: [buildEmbed(members)], components: [], allowedMentions: { parse: [] } });
    return { ...member, quota: require('./quota').quotaForRank(member.rank) };
  });
}
async function reset() {
  const client = activeClient || require('./bot').getClient();
  if (!client) return { ok: false, error: 'IA quota board is unavailable.' };
  return withLock(async () => {
    const { message, members } = await readState(client);
    const resetMembers = members.map(m => ({ ...m, total: 0 }));
    await message.edit({ content: encodeMeta({ v: 1, week: weekKey(), refs: [] }), embeds: [buildEmbed(resetMembers)], components: [], allowedMentions: { parse: [] } });
    return { ok: true, cleared: resetMembers.length };
  });
}
async function refresh(client) {
  if (!client) return false;
  activeClient = client;
  return withLock(async () => {
    try {
      // Refresh only normalizes the existing message. It never imports or
      // overwrites balances from any external source.
      const { message, members, meta } = await readState(client);
      await message.edit({ content: encodeMeta(meta), embeds: [buildEmbed(members)], components: [], allowedMentions: { parse: [] } });
      console.log(`[IA Quota Board] message-backed board ready with ${members.length} members in ${CHANNEL_ID()}`);
      return true;
    } catch (err) {
      console.warn('[IA Quota Board] refresh failed:', err.message);
      return false;
    }
  });
}
function requestRefresh() {
  if (!activeClient || refreshQueued) return;
  refreshQueued = true;
  setTimeout(async () => {
    refreshQueued = false;
    await refresh(activeClient);
  }, 1500);
}
function start(client) {
  activeClient = client;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { await refresh(client); }
    finally { running = false; }
  };
  setTimeout(run, 12000);
  setInterval(run, 60 * 1000);
  console.log(`[IA Quota Board] message-backed updates enabled in channel ${CHANNEL_ID()}`);
}
module.exports = {
  start, refresh, requestRefresh, buildEmbed, rankOrder,
  getAllMembersPoints, getMemberPoints, applyAward, setMemberTotal, reset,
};
