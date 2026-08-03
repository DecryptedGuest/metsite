// server/lib/iaPatrols.js
// Internal Affairs patrol logs, filed on the site by the officer who went out.
//
// The shape is the event log's, on purpose: file it, a supervisor signs it off,
// and only then is anything paid. What differs is what a patrol IS.
//
//   The clock decides the XP, not the log. An event is worth a flat amount to
//   everybody named. A patrol is worth one XP per completed block of
//   PATROL_XP_MINUTES — the same rule the Discord patrol logs have always used,
//   read from the same function, so a patrol logged here and a patrol logged
//   there are worth the same thing. Twenty-nine minutes is worth nothing, and
//   that is the rule rather than a rounding accident.
//
//   Only the officer is paid. Partners are recorded because a reviewer wants to
//   see who was out, and paid nothing: on a joint patrol both officers file
//   their own log, so paying partners too would pay each of them twice for the
//   same shift.
//
//   The minutes are computed, never accepted. The form collects a start and an
//   end; this works out the span, midnight included. Taking a typed duration
//   would let a ten-minute patrol be filed as six hours.

const prisma = require('./db');
const mirror = require('./logMirror');

// One quota point figure, so changing it is one edit. The XP comes from the
// patrol rule in logXpAward and has no separate knob here — two places to set
// the same thing is how they end up disagreeing.
const POINTS_EACH = () => {
  const n = parseInt(process.env.IA_PATROL_POINTS, 10);
  return Number.isFinite(n) && n >= 0 ? n : 2;
};

const MAX_PARTNERS = 20;
const MAX_PROOF = 10;

// A patrol has to be long enough to be a patrol. Five minutes of standing in
// the car park is not a shift, and without a floor the XP rule pays nothing for
// it anyway — so the log would be filed, reviewed and paid zero, wasting a
// supervisor's time to say so.
const MIN_MINUTES = () => {
  const n = parseInt(process.env.IA_PATROL_MIN_MINUTES, 10);
  return Number.isFinite(n) && n > 0 ? n : 15;
};
const MAX_MINUTES = 16 * 60;   // a sixteen-hour patrol is a typo, not a shift

function clean(v, max = 200) {
  return String(v == null ? '' : v).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max);
}

/**
 * The next patrol reference, from the HIGHEST in use rather than a row count.
 * Counting breaks permanently the first time a row is deleted, because every
 * retry then recomputes the same taken number.
 */
async function nextPatrolRef(attempt = 0) {
  const latest = await prisma.iaPatrolLog.findFirst({
    where:   { patrolRef: { startsWith: 'PTL-' } },
    orderBy: { patrolRef: 'desc' },
    select:  { patrolRef: true },
  });
  const highest = latest ? parseInt(String(latest.patrolRef).replace(/\D/g, ''), 10) : 0;
  const next = (Number.isFinite(highest) ? highest : 0) + 1 + attempt;
  return `PTL-${String(next).padStart(4, '0')}`;
}

/**
 * The span of a shift in whole minutes.
 *
 * A patrol that ends "before" it started ran past midnight — 22:30 → 01:00 is
 * two and a half hours, not minus twenty-one. That is the normal case for a
 * night shift, so it is handled rather than rejected: a day is added to the end.
 *
 * @returns {{ minutes: number, crossedMidnight: boolean } | null}
 */
function spanOf(startedAt, endedAt) {
  const a = new Date(startedAt).getTime();
  let b = new Date(endedAt).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  let crossedMidnight = false;
  if (b <= a) { b += 86400 * 1000; crossedMidnight = true; }
  const minutes = Math.round((b - a) / 60000);
  return { minutes, crossedMidnight };
}

/**
 * Normalise the partner list to { discordId, name }.
 *
 * The same paste-anything tolerance the attendee picker has: a mention, a bare
 * snowflake, a "RANK | RobloxUser" nickname, or a plain name. Deduplicated,
 * because listing somebody twice does not mean they were there twice.
 */
function normalisePartners(raw, officerDiscordId) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  let dropped = 0, selfRemoved = 0;

  for (const item of list) {
    let discordId = null, name = '';
    if (item && typeof item === 'object') {
      discordId = clean(item.discordId, 25) || null;
      name = clean(item.name || item.username || '', 80);
    } else {
      name = clean(item, 80);
    }

    const mention = /^<@!?(\d{15,21})>$/.exec(name);
    if (mention) { discordId = discordId || mention[1]; name = ''; }
    else if (/^\d{15,21}$/.test(name)) { discordId = discordId || name; name = ''; }
    if (discordId && !/^\d{15,21}$/.test(discordId)) discordId = null;

    if (name.includes('|')) {
      const tail = name.split('|').pop().trim();
      if (tail) name = tail;
    }
    name = name.replace(/^@/, '').trim();
    if (!discordId && !name) { dropped++; continue; }

    const key = discordId ? 'd:' + discordId : 'n:' + name.toLowerCase();
    // The officer is not their own partner. Leaving them on the list makes the
    // headcount read wrong, and it pays nothing either way.
    if (officerDiscordId && key === 'd:' + officerDiscordId) { selfRemoved++; continue; }
    if (seen.has(key)) { dropped++; continue; }
    seen.add(key);

    out.push({ discordId, name: name || null });
    if (out.length >= MAX_PARTNERS) break;
  }
  return { partners: out, dropped, selfRemoved };
}

