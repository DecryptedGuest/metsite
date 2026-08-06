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
      prisma.ticketLog.count({ where: { status: 'PENDING' } }),
      prisma.tryoutLog.count({ where: { status: 'PENDING' } }),
      prisma.case.count({ where: { status: 'PENDING' } }).catch(() => 0),
      prisma.patrolLog.count({ where: { status: 'PENDING' } }),
      prisma.auditLog.findMany({ where: { category: { not: 'DEV' } }, orderBy: { createdAt: 'desc' }, take: 15 }),
      prisma.tryoutLog.count({ where: { createdAt: { gte: dayAgo } } }),
      prisma.ticketLog.count({ where: { closedAt: { gte: dayAgo } } }),
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
    const days = analytics.normDays(req.query.days); // number, or 0 = all time
    const [tryouts, funnel, activity] = await Promise.all([
      analytics.tryoutAnalytics(division, days),
      analytics.recruitmentFunnel(division, days),
      analytics.activityAnalytics(days),
    ]);
    res.json({ division: division || 'ALL', days: tryouts.days, allTime: tryouts.allTime, tryouts, funnel, activity });
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
    // Developer/maintenance actions are never surfaced in the audit trail.
    const where = { category: { not: 'DEV' } };
    const cat = String(req.query.category || '').toUpperCase();
    if (['GROUP', 'SUPPORT', 'TRYOUT', 'CASE', 'TICKET', 'ACCESS', 'SECURITY'].includes(cat)) where.category = cat;
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

// ── The in-game log feed ─────────────────────────────────────────
// Adonis / join / leave / chat logs ingested from the training game.
//
// Nothing ever deletes a GameLog row — the record is all-time and always has
// been. What was capped was the READING of it: one request for the newest 150
// and no way to reach anything older, so the page looked like the log itself
// stopped there. lib/gameLog owns the query now, shared with the developer
// panel, which had a second copy of it and the same cap.
const GL = require('../lib/gameLog');

// GET /api/hicomm/game-logs?source=&q=&before=&limit=
router.get('/game-logs', async (req, res) => {
  try {
    res.json(await GL.page(req.query));
  } catch (e) {
    console.error('[HICOMM] game-logs failed:', e.message);
    res.status(500).json({ error: 'Failed to load game logs' });
  }
});

