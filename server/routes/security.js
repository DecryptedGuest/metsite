// server/routes/security.js
// Records client-side capture/screenshot detection events.
const express  = require('express');
const prisma   = require('../lib/db');
const { getClientIp } = require('../middleware/visit');

const router = express.Router();

const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n) : null);

// ── POST /api/security/capture ────────────────────────────────────
// Body: { method, details, page, os, browser, device, userAgent, screenInfo, language }
router.post('/capture', async (req, res) => {
  try {
    const b  = req.body || {};
    const ip = getClientIp(req);

    await prisma.captureLog.create({
      data: {
        method:          clip(b.method, 120) || 'Unknown',
        details:         clip(b.details, 500),
        page:            clip(b.page, 300),
        os:              clip(b.os, 120),
        browser:         clip(b.browser, 120),
        device:          clip(b.device, 120),
        userAgent:       clip(b.userAgent || req.headers['user-agent'], 500),
        screenInfo:      clip(b.screenInfo, 200),
        language:        clip(b.language, 60),
        screenshot:      typeof b.screenshot === 'string' ? b.screenshot : null,
        ip,
        userId:          req.user.id,
        discordId:       req.user.discordId,
        discordUsername: req.user.discordUsername,
        robloxId:        req.user.robloxId || null,
        robloxUsername:  req.user.robloxUsername || null,
      },
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[Security] capture log error:', err.message);
    res.status(500).json({ error: 'Failed to record capture event.' });
  }
});

module.exports = router;
