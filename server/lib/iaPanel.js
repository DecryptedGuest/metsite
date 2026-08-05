// server/lib/iaPanel.js
// /check-record — the Internal Affairs panel.
//
// Named for what it does rather than for who owns it. "/ia" told you which
// department the command belonged to and nothing about what typing it would get
// you, which is the wrong way round for the one command in here that people who
// are not in IA also see in the picker.
//
// Handling a ticket means answering the same handful of questions over and
// over: who is this, what have they got on their record, what did case #618
// actually say, where is the evidence, are they even in the MET. Every one of
// those answers already exists on the dashboard, and every one of them currently
// costs a context switch — open the site, log in, find the person, find the
// case, open the document, scroll to the exhibits.
//
// So this is not a "record command". It is the dashboard's answers, delivered
// where the question is being asked. One ephemeral panel with a set of views:
//
//   Overview    who they are, their standing, and the shape of their record
//   Record      punishments and cases, newest first
//   Cases       a select menu of their cases → the case, and its exhibits
//   Tickets     tickets they opened and tickets they closed
//   Activity    XP, MET quota, patrol/event logs
//
// Nothing here changes anything. It is a reading tool, and deliberately so:
// /discipline already owns doing, and a panel that both shows and acts is a
// panel where somebody clicks the wrong button while looking something up.
//
// Access is the same gate as /discipline (Internal Affairs, MET High Command,
// or the developer) because it shows the same material.

const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
} = require('discord.js');

const prisma = require('./db');
const { e } = require('./emoji');
const { canDiscipline } = require('./disciplineAccess');
const { caseIsAbout, caseHasHicommOnlyPunishment } = require('./iaRank');

const COLOR = { panel: 0x4a8fff, warn: 0xf5b730, fail: 0xf04f5e, ok: 0x2ed896 };
const TTL_MS = 14 * 60 * 1000;   // a Discord component token lasts 15 minutes

