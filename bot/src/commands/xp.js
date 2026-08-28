const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
        ButtonStyle, MessageFlags } = require('discord.js');
const { isIA, isHicomm, DENIED } = require('../lib/perms');
const { getMemberPoints, getAllMembersPoints, setMemberExempt, resetAllQuota } = require('../lib/quota');
const { sendQuotaCheckWebhook } = require('../lib/webhook');
const roblox = require('../lib/roblox');

const data = new SlashCommandBuilder()
  .setName('xp')
  .setDescription('Quota points')
  .addSubcommand(s => s.setName('me').setDescription('Your own quota points this week'))
  .addSubcommand(s => s.setName('check').setDescription("Another member's quota points")
    .addUserOption(o => o.setName('user').setDescription('The member').setRequired(true)))
  .addSubcommand(s => s.setName('review').setDescription('Post the weekly quota review')
    .addStringOption(o => o.setName('week').setDescription('Week label, e.g. "12–18 May"')))
  .addSubcommand(s => s.setName('reset').setDescription("Clear everyone's weekly points (destructive)"))
  .addSubcommand(s => s.setName('exempt').setDescription('Mark a member exempt (writes EX)')
    .addStringOption(o => o.setName('user').setDescription('Roblox username or Discord mention/ID').setRequired(true)))
  .addSubcommand(s => s.setName('iotw').setDescription('Set the Investigator of the Week')
    .addUserOption(o => o.setName('user').setDescription('The member').setRequired(true)));

function pointsEmbed(title, r) {
  const days = Object.entries(r.days).map(([d, v]) => `\`${d}\` ${v}`).join('  ');
  const target = r.quota.exempt ? 'Exempt'
    : (r.quota.target != null ? `${r.quota.target}${r.quota.reducedBy ? ` (−${r.quota.reducedBy} reduction)` : ''}` : 'Unknown');
  const met = r.quota.exempt ? '➖' : (r.quota.target != null && r.total >= r.quota.target ? '✅' : '❌');

  return new EmbedBuilder()
    .setColor(r.quota.exempt ? 0x9b7cf5 : (r.quota.target != null && r.total >= r.quota.target ? 0x2ed896 : 0xf5b730))
    .setTitle(title)
    .addFields(
      { name: 'Rank',   value: r.rank || '*Unknown*', inline: true },
      { name: 'Tier',   value: r.quota.tier || '*Unknown*', inline: true },
      { name: 'Target', value: String(target), inline: true },
      { name: 'Total',  value: `${met} **${r.total}**`, inline: true },
      { name: 'Remaining', value: String(r.remaining), inline: true },
      { name: 'By day', value: days || '*No day columns found*', inline: false },
    );
}

async function execute(interaction, bot) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'me' || sub === 'check') {
    if (sub === 'check' && !isIA(interaction.member)) {
      return interaction.reply({ content: DENIED, flags: MessageFlags.Ephemeral });
    }
    const user = sub === 'me' ? interaction.user : interaction.options.getUser('user');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const rbxId = await roblox.getRobloxIdFromDiscord(user.id);
    const info  = rbxId ? await roblox.getRobloxUserInfo(rbxId) : null;
    const r = await getMemberPoints({ discordId: user.id, robloxUsername: info?.name || null }, bot);

    if (r === null) return interaction.editReply('❌ The quota sheet is not configured.');
    if (!r.found)   return interaction.editReply(`❌ ${user} was not found on the quota sheet.`);
    return interaction.editReply({ embeds: [pointsEmbed(`Quota — ${info?.name || user.username}`, r)] });
  }

  if (sub === 'review') {
    if (!isHicomm(interaction.member)) {
      return interaction.reply({ content: DENIED, flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const members = await getAllMembersPoints(bot);
    if (members === null) return interaction.editReply('❌ The quota sheet is not configured.');
    if (!members.length)  return interaction.editReply('❌ No members found on the sheet.');

    const results = members.map(m => ({
      username: m.username, rank: m.rank, total: m.total,
      target: m.quota.target, exempt: m.quota.exempt,
      status: m.quota.exempt || m.met ? 'pass' : 'fail',
      reason: m.quota.exempt ? null : (m.quota.target == null ? 'unknown rank' : 'under target'),
    }));

    const ok = await sendQuotaCheckWebhook({
      reviewerName: interaction.member?.displayName || interaction.user.username,
      reviewerId:   interaction.user.id,
      results,
      weekLabel:    interaction.options.getString('week'),
      iotwUsername: null,
    });
    return interaction.editReply(ok
      ? `✅ Posted the weekly review — ${results.filter(r => r.status === 'pass').length} passed, ${results.filter(r => r.status === 'fail').length} failed.`
      : '❌ The quota results webhook is not configured or failed to send.');
  }

  if (sub === 'reset') {
    if (!isHicomm(interaction.member)) {
      return interaction.reply({ content: DENIED, flags: MessageFlags.Ephemeral });
    }
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`xp:reset:confirm:${interaction.user.id}`)
        .setLabel('Reset everyone').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`xp:reset:cancel:${interaction.user.id}`)
        .setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );
    return interaction.reply({
      content: '⚠️ This clears **every** member\'s weekly points. `EX` and `LOA` markers are left alone. Continue?',
      components: [row], flags: MessageFlags.Ephemeral,
    });
  }

  if (sub === 'exempt') {
    if (!isHicomm(interaction.member)) {
      return interaction.reply({ content: DENIED, flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const raw = interaction.options.getString('user').trim();
    const mention = raw.match(/^<@!?(\d+)>$/);
    const discordId = mention ? mention[1] : (/^\d{15,25}$/.test(raw) ? raw : null);

    let username = raw;
    if (discordId) {
      const rbxId = await roblox.getRobloxIdFromDiscord(discordId);
      const info  = rbxId ? await roblox.getRobloxUserInfo(rbxId) : null;
      if (!info) return interaction.editReply('❌ That Discord account is not linked to a Roblox account.');
      username = info.name;
    }
    const result = await setMemberExempt(username);
    return interaction.editReply(result.ok ? `✅ **${username}** is now exempt (EX).` : `❌ ${result.error}`);
  }

  if (sub === 'iotw') {
    if (!isHicomm(interaction.member)) {
      return interaction.reply({ content: DENIED, flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const user = interaction.options.getUser('user');
    const result = await bot.setExclusiveRoleHolder(
      require('../lib/quota').REDUCTION_GUILD_ID(),
      require('../lib/quota').REDUCTION_ROLE_ID(),
      user.id);
    if (!result.ok) return interaction.editReply(`❌ ${result.error}`);
    return interaction.editReply(`✅ ${user} is now ⭐ Investigator of the Week (removed from ${result.removed} other member(s)).`);
  }
}

/** Confirmation buttons for `/xp reset`. */
async function handleButton(interaction) {
  const [, , verb, ownerId] = interaction.customId.split(':');
  if (interaction.user.id !== ownerId) {
    return interaction.reply({ content: '⛔ That confirmation is not yours.', flags: MessageFlags.Ephemeral });
  }
  if (verb === 'cancel') {
    return interaction.update({ content: 'Cancelled — nothing was changed.', components: [] });
  }
  await interaction.update({ content: '⏳ Resetting…', components: [] });
  const result = await resetAllQuota();
  return interaction.editReply(result.ok
    ? `✅ Weekly quota reset — ${result.cleared ?? 'all'} cell(s) cleared.`
    : `❌ ${result.error}`);
}

module.exports = { scope: 'ia', data, execute, handleButton };
