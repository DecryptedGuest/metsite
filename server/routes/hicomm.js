// server/routes/hicomm.js — MET HICOMM oversight dashboard API.
// Mounted at /api/hicomm behind requireAuth + requireMetHicomm (Deputy
// Commissioner+ in the MET group, or DEVELOPER). Powers the Command Center,
// analytics, integrity flags, the immutable audit trail, and the officer 360°
// timeline.
const express = require('express');
const prisma  = require('../lib/db');
const analytics = require('../lib/analytics');
const audit     = require('../lib/audit');

const router = express.Router();

// ── GET /api/hicomm/context — capabilities for the UI ──
router.get('/context', async (req, res) => {
  let metRank = null, minRank = null;
  try {
    const m = require('../lib/metRank');
    const r = await m.metRole(req.user.robloxId); if (r) metRank = { name: r.name, rank: r.rank };
    minRank = await m.hicommMinRank();
  } catch (e) {}
  res.json({ isDev: req.user.role === 'DEVELOPER', metRank, minRank, name: req.user.displayName || req.user.discordUsername });
});

// ── GET /api/hicomm/overview — live Command Center snapshot ──
router.get('/overview', async (req, res) => {
  try {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [liveTryouts, openTickets, pendingLogs, pendingCases, pendingPatrols, recentAudit,
           tryoutsToday, ticketsToday, newUsersToday] = await Promise.all([
      prisma.tryout.findMany({ where: { status: 'LIVE' }, orderBy: { scheduledAt: 'desc' }, take: 20 }),
      prisma.supportTicket.count({ where: { status: { in: ['OPEN', 'CLAIMED'] } } }),
      prisma.tryoutLog.count({ where: { status: 'PENDING' } }),
      prisma.case.count({ where: { status: 'PENDING' } }).catch(() => 0),
      prisma.patrolLog.count({ where: { status: 'PENDING' } }),
      prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 15 }),
      prisma.tryoutLog.count({ where: { createdAt: { gte: dayAgo } } }),
      prisma.supportTicket.count({ where: { createdAt: { gte: dayAgo } } }),
      prisma.user.count({ where: { createdAt: { gte: dayAgo } } }),
    ]);

    res.json({
      live: liveTryouts.map(t => ({
        id: t.id, division: t.division, hostName: t.hostName, coHostName: t.coHostName,
        lockState: t.lockState, scheduledAt: t.scheduledAt,
        attendees: t.liveSnapshot && t.liveSnapshot.totalAttendees != null ? t.liveSnapshot.totalAttendees
          : (t.liveSnapshot && Array.isArray(t.liveSnapshot.attendees) ? t.liveSnapshot.attendees.length : 0),
      })),
      counters: {
        liveTryouts: liveTryouts.length, openTickets, pendingLogs, pendingCases, pendingPatrols,
        tryoutsToday, ticketsToday, newUsersToday,
      },
      audit: recentAudit.map(audit.serialize),
    });
  } catch (e) {
    console.error('[HICOMM] overview failed:', e.message);
    res.status(500).json({ error: 'Failed to load overview' });
  }
});

// ── GET /api/hicomm/analytics?division=&days= — the analytics suite ──
router.get('/analytics', async (req, res) => {
  try {
    const division = normDiv(req.query.division);
    const days = clampDays(req.query.days);
    const [tryouts, funnel, activity] = await Promise.all([
      analytics.tryoutAnalytics(division, days),
      analytics.recruitmentFunnel(division, days),
      analytics.activityAnalytics(days),
    ]);
    res.json({ division: division || 'ALL', days, tryouts, funnel, activity });
  } catch (e) {
    console.error('[HICOMM] analytics failed:', e.message);
    res.status(500).json({ error: 'Failed to load analytics' });
  }
});

// ── GET /api/hicomm/integrity?division= — tryout-log integrity flags ──
router.get('/integrity', async (req, res) => {
  try {
    const result = await analytics.integrityFlags(normDiv(req.query.division));
    res.json(result);
  } catch (e) {
    console.error('[HICOMM] integrity failed:', e.message);
    res.status(500).json({ error: 'Failed to run integrity scan' });
  }
});