function short(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function when(d) {
  return d ? `<t:${Math.floor(new Date(d).getTime() / 1000)}:R>` : '*undated*';
}

// "3d 4h", "5h", "12m" — a plain how-much-longer, to sit beside the relative
// timestamp Discord renders.
function humanLeft(ms) {
  if (ms <= 0) return '0m';
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (d) return `${d}d${h ? ` ${h}h` : ''}`;
  if (h) return `${h}h${m ? ` ${m}m` : ''}`;
  return `${m}m`;
}

/**
 * The state of one punishment — the same shape whether it came from a
 * CasePunishment (roleRemoved / expiresAt / durationDays) or a MetPunishment
 * (active / expiresAt / issuedAt). Says whether it is live, and if it is timed,
 * when it lapses and how long is left; if it has lapsed, when.
 *
 * @returns {{ icon: string, live: boolean, label: string }}
 */
function punishState(p) {
  const now = Date.now();
  const lifted = p.roleRemoved === true || p.active === false;
  const exp = p.expiresAt ? new Date(p.expiresAt) : null;
  const expMs = exp ? exp.getTime() : null;

  if (lifted) {
    return { icon: 'met_dot_off', live: false,
      label: p.roleRemoved ? 'Lifted' : 'No longer active' };
  }
  if (expMs != null && expMs <= now) {
    return { icon: 'met_dot_off', live: false, label: `Expired ${when(exp)}` };
  }
  if (expMs != null) {
    return { icon: 'met_online', live: true,
      label: `Active · expires ${when(exp)} · **${humanLeft(expMs - now)}** left` };
  }
  return { icon: 'met_stop', live: true, label: 'Active · permanent' };
}
function baseUrl() {
  return (process.env.PUBLIC_BASE_URL || 'https://metia.uk').replace(/\/+$/, '');
}

// The command's name, in one place. It appears in the builder, in the dispatcher
// in bot.js, and in the half-dozen messages that tell somebody to run it again —
// and a rename that misses any one of those leaves a command that cannot be
// reached or a message that names a command that no longer exists.
const COMMAND = 'check-record';

function buildCommand() {
  return new SlashCommandBuilder()
    .setName(COMMAND)
    .setDescription("Look up an officer's record, or open a case by number")
    .addStringOption(o => o
      .setName('officer')
      .setDescription('Who — a mention, a Discord id, or a Roblox username')
      .setMaxLength(120))
    .addStringOption(o => o
      .setName('case_number')
      .setDescription('Case number, e.g. 618')
      .setMaxLength(40))
    .toJSON();
}

// ── Panel state ───────────────────────────────────────────────────
// The panel is driven by buttons, and a Discord button gives us back only its
// custom id. Rather than cram the subject into that id (and re-resolve them on
// every click), each panel gets a token and the subject is held here.
const panels = new Map();   // token → { subject, ownerId, at }

function keep(state) {
  const token = Math.random().toString(36).slice(2, 10);
  panels.set(token, { ...state, at: Date.now() });
  // Cheap sweep — the map only grows while people are actively using it.
  if (panels.size > 400) {
    for (const [k, v] of panels) if (Date.now() - v.at > TTL_MS) panels.delete(k);
  }
  return token;
}
function recall(token) {
  const s = panels.get(token);
  if (!s) return null;
  if (Date.now() - s.at > TTL_MS) { panels.delete(token); return null; }
  return s;
}

// ── Resolving who they meant ──────────────────────────────────────
/**
 * Turn whatever was typed into somebody we can look up.
 *
 * Order matters: a mention is unambiguous, an id nearly so, and a name has to
 * be resolved — first against the server, then against Roblox, then against
 * anybody we have ever filed a case about. That last one is what makes the
 * panel work for somebody who has left the Discord entirely, which is exactly
 * when Internal Affairs most wants to look them up.
 */
async function resolveSubject(raw, guild) {
  const text = String(raw || '').trim();
  if (!text) return null;

  const mention = text.match(/<@!?(\d{15,25})>/);
  const id = mention ? mention[1] : (/^\d{15,25}$/.test(text) ? text : null);
  if (id) return finish({ discordId: id }, guild);

  const name = text.replace(/^@/, '');

  if (guild) {
    try {
      const hits = await guild.members.fetch({ query: name, limit: 5 });
      const q = name.toLowerCase();
      const m = hits.find(x => x.user.username.toLowerCase() === q)
             || hits.find(x => (x.displayName || '').toLowerCase() === q)
             // "PC | someone" — match the Roblox half of a rank nickname.
             || hits.find(x => (x.displayName || '').split('|').pop().trim().toLowerCase() === q)
             || hits.first();
      if (m) return finish({ discordId: m.id }, guild);
    } catch (err) { /* fall through to the other resolvers */ }
  }

  // A dashboard account under that Roblox username.
  try {
    const u = await prisma.user.findFirst({
      where: { robloxUsername: { equals: name, mode: 'insensitive' } },
      select: { discordId: true, robloxId: true, robloxUsername: true },
    });
    if (u && u.discordId) return finish({ discordId: u.discordId, robloxUsername: u.robloxUsername }, guild);
  } catch (err) { /* keep going */ }

  // Somebody we have filed a case about, even if they are long gone.
  try {
    const c = await prisma.case.findFirst({
      where: { robloxUsername: { equals: name, mode: 'insensitive' } },
      orderBy: { createdAt: 'desc' },
      select: { officerDiscordId: true, robloxUsername: true, robloxUserId: true },
    });
    if (c) {
      return finish({
        discordId: c.officerDiscordId || null,
        robloxUsername: c.robloxUsername,
        robloxId: c.robloxUserId,
      }, guild);
    }
  } catch (err) { /* keep going */ }

  // Roblox itself — they may simply not be on the dashboard yet.
  try {
    const info = await require('./roblox').getRobloxIdFromUsername(name);
    if (info && info.id) return finish({ discordId: null, robloxUsername: info.username || name, robloxId: String(info.id) }, guild);
  } catch (err) { /* no such Roblox user, or Roblox is down */ }

  return null;
}

// Fill in everything else we know about them, from whichever half we have.
async function finish(seed, guild) {
  const out = {
    discordId: seed.discordId ? String(seed.discordId) : null,
    robloxId: seed.robloxId ? String(seed.robloxId) : null,
    robloxUsername: seed.robloxUsername || null,
    displayName: null, avatar: null, metRank: null, inGuild: null,
  };

  if (out.discordId && guild) {
    try {
      const m = await guild.members.fetch(out.discordId);
      out.displayName = m.displayName;
      out.inGuild = true;
    } catch (err) { out.inGuild = false; }
  }

  if (out.discordId && (!out.robloxId || !out.robloxUsername)) {
    try {
      const link = await require('./robloxLink').resolveRoblox(out.discordId);
      if (link.robloxId) out.robloxId = String(link.robloxId);
      if (link.username) out.robloxUsername = link.username;
    } catch (err) { /* no link — the panel still works on the Discord half */ }
  }

  const roblox = require('./roblox');
  if (out.robloxId) {
    const [avatar, rank] = await Promise.all([
      roblox.getRobloxAvatarHeadshot(out.robloxId).catch(() => null),
      require('./metRank').metRole(out.robloxId).catch(() => null),
    ]);
    out.avatar = avatar;
    out.metRank = rank;
  }
  if (!out.displayName) out.displayName = out.robloxUsername || (out.discordId ? `<@${out.discordId}>` : 'Unknown');
  return out;
}

// ── Reading the record ────────────────────────────────────────────
/**
 * Every case filed against this person, newest first.
 *
 * Matched on the Discord id AND the Roblox username, because cases are filed
 * both ways: /discipline knows the Discord id, an imported case from before
 * any of this often only carries the Roblox name.
 */
async function casesFor(subject, take = 25) {
  const or = [];
  if (subject.discordId) or.push({ officerDiscordId: String(subject.discordId) });
  if (subject.robloxUsername) or.push({ robloxUsername: { equals: subject.robloxUsername, mode: 'insensitive' } });
  if (subject.robloxId) or.push({ robloxUserId: String(subject.robloxId) });
  if (!or.length) return [];
  try {
    return await prisma.case.findMany({
      where: { OR: or },
      orderBy: { createdAt: 'desc' },
      take,
      include: {
        user: { select: { displayName: true, discordUsername: true } },
        casePunishments: { select: { action: true, roleRemoved: true, expiresAt: true, durationDays: true } },
        // An appeal is auto-granted the moment it is filed, so there is no
        // status to read — the row existing IS the outcome.
        appeals: { select: { createdAt: true, appealedByName: true } },
      },
    });
  } catch (err) { return []; }
}

async function punishmentsFor(subject) {
  if (!subject.discordId) return [];
  try {
    return await prisma.metPunishment.findMany({
      where: { discordId: String(subject.discordId) },
      orderBy: { issuedAt: 'desc' },
      take: 25,
    });
  } catch (err) { return []; }
}

async function ticketsFor(subject) {
  const or = [];
  if (subject.discordId) {
    or.push({ creatorDiscordId: String(subject.discordId) });
    or.push({ closerDiscordId: String(subject.discordId) });
  }
  if (subject.robloxUsername) {
    or.push({ creatorRobloxUsername: { equals: subject.robloxUsername, mode: 'insensitive' } });
    or.push({ creatorUsername: { equals: subject.robloxUsername, mode: 'insensitive' } });
    or.push({ closerUsername: { equals: subject.robloxUsername, mode: 'insensitive' } });
  }
  if (!or.length) return [];
  try {
    return await prisma.ticketLog.findMany({ where: { OR: or }, orderBy: { closedAt: 'desc' }, take: 20 });
  } catch (err) { return []; }
}

const STATUS_ICON = {
  APPROVED: 'met_tick', PENDING: 'met_pending', DENIED: 'met_cross',
  OVERTURNED: 'met_scales', CHANGES_REQUESTED: 'met_edit',
};
function statusMark(s) { return e(STATUS_ICON[s] || 'met_dot_on'); }

// ── The views ─────────────────────────────────────────────────────
function headline(subject) {
  const bits = [];
  if (subject.discordId) bits.push(`${e('met_user')} <@${subject.discordId}>`);
  if (subject.robloxUsername) {
    bits.push(subject.robloxId
      ? `[${short(subject.robloxUsername, 30)}](https://www.roblox.com/users/${subject.robloxId}/profile)`
      : short(subject.robloxUsername, 30));
  }
  if (!bits.length) bits.push('*unidentified*');
  return bits.join(' · ');
}

async function overviewView(subject, client) {
  const [cases, punishments, tickets, strike] = await Promise.all([
    casesFor(subject),
    punishmentsFor(subject),
    ticketsFor(subject),
    subject.discordId
      ? require('./discipline').currentStrikeLevel({ discordId: subject.discordId }).catch(() => null)
      : null,
  ]);

  const rankIcon = subject.metRank
    ? require('./rankEmoji').forRank(client, subject.metRank.name)
    : '';

  const byStatus = {};
  for (const c of cases) byStatus[c.status] = (byStatus[c.status] || 0) + 1;
  const live = punishments.filter(p => p.active && (!p.expiresAt || new Date(p.expiresAt) > new Date()));

  const embed = new EmbedBuilder()
    .setColor(COLOR.panel)
    .setTitle(`${e('met_folder')} ${short(subject.displayName, 60)}`)
    .setDescription(headline(subject)
      + (subject.metRank ? `\n${rankIcon ? rankIcon + ' ' : ''}${subject.metRank.name}` : '\n*MET rank not found*')
      + (subject.inGuild === false ? `\n${e('met_leave')} **Not in the server.**` : ''))
    .addFields(
      { name: 'Cases', value: cases.length
          ? `${cases.length} total\n` + Object.entries(byStatus)
              .map(([s, n]) => `${statusMark(s)} ${n} ${s.toLowerCase().replace('_', ' ')}`).join('\n')
          : '*None on file.*', inline: true },
      { name: 'Punishments', value: punishments.length
          ? `${punishments.length} on record\n${live.length ? `${e('met_warn')} ${live.length} still live` : `${e('met_tick')} none live`}`
          : '*None on file.*', inline: true },
      { name: 'Strikes', value: strike && strike.level
          ? `${e('met_strike' + Math.min(strike.level, 3))} **Strike ${strike.level}**`
          : `${e('met_tick')} None`, inline: true },
    );

  if (strike && strike.cleared && strike.cleared.length) {
    embed.addFields({ name: 'Discounted', value:
      `${e('met_dot_off')} ${short(strike.cleared.join('; '), 200)} — on record but the role isn't worn, so it doesn't count.`,
      inline: false });
  }

  if (cases.length) {
    embed.addFields({ name: 'Most recent', value: cases.slice(0, 3).map(c =>
      `${statusMark(c.status)} \`${short(c.caseRef, 14)}\` ${short(c.action, 34)} — ${when(c.createdAt)}`).join('\n'),
      inline: false });
  }
  if (tickets.length) {
    const opened = tickets.filter(t => subject.discordId && String(t.creatorDiscordId) === String(subject.discordId)).length;
    embed.addFields({ name: 'Tickets', value:
      `${e('met_ticket')} ${tickets.length} on file — ${opened} opened, ${tickets.length - opened} closed by them`,
      inline: false });
  }

  if (subject.avatar) embed.setThumbnail(subject.avatar);
  embed.setFooter({ text: 'Internal Affairs · read-only' });
  return embed;
}

async function recordView(subject) {
  const [cases, punishments] = await Promise.all([casesFor(subject), punishmentsFor(subject)]);

  // A /discipline action exists as both a case and a punishment row sharing a
  // ref. Show it once, preferring the case — it carries the detail and the
  // appeal state.
  const refs = new Set(cases.map(c => c.caseRef).filter(Boolean));
  const rows = cases.map(c => {
    // The live/expired state of the case's own punishments, so the record can
    // say at a glance whether a strike is still standing or has lapsed.
    const pun = Array.isArray(c.casePunishments) ? c.casePunishments : [];
    const live = pun.filter(p => punishState(p).live);
    const soonest = live.map(p => p.expiresAt).filter(Boolean).map(d => new Date(d).getTime()).sort((a, b) => a - b)[0];
    return {
      at: c.createdAt, ref: c.caseRef, what: c.action, status: c.status,
      origin: c.origin, appealed: !!c.appealedAt,
      note: c.appealedAt ? null
        : soonest ? `${humanLeft(soonest - Date.now())} left`
        : (pun.length && !live.length) ? 'expired' : null,
    };
  }).concat(punishments
    .filter(p => !(p.caseRef && refs.has(p.caseRef)))
    .map(p => {
      const st = punishState(p);
      return {
        at: p.issuedAt, ref: p.caseRef, what: p.type,
        status: p.active ? 'ACTIVE' : 'LIFTED', origin: 'BOT', appealed: false,
        note: !st.live ? (p.active ? 'expired' : null)
          : p.expiresAt ? `${humanLeft(new Date(p.expiresAt).getTime() - Date.now())} left` : null,
      };
    }))
    .sort((a, b) => new Date(b.at) - new Date(a.at));

  const embed = new EmbedBuilder()
    .setColor(rows.length ? COLOR.warn : COLOR.ok)
    .setTitle(`${e('met_gavel')} Record — ${short(subject.displayName, 50)}`)
    .setDescription(headline(subject));

  if (!rows.length) {
    embed.addFields({ name: 'Nothing on file', value:
      'No cases and no punishments against this person.', inline: false });
    return embed;
  }

  const lines = rows.slice(0, 18).map(r => {
    const tag = r.origin === 'DISCIPLINE' ? ' *(direct)*' : r.origin === 'BOT' ? ' *(bot)*' : '';
    const appeal = r.appealed ? ` ${e('met_scales')} *appealed*` : '';
    const note = r.note ? ` · ${r.note}` : '';
    return `${statusMark(r.status)} \`${short(r.ref || '—', 14)}\` ${short(r.what, 36)}${tag}${appeal}${note} — ${when(r.at)}`;
  });
  embed.addFields({ name: `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}`,
    value: short(lines.join('\n'), 1000), inline: false });
  if (rows.length > 18) embed.setFooter({ text: `…and ${rows.length - 18} more — the full record is on the MET Dashboard` });
  return embed;
}

async function ticketsView(subject) {
  const tickets = await ticketsFor(subject);
  const embed = new EmbedBuilder()
    .setColor(COLOR.panel)
    .setTitle(`${e('met_ticket')} Tickets — ${short(subject.displayName, 50)}`)
    .setDescription(headline(subject));

  if (!tickets.length) {
    embed.addFields({ name: 'Nothing on file', value: 'No tickets opened by or closed by this person.', inline: false });
    return embed;
  }
  const mine = String(subject.discordId || '');
  const opened = tickets.filter(t => mine && String(t.creatorDiscordId) === mine);
  const closed = tickets.filter(t => !(mine && String(t.creatorDiscordId) === mine));
  const fmt = t => `${statusMark(t.status)} \`${short(t.ticketRef || t.ticketName || '—', 16)}\` `
    + `${short(String(t.ticketType || '').replace(/_/g, ' ').toLowerCase(), 22)} — ${when(t.closedAt)}`;

  if (opened.length) embed.addFields({ name: `Opened (${opened.length})`, value: short(opened.slice(0, 8).map(fmt).join('\n'), 1000), inline: false });
  if (closed.length) embed.addFields({ name: `Closed by them (${closed.length})`, value: short(closed.slice(0, 8).map(fmt).join('\n'), 1000), inline: false });
  return embed;
}

async function activityView(subject, client) {
  const embed = new EmbedBuilder()
    .setColor(COLOR.panel)
    .setTitle(`${e('met_xp')} Activity — ${short(subject.displayName, 50)}`)
    .setDescription(headline(subject));

  if (!subject.discordId) {
    embed.addFields({ name: 'No Discord account', value:
      'XP, quota and logs are all keyed to a Discord account, and this person has none linked.', inline: false });
    return embed;
  }

  const XP = require('./xp');
  const [row, standing, logs] = await Promise.all([
    XP.getBalance(subject.discordId).catch(() => null),
    XP.standing(subject.discordId).catch(() => ({ position: 0, total: 0 })),
    prisma.patrolLog.findMany({
      where: { submitterDiscordId: String(subject.discordId) },
      orderBy: { createdAt: 'desc' }, take: 50,
    }).catch(() => []),
  ]);

  if (row) {
    const p = XP.progress(row.xp);
    embed.addFields(
      { name: 'XP', value: p.next ? `${row.xp} / ${p.next.at} XP\n${p.need} more to go` : `${row.xp} / ${XP.maxXp()} XP\nMax rank`, inline: true },
      { name: 'Rank', value: p.rank.name, inline: true },
      { name: 'Standing', value: standing.total ? `#${standing.position} of ${standing.total}` : '—', inline: true },
    );
  } else {
    embed.addFields({ name: 'XP', value: '*Never placed on the XP ladder.*', inline: false });
  }

  // MET quota — the same read the officer's own dashboard does.
  try {
    const q = require('./quota');
    const res = await q.getMemberPoints(
      { discordId: subject.discordId, robloxUsername: subject.robloxUsername }, 'MET');
    if (res && res.found) {
      const target = res.quota ? res.quota.target : null;
      embed.addFields({ name: 'MET quota', value: res.quota && res.quota.exempt
          ? `${e('met_shield')} Exempt${res.exemptKind === 'PURCHASED' ? ' (bought)' : res.exemptKind === 'LOA' ? ' (on leave)' : ''}`
          : `${res.total} / ${target == null ? '—' : target} events this week`
            + (target != null ? (res.total >= target ? ` ${e('met_tick')}` : ` · ${res.remaining} to go`) : ''),
        inline: true });
    }
  } catch (err) { /* the sheet is optional */ }

  const approved = logs.filter(l => l.status === 'APPROVED');
  embed.addFields({ name: 'Logs filed', value: logs.length
      ? `${logs.length} in the last 50 · ${approved.length} approved\n`
        + `${e('met_dot_on')} ${logs.filter(l => l.type === 'PATROL').length} patrol · `
        + `${logs.filter(l => l.type === 'EVENT').length} event`
      : '*None on file.*', inline: false });
  return embed;
}

/** One case, in full, with its evidence. */
async function caseView(kase, precomputed) {
  const ev = precomputed || await require('./caseEvidence').evidenceFor(kase);
  const embed = new EmbedBuilder()
    .setColor(kase.status === 'APPROVED' ? COLOR.warn : COLOR.panel)
    .setTitle(`${e('met_folder')} ${short(kase.caseRef, 20)} — ${short(kase.action, 40)}`)
    .setDescription(
      `${statusMark(kase.status)} **${kase.status.replace('_', ' ')}**`
      + (kase.origin === 'DISCIPLINE' ? ` · *issued directly with /discipline, not an investigation*` : '')
      + `\n${e('met_user')} ${kase.robloxUsername ? short(kase.robloxUsername, 30) : (kase.officerDiscordId ? `<@${kase.officerDiscordId}>` : 'unknown')}`
      + ` · filed ${when(kase.createdAt)}`)
    .addFields(
      { name: 'Reason', value: short(kase.reason || 'N/A', 1000), inline: false },
    );

  if (kase.notes && kase.notes !== 'N/A') {
    embed.addFields({ name: 'Notes', value: short(kase.notes, 700), inline: false });
  }

  const punishments = Array.isArray(kase.casePunishments) ? kase.casePunishments : [];
  if (punishments.length) {
    embed.addFields({ name: 'Punishments', value: punishments.map(p => {
      const st = punishState(p);
      return `${e(st.icon)} **${short(p.action, 40)}**`
        + (p.durationDays ? ` · ${p.durationDays} day${p.durationDays === 1 ? '' : 's'}` : '')
        + `\n   ${st.label}`;
    }).join('\n'), inline: false });
  }

  if (kase.appealedAt) {
    embed.addFields({ name: 'Appeal', value:
      `${e('met_scales')} Granted ${when(kase.appealedAt)}`
      + (kase.appealedByName ? ` by ${short(kase.appealedByName, 40)}` : '')
      + (kase.appealReason ? `\n${short(kase.appealReason, 400)}` : ''), inline: false });
  }

  // ── Evidence ──
  if (ev.exhibits.length) {
    const lines = ev.exhibits.slice(0, 14).map(x => {
      const label = x.label || (x.external ? 'Case document' : 'Link');
      const body = x.url ? `[${label}](${x.url})` : `**${label}**`;
      const note = x.note ? ` — ${short(x.note, 90)}` : '';
      const flag = x.rejected ? ` ${e('met_warn')} *link rejected: \`${short(x.rejected, 40)}\`*` : '';
      const src = x.source && x.source !== 'exhibit list' ? ` *(from the ${x.source})*` : '';
      return `${e('met_link')} ${body}${note}${src}${flag}`;
    });
    embed.addFields({ name: `Evidence (${ev.exhibits.length})`, value: short(lines.join('\n'), 1000), inline: false });
  } else {
    embed.addFields({ name: 'Evidence', value: `${e('met_warn')} ${ev.note}`, inline: false });
  }

  const links = [];
  if (ev.caseLink) links.push(`[Case file](${ev.caseLink})`);
  links.push(`[Open on the MET Dashboard](${baseUrl()}/ia/dashboard#case-${encodeURIComponent(kase.caseRef)})`);
  embed.addFields({ name: 'Open', value: links.join(' · '), inline: false });

  embed.setFooter({ text: 'Internal Affairs · read-only' });
  return embed;
}

// ── Sharing evidence into the channel ─────────────────────────────
// The panel is ephemeral; the channel is not. Posting a case's exhibits into it
// puts them in front of everybody who can read that channel, permanently, and
// that is a disclosure decision rather than a UI convenience. So it is two
// steps: a confirmation that names the case, names the channel, and lists what
// is about to go out with where each exhibit came from — then the post.

/** What the confirmation shows before anything is public. */
function shareConfirmView(kase, ev, channel) {
  const where = channel
    ? (channel.name ? `**#${short(channel.name, 60)}**` : 'this channel')
    : 'this channel';

  const lines = ev.exhibits.slice(0, 14).map(x => {
    const label = x.label || (x.external ? 'Case document' : 'Link');
    const src = x.source ? ` *(${x.source})*` : '';
    return `${e('met_link')} ${label}${src}${x.url ? `\n\`${short(x.url, 90)}\`` : ' — *no link, nothing to send*'}`;
  });

  const sendable = ev.exhibits.filter(x => x.url).length;

  return new EmbedBuilder()
    .setColor(COLOR.warn)
    .setTitle(`${e('met_warn')} Send this evidence to ${channel && channel.name ? '#' + short(channel.name, 40) : 'the channel'}?`)
    .setDescription(
      `You are about to post **${sendable}** evidence link${sendable === 1 ? '' : 's'} from `
      + `\`${short(kase.caseRef, 20)}\` into ${where}.\n\n`
      + `${e('met_dot_on')} It will be **visible to everyone who can read that channel**, not just Internal Affairs.\n`
      + `${e('met_dot_on')} It will say the case reference and that you shared it.\n`
      + `${e('met_dot_on')} Nothing else from the case goes with it — no reason, no notes, no appeal detail.`)
    .addFields(
      { name: 'From', value:
        `\`${short(kase.caseRef, 20)}\` · ${short(kase.action, 40)}\n`
        + `${e('met_user')} ${kase.robloxUsername ? short(kase.robloxUsername, 30) : (kase.officerDiscordId ? `<@${kase.officerDiscordId}>` : 'unknown')}`
        + ` · filed ${when(kase.createdAt)}`
        + `\n${e('met_folder')} ${ev.caseLink ? 'From the case file' : 'From the case itself'}`,
        inline: false },
      { name: `What will be sent (${ev.exhibits.length})`, value: short(lines.join('\n'), 1000), inline: false },
    )
    .setFooter({ text: 'Nothing has been sent yet' });
}

/** The public post. Deliberately spare — links, and where they came from. */
function evidencePost(kase, ev, sharedBy) {
  const lines = ev.exhibits.filter(x => x.url).slice(0, 20).map(x => {
    const label = x.label || (x.external ? 'Case document' : 'Link');
    const note = x.note && !x.external ? ` — ${short(x.note, 90)}` : '';
    return `${e('met_link')} **${label}** — ${x.url}${note}`;
  });

  return new EmbedBuilder()
    .setColor(COLOR.panel)
    .setTitle(`${e('met_folder')} Evidence — ${short(kase.caseRef, 20)}`)
    .setDescription(
      `${short(kase.action, 60)}`
      + (kase.robloxUsername ? ` · ${short(kase.robloxUsername, 30)}` : '')
      + `\n\n${lines.join('\n')}`)
    .setFooter({ text: `Shared by ${short(sharedBy, 60)} · Internal Affairs` })
    .setTimestamp(new Date());
}

// Can the bot actually post here, and is this even a place to post?
function channelProblem(channel, client) {
  if (!channel) return "this doesn't look like a channel the bot can post in";
  if (typeof channel.send !== 'function') return "this isn't a channel the bot can post in";
  // A DM has no permission model to check, and posting evidence into somebody's
  // DMs from a panel is not what this button is for.
  if (!channel.guild) return 'this is a direct message — run `/' + COMMAND + '` in the channel you want the evidence in';
  try {
    const me = channel.guild.members && channel.guild.members.me;
    if (me && typeof channel.permissionsFor === 'function') {
      const perms = channel.permissionsFor(me);
      if (perms && typeof perms.has === 'function') {
        const { PermissionFlagsBits } = require('discord.js');
        if (!perms.has(PermissionFlagsBits.SendMessages)) return "the bot can't send messages in this channel";
        if (!perms.has(PermissionFlagsBits.EmbedLinks)) return "the bot can't embed links in this channel";
      }
    }
  } catch (err) { /* an unreadable permission set is not a refusal */ }
  return null;
}

// ── The desk (no officer named) ───────────────────────────────────
async function deskView() {
  // An appeal is granted the moment it is filed, so there is no pending pile —
  // what is worth surfacing is how many landed this week, because each one is a
  // case that has just been overturned.
  const weekAgo = new Date(Date.now() - 7 * 86400000);
  // Patrol and event logs are signed off in Discord, not here — counting them
  // on an Internal Affairs desk was advertising a queue nobody on it works.
  const [pendingCases, pendingTickets, recentAppeals] = await Promise.all([
    prisma.case.count({ where: { status: 'PENDING' } }).catch(() => 0),
    prisma.ticketLog.count({ where: { status: 'PENDING' } }).catch(() => 0),
    prisma.caseAppeal.count({ where: { createdAt: { gte: weekAgo } } }).catch(() => 0),
  ]);

  return new EmbedBuilder()
    .setColor(COLOR.panel)
    .setTitle(`${e('met_shield')} Internal Affairs`)
    .setDescription('Name an officer to pull their record — `/' + COMMAND + ' officer:@someone` — or a case '
      + 'number to open it directly with `/' + COMMAND + ' case_number:618`.\n\n'
      + 'Officers can be found by @mention, Discord id, or Roblox username, and a Roblox username '
      + 'works even for somebody who has left the server.')
    .addFields(
      { name: 'Waiting on review', value:
        `${e('met_pending')} **${pendingCases}** case${pendingCases === 1 ? '' : 's'}\n`
        + `${e('met_ticket')} **${pendingTickets}** ticket log${pendingTickets === 1 ? '' : 's'}\n`
        + `${e('met_scales')} **${recentAppeals}** appeal${recentAppeals === 1 ? '' : 's'} granted this week`, inline: true },
      { name: 'On the MET Dashboard', value:
        `[Pending queue](${baseUrl()}/ia/dashboard)\n[Casework](${baseUrl()}/ia/dashboard)\n[Quota & database](${baseUrl()}/ia/dashboard)`,
        inline: true },
    )
    .setFooter({ text: 'Internal Affairs · read-only' });
}

// ── Components ────────────────────────────────────────────────────
function navRow(token, active) {
  const b = (id, label) => new ButtonBuilder()
    .setCustomId(`ia_${id}_${token}`)
    .setLabel(label)
    .setStyle(active === id ? ButtonStyle.Primary : ButtonStyle.Secondary)
    .setDisabled(active === id);
  return new ActionRowBuilder().addComponents(
    b('over', 'Overview'), b('rec', 'Record'), b('tik', 'Tickets'), b('act', 'Activity'),
    // The record is ephemeral by design; this is the one deliberate way to put a
    // piece of it into the channel where the question is being asked.
    new ButtonBuilder().setCustomId(`ia_post_${token}`)
      .setLabel('Post to channel').setStyle(ButtonStyle.Success).setEmoji('📮'),
  );
}

function caseSelectRow(token, cases) {
  if (!cases.length) return null;
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`ia_case_${token}`)
    .setPlaceholder(`Open a case — ${cases.length} on file`)
    .addOptions(cases.slice(0, 25).map(c => ({
      label: short(`${c.caseRef} · ${c.action}`, 100),
      description: short(`${c.status.replace('_', ' ')} · ${new Date(c.createdAt).toISOString().slice(0, 10)} · ${c.reason || ''}`, 100),
      value: c.id,
    })));
  return new ActionRowBuilder().addComponents(menu);
}

