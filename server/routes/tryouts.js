// server/routes/tryouts.js — public-facing tryout view (MET-wide).
// Mounted at /api/tryouts behind requireAuth. British citizens see upcoming +
// live tryouts and can join the live one directly. Gated to the British-citizen
// Discord role when BRITISH_CITIZEN_ROLE_ID is set; until then, any signed-in
// user can see them (so the feature works before the role id is provided).
const express = require('express');
const prisma  = require('../lib/db');

const router = express.Router();

function britishCitizenRoleId() { return process.env.BRITISH_CITIZEN_ROLE_ID || null; }

function canSeeTryouts(user) {
  if (user.role === 'DEVELOPER') return true;
  const roleId = britishCitizenRoleId();
  if (!roleId) return true; // not configured yet → visible to all signed-in users
  const ids = Array.isArray(user.metRoleIds) ? user.metRoleIds : [];
  return ids.includes(roleId);
}

// GET /api/tryouts/upcoming — live now + scheduled ahead.
router.get('/upcoming', async (req, res) => {
  if (!canSeeTryouts(req.user)) return res.json({ eligible: false, live: [], upcoming: [] });
  try {
    const [live, upcoming] = await Promise.all([
      prisma.tryout.findMany({ where: { status: 'LIVE' }, orderBy: { scheduledAt: 'desc' }, take: 20 }),
      prisma.tryout.findMany({
        where: { status: 'SCHEDULED', scheduledAt: { gte: new Date(Date.now() - 5 * 60 * 1000) } },
        orderBy: { scheduledAt: 'asc' }, take: 20,
      }),
    ]);
    const pub = (t) => ({
      id: t.id, hostName: t.hostName, coHostName: t.coHostName,
      scheduledAt: t.scheduledAt, status: t.status, lockState: t.lockState,
      // Only expose the join link once the tryout is live.
      joinLink: t.status === 'LIVE' ? (t.privateServerLink || null) : null,
    });
    res.json({ eligible: true, live: live.map(pub), upcoming: upcoming.map(pub) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load tryouts' });
  }
});

module.exports = router;
