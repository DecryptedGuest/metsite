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

// The Internal Affairs review channels and the role that reviews them.
//
// Hardcoded, deliberately. These were env-only, and unset, which meant every
// card was built, found no channel to post to, and was dropped: a ticket closed
// in the MET server produced nothing at all, silently. A channel id that never
// changes should not be a thing you can forget to configure.
//
// IA_REVIEWER_ROLE_iD is read too. Environment variable names are
// case-sensitive on Linux, so a var set with that lower-case "i" never matched
// the lookup and the ping silently did nothing.
const casesChannelId   = () =>
  process.env.CASES_CHANNEL_ID || process.env.IA_CASES_CHANNEL_ID || '1537076390829101057';
const ticketsChannelId = () =>
  process.env.TICKETS_CHANNEL_ID || process.env.IA_TICKETS_CHANNEL_ID || '1537076390829101058';
const reviewerRoleId   = () =>
  process.env.IA_REVIEWER_ROLE_ID || process.env.IA_REVIEWER_ROLE_iD || '1537076386198716439';

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
 * A field value Discord will accept.
 *
 * An embed field value must be 1..1024 characters. An EMPTY one is rejected with
 * a throw, and a record with a blank column produces one easily — `trim(' ')` is
 * the empty string, and the guard around it was a truthiness check on the raw
 * value, which " " passes. Every field goes through here now, so no single blank
 * column can take the whole card down.
 */
const field = (name, value, inline = false) => {
  const v = trim(value, 1024);
  return v ? { name: trim(name, 256) || 'Field', value: v, inline } : null;
};

/** Add only the fields that are actually renderable, capped at Discord's 25. */
function addFields(embed, ...fields) {
  const usable = fields.filter(Boolean).slice(0, 25 - (embed.data.fields || []).length);
  if (usable.length) embed.addFields(usable);
  return embed;
}

/** A date Discord will accept, or now. setTimestamp throws on an invalid one. */
function safeDate(value) {
  const d = value ? new Date(value) : null;
  return d && !isNaN(d.getTime()) ? d : new Date();
}

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
    .setTimestamp(safeDate(kase.createdAt));

  // The document, when there is one, is the most-clicked thing on the card.
  const caseLink = safeUrl(kase.caseLink || kase.docUrl);
  if (caseLink) embed.setURL(caseLink);

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
      value: `\`${kase.blacklistCode}\`${kase.blacklistReason ? ` · ${kase.blacklistReason}` : ''}`,
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

/**
 * The ticket card.
 *
 * A reviewer approving this is deciding whether somebody gets paid for it, so
 * the card has to carry everything that decision needs WITHOUT opening the
 * transcript: which ticket, who opened it, who handled it and at what rank,
 * when it closed, why it closed, and what approving it is worth. A card that
 * only says "a ticket exists" makes the reviewer do the lookup every time.
 */
