// server/routes/iaProfiles.js
// IA oversight → "IA Profiles": IA HICOMM and MET HICOMM can search IA members
// and open a full profile — Discord + Roblox identity, every case they've
// investigated and every ticket log they've filed/reviewed, with statuses.
// Gated to HICOMM/DEVELOPER (MET HICOMM resolve to role HICOMM, so they're in).
const express = require('express');
const router  = express.Router();
const prisma  = require('../lib/db');
const roblox  = require('../lib/roblox');
const { requireHICOMMStrict } = require('../middleware/auth');

router.use(requireHICOMMStrict);

const IA_SITE_ROLES = ['IA', 'SUPERVISOR', 'HICOMM', 'DEVELOPER'];

// The IA division entry (if any) in a user's cached divisions.
function iaDivisionEntry(u) {
  const divs = Array.isArray(u.divisions) ? u.divisions : [];
  return divs.find(d => d && d.division === 'IA') || null;
}
// Is this user an IA member? (an IA division entry, or an IA-flavoured site role)
function isIaMember(u) {
  return !!iaDivisionEntry(u) || ['IA', 'SUPERVISOR'].includes(u.role);
}
// The IA rank label to show — the cached IA group rank name, else the site role.
function iaRankLabel(u) {
  const e = iaDivisionEntry(u);
  if (e && e.rankName) return e.rankName;
  if (u.role === 'HICOMM') return 'IA HICOMM';
  if (u.role === 'SUPERVISOR') return 'Supervisor';
  if (u.role === 'IA') return 'Investigator';
  return u.role || '—';
}

// ── GET /api/ia-profiles/search?q= ───────────────────────────────────
// Search IA members by display/Discord/Roblox name or Discord id.
router.get('/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  try {
    const candidates = await prisma.user.findMany({
      where: {
        role: { in: IA_SITE_ROLES },
        ...(q ? { OR: [
          { displayName:     { contains: q, mode: 'insensitive' } },
          { discordUsername: { contains: q, mode: 'insensitive' } },
          { robloxUsername:  { contains: q, mode: 'insensitive' } },
          { discordId:       { contains: q } },
          { robloxId:        { contains: q } },
        ] } : {}),
      },
      select: {
        id: true, displayName: true, discordUsername: true, discordId: true,
        robloxUsername: true, robloxId: true, discordAvatar: true, role: true,
        divisions: true, lastLogin: true,
      },
      orderBy: [{ lastLogin: 'desc' }],
      take: 60,
    });
    const members = candidates.filter(isIaMember).slice(0, 40);
    res.json(members.map(u => ({
      id: u.id, displayName: u.displayName, discordUsername: u.discordUsername,
      discordId: u.discordId, robloxUsername: u.robloxUsername, robloxId: u.robloxId,
      discordAvatar: u.discordAvatar, role: u.role, iaRank: iaRankLabel(u),
      lastLogin: u.lastLogin,
    })));
  } catch (e) {
    console.error('[IA Profiles] search failed:', e.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ── GET /api/ia-profiles/:id ─────────────────────────────────────────
// Full profile: identity (Discord + Roblox + headshot), IA rank, and every
// case they investigated + ticket they filed/reviewed, with statuses + counts.
router.get('/:id', async (req, res) => {
  try {
    const u = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: {
        id: true, displayName: true, discordUsername: true, discordId: true,
        discordAvatar: true, robloxUsername: true, robloxId: true, role: true,
        divisions: true, createdAt: true, lastLogin: true,
      },
    });
    if (!u) return res.status(404).json({ error: 'Not found' });

    // Roblox headshot (best-effort — never blocks the profile).
    let headshot = null;
    if (u.robloxId) { try { headshot = await roblox.getRobloxAvatarHeadshot(u.robloxId); } catch (e) {} }

    // Cases they INVESTIGATED (by site account, Roblox id, or Roblox username).
    const caseOr = [{ userId: u.id }];
    if (u.robloxId)       caseOr.push({ investigatorRobloxId: String(u.robloxId) });
    if (u.robloxUsername) caseOr.push({ investigatorRobloxUsername: { equals: u.robloxUsername, mode: 'insensitive' } });
    const cases = await prisma.case.findMany({
      where: { OR: caseOr },
      select: {
        id: true, caseRef: true, action: true, reason: true, status: true, origin: true,
        robloxUsername: true, suspectRobloxDisplayName: true, caseLink: true,
        punishmentsSummary: true, createdAt: true,
      },
      orderBy: { createdAt: 'desc' }, take: 300,
    });

    // Ticket logs they CLOSED or REVIEWED. These are ingested from Discord —
    // nobody files a ticket on the site — so the link is the closer, matched on
    // the site account or the raw Discord id for tickets closed before they
    // first signed in.
    const tickets = await prisma.ticketLog.findMany({
      where: { OR: [{ closerUserId: u.id }, { closerDiscordId: u.discordId }, { reviewedById: u.id }] },
      select: {
        id: true, ticketRef: true, ticketName: true, ticketType: true, status: true,
        reason: true, transcriptUrl: true, creatorRobloxUsername: true,
        closerUsername: true, reviewedByName: true, closedAt: true,
      },
      orderBy: { closedAt: 'desc' }, take: 300,
    });

    const tally = (rows) => rows.reduce((a, r) => { const k = String(r.status || 'UNKNOWN'); a[k] = (a[k] || 0) + 1; return a; }, {});

    res.json({
      id: u.id,
      role: u.role,
      iaRank: iaRankLabel(u),
      isIaMember: isIaMember(u),
      createdAt: u.createdAt, lastLogin: u.lastLogin,
      discord: { id: u.discordId, username: u.discordUsername, avatar: u.discordAvatar },
      roblox: u.robloxId ? {
        id: u.robloxId, username: u.robloxUsername, headshot,
        url: `https://www.roblox.com/users/${u.robloxId}/profile`,
      } : null,
      icon: '/img/divisions/ia.png',
      cases: { total: cases.length, byStatus: tally(cases), items: cases },
      tickets: { total: tickets.length, byStatus: tally(tickets), items: tickets },
    });
  } catch (e) {
    console.error('[IA Profiles] profile failed:', e.message);
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

module.exports = router;
