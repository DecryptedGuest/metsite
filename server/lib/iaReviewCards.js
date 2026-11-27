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
const casesChannelId   = () => '1574841103042093224'; // review queue with approve/deny controls
const casesForumChannelId = () => '1574841103042093225'; // read-only case log forum
const ticketsChannelId = () =>
  process.env.IA_TICKET_CLOSED_CHANNEL_ID || process.env.TICKETS_CHANNEL_ID || process.env.IA_TICKETS_CHANNEL_ID || '1574841102836699252';
const reviewerRoleId   = () => '1574841102190780564';

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
  // Math.max, because `slice(0, -1)` is not "add nothing" — it is "all but the
  // last", so an already-full embed would have gone on ADDING fields past the
  // limit that this exists to enforce.
  const room = Math.max(0, 25 - (embed.data.fields || []).length);
  const usable = fields.filter(Boolean).slice(0, room);
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
  const embed = new EmbedBuilder()
    .setTitle('Case Information');

  // These are the exact application emoji IDs supplied for the IA case log.
  // Use explicit Discord markup here so a missing/late emoji sync cannot
  // degrade the identity marks to the manifest's single-letter fallbacks.
  const robloxMark = '<:ia_roblox_white:1575987316537696580>';
  const discordMark = '<:ia_discord_white:1575987317917622324>';
  const investigatorRoblox = kase.investigatorRobloxUsername || 'Not recorded';
  const investigatorDiscord = extra.investigatorDiscordId
    ? `<@${extra.investigatorDiscordId}>`
    : (kase.investigatorDiscordUsername ? `@${kase.investigatorDiscordUsername}` : 'Not recorded');
  const officer = kase.officerDiscordId
    ? `<@${kase.officerDiscordId}>${kase.robloxUsername ? ` (Roblox: **${kase.robloxUsername}**)` : ''}`
    : (kase.robloxUsername ? `**${kase.robloxUsername}**` : 'Not identified');

  addFields(embed,
    field('Case', kase.caseRef ? `#${String(kase.caseRef).replace(/^#/, '')}` : 'Not assigned'),
    field('Punishments', punishmentLines(kase.actions, kase.action) || 'None recorded'),
    field('Investigator Information',
      ` ${robloxMark} **${investigatorRoblox}**\n ${discordMark} ${investigatorDiscord}${kase.investigatorRank ? `\nIA Rank: **${kase.investigatorRank}**` : ''}`),
    field('Officer Information', officer),
    field('Reason', kase.reason),
    (kase.notes && kase.notes !== 'N/A') ? field('Notes', kase.notes) : null,
    kase.blacklistCode ? field('Blacklist Information',
      `Code: \`${trim(kase.blacklistCode, 90)}\`${kase.blacklistReason ? `\nReason: ${trim(kase.blacklistReason, 300)}` : ''}`) : null,
  );
  return embed;
}

/**
 * Actionable review card. Kept deliberately separate from the permanent forum
 * log: review cards are yellow, carry the pending state, links and avatar, and
 * can ping both the reviewer role and the investigator.
 */
