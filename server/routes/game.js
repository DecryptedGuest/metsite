// server/routes/game.js
// Callbacks from the Roblox game(s) — NOT behind requireAuth (the game isn't a
// logged-in user). Every request is authenticated with a shared secret in the
// `x-game-secret` header (or `secret` body field), compared to TRYOUT_GAME_SECRET.
//
// Right now this carries the live tryout server-lock state: when an admin runs
// `:serverlock on/off` (Adonis) in the Hendon Police Campus game, the game POSTs
// here and we update the tryout's lock state + re-render its Discord announcement
// in real time.
const express = require('express');
const prisma  = require('../lib/db');

const router = express.Router();

function gameSecret() { return process.env.TRYOUT_GAME_SECRET || null; }

// Timing-safe-ish shared-secret check. If no secret is configured the endpoint
// is disabled (503) rather than open, so it can never be hit unauthenticated.
function requireGameSecret(req, res, next) {
  const configured = gameSecret();
  if (!configured) return res.status(503).json({ error: 'Game callback not configured (set TRYOUT_GAME_SECRET).' });
  const provided = req.get('x-game-secret') || (req.body && req.body.secret) || '';
  if (String(provided) !== String(configured)) return res.status(401).json({ error: 'Bad game secret.' });
  next();
}

// Resolve which tryout the callback refers to:
//   1. explicit tryoutId, else
//   2. the LIVE tryout whose privateServerId matches, else
//   3. the single most-recent LIVE tryout (the common case: one live at a time).
async function resolveTargetTryout({ tryoutId, privateServerId }) {
  if (tryoutId) return prisma.tryout.findUnique({ where: { id: String(tryoutId) } });
  if (privateServerId) {
    const t = await prisma.tryout.findFirst({
      where: { status: 'LIVE', privateServerId: String(privateServerId) },
      orderBy: { serverCreatedAt: 'desc' },
    });
    if (t) return t;
  }
  return prisma.tryout.findFirst({ where: { status: 'LIVE' }, orderBy: { scheduledAt: 'desc' } });
}

// POST /api/game/serverlock  { locked: bool, tryoutId?|privateServerId? }
// Sets the live tryout's server-lock state and updates its Discord announcement.
router.post('/serverlock', requireGameSecret, async (req, res) => {
  try {
    const body = req.body || {};
    // Accept a few shapes so the in-game HTTP call is easy: locked / lock /
    // state ("on"/"off"/"locked"/"unlocked").
    let locked;
    if (typeof body.locked === 'boolean') locked = body.locked;
    else if (typeof body.lock === 'boolean') locked = body.lock;
    else {
      const s = String(body.locked ?? body.lock ?? body.state ?? '').toLowerCase();
      locked = ['on', 'true', 'locked', 'lock', '1', 'yes'].includes(s);
    }

    const target = await resolveTargetTryout({ tryoutId: body.tryoutId, privateServerId: body.privateServerId });
    if (!target) return res.status(404).json({ error: 'No matching live tryout to update.' });

    const lockState = locked ? 'LOCKED' : 'UNLOCKED';
    const updated = await prisma.tryout.update({ where: { id: target.id }, data: { lockState } });

    // Re-render the Discord announcement in place (best-effort).
    try {
      const { editTryoutAnnouncement } = require('../lib/bot');
      if (typeof editTryoutAnnouncement === 'function') await editTryoutAnnouncement(updated);
    } catch (e) { /* announcement update is best-effort */ }

    res.json({ ok: true, id: updated.id, lockState });
  } catch (err) {
    console.error('[Game] serverlock callback failed:', err.message);
    res.status(500).json({ error: 'Failed to update server lock.' });
  }
});

module.exports = router;