// GET /api/hicomm/game-logs.csv?source=&q= — the whole log, as a file.
router.get('/game-logs.csv', async (req, res) => {
  try {
    res.type('text/csv').set('Content-Disposition', `attachment; filename="${GL.csvFilename()}"`);
    await GL.writeCsv(res, req.query);
    res.end();
  } catch (e) {
    console.error('[HICOMM] game-logs.csv failed:', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to export game logs' });
    else res.end();
  }
});


// ── GET /api/hicomm/officer/search?q= — find an officer (type-ahead) ──
// DB-FIRST: every officer who has signed in is already in the user table with
// their Discord + Roblox identity cached, so we never touch Rover here (its rate
// limits are harsh and a per-keystroke lookup would burn through them). We match
// across every identity field and rank exact → prefix → word-prefix → contains.
//
// Roblox usernames go stale (an officer renames on Roblox, so the name we cached
// at their last login no longer matches) or were never captured. So when a query
// looks like a full Roblox username and the text search hasn't already found that
// exact person, we resolve it to a Roblox id via Roblox's OWN batch username API
// (users.roblox.com — NOT Rover, exact-match, generous limits) and look the
// officer up by robloxId instead. Result is cached briefly to avoid re-hitting
// the API on every keystroke, and we backfill the corrected username.
const _rbxUserCache = new Map(); // lower(username) -> { at, val: {id,username,displayName}|null }
async function resolveRobloxUsername(name) {
  const key = name.toLowerCase();
  const hit = _rbxUserCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.val;
  let val = null;
  try { val = await require('../lib/roblox').getRobloxIdFromUsername(name); } catch (e) { val = null; }
  _rbxUserCache.set(key, { at: Date.now(), val });
  return val;
}

router.get('/officer/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  try {
    const SEL = { id: true, discordUsername: true, displayName: true, robloxUsername: true, robloxId: true, discordAvatar: true, role: true, lastLogin: true };
    const users = await prisma.user.findMany({
      where: { OR: [
        { discordUsername: { contains: q, mode: 'insensitive' } },
        { displayName:     { contains: q, mode: 'insensitive' } },
        { robloxUsername:  { contains: q, mode: 'insensitive' } },
        { discordId:       { contains: q } },
        { robloxId:        { contains: q } },
      ] },
      select: SEL,
      take: 40,
    });

    const ql = q.toLowerCase();
    const byId = new Map(users.map(u => [u.id, u]));

    // If the query is a plausible complete Roblox username and we didn't already
    // match that exact name, resolve it via Roblox's API and look up by robloxId.
    const looksLikeUsername = /^[A-Za-z0-9_]{3,20}$/.test(q);
    const haveExact = users.some(u => (u.robloxUsername || '').toLowerCase() === ql);
    let resolvedRbx = null;
    if (looksLikeUsername && !haveExact) {
      resolvedRbx = await resolveRobloxUsername(q);
      if (resolvedRbx && resolvedRbx.id) {
        const extra = await prisma.user.findMany({ where: { robloxId: String(resolvedRbx.id) }, select: SEL });
        for (const u of extra) {
          byId.set(u.id, u);
          // Backfill a stale/missing cached username so future searches hit the DB.
          if ((u.robloxUsername || '').toLowerCase() !== resolvedRbx.username.toLowerCase()) {
            prisma.user.update({ where: { id: u.id }, data: { robloxUsername: resolvedRbx.username } }).catch(() => {});
          }
        }
      }
    }

    const all = [...byId.values()];
    const score = (u) => {
      const fields = [u.displayName, u.discordUsername, u.robloxUsername].filter(Boolean).map(s => s.toLowerCase());
      if (resolvedRbx && String(u.robloxId) === String(resolvedRbx.id)) return 0; // resolved exact Roblox account
      if (fields.some(f => f === ql)) return 0;             // exact identity match
      if (fields.some(f => f.startsWith(ql))) return 1;     // prefix — most likely intent
      if (fields.some(f => f.split(/[\s._-]+/).some(w => w.startsWith(ql)))) return 2; // word-prefix
      return 3;                                             // anywhere-contains
    };
    all.sort((a, b) => {
      const d = score(a) - score(b);
      if (d) return d;
      return new Date(b.lastLogin || 0) - new Date(a.lastLogin || 0); // recently-seen first
    });

    const results = all.slice(0, 15).map(u => ({ id: u.id, name: u.displayName || u.discordUsername, discordUsername: u.discordUsername,
      robloxUsername: u.robloxUsername, avatar: u.discordAvatar, role: u.role }));
    if (results.length) return res.json(results);

    // No site user matched. Fall back to the MET Discord server via the bot, so
    // HICOMM can still pull up anyone who's in the server but never used the site
    // (their nickname carries their rank + Roblox name; we enrich on open). Only
    // on queries of 3+ chars — a guild member fetch is heavier than a DB read.
    if (q.length >= 3) try {
      const bot = require('../lib/bot');
      const members = await bot.searchGuildMembers(q, 8).catch(() => []);
      const discordOnly = (members || []).filter(m => !m.isBot).map(m => {
        const parsed = bot.parseRankNick(m.displayName || m.username);
        return { discordOnly: true, discordId: m.id, name: m.displayName || m.username,
          robloxUsername: parsed.robloxUsername || null, roleCount: (m.roleIds || []).length, avatar: m.avatar };
      });
      if (discordOnly.length) return res.json(discordOnly);
    } catch (e) { /* bot down → fall through */ }

    // Last resort: a valid Roblox account that isn't in the DB or the server.
    if (resolvedRbx && resolvedRbx.id) {
      return res.json([{ noAccount: true, robloxId: resolvedRbx.id,
        name: resolvedRbx.displayName || resolvedRbx.username, robloxUsername: resolvedRbx.username }]);
    }

    res.json([]);
  } catch (e) { res.status(500).json({ error: 'Search failed' }); }
});

