// server/routes/divisionQuota.js — generic per-division quota + activity API.
// Mounted at /api/divquota behind requireAuth. Serves every division that has a
// quota database (IA, FLP, MET, SCO19, CID):
//   GET  /:division/members  → read-only member list (Activity Tracking tab for
//                              ANY member of the division) + a canReview flag.
//   POST /:division/check|exempt|loa|reset → HICOMM (division LEAD) only.
// FLP/MET keep their own /api/flp/quota routes; this powers the newer division
// dashboards (SCO-19, CID) and the read-only Activity tab shared by all.
const express = require('express');
const router  = express.Router();

const quotaLib = require('../lib/quota');
const { sendQuotaCheckWebhook } = require('../lib/webhook');
const { userHasDivision, userIsDivisionLead } = require('../middleware/division');

// Divisions with a quota database (match quota-lib's DIVISION_PREFIX keys).
const QUOTA_DIVISIONS = new Set(['IA', 'FLP', 'MET', 'SCO19', 'CID', 'HPC']);
function normDivision(d) {
  const x = String(d || '').toUpperCase();
  return QUOTA_DIVISIONS.has(x) ? x : null;
}

// A member of the division (or MET HICOMM / developer) may READ the activity.
function requireMember(req, res, next) {
  const division = normDivision(req.params.division);
  if (!division) return res.status(404).json({ error: 'Unknown division.' });
  if (userHasDivision(req.user, division)) { req.division = division; return next(); }
  return res.status(403).json({ error: `${division} access required.` });
}

// Only a division LEAD (HICOMM), MET HICOMM or developer may EDIT/review.
function requireLead(req, res, next) {
  const division = normDivision(req.params.division);
  if (!division) return res.status(404).json({ error: 'Unknown division.' });
  if (userIsDivisionLead(req.user, division)) { req.division = division; return next(); }
  return res.status(403).json({ error: `${division} High Command access required.` });
}

// ── GET /:division/access — cheap membership/lead check (no sheet read) ──
// Used by dashboards to reveal HICOMM-only tabs without a Google Sheets round-trip.
router.get('/:division/access', (req, res) => {
  const division = normDivision(req.params.division);
  if (!division) return res.status(404).json({ error: 'Unknown division.' });
  res.json({
    division,
    member:    userHasDivision(req.user, division),
    canReview: userIsDivisionLead(req.user, division),
  });
});

// ── GET /:division/me — the signed-in member's OWN quota + progression ──
router.get('/:division/me', requireMember, async (req, res) => {
  try {
    const row = await quotaLib.getMemberPoints(
      { discordId: req.user.discordId, robloxUsername: req.user.robloxUsername }, req.division,
    );
    if (row == null) return res.json({ configured: false });
    if (!row.found)  return res.json({ configured: true, found: false });
    const exempt = !!(row.quota && row.quota.exempt);
    const target = row.quota ? row.quota.target : null;
    res.json({
      configured: true, found: true, division: req.division,
      rank: row.rank, exempt, exemptKind: row.exemptKind || (exempt ? 'EXEMPT' : null),
      total: row.total, target, remaining: row.remaining,
      tier: row.quota ? row.quota.tier : null,
      met:  exempt ? true : (target != null ? row.total >= target : null),
      days: row.days || null,
    });
  } catch (err) {
    console.error(`[DivQuota] ${req.division} me error:`, err.message);
    res.status(500).json({ error: 'Failed to read your quota.' });
  }
});

// ── GET /:division/members — everyone's activity (read-only for members) ──
router.get('/:division/members', requireMember, async (req, res) => {
  try {
    const members = await quotaLib.getAllMembersPoints(req.division);
    const canReview = userIsDivisionLead(req.user, req.division);
    if (members == null) return res.json({ configured: false, members: [], division: req.division, canReview });
    res.json({ configured: true, members, division: req.division, canReview });
  } catch (err) {
    console.error(`[DivQuota] ${req.division} members error:`, err.message);
    res.status(500).json({ error: 'Failed to read quota sheet.' });
  }
});

// ── POST /:division/check — post the weekly review to Discord (LEAD) ──
router.post('/:division/check', requireLead, async (req, res) => {
  const { results, weekLabel } = req.body || {};
  if (!Array.isArray(results) || !results.length) return res.status(400).json({ error: 'No results to submit.' });
  for (const r of results) {
    if (!r || !r.username || !['pass', 'fail', 'exempt'].includes(r.status)) {
      return res.status(400).json({ error: 'Each result needs a username and a pass/fail/exempt status.' });
    }
  }
  try {
    const cfg = quotaLib.quotaConfig(req.division);
    const ok = await sendQuotaCheckWebhook({
      reviewerName:  req.user.displayName || req.user.discordUsername,
      reviewerId:    req.user.discordId,
      results, weekLabel,
      webhookUrl:    cfg.resultsWebhookUrl,
      divisionLabel: req.division,
      mentionRoleId: process.env[`${cfg.prefix}QUOTA_MENTION_ROLE_ID`] || null,
    });
    if (!ok) return res.status(502).json({ error: 'Quota results webhook is not configured or failed to send.' });
    res.json({ ok: true, division: req.division });
  } catch (err) {
    console.error(`[DivQuota] ${req.division} check error:`, err.message);
    res.status(500).json({ error: 'Failed to submit quota check.' });
  }
});

// ── POST /:division/exempt | /loa — write a marker for one member (LEAD) ──
async function markMember(req, res, kind) {
  const username = (req.body && req.body.username || '').toString().trim();
  if (!username) return res.status(400).json({ error: 'Username is required.' });
  try {
    const result = kind === 'loa'
      ? await quotaLib.setMemberLOA(username, req.division)
      : await quotaLib.setMemberExempt(username, req.division);
    if (!result.ok) return res.status(500).json({ error: result.error || `Failed to set ${kind}.` });
    res.json(result);
  } catch (err) {
    console.error(`[DivQuota] ${req.division} ${kind} error:`, err.message);
    res.status(500).json({ error: `Failed to set ${kind}.` });
  }
}
router.post('/:division/exempt', requireLead, (req, res) => markMember(req, res, 'exempt'));
router.post('/:division/loa',    requireLead, (req, res) => markMember(req, res, 'loa'));

// ── POST /:division/reset — clear everyone's weekly points (LEAD) ──
router.post('/:division/reset', requireLead, async (req, res) => {
  try {
    const result = await quotaLib.resetAllQuota(req.division);
    if (!result.ok) return res.status(500).json({ error: result.error || 'Reset failed.' });
    console.log(`[DivQuota] ${req.division} reset by ${req.user.displayName || req.user.discordUsername} — ${result.cleared} cell(s) cleared`);
    res.json(result);
  } catch (err) {
    console.error(`[DivQuota] ${req.division} reset error:`, err.message);
    res.status(500).json({ error: 'Failed to reset quota.' });
  }
});

module.exports = router;
