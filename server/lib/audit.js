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
//
// It must also match what Postgres ACTUALLY STORES, not what the caller passed:
//
//   · a key whose value is `undefined` is dropped by JSON.stringify and never
//     reaches jsonb, so hashing it as present made the row unverifiable the
//     moment it was written. This is not hypothetical — an AI scan that
//     returned no score passed `{ overall: undefined }`, and every one of those
//     rows read as tampered forever after.
//   · `undefined` inside an ARRAY becomes null, because an array has no key to
//     drop and JSON has no undefined.
//   · a function or a symbol behaves the same way in both positions.
//
// Anything this gets wrong shows up as a tamper alert on a row nobody touched,
// which is worse than useless: it teaches people to ignore the alert.
function isDropped(v) {
  return v === undefined || typeof v === 'function' || typeof v === 'symbol';
}

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(isDropped(v) ? null : v);
  if (Array.isArray(v)) return '[' + v.map(x => (isDropped(x) ? 'null' : stableStringify(x))).join(',') + ']';
  return '{' + Object.keys(v).sort()
    .filter(k => !isDropped(v[k]))
    .map(k => JSON.stringify(k) + ':' + stableStringify(v[k]))
    .join(',') + '}';
}

// The pre-fix stringifier, kept only so a row written under it can be
// recognised as legitimately-written-but-wrongly-hashed and repaired. Never
// used to write anything.
function legacyStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(legacyStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + legacyStringify(v[k])).join(',') + '}';
}

// A per-row tamper-evidence HMAC over the immutable fields. Editing any field in
// the DB without the secret invalidates the hash, which the verify pass detects.
function canonicalFor(r, stringify) {
  return [
    r.id, r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
    r.category, r.action, r.actorId || '', r.actorName || '', r.actorRole || '',
    r.targetType || '', r.targetId || '', r.targetName || '', r.division || '',
    r.summary || '', r.ip || '', stringify(r.metadata == null ? null : r.metadata),
  ].join('␟');
}

function rowHash(r) {
  return crypto.createHmac('sha256', auditSecret()).update(canonicalFor(r, stableStringify)).digest('hex');
}

// What this row's hash WOULD have been under the pre-fix stringifier. A match
// here means the row is genuine and only its hash is stale.
function legacyRowHash(r) {
  return crypto.createHmac('sha256', auditSecret()).update(canonicalFor(r, legacyStringify)).digest('hex');
}

function clientIp(req) {
  if (!req) return null;
  try {
    const { getClientIp } = require('../middleware/visit');
    if (typeof getClientIp === 'function') return getClientIp(req);
  } catch (e) { /* fall through */ }
  // Same resolver as the visit log — behind Cloudflare the first x-forwarded-for
  // entry is an edge address, not the person.
  try { return require('./clientIp').clientIp(req); } catch (e) { return req.ip || null; }
}

// Internal writer — stamps id + createdAt in code (so the hash covers them),
// computes the tamper-evidence HMAC, then persists.
async function write(data) {
  try {
    // Developer/maintenance actions are never recorded in the audit trail — they
    // must not surface for MET HICOMM (or anyone) in any log view. (The DEV
    // category is also the default when a caller omits one.)
    if (String((data && data.category) || 'DEV').toUpperCase() === 'DEV') return;
    const row = { id: crypto.randomUUID(), createdAt: new Date(), ...data };
    row.hash = rowHash(row);
    await prisma.auditLog.create({ data: row });
  } catch (e) { console.warn('[Audit] write failed:', e.message); }
}

// Verify the whole trail: recompute each row's HMAC and report mismatches.
//
// A row is reported three ways, not two. "Tampered" has to mean somebody
// changed the data — if it also means "written by a version of this file with a
// hashing bug", the alert is noise and gets ignored, which is the one outcome a
// tamper trail cannot survive. Rows that verify under the OLD stringifier are
// genuine and are reported separately as `stale`, with a repair available.
async function verify(limit = 5000) {
  const rows = await prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: limit });
  let ok = 0;
  const tampered = [], stale = [];
  for (const r of rows) {
    if (!r.hash) continue; // written before hashing existed — not counted
    if (rowHash(r) === r.hash) { ok++; continue; }
    const brief = { id: r.id, action: r.action, createdAt: r.createdAt, summary: r.summary };
    if (legacyRowHash(r) === r.hash) stale.push(brief);
    else tampered.push(brief);
  }
  return {
    checked: rows.length, ok, tampered, stale,
    unhashed: rows.filter(r => !r.hash).length,
  };
}

/**
 * Re-baseline the trail: accept the CURRENT contents of every row written
 * before `before` and re-hash them.
 *
 * Be clear about what this does and does not prove, because the honest answer
 * is uncomfortable. Rows written with a dropped key were hashed over a field
 * the database never stored — and at verify time that field is gone, so there
 * is no way to recompute what the original hash covered. The information
 * needed to tell "written before the fix" from "edited by hand" is not
 * recoverable. Anyone who says otherwise is guessing.
 *
 * So this does not repair anything and does not vindicate anything. It draws a
 * line: everything before `before` is taken as the baseline, and the trail's
 * integrity guarantee runs from there. Tampering AFTER that line is still
 * detected exactly as before, which is the guarantee that actually matters
 * going forward.
 *
 * It is deliberately not automatic, and the UI says all of the above before
 * offering the button.
 *
 * @returns {Promise<{ rebaselined: number, checked: number, before: Date }>}
 */
async function rebaseline(before) {
  const cutoff = before ? new Date(before) : new Date();
  const rows = await prisma.auditLog.findMany({
    where: { createdAt: { lt: cutoff } },
    orderBy: { createdAt: 'desc' },
    take: 50000,
  });
  let rebaselined = 0;
  for (const r of rows) {
    if (!r.hash) continue;
    if (rowHash(r) === r.hash) continue;
    try {
      await prisma.auditLog.update({ where: { id: r.id }, data: { hash: rowHash(r) } });
      rebaselined++;
    } catch (e) { /* one bad row must not stop the sweep */ }
  }
  console.log(`[Audit] re-baselined ${rebaselined} row(s) written before ${cutoff.toISOString()}`);
  return { rebaselined, checked: rows.length, before: cutoff };
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

// Throttled "access denied" logger for suspicious probing of privileged gates.
// Records at most once per (user, action) per 5 minutes so an attacker hammering
// an endpoint can't flood the audit trail, while still surfacing the attempt.
const _deniedThrottle = new Map();
function denied(req, action, summary) {
  try {
    const uid = (req && req.user && req.user.id) || (req && clientIp(req)) || 'anon';
    const key = uid + ':' + action;
    const now = Date.now();
    if (now - (_deniedThrottle.get(key) || 0) < 5 * 60 * 1000) return;
    _deniedThrottle.set(key, now);
    if (_deniedThrottle.size > 5000) _deniedThrottle.clear(); // bound memory
    record({ req, action, category: 'SECURITY', targetType: 'user',
      targetId: (req && req.user && req.user.id) || null, summary });
  } catch (e) { /* logging must never break the request */ }
}

module.exports = {
  rebaseline, legacyRowHash, record, log, serialize, write, clientIp, verify, rowHash, denied };
