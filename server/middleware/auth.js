// server/middleware/auth.js
const jwt    = require('jsonwebtoken');
const prisma = require('../lib/db');

// Use functions so env vars are read at call-time, not module-load-time
const ROLE_IA          = () => process.env.ROLE_IA           || '1398071208343244870';
const ROLE_HICOMM      = () => process.env.ROLE_HICOMM       || '1399746451453644860';
const ROLE_SUPERVISOR  = () => process.env.ROLE_SUPERVISOR   || '1424505342129082571';
const DEVELOPER_DISCORD_ID = () => process.env.DEVELOPER_DISCORD_ID || '1227866745201627137';

async function requireAuth(req, res, next) {
  const token = req.cookies?.iacms_token;
  const isApi = req.originalUrl.startsWith('/api');

  if (!token) {
    return isApi ? res.status(401).json({ error: 'Not authenticated' }) : res.redirect('/login');
  }

  // 1) Verify the token itself. A bad/expired/tampered token is a real auth
  //    failure → clear it and send them to login.
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    res.clearCookie('iacms_token');
    return isApi ? res.status(401).json({ error: 'Invalid session' }) : res.redirect('/login');
  }

  // 2) Load the user. A DB error here is TRANSIENT (blip / deploy restart) —
  //    do NOT log the user out over it. Return 503 and keep their session so a
  //    refresh recovers, instead of the old behaviour that wiped the cookie and
  //    bounced everyone to login (seen as spurious "access revoked" logouts).
  let user;
  try {
    user = await prisma.user.findUnique({ where: { id: payload.userId } });
  } catch (dbErr) {
    console.error('[Auth] requireAuth DB lookup failed (transient):', dbErr.message);
    return isApi
      ? res.status(503).json({ error: 'Server busy — please retry.' })
      : res.status(503).send('Server busy — please refresh in a moment.');
  }

  if (!user) {
    res.clearCookie('iacms_token');
    return isApi ? res.status(401).json({ error: 'User not found' }) : res.redirect('/login');
  }

  if (user.isBlacklisted) {
    res.clearCookie('iacms_token');
    const reason = (user.blacklistReason || '').trim();
    return isApi
      ? res.status(403).json({ error: 'Your account has been blacklisted.', reason: reason || undefined })
      : res.redirect('/denied?reason=blacklisted' + (reason ? '&msg=' + encodeURIComponent(reason.slice(0, 300)) : ''));
  }

  if (user.mustReauth) {
    res.clearCookie('iacms_token');
    return isApi
      ? res.status(401).json({ error: 'Your access has changed. Please sign in again.' })
      : res.redirect('/login?error=access_revoked');
  }

  // 3) Server-side session check — gives instant revocation ("sign out
  //    everywhere") and powers the Active Sessions panel. Tokens issued before
  //    this feature (no `sid`) are treated as stale → re-login. A transient DB
  //    error here must NOT log the user out (same reasoning as the user load).
  if (payload.sid) {
    let session;
    try {
      session = await prisma.session.findUnique({ where: { id: payload.sid } });
    } catch (dbErr) {
      console.error('[Auth] session lookup failed (transient):', dbErr.message);
      return isApi
        ? res.status(503).json({ error: 'Server busy — please retry.' })
        : res.status(503).send('Server busy — please refresh in a moment.');
    }
    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      res.clearCookie('iacms_token');
      return isApi
        ? res.status(401).json({ error: 'Your session has ended. Please sign in again.' })
        : res.redirect('/login?error=access_revoked');
    }
    req.sessionId = session.id;
    // Rolling ("remember me") session: keep active users signed in. Piggyback
    // on the ~5-min lastSeen throttle to also push the expiry window forward
    // and reissue the cookie, so simply returning to the site keeps you logged
    // in until you explicitly log out. Never blocks the request.
    if (Date.now() - new Date(session.lastSeenAt).getTime() > 5 * 60 * 1000) {
      const SESSION_DAYS = parseInt(process.env.SESSION_DAYS, 10) || 60;
      const newExpiry = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
      prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date(), expiresAt: newExpiry } }).catch(() => {});
      try {
        const rolled = jwt.sign({ userId: user.id, sid: session.id }, process.env.JWT_SECRET, { expiresIn: `${SESSION_DAYS}d` });
        res.cookie('iacms_token', rolled, {
          httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax',
          maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
        });
      } catch (e) { /* non-fatal — the existing cookie still works */ }
    }
  } else {
    res.clearCookie('iacms_token');
    return isApi
      ? res.status(401).json({ error: 'Please sign in again.' })
      : res.redirect('/login?error=access_revoked');
  }

  req.user = user;
  next();

  // Opportunistic, non-blocking role refresh: if this user's roles haven't been
  // re-checked recently, re-derive them in the background so role changes (e.g.
  // a removed final-exam role) take effect on their next request — without
  // waiting for the periodic batch. Guarded per-user to avoid duplicate work.
  maybeRefreshRoles(user);
}

