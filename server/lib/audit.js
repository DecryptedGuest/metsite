// server/lib/audit.js — the unified immutable audit trail.
// Merges two call styles onto one `audit_log` table:
//   • log(actor, { category, action, target:{type,id,name,division}, summary, metadata })
//       — the MET HICOMM / dev-oversight style (actor is a req.user or null).
//   • record({ req, action, category, targetType, targetId, summary, metadata })
//       — the security-trail style (actor taken from req.user; captures ip).
// Best-effort: a failed audit write is logged and swallowed, never thrown into
// the caller (an audit failure must not break the action it records).
const prisma = require('./db');

function clientIp(req) {
  if (!req) return null;
  try {
    const { getClientIp } = require('../middleware/visit');
    if (typeof getClientIp === 'function') return getClientIp(req);
  } catch (e) { /* fall through */ }
  return (req.headers && (req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.ip || null;
}

// Internal writer — takes a fully-normalised row.
async function write(data) {
  try { await prisma.auditLog.create({ data }); }
  catch (e) { console.warn('[Audit] write failed:', e.message); }
}

// Security-trail style: record({ req, action, category, targetType, targetId, summary, metadata, ip? })
async function record(opts = {}) {
  const { req, action, category, targetType, targetId, summary, metadata } = opts;
  const actor = req && req.user;
  await write({
    action:     String(action || 'UNKNOWN').slice(0, 40),
    category:   String(category || 'general').slice(0, 24),
    actorId:    actor ? actor.id : (opts.actorId || null),
    actorName:  actor ? (actor.displayName || actor.discordUsername || null) : (opts.actorName || null),
    actorRole:  actor ? (actor.role || null) : (opts.actorRole || null),
    targetType: targetType ? String(targetType).slice(0, 40) : null,
    targetId:   targetId ? String(targetId).slice(0, 100) : null,
    targetName: opts.targetName ? String(opts.targetName).slice(0, 200) : null,
    division:   opts.division ? String(opts.division).slice(0, 24) : null,
    summary:    summary ? String(summary).slice(0, 500) : null,
    metadata:   metadata || undefined,
    ip:         opts.ip || clientIp(req),
  });
}

// HICOMM / dev-oversight style: log(actor, { category, action, target, summary, metadata|meta })
function log(actor, { category, action, target = {}, summary = null, metadata = null, meta = null } = {}) {
  write({
    category:   String(category || 'DEV').toUpperCase().slice(0, 24),
    action:     String(action || 'ACTION').toUpperCase().slice(0, 40),
    actorId:    actor && actor.id ? actor.id : null,
    actorName:  actor ? (actor.displayName || actor.discordUsername || 'System') : 'System',
    actorRole:  actor ? (actor.role || null) : null,
    targetType: target.type ? String(target.type).slice(0, 40) : null,
    targetId:   target.id ? String(target.id).slice(0, 100) : null,
    targetName: target.name ? String(target.name).slice(0, 200) : null,
    division:   target.division ? String(target.division).slice(0, 24) : null,
    summary:    summary ? String(summary).slice(0, 500) : null,
    metadata:   metadata || meta || undefined,
  }).catch(() => {});
}

function serialize(a) {
  return {
    id: a.id, category: a.category, action: a.action,
    actorId: a.actorId, actorName: a.actorName, actorRole: a.actorRole,
    targetType: a.targetType, targetId: a.targetId, targetName: a.targetName,
    division: a.division, summary: a.summary, metadata: a.metadata || null, ip: a.ip || null,
    createdAt: a.createdAt,
  };
}

module.exports = { record, log, serialize, write, clientIp };
