// server/routes/tickets.js
const express = require('express');
const prisma  = require('../lib/db');
const { notifyStaff } = require('../lib/push');
const { requireHICOMM } = require('../middleware/auth');
const { getRobloxIdFromDiscord, getRobloxUserInfo, getRobloxIdFromUsername,
        getRobloxAvatarHeadshot, getGroupMembership } = require('../lib/roblox');
const { findMemberByUsername, matchTicketTranscript, parseRankNick, getRobloxNameFromNick } = require('../lib/bot');

const router = express.Router();

// Resolve any of: Roblox username / Roblox ID / Discord ID / Discord username
// into a canonical Roblox username. Falls back to the raw input on failure.
async function resolveToRobloxUsername(input) {
  const raw = (input || '').trim().replace(/^@/, '');
  if (!raw) return input;
  try {
    if (/^\d{17,20}$/.test(raw)) {                 // Discord ID
      const rid = await getRobloxIdFromDiscord(raw);
      if (rid) { const info = await getRobloxUserInfo(rid); if (info?.username) return info.username; }
    } else if (/^\d{1,16}$/.test(raw)) {           // Roblox ID
      const info = await getRobloxUserInfo(raw);
      if (info?.username) return info.username;
    } else {                                       // a username
      const r = await getRobloxIdFromUsername(raw);
      if (r?.username) return r.username;          // canonical Roblox username
      const m = await findMemberByUsername(raw);   // Discord username → RoVer → Roblox
      if (m) {
        const rid = await getRobloxIdFromDiscord(m.id);
        if (rid) { const info = await getRobloxUserInfo(rid); if (info?.username) return info.username; }
      }
    }
  } catch (e) { /* keep raw input */ }
  return input.trim();
}

// ── Helpers ──────────────────────────────────────────────────
async function nextTicketRef() {
  // Bump the counter (atomic) and build the candidate ref.
  let { count } = await prisma.ticketCounter.upsert({
    where:  { id: 1 },
    update: { count: { increment: 1 } },
    create: { id: 1, count: 1 },
  });
  let ref = `TKT-${String(count).padStart(4, '0')}`;

  // The IA site was cloned from this codebase, so its tickets use the SAME
  // TKT-#### scheme. Once IA_DATABASE_URL is set, iaSync imports those tickets,
  // which occupy TKT-#### refs while our counter is still low — so the candidate
  // ref can collide (a unique-constraint violation → "Failed to create ticket").
  // If it's taken, jump the counter PAST the highest TKT-#### currently in use
  // (native or imported) so creation never collides again.
  const taken = (r) => prisma.ticket.findUnique({ where: { ticketRef: r }, select: { id: true } }).then(Boolean).catch(() => false);
  if (await taken(ref)) {
    const rows = await prisma.ticket.findMany({ where: { ticketRef: { startsWith: 'TKT-' } }, select: { ticketRef: true } });
    let maxN = count;
    for (const row of rows) {
      const n = parseInt(String(row.ticketRef).replace(/^TKT-/i, ''), 10);
      if (Number.isFinite(n) && n > maxN) maxN = n;
    }
    count = maxN + 1;
    await prisma.ticketCounter.update({ where: { id: 1 }, data: { count } });
    ref = `TKT-${String(count).padStart(4, '0')}`;
    // Extremely defensive: never return a taken ref.
    if (await taken(ref)) ref = `TKT-${count}-${Math.random().toString(36).slice(2, 6)}`;
  }
  return ref;
}

// ── GET /api/tickets/my-roblox ─────────────────────────────────
// Returns the logged-in user's Roblox username via RoVer.
router.get('/my-roblox', async (req, res) => {
  try {
    const robloxId = await getRobloxIdFromDiscord(req.user.discordId);
    if (!robloxId) return res.json({ linked: false });

    const info = await getRobloxUserInfo(robloxId);
    res.json({ linked: true, robloxUsername: info?.username || null, robloxId });
  } catch (err) {
    console.error('[Tickets] my-roblox error:', err.message);
    res.json({ linked: false, error: err.message });
  }
});