function linkRow(subject) {
  const row = new ActionRowBuilder();
  const url = subject.discordId
    ? `${baseUrl()}/profile?user=${encodeURIComponent(subject.discordId)}`
    : `${baseUrl()}/ia/dashboard`;
  row.addComponents(new ButtonBuilder().setLabel('Open on the MET Dashboard').setStyle(ButtonStyle.Link).setURL(url));
  if (subject.robloxId) {
    row.addComponents(new ButtonBuilder().setLabel('Roblox profile').setStyle(ButtonStyle.Link)
      .setURL(`https://www.roblox.com/users/${subject.robloxId}/profile`));
  }
  return row;
}

/**
 * The share button, on a case view that actually has something to share.
 *
 * Deliberately absent when there is nothing sendable — a button that explains
 * why it can't do anything is worse than no button.
 */
function shareRow(token, sendable) {
  if (!sendable) return null;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ia_send_${token}`)
      .setLabel(`Send evidence to channel (${sendable})`)
      .setStyle(ButtonStyle.Secondary),
  );
}

// The actions on an open case: share its evidence, and — for Internal Affairs
// and Deputy Commissioner and above, on a case that can still be appealed —
// grant an appeal. Both on one row so the case view stays inside Discord's
// five-row limit.
function caseActionsRow(token, opts = {}) {
  const btns = [];
  if (opts.sendable) {
    btns.push(new ButtonBuilder().setCustomId(`ia_send_${token}`)
      .setLabel(`Send evidence to channel (${opts.sendable})`).setStyle(ButtonStyle.Secondary));
  }
  if (opts.canAppeal) {
    btns.push(new ButtonBuilder().setCustomId(`ia_appeal_${token}`)
      .setLabel('Appeal this case').setStyle(ButtonStyle.Danger).setEmoji('⚖️'));
  }
  return btns.length ? new ActionRowBuilder().addComponents(btns) : null;
}

/**
 * Render a case and pin it to the panel token.
 *
 * The share button carries only the token, so the token has to know which case
 * is on screen. Doing that here means opening a case from the menu and opening
 * one by reference cannot end up remembering different things.
 */
async function caseFrame(token, subject, kase, interaction) {
  const ev = await require('./caseEvidence').evidenceFor(kase);
  const state = recall(token);
  if (state) { state.caseId = kase.id; state.caseRef = kase.caseRef; state.view = 'case'; }
  const sendable = ev.exhibits.filter(x => x.url).length;
  // Whether the person looking at this may appeal it — worked out here so the
  // button only appears when pressing it would actually do something.
  const canAppeal = interaction ? (await appealCapability(interaction, kase)).allowed : false;
  return {
    embeds: [await caseView(kase, ev)],
    components: await componentsFor(token, subject, 'case', { sendable, canAppeal }),
  };
}

async function componentsFor(token, subject, active, opts = {}) {
  const rows = [navRow(token, active)];
  const cases = await casesFor(subject, 25);
  const sel = caseSelectRow(token, cases);
  if (sel) rows.push(sel);
  const actions = active === 'case'
    ? caseActionsRow(token, { sendable: opts.sendable || 0, canAppeal: !!opts.canAppeal })
    : null;
  if (actions) rows.push(actions);
  rows.push(linkRow(subject));
  return rows;
}

/**
 * May the person driving the panel appeal THIS case?
 *
 * Broader than the website (Internal Affairs and Deputy Commissioner and above,
 * rather than Senior Investigator and above) but with the same two guards that
 * make appeals safe: you cannot appeal a case about yourself, and only Deputy
 * Commissioner and above can appeal a Termination or a Blacklist.
 *
 * @returns {Promise<{ allowed, reason?, actorName?, rankLabel?, userId? }>}
 */
async function appealCapability(interaction, kase) {
  if (!kase) return { allowed: false, reason: 'That case is no longer there.' };
  if (kase.appealedAt || kase.status === 'OVERTURNED')
    return { allowed: false, reason: 'This case has already been appealed.' };
  if (kase.status !== 'APPROVED')
    return { allowed: false, reason: 'Only an approved case can be appealed.' };

  const verdict = await canUsePanel(interaction);
  if (!verdict.ok) return { allowed: false, reason: verdict.why || 'Not authorised.' };

  // The appealer's own identity, for the self-appeal guard.
  let appealer = null;
  try {
    appealer = await prisma.user.findUnique({
      where: { discordId: String(interaction.user.id) },
      select: { id: true, discordId: true, robloxId: true, robloxUsername: true },
    });
  } catch (e) { /* no dashboard account — still identified by discord id */ }
  const appealerUser = appealer || { discordId: String(interaction.user.id) };

  if (caseIsAbout(appealerUser, kase)) {
    return { allowed: false, reason: 'You cannot appeal a case about yourself — ask somebody else in Internal Affairs.' };
  }
  if (caseHasHicommOnlyPunishment(kase) && !verdict.isMetHicomm) {
    return { allowed: false, reason: 'Only Deputy Commissioner and above can appeal a Termination or a Blacklist.' };
  }

  const actorName = (interaction.member && interaction.member.displayName)
    || (interaction.user && (interaction.user.globalName || interaction.user.username)) || 'Internal Affairs';
  return {
    allowed: true,
    userId: appealer ? appealer.id : null,
    actorName,
    rankLabel: verdict.label || 'Internal Affairs',
  };
}

// ── Posting a piece of the record to the channel ──────────────────
// The panel is a reading tool for one person; sometimes the answer needs to be
// in the channel where the question was asked — "here is their record", or "here
// is exactly the Blacklist and the two cases behind it". This is that: a picker
// of the shareable parts (the current view, each punishment, each case, and the
// evidence on the open case), then a public post of whichever were chosen.
//
// The friendly name for the view on screen, for the picker and the confirmation.
const VIEW_LABEL = { over: 'overview', rec: 'record', tik: 'tickets', act: 'activity', case: 'case' };

// A human line for one punishment row — with its live/expired state and, when
// it is timed, how long is left.
function punishLine(p) {
  const st = punishState(p);
  return `${e(st.icon)} **${short(p.type, 40)}**${p.caseRef ? ` \`${short(p.caseRef, 20)}\`` : ''}`
    + `\n   ${e('met_calendar')} issued ${when(p.issuedAt)} · ${st.label}`
    + (p.reason ? `\n   > ${short(p.reason, 140)}` : '');
}

/**
 * The picker: an embed that says where it will post, a multi-select of the
 * shareable parts, and Post / Cancel. `picks` is what is currently ticked, so
 * the selection survives a re-render.
 */
async function postPickerView(token, subject, state, channel, picks = []) {
  const chosen = new Set(picks);
  const [cases, punishments] = await Promise.all([casesFor(subject, 20), punishmentsFor(subject)]);
  // A punishment that is really the CasePunishment half of a case is not listed
  // twice — the case carries it.
  const caseRefs = new Set(cases.map(c => c.caseRef).filter(Boolean));
  const punOptions = punishments.filter(p => !(p.caseRef && caseRefs.has(p.caseRef)));

  const options = [];
  const viewLabel = VIEW_LABEL[state.view] || 'record';
  options.push({
    label: short(`This ${viewLabel}`, 100),
    description: 'Post the panel exactly as it is on screen',
    value: 'view', emoji: '🧾', default: chosen.has('view'),
  });
  for (const p of punOptions.slice(0, 10)) {
    options.push({
      label: short(`${p.type}${p.caseRef ? ` · ${p.caseRef}` : ''}`, 100),
      description: short(`${p.active ? 'Active' : 'Lifted'} · ${p.issuedAt ? new Date(p.issuedAt).toISOString().slice(0, 10) : ''} · ${p.reason || ''}`, 100),
      value: `pun:${p.id}`, emoji: '⛔', default: chosen.has(`pun:${p.id}`),
    });
  }
  for (const c of cases.slice(0, 12)) {
    options.push({
      label: short(`${c.caseRef} · ${c.action}`, 100),
      description: short(`${String(c.status || '').replace('_', ' ')} · ${c.reason || ''}`, 100),
      value: `case:${c.id}`, emoji: '📁', default: chosen.has(`case:${c.id}`),
    });
  }
  // Evidence is only offered for the case that is open, because working out how
  // many links every case has would mean loading every one.
  if (state.caseId) {
    options.push({
      label: short(`Evidence from ${state.caseRef || 'the open case'}`, 100),
      description: 'The exhibit links on the case currently open',
      value: `ev:${state.caseId}`, emoji: '📎', default: chosen.has(`ev:${state.caseId}`),
    });
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`ia_pick_${token}`)
    .setPlaceholder('Pick what to post — the whole view, or specific items')
    .setMinValues(0)
    .setMaxValues(Math.min(25, options.length))
    .addOptions(options.slice(0, 25));

  const where = channel && channel.name ? `**#${short(channel.name, 60)}**` : 'this channel';
  const embed = new EmbedBuilder()
    .setColor(COLOR.panel)
    .setTitle(`${e('met_announce')} Post to the channel`)
    .setDescription(
      `Choose what to put in ${where}. It posts publicly, attributed to you.\n\n`
      + (picks.length
        ? `${e('met_tick')} **${picks.length}** selected.`
        : `${e('met_dot_off')} Nothing selected yet — the default is this ${viewLabel}.`))
    .setFooter({ text: 'Internal Affairs · nothing is posted until you press Post' });

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(menu),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`ia_postgo_${token}`)
          .setLabel(picks.length > 1 ? `Post ${picks.length} items` : 'Post').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`ia_postno_${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

/**
 * Turn the chosen picks into the embeds that go in the channel.
 *
 * Everything is read fresh here, so what is posted is what the record says now
 * rather than what it said when the picker opened. Capped at Discord's ten
 * embeds per message; a run of picks past that is noted rather than dropped
 * silently.
 */
async function buildPostEmbeds(subject, picks, view, client, sharedBy) {
  const embeds = [];
  const set = new Set(picks.length ? picks : ['view']);   // nothing ticked → the view
  let dropped = 0;

  if (set.has('view')) {
    const v = view === 'rec' ? await recordView(subject)
      : view === 'tik' ? await ticketsView(subject)
      : view === 'act' ? await activityView(subject, client)
      : await overviewView(subject, client);
    embeds.push(v);
  }

  // Punishments collapse into one embed — a list reads better than five cards.
  const punIds = [...set].filter(v => v.startsWith('pun:')).map(v => v.slice(4));
  if (punIds.length) {
    const all = await punishmentsFor(subject);
    const rows = all.filter(p => punIds.includes(String(p.id)));
    if (rows.length) {
      embeds.push(new EmbedBuilder()
        .setColor(COLOR.warn)
        .setTitle(`${e('met_gavel')} Punishments — ${short(subject.displayName, 50)}`)
        .setDescription(headline(subject))
        .addFields({ name: `Selected (${rows.length})`, value: short(rows.map(punishLine).join('\n\n'), 1800), inline: false })
        .setFooter({ text: 'Internal Affairs record' }));
    }
  }

  for (const v of set) {
    if (embeds.length >= 10) { dropped++; continue; }
    if (v.startsWith('case:')) {
      const kase = await loadCase(v.slice(5));
      if (kase) { const ev = await require('./caseEvidence').evidenceFor(kase); embeds.push(await caseView(kase, ev)); }
    } else if (v.startsWith('ev:')) {
      const kase = await loadCase(v.slice(3));
      if (kase) {
        const ev = await require('./caseEvidence').evidenceFor(kase);
        if (ev.exhibits.filter(x => x.url).length) embeds.push(evidencePost(kase, ev, sharedBy || 'Internal Affairs'));
      }
    }
  }
  return { embeds: embeds.slice(0, 10), dropped };
}

/**
 * The post-to-channel flow: `post` opens the picker, `pick` records a selection
 * and keeps it on screen, `postno` backs out, `postgo` posts.
 */
async function handlePost(interaction, token, state, step) {
  const subject = state.subject;
  const channel = interaction.channel;

  const backToView = async () => {
    const view = state.view || 'over';
    if (view === 'case' && state.caseId) {
      const kase = await loadCase(state.caseId);
      if (kase) return interaction.editReply(await caseFrame(token, subject, kase, interaction)).catch(() => {});
    }
    const embed = view === 'rec' ? await recordView(subject)
      : view === 'tik' ? await ticketsView(subject)
      : view === 'act' ? await activityView(subject, interaction.client)
      : await overviewView(subject, interaction.client);
    return interaction.editReply({ embeds: [embed], components: await componentsFor(token, subject, view) }).catch(() => {});
  };

  if (step === 'postno') { state.postPick = []; return backToView(); }

  if (step === 'post') {
    state.postPick = state.postPick || [];
    return interaction.editReply(await postPickerView(token, subject, state, channel, state.postPick)).catch(() => {});
  }

  if (step === 'pick') {
    state.postPick = Array.isArray(interaction.values) ? interaction.values : [];
    return interaction.editReply(await postPickerView(token, subject, state, channel, state.postPick)).catch(() => {});
  }

  // ── postgo ──
  const problem = channelProblem(channel, interaction.client);
  if (problem) {
    return interaction.editReply({
      embeds: [new EmbedBuilder().setColor(COLOR.fail)
        .setTitle(`${e('met_cross')} Can't post here`)
        .setDescription(`Nothing was posted — ${problem}.`)],
      components: await componentsFor(token, subject, state.view || 'over'),
    }).catch(() => {});
  }

  const picks = state.postPick || [];
  const who = (interaction.member && interaction.member.displayName)
    || interaction.user.globalName || interaction.user.username;
  const { embeds, dropped } = await buildPostEmbeds(subject, picks, state.view || 'over', interaction.client, who);
  if (!embeds.length) {
    return interaction.editReply(await postPickerView(token, subject, state, channel, picks)).catch(() => {});
  }
  // A lead line so the channel knows who pulled the record and about whom —
  // the embeds themselves carry no attribution.
  const lead = `${e('met_folder')} Record shared by **${short(who, 60)}**`
    + (subject.discordId ? ` — <@${subject.discordId}>` : subject.robloxUsername ? ` — ${short(subject.robloxUsername, 40)}` : '');

  let posted = null;
  try {
    posted = await channel.send({ content: lead, embeds, allowedMentions: { parse: [] } });
  } catch (err) {
    return interaction.editReply({
      embeds: [new EmbedBuilder().setColor(COLOR.fail)
        .setTitle(`${e('met_cross')} Not posted`)
        .setDescription(`Discord refused it: ${short(err.message, 300)}`)],
      components: await componentsFor(token, subject, state.view || 'over'),
    }).catch(() => {});
  }

  console.log(`[IA panel] ${interaction.user.id} posted ${embeds.length} record item(s) about `
    + `${subject.discordId || subject.robloxUsername || 'unknown'} into #${(channel && channel.name) || channel.id}`);
  state.postPick = [];

  return interaction.editReply({
    embeds: [new EmbedBuilder().setColor(COLOR.ok)
      .setTitle(`${e('met_tick')} Posted`)
      .setDescription(`**${embeds.length}** item${embeds.length === 1 ? '' : 's'} posted in `
        + `${channel.name ? `**#${short(channel.name, 60)}**` : 'this channel'}.`
        + (dropped ? `\n${e('met_warn')} ${dropped} more couldn't fit in one message — post them in a second batch.` : '')
        + (posted && posted.url ? `\n\n[Jump to it](${posted.url})` : ''))],
    components: await componentsFor(token, subject, state.view || 'over'),
  }).catch(() => {});
}

