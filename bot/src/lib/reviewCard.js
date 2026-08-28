// The review cards posted into the cases / tickets channels, and the button
// handler behind them.
//
// The record id travels in the button customId (`ia:<kind>:<verb>:<id>`), so a
// restart never orphans a pending card — nothing is held in memory.
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const prisma = require('./db');
const { env } = require('./env');
const { isSupervisor, isHicomm, DENIED_REVIEW } = require('./perms');
const { caseHasHicommOnlyPunishment } = require('./actions');
const { canReview, canApproveActions, rankOf } = require('./iaRanks');
const { e } = require('./emoji');
const { announceApproval } = require('./notify');
const { approveCase, denyCase } = require('./discipline');
const { enqueueQuotaAward } = require('./quota');

const AMBER = 0xf5b730, GREEN = 0x2ed896, RED = 0xf04f5e;

function reviewButtons(kind, id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ia:${kind}:approve:${id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`ia:${kind}:deny:${id}`).setLabel('Deny').setStyle(ButtonStyle.Danger),
  );
}

function caseCardEmbed(c, filer) {
  const punishments = Array.isArray(c.actions) && c.actions.length
    ? c.actions.map(a => `• ${a.action}${a.durationDays ? ` (${a.durationDays}d)` : ''}`).join('\n')
    : `• ${c.action}`;
  const subject = c.officerDiscordId
    ? `<@${c.officerDiscordId}>${c.robloxUsername ? ` (${c.robloxUsername})` : ''}`
    : (c.robloxUsername || '*Unknown*');

  return new EmbedBuilder()
    .setColor(AMBER)
    .setTitle(`Case ${c.caseRef}`)
    .addFields(
      { name: '• Subject:',       value: subject,     inline: false },
      { name: '• Punishment(s):', value: punishments, inline: false },
      { name: '• Reason:',        value: c.reason || 'N/A', inline: false },
      { name: '• Notes:',         value: c.notes  || 'N/A', inline: false },
      ...(c.caseLink ? [{ name: '• Evidence:', value: c.caseLink, inline: false }] : []),
    )
    .setFooter({ text: `Filed by ${filer.displayName}`, iconURL: filer.avatarURL })
    .setTimestamp(c.createdAt || new Date());
}

function ticketCardEmbed(t, filer) {
  return new EmbedBuilder()
    .setColor(AMBER)
    .setTitle(`Ticket ${t.ticketRef}`)
    .addFields(
      { name: '• Roblox user:', value: t.robloxUsername, inline: false },
      { name: '• Type:',        value: t.ticketType,     inline: true  },
      { name: '• Submitted:',   value: `${t.submittedAt} (${t.timezone})`, inline: true },
      { name: '• Conclusion:',  value: t.conclusion,     inline: false },
      ...(t.transcriptLink ? [{ name: '• Transcript:', value: t.transcriptLink, inline: false }] : []),
      ...((t.proofImages || []).length ? [{ name: '• Proof:', value: t.proofImages.join('\n').slice(0, 1000), inline: false }] : []),
    )
    .setFooter({ text: `Filed by ${filer.displayName}`, iconURL: filer.avatarURL })
    .setTimestamp(t.createdAt || new Date());
}

async function postCard(client, channelId, embed, kind, id) {
  if (!channelId) { console.warn(`[reviewCard] no channel configured for ${kind}`); return null; }
  try {
    const channel = await client.channels.fetch(channelId);
    const msg = await channel.send({ embeds: [embed], components: [reviewButtons(kind, id)] });
    return msg.id;
  } catch (err) {
    console.error(`[reviewCard] failed to post ${kind} card:`, err.message);
    return null;
  }
}

const postCaseCard = (client, c, filer) =>
  postCard(client, env('CASES_CHANNEL_ID'), caseCardEmbed(c, filer), 'case', c.id);
const postTicketCard = (client, t, filer) =>
  postCard(client, env('TICKETS_CHANNEL_ID'), ticketCardEmbed(t, filer), 'ticket', t.id);

/** Stamp the card with the outcome and strip its buttons so it can't be re-actioned. */
async function finaliseCard(interaction, { approved, actor }) {
  const original = interaction.message.embeds[0];
  const embed = EmbedBuilder.from(original)
    .setColor(approved ? GREEN : RED)
    .setAuthor({
      name: `${approved ? 'Approved' : 'Denied'} by ${actor.displayName}`,
      iconURL: actor.avatarURL,
    });
  if (approved) {
    embed.addFields({ name: '• Approved by:', value: `<@${actor.id}>`, inline: false });
  }
  await interaction.message.edit({ embeds: [embed], components: [] }).catch(() => {});
}

