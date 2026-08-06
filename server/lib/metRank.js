// server/lib/metRank.js
// MET HICOMM access gate. The MET HICOMM "division" is the oversight tier for
// the whole dashboard — gated to Deputy Commissioner and above in the MET umbrella
// group (or DEVELOPER).
//
// The threshold rank NUMBER is discovered from the group's roles via the
// groups v1 API (groups.roblox.com/v1/groups/{id}/roles → [{ id, name, rank }]):
// we look up the "Deputy Commissioner" roleset and use its `rank` as the minimum.
// A member is HICOMM when their MET-group rank number >= that. Overrides:
//   • METHICOMM_MIN_RANK  — pin the numeric threshold directly (skips discovery)
//   • METHICOMM_RANK_NAME — the role name to discover (default "Deputy Commissioner")
//   • METHICOMM_ROLE_ID   — a MET Discord role that also grants access
const { getUserGroupRole, getGroupRolesPublic } = require('./roblox');
const { metGroupId } = require('./divisions');

// Named top ranks — a last-resort fallback only if the v1 roles lookup fails
// AND no numeric threshold is configured.
const HICOMM_PATTERN = /deputy commissioner|\bcommissioner\b|chief of|commander[- ]in[- ]chief|assistant commissioner/i;

const HICOMM_RANK_NAME = () => (process.env.METHICOMM_RANK_NAME || 'Deputy Commissioner').trim().toLowerCase();

// Resolved threshold cache (the discovery result is stable — roles rarely change).
let _minCache = { at: 0, rank: null };
const MIN_TTL = 60 * 60 * 1000;

// The minimum MET-group rank NUMBER that counts as High Command. Env pin wins;
// otherwise discovered from the v1 roles list by name. Returns null if neither
// is available (→ caller falls back to name-pattern matching).
async function hicommMinRank() {
  const envMin = parseInt(process.env.METHICOMM_MIN_RANK, 10);
  if (Number.isFinite(envMin)) return envMin;
  if (_minCache.rank != null && Date.now() - _minCache.at < MIN_TTL) return _minCache.rank;
  try {
    const roles = await getGroupRolesPublic(metGroupId());
    const want  = HICOMM_RANK_NAME();
    const norm  = r => String(r.name || '').trim().toLowerCase();
    // Exact name first, then a contained match ("Deputy Commissioner" inside a
    // longer label), so minor naming variations still resolve.
    const hit = (roles || []).find(r => norm(r) === want) || (roles || []).find(r => norm(r).includes(want));
    if (hit) { _minCache = { at: Date.now(), rank: Number(hit.rank) }; return Number(hit.rank); }
  } catch (e) { /* fall through to name pattern */ }
  return null;
}

// The user's MET-group role ({ id, name, rank }) or null.
async function metRole(robloxId) {
  if (!robloxId) return null;
  try { return await getUserGroupRole(String(robloxId), metGroupId()); }
  catch (e) { return null; }
}

// Is this user MET High Command? DEVELOPER always; else the Discord-role
// shortcut, else the MET-group rank number ≥ the discovered/pinned threshold.
async function userIsMetHicomm(user) {
  if (!user) return false;
  if (user.role === 'DEVELOPER') return true;
  const rid = process.env.METHICOMM_ROLE_ID;
  if (rid && Array.isArray(user.metRoleIds) && user.metRoleIds.includes(rid)) return true;
  // Developer-set, site-only MET rank override that meets the HICOMM threshold.
  if (user.metRankOverride && Number.isFinite(Number(user.metRankOverride.rank))) {
    const min = await hicommMinRank();
    if (min != null && Number(user.metRankOverride.rank) >= min) return true;
  }
  const role = await metRole(user.robloxId);
  if (!role) return false;
  const min = await hicommMinRank();
  if (min != null) return Number(role.rank) >= min;
  return HICOMM_PATTERN.test(String(role.name || ''));
}

// The user's MET-group role IF it qualifies them as High Command, else null.
// Used to grant MET HICOMM LEAD access to every division, labelled with their
// actual MET rank (which outranks divisional HICOMM).
async function metHicommRoleByRoblox(robloxId) {
  const role = await metRole(robloxId);
  if (!role) return null;
  const min = await hicommMinRank();
  const ok = (min != null) ? Number(role.rank) >= min : HICOMM_PATTERN.test(String(role.name || ''));
  return ok ? role : null;
}

module.exports = { metRole, hicommMinRank, userIsMetHicomm, metHicommRoleByRoblox };
