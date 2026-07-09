// server/routes/admin.js — Developer-only management endpoints
const express = require('express');
const prisma  = require('../lib/db');
const { requireDeveloper } = require('../middleware/auth');
const { userIsMetHicommCached } = require('../middleware/division');
const {
  listGroupRoles, listGroupMembers, listJoinRequests,
  resolveJoinRequest, changeGroupRank, exileFromGroup, cookieForDivision, mainGroupId,
} = require('../lib/roblox');
const {
  searchGuildMembers, listGuildBans, banMember, unbanMember, kickMember, timeoutMember,
} = require('../lib/bot');
const { panelGroups, groupIdForKey } = require('../lib/divisions');

// Resolve the ?division= query to a Roblox group id for the group panel.
// No division → null (falls back to ROBLOX_GROUP_ID inside the roblox helpers,
// preserving the original single-group behaviour). Unknown key → throws (400).
function panelGroupId(req) {
  const key = req.query.division;
  if (!key) return null;
  const gid = groupIdForKey(key);
  if (!gid) { const e = new Error(`Unknown division "${key}"`); e.status = 400; throw e; }
  return gid;
}

// The bot-account cookie to manage the selected division's group. CID uses its
// own account (CID_ROBLOX_BOT_COOKIE); everything else uses the default.
function panelCookie(req) {
  return cookieForDivision(req.query.division);
}

const router = express.Router();

// The Group Panel (/group/*) is shared with MET HICOMM — they can manage every
// Roblox group (ranks, join requests, exile) just like developers. Everything
// else in this router (user management, Discord moderation, blacklists, site
// control) stays DEVELOPER-only. req.path here is mount-relative (e.g.
// '/group/roles'), matching the outer /api/admin gate that already admits HICOMM.
router.use((req, res, next) => {
  if (/^\/group(\/|$)/.test(req.path)) {
    if (req.user && (req.user.role === 'DEVELOPER' || userIsMetHicommCached(req.user))) return next();
    return res.status(403).json({ error: 'Developer or MET HICOMM access required' });
  }
  return requireDeveloper(req, res, next);
});

// ── GET /api/admin/users ───────────────────────────────────
router.get('/users', async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      // Only real people who have actually signed in — a session row exists for
      // every login. This excludes the shell rows the IA archive import creates
      // (username "ia_<id>" / "IA Archive"), which never log in and cluttered
      // the panel. Most-recently-active first.
      where: { sessions: { some: {} } },
      orderBy: [{ lastLogin: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true, discordId: true, discordUsername: true,
        displayName: true, discordAvatar: true, role: true,
        isBlacklisted: true, blacklistReason: true,
        lastIp: true, robloxId: true, robloxUsername: true,
        createdAt: true, lastLogin: true,
        notifyEnabled: true, metRankOverride: true,
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

// ── PATCH /api/admin/users/:id/role ─────────────────────────
router.patch('/users/:id/role', async (req, res) => {
  const { role } = req.body;
  // NONE removes site access (division-only / plain member). Changing the site
  // role never touches the Roblox group — it's a site-only standing.
  if (!['NONE', 'IA', 'SUPERVISOR', 'HICOMM', 'DEVELOPER'].includes(role)) {
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
    audit.log(req.user, { category: 'ACCESS', action: 'ROLE_CHANGE', target: { type: 'user', id: req.params.id, name: user.displayName || user.discordUsername },
      summary: `Site role changed to ${role} for ${user.displayName || user.discordUsername}` });
    res.json({ success: true, role: user.role });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update role' });
  }
});

// ── POST /api/admin/dedupe-migration-logs ───────────────────
// Remove duplicate case/ticket logs from the IA→MET migration. Dry run unless
// { apply:true }. Optional { scope: 'all'|'cases'|'tickets' }. Developer-gated.
router.post('/dedupe-migration-logs', async (req, res) => {
  try {
    const apply = !!(req.body && req.body.apply);
    const scope = ['all', 'cases', 'tickets'].includes(req.body && req.body.scope) ? req.body.scope : 'all';
    const result = await require('../lib/dedupeMigration').runDedupe({ apply, scope });
    if (apply) {
      audit.log(req.user, { category: 'ACCESS', action: 'DEDUPE_MIGRATION_LOGS',
        summary: `Deduped migration logs — deleted ${result.tickets.deleted} ticket(s) + ${result.cases.deleted} case(s)` });
    }
    res.json(result);
  } catch (e) {
    console.error('[Admin] dedupe failed:', e.message);
    res.status(500).json({ error: 'Dedupe failed' });
  }
});

// ── GET /api/admin/met-roles ────────────────────────────────
// The live MET umbrella group's rank ladder (from the Roblox roles API), newest
// rank first — populates the dev panel's MET-rank dropdown. Cached in roblox.js.
router.get('/met-roles', async (req, res) => {
  try {
    const { getGroupRolesPublic } = require('../lib/roblox');
    const { metGroupId } = require('../lib/divisions');
    const roles = await getGroupRolesPublic(metGroupId());
    const out = (roles || [])
      .filter(r => Number(r.rank) > 0 && Number(r.rank) < 255) // skip Guest(0)/Owner(255)
      .sort((a, b) => Number(b.rank) - Number(a.rank));
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: 'Failed to load MET roles' });
  }
});

// ── PATCH /api/admin/users/:id/met-rank ─────────────────────
// Set (or clear) a SITE-ONLY MET rank override for a user. Body:
//   { name, rank }  — set the override to this MET rank
//   { clear: true } — remove the override
// Never touches the Roblox group. Takes effect on the user's next revalidation
// (≤1 min on a gated route, or immediately on their next login).
router.patch('/users/:id/met-rank', async (req, res) => {
  try {
    const body = req.body || {};
    let metRankOverride = null;
    if (!body.clear) {
      const rank = parseInt(body.rank, 10);
      const name = (body.name || '').toString().trim().slice(0, 80);
      if (!Number.isFinite(rank) || rank < 1 || rank > 255 || !name) {
        return res.status(400).json({ error: 'Provide a valid MET rank (name + rank), or clear:true.' });
      }
      metRankOverride = { name, rank };
    }
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data:  { metRankOverride, lastRoleCheck: null }, // force a re-derive on next access
    });
    audit.log(req.user, { category: 'ACCESS', action: 'MET_RANK_OVERRIDE',
      target: { type: 'user', id: req.params.id, name: user.displayName || user.discordUsername },
      summary: metRankOverride
        ? `MET rank override set to ${metRankOverride.name} (rank ${metRankOverride.rank}) for ${user.displayName || user.discordUsername}`
        : `MET rank override cleared for ${user.displayName || user.discordUsername}` });
    res.json({ success: true, metRankOverride });
  } catch (e) {
    res.status(500).json({ error: 'Failed to set MET rank' });
  }
});

