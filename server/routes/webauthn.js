// server/routes/webauthn.js — passkeys / WebAuthn 2FA (mounted at /api/webauthn
// behind requireAuth). Users register passkeys and use them as a step-up
// ("2FA") for sensitive actions. Verification is done by @simplewebauthn/server;
// the RP id + origin are derived from the incoming request so it works on any
// domain the portal is served from (localhost, Railway, a custom domain).
const express = require('express');
const prisma  = require('../lib/db');
const audit   = require('../lib/audit');
const {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const router = express.Router();

const RP_NAME = 'MET Police Portal';
const STEP_UP_WINDOW_MS = 10 * 60 * 1000; // a step-up is "fresh" for 10 minutes

// Derive the Relying Party id (a bare domain) + expected origin from the
// request, matching how the OAuth callback URL is derived elsewhere.
function rpInfo(req) {
  if (process.env.PUBLIC_BASE_URL) {
    const u = new URL(process.env.PUBLIC_BASE_URL);
    return { rpID: u.hostname, origin: u.origin };
  }
  const host  = req.get('host') || 'localhost:3000';
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0];
  const hostname = host.split(':')[0];
  return { rpID: hostname, origin: `${proto}://${host}` };
}

function toB64urlArray(json) {
  try { const a = JSON.parse(json || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}

// ── GET /api/webauthn/passkeys — list the user's registered passkeys ──
router.get('/passkeys', async (req, res) => {
  try {
    const rows = await prisma.passkey.findMany({
      where: { userId: req.user.id }, orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, deviceType: true, backedUp: true, createdAt: true, lastUsedAt: true },
    });
    // Is this session currently step-up verified?
    let stepUp = false;
    if (req.sessionId) {
      const s = await prisma.session.findUnique({ where: { id: req.sessionId }, select: { stepUpAt: true } });
      stepUp = !!(s && s.stepUpAt && (Date.now() - new Date(s.stepUpAt).getTime()) < STEP_UP_WINDOW_MS);
    }
    res.json({ passkeys: rows, stepUpActive: stepUp });
  } catch (e) {
    res.status(500).json({ error: 'Could not load passkeys.' });
  }
});

// ── POST /api/webauthn/register/options ──
router.post('/register/options', async (req, res) => {
  try {
    const { rpID } = rpInfo(req);
    const existing = await prisma.passkey.findMany({ where: { userId: req.user.id } });
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID,
      userName: req.user.displayName || req.user.discordUsername,
      userID: Buffer.from(req.user.id),
      attestationType: 'none',
      excludeCredentials: existing.map(p => ({ id: p.credentialId, transports: toB64urlArray(p.transports) })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    });
    await prisma.user.update({ where: { id: req.user.id }, data: { webauthnChallenge: options.challenge } });
    res.json(options);
  } catch (e) {
    console.error('[WebAuthn] register/options failed:', e.message);
    res.status(500).json({ error: 'Could not start passkey registration.' });
  }
});

// ── POST /api/webauthn/register/verify { response, name } ──
router.post('/register/verify', async (req, res) => {
  try {
    const { rpID, origin } = rpInfo(req);
    const expectedChallenge = req.user.webauthnChallenge;
    if (!expectedChallenge) return res.status(400).json({ error: 'No registration in progress. Please try again.' });

    const verification = await verifyRegistrationResponse({
      response: req.body.response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    });
    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'Passkey could not be verified.' });
    }
    const info = verification.registrationInfo;
    await prisma.passkey.create({
      data: {
        userId:       req.user.id,
        credentialId: info.credentialID,
        publicKey:    Buffer.from(info.credentialPublicKey),
        counter:      BigInt(info.counter || 0),
        transports:   JSON.stringify(req.body.response?.response?.transports || []),
        deviceType:   info.credentialDeviceType || null,
        backedUp:     !!info.credentialBackedUp,
        name:         (req.body.name ? String(req.body.name).slice(0, 60) : null) || 'Passkey',
      },
    });
    await prisma.user.update({ where: { id: req.user.id }, data: { webauthnChallenge: null } });
    audit.record({ req, action: 'PASSKEY_REGISTER', category: 'auth', targetType: 'user', targetId: req.user.id, summary: 'Registered a passkey' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[WebAuthn] register/verify failed:', e.message);
    res.status(400).json({ error: 'Passkey registration failed.' });
  }
});

