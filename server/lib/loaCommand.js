// server/lib/loaCommand.js — the /loa panel.
//
// Six subcommands, one command:
//
//   /loa request   ask for leave — duration and reason, nothing else
//   /loa manage    your own leave: withdraw, come back early, ask for more time
//   /loa active    who is on leave right now
//   /loa pending   the queue waiting on a decision   (Jade Command)
//   /loa admin     act on somebody's leave            (Jade Command)
//   /loa history   past leave, yours or somebody's
//
// This replaces a third-party bot whose start-date option was the single
// biggest source of broken requests — so there is no start date. Leave starts
// when it is granted. It is written in the house style: the MET emoji set, a
// spinner while it works, one colour per kind of message, and a DM to the
// member on every change to their leave, because the thing people actually
// complained about was finding out by checking a channel.
//
// Everything the reviewer sees is ephemeral except the request card, which is
// posted publicly in the review channel and edited in place when it is decided
// — so the channel never carries a stale "pending" message. Every LATER change
// also replies to that card: ended early, ended by command, run its course,
// extended, refused. An edit is silent, and somebody scrolling the channel a
// week later needs to be able to see that a leave finished; a reply puts it in
// the timeline and keeps one request reading as one thread.

const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');

const { e } = require('./emoji');
const L = require('./loa');

const COLOR = {
  working:  0x4a8fff,
  pending:  0xf5b730,
  approved: 0x2ed896,
  denied:   0xf04f5e,
  ended:    0x8fa3bd,
  info:     0x4a8fff,
};

const SPIN = ['met_load1', 'met_load2', 'met_load3', 'met_load4'];
const spinner = i => e(SPIN[i % SPIN.length]);