// ── POST /api/admin/users/:id/blacklist ───────────────────────
router.post('/users/:id/blacklist', async (req, res) => {
  const { reason } = req.body;
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'Cannot blacklist yourself' });
  }
  try {
    const u = await prisma.user.update({
      where: { id: req.params.id },
      data:  { isBlacklisted: true, blacklistReason: reason || 'No reason given' },
    });
    // Kill their live sessions immediately so the blacklist takes effect now.
    await prisma.session.updateMany({ where: { userId: req.params.id, revokedAt: null }, data: { revokedAt: new Date() } }).catch(() => {});
    audit.log(req.user, { category: 'ACCESS', action: 'BLACKLIST', target: { type: 'user', id: req.params.id, name: u.displayName || u.discordUsername },
      summary: `Blacklisted ${u.displayName || u.discordUsername}${reason ? ` — ${reason}` : ''}` });

    // Advanced alt detection: propagate the blacklist to accounts that share a
    // real IP / device with this one (developer-toggleable via `altBlock`).
    let altIds = [];
    try { altIds = await require('../lib/accessGuard').propagateBlacklistToAlts(u, reason); } catch (e) { altIds = []; }
    if (altIds.length) {
      audit.log(req.user, { category: 'ACCESS', action: 'BLACKLIST_ALTS', target: { type: 'user', id: req.params.id, name: u.displayName || u.discordUsername },
        summary: `Alt detection auto-blacklisted ${altIds.length} linked account(s) of ${u.displayName || u.discordUsername}` });
    }
    res.json({ success: true, altsBlacklisted: altIds.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to blacklist user' });
  }
});

// ── POST /api/admin/users/:id/unblacklist ─────────────────────
router.post('/users/:id/unblacklist', async (req, res) => {
  try {
    const u = await prisma.user.update({
      where: { id: req.params.id },
      data:  { isBlacklisted: false, blacklistReason: null },
    });
    audit.log(req.user, { category: 'ACCESS', action: 'UNBLACKLIST', target: { type: 'user', id: req.params.id, name: u.displayName || u.discordUsername },
      summary: `Lifted blacklist on ${u.displayName || u.discordUsername}` });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to unblacklist user' });
  }
});

// ── DELETE /api/admin/cases/:id ──────────────────────────────
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

// ── GET /api/admin/visits ───────────────────────────────────
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

// ── GET /api/admin/security ─────────────────────────────────
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

// ── DELETE /api/admin/tickets/:id ─────────────────────────────
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

// ── GET /api/admin/settings ─────────────────────────────────
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

// ── PATCH /api/admin/settings ──────────────────────────────
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

// ── GET /api/admin/stats ──────────────────────────────────
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

