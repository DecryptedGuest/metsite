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
    return isApi
      ? res.status(403).json({ error: 'Your account has been blacklisted.' })
      : res.redirect('/denied?reason=blacklisted');
  }

  if (user.mustReauth) {
    res.clearCookie('iacms_token');
    return isApi
      ? res.status(401).json({ error: 'Your access has changed. Please sign in again.' })
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
    if (!user || user.role === 'DEVELOPER') return;
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
  return res.status(403).json({ error: 'Developer access required' });
}

module.exports = {
  requireAuth,
  requireHICOMM,
  requireHICOMMStrict,
  requireDeveloper,
  ROLE_IA,
  ROLE_HICOMM,
  ROLE_SUPERVISOR,
  DEVELOPER_DISCORD_ID,
};
