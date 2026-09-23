// XP promotion approval workflow.
// Every XP-driven promotion pauses here until the configured review role approves it.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const XP = require('./xp');
const xpLog = require('./xpLog');
const { e } = require('./emoji');

const CHANNEL_ID = () => process.env.XP_PROMOTION_REVIEW_CHANNEL_ID || '1552170256053833728';
const REVIEW_ROLE_ID = () => process.env.XP_PROMOTION_REVIEW_ROLE_ID || '1422406753231966290';
const TICK = '<:tick:1533231152570040510>';
const CROSS = '<:cross:1533231153866084433>';
const PENDING = '<:pending:1533231156017758369>';

function short(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function buttons(id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`xppromo:approve:${id}`).setLabel('Approve promotion').setStyle(ButtonStyle.Success).setEmoji({ id: '1533231152570040510', name: 'tick' }),
    new ButtonBuilder().setCustomId(`xppromo:deny:${id}`).setLabel('Deny promotion').setStyle(ButtonStyle.Danger).setEmoji({ id: '1533231153866084433', name: 'cross' }),
  );
}

function embed(p, status = 'PENDING') {
  const title = status === 'PENDING'
    ? `${PENDING} Pending Promotion`
    : status === 'APPROVED' ? `${TICK} Promotion Approved` : `${CROSS} Promotion Denied`;
  const color = status === 'PENDING' ? 0xf5b730 : status === 'APPROVED' ? 0x2ed896 : 0xf04f5e;
  const b = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(`${e('met_user')} <@${p.discordId}> ${p.memberName ? `· **${short(p.memberName, 50)}**` : ''}`)
    .addFields(
      { name: 'Rank', value: `**${short(p.fromRank, 40)}** → **${short(p.toRank, 40)}**`, inline: true },
      { name: 'XP', value: `**${p.xp} XP**`, inline: true },
      { name: 'Roblox', value: p.robloxId ? `[${short(p.robloxUsername || p.robloxId, 40)}](https://www.roblox.com/users/${p.robloxId}/profile)\\nID: \`${p.robloxId}\`` : '*Not linked*', inline: false },
      { name: 'Requested by', value: p.issuedById ? `<@${p.issuedById}>` : short(p.issuedBy || 'System', 60), inline: true },
      { name: 'Reason', value: short(p.reason || '*No reason given*', 1000), inline: false },
    )
    .setFooter({ text: 'MET XP · High Command promotion review' })
    .setTimestamp(p.createdAt ? new Date(p.createdAt) : new Date());
  if (p.avatar) b.setThumbnail(p.avatar);
  if (status !== 'PENDING' && p.resolvedById) b.addFields({ name: 'Resolved by', value: `<@${p.resolvedById}>`, inline: true });
  return b;
}

async function queue({ officer, promotion, xp, issuedById, issuedBy, reason }) {
  const pending = await XP.queuePendingPromotion({
    discordId: officer.discordId,
    robloxId: officer.robloxId,
    robloxUsername: officer.robloxUsername,
    memberName: officer.displayName,
    avatar: officer.avatar,
    from: promotion.from,
    to: promotion.to,
    xp,
    issuedById,
    issuedBy,
    reason,
  });
  if (!pending) return null;

  // If a review already exists, update it rather than creating duplicate approval cards.
  if (pending.messageId) {
    await require('./bot').editChannelMessage(CHANNEL_ID(), pending.messageId, {
      content: `<@&${REVIEW_ROLE_ID()}>`,
      embeds: [embed(pending)],
      components: [buttons(pending.id)],
      allowedMentions: { roles: [REVIEW_ROLE_ID()], parse: [] },
    }).catch(() => {});
    return pending;
  }

  const messageId = await require('./bot').postChannelMessage(CHANNEL_ID(), {
    content: `<@&${REVIEW_ROLE_ID()}>`,
    embeds: [embed(pending)],
    components: [buttons(pending.id)],
    allowedMentions: { roles: [REVIEW_ROLE_ID()], parse: [] },
  });
  if (messageId) {
    const saved = await XP.attachPendingPromotionMessage(pending.discordId, pending.id, CHANNEL_ID(), messageId);
    return saved || { ...pending, messageId, channelId: CHANNEL_ID() };
  }
  return pending;
}

async function handleButton(interaction) {
  const parts = String(interaction.customId || '').split(':');
  const action = parts[1];
  const id = parts[2];
  if (!id || !['approve', 'deny'].includes(action)) return;

  const roleId = REVIEW_ROLE_ID();
  if (String(interaction.channelId) !== String(CHANNEL_ID())) {
    return interaction.reply({ content: `${CROSS} This review button is only valid in the promotion review channel.`, ephemeral: true });
  }
  if (!interaction.member?.roles?.cache?.has(roleId)) {
    return interaction.reply({ content: `${CROSS} You need <@&${roleId}> to do this.`, ephemeral: true });
  }

  await interaction.deferUpdate();
  const pending = await XP.resolvePendingPromotion(id, action === 'approve' ? 'APPROVED' : 'REJECTED', interaction.user.id);
  if (!pending) {
    return interaction.editReply({ components: [], content: `${CROSS} This promotion has already been resolved or no longer exists.` }).catch(() => {});
  }

  if (action === 'deny') {
    await interaction.editReply({ content: `<@&${roleId}>`, embeds: [embed(pending, 'REJECTED')], components: [], allowedMentions: { roles: [], parse: [] } }).catch(() => {});
    return;
  }

  const officer = {
    discordId: pending.discordId,
    robloxId: pending.robloxId,
    robloxUsername: pending.robloxUsername,
    displayName: pending.memberName,
    avatar: pending.avatar,
  };
  const promotion = {
    from: { code: pending.fromCode, name: pending.fromRank, at: 0 },
    to: { code: pending.toCode, name: pending.toRank, at: pending.xp },
  };

  try {
    const result = await require('./xpCommand').promote({
      officer, promotion, xp: pending.xp,
      issuedById: pending.issuedById,
      issuedBy: pending.issuedBy,
    });
    await interaction.editReply({
      content: `<@&${roleId}>`,
      embeds: [embed({ ...pending, resolvedById: interaction.user.id, groupResult: result.group }, 'APPROVED')],
      components: [],
      allowedMentions: { roles: [], parse: [] },
    }).catch(() => {});
  } catch (err) {
    // The approval is recorded, but the existing promotion routine remains best-effort.
    await interaction.editReply({
      content: `<@&${roleId}>\\n${CROSS} Approval recorded, but the promotion action failed: ${short(err.message, 500)}`,
      embeds: [embed({ ...pending, resolvedById: interaction.user.id }, 'APPROVED')],
      components: [],
      allowedMentions: { roles: [], parse: [] },
    }).catch(() => {});
  }
}

module.exports = { CHANNEL_ID, REVIEW_ROLE_ID, queue, handleButton, embed };
