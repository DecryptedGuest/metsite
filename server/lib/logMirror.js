// server/lib/logMirror.js
// The Discord copy of a patrol or event log filed on the site.
//
// A log lives in the database and is decided on the website. This posts a
// mirror of it into the division's channel the moment it is filed, marked
// clearly as waiting, and then EDITS THAT SAME MESSAGE when a supervisor
// decides — so the channel shows one message per log whose current state is the
// truth, rather than a pending post followed later by an unrelated "approved"
// post that nobody can match up to it.
//
// Three things this deliberately does not do:
//
//   It never throws. A Discord outage, a missing channel, a revoked permission
//   — none of those may stop a log being filed or a decision being recorded.
//   Every function returns what it managed and logs what it didn't.
//
//   It never treats a reaction as a decision. patrolReactions.js signs off the
//   FLP logs that live in Discord, keyed on patrol_logs.messageId, and these
//   rows are in different tables, so it will never see them. That is on
//   purpose: these are decided on the site by somebody whose rank the site can
//   actually check. The footer says so, because a channel full of tickable
//   embeds otherwise invites a tick that does nothing.
//
//   It never writes a second message for the same log. If the mirror has been
//   deleted, editing it fails with 10008 and it is reposted once, with the new
//   id recorded — so a deleted mirror heals instead of being lost or duplicated.

const { e } = require('./emoji');

// Where each kind goes. Overridable, because a server that reorganises its
// channels should not need a deploy.
function channelFor(kind) {
  if (kind === 'EVENT') {
    return String(process.env.IA_EVENT_LOG_CHANNEL_ID || '1533829063611777035').trim();
  }
  return String(process.env.IA_PATROL_LOG_CHANNEL_ID || '1533823805804380220').trim();
}

// Off by default for nothing — but a deployment with no bot, or one that wants
// the site to be the only record, can turn the whole mirror off.
function enabled() {
  return String(process.env.IA_LOG_MIRROR || 'on').toLowerCase() !== 'off';
}

const COLOUR = {
  PENDING:  0xf5b730,   // amber — waiting on somebody
  APPROVED: 0x2ed896,   // green
  DENIED:   0xf04f5e,   // red
  VOIDED:   0x9d7dff,   // purple, the same mark an appealed case gets
};

// ── Formatting helpers ────────────────────────────────────────────

const cap = (s, n = 1024) => {
  const v = String(s == null ? '' : s);
  return v.length > n ? v.slice(0, n - 1) + '…' : v;
};

// Discord's own timestamps, so everybody reads the log in their own timezone.
// A log filed by somebody in London and reviewed by somebody in New York
// otherwise disagrees with itself about when the shift was.
const ts = (d, style = 'f') => {
  const t = d ? new Date(d).getTime() : NaN;
  return Number.isFinite(t) ? `<t:${Math.floor(t / 1000)}:${style}>` : 'unknown';
};

/** "2h 30m", "45m", "—". Minutes are what the form collects; nobody reads 150. */
function humanMinutes(mins) {
  const m = Number(mins);
  if (!Number.isFinite(m) || m <= 0) return '—';
  const h = Math.floor(m / 60), r = m % 60;
  if (!h) return `${r}m`;
  if (!r) return `${h}h`;
  return `${h}h ${r}m`;
}

/** A person as Discord should render them: a mention when we know the id. */
function person(p) {
  if (!p) return '*unknown*';
  if (p.discordId && /^\d{15,21}$/.test(String(p.discordId))) return `<@${p.discordId}>`;
  return p.name ? String(p.name).slice(0, 80) : '*unknown*';
}

/**
 * A roll of people, as one field value.
 *
 * Capped at Discord's 1024 characters with an honest "+N more" rather than a
 * silent truncation — an embed that drops eleven names without saying so reads
 * as though eleven people were not there.
 */
