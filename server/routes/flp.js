// server/routes/flp.js — Frontline Policing.
// Mounted at /api/flp behind requireAuth + requireDivision('FLP'). Group-panel
// endpoints add requireFlpGroupAdmin (Assistant Director+) and operate on the
// FLP Roblox group (GROUP_FLP) — same group-management helpers as the dev panel,
// scoped to FLP with an "assign below your own rank" guardrail.
const express = require('express');
const router  = express.Router();
const prisma  = require('../lib/db');

const { userFlpGroupAdmin, requireFlpGroupAdmin, userDivisions, userIsMetHicommCached } = require('../middleware/division');
const { explicitGroupId } = require('../lib/divisions');
const patrolLib = require('../lib/patrolLog');
const quotaLib = require('../lib/quota');
const { sendQuotaCheckWebhook } = require('../lib/webhook');
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

// ── FLP High Command gate ─────────────────────────────────────────
// Passes when: DEVELOPER or MET HICOMM; OR the FLP group rank ≥
// FLP_HICOMM_MIN_RANK (when that env is set); OR the user holds the Discord role
// FLP_HICOMM_ROLE_ID (when set). If NEITHER env is set, falls back to the
// existing Assistant-Director+ group-admin gate (userFlpGroupAdmin).
async function userFlpHicomm(user) {
  if (!user) return false;
  if (user.role === 'DEVELOPER' || userIsMetHicommCached(user)) return true;

  const min = parseInt(process.env.FLP_HICOMM_MIN_RANK, 10);
  const hasMin = Number.isFinite(min);
  const roleId = process.env.FLP_HICOMM_ROLE_ID;
  const hasRole = !!roleId;

  if (!hasMin && !hasRole) return userFlpGroupAdmin(user); // neither configured → AD+ fallback

  if (hasMin) {
    const e = userDivisions(user).find(d => d.division === 'FLP');
    if (e && Number(e.rank) >= min) return true;
  }
  if (hasRole && user.discordId) {
    try {
      const { getRoleHolders } = require('../lib/bot');
      const guildId = process.env.FLP_HICOMM_GUILD_ID || process.env.MET_GUILD_ID || process.env.DISCORD_GUILD_ID;
      if (guildId) {
        const holders = await getRoleHolders(guildId, roleId);
        const did = String(user.discordId).replace(/\D/g, '');
        if (holders && holders.has(did)) return true;
      }
    } catch (e) { /* bot unavailable → deny this path */ }
  }
  return false;
}

async function requireFlpHicomm(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  try { if (await userFlpHicomm(req.user)) return next(); }
  catch (e) { /* fall through to 403 */ }
  return res.status(403).json({ error: 'FLP High Command access required.' });
}

// Map a UI scope (?scope=FLP|MET) to the quota-lib division. Defaults to FLP.
function scopeDivision(req) {
  const s = (req.query.scope || req.body && req.body.scope || 'FLP').toString().toUpperCase();
  return s === 'MET' ? 'MET' : 'FLP';
}

router.get('/', (req, res) => res.json({ division: 'flp' }));