function short(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ── The command ───────────────────────────────────────────────────
function buildCommand() {
  return new SlashCommandBuilder()
    .setName('loa')
    .setDescription('Leave of absence')
    .addSubcommand(s => s
      .setName('request')
      .setDescription('Request a leave of absence')
      .addStringOption(o => o
        .setName('duration')
        .setDescription('How long — 7d, 2w, 10 days')
        .setRequired(true).setMaxLength(20))
      .addStringOption(o => o
        .setName('reason')
        .setDescription('Why — command decide on this')
        .setRequired(true).setMaxLength(900)))
    .addSubcommand(s => s
      .setName('manage')
      .setDescription('Manage your own leave of absence'))
    .addSubcommand(s => s
      .setName('active')
      .setDescription('View active leave of absences'))
    .addSubcommand(s => s
      .setName('pending')
      .setDescription('View pending leave of absence requests'))
    .addSubcommand(s => s
      .setName('admin')
      .setDescription("Manage a staff member's leave of absence")
      .addUserOption(o => o
        .setName('member').setDescription('Whose leave').setRequired(true)))
    .addSubcommand(s => s
      .setName('history')
      .setDescription('View past leave of absences')
      .addUserOption(o => o
        .setName('member').setDescription('Whose history — yours if left blank')))
    .toJSON();
}

// ── Shared drawing ────────────────────────────────────────────────
const STATUS_MARK = {
  PENDING:   'met_pending',
  APPROVED:  'met_tick',
  DENIED:    'met_cross',
  CANCELLED: 'met_dot_off',
  ENDED:     'met_return',
  EXPIRED:   'met_return',
};
const STATUS_COLOR = {
  PENDING:   COLOR.pending,
  APPROVED:  COLOR.approved,
  DENIED:    COLOR.denied,
  CANCELLED: COLOR.ended,
  ENDED:     COLOR.ended,
  EXPIRED:   COLOR.ended,
};

function statusLine(r) {
  return `${e(STATUS_MARK[r.status] || 'met_dot_off')} **${L.STATUS_LABEL[r.status] || r.status}**`;
}

function who(r) {
  return r.discordId ? `<@${r.discordId}>` : (r.userName || 'Unknown');
}

/** The dates, said once, the same way everywhere. */
function periodField(r) {
  const days = Math.max(1, Math.round((new Date(r.endAt) - new Date(r.startAt)) / L.DAY));
  return {
    name: `${e('met_calendar')} Leave period`,
    value: `${L.ts(r.startAt)} → ${L.ts(r.endAt)}\n`
         + `${e('met_hourglass')} ${L.humanDays(days)}`
         + (L.isActive(r) ? ` · **${L.daysUntil(r.endAt)}** left to run` : ''),
    inline: false,
  };
}

/** One leave, in full. Used by the request card, /loa manage and /loa admin. */
function card(r, opts = {}) {
  const fields = [
    { name: `${e('met_user')} Member`, value: who(r), inline: true },
    { name: `${e('met_shield')} Status`, value: statusLine(r), inline: true },
  ];
  fields.push(periodField(r));
  if (r.reason) fields.push({ name: `${e('met_edit')} Reason`, value: short(r.reason, 1000), inline: false });

  if (r.changeRequest && r.changeRequest.kind === 'EXTEND') {
    fields.push({
      name: `${e('met_hourglass')} Extension requested`,
      value: `**${L.humanDays(r.changeRequest.days)}** more — would end ${L.ts(r.changeRequest.endAt)}`
        + (r.changeRequest.reason ? `\n${short(r.changeRequest.reason, 400)}` : ''),
      inline: false,
    });
  }
  if (r.reviewerName || r.reviewedAt) {
    fields.push({
      name: `${e('met_scales')} Decided by`,
      value: `${r.reviewerName || 'Command'}${r.reviewedAt ? ` · ${L.ts(r.reviewedAt, 'f')}` : ''}`,
      inline: true,
    });
  }
  if (r.endedByName || r.endedAt) {
    fields.push({
      name: `${e('met_return')} Ended`,
      value: `${r.endedByName || 'Automatically'}${r.endedAt ? ` · ${L.ts(r.endedAt, 'f')}` : ''}`,
      inline: true,
    });
  }
  if (r.reviewNote) fields.push({ name: `${e('met_announce')} Note`, value: short(r.reviewNote, 900), inline: false });

  return new EmbedBuilder()
    .setColor(opts.color || STATUS_COLOR[r.status] || COLOR.info)
    .setAuthor({ name: 'Metropolitan Police Service' })
    .setTitle(opts.title || 'Leave of Absence')
    .setDescription(opts.description || null)
    .addFields(fields)
    .setFooter({ text: `Reference ${String(r.id).slice(0, 8).toUpperCase()}` })
    .setTimestamp(new Date(r.createdAt || Date.now()));
}

/** A compact one-liner for the list views. */
function line(r, i) {
  const mark = e(STATUS_MARK[r.status] || 'met_dot_off');
  const days = L.isActive(r) ? ` · **${L.daysUntil(r.endAt)}d** left` : '';
  return `${mark} ${who(r)} — ${L.ts(r.startAt)} → ${L.ts(r.endAt)}${days}\n`
       + ` ${e('met_edit')} ${short(r.reason || 'No reason given', 120)}`;
}

function listEmbed({ title, rows, empty, color, note }) {
  const em = new EmbedBuilder()
    .setColor(color || COLOR.info)
    .setAuthor({ name: 'Metropolitan Police Service' })
    .setTitle(title)
    .setTimestamp(Date.now());
  if (!rows.length) {
    em.setDescription(`${e('met_dot_off')} ${empty}`);
    return em;
  }
  em.setDescription((note ? note + '\n\n' : '') + rows.map(line).join('\n\n'));
  em.setFooter({ text: `${rows.length} shown` });
  return em;
}

// ── Buttons ───────────────────────────────────────────────────────
// Namespaced `loa_` so bot.js routes them, and the id carries the row so a
// button pressed an hour later still knows what it is about.
const btn = (action, id, label, style, emoji) =>
  new ButtonBuilder()
    .setCustomId(`loa_${action}_${id}`)
    .setLabel(label)
    .setStyle(style)
    .setEmoji(emoji);

function reviewRow(id) {
  return new ActionRowBuilder().addComponents(
    btn('approve', id, 'Approve', ButtonStyle.Success, '✅'),
    btn('deny',    id, 'Deny',    ButtonStyle.Danger,  '❌'),
  );
}
function extensionRow(id) {
  return new ActionRowBuilder().addComponents(
    btn('extok', id, 'Grant the extra time', ButtonStyle.Success, '✅'),
    btn('extno', id, 'Refuse it',            ButtonStyle.Danger,  '❌'),
  );
}
function manageRow(r) {
  const row = new ActionRowBuilder();
  if (r.status === 'PENDING') {
    row.addComponents(btn('cancel', r.id, 'Withdraw the request', ButtonStyle.Secondary, '🗑️'));
  } else if (L.isActive(r)) {
    row.addComponents(
      btn('back', r.id, "I'm back — end it now", ButtonStyle.Success, '↩️'),
      btn('more', r.id, 'Ask for more time',     ButtonStyle.Secondary, '⏳'),
      btn('less', r.id, 'Come back sooner',      ButtonStyle.Secondary, '⏪'),
    );
  }
  return row.components.length ? [row] : [];
}

// ── The member's DM ───────────────────────────────────────────────
// The one thing people actually asked for: being told, rather than having to
// check a channel. Every change to somebody's leave sends one.
async function tell(r, kind, extra = {}) {
  if (!r || !r.discordId) return false;
  if (process.env.MEMBER_ACTION_DM === 'off') return 'off';

  const M = {
    APPROVED: {
      color: COLOR.approved,
      title: 'Your leave of absence has been approved',
      lead: `${e('met_tick')} **Approved.** Your leave starts now.`,
      note: `\`/loa manage\` if anything changes.`,
    },
    DENIED: {
      color: COLOR.denied,
      title: 'Your leave of absence was denied',
      lead: `${e('met_cross')} **Denied.**`,
      note: `\`/loa request\` if you need to ask again.`,
    },
    ENDED: {
      color: COLOR.ended,
      title: extra.byThem ? 'Welcome back' : 'Your leave of absence has been ended',
      lead: extra.byThem
        ? `${e('met_return')} **Your leave has ended.** Your quota counts again from today.`
        : `${e('met_return')} **Your leave has been ended by command.**`,
      note: null,
    },
    EXPIRED: {
      color: COLOR.ended,
      title: 'Your leave of absence has finished',
      lead: `${e('met_return')} **Your leave has finished.** Your quota counts again from today.`,
      note: null,
    },
    EXTENDED: {
      color: COLOR.approved,
      title: 'Your leave has been extended',
      lead: `${e('met_tick')} **${L.humanDays(extra.days)} more** has been granted.`,
      note: null,
    },
    EXT_DENIED: {
      color: COLOR.denied,
      title: 'Your extension was refused',
      lead: `${e('met_cross')} The extra **${L.humanDays(extra.days)}** was not granted. Your leave still ends as planned.`,
      note: null,
    },
    SUBMITTED: {
      color: COLOR.pending,
      title: 'Your leave of absence request is with command',
      lead: `${e('met_pending')} **Waiting on Jade Command.**`,
      note: `You will hear back here. \`/loa manage\` to withdraw it.`,
    },
  }[kind];
  if (!M) return false;

  const fields = [periodField(r)];
  if (r.reason) fields.push({ name: `${e('met_edit')} Reason given`, value: short(r.reason, 700), inline: false });
  if (r.reviewNote && (kind === 'DENIED' || kind === 'ENDED')) {
    fields.push({ name: `${e('met_announce')} From command`, value: short(r.reviewNote, 700), inline: false });
  }
  if (r.reviewerName && kind !== 'SUBMITTED') {
    fields.push({ name: `${e('met_scales')} Decided by`, value: short(r.reviewerName, 200), inline: true });
  }
  if (M.note) fields.push({ name: `${e('met_shield')} Next`, value: M.note, inline: false });

  return require('./bot').dmMemberNotice(r.discordId, {
    color: M.color,
    authorName: 'Metropolitan Police Service',
    title: M.title,
    description: M.lead,
    fields,
    timestamp: Date.now(),
    footer: `Leave of absence · Reference ${String(r.id).slice(0, 8).toUpperCase()}`,
  }).catch(() => false);
}

// ── Posting the request card for review ───────────────────────────
async function postForReview(r, overLimit) {
  const channelId = L.CHANNEL();
  if (!channelId) return null;
  try {
    const client = require('./bot').getClient();
    if (!client) return null;
    const ch = await client.channels.fetch(channelId).catch(() => null);
    if (!ch || !ch.send) return null;

    const em = card(r, {
      title: 'Leave of Absence — awaiting a decision',
      description: overLimit
        ? `${e('met_warn')} Longer than the usual **${L.humanDays(L.MAX_DAYS())}** limit.`
        : null,
      color: COLOR.pending,
    });
    const msg = await ch.send({
      content: `<@&${L.ADMIN_ROLE()}>`,
      embeds: [em],
      components: [reviewRow(r.id)],
      allowedMentions: { roles: [L.ADMIN_ROLE()] },
    });
    await require('./db').loaRequest.update({
      where: { id: r.id }, data: { messageId: msg.id, channelId: ch.id },
    }).catch(() => {});
    return msg;
  } catch (err) {
    console.warn('[LOA] could not post the request card:', err.message);
    return null;
  }
}

/**
 * Reply to the original request card.
 *
 * The card itself is edited in place so it never reads "pending" once it is
 * not — but an edit is silent, and somebody scrolling the channel a week later
 * has no way to see that a leave ended early or ran its course. So every later
 * change also REPLIES to the card, which keeps one request as one thread and
 * puts the change in the channel's timeline where it can be read.
 *
 * Best-effort throughout: a deleted card, a channel the bot has lost access
 * to, or a missing message must not stop the leave changing.
 */
async function replyToCard(r, text, color, ping) {
  if (!r || !r.messageId || !r.channelId) return false;
  try {
    const client = require('./bot').getClient();
    if (!client) return false;
    const ch = await client.channels.fetch(r.channelId).catch(() => null);
    if (!ch || !ch.messages) return false;
    const msg = await ch.messages.fetch(r.messageId).catch(() => null);
    if (!msg || !msg.reply) return false;

    const em = new EmbedBuilder()
      .setColor(color || COLOR.ended)
      .setAuthor({ name: 'Metropolitan Police Service' })
      .setDescription(text)
      .setFooter({ text: `Leave of absence · Reference ${String(r.id).slice(0, 8).toUpperCase()}` })
      .setTimestamp(Date.now());

    // Only an extension asks for a decision, so only that one pings. Everything
    // else is a notice, and a notice that pings is a notice people mute.
    await msg.reply(ping
      ? { content: `<@&${L.ADMIN_ROLE()}>`, embeds: [em], allowedMentions: { roles: [L.ADMIN_ROLE()] } }
      : { embeds: [em], allowedMentions: { parse: [] } });
    return true;
  } catch (err) {
    console.warn('[LOA] could not reply to the request card:', err.message);
    return false;
  }
}

// What each kind of change says in the channel. Written to be read by somebody
// who was not watching when it happened.
function changeLine(r, kind, extra = {}) {
  const m = who(r);
  switch (kind) {
    case 'ENDED':
      return extra.byThem
        ? `${e('met_return')} ${m} is **back early**.`
        : `${e('met_return')} ${m}'s leave was **ended by ${extra.by || 'command'}**.`;
    case 'EXPIRED':
      return `${e('met_return')} ${m}'s leave has **finished**. They are back.`;
    case 'CANCELLED':
      return `${e('met_dot_off')} ${m} **withdrew** this request.`;
    case 'EXTENDED':
      return `${e('met_hourglass')} ${m}'s leave has been **extended by ${L.humanDays(extra.days)}** — `
           + `now ending ${L.ts(r.endAt)}.`;
    case 'EXT_DENIED':
      return `${e('met_cross')} **${L.humanDays(extra.days)} more** refused — still ending ${L.ts(r.endAt)}.`;
    case 'EXT_ASKED':
      return `${e('met_hourglass')} ${m} has asked for **${L.humanDays(extra.days)} more** — `
           + `would end ${L.ts(extra.wouldEndAt)}.`
           + (extra.reason ? `
${e('met_edit')} ${short(extra.reason, 400)}` : '');
    case 'SHORTENED':
      return `${e('met_return')} ${m} **cut their leave short by ${L.humanDays(extra.days)}** — back ${L.ts(r.endAt)}.`;
    default:
      return null;
  }
}

const CHANGE_COLOR = {
  ENDED: COLOR.ended, EXPIRED: COLOR.ended, CANCELLED: COLOR.ended,
  EXTENDED: COLOR.approved, EXT_DENIED: COLOR.denied,
  EXT_ASKED: COLOR.pending, SHORTENED: COLOR.approved,
};

/**
 * Everything a change to a leave has to do: bring the card up to date, say so
 * underneath it, and tell the member. One call so no path can do two of the
 * three and quietly skip the other.
 */
async function announce(r, kind, extra = {}) {
  await refreshCard(r).catch(() => {});
  const line = changeLine(r, kind, extra);
  if (line) await replyToCard(r, line, CHANGE_COLOR[kind], kind === 'EXT_ASKED').catch(() => {});
  await tell(r, kind, extra).catch(() => {});
}

/** Bring the posted card up to date after a decision. */
async function refreshCard(r) {
  if (!r || !r.messageId || !r.channelId) return false;
  try {
    const client = require('./bot').getClient();
    if (!client) return false;
    const ch = await client.channels.fetch(r.channelId).catch(() => null);
    if (!ch || !ch.messages) return false;
    const msg = await ch.messages.fetch(r.messageId).catch(() => null);
    if (!msg) return false;
    const components = (r.changeRequest && r.changeRequest.kind === 'EXTEND')
      ? [extensionRow(r.id)]
      : [];
    await msg.edit({ content: '', embeds: [card(r)], components, allowedMentions: { parse: [] } });
    return true;
  } catch (err) {
    console.warn('[LOA] could not update the request card:', err.message);
    return false;
  }
}

// ── Subcommands ───────────────────────────────────────────────────
async function handleLoaCommand(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'request') return doRequest(interaction);
  if (sub === 'manage')  return doManage(interaction);
  if (sub === 'active')  return doActive(interaction);
  if (sub === 'pending') return doPending(interaction);
  if (sub === 'admin')   return doAdmin(interaction);
  if (sub === 'history') return doHistory(interaction);
  return interaction.reply({ content: `${e('met_cross')} Unknown subcommand.`, flags: 64 });
}