// ── POST /api/tickets/import-transcript ─────────────────────────
// Autofill a ticket from a Tickety "View Transcript" link. Scans the recent
// closed-ticket logs, matches the transcript URL, and returns the fields to
// prefill the form: Roblox username (resolved from the creator), ticket type
// (from the ticket's original name), the close reason, and the log's timestamp.
router.post('/import-transcript', async (req, res) => {
  const link = (req.body?.transcriptLink || '').trim();
  if (!link) return res.status(400).json({ matched: false, error: 'A transcript link is required.' });

  try {
    const result = await matchTicketTranscript(link);
    if (!result.matched) {
      return res.status(404).json({ matched: false, error: result.error || 'No matching ticket log found.' });
    }
    const log = result.log;

    // Resolve the ticket creator → Roblox username, in order of confidence:
    //  1. The embed already shows a "RANK | RobloxUsername" nickname.
    //  2. Their server nickname ("RANK | RobloxUsername") looked up by Discord ID.
    //  3. Convert their Discord ID via RoVer (DB-first + cooldown-aware — the
    //     existing rate-limit-friendly path).
    //  4. Only then: Unverified/Unknown.
    let robloxUsername = null;
    if (log.creatorRaw && log.creatorRaw.includes('|')) {
      robloxUsername = parseRankNick(log.creatorRaw).robloxUsername || null;
    }
    if (!robloxUsername && log.creatorId) {
      try { robloxUsername = (await getRobloxNameFromNick(log.creatorId)) || null; } catch (e) { /* try RoVer next */ }
    }
    if (!robloxUsername && log.creatorId) {
      try {
        const rid = await getRobloxIdFromDiscord(log.creatorId);
        if (rid) { const info = await getRobloxUserInfo(rid); robloxUsername = info?.username || null; }
      } catch (e) { /* fall through to Unverified/Unknown */ }
    }
    if (!robloxUsername) robloxUsername = 'Unverified/Unknown';

    res.json({
      matched:        true,
      robloxUsername,
      ticketType:     log.ticketType || 'GENERAL_SUPPORT',
      conclusion:     log.reason || '',
      submittedAt:    log.sentAt || new Date().toISOString(),
      timezone:       'UTC',
      transcriptLink: log.transcriptUrl || link,
      meta: {
        ticketName:      log.effectiveName || log.ticketName || null,
        creatorId:       log.creatorId || null,
        creatorUsername: log.creatorUsername || null,
      },
    });
  } catch (err) {
    console.error('[Tickets] import-transcript error:', err.message);
    res.status(500).json({ matched: false, error: 'Failed to look up ticket transcript.' });
  }
});

// ── POST /api/tickets ──────────────────────────────────────
// Submit a new ticket.
router.post('/', async (req, res) => {
  const { robloxUsername, ticketType, submittedAt, timezone, conclusion, proofImages, transcriptLink } = req.body;

  if (!robloxUsername?.trim())  return res.status(400).json({ error: 'Roblox username is required.' });
  if (!ticketType)              return res.status(400).json({ error: 'Ticket type is required.' });
  if (!conclusion?.trim())      return res.status(400).json({ error: 'Conclusion is required.' });
  if (!transcriptLink?.trim())  return res.status(400).json({ error: 'Ticket transcript link is required.' });

  const validTypes = ['GENERAL_SUPPORT', 'HICOMM', 'OFFICER_REPORT', 'APPEAL'];
  if (!validTypes.includes(ticketType)) return res.status(400).json({ error: 'Invalid ticket type.' });

  // Validate proof images (max 10, each an image data-URI or http(s) URL). The
  // per-element check blocks stored-XSS payloads (e.g. a string that breaks out
  // of the <img src> attribute when the review modal renders it).
  if (proofImages && (!Array.isArray(proofImages) || proofImages.length > 10))
    return res.status(400).json({ error: 'Too many proof images (max 10).' });
  if (Array.isArray(proofImages) && proofImages.some(s =>
      typeof s !== 'string' || !/^(data:image\/(png|jpe?g|gif|webp);base64,|https?:\/\/)/i.test(s)))
    return res.status(400).json({ error: 'Proof images must be image data or http(s) URLs.' });

  try {
    const ticketRef = await nextTicketRef();
    const resolvedRoblox = await resolveToRobloxUsername(robloxUsername);

    const ticket = await prisma.ticket.create({
      data: {
        ticketRef,
        userId:        req.user.id,
        robloxUsername: resolvedRoblox,
        ticketType,
        submittedAt:   submittedAt || new Date().toISOString(),
        timezone:      timezone    || 'UTC',
        conclusion:    conclusion.trim(),
        transcriptLink: transcriptLink.trim(),
        proofImages:   proofImages || [],
      },
      include: { user: { select: { displayName: true, discordUsername: true } } },
    });

    const typeLabels = {
      GENERAL_SUPPORT: 'General Support', HICOMM: 'HICOMM',
      OFFICER_REPORT: 'Officer Report', APPEAL: 'Disciplinary Action Appeal',
    };
    notifyStaff({
      category: 'ticket',
      ticketType,
      title: `New Ticket — ${ticketRef}`,
      body:  `${resolvedRoblox} · ${typeLabels[ticketType] || ticketType}`,
      url:   `/ia/dashboard?page=ticket-review&ticket=${ticket.id}`,
    });

    res.status(201).json(ticket);
  } catch (err) {
    console.error('[Tickets] create error:', err.message);
    res.status(500).json({ error: 'Failed to create ticket.' });
  }
});

