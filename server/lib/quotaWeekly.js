// server/lib/quotaWeekly.js
// The weekly IA quota check, posted by the site rather than by a person.
//
// It used to be somebody opening the dashboard on a Sunday night, reading the
// sheet, ticking every row, picking an Investigator of the Week and pressing
// submit. Every one of those steps is mechanical — the sheet already says who
// met their target and who has the most points — so the only thing a person was
// really adding was the chance of forgetting.
//
// So it runs itself at 23:59 on Sunday, in the quota's own timezone:
//
//   · read every member off the sheet
//   · pass / fail / exempt straight from their points against their target
//   · Investigator of the Week is whoever has the most points, ignoring anybody
//     exempt (an exempt member has no points to compete with) — and nobody at
//     all if it is a tie or the highest score is zero, because picking one of
//     two equals arbitrarily is worse than picking neither
//   · apply the IOTW role and post the review to the quota channel
//
// A person can still do it by hand on the dashboard; this is the backstop, and
// the two write to exactly the same place.
//
// It runs ONCE per week. The check is stamped in SystemSetting, so a restart at
// 23:58 on Sunday cannot post it twice, and a server that was down at 23:59
// still posts it when it comes back — late is better than never, and the
// alternative is a week silently missing from the record.
//
// Env:
//   QUOTA_WEEKLY_AUTO   'off' to disable and leave it to a person
//   QUOTA_WEEKLY_DAY    0–6, Sunday = 0 (default 0)
//   QUOTA_WEEKLY_HOUR   0–23 (default 23)
//   QUOTA_WEEKLY_MINUTE 0–59 (default 59)
//   QUOTA_TIMEZONE      the timezone all of that is read in (default Europe/London)

const prisma = require('./db');
const quota  = require('./quota');

const STAMP_KEY = 'quota.weeklyCheckPostedFor';

const AUTO   = () => String(process.env.QUOTA_WEEKLY_AUTO || '').toLowerCase() !== 'off';
const DAY    = () => num(process.env.QUOTA_WEEKLY_DAY, 0, 0, 6);
const HOUR   = () => num(process.env.QUOTA_WEEKLY_HOUR, 23, 0, 23);
const MINUTE = () => num(process.env.QUOTA_WEEKLY_MINUTE, 59, 0, 59);

function num(v, dflt, lo, hi) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
}

// ── Time, in the quota's timezone ─────────────────────────────────
// Everything about "Sunday at 23:59" is local to whoever runs the department,
// not to whatever region the server happens to be in.
function localParts(at = new Date(), tz = quota.quotaConfig('IA').timezone) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, weekday: 'short', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = {};
  for (const part of fmt.formatToParts(at)) p[part.type] = part.value;
  const DAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    weekday: DAYS[p.weekday] != null ? DAYS[p.weekday] : new Date(at).getUTCDay(),
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour: Number(p.hour === '24' ? '0' : p.hour), minute: Number(p.minute),
    date: `${p.year}-${p.month}-${p.day}`,
  };
}

/**
 * The week a moment belongs to, as "2026-W31".
 *
 * Keyed on the ISO week rather than the date so the stamp still identifies the
 * same week whether the post went out on time at 23:59 Sunday or late on the
 * Monday after an outage.
 */
function weekKey(at = new Date(), tz) {
  const { year, month, day } = localParts(at, tz);
  const d = new Date(Date.UTC(year, month - 1, day));
  // ISO weeks start on Monday and are numbered by the Thursday they contain.
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const fDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fDayNum + 3);
  const week = 1 + Math.round((d - firstThursday) / (7 * 86400000));
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * The week the review is ABOUT, which is not always the week it is posted in.
 *
 * The slot is 23:59 on Sunday, and an ISO week ends on that Sunday — so a post
 * that goes out on time is stamped with the week it reviews. One that goes out
 * late, because the server was down overnight, happens on the Monday, which is
 * already the NEXT ISO week. Stamping that would let the same week's figures be
 * posted twice, once at 23:59 and once at 00:10.
 *
 * So the key is taken from the most recent scheduled slot at or before `now` —
 * always a Sunday, always inside the week being reviewed, whether the post is
 * punctual or nine hours late.
 */
