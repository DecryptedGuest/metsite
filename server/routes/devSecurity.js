// server/routes/devSecurity.js — the Dev panel's Security Center.
// DEVELOPER-gated (mounted with requireDeveloper). Everything security-related
// lives here: active-session command + remote kill, break-glass lockdown, a
// global broadcast, the live security alert feed, and passkey compliance.
const express = require('express');
const prisma  = require('../lib/db');
const audit   = require('../lib/audit');
const siteConfig = require('../lib/siteConfig');
const { requireStepUpEnforced } = require('../middleware/stepup');

const router = express.Router();

// GET/POST /api/dev/security/require-passkey — the "elevated staff must have a
// passkey" enforcement toggle. To turn it ON you must already have a passkey
// yourself (so you can't lock yourself out of your own controls).
router.get('/require-passkey', async (req, res) => {
  const mine = await prisma.passkey.count({ where: { userId: req.user.id } }).catch(() => 0);
  res.json({ on: siteConfig.isOn('requirePasskeyElevated'), youHavePasskey: mine > 0 });
});
router.post('/require-passkey', async (req, res) => {
  try {
    const on = !!(req.body && req.body.on);
    if (on) {
      const mine = await prisma.passkey.count({ where: { userId: req.user.id } });
      if (mine === 0) return res.status(400).json({ error: 'Add a passkey to your own account first (profile → Passkeys & 2FA), or you would lock yourself out.' });
    }
    await siteConfig.set('requirePasskeyElevated', on ? 'true' : 'false');
    audit.record({ req, action: on ? 'PASSKEY_ENFORCE_ON' : 'PASSKEY_ENFORCE_OFF', category: 'SECURITY', targetType: 'site', summary: on ? 'Enabled passkey enforcement for elevated staff' : 'Disabled passkey enforcement' });
    res.json({ ok: true, on });
  } catch (e) { res.status(500).json({ error: 'Failed to update' }); }
});

const ELEVATED = ['IA', 'SUPERVISOR', 'HICOMM', 'DEVELOPER'];

// Four-eyes enforcement for the high-stakes site-wide actions (lockdown /
// force-reauth / broadcast). When MORE THAN ONE developer exists these must go
// through the two-developer approvals workflow (POST /approvals), not the direct
// endpoints — otherwise a single (or session-hijacked) developer bypasses the
// control by calling the direct endpoint. With a sole developer four-eyes is
// meaningless, so the direct endpoint is allowed.
async function requireSecondDevOrApprovals(req, res, next) {
  try {
    const devCount = await prisma.user.count({ where: { role: 'DEVELOPER' } });
    if (devCount > 1) return res.status(409).json({
      error: 'This action needs a second developer. Propose it under Security → Approvals and another developer confirms it.',
      code: 'FOUR_EYES_REQUIRED',
    });
  } catch (e) { /* count failed → allow (availability); still DEVELOPER + step-up gated */ }
  next();
}

// ── Active sessions ───────────────────────────────────────────────────
// GET /api/dev/security/sessions?userId=&history=1 — sessions with IP intel.
// Devs (and ONLY devs) see the IP, whether it was a VPN, and the account's most
// recent REAL non-VPN IP. Passing userId (or history=1) returns the full login
// history for that account — every session, including revoked/expired ones.
router.get('/sessions', async (req, res) => {
  try {
    const history = req.query.history === '1' || !!req.query.userId;
    const where = history ? {} : { revokedAt: null, expiresAt: { gt: new Date() } };
    if (req.query.userId) where.userId = String(req.query.userId);
    const now = new Date();
    const rows = await prisma.session.findMany({
      where, orderBy: { lastSeenAt: 'desc' }, take: history ? 500 : 300,
      include: { user: { select: { id: true, displayName: true, discordUsername: true, discordAvatar: true, role: true, lastRealIp: true, lastRealIpAt: true } } },
    });
    res.json(rows.map(s => ({
      id: s.id, userId: s.userId,
      user: s.user ? { name: s.user.displayName || s.user.discordUsername, role: s.user.role, avatar: s.user.discordAvatar,
        realIp: s.user.lastRealIp || null, realIpAt: s.user.lastRealIpAt || null } : null,
      ip: s.ip, ipVpn: !!s.ipVpn, ipOrg: s.ipOrg || null, device: s.device, userAgent: s.userAgent,
      createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, stepUpAt: s.stepUpAt,
      revoked: !!s.revokedAt, expired: s.expiresAt <= now,
      current: s.id === req.sessionId,
    })));
  } catch (e) { res.status(500).json({ error: 'Failed to load sessions' }); }
});

