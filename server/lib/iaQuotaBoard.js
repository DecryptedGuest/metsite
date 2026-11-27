// Live Internal Affairs quota leaderboard.
// Reads the same IA quota sheet used by the dashboard, so manual adjustments,
// automatic ticket awards and approved-case awards all appear in one place.
const { EmbedBuilder } = require('discord.js');
const CHANNEL_ID = () => process.env.IA_QUOTA_BOARD_CHANNEL_ID || '1575970681865117716';
const TITLE = 'INTERNAL AFFAIRS | QUOTA POINTS';
const FOOTER = 'Metropolitan Police Service - Internal Affairs | Automatically updated';

function rankOrder(rank) {
  const r = String(rank || '').toLowerCase();
  if (/director|high command|administration|overseer/.test(r)) return 0;
  if (/supervisor/.test(r)) return 1;
  if (/senior\\s*investigator/.test(r)) return 2;
  if (/junior\\s*investigator/.test(r)) return 4;
  if (/probationary|trainee/.test(r)) return 5;
  if (/investigator/.test(r)) return 3;
  return 6;
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
    .setTitle(TITLE)
    .setDescription('Quota points by IA rank. Ticket closures award **+2 QP** and approved cases award **+4 QP**.')
    .setFooter({ text: FOOTER })
    .setTimestamp(new Date());

  let fields = [];
  let used = embed.data.title.length + embed.data.description.length + FOOTER.length;
  for (const group of groups) {
    const lines = group.members.map((m, i) => memberLine(m, i));
    let chunk = [];
    let part = 1;
    const pushChunk = () => {
      if (!chunk.length) return;
      const name = part === 1 ? group.rank : `${group.rank} (continued)`;
      const value = chunk.join('\\n');
      if (fields.length < 25 && used + name.length + value.length < 5700) {
        fields.push({ name, value });
        used += name.length + value.length;
      }
      chunk = [];
      part++;
    };
    for (const line of lines) {
      if (chunk.join('\\n').length + line.length + 1 > 1000) pushChunk();
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
    const channel = await client.channels.fetch(String(channelId));
    const embed = buildEmbed(members);
    const recent = await channel.messages.fetch({ limit: 100 });
    const existing = recent.find(message =>
      message.author?.id === client.user.id
      && message.embeds?.some(item => String(item.title || '').startsWith(TITLE))
    );
    if (existing) await existing.edit({ content: null, embeds: [embed], components: [] });
    else await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    return true;
  } catch (err) {
    console.warn('[IA Quota Board] refresh failed:', err.message);
    return false;
  }
}

function start(client) {
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

module.exports = { start, refresh, buildEmbed, rankOrder };
