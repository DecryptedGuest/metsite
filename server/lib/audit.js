// server/lib/audit.js — write to the immutable portal audit trail.
// Best-effort: never throws into the caller (a failed audit write must not
// break the action it records).
const prisma = require('./db');

function clientIp(req) {
  if (!req) return null;
  try {
    const { getClientIp } = require('../middleware/visit');
    if (typeof getClientIp === 'function') return getClientIp(req);
  } catch (e) { /* fall through */ }
  return (req.headers && (req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.ip || null;
}

// record({ req, action, category, targetType, targetId, summary, metadata })
async function record(opts = {}) {
  try {
    const { req, action, category, targetType, targetId, summary, metadata } = opts;
    const actor = req && req.user;
    await prisma.auditLog.create({
      data: {
        action:     String(action || 'UNKNOWN'),
        category:   String(category || 'general'),
        actorId:    actor ? actor.id : (opts.actorId || null),
        actorName:  actor ? (actor.displayName || actor.discordUsername) : (opts.actorName || null),
        targetType: targetType || null,
        targetId:   targetId || null,
        summary:    summary ? String(summary).slice(0, 500) : null,
        metadata:   metadata || null,
        ip:         opts.ip || clientIp(req),
      },
    });
  } catch (e) {
    console.warn('[Audit] write failed:', e.message);
  }
}

module.exports = { record };
