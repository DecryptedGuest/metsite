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

// ── FLP group panel — Assistant Director and above (FLP group rank ≥ 170) ──
// Lets FLP high command manage the FLP Roblox group from their dashboard.
// Override the threshold with FLP_GROUP_ADMIN_MIN_RANK. DEVELOPER always passes.
function userFlpGroupAdmin(user) {
  if (user.role === 'DEVELOPER') return true;
  const min = parseInt(process.env.FLP_GROUP_ADMIN_MIN_RANK, 10);
  const threshold = Number.isFinite(min) ? min : 170; // Assistant Director
  const e = userDivisions(user).find(d => d.division === 'FLP');
  return !!(e && Number(e.rank) >= threshold);
}

function requireFlpGroupAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (userFlpGroupAdmin(req.user)) return next();
  return res.status(403).json({ error: 'FLP Assistant Director or above required.' });
}

// ── CID tryout access — gated by two CID Discord roles in CID_GUILD_ID ──
// This REPLACES the Roblox-group-rank gate HPC uses. A user can view/manage the
// CID tryout dashboard, Live tab and management actions if they hold
// CID_INSTRUCTORUNIT_ROLE_ID or CID_DIRECTOROFFICE_ROLE_ID in CID_GUILD_ID.
// The Director's Office role is the LEAD tier (log review / approvals).
// Membership is read via the bot's cached role-holder lookup (60s TTL), so this
// never hammers Discord. DEVELOPER always passes.
function cidGuildId()       { return process.env.CID_GUILD_ID || null; }
function cidAccessRoleIds() { return [process.env.CID_INSTRUCTORUNIT_ROLE_ID, process.env.CID_DIRECTOROFFICE_ROLE_ID].filter(Boolean); }
function cidLeadRoleIds()   { return [process.env.CID_DIRECTOROFFICE_ROLE_ID].filter(Boolean); }

async function userHoldsAnyRole(user, guildId, roleIds) {
  if (!user || !user.discordId || !guildId || !roleIds.length) return false;
  try {
    const { getRoleHolders } = require('../lib/bot');
    const did = String(user.discordId).replace(/\D/g, '');
    for (const rid of roleIds) {
      const holders = await getRoleHolders(guildId, rid);
      if (holders && holders.has(did)) return true;
    }
  } catch (e) { /* bot down → deny */ }
  return false;
}

async function userHasCidTryout(user) {
  if (!user) return false;
  if (user.role === 'DEVELOPER') return true;
  return userHoldsAnyRole(user, cidGuildId(), cidAccessRoleIds());
}
async function userIsCidLead(user) {
  if (!user) return false;
  if (user.role === 'DEVELOPER') return true;
  return userHoldsAnyRole(user, cidGuildId(), cidLeadRoleIds());
}

function requireCidTryout(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  userHasCidTryout(req.user).then(ok => {
    if (ok) return next();
    if (req.originalUrl.startsWith('/api')) return res.status(403).json({ error: 'CID access required' });
    return res.redirect('/cid/denied');
  }).catch(() => res.status(403).json({ error: 'CID access required' }));
}
function requireCidLead(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  userIsCidLead(req.user).then(ok => {
    if (ok) return next();
    return res.status(403).json({ error: 'CID Director\'s Office access required.' });
  }).catch(() => res.status(403).json({ error: 'CID Director\'s Office access required.' }));
}

module.exports = {
  requireDivision, requireDivisionLead,
  userDivisions, userHasDivision, userIsDivisionLead, DIVISION_SLUG,
  userNeedsFinalExam, userHpcTier, requireHpcMarker, requireHpcQuota,
  userFlpGroupAdmin, requireFlpGroupAdmin,
  userHasCidTryout, userIsCidLead, requireCidTryout, requireCidLead,
};
