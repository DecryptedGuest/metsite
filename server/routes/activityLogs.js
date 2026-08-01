// server/routes/activityLogs.js
// Patrol & event logs — the site's view of what lib/activityLogs.js mirrors out
// of Discord.
//
// A log is approved or denied by somebody ticking or crossing the Discord
// message. Whoever does it, and whether or not they have ever opened this site,
// the status lands here. Deciding from the site is the same act from the other
// end: it writes the decision AND mirrors the reaction back onto the message,
// so the two never drift apart.
//
//   GET  /api/logs               → my patrol/event logs
//   GET  /api/logs/all           → every log (FLP members + Developer)
//   GET  /api/logs/stats         → counts for the dashboard tiles
//   POST /api/logs/sync          → force a re-scan of the log channels (FLP lead)
//   GET  /api/logs/:id           → one log
//   POST /api/logs/:id/decide    → approve/deny from the site (FLP lead)

const express = require('express');
const prisma  = require('../lib/db');
const { requireDivision, requireDivisionLead } = require('../middleware/division');

const router = express.Router();

const KINDS    = ['PATROL', 'EVENT'];
const STATUSES = ['PENDING', 'APPROVED', 'DENIED'];

// Reviewing is FLP business — patrols and events are frontline activity — so
// the "all logs" list is FLP, and signing one off is FLP lead. requireDivision
// already lets a DEVELOPER through both.
const canRead   = requireDivision('FLP');
const canDecide = requireDivisionLead('FLP');

function searchClause(q) {
  const s = (q || '').toString().trim();
  if (!s) return null;
  const like = { contains: s, mode: 'insensitive' };
  return {
    OR: [
      { content:               like },
      { officerUsername:       like },
      { officerRobloxUsername: like },
      { officerDiscordId:      like },
      { decidedByName:         like },
    ],
  };
}

// A log belongs to the caller if it was matched to their site account, or if it
// was posted by their Discord id — so logs filed before they first signed in
// still show up as theirs.
function mineClause(user) {
  const or = [{ officerId: user.id }];
  if (user.discordId) or.push({ officerDiscordId: String(user.discordId) });
  return { OR: or };
}

function buildWhere(req, base) {
  const filters = [];
  if (base) filters.push(base);

  const kind = (req.query.kind || '').toString().toUpperCase();
  if (KINDS.includes(kind)) filters.push({ kind });

  const status = (req.query.status || '').toString().toUpperCase();
  if (STATUSES.includes(status)) filters.push({ status });

  const search = searchClause(req.query.q);
  if (search) filters.push(search);

  return filters.length ? { AND: filters } : {};
}

function take(req, fallback = 300) {
  const n = parseInt(req.query.take, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 2000) : fallback;
}

// ── GET /api/logs — my logs ───────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const logs = await prisma.activityLog.findMany({
      where:   buildWhere(req, mineClause(req.user)),
      orderBy: { loggedAt: 'desc' },
      take:    take(req),
    });
    res.json(logs);
  } catch (err) {
    console.error('[ActivityLogs] list error:', err.message);
    res.status(500).json({ error: 'Failed to load patrol/event logs.' });
  }
});

// ── GET /api/logs/all — every log ─────────────────────────────────
router.get('/all', canRead, async (req, res) => {
  try {
    const logs = await prisma.activityLog.findMany({
      where:   buildWhere(req, null),
      orderBy: { loggedAt: 'desc' },
      take:    take(req, 1000),
    });
    res.json(logs);
  } catch (err) {
    console.error('[ActivityLogs] all error:', err.message);
    res.status(500).json({ error: 'Failed to load patrol/event logs.' });
  }
});

