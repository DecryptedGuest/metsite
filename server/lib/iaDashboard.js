// server/lib/iaDashboard.js
// /ia — the Internal Affairs dashboard, in Discord.
//
// The website is where Internal Affairs works, but most of that work is
// answering short questions: what is waiting on me, what does this case say,
// has this been signed off, am I on quota. Opening a browser to read six
// numbers is friction, and a queue nobody can see is a queue that does not
// move. So this is the dashboard as a message: the same data, the same rules,
// no browser.
//
// ── The rules are NOT restated here ────────────────────────────────
// Every permission question goes to lib/iaAuthority, and every decision goes to
// lib/caseDecision — the same modules the website routes use. This file decides
// what to DRAW, never what is allowed or what a decision does. That is the
// whole reason a Supervisor pressing Approve on a Termination gets the same
// refusal here as there, and will still get it after somebody changes the rule.
//
// ── State ──────────────────────────────────────────────────────────
// Discord gives a component 100 characters of customId and no memory, so each
// panel mints a token and keeps its state (whose panel, which view, which page,
// which filter, which case) server-side against it. The token is in every
// customId; the state is never trusted from the client, and the owner check
// stops somebody driving a colleague's panel.
//
// ── customId scheme ────────────────────────────────────────────────
// `iad_<verb>_<token>` — deliberately NOT `ia_`, which /check-record's panel
// already owns in the router.

const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');

const prisma = require('./db');
const { e, buttonEmoji } = require('./emoji');
const AUTH = require('./iaAuthority');
const { approveCase, denyCase, reviewTicket } = require('./caseDecision');
const { caseActionNames } = require('./iaRank');

const COMMAND = 'ia';
const TTL_MS = 14 * 60 * 1000;
const PAGE = 6;                       // rows per page — a readable embed, not a wall
const COLOR = {
  ia: 0x9d7dff, working: 0x4a8fff, ok: 0x2ed896, bad: 0xf04f5e, warn: 0xf5b730, quiet: 0x5a6478,
};

const SPIN = ['met_load1', 'met_load2', 'met_load3', 'met_load4'];
const spinner = i => e(SPIN[i % SPIN.length]);