function roll(people) {
  const list = (Array.isArray(people) ? people : []).filter(Boolean);
  if (!list.length) return null;

  const SEP = ' · ';
  // Room for the honest tail, worked out for the WHOLE list rather than for
  // however many happen to fit — otherwise the reserved space is short by a
  // digit exactly when the list is long enough to need it.
  const tailFor = (n) => n > 0 ? ` *+${n} more*` : '';
  const reserve = tailFor(list.length).length;

  const parts = [];
  let used = 0;
  for (const p of list) {
    const s = person(p);
    // The separator only exists between items, so it is only charged after the
    // first. Counting it per item is what let 60 mentions come out at 1040
    // characters and get the whole embed rejected by Discord.
    const cost = s.length + (parts.length ? SEP.length : 0);
    if (used + cost + reserve > 1024) break;
    parts.push(s);
    used += cost;
  }
  const rest = list.length - parts.length;
  // Nothing fitted at all: one enormous name. Say the count rather than nothing.
  if (!parts.length) return `**${list.length}** listed`;
  return parts.join(SEP) + tailFor(rest);
}

/** The one-line verdict at the top, which is the thing people scan for. */
function statusLine(row) {
  if (row.voidedAt) {
    return `${e('met_warn')} **Withdrawn**`
      + (row.voidedReason ? ` — ${cap(row.voidedReason, 200)}` : '')
      + `\nThe points and XP this paid have been taken back.`;
  }
  const who = row.reviewedByName ? `**${cap(row.reviewedByName, 60)}**` : 'a supervisor';
  if (row.status === 'APPROVED') {
    return `${e('met_tick')} **Approved** by ${who} · ${ts(row.reviewedAt, 'R')}`;
  }
  if (row.status === 'DENIED') {
    return `${e('met_cross')} **Denied** by ${who} · ${ts(row.reviewedAt, 'R')}`
      + (row.reviewNote ? `\n> ${cap(row.reviewNote, 300)}` : '');
  }
  return `${e('met_pending')} **Waiting on a supervisor.** Nobody has been paid yet.`;
}

/**
 * What the log is worth, spelled out rather than implied.
 *
 * The LABEL has to follow the status, not sit at "Worth on approval" forever. An
 * approved log saying "on approval" reads as though it is still coming, and a
 * denied one saying it reads as though somebody was paid.
 *
 * @returns {{ label: string, value: string } | null}
 */
function worthLine(row, kind) {
  const points = row.pointsEach || 0;
  const xp = row.xpEach != null ? row.xpEach : 0;
  const bits = [];
  if (points) bits.push(`**${points}** quota point${points === 1 ? '' : 's'}`);
  if (xp) bits.push(`**${xp}** XP`);
  if (!bits.length) return null;
  const each = kind === 'EVENT' ? ' each, to everybody named' : '';
  const value = bits.join(' and ') + each;

  if (row.voidedAt) return { label: 'Taken back', value };
  if (row.status === 'APPROVED') return { label: 'Paid', value };
  if (row.status === 'DENIED')   return { label: 'Would have been worth', value };
  return { label: 'Worth on approval', value };
}

// ── The embeds ────────────────────────────────────────────────────

function patrolEmbed(row) {
  const fields = [];
  fields.push({ name: `${e('met_user')}  Officer`, value: cap(person({
    discordId: row.officerDiscordId, name: row.officerName })), inline: true });
  fields.push({ name: `${e('met_hourglass')}  On duty for`, value: humanMinutes(row.totalMinutes), inline: true });
  // One line, with the end as a time only: Discord renders "2 August 2026 19:00
  // → 21:30", which is how somebody would say it. Two full timestamps stacked
  // repeats the date at the reader for no reason.
  fields.push({ name: `${e('met_clock')}  Shift`,
    value: `${ts(row.startedAt)} → ${ts(row.endedAt, 't')}`, inline: false });
  if (row.area) fields.push({ name: `${e('met_search')}  Area`, value: cap(row.area, 200), inline: true });

  const partners = roll(row.partners);
  if (partners) {
    fields.push({ name: `${e('met_users')}  Out with`, value: partners, inline: false });
  }
  if (row.notes) fields.push({ name: `${e('met_note')}  Notes`, value: cap(row.notes), inline: false });

  const worth = worthLine(row, 'PATROL');
  if (worth) fields.push({ name: `${e('met_xp')}  ${worth.label}`, value: worth.value, inline: false });

  return {
    color: COLOUR[row.voidedAt ? 'VOIDED' : row.status] || COLOUR.PENDING,
    title: `${e('met_patrol')}  Patrol Log · ${row.patrolRef}`,
    description: statusLine(row),
    fields,
    footer: { text: 'Filed on the site · decided on the site, not by reacting here' },
    timestamp: new Date(row.createdAt || Date.now()).toISOString(),
  };
}

