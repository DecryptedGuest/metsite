const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { isHicomm, DENIED } = require('../lib/perms');
const { listJoinRequests, resolveJoinRequest } = require('../lib/roblox');

const data = new SlashCommandBuilder()
  .setName('pendingjoin')
  .setDescription('Roblox group join requests')
  .addSubcommand(s => s.setName('list').setDescription('Show pending join requests')
    .addStringOption(o => o.setName('cursor').setDescription('Next-page cursor from a previous listing')))
  .addSubcommand(s => s.setName('approve').setDescription('Approve a join request')
    .addStringOption(o => o.setName('roblox_user_id').setDescription('The requester\'s Roblox user id').setRequired(true)))
  .addSubcommand(s => s.setName('decline').setDescription('Decline a join request')
    .addStringOption(o => o.setName('roblox_user_id').setDescription('The requester\'s Roblox user id').setRequired(true)));

async function execute(interaction) {
  if (!isHicomm(interaction.member)) {
    return interaction.reply({ content: DENIED, flags: MessageFlags.Ephemeral });
  }
  const sub = interaction.options.getSubcommand();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    if (sub === 'list') {
      const { requests, nextPageToken } = await listJoinRequests(interaction.options.getString('cursor'));
      if (!requests.length) return interaction.editReply('✅ No pending join requests.');

      const lines = requests.map(r =>
        `\`${r.userId}\` **${r.username}**${r.displayName !== r.username ? ` (${r.displayName})` : ''}` +
        `${r.requestedAt ? ` — <t:${Math.floor(new Date(r.requestedAt) / 1000)}:R>` : ''}`);

      const embed = new EmbedBuilder()
        .setColor(0x4a8fff)
        .setTitle(`Pending join requests (${requests.length})`)
        .setDescription(lines.join('\n').slice(0, 3900))
        .setFooter({ text: nextPageToken
          ? 'More pages — re-run with the cursor below'
          : 'End of list' });
      if (nextPageToken) embed.addFields({ name: 'Next cursor', value: `\`${nextPageToken}\`` });
      return interaction.editReply({ embeds: [embed] });
    }

    const userId = interaction.options.getString('roblox_user_id').trim();
    await resolveJoinRequest(userId, sub === 'approve' ? 'approve' : 'decline');
    return interaction.editReply(`✅ Join request for \`${userId}\` ${sub === 'approve' ? 'approved' : 'declined'}.`);
  } catch (err) {
    return interaction.editReply(`❌ ${err.message}`);
  }
}

module.exports = { data, execute };