// ── GET /api/admin/group/debug ──────────────────────────────
// Exercises the cookie-authenticated group functions so misconfiguration is visible
router.get('/group/debug', async (req, res) => {
  const groupId = mainGroupId();

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

// ── GET /api/admin/group/divisions ───────────────────────────
// The selectable groups for the panel's division switcher (every division that
// has a group id, + MET). Client-safe: names/keys only, never the group ids.
router.get('/group/divisions', (req, res) => {
  res.json(panelGroups().map(g => ({ key: g.key, name: g.name, fullName: g.fullName })));
});

// ── GET /api/admin/group/roles ──────────────────────────────
router.get('/group/roles', async (req, res) => {
  try {
    const roles = await listGroupRoles(panelGroupId(req), panelCookie(req));
    res.json(roles);
  } catch (err) {
    console.error('GET /group/roles error:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── GET /api/admin/group/members ────────────────────────────
router.get('/group/members', async (req, res) => {
  try {
    const { pageToken } = req.query;
    const result = await listGroupMembers(pageToken || null, panelGroupId(req), panelCookie(req));
    res.json(result);
  } catch (err) {
    console.error('GET /group/members error:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── GET /api/admin/group/pending ────────────────────────────
router.get('/group/pending', async (req, res) => {
  try {
    const { pageToken } = req.query;
    const result = await listJoinRequests(pageToken || null, panelGroupId(req), panelCookie(req));
    res.json(result);
  } catch (err) {
    console.error('GET /group/pending error:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

const audit = require('../lib/audit');

// ── POST /api/admin/group/pending/:userId/approve ─────────────────
router.post('/group/pending/:userId/approve', async (req, res) => {
  try {
    await resolveJoinRequest(req.params.userId, 'approve', panelGroupId(req), panelCookie(req));
    audit.log(req.user, { category: 'GROUP', action: 'JOIN_APPROVE', division: req.query.division || 'MET',
      target: { type: 'roblox_user', id: req.params.userId }, summary: `Approved join request for Roblox user ${req.params.userId} (${req.query.division || 'MET'})` });
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Failed to approve join request' });
  }
});

// ── POST /api/admin/group/pending/:userId/decline ─────────────────
router.post('/group/pending/:userId/decline', async (req, res) => {
  try {
    await resolveJoinRequest(req.params.userId, 'decline', panelGroupId(req), panelCookie(req));
    audit.log(req.user, { category: 'GROUP', action: 'JOIN_DECLINE', division: req.query.division || 'MET',
      target: { type: 'roblox_user', id: req.params.userId }, summary: `Declined join request for Roblox user ${req.params.userId} (${req.query.division || 'MET'})` });
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Failed to decline join request' });
  }
});

// ── PATCH /api/admin/group/members/:userId/rank ───────────────────
router.patch('/group/members/:userId/rank', async (req, res) => {
  const { roleId } = req.body;
  if (!roleId) return res.status(400).json({ error: 'roleId is required' });
  try {
    await changeGroupRank(req.params.userId, roleId, panelGroupId(req), panelCookie(req));
    audit.log(req.user, { category: 'GROUP', action: 'RANK_CHANGE', division: req.query.division || 'MET',
      target: { type: 'roblox_user', id: req.params.userId }, summary: `Changed rank of Roblox user ${req.params.userId} → role ${roleId} (${req.query.division || 'MET'})`,
      meta: { roleId } });
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Failed to change rank' });
  }
});

// ── DELETE /api/admin/group/members/:userId ─────────────────────
router.delete('/group/members/:userId', async (req, res) => {
  try {
    // exileFromGroup returns false (never throws) on any failure — cookie unset,
    // bot lacks permission, Roblox 403/429/500. Don't report success or write a
    // KICK audit entry unless the exile actually happened.
    const ok = await exileFromGroup(req.params.userId, panelGroupId(req), panelCookie(req));
    if (!ok) return res.status(502).json({ error: 'Roblox rejected the kick (check the group bot cookie/permissions).' });
    audit.log(req.user, { category: 'GROUP', action: 'KICK', division: req.query.division || 'MET',
      target: { type: 'roblox_user', id: req.params.userId }, summary: `Kicked Roblox user ${req.params.userId} from ${req.query.division || 'MET'} group` });
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Failed to kick member' });
  }
});

// ── Discord Moderation (Dev Panel) ───────────────────────────
// Ban / unban / kick / timeout ("mute") any Discord user by ID or by
// searching the member list — for MET-server moderation, independent of any
// IA case. Every action is logged to DiscordModerationLog for an audit trail.

async function logModeration(req, { action, targetDiscordId, targetUsername, reason, durationMinutes }) {
  try {
    await prisma.discordModerationLog.create({
      data: {
        action, targetDiscordId, targetUsername: targetUsername || null,
        reason: reason || null, durationMinutes: durationMinutes ?? null,
        performedById: req.user.id,
        performedBy:   req.user.displayName || req.user.discordUsername,
      },
    });
  } catch (e) { console.error('[Moderation] audit log write failed:', e.message); }
  // Mirror into the unified portal audit trail (best-effort).
  try {
    require('../lib/audit').record({
      req, action: `MOD_${action}`, category: 'moderation', targetType: 'discord_user', targetId: targetDiscordId,
      summary: `${action} ${targetUsername || targetDiscordId}${reason ? ` — ${reason}` : ''}${durationMinutes ? ` (${durationMinutes}m)` : ''}`,
    });
  } catch (e) { /* non-fatal */ }
}

function isValidDiscordId(id) { return /^\d{15,25}$/.test(String(id || '').trim()); }

// GET /api/admin/discord/members?search=... — search the guild's member list.
router.get('/discord/members', async (req, res) => {
  try {
    const q = String(req.query.search || '').trim();
    if (!q) return res.json([]);
    const members = await searchGuildMembers(q, 25);
    res.json(members);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to search members' });
  }
});

// GET /api/admin/discord/bans?search=... — list/search currently-banned users.
router.get('/discord/bans', async (req, res) => {
  try {
    const bans = await listGuildBans(req.query.search || '');
    res.json(bans);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to list bans' });
  }
});

// GET /api/admin/discord/moderation-log — recent actions taken via this tool.
router.get('/discord/moderation-log', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const log = await prisma.discordModerationLog.findMany({ orderBy: { createdAt: 'desc' }, take: limit });
    res.json(log);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load moderation log' });
  }
});

// POST /api/admin/discord/ban { discordId, reason, deleteMessageSeconds }
router.post('/discord/ban', async (req, res) => {
  const { discordId, reason, deleteMessageSeconds, username } = req.body || {};
  if (!isValidDiscordId(discordId)) return res.status(400).json({ error: 'A valid Discord user ID is required.' });
  try {
    await banMember(discordId, { reason, deleteMessageSeconds });
    await logModeration(req, { action: 'BAN', targetDiscordId: discordId, targetUsername: username, reason });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to ban user' });
  }
});

// POST /api/admin/discord/unban { discordId, reason }
router.post('/discord/unban', async (req, res) => {
  const { discordId, reason, username } = req.body || {};
  if (!isValidDiscordId(discordId)) return res.status(400).json({ error: 'A valid Discord user ID is required.' });
  try {
    await unbanMember(discordId, { reason });
    await logModeration(req, { action: 'UNBAN', targetDiscordId: discordId, targetUsername: username, reason });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to unban user' });
  }
});

// POST /api/admin/discord/kick { discordId, reason }
router.post('/discord/kick', async (req, res) => {
  const { discordId, reason, username } = req.body || {};
  if (!isValidDiscordId(discordId)) return res.status(400).json({ error: 'A valid Discord user ID is required.' });
  try {
    await kickMember(discordId, { reason });
    await logModeration(req, { action: 'KICK', targetDiscordId: discordId, targetUsername: username, reason });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to kick user' });
  }
});

// POST /api/admin/discord/timeout { discordId, durationMinutes, reason } — mute.
router.post('/discord/timeout', async (req, res) => {
  const { discordId, durationMinutes, reason, username } = req.body || {};
  if (!isValidDiscordId(discordId)) return res.status(400).json({ error: 'A valid Discord user ID is required.' });
  if (!(Number(durationMinutes) > 0)) return res.status(400).json({ error: 'durationMinutes must be greater than 0.' });
  try {
    await timeoutMember(discordId, { durationMinutes, reason });
    await logModeration(req, { action: 'TIMEOUT', targetDiscordId: discordId, targetUsername: username, reason, durationMinutes: Number(durationMinutes) });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to timeout user' });
  }
});

// DELETE /api/admin/discord/timeout/:discordId — unmute (remove timeout).
router.delete('/discord/timeout/:discordId', async (req, res) => {
  const { discordId } = req.params;
  const { reason, username } = req.body || {};
  if (!isValidDiscordId(discordId)) return res.status(400).json({ error: 'A valid Discord user ID is required.' });
  try {
    await timeoutMember(discordId, { durationMinutes: 0, reason });
    await logModeration(req, { action: 'UNTIMEOUT', targetDiscordId: discordId, targetUsername: username, reason });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to remove timeout' });
  }
});

// ── GET /api/admin/audit ─────────────────────────────────
// Unified security audit trail (logins, session revocations, exam marking,
// tryouts, moderation, access changes). Newest first, optional ?category= and
// ?limit= filters. Developer-only (whole router is requireDeveloper).
router.get('/audit', async (req, res) => {
  try {
    const category = req.query.category ? String(req.query.category) : undefined;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const rows = await prisma.auditLog.findMany({
      where: category ? { category } : undefined,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    res.json({ entries: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load audit log' });
  }
});

module.exports = router;