const nameOf = (interaction) =>
  (interaction.member && interaction.member.displayName)
  || interaction.user.globalName || interaction.user.username;

async function doRequest(interaction) {
  await interaction.deferReply({ flags: 64 });

  const raw = interaction.options.getString('duration');
  const reason = interaction.options.getString('reason');
  const { days, why } = L.parseDuration(raw);
  if (!days) {
    return interaction.editReply({ embeds: [new EmbedBuilder()
      .setColor(COLOR.denied)
      .setTitle(`${e('met_cross')} I could not read that`)
      .setDescription(`${why}\n\n${e('met_calendar')} \`7d\` · \`10 days\` · \`1w\` · \`2 weeks\``
        + `\n${e('met_hourglass')} Usual limit **${L.humanDays(L.MAX_DAYS())}**.`)] });
  }

  // A spinner, so a slow DM or a slow channel post does not read as a hang.
  await interaction.editReply({ embeds: [new EmbedBuilder()
    .setColor(COLOR.working)
    .setTitle(`${spinner(0)} Filing your request…`)
    .setDescription(`${e('met_calendar')} ${L.humanDays(days)}, starting now.`)] });

  const out = await L.create({
    discordId: interaction.user.id,
    discordUsername: interaction.user.username,
    displayName: nameOf(interaction),
    days, reason,
  });

  if (!out.ok) {
    const em = new EmbedBuilder()
      .setColor(COLOR.denied)
      .setTitle(`${e('met_warn')} That cannot be filed`)
      .setDescription(out.why);
    if (out.existing) em.addFields(periodField(out.existing), { name: `${e('met_shield')} Status`, value: statusLine(out.existing), inline: true });
    return interaction.editReply({ embeds: [em] });
  }

  const r = out.request;
  await postForReview(r, out.overLimit);
  await tell(r, 'SUBMITTED');

  const em = card(r, {
    title: 'Your leave of absence request is with command',
    description: `${e('met_pending')} **Filed.** Waiting on Jade Command.`
      + (out.overLimit
        ? `\n\n${e('met_warn')} Longer than the usual **${L.humanDays(L.MAX_DAYS())}**.`
        : ''),
    color: COLOR.pending,
  });
  return interaction.editReply({ embeds: [em], components: manageRow(r) });
}