function reviewWeekKey(at = new Date(), tz = quota.quotaConfig('IA').timezone) {
  const t = localParts(at, tz);
  const nowMinutes  = t.weekday * 1440 + t.hour * 60 + t.minute;
  const slotMinutes = DAY() * 1440 + HOUR() * 60 + MINUTE();
  const since = ((nowMinutes - slotMinutes) + 10080) % 10080;   // minutes since the last slot
  return weekKey(new Date(new Date(at).getTime() - since * 60000), tz);
}

/** "Week ending 3 August 2026" — what the post calls itself. */
function weekLabel(at = new Date(), tz = quota.quotaConfig('IA').timezone) {
  try {
    return 'Week ending ' + new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, day: 'numeric', month: 'long', year: 'numeric',
    }).format(at);
  } catch (e) { return null; }
}

// ── The decision, made from the sheet ─────────────────────────────
/**
 * Turn the sheet's members into the results the review posts.
 *
 * No judgement in here: a member met their target or they did not, and somebody
 * marked EX or LOA is exempt. The one place a human used to add something was
 * the reason on a failure, and an automatic post says "did not meet the target"
 * rather than inventing one.
 */
function resultsFrom(members) {
  return (members || []).map(m => {
    const q = m.quota || {};
    const exempt = !!q.exempt;
    const met = exempt ? true : (q.target != null ? Number(m.total) >= Number(q.target) : null);
    return {
      username: m.username,
      rank:     m.rank || null,
      total:    Number(m.total) || 0,
      target:   exempt ? null : (q.target != null ? q.target : null),
      exempt,
      status:   exempt ? 'exempt' : (met ? 'pass' : 'fail'),
      reason:   null,
      discordId: m.discordId || null,
      exemptKind: m.exemptKind || null,
    };
  });
}

/**
 * Investigator of the Week: the most points.
 *
 * Exempt members are out of the running — they have no points to compete with,
 * and handing the award to somebody who was on leave all week reads as a joke.
 * A tie wins nobody: choosing between two equal scores is a judgement, and this
 * is deliberately not making judgements. Nobody scoring anything wins nobody
 * either.
 *
 * @returns {{ winner: object|null, tied: object[], top: number }}
 */
function investigatorOfTheWeek(results) {
  const eligible = (results || []).filter(r => !r.exempt && Number(r.total) > 0);
  if (!eligible.length) return { winner: null, tied: [], top: 0 };
  const top = Math.max(...eligible.map(r => Number(r.total) || 0));
  const tied = eligible.filter(r => Number(r.total) === top);
  return { winner: tied.length === 1 ? tied[0] : null, tied, top };
}

// ── Has it already gone out? ──────────────────────────────────────
// ── Claiming the week ─────────────────────────────────────────────
// This posts to a channel and pings a role, so the ONLY safe direction to fail is
// silent. The first version of this failed the other way and did real damage: the
// stamp read swallowed database errors and returned null, which reads as "not
// posted yet", and the stamp write swallowed its errors and was never checked. A
// database hiccup therefore meant a ping to the whole of Internal Affairs every
// sixty seconds until somebody noticed.
//
// So the week is CLAIMED BEFORE anything is sent, with a create against a
// per-week key. A create either succeeds — and it can only succeed once, ever,
// across every instance — or it tells us somebody already holds it. Nothing is
// posted unless the claim is definitely ours, and a database that will not answer
// means nothing is posted at all.
const claimKey = (week) => `quota.weeklyCheck:${week}`;

// A claim that was taken but never confirmed is retried, but only a few times: a
// post that keeps failing must go quiet rather than keep trying to shout.
const MAX_ATTEMPTS = 3;

