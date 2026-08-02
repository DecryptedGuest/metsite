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

// ── MET database sync ─────────────────────────────────────────────
// Removes members who are no longer in the MET Roblox group from the database
// sheet, and adds newly joined constables into the rows that frees up.
//
//   GET  /api/quota/met-database         → what the sync WOULD do (dry run)
//   POST /api/quota/met-database/sync    → actually do it

router.get('/met-database', requireHICOMMStrict, async (req, res) => {
  try {
    const { syncMetDatabase } = require('../lib/metDatabase');
    const plan = await syncMetDatabase({ dry: true });
    if (!plan.ok) return res.status(plan.error ? 400 : 500).json(plan);
    res.json(plan);
  } catch (err) {
    console.error('[MetDB] plan error:', err.message);
    res.status(500).json({ error: 'Could not read the MET database: ' + err.message });
  }
});

router.post('/met-database/sync', requireHICOMMStrict, async (req, res) => {
  try {
    const { syncMetDatabase } = require('../lib/metDatabase');
    const result = await syncMetDatabase({
      dry:   false,
      // The token comes from the dry run the operator just reviewed, so what
      // gets written is exactly what they were shown.
      token: (req.body && req.body.token) || null,
      actor: { id: req.user.id, name: req.user.displayName || req.user.discordUsername },
    });
    if (!result.ok) return res.status(result.stale ? 409 : 502).json(result);
    res.json(result);
  } catch (err) {
    console.error('[MetDB] sync error:', err.message);
    res.status(500).json({ error: 'MET database sync failed: ' + err.message });
  }
});

// ── MET database audit ────────────────────────────────────────────
// GET  /api/quota/met-database/audit    what is wrong with the sheet
// POST /api/quota/met-database/normalise  fix the fixable half
//
// The audit is read-only and safe to run at any time. Normalise only ever
// writes zeros into the seven day columns — it never adds, deletes or moves a
// row, and never touches a cell holding EX or LOA. Moving somebody to their
// correct rank tab is reported, not performed: that is a structural edit to a
// live sheet with no undo, and the operator should be the one making it.
router.get('/met-database/audit', requireHICOMMStrict, async (req, res) => {
  try {
    const { auditMet, summarise } = require('../lib/metDatabaseAudit');
    const report = await auditMet({ checkGroup: req.query.group !== '0' });
    if (!report.ok) return res.status(400).json(report);
    res.json({ ...report, summaryText: summarise(report) });
  } catch (err) {
    console.error('[MetDB] audit error:', err.message);
    res.status(500).json({ error: 'MET database audit failed: ' + err.message });
  }
});

router.post('/met-database/normalise', requireHICOMMStrict, async (req, res) => {
  const body = req.body || {};
  try {
    const { normaliseMet } = require('../lib/metDatabaseAudit');
    const result = await normaliseMet({
      fillBlanks: body.fillBlanks !== false,
      reset:      !!body.reset,
      // Default to a dry run. Zeroing a live database is not something to do by
      // accident, so the caller has to say apply:true explicitly.
      dryRun:     body.apply !== true,
    });
    if (!result.ok) return res.status(400).json(result);
    if (!result.dryRun) {
      console.log(`[MetDB] normalised by ${req.user.displayName || req.user.discordUsername}`
        + ` — ${result.cleared} cleared, ${result.filled} filled, ${result.kept} EX/LOA kept`);
    }
    res.json(result);
  } catch (err) {
    console.error('[MetDB] normalise error:', err.message);
    res.status(500).json({ error: 'MET database normalise failed: ' + err.message });
  }
});

module.exports = router;