async function doManage(interaction) {
  await interaction.deferReply({ flags: 64 });
  const r = await L.openFor(interaction.user.id);
  if (!r) {
    return interaction.editReply({ embeds: [new EmbedBuilder()
      .setColor(COLOR.info)
      .setTitle(`${e('met_calendar')} Nothing to manage`)
      .setDescription(`${e('met_edit')} \`/loa request\` to ask for some.`)] });
  }
  return interaction.editReply({
    embeds: [card(r, {
      title: r.status === 'PENDING' ? 'Your request' : 'Your leave of absence',
      description: r.status === 'PENDING'
        ? `${e('met_pending')} Waiting on Jade Command.`
        : `${e('met_tick')} **${L.daysUntil(r.endAt)}** day(s) left.`,
    })],
    components: manageRow(r),
  });
}

async function doActive(interaction) {
  await interaction.deferReply({ flags: 64 });
  const rows = await L.activeNow(25);
  return interaction.editReply({ embeds: [listEmbed({
    title: `${'Active leave of absences'}`,
    rows,
    color: COLOR.approved,
    empty: 'Nobody is on leave.',
    note: rows.length ? `${e('met_calendar')} Soonest back first.` : null,
  })] });
}

async function doPending(interaction) {
  await interaction.deferReply({ flags: 64 });
  if (!L.canReview(interaction.member, interaction.user.id)) {
    return interaction.editReply({ embeds: [denied('Jade Command only.')] });
  }
  const rows = await L.pending(25);
  return interaction.editReply({
    embeds: [listEmbed({
      title: 'Leave of absence — pending',
      rows,
      color: COLOR.pending,
      empty: 'Nothing waiting.',
      note: rows.length ? `${e('met_hourglass')} Longest wait first · \`/loa admin\` to act on one.` : null,
    })],
  });
}