// How late a slot may be posted. "Late is better than never" is true for a server
// that restarted at 23:58 and came back at 00:10. It is NOT true forty hours later,
// and it is emphatically not true on a database that has no record of the slot
// because the database is NEW — which is the case that pinged Internal Affairs on a
// Monday afternoon. With no claim row, the worker concluded the week had never been
// posted and dutifully posted it.
//
// So a slot older than this is closed out, marked as skipped, and logged. A missing
// week can be posted by hand from the dashboard in seconds; an unexpected ping to
// seventy people cannot be taken back.
// Twelve hours. Chosen so the case the catch-up genuinely exists for still works —
// the server was down across Sunday midnight and comes back on Monday morning, and
// posting the review at 07:00 is wanted — while Monday afternoon and everything
// after it is not. Sixteen hours late was the actual complaint.
const MAX_LATE_MINUTES = () => num(process.env.QUOTA_WEEKLY_MAX_LATE_MIN, 720, 1, 10080);

// Minutes since the scheduled slot that `at` belongs to.
function minutesSinceSlot(at = new Date(), tz = quota.quotaConfig('IA').timezone) {
  const t = localParts(at, tz);
  const nowMinutes  = t.weekday * 1440 + t.hour * 60 + t.minute;
  const slotMinutes = DAY() * 1440 + HOUR() * 60 + MINUTE();
  return ((nowMinutes - slotMinutes) + 10080) % 10080;
}

/** The week the legacy single-key stamp says was last posted, or a read failure. */
async function postedWeek() {
  try {
    const row = await prisma.systemSetting.findUnique({ where: { key: STAMP_KEY } });
    return row ? String(row.value) : null;
  } catch (e) { return null; }
}

/**
 * Take the week, or explain why not.
 *
 *   { ok: true }                  it is ours, go ahead
 *   { ok: false, done: true }     already posted, or out of attempts
 *   { ok: false, error }          we could not tell — DO NOT POST
 */
async function claimWeek(week) {
  const key = claimKey(week);

  // The legacy stamp still marks weeks posted before this change, so honour it
  // rather than reposting them on the first deploy.
  try {
    const legacy = await prisma.systemSetting.findUnique({ where: { key: STAMP_KEY } });
    if (legacy && String(legacy.value) === week) return { ok: false, done: true, why: 'already posted' };
  } catch (e) {
    return { ok: false, error: 'the database would not answer: ' + e.message };
  }

  try {
    await prisma.systemSetting.create({ data: { key, value: JSON.stringify({ attempts: 1 }) } });
    return { ok: true, attempt: 1 };
  } catch (e) {
    // P2002 is the unique-key collision, which is the answer we want rather than
    // a fault: somebody already claimed this week.
    const taken = e && (e.code === 'P2002' || /unique|duplicate/i.test(e.message || ''));
    if (!taken) return { ok: false, error: 'the database would not answer: ' + e.message };
  }

  // Somebody holds it. Either it is finished, or an earlier attempt died partway.
  let held;
  try {
    const row = await prisma.systemSetting.findUnique({ where: { key } });
    held = row ? JSON.parse(row.value || '{}') : {};
  } catch (e) {
    return { ok: false, error: 'the claim exists but could not be read: ' + e.message };
  }

  if (held.postedAt) return { ok: false, done: true, why: 'already posted' };
  if ((held.attempts || 0) >= MAX_ATTEMPTS) {
    return { ok: false, done: true, why: `gave up after ${MAX_ATTEMPTS} attempts` };
  }

  // The rule that matters, and the one whose absence caused the incident: an
  // attempt is only repeated when the previous one EXPLICITLY recorded that
  // nothing was sent. Anything else — a claim taken by an instance that then died,
  // a post that landed but whose confirmation write failed, another instance
  // holding the claim right now — is unknown, and unknown must never mean "post it
  // again". A week silently missing is recoverable by hand; forty pings are not.
  if (held.lastFailed !== true) {
    return { ok: false, done: true, why: 'an attempt is unaccounted for, so nothing is sent' };
  }

  // Take another attempt, and record it BEFORE trying — a crash between here and
  // the post must count against the budget, not be forgotten. lastFailed is
  // cleared, so this attempt is unknown until it says otherwise.
  try {
    await prisma.systemSetting.update({
      where: { key },
      data:  { value: JSON.stringify({ ...held, attempts: (held.attempts || 0) + 1, lastFailed: false }) },
    });
    return { ok: true, attempt: (held.attempts || 0) + 1 };
  } catch (e) {
    return { ok: false, error: 'could not record the attempt: ' + e.message };
  }
}

