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

// ── Database sync ─────────────────────────────────────────────────
// Removes members who are no longer in the group from the database sheet, and
// adds newly joined members into the rows that frees up.
//
// WHICH database is a parameter. IA runs this against its own sheet from the IA
// dashboard; FLP High Command runs the same thing against the MET sheet from
// theirs. Same comparison, same safety rails, different sheet and group.
//
//   GET  /api/quota/met-database?division=IA|MET   → what it WOULD do
//   POST /api/quota/met-database/sync              → actually do it

// Only these two have a database this machinery understands, and letting the
// query string name any division would point a destructive sync at a sheet
// nobody meant.
const DB_DIVISIONS = ['IA', 'MET'];
function dbDivision(req) {
  const d = ((req.query && req.query.division) || (req.body && req.body.division) || 'IA')
    .toString().toUpperCase();
  return DB_DIVISIONS.includes(d) ? d : 'IA';
}

// The MET database belongs to FLP High Command as well as to developers — they
// are the ones who maintain it. IA's own database stays HICOMM-strict.
function canTouchDatabase(req, res, next) {
  const division = dbDivision(req);
  if (division !== 'MET') return requireHICOMMStrict(req, res, next);
  const divs = Array.isArray(req.user.divisions) ? req.user.divisions : [];
  const flpHicomm = divs.some(d => d && d.division === 'FLP' && (d.hicomm || d.metHicomm));
  if (req.user.role === 'DEVELOPER' || req.user.role === 'HICOMM' || flpHicomm) return next();
  return res.status(403).json({ error: 'The MET database is maintained by FLP High Command.' });
}

router.get('/met-database', canTouchDatabase, async (req, res) => {
  try {
    const { syncMetDatabase } = require('../lib/metDatabase');
    const plan = await syncMetDatabase({ dry: true, division: dbDivision(req) });
    if (!plan.ok) return res.status(plan.error ? 400 : 500).json(plan);
    res.json(plan);
  } catch (err) {
    console.error('[MetDB] plan error:', err.message);
    res.status(500).json({ error: 'Could not read the MET database: ' + err.message });
  }
});

router.post('/met-database/sync', canTouchDatabase, async (req, res) => {
  try {
    const { syncMetDatabase } = require('../lib/metDatabase');
    const result = await syncMetDatabase({
      dry:      false,
      division: dbDivision(req),
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
router.get('/met-database/audit', canTouchDatabase, async (req, res) => {
  try {
    const { auditMet, summarise } = require('../lib/metDatabaseAudit');
    const report = await auditMet({ checkGroup: req.query.group !== '0', division: dbDivision(req) });
    if (!report.ok) return res.status(400).json(report);
    res.json({ ...report, summaryText: summarise(report) });
  } catch (err) {
    console.error('[MetDB] audit error:', err.message);
    res.status(500).json({ error: 'MET database audit failed: ' + err.message });
  }
});

// ── Adding people the sheet is missing ────────────────────────────
// GET  /api/quota/met-database/missing   everyone in the group with no row
// POST /api/quota/met-database/add-members   add the ones that were picked
//
// The sync decides for itself and only ever offers the entry rank, which means a
// Junior Investigator who never got a row stays invisible until their quota
// reads zero for a month. These two are the manual half: a list to look at, and
// a write that does exactly what it was told.
router.get('/met-database/missing', canTouchDatabase, async (req, res) => {
  try {
    const { missingMembers } = require('../lib/metDatabase');
    const out = await missingMembers(dbDivision(req));
    if (out.error) return res.status(400).json(out);
    res.json(out);
  } catch (err) {
    console.error('[MetDB] missing-members read failed:', err.message);
    res.status(500).json({ error: 'Could not work out who is missing: ' + err.message });
  }
});

router.post('/met-database/add-members', canTouchDatabase, async (req, res) => {
  const body = req.body || {};
  if (!Array.isArray(body.members) || !body.members.length) {
    return res.status(400).json({ error: 'Pick at least one person to add.' });
  }
  try {
    const { addMembers } = require('../lib/metDatabase');
    const out = await addMembers(body.members, dbDivision(req), {
      id: req.user.id, name: req.user.displayName || req.user.discordUsername || req.user.id,
    });
    // A bad selection is the caller's fault; a sheet that refuses the write is
    // not. Answering 400 for both told somebody their selection was wrong when
    // the actual problem was upstream.
    if (!out.ok) return res.status(out.stage === 'write' ? 502 : 400).json(out);
    res.json(out);
  } catch (err) {
    console.error('[MetDB] add-members failed:', err.message);
    res.status(500).json({ error: 'Could not add them: ' + err.message });
  }
});

router.post('/met-database/normalise', canTouchDatabase, async (req, res) => {
  const body = req.body || {};
  try {
    const { normaliseMet } = require('../lib/metDatabaseAudit');
    const result = await normaliseMet({
      division:   dbDivision(req),
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