// What the FLP dashboard can show for this user (drives the UI).
router.get('/context', async (req, res) => {
  let canQuota = false;
  try { canQuota = await userFlpHicomm(req.user); } catch (e) { canQuota = false; }
  res.json({
    canGroupAdmin:    userFlpGroupAdmin(req.user),
    canReviewPatrols: true, // any FLP member (the route is already FLP-gated)
    canQuota,               // FLP HICOMM — shows the Quota Check / MET Quota Review tabs
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

    // EVENT logs are HICOMM-only to review; PATROL logs stay open to any FLP rank.
    if (p.type === 'EVENT') {
      let ok = false;
      try { ok = await userFlpHicomm(req.user); } catch (e) { ok = false; }
      if (!ok) return res.status(403).json({ error: 'FLP High Command access required to review event logs.' });
    }

    const status = action === 'approve' ? 'APPROVED' : 'DENIED';

    // Event logs award +1 to the configured sheet(s) — EVENT_POINT_TARGET =
    // FLP (default) | MET | BOTH. Best-effort; never blocks the review.
    let pointResult = null;
    if (status === 'APPROVED' && p.type === 'EVENT') {
      pointResult = await patrolLib.awardEventPoints(p).catch(() => ({ ok: false }));
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

// ── FLP-scoped quota review (FLP High Command) ─────────────────────
// Each endpoint takes ?scope=FLP|MET (query or body) which selects the division
// config from the quota lib, so the SAME FLP tab can review the FLP sheet or the
// MET sheet. Reuses the exact quota engine IA uses.
router.get('/quota/members', requireFlpHicomm, async (req, res) => {
  try {
    const division = scopeDivision(req);
    const members = await quotaLib.getAllMembersPoints(division);
    if (members == null) return res.json({ configured: false, members: [], scope: division });
    res.json({ configured: true, members, scope: division });
  } catch (err) {
    console.error('[FLP Quota] members error:', err.message);
    res.status(500).json({ error: 'Failed to read quota sheet.' });
  }
});

router.post('/quota/check', requireFlpHicomm, async (req, res) => {
  const division = scopeDivision(req);
  const { results, weekLabel } = req.body || {};
  if (!Array.isArray(results) || !results.length) return res.status(400).json({ error: 'No results to submit.' });
  for (const r of results) {
    if (!r || !r.username || !['pass', 'fail', 'exempt'].includes(r.status)) {
      return res.status(400).json({ error: 'Each result needs a username and a pass/fail/exempt status.' });
    }
  }
  try {
    const cfg = quotaLib.quotaConfig(division);
    const ok = await sendQuotaCheckWebhook({
      reviewerName:  req.user.displayName || req.user.discordUsername,
      reviewerId:    req.user.discordId,
      results, weekLabel,
      webhookUrl:    cfg.resultsWebhookUrl,
      divisionLabel: division,
      mentionRoleId: process.env[`${cfg.prefix}QUOTA_MENTION_ROLE_ID`] || null,
    });
    if (!ok) return res.status(502).json({ error: 'Quota results webhook is not configured or failed to send.' });
    res.json({ ok: true, scope: division });
  } catch (err) {
    console.error('[FLP Quota] check error:', err.message);
    res.status(500).json({ error: 'Failed to submit quota check.' });
  }
});

router.post('/quota/exempt', requireFlpHicomm, async (req, res) => {
  const division = scopeDivision(req);
  const username = (req.body && req.body.username || '').toString().trim();
  if (!username) return res.status(400).json({ error: 'Username is required.' });
  try {
    const result = await quotaLib.setMemberExempt(username, division);
    if (!result.ok) return res.status(500).json({ error: result.error || 'Failed to set exempt.' });
    res.json(result);
  } catch (err) {
    console.error('[FLP Quota] exempt error:', err.message);
    res.status(500).json({ error: 'Failed to set exempt.' });
  }
});

router.post('/quota/loa', requireFlpHicomm, async (req, res) => {
  const division = scopeDivision(req);
  const username = (req.body && req.body.username || '').toString().trim();
  if (!username) return res.status(400).json({ error: 'Username is required.' });
  try {
    const result = await quotaLib.setMemberLOA(username, division);
    if (!result.ok) return res.status(500).json({ error: result.error || 'Failed to set LOA.' });
    res.json(result);
  } catch (err) {
    console.error('[FLP Quota] loa error:', err.message);
    res.status(500).json({ error: 'Failed to set LOA.' });
  }
});

router.post('/quota/reset', requireFlpHicomm, async (req, res) => {
  const division = scopeDivision(req);
  try {
    const result = await quotaLib.resetAllQuota(division);
    if (!result.ok) return res.status(500).json({ error: result.error || 'Reset failed.' });
    console.log(`[FLP Quota] ${division} reset by ${req.user.displayName || req.user.discordUsername} — ${result.cleared} cell(s) cleared`);
    res.json(result);
  } catch (err) {
    console.error('[FLP Quota] reset error:', err.message);
    res.status(500).json({ error: 'Failed to reset quota.' });
  }
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