// ── GET /api/tickets/stats ───────────────────────────────────
// `pending` etc. are scoped to the user's OWN tickets (My Tickets badge).
// `pendingAll` is every pending ticket (the HICOMM "Pending Tickets" review badge).
router.get('/stats', async (req, res) => {
  try {
    const isElevated = ['HICOMM','SUPERVISOR','DEVELOPER'].includes(req.user.role);
    const own = { userId: req.user.id };
    const [total, pending, approved, denied, pendingAll] = await Promise.all([
      prisma.ticket.count({ where: own }),
      prisma.ticket.count({ where: { ...own, status: 'PENDING'  } }),
      prisma.ticket.count({ where: { ...own, status: 'APPROVED' } }),
      prisma.ticket.count({ where: { ...own, status: 'DENIED'   } }),
      isElevated ? prisma.ticket.count({ where: { status: 'PENDING' } }) : Promise.resolve(0),
    ]);
    res.json({ total, pending, approved, denied, pendingAll });
  } catch (err) {
    console.error('[Tickets] stats error:', err.message);
    res.status(500).json({ error: 'Failed to fetch ticket stats.' });
  }
});

// ── GET /api/tickets ───────────────────────────────────────
// "My Tickets" — always only the current user's own tickets (any role).
router.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    const where = { userId: req.user.id };
    if (status && ['PENDING', 'APPROVED', 'DENIED'].includes(status)) where.status = status;

    const tickets = await prisma.ticket.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { displayName: true, discordUsername: true, discordAvatar: true } } },
    });

    // Strip proof image data from list view (send count only)
    const safe = tickets.map(t => ({
      ...t,
      proofImages: undefined,
      proofCount: Array.isArray(t.proofImages) ? t.proofImages.length : 0,
    }));

    res.json(safe);
  } catch (err) {
    console.error('[Tickets] list error:', err.message);
    res.status(500).json({ error: 'Failed to load tickets.' });
  }
});

// ── GET /api/tickets/all ───────────────────────────────────
// Every ticket — readable by any authenticated user (IA + HICOMM).
// HICOMM-only actions (approve/deny) remain gated on their own endpoints.
router.get('/all', async (req, res) => {
  try {
    const { status } = req.query;
    const where = {};
    if (status && ['PENDING', 'APPROVED', 'DENIED'].includes(status)) where.status = status;

    const tickets = await prisma.ticket.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { displayName: true, discordUsername: true, discordAvatar: true } } },
    });

    const safe = tickets.map(t => ({
      ...t,
      proofImages: undefined,
      proofCount: Array.isArray(t.proofImages) ? t.proofImages.length : 0,
    }));

    res.json(safe);
  } catch (err) {
    console.error('[Tickets] all error:', err.message);
    res.status(500).json({ error: 'Failed to load tickets.' });
  }
});

// ── GET /api/tickets/:id ───────────────────────────────────
// Get a single ticket with full proof images.
router.get('/:id', async (req, res) => {
  try {
    const ticket = await prisma.ticket.findUnique({
      where:   { id: req.params.id },
      include: { user: { select: { displayName: true, discordUsername: true } } },
    });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });

    // Any authenticated IA member can view a ticket's detail — the All Tickets
    // tab lists everyone's tickets and is meant to be clickable. Acting on a
    // ticket (approve/deny) stays gated on its own HICOMM-only endpoints.

    // Attach reviewer display name if the ticket has been decided
    let reviewer = null;
    if (ticket.reviewedBy) {
      reviewer = await prisma.user.findUnique({
        where:  { id: ticket.reviewedBy },
        select: { displayName: true, discordUsername: true },
      });
    }
    // IA-synced tickets store an IA users.id in reviewedBy that isn't in the MET
    // DB, so the lookup misses — label it rather than dropping the "Reviewed By"
    // row on a ticket that plainly carries a decision date.
    if (!reviewer && ticket.reviewedAt) reviewer = { displayName: 'Internal Affairs', discordUsername: null };

    // Resolve the target Roblox user for richer detail (non-fatal on failure)
    let target = null;
    try {
      const r = await getRobloxIdFromUsername(ticket.robloxUsername);
      if (r) {
        const [membership, avatar] = await Promise.all([
          getGroupMembership(r.id),
          getRobloxAvatarHeadshot(r.id),
        ]);
        target = {
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
    } catch (e) {
      console.error('[Tickets] target resolve error:', e.message);
    }

    res.json({ ...ticket, reviewer, target });
  } catch (err) {
    console.error('[Tickets] detail error:', err.message);
    res.status(500).json({ error: 'Failed to load ticket.' });
  }
});

