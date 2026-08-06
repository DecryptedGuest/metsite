// server/middleware/visit.js
// Logs website page visits with IP + linked Discord/Roblox identity (if any).
const jwt    = require('jsonwebtoken');
const prisma = require('../lib/db');

// The visitor's real IP. Behind Cloudflare, x-forwarded-for as it arrives here
// names the last proxy rather than the browser, so this is not a one-liner — see
// lib/clientIp.js, which also knows which addresses belong to Cloudflare and must
// never be treated as somebody's own.
const { clientIp, isRealClientIp } = require('../lib/clientIp');
function getClientIp(req) { return clientIp(req); }

// Express middleware — records a visit row without blocking the response.
function recordVisit(req, res, next) {
  next(); // never delay the page render

  setImmediate(async () => {
    try {
      const ip = getClientIp(req);

      let info = {
        userId: null, discordId: null, discordUsername: null,
        robloxId: null, robloxUsername: null,
      };

      const token = req.cookies?.iacms_token;
      if (token) {
        try {
          const payload = jwt.verify(token, process.env.JWT_SECRET);
          const u = await prisma.user.findUnique({
            where:  { id: payload.userId },
            select: {
              id: true, discordId: true, discordUsername: true,
              robloxId: true, robloxUsername: true, lastRealIp: true,
            },
          });
          if (u) {
            info = {
              userId: u.id, discordId: u.discordId, discordUsername: u.discordUsername,
              robloxId: u.robloxId, robloxUsername: u.robloxUsername,
            };
            // If they're visiting from a new IP, re-classify it (VPN?) and refresh
            // the account's most-recent real IP — dev-panel only, best-effort.
            // Only a REAL address is worth classifying or storing as theirs. A
            // proxy's address shared by every visitor is what made alt detection
            // link unrelated members to each other.
            if (ip && isRealClientIp(ip) && ip !== u.lastRealIp) {
              require('../lib/ipIntel').classifyAndRecord({ userId: u.id, ip }).catch(() => {});
            }
          }
        } catch { /* invalid/expired token → anonymous visit */ }
      }

      await prisma.visit.create({
        data: {
          path:      req.path,
          ip,
          userAgent: req.headers['user-agent'] || null,
          ...info,
        },
      });
    } catch (err) {
      console.error('[Visit] log error:', err.message);
    }
  });
}

module.exports = { recordVisit, getClientIp };