// ── Appealing a case from the panel ───────────────────────────────
// Opening the modal has to be the FIRST response to the button — you cannot
// defer and then show a modal — so this is called before the shared deferUpdate.
async function openAppealModal(interaction, token, state) {
  const kase = state.caseId ? await loadCase(state.caseId) : null;
  const cap = await appealCapability(interaction, kase);
  if (!cap.allowed) {
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(COLOR.warn)
        .setTitle(`${e('met_warn')} Can't appeal this`).setDescription(cap.reason)],
      flags: 64,
    }).catch(() => {});
  }
  const { ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
  const modal = new ModalBuilder()
    .setCustomId(`ia_appealmodal_${token}`)
    .setTitle(short(`Appeal ${kase.caseRef}`, 45))
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('reason')
        .setLabel('Reason for the appeal')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Recorded permanently against the case. This grants the appeal immediately.')
        .setRequired(true).setMaxLength(2000)));
  return interaction.showModal(modal).catch(() => {});
}

/**
 * The modal came back — grant the appeal. Re-checks the gate (the panel token
 * outlives the case's state) and re-reads the case, then runs the shared
 * lib/caseAppeal so it happens exactly as it does from the website.
 */
async function handleAppealSubmit(interaction, token, state) {
  const subject = state.subject;
  const kase = state.caseId ? await loadCase(state.caseId) : null;
  const cap = await appealCapability(interaction, kase);
  if (!cap.allowed) {
    return interaction.editReply({
      embeds: [new EmbedBuilder().setColor(COLOR.warn)
        .setTitle(`${e('met_warn')} Can't appeal this`).setDescription(cap.reason)],
    }).catch(() => {});
  }

  const reason = interaction.fields && typeof interaction.fields.getTextInputValue === 'function'
    ? interaction.fields.getTextInputValue('reason') : '';

  // The appeal needs the punishments WITH their id and roleId to lift and mark
  // them — the panel's loadCase selects a lighter set for display, so re-read
  // the case in full for the operation itself.
  const full = await prisma.case.findUnique({
    where: { id: kase.id },
    include: { casePunishments: true },
  }).catch(() => null);

  const out = await require('./caseAppeal').appealCase({
    existing: full || kase,
    actor: { userId: cap.userId, name: cap.actorName, rankLabel: cap.rankLabel },
    reason,
  });
  if (!out.ok) {
    return interaction.editReply({
      embeds: [new EmbedBuilder().setColor(COLOR.fail)
        .setTitle(`${e('met_cross')} Not appealed`).setDescription(out.error || 'Something went wrong.')],
    }).catch(() => {});
  }

  require('./audit').log(
    { id: cap.userId, displayName: cap.actorName },
    { category: 'ia', action: 'CASE_APPEAL', target: { type: 'case', id: kase.id },
      summary: `Appeal granted on ${kase.caseRef} from /check-record — ${out.lifted.length} role(s) lifted`,
      metadata: { reason, lifted: out.lifted, failed: out.failed, kept: out.kept, manual: out.manual } });

  const done = new EmbedBuilder()
    .setColor(COLOR.ok)
    .setTitle(`${e('met_scales')} Appeal granted — ${short(kase.caseRef, 20)}`)
    .setDescription(`${e('met_tick')} The case is overturned and no longer counts against them.`)
    .addFields(
      { name: 'Roles lifted', value: out.lifted.length ? out.lifted.join(', ') : '*none to lift*', inline: false },
    );
  if (out.failed.length) done.addFields({ name: `${e('met_warn')} Couldn't remove (will retry)`, value: short(out.failed.join(', '), 300), inline: false });
  if (out.kept.length)   done.addFields({ name: 'Left in place', value: short(out.kept.join(', '), 300), inline: false });
  if (out.manual.length) done.addFields({ name: `${e('met_warn')} By hand`, value: short(out.manual.join('\n'), 400), inline: false });
  done.setFooter({ text: `Appealed by ${short(cap.actorName, 50)} · Internal Affairs` });

  // Reload the case so the panel underneath shows it appealed, with the result
  // embed sitting on top.
  const fresh = await loadCase(kase.id);
  const frame = fresh ? await caseFrame(token, subject, fresh, interaction) : { components: await componentsFor(token, subject, 'over') };
  return interaction.editReply({ embeds: [done], components: frame.components }).catch(() => {});
}

