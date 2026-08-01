// server/routes/tickets.js
// Closed-ticket logs, mirrored from the IA ticket-logs Discord channel.
//
// This is READ-ONLY. Tickets are no longer submitted, approved or denied on the
// site, and closing a ticket no longer awards quota points — the weekly quota
// is 2 cases (8 points). Everything here just reads the TicketLog rows that
// lib/ticketIngest.js keeps in sync with Discord.
//
//   GET  /api/tickets            → tickets the current user closed ("My Tickets")
//   GET  /api/tickets/all        → every closed ticket ("All Tickets")
//   GET  /api/tickets/stats      → counts for the dashboard + nav
//   GET  /api/tickets/:id        → one ticket log
//   POST /api/tickets/sync       → force a re-scan of the log channel (HICOMM+)

const express = require('express');
const prisma  = require('../lib/db');
const { requireHICOMM } = require('../middleware/auth');

const router = express.Router();

const TYPES = ['GENERAL_SUPPORT', 'HICOMM', 'OFFICER_REPORT', 'APPEAL'];

// Free-text search across everything on a ticket worth searching by.
function searchClause(q) {
  const s = (q || '').toString().trim();
  if (!s) return null;
  const like = { contains: s, mode: 'insensitive' };
  return {
    OR: [
      { ticketRef:             like },
      { ticketName:            like },
      { reason:                like },
      { creatorUsername:       like },
      { creatorRobloxUsername: like },
      { creatorDiscordId:      like },
      { closerUsername:        like },
      { closerDiscordId:       like },
      { transcriptUrl:         like },
    ],
  };
}

// Every ticket the current user closed. Matched on the site account first, and
// on the raw Discord id too so tickets closed before they ever signed in still
// appear under their name.
function mineClause(user) {
  const or = [{ closerUserId: user.id }];
  if (user.discordId) or.push({ closerDiscordId: String(user.discordId) });
  return { OR: or };
}

function buildWhere(req, base) {
  const filters = [];
  if (base) filters.push(base);
  const type = (req.query.type || '').toString();
  if (TYPES.includes(type)) filters.push({ ticketType: type });
  const search = searchClause(req.query.q);
  if (search) filters.push(search);
  return filters.length ? { AND: filters } : {};
}

function take(req, fallback = 500) {
  const n = parseInt(req.query.take, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 2000) : fallback;
}

// Resolve a promise, or give up and return `fallback` after `ms`. Used so a
// slow third-party lookup can never hold a page open.
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise(resolve => setTimeout(() => resolve(fallback), ms)),
  ]);
}

// The ticket creator's Roblox identity (avatar, profile link, MET rank).
async function enrichCreator(ticket) {
  if (!ticket.creatorRobloxUsername) return null;
  const { getRobloxIdFromUsername, getGroupMembership, getRobloxAvatarHeadshot } = require('../lib/roblox');
  const r = await getRobloxIdFromUsername(ticket.creatorRobloxUsername);
  if (!r) return null;
  const [membership, avatar] = await Promise.all([
    getGroupMembership(r.id).catch(() => null),
    getRobloxAvatarHeadshot(r.id).catch(() => null),
  ]);
  return {
    robloxId:    r.id,
    username:    r.username,
    displayName: r.displayName,
    avatar,
    profileUrl:  `https://www.roblox.com/users/${r.id}/profile`,
    inGroup:     !!membership,
    groupRole:   membership?.role?.name ?? null,
    groupRank:   membership?.role?.rank ?? null,
  };
}

// ── GET /api/tickets — "My Tickets" (tickets I closed) ────────────
router.get('/', async (req, res) => {
  try {
    const tickets = await prisma.ticketLog.findMany({
      where:   buildWhere(req, mineClause(req.user)),
      orderBy: { closedAt: 'desc' },
      take:    take(req),
    });
    res.json(tickets);
  } catch (err) {
    console.error('[TicketLogs] list error:', err.message);
    res.status(500).json({ error: 'Failed to load ticket logs.' });
  }
});

// ── GET /api/tickets/all — every closed ticket ────────────────────
router.get('/all', async (req, res) => {
  try {
    const tickets = await prisma.ticketLog.findMany({
      where:   buildWhere(req, null),
      orderBy: { closedAt: 'desc' },
      take:    take(req, 1000),
    });
    res.json(tickets);
  } catch (err) {
    console.error('[TicketLogs] all error:', err.message);
    res.status(500).json({ error: 'Failed to load ticket logs.' });
  }
});

// ── GET /api/tickets/stats ────────────────────────────────────────
// `mine` powers the dashboard tiles; `total` the All Tickets header. `week`
// is how many the user closed in the last 7 days.
router.get('/stats', async (req, res) => {
  try {
    const mine = mineClause(req.user);
    const weekAgo = new Date(Date.now() - 7 * 86400000);
    const [total, mineCount, mineWeek, byType] = await Promise.all([
      prisma.ticketLog.count(),
      prisma.ticketLog.count({ where: mine }),
      prisma.ticketLog.count({ where: { AND: [mine, { closedAt: { gte: weekAgo } }] } }),
      prisma.ticketLog.groupBy({ by: ['ticketType'], _count: { _all: true } }).catch(() => []),
    ]);
    const types = {};
    for (const row of byType) types[row.ticketType] = row._count._all;
    res.json({ total, mine: mineCount, mineWeek, types });
  } catch (err) {
    console.error('[TicketLogs] stats error:', err.message);
    res.status(500).json({ error: 'Failed to fetch ticket stats.' });
  }
});

// ── POST /api/tickets/sync — force a re-scan (HICOMM / Developer) ─
router.post('/sync', requireHICOMM, async (req, res) => {
  try {
    const { getClient } = require('../lib/bot');
    const client = getClient();
    if (!client) return res.status(503).json({ error: 'The Discord bot is not connected yet — try again shortly.' });
    const { sweep } = require('../lib/ticketIngest');
    const stats = await sweep(client, { full: !!(req.body && req.body.full) });
    if (!stats) return res.status(409).json({ error: 'A sync is already running.' });
    if (stats.error) return res.status(502).json({ error: stats.error, ...stats });
    res.json(stats);
  } catch (err) {
    console.error('[TicketLogs] sync error:', err.message);
    res.status(500).json({ error: 'Failed to sync ticket logs.' });
  }
});

// ── GET /api/tickets/:id ──────────────────────────────────────────
// Registered last so it doesn't shadow /all, /stats or /sync.
router.get('/:id', async (req, res) => {
  try {
    const ticket = await prisma.ticketLog.findUnique({ where: { id: req.params.id } });
    if (!ticket) return res.status(404).json({ error: 'Ticket log not found.' });

    // Enrich the ticket's creator with their Roblox identity, the same way the
    // records lookup does, so the detail view can show who opened it. This is a
    // nicety, not the point of the page — so it is time-boxed: if Roblox is slow
    // or unreachable the ticket still opens instantly, just without the extras.
    const target = await withTimeout(enrichCreator(ticket), 2500, null);

    res.json({ ...ticket, target });
  } catch (err) {
    console.error('[TicketLogs] detail error:', err.message);
    res.status(500).json({ error: 'Failed to load ticket log.' });
  }
});

module.exports = router;