/**
 * Record that the send definitely did not happen, which is what permits one more
 * attempt. If even this write fails, the claim stays unaccounted for and the week
 * goes quiet — which is the safe direction.
 */
async function noteSendFailed(week) {
  const key = claimKey(week);
  try {
    const row = await prisma.systemSetting.findUnique({ where: { key } });
    const held = row ? JSON.parse(row.value || '{}') : {};
    if (held.postedAt) return;
    await prisma.systemSetting.update({
      where: { key },
      data:  { value: JSON.stringify({ ...held, lastFailed: true }) },
    });
  } catch (e) {
    console.warn('[Quota] could not record the send failure; this week will stay quiet:', e.message);
  }
}

/**
 * Mark a slot as deliberately not posted, so it is never revisited. Used when a
 * slot is too old to post — including the fresh-database case, where nothing was
 * ever recorded because the record itself is new.
 */
async function closeOutWeek(week, why) {
  const key = claimKey(week);
  const value = JSON.stringify({ attempts: MAX_ATTEMPTS, postedAt: new Date().toISOString(), skipped: why });
  try {
    await prisma.systemSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
    console.warn(`[Quota] weekly check for ${week} was NOT posted · ${why}. `
      + 'Post it by hand from the dashboard if it is still wanted.');
    return true;
  } catch (e) {
    console.warn('[Quota] could not close out ' + week + ':', e.message);
    return false;
  }
}

/** Confirm the post landed, so no later tick can repeat it. */
async function confirmPosted(week) {
  const key = claimKey(week);
  const value = JSON.stringify({ attempts: MAX_ATTEMPTS, postedAt: new Date().toISOString() });
  try {
    await prisma.systemSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
  } catch (e) {
    console.error('[Quota] POSTED but could not confirm it · the claim still holds, so it will not repeat:', e.message);
  }
  // Keep the legacy key current too, so anything still reading it agrees.
  try {
    await prisma.systemSetting.upsert({
      where:  { key: STAMP_KEY },
      update: { value: String(week) },
      create: { key: STAMP_KEY, value: String(week) },
    });
  } catch (e) { /* the per-week claim is what actually guards this */ }
}

async function markPosted(week) {
  await confirmPosted(week);
  return true;
}

/**
 * Read the sheet, decide, post.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun]  work it all out and send nothing
 * @param {boolean} [opts.force]   post even if this week is already stamped
 * @param {Date}    [opts.at]      pretend it is this moment (tests)
 */