// POST /api/dev/security/sessions/:id/revoke — kill one session immediately.
router.post('/sessions/:id/revoke', requireStepUpEnforced, async (req, res) => {
  try {
    const s = await prisma.session.findUnique({ where: { id: req.params.id }, include: { user: { select: { displayName: true, discordUsername: true } } } });
    if (!s) return res.status(404).json({ error: 'Session not found' });
    await prisma.session.update({ where: { id: s.id }, data: { revokedAt: new Date() } });
    audit.record({ req, action: 'SESSION_REVOKE', category: 'SECURITY', targetType: 'session', targetId: s.id,
      targetName: s.user ? (s.user.displayName || s.user.discordUsername) : null, summary: `Revoked a session for ${s.user ? (s.user.displayName || s.user.discordUsername) : s.userId}` });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Failed to revoke session' }); }
});

// POST /api/dev/security/users/:id/force-reauth — revoke ALL of a user's
// sessions and require a fresh sign-in.
router.post('/users/:id/force-reauth', requireStepUpEnforced, requireSecondDevOrApprovals, async (req, res) => {
  try {
    const u = await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true, displayName: true, discordUsername: true } });
    if (!u) return res.status(404).json({ error: 'User not found' });
    const r = await prisma.session.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date() } });
    audit.record({ req, action: 'FORCE_REAUTH', category: 'SECURITY', targetType: 'user', targetId: u.id,
      targetName: u.displayName || u.discordUsername, summary: `Forced re-authentication for ${u.displayName || u.discordUsername} (${r.count} session(s) killed)` });
    res.json({ ok: true, killed: r.count });
  } catch (e) { res.status(500).json({ error: 'Failed to force re-auth' }); }
});

// ── Break-glass lockdown ──────────────────────────────────────────────
// GET/POST /api/dev/security/lockdown — sitePrivate blocks everyone but devs.
router.get('/lockdown', (req, res) => res.json({ on: siteConfig.isOn('sitePrivate') }));
router.post('/lockdown', requireStepUpEnforced, requireSecondDevOrApprovals, async (req, res) => {
  try {
    const on = !!(req.body && req.body.on);
    await siteConfig.set('sitePrivate', on ? 'true' : 'false');
    audit.record({ req, action: on ? 'LOCKDOWN_ON' : 'LOCKDOWN_OFF', category: 'SECURITY', targetType: 'site',
      summary: on ? 'Engaged site lockdown (developers only)' : 'Lifted site lockdown' });
    res.json({ ok: true, on });
  } catch (e) { res.status(500).json({ error: 'Failed to set lockdown' }); }
});

// ── Global broadcast ──────────────────────────────────────────────────
// POST /api/dev/security/broadcast { title, body, url?, banner? } — push to all
// subscribed devices and (optionally) raise a site-wide banner.
router.post('/broadcast', requireStepUpEnforced, requireSecondDevOrApprovals, async (req, res) => {
  try {
    const title = String((req.body && req.body.title) || 'Message from High Command').slice(0, 100);
    const body  = String((req.body && req.body.body) || '').slice(0, 300);
    const url   = req.body && req.body.url ? String(req.body.url).slice(0, 300) : '/profile';
    if (!body) return res.status(400).json({ error: 'A message is required.' });
    let pushed = 0;
    try { const { sendCustomNotification } = require('../lib/push'); const r = await sendCustomNotification({ all: true, title, body, url }); pushed = (r && r.sent) || 0; } catch (e) {}
    if (req.body && req.body.banner) {
      await siteConfig.set('bannerText', `${title} — ${body}`);
      if (req.body.bannerColor) await siteConfig.set('bannerColor', String(req.body.bannerColor).slice(0, 12));
    }
    audit.record({ req, action: 'BROADCAST', category: 'SECURITY', targetType: 'site', summary: `Broadcast: "${title}" — ${body}`.slice(0, 500) });
    res.json({ ok: true, pushed });
  } catch (e) { res.status(500).json({ error: 'Failed to broadcast' }); }
});
router.post('/broadcast/clear-banner', async (req, res) => {
  try { await siteConfig.set('bannerText', ''); audit.record({ req, action: 'BANNER_CLEAR', category: 'SECURITY', targetType: 'site', summary: 'Cleared the site banner' }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: 'Failed to clear banner' }); }
});