function short(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
const when = d => (d ? `<t:${Math.floor(new Date(d).getTime() / 1000)}:R>` : '·');
const dateOf = d => (d ? `<t:${Math.floor(new Date(d).getTime() / 1000)}:d>` : '·');

// Status → the mark next to a case. OVERTURNED is its own thing: the case was
// upheld and then lifted, which is not the same as denied.
const STATUS_ICON = {
  PENDING: 'met_pending', APPROVED: 'met_tick', DENIED: 'met_cross', OVERTURNED: 'met_ia_appeal',
  VOID: 'met_dot_off',
};
const mark = s => e(STATUS_ICON[String(s || '').toUpperCase()] || 'met_dot_off');

function buildCommand() {
  return new SlashCommandBuilder()
    .setName(COMMAND)
    .setDescription('The Internal Affairs dashboard: cases, tickets, the review queue and your quota')
    .addStringOption(o => o
      .setName('search')
      .setDescription('Jump straight to a search (case ref, officer, reason, investigator)')
      .setMaxLength(100))
    .toJSON();
}

// ── Panel state ───────────────────────────────────────────────────
const panels = new Map();   // token → state

function keep(state) {
  const token = Math.random().toString(36).slice(2, 10);
  panels.set(token, { ...state, at: Date.now() });
  if (panels.size > 400) {
    for (const [k, v] of panels) if (Date.now() - v.at > TTL_MS) panels.delete(k);
  }
  return token;
}
function recall(token) {
  const s = panels.get(token);
  if (!s) return null;
  if (Date.now() - s.at > TTL_MS) { panels.delete(token); return null; }
  s.at = Date.now();
  return s;
}

// ── Queries ───────────────────────────────────────────────────────
// Mirrors the website's own filters (routes/cases.js caseSearchClause) so a
// search here finds what a search there finds.
function searchClause(q) {
  const s = String(q || '').trim();
  if (!s) return null;
  const bare = s.replace(/^#/, '');
  const like = v => ({ contains: v, mode: 'insensitive' });
  return {
    OR: [
      { caseRef: like(s) }, { caseRef: like(bare) },
      { action: like(s) }, { reason: like(s) }, { notes: like(s) },
      { robloxUsername: like(s) }, { robloxUserId: like(s) }, { officerDiscordId: like(s) },
      { suspectRobloxDisplayName: like(s) },
      { investigatorRobloxUsername: like(s) }, { investigatorDiscordUsername: like(s) },
      { punishmentsSummary: like(s) }, { appealedByName: like(s) },
    ],
  };
}

async function fetchCases(state, auth) {
  const filters = [];
  if (state.scope === 'pending') filters.push({ status: 'PENDING' });
  else if (state.scope === 'mine') {
    // "Mine" is the cases this person FILED. userId is the submitter; without a
    // dashboard account there is nothing to match on, so it comes back empty
    // rather than silently showing everybody's.
    filters.push(auth.userId ? { userId: auth.userId } : { id: '__none__' });
  } else if (state.scope && state.scope !== 'all') filters.push({ status: state.scope.toUpperCase() });
  const q = searchClause(state.q);
  if (q) filters.push(q);
  const where = filters.length ? { AND: filters } : {};

  const [total, rows] = await Promise.all([
    prisma.case.count({ where }),
    prisma.case.findMany({
      where, orderBy: { createdAt: 'desc' },
      skip: state.page * PAGE, take: PAGE,
      select: {
        id: true, caseRef: true, status: true, action: true, actions: true, reason: true,
        robloxUsername: true, suspectRobloxDisplayName: true, officerDiscordId: true,
        createdAt: true, appealedAt: true, reviewNote: true, origin: true,
        investigatorRobloxUsername: true,
        user: { select: { displayName: true, discordUsername: true } },
      },
    }),
  ]);
  return { total, rows };
}

async function fetchTickets(state, auth) {
  const filters = [];
  if (state.scope === 'pending') filters.push({ status: 'PENDING' });
  else if (state.scope === 'mine') {
    filters.push(auth.userId || auth.discordId
      ? { OR: [{ closerUserId: auth.userId || '__none__' }, { closerDiscordId: String(auth.discordId) }] }
      : { id: '__none__' });
  }
  const s = String(state.q || '').trim();
  if (s) {
    const like = v => ({ contains: v, mode: 'insensitive' });
    filters.push({ OR: [
      { ticketRef: like(s) }, { ticketName: like(s) }, { reason: like(s) },
      { creatorUsername: like(s) }, { creatorRobloxUsername: like(s) }, { closerUsername: like(s) },
    ] });
  }
  const where = filters.length ? { AND: filters } : {};
  const [total, rows] = await Promise.all([
    prisma.ticketLog.count({ where }),
    prisma.ticketLog.findMany({
      where, orderBy: [{ closedAt: 'desc' }, { createdAt: 'desc' }],
      skip: state.page * PAGE, take: PAGE,
    }),
  ]);
  return { total, rows };
}

// ── Views ─────────────────────────────────────────────────────────

async function homeView(auth) {
  const [caseCounts, ticketCounts, changes] = await Promise.all([
    prisma.case.groupBy({ by: ['status'], _count: { _all: true } }).catch(() => []),
    prisma.ticketLog.groupBy({ by: ['status'], _count: { _all: true } }).catch(() => []),
    prisma.case.count({ where: { status: 'PENDING', reviewNote: { not: null } } }).catch(() => 0),
  ]);
  const c = Object.fromEntries(caseCounts.map(r => [r.status, r._count._all]));
  const t = Object.fromEntries(ticketCounts.map(r => [r.status, r._count._all]));

  const mine = auth.userId
    ? await prisma.case.count({ where: { userId: auth.userId } }).catch(() => 0)
    : 0;

  const cap = AUTH.capabilitySummary(auth);
  const permLines = [
    ...(cap.yes || []).map(s => `${e('met_tick')} ${s}`),
    ...(cap.no  || []).map(s => `${e('met_ia_locked')} ${s}`),
  ].join('\n');

  const embed = new EmbedBuilder()
    .setColor(COLOR.ia)
    .setTitle(`${e('met_ia')} Internal Affairs`)
    .setDescription(
      `Signed in as **${short(auth.name || 'you', 40)}** · ${e('met_rank')} **${short(auth.label, 40)}**`
      + (auth.rank != null ? ` · IA rank \`${auth.rank}\`` : ''))
    .addFields(
      { name: `${e('met_ia_queue')} Waiting on review`, inline: true, value:
        `${e('met_pending')} **${c.PENDING || 0}** case${(c.PENDING || 0) === 1 ? '' : 's'}\n`
        + `${e('met_ticket')} **${t.PENDING || 0}** ticket${(t.PENDING || 0) === 1 ? '' : 's'}\n`
        + `${e('met_edit')} **${changes}** awaiting changes` },
      { name: `${e('met_ia_case')} Cases`, inline: true, value:
        `${e('met_tick')} **${c.APPROVED || 0}** approved\n`
        + `${e('met_cross')} **${c.DENIED || 0}** denied\n`
        + `${e('met_ia_appeal')} **${c.OVERTURNED || 0}** overturned` },
      { name: `${e('met_ia_officer')} Yours`, inline: true, value:
        `${e('met_folder')} **${mine}** filed by you\n`
        + `${e('met_ia_quota')} use **Quota** below\n`
        + `${e('met_database')} **${(c.PENDING || 0) + (c.APPROVED || 0) + (c.DENIED || 0) + (c.OVERTURNED || 0)}** on record` },
      { name: `${e('met_shield')} What you can do`, value: permLines || '·', inline: false },
    )
    .setFooter({ text: 'Internal Affairs · the same rules as the dashboard' })
    .setTimestamp(new Date());
  return embed;
}

function caseLine(k) {
  const who = k.robloxUsername || k.suspectRobloxDisplayName
    || (k.officerDiscordId ? `<@${k.officerDiscordId}>` : 'unknown');
  const acts = caseActionNames(k);
  const uniq = [...new Set(acts)];
  const flags = [
    k.appealedAt ? e('met_ia_appeal') : '',
    k.reviewNote ? e('met_edit') : '',
    k.origin === 'DISCIPLINE' ? e('met_bot') : '',
  ].filter(Boolean).join('');
  return `${mark(k.status)} **${k.caseRef}** · ${short(who, 22)}${flags ? ' ' + flags : ''}\n`
       + `${e('met_dot_on')} ${short(uniq.join(', ') || k.action || '·', 60)} · ${dateOf(k.createdAt)}`;
}

async function casesView(state, auth) {
  const { total, rows } = await fetchCases(state, auth);
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const scopeLabel = { all: 'All cases', mine: 'Filed by me', pending: 'Pending review' }[state.scope] || state.scope;

  const embed = new EmbedBuilder()
    .setColor(state.scope === 'pending' ? COLOR.warn : COLOR.ia)
    .setTitle(`${e(state.scope === 'pending' ? 'met_ia_queue' : 'met_ia_case')} ${scopeLabel}`)
    .setDescription(rows.length
      ? rows.map(caseLine).join('\n\n')
      : `${e('met_dot_off')} Nothing here.${state.q ? ` No case matches **${short(state.q, 40)}**.` : ''}`)
    .setFooter({ text: total
      ? `${total} case${total === 1 ? '' : 's'} · page ${state.page + 1}/${pages}${state.q ? ` · search: ${short(state.q, 30)}` : ''}`
      : 'Nothing to show' });
  return { embed, rows, pages, total };
}

// Internal Affairs handles the MET's tickets, CID's and SCO-19's, so every line
// carries the tag saying which — and the handler's rank when they are not IA,
// because "closed by Sirrto49" alone does not tell a reviewer who that is.
const DIV_TAG = { MET: 'MET', CID: 'CID', SCO: 'SCO' };
function divisionTag(d) { return `\`${DIV_TAG[String(d || 'MET').toUpperCase()] || d}\``; }

function ticketLine(t) {
  const num = t.ticketNo != null ? `#${String(t.ticketNo).padStart(4, '0')}` : (t.ticketRef || t.id.slice(0, 6));
  const who = short(t.closerUsername || '·', 22);
  const rank = t.closerRank ? ` (${short(t.closerRank, 18)})` : '';
  return `${mark(t.status)} ${divisionTag(t.division)} **${num}** · ${short(t.ticketName || t.ticketRef || 'ticket', 26)}\n`
       + `${e('met_dot_on')} closed by ${who}${rank} · ${dateOf(t.closedAt)}`;
}

async function ticketsView(state, auth) {
  const { total, rows } = await fetchTickets(state, auth);
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const scopeLabel = { all: 'All tickets', mine: 'Closed by me', pending: 'Pending review' }[state.scope] || state.scope;
  const embed = new EmbedBuilder()
    .setColor(state.scope === 'pending' ? COLOR.warn : 0x19c6d8)
    .setTitle(`${e('met_ticket')} ${scopeLabel}`)
    .setDescription(rows.length
      ? rows.map(ticketLine).join('\n\n')
      : `${e('met_dot_off')} Nothing here.`)
    .setFooter({ text: total
      ? `${total} ticket${total === 1 ? '' : 's'} · page ${state.page + 1}/${pages}`
      : 'Nothing to show' });
  return { embed, rows, pages, total };
}

async function caseDetailView(caseId, auth) {
  const k = await prisma.case.findUnique({
    where: { id: caseId },
    include: {
      user: { select: { displayName: true, discordUsername: true } },
      casePunishments: true,
      caseActions: { orderBy: { timestamp: 'desc' }, take: 5,
        include: { user: { select: { displayName: true, discordUsername: true } } } },
    },
  });
  if (!k) return { embed: new EmbedBuilder().setColor(COLOR.bad).setTitle(`${e('met_cross')} Gone`)
    .setDescription('That case is no longer there.'), kase: null };

  const acts = [...new Set(caseActionNames(k))];
  const who = k.robloxUsername || k.suspectRobloxDisplayName
    || (k.officerDiscordId ? `<@${k.officerDiscordId}>` : 'unknown');
  const decide = AUTH.canDecideCase(auth, k);

  const embed = new EmbedBuilder()
    .setColor(k.status === 'PENDING' ? COLOR.warn : k.status === 'APPROVED' ? COLOR.ok
      : k.status === 'OVERTURNED' ? COLOR.ia : COLOR.bad)
    .setTitle(`${mark(k.status)} ${k.caseRef} · ${String(k.status).toLowerCase()}`)
    .setDescription(`${e('met_ia_officer')} **Officer** ${short(who, 40)}`
      + (k.robloxUserId ? `\n${e('met_link')} [Roblox profile](https://www.roblox.com/users/${k.robloxUserId}/profile)` : ''))
    .addFields(
      { name: `${e('met_gavel')} Punishments`, value: acts.length ? acts.map(a => `${e('met_dot_on')} ${a}`).join('\n') : '·', inline: true },
      { name: `${e('met_user')} Filed by`, inline: true, value:
        short((k.user && (k.user.displayName || k.user.discordUsername))
          || k.investigatorRobloxUsername || 'unknown', 40) + `\n${dateOf(k.createdAt)}` },
      { name: `${e('met_note')} Reason`, value: short(k.reason || '·', 900), inline: false },
    );

  if (k.notes && k.notes !== 'N/A') embed.addFields({ name: `${e('met_edit')} Notes`, value: short(k.notes, 600), inline: false });
  if (k.reviewNote) embed.addFields({ name: `${e('met_edit')} Changes requested`, value: short(k.reviewNote, 600), inline: false });
  if (Array.isArray(k.evidence) && k.evidence.length) {
    embed.addFields({ name: `${e('met_ia_evidence')} Evidence`, inline: false,
      value: k.evidence.slice(0, 5).map(x => `${e('met_dot_on')} ${short(x.label || x.url || 'exhibit', 60)}`).join('\n')
           + (k.evidence.length > 5 ? `\n…and ${k.evidence.length - 5} more` : '') });
  }
  if (k.appealedAt) {
    embed.addFields({ name: `${e('met_ia_appeal')} Appealed`, inline: false,
      value: `Granted by **${short(k.appealedByName || 'Internal Affairs', 40)}** ${when(k.appealedAt)}`
           + (k.appealReason ? `\n${e('met_note')} ${short(k.appealReason, 300)}` : '') });
  }
  if (k.caseActions && k.caseActions.length) {
    embed.addFields({ name: `${e('met_database')} Recent activity`, inline: false,
      value: k.caseActions.slice(0, 4).map(a =>
        `${e('met_dot_on')} ${a.actionType} · ${short((a.user && (a.user.displayName || a.user.discordUsername)) || 'system', 24)} ${when(a.timestamp)}`
      ).join('\n') });
  }
  // Say WHY a decision is unavailable rather than showing a dead button.
  if (k.status === 'PENDING' && !decide.allowed) {
    embed.addFields({ name: `${e('met_ia_locked')} You cannot decide this`, value: decide.reason, inline: false });
  }
  embed.setFooter({ text: `Internal Affairs · ${k.origin === 'DISCIPLINE' ? 'filed by /discipline' : 'filed on the dashboard'}` });
  return { embed, kase: k, decide };
}

async function ticketDetailView(ticketId, auth) {
  const t = await prisma.ticketLog.findUnique({ where: { id: ticketId } });
  if (!t) return { embed: new EmbedBuilder().setColor(COLOR.bad).setTitle(`${e('met_cross')} Gone`)
    .setDescription('That ticket is no longer there.'), ticket: null };
  const num = t.ticketNo != null ? `#${String(t.ticketNo).padStart(4, '0')}` : (t.ticketRef || t.id.slice(0, 6));
  const review = AUTH.canReviewTicket(auth, t);
  const embed = new EmbedBuilder()
    .setColor(t.status === 'PENDING' ? COLOR.warn : t.status === 'APPROVED' ? COLOR.ok : COLOR.bad)
    .setTitle(`${mark(t.status)} Ticket ${num} · ${String(t.status || 'PENDING').toLowerCase()}`)
    .setDescription(`${divisionTag(t.division)} ${short(t.ticketName || t.ticketRef || 'Ticket', 190)}`)
    .addFields(
      { name: `${e('met_user')} Opened by`, value: short(t.creatorUsername || '·', 40), inline: true },
      { name: `${e('met_shield')} Closed by`, inline: true, value:
        short(t.closerUsername || '·', 40)
        + (t.closerRank ? `\n${short(t.closerRank, 30)}` : '')
        // Quota is IA's, so say plainly when approving this pays nobody.
        + (t.closerIsIa === false ? `\n${e('met_warn')} not IA · no quota` : '') },
      { name: `${e('met_calendar')} Closed`, value: t.closedAt ? when(t.closedAt) : '·', inline: true },
      { name: `${e('met_note')} Close reason`, value: short(t.reason || 'No reason given.', 800), inline: false },
    );
  if (t.transcriptUrl) embed.addFields({ name: `${e('met_ia_evidence')} Transcript`, value: `[Open the transcript](${t.transcriptUrl})`, inline: false });
  if (t.reviewedByName) embed.addFields({ name: `${e('met_ia_verdict')} Reviewed`, value: `${short(t.reviewedByName, 40)} ${when(t.reviewedAt)}`, inline: false });
  if (t.status === 'PENDING' && !review.allowed) {
    embed.addFields({ name: `${e('met_ia_locked')} You cannot decide this`, value: review.reason, inline: false });
  }
  return { embed, ticket: t, review };
}

async function quotaView(auth) {
  const embed = new EmbedBuilder().setColor(COLOR.ia).setTitle(`${e('met_ia_quota')} Weekly quota`);
  let points = null;
  try {
    const { getMemberPoints } = require('./quota');
    points = await getMemberPoints({ discordId: auth.discordId, robloxUsername: auth.user && auth.user.robloxUsername }, 'IA');
  } catch (err) { points = null; }

  if (!points) {
    return embed.setColor(COLOR.quiet)
      .setDescription(`${e('met_warn')} The quota sheet is not configured, so there is nothing to read.`);
  }
  if (!points.found) {
    return embed.setColor(COLOR.quiet)
      .setDescription(`${e('met_warn')} You are not on the Internal Affairs quota sheet this week.`);
  }
  const q = points.quota || {};
  const bar = (have, target) => {
    if (!target) return e('met_star') + ' exempt';
    const w = 10, filled = Math.max(0, Math.min(w, Math.round((have / target) * w)));
    return e('met_dot_on').repeat(filled) + e('met_dot_off').repeat(w - filled);
  };
  embed.setDescription(`${e('met_rank')} **${short(points.rank || auth.label, 40)}**`
    + (q.tier ? ` · ${q.tier}` : ''));
  if (q.exempt) {
    embed.addFields({ name: `${e('met_star')} Exempt`, inline: false,
      value: `You are exempt this week${points.exemptKind ? ` (${points.exemptKind})` : ''} · **${points.total || 0}** points logged anyway.` });
  } else {
    embed.addFields(
      { name: `${e('met_ia_stats')} Progress`, inline: false,
        value: `${bar(points.total || 0, q.target)}\n**${points.total || 0}/${q.target != null ? q.target : '·'}** points`
             + (points.remaining ? ` · **${points.remaining}** to go` : ` · ${e('met_tick')} met`) },
    );
    if (q.reducedBy) embed.addFields({ name: `${e('met_star')} Reduction`, value: `Target reduced by **${q.reducedBy}**.`, inline: true });
  }
  if (points.days) {
    const days = Object.entries(points.days).map(([d, v]) => `${d.slice(0, 3)} ${v}`).join(' · ');
    embed.addFields({ name: `${e('met_calendar')} This week`, value: short(days, 400), inline: false });
  }
  embed.setFooter({ text: 'A case is worth 4 points · a ticket 2' });
  return embed;
}

async function statsView() {
  const [byStatus, tByStatus, changes, week] = await Promise.all([
    prisma.case.groupBy({ by: ['status'], _count: { _all: true } }).catch(() => []),
    prisma.ticketLog.groupBy({ by: ['status'], _count: { _all: true } }).catch(() => []),
    prisma.case.count({ where: { status: 'PENDING', reviewNote: { not: null } } }).catch(() => 0),
    prisma.case.count({ where: { createdAt: { gte: new Date(Date.now() - 7 * 86400000) } } }).catch(() => 0),
  ]);
  const c = Object.fromEntries(byStatus.map(r => [r.status, r._count._all]));
  const t = Object.fromEntries(tByStatus.map(r => [r.status, r._count._all]));
  const totalC = Object.values(c).reduce((a, b) => a + b, 0);
  const totalT = Object.values(t).reduce((a, b) => a + b, 0);
  const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);

  return new EmbedBuilder()
    .setColor(COLOR.ia)
    .setTitle(`${e('met_ia_stats')} Internal Affairs statistics`)
    .addFields(
      { name: `${e('met_ia_case')} Cases · ${totalC}`, inline: true, value:
        `${e('met_pending')} ${c.PENDING || 0} pending (${pct(c.PENDING || 0, totalC)}%)\n`
        + `${e('met_tick')} ${c.APPROVED || 0} approved\n`
        + `${e('met_cross')} ${c.DENIED || 0} denied\n`
        + `${e('met_ia_appeal')} ${c.OVERTURNED || 0} overturned` },
      { name: `${e('met_ticket')} Tickets · ${totalT}`, inline: true, value:
        `${e('met_pending')} ${t.PENDING || 0} pending\n`
        + `${e('met_tick')} ${t.APPROVED || 0} approved\n`
        + `${e('met_cross')} ${t.DENIED || 0} denied` },
      { name: `${e('met_calendar')} Last 7 days`, inline: true, value:
        `${e('met_folder')} **${week}** cases filed\n${e('met_edit')} **${changes}** awaiting changes` },
    )
    .setFooter({ text: 'Internal Affairs' })
    .setTimestamp(new Date());
}

// ── Components ────────────────────────────────────────────────────
const btn = (id, label, style, emojiName, disabled) => {
  const b = new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
  const em = emojiName ? buttonEmoji(emojiName) : null;
  if (em) b.setEmoji(em);
  if (disabled) b.setDisabled(true);
  return b;
};

function navRow(token, view) {
  return new ActionRowBuilder().addComponents(
    btn(`iad_home_${token}`,    'Home',    view === 'home' ? ButtonStyle.Primary : ButtonStyle.Secondary, 'met_ia_home', view === 'home'),
    btn(`iad_cases_${token}`,   'Cases',   view === 'cases' ? ButtonStyle.Primary : ButtonStyle.Secondary, 'met_ia_case', view === 'cases'),
    btn(`iad_tickets_${token}`, 'Tickets', view === 'tickets' ? ButtonStyle.Primary : ButtonStyle.Secondary, 'met_ticket', view === 'tickets'),
    btn(`iad_stats_${token}`,   'Stats',   view === 'stats' ? ButtonStyle.Primary : ButtonStyle.Secondary, 'met_ia_stats', view === 'stats'),
    btn(`iad_quota_${token}`,   'Quota',   view === 'quota' ? ButtonStyle.Primary : ButtonStyle.Secondary, 'met_ia_quota', view === 'quota'),
  );
}

function scopeRow(token, scope, kind) {
  const opts = [
    { label: kind === 'tickets' ? 'All tickets' : 'All cases', value: 'all', description: 'Everything on record', emoji: 'met_database' },
    { label: 'Pending review', value: 'pending', description: 'Waiting on a decision', emoji: 'met_ia_queue' },
    { label: kind === 'tickets' ? 'Closed by me' : 'Filed by me', value: 'mine', description: 'Your own work', emoji: 'met_ia_officer' },
  ];
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`iad_scope_${token}`)
    .setPlaceholder('Filter…')
    .addOptions(opts.map(o => {
      const em = buttonEmoji(o.emoji);
      const opt = { label: o.label, value: o.value, description: o.description, default: o.value === scope };
      if (em) opt.emoji = em;
      return opt;
    }));
  return new ActionRowBuilder().addComponents(menu);
}