function caseReviewCard(kase, extra = {}) {
  const caseUrl = safeUrl(kase.caseLink || kase.docUrl);
  const caseNo = String(kase.caseRef || 'New').replace(/^#/, '');
  const robloxMark = '<:ia_roblox_white:1575987316537696580>';
  const discordMark = '<:ia_discord_white:1575987317917622324>';
  const investigatorRoblox = kase.investigatorRobloxUsername || 'Not recorded';
  const investigatorDiscord = extra.investigatorDiscordId
    ? `<@${extra.investigatorDiscordId}>`
    : (kase.investigatorDiscordUsername ? `@${kase.investigatorDiscordUsername}` : 'Not recorded');
  const officer = kase.officerDiscordId
    ? `<@${kase.officerDiscordId}>${kase.robloxUsername ? ` · \`${kase.robloxUsername}\`` : ''}`
    : (kase.robloxUsername ? `\`${kase.robloxUsername}\`` : 'Not identified');
  const embed = new EmbedBuilder()
    .setColor(AMBER)
    .setTitle(`Case #${caseNo}`)
    .setDescription(caseUrl ? `[Open case file](${caseUrl})` : 'Case file link unavailable')
    .setFooter({ text: 'Awaiting review · Internal Affairs' })
    .setTimestamp(safeDate(kase.createdAt));
  if (caseUrl) embed.setURL(caseUrl);
  if (extra.subjectAvatar) embed.setThumbnail(extra.subjectAvatar);
  addFields(embed,
    field('Officer', officer),
    field('Investigator',
      `${robloxMark} **${investigatorRoblox}**  ${discordMark} Discord: ${investigatorDiscord}`),
    field('Punishment', punishmentLines(kase.actions, kase.action) || 'None recorded'),
    field('Reason', kase.reason),
  );
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

  // Just the person. The rank used to hang on a second line under the mention
  // ("<@id>" then "SGT"), which read as a label on the card rather than a name,
  // and a reviewer does not need it to decide a ticket. It is still parsed and
  // still stored on the row — closerRank is what decides whether the handler
  // counts as Internal Affairs — it simply is not printed here.
  const handlerName = ticket.closerUsername || ticket.closerRaw || null;
  const handled = ticket.closerDiscordId
    ? `<@${ticket.closerDiscordId}>`
    : (handlerName || '*being identified*');

  const closedAt = ticket.closedAt && !isNaN(new Date(ticket.closedAt).getTime())
    ? Math.floor(new Date(ticket.closedAt).getTime() / 1000) : null;
  addFields(embed,
    field('Opened by',  opened,  true),
    field('Handled by', handled, true),
    field('Closed', closedAt ? `<t:${closedAt}:f>\n<t:${closedAt}:R>` : '*unknown*', true),
    field('Type',     require('./ticketLog').ticketTypeLabel(ticket.ticketType), true),
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
    const n = ticketPointsFor();
    const word = n === 1 ? 'point' : 'points';
    if (!identified || ticket.closerIsIa == null || (!ticket.closerDiscordId && !ticket.closerUserId)) {
      points = `**${n}** quota ${word} - awaiting investigator account identification`;
    } else if (ticket.closerIsIa === false) {
      points = 'No IA quota - investigator is not Internal Affairs';
    } else {
      points = String(ticket.status || 'PENDING').toUpperCase() === 'APPROVED'
        ? `**${n}** quota ${word} awarded automatically`
        : `**${n}** quota ${word} pending approval`;
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
async function postCard(client, channelId, embed, components, { ping = false, users = [] } = {}) {
  if (!client || !channelId) return null;
  try {
    const channel = await client.channels.fetch(String(channelId));
    const msg = await channel.send({
      content: ping ? reviewerPing() : undefined,
      embeds: [embed],
      components: components ? [components] : [],
      allowedMentions: { parse: ping ? ['roles'] : [], users: [...new Set((users || []).map(String).filter(Boolean))] },
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
async function buildAndPost(client, channelId, build, what, options = {}) {
  if (!client || !channelId) return null;
  let embed, components;
  try {
    ({ embed, components } = build());
  } catch (err) {
    console.error(`[IA] could not BUILD the ${what} card`, err);
    console.error(`[IA] ${what} card context`, {
      channelId, recordId: build.recordId || null,
      errorName: err && err.name, errorMessage: err && err.message,
      errors: err && err.errors,
    });
    return null;
  }
  return postCard(client, channelId, embed, components, { ping: options.ping === true });
}

const postCaseCard = async (client, kase, extra) => {
  if (!client) return null;
  let forumThreadId = null;
  try {
    // Permanent, read-only case log: no reviewer ping and no components.
    const forum = await client.channels.fetch(String(casesForumChannelId()));
    // Resolve the filing investigator's Discord id so the log contains a
    // real mention rather than a plain username.
    const investigatorUser = kase.userId
      ? await Promise.resolve(require('./db').user.findUnique({ where: { id: kase.userId }, select: { discordId: true } })).catch(() => null)
      : null;
    const forumExtra = { ...extra, investigatorDiscordId: investigatorUser?.discordId || extra?.investigatorDiscordId || null };
    const embed = caseCard(kase, forumExtra);
    const ref = String(kase.caseRef || 'New').replace(/^#?/, '#');
    const title = `Case ${ref} - ${trim(kase.robloxUsername || 'Unknown officer', 70)}`;
    const caseUrl = safeUrl(kase.caseLink || kase.docUrl);
    const thread = await forum.threads.create({
      name: title.slice(0, 100),
      message: {
        content: caseUrl || '',
        embeds: [embed],
        components: [],
        allowedMentions: { parse: [], users: investigatorUser?.discordId ? [String(investigatorUser.discordId)] : [] },
      },
    });
    forumThreadId = thread.id;
    await applyCaseStatusTag(thread, kase.status || 'PENDING');
    console.log(`[IA] read-only case forum log created for ${kase.caseRef} in ${casesForumChannelId()} (${thread.id})`);
  } catch (err) {
    console.error(`[IA] could not create read-only case forum log in ${casesForumChannelId()}: ${err.message}`);
  }

  // Actionable review card lives in the separate IA review channel.
  const reviewChannelId = casesChannelId();
  const reviewMessageId = await buildAndPost(
    client,
    reviewChannelId,
    () => ({ embed: caseReviewCard(kase, { ...extra, investigatorDiscordId: investigatorUser?.discordId || extra?.investigatorDiscordId || null }), components: reviewButtons('case', kase.id) }),
    'case review',
    { ping: true, users: [investigatorUser?.discordId, kase.officerDiscordId].filter(Boolean) },
  );
  if (!reviewMessageId) {
    console.error(`[IA] case review card could not be posted to ${reviewChannelId} for ${kase.caseRef}`);
  }
  // cardMessageId is the forum thread id; notices link to this log.
  return forumThreadId;
};

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
  const link = safeUrl(ticket.transcriptUrl);
  if (!link) return null;
  return new ActionRowBuilder().addComponents(new ButtonBuilder()
    .setLabel('View transcript').setStyle(ButtonStyle.Link).setURL(link));
}

const postTicketCard = (client, ticket, extra) =>
  buildAndPost(client, ticketsChannelId(),
    () => ({ embed: ticketCard(ticket, extra), components: ticketComponents(ticket) }), 'ticket', { ping: false });

/** Rewrite a card in place once it has been decided, and take the buttons away. */
function caseStatusTag(channel, status) {
  const state = String(status || '').toUpperCase();
  const tags = channel && channel.availableTags || [];
  const match = state === 'APPROVED'
    ? tags.find(t => /approved|accepted/i.test(t.name))
    : state === 'DENIED'
      ? tags.find(t => /denied|rejected/i.test(t.name))
      : tags.find(t => /pending|awaiting|under review|review/i.test(t.name));
  return match ? [match.id] : [];
}

async function applyCaseStatusTag(thread, status) {
  if (!thread || typeof thread.setAppliedTags !== 'function') return false;
  try {
    const parent = thread.parent || await thread.guild.channels.fetch(thread.parentId).catch(() => null);
    const tags = caseStatusTag(parent, status);
    if (!tags.length) {
      console.warn(`[IA] no forum tag configured for case status ${status}`);
      return false;
    }
    await thread.setAppliedTags(tags);
    return true;
  } catch (err) {
    console.warn(`[IA] could not update forum tag for ${thread.id}: ${err.message}`);
    return false;
  }
}

async function finaliseCard(client, channelId, messageId, embed) {
  if (!client || !channelId || !messageId) return false;
  try {
    if (String(channelId) === String(casesForumChannelId())) {
      const thread = await client.channels.fetch(String(messageId));
      const msg = await thread.fetchStarterMessage();
      await msg.edit({ embeds: [embed], components: [] });
      const footer = embed.data?.footer?.text || '';
      const status = /^Approved/i.test(footer) ? 'APPROVED' : /^Denied/i.test(footer) ? 'DENIED' : 'PENDING';
      await applyCaseStatusTag(thread, status);
      return true;
    }
    const channel = await client.channels.fetch(String(channelId));
    const msg = await channel.messages.fetch(String(messageId));
    await msg.edit({ embeds: [embed], components: [] });
    return true;
  } catch (err) {
    console.warn(`[IA] could not update card ${messageId}: ${err.message}`);
    return false;
  }
}

module.exports = { caseReviewCard,
  caseCard, ticketCard, punishmentLines,
  postCaseCard, postTicketCard, postCard, finaliseCard, reviewButtons, applyCaseStatusTag,
  casesChannelId, casesForumChannelId, ticketsChannelId, reviewerRoleId, reviewerPing,
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
  const { e } = require('./emoji');
  if (!auth.ok) {
    return interaction.editReply(`${e('met_denied')} ${auth.why || 'You are not authorised to review this.'}`);
  }

  const actor = {
    id: auth.userId,                 // User.id — what performedBy is a key to
    role: auth.role,                 // what the punishment-tier gate reads
    iaRank: auth.rank,
    iaRankName: auth.rankName,
    discordId: String(interaction.user.id),
    displayName: interaction.member?.displayName || interaction.user.username,
    discordUsername: interaction.user.username,
    avatarURL: interaction.user.displayAvatarURL({ extension: 'png', size: 64 }),
  };

  let caseLoading = null;
  try {
    if (kind === 'ticket') {
      const row = await prisma.ticketLog.findUnique({ where: { id: recordId } }).catch(() => null);
      if (!row) return interaction.editReply('That ticket is no longer in the database.');
      if (row.status && row.status !== 'PENDING') {
        await interaction.message.edit({ components: [] }).catch(() => {});
        return interaction.editReply(`Already ${String(row.status).toLowerCase()}.`);
      }
      const may = authority.canReviewTicket(auth, row);
      if (!may.allowed) return interaction.editReply(`${e('met_denied')} ${may.reason}`);
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
      let line = approved ? `${e('met_tick')} Approved.` : `${e('met_cross')} Denied.`;
      if (approved) {
        const t = out.ticket;
        const handler = t.closerDiscordId ? `<@${t.closerDiscordId}>` : (t.closerUsername || 'the handler');
        if (!(t.closerDiscordId || t.closerUserId)) {
          line += ' No points yet: the handler is still being identified.';
        } else if (t.closerIsIa === false) {
          line += ` No points: ${handler} is not Internal Affairs.`;
        } else {
          const { ticketPointsFor } = require('./quota');
          const n = ticketPointsFor();
          line += ` ${n} quota ${n === 1 ? 'point' : 'points'} queued for ${handler}.`;
        }
      }
      return interaction.editReply({ content: line, allowedMentions: { parse: [] } });
    }

    if (kind === 'case') {
      const row = await prisma.case.findUnique({
        where: { id: recordId },
        include: {
          casePunishments: { select: { action: true } },
          user: { select: { discordId: true, discordUsername: true, robloxUsername: true } },
        },
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
      if (!mayDecide.allowed) return interaction.editReply(`${e('met_denied')} ${mayDecide.reason}`);

      // Cases carry consequences (roles, exile, demotion, points), so the real
      // pipeline decides — this button only triggers it.
      const decision = require('./caseDecision');
      const fn = approved ? decision.approveCase : decision.denyCase;
      // Use the shared MET blue four-frame spinner. It cycles the custom
      // met_load emoji while the decision pipeline reports its live step.
      caseLoading = approved
        ? require('./emoji').startLoading(interaction, 'Preparing case approval')
        : null;
      const out = await fn({
        caseId: recordId, actor,
        onProgress: approved ? (step) => caseLoading.update(step) : undefined,
      });
      if (caseLoading) { caseLoading.stop(); caseLoading = null; }
      if (out && out.ok === false) return interaction.editReply(out.error || out.reason || 'Refused.');

      const fresh = await prisma.case.findUnique({
        where: { id: recordId },
        include: { user: { select: { discordId: true, discordUsername: true, robloxUsername: true } } },
      });
      // caseDecision updates the forum starter message and status tag as part of
      // the decision pipeline, preserving the suspect thumbnail and website link.
      // Both halves of the award, stated, because they differ by decision:
      // an approval pays the submitter and the reviewer, a denial pays only the
      // reviewer.
      const submitter = fresh.user?.discordId
        ? `<@${fresh.user.discordId}>`
        : (fresh.user?.robloxUsername || fresh.user?.discordUsername || 'the submitter');
      const line = approved
        ? (out.quotaAwarded
          ? `${e('met_tick')} **Approved ${fresh.caseRef || ''}.**\n+4 QP award queued for ${submitter}. The IA quota leaderboard refresh has been triggered.`
          : `${e('met_tick')} **Approved ${fresh.caseRef || ''}.**\nThe case was approved, but +4 QP could not be queued because the submitter is not matched to an IA quota account.`)
        : `${e('met_cross')} **Denied ${fresh.caseRef || ''}.** No submitter quota points were awarded.`;
      return interaction.editReply({ content: line, allowedMentions: { parse: [] } });
    }

    return interaction.editReply(`${e('met_warn')} Unknown review action.`);
  } catch (err) {
    if (caseLoading) caseLoading.stop();
    console.error('[IA] review button failed:', err.message);
    return interaction.editReply('That did not go through: ' + err.message);
  }
}

module.exports.handleReviewButton = handleReviewButton;
