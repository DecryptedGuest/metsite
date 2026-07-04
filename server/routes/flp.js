// server/routes/flp.js — Frontline Policing.
// Mounted at /api/flp behind requireAuth + requireDivision('FLP'). Group-panel
// endpoints add requireFlpGroupAdmin (Assistant Director+) and operate on the
// FLP Roblox group (GROUP_FLP) — same group-management helpers as the dev panel,
// scoped to FLP with an "assign below your own rank" guardrail.
const express = require('express');
const router  = express.Router();

const { userFlpGroupAdmin, requireFlpGroupAdmin, userDivisions } = require('../middleware/division');
const { explicitGroupId } = require('../lib/divisions');
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
    canGroupAdmin: userFlpGroupAdmin(req.user),
    flpRank:       myFlpRank(req.user),
    isDev:         req.user.role === 'DEVELOPER',
  });
});

// ── FLP group panel (Assistant Director+) ─────────────────────────────
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
    // Guardrail: a non-developer can only assign ranks BELOW their own FLP rank.
    if (req.user.role !== 'DEVELOPER') {
      const roles  = await listGroupRoles(gid);
      const target = roles.find(r => String(r.id) === String(roleId).split('/').pop());
      if (!target) return res.status(400).json({ error: 'Unknown role for this group.' });
      if (Number(target.rank) >= myFlpRank(req.user)) {
        return res.status(403).json({ error: 'You can only assign ranks below your own.' });
      }
    }
    await changeGroupRank(req.params.userId, roleId, gid);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/group/members/:userId', requireFlpGroupAdmin, async (req, res) => {
  try { await exileFromGroup(req.params.userId, flpGroupId()); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