function pickRow(token, rows, kind) {
  if (!rows.length) return null;
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`iad_${kind === 'tickets' ? 'tpick' : 'pick'}_${token}`)
    .setPlaceholder(kind === 'tickets' ? 'Open a ticket…' : 'Open a case…')
    .addOptions(rows.slice(0, 25).map(r => kind === 'tickets'
      ? { label: short(`${r.ticketNo != null ? '#' + String(r.ticketNo).padStart(4, '0') : (r.ticketRef || 'ticket')} · ${r.ticketName || ''}`, 90),
          value: r.id, description: short(`closed by ${r.closerUsername || '·'}`, 90) }
      : { label: short(`${r.caseRef} · ${[...new Set(caseActionNames(r))].join(', ') || r.action || ''}`, 90),
          value: r.id, description: short(`${r.status} · ${r.robloxUsername || r.suspectRobloxDisplayName || 'unknown'}`, 90) }));
  return new ActionRowBuilder().addComponents(menu);
}

function pageRow(token, page, pages) {
  return new ActionRowBuilder().addComponents(
    btn(`iad_prev_${token}`, 'Back', ButtonStyle.Secondary, 'met_ia_prev', page <= 0),
    btn(`iad_noop_${token}`, `${page + 1} / ${pages}`, ButtonStyle.Secondary, null, true),
    btn(`iad_next_${token}`, 'Next', ButtonStyle.Secondary, 'met_ia_next', page >= pages - 1),
    btn(`iad_search_${token}`, 'Search', ButtonStyle.Secondary, 'met_search'),
    btn(`iad_refresh_${token}`, 'Refresh', ButtonStyle.Secondary, 'met_ia_refresh'),
  );
}