// ── GET /api/hicomm/audit?category=&q=&before= — the audit trail ──
router.get('/audit', async (req, res) => {
  try {
    const where = {};
    const cat = String(req.query.category || '').toUpperCase();
    if (['GROUP', 'SUPPORT', 'TRYOUT', 'CASE', 'TICKET', 'ACCESS', 'DEV'].includes(cat)) where.category = cat;
    const q = String(req.query.q || '').trim();
    if (q) where.OR = [
      { actorName: { contains: q, mode: 'insensitive' } },
      { targetName: { contains: q, mode: 'insensitive' } },
      { summary: { contains: q, mode: 'insensitive' } },
    ];
    if (req.query.before) where.createdAt = { lt: new Date(req.query.before) };
    const rows = await prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 });
    res.json(rows.map(audit.serialize));
  } catch (e) {
    console.error('[HICOMM] audit failed:', e.message);
    res.status(500).json({ error: 'Failed to load audit trail' });
  }
});

// ── GET /api/hicomm/officer/search?q= — find an officer ──
router.get('/officer/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  try {
    const users = await prisma.user.findMany({
      where: { OR: [
        { discordUsername: { contains: q, mode: 'insensitive' } },
        { displayName:     { contains: q, mode: 'insensitive' } },
        { robloxUsername:  { contains: q, mode: 'insensitive' } },
      ] },
      select: { id: true, discordUsername: true, displayName: true, robloxUsername: true, discordAvatar: true, role: true },
      take: 15,
    });
    res.json(users.map(u => ({ id: u.id, name: u.displayName || u.discordUsername, discordUsername: u.discordUsername,
      robloxUsername: u.robloxUsername, avatar: u.discordAvatar, role: u.role })));
  } catch (e) { res.status(500).json({ error: 'Search failed' }); }
});

// ── GET /api/hicomm/officer/:id/timeline — unified 360° history ──
router.get('/officer/:id/timeline', async (req, res) => {
  try {
    const u = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!u) return res.status(404).json({ error: 'Officer not found' });
    const rid = u.robloxId ? String(u.robloxId) : null;
    const ruser = u.robloxUsername || null;

    const [cases, punishments, hosted, patrols, tickets, auditRows] = await Promise.all([
      prisma.case.findMany({ where: { OR: [
        ...(rid ? [{ robloxUserId: rid }] : []),
        ...(ruser ? [{ robloxUsername: ruser }] : []),
      ].length ? [{ OR: [...(rid ? [{ robloxUserId: rid }] : []), ...(ruser ? [{ robloxUsername: ruser }] : [])] }] : [{ id: '__none__' }] },
        orderBy: { createdAt: 'desc' }, take: 50 }).catch(() => []),
      prisma.metPunishment.findMany({ where: { discordId: u.discordId }, orderBy: { issuedAt: 'desc' }, take: 50 }).catch(() => []),
      prisma.tryoutLog.findMany({ where: { hostId: u.id }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, division: true, status: true, totalAttendees: true, passedCount: true, createdAt: true } }),
      prisma.patrolLog.findMany({ where: { submitterDiscordId: u.discordId }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, type: true, status: true, totalMinutes: true, createdAt: true } }),
      prisma.supportTicket.findMany({ where: { openerId: u.id }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, type: true, status: true, createdAt: true } }),
      prisma.auditLog.findMany({ where: { OR: [{ actorId: u.id }, { targetId: u.id }] }, orderBy: { createdAt: 'desc' }, take: 50 }),
    ]);

    const events = [];
    for (const c of cases) events.push({ at: c.createdAt, kind: 'case', icon: 'ti-gavel', color: '#e0503a', title: `Case ${c.caseRef} — ${c.action}`, detail: c.reason, status: c.status });
    for (const p of punishments) events.push({ at: p.issuedAt, kind: 'punishment', icon: 'ti-alert-triangle', color: '#e8842a', title: `${p.type || 'Punishment'}${p.active ? '' : ' (expired)'}`, detail: p.reason, status: p.active ? 'ACTIVE' : 'ENDED' });
    for (const l of hosted) events.push({ at: l.createdAt, kind: 'tryout', icon: 'ti-clipboard-check', color: '#3b82f6', title: `Hosted ${l.division} tryout`, detail: `${l.totalAttendees} attended · ${l.passedCount} passed`, status: l.status });
    for (const p of patrols) events.push({ at: p.createdAt, kind: 'patrol', icon: 'ti-shield', color: '#14b8a6', title: p.type === 'EVENT' ? 'Event log' : 'Patrol log', detail: p.totalMinutes != null ? `${p.totalMinutes} min` : '', status: p.status });
    for (const t of tickets) events.push({ at: t.createdAt, kind: 'ticket', icon: 'ti-lifebuoy', color: '#8b93a1', title: `Support ticket (${t.type})`, detail: '', status: t.status });
    for (const a of auditRows) events.push({ at: a.createdAt, kind: 'audit', icon: 'ti-history', color: '#6b7280', title: a.summary || `${a.category}/${a.action}`, detail: a.actorId === u.id ? `by them` : `on them — by ${a.actorName}`, status: a.action });

    events.sort((a, b) => new Date(b.at) - new Date(a.at));

    res.json({
      officer: { id: u.id, name: u.displayName || u.discordUsername, discordUsername: u.discordUsername,
        discordId: u.discordId, robloxUsername: u.robloxUsername, robloxId: u.robloxId, avatar: u.discordAvatar, role: u.role,
        joinedAt: u.createdAt, lastLogin: u.lastLogin },
      counts: { cases: cases.length, punishments: punishments.length, hosted: hosted.length, patrols: patrols.length, tickets: tickets.length },
      events: events.slice(0, 200),
    });
  } catch (e) {
    console.error('[HICOMM] timeline failed:', e.message);
    res.status(500).json({ error: 'Failed to load timeline' });
  }
});