function ticketCard(ticket, extra = {}) {
  const status = String(ticket.status || 'PENDING').toUpperCase();
  const colour = status === 'APPROVED' ? GREEN : status === 'DENIED' ? RED : AMBER;
  const state  = status === 'APPROVED' ? 'Approved' : status === 'DENIED' ? 'Denied' : 'Awaiting review';

  const ref = ticket.ticketNo != null ? `#${String(ticket.ticketNo).padStart(4, '0')}`
            : (ticket.ticketRef || ticket.ticketName || '');

  const embed = new EmbedBuilder()
    .setColor(colour)
    .setTitle(`Ticket ${ref}`.trim())
    .setTimestamp(safeDate(ticket.closedAt || ticket.createdAt));

  // The channel name is how people actually refer to a ticket ("that
  // no_onee_01 one"), so it belongs above the fold, not in a footer.
  if (ticket.ticketName) embed.setDescription(`\`${ticket.ticketName}\``);
  const ticketLink = safeUrl(ticket.transcriptUrl);
  if (ticketLink) embed.setURL(ticketLink);

  const opened = ticket.creatorDiscordId
    ? `<@${ticket.creatorDiscordId}>${ticket.creatorRobloxUsername ? `\n\`${ticket.creatorRobloxUsername}\`` : ''}`
    : (ticket.creatorUsername || ticket.creatorRobloxUsername || '*not identified*');

  const handlerName = ticket.closerUsername || ticket.closerRaw || null;
  const handled = ticket.closerDiscordId
    ? `<@${ticket.closerDiscordId}>${ticket.closerRank ? `\n${ticket.closerRank}` : ''}`
    : (handlerName
        ? `${handlerName}${ticket.closerRank ? `\n${ticket.closerRank}` : ''}`
        // Not a dead end: the sweep re-reads the log and fills this in, and the
        // card is re-rendered when it does.
        : '*being identified*');

  const closedAt = ticket.closedAt && !isNaN(new Date(ticket.closedAt).getTime())
    ? Math.floor(new Date(ticket.closedAt).getTime() / 1000) : null;
  addFields(embed,
    field('Opened by',  opened,  true),
    field('Handled by', handled, true),
    field('Closed', closedAt ? `<t:${closedAt}:f>\n<t:${closedAt}:R>` : '*unknown*', true),
    field('Type',     String(ticket.ticketType || 'GENERAL_SUPPORT').replace(/_/g, ' '), true),
    field('Division', String(ticket.division || 'MET'), true),
  );

  // What approving it pays, stated up front and in the word people use for it.
  // "Worth: +2 pts" read like a score the ticket already had; these are quota
  // points, they are only awarded on approval, and the reviewer pressing the
  // button is the person awarding them. The rate is per type (an appeal pays
  // more), and a non-IA handler is paid nothing at all — nobody should have to
  // know that rule to read the card.
  //
  // Three distinct answers, and they used to be two. A ticket whose handler had
  // not been resolved said "No points · handler is not IA", which read as a
  // decision about a named person on a card whose Handled by field said "not
  // identified". Not knowing who closed it is its own state, and it is
  // temporary: the handler backfill fills it in and the card is re-rendered.
  const identified = !!(ticket.closerDiscordId || ticket.closerUserId || ticket.closerRaw);
  let points = 'Not known';
  try {
    const { ticketPointsFor } = require('./quota');
    const n = ticketPointsFor(ticket.ticketType);
    const word = n === 1 ? 'point' : 'points';
    if (!identified) {
      points = `**${n}** quota ${word}, once the handler is identified`;
    } else if (ticket.closerIsIa === false) {
      points = 'None · the handler is not Internal Affairs';
    } else {
      points = String(ticket.status || 'PENDING').toUpperCase() === 'APPROVED'
        ? `**${n}** quota ${word} awarded`
        : `**${n}** quota ${word} on approval`;
    }
  } catch { /* quota not loaded — leave the placeholder */ }
  addFields(embed, field('Quota points', points, true));

  // The close reason is the substance of the decision.
  addFields(embed, field('Close reason', ticket.reason));

  // Tickety's own id, kept last: unreadable, but it is what you search with
  // when somebody disputes a decision.
  if (ticket.ticketRef && ticket.ticketNo != null) {
    addFields(embed, field('Ticket ID', `\`${trim(ticket.ticketRef, 90)}\``));
  }

  const decided = actorName(extra.decidedBy) || ticket.reviewedByName;
  embed.setFooter({
    text: status === 'PENDING'
      ? `${state} · Internal Affairs`
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
    // Name the actual cause. "Missing Access" on a channel fetch almost always
    // means the bot is not in that SERVER at all, not that one channel is
    // locked down — and telling somebody to check channel permissions when the
    // bot was never invited sends them looking in the wrong place.
    const why = /Missing Access|50001/i.test(err.message)
      ? 'the bot cannot see that channel · usually this means it is not in that server at all'
        + ' · re-invite it with the "bot" and "applications.commands" scopes, then give it'
        + ' View Channel + Send Messages there'
      : /Unknown Channel|10003/i.test(err.message)
        ? 'there is no such channel · the id is wrong or the channel was deleted'
        : err.message;
    console.error(`[IA] could not post to channel ${channelId} · ${why}`);
    return null;
  }
}

/**
 * Build a card and post it, with the BUILD inside the guard.
 *
 * postCaseCard and postTicketCard used to pass `caseCard(...)` and
 * `ticketComponents(...)` as ARGUMENTS to postCard. Arguments are evaluated
 * before the call, so a throw while building the embed happened OUTSIDE
 * postCard's try/catch. It escaped into queueCard, which had no catch, and
 * landed on `queueCard(created).catch(() => {})` in the ingest — swallowed
 * whole, with no log line anywhere.
 *
 * So a single bad value (a transcript link that is not a URL, an empty field
 * value, an unparseable date) made the review card vanish in complete silence,
 * which is indistinguishable from the ingest never having run.
 */
async function buildAndPost(client, channelId, build, what) {
  if (!client || !channelId) return null;
  let embed, components;
  try {
    ({ embed, components } = build());
  } catch (err) {
    console.error(`[IA] could not BUILD the ${what} card · ${err.message}`
      + ' · the record is stored; this is a card-rendering fault, not a lost record');
    return null;
  }
  return postCard(client, channelId, embed, components, { ping: true });
}

const postCaseCard = (client, kase, extra) =>
  buildAndPost(client, casesChannelId(),
    () => ({ embed: caseCard(kase, extra), components: reviewButtons('case', kase.id) }), 'case');

/**
 * A link discord.js will actually accept, or null.
 *
 * ButtonBuilder.setURL and EmbedBuilder.setURL both THROW on anything that is not
 * a valid http(s) URL, and that throw happened while the card was being BUILT —
 * see postTicketCard below for why that was fatal and silent.
 */
function safeUrl(value) {
  const v = String(value == null ? '' : value).trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? v : null;
  } catch { return null; }
}

function ticketComponents(ticket) {
  const row = reviewButtons('ticket', ticket.id);
  const link = safeUrl(ticket.transcriptUrl);
  if (link) {
    row.addComponents(new ButtonBuilder()
      .setLabel('Transcript').setStyle(ButtonStyle.Link).setURL(link));
  }
  return row;
}

