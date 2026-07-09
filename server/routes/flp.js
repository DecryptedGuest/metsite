// server/routes/flp.js — Frontline Policing.
// Mounted at /api/flp behind requireAuth + requireDivision('FLP'). Group-panel
// endpoints add requireFlpGroupAdmin (Assistant Director+) and operate on the
// FLP Roblox group (GROUP_FLP) — same group-management helpers as the dev panel,
// scoped to FLP with an "assign below your own rank" guardrail.
const express = require('express');
const router  = express.Router();
const prisma  = require('../lib/db');

const { userFlpGroupAdmin, requireFlpGroupAdmin, userDivisions } = require('../middleware/division');
const { explicitGroupId } = require('../lib/divisions');
const patrolLib = require('../lib/patrolLog');
const bot = require('../lib/bot');
const {
  listGroupRoles, listGroupMembers, listJoinRequests,
  resolveJoinRequest, changeGroupRank, exileFromGroup,
} = require('../lib/roblox');

function flpGroupId() { return explicitGroupId('FLP'); }
function myFlpRank(user) {
  const e = userDivisions(user).find(d => d.division === 'FLP');
  return e ? Number(e.rank) : 0;
}

router.get('/', (req, res) => res.json({ division: 'flp' }));

// What the FLP dashboard can show for this user (drives the UI).
router.get('/context', (req, res) => {
  res.json({
    canGroupAdmin:    userFlpGroupAdmin(req.user),
    canReviewPatrols: true, // any FLP member (the route is already FLP-gated)
    flpRank:          myFlpRank(req.user),
    isDev:            req.user.role === 'DEVELOPER',
  });
});

