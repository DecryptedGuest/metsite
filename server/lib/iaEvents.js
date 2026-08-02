// server/lib/iaEvents.js
// Internal Affairs events, logged on the site by whoever hosted them.
//
// The FLP side of the house logs events in Discord and a bot reads them back.
// IA does not — there is no channel to mirror — so this is a form on the
// dashboard, and filing it IS the award: every attendee is paid the moment it
// is submitted, with no approval step in between.
//
// Attending an IA event is worth two things, and an attendee gets both:
//   · 2 quota points on the IA database — what the weekly IA quota is counted in
//   · 2 XP on MET — the same currency /xp moves and promotions are driven by
// They are separate systems with separate failure modes, so they are awarded
// separately and recorded separately. One of them being unavailable does not
// cost somebody the other.
//
// Which means two things matter more here than they would behind a review:
//
//   Nobody is paid twice. Awards go through the same durable QuotaAward outbox
//   the rest of the site uses, keyed on `${eventId}:${attendee}` — so a retry, a
//   double-click, or the same person listed twice on the roll all resolve to one
//   award. The queue survives a restart; a Google Sheets outage delays the
//   points, it does not lose them.
//
//   Nobody is paid for nothing. The host cannot pay themselves by attending
//   their own event, an empty roll is refused, and every attendee is recorded
//   with what they were actually paid — so an event that turns out to be
//   fabricated can be read back and reversed by name.

const prisma = require('./db');

// What an attendee is worth, on each of the two systems. One number each, so
// changing either is one edit.
const POINTS_EACH = () => {
  const n = parseInt(process.env.IA_EVENT_POINTS, 10);
  return Number.isFinite(n) && n > 0 ? n : 2;
};
const XP_EACH = () => {
  const n = parseInt(process.env.IA_EVENT_XP, 10);
  return Number.isFinite(n) && n >= 0 ? n : 2;
};

// The kinds of event IA actually runs. Free text is not accepted — a roll of
// twenty people being paid needs to say what they were paid for, and "misc"
// tells a reviewer nothing.
const EVENT_TYPES = [
  'Mass Patrol',
  'Combat Training',
];

const MAX_ATTENDEES = 60;

function clean(v, max = 200) {
  return String(v == null ? '' : v).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max);
}

/**
 * The next event reference, from the HIGHEST in use rather than a row count —
 * counting breaks permanently the first time a row is deleted, because every
 * retry then recomputes the same taken number. `attempt` walks forward so a
 * genuine race resolves on the next try.
 */
async function nextEventRef(attempt = 0) {
  const latest = await prisma.iaEventLog.findFirst({
    where:   { eventRef: { startsWith: 'EVT-' } },
    orderBy: { eventRef: 'desc' },
    select:  { eventRef: true },
  });
  const highest = latest ? parseInt(String(latest.eventRef).replace(/\D/g, ''), 10) : 0;
  const next = (Number.isFinite(highest) ? highest : 0) + 1 + attempt;
  return `EVT-${String(next).padStart(4, '0')}`;
}

/**
 * Normalise the roll.
 *
 * An attendee can be given as a Discord id, a mention, a username, or a
 * "RANK | RobloxUser" nickname pasted straight out of Discord — people paste
 * whatever is in front of them. Each becomes { discordId, name, key }, where
 * `key` is what the award is keyed on so the same person listed twice is paid
 * once.
 *
 * @param {Array<string|object>} raw
 * @returns {{ attendees: Array<{discordId: string|null, name: string, key: string}>, dropped: number }}
 */