async function doAdmin(interaction) {
  await interaction.deferReply({ flags: 64 });
  if (!L.canReview(interaction.member, interaction.user.id)) {
    return interaction.editReply({ embeds: [denied('Jade Command only.')] });
  }
  const target = interaction.options.getUser('member');
  const r = await L.openFor(target.id);
  if (!r) {
    const past = await L.history(target.id, 5);
    return interaction.editReply({ embeds: [listEmbed({
      title: `${target.username} has no leave open`,
      rows: past,
      color: COLOR.info,
      empty: 'Nothing on record.',
      note: `${e('met_folder')} Their last few:`,
    })] });
  }

  const rows = [];
  if (r.status === 'PENDING') rows.push(reviewRow(r.id));
  else if (r.changeRequest && r.changeRequest.kind === 'EXTEND') rows.push(extensionRow(r.id));
  else if (L.isActive(r)) {
    rows.push(new ActionRowBuilder().addComponents(
      btn('force', r.id, 'End this leave now', ButtonStyle.Danger, '↩️'),
    ));
  }

  return interaction.editReply({
    embeds: [card(r, { title: `${target.username}'s leave of absence` })],
    components: rows,
  });
}

async function doHistory(interaction) {
  await interaction.deferReply({ flags: 64 });
  const target = interaction.options.getUser('member');
  // Looking at somebody else's history is command's business, not everyone's.
  if (target && target.id !== interaction.user.id && !L.canReview(interaction.member, interaction.user.id)) {
    return interaction.editReply({ embeds: [denied('Jade Command only.')] });
  }
  const id = target ? target.id : interaction.user.id;
  const rows = await L.history(id, 15);
  return interaction.editReply({ embeds: [listEmbed({
    title: target && target.id !== interaction.user.id
      ? `${target.username} — leave history`
      : 'Your leave history',
    rows,
    color: COLOR.info,
    empty: 'No leave on record.',
    note: rows.length ? `${e('met_folder')} Newest first.` : null,
  })] });
}