function caseActionRow(token, kase, decide, auth) {
  const row = new ActionRowBuilder();
  if (kase.status === 'PENDING') {
    row.addComponents(
      btn(`iad_approve_${token}`, 'Approve', ButtonStyle.Success, 'met_tick', !decide.allowed),
      btn(`iad_deny_${token}`,    'Deny',    ButtonStyle.Danger,  'met_cross', !decide.allowed),
      btn(`iad_changes_${token}`, 'Request changes', ButtonStyle.Secondary, 'met_edit',
        !AUTH.canRequestChanges(auth, kase).allowed),
    );
  }
  row.addComponents(btn(`iad_back_${token}`, 'Back to list', ButtonStyle.Secondary, 'met_ia_prev'));
  return row;
}

// ── Rendering ─────────────────────────────────────────────────────
async function render(interaction, token, state, auth) {
  const view = state.view;
  if (view === 'home') {
    return { embeds: [await homeView(auth)], components: [navRow(token, 'home')] };
  }
  if (view === 'stats') {
    return { embeds: [await statsView()], components: [navRow(token, 'stats')] };
  }
  if (view === 'quota') {
    return { embeds: [await quotaView(auth)], components: [navRow(token, 'quota')] };
  }
  if (view === 'cases' || view === 'tickets') {
    const kind = view;
    const out = kind === 'cases' ? await casesView(state, auth) : await ticketsView(state, auth);
    state.rowIds = out.rows.map(r => r.id);
    state.pages = out.pages;
    const rows = [navRow(token, kind), scopeRow(token, state.scope, kind)];
    const pick = pickRow(token, out.rows, kind);
    if (pick) rows.push(pick);
    rows.push(pageRow(token, state.page, out.pages));
    return { embeds: [out.embed], components: rows };
  }
  if (view === 'case') {
    const out = await caseDetailView(state.caseId, auth);
    if (!out.kase) return { embeds: [out.embed], components: [navRow(token, 'cases')] };
    return { embeds: [out.embed], components: [caseActionRow(token, out.kase, out.decide, auth), navRow(token, 'cases')] };
  }
  if (view === 'ticket') {
    const out = await ticketDetailView(state.ticketId, auth);
    if (!out.ticket) return { embeds: [out.embed], components: [navRow(token, 'tickets')] };
    const row = new ActionRowBuilder();
    if (out.ticket.status === 'PENDING') {
      row.addComponents(
        btn(`iad_tapprove_${token}`, 'Approve', ButtonStyle.Success, 'met_tick', !out.review.allowed),
        btn(`iad_tdeny_${token}`,    'Deny',    ButtonStyle.Danger,  'met_cross', !out.review.allowed),
      );
    }
    row.addComponents(btn(`iad_back_${token}`, 'Back to list', ButtonStyle.Secondary, 'met_ia_prev'));
    return { embeds: [out.embed], components: [row, navRow(token, 'tickets')] };
  }
  return { embeds: [await homeView(auth)], components: [navRow(token, 'home')] };
}