async function runWeeklyCheck(opts = {}) {
  const at = opts.at || new Date();
  const cfg = quota.quotaConfig('IA');
  const week = reviewWeekKey(at, cfg.timezone);

  // Claimed BEFORE the sheet is read and long before anything is sent. A claim we
  // cannot definitely take means we post nothing at all.
  if (!opts.force && !opts.dryRun) {
    const claim = await claimWeek(week);
    if (!claim.ok) {
      if (claim.done) return { ok: true, skipped: claim.why || 'already posted', week };
      // Deliberately silent. Not knowing whether this week was already posted is
      // not a reason to post it again.
      console.warn('[Quota] weekly check held back · ' + claim.error);
      return { ok: false, error: 'Could not confirm whether this week was already posted, so nothing was sent. ' + claim.error, week, heldBack: true };
    }
  }

  const members = await quota.getAllMembersPoints();
  // A sheet that cannot be read is a definite non-send, exactly like an
  // unavailable channel — so it earns a retry rather than burning the week.
  if (members == null) {
    if (!opts.force && !opts.dryRun) await noteSendFailed(week);
    return { ok: false, error: 'The quota sheet is not readable.', week };
  }
  if (!members.length) {
    if (!opts.force && !opts.dryRun) await noteSendFailed(week);
    return { ok: false, error: 'The quota sheet has no members on it.', week };
  }

  const results = resultsFrom(members);
  const iotw = investigatorOfTheWeek(results);

  if (opts.dryRun) {
    return { ok: true, dryRun: true, week, results, iotw, label: weekLabel(at, cfg.timezone) };
  }

  // The role first: if the post lands and the role does not, the channel says
  // somebody is Investigator of the Week while their quota is unchanged.
  let iotwApplied = null;
  if (iotw.winner && iotw.winner.discordId) {
    try {
      iotwApplied = await quota.setInvestigatorOfWeek(iotw.winner.discordId);
      if (iotwApplied && !iotwApplied.ok) {
        console.warn('[Quota] weekly IOTW role update failed:', iotwApplied.error);
      }
    } catch (err) {
      iotwApplied = { ok: false, error: err.message };
    }
  }

  const { sendQuotaCheckWebhook } = require('./webhook');
  const sent = await sendQuotaCheckWebhook({
    reviewerName: 'Automatic weekly check',
    reviewerId:   null,
    results,
    weekLabel:    weekLabel(at, cfg.timezone),
    iotwUsername: iotw.winner ? iotw.winner.username : null,
    automatic:    true,
    iotwTied:     iotw.tied.length > 1 ? iotw.tied.map(r => r.username) : null,
    iotwPoints:   iotw.top,
  });

  if (!sent) {
    // Definitely not sent, which is the ONLY outcome that earns a retry. Recorded
    // explicitly, because claimWeek refuses to repeat anything it cannot account
    // for.
    await noteSendFailed(week);
    return { ok: false, error: 'The quota results channel and webhook are both unavailable.', week, results, iotw };
  }

  await markPosted(week);
  console.log(`[Quota] weekly check posted for ${week} · ${results.length} member(s), `
    + `${results.filter(r => r.status === 'pass').length} met, `
    + `${results.filter(r => r.status === 'fail').length} missed`
    + (iotw.winner ? `, IOTW ${iotw.winner.username} on ${iotw.top}` : ', no IOTW'));

  return { ok: true, week, results, iotw, iotwApplied, posted: true };
}

// ── The clock ─────────────────────────────────────────────────────
// Checked every minute rather than scheduled once, so a restart cannot lose the
// slot and a server that was down at 23:59 still posts when it comes back. The
// week stamp is what stops it posting twice.
let timer = null;
// One tick at a time, and never two posts close together whatever the database
// says. Both are belt and braces behind the claim, and both are cheap.
let ticking = false;
let lastPostAt = 0;
const MIN_GAP_MS = 30 * 60 * 1000;

async function tick(now = new Date(), opts = {}) {
  if (!AUTO()) return { ran: false, why: 'disabled' };
  if (ticking) return { ran: false, why: 'already running' };
  if (Date.now() - lastPostAt < MIN_GAP_MS) return { ran: false, why: 'posted very recently' };
  ticking = true;
  try {
    return await tickOnce(now, opts);
  } finally {
    ticking = false;
  }
}

async function tickOnce(now, opts = {}) {
  const cfg = quota.quotaConfig('IA');
  const t = localParts(now, cfg.timezone);
  const week = reviewWeekKey(now, cfg.timezone);

  // How late this would be. Applied on EVERY automatic path — the previous version
  // put this behind an opts.strict flag that nothing in production ever passed, so
  // the guard existed and never ran.
  const late = minutesSinceSlot(now, cfg.timezone);
  if (late > MAX_LATE_MINUTES()) {
    // Too old to announce. Close the slot out so it is not reconsidered every ten
    // minutes for the rest of the week.
    await closeOutWeek(week, `the slot was ${Math.round(late / 60)}h old by the time it was considered`);
    return { ran: false, why: 'too late to post', lateMinutes: late };
  }

  const out = await runWeeklyCheck({ at: now });
  if (out.posted) lastPostAt = Date.now();
  if (!out.ok) console.warn('[Quota] weekly check did not post:', out.error);
  return { ran: true, ...out };
}

