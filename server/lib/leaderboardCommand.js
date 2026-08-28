// server/lib/leaderboardCommand.js
// /leaderboard — this week's quota progress, by rank group.
//
// Reads the same sheet the site reads (lib/quota.getAllMembersPoints), so the
// numbers in Discord and the numbers on the dashboard cannot disagree.
//
// Grouped rather than ranked flat, because the targets differ per tier: a Low
// Command officer on 25 and a High Command officer on 25 are not in the same
// position, and one list would imply they were.
const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { e } = require('./emoji');
const { getAllMembersPoints } = require('./quota');

function buildCommand() {
  return new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription("This week's quota progress by rank group")
    .addStringOption(o => o.setName('group').setDescription('Only one rank group')
      .addChoices(
        { name: 'High Command',   value: 'High Command' },
        { name: 'Middle Command', value: 'Middle Command' },
        { name: 'Low Command',    value: 'Low Command' },
      ))
    .addBooleanOption(o => o.setName('public').setDescription('Post visibly instead of just to you'))
    .toJSON();
}

// Rendered in this order whatever order the sheet returns.
const GROUP_ORDER = ['High Command', 'Middle Command', 'Low Command', 'LOA', 'Exempt', 'Unranked'];
const MEDALS = ['\u{1F947}', '\u{1F948}', '\u{1F949}'];

/** A short text meter. Discord has no progress bar and this reads at a glance. */
function meter(total, target) {
  if (target == null || target <= 0) return '';
  const pct = Math.min(1, total / target);
  const filled = Math.round(pct * 10);
  return ` \`${'█'.repeat(filled)}${'░'.repeat(10 - filled)}\` ${Math.round(pct * 100)}%`;
}

function line(m, i) {
  const place = i < 3 && !m.quota.exempt ? MEDALS[i] : `\`${String(i + 1).padStart(2)}\``;
  if (m.quota.exempt) {
    const tag = m.quota.tier === 'LOA'
      ? `${e('met_calendar')} LOA`
      : `${e('met_exempt')} Exempt${m.exemptKind === 'PURCHASED' ? ' (purchased)' : ''}`;
    return `${place} **${m.username}** · ${tag}`;
  }
  const state = m.met ? e('met_quota_met') : e('met_quota_miss');
  const target = m.quota.target != null ? `${m.total}/${m.quota.target}` : `${m.total}`;
  return `${place} ${state} **${m.username}** · ${target}${meter(m.total, m.quota.target)}`;
}

async function handleLeaderboard(interaction) {
  const isPublic = interaction.options.getBoolean('public') || false;
  await interaction.deferReply(isPublic ? {} : { flags: MessageFlags.Ephemeral });

  let members;
  try {
    members = await getAllMembersPoints('IA');
  } catch (err) {
    return interaction.editReply(`${e('met_cross')} Could not read the quota sheet: ${err.message}`);
  }

  if (members === null) return interaction.editReply(`${e('met_cross')} The quota sheet is not configured.`);
  if (!members.length)  return interaction.editReply(`${e('met_warn')} No members found on the sheet.`);

  const only = interaction.options.getString('group');

  const groups = new Map();
  for (const m of members) {
    const key = (m.quota && m.quota.tier) || 'Unranked';
    if (only && key !== only) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  if (!groups.size) {
    return interaction.editReply(`${e('met_warn')} Nobody is in **${only}** on the sheet.`);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => (b.total - a.total) || a.username.localeCompare(b.username));
  }

  const counted  = [...groups.values()].flat().filter(m => !m.quota.exempt);
  const metCount = counted.filter(m => m.met).length;

  const embed = new EmbedBuilder()
    .setColor(0x4a8fff)
    .setTitle(`${e('met_chart')} Weekly quota${only ? ` · ${only}` : ''}`)
    .setDescription(counted.length
      ? `**${metCount}/${counted.length}** on target · ${[...groups.values()].flat().length - counted.length} exempt`
      : '*Everyone listed is exempt.*')
    .setFooter({ text: 'Internal Affairs · resets weekly' })
    .setTimestamp();

  // Anything the sheet returned under a tier this list does not name still has
  // to appear, or a renamed tier would silently drop people off the board.
  const keys = [...GROUP_ORDER.filter(k => groups.has(k)),
                ...[...groups.keys()].filter(k => !GROUP_ORDER.includes(k))];

  for (const key of keys) {
    const list = groups.get(key);
    if (!list || !list.length) continue;
    // A field caps at 1024 characters, so long groups page into continuations.
    const lines = list.map(line);
    let chunk = [], chunks = [];
    for (const l of lines) {
      if (chunk.length && chunk.join('\n').length + l.length > 1000) { chunks.push(chunk); chunk = []; }
      chunk.push(l);
    }
    if (chunk.length) chunks.push(chunk);
    chunks.forEach((c, i) => embed.addFields({
      name: i === 0 ? `${key} (${list.length})` : `${key} (cont.)`,
      value: c.join('\n'),
    }));
  }
  // 25 fields is the hard embed limit.
  if (embed.data.fields && embed.data.fields.length > 25) {
    embed.data.fields = embed.data.fields.slice(0, 25);
  }

  return interaction.editReply({ content: '', embeds: [embed] });
}

module.exports = { buildCommand, handleLeaderboard };
