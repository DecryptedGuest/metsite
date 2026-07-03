// server/middleware/division.js
// Per-division access gate, layered on top of requireAuth. Reads the cached
// req.user.divisions (kept fresh by lib/accessControl.js) so it never needs a
// live Discord call on the request path. Developers always pass every check.
const { hasDivisionAccess, divisionTier } = require('../lib/roleResolver');
const { hpcRankAtLeast, hpcExamRoleId } = require('../lib/divisions');

const DIVISION_SLUG = { CID: 'cid', SCO19: 'sco19', IA: 'ia', FLP: 'flp', HPC: 'hpc' };

// IA access is governed by the IA SITE ROLE (unchanged), never by the divisions
// cache — this keeps IA's gating identical to the original system and immune to
// the divisions cache being empty/stale for a legacy user.
const IA_MEMBER_ROLES = ['IA', 'SUPERVISOR', 'HICOMM', 'DEVELOPER'];
const IA_LEAD_ROLES   = ['SUPERVISOR', 'HICOMM', 'DEVELOPER'];

function userDivisions(user) {
  if (Array.isArray(user.divisions)) return user.divisions;
  // Prisma returns Json columns already parsed; this guards against a raw
  // string ending up here (e.g. from a manual DB edit).
  if (typeof user.divisions === 'string') {
    try { return JSON.parse(user.divisions) || []; } catch (e) { return []; }
  }
  return [];
}

// Does the user have access to `division`? IA → site role; HPC → Junior
// Instructor and above (not mere group membership); others → cache.
function userHasDivision(user, division) {
  if (division === 'IA')  return IA_MEMBER_ROLES.includes(user.role);
  if (division === 'HPC') return user.role === 'DEVELOPER' || userHpcTier(user, 'instructor');
  return hasDivisionAccess(userDivisions(user), division);
}

// Is the user LEAD-tier in `division`? IA → HICOMM/SUPERVISOR/DEV; others → cache.
function userIsDivisionLead(user, division) {
  if (division === 'IA') return IA_LEAD_ROLES.includes(user.role);
  return divisionTier(userDivisions(user), division) === 'LEAD';
}

// requireDivision('CID') — 403/redirect-to-denied unless the user has any
// tier (MEMBER or LEAD) in that division. DEVELOPER always passes.
function requireDivision(division) {
  return function (req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (req.user.role === 'DEVELOPER') return next();
    if (userHasDivision(req.user, division)) return next();

    const isApi = req.originalUrl.startsWith('/api');
    if (isApi) return res.status(403).json({ error: `${division} access required` });
    return res.redirect(`/${DIVISION_SLUG[division]}/denied`);
  };
}

// requireDivisionLead('SCO19') — division access AND tier === 'LEAD'.
function requireDivisionLead(division) {
  return function (req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (req.user.role === 'DEVELOPER') return next();
    if (userIsDivisionLead(req.user, division)) return next();

    const isApi = req.originalUrl.startsWith('/api');
    if (isApi) return res.status(403).json({ error: `${division} lead access required` });
    return res.redirect(`/${DIVISION_SLUG[division]}/denied`);
  };
}

// ── HPC-specific tiers (Junior Instructor / Database Manager / Assistant Dir) ──
function hpcEntry(user) { return userDivisions(user).find(d => d.division === 'HPC'); }

// A cadet who holds the HPC final-exam Discord role must sit the exam.
function userNeedsFinalExam(user) {
  const ids = Array.isArray(user.metRoleIds) ? user.metRoleIds : [];
  return ids.includes(hpcExamRoleId());
}

// kind: 'instructor' | 'marker' | 'quota'. DEVELOPER always passes.
function userHpcTier(user, kind) {
  if (user.role === 'DEVELOPER') return true;
  const e = hpcEntry(user);
  if (!e) return false;
  return hpcRankAtLeast(e.rankName, e.rank, kind);
}

function requireHpcMarker(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (userHpcTier(req.user, 'marker')) return next();
  return res.status(403).json({ error: 'HPC marker access required (Database Manager and above).' });
}

function requireHpcQuota(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (userHpcTier(req.user, 'quota')) return next();
  return res.status(403).json({ error: 'HPC quota access required (Assistant Director and above).' });
}

module.exports = {
  requireDivision, requireDivisionLead,
  userDivisions, userHasDivision, userIsDivisionLead, DIVISION_SLUG,
  userNeedsFinalExam, userHpcTier, requireHpcMarker, requireHpcQuota,
};