// ── Patrol logs — reviewable by ANY FLP rank (the mount already gates to the
// FLP division); the bot reacts ✅/❌ on the original message. ─────────
router.get('/patrols', async (req, res) => {
  try {
    const type   = req.query.type === 'EVENT' ? 'EVENT' : 'PATROL';
    const where  = { type };
    // A specific status filters; "ALL" (or anything else) returns every status.
    if (['PENDING', 'APPROVED', 'DENIED'].includes(req.query.status)) where.status = req.query.status;
    // Order by the shift's own date (newest first), not the import time — so a
    // bulk import shows in real chronological order. Falls back to createdAt.
    const rows = await prisma.patrolLog.findMany({
      where,
      orderBy: [{ logDate: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      take: 2000,
    });
    res.json(rows.map(patrolLib.serialize));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load logs' });
  }
});

router.post('/patrols/:id/:action', async (req, res) => {
  const action = req.params.action;
  if (!['approve', 'deny'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
  try {
    const p = await prisma.patrolLog.findUnique({ where: { id: req.params.id } });
    if (!p) return res.status(404).json({ error: 'Log not found' });
    if (p.status !== 'PENDING') return res.status(400).json({ error: 'This log has already been reviewed.' });

    const status = action === 'approve' ? 'APPROVED' : 'DENIED';

    // Event logs award +1 on the MET database (best-effort; never blocks review).
    let pointResult = null;
    if (status === 'APPROVED' && p.type === 'EVENT') {
      pointResult = await patrolLib.awardMetEventPoint(p).catch(() => ({ ok: false }));
    }

    await prisma.patrolLog.update({
      where: { id: p.id },
      data: {
        status,
        pointAwarded: !!(pointResult && pointResult.ok),
        reviewedById: req.user.id,
        reviewedByName: req.user.displayName || req.user.discordUsername,
        reviewedAt: new Date(),
      },
    });
    const reacted = await bot.reactToMessage(p.channelId, p.messageId, action === 'approve' ? '✅' : '❌').catch(() => false);
    res.json({ success: true, status, reacted, point: pointResult });
  } catch (err) {
    console.error('[FLP] log review failed:', err.message);
    res.status(500).json({ error: 'Failed to review log' });
  }
});

// ── FLP group panel (Assistant Director+) ──────────────────────
router.get('/group/roles', requireFlpGroupAdmin, async (req, res) => {
  try { res.json(await listGroupRoles(flpGroupId())); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/group/members', requireFlpGroupAdmin, async (req, res) => {
  try { res.json(await listGroupMembers(req.query.pageToken || null, flpGroupId())); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/group/pending', requireFlpGroupAdmin, async (req, res) => {
  try { res.json(await listJoinRequests(req.query.pageToken || null, flpGroupId())); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/group/pending/:userId/:action', requireFlpGroupAdmin, async (req, res) => {
  const action = req.params.action === 'approve' ? 'approve' : 'decline';
  try { await resolveJoinRequest(req.params.userId, action, flpGroupId()); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/group/members/:userId/rank', requireFlpGroupAdmin, async (req, res) => {
  const { roleId } = req.body || {};
  if (!roleId) return res.status(400).json({ error: 'roleId is required' });
  try {
    const gid = flpGroupId();
    // Guardrail: a non-developer can only assign ranks BELOW their own FLP rank,
    // AND may only manage members who currently rank below them (so they can't
    // demote a superior). The frontend hides the control; this enforces it.
    if (req.user.role !== 'DEVELOPER') {
      const myRank = myFlpRank(req.user);
      const roles  = await listGroupRoles(gid);
      const target = roles.find(r => String(r.id) === String(roleId).split('/').pop());
      if (!target) return res.status(400).json({ error: 'Unknown role for this group.' });
      if (Number(target.rank) >= myRank) {
        return res.status(403).json({ error: 'You can only assign ranks below your own.' });
      }
      const { getUserGroupRole } = require('../lib/roblox');
      const cur = await getUserGroupRole(req.params.userId, gid).catch(() => null);
      const curRank = cur && cur.rank != null ? Number(cur.rank) : Infinity;
      if (curRank >= myRank) {
        return res.status(403).json({ error: 'You can only manage members ranked below your own.' });
      }
    }
    await changeGroupRank(req.params.userId, roleId, gid);
    require('../lib/audit').log(req.user, { category: 'GROUP', action: 'RANK_CHANGE', division: 'FLP',
      target: { type: 'roblox_user', id: req.params.userId }, summary: `Changed FLP group rank for Roblox user ${req.params.userId}` });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/group/members/:userId', requireFlpGroupAdmin, async (req, res) => {
  try {
    const gid = flpGroupId();
    // Can't kick a member who currently outranks (or equals) you (developers bypass).
    if (req.user.role !== 'DEVELOPER') {
      const { getUserGroupRole } = require('../lib/roblox');
      const cur = await getUserGroupRole(req.params.userId, gid).catch(() => null);
      const curRank = cur && cur.rank != null ? Number(cur.rank) : Infinity;
      if (curRank >= myFlpRank(req.user)) {
        return res.status(403).json({ error: 'You can only kick members ranked below your own.' });
      }
    }
    // exileFromGroup returns false (never throws) on failure — don't claim
    // success or log a KICK audit entry unless the exile actually happened.
    const ok = await exileFromGroup(req.params.userId, gid);
    if (!ok) return res.status(502).json({ error: 'Roblox rejected the kick (check the group bot cookie/permissions).' });
    require('../lib/audit').log(req.user, { category: 'GROUP', action: 'KICK', division: 'FLP',
      target: { type: 'roblox_user', id: req.params.userId }, summary: `Kicked Roblox user ${req.params.userId} from FLP group` });
    res.json({ success: true });
  }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/flp/analytics?days= — FLP patrol/event activity for the dashboard. ──
router.get('/analytics', async (req, res) => {
  try {
    const analytics = require('../lib/analytics');
    const days = analytics.normDays(req.query.days); // number, or 0 = all time
    const activity = await analytics.activityAnalytics(days);
    res.json({ division: 'FLP', days: activity.days, allTime: activity.allTime, activity });
  } catch (e) { res.status(500).json({ error: 'Failed to load analytics' }); }
});

module.exports = router;