/**
 * The three steps of putting a case's evidence in the channel.
 *
 * The panel it is driven from is ephemeral and the channel is not, so this is
 * never one click: `send` shows what would go out and where, `sendgo` posts it,
 * `sendno` puts the case back. The case is read fresh at each step rather than
 * carried along, so what gets posted is what the case says now.
 */
async function handleShare(interaction, token, state, step) {
  const subject = state.subject;
  const back = async () => {
    const kase = state.caseId ? await loadCase(state.caseId) : null;
    if (!kase) return;
    return interaction.editReply(await caseFrame(token, subject, kase, interaction)).catch(() => {});
  };

  if (step === 'sendno') return back();

  const kase = state.caseId ? await loadCase(state.caseId) : null;
  if (!kase) {
    return interaction.editReply({
      embeds: [new EmbedBuilder().setColor(COLOR.fail)
        .setTitle(`${e('met_cross')} That case is no longer there`)
        .setDescription('Open it again from the menu.')],
    }).catch(() => {});
  }

  const ev = await require('./caseEvidence').evidenceFor(kase);
  const sendable = ev.exhibits.filter(x => x.url).length;
  if (!sendable) {
    return interaction.editReply({
      embeds: [new EmbedBuilder().setColor(COLOR.warn)
        .setTitle(`${e('met_warn')} Nothing to send`)
        .setDescription('This case has no evidence links on it.')],
      components: await componentsFor(token, subject, 'case', { sendable: 0 }),
    }).catch(() => {});
  }

  const channel = interaction.channel;
  const problem = channelProblem(channel, interaction.client);

  // ── Step 1: ask ──
  if (step === 'send') {
    if (problem) {
      return interaction.editReply({
        embeds: [new EmbedBuilder().setColor(COLOR.fail)
          .setTitle(`${e('met_cross')} Can't send it here`)
          .setDescription(`Nothing was sent — ${problem}.`)],
        components: await componentsFor(token, subject, 'case', { sendable }),
      }).catch(() => {});
    }
    return interaction.editReply({
      embeds: [shareConfirmView(kase, ev, channel)],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`ia_sendgo_${token}`)
          .setLabel(`Send ${sendable} link${sendable === 1 ? '' : 's'}`).setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`ia_sendno_${token}`)
          .setLabel('Cancel').setStyle(ButtonStyle.Secondary),
      )],
    }).catch(() => {});
  }

  // ── Step 2: send ──
  if (problem) {
    return interaction.editReply({
      embeds: [new EmbedBuilder().setColor(COLOR.fail)
        .setTitle(`${e('met_cross')} Not sent`)
        .setDescription(problem)],
      components: await componentsFor(token, subject, 'case', { sendable }),
    }).catch(() => {});
  }

  const who = (interaction.member && interaction.member.displayName)
    || interaction.user.globalName || interaction.user.username;
  let posted = null;
  try {
    posted = await channel.send({
      embeds: [evidencePost(kase, ev, who)],
      // The links are the point; nothing here should ping anybody.
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    return interaction.editReply({
      embeds: [new EmbedBuilder().setColor(COLOR.fail)
        .setTitle(`${e('met_cross')} Not sent`)
        .setDescription(`Discord refused it: ${short(err.message, 300)}`)],
      components: await componentsFor(token, subject, 'case', { sendable }),
    }).catch(() => {});
  }

  console.log(`[IA panel] ${interaction.user.id} shared ${sendable} evidence link(s) `
    + `from ${kase.caseRef} into #${(channel && channel.name) || channel.id}`);

  return interaction.editReply({
    embeds: [new EmbedBuilder().setColor(COLOR.ok)
      .setTitle(`${e('met_tick')} Sent`)
      .setDescription(`**${sendable}** evidence link${sendable === 1 ? '' : 's'} from \`${short(kase.caseRef, 20)}\` `
        + `posted in ${channel.name ? `**#${short(channel.name, 60)}**` : 'this channel'}.`
        + (posted && posted.url ? `\n\n[Jump to it](${posted.url})` : ''))],
    components: await componentsFor(token, subject, 'case', { sendable }),
  }).catch(() => {});
}

// One case with everything the panel needs on it.
function loadCase(id) {
  return prisma.case.findUnique({
    where: { id },
    include: {
      user: { select: { displayName: true } },
      casePunishments: { select: { action: true, roleRemoved: true, expiresAt: true, durationDays: true } },
    },
  }).catch(() => null);
}

// ── Access ────────────────────────────────────────────────────────
async function canUsePanel(interaction) {
  const roleIds = interaction.member && interaction.member.roles && interaction.member.roles.cache
    ? [...interaction.member.roles.cache.keys()] : [];
  return canDiscipline(interaction.user.id, roleIds);
}

function denied(access) {
  return new EmbedBuilder()
    .setColor(COLOR.fail)
    .setTitle(`${e('met_denied')} Not authorised`)
    .setDescription(access.why || 'The Internal Affairs panel is for Internal Affairs and Deputy Commissioner and above.');
}

// ── The command ───────────────────────────────────────────────────
async function handleIaCommand(interaction) {
  await interaction.deferReply({ flags: 64 });   // 64 = ephemeral

  const access = await canUsePanel(interaction);
  if (!access.ok) return interaction.editReply({ embeds: [denied(access)] }).catch(() => {});

  const officer = interaction.options.getString('officer');
  // `case` is a reserved word in a lot of people's heads — it read as "pick a
  // case" rather than "type its number". The option name says which.
  const caseRef = interaction.options.getString('case_number');

  // A case reference wins — somebody who typed one wants that case.
  if (caseRef) {
    const kase = await findCase(caseRef);
    if (!kase) {
      return interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLOR.fail)
        .setTitle(`${e('met_cross')} No such case`)
        .setDescription(`Nothing on file under \`${short(caseRef, 30)}\`. Case references look like \`#618\`.`)] }).catch(() => {});
    }
    const subject = await finish({
      discordId: kase.officerDiscordId, robloxUsername: kase.robloxUsername, robloxId: kase.robloxUserId,
    }, interaction.guild);
    const token = keep({ subject, ownerId: interaction.user.id });
    return interaction.editReply(await caseFrame(token, subject, kase, interaction)).catch(() => {});
  }

  if (!officer) {
    return interaction.editReply({ embeds: [await deskView()], components: [] }).catch(() => {});
  }

  const subject = await resolveSubject(officer, interaction.guild);
  if (!subject) {
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLOR.fail)
      .setTitle(`${e('met_cross')} Couldn't find them`)
      .setDescription(`Nothing matched \`${short(officer, 40)}\`.\n\n`
        + 'Try @-mentioning them — the picker inserts a real mention, which always resolves — '
        + 'or give their exact Roblox username.')] }).catch(() => {});
  }

  const token = keep({ subject, ownerId: interaction.user.id, view: 'over' });
  return interaction.editReply({
    embeds: [await overviewView(subject, interaction.client)],
    components: await componentsFor(token, subject, 'over'),
  }).catch(() => {});
}

