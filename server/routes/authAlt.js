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
  message: { error: 'Too many code requests · wait a few minutes and try again.' } });
// Brute-force guard for the passwordless verify endpoints.
const verifyLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many sign-in attempts · wait a few minutes and try again.' } });

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
      await require('../lib/bot').dmLoginCode(discordId, code, challenge.id).catch(() => false);
    }
    res.json({ ok: true, id: challenge.id });
  } catch (e) {
    console.error('[AuthAlt] code/request failed:', e.message);
    res.status(500).json({ error: 'Could not start code sign-in.' });
  }
});

// POST /api/login/code/verify { id, code }
router.post('/code/verify', verifyLimiter, async (req, res) => {
  try {
    const { id, code } = req.body || {};
    const c = await prisma.loginChallenge.findUnique({ where: { id: String(id || '') } }).catch(() => null);
    if (!c || c.method !== 'CODE' || c.status !== 'PENDING') return res.status(400).json({ error: 'Invalid or expired code. Request a new one.' });
    if (new Date(c.expiresAt) < new Date()) return res.status(400).json({ error: 'That code has expired. Request a new one.' });
    if (c.attempts >= MAX_ATTEMPTS) { await prisma.loginChallenge.update({ where: { id: c.id }, data: { status: 'CONSUMED' } }).catch(() => {}); require('../lib/bot').deleteLoginDm(c.id).catch(() => {}); audit.record({ req, action: 'LOGIN_CODE_LOCKOUT', category: 'SECURITY', targetType: 'user', targetId: c.userId || null, summary: 'Discord sign-in code locked out after too many wrong attempts (possible brute force)' }); return res.status(429).json({ error: 'Too many attempts. Request a new code.' }); }

    const ok = c.userId && String(code || '').trim() === c.code;
    if (!ok) {
      await prisma.loginChallenge.update({ where: { id: c.id }, data: { attempts: { increment: 1 } } }).catch(() => {});
      audit.record({ req, action: 'LOGIN_CODE_FAIL', category: 'SECURITY', targetType: 'user', targetId: c.userId || null, summary: `Wrong Discord sign-in code (attempt ${(c.attempts || 0) + 1})` });
      return res.status(400).json({ error: 'Incorrect code.' });
    }

    const user = await prisma.user.findUnique({ where: { id: c.userId } });
    if (!usable(user)) return res.status(403).json({ error: 'This account cannot sign in.' });
    await prisma.loginChallenge.update({ where: { id: c.id }, data: { status: 'CONSUMED' } }).catch(() => {});
    require('../lib/bot').deleteLoginDm(c.id).catch(() => {}); // remove the code DM now it's used
    await createSession(req, res, user); // sets the cookie (no redirect)
    audit.record({ req, action: 'LOGIN_CODE', category: 'auth', targetType: 'user', targetId: user.id, summary: 'Signed in with a Discord DM code' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[AuthAlt] code/verify failed:', e.message);
    res.status(500).json({ error: 'Could not verify the code.' });
  }
});

// ── 2. QR approval (approve from a logged-in device) ─────────────────
// Anti-QRLJacking: the flow is bound to the initiating browser (a secret cookie
// gates status polling), a 2-digit number-match code must be confirmed by the
// approver, and the approval page shows the initiating device's context so a
// victim can recognise an unfamiliar device and decline.
const qrLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many sign-in requests · wait a few minutes and try again.' } });
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const qrCookieName = (id) => 'qr_' + String(id).replace(/[^a-zA-Z0-9]/g, '');

// POST /api/login/qr/start → returns a pending challenge + its QR + match code.
router.post('/qr/start', qrLimiter, async (req, res) => {
  try {
    const secret    = crypto.randomBytes(24).toString('hex');
    const matchCode = String(crypto.randomInt(10, 100)); // 2 digits
    const ua        = String(req.headers['user-agent'] || '').slice(0, 400);
    const c = await prisma.loginChallenge.create({ data: {
      method: 'QR', ip: ipOf(req), userAgent: ua, matchCode, secretHash: sha256(secret),
      expiresAt: new Date(Date.now() + QR_TTL_MS),
    } });
    // Bind status polling to THIS browser — an attacker who only has the id/URL
    // can't complete the flow to receive the session cookie.
    res.cookie(qrCookieName(c.id), secret, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: QR_TTL_MS });
    const approveUrl = `${baseUrl(req)}/link/approve?id=${c.id}`;
    const qr = await QRCode.toDataURL(approveUrl, { width: 240, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0b0f1a', light: '#ffffff' } });
    res.json({ id: c.id, qr, approveUrl, expiresInMs: QR_TTL_MS, matchCode });
  } catch (e) {
    console.error('[AuthAlt] qr/start failed:', e.message);
    res.status(500).json({ error: 'Could not start QR sign-in.' });
  }
});

// GET /api/login/qr/context?id — the approving (logged-in) device reads the
// initiating device's context so it can be shown before approving.
router.get('/qr/context', async (req, res) => {
  try {
    const c = await prisma.loginChallenge.findUnique({ where: { id: String(req.query.id || '') } }).catch(() => null);
    if (!c || c.method !== 'QR' || c.status !== 'PENDING' || new Date(c.expiresAt) < new Date()) return res.status(404).json({ error: 'This sign-in request is no longer valid.' });
    let device = 'an unknown device';
    try { device = require('./auth').describeDevice(c.userAgent || '') || device; } catch (e) {}
    res.json({ device, ip: c.ip || null, startedAt: c.createdAt, matchCode: c.matchCode || null });
  } catch (e) { res.status(500).json({ error: 'Could not load request.' }); }
});

// GET /api/login/qr/status?id — the browser polls; on approval this sets the
// session cookie on THIS (browser) response and reports approved. Requires the
// initiator secret cookie so only the browser that started the flow gets in.
router.get('/qr/status', async (req, res) => {
  try {
    const id = String(req.query.id || '');
    const c = await prisma.loginChallenge.findUnique({ where: { id } }).catch(() => null);
    if (!c || c.method !== 'QR') return res.json({ status: 'expired' });
    // Initiator binding: this must be the browser that started the request.
    const secret = req.cookies && req.cookies[qrCookieName(id)];
    if (!secret || !c.secretHash || sha256(secret) !== c.secretHash) return res.json({ status: 'pending' });
    if (c.status === 'CONSUMED') return res.json({ status: 'consumed' });
    if (new Date(c.expiresAt) < new Date()) return res.json({ status: 'expired' });
    if (c.status !== 'APPROVED' || !c.userId) return res.json({ status: 'pending' });

    const user = await prisma.user.findUnique({ where: { id: c.userId } });
    if (!usable(user)) { await prisma.loginChallenge.update({ where: { id: c.id }, data: { status: 'CONSUMED' } }).catch(() => {}); return res.json({ status: 'denied' }); }
    await prisma.loginChallenge.update({ where: { id: c.id }, data: { status: 'CONSUMED' } }).catch(() => {});
    res.clearCookie(qrCookieName(id));
    await createSession(req, res, user);
    audit.record({ req, action: 'LOGIN_QR', category: 'auth', targetType: 'user', targetId: user.id, summary: 'Signed in via QR approved on another device' });
    res.json({ status: 'approved' });
  } catch (e) {
    console.error('[AuthAlt] qr/status failed:', e.message);
    res.status(500).json({ error: 'Could not check status.' });
  }
});

// POST /api/login/qr/approve { id, matchCode } — the logged-in device approves.
// The approver must confirm the 2-digit code shown on the initiating screen.
router.post('/qr/approve', requireAuth, async (req, res) => {
  try {
    const c = await prisma.loginChallenge.findUnique({ where: { id: String((req.body && req.body.id) || '') } }).catch(() => null);
    if (!c || c.method !== 'QR' || c.status !== 'PENDING') return res.status(400).json({ error: 'This sign-in request is no longer valid.' });
    if (new Date(c.expiresAt) < new Date()) return res.status(400).json({ error: 'This sign-in request has expired.' });
    const code = String((req.body && req.body.matchCode) || '').trim();
    if (!c.matchCode || code !== c.matchCode) {
      audit.record({ req, action: 'QR_CODE_MISMATCH', category: 'SECURITY', targetType: 'user', targetId: req.user.id, summary: 'QR sign-in approval attempted with the wrong match code (possible QR phishing)' });
      return res.status(400).json({ error: 'That code doesn\'t match the one on the sign-in screen. Only continue if you started this sign-in yourself.' });
    }
    await prisma.loginChallenge.update({ where: { id: c.id }, data: { status: 'APPROVED', userId: req.user.id } });
    audit.record({ req, action: 'LOGIN_QR_APPROVE', category: 'auth', targetType: 'user', targetId: req.user.id, summary: 'Approved a QR sign-in from another device' });
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
    // Omit allowCredentials entirely → the browser offers any discoverable
    // passkey registered for this domain (username-less login). An empty array
    // can be read as "no credentials allowed" and suppress the prompt.
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'preferred' });
    const token = jwt.sign({ ch: options.challenge }, process.env.JWT_SECRET, { expiresIn: '5m' });
    res.cookie('pk_login', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 5 * 60 * 1000 });
    res.json(options);
  } catch (e) {
    console.error('[AuthAlt] passkey/options failed:', e.message);
    res.status(500).json({ error: 'Could not start passkey sign-in.' });
  }
});

// POST /api/login/passkey/verify { response }
router.post('/passkey/verify', verifyLimiter, async (req, res) => {
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
    if (!verification.verified) {
      audit.record({ req, action: 'PASSKEY_FAIL', category: 'SECURITY', targetType: 'user', targetId: passkey.userId || null, summary: 'Passkey sign-in failed verification (bad signature/challenge)' });
      return res.status(400).json({ error: 'Passkey verification failed.' });
    }

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