const REFRESH_TTL_MS = 3 * 60 * 1000; // don't refresh the same user more than ~every 3 min
const _refreshing = new Set();
function maybeRefreshRoles(user) {
  try {
    if (!user || user.discordId === DEVELOPER_DISCORD_ID()) return; // only the owner skips re-derivation
    const last = user.lastRoleCheck ? new Date(user.lastRoleCheck).getTime() : 0;
    if (Date.now() - last < REFRESH_TTL_MS) return;
    if (_refreshing.has(user.id)) return;
    _refreshing.add(user.id);
    (async () => {
      try {
        const { getMemberRecord } = require('../lib/bot');
        const { revalidateUser } = require('../lib/accessControl');
        await revalidateUser(user, getMemberRecord);
      } catch (e) { /* best-effort; the periodic batch is the backstop */ }
      finally { _refreshing.delete(user.id); }
    })();
  } catch (e) { /* never let a refresh error affect the request */ }
}

// HICOMM access: HICOMM, SUPERVISOR, or DEVELOPER
function requireHICOMM(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (['HICOMM', 'SUPERVISOR', 'DEVELOPER'].includes(req.user.role)) return next();
  return res.status(403).json({ error: 'HICOMM access required' });
}

// Stricter than requireHICOMM — HICOMM or DEVELOPER only (excludes SUPERVISOR).
// Supervisors can approve/deny cases & tickets but not view audit/quota tools.
function requireHICOMMStrict(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (['HICOMM', 'DEVELOPER'].includes(req.user.role)) return next();
  return res.status(403).json({ error: 'HICOMM access required' });
}

function requireDeveloper(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (req.user.role === 'DEVELOPER') return next();
  try { require('../lib/audit').denied(req, 'ACCESS_DENIED_DEV', `Non-developer (${req.user.role}) tried to reach a developer endpoint: ${req.method} ${req.originalUrl}`); } catch (e) {}
  return res.status(403).json({ error: 'Developer access required' });
}

// Optional auth: set req.user if a valid session exists, else leave it null and
// continue (never redirects/rejects). Used by public-but-personalisable areas
// like /support, where login is optional.
async function maybeAuth(req, res, next) {
  const token = req.cookies?.iacms_token;
  if (!token) { req.user = null; return next(); }
  let payload;
  try { payload = jwt.verify(token, process.env.JWT_SECRET); }
  catch (e) { req.user = null; return next(); }
  let user = null;
  try { user = await prisma.user.findUnique({ where: { id: payload.userId } }); }
  catch (e) { req.user = null; return next(); }
  if (!user || user.isBlacklisted || user.mustReauth) { req.user = null; return next(); }
  // Honour per-session revocation / force-reauth here too — a revoked or
  // sid-less session degrades to anonymous (guest) rather than keeping staff
  // capabilities on maybeAuth routes like /api/support.
  if (!payload.sid) { req.user = null; return next(); }
  let session = null;
  try { session = await prisma.session.findUnique({ where: { id: payload.sid } }); }
  catch (e) { req.user = null; return next(); }
  if (!session || session.revokedAt || session.expiresAt < new Date()) { req.user = null; return next(); }
  req.sessionId = session.id;
  req.user = user;
  next();
  maybeRefreshRoles(user);
}

module.exports = {
  requireAuth,
  maybeAuth,
  requireHICOMM,
  requireHICOMMStrict,
  requireDeveloper,
  ROLE_IA,
  ROLE_HICOMM,
  ROLE_SUPERVISOR,
  DEVELOPER_DISCORD_ID,
};
