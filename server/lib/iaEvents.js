// server/lib/iaEvents.js
// Internal Affairs events, logged on the site by whoever hosted them.
//
// The FLP side of the house logs events in Discord and a bot reads them back.
// IA does not — there is no channel to mirror — so this is a form on the
// dashboard.
//
// Filing one is NOT the award. A Senior Investigator and above may file; a
// supervisor and above signs it off, and only then is anybody paid. Filing used
// to pay immediately, which meant the person who ran the event decided what it
// was worth and how many people attended it.
//
// Being on a signed-off event is worth two things, and everybody named gets
// both — the host included, because hosting is work:
//   · 2 quota points on the IA database — what the weekly IA quota is counted in
//   · 2 XP on MET — the same currency /xp moves and promotions are driven by
// They are separate systems with separate failure modes, so they are awarded
// separately and recorded separately. One of them being unavailable does not
// cost somebody the other.
//
// Two things hold throughout:
//
//   Nobody is paid twice. Quota awards go through the same durable QuotaAward
//   outbox the rest of the site uses, keyed on `${eventId}:${person}` — so a
//   retry, a double-click, the same person listed twice, or a host who also put
//   themselves on the attendee list all resolve to one award. XP has no outbox,
//   so the row carries a receipt and the approval refuses to run twice.
//
//   Nobody is paid for nothing. An empty log is refused, and everybody paid is
//   recorded with what they got — so an event that turns out to be fabricated
//   can be read back and reversed by name.

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
  if (!attendees || !attendees.length) problems.push('Add at least one attendee · the roll is what gets paid.');
  if (durationMins != null && (!Number.isFinite(durationMins) || durationMins < 0 || durationMins > 1440)) {
    problems.push('The duration has to be between 0 and 1440 minutes.');
  }
  return problems;
}

// Proof of the event. Screenshots are uploaded rather than linked — an image
// hosted somewhere else stops being evidence the day that host expires, and
// asking somebody to go and upload it elsewhere first is how proof ends up not
// being attached at all. They arrive as data URLs in the body, the same way
// ticket-log proof already does.
//
// A link is still accepted, because sometimes the evidence IS a link.
const MAX_PROOF       = 10;
const MAX_PROOF_BYTES = 6 * 1024 * 1024;   // per image, before base64 inflation
const DATA_IMAGE      = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i;

