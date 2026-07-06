// server/lib/metRank.js
// MET HICOMM access gate. The MET HICOMM "division" is the oversight tier for
// the whole portal — gated to Deputy Commissioner and above in the MET umbrella
// group (or DEVELOPER). Resolved from the user's Roblox rank in the MET group
// (getUserGroupRole is itself cached ~30 min), with two overrides:
//   • METHICOMM_MIN_RANK — a numeric MET-group rank threshold, or
//   • METHICOMM_ROLE_ID  — a MET Discord role that also grants access.
const { getUserGroupRole } = require('./roblox');
const { metGroupId } = require('./divisions');

// Named top ranks of the MET umbrella group that count as High Command.
const HICOMM_PATTERN = /deputy commissioner|\bcommissioner\b|chief of|commander[- ]in[- ]chief|assistant commissioner/i;

function isHicommRank(role) {
  if (!role) return false;
  const envMin = parseInt(process.env.METHICOMM_MIN_RANK, 10);
  if (Number.isFinite(envMin)) return Number(role.rank) >= envMin;
  return HICOMM_PATTERN.test(String(role.name || ''));
}

// The user's MET-group role ({ id, name, rank }) or null.
async function metRole(robloxId) {
  if (!robloxId) return null;
  try { return await getUserGroupRole(String(robloxId), metGroupId()); }
  catch (e) { return null; }
}

// Is this user MET High Command? DEVELOPER always; else the Discord-role
// shortcut, else the MET-group rank threshold.
async function userIsMetHicomm(user) {
  if (!user) return false;
  if (user.role === 'DEVELOPER') return true;
  const rid = process.env.METHICOMM_ROLE_ID;
  if (rid && Array.isArray(user.metRoleIds) && user.metRoleIds.includes(rid)) return true;
  return isHicommRank(await metRole(user.robloxId));
}

module.exports = { metRole, isHicommRank, userIsMetHicomm };
