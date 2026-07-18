// server/routes/quota.js — HICOMM Quota Check (HICOMM + Developer only; not Supervisor)
const express = require('express');
const { getAllMembersPoints, resetAllQuota, setMemberExempt, setMemberLOA, setInvestigatorOfWeek } = require('../lib/quota');
const { sendQuotaCheckWebhook } = require('../lib/webhook');

const router = express.Router();

// Stricter than requireHICOMM — excludes SUPERVISOR.
function requireHICOMMStrict(req, res, next) {
  if (req.user && ['HICOMM', 'DEVELOPER'].includes(req.user.role)) return next();
  return res.status(403).json({ error: 'HICOMM access required' });
}

// ── GET /api/quota/members ────────────────────────────────────────
// Every IA member with their rank, weekly total, quota target and met flag.
router.get('/members', requireHICOMMStrict, async (req, res) => {
  try {
    const members = await getAllMembersPoints();
    if (members == null) return res.json({ configured: false, members: [] });
    res.json({ configured: true, members });
  } catch (err) {
    console.error('[Quota] members error:', err.message);
    res.status(500).json({ error: 'Failed to read quota sheet.' });
  }
});

// ── POST /api/quota/check ─────────────────────────────────────────
// Body: { results: [{ username, rank, total, target, status, reason }], weekLabel? }
// Posts the review to the quota-results Discord webhook.
router.post('/check', requireHICOMMStrict, async (req, res) => {
  const { results, weekLabel, iotwUsername, iotwDiscordId } = req.body || {};
  if (!Array.isArray(results) || !results.length) {
    return res.status(400).json({ error: 'No results to submit.' });
  }
  for (const r of results) {
    if (!r || !r.username || !['pass', 'fail', 'exempt'].includes(r.status)) {
      return res.status(400).json({ error: 'Each result needs a username and a pass/fail/exempt status.' });
    }
  }
  try {
    // Apply Investigator of the Week: assign the IOTW role to the selected member
    // (reducing their quota) and remove it from the previous holder. If the same
    // person is re-selected, the role simply stays. Non-blocking on failure.
    let iotwApplied = null;
    if (iotwDiscordId) {
      // Guard on the Discord ID, not the username: calling setInvestigatorOfWeek(null)
      // as a side effect of a selection that merely lacked an ID would strip the
      // IOTW role from the PREVIOUS holder and grant it to nobody.
      iotwApplied = await setInvestigatorOfWeek(iotwDiscordId);
      if (iotwApplied && !iotwApplied.ok)
        console.warn('[Quota] IOTW role update failed:', iotwApplied.error);
    } else if (iotwUsername) {
      // A member was picked but their sheet row has no Discord ID — surface it as
      // a failure instead of silently clearing everyone's IOTW role.
      iotwApplied = { ok: false, error: 'No Discord ID on file for the selected Investigator of the Week.' };
      console.warn('[Quota] IOTW selection had no Discord ID — skipping role change for', iotwUsername);
    }

    const ok = await sendQuotaCheckWebhook({
      reviewerName: req.user.displayName || req.user.discordUsername,
      reviewerId:   req.user.discordId,
      results,
      weekLabel,
      iotwUsername: iotwUsername || null,
    });
    if (!ok) return res.status(502).json({ error: 'Quota results webhook is not configured or failed to send.' });
    res.json({ ok: true, iotw: iotwApplied });
  } catch (err) {
    console.error('[Quota] check error:', err.message);
    res.status(500).json({ error: 'Failed to submit quota check.' });
  }
});

// ── POST /api/quota/exempt ────────────────────────────────────────
// Body: { username } — marks a member exempt (writes "EX" to their day cells).
router.post('/exempt', requireHICOMMStrict, async (req, res) => {
  const username = (req.body && req.body.username || '').toString().trim();
  if (!username) return res.status(400).json({ error: 'Username is required.' });
  try {
    const result = await setMemberExempt(username);
    if (!result.ok) return res.status(500).json({ error: result.error || 'Failed to set exempt.' });
    res.json(result);
  } catch (err) {
    console.error('[Quota] exempt error:', err.message);
    res.status(500).json({ error: 'Failed to set exempt.' });
  }
});

// ── POST /api/quota/loa ───────────────────────────────────────────
// Body: { username } — marks a member on Leave of Absence (writes "LOA").
router.post('/loa', requireHICOMMStrict, async (req, res) => {
  const username = (req.body && req.body.username || '').toString().trim();
  if (!username) return res.status(400).json({ error: 'Username is required.' });
  try {
    const result = await setMemberLOA(username);
    if (!result.ok) return res.status(500).json({ error: result.error || 'Failed to set LOA.' });
    res.json(result);
  } catch (err) {
    console.error('[Quota] loa error:', err.message);
    res.status(500).json({ error: 'Failed to set LOA.' });
  }
});

// ── POST /api/quota/reset ─────────────────────────────────────────
// Resets EVERYONE's weekly quota points to 0 on the sheet. Destructive.
router.post('/reset', requireHICOMMStrict, async (req, res) => {
  try {
    const result = await resetAllQuota();
    if (!result.ok) return res.status(500).json({ error: result.error || 'Reset failed.' });
    console.log(`[Quota] reset by ${req.user.displayName || req.user.discordUsername} — ${result.cleared} cell(s) cleared`);
    res.json(result);
  } catch (err) {
    console.error('[Quota] reset error:', err.message);
    res.status(500).json({ error: 'Failed to reset quota.' });
  }
});

module.exports = router;
