// server/routes/admin.js — Developer-only management endpoints
const express = require('express');
const prisma  = require('../lib/db');
const { requireDeveloper } = require('../middleware/auth');
const {
  listGroupRoles, listGroupMembers, listJoinRequests,
  resolveJoinRequest, changeGroupRank, exileFromGroup,
} = require('../lib/roblox');

const router = express.Router();

// All routes require DEVELOPER role
router.use(requireDeveloper);

// ── GET /api/admin/users ──────────────────────────────────────────
router.get('/users', async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, discordId: true, discordUsername: true,
        displayName: true, discordAvatar: true, role: true,
        isBlacklisted: true, blacklistReason: true,
        lastIp: true, robloxId: true, robloxUsername: true,
        createdAt: true, lastLogin: true,
        notifyEnabled: true,
        _count: { select: { cases: true, pushSubscriptions: true } },
      },
    });
    res.json(users.map(u => ({
      ...u,
      hasPush: u._count.pushSubscriptions > 0,
    })));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// ── PATCH /api/admin/users/:id/role ──────────────────────────────
router.patch('/users/:id/role', async (req, res) => {
  const { role } = req.body;
  if (!['IA', 'SUPERVISOR', 'HICOMM', 'DEVELOPER'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  // Prevent dev from demoting themselves
  if (req.params.id === req.user.id && role !== 'DEVELOPER') {
    return res.status(400).json({ error: 'Cannot change your own developer role' });
  }
  try {
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data:  { role },
    });
    await prisma.caseAction.create({
      data: {
        caseId:      (await prisma.case.findFirst({ where: { userId: req.params.id } }))?.id || req.user.id,
        actionType:  'CREATED', // reuse for audit
        performedBy: req.user.id,
        notes:       `Role changed to ${role} by Developer`,
      },
    }).catch(() => {}); // ignore if no case to attach to
    res.json({ success: true, role: user.role });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update role' });
  }
});

// ── POST /api/admin/users/:id/blacklist ──────────────────────────
router.post('/users/:id/blacklist', async (req, res) => {
  const { reason } = req.body;
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'Cannot blacklist yourself' });
  }
  try {
    await prisma.user.update({
      where: { id: req.params.id },
      data:  { isBlacklisted: true, blacklistReason: reason || 'No reason given' },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to blacklist user' });
  }
});

// ── POST /api/admin/users/:id/unblacklist ────────────────────────
router.post('/users/:id/unblacklist', async (req, res) => {
  try {
    await prisma.user.update({
      where: { id: req.params.id },
      data:  { isBlacklisted: false, blacklistReason: null },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to unblacklist user' });
  }
});

// ── DELETE /api/admin/cases/:id ───────────────────────────────────
router.delete('/cases/:id', async (req, res) => {
  try {
    const existing = await prisma.case.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Case not found' });

    await prisma.caseAction.deleteMany({ where: { caseId: req.params.id } });
    await prisma.casePunishment.deleteMany({ where: { caseId: req.params.id } });
    await prisma.case.delete({ where: { id: req.params.id } });

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /cases error:', err);
    res.status(500).json({ error: 'Failed to delete case' });
  }
});

// ── GET /api/admin/visits ─────────────────────────────────────────
// Developer-only website visit log (most recent first).
router.get('/visits', async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit) || 300, 1000);
    const visits = await prisma.visit.findMany({
      orderBy: { createdAt: 'desc' },
      take:    limit,
    });
    res.json(visits);
  } catch (err) {
    console.error('GET /visits error:', err.message);
    res.status(500).json({ error: 'Failed to fetch visits' });
  }
});

// ── Access Grants (authorise Discord IDs without Discord roles) ───
// GET /api/admin/access-grants
router.get('/access-grants', async (req, res) => {
  try {
    const grants = await prisma.accessGrant.findMany({ orderBy: { createdAt: 'desc' } });
    res.json(grants);
  } catch (err) {
    console.error('GET /access-grants error:', err.message);
    res.status(500).json({ error: 'Failed to fetch access grants' });
  }
});

// POST /api/admin/access-grants  { discordId, role, note }
router.post('/access-grants', async (req, res) => {
  const { discordId, role, note } = req.body;
  if (!/^\d{17,20}$/.test(discordId || '')) {
    return res.status(400).json({ error: 'A valid Discord user ID (17-20 digits) is required.' });
  }
  if (!['IA', 'SUPERVISOR', 'HICOMM', 'DEVELOPER'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role.' });
  }
  try {
    const grant = await prisma.accessGrant.upsert({
      where:  { discordId },
      update: { role, note: note?.trim() || null, grantedBy: req.user.id },
      create: { discordId, role, note: note?.trim() || null, grantedBy: req.user.id },
    });
    // If this person already has an account, apply the new role immediately
    await prisma.user.updateMany({ where: { discordId }, data: { role } }).catch(() => {});
    res.json(grant);
  } catch (err) {
    console.error('POST /access-grants error:', err.message);
    res.status(500).json({ error: 'Failed to create access grant' });
  }
});

// DELETE /api/admin/access-grants/:id  — revoke
router.delete('/access-grants/:id', async (req, res) => {
  try {
    const grant = await prisma.accessGrant.findUnique({ where: { id: req.params.id } });
    if (!grant) return res.status(404).json({ error: 'Access grant not found' });
    await prisma.accessGrant.delete({ where: { id: req.params.id } });
    // Force an immediate logout — they lose access now and can only return if
    // they hold the real Discord roles (re-login re-evaluates and clears the flag).
    await prisma.user.updateMany({
      where: { discordId: grant.discordId },
      data:  { mustReauth: true },
    }).catch(() => {});
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /access-grants error:', err.message);
    res.status(500).json({ error: 'Failed to revoke access grant' });
  }
});

// ── GET /api/admin/security ───────────────────────────────────────
// Developer-only screenshot/capture security log (most recent first).
router.get('/security', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 300, 1000);
    const logs  = await prisma.captureLog.findMany({
      orderBy: { createdAt: 'desc' },
      take:    limit,
    });
    res.json(logs);
  } catch (err) {
    console.error('GET /security error:', err.message);
    res.status(500).json({ error: 'Failed to fetch security logs' });
  }
});

