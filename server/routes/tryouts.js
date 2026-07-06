// server/routes/tryouts.js — public-facing tryout view (MET-wide).
// Mounted at /api/tryouts behind requireAuth. British citizens see upcoming +
// live tryouts and can join the live one directly. Gated to the British-citizen
// Discord role when BRITISH_CITIZEN_ROLE_ID is set; until then, any signed-in
// user can see them (so the feature works before the role id is provided).
const express = require('express');
const jwt     = require('jsonwebtoken');
const prisma  = require('../lib/db');
const audit   = require('../lib/audit');

const router = express.Router();

function britishCitizenRoleId() { return process.env.BRITISH_CITIZEN_ROLE_ID || null; }

function canSeeTryouts(user) {
  if (user.role === 'DEVELOPER') return true;
  const roleId = britishCitizenRoleId();
  if (!roleId) return true; // not configured yet → visible to all signed-in users
  const ids = Array.isArray(user.metRoleIds) ? user.metRoleIds : [];
  return ids.includes(roleId);
}

// Signed, short-lived, per-user join token. The raw private-server link is never
// sent to the browser; instead the client gets a /join redirect URL carrying
// this token. It is bound to one user + one tryout and expires in 2 minutes, so
// a copied link can't be shared or reused later.
const JOIN_TTL_SECONDS = 900;
function signJoinToken(tryoutId, userId) {
  return jwt.sign(
    { tid: tryoutId, uid: userId, purpose: 'tryout_join' },
    process.env.JWT_SECRET,
    { expiresIn: JOIN_TTL_SECONDS }
  );
}

// GET /api/tryouts/upcoming — live now + scheduled ahead.
router.get('/upcoming', async (req, res) => {
  if (!canSeeTryouts(req.user)) return res.json({ eligible: false, live: [], upcoming: [] });
  try {
    const [live, upcoming] = await Promise.all([
      prisma.tryout.findMany({ where: { status: 'LIVE' }, orderBy: { scheduledAt: 'desc' }, take: 20 }),
      prisma.tryout.findMany({
        where: { status: 'SCHEDULED', scheduledAt: { gte: new Date(Date.now() - 5 * 60 * 1000) } },
        orderBy: { scheduledAt: 'asc' }, take: 20,
      }),
    ]);
    const pub = (t) => ({
      id: t.id, hostName: t.hostName, coHostName: t.coHostName,
      scheduledAt: t.scheduledAt, status: t.status, lockState: t.lockState,
      // Only expose a join path once live, and only as a signed redirect URL —
      // never the raw private-server link.
      joinLink: (t.status === 'LIVE' && t.privateServerLink)
        ? `/api/tryouts/${t.id}/join?token=${encodeURIComponent(signJoinToken(t.id, req.user.id))}`
        : null,
    });
    res.json({ eligible: true, live: live.map(pub), upcoming: upcoming.map(pub) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load tryouts' });
  }
});

// GET /api/tryouts/:id/join?token=... — verify the signed token, re-check
// eligibility, then redirect to the real private-server link. This is the only
// place the raw link is revealed, and only to the specific user it was issued
// to, within the short token window.
router.get('/:id/join', async (req, res) => {
  const fail = (msg) => res.status(403).type('html').send(
    `<!doctype html><meta charset="utf-8"><title>Join link expired</title>` +
    `<body style="font-family:system-ui;background:#0a0c12;color:#e6e9ef;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center">` +
    `<div><h1 style="font-size:20px">${msg}</h1><p style="color:#9aa3b2">Return to your dashboard and click Join again to get a fresh link.</p>` +
    `<a href="/dashboard" style="color:#4a8fff">Back to dashboard</a></div></body>`
  );
  try {
    let payload;
    try {
      payload = jwt.verify(String(req.query.token || ''), process.env.JWT_SECRET);
    } catch (e) {
      return fail('This join link has expired.');
    }
    if (payload.purpose !== 'tryout_join' || payload.tid !== req.params.id || payload.uid !== req.user.id) {
      return fail('This join link isn’t valid for your account.');
    }
    if (!canSeeTryouts(req.user)) return fail('You’re not eligible to join this tryout.');

    const t = await prisma.tryout.findUnique({ where: { id: req.params.id } });
    if (!t || t.status !== 'LIVE' || !t.privateServerLink) {
      return fail('This tryout isn’t live right now.');
    }

    audit.record({
      req, action: 'TRYOUT_JOIN', category: 'tryout', targetType: 'tryout', targetId: t.id,
      summary: `Joined the live tryout hosted by ${t.hostName}`,
    });
    return res.redirect(t.privateServerLink);
  } catch (err) {
    return fail('Something went wrong opening this tryout.');
  }
});

module.exports = router;