function denied(msg) {
  return new EmbedBuilder()
    .setColor(COLOR.denied)
    .setTitle(`${e('met_denied')} No`)
    .setDescription(msg);
}

// ── Buttons ───────────────────────────────────────────────────────
async function handleLoaButton(interaction) {
  const cid = interaction.customId || '';
  const m = /^loa_([a-z]+)_(.+)$/.exec(cid);
  if (!m) return;
  const [, action, id] = m;

  // The member's own buttons.
  if (['cancel', 'back', 'more', 'less'].includes(action)) return memberButton(interaction, action, id);
  // Command's.
  return reviewButton(interaction, action, id);
}

async function memberButton(interaction, action, id) {
  if (action === 'more' || action === 'less') {
    // A number is needed, and a modal is the only way to ask for one from a
    // button without another round trip through the command.
    const { ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
    const modal = new ModalBuilder()
      .setCustomId(`loa_${action === 'more' ? 'extend' : 'reduce'}_${id}`)
      .setTitle(action === 'more' ? 'Ask for more time' : 'Come back sooner')
      .addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder()
          .setCustomId('days')
          .setLabel(action === 'more' ? 'How many extra days?' : 'How many days sooner?')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('7')
          .setRequired(true).setMaxLength(3)),
        new ActionRowBuilder().addComponents(new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Why? (optional)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false).setMaxLength(400)),
      );
    return interaction.showModal(modal);
  }

  await interaction.deferReply({ flags: 64 });

  if (action === 'cancel') {
    const out = await L.cancel(id, interaction.user.id);
    if (!out.ok) return interaction.editReply({ embeds: [denied(out.why)] });
    await announce(out.request, 'CANCELLED');
    return interaction.editReply({ embeds: [new EmbedBuilder()
      .setColor(COLOR.ended)
      .setTitle(`${e('met_tick')} Withdrawn`)
      .setDescription('Your request has been taken back.')] });
  }

  if (action === 'back') {
    const r = await L.byId(id);
    if (!r || String(r.discordId) !== String(interaction.user.id)) {
      return interaction.editReply({ embeds: [denied('That is not your leave.')] });
    }
    const out = await L.end(id, { id: interaction.user.id, name: nameOf(interaction) }, 'Returned early');
    if (!out.ok) return interaction.editReply({ embeds: [denied(out.why)] });
    await announce(out.request, 'ENDED', { byThem: true });
    return interaction.editReply({ embeds: [new EmbedBuilder()
      .setColor(COLOR.approved)
      .setTitle(`${e('met_return')} Welcome back`)
      .setDescription('Your quota counts again from today.')] });
  }
}