// ── The command ───────────────────────────────────────────────────
async function handleIaDashboardCommand(interaction) {
  await interaction.deferReply({ flags: 64 });

  const auth = await AUTH.resolveAuthority(interaction);
  if (!auth.ok) {
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLOR.bad)
      .setTitle(`${e('met_denied')} Not Internal Affairs`)
      .setDescription(auth.why)] }).catch(() => {});
  }

  await interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLOR.working)
    .setTitle(`${spinner(1)} Opening the dashboard…`)
    .setDescription(`${e('met_ia')} Reading the case and ticket queues.`)] }).catch(() => {});

  const q = (interaction.options.getString('search') || '').trim();
  const state = {
    ownerId: interaction.user.id,
    view: q ? 'cases' : 'home',
    scope: q ? 'all' : 'pending',
    page: 0, q: q || null, caseId: null, ticketId: null,
  };
  const token = keep(state);
  const payload = await render(interaction, token, state, auth);
  return interaction.editReply(payload).catch(() => {});
}

// ── Components ────────────────────────────────────────────────────
async function handleIaDashboardComponent(interaction) {
  const m = /^iad_([a-z]+)_([a-z0-9]+)$/i.exec(interaction.customId || '');
  if (!m) return;
  const [, verb, token] = m;
  if (verb === 'noop') return interaction.deferUpdate().catch(() => {});

  const state = recall(token);
  if (!state) {
    return interaction.update({
      embeds: [new EmbedBuilder().setColor(COLOR.quiet)
        .setTitle(`${e('met_warn')} This panel has expired`)
        .setDescription('Run `/ia` again · nothing was changed.')],
      components: [],
    }).catch(() => {});
  }
  if (String(state.ownerId) !== String(interaction.user.id)) {
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(COLOR.bad)
        .setTitle(`${e('met_denied')} Not your panel`)
        .setDescription('Run `/ia` to open your own.')],
      flags: 64,
    }).catch(() => {});
  }

  // Permissions are re-resolved on EVERY press, never carried on the token: a
  // panel opened as a Supervisor must not still act as one after the rank moves.
  const auth = await AUTH.resolveAuthority(interaction);
  if (!auth.ok) {
    return interaction.update({
      embeds: [new EmbedBuilder().setColor(COLOR.bad).setTitle(`${e('met_denied')} Not Internal Affairs`).setDescription(auth.why)],
      components: [],
    }).catch(() => {});
  }

  // A modal must be the FIRST response, so it cannot be deferred first.
  if (verb === 'search') return openSearchModal(interaction, token);
  if (verb === 'changes') return openChangesModal(interaction, token, state, auth);

  await interaction.deferUpdate().catch(() => {});

  switch (verb) {
    case 'home':    state.view = 'home'; break;
    case 'stats':   state.view = 'stats'; break;
    case 'quota':   state.view = 'quota'; break;
    case 'cases':   state.view = 'cases'; state.page = 0; break;
    case 'tickets': state.view = 'tickets'; state.page = 0; break;
    case 'scope':   state.scope = interaction.values[0]; state.page = 0; break;
    case 'prev':    state.page = Math.max(0, state.page - 1); break;
    case 'next':    state.page = Math.min((state.pages || 1) - 1, state.page + 1); break;
    case 'pick':    state.caseId = interaction.values[0]; state.view = 'case'; break;
    case 'tpick':   state.ticketId = interaction.values[0]; state.view = 'ticket'; break;
    case 'back':    state.view = state.view === 'ticket' ? 'tickets' : 'cases'; break;
    case 'refresh': break;
    case 'searchmodal': break;   // handled below via modal submit
    case 'approve': case 'deny':          return decideCase(interaction, token, state, auth, verb);
    case 'tapprove': case 'tdeny':        return decideTicket(interaction, token, state, auth, verb === 'tapprove' ? 'approve' : 'deny');
    default: break;
  }

  const payload = await render(interaction, token, state, auth);
  return interaction.editReply(payload).catch(() => {});
}

