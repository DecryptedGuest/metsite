// server/routes/tickets.js
// Closed-ticket logs, mirrored from the IA ticket-logs Discord channel.
//
// Nobody logs a ticket on the site. Rows arrive automatically from Discord via
// lib/ticketIngest.js — but a supervisor still SIGNS THEM OFF here, which is the
// one thing that isn't read-only. Approving a ticket log awards the investigator
// who CLOSED it 2 quota points (an approved case is worth 4).
//
//   GET  /api/tickets            → tickets the current user closed ("My Tickets")
//   GET  /api/tickets/all        → every closed ticket ("All Tickets")
//   GET  /api/tickets/stats      → counts for the dashboard + nav
//   GET  /api/tickets/:id        → one ticket log
//   POST /api/tickets/sync       → force a re-scan of the log channel (HICOMM+)
//   POST /api/tickets/:id/review → approve / deny a ticket log (Supervisor+)

const express = require('express');
const prisma  = require('../lib/db');
const { requireHICOMMStrict, requireHICOMM } = require('../middleware/auth');

const router = express.Router();

const TYPES    = ['GENERAL_SUPPORT', 'HICOMM', 'OFFICER_REPORT', 'APPEAL'];
const STATUSES = ['PENDING', 'APPROVED', 'DENIED'];

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
  const status = (req.query.status || '').toString().toUpperCase();
  if (STATUSES.includes(status)) filters.push({ status });
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
    const [total, mineCount, mineWeek, byType, byStatus, pending] = await Promise.all([
      prisma.ticketLog.count(),
      prisma.ticketLog.count({ where: mine }),
      prisma.ticketLog.count({ where: { AND: [mine, { closedAt: { gte: weekAgo } }] } }),
      prisma.ticketLog.groupBy({ by: ['ticketType'], _count: { _all: true } }).catch(() => []),
      prisma.ticketLog.groupBy({ by: ['status'], _count: { _all: true } }).catch(() => []),
      prisma.ticketLog.count({ where: { status: 'PENDING' } }).catch(() => 0),
    ]);
    const types = {};
    for (const row of byType) types[row.ticketType] = row._count._all;
    const statuses = { PENDING: 0, APPROVED: 0, DENIED: 0 };
    for (const row of byStatus) statuses[row.status] = row._count._all;
    res.json({ total, mine: mineCount, mineWeek, types, statuses, pending });
  } catch (err) {
    console.error('[TicketLogs] stats error:', err.message);
    res.status(500).json({ error: 'Failed to fetch ticket stats.' });
  }
});

