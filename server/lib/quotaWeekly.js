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
async function postedWeek() {
  try {
    const row = await prisma.systemSetting.findUnique({ where: { key: STAMP_KEY } });
    return row ? String(row.value) : null;
  } catch (e) { return null; }
}

async function markPosted(week) {
  try {
    await prisma.systemSetting.upsert({
      where:  { key: STAMP_KEY },
      update: { value: String(week) },
      create: { key: STAMP_KEY, value: String(week) },
    });
    return true;
  } catch (e) {
    console.warn('[Quota] could not stamp the weekly check:', e.message);
    return false;
  }
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

  if (!opts.force && !opts.dryRun) {
    const done = await postedWeek();
    if (done === week) return { ok: true, skipped: 'already posted for ' + week, week };
  }

  const members = await quota.getAllMembersPoints();
  if (members == null) return { ok: false, error: 'The quota sheet is not readable.', week };
  if (!members.length) return { ok: false, error: 'The quota sheet has no members on it.', week };

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

  if (!sent) return { ok: false, error: 'The quota results channel and webhook are both unavailable.', week, results, iotw };

  await markPosted(week);
  console.log(`[Quota] weekly check posted for ${week} — ${results.length} member(s), `
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

async function tick(now = new Date(), opts = {}) {
  if (!AUTO()) return { ran: false, why: 'disabled' };
  const cfg = quota.quotaConfig('IA');
  const t = localParts(now, cfg.timezone);
  const week = reviewWeekKey(now, cfg.timezone);

  const done = await postedWeek();
  if (done === week) return { ran: false, why: 'already posted' };

  // Due once the slot has passed, not only exactly on it — a minute missed to a
  // restart or a slow tick is not a week skipped. `week` is the week the last
  // slot belongs to, so reaching here means that slot has been and gone and
  // has not been posted for.
  //
  // The one case to hold back on: before the FIRST slot has ever passed in a
  // fresh deployment, `week` names last week, which nobody has any figures for.
  // A sheet that has since been reset would make that post a page of zeroes.
  if (opts && opts.strict) {
    const dueMinutes = DAY() * 1440 + HOUR() * 60 + MINUTE();
    const nowMinutes = t.weekday * 1440 + t.hour * 60 + t.minute;
    if (nowMinutes < dueMinutes) return { ran: false, why: 'not due yet' };
  }

  const out = await runWeeklyCheck({ at: now });
  if (!out.ok) console.warn('[Quota] weekly check did not post:', out.error);
  return { ran: true, ...out };
}

function startWeeklyQuotaWorker() {
  if (timer) return;
  if (!AUTO()) { console.log('[Quota] the weekly check is off (QUOTA_WEEKLY_AUTO=off).'); return; }
  timer = setInterval(() => { tick().catch(e => console.warn('[Quota] weekly tick failed:', e.message)); }, 60 * 1000);
  if (timer.unref) timer.unref();
  // Not immediately: the sheet read is not free and boot is busy enough.
  setTimeout(() => { tick().catch(() => {}); }, 90 * 1000);
  console.log(`[Quota] weekly check armed — ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][DAY()]} `
    + `${String(HOUR()).padStart(2, '0')}:${String(MINUTE()).padStart(2, '0')} ${quota.quotaConfig('IA').timezone}`);
}

module.exports = {
  STAMP_KEY, AUTO, DAY, HOUR, MINUTE,
  localParts, weekKey, reviewWeekKey, weekLabel,
  resultsFrom, investigatorOfTheWeek,
  postedWeek, markPosted,
  runWeeklyCheck, tick, startWeeklyQuotaWorker,
};
