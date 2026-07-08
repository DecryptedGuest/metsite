// server/lib/analytics.js
// Portal intelligence: tryout performance, recruitment funnel, host leaderboards,
// activity trends and tryout-log integrity flags. Every function takes an
// optional `division` (null = across the whole MET) so the same component powers
// the MET HICOMM oversight dashboard and each division's own analytics tab.
const prisma = require('./db');

const DAY = 24 * 60 * 60 * 1000;

function dayKey(d) {
  const t = new Date(d);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}
function emptyDays(days) {
  const out = [];
  const now = Date.now();
  for (let i = days - 1; i >= 0; i--) out.push({ day: dayKey(now - i * DAY) });
  return out;
}
function divWhere(division, extra = {}) {
  return division ? { division, ...extra } : { ...extra };
}

// Parse a ?days= value → a clamped day count, or 0 for the "all time" sentinel.
const MAX_ALLTIME_DAYS = 3650; // safety cap on all-time daily buckets (~10y)
function normDays(v) {
  if (v == null) return 30;
  const s = String(v).toLowerCase();
  if (s === 'all' || s === '0') return 0;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? Math.min(180, Math.max(7, n)) : 30;
}
// All-time mode: number of daily buckets spanning the earliest of `dates` → today.
function allTimeBuckets(dates) {
  const now = Date.now();
  let min = now;
  for (const d of dates) { if (d == null) continue; const t = new Date(d).getTime(); if (Number.isFinite(t) && t < min) min = t; }
  // Count by UTC calendar-day span (inclusive) so it matches emptyDays' day-
  // anchored keys — a ms floor() would drop the earliest day.
  const md = new Date(min), nd = new Date(now);
  const minMidnight = Date.UTC(md.getUTCFullYear(), md.getUTCMonth(), md.getUTCDate());
  const nowMidnight = Date.UTC(nd.getUTCFullYear(), nd.getUTCMonth(), nd.getUTCDate());
  return Math.min(MAX_ALLTIME_DAYS, Math.max(1, Math.round((nowMidnight - minMidnight) / DAY) + 1));
}

// ── Tryout performance ────────────────────────────────────────────────
// Concluded tryout logs bucketed by day (attendees / passed / failed), the
// overall pass rate, and a host leaderboard (tryouts run + candidates passed).
async function tryoutAnalytics(division, days = 30) {
  const allTime = days <= 0;
  const since = allTime ? new Date(0) : new Date(Date.now() - days * DAY);
  const logs = await prisma.tryoutLog.findMany({
    where: divWhere(division, { createdAt: { gte: since } }),
    select: {
      id: true, hostId: true, hostName: true, division: true, status: true,
      totalAttendees: true, passedCount: true, failedCount: true, strikeCount: true,
      createdAt: true, concludedAt: true,
    },
    orderBy: { createdAt: 'asc' },
    take: 5000,
  });

  const bucketCount = allTime ? allTimeBuckets(logs.map(l => l.concludedAt || l.createdAt)) : days;
  const byDay = new Map(emptyDays(bucketCount).map(d => [d.day, { day: d.day, tryouts: 0, attendees: 0, passed: 0, failed: 0 }]));
  const hosts = new Map();
  let tAtt = 0, tPass = 0, tFail = 0;
  for (const l of logs) {
    const k = dayKey(l.concludedAt || l.createdAt);
    const b = byDay.get(k);
    if (b) { b.tryouts++; b.attendees += l.totalAttendees || 0; b.passed += l.passedCount || 0; b.failed += l.failedCount || 0; }
    tAtt += l.totalAttendees || 0; tPass += l.passedCount || 0; tFail += l.failedCount || 0;
    const h = hosts.get(l.hostId) || { hostId: l.hostId, hostName: l.hostName, tryouts: 0, attendees: 0, passed: 0, failed: 0 };
    h.tryouts++; h.attendees += l.totalAttendees || 0; h.passed += l.passedCount || 0; h.failed += l.failedCount || 0;
    hosts.set(l.hostId, h);
  }
  const leaderboard = [...hosts.values()]
    .map(h => ({ ...h, passRate: h.attendees ? Math.round((h.passed / h.attendees) * 100) : 0 }))
    .sort((a, b) => b.tryouts - a.tryouts || b.attendees - a.attendees)
    .slice(0, 12);

  return {
    days: bucketCount, allTime,
    series: [...byDay.values()],
    totals: { tryouts: logs.length, attendees: tAtt, passed: tPass, failed: tFail,
              passRate: tAtt ? Math.round((tPass / tAtt) * 100) : 0 },
    leaderboard,
  };
}

// ── Recruitment funnel ────────────────────────────────────────────────
// tryouts run → candidates attended → passed. (Group join-requests would sit
// at the very top but need a live Roblox call, so they're fetched separately by
// the overview when a group is configured.)
async function recruitmentFunnel(division, days = 30) {
  const t = await tryoutAnalytics(division, days);
  const attended = t.totals.attendees;
  const passed = t.totals.passed;
  return {
    stages: [
      { key: 'tryouts',  label: 'Tryouts run',       value: t.totals.tryouts },
      { key: 'attended', label: 'Candidates',        value: attended },
      { key: 'passed',   label: 'Passed',            value: passed },
    ],
    conversion: attended ? Math.round((passed / attended) * 100) : 0,
  };
}