function eventEmbed(row) {
  const fields = [];
  fields.push({ name: `${e('met_star')}  Type`, value: cap(row.eventType || '—', 200), inline: true });
  fields.push({ name: `${e('met_user')}  Host`, value: cap(person({
    discordId: row.hostDiscordId, name: row.hostName })), inline: true });
  if (row.coHostName) {
    fields.push({ name: `${e('met_user')}  Co-host`, value: cap(row.coHostName, 200), inline: true });
  }
  fields.push({ name: `${e('met_calendar')}  Started`, value: ts(row.startedAt), inline: true });
  if (row.durationMins) {
    fields.push({ name: `${e('met_hourglass')}  Ran for`, value: humanMinutes(row.durationMins), inline: true });
  }

  const attendees = Array.isArray(row.attendees) ? row.attendees : [];
  fields.push({
    name: `${e('met_users')}  Attendees · ${row.attendeeCount != null ? row.attendeeCount : attendees.length}`,
    value: roll(attendees) || '*none listed*',
    inline: false,
  });
  if (row.notes) fields.push({ name: `${e('met_note')}  Notes`, value: cap(row.notes), inline: false });

  const worth = worthLine(row, 'EVENT');
  if (worth) fields.push({ name: `${e('met_xp')}  ${worth.label}`, value: worth.value, inline: false });

  return {
    color: COLOUR[row.voidedAt ? 'VOIDED' : row.status] || COLOUR.PENDING,
    title: `${e('met_event')}  Event Log · ${row.eventRef}`,
    description: statusLine(row),
    fields,
    footer: { text: 'Filed on the site · decided on the site, not by reacting here' },
    timestamp: new Date(row.createdAt || Date.now()).toISOString(),
  };
}

/**
 * The embed for a row. Exported so a test can read it without a Discord
 * connection, which is the only way to assert what the channel actually shows.
 */
