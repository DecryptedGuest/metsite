// server/routes/app.js — "install on your phone" QR handoff.
// Mounted at /api/app behind requireAuth. A signed-in user mints a one-time,
// short-lived token; scanning its QR on a phone opens /m/<token> (see index.js),
// which transfers the session to that device and prompts the PWA install.
const express = require('express');
const crypto  = require('crypto');
const QRCode  = require('qrcode');
const prisma  = require('../lib/db');

const router = express.Router();

function baseUrl(req) {
  const env = process.env.PUBLIC_BASE_URL;
  if (env) return env.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  return `${proto}://${req.get('host')}`;
}

// POST /api/app/link — create a fresh handoff token + its QR (data-URL).
router.post('/link', async (req, res) => {
  try {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes
    await prisma.mobileLoginToken.create({ data: { token, userId: req.user.id, expiresAt } });
    const url = `${baseUrl(req)}/m/${token}`;
    const qr  = await QRCode.toDataURL(url, { width: 320, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0b0f1a', light: '#ffffff' } });
    res.json({ url, qr, expiresIn: 300 });
  } catch (e) {
    console.error('[App] link failed:', e.message);
    res.status(500).json({ error: 'Failed to create install link' });
  }
});

// POST /api/app/link/dm — mint a handoff token and DM its link to the user's
// Discord, so they can just tap it on their phone (no QR / no typing).
router.post('/link/dm', async (req, res) => {
  try {
    if (!req.user.discordId) return res.status(400).json({ error: 'No Discord account linked.' });
    const token = crypto.randomBytes(32).toString('hex');
    await prisma.mobileLoginToken.create({ data: { token, userId: req.user.id, expiresAt: new Date(Date.now() + 5 * 60 * 1000) } });
    const url = `${baseUrl(req)}/m/${token}`;
    const ok = await require('../lib/bot').dmInstallLink(req.user.discordId, url).catch(() => false);
    if (!ok) return res.status(502).json({ error: "Couldn't DM you — check your Discord privacy settings allow DMs from server members." });
    res.json({ ok: true });
  } catch (e) {
    console.error('[App] link/dm failed:', e.message);
    res.status(500).json({ error: 'Failed to send the link' });
  }
});

module.exports = router;
