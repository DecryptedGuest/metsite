// server/lib/iaRank.js
// Who is "SI+" (Senior Investigator and above)?
//
// The site role (IA / SUPERVISOR / HICOMM / DEVELOPER) deliberately collapses
// every investigator tier into a single "IA" role, so it can't tell a Senior
// Investigator apart from a Probationary one. Case appeals need exactly that
// distinction, so login + the access revalidator now snapshot the user's
// Internal Affairs Roblox group rank onto `User.iaRank` / `User.iaRankName`,
// and everything here reads from that snapshot.
//
// Env:
//   IA_SI_MIN_RANK  — the IA group rank number at/above which a member counts
//                     as Senior Investigator (default 15; see roleResolver's
//                     rank map: investigator tiers are 1–15, Supervisor 20,
//                     High Command 30+).

const SI_MIN_RANK = () => {
  const n = parseInt(process.env.IA_SI_MIN_RANK || '15', 10);
  return Number.isFinite(n) ? n : 15;
};

// Site roles that are unambiguously above Senior Investigator.
const ABOVE_SI_ROLES = ['SUPERVISOR', 'HICOMM', 'DEVELOPER'];

// Punishments only High Command may appeal (mirrors the approve/deny gate).
const HICOMM_ONLY_ACTIONS = ['Blacklist', 'Termination'];

// Site roles that count as High Command for appeal purposes.
const HICOMM_ROLES = ['HICOMM', 'DEVELOPER'];

// Every punishment name attached to a case: the enriched JSON, the legacy
// comma-joined `action` string, AND the CasePunishment rows written when the
// case was approved.
//
// The CasePunishment rows matter for the High-Command-only gate: `action` and
// `actions` are rewritable through the edit endpoint, so if the gate read only
// those, someone could edit a Termination off a case and then appeal it as if
// it had never carried one. The punishments actually applied at approval time
// cannot be laundered that way.
function caseActionNames(c) {
  const names = [];
  if (c && Array.isArray(c.actions)) c.actions.forEach(a => { if (a && a.action) names.push(String(a.action)); });
  if (c && c.action) String(c.action).split(',').forEach(s => { const t = s.trim(); if (t) names.push(t); });
  if (c && Array.isArray(c.casePunishments)) c.casePunishments.forEach(p => { if (p && p.action) names.push(String(p.action)); });
  return names;
}

function caseHasHicommOnlyPunishment(c) {
  return caseActionNames(c).some(n => HICOMM_ONLY_ACTIONS.includes(n));
}

// Does this rank NAME read as Senior Investigator or above? Used alongside the
// numeric check so a renamed/renumbered ladder still resolves sensibly.
function rankNameIsSiPlus(name) {
  const n = (name || '').toString().toLowerCase().trim();
  if (!n) return false;
  if (/probationary|junior|trial|cadet|trainee/.test(n)) return false;
  return /senior\s*investigator|supervisor|director|administration|hicom|overseer|owner|holder/.test(n);
}

// The user's IA rank as { rank, rankName } — falling back to whatever the
// cached divisions blob carries if the snapshot columns aren't populated yet
// (e.g. a user who hasn't signed in since this shipped).
function iaRankOf(user) {
  if (!user) return { rank: null, rankName: null };
  if (user.iaRank != null || user.iaRankName) {
    return { rank: user.iaRank != null ? Number(user.iaRank) : null, rankName: user.iaRankName || null };
  }
  const divs = Array.isArray(user.divisions) ? user.divisions : [];
  const ia = divs.find(d => d && d.division === 'IA');
  return { rank: ia && ia.rank != null ? Number(ia.rank) : null, rankName: (ia && ia.rankName) || null };
}

/**
 * Senior Investigator and above.
 * True when any of these hold:
 *   - the site role is Supervisor / High Command / Developer (all above SI), or
 *   - the snapshotted IA group rank number is >= IA_SI_MIN_RANK, or
 *   - the snapshotted IA group rank name reads as SI+.
 */
function isSeniorInvestigatorPlus(user) {
  if (!user) return false;
  if (ABOVE_SI_ROLES.includes(user.role)) return true;
  const { rank, rankName } = iaRankOf(user);
  if (rank != null && Number.isFinite(rank) && rank >= SI_MIN_RANK()) return true;
  return rankNameIsSiPlus(rankName);
}

function isHicomm(user) {
  return !!user && HICOMM_ROLES.includes(user.role);
}

/**
 * May `user` file an appeal against `caseRow`?
 * Returns { allowed, reason } — `reason` is a user-facing message when denied.
 *
 * Rules (from the IA spec):
 *   - Only Senior Investigator and above may appeal at all.
 *   - Only High Command may appeal a Termination or a Blacklist.
 *   - Only an APPROVED case can be appealed (there is nothing to lift on a
 *     pending or denied one), and never twice.
 */
function canAppealCase(user, caseRow) {
  if (!user)     return { allowed: false, reason: 'Not authenticated.' };
  if (!caseRow)  return { allowed: false, reason: 'Case not found.' };

  if (caseRow.status === 'OVERTURNED' || caseRow.appealedAt)
    return { allowed: false, reason: 'This case has already been appealed.' };
  if (caseRow.status !== 'APPROVED')
    return { allowed: false, reason: 'Only an approved case can be appealed.' };

  if (!isSeniorInvestigatorPlus(user))
    return { allowed: false, reason: 'Appeals can only be filed by Senior Investigator and above.' };

  if (caseHasHicommOnlyPunishment(caseRow) && !isHicomm(user))
    return { allowed: false, reason: 'Only High Command can appeal a Termination or Blacklist.' };

  return { allowed: true, reason: null };
}

// A short label for the user's IA standing, shown on the appeal UI.
function iaRankLabel(user) {
  const { rankName } = iaRankOf(user);
  if (rankName) return rankName;
  const labels = { DEVELOPER: 'Developer', HICOMM: 'High Command', SUPERVISOR: 'Supervisor', IA: 'Internal Affairs' };
  return (user && labels[user.role]) || 'Internal Affairs';
}

module.exports = {
  SI_MIN_RANK,
  HICOMM_ONLY_ACTIONS,
  caseActionNames,
  caseHasHicommOnlyPunishment,
  isSeniorInvestigatorPlus,
  isHicomm,
  canAppealCase,
  iaRankOf,
  iaRankLabel,
  rankNameIsSiPlus,
};
