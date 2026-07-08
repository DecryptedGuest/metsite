// server/lib/audit.js — the unified immutable audit trail.
// Merges two call styles onto one `audit_log` table:
//   • log(actor, { category, action, target:{type,id,name,division}, summary, metadata })
//       — the MET HICOMM / dev-oversight style (actor is a req.user or null).
//   • record({ req, action, category, targetType, targetId, summary, metadata })
//       — the security-trail style (actor taken from req.user; captures ip).
// Best-effort: a failed audit write is logged and swallowed, never thrown into
// the caller (an audit failure must not break the action it records).
const prisma = require('./db');
const crypto = require('crypto');

function auditSecret() { return process.env.AUDIT_HMAC_SECRET || process.env.JWT_SECRET || 'met-audit-fallback'; }

// Deterministic JSON: sort object keys recursively so the byte stream is the
// same at write time and at verify time (jsonb reorders keys, which otherwise
// makes a legitimate multi-key metadata row read as "tampered").
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

// A per-row tamper-evidence HMAC over the immutable fields. Editing any field in
// the DB without the secret invalidates the hash, which the verify pass detects.
function rowHash(r) {
  const canonical = [
    r.id, r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
    r.category, r.action, r.actorId || '', r.actorName || '', r.actorRole || '',
    r.targetType || '', r.targetId || '', r.targetName || '', r.division || '',
    r.summary || '', r.ip || '', stableStringify(r.metadata == null ? null : r.metadata),
  ].join('␟');
  return crypto.createHmac('sha256', auditSecret()).update(canonical).digest('hex');
}

function clientIp(req) {
  if (!req) return null;
  try {
    const { getClientIp } = require('../middleware/visit');
    if (typeof getClientIp === 'function') return getClientIp(req);
  } catch (e) { /* fall through */ }
  return (req.headers && (req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.ip || null;
}

// Internal writer — stamps id + createdAt in code (so the hash covers them),
// computes the tamper-evidence HMAC, then persists.
async function write(data) {
  try {
    const row = { id: crypto.randomUUID(), createdAt: new Date(), ...data };
    row.hash = rowHash(row);
    await prisma.auditLog.create({ data: row });
  } catch (e) { console.warn('[Audit] write failed:', e.message); }
}

// Verify the whole trail: recompute each row's HMAC and report mismatches.
async function verify(limit = 5000) {
  const rows = await prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: limit });
  let ok = 0; const tampered = [];
  for (const r of rows) {
    if (!r.hash) continue; // legacy rows written before hashing — not counted
    if (rowHash(r) === r.hash) ok++;
    else tampered.push({ id: r.id, action: r.action, createdAt: r.createdAt, summary: r.summary });
  }
  return { checked: rows.length, ok, tampered, unhashed: rows.filter(r => !r.hash).length };
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

module.exports = { record, log, serialize, write, clientIp, verify, rowHash };
