// server/middleware/visit.js
// Logs website page visits with IP + linked Discord/Roblox identity (if any).
const jwt    = require('jsonwebtoken');
const prisma = require('../lib/db');

// Resolve the real client IP, honouring the proxy (Railway) X-Forwarded-For header.
function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || null;
}

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
            if (ip && ip !== u.lastRealIp) {
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