// ── View-as: a read-only preview of exactly what an officer can access ──
// No session switching (safe) — just resolves their role, divisions/tiers,
// standing and which dashboards they can reach. Audited.
router.get('/officer/:id/access-preview', async (req, res) => {
  try {
    const u = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!u) return res.status(404).json({ error: 'Officer not found' });
    const divisions = Array.isArray(u.divisions) ? u.divisions : [];
    const IA = ['IA', 'SUPERVISOR', 'HICOMM', 'DEVELOPER'];
    const pages = [];
    if (u.role === 'DEVELOPER') pages.push('Developer panel', 'Security Center');
    if (IA.includes(u.role)) pages.push('IA dashboard');
    for (const d of divisions) { const slug = { CID: 'CID', SCO19: 'SCO-19', FLP: 'FLP', HPC: 'HPC', IA: 'IA' }[d.division] || d.division; pages.push(`${slug} dashboard${d.tier === 'LEAD' ? ' (lead)' : ''}`); }
    pages.push('Profile', 'Support');
    let metHicomm = false;
    try { metHicomm = await require('../lib/metRank').userIsMetHicomm(u); } catch (e) {}
    if (metHicomm) pages.push('MET High Command');
    require('../lib/audit').log(req.user, { category: 'SECURITY', action: 'VIEW_AS', target: { type: 'user', id: u.id, name: u.displayName || u.discordUsername }, summary: `Viewed access preview for ${u.displayName || u.discordUsername}` });
    res.json({
      officer: { id: u.id, name: u.displayName || u.discordUsername, role: u.role, avatar: u.discordAvatar },
      role: u.role, metHicomm, divisions,
      standing: { blacklisted: !!u.isBlacklisted, mustReauth: !!u.mustReauth, reason: u.blacklistReason || null },
      pages: [...new Set(pages)],
    });
  } catch (e) { res.status(500).json({ error: 'Failed to load access preview' }); }
});

// ── Act from the timeline: force an officer to re-authenticate everywhere ──
router.post('/officer/:id/force-reauth', async (req, res) => {
  try {
    const u = await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true, displayName: true, discordUsername: true } });
    if (!u) return res.status(404).json({ error: 'Officer not found' });
    const r = await prisma.session.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date() } });
    require('../lib/audit').log(req.user, { category: 'SECURITY', action: 'FORCE_REAUTH', target: { type: 'user', id: u.id, name: u.displayName || u.discordUsername }, summary: `Forced re-auth for ${u.displayName || u.discordUsername} (${r.count} session(s))` });
    res.json({ ok: true, killed: r.count });
  } catch (e) { res.status(500).json({ error: 'Failed to force re-auth' }); }
});

function normDiv(v) {
  const d = String(v || '').toUpperCase();
  return ['CID', 'SCO19', 'FLP', 'HPC'].includes(d) ? d : null;
}
function clampDays(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(180, Math.max(7, n)) : 30; }

module.exports = router;
