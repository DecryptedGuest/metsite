// server/middleware/division.js
// Per-division access gate, layered on top of requireAuth. Reads the cached
// req.user.divisions (kept fresh by lib/accessControl.js) so it never needs a
// live Discord call on the request path. Developers always pass every check.
const { hasDivisionAccess, divisionRank } = require('../lib/roleResolver');

const DIVISION_SLUG = { CID: 'cid', SCO19: 'sco19', IA: 'ia', FLP: 'flp', HPC: 'hpc' };

function userDivisions(user) {
  if (Array.isArray(user.divisions)) return user.divisions;
  // Prisma returns Json columns already parsed; this guards against a raw
  // string ending up here (e.g. from a manual DB edit).
  if (typeof user.divisions === 'string') {
    try { return JSON.parse(user.divisions) || []; } catch (e) { return []; }
  }
  return [];
}

// requireDivision('CID') — 403/redirect-to-denied unless the user has any
// rank (MEMBER or LEAD) in that division. DEVELOPER always passes.
function requireDivision(division) {
  return function (req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (req.user.role === 'DEVELOPER') return next();
    if (hasDivisionAccess(userDivisions(req.user), division)) return next();

    const isApi = req.originalUrl.startsWith('/api');
    if (isApi) return res.status(403).json({ error: `${division} access required` });
    return res.redirect(`/${DIVISION_SLUG[division]}/denied`);
  };
}

// requireDivisionLead('SCO19') — division access AND rank === 'LEAD'.
function requireDivisionLead(division) {
  return function (req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (req.user.role === 'DEVELOPER') return next();
    if (divisionRank(userDivisions(req.user), division) === 'LEAD') return next();

    const isApi = req.originalUrl.startsWith('/api');
    if (isApi) return res.status(403).json({ error: `${division} lead access required` });
    return res.redirect(`/${DIVISION_SLUG[division]}/denied`);
  };
}

module.exports = { requireDivision, requireDivisionLead, userDivisions, DIVISION_SLUG };
