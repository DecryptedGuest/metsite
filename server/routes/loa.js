// server/routes/loa.js — Leave of Absence requests
// Mounted at /api/loa behind requireAuth. Any MET member can request an LOA for
// MET or for a division they belong to; it forwards to the MET HICOMM (MET
// scope) or the divisional HICOMM (division scope) for review. LOA roles come
// later — for now this is request → forward → approve/deny with an audit trail.
const express = require('express');
const prisma  = require('../lib/db');
const audit   = require('../lib/audit');
const {
  userDivisions, userIsDivisionLead, userIsMetHicommCached,
} = require('../middleware/division');

const router = express.Router();

const DIV_NAME = { MET: 'MET', CID: 'CID', SCO19: 'SCO-19', FLP: 'FLP', HPC: 'HPC', IA: 'Internal Affairs' };

// Divisions this user could request an LOA for (their divisions + MET).
function requestableScopes(user) {
  const set = new Set(['MET']);
  userDivisions(user).forEach(d => { if (d && d.division && d.division !== 'MET') set.add(d.division); });
  return [...set];
}

// Can this user review a request of the given scope/division?
function canReview(user, r) {
  if (user.role === 'DEVELOPER' || userIsMetHicommCached(user)) return true; // MET HICOMM oversee all
  if (r.scope === 'DIVISION' && r.division) return userIsDivisionLead(user, r.division);
  return false; // MET-scope needs MET HICOMM
}

function serialize(r) {
  return {
    id: r.id, userId: r.userId, userName: r.userName, scope: r.scope, division: r.division,
    reason: r.reason, startAt: r.startAt, endAt: r.endAt, status: r.status,
    forwardedTo: r.forwardedTo, reviewerName: r.reviewerName, reviewNote: r.reviewNote,
    reviewedAt: r.reviewedAt, createdAt: r.createdAt,
  };
}

// GET /api/loa/context — what the current user can request/review.
router.get('/context', (req, res) => {
  const reviewDivisions = ['CID', 'SCO19', 'FLP', 'HPC', 'IA'].filter(d => userIsDivisionLead(req.user, d) && !userIsMetHicommCached(req.user) && req.user.role !== 'DEVELOPER');
  res.json({
    scopes: requestableScopes(req.user),
    scopeNames: DIV_NAME,
    canReviewMet: req.user.role === 'DEVELOPER' || userIsMetHicommCached(req.user),
    reviewDivisions,
  });
});

// POST /api/loa — create a request.
router.post('/', async (req, res) => {
  try {
    const { scope, division, reason, startAt, endAt } = req.body || {};
    const sc = String(scope || '').toUpperCase() === 'MET' ? 'MET' : 'DIVISION';
    const div = sc === 'DIVISION' ? String(division || '').toUpperCase() : null;
    if (sc === 'DIVISION' && !div) return res.status(400).json({ error: 'Division required for a divisional LOA.' });
    if (sc === 'DIVISION' && !requestableScopes(req.user).includes(div)) {
      return res.status(403).json({ error: 'You can only request an LOA for a division you belong to.' });
    }
    const start = new Date(startAt), end = new Date(endAt);
    if (isNaN(start) || isNaN(end)) return res.status(400).json({ error: 'Valid start and end dates are required.' });
    if (end <= start) return res.status(400).json({ error: 'End date must be after the start date.' });

    const forwardedTo = sc === 'MET' ? 'MET HICOMM' : `${DIV_NAME[div] || div} HICOMM`;
    const created = await prisma.loaRequest.create({
      data: {
        userId: req.user.id, userName: req.user.displayName || req.user.discordUsername,
        scope: sc, division: div, reason: reason ? String(reason).slice(0, 1000) : null,
        startAt: start, endAt: end, status: 'PENDING', forwardedTo,
      },
    });

    audit.record({
      req, action: 'LOA_REQUEST', category: 'ACCESS', targetType: 'loa', targetId: created.id,
      division: div || 'MET',
      summary: `${req.user.displayName || req.user.discordUsername} requested a ${sc === 'MET' ? 'MET' : DIV_NAME[div] || div} LOA (→ ${forwardedTo})`,
    });

    // Best-effort ping to the reviewing HICOMM via a webhook, if configured.
    try {
      const url = process.env.LOA_WEBHOOK_URL;
      if (url) {
        const fetch = require('node-fetch');
        await fetch(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ embeds: [{
            title: `New LOA request — ${forwardedTo}`,
            color: 0x3b82f6,
            fields: [
              { name: 'Member', value: created.userName || req.user.discordUsername, inline: true },
              { name: 'Scope', value: sc === 'MET' ? 'MET' : (DIV_NAME[div] || div), inline: true },
              { name: 'Dates', value: `${start.toDateString()} → ${end.toDateString()}`, inline: false },
              ...(reason ? [{ name: 'Reason', value: String(reason).slice(0, 900), inline: false }] : []),
            ],
          }] }),
        }).catch(() => {});
      }
    } catch (e) { /* non-fatal */ }

    res.json({ ok: true, request: serialize(created) });
  } catch (e) {
    console.error('[LOA] create failed:', e.message);
    res.status(500).json({ error: 'Failed to submit LOA request' });
  }
});