// ── Modals ────────────────────────────────────────────────────────
function openSearchModal(interaction, token) {
  const modal = new ModalBuilder().setCustomId(`iad_searchmodal_${token}`).setTitle('Search Internal Affairs');
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('q').setLabel('Case ref, officer, reason, investigator')
      .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100)));
  return interaction.showModal(modal).catch(() => {});
}

function openChangesModal(interaction, token, state, auth) {
  const modal = new ModalBuilder().setCustomId(`iad_changesmodal_${token}`).setTitle('Request changes');
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('note').setLabel('What needs changing?')
      .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000)));
  return interaction.showModal(modal).catch(() => {});
}

async function handleIaDashboardModal(interaction) {
  const m = /^iad_([a-z]+)_([a-z0-9]+)$/i.exec(interaction.customId || '');
  if (!m) return;
  const [, verb, token] = m;
  const state = recall(token);
  if (!state) return interaction.reply({ content: `${e('met_warn')} That panel has expired · run \`/ia\` again.`, flags: 64 }).catch(() => {});
  if (String(state.ownerId) !== String(interaction.user.id)) return interaction.deferUpdate().catch(() => {});

  const auth = await AUTH.resolveAuthority(interaction);
  if (!auth.ok) return interaction.deferUpdate().catch(() => {});

  if (verb === 'searchmodal') {
    await interaction.deferUpdate().catch(() => {});
    state.q = (interaction.fields.getTextInputValue('q') || '').trim() || null;
    state.page = 0;
    if (state.view !== 'cases' && state.view !== 'tickets') state.view = 'cases';
    const payload = await render(interaction, token, state, auth);
    return interaction.editReply(payload).catch(() => {});
  }

  if (verb === 'changesmodal') {
    await interaction.deferUpdate().catch(() => {});
    const note = (interaction.fields.getTextInputValue('note') || '').trim();
    const kase = await prisma.case.findUnique({ where: { id: state.caseId }, include: { casePunishments: true } });
    const can = AUTH.canRequestChanges(auth, kase);
    if (!can.allowed) return refuse(interaction, can.reason);
    try {
      await prisma.case.update({ where: { id: kase.id }, data: { reviewNote: note } });
      await prisma.caseAction.create({ data: {
        caseId: kase.id, actionType: 'CHANGES_REQUESTED', performedBy: auth.userId,
        notes: short(note, 400),
      } }).catch(() => {});
    } catch (err) {
      return refuse(interaction, `That could not be saved · ${short(err.message, 120)}`);
    }
    const payload = await render(interaction, token, state, auth);
    return interaction.editReply(payload).catch(() => {});
  }
}