const postTicketCard = (client, ticket, extra) =>
  buildAndPost(client, ticketsChannelId(),
    () => ({ embed: ticketCard(ticket, extra), components: ticketComponents(ticket) }), 'ticket');

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

  // ── Who is pressing this? ───────────────────────────────────────
  // This used to build an actor out of the Discord user and guess at the gate,
  // and got three things wrong at once:
  //
  //   * it looked for `auth.canReview`, which does not exist on iaAuthority
  //     (the real names are canReviewTicket and canDecideCase), so the check
  //     silently evaluated to "allowed" and ANYBODY could press Approve;
  //   * it passed no `role`, so the Supervisor guard on a Termination or
  //     Blacklist never fired from Discord;
  //   * it passed the Discord id as `actor.id`, but CaseAction.performedBy is a
  //     foreign key to User.id, so approving from a card threw on the audit row
  //     AFTER the case had already been claimed as approved.
  //
  // resolveAuthority answers all three: it maps the Discord user to their
  // dashboard account and IA standing, which is what every gate is written
  // against, and it is the same resolver the /ia dashboard uses.
  await interaction.deferReply(ephemeral);

  const authority = require('./iaAuthority');
  const auth = await authority.resolveAuthority(interaction);
  if (!auth.ok) return interaction.editReply(`⛔ ${auth.why || 'You are not authorised to review this.'}`);

  const actor = {
    id: auth.userId,                 // User.id — what performedBy is a key to
    role: auth.role,                 // what the punishment-tier gate reads
    discordId: String(interaction.user.id),
    displayName: interaction.member?.displayName || interaction.user.username,
    discordUsername: interaction.user.username,
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
      const may = authority.canReviewTicket(auth, row);
      if (!may.allowed) return interaction.editReply(`⛔ ${may.reason}`);
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

      // Say what was actually paid and to whom. "Points queued" left the
      // reviewer to guess how many and for which of the two people on the card.
      let line = approved ? 'Approved.' : 'Denied.';
      if (approved) {
        const t = out.ticket;
        const handler = t.closerDiscordId ? `<@${t.closerDiscordId}>` : (t.closerUsername || 'the handler');
        if (!(t.closerDiscordId || t.closerUserId)) {
          line += ' No points yet: the handler is still being identified.';
        } else if (t.closerIsIa === false) {
          line += ` No points: ${handler} is not Internal Affairs.`;
        } else {
          const { ticketPointsFor } = require('./quota');
          const n = ticketPointsFor(t.ticketType);
          line += ` ${n} quota ${n === 1 ? 'point' : 'points'} queued for ${handler}.`;
        }
      }
      return interaction.editReply({ content: line, allowedMentions: { parse: [] } });
    }

    if (kind === 'case') {
      const row = await prisma.case.findUnique({
        where: { id: recordId },
        include: { casePunishments: { select: { action: true } } },
      }).catch(() => null);
      if (!row) return interaction.editReply('That case is no longer in the database.');
      if (row.status && row.status !== 'PENDING') {
        await interaction.message.edit({ components: [] }).catch(() => {});
        return interaction.editReply(`Already ${String(row.status).toLowerCase()}.`);
      }
      // Supervisor and above, and NOT a Supervisor on a Termination or
      // Blacklist. canDecideCase reads the applied punishments as well as the
      // listed ones, so one edited off the case cannot launder it past here.
      const mayDecide = authority.canDecideCase(auth, row);
      if (!mayDecide.allowed) return interaction.editReply(`⛔ ${mayDecide.reason}`);

      // Cases carry consequences (roles, exile, demotion, points), so the real
      // pipeline decides — this button only triggers it.
      const decision = require('./caseDecision');
      const fn = approved ? decision.approveCase : decision.denyCase;
      const out = await fn({ caseId: recordId, actor });
      if (out && out.ok === false) return interaction.editReply(out.error || out.reason || 'Refused.');

      const fresh = await prisma.case.findUnique({ where: { id: recordId } });
      await interaction.message.edit({
        embeds: [caseCard(fresh, { decidedBy: actor })], components: [],
      }).catch(() => {});
      // Both halves of the award, stated, because they differ by decision:
      // an approval pays the submitter and the reviewer, a denial pays only the
      // reviewer.
      const review = parseInt(process.env.IA_CASE_REVIEW_POINTS || '1', 10) || 0;
      const mine = review ? ` ${review} quota ${review === 1 ? 'point' : 'points'} queued for you.` : '';
      const line = approved
        ? `Approved ${fresh.caseRef || ''}.`.trim() + ` 4 quota points queued for the submitter.${mine}`
        : `Denied ${fresh.caseRef || ''}.`.trim() + `${mine} The submitter gets nothing.`;
      return interaction.editReply(line);
    }

    return interaction.editReply('Unknown review action.');
  } catch (err) {
    console.error('[IA] review button failed:', err.message);
    return interaction.editReply('That did not go through: ' + err.message);
  }
}

module.exports.handleReviewButton = handleReviewButton;