// Aggregate a MET profile from the live sources (Discord server + Roblox), for
// the officer 360 — works for anyone, whether or not they're a site user.
// Prefers zero-Rover paths: the nickname's Roblox name resolves via Roblox's own
// username API, and group ranks come from the public Roblox groups API.
async function buildMetProfile({ discordId, robloxId, robloxUsername }) {
  const bot    = require('../lib/bot');
  const roblox = require('../lib/roblox');

  let discord = null;
  if (discordId) discord = await bot.getMetMemberProfile(discordId).catch(() => null);

  let rid   = robloxId ? String(robloxId) : null;
  let rname = robloxUsername || (discord && discord.robloxName) || null;
  if (!rid && rname) {
    const r = await roblox.getRobloxIdFromUsername(rname).catch(() => null);
    if (r) { rid = r.id; rname = r.username; }
  }

  let info = null, groups = [], metRank = null;
  if (rid) {
    [info, groups] = await Promise.all([
      roblox.getRobloxUserInfo(rid).catch(() => null),
      roblox.getUserGroups(rid).catch(() => []),
    ]);
    try { metRank = await require('../lib/metRank').metRole(rid); } catch (e) {}
  }

  return {
    discord,
    roblox: rid ? { id: rid, username: (info && info.username) || rname, displayName: info && info.displayName } : null,
    robloxGroups: await withGroupIcons(filterMetGroups(groups)),
    metRank: metRank ? { name: metRank.name, rank: metRank.rank } : null,
  };
}

// Attach a division/group icon to each MET-related group. A group that maps to
// a dashboard division (or the MET umbrella) uses that division's resolved icon —
// the committed local logo where one exists, otherwise the live Roblox group
// icon. Any remaining group falls back to its own Roblox group icon fetched
// directly. All best-effort: on Roblox failure the icon is simply omitted.
async function withGroupIcons(groups) {
  if (!groups || !groups.length) return groups || [];
  const byGroupId = {};
  try {
    const div = require('../lib/divisions');
    const cfg = await div.getDivisionConfig();
    for (const key of Object.keys(cfg)) {
      const c = cfg[key];
      if (c && c.groupId && c.icon) byGroupId[String(c.groupId)] = c.icon;
    }
  } catch (e) { /* no division config — fall through to Roblox icons */ }

  const need = groups
    .map(g => g && g.group && String(g.group.id))
    .filter(id => id && !byGroupId[id]);
  let robloxIcons = {};
  if (need.length) { try { robloxIcons = await require('../lib/roblox').getGroupIcons(need); } catch (e) { robloxIcons = {}; } }

  return groups.map(g => {
    const gid = g && g.group && String(g.group.id);
    const icon = (gid && (byGroupId[gid] || robloxIcons[gid])) || null;
    return { ...g, group: { ...g.group, icon } };
  });
}

// Officer 360 shows only groups RELATED TO MET (the umbrella group + the dashboard
// divisions), not every Roblox group the person happens to be in. Kept by
// configured group id (authoritative) or a MET-specific name match.
const MET_GROUP_NAME = /metropolitan|met police|\bsco[\s-]?19\b|specialist firearms|firearms command|criminal invest|\bcid\b|frontline|hendon|police college|\bhpc\b|internal affairs|\bmi5\b|military intelligence|\bsas\b|special air service/i;
function metRelatedGroupIds() {
  try {
    const div = require('../lib/divisions');
    return new Set([div.metGroupId(), ...div.ALL.map(d => div.explicitGroupId(d))].filter(Boolean).map(String));
  } catch (e) { return new Set(); }
}
// A group whose name starts with another community's bracketed tag — e.g.
// "{WL} Metropolitan Police", "[XYZ] Met Police". These belong to OTHER servers
// and only share a generic name, so they're never relevant here.
const FOREIGN_COMMUNITY_TAG = /^\s*[{[][^}\]]*[}\]]/;
function filterMetGroups(groups) {
  const ids = metRelatedGroupIds();
  return (groups || []).filter(g => {
    const gid = g && g.group && String(g.group.id);
    const name = (g && g.group && g.group.name) || '';
    if (gid && ids.has(gid)) return true;              // a configured group id is authoritative
    if (FOREIGN_COMMUNITY_TAG.test(name)) return false; // another community's group · drop it
    return MET_GROUP_NAME.test(name);
  });
}