const INSTALL_KEY = 'quota.weeklyCheckInstalledAt';

/**
 * Close out the slot that is already in the past the FIRST time this runs against a
 * given database, so a new deployment never opens by announcing a week it was not
 * present for.
 *
 * This is the case that actually pinged Internal Affairs: a fresh database has no
 * claim rows, so every past slot looks unposted, and the catch-up logic did exactly
 * what it was told. A record of when the worker first saw this database is what
 * distinguishes "we missed it" from "it happened before we existed".
 */
async function markInstalled() {
  const cfg = quota.quotaConfig('IA');
  try {
    const existing = await prisma.systemSetting.findUnique({ where: { key: INSTALL_KEY } });
    if (existing) return { firstRun: false };

    await prisma.systemSetting.create({ data: { key: INSTALL_KEY, value: new Date().toISOString() } });
    const week = reviewWeekKey(new Date(), cfg.timezone);
    const held = await prisma.systemSetting.findUnique({ where: { key: claimKey(week) } }).catch(() => null);
    if (!held) {
      await closeOutWeek(week, 'this database had no record of it · the check was installed after the slot passed');
    }
    return { firstRun: true, closedOut: week };
  } catch (e) {
    // If this cannot be established, the safe assumption is that we are new and
    // should not announce anything. Saying nothing is always recoverable.
    console.warn('[Quota] could not establish whether this is a new installation, so the weekly check will stay quiet:', e.message);
    return { firstRun: true, unknown: true };
  }
}

function startWeeklyQuotaWorker() {
  if (timer) return;
  if (!AUTO()) { console.log('[Quota] the weekly check is off (QUOTA_WEEKLY_AUTO=off).'); return; }
  // Every ten minutes, not every minute. For a job that runs once a week the extra
  // precision buys nothing, and the interval is the multiplier on the blast radius
  // of anything that goes wrong — at one minute, this managed 60 pings an hour.
  timer = setInterval(() => { tick().catch(e => console.warn('[Quota] weekly tick failed:', e.message)); }, 10 * 60 * 1000);
  if (timer.unref) timer.unref();
  // Not immediately: the sheet read is not free and boot is busy enough. And the
  // install marker is settled BEFORE the first tick, so a new database closes out
  // the slot behind it rather than announcing it.
  setTimeout(() => {
    markInstalled()
      .then(r => { if (r.firstRun) console.log('[Quota] first run against this database · the slot already past will not be posted.'); })
      .then(() => tick())
      .catch(() => {});
  }, 90 * 1000);
  console.log(`[Quota] weekly check armed · ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][DAY()]} `
    + `${String(HOUR()).padStart(2, '0')}:${String(MINUTE()).padStart(2, '0')} ${quota.quotaConfig('IA').timezone}`);
}

module.exports = {
  STAMP_KEY, AUTO, DAY, HOUR, MINUTE, claimKey, claimWeek, confirmPosted, noteSendFailed, MAX_ATTEMPTS,
  MAX_LATE_MINUTES, minutesSinceSlot, closeOutWeek, markInstalled, INSTALL_KEY,
  // Tests drive many weeks in a row in a few milliseconds, which the in-process
  // guards are specifically there to prevent in production.
  __resetGuards: () => { ticking = false; lastPostAt = 0; },
  CLAIM_PREFIX: 'quota.weeklyCheck:',
  localParts, weekKey, reviewWeekKey, weekLabel,
  resultsFrom, investigatorOfTheWeek,
  postedWeek, markPosted,
  runWeeklyCheck, tick, startWeeklyQuotaWorker,
};