// GET /api/loa/mine — the requester's own LOA requests.
router.get('/mine', async (req, res) => {
  try {
    const rows = await prisma.loaRequest.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: 'desc' }, take: 50 });
    res.json(rows.map(serialize));
  } catch (e) { res.status(500).json({ error: 'Failed to load your LOA requests' }); }
});

// GET /api/loa/review — pending requests the current user may review.
router.get('/review', async (req, res) => {
  try {
    const isMet = req.user.role === 'DEVELOPER' || userIsMetHicommCached(req.user);
    let where;
    if (isMet) {
      where = {}; // MET HICOMM see everything
    } else {
      const divs = ['CID', 'SCO19', 'FLP', 'HPC', 'IA'].filter(d => userIsDivisionLead(req.user, d));
      if (!divs.length) return res.json([]); // not a reviewer
      where = { scope: 'DIVISION', division: { in: divs } };
    }
    const rows = await prisma.loaRequest.findMany({
      // Never surface the reviewer's own requests in their review queue.
      where: { ...where, userId: { not: req.user.id }, ...(req.query.status ? { status: String(req.query.status).toUpperCase() } : {}) },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }], take: 100,
    });
    res.json(rows.map(serialize));
  } catch (e) {
    console.error('[LOA] review load failed:', e.message);
    res.status(500).json({ error: 'Failed to load LOA review queue' });
  }
});

// POST /api/loa/:id/decision { action: 'approve'|'deny', note }
router.post('/:id/decision', async (req, res) => {
  try {
    const r = await prisma.loaRequest.findUnique({ where: { id: req.params.id } });
    if (!r) return res.status(404).json({ error: 'Request not found' });
    // Segregation of duties: a reviewer must not decide their own request, even
    // if they lead the scope. They can withdraw it via /cancel instead.
    if (r.userId === req.user.id) return res.status(403).json({ error: 'You cannot review your own LOA request.' });
    if (!canReview(req.user, r)) return res.status(403).json({ error: 'You cannot review this LOA request.' });
    if (r.status !== 'PENDING') return res.status(400).json({ error: 'This request has already been decided.' });
    const action = String((req.body && req.body.action) || '').toLowerCase();
    if (!['approve', 'deny'].includes(action)) return res.status(400).json({ error: 'action must be approve or deny' });

    const updated = await prisma.loaRequest.update({
      where: { id: r.id },
      data: {
        status: action === 'approve' ? 'APPROVED' : 'DENIED',
        reviewerId: req.user.id, reviewerName: req.user.displayName || req.user.discordUsername,
        reviewNote: req.body && req.body.note ? String(req.body.note).slice(0, 1000) : null,
        reviewedAt: new Date(),
      },
    });
    audit.record({
      req, action: `LOA_${action === 'approve' ? 'APPROVE' : 'DENY'}`, category: 'ACCESS',
      targetType: 'loa', targetId: r.id, division: r.division || 'MET',
      summary: `${action === 'approve' ? 'Approved' : 'Denied'} ${r.userName || 'a member'}'s ${r.scope === 'MET' ? 'MET' : (DIV_NAME[r.division] || r.division)} LOA`,
    });
    // Notify the requester in-page (best-effort).
    try { require('../lib/events').publishToUser(r.userId, 'loa_decided', { status: updated.status, message: `Your LOA request was ${updated.status.toLowerCase()}.` }); } catch (e) {}
    res.json({ ok: true, request: serialize(updated) });
  } catch (e) {
    console.error('[LOA] decision failed:', e.message);
    res.status(500).json({ error: 'Failed to record decision' });
  }
});

// POST /api/loa/:id/cancel — requester withdraws a pending request.
router.post('/:id/cancel', async (req, res) => {
  try {
    const r = await prisma.loaRequest.findUnique({ where: { id: req.params.id } });
    if (!r) return res.status(404).json({ error: 'Request not found' });
    if (r.userId !== req.user.id) return res.status(403).json({ error: 'Not your request.' });
    if (r.status !== 'PENDING') return res.status(400).json({ error: 'Only pending requests can be cancelled.' });
    const updated = await prisma.loaRequest.update({ where: { id: r.id }, data: { status: 'CANCELLED' } });
    res.json({ ok: true, request: serialize(updated) });
  } catch (e) { res.status(500).json({ error: 'Failed to cancel request' }); }
});

module.exports = router;