// ── POST /api/webauthn/authenticate/options — start a step-up ──
router.post('/authenticate/options', async (req, res) => {
  try {
    const { rpID } = rpInfo(req);
    const passkeys = await prisma.passkey.findMany({ where: { userId: req.user.id } });
    if (!passkeys.length) return res.status(400).json({ error: 'You have no passkeys registered.' });
    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials: passkeys.map(p => ({ id: p.credentialId, transports: toB64urlArray(p.transports) })),
      userVerification: 'preferred',
    });
    await prisma.user.update({ where: { id: req.user.id }, data: { webauthnChallenge: options.challenge } });
    res.json(options);
  } catch (e) {
    console.error('[WebAuthn] authenticate/options failed:', e.message);
    res.status(500).json({ error: 'Could not start passkey verification.' });
  }
});

// ── POST /api/webauthn/authenticate/verify { response } — complete step-up ──
router.post('/authenticate/verify', async (req, res) => {
  try {
    const { rpID, origin } = rpInfo(req);
    const expectedChallenge = req.user.webauthnChallenge;
    if (!expectedChallenge) return res.status(400).json({ error: 'No verification in progress. Please try again.' });

    const passkey = await prisma.passkey.findFirst({ where: { userId: req.user.id, credentialId: req.body.response?.id } });
    if (!passkey) return res.status(400).json({ error: 'Unrecognised passkey.' });

    const verification = await verifyAuthenticationResponse({
      response: req.body.response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      authenticator: {
        credentialID:        passkey.credentialId,
        credentialPublicKey: passkey.publicKey,
        counter:             Number(passkey.counter),
        transports:          toB64urlArray(passkey.transports),
      },
    });
    if (!verification.verified) return res.status(400).json({ error: 'Passkey verification failed.' });

    await prisma.passkey.update({
      where: { id: passkey.id },
      data: { counter: BigInt(verification.authenticationInfo.newCounter), lastUsedAt: new Date() },
    });
    await prisma.user.update({ where: { id: req.user.id }, data: { webauthnChallenge: null } });
    if (req.sessionId) {
      await prisma.session.update({ where: { id: req.sessionId }, data: { stepUpAt: new Date() } }).catch(() => {});
    }
    audit.record({ req, action: 'STEP_UP', category: 'auth', targetType: 'session', targetId: req.sessionId || null, summary: 'Passed passkey step-up verification' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[WebAuthn] authenticate/verify failed:', e.message);
    res.status(400).json({ error: 'Passkey verification failed.' });
  }
});

// ── PATCH /api/webauthn/passkeys/:id { name } — rename ──
router.patch('/passkeys/:id', async (req, res) => {
  try {
    const pk = await prisma.passkey.findUnique({ where: { id: req.params.id } });
    if (!pk || pk.userId !== req.user.id) return res.status(404).json({ error: 'Passkey not found.' });
    await prisma.passkey.update({ where: { id: pk.id }, data: { name: String(req.body.name || 'Passkey').slice(0, 60) } });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not rename passkey.' });
  }
});

// ── DELETE /api/webauthn/passkeys/:id ──
router.delete('/passkeys/:id', async (req, res) => {
  try {
    const pk = await prisma.passkey.findUnique({ where: { id: req.params.id } });
    if (!pk || pk.userId !== req.user.id) return res.status(404).json({ error: 'Passkey not found.' });
    await prisma.passkey.delete({ where: { id: pk.id } });
    audit.record({ req, action: 'PASSKEY_DELETE', category: 'auth', targetType: 'user', targetId: req.user.id, summary: `Removed passkey "${pk.name || 'Passkey'}"` });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not remove passkey.' });
  }
});

module.exports = router;
