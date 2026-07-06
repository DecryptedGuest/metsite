// server/lib/audit.js
// Immutable audit trail. Every privileged action across the portal records
// who did what, to whom, and the before→after — searchable from the MET HICOMM
// oversight dashboard. Writes are best-effort and MUST never block the action
// they describe (a failed audit write is logged and swallowed).
const prisma = require('./db');

// Record one action. `actor` is the acting req.user; the rest describe it.
//   category  — coarse bucket: GROUP | SUPPORT | TRYOUT | CASE | TICKET | ACCESS | DEV
//   action    — verb slug: RANK_CHANGE | KICK | BLACKLIST | CLOSE | DELETE | APPROVE …
//   target    — { type, id?, name? } the thing acted upon
//   summary   — one-line human description (shown in the trail)
//   meta      — optional before/after or extra context (JSON)
async function record(actor, { category, action, target = {}, summary = null, meta = null } = {}) {
  try {
    await prisma.auditLog.create({
      data: {
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
        meta:       meta || undefined,
      },
    });
  } catch (e) {
    console.warn('[Audit] record failed:', e.message);
  }
}

// Fire-and-forget wrapper (never awaited by callers on the hot path).
function log(actor, entry) { record(actor, entry).catch(() => {}); }

function serialize(a) {
  return {
    id: a.id, category: a.category, action: a.action,
    actorId: a.actorId, actorName: a.actorName, actorRole: a.actorRole,
    targetType: a.targetType, targetId: a.targetId, targetName: a.targetName,
    division: a.division, summary: a.summary, meta: a.meta || null,
    createdAt: a.createdAt,
  };
}

module.exports = { record, log, serialize };