// ── DELETE /api/admin/tickets/:id ─────────────────────────────────
router.delete('/tickets/:id', async (req, res) => {
  try {
    const existing = await prisma.ticket.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Ticket not found' });
    await prisma.ticket.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /tickets error:', err.message);
    res.status(500).json({ error: 'Failed to delete ticket' });
  }
});

// ── GET /api/admin/settings ───────────────────────────────────────
router.get('/settings', async (req, res) => {
  try {
    const settings = await prisma.systemSetting.findMany();
    const obj = {};
    settings.forEach(s => { obj[s.key] = s.value; });
    res.json(obj);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// ── PATCH /api/admin/settings ─────────────────────────────────────
router.patch('/settings', async (req, res) => {
  const siteConfig = require('../lib/siteConfig');
  const allowed = ['webhookUrl', 'systemName', 'maintenanceMode', ...siteConfig.KEYS];
  try {
    const updates = [];
    for (const [key, value] of Object.entries(req.body)) {
      if (!allowed.includes(key)) continue;
      updates.push(
        prisma.systemSetting.upsert({
          where:  { key },
          update: { value: String(value) },
          create: { key, value: String(value) },
        })
      );
    }
    await Promise.all(updates);
    await siteConfig.refresh(); // push changes into the live cache immediately
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// ── GET /api/admin/stats ──────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const [totalUsers, totalCases, totalActions, blacklisted] = await Promise.all([
      prisma.user.count(),
      prisma.case.count(),
      prisma.caseAction.count(),
      prisma.user.count({ where: { isBlacklisted: true } }),
    ]);
    res.json({ totalUsers, totalCases, totalActions, blacklisted });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch admin stats' });
  }
});

// ── GET /api/admin/group/debug ────────────────────────────────────
// Exercises the cookie-authenticated group functions so misconfiguration is visible
router.get('/group/debug', async (req, res) => {
  const groupId = process.env.ROBLOX_GROUP_ID;

  const probe = async (label, fn) => {
    try {
      const out = await fn();
      let summary = out;
      if (out && Array.isArray(out.members))  summary = { count: out.members.length,  sample: out.members[0] || null };
      if (out && Array.isArray(out.requests)) summary = { count: out.requests.length, sample: out.requests[0] || null };
      if (Array.isArray(out))                 summary = { count: out.length, sample: out[0] || null };
      return { label, ok: true, result: summary };
    } catch (e) {
      return { label, ok: false, error: e.message };
    }
  };

  const [rolesRes, membersRes, pendingRes] = await Promise.all([
    probe('roles',   () => listGroupRoles()),
    probe('members', () => listGroupMembers()),
    probe('pending', () => listJoinRequests()),
  ]);

  res.json({
    env: {
      groupId:   groupId || 'NOT SET',
      cookieSet: !!process.env.ROBLOX_COOKIE,
    },
    results: [rolesRes, membersRes, pendingRes],
  });
});

// ── GET /api/admin/group/roles ────────────────────────────────────
router.get('/group/roles', async (req, res) => {
  try {
    const roles = await listGroupRoles();
    res.json(roles);
  } catch (err) {
    console.error('GET /group/roles error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/group/members ──────────────────────────────────
router.get('/group/members', async (req, res) => {
  try {
    const { pageToken } = req.query;
    const result = await listGroupMembers(pageToken || null);
    res.json(result);
  } catch (err) {
    console.error('GET /group/members error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/group/pending ──────────────────────────────────
router.get('/group/pending', async (req, res) => {
  try {
    const { pageToken } = req.query;
    const result = await listJoinRequests(pageToken || null);
    res.json(result);
  } catch (err) {
    console.error('GET /group/pending error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/group/pending/:userId/approve ─────────────────
router.post('/group/pending/:userId/approve', async (req, res) => {
  try {
    await resolveJoinRequest(req.params.userId, 'approve');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to approve join request' });
  }
});

// ── POST /api/admin/group/pending/:userId/decline ─────────────────
router.post('/group/pending/:userId/decline', async (req, res) => {
  try {
    await resolveJoinRequest(req.params.userId, 'decline');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to decline join request' });
  }
});

// ── PATCH /api/admin/group/members/:userId/rank ───────────────────
router.patch('/group/members/:userId/rank', async (req, res) => {
  const { roleId } = req.body;
  if (!roleId) return res.status(400).json({ error: 'roleId is required' });
  try {
    await changeGroupRank(req.params.userId, roleId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to change rank' });
  }
});

// ── DELETE /api/admin/group/members/:userId ───────────────────────
router.delete('/group/members/:userId', async (req, res) => {
  try {
    await exileFromGroup(req.params.userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to kick member' });
  }
});

module.exports = router;
