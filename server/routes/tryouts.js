// server/routes/tryouts.js — public-facing tryout view (MET-wide).
// Mounted at /api/tryouts behind requireAuth. British citizens see upcoming +
// live tryouts and can join the live one directly. Gated to the British-citizen
// Discord role when BRITISH_CITIZEN_ROLE_ID is set; until then, any signed-in
// user can see them (so the feature works before the role id is provided).
const express = require('express');
const jwt     = require('jsonwebtoken');
const prisma  = require('../lib/db');
const audit   = require('../lib/audit');
const { metRole } = require('../lib/metRank');
const { tryoutLaunchUrl } = require('../lib/tryouts');

const router = express.Router();

function britishCitizenRoleId() { return process.env.BRITISH_CITIZEN_ROLE_ID || null; }

function canSeeTryouts(user) {
  if (user.role === 'DEVELOPER') return true;
  const roleId = britishCitizenRoleId();
  if (!roleId) return true; // not configured yet → visible to all signed-in users
  const ids = Array.isArray(user.metRoleIds) ? user.metRoleIds : [];
  return ids.includes(roleId);
}

// A tryout's division 'HPC' is the MET RECRUITMENT (join-the-MET) tryout; every
// other division ('CID','SCO19',…) is a division tryout for existing members.
function isMetTryout(t) { return String((t && t.division) || 'HPC').toUpperCase() === 'HPC'; }

// Which tryouts a viewer may see:
//   • MET (recruitment) tryouts — ONLY pure outsiders: not in the MET group AND
//     without the final-exam role (people who still need to join the MET).
//   • Division tryouts — MET members at Constable and above.
// So a final-exam holder or a CSO (MET but below Constable) sees neither the MET
// recruitment tryouts (they're past that) nor division tryouts (not yet Con+).
// MET_CONSTABLE_MIN_RANK pins the Constable rank number; otherwise Constable+ is
// "a MET member whose rank name isn't a CSO/cadet tier".
async function tryoutVisibility(user) {
  if (!user) return { seeMet: true, seeDivision: false };
  if (user.role === 'DEVELOPER') return { seeMet: true, seeDivision: true };
  let rank = 0, rankName = '';
  if (user.metRankOverride && Number.isFinite(Number(user.metRankOverride.rank))) {
    rank = Number(user.metRankOverride.rank); rankName = user.metRankOverride.name || '';
  } else if (user.robloxId) {
    try { const r = await metRole(user.robloxId); if (r) { rank = Number(r.rank) || 0; rankName = r.name || ''; } } catch (e) {}
  }
  const isMet = rank > 0;
  let hasFinalExam = false;
  try { hasFinalExam = await require('../middleware/division').userHasFinalExamRole(user); } catch (e) { hasFinalExam = false; }
  const conMin = parseInt(process.env.MET_CONSTABLE_MIN_RANK, 10);
  const csoTier = /community support officer|\bcso\b|\bcadet\b|recruit|trainee|probation/i.test(rankName);
  const isConstablePlus = isMet && (Number.isFinite(conMin) ? rank >= conMin : !csoTier);
  return {
    seeMet: !isMet && !hasFinalExam,   // pure outsiders only
    seeDivision: isConstablePlus,       // MET Constable+
    isMet, hasFinalExam, metRank: rank, metRankName: rankName, isConstablePlus,
  };
}
function canSeeTryout(vis, t) { return isMetTryout(t) ? vis.seeMet : vis.seeDivision; }

// Signed, short-lived, per-user join token. The raw private-server link is never
// sent to the browser; instead the client gets a /join redirect URL carrying
// this token. It is bound to one user + one tryout and expires in 2 minutes, so
// a copied link can't be shared or reused later.
const JOIN_TTL_SECONDS = 900;
function signJoinToken(tryoutId, userId) {
  return jwt.sign(
    { tid: tryoutId, uid: userId, purpose: 'tryout_join' },
    process.env.JWT_SECRET,
    { expiresIn: JOIN_TTL_SECONDS }
  );
}

