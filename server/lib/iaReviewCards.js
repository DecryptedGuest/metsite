// server/lib/iaReviewCards.js
// The cards posted into the IA cases and tickets channels.
//
// ── Why these are built here rather than inline ────────────────────
//
// The old cards were written where the record was created, so the layout drifted
// per caller and every reader had to re-learn it. Worse, they printed the whole
// submission form — including the rows nobody filled in — so a card listing
// "Suspension [Specify number of days]" looked exactly like a card issuing a
// suspension. That ambiguity is the thing to fix: a card must show what was
// DECIDED, never what the form offered.
//
// So: one builder, one shape, used by both cases and tickets.
//
// ── The shape ─────────────────────────────────────────────────────
//
//   colour + title    state at a glance, before any reading
//   subject           WHO this is about, first, always
//   punishments       only the ones actually applied, with durations
//   reason / notes    the substance
//   officer + decision who did it and what happened, as a footer line
//
// Anything unset is omitted rather than rendered as "N/A" — an empty row is
// noise that pushes the real content off the screen.
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const AMBER = 0xf5b730;   // awaiting review
const GREEN = 0x2ed896;   // approved
const RED   = 0xf04f5e;   // denied

const casesChannelId   = () => process.env.CASES_CHANNEL_ID || process.env.IA_CASES_CHANNEL_ID || null;
const ticketsChannelId = () => process.env.TICKETS_CHANNEL_ID || process.env.IA_TICKETS_CHANNEL_ID || null;
const reviewerRoleId   = () => process.env.IA_REVIEWER_ROLE_ID || null;

/** The reviewer ping, or nothing if no role is configured. */
function reviewerPing() {
  const id = reviewerRoleId();
  return id ? `<@&${id}>` : undefined;
}

const trim = (s, n) => {
  const t = String(s == null ? '' : s).trim();
  if (!t) return '';
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/**
 * Punishments, one per line, showing only what was actually applied.
 *
 * `actions` may be the enriched JSON ([{ action, durationDays, code }]) or the
 * legacy comma-joined string. Anything that still carries a form placeholder in
 * brackets is dropped: it was never a decision.
 */
function punishmentLines(actions, fallbackAction) {
  let list = [];
  if (Array.isArray(actions) && actions.length) list = actions;
  else if (fallbackAction) list = String(fallbackAction).split(',').map(a => ({ action: a.trim() }));

  const lines = list
    .map(a => (typeof a === 'string' ? { action: a } : a))
    .filter(a => a && a.action)
    // "Suspension [Specify number of days]" is an unfilled template row.
    .filter(a => !/\[(specify|n\/a|number of days)[^\]]*\]/i.test(a.action))
    .map(a => {
      const name = a.action.replace(/\s*\[[^\]]*\]\s*$/, '').trim();
      const dur  = a.durationDays ? ` · **${a.durationDays}** day${a.durationDays === 1 ? '' : 's'}` : '';
      const code = a.code ? ` · \`${a.code}\`` : '';
      return `**${name}**${dur}${code}`;
    });

  return lines.length ? lines.map(l => `› ${l}`).join('\n') : null;
}

/** "IA-SPVR | Fxkresl" → a display name that fits a footer. */
function actorName(actor) {
  if (!actor) return null;
  return actor.displayName || actor.username || actor.tag || null;
}

function reviewButtons(kind, id, { disabled = false } = {}) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`iareview:${kind}:approve:${id}`)
      .setLabel('Approve').setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`iareview:${kind}:deny:${id}`)
      .setLabel('Deny').setStyle(ButtonStyle.Danger).setDisabled(disabled),
  );
}

/**
 * The case card.
 * @param {object} kase   the Case row
 * @param {object} extra  { filer, subjectAvatar, decidedBy }
 */
function caseCard(kase, extra = {}) {
  const status = String(kase.status || 'PENDING').toUpperCase();
  const colour = status === 'APPROVED' ? GREEN : status === 'DENIED' ? RED : AMBER;
  const state  = status === 'APPROVED' ? 'Approved' : status === 'DENIED' ? 'Denied' : 'Awaiting review';

  const embed = new EmbedBuilder()
    .setColor(colour)
    .setTitle(`Case ${kase.caseRef || ''}`.trim())
    .setTimestamp(kase.createdAt || new Date());

  // The document, when there is one, is the most-clicked thing on the card.
  if (kase.caseLink || kase.docUrl) embed.setURL(kase.caseLink || kase.docUrl);

  // WHO, first. A card whose subject you have to hunt for is the main
  // complaint about the old layout.
  const subject = kase.officerDiscordId
    ? `<@${kase.officerDiscordId}>${kase.robloxUsername ? ` · \`${kase.robloxUsername}\`` : ''}`
    : (kase.robloxUsername ? `\`${kase.robloxUsername}\`` : '*not identified*');
  embed.addFields({ name: 'Officer', value: subject, inline: false });

  const punishments = punishmentLines(kase.actions, kase.action);
  if (punishments) embed.addFields({ name: 'Punishment', value: trim(punishments, 1024), inline: false });

  if (kase.reason) embed.addFields({ name: 'Reason', value: trim(kase.reason, 1024), inline: false });
  if (kase.notes && kase.notes !== 'N/A') {
    embed.addFields({ name: 'Notes', value: trim(kase.notes, 1024), inline: false });
  }
  if (kase.blacklistCode) {
    embed.addFields({
      name: 'Blacklist code',
      value: `\`${kase.blacklistCode}\`${kase.blacklistReason ? ` — ${kase.blacklistReason}` : ''}`,
      inline: true,
    });
  }

  const filer = actorName(extra.filer) || kase.reviewedByRaw || null;
  if (filer) embed.setAuthor({ name: `Filed by ${filer}`, iconURL: extra.filer?.avatarURL || undefined });

  const decided = actorName(extra.decidedBy);
  embed.setFooter({
    text: status === 'PENDING'
      ? `${state} · Internal Affairs`
      : `${state}${decided ? ` by ${decided}` : ''} · Internal Affairs`,
    iconURL: extra.decidedBy?.avatarURL || undefined,
  });

  if (extra.subjectAvatar) embed.setThumbnail(extra.subjectAvatar);
  return embed;
}