// ── GET /api/hicomm/officer/:id/met — enrich a SITE user's 360 with their live
// MET Discord roles + Roblox group ranks. ──
router.get('/officer/:id/met', async (req, res) => {
  try {
    const u = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!u) return res.status(404).json({ error: 'Officer not found' });
    const profile = await buildMetProfile({ discordId: u.discordId, robloxId: u.robloxId, robloxUsername: u.robloxUsername });
    res.json(profile);
  } catch (e) {
    console.error('[HICOMM] officer met enrich failed:', e.message);
    res.status(500).json({ error: 'Failed to load MET details' });
  }
});

// ── GET /api/hicomm/subject?discordId=|robloxId=|robloxUsername= — a MET profile
// for someone who ISN'T (necessarily) a site user. Also reports whether a site
// account exists, so the UI can offer to open the full 360. Audited. ──
router.get('/subject', async (req, res) => {
  try {
    const discordId      = req.query.discordId ? String(req.query.discordId) : null;
    let   robloxId       = req.query.robloxId ? String(req.query.robloxId) : null;
    const robloxUsername = req.query.robloxUsername ? String(req.query.robloxUsername) : null;
    if (!discordId && !robloxId && !robloxUsername) return res.status(400).json({ error: 'A subject identifier is required.' });

    const profile = await buildMetProfile({ discordId, robloxId, robloxUsername });
    if (!robloxId && profile.roblox) robloxId = profile.roblox.id;

    // Is this person already a site user? (so the UI can deep-link the full 360)
    const or = [];
    if (discordId) or.push({ discordId });
    if (robloxId)  or.push({ robloxId: String(robloxId) });
    const siteUser = or.length ? await prisma.user.findFirst({ where: { OR: or }, select: { id: true, displayName: true, discordUsername: true, role: true } }).catch(() => null) : null;

    const subject = {
      name: (profile.discord && profile.discord.nick) || (profile.roblox && (profile.roblox.username)) || robloxUsername || 'Unknown',
      avatar: profile.discord && profile.discord.avatar,
      discordId: discordId || (profile.discord && profile.discord.discordId) || null,
      robloxId: robloxId || null,
      robloxUsername: profile.roblox && profile.roblox.username,
      siteUserId: siteUser ? siteUser.id : null,
      siteRole: siteUser ? siteUser.role : null,
    };
    require('../lib/audit').log(req.user, { category: 'ACCESS', action: 'LOOKUP', target: { type: 'subject', id: subject.discordId || subject.robloxId || robloxUsername, name: subject.name }, summary: `Looked up MET profile for ${subject.name}` });
    res.json({ subject, ...profile });
  } catch (e) {
    console.error('[HICOMM] subject lookup failed:', e.message);
    res.status(500).json({ error: 'Failed to load subject' });
  }
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
      prisma.ticketLog.findMany({ where: { OR: [{ closerUserId: u.id }, { closerDiscordId: u.discordId }] }, orderBy: { closedAt: 'desc' }, take: 50, select: { id: true, ticketRef: true, ticketType: true, status: true, closedAt: true } }),
      prisma.auditLog.findMany({ where: { category: { not: 'DEV' }, OR: [{ actorId: u.id }, { targetId: u.id }] }, orderBy: { createdAt: 'desc' }, take: 50 }),
    ]);

    const events = [];
    for (const c of cases) events.push({ at: c.createdAt, kind: 'case', refId: c.id, icon: 'ti-gavel', color: '#e0503a', title: `Case ${c.caseRef} · ${c.action}`, detail: c.reason, status: c.status });
    for (const p of punishments) events.push({ at: p.issuedAt, kind: 'punishment', refId: p.id, icon: 'ti-alert-triangle', color: '#e8842a', title: `${p.type || 'Punishment'}${p.active ? '' : ' (expired)'}`, detail: p.reason, status: p.active ? 'ACTIVE' : 'ENDED' });
    for (const l of hosted) events.push({ at: l.createdAt, kind: 'tryout', refId: l.id, icon: 'ti-clipboard-check', color: '#3b82f6', title: `Hosted ${l.division} tryout`, detail: `${l.totalAttendees} attended · ${l.passedCount} passed`, status: l.status });
    for (const p of patrols) events.push({ at: p.createdAt, kind: 'patrol', refId: p.id, icon: 'ti-shield', color: '#14b8a6', title: p.type === 'EVENT' ? 'Event log' : 'Patrol log', detail: p.totalMinutes != null ? `${p.totalMinutes} min` : '', status: p.status });
    for (const t of tickets) events.push({ at: t.closedAt, kind: 'ticket', refId: t.id, icon: 'ti-lifebuoy', color: '#8b93a1', title: `Closed ticket ${t.ticketRef || ''} (${t.ticketType})`.trim(), detail: '', status: t.status });
    for (const a of auditRows) events.push({ at: a.createdAt, kind: 'audit', refId: a.id, icon: 'ti-history', color: '#6b7280', title: a.summary || `${a.category}/${a.action}`, detail: a.actorId === u.id ? `by them` : `on them · by ${a.actorName}`, status: a.action });

    events.sort((a, b) => new Date(b.at) - new Date(a.at));

    // Roblox headshot so the card can show a proper Roblox profile block (like the
    // ticket profile card). Best-effort + cached; never blocks the timeline.
    let robloxHeadshot = null;
    if (rid) { try { robloxHeadshot = await require('../lib/roblox').getRobloxAvatarHeadshot(rid); } catch (e) {} }

    res.json({
      officer: { id: u.id, name: u.displayName || u.discordUsername, discordUsername: u.discordUsername,
        discordId: u.discordId, robloxUsername: u.robloxUsername, robloxId: u.robloxId, avatar: u.discordAvatar, role: u.role,
        robloxHeadshot,
        joinedAt: u.createdAt, lastLogin: u.lastLogin },
      counts: { cases: cases.length, punishments: punishments.length, hosted: hosted.length, patrols: patrols.length, tickets: tickets.length },
      events: events.slice(0, 200),
    });
  } catch (e) {
    console.error('[HICOMM] timeline failed:', e.message);
    res.status(500).json({ error: 'Failed to load timeline' });
  }
});