// ── GET /api/logs/stats ───────────────────────────────────────────
// `mine` powers the officer's own tiles; the rest the reviewer's list header.
router.get('/stats', async (req, res) => {
  try {
    const mine = mineClause(req.user);
    const weekAgo = new Date(Date.now() - 7 * 86400000);

    const [mineTotal, mineWeek, mineByStatus, pendingAll] = await Promise.all([
      prisma.activityLog.count({ where: mine }),
      prisma.activityLog.count({ where: { AND: [mine, { loggedAt: { gte: weekAgo } }] } }),
      prisma.activityLog.groupBy({ by: ['status'], where: mine, _count: { _all: true } }).catch(() => []),
      prisma.activityLog.count({ where: { status: 'PENDING' } }).catch(() => 0),
    ]);

    const byStatus = { PENDING: 0, APPROVED: 0, DENIED: 0 };
    for (const row of mineByStatus) byStatus[row.status] = row._count._all;

    res.json({
      configured: require('../lib/activityLogs').isConfigured(),
      mine: mineTotal,
      mineWeek,
      byStatus,
      pendingAll,
    });
  } catch (err) {
    console.error('[ActivityLogs] stats error:', err.message);
    res.status(500).json({ error: 'Failed to fetch log stats.' });
  }
});

// ── POST /api/logs/sync — force a re-scan ─────────────────────────
// The live gateway events cover the normal case; this is the manual lever for
// after downtime, when a tick added while the bot was offline never arrived.
router.post('/sync', canDecide, async (req, res) => {
  try {
    const { getClient } = require('../lib/bot');
    const client = getClient();
    if (!client) return res.status(503).json({ error: 'The Discord bot is not connected yet — try again shortly.' });

    const { sweep, isConfigured } = require('../lib/activityLogs');
    if (!isConfigured()) {
      return res.status(400).json({ error: 'No patrol/event log channels are configured. Set PATROL_LOG_CHANNEL_ID / EVENT_LOG_CHANNEL_ID.' });
    }
    const stats = await sweep(client, { full: !!(req.body && req.body.full) });
    if (!stats) return res.status(409).json({ error: 'A sync is already running.' });
    if (stats.error) return res.status(502).json({ error: stats.error, ...stats });
    res.json(stats);
  } catch (err) {
    console.error('[ActivityLogs] sync error:', err.message);
    res.status(500).json({ error: 'Failed to sync patrol/event logs.' });
  }
});

// Is this log the caller's own?
function isMine(user, log) {
  if (log.officerId && log.officerId === user.id) return true;
  return !!(user.discordId && log.officerDiscordId &&
            String(log.officerDiscordId) === String(user.discordId));
}

// ── GET /api/logs/:id ─────────────────────────────────────────────
// Registered after the fixed paths so it can't shadow /all, /stats or /sync.
router.get('/:id', async (req, res) => {
  try {
    const log = await prisma.activityLog.findUnique({ where: { id: req.params.id } });
    if (!log) return res.status(404).json({ error: 'Log not found.' });
    if (isMine(req.user, log)) return res.json(log);
    // Somebody else's log — hand off to the division gate, which either calls
    // through to the response or answers 403 itself.
    return canRead(req, res, () => res.json(log));
  } catch (err) {
    console.error('[ActivityLogs] detail error:', err.message);
    res.status(500).json({ error: 'Failed to load the log.' });
  }
});

// ── POST /api/logs/:id/decide — approve/deny from the site ────────
// Body: { status: 'APPROVED' | 'DENIED' }
router.post('/:id/decide', canDecide, async (req, res) => {
  const status = ((req.body && req.body.status) || '').toString().toUpperCase();
  if (!['APPROVED', 'DENIED'].includes(status)) {
    return res.status(400).json({ error: 'status must be APPROVED or DENIED.' });
  }
  try {
    const log = await prisma.activityLog.findUnique({ where: { id: req.params.id } });
    if (!log) return res.status(404).json({ error: 'Log not found.' });

    // An officer can't sign off their own log here either — the same rule the
    // reaction path applies.
    if (isMine(req.user, log)) {
      return res.status(403).json({ error: 'You cannot sign off your own log.' });
    }

    const { decideFromSite } = require('../lib/activityLogs');
    const updated = await decideFromSite(log, status, {
      id:        req.user.id,
      discordId: req.user.discordId,
      name:      req.user.displayName || req.user.discordUsername,
    });
    res.json(updated);
  } catch (err) {
    console.error('[ActivityLogs] decide error:', err.message);
    res.status(500).json({ error: 'Failed to record the decision.' });
  }
});

module.exports = router;