function normaliseProof(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of list) {
    const v = String(item == null ? '' : item).trim();
    if (!v) continue;
    if (DATA_IMAGE.test(v)) {
      // base64 is 4 characters per 3 bytes, so the decoded size is 3/4 of the
      // payload. Checking the decoded size means the cap means what it says.
      const b64 = v.slice(v.indexOf(',') + 1).replace(/\s/g, '');
      if ((b64.length * 3) / 4 > MAX_PROOF_BYTES) continue;
      out.push(v);
    } else if (/^https?:\/\//i.test(v)) {
      out.push(v.slice(0, 500));
    }
    if (out.length >= MAX_PROOF) break;
  }
  return out;
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
  const coHostName   = clean(input.coHostName, 80) || null;
  const notes        = clean(input.notes, 2000) || null;
  const startedAt    = input.startedAt ? new Date(input.startedAt) : null;
  const durationMins = input.durationMins == null || input.durationMins === ''
    ? null : parseInt(input.durationMins, 10);

  const { attendees, dropped } = normaliseAttendees(input.attendees);

  // The host is paid for hosting, so they do not ALSO need to be on the
  // attendee list — being there twice is one payment either way, but leaving
  // them on it makes the headcount read wrong.
  const hostKey = host.discordId ? 'd:' + host.discordId : null;
  const roll = attendees.filter(a => !hostKey || a.key !== hostKey);
  const selfRemoved = attendees.length - roll.length;

  const problems = problemsWith({ eventType, startedAt, attendees: roll, durationMins });
  if (selfRemoved && !roll.length) {
    // They are paid for hosting either way, so this is not about the money —
    // an event with nobody at it is not an event.
    problems.push('You were the only name on the log · an event needs somebody to attend it.');
  }
  if (problems.length) return { ok: false, problems };

  const proof = normaliseProof(input.proof);

  const pointsEach = POINTS_EACH();
  const xpEach     = XP_EACH();

  let event = null;
  for (let attempt = 0; !event && attempt < 10; attempt++) {
    try {
      event = await prisma.iaEventLog.create({
        data: {
          eventRef:      await nextEventRef(attempt),
          eventType,
          title:         clean(input.title, 160) || null,
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
          status:        'PENDING',
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

  console.log(`[IA events] ${event.eventRef} filed by ${event.hostName || host.id} · `
    + `${roll.length} attendee(s), awaiting review`
    + (dropped ? `, ${dropped} duplicate/blank name(s) dropped` : '')
    + (selfRemoved ? ', host taken off their own attendee list' : ''));

  // Mirrored into the event log channel as PENDING. The same message is edited
  // when a supervisor decides, so the channel carries one message per event
  // whose current state is the truth.
  event = await require('./logMirror').attach('EVENT', event);

  return { ok: true, event, dropped, selfRemoved, pointsEach, xpEach };
}

/**
 * Everybody an approved event pays: the host, then the attendees.
 *
 * The host first, so if the same person somehow appears twice the payment is
 * attributed to hosting — which is the more specific fact about them.
 *
 * @returns {Array<{ key, discordId, name, host: boolean }>}
 */
function payeesOf(event) {
  const out = [];
  const seen = new Set();
  const push = (discordId, name, isHost) => {
    const key = discordId ? 'd:' + discordId : 'n:' + String(name || '').toLowerCase();
    if (key === 'n:' || seen.has(key)) return;
    seen.add(key);
    out.push({ key, discordId: discordId || null, name: name || null, host: !!isHost });
  };
  push(event.hostDiscordId, event.hostName, true);
  for (const a of (Array.isArray(event.attendees) ? event.attendees : [])) {
    if (a) push(a.discordId, a.name, false);
  }
  return out;
}

/**
 * Sign an event off — or refuse it.
 *
 * Approving is what pays. Denying records the decision and pays nobody, so a
 * fabricated or mistaken log costs nothing to refuse.
 *
 * @param {string} id
 * @param {'approve'|'deny'} action
 * @param {object} reviewer   the signed-in supervisor
 * @param {string} [note]
 */
async function reviewEvent(id, action, reviewer, note) {
  const act = String(action || '').toLowerCase();
  if (!['approve', 'deny'].includes(act)) return { ok: false, why: 'That is not a decision.' };

  const event = await prisma.iaEventLog.findUnique({ where: { id } });
  if (!event) return { ok: false, why: 'That event no longer exists.' };
  if (event.status !== 'PENDING') {
    return { ok: false, why: `That event has already been ${String(event.status).toLowerCase()}.` };
  }
  // The host does not sign off their own event.
  if (reviewer && event.hostId && String(event.hostId) === String(reviewer.id)) {
    return { ok: false, why: 'You cannot review your own event.' };
  }

  // Claim it first. Two supervisors pressing at once must not both pay the
  // roll — the second is told it was already decided.
  const claim = await prisma.iaEventLog.updateMany({
    where: { id, status: 'PENDING' },
    data: {
      status:         act === 'approve' ? 'APPROVED' : 'DENIED',
      reviewedById:   reviewer ? reviewer.id : null,
      reviewedByName: reviewer ? (reviewer.displayName || reviewer.discordUsername || null) : null,
      reviewedAt:     new Date(),
      reviewNote:     note ? clean(note, 500) : null,
    },
  });
  if (!claim.count) return { ok: false, why: 'Somebody decided that one first.' };

  if (act === 'deny') {
    console.log(`[IA events] ${event.eventRef} denied by ${(reviewer && reviewer.displayName) || 'a supervisor'} · nobody paid`);
    const denied = await prisma.iaEventLog.findUnique({ where: { id } });
    // The Discord mirror is edited in place, so the pending embed in the channel
    // becomes the denial rather than sitting there contradicting the site.
    return { ok: true, event: await require('./logMirror').attach('EVENT', denied),
             awarded: 0, xpAwarded: 0 };
  }

  // The claimed row, not the one read before the claim — payEvent stamps the XP
  // receipt onto it and mirrors it, and both need the recorded decision.
  return payEvent(await prisma.iaEventLog.findUnique({ where: { id } }), reviewer);
}

/**
 * Pay a signed-off event, on both systems.
 *
 * The quota points go through the durable outbox, keyed per person, so a retry
 * cannot double-award and a Google Sheets outage delays them rather than losing
 * them. The XP is applied straight to the balance — that is a row in our own
 * database, not a third party's spreadsheet, and there is nothing to queue
 * behind — so the row keeps a receipt of what actually landed.
 */
async function payEvent(event, reviewer) {
  const { enqueueQuotaAward } = require('./quota');
  const { awardXpTo } = require('./logXpAward');

  const pointsEach = event.pointsEach || POINTS_EACH();
  const xpEach     = event.xpEach != null ? event.xpEach : XP_EACH();
  const payees     = payeesOf(event);
  const actor = {
    id: reviewer ? reviewer.id : null,
    name: (reviewer && (reviewer.displayName || reviewer.discordUsername)) || 'IA event log',
  };

  let awarded = 0, xpAwarded = 0, xpSkipped = 0;
  const xpRecord = [];

  for (const p of payees) {
    const why = p.host ? 'hosted' : 'attended';
    try {
      await enqueueQuotaAward({
        refType:        'ia_event',
        refId:          `${event.id}:${p.key}`,
        discordId:      p.discordId,
        robloxUsername: p.discordId ? null : p.name,
        points:         pointsEach,
        label:          `${event.eventRef} ${event.eventType}`,
        division:       'IA',
      });
      awarded++;
    } catch (e) {
      // One person failing to queue must not lose the rest — the row records
      // who was on the log either way, so it can be paid by hand.
      console.error(`[IA events] could not queue ${p.key} for ${event.eventRef}:`, e.message);
    }

    // XP is held against a Discord id. Somebody named without one has no
    // balance to move, so they get their quota points and are recorded as owed
    // the XP rather than silently missing it.
    if (!xpEach) continue;
    if (!p.discordId) {
      xpSkipped++;
      xpRecord.push({ name: p.name, xp: 0, ok: false, host: p.host, why: 'no Discord id' });
      continue;
    }
    const res = await awardXpTo({
      discordId: p.discordId, name: p.name, amount: xpEach,
      reason: `${p.host ? 'Hosted' : 'Attended'} ${event.eventType} · ${event.eventRef}`,
      actor,
    });
    if (res.ok) xpAwarded++;
    xpRecord.push({ discordId: p.discordId, name: p.name, xp: xpEach, host: p.host,
                    ok: !!res.ok, after: res.after, promoted: !!res.promoted,
                    why: res.error || undefined });
  }

  let updated = event;
  try {
    updated = await prisma.iaEventLog.update({
      where: { id: event.id },
      data:  { xpAward: { at: new Date().toISOString(), each: xpEach, people: xpRecord } },
    });
  } catch (e) {
    console.error(`[IA events] could not record the XP on ${event.eventRef}:`, e.message);
    updated = await prisma.iaEventLog.findUnique({ where: { id: event.id } });
  }

  console.log(`[IA events] ${event.eventRef} approved by ${actor.name} · `
    + `${payees.length} paid ${pointsEach} point(s) + ${xpEach} XP (host included)`
    + (xpSkipped ? `, ${xpSkipped} with no Discord id got no XP` : ''));

  updated = await require('./logMirror').attach('EVENT', updated);

  return { ok: true, event: updated, awarded, xpAwarded, xpSkipped, pointsEach, xpEach, paid: payees.length };
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
  // Nothing was paid for a pending or denied event, so there is nothing to
  // reverse — refusing it is what a supervisor does instead.
  if (event.status !== 'APPROVED') {
    return { ok: false, why: 'Only an approved event can be withdrawn. Deny it instead.' };
  }

  // Everybody who was PAID, which is the host as well as the attendees — the
  // same list the approval paid, so nothing is left holding points from an
  // event that has been withdrawn.
  let reversed = 0;
  for (const a of payeesOf(event)) {
    const key = a.key;
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
  console.log(`[IA events] ${event.eventRef} withdrawn by ${actor.name} · `
    + `${reversed} points award(s) reversed, ${xpReversed} XP award(s) taken back`);
  return { ok: true, event: await require('./logMirror').attach('EVENT', updated),
           reversed, xpReversed };
}

/**
 * Events, newest first.
 *   mine    limits to the ones you hosted
 *   status  'PENDING' | 'APPROVED' | 'DENIED' — the review queue asks for one
 *
 * The queue is oldest-first: a supervisor works through what has been waiting
 * longest, not what was filed most recently.
 */
async function listEvents({ mine, hostId, status, take = 100 } = {}) {
  const where = {};
  if (mine && hostId) where.hostId = hostId;
  if (status) where.status = String(status).toUpperCase();
  return prisma.iaEventLog.findMany({
    where,
    orderBy: status === 'PENDING' ? { createdAt: 'asc' } : { startedAt: 'desc' },
    take:    Math.min(Math.max(parseInt(take, 10) || 100, 1), 300),
  });
}

/** How many are waiting on a decision — for the nav badge. */
async function pendingCount() {
  return prisma.iaEventLog.count({ where: { status: 'PENDING' } });
}

module.exports = {
  EVENT_TYPES, MAX_ATTENDEES, POINTS_EACH, XP_EACH,
  MAX_PROOF, MAX_PROOF_BYTES, normaliseProof,
  normaliseAttendees, problemsWith, nextEventRef,
  submitEvent, reviewEvent, payEvent, payeesOf, voidEvent, listEvents, pendingCount,
};