// ── PATCH /api/tickets/:id/approve ────────────────────────────
router.patch('/:id/approve', requireHICOMM, async (req, res) => {
  try {
    const existing = await prisma.ticket.findUnique({ where: { id: req.params.id } });
    if (!existing)                     return res.status(404).json({ error: 'Ticket not found.' });
    if (existing.status !== 'PENDING') return res.status(409).json({ error: 'Ticket is not pending.' });
    // You can't review (and self-award quota for) your own ticket. Developers
    // are exempt so they can test the review flow end-to-end.
    if (existing.userId === req.user.id && req.user.role !== 'DEVELOPER')
      return res.status(403).json({ error: 'You cannot review your own ticket.' });
    // IA Complaints (HICOMM tickets) are a High Command matter — Supervisors
    // (and IA, already blocked by requireHICOMM) cannot action them.
    if (existing.ticketType === 'HICOMM' && req.user.role === 'SUPERVISOR')
      return res.status(403).json({ error: 'Only HICOMM can action IA Complaint (HICOMM) tickets.' });

    const updated = await prisma.ticket.update({
      where: { id: req.params.id },
      data:  { status: 'APPROVED', reviewedBy: req.user.id, reviewedAt: new Date() },
    });

    // +2 quota points for the IA member who logged the ticket
    try {
      const submitter = await prisma.user.findUnique({
        where:  { id: existing.userId },
        select: { discordId: true, robloxUsername: true },
      });
      if (submitter) {
        // If robloxUsername isn't cached, do a live RoVer lookup so the sheet
        // can match by username even when there's no Discord ID column.
        let robloxUsername = submitter.robloxUsername;
        if (!robloxUsername && submitter.discordId) {
          try {
            const { getRobloxIdFromDiscord, getRobloxUserInfo } = require('../lib/roblox');
            const rbxId = await getRobloxIdFromDiscord(submitter.discordId);
            if (rbxId) {
              const info = await getRobloxUserInfo(rbxId);
              robloxUsername = info?.username || null;
              // Cache it for next time
              if (robloxUsername) {
                await prisma.user.update({
                  where: { id: existing.userId },
                  data:  { robloxId: rbxId, robloxUsername },
                }).catch(() => {});
              }
            }
          } catch (rvErr) {
            console.warn('[Tickets] RoVer lookup for quota failed:', rvErr.message);
          }
        }
        // Queue the award durably so it's retried until it lands — never lost
        // to a transient failure or a rapid approve burst.
        const { enqueueQuotaAward } = require('../lib/quota');
        await enqueueQuotaAward({
          refType: 'ticket', refId: existing.id,
          discordId: submitter.discordId, robloxUsername,
          points: 2, label: `ticket ${existing.ticketRef}`,
        }).catch(err => { console.warn('[Tickets] quota enqueue error:', err.message); });
      }
    } catch (e) { console.warn('[Tickets] quota award skipped:', e.message); }

    res.json(updated);
  } catch (err) {
    console.error('[Tickets] approve error:', err.message);
    res.status(500).json({ error: 'Failed to approve ticket.' });
  }
});

// ── PATCH /api/tickets/:id/deny ──────────────────────────────
router.patch('/:id/deny', requireHICOMM, async (req, res) => {
  try {
    const existing = await prisma.ticket.findUnique({ where: { id: req.params.id } });
    if (!existing)                     return res.status(404).json({ error: 'Ticket not found.' });
    if (existing.status !== 'PENDING') return res.status(409).json({ error: 'Ticket is not pending.' });
    if (existing.userId === req.user.id && req.user.role !== 'DEVELOPER')
      return res.status(403).json({ error: 'You cannot review your own ticket.' });
    if (existing.ticketType === 'HICOMM' && req.user.role === 'SUPERVISOR')
      return res.status(403).json({ error: 'Only HICOMM can action IA Complaint (HICOMM) tickets.' });

    const updated = await prisma.ticket.update({
      where: { id: req.params.id },
      data:  { status: 'DENIED', reviewedBy: req.user.id, reviewedAt: new Date() },
    });
    res.json(updated);
  } catch (err) {
    console.error('[Tickets] deny error:', err.message);
    res.status(500).json({ error: 'Failed to deny ticket.' });
  }
});

module.exports = router;
// Exposed so the support-desk auto-ticket-log path reuses the SAME collision-safe
// ref allocation (survives IA-import TKT-#### collisions) instead of a raw counter.
module.exports.nextTicketRef = nextTicketRef;