// GET /api/tryouts/upcoming — live now + scheduled ahead.
router.get('/upcoming', async (req, res) => {
  if (!canSeeTryouts(req.user)) return res.json({ eligible: false, live: [], upcoming: [] });
  try {
    const vis = await tryoutVisibility(req.user);
    const [liveAll, upcomingAll] = await Promise.all([
      prisma.tryout.findMany({ where: { status: 'LIVE' }, orderBy: { scheduledAt: 'desc' }, take: 40 }),
      prisma.tryout.findMany({
        where: { status: 'SCHEDULED', scheduledAt: { gte: new Date(Date.now() - 5 * 60 * 1000) } },
        orderBy: { scheduledAt: 'asc' }, take: 40,
      }),
    ]);
    // Hide MET-recruitment tryouts from members and division tryouts from outsiders.
    const live = liveAll.filter(t => canSeeTryout(vis, t));
    const upcoming = upcomingAll.filter(t => canSeeTryout(vis, t));
    const pub = (t) => ({
      id: t.id, hostName: t.hostName, coHostName: t.coHostName, division: t.division || 'HPC',
      scheduledAt: t.scheduledAt, status: t.status, lockState: t.lockState,
      // Only expose a join path once live, and only as a signed redirect URL —
      // never the raw private-server link. A launch URL alone is enough (the
      // privacy-independent router flow), so joining works even without a link.
      joinLink: (t.status === 'LIVE' && (t.privateServerLink || tryoutLaunchUrl(t)))
        ? `/api/tryouts/${t.id}/join?token=${encodeURIComponent(signJoinToken(t.id, req.user.id))}`
        : null,
    });
    res.json({ eligible: true, live: live.map(pub), upcoming: upcoming.map(pub), visibility: { seeMet: vis.seeMet, seeDivision: vis.seeDivision } });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load tryouts' });
  }
});

// GET /api/tryouts/:id/join?token=... — verify the signed token, re-check
// eligibility, then redirect to the real private-server link. This is the only
// place the raw link is revealed, and only to the specific user it was issued
// to, within the short token window.
router.get('/:id/join', async (req, res) => {
  const fail = (msg) => res.status(403).type('html').send(
    `<!doctype html><meta charset="utf-8"><title>Join link expired</title>` +
    `<body style="font-family:system-ui;background:#0a0c12;color:#e6e9ef;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center">` +
    `<div><h1 style="font-size:20px">${msg}</h1><p style="color:#9aa3b2">Return to your dashboard and click Join again to get a fresh link.</p>` +
    `<a href="/dashboard" style="color:#4a8fff">Back to dashboard</a></div></body>`
  );
  try {
    let payload;
    try {
      payload = jwt.verify(String(req.query.token || ''), process.env.JWT_SECRET);
    } catch (e) {
      return fail('This join link has expired.');
    }
    if (payload.purpose !== 'tryout_join' || payload.tid !== req.params.id || payload.uid !== req.user.id) {
      return fail('This join link isn’t valid for your account.');
    }
    if (!canSeeTryouts(req.user)) return fail('You’re not eligible to join this tryout.');

    const t = await prisma.tryout.findUnique({ where: { id: req.params.id } });
    if (!t || t.status !== 'LIVE') return fail('This tryout isn’t live right now.');
    // Same division-visibility rule as the list: a member can't deep-link into a
    // tryout they aren't allowed to see.
    const vis = await tryoutVisibility(req.user);
    if (!canSeeTryout(vis, t)) return fail('You’re not eligible to join this tryout.');

    // Prefer the privacy-INDEPENDENT launch URL — the game's router reads
    // launchData and teleports the player into the reserved server via its access
    // code (TeleportService), so it never depends on the LINK OWNER's private-
    // server/friend privacy the way a raw shared link does (that dependency is
    // exactly what produces the "can't join due to privacy" error for players
    // whose own settings are fine). We only route this way when there's a reserved
    // access code (so the teleport is guaranteed); otherwise use the raw link.
    const launch = tryoutLaunchUrl(t);
    const target = (t.accessCode && launch) ? launch : (t.privateServerLink || launch);
    if (!target) return fail('This tryout has no join link configured yet.');

    audit.record({
      req, action: 'TRYOUT_JOIN', category: 'tryout', targetType: 'tryout', targetId: t.id,
      summary: `Joined the live tryout hosted by ${t.hostName}`,
    });
    return res.redirect(target);
  } catch (err) {
    return fail('Something went wrong opening this tryout.');
  }
});

module.exports = router;