// ── Security alert feed ───────────────────────────────────────────────
// GET /api/dev/security/alerts — recent security-relevant audit events, plus
// impossible-travel / new-IP heuristics derived from sessions.
router.get('/alerts', async (req, res) => {
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const events = await prisma.auditLog.findMany({
      where: { createdAt: { gte: since }, category: { in: ['SECURITY', 'auth', 'moderation', 'ACCESS', 'admin', 'GROUP'] } },
      orderBy: { createdAt: 'desc' }, take: 100,
    });
    // Impossible travel: same user, 2+ distinct IPs seen within 15 min.
    const recentSessions = await prisma.session.findMany({
      where: { lastSeenAt: { gte: new Date(Date.now() - 60 * 60 * 1000) } },
      select: { userId: true, ip: true, lastSeenAt: true, user: { select: { displayName: true, discordUsername: true } } },
      take: 500,
    });
    const byUser = new Map();
    for (const s of recentSessions) {
      if (!s.ip) continue;
      const k = s.userId; const cur = byUser.get(k) || { name: s.user ? (s.user.displayName || s.user.discordUsername) : k, ips: new Set() };
      cur.ips.add(s.ip); byUser.set(k, cur);
    }
    const multiIp = [...byUser.values()].filter(v => v.ips.size >= 2).map(v => ({ name: v.name, ips: [...v.ips] }));
    // Count attack-adjacent signals (failed logins, lockouts, QR-phishing
    // mismatches, denied privileged access) in the last 24h for the badge.
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const SUSPICIOUS = /FAIL|LOCKOUT|MISMATCH|DENIED|SUSPICIOUS|SSRF/;
    const suspicious24h = events.filter(e => new Date(e.createdAt).getTime() >= dayAgo && SUSPICIOUS.test(e.action || '')).length;
    res.json({ events: events.map(audit.serialize), multiIp, suspicious24h });
  } catch (e) { res.status(500).json({ error: 'Failed to load alerts' }); }
});

// ── Live presence ─────────────────────────────────────────────────────
// GET /api/dev/security/presence — who's online now (active session seen in the
// last 5 minutes), deduped per user.
router.get('/presence', async (req, res) => {
  try {
    const since = new Date(Date.now() - 5 * 60 * 1000);
    const rows = await prisma.session.findMany({
      where: { revokedAt: null, lastSeenAt: { gte: since } },
      orderBy: { lastSeenAt: 'desc' }, take: 500,
      include: { user: { select: { id: true, displayName: true, discordUsername: true, discordAvatar: true, role: true } } },
    });
    const byUser = new Map();
    for (const s of rows) {
      if (!s.user) continue;
      const cur = byUser.get(s.user.id);
      if (!cur || new Date(s.lastSeenAt) > new Date(cur.lastSeenAt)) {
        byUser.set(s.user.id, { id: s.user.id, name: s.user.displayName || s.user.discordUsername, role: s.user.role, avatar: s.user.discordAvatar, lastSeenAt: s.lastSeenAt, ip: s.ip, device: s.device });
      }
    }
    res.json({ online: [...byUser.values()] });
  } catch (e) { res.status(500).json({ error: 'Failed to load presence' }); }
});