// ── Activity trends ───────────────────────────────────────────────────
// Patrol logs, event logs and support tickets per day (portal-wide; patrol/event
// logs aren't division-scoped in the schema, so `division` only filters tickets
// isn't meaningful — these are MET-wide signals).
async function activityAnalytics(days = 30) {
  const allTime = days <= 0;
  const since = allTime ? new Date(0) : new Date(Date.now() - days * DAY);
  // Bucket patrol/event logs by the SHIFT's own date (logDate), not the import
  // time — a bulk import all lands on one day otherwise. Pull a wide window and
  // filter by the effective date so a log whose logDate is outside the window is
  // dropped even if it was imported recently.
  const [patrols, tickets] = await Promise.all([
    prisma.patrolLog.findMany({
      where: { OR: [{ logDate: { gte: since } }, { logDate: null, createdAt: { gte: since } }] },
      select: { type: true, createdAt: true, logDate: true }, take: 8000,
    }),
    prisma.supportTicket.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true, status: true }, take: 8000 }),
  ]);
  const bucketCount = allTime
    ? allTimeBuckets([...patrols.map(p => p.logDate || p.createdAt), ...tickets.map(t => t.createdAt)])
    : days;
  const byDay = new Map(emptyDays(bucketCount).map(d => [d.day, { day: d.day, patrols: 0, events: 0, tickets: 0 }]));
  for (const p of patrols) { const b = byDay.get(dayKey(p.logDate || p.createdAt)); if (b) { if (p.type === 'EVENT') b.events++; else b.patrols++; } }
  for (const t of tickets) { const b = byDay.get(dayKey(t.createdAt)); if (b) b.tickets++; }
  return { days: bucketCount, allTime, series: [...byDay.values()] };
}

// ── Integrity flags (the "AI auditor") ────────────────────────────────
// Heuristic anomaly detection over recent tryout logs. Cheap, explainable rules
// that surface logs a reviewer should look at twice. Each flag: { logId, host,
// division, severity, kind, detail }.
async function integrityFlags(division, days = 45) {
  const since = new Date(Date.now() - days * DAY);
  const logs = await prisma.tryoutLog.findMany({
    where: divWhere(division, { createdAt: { gte: since } }),
    select: {
      id: true, hostId: true, hostName: true, division: true, status: true,
      totalAttendees: true, passedCount: true, failedCount: true,
      reviewedById: true, startedAt: true, concludedAt: true, attendees: true, createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 2000,
  });

  // Baseline pass rate per division for outlier detection.
  const flags = [];
  const hostAgg = new Map();
  for (const l of logs) {
    const att = Array.isArray(l.attendees) ? l.attendees : [];

    // 1. Quiz answer-copying reported by the game.
    const copiers = att.filter(a => a.quiz && a.quiz.copyFlag);
    if (copiers.length) {
      flags.push({ logId: l.id, host: l.hostName, division: l.division, severity: 'high', kind: 'quiz-copy',
        detail: `${copiers.length} candidate(s) flagged for possible answer copying (${copiers.map(c => c.username).slice(0, 4).join(', ')}).` });
    }

    // 2. Host approved their own log.
    if (l.status === 'APPROVED' && l.reviewedById && l.reviewedById === l.hostId) {
      flags.push({ logId: l.id, host: l.hostName, division: l.division, severity: 'high', kind: 'self-approval',
        detail: 'This tryout log was approved by its own host.' });
    }

    // 3. Impossibly fast tryout (many candidates, tiny duration).
    if (l.startedAt && l.concludedAt) {
      const mins = (new Date(l.concludedAt) - new Date(l.startedAt)) / 60000;
      if (mins > 0 && mins < 5 && (l.totalAttendees || 0) >= 4) {
        flags.push({ logId: l.id, host: l.hostName, division: l.division, severity: 'medium', kind: 'fast-conclude',
          detail: `Concluded in ${Math.round(mins)} min with ${l.totalAttendees} candidates.` });
      }
    }

    // 4. Everyone passed, repeatedly (aggregate per host below).
    const h = hostAgg.get(l.hostId) || { host: l.hostName, division: l.division, tryouts: 0, attendees: 0, passed: 0, perfect: 0 };
    h.tryouts++; h.attendees += l.totalAttendees || 0; h.passed += l.passedCount || 0;
    if ((l.totalAttendees || 0) >= 3 && l.passedCount === l.totalAttendees) h.perfect++;
    hostAgg.set(l.hostId, h);
  }

  // Portal/division baseline.
  let bAtt = 0, bPass = 0;
  for (const h of hostAgg.values()) { bAtt += h.attendees; bPass += h.passed; }
  const baseline = bAtt ? bPass / bAtt : 0;
  for (const h of hostAgg.values()) {
    if (h.attendees >= 8) {
      const rate = h.passed / h.attendees;
      if (baseline > 0 && rate > Math.min(0.98, baseline + 0.3)) {
        flags.push({ logId: null, host: h.host, division: h.division, severity: 'medium', kind: 'pass-rate-outlier',
          detail: `Pass rate ${Math.round(rate * 100)}% vs ${Math.round(baseline * 100)}% baseline across ${h.tryouts} tryouts.` });
      }
    }
    if (h.perfect >= 3) {
      flags.push({ logId: null, host: h.host, division: h.division, severity: 'low', kind: 'always-perfect',
        detail: `${h.perfect} tryouts where every candidate passed.` });
    }
  }

  const rank = { high: 0, medium: 1, low: 2 };
  flags.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return { flags, scanned: logs.length };
}

module.exports = { tryoutAnalytics, recruitmentFunnel, activityAnalytics, integrityFlags, normDays };
