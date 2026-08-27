const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { e, startLoading } = require('../lib/emoji');
const { getAllMembersPoints } = require('../lib/quota');

const data = new SlashCommandBuilder()
  .setName('leaderboard')
  .setDescription("Show this week's quota progress by rank group")
  .addStringOption(o => o.setName('group').setDescription('Only one rank group')
    .addChoices(
      { name: 'High Command',   value: 'High Command' },
      { name: 'Middle Command', value: 'Middle Command' },
      { name: 'Low Command',    value: 'Low Command' },
    ))
  .addBooleanOption(o => o.setName('public').setDescription('Post visibly instead of just to you'));

// Rendered in this order regardless of what the sheet returns.
const GROUP_ORDER = ['High Command', 'Middle Command', 'Low Command', 'LOA', 'Unranked'];
const MEDALS = ['GOLD', 'SILVER', 'BRONZE'];

/** A short text meter — Discord has no progress bar, and this reads at a glance. */
function meter(total, target) {
  if (target == null || target <= 0) return '';
  const pct = Math.min(1, total / target);
  const filled = Math.round(pct * 10);
  return ` \`${'█'.repeat(filled)}${'░'.repeat(10 - filled)}\` ${Math.round(pct * 100)}%`;
}

function line(m, i) {
  const medal = i < 3 && !m.quota.exempt ? e(MEDALS[i]) : `\`${String(i + 1).padStart(2)}\``;
  if (m.quota.exempt) {
    const tag = m.quota.tier === 'LOA' ? `${e('LOA')} LOA` : `${e('EXEMPT')} Exempt`;
    return `${medal} **${m.username}** — ${tag}`;
  }
  const met = m.met ? e('APPROVE') : e('PENDING');
  const target = m.quota.target != null
    ? `${m.total}/${m.quota.target}${m.quota.reducedBy ? ` ${e('IOTW')}` : ''}`
    : `${m.total}`;
  return `${medal} ${met} **${m.username}** — ${target}${meter(m.total, m.quota.target)}`;
}

async function execute(interaction, bot) {
  const isPublic = interaction.options.getBoolean('public') || false;
  await interaction.deferReply(isPublic ? {} : { flags: MessageFlags.Ephemeral });
  const loader = startLoading(interaction, 'Reading the quota sheet');

  try {
    const members = await getAllMembersPoints(bot);
    loader.stop();

    if (members === null) return interaction.editReply(`${e('DENY')} The quota sheet is not configured.`);
    if (!members.length)  return interaction.editReply(`${e('WARNING')} No members found on the sheet.`);

    const only = interaction.options.getString('group');

    // Group by tier, each sorted by points then name.
    const groups = new Map();
    for (const m of members) {
      const key = m.quota.tier || 'Unranked';
      if (only && key !== only) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }
    for (const list of groups.values()) {
      list.sort((a, b) => (b.total - a.total) || a.username.localeCompare(b.username));
    }

    const counted = [...groups.values()].flat().filter(m => !m.quota.exempt);
    const metCount = counted.filter(m => m.met).length;

    const embed = new EmbedBuilder()
      .setColor(0x4a8fff)
      .setTitle(`${e('POINTS')} Weekly quota${only ? ` — ${only}` : ''}`)
      .setDescription(counted.length
        ? `**${metCount}/${counted.length}** on target · ${members.length - counted.length} exempt`
        : '*Everyone listed is exempt.*')
      .setFooter({ text: 'Internal Affairs · resets weekly' })
      .setTimestamp();

    for (const key of GROUP_ORDER) {
      const list = groups.get(key);
      if (!list?.length) continue;
      // Discord caps a field at 1024 chars — page long groups into continuations.
      const lines = list.map(line);
      let chunk = [], chunks = [];
      for (const l of lines) {
        if (chunk.join('\n').length + l.length > 1000) { chunks.push(chunk); chunk = []; }
        chunk.push(l);
      }
      if (chunk.length) chunks.push(chunk);
      chunks.forEach((c, i) => embed.addFields({
        name: i === 0 ? `${key} (${list.length})` : `${key} (cont.)`,
        value: c.join('\n'),
      }));
    }
    // 25 fields is the hard embed limit.
    if (embed.data.fields?.length > 25) embed.data.fields = embed.data.fields.slice(0, 25);

    return interaction.editReply({ content: '', embeds: [embed] });
  } catch (err) {
    loader.stop();
    return interaction.editReply(`${e('DENY')} ${err.message}`);
  }
}

module.exports = { data, execute };