// ── Audit integrity ───────────────────────────────────────────────────
// POST /api/dev/security/audit/rebaseline — accept the current contents of
// every row written before `before` (default: now) as the baseline.
//
// This does NOT prove those rows were never edited — see audit.rebaseline. It
// draws a line so the trail is verifiable from here on. Requires an explicit
// acknowledgement so it cannot be clicked past.
router.post('/audit/rebaseline', async (req, res) => {
  const body = req.body || {};
  if (body.acknowledge !== true) {
    return res.status(400).json({
      error: 'This does not prove the older rows are untampered — it accepts them as the baseline. '
           + 'Send acknowledge:true to confirm.',
    });
  }
  try { res.json(await audit.rebaseline(body.before || undefined)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/dev/security/audit/verify — recompute every row's HMAC.
router.get('/audit/verify', async (req, res) => {
  try { res.json(await audit.verify()); }
  catch (e) { res.status(500).json({ error: 'Verify failed' }); }
});

// GET /api/dev/security/audit/export?format=csv|json — download the trail.
router.get('/audit/export', async (req, res) => {
  try {
    const rows = await prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 20000 });
    audit.record({ req, action: 'AUDIT_EXPORT', category: 'SECURITY', targetType: 'audit', summary: `Exported ${rows.length} audit rows` });
    if (String(req.query.format) === 'csv') {
      const esc = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
      const cols = ['createdAt', 'category', 'action', 'actorName', 'actorRole', 'targetType', 'targetId', 'targetName', 'summary', 'ip', 'hash'];
      const csv = [cols.join(',')].concat(rows.map(r => cols.map(c => esc(r[c])).join(','))).join('\n');
      res.set('Content-Type', 'text/csv');
      res.set('Content-Disposition', 'attachment; filename="met-audit-log.csv"');
      return res.send(csv);
    }
    res.set('Content-Disposition', 'attachment; filename="met-audit-log.json"');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Export failed' }); }
});

// ── Four-eyes approvals ───────────────────────────────────────────────
// A dev PROPOSES a high-stakes action; a DIFFERENT dev must approve it before
// it runs. Supported actions: LOCKDOWN {on}, FORCE_REAUTH {userId,name?},
// BROADCAST {title,body,url?,banner?}.
const FOUR_EYES_ACTIONS = ['LOCKDOWN', 'FORCE_REAUTH', 'BROADCAST'];

async function executeApproval(a, approver) {
  const p = a.params || {};
  if (a.action === 'LOCKDOWN') {
    await siteConfig.set('sitePrivate', p.on ? 'true' : 'false');
  } else if (a.action === 'FORCE_REAUTH') {
    await prisma.session.updateMany({ where: { userId: String(p.userId), revokedAt: null }, data: { revokedAt: new Date() } });
  } else if (a.action === 'BROADCAST') {
    try { const { sendCustomNotification } = require('../lib/push'); await sendCustomNotification({ all: true, title: p.title || 'Message from High Command', body: p.body || '', url: p.url || '/profile' }); } catch (e) {}
    if (p.banner) await siteConfig.set('bannerText', `${p.title || 'High Command'} — ${p.body || ''}`);
  }
}

router.get('/approvals', async (req, res) => {
  try {
    const rows = await prisma.pendingApproval.findMany({ where: { status: 'PENDING' }, orderBy: { createdAt: 'desc' }, take: 100 });
    res.json(rows.map(a => ({ id: a.id, action: a.action, params: a.params, reason: a.reason, requestedById: a.requestedById, requestedByName: a.requestedByName, createdAt: a.createdAt, mine: a.requestedById === req.user.id })));
  } catch (e) { res.status(500).json({ error: 'Failed to load approvals' }); }
});

router.post('/approvals', requireStepUpEnforced, async (req, res) => {
  try {
    const action = String((req.body && req.body.action) || '').toUpperCase();
    if (!FOUR_EYES_ACTIONS.includes(action)) return res.status(400).json({ error: 'Unknown action' });
    const a = await prisma.pendingApproval.create({ data: {
      action, params: (req.body && req.body.params) || {}, reason: req.body && req.body.reason ? String(req.body.reason).slice(0, 500) : null,
      requestedById: req.user.id, requestedByName: req.user.displayName || req.user.discordUsername,
    } });

    // Four-eyes needs a SECOND developer — but if this is the only developer on
    // the site, there's nobody else to approve, so it executes immediately.
    const devCount = await prisma.user.count({ where: { role: 'DEVELOPER' } }).catch(() => 2);
    if (devCount <= 1) {
      await executeApproval(a, req.user);
      await prisma.pendingApproval.update({ where: { id: a.id }, data: { status: 'APPROVED', resolvedById: req.user.id, resolvedByName: req.user.displayName || req.user.discordUsername, resolvedAt: new Date() } });
      audit.record({ req, action: 'APPROVAL_AUTO', category: 'SECURITY', targetType: 'approval', targetId: a.id, summary: `Executed ${action} (sole developer — no second approval required)` });
      return res.status(201).json({ ok: true, id: a.id, executed: true });
    }

    audit.record({ req, action: 'APPROVAL_PROPOSE', category: 'SECURITY', targetType: 'approval', targetId: a.id, summary: `Proposed ${action} (awaiting a second developer)` });
    res.status(201).json({ ok: true, id: a.id });
  } catch (e) { res.status(500).json({ error: 'Failed to propose' }); }
});

router.post('/approvals/:id/approve', requireStepUpEnforced, async (req, res) => {
  try {
    const a = await prisma.pendingApproval.findUnique({ where: { id: req.params.id } });
    if (!a || a.status !== 'PENDING') return res.status(404).json({ error: 'Not found or already resolved' });
    // A different developer must approve — unless this is the only developer.
    if (a.requestedById === req.user.id) {
      const devCount = await prisma.user.count({ where: { role: 'DEVELOPER' } }).catch(() => 2);
      if (devCount > 1) return res.status(403).json({ error: 'A different developer must approve this — you proposed it.' });
    }
    await executeApproval(a, req.user);
    await prisma.pendingApproval.update({ where: { id: a.id }, data: { status: 'APPROVED', resolvedById: req.user.id, resolvedByName: req.user.displayName || req.user.discordUsername, resolvedAt: new Date() } });
    audit.record({ req, action: 'APPROVAL_APPROVE', category: 'SECURITY', targetType: 'approval', targetId: a.id, summary: `Approved + executed ${a.action} (proposed by ${a.requestedByName})` });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Failed to approve' }); }
});

router.post('/approvals/:id/reject', async (req, res) => {
  try {
    const a = await prisma.pendingApproval.findUnique({ where: { id: req.params.id } });
    if (!a || a.status !== 'PENDING') return res.status(404).json({ error: 'Not found' });
    await prisma.pendingApproval.update({ where: { id: a.id }, data: { status: 'REJECTED', resolvedById: req.user.id, resolvedByName: req.user.displayName || req.user.discordUsername, resolvedAt: new Date() } });
    audit.record({ req, action: 'APPROVAL_REJECT', category: 'SECURITY', targetType: 'approval', targetId: a.id, summary: `Rejected ${a.action} (proposed by ${a.requestedByName})` });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Failed to reject' }); }
});

// ── Passkey compliance ────────────────────────────────────────────────
// GET /api/dev/security/passkey-compliance — which elevated staff have a
// passkey enrolled (2FA readiness board).
router.get('/passkey-compliance', async (req, res) => {
  try {
    const staff = await prisma.user.findMany({ where: { role: { in: ELEVATED } }, select: { id: true, displayName: true, discordUsername: true, role: true, _count: { select: { passkeys: true } } } });
    const rows = staff.map(u => ({ id: u.id, name: u.displayName || u.discordUsername, role: u.role, passkeys: u._count.passkeys, compliant: u._count.passkeys > 0 }))
      .sort((a, b) => Number(a.compliant) - Number(b.compliant));
    res.json({ rows, compliant: rows.filter(r => r.compliant).length, total: rows.length });
  } catch (e) { res.status(500).json({ error: 'Failed to load compliance' }); }
});

module.exports = router;
