// Live Internal Affairs quota leaderboard.
// Reads the same IA quota sheet used by the dashboard, so manual adjustments,
// automatic ticket awards and approved-case awards all appear in one place.
const { EmbedBuilder } = require('discord.js');
const CHANNEL_ID = () => process.env.IA_QUOTA_BOARD_CHANNEL_ID || '1575970681865117716';
const TITLE = 'INTERNAL AFFAIRS | QUOTA POINTS';
const IA_LOGO = 'https://cdn.discordapp.com/icons/1574841102169669692/bdaf270aa78f376ce95c7a9ad6095858.webp?size=1024';
const FOOTER = 'Metropolitan Police Service - Internal Affairs';
let activeClient = null;
let refreshQueued = false;
function requestRefresh() {
  if (!activeClient || refreshQueued) return;
  refreshQueued = true;
  setTimeout(async () => {
    refreshQueued = false;
    await refresh(activeClient);
  }, 1500);
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

function rankLabel(rank) {
  return String(rank || 'Unranked').trim() || 'Unranked';
}

function memberLine(member, index) {
  const name = String(member.username || 'Unknown').replace(/[`*_~|]/g, '').slice(0, 32);
  const identity = member.discordId ? `<@${member.discordId}> (${name})` : `**${name}**`;
  const points = Number.isFinite(Number(member.total)) ? Number(member.total) : 0;
  return `${index + 1}. ${identity} - **${points} QP**`;
}

async function verifiedIaMembers(client, members) {
  // The quota sheet is the maintained IA roster. Do not silently hide people
  // because their Discord link is blank, they are not currently cached in the
  // IA Discord server, or Roblox lookups are temporarily unavailable. Resolve
  // links and live ranks where possible, but retain every valid sheet row.
  const groupId = process.env.IA_GROUP_ID;
  const prisma = require('./db');
  const roblox = require('./roblox');
  const included = [];
  let linked = 0, liveRanks = 0, missingDiscord = 0, missingRoblox = 0, notInIa = 0;

  for (const member of members) {
    const sheetDiscordId = String(member.discordId || '').trim();
    const user = await prisma.user.findFirst({
      where: { OR: [
        ...(sheetDiscordId ? [{ discordId: sheetDiscordId }] : []),
        ...(member.username ? [{ robloxUsername: { equals: member.username, mode: 'insensitive' } }] : []),
      ] },
      select: { discordId: true, robloxId: true, robloxUsername: true },
    }).catch(() => null);

    const discordId = sheetDiscordId || String(user?.discordId || '').trim() || null;
    if (discordId) linked++;
    else missingDiscord++;

    let rank = String(member.rank || 'IA Member');
    let robloxId = user?.robloxId ? String(user.robloxId) : null;
    if (!robloxId && member.username) {
      const resolved = await roblox.getRobloxIdFromUsername(member.username).catch(() => null);
      robloxId = resolved?.id ? String(resolved.id) : null;
    }
    if (!robloxId) {
      missingRoblox++;
    } else if (groupId) {
      const roles = await roblox.getUserGroupRoles(robloxId, groupId, null, true).catch(() => []);
      const iaRole = Array.isArray(roles) && roles.length
        ? roles.reduce((highest, role) => Number(role.rank) > Number(highest.rank) ? role : highest)
        : null;
      if (iaRole?.name) {
        rank = String(iaRole.name);
        liveRanks++;
      } else {
        notInIa++;
      }
    }

    included.push({ ...member, discordId, rank });
  }

  console.log(`[IA Quota Board] included ${included.length}/${members.length} quota rows (linked Discord: ${linked}, missing Discord: ${missingDiscord}, missing Roblox: ${missingRoblox}, live IA ranks: ${liveRanks}, no live IA group rank: ${notInIa})`);
  return included;
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

  let fields = [];
  let used = String(embed.data.title || '').length + String(embed.data.description || '').length + FOOTER.length;
  for (const group of groups) {
    const lines = group.members.map((m, i) => memberLine(m, i));
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
    for (const line of lines) {
      if (chunk.join('\n').length + line.length + 1 > 1000) pushChunk();
      chunk.push(line);
    }
    pushChunk();
  }
  if (!fields.length) fields = [{ name: 'No quota members found', value: 'The IA quota sheet returned no member rows.' }];
  embed.addFields(fields);
  return embed;
}

async function refresh(client) {
  const channelId = CHANNEL_ID();
  if (!client || !channelId) return false;
  try {
    const quota = require('./quota');
    const members = await quota.getAllMembersPoints('IA');
    if (!Array.isArray(members)) {
      console.warn('[IA Quota Board] quota sheet is not currently readable; keeping the existing board');
      return false;
    }
    const eligible = await verifiedIaMembers(client, members);
    const channel = await client.channels.fetch(String(channelId));
    const embed = buildEmbed(eligible);
    const recent = await channel.messages.fetch({ limit: 100 });
    const existing = recent.find(message =>
      message.author?.id === client.user.id
      && message.embeds?.some(item => String(item.title || '').startsWith(TITLE))
    );
    if (existing) await existing.edit({ content: null, embeds: [embed], components: [] });
    else await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    console.log(`[IA Quota Board] ${existing ? 'updated' : 'posted'} in ${channelId} with ${eligible.length} verified IA members from ${members.length} quota rows`);
    return true;
  } catch (err) {
    console.warn('[IA Quota Board] refresh failed:', err.message);
    return false;
  }
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
  console.log(`[IA Quota Board] updates enabled in channel ${CHANNEL_ID()}`);
}

module.exports = { start, refresh, requestRefresh, buildEmbed, rankOrder, verifiedIaMembers };
