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

// MET High Command — portal-wide oversight tier (Deputy Commissioner+ in the MET
// group). Sync check off cached data: the METHICOMM Discord role captured at
// login, or the 'MET' entry stamped into the divisions cache from the MET group
// rank (see roleResolver). MET HICOMM gets LEAD access to EVERY division (not the
// dev panel). DEVELOPER is separate and always passes its own checks.
function userIsMetHicommCached(user) {
  if (!user) return false;
  const rid = process.env.METHICOMM_ROLE_ID;
  if (rid && Array.isArray(user.metRoleIds) && user.metRoleIds.map(String).includes(String(rid))) return true;
  return userDivisions(user).some(d => d.division === 'MET');
}

// Does the user have access to `division`? DEVELOPER + MET HICOMM → every
// division; IA → site role; HPC → Junior Instructor and above; others → cache.
function userHasDivision(user, division) {
  if (user.role === 'DEVELOPER' || userIsMetHicommCached(user)) return true;
  if (division === 'IA')  return IA_MEMBER_ROLES.includes(user.role);
  if (division === 'HPC') return userHpcTier(user, 'instructor');
  return hasDivisionAccess(userDivisions(user), division);
}

// Is the user LEAD-tier in `division`? DEVELOPER + MET HICOMM → LEAD everywhere;
// IA → HICOMM/SUPERVISOR/DEV; others → cache.
function userIsDivisionLead(user, division) {
  if (user.role === 'DEVELOPER' || userIsMetHicommCached(user)) return true;
  if (division === 'IA') return IA_LEAD_ROLES.includes(user.role);
  return divisionTier(userDivisions(user), division) === 'LEAD';
}

// Rank-locked gate freshness: re-derive the user's role/divisions LIVE when
// their cache is stale, then block if that just revoked their access. Ensures a
// member removed from a division (or demoted) is denied on THIS request rather
// than keeping access until a background refresh. Returns true if the request
// was denied (a response has been sent). Fail-open on bot/API errors.
async function gateRevokedAfterRefresh(req, res) {
  try { req.user = await require('../lib/accessControl').ensureFreshUser(req.user); }
  catch (e) { return false; }
  if (req.user && (req.user.isBlacklisted || req.user.mustReauth)) {
    if (req.originalUrl.startsWith('/api')) res.status(401).json({ error: 'Your access has changed. Please sign in again.' });
    else res.redirect('/login?error=access_revoked');
    return true;
  }
  return false;
}

// requireDivision('CID') — 403/redirect-to-denied unless the user has any
// tier (MEMBER or LEAD) in that division. DEVELOPER always passes.
function requireDivision(division) {
  return async function (req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (req.user.role !== 'DEVELOPER' && await gateRevokedAfterRefresh(req, res)) return;
    if (req.user.role === 'DEVELOPER' || userIsMetHicommCached(req.user)) return next();
    if (userHasDivision(req.user, division)) return next();

    const isApi = req.originalUrl.startsWith('/api');
    if (isApi) return res.status(403).json({ error: `${division} access required` });
    return res.redirect(`/${DIVISION_SLUG[division]}/denied`);
  };
}

// requireDivisionLead('SCO19') — division access AND tier === 'LEAD'.
function requireDivisionLead(division) {
  return async function (req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (req.user.role !== 'DEVELOPER' && await gateRevokedAfterRefresh(req, res)) return;
    if (req.user.role === 'DEVELOPER' || userIsMetHicommCached(req.user)) return next();
    if (userIsDivisionLead(req.user, division)) return next();

    const isApi = req.originalUrl.startsWith('/api');
    if (isApi) return res.status(403).json({ error: `${division} lead access required` });
    return res.redirect(`/${DIVISION_SLUG[division]}/denied`);
  };
}

// ── HPC-specific tiers (Junior Instructor / Database Manager / Assistant Dir) ──
function hpcEntry(user) { return userDivisions(user).find(d => d.division === 'HPC'); }

// A cadet who holds the HPC final-exam Discord role must sit the exam. Fast,
// synchronous check against the roles snapshotted at login.
function userNeedsFinalExam(user) {
  const ids = Array.isArray(user.metRoleIds) ? user.metRoleIds : [];
  return ids.includes(hpcExamRoleId());
}

