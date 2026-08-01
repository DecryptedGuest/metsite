// server/lib/claimToken.js — short-lived signed token that authorises claiming a
// specific support ticket straight from a push notification.
//
// The service worker can't always read the double-submit CSRF cookie, so a
// notification-initiated claim carries this token instead. It only ever exists
// inside the push payload (which web pages can't read), so it's a valid CSRF
// substitute: an attacker can neither forge it nor obtain it. The session cookie
// still authenticates WHO is claiming.
const crypto = require('crypto');

function secret() {
  return process.env.CLAIM_TOKEN_SECRET || process.env.JWT_SECRET || 'met-claim-token-fallback';
}

// Sign a token for `ticketId`, valid for `ttlMs` (default 2h). Format: "<exp>.<hmac>".
function signClaimToken(ticketId, ttlMs) {
  const exp = Date.now() + (ttlMs || 2 * 60 * 60 * 1000);
  const h = crypto.createHmac('sha256', secret()).update(String(ticketId) + ':' + exp).digest('hex').slice(0, 40);
  return exp + '.' + h;
}

function verifyClaimToken(token, ticketId) {
  if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return false;
  const dot = token.indexOf('.');
  const exp = parseInt(token.slice(0, dot), 10);
  const h = token.slice(dot + 1);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  const expect = crypto.createHmac('sha256', secret()).update(String(ticketId) + ':' + exp).digest('hex').slice(0, 40);
  try { return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(expect)); } catch (e) { return false; }
}

module.exports = { signClaimToken, verifyClaimToken };
