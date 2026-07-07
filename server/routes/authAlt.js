// server/routes/authAlt.js — "Try another way" passwordless sign-in.
// Mounted at /api/login (CSRF-protected for POSTs; the login page holds a CSRF
// cookie like every visitor). Three logged-out flows, all ending in the same
// createSession() path as Discord/Roblox:
//   1. Discord DM code — a 6-digit code DM'd by the bot.
//   2. QR approval    — approve a browser sign-in from a logged-in device.
//   3. Passkey        — a discoverable WebAuthn credential (no username).
const express = require('express');
const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');
const QRCode  = require('qrcode');
const prisma  = require('../lib/db');
const audit   = require('../lib/audit');
const rateLimit = require('express-rate-limit');
const { generateAuthenticationOptions, verifyAuthenticationResponse } = require('@simplewebauthn/server');
const { createSession } = require('./auth');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const CODE_TTL_MS = 10 * 60 * 1000;
const QR_TTL_MS   = 3 * 60 * 1000;
const MAX_ATTEMPTS = 6;

function rpInfo(req) {
  if (process.env.PUBLIC_BASE_URL) { const u = new URL(process.env.PUBLIC_BASE_URL); return { rpID: u.hostname, origin: u.origin }; }
  const host = req.get('host') || 'localhost:3000';
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0];
  return { rpID: host.split(':')[0], origin: `${proto}://${host}` };
}
function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0];
  return `${proto}://${req.get('host')}`;
}
function toB64urlArray(json) { try { const a = JSON.parse(json || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
function ipOf(req) { try { return require('../middleware/visit').getClientIp(req); } catch (e) { return null; } }
// A signed-in user who is actually allowed a session (not blacklisted / revoked).
function usable(u) { return u && !u.isBlacklisted && !u.mustReauth; }

const codeLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many code requests — wait a few minutes and try again.' } });

// ── 1. Discord DM 6-digit code ───────────────────────────────────────
// POST /api/login/code/request { discord } — resolve the account, DM a code.
// Response is deliberately uniform (always { ok, id }) to avoid revealing who
// has an account; a code is only sent when a real, usable account matches.
router.post('/code/request', codeLimiter, async (req, res) => {
  try {
    const input = String((req.body && req.body.discord) || '').trim().replace(/^@/, '');
    if (!input) return res.status(400).json({ error: 'Enter your Discord username or ID.' });

    // Resolve to a Discord id: raw id, else look the member up via the bot.
    let discordId = /^\d{5,}$/.test(input) ? input : null;
    if (!discordId) {
      try { const m = await require('../lib/bot').findMemberByUsername(input); if (m && m.id) discordId = String(m.id); }
      catch (e) { /* bot down → treated as no match */ }
    }
    const user = discordId ? await prisma.user.findUnique({ where: { discordId } }).catch(() => null) : null;

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const challenge = await prisma.loginChallenge.create({
      data: {
        method: 'CODE',
        // Only store a usable code + link when a real account matches; otherwise
        // a random code that is never delivered, so verify always fails.
        code: usable(user) ? code : String(crypto.randomInt(0, 1000000)).padStart(6, '0'),
        discordId: usable(user) ? discordId : null,
        userId: usable(user) ? user.id : null,
        ip: ipOf(req),
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      },
    });
    if (usable(user)) {
      await require('../lib/bot').dmLoginCode(discordId, code).catch(() => false);
    }
    res.json({ ok: true, id: challenge.id });
  } catch (e) {
    console.error('[AuthAlt] code/request failed:', e.message);
    res.status(500).json({ error: 'Could not start code sign-in.' });
  }
});

// POST /api/login/code/verify { id, code }
router.post('/code/verify', async (req, res) => {
  try {
    const { id, code } = req.body || {};
    const c = await prisma.loginChallenge.findUnique({ where: { id: String(id || '') } }).catch(() => null);
    if (!c || c.method !== 'CODE' || c.status !== 'PENDING') return res.status(400).json({ error: 'Invalid or expired code. Request a new one.' });
    if (new Date(c.expiresAt) < new Date()) return res.status(400).json({ error: 'That code has expired. Request a new one.' });
    if (c.attempts >= MAX_ATTEMPTS) { await prisma.loginChallenge.update({ where: { id: c.id }, data: { status: 'CONSUMED' } }).catch(() => {}); return res.status(429).json({ error: 'Too many attempts. Request a new code.' }); }

    const ok = c.userId && String(code || '').trim() === c.code;
    if (!ok) { await prisma.loginChallenge.update({ where: { id: c.id }, data: { attempts: { increment: 1 } } }).catch(() => {}); return res.status(400).json({ error: 'Incorrect code.' }); }

    const user = await prisma.user.findUnique({ where: { id: c.userId } });
    if (!usable(user)) return res.status(403).json({ error: 'This account cannot sign in.' });
    await prisma.loginChallenge.update({ where: { id: c.id }, data: { status: 'CONSUMED' } }).catch(() => {});
    await createSession(req, res, user); // sets the cookie (no redirect)
    audit.record({ req, action: 'LOGIN_CODE', category: 'auth', targetType: 'user', targetId: user.id, summary: 'Signed in with a Discord DM code' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[AuthAlt] code/verify failed:', e.message);
    res.status(500).json({ error: 'Could not verify the code.' });
  }
});

// ── 2. QR approval (approve from a logged-in device) ─────────────────
// POST /api/login/qr/start → returns a pending challenge + its QR to display.
router.post('/qr/start', async (req, res) => {
  try {
    const c = await prisma.loginChallenge.create({ data: { method: 'QR', ip: ipOf(req), expiresAt: new Date(Date.now() + QR_TTL_MS) } });
    const approveUrl = `${baseUrl(req)}/link/approve?id=${c.id}`;
    const qr = await QRCode.toDataURL(approveUrl, { width: 240, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0b0f1a', light: '#ffffff' } });
    res.json({ id: c.id, qr, approveUrl, expiresInMs: QR_TTL_MS });
  } catch (e) {
    console.error('[AuthAlt] qr/start failed:', e.message);
    res.status(500).json({ error: 'Could not start QR sign-in.' });
  }
});

// GET /api/login/qr/status?id — the browser polls; on approval this sets the
// session cookie on THIS (browser) response and reports approved.
router.get('/qr/status', async (req, res) => {
  try {
    const c = await prisma.loginChallenge.findUnique({ where: { id: String(req.query.id || '') } }).catch(() => null);
    if (!c || c.method !== 'QR') return res.json({ status: 'expired' });
    if (c.status === 'CONSUMED') return res.json({ status: 'consumed' });
    if (new Date(c.expiresAt) < new Date()) return res.json({ status: 'expired' });
    if (c.status !== 'APPROVED' || !c.userId) return res.json({ status: 'pending' });

    const user = await prisma.user.findUnique({ where: { id: c.userId } });
    if (!usable(user)) { await prisma.loginChallenge.update({ where: { id: c.id }, data: { status: 'CONSUMED' } }).catch(() => {}); return res.json({ status: 'denied' }); }
    await prisma.loginChallenge.update({ where: { id: c.id }, data: { status: 'CONSUMED' } }).catch(() => {});
    await createSession(req, res, user);
    audit.record({ req, action: 'LOGIN_QR', category: 'auth', targetType: 'user', targetId: user.id, summary: 'Signed in via QR approved on another device' });
    res.json({ status: 'approved' });
  } catch (e) {
    console.error('[AuthAlt] qr/status failed:', e.message);
    res.status(500).json({ error: 'Could not check status.' });
  }
});

// POST /api/login/qr/approve { id } — the logged-in device approves the browser.
router.post('/qr/approve', requireAuth, async (req, res) => {
  try {
    const c = await prisma.loginChallenge.findUnique({ where: { id: String((req.body && req.body.id) || '') } }).catch(() => null);
    if (!c || c.method !== 'QR' || c.status !== 'PENDING') return res.status(400).json({ error: 'This sign-in request is no longer valid.' });
    if (new Date(c.expiresAt) < new Date()) return res.status(400).json({ error: 'This sign-in request has expired.' });
    await prisma.loginChallenge.update({ where: { id: c.id }, data: { status: 'APPROVED', userId: req.user.id } });
    res.json({ ok: true });
  } catch (e) {
    console.error('[AuthAlt] qr/approve failed:', e.message);
    res.status(500).json({ error: 'Could not approve sign-in.' });
  }
});

// ── 3. Passkey (discoverable credential, no username) ────────────────
// POST /api/login/passkey/options → challenge stored in a signed cookie.
router.post('/passkey/options', async (req, res) => {
  try {
    const { rpID } = rpInfo(req);
    const options = await generateAuthenticationOptions({ rpID, allowCredentials: [], userVerification: 'preferred' });
    const token = jwt.sign({ ch: options.challenge }, process.env.JWT_SECRET, { expiresIn: '5m' });
    res.cookie('pk_login', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 5 * 60 * 1000 });
    res.json(options);
  } catch (e) {
    console.error('[AuthAlt] passkey/options failed:', e.message);
    res.status(500).json({ error: 'Could not start passkey sign-in.' });
  }
});

// POST /api/login/passkey/verify { response }
router.post('/passkey/verify', async (req, res) => {
  try {
    const { rpID, origin } = rpInfo(req);
    let expectedChallenge = null;
    try { expectedChallenge = jwt.verify(req.cookies?.pk_login || '', process.env.JWT_SECRET).ch; } catch (e) { return res.status(400).json({ error: 'Passkey sign-in expired. Try again.' }); }

    const credId = req.body.response && req.body.response.id;
    const passkey = credId ? await prisma.passkey.findUnique({ where: { credentialId: credId } }) : null;
    if (!passkey) return res.status(400).json({ error: 'Unrecognised passkey.' });

    const verification = await verifyAuthenticationResponse({
      response: req.body.response,
      expectedChallenge, expectedOrigin: origin, expectedRPID: rpID,
      authenticator: { credentialID: passkey.credentialId, credentialPublicKey: passkey.publicKey, counter: Number(passkey.counter), transports: toB64urlArray(passkey.transports) },
    });
    if (!verification.verified) return res.status(400).json({ error: 'Passkey verification failed.' });

    const user = await prisma.user.findUnique({ where: { id: passkey.userId } });
    if (!usable(user)) return res.status(403).json({ error: 'This account cannot sign in.' });

    await prisma.passkey.update({ where: { id: passkey.id }, data: { counter: BigInt(verification.authenticationInfo.newCounter), lastUsedAt: new Date() } });
    res.clearCookie('pk_login');
    await createSession(req, res, user);
    audit.record({ req, action: 'LOGIN_PASSKEY', category: 'auth', targetType: 'user', targetId: user.id, summary: 'Signed in with a passkey' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[AuthAlt] passkey/verify failed:', e.message);
    res.status(400).json({ error: 'Passkey verification failed.' });
  }
});

module.exports = router;
