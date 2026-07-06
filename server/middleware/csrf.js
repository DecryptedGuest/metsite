// server/middleware/csrf.js — double-submit-cookie CSRF protection.
//
// The auth cookie is SameSite=Lax, which already blocks most cross-site POSTs,
// but we add a second, explicit check for defence in depth: a non-httpOnly
// `csrf_token` cookie the browser JS reads and echoes back in the
// `X-CSRF-Token` header on every state-changing request. A cross-site attacker
// can trigger a request with the victim's cookies but cannot read the cookie
// value to set the matching header (same-origin policy), so the two won't match.
const crypto = require('crypto');

const COOKIE = 'csrf_token';

// Attach a CSRF token cookie to page loads so the client always has one to echo.
// Safe methods only — never issue a fresh token mid-mutation.
function issueCsrfToken(req, res, next) {
  try {
    if (!req.cookies || !req.cookies[COOKIE]) {
      const token = crypto.randomBytes(24).toString('hex');
      res.cookie(COOKIE, token, {
        httpOnly: false, // must be readable by client JS to echo in the header
        secure:   process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge:   7 * 24 * 60 * 60 * 1000,
        path:     '/',
      });
      // Make it available to the same response's handlers if needed.
      req.cookies[COOKIE] = token;
    }
  } catch (e) { /* never block a request on token issuance */ }
  next();
}

// Enforce the token on state-changing requests. GET/HEAD/OPTIONS are exempt.
function requireCsrf(req, res, next) {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();

  // Machine-to-machine callbacks authenticate with their own shared secret and
  // carry NO browser cookies, so CSRF (a cookie-riding attack) doesn't apply.
  // Exempt the Roblox game callbacks and anything presenting the game secret.
  const url = req.originalUrl || req.url || '';
  if (url.startsWith('/api/game') || req.headers['x-game-secret']) return next();

  const cookieToken = req.cookies && req.cookies[COOKIE];
  const headerToken = req.headers['x-csrf-token'];

  if (!cookieToken || !headerToken || !timingSafeEqual(cookieToken, headerToken)) {
    return res.status(403).json({ error: 'Invalid or missing CSRF token. Please refresh the page and try again.' });
  }
  next();
}

function timingSafeEqual(a, b) {
  try {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch (e) { return false; }
}

module.exports = { issueCsrfToken, requireCsrf, CSRF_COOKIE: COOKIE };