// ── GET /api/hicomm/entity/:kind/:id — full detail behind a timeline event ──
// Lets HICOMM click any point on the 360° timeline and see the actual record
// (the ticket + its conversation, the IA case, the tryout log, the patrol log,
// the punishment, or the audit entry). Read-only; the view is audited.
router.get('/entity/:kind/:id', async (req, res) => {
  const kind = String(req.params.kind || '').toLowerCase();
  const id   = req.params.id;
  try {
    let out = null;

    if (kind === 'ticket') {
      const t = await prisma.ticketLog.findUnique({ where: { id } });
      if (!t) return res.status(404).json({ error: 'Ticket not found' });
      out = { kind, title: `Ticket ${t.ticketRef || ''} · ${t.ticketType}`.trim(), status: t.status,
        link: t.transcriptUrl || null,
        fields: [
          ['Type', t.ticketType], ['Ticket', t.ticketName || t.ticketRef || '·'],
          ['Opened by', t.creatorRobloxUsername || t.creatorUsername || '·'],
          ['Closed by', t.closerUsername || '·'], ['Reason', t.reason || '·'],
          ['Reviewed by', t.reviewedByName || '·'],
          ['Closed', t.closedAt], ['Reviewed', t.reviewedAt || '·'],
        ],
        intake: [],
        messages: [],
      };
    } else if (kind === 'case') {
      const c = await prisma.case.findUnique({ where: { id }, include: { caseActions: { orderBy: { timestamp: 'asc' } }, casePunishments: true } }).catch(() => null);
      if (!c) return res.status(404).json({ error: 'Case not found' });
      out = { kind, title: `IA Case ${c.caseRef}`, status: c.status, link: c.caseLink || null,
        fields: [
          ['Action', c.action], ['Suspect', c.robloxUsername || c.suspectRobloxDisplayName || '·'],
          ['Investigator', c.investigatorDiscordUsername || c.investigatorRobloxUsername || '·'],
          ['Reason', c.reason], ['Notes', c.notes], ['Punishments', c.punishmentsSummary || '·'],
          ['Opened', c.createdAt], ['Updated', c.updatedAt],
        ],
        messages: (c.caseActions || []).map(a => ({ author: a.performedBy, kind: a.actionType, body: a.notes || '', at: a.timestamp })),
      };
    } else if (kind === 'tryout') {
      const l = await prisma.tryoutLog.findUnique({ where: { id } });
      if (!l) return res.status(404).json({ error: 'Tryout log not found' });
      out = { kind, title: `${l.division} tryout log`, status: l.status,
        link: `/${l.division.toLowerCase() === 'sco19' ? 'sco19' : l.division.toLowerCase()}/dashboard?tryoutLog=${l.id}`,
        fields: [
          ['Host', l.hostName], ['Co-host', l.coHostName || '·'],
          ['Attended', l.totalAttendees], ['Passed', l.passedCount], ['Failed', l.failedCount],
          ['Strikes', l.strikeCount], ['Concluded', l.concludedAt || l.createdAt],
          ['Review note', l.reviewNote || '·'], ['Reviewed by', l.reviewedByName || '·'],
        ],
        attendees: Array.isArray(l.attendees) ? l.attendees.map(a => ({ username: a.username, result: a.result, strikes: a.strikes || 0 })) : [],
      };
    } else if (kind === 'patrol') {
      const p = await prisma.patrolLog.findUnique({ where: { id } });
      if (!p) return res.status(404).json({ error: 'Patrol log not found' });
      out = { kind, title: p.type === 'EVENT' ? 'Event log' : 'Patrol log', status: p.status,
        fields: [
          ['Type', p.type], ['Division', p.division || 'N/A'],
          ['Shift', `${p.shiftStart || '?'} → ${p.shiftEnd || '?'}`],
          ['Duration', p.totalMinutes != null ? `${p.totalMinutes} min` : '·'],
          ['Submitted by', p.submitterDisplayName || p.submitterUsername || '·'],
          ['Reviewed by', p.reviewedByName || '·'], ['Logged', p.createdAt],
        ],
        raw: p.rawContent || '', images: Array.isArray(p.images) ? p.images : [],
      };
    } else if (kind === 'punishment') {
      const p = await prisma.metPunishment.findUnique({ where: { id } });
      if (!p) return res.status(404).json({ error: 'Punishment not found' });
      out = { kind, title: `${p.type || 'Punishment'}${p.active ? '' : ' (expired)'}`, status: p.active ? 'ACTIVE' : 'ENDED',
        fields: [
          ['Type', p.type], ['Reason', p.reason || '·'], ['Issued by', p.issuedBy || '·'],
          ['Case ref', p.caseRef || '·'], ['Issued', p.issuedAt], ['Expires', p.expiresAt || '·'],
        ],
      };
    } else if (kind === 'audit') {
      const a = await prisma.auditLog.findUnique({ where: { id } });
      if (!a) return res.status(404).json({ error: 'Audit entry not found' });
      out = { kind, title: a.summary || `${a.category}/${a.action}`, status: a.action,
        fields: [
          ['Category', a.category], ['Action', a.action], ['Actor', a.actorName || 'System'],
          ['Target', a.targetName || '·'], ['Division', a.division || '·'], ['When', a.createdAt],
        ],
        metadata: a.metadata && typeof a.metadata === 'object' ? a.metadata : null,
      };
    } else {
      return res.status(400).json({ error: 'Unknown entity kind' });
    }

    require('../lib/audit').log(req.user, { category: 'ACCESS', action: 'VIEW_ENTITY', target: { type: kind, id }, summary: `Viewed ${kind} from officer timeline` });
    res.json(out);
  } catch (e) {
    console.error('[HICOMM] entity detail failed:', e.message);
    res.status(500).json({ error: 'Failed to load detail' });
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