// ── Decisions ─────────────────────────────────────────────────────
async function refuse(interaction, reason) {
  return interaction.followUp({
    embeds: [new EmbedBuilder().setColor(COLOR.bad).setTitle(`${e('met_ia_locked')} Not allowed`).setDescription(reason)],
    flags: 64,
  }).catch(() => {});
}

async function decideCase(interaction, token, state, auth, verb) {
  // Re-read the case WITH its punishments: the tier gate reads the applied rows,
  // so deciding off the list snapshot would be deciding off stale data.
  const kase = await prisma.case.findUnique({
    where: { id: state.caseId }, include: { casePunishments: true },
  });
  const can = AUTH.canDecideCase(auth, kase);
  if (!can.allowed) return refuse(interaction, can.reason);

  await interaction.editReply({
    embeds: [new EmbedBuilder().setColor(COLOR.working)
      .setTitle(`${spinner(2)} ${verb === 'approve' ? 'Approving' : 'Denying'} ${kase.caseRef}…`)
      .setDescription(verb === 'approve'
        ? `${e('met_ia_verdict')} Posting the log, applying punishments and notifying the officer.`
        : `${e('met_ia_verdict')} Recording the decision.`)],
    components: [],
  }).catch(() => {});

  const actor = { id: auth.userId, role: auth.role, displayName: auth.name };
  let out;
  try {
    out = verb === 'approve'
      ? await approveCase({ caseId: kase.id, actor, note: `Approved from Discord by ${auth.label}` })
      : await denyCase({ caseId: kase.id, actor, note: `Denied from Discord by ${auth.label}` });
  } catch (err) {
    out = { ok: false, error: short(err.message, 200) };
  }
  if (!out.ok) {
    await refuse(interaction, out.error || 'That could not be recorded.');
  }
  state.view = 'case';
  const payload = await render(interaction, token, state, auth);
  return interaction.editReply(payload).catch(() => {});
}

async function decideTicket(interaction, token, state, auth, action) {
  const ticket = await prisma.ticketLog.findUnique({ where: { id: state.ticketId } });
  const can = AUTH.canReviewTicket(auth, ticket);
  if (!can.allowed) return refuse(interaction, can.reason);

  await interaction.editReply({
    embeds: [new EmbedBuilder().setColor(COLOR.working)
      .setTitle(`${spinner(3)} Recording the decision…`)],
    components: [],
  }).catch(() => {});

  let out;
  try {
    out = await reviewTicket({
      ticketId: ticket.id,
      actor: { id: auth.userId, role: auth.role, displayName: auth.name },
      action,
    });
  } catch (err) { out = { ok: false, error: short(err.message, 200) }; }
  if (!out.ok) await refuse(interaction, out.error || 'That could not be recorded.');

  state.view = 'ticket';
  const payload = await render(interaction, token, state, auth);
  return interaction.editReply(payload).catch(() => {});
}

module.exports = {
  COMMAND, buildCommand,
  handleIaDashboardCommand, handleIaDashboardComponent, handleIaDashboardModal,
  // exposed for tests
  keep, recall, searchClause, caseLine, ticketLine, panels,
};