function normaliseAttendees(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  let dropped = 0;

  for (const item of list) {
    let discordId = null;
    let name = '';

    if (item && typeof item === 'object') {
      discordId = clean(item.discordId, 25) || null;
      name = clean(item.name || item.username || '', 80);
    } else {
      name = clean(item, 80);
    }

    // "<@123>" / "<@!123>" / a bare snowflake.
    const mention = /^<@!?(\d{15,21})>$/.exec(name);
    if (mention) { discordId = discordId || mention[1]; name = ''; }
    else if (/^\d{15,21}$/.test(name)) { discordId = discordId || name; name = ''; }

    if (discordId && !/^\d{15,21}$/.test(discordId)) discordId = null;

    // "CSUP | someone" — the half after the bar is the name people know.
    if (name.includes('|')) {
      const tail = name.split('|').pop().trim();
      if (tail) name = tail;
    }
    name = name.replace(/^@/, '').trim();

    if (!discordId && !name) { dropped++; continue; }

    // One award per person. A Discord id identifies somebody exactly; a bare
    // name only identifies them as well as it is spelled, so it is folded to
    // lower case before being compared.
    const key = discordId ? 'd:' + discordId : 'n:' + name.toLowerCase();
    if (seen.has(key)) { dropped++; continue; }
    seen.add(key);

    out.push({ discordId, name: name || null, key });
    if (out.length >= MAX_ATTENDEES) break;
  }

  return { attendees: out, dropped };
}

/**
 * Everything wrong with a submission, in the order somebody would fix it.
 * Returns [] when it is fine.
 */
function problemsWith({ eventType, startedAt, attendees, durationMins }) {
  const problems = [];
  if (!EVENT_TYPES.includes(eventType)) problems.push('Pick what kind of event this was.');
  if (!startedAt || isNaN(new Date(startedAt).getTime())) problems.push('Say when the event started.');
  else {
    const t = new Date(startedAt).getTime();
    // An hour of slack for clock skew; beyond that a future event has not
    // happened yet and nobody can have attended it.
    if (t > Date.now() + 3600 * 1000) problems.push('That start time is in the future.');
    if (t < Date.now() - 90 * 86400 * 1000) problems.push('That start time is more than 90 days ago.');
  }
  if (!attendees || !attendees.length) problems.push('Add at least one attendee — the roll is what gets paid.');
  if (durationMins != null && (!Number.isFinite(durationMins) || durationMins < 0 || durationMins > 1440)) {
    problems.push('The duration has to be between 0 and 1440 minutes.');
  }
  return problems;
}

/**
 * File an event and pay the roll.
 *
 * @param {object} input
 * @param {object} host  the signed-in user row (id, discordId, displayName…)
 * @returns {Promise<{ ok: boolean, problems?: string[], event?: object, awarded?: number, dropped?: number }>}
 */
