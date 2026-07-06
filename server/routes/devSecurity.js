// server/routes/devSecurity.js — the Dev panel's Security Center.
// DEVELOPER-gated (mounted with requireDeveloper). Everything security-related
// lives here: active-session command + remote kill, break-glass lockdown, a
// global broadcast, the live security alert feed, and passkey compliance.
const express = require('express');
const prisma  = require('../lib/db');
const audit   = require('../lib/audit');
const siteConfig = require('../lib/siteConfig');

const router = express.Router();

const ELEVATED = ['IA', 'SUPERVISOR', 'HICOMM', 'DEVELOPER'];

// ── Active sessions ───────────────────────────────────────────────────
// GET /api/dev/security/sessions?userId=&all=1 — active (non-revoked) sessions.
router.get('/sessions', async (req, res) => {
  try {
    const where = { revokedAt: null, expiresAt: { gt: new Date() } };
    if (req.query.userId) where.userId = String(req.query.userId);
    const rows = await prisma.session.findMany({
      where, orderBy: { lastSeenAt: 'desc' }, take: 300,
      include: { user: { select: { id: true, displayName: true, discordUsername: true, discordAvatar: true, role: true } } },
    });
    res.json(rows.map(s => ({
      id: s.id, userId: s.userId,
      user: s.user ? { name: s.user.displayName || s.user.discordUsername, role: s.user.role, avatar: s.user.discordAvatar } : null,
      ip: s.ip, device: s.device, userAgent: s.userAgent,
      createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, stepUpAt: s.stepUpAt,
      current: s.id === req.sessionId,
    })));
  } catch (e) { res.status(500).json({ error: 'Failed to load sessions' }); }
});

// POST /api/dev/security/sessions/:id/revoke — kill one session immediately.
router.post('/sessions/:id/revoke', async (req, res) => {
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
router.post('/users/:id/force-reauth', async (req, res) => {
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
router.post('/lockdown', async (req, res) => {
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
router.post('/broadcast', async (req, res) => {
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
    res.json({ events: events.map(audit.serialize), multiIp });
  } catch (e) { res.status(500).json({ error: 'Failed to load alerts' }); }
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