// Authoritative check: does the user CURRENTLY hold the final-exam role in the
// MET server? Uses the login snapshot as a fast path, then a live bot lookup —
// so it's correct even when the role lives in a guild other than the portal's
// primary DISCORD_GUILD_ID, or when the snapshot is stale (role added/removed
// after login). MET_GUILD_ID overrides which server the role is read from.
async function userHasFinalExamRole(user) {
  if (!user) return false;
  const roleId = hpcExamRoleId();
  if (!roleId) return false;
  if (userNeedsFinalExam(user)) return true; // fast path (login snapshot)
  try {
    const { getRoleHolders } = require('../lib/bot');
    const guildId = process.env.MET_GUILD_ID || process.env.DISCORD_GUILD_ID;
    if (!guildId || !user.discordId) return false;
    const holders = await getRoleHolders(guildId, roleId);
    const did = String(user.discordId).replace(/\D/g, '');
    return !!(holders && holders.has(did));
  } catch (e) { return false; }
}

// kind: 'instructor' | 'marker' | 'quota'. DEVELOPER always passes.
function userHpcTier(user, kind) {
  if (user.role === 'DEVELOPER' || userIsMetHicommCached(user)) return true;
  const e = hpcEntry(user);
  if (!e) return false;
  return hpcRankAtLeast(e.rankName, e.rank, kind);
}

// Final-exam marking + HPC tryout-log review are gated on the HPC group rank:
// rank HPC_REVIEW_MIN_RANK (default 247) and above, or DEVELOPER.
function hpcReviewMinRank() { const n = parseInt(process.env.HPC_REVIEW_MIN_RANK, 10); return Number.isFinite(n) ? n : 247; }
function userHpcReviewer(user) {
  if (!user) return false;
  if (user.role === 'DEVELOPER' || userIsMetHicommCached(user)) return true;
  const e = userDivisions(user).find(d => d.division === 'HPC');
  return !!(e && Number(e.rank) >= hpcReviewMinRank());
}

async function requireHpcMarker(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (req.user.role !== 'DEVELOPER' && await gateRevokedAfterRefresh(req, res)) return;
  if (userHpcReviewer(req.user)) return next();
  return res.status(403).json({ error: `HPC group rank ${hpcReviewMinRank()}+ required to mark final exams.` });
}

async function requireHpcQuota(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (req.user.role !== 'DEVELOPER' && await gateRevokedAfterRefresh(req, res)) return;
  if (userHpcTier(req.user, 'quota')) return next();
  return res.status(403).json({ error: 'HPC quota access required (Assistant Director and above).' });
}

// ── FLP group panel — Assistant Director and above (FLP group rank ≥ 170) ──
// Lets FLP high command manage the FLP Roblox group from their dashboard.
// Override the threshold with FLP_GROUP_ADMIN_MIN_RANK. DEVELOPER always passes.
function userFlpGroupAdmin(user) {
  if (user.role === 'DEVELOPER' || userIsMetHicommCached(user)) return true;
  const min = parseInt(process.env.FLP_GROUP_ADMIN_MIN_RANK, 10);
  const threshold = Number.isFinite(min) ? min : 170; // Assistant Director
  const e = userDivisions(user).find(d => d.division === 'FLP');
  return !!(e && Number(e.rank) >= threshold);
}

async function requireFlpGroupAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (req.user.role !== 'DEVELOPER' && await gateRevokedAfterRefresh(req, res)) return;
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
  if (user.role === 'DEVELOPER' || userIsMetHicommCached(user)) return true;
  return userHoldsAnyRole(user, cidGuildId(), cidAccessRoleIds());
}
async function userIsCidLead(user) {
  if (!user) return false;
  if (user.role === 'DEVELOPER' || userIsMetHicommCached(user)) return true;
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

// ── MET HICOMM — portal-wide oversight tier (Deputy Commissioner+ in the MET
// umbrella group, or DEVELOPER). Resolved from the MET group rank (cached), so
// it's async like the CID gate. ──
function requireMetHicomm(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  const { userIsMetHicomm } = require('../lib/metRank');
  userIsMetHicomm(req.user).then(ok => {
    if (ok) return next();
    try { require('../lib/audit').denied(req, 'ACCESS_DENIED_HICOMM', `Non-HICOMM (${req.user.role}) tried to reach a MET HICOMM endpoint: ${req.method} ${req.originalUrl}`); } catch (e) {}
    if (req.originalUrl.startsWith('/api')) return res.status(403).json({ error: 'MET HICOMM access required' });
    return res.redirect('/hicomm/denied');
  }).catch(() => res.status(403).json({ error: 'MET HICOMM access required' }));
}

module.exports = {
  requireDivision, requireDivisionLead,
  userDivisions, userHasDivision, userIsDivisionLead, DIVISION_SLUG,
  userNeedsFinalExam, userHasFinalExamRole, userHpcTier, userHpcReviewer, userIsMetHicommCached, requireHpcMarker, requireHpcQuota,
  userFlpGroupAdmin, requireFlpGroupAdmin,
  userHasCidTryout, userIsCidLead, requireCidTryout, requireCidLead,
  requireMetHicomm,
};