function buildEmbed(kind, row) {
  const embed = kind === 'EVENT' ? eventEmbed(row) : patrolEmbed(row);
  // Proof, when it is a link we can render. Uploaded screenshots are data URLs
  // held on the site — Discord cannot fetch those, and inlining megabytes of
  // base64 into an embed is not a thing, so the count is stated instead and the
  // images stay where the reviewer looks at them.
  const proof = (Array.isArray(row.proof) ? row.proof : []).filter(Boolean);
  const linked = proof.filter(p => /^https?:\/\//i.test(String(p)));
  if (linked.length) embed.image = { url: String(linked[0]).slice(0, 500) };
  if (proof.length) {
    embed.fields.push({
      name: `${e('met_camera')}  Proof`,
      value: linked.length === proof.length && proof.length === 1
        ? `[Screenshot](${linked[0]})`
        : `**${proof.length}** attached — open the log on the site to see ${proof.length === 1 ? 'it' : 'them'}.`,
      inline: false,
    });
  }
  return embed;
}

// ── Talking to Discord ────────────────────────────────────────────

function client() {
  try { return require('./bot').getClient(); } catch (e) { return null; }
}

function why(err) {
  const code = err && err.code;
  if (code === 10003) return 'that channel does not exist, or the bot cannot see it';
  if (code === 10008) return 'the message is gone';
  if (code === 50013) return 'the bot lacks permission there';
  if (code === 50001) return 'the bot has no access to that channel';
  return (err && err.message) || 'unknown error';
}

async function fetchChannel(kind) {
  const c = client();
  if (!c) return { channel: null, why: 'the bot is not connected' };
  const id = channelFor(kind);
  if (!id) return { channel: null, why: 'no channel is configured' };
  try {
    const channel = await c.channels.fetch(id);
    if (!channel || typeof channel.send !== 'function') {
      return { channel: null, why: 'that channel cannot be posted in' };
    }
    return { channel, why: null };
  } catch (err) {
    return { channel: null, why: why(err) };
  }
}

/**
 * Post the first mirror of a log.
 *
 * @returns {Promise<{ channelId: string, messageId: string } | null>}
 *          null when it could not be posted, which is not an error the caller
 *          needs to handle — the log stands on its own.
 */
async function post(kind, row) {
  if (!enabled()) return null;
  const ref = row.patrolRef || row.eventRef || row.id;
  const { channel, why: problem } = await fetchChannel(kind);
  if (!channel) {
    console.warn(`[LogMirror] ${ref} not mirrored — ${problem}`);
    return null;
  }
  try {
    const msg = await channel.send({ embeds: [buildEmbed(kind, row)], allowedMentions: { parse: [] } });
    return { channelId: String(channel.id), messageId: String(msg.id) };
  } catch (err) {
    console.warn(`[LogMirror] ${ref} not mirrored — ${why(err)}`);
    return null;
  }
}

/**
 * Bring an existing mirror up to date with the row.
 *
 * Called after every decision, and after a withdrawal. If the mirror was never
 * posted (the bot was down when the log was filed) this posts it now, so the
 * channel catches up rather than skipping the log entirely. If it was posted
 * and then deleted, it is reposted once.
 *
 * @returns {Promise<{ channelId, messageId, reposted?: boolean } | null>}
 *          non-null when the ids should be written back to the row.
 */
async function refresh(kind, row) {
  if (!enabled()) return null;
  const ref = row.patrolRef || row.eventRef || row.id;
  if (!row.mirrorMessageId) return post(kind, row);

  const c = client();
  if (!c) { console.warn(`[LogMirror] ${ref} not updated — the bot is not connected`); return null; }
  try {
    const channel = await c.channels.fetch(String(row.mirrorChannelId || channelFor(kind)));
    const msg = await channel.messages.fetch(String(row.mirrorMessageId));
    await msg.edit({ embeds: [buildEmbed(kind, row)], allowedMentions: { parse: [] } });
    return null;   // nothing changed about where it lives
  } catch (err) {
    // A mirror somebody deleted is reposted, once. Anything else is reported and
    // left alone — reposting on a permission error would spam the channel the
    // moment permission came back.
    if (err && (err.code === 10008 || err.code === 10003)) {
      console.warn(`[LogMirror] ${ref} — ${why(err)}, posting a fresh mirror`);
      const out = await post(kind, row);
      return out ? { ...out, reposted: true } : null;
    }
    console.warn(`[LogMirror] ${ref} not updated — ${why(err)}`);
    return null;
  }
}

/**
 * Post or update the mirror, and write back where it lives.
 *
 * This is the whole integration: the same call after filing, after a decision
 * and after a withdrawal. It never throws, because a mirror is a copy and
 * losing the copy must not lose the log or the decision that was just recorded.
 *
 * @param {'PATROL'|'EVENT'} kind
 * @param {object} row  an IaPatrolLog or IaEventLog row
 * @returns {Promise<object>} the row — updated with the mirror's ids when they
 *          changed, and unchanged otherwise, so the caller can always use what
 *          comes back.
 */
async function attach(kind, row) {
  if (!row) return row;
  const prisma = require('./db');
  const table = kind === 'EVENT' ? prisma.iaEventLog : prisma.iaPatrolLog;
  try {
    const at = row.mirrorMessageId ? await refresh(kind, row) : await post(kind, row);
    if (!at) return row;
    return await table.update({
      where: { id: row.id },
      data:  { mirrorChannelId: at.channelId, mirrorMessageId: at.messageId },
    });
  } catch (err) {
    console.warn(`[LogMirror] could not record the mirror for `
      + `${row.patrolRef || row.eventRef || row.id}: ${err.message}`);
    return row;
  }
}

module.exports = {
  channelFor, enabled, buildEmbed, post, refresh, attach,
  // exported for the tests, and because they are genuinely reusable
  humanMinutes, roll, person, statusLine, worthLine, COLOUR,
};