async function submitEvent(input, host) {
  const eventType    = clean(input.eventType, 60);
  const title        = clean(input.title, 160) || null;
  const coHostName   = clean(input.coHostName, 80) || null;
  const notes        = clean(input.notes, 2000) || null;
  const startedAt    = input.startedAt ? new Date(input.startedAt) : null;
  const durationMins = input.durationMins == null || input.durationMins === ''
    ? null : parseInt(input.durationMins, 10);

  const { attendees, dropped } = normaliseAttendees(input.attendees);

  // The host does not pay themselves for turning up to their own event.
  const hostKey = host.discordId ? 'd:' + host.discordId : null;
  const roll = attendees.filter(a => !hostKey || a.key !== hostKey);
  const selfRemoved = attendees.length - roll.length;

  const problems = problemsWith({ eventType, startedAt, attendees: roll, durationMins });
  if (selfRemoved && !roll.length) {
    problems.push('You were the only name on the roll — a host is not paid for hosting.');
  }
  if (problems.length) return { ok: false, problems };

  const proof = Array.isArray(input.proof)
    ? input.proof.map(u => clean(u, 500)).filter(u => /^https?:\/\//i.test(u)).slice(0, 20)
    : [];

  const pointsEach = POINTS_EACH();
  const xpEach     = XP_EACH();

  let event = null;
  for (let attempt = 0; !event && attempt < 10; attempt++) {
    try {
      event = await prisma.iaEventLog.create({
        data: {
          eventRef:      await nextEventRef(attempt),
          eventType, title,
          hostId:        host.id,
          hostDiscordId: host.discordId || null,
          hostName:      host.displayName || host.discordUsername || null,
          coHostName,
          startedAt,
          durationMins:  Number.isFinite(durationMins) ? durationMins : null,
          attendees:     roll.map(a => ({ discordId: a.discordId, name: a.name, points: pointsEach, xp: xpEach })),
          attendeeCount: roll.length,
          pointsEach,
          xpEach,
          notes,
          proof:         proof.length ? proof : undefined,
        },
      });
    } catch (e) {
      if (e && e.code === 'P2002') continue;   // ref taken — step to the next
      throw e;
    }
  }
  if (!event) return { ok: false, problems: ['Could not allocate an event reference.'] };

  // Pay the roll, on both systems.
  //
  // The quota points go through the durable outbox, keyed per attendee, so a
  // retry cannot double-award and a Google Sheets outage delays them rather
  // than losing them. The XP is applied straight to the balance — that is a row
  // in our own database, not a third party's spreadsheet, and there is nothing
  // to queue behind.
  const { enqueueQuotaAward } = require('./quota');
  const { awardXpTo } = require('./logXpAward');
  const actor = { id: host.id, name: host.displayName || host.discordUsername || 'IA event log' };

  let awarded = 0, xpAwarded = 0, xpSkipped = 0;
  const xpRecord = [];

  for (const a of roll) {
    try {
      await enqueueQuotaAward({
        refType:        'ia_event',
        refId:          `${event.id}:${a.key}`,
        discordId:      a.discordId,
        robloxUsername: a.discordId ? null : a.name,
        points:         pointsEach,
        label:          `${event.eventRef} ${eventType}`,
        division:       'IA',
      });
      awarded++;
    } catch (e) {
      // One attendee failing to queue must not lose the rest — the row records
      // who was on the roll either way, so it can be paid by hand.
      console.error(`[IA events] could not queue ${a.key} for ${event.eventRef}:`, e.message);
    }

    // XP is held against a Discord id. Somebody on the roll by name alone has
    // no balance to move, so they get their quota points and are recorded as
    // owed the XP rather than silently missing it.
    if (!xpEach) continue;
    if (!a.discordId) {
      xpSkipped++;
      xpRecord.push({ name: a.name, xp: 0, ok: false, why: 'no Discord id' });
      continue;
    }
    const res = await awardXpTo({
      discordId: a.discordId, name: a.name, amount: xpEach,
      reason: `Attended ${eventType} · ${event.eventRef}`,
      actor,
    });
    if (res.ok) xpAwarded++;
    xpRecord.push({ discordId: a.discordId, name: a.name, xp: xpEach,
                    ok: !!res.ok, after: res.after, promoted: !!res.promoted,
                    why: res.error || undefined });
  }

  // What was actually paid, on the row. The award rows are the record for the
  // quota side; XP has no outbox, so this is its receipt — and it is what makes
  // a withdrawal able to take back exactly what was given.
  if (xpRecord.length) {
    try {
      event = await prisma.iaEventLog.update({
        where: { id: event.id },
        data:  { xpAward: { at: new Date().toISOString(), each: xpEach, people: xpRecord } },
      });
    } catch (e) {
      console.error(`[IA events] could not record the XP on ${event.eventRef}:`, e.message);
    }
  }

  console.log(`[IA events] ${event.eventRef} filed by ${event.hostName || host.id} — `
    + `${roll.length} attendee(s) × ${pointsEach} point(s) + ${xpEach} XP`
    + (xpSkipped ? `, ${xpSkipped} with no Discord id got no XP` : '')
    + (dropped ? `, ${dropped} duplicate/blank name(s) dropped` : '')
    + (selfRemoved ? ', host removed from their own roll' : ''));

  return { ok: true, event, awarded, xpAwarded, xpSkipped, xpEach, dropped, selfRemoved };
}

/**
 * Withdraw an event. The points already queued are NOT silently unwound — the
 * award rows are the record of what was paid, so this reverses them explicitly
 * and says so, rather than deleting the evidence that it happened.
 */
async function voidEvent(id, by, reason) {
  const event = await prisma.iaEventLog.findUnique({ where: { id } });
  if (!event) return { ok: false, why: 'That event no longer exists.' };
  if (event.voidedAt) return { ok: false, why: 'That event has already been withdrawn.' };

  const attendees = Array.isArray(event.attendees) ? event.attendees : [];
  let reversed = 0;
  for (const a of attendees) {
    const key = a.discordId ? 'd:' + a.discordId : 'n:' + String(a.name || '').toLowerCase();
    try {
      // A points award that has not been written yet can simply be cancelled.
      // One already applied is reversed by a negative award, so the sheet ends
      // up right and the history says both things happened.
      const row = await prisma.quotaAward.findUnique({
        where: { refType_refId: { refType: 'ia_event', refId: `${event.id}:${key}` } },
      });
      if (!row) continue;
      if (row.status === 'PENDING') {
        await prisma.quotaAward.update({
          where: { id: row.id },
          data:  { status: 'FAILED', lastError: 'event withdrawn before the points were written' },
        });
        reversed++;
      } else if (row.status === 'DONE') {
        const { enqueueQuotaAward } = require('./quota');
        await enqueueQuotaAward({
          refType: 'ia_event_void', refId: `${event.id}:${key}`,
          discordId: a.discordId, robloxUsername: a.discordId ? null : a.name,
          points: -Math.abs(row.points), label: `${event.eventRef} withdrawn`, division: 'IA',
        });
        reversed++;
      }
    } catch (e) {
      console.error(`[IA events] could not reverse ${key} on ${event.eventRef}:`, e.message);
    }
  }

  // And the XP. It was applied straight to the balance, so it is taken back the
  // same way, off the receipt of what was actually given rather than off what
  // was intended — an attendee whose award failed at the time is not docked for
  // XP they never received.
  const { awardXpTo } = require('./logXpAward');
  const paid = (event.xpAward && Array.isArray(event.xpAward.people)) ? event.xpAward.people : [];
  const actor = { id: by && by.id, name: (by && (by.displayName || by.discordUsername)) || 'IA event withdrawn' };
  let xpReversed = 0;
  for (const p of paid) {
    if (!p || !p.ok || !p.discordId || !p.xp) continue;
    const res = await awardXpTo({
      discordId: p.discordId, name: p.name, amount: -Math.abs(p.xp),
      reason: `${event.eventRef} withdrawn`,
      actor,
    });
    if (res.ok) xpReversed++;
    else console.error(`[IA events] could not take back ${p.xp} XP from ${p.discordId}:`, res.error);
  }

  const updated = await prisma.iaEventLog.update({
    where: { id },
    data: {
      voidedAt: new Date(),
      voidedById: by && by.id ? by.id : null,
      voidedReason: clean(reason, 300) || null,
    },
  });
  console.log(`[IA events] ${event.eventRef} withdrawn by ${actor.name} — `
    + `${reversed} points award(s) reversed, ${xpReversed} XP award(s) taken back`);
  return { ok: true, event: updated, reversed, xpReversed };
}

/** Events, newest first. `mine` limits to the ones you hosted. */
async function listEvents({ mine, hostId, take = 100 } = {}) {
  return prisma.iaEventLog.findMany({
    where:   mine && hostId ? { hostId } : {},
    orderBy: { startedAt: 'desc' },
    take:    Math.min(Math.max(parseInt(take, 10) || 100, 1), 300),
  });
}

module.exports = {
  EVENT_TYPES, MAX_ATTENDEES, POINTS_EACH, XP_EACH,
  normaliseAttendees, problemsWith, nextEventRef,
  submitEvent, voidEvent, listEvents,
};