async function handleReviewButton(interaction, bot) {
  const [, kind, verb, recordId] = interaction.customId.split(':');
  const member = interaction.member;

  // Review cards are an IA-server artefact; a card copied elsewhere is inert.
  const iaGuild = env('IA_GUILD_ID') || env('DISCORD_GUILD_ID');
  if (iaGuild && interaction.guildId !== iaGuild) {
    return interaction.reply({
      content: '⛔ Case review only happens in the Internal Affairs server.',
      flags: MessageFlags.Ephemeral,
    });
  }

  // Either ladder may authorise: the IA rank roles, or the site-style tiers.
  if (!canReview(member) && !isSupervisor(member)) {
    return interaction.reply({ content: DENIED_REVIEW, flags: MessageFlags.Ephemeral });
  }

  const actor = {
    id: interaction.user.id,
    displayName: interaction.member?.displayName || interaction.user.username,
    avatarURL: interaction.user.displayAvatarURL({ extension: 'png', size: 64 }),
  };

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (kind === 'case') {
    const c = await prisma.case.findUnique({ where: { id: recordId } });
    if (!c) return interaction.editReply('❌ Case not found.');
    if (c.status !== 'PENDING') {
      await interaction.message.edit({ components: [] }).catch(() => {});
      return interaction.editReply('❌ Case is not pending');
    }
    if (c.submitterDiscordId === interaction.user.id) {
      return interaction.editReply('❌ You cannot review your own submission.');
    }
    if (verb === 'approve') {
      const names = (c.actions || []).map(a => a.action || a);
      const verdict = canApproveActions(member, names);
      if (!verdict.ok && !isHicomm(member)) {
        return interaction.editReply(
          `${e('DENIED_MARK')} **${verdict.blocking}** needs **${verdict.required.abbr} — ${verdict.required.name}** or above. ` +
          `You are ${rankOf(member)?.abbr || 'unranked'}.`);
      }
      // The site-tier rule still stands on top of the ladder.
      if (!isHicomm(member) && caseHasHicommOnlyPunishment(c.actions || [])) {
        return interaction.editReply('Only HICOMM can approve a case involving a Blacklist or Termination.');
      }
    }

    const result = verb === 'approve'
      ? await approveCase(c.id, interaction.user.id, bot)
      : await denyCase(c.id, interaction.user.id, 'Denied from the review card');
    if (!result.ok) return interaction.editReply(`❌ ${result.error}`);

    await finaliseCard(interaction, { approved: verb === 'approve', actor });

    if (verb !== 'approve') {
      return interaction.editReply(`${e('DENY')} Case ${c.caseRef} denied.`);
    }

    // DM the subject, post the MET notice. Roles/exile/demotion already ran
    // inside approveCase; this is the announcement half.
    const fresh = await prisma.case.findUnique({ where: { id: c.id } });
    const sent = await announceApproval(interaction.client, fresh);
    return interaction.editReply(
      `${e('APPROVE')} Case ${c.caseRef} approved.\n` +
      `${sent.dm ? e('APPROVE') : e('WARNING')} DM to subject ${sent.dm ? 'sent' : 'not delivered (DMs closed or no Discord link)'}\n` +
      `${sent.notice ? e('APPROVE') : e('WARNING')} MET notice ${sent.notice ? 'posted' : 'skipped (MET_NOTICES_CHANNEL_ID unset)'}`);
  }

  if (kind === 'ticket') {
    const t = await prisma.ticket.findUnique({ where: { id: recordId } });
    if (!t) return interaction.editReply('❌ Ticket not found.');
    if (t.status !== 'PENDING') {
      await interaction.message.edit({ components: [] }).catch(() => {});
      return interaction.editReply('❌ Ticket is not pending');
    }
    if (t.filerDiscordId === interaction.user.id) {
      return interaction.editReply('❌ You cannot review your own submission.');
    }
    // IA Complaints are a High Command matter.
    if (t.ticketType === 'HICOMM' && !isHicomm(member)) {
      return interaction.editReply('Only HICOMM can action IA Complaint (HICOMM) tickets.');
    }

    const approved = verb === 'approve';
    await prisma.ticket.update({
      where: { id: t.id },
      data: { status: approved ? 'APPROVED' : 'DENIED', reviewedBy: interaction.user.id, reviewedAt: new Date() },
    });

    if (approved) {
      // Resolve the filer's Roblox name for the sheet, caching it for next time.
      let robloxUsername = (await prisma.robloxLink.findUnique({
        where: { discordId: t.filerDiscordId } }).catch(() => null))?.robloxUsername || null;
      if (!robloxUsername) {
        const roblox = require('./roblox');
        const rbxId = await roblox.getRobloxIdFromDiscord(t.filerDiscordId);
        if (rbxId) {
          robloxUsername = (await roblox.getRobloxUserInfo(rbxId))?.name || null;
          if (robloxUsername) await roblox.cacheLink(t.filerDiscordId, rbxId, robloxUsername);
        }
      }
      await enqueueQuotaAward({
        refType: 'ticket', refId: t.id,
        discordId: t.filerDiscordId, robloxUsername,
        points: 2, label: `ticket ${t.ticketRef}`,
      });
    }

    await finaliseCard(interaction, { approved, actor });
    return interaction.editReply(`✅ Ticket ${t.ticketRef} ${approved ? 'approved' : 'denied'}.`);
  }

  return interaction.editReply('❌ Unknown review action.');
}

module.exports = { postCaseCard, postTicketCard, handleReviewButton, reviewButtons };