async function findCase(ref) {
  const raw = String(ref || '').trim();
  const candidates = [...new Set([raw, raw.replace(/^#/, ''), `#${raw.replace(/^#/, '')}`])];
  try {
    return await prisma.case.findFirst({
      where: { caseRef: { in: candidates } },
      include: {
        user: { select: { displayName: true } },
        casePunishments: { select: { action: true, roleRemoved: true, expiresAt: true, durationDays: true } },
      },
    });
  } catch (err) { return null; }
}

// ── Buttons and the case menu ─────────────────────────────────────
async function handleIaComponent(interaction) {
  const cid = String(interaction.customId || '');
  const m = cid.match(/^ia_([a-z]+)_([a-z0-9]+)$/i);
  if (!m) return;
  const [, view, token] = m;

  const access = await canUsePanel(interaction);
  if (!access.ok) {
    return interaction.reply({ embeds: [denied(access)], flags: 64 }).catch(() => {});
  }

  const state = recall(token);
  if (!state) {
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(COLOR.warn)
        .setTitle(`${e('met_warn')} This panel has expired`)
        .setDescription('Run `/' + COMMAND + '` again — panels last about fifteen minutes.')],
      flags: 64,
    }).catch(() => {});
  }
  // The panel is ephemeral, so only its owner can see it anyway; this is a
  // guard against a token being replayed from somewhere else.
  if (state.ownerId && String(state.ownerId) !== String(interaction.user.id)) {
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(COLOR.fail)
        .setTitle(`${e('met_denied')} Not your panel`)
        .setDescription('Run `/' + COMMAND + '` to open your own.')],
      flags: 64,
    }).catch(() => {});
  }

  // Opening the appeal modal must be the FIRST response — before the deferUpdate
  // below, which would otherwise consume the interaction and make showModal fail.
  if (view === 'appeal') {
    return openAppealModal(interaction, token, state);
  }

  await interaction.deferUpdate().catch(() => {});
  const subject = state.subject;

  try {
    // ── Granting an appeal (the modal came back) ──
    if (view === 'appealmodal') {
      return handleAppealSubmit(interaction, token, state);
    }

    // ── Sharing evidence ──
    if (view === 'send' || view === 'sendgo' || view === 'sendno') {
      return handleShare(interaction, token, state, view);
    }

    // ── Posting a piece of the record to the channel ──
    if (view === 'post' || view === 'pick' || view === 'postgo' || view === 'postno') {
      return handlePost(interaction, token, state, view);
    }

    if (view === 'case') {
      const id = interaction.values && interaction.values[0];
      const kase = id ? await loadCase(id) : null;
      if (!kase) return;
      state.view = 'case';
      return interaction.editReply(await caseFrame(token, subject, kase, interaction)).catch(() => {});
    }

    // Remember which view is on screen, so "Post to channel" knows what "this
    // view" means when it is pressed.
    state.view = view;

    const embed = view === 'rec' ? await recordView(subject)
      : view === 'tik' ? await ticketsView(subject)
      : view === 'act' ? await activityView(subject, interaction.client)
      : await overviewView(subject, interaction.client);

    return interaction.editReply({
      embeds: [embed],
      components: await componentsFor(token, subject, view),
    }).catch(() => {});
  } catch (err) {
    console.error('[IA panel] view failed:', err.message);
    return interaction.editReply({
      embeds: [new EmbedBuilder().setColor(COLOR.fail)
        .setTitle(`${e('met_cross')} Couldn't load that`)
        .setDescription(short(err.message, 300))],
    }).catch(() => {});
  }
}

module.exports = {
  COMMAND, buildCommand, handleIaCommand, handleIaComponent,
  shareConfirmView, evidencePost, channelProblem, caseFrame, handleShare, handlePost,
  postPickerView, buildPostEmbeds, loadCase,
  appealCapability, openAppealModal, handleAppealSubmit, punishState, punishLine,
  resolveSubject, casesFor, punishmentsFor, ticketsFor, findCase,
  overviewView, recordView, ticketsView, activityView, caseView, deskView,
  componentsFor, keep, recall,
};
