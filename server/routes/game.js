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
const crypto  = require('crypto');
const prisma  = require('../lib/db');

const router = express.Router();

function gameSecret()        { return process.env.TRYOUT_GAME_SECRET || null; }
function gameSigningSecret() { return process.env.TRYOUT_GAME_SIGNING_SECRET || null; }

// Constant-time string compare (avoids leaking length/where via early-exit).
function safeEqual(a, b) {
  const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// Verify an optional HMAC-SHA256 signature over the raw body:
//   x-game-signature: hex(HMAC_SHA256(rawBody, TRYOUT_GAME_SIGNING_SECRET))
// Returns true if a valid signature is present, false otherwise.
function hasValidSignature(req) {
  const secret = gameSigningSecret();
  const sig    = req.get('x-game-signature');
  if (!secret || !sig || !req.rawBody) return false;
  const expected = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  return safeEqual(sig.trim().toLowerCase(), expected);
}

// Auth for game callbacks. Accepts EITHER a valid HMAC signature (preferred,
// replay-resistant) OR the shared secret — so the game can adopt signing
// gradually. If neither a shared secret nor a signing secret is configured, the
// endpoint is disabled (503) rather than left open.
function requireGameSecret(req, res, next) {
  if (!gameSecret() && !gameSigningSecret()) {
    return res.status(503).json({ error: 'Game callback not configured (set TRYOUT_GAME_SECRET).' });
  }
  if (hasValidSignature(req)) return next();
  const provided = req.get('x-game-secret') || (req.body && req.body.secret) || '';
  if (gameSecret() && safeEqual(provided, gameSecret())) return next();
  return res.status(401).json({ error: 'Bad game secret or signature.' });
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

// GET /api/game/health — public config visibility (booleans only, no secrets),
// so you can confirm from a browser what's set up server-side. Optionally pass
// ?robloxId=<id> WITH the secret (header/x-game-secret or ?secret=) to check
// whether that Roblox account resolves to a signed-in portal user.
router.get('/health', async (req, res) => {
  let botReady = null;
  try { botReady = require('../lib/bot').isReady(); } catch (e) { /* bot module absent */ }
  const out = {
    ok: true,
    secretSet:          !!gameSecret(),
    signingSet:         !!gameSigningSecret(),
    roverConfigured:    !!(process.env.ROVER_API_KEY && process.env.DISCORD_GUILD_ID),
    announceChannelSet: !!process.env.TRYOUT_ANNOUNCE_CHANNEL_ID,
    publicBaseUrlSet:   !!process.env.PUBLIC_BASE_URL,
    botReady,
  };
  // Secret-gated host check (so account lookups aren't public).
  const provided = req.get('x-game-secret') || req.query.secret || '';
  const authed = gameSecret() && safeEqual(provided, gameSecret());
  if (req.query.robloxId && authed) {
    try {
      const { resolveHostUser } = require('../lib/tryoutLogs');
      const u = await resolveHostUser({ hostRobloxId: String(req.query.robloxId) });
      out.hostCheck = { robloxId: String(req.query.robloxId), resolved: !!u, siteUser: u ? (u.displayName || u.discordUsername || null) : null };
    } catch (e) { out.hostCheck = { error: e.message }; }
  } else if (req.query.robloxId) {
    out.hostCheck = { note: 'pass the secret (?secret=… or x-game-secret header) to run the host check' };
  }
  res.json(out);
});

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

// ── Tryout logging from the in-game HPCInstructorPanel ────────────────
// When the host confirms conclusion in-game, the panel POSTs a full snapshot
// here. We create a DRAFT tryout log owned by the host, who then reviews +
// posts it on the site.
//
// POST /api/game/tryout/conclude
//   {
//     host:   { robloxId, username, discordId? },
//     coHost: { robloxId?, username? },
//     tryoutId?, startedAt?, concludedAt?,
//     attendees: [{ robloxId, username, joinedAt, leftAt, kicked, result, strikes, note }],
//     events:    [{ at, type, username, by, detail }]
//   }
router.post('/tryout/conclude', requireGameSecret, async (req, res) => {
  try {
    const { createFromGamePayload } = require('../lib/tryoutLogs');
    const result = await createFromGamePayload(req.body || {});
    if (!result.ok) return res.status(422).json({ error: result.error });
    res.status(201).json(result);
  } catch (err) {
    console.error('[Game] tryout conclude failed:', err.message);
    res.status(500).json({ error: 'Failed to log tryout.' });
  }
});

// POST /api/game/tryout/live — optional live snapshot while a tryout is running,
// so the site can mirror the in-game overview. Stored on the linked Tryout's
// row as a transient JSON blob (best-effort; requires a live tryout to attach to).
router.post('/tryout/live', requireGameSecret, async (req, res) => {
  try {
    const body = req.body || {};
    const where = body.tryoutId ? { id: String(body.tryoutId) }
      : (body.privateServerId ? { status: 'LIVE', privateServerId: String(body.privateServerId) } : null);
    if (!where) return res.status(400).json({ error: 'tryoutId or privateServerId required.' });
    const t = await prisma.tryout.findFirst({ where });
    if (!t) return res.status(404).json({ error: 'No matching live tryout.' });
    const { normaliseAttendees, countsFor } = require('../lib/tryoutLogs');
    const attendees = normaliseAttendees(body.attendees);
    await prisma.tryout.update({
      where: { id: t.id },
      data: { liveSnapshot: { at: new Date().toISOString(), attendees, ...countsFor(attendees) } },
    }).catch(() => {}); // liveSnapshot column is optional; ignore if absent
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to store live snapshot.' });
  }
});

// ── Tryout lifecycle driven from the in-game panel ────────────────────
// Resolve a { robloxId, username, discordId? } host payload to a site user
// (must have signed in — same rule as /tryout/conclude's 422).
async function resolveGameHost(host) {
  if (!host) return null;
  const { resolveHostUser } = require('../lib/tryoutLogs');
  return resolveHostUser({ hostDiscordId: host.discordId, hostRobloxId: host.robloxId, hostRobloxName: host.username });
}

// A diagnostic 422 for an unresolvable host — says exactly why so the panel /
// logs make the fix obvious (which Roblox id, whether RoVer is even configured).
function hostNotFound(res, host) {
  const roverConfigured = !!(process.env.ROVER_API_KEY && process.env.DISCORD_GUILD_ID);
  const site = process.env.PUBLIC_BASE_URL || 'the MET portal';
  const who  = `Roblox user ${(host && host.robloxId) || '?'}${host && host.username ? ` (${host.username})` : ''}`;
  return res.status(422).json({
    error: roverConfigured
      ? `No portal account is linked to ${who}. That person must sign in at ${site} with the Discord account RoVer-verified to that Roblox account, then retry.`
      : `Cannot resolve ${who}: RoVer isn't configured on the server (set ROVER_API_KEY and DISCORD_GUILD_ID). Until then, the host can only be matched if they've signed in on that Roblox account.`,
    robloxId: host && host.robloxId != null ? String(host.robloxId) : null,
    roverConfigured,
  });
}

// Absolute review URL for host DMs (null if no base configured → link omitted).
function reviewUrl() {
  const base = process.env.PUBLIC_BASE_URL;
  return base ? `${base.replace(/\/$/, '')}/hpc/dashboard` : null;
}

// The single currently-ongoing (LIVE) tryout, if any.
function ongoingTryout() {
  return prisma.tryout.findFirst({ where: { status: 'LIVE' }, orderBy: { scheduledAt: 'desc' } });
}

// Take a tryout LIVE-facing: post its announcement + DM the host. Returns
// { tryoutId, dmed, announced }. Best-effort on the Discord side (never throws).
async function announceAndDm(tryout, { edit = false } = {}) {
  const bot = require('../lib/bot');
  let announced;
  if (edit && tryout.announcementMsgId) announced = await bot.editTryoutAnnouncement(tryout).catch(() => false);
  else announced = await bot.postTryoutAnnouncement(tryout).then(id => !!id).catch(() => false);
  const fresh = (await prisma.tryout.findUnique({ where: { id: tryout.id } }).catch(() => null)) || tryout;
  const dmed  = await bot.dmTryoutStarted(fresh, { reviewUrl: reviewUrl() }).catch(() => false);
  return { tryoutId: tryout.id, dmed: !!dmed, announced: !!announced };
}

// GET /api/game/tryout/scheduled — upcoming scheduled tryouts for the "Begin
// Scheduled Tryout" list. Returns { items: [{ id, name, scheduledAt, host }] }.
// NOTE: Tryout has no name column, so `name` is derived as "<host>'s tryout".
router.get('/tryout/scheduled', requireGameSecret, async (req, res) => {
  try {
    const rows = await prisma.tryout.findMany({
      where: { status: 'SCHEDULED', scheduledAt: { gte: new Date(Date.now() - 5 * 60 * 1000) } },
      orderBy: { scheduledAt: 'asc' }, take: 25,
    });
    res.json({ items: rows.map(t => ({
      id: t.id, name: `${t.hostName}'s tryout`, scheduledAt: t.scheduledAt, host: t.hostName,
    })) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list scheduled tryouts.' });
  }
});

// POST /api/game/tryout/create — start an unscheduled tryout instantly.
// body: { host:{robloxId,username,discordId?}, coHost?, privateServerId?, startedAt? }
router.post('/tryout/create', requireGameSecret, async (req, res) => {
  try {
    const body = req.body || {};
    const hostUser = await resolveGameHost(body.host);
    if (!hostUser) return hostNotFound(res, body.host);

    const existing = await ongoingTryout();
    if (existing) return res.status(409).json({ error: 'A tryout is already ongoing.', tryoutId: existing.id });

    const coHost = body.coHost || {};
    const t = await prisma.tryout.create({ data: {
      hostId:            hostUser.id,
      hostDiscordId:     hostUser.discordId,
      hostName:          hostUser.displayName || hostUser.discordUsername || (body.host && body.host.username) || 'Host',
      coHostName:        coHost.username || coHost.name || null,
      scheduledAt:       body.startedAt ? new Date(body.startedAt) : new Date(),
      status:            'LIVE',
      privateServerId:   body.privateServerId ? String(body.privateServerId) : null,
      privateServerLink: body.privateServerLink || null,
      serverCreatedAt:   new Date(),
    } });
    res.status(201).json(await announceAndDm(t));
  } catch (err) {
    console.error('[Game] tryout create failed:', err.message);
    res.status(500).json({ error: 'Failed to create tryout.' });
  }
});

// POST /api/game/tryout/start-scheduled — start an existing scheduled tryout now.
// body: { scheduledId, host, coHost?, privateServerId? }
router.post('/tryout/start-scheduled', requireGameSecret, async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.scheduledId) return res.status(400).json({ error: 'scheduledId is required.' });
    const hostUser = await resolveGameHost(body.host);
    if (!hostUser) return hostNotFound(res, body.host);

    const t = await prisma.tryout.findUnique({ where: { id: String(body.scheduledId) } });
    if (!t) return res.status(404).json({ error: 'Scheduled tryout not found.' });
    if (['CANCELLED', 'COMPLETED'].includes(t.status)) return res.status(400).json({ error: 'That tryout is already finished.' });

    const coHost = body.coHost || {};
    const updated = await prisma.tryout.update({ where: { id: t.id }, data: {
      status:          'LIVE',
      hostId:          hostUser.id,
      hostDiscordId:   hostUser.discordId,
      hostName:        hostUser.displayName || hostUser.discordUsername || t.hostName,
      coHostName:      coHost.username || coHost.name || t.coHostName,
      privateServerId: body.privateServerId ? String(body.privateServerId) : t.privateServerId,
      serverCreatedAt: t.serverCreatedAt || new Date(),
    } });
    res.json(await announceAndDm(updated, { edit: true }));
  } catch (err) {
    console.error('[Game] start-scheduled failed:', err.message);
    res.status(500).json({ error: 'Failed to start scheduled tryout.' });
  }
});

// POST /api/game/tryout/cancel — cancel the ongoing tryout + close its post.
// body: { tryoutId?, privateServerId?, host?, reason? }
router.post('/tryout/cancel', requireGameSecret, async (req, res) => {
  try {
    const body = req.body || {};
    let t = null;
    if (body.tryoutId)       t = await prisma.tryout.findUnique({ where: { id: String(body.tryoutId) } });
    if (!t && body.privateServerId) t = await prisma.tryout.findFirst({ where: { status: 'LIVE', privateServerId: String(body.privateServerId) } });
    if (!t) t = await ongoingTryout();
    if (!t) return res.status(404).json({ error: 'No ongoing tryout to cancel.' });
    if (['CANCELLED', 'COMPLETED'].includes(t.status)) return res.json({ ok: true, alreadyClosed: true });

    const updated = await prisma.tryout.update({ where: { id: t.id }, data: { status: 'CANCELLED' } });
    await require('../lib/bot').cancelTryoutAnnouncement(updated, body.reason).catch(() => {});
    res.json({ ok: true, tryoutId: updated.id });
  } catch (err) {
    console.error('[Game] cancel failed:', err.message);
    res.status(500).json({ error: 'Failed to cancel tryout.' });
  }
});

module.exports = router;