// Proof arrives the same way it does for events and ticket logs: data URLs for
// uploaded screenshots, or a link when the evidence IS a link.
const MAX_PROOF_BYTES = 6 * 1024 * 1024;
const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i;

function normaliseProof(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of list) {
    const v = String(item == null ? '' : item).trim();
    if (!v) continue;
    if (DATA_IMAGE.test(v)) {
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

/** Everything wrong with a submission, in the order somebody would fix it. */
function problemsWith({ startedAt, endedAt, span }) {
  const problems = [];
  if (!startedAt || isNaN(new Date(startedAt).getTime())) problems.push('Say when the patrol started.');
  if (!endedAt || isNaN(new Date(endedAt).getTime())) problems.push('Say when it ended.');
  if (problems.length) return problems;

  const start = new Date(startedAt).getTime();
  // An hour of slack for clock skew. Beyond that a patrol has not happened yet.
  if (start > Date.now() + 3600 * 1000) problems.push('That start time is in the future.');
  if (start < Date.now() - 90 * 86400 * 1000) problems.push('That start time is more than 90 days ago.');

  if (!span) problems.push('Those times do not make sense together.');
  else {
    if (span.minutes < MIN_MINUTES()) {
      problems.push(`A patrol has to be at least ${MIN_MINUTES()} minutes. That one is ${span.minutes}.`);
    }
    if (span.minutes > MAX_MINUTES) {
      problems.push(`That comes to ${Math.round(span.minutes / 60)} hours, which is longer than a shift. Check the times.`);
    }
  }
  return problems;
}

/**
 * What a patrol of this length is worth in XP, by the standing rule.
 * Read from logXpAward so there is one rule, in one place.
 */
function xpFor(minutes) {
  try { return require('./logXpAward').patrolXpFor(minutes); }
  catch (e) { return 0; }
}

/**
 * File a patrol. Pays nobody — a supervisor signs it off.
 *
 * @param {object} input
 * @param {object} officer  the signed-in user row
 */
async function submitPatrol(input, officer) {
  const startedAt = input.startedAt ? new Date(input.startedAt) : null;
  const endedAt   = input.endedAt ? new Date(input.endedAt) : null;
  const span = startedAt && endedAt && !isNaN(startedAt) && !isNaN(endedAt)
    ? spanOf(startedAt, endedAt) : null;

  const problems = problemsWith({ startedAt, endedAt, span });
  if (problems.length) return { ok: false, problems };

  const { partners, dropped, selfRemoved } =
    normalisePartners(input.partners, officer.discordId || null);
  const proof = normaliseProof(input.proof);

  // The end is stored as the real instant, so a night shift's end is on the next
  // day rather than before its own start.
  const realEnd = span.crossedMidnight
    ? new Date(endedAt.getTime() + 86400 * 1000) : endedAt;

  const pointsEach = POINTS_EACH();
  const xpEach = xpFor(span.minutes);

  let patrol = null;
  for (let attempt = 0; !patrol && attempt < 10; attempt++) {
    try {
      patrol = await prisma.iaPatrolLog.create({
        data: {
          patrolRef:        await nextPatrolRef(attempt),
          officerId:        officer.id,
          officerDiscordId: officer.discordId || null,
          officerName:      officer.displayName || officer.discordUsername || null,
          startedAt,
          endedAt:          realEnd,
          totalMinutes:     span.minutes,
          area:             clean(input.area, 120) || null,
          partners:         partners.length ? partners : undefined,
          partnerCount:     partners.length,
          notes:            clean(input.notes, 2000) || null,
          proof:            proof.length ? proof : undefined,
          pointsEach,
          xpEach,
          status:           'PENDING',
        },
      });
    } catch (e) {
      if (e && e.code === 'P2002') continue;   // ref taken — step to the next
      throw e;
    }
  }
  if (!patrol) return { ok: false, problems: ['Could not allocate a patrol reference.'] };

  console.log(`[IA patrols] ${patrol.patrolRef} filed by ${patrol.officerName || officer.id} — `
    + `${span.minutes} min, worth ${pointsEach} point(s) + ${xpEach} XP on approval`
    + (span.crossedMidnight ? ', ran past midnight' : '')
    + (dropped ? `, ${dropped} duplicate/blank partner(s) dropped` : ''));

  patrol = await mirror.attach('PATROL', patrol);

  return { ok: true, patrol, dropped, selfRemoved,
           crossedMidnight: span.crossedMidnight, pointsEach, xpEach };
}

/**
 * Sign a patrol off, or refuse it.
 *
 * Approving pays the officer their quota points and the XP the clock earned.
 * Denying records the decision and pays nothing.
 */
async function reviewPatrol(id, action, reviewer, note) {
  const act = String(action || '').toLowerCase();
  if (!['approve', 'deny'].includes(act)) return { ok: false, why: 'That is not a decision.' };

  const patrol = await prisma.iaPatrolLog.findUnique({ where: { id } });
  if (!patrol) return { ok: false, why: 'That patrol log no longer exists.' };
  if (patrol.status !== 'PENDING') {
    return { ok: false, why: `That patrol has already been ${String(patrol.status).toLowerCase()}.` };
  }
  // Nobody signs off their own patrol.
  if (reviewer && patrol.officerId && String(patrol.officerId) === String(reviewer.id)) {
    return { ok: false, why: 'You cannot review your own patrol.' };
  }

  // Claim it first, so two supervisors pressing at once cannot both pay it.
  const claim = await prisma.iaPatrolLog.updateMany({
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
    const denied = await prisma.iaPatrolLog.findUnique({ where: { id } });
    console.log(`[IA patrols] ${patrol.patrolRef} denied by ${(reviewer && reviewer.displayName) || 'a supervisor'} — nobody paid`);
    return { ok: true, patrol: await mirror.attach('PATROL', denied), awarded: 0, xpAwarded: 0 };
  }

  return payPatrol(await prisma.iaPatrolLog.findUnique({ where: { id } }), reviewer);
}

/**
 * Pay an approved patrol, on both systems.
 *
 * The quota points go through the durable outbox keyed on the patrol, so a
 * retry cannot double-award. The XP is applied straight to the balance and the
 * row keeps a receipt of what landed, which is what a withdrawal reverses.
 */
async function payPatrol(patrol, reviewer) {
  const { enqueueQuotaAward } = require('./quota');
  const { awardXpTo } = require('./logXpAward');

  const pointsEach = patrol.pointsEach || POINTS_EACH();
  const xpEach = patrol.xpEach != null ? patrol.xpEach : xpFor(patrol.totalMinutes);
  const actor = {
    id: reviewer ? reviewer.id : null,
    name: (reviewer && (reviewer.displayName || reviewer.discordUsername)) || 'IA patrol log',
  };

  let awarded = 0, xpAwarded = 0;
  const xpRecord = [];

  if (pointsEach) {
    try {
      await enqueueQuotaAward({
        refType:        'ia_patrol',
        refId:          patrol.id,
        discordId:      patrol.officerDiscordId,
        robloxUsername: patrol.officerDiscordId ? null : patrol.officerName,
        points:         pointsEach,
        label:          `${patrol.patrolRef} patrol · ${patrol.totalMinutes} min`,
        division:       'IA',
      });
      awarded++;
    } catch (e) {
      // The row records who filed it either way, so this can be paid by hand.
      console.error(`[IA patrols] could not queue points for ${patrol.patrolRef}:`, e.message);
    }
  }

  // XP is held against a Discord id. Somebody without one gets their quota
  // points and is recorded as owed the XP rather than silently missing it.
  if (xpEach && patrol.officerDiscordId) {
    const res = await awardXpTo({
      discordId: patrol.officerDiscordId, name: patrol.officerName, amount: xpEach,
      reason: `Patrol · ${patrol.totalMinutes} min · ${patrol.patrolRef}`,
      actor,
    });
    if (res.ok) xpAwarded++;
    xpRecord.push({ discordId: patrol.officerDiscordId, name: patrol.officerName,
                    xp: xpEach, ok: !!res.ok, after: res.after,
                    promoted: !!res.promoted, why: res.error || undefined });
  } else if (xpEach) {
    xpRecord.push({ name: patrol.officerName, xp: 0, ok: false, why: 'no Discord id' });
  }

  let updated = patrol;
  try {
    updated = await prisma.iaPatrolLog.update({
      where: { id: patrol.id },
      data:  { xpAward: { at: new Date().toISOString(), each: xpEach, people: xpRecord } },
    });
  } catch (e) {
    console.error(`[IA patrols] could not record the XP on ${patrol.patrolRef}:`, e.message);
    updated = await prisma.iaPatrolLog.findUnique({ where: { id: patrol.id } });
  }

  console.log(`[IA patrols] ${patrol.patrolRef} approved by ${actor.name} — `
    + `${pointsEach} point(s) + ${xpEach} XP to ${patrol.officerName || patrol.officerId}`);

  updated = await mirror.attach('PATROL', updated);
  return { ok: true, patrol: updated, awarded, xpAwarded, pointsEach, xpEach };
}

/**
 * Withdraw an approved patrol. The award rows are the record of what was paid,
 * so this reverses them explicitly rather than deleting the evidence.
 */
async function voidPatrol(id, by, reason) {
  const patrol = await prisma.iaPatrolLog.findUnique({ where: { id } });
  if (!patrol) return { ok: false, why: 'That patrol log no longer exists.' };
  if (patrol.voidedAt) return { ok: false, why: 'That patrol has already been withdrawn.' };
  if (patrol.status !== 'APPROVED') {
    return { ok: false, why: 'Only an approved patrol can be withdrawn. Deny it instead.' };
  }

  let reversed = 0;
  try {
    const row = await prisma.quotaAward.findUnique({
      where: { refType_refId: { refType: 'ia_patrol', refId: patrol.id } },
    });
    if (row && row.status === 'PENDING') {
      await prisma.quotaAward.update({
        where: { id: row.id },
        data:  { status: 'FAILED', lastError: 'patrol withdrawn before the points were written' },
      });
      reversed++;
    } else if (row && row.status === 'DONE') {
      const { enqueueQuotaAward } = require('./quota');
      await enqueueQuotaAward({
        refType: 'ia_patrol_void', refId: patrol.id,
        discordId: patrol.officerDiscordId,
        robloxUsername: patrol.officerDiscordId ? null : patrol.officerName,
        points: -Math.abs(row.points),
        label: `${patrol.patrolRef} withdrawn`, division: 'IA',
      });
      reversed++;
    }
  } catch (e) {
    console.error(`[IA patrols] could not reverse the points on ${patrol.patrolRef}:`, e.message);
  }

  // The XP comes off the receipt of what was actually given, not off what was
  // intended — an award that failed at the time is not docked twice.
  const { awardXpTo } = require('./logXpAward');
  const paid = (patrol.xpAward && Array.isArray(patrol.xpAward.people)) ? patrol.xpAward.people : [];
  const actor = { id: by && by.id, name: (by && (by.displayName || by.discordUsername)) || 'IA patrol withdrawn' };
  let xpReversed = 0;
  for (const p of paid) {
    if (!p || !p.ok || !p.discordId || !p.xp) continue;
    const res = await awardXpTo({
      discordId: p.discordId, name: p.name, amount: -Math.abs(p.xp),
      reason: `${patrol.patrolRef} withdrawn`, actor,
    });
    if (res.ok) xpReversed++;
    else console.error(`[IA patrols] could not take back ${p.xp} XP from ${p.discordId}:`, res.error);
  }

  let updated = await prisma.iaPatrolLog.update({
    where: { id },
    data: {
      voidedAt: new Date(),
      voidedById: by && by.id ? by.id : null,
      voidedReason: clean(reason, 300) || null,
    },
  });
  console.log(`[IA patrols] ${patrol.patrolRef} withdrawn by ${actor.name} — `
    + `${reversed} points award(s) reversed, ${xpReversed} XP award(s) taken back`);
  updated = await mirror.attach('PATROL', updated);
  return { ok: true, patrol: updated, reversed, xpReversed };
}

/**
 * Patrols, newest first — except the queue, which is oldest first: a supervisor
 * works through what has been waiting longest.
 */
async function listPatrols({ mine, officerId, status, take = 100 } = {}) {
  const where = {};
  if (mine && officerId) where.officerId = officerId;
  if (status) where.status = String(status).toUpperCase();
  return prisma.iaPatrolLog.findMany({
    where,
    orderBy: status === 'PENDING' ? { createdAt: 'asc' } : { startedAt: 'desc' },
    take:    Math.min(Math.max(parseInt(take, 10) || 100, 1), 300),
  });
}

/** How many are waiting on a decision — for the nav badge. */
async function pendingCount() {
  return prisma.iaPatrolLog.count({ where: { status: 'PENDING' } });
}

module.exports = {
  POINTS_EACH, MIN_MINUTES, MAX_MINUTES, MAX_PARTNERS, MAX_PROOF, MAX_PROOF_BYTES,
  spanOf, normalisePartners, normaliseProof, problemsWith, nextPatrolRef, xpFor,
  submitPatrol, reviewPatrol, payPatrol, voidPatrol, listPatrols, pendingCount,
};