/** The ticket card. Same grammar, different substance. */
function ticketCard(ticket, extra = {}) {
  const status = String(ticket.status || 'PENDING').toUpperCase();
  const colour = status === 'APPROVED' ? GREEN : status === 'DENIED' ? RED : AMBER;
  const state  = status === 'APPROVED' ? 'Approved' : status === 'DENIED' ? 'Denied' : 'Awaiting review';

  // ticketNo is the short readable number the site shows; ticketRef is
  // Tickety's own unreadable id, so it is only a fallback.
  const ref = ticket.ticketNo != null ? `#${String(ticket.ticketNo).padStart(4, '0')}`
            : (ticket.ticketRef || ticket.ticketName || '');
  const embed = new EmbedBuilder()
    .setColor(colour)
    .setTitle(`Ticket ${ref}`.trim())
    .setTimestamp(ticket.closedAt || ticket.createdAt || new Date());

  if (ticket.transcriptUrl) embed.setURL(ticket.transcriptUrl);

  // Who OPENED it — never confuse this with the handler.
  const who = ticket.creatorDiscordId
    ? `<@${ticket.creatorDiscordId}>${ticket.creatorRobloxUsername ? ` · \`${ticket.creatorRobloxUsername}\`` : ''}`
    : (ticket.creatorUsername || ticket.creatorRobloxUsername || '*not identified*');
  embed.addFields({ name: 'Opened by', value: String(who), inline: true });
  if (ticket.ticketType) {
    embed.addFields({ name: 'Type', value: String(ticket.ticketType).replace(/_/g, ' '), inline: true });
  }
  if (ticket.division) embed.addFields({ name: 'Division', value: String(ticket.division), inline: true });
  if (ticket.reason) {
    embed.addFields({ name: 'Close reason', value: trim(ticket.reason, 1024), inline: false });
  }

  // The handler is who gets paid, so name them plainly, with the rank their
  // nickname carried at the time.
  const handlerName = ticket.closerUsername || ticket.closerRaw || null;
  if (ticket.closerDiscordId || handlerName) {
    embed.addFields({
      name: 'Handled by',
      value: `${ticket.closerDiscordId ? `<@${ticket.closerDiscordId}>` : handlerName}`
           + `${ticket.closerRank ? ` · ${ticket.closerRank}` : ''}`
           + `${ticket.closerIsIa === false ? ' · *not IA — no points*' : ''}`,
      inline: false,
    });
  }

  const handler = actorName(extra.filer) || handlerName || null;
  if (handler) embed.setAuthor({ name: `Handled by ${handler}`, iconURL: extra.filer?.avatarURL || undefined });

  const decided = actorName(extra.decidedBy);
  embed.setFooter({
    text: status === 'PENDING'
      ? `${state}${ticket.closerIsIa === false ? '' : ' · points on approval'} · Internal Affairs`
      : `${state}${decided ? ` by ${decided}` : ''} · Internal Affairs`,
    iconURL: extra.decidedBy?.avatarURL || undefined,
  });
  return embed;
}

/**
 * Post a card and return the message id.
 * Never throws: a channel that cannot be posted to is logged and the caller
 * carries on, because losing the record matters more than losing the card.
 */
async function postCard(client, channelId, embed, components, { ping = false } = {}) {
  if (!client || !channelId) return null;
  try {
    const channel = await client.channels.fetch(String(channelId));
    const msg = await channel.send({
      content: ping ? reviewerPing() : undefined,
      embeds: [embed],
      components: components ? [components] : [],
      allowedMentions: ping ? { parse: ['roles'] } : { parse: [] },
    });
    return msg.id;
  } catch (err) {
    console.error(`[IA] could not post to channel ${channelId}: ${err.message}`
      + ' · check the id and that the bot can View Channel + Send Messages there');
    return null;
  }
}

const postCaseCard = (client, kase, extra) =>
  postCard(client, casesChannelId(), caseCard(kase, extra),
    reviewButtons('case', kase.id), { ping: true });

const postTicketCard = (client, ticket, extra) =>
  postCard(client, ticketsChannelId(), ticketCard(ticket, extra),
    reviewButtons('ticket', ticket.id), { ping: true });

/** Rewrite a card in place once it has been decided, and take the buttons away. */
async function finaliseCard(client, channelId, messageId, embed) {
  if (!client || !channelId || !messageId) return false;
  try {
    const channel = await client.channels.fetch(String(channelId));
    const msg = await channel.messages.fetch(String(messageId));
    await msg.edit({ embeds: [embed], components: [] });
    return true;
  } catch (err) {
    console.warn(`[IA] could not update card ${messageId}: ${err.message}`);
    return false;
  }
}

module.exports = {
  caseCard, ticketCard, punishmentLines,
  postCaseCard, postTicketCard, postCard, finaliseCard, reviewButtons,
  casesChannelId, ticketsChannelId, reviewerRoleId, reviewerPing,
};

// ── Review buttons ────────────────────────────────────────────────
//
// The record id travels in the customId (`iareview:<kind>:<verb>:<id>`), so a
// restart never orphans a pending card: nothing is held in memory.
//
// Approving a ticket is the whole reason the card exists — it is what turns a
// closed ticket into +2 quota points for whoever handled it. Before this, the
// cards were decoration and the points were entered by hand.
async function handleReviewButton(interaction) {
  const [, kind, verb, recordId] = String(interaction.customId || '').split(':');
  const approved = verb === 'approve';

  const prisma = require('./db');
  const { MessageFlags } = require('discord.js');
  const ephemeral = { flags: MessageFlags.Ephemeral };

  // Reviewing is a Supervisor-and-above job; iaAuthority owns that rule so it
  // cannot drift from the rest of IA.
  let allowed = true;
  try {
    const auth = require('./iaAuthority');
    if (typeof auth.canReview === 'function') allowed = !!auth.canReview(interaction.member);
  } catch { /* authority module absent — fall through to the role check below */ }
  if (!allowed) {
    return interaction.reply({ content: '⛔ You are not authorised to review this.', ...ephemeral });
  }

  await interaction.deferReply(ephemeral);

  const actor = {
    id: interaction.user.id,
    displayName: interaction.member?.displayName || interaction.user.username,
    avatarURL: interaction.user.displayAvatarURL({ extension: 'png', size: 64 }),
  };

  try {
    if (kind === 'ticket') {
      const row = await prisma.ticketLog.findUnique({ where: { id: recordId } }).catch(() => null);
      if (!row) return interaction.editReply('That ticket is no longer in the database.');
      if (row.status && row.status !== 'PENDING') {
        await interaction.message.edit({ components: [] }).catch(() => {});
        return interaction.editReply(`Already ${String(row.status).toLowerCase()}.`);
      }
      // Nobody signs off their own work.
      if (row.closerDiscordId && row.closerDiscordId === interaction.user.id) {
        return interaction.editReply('You cannot review a ticket you handled yourself.');
      }

      // reviewTicket owns the decision AND the quota award, including the
      // closerIsIa rule that stops a division officer being paid from IA's
      // quota. Duplicating any of that here would let the two drift.
      const out = await require('./caseDecision')
        .reviewTicket({ ticketId: recordId, actor, action: verb });
      if (!out || out.ok === false) {
        return interaction.editReply(out?.error || 'That was refused.');
      }

      await interaction.message.edit({
        embeds: [ticketCard(out.ticket, { decidedBy: actor })], components: [],
      }).catch(() => {});

      const paid = approved && out.ticket.closerIsIa !== false && out.ticket.closerDiscordId;
      return interaction.editReply(
        `${approved ? 'Approved' : 'Denied'}.${paid ? ' Points queued for the handler.' : ''}`);
    }

    if (kind === 'case') {
      const row = await prisma.case.findUnique({ where: { id: recordId } }).catch(() => null);
      if (!row) return interaction.editReply('That case is no longer in the database.');
      if (row.status && row.status !== 'PENDING') {
        await interaction.message.edit({ components: [] }).catch(() => {});
        return interaction.editReply(`Already ${String(row.status).toLowerCase()}.`);
      }

      // Cases carry consequences (roles, exile, demotion, points), so the real
      // pipeline decides — this button only triggers it.
      const decision = require('./caseDecision');
      const fn = approved ? decision.approveCase : decision.denyCase;
      const out = await fn({ caseId: recordId, actor: { ...actor, member: interaction.member } });
      if (out && out.ok === false) return interaction.editReply(out.error || out.reason || 'Refused.');

      const fresh = await prisma.case.findUnique({ where: { id: recordId } });
      await interaction.message.edit({
        embeds: [caseCard(fresh, { decidedBy: actor })], components: [],
      }).catch(() => {});
      return interaction.editReply(`${approved ? 'Approved' : 'Denied'} ${fresh.caseRef || ''}.`.trim());
    }

    return interaction.editReply('Unknown review action.');
  } catch (err) {
    console.error('[IA] review button failed:', err.message);
    return interaction.editReply('That did not go through: ' + err.message);
  }
}

module.exports.handleReviewButton = handleReviewButton;