async function handleLoaModal(interaction) {
  const m = /^loa_(extend|reduce)_(.+)$/.exec(interaction.customId || '');
  if (!m) return;
  const [, kind, id] = m;
  await interaction.deferReply({ flags: 64 });

  const raw = interaction.fields.getTextInputValue('days');
  const reason = (interaction.fields.getTextInputValue('reason') || '').trim();
  const days = parseInt(String(raw).replace(/\D/g, ''), 10);
  if (!Number.isFinite(days) || days <= 0) {
    return interaction.editReply({ embeds: [denied('That is not a number of days.')] });
  }

  const out = await L.change(id, interaction.user.id, kind === 'extend' ? 'EXTEND' : 'REDUCE', days, reason);
  if (!out.ok) return interaction.editReply({ embeds: [denied(out.why)] });

  if (out.applied) {
    // Shortening it may have taken it past today, in which case the leave has
    // ended rather than merely moved.
    await announce(out.request,
      out.request.status === 'ENDED' ? 'ENDED' : 'SHORTENED',
      { byThem: true, days });
  } else {
    // An extension has to be visible to the people who decide on it, so it
    // replies to the card AND puts the buttons back on it.
    await announce(out.request, 'EXT_ASKED',
      { days, wouldEndAt: out.wouldEndAt, reason });
  }

  if (out.applied) {
    // Coming back sooner needs nobody's permission.
    return interaction.editReply({ embeds: [card(out.request, {
      title: `${e('met_tick')} Your leave has been shortened`,
      description: out.request.status === 'ENDED'
        ? `${e('met_return')} Your leave has ended. Welcome back.`
        : `${e('met_return')} **${L.humanDays(days)}** off the end — back ${L.ts(out.request.endAt)}.`,
      color: COLOR.approved,
    })] });
  }

  return interaction.editReply({ embeds: [card(out.request, {
    title: `${e('met_hourglass')} Extension requested`,
    description: `${e('met_pending')} **${L.humanDays(days)}** more — waiting on Jade Command. `
      + `Your leave still ends ${L.ts(out.request.endAt)}.`,
    color: COLOR.pending,
  })] });
}

