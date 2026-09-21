// server/lib/dmOptOut.js
// One-click opt-out/opt-in links for the Internal Affairs ticket DMs. The link
// is signed (HMAC of the user id) so it works WITHOUT a login — a recipient can
// toggle their DMs straight from the Discord message — but can't be forged to
// change someone else's preference.
const crypto = require('crypto');

function secret() { return process.env.JWT_SECRET || process.env.AUDIT_HMAC_SECRET || 'met-dm-optout-fallback'; }

// A short, URL-safe signature bound to this user id + this purpose.
function ticketDmSig(userId) {
  return crypto.createHmac('sha256', secret()).update('ticket-dm:' + String(userId)).digest('hex').slice(0, 32);
}
function verifyTicketDmSig(userId, sig) {
  const want = ticketDmSig(userId);
  const got  = String(sig || '');
  if (got.length !== want.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got)); }
  catch (e) { return false; }
}

// Absolute site origin for links that must resolve outside the app (Discord
// buttons need a full https URL). Prefers PUBLIC_BASE_URL, then CANONICAL_HOST.
function siteBaseUrl() {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const host = (process.env.CANONICAL_HOST || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return host ? 'https://' + host : '';
}

// Build the toggle URL. off=true → opt OUT; off=false → opt back IN.
function ticketDmToggleUrl(userId, off) {
  const base = siteBaseUrl();
  const qs = `u=${encodeURIComponent(userId)}&sig=${ticketDmSig(userId)}&off=${off ? '1' : '0'}`;
  return `${base}/n/ticket-dm?${qs}`;
}

module.exports = { ticketDmSig, verifyTicketDmSig, siteBaseUrl, ticketDmToggleUrl };