// ── POST /api/tickets/sync — force a re-scan (HICOMM / Developer) ─
// Strict: matches the button, which is hicomm-strict-only in the UI.
router.post('/sync', requireHICOMMStrict, async (req, res) => {
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

// ── POST /api/tickets/clear-backlog — clear the queue ─────────────
// Nine thousand logs nobody was ever going to work through is a wall, not a
// queue. Everything waiting gets closed off as APPROVED and marked as a backlog
// clear rather than a decision — the rows stay, they keep their full history in
// All Tickets, they simply stop being somebody's decision to make. No points
// are awarded: nobody reviewed these, so nobody earned anything.
//
// This request is deliberately BOUNDED. It clears a slice and reports how many
// are left, and the caller comes back for the next one. The previous version
// tried the whole queue in one statement and one request, which at this size is
// long enough for a pooler or a proxy to kill it — the write rolled back and
// the button appeared to do nothing at all.
//
//   { }                       → dry run: how many are waiting
//   { apply: true }           → clear a slice, report `remaining`
//   { apply: true, all: true} → ignore the date cutoff (strays included)
router.post('/clear-backlog', requireHICOMMStrict, async (req, res) => {
  const body = req.body || {};
  try {
    const cutoff = body.before ? new Date(body.before) : new Date();
    if (isNaN(cutoff.getTime())) return res.status(400).json({ error: 'That is not a date.' });

    // `all` also decides what we COUNT, or the dry run would promise a number
    // the apply then disagrees with.
    const where = body.all === true
      ? { status: 'PENDING' }
      : { status: 'PENDING', closedAt: { lt: cutoff } };

    if (body.apply !== true) {
      const [waiting, total, blank] = await Promise.all([
        prisma.ticketLog.count({ where }),
        prisma.ticketLog.count({ where: { status: 'PENDING' } }),
        prisma.ticketLog.count({ where: { OR: [{ closerUsername: null }, { closerUsername: '' }] } }),
      ]);
      return res.json({
        dryRun: true, wouldClear: waiting, pendingTotal: total,
        // Rows the cutoff would strand — a ticket dated in the future is never
        // "before now", so without saying so it would sit there unexplained.
        strandedByDate: Math.max(0, total - waiting),
        blankHandlers: blank, before: cutoff,
      });
    }

    const { clearBacklogBefore, backfillHandlers } = require('../lib/ticketIngest');
    const out = await clearBacklogBefore(cutoff, {
      all: body.all === true,
      batch: body.batch,
      // One request's worth. Enough that a normal queue goes in a single press,
      // small enough that the statement can never be the slow thing.
      maxRows: body.maxRows || 3000,
    });

    // The handler repair is per-row and can involve a Discord fetch each, so it
    // is capped hard and never allowed to refetch here — the sweep picks up the
    // rest a few at a time in the background.
    let handlers = { fixed: 0, stillBlank: 0, checked: 0 };
    try {
      handlers = await backfillHandlers(150, { refetch: false });
    } catch (e) {
      console.warn('[TicketLogs] handler repair skipped during clear:', e.message);
    }

    // The TRUE pending count, not just what this filter matched. A clear that
    // reports "0 cleared" while nine thousand rows are still pending is telling
    // you something, and the old response had no way to say it.
    const pendingTotal = await prisma.ticketLog.count({ where: { status: 'PENDING' } });

    // When nothing moved but rows remain, say why rather than shrugging.
    let diagnosis = null;
    if (!out.cleared && pendingTotal > 0) {
      const [future, sample] = await Promise.all([
        prisma.ticketLog.count({ where: { status: 'PENDING', closedAt: { gte: new Date() } } }),
        prisma.ticketLog.findFirst({
          where: { status: 'PENDING' }, orderBy: { closedAt: 'asc' },
          select: { id: true, ticketNo: true, closedAt: true, status: true, messageId: true },
        }),
      ]);
      diagnosis = {
        pendingTotal, matchedByFilter: 0, datedInTheFuture: future,
        oldestPending: sample,
        why: body.all === true
          ? 'Rows are pending but the update matched none of them. This is not a filter problem — check the server log for the failing statement.'
          : `The date cutoff excluded them. ${future} pending ticket(s) are dated in the future. Retry with "all".`,
      };
      console.warn('[TicketLogs] backlog clear moved nothing:', JSON.stringify(diagnosis));
    }

    console.log(`[TicketLogs] backlog clear by ${req.user.displayName || req.user.discordUsername} — `
      + `${out.cleared} cleared, ${out.remaining} left (${pendingTotal} pending overall), `
      + `${handlers.fixed} handler(s) filled in`);
    res.json({ dryRun: false, ...out, pendingTotal, diagnosis, handlers, before: cutoff });
  } catch (err) {
    console.error('[TicketLogs] backlog clear error:', err.message);
    res.status(500).json({ error: 'Failed to clear the backlog: ' + err.message });
  }
});

// ── POST /api/tickets/backfill-handlers ───────────────────────────
// Fill in the handler on any row that has none, without touching status.
router.post('/backfill-handlers', requireHICOMMStrict, async (req, res) => {
  try {
    const { backfillHandlers } = require('../lib/ticketIngest');
    const out = await backfillHandlers();
    res.json(out);
  } catch (err) {
    console.error('[TicketLogs] handler backfill error:', err.message);
    res.status(500).json({ error: 'Failed to fill in the handlers.' });
  }
});

// ── POST /api/tickets/:id/review — approve / deny a ticket log ────
// Body: { action: 'approve' | 'deny' }
//
// This is the ONLY write on a ticket. It records a supervisor's decision on a
// log that was ingested from Discord — it does not create, edit or delete the
// log. Approving one awards TICKET_POINTS (2) to the investigator who closed
// the ticket; denying one awards nothing.
router.post('/:id/review', requireHICOMM, async (req, res) => {
  const action = ((req.body && req.body.action) || '').toString().toLowerCase();
  if (!['approve', 'deny'].includes(action)) {
    return res.status(400).json({ error: "action must be 'approve' or 'deny'." });
  }
  const status = action === 'approve' ? 'APPROVED' : 'DENIED';
  try {
    const ticket = await prisma.ticketLog.findUnique({ where: { id: req.params.id } });
    if (!ticket) return res.status(404).json({ error: 'Ticket log not found.' });

    // A supervisor can't sign off a ticket they closed themselves.
    const own = ticket.closerUserId === req.user.id ||
      (req.user.discordId && ticket.closerDiscordId &&
       String(ticket.closerDiscordId) === String(req.user.discordId));
    if (own && req.user.role !== 'DEVELOPER') {
      return res.status(403).json({ error: 'You cannot review a ticket you closed.' });
    }

    const updated = await prisma.ticketLog.update({
      where: { id: ticket.id },
      data: {
        status,
        reviewedById:   req.user.id,
        reviewedByName: req.user.displayName || req.user.discordUsername,
        reviewedAt:     new Date(),
      },
    });

    // +2 quota points for the investigator who closed the ticket. Queued
    // durably and keyed on the ticket id, so re-approving (or a retry) can never
    // double-award — and a later deny simply leaves the existing award alone
    // rather than clawing it back.
    if (status === 'APPROVED' && (ticket.closerDiscordId || ticket.closerUserId)) {
      const { enqueueQuotaAward, TICKET_POINTS } = require('../lib/quota');
      let closer = null;
      if (ticket.closerUserId) {
        closer = await prisma.user.findUnique({
          where:  { id: ticket.closerUserId },
          select: { discordId: true, robloxUsername: true },
        }).catch(() => null);
      }
      const discordId = (closer && closer.discordId) || ticket.closerDiscordId || null;
      if (discordId) {
        enqueueQuotaAward({
          refType: 'ticket', refId: ticket.id,
          discordId,
          // Only the matched site account's Roblox name — NEVER
          // creatorRobloxUsername, which is the person who OPENED the ticket.
          // With no Roblox name the sheet still matches on the Discord id.
          robloxUsername: (closer && closer.robloxUsername) || null,
          points: TICKET_POINTS(),
          label: `ticket ${ticket.ticketRef || ticket.ticketName || ticket.id}`,
        }).catch(() => {});
      }
    }

    require('../lib/audit').record({
      req, action: status === 'APPROVED' ? 'TICKET_APPROVE' : 'TICKET_DENY',
      category: 'ia', targetType: 'ticketLog', targetId: ticket.id,
      summary: `${status === 'APPROVED' ? 'Approved' : 'Denied'} ticket ${ticket.ticketRef || ticket.ticketName || ticket.id}`
             + (status === 'APPROVED' ? ` (+${require('../lib/quota').TICKET_POINTS()} pts)` : ''),
    });

    res.json(updated);
  } catch (err) {
    console.error('[TicketLogs] review error:', err.message);
    res.status(500).json({ error: 'Failed to record the decision.' });
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