async function reviewButton(interaction, action, id) {
  if (!L.canReview(interaction.member, interaction.user.id)) {
    return interaction.reply({ embeds: [denied('Jade Command only.')], flags: 64 });
  }
  await interaction.deferReply({ flags: 64 });

  const reviewer = { id: interaction.user.id, name: nameOf(interaction) };

  if (action === 'approve' || action === 'deny') {
    const out = await L.decide(id, action === 'approve' ? 'approve' : 'deny', reviewer, null);
    if (!out.ok) return interaction.editReply({ embeds: [denied(out.why)] });
    // The card itself carries the decision, so this one does not also reply —
    // the edit and a reply saying the same thing is noise.
    await refreshCard(out.request);
    await tell(out.request, action === 'approve' ? 'APPROVED' : 'DENIED');
    return interaction.editReply({ embeds: [card(out.request, {
      title: action === 'approve' ? `${e('met_tick')} Approved` : `${e('met_cross')} Denied`,
      description: who(out.request),
    })] });
  }

  if (action === 'extok' || action === 'extno') {
    const days = ((await L.byId(id)) || {}).changeRequest?.days;
    const out = await L.decideChange(id, action === 'extok' ? 'approve' : 'deny', reviewer);
    if (!out.ok) return interaction.editReply({ embeds: [denied(out.why)] });
    await announce(out.request, out.granted ? 'EXTENDED' : 'EXT_DENIED', { days: out.days || days });
    return interaction.editReply({ embeds: [card(out.request, {
      title: out.granted ? `${e('met_tick')} Extension granted` : `${e('met_cross')} Extension refused`,
      description: who(out.request),
    })] });
  }

  if (action === 'force') {
    const out = await L.end(id, reviewer, 'Ended by command');
    if (!out.ok) return interaction.editReply({ embeds: [denied(out.why)] });
    await announce(out.request, 'ENDED', { byThem: false, by: reviewer.name });
    return interaction.editReply({ embeds: [card(out.request, {
      title: `${e('met_return')} Leave ended`,
      description: who(out.request),
    })] });
  }
}

// ── The sweep ─────────────────────────────────────────────────────
// Closes off leave whose end date has passed, and tells the member they are
// back. Without it `/loa active` fills with people who returned weeks ago.
let sweepTimer = null;
async function sweepOnce() {
  try {
    const out = await L.expire();
    if (!out.closed) return out;
    for (const p of out.people) {
      const r = await L.byId(p.id);
      if (r) await announce(r, 'EXPIRED').catch(() => {});
    }
    console.log(`[LOA] ${out.closed} leave(s) finished and closed off`);
    return out;
  } catch (err) {
    console.warn('[LOA] sweep failed:', err.message);
    return { closed: 0, people: [] };
  }
}

function startLoaWorker() {
  if (sweepTimer) return;
  const every = 30 * 60 * 1000;
  sweepTimer = setInterval(() => { sweepOnce(); }, every);
  if (sweepTimer.unref) sweepTimer.unref();
  setTimeout(() => { sweepOnce(); }, 20 * 1000);
  console.log('[LOA] worker started — finished leave is closed off every 30 minutes');
}

module.exports = {
  buildCommand, handleLoaCommand, handleLoaButton, handleLoaModal,
  startLoaWorker, sweepOnce,
  // Drawing, exported for the tests.
  card, line, listEmbed, tell, postForReview, refreshCard,
  replyToCard, changeLine, announce, COLOR,
};
