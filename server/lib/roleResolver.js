// server/lib/roleResolver.js
// Single source of truth for deriving a user's site role. Used by the login
// callback and by the background access-revalidation job so they never drift.
const prisma = require('./db');

function getRoleIA()             { return process.env.ROLE_IA          || '1398071208343244870'; }
function getRoleHICOMM()         { return process.env.ROLE_HICOMM      || '1399746451453644860'; }
function getRoleSUPERVISOR()     { return process.env.ROLE_SUPERVISOR  || '1424505342129082571'; }
function getDeveloperDiscordId() { return process.env.DEVELOPER_DISCORD_ID || '1227866745201627137'; }
// Discord role(s) that grant DEVELOPER access (in addition to the developer
// user override above). Supports a primary + secondary role id via env.
function getDeveloperRoleIds() {
  return [
    process.env.DEVELOPER_ROLE_ID,
    process.env.DEVELOPER_ROLE_ID2 || '1521189335230316675',
  ].filter(Boolean);
}

// Map an Internal Affairs Roblox group (407296071) role to a site role, using
// both the role name and its numeric rank for reliability:
//   High Command (Assistant Director rank 30 and up — incl. Director, MET
//     ADMINISTRATION/HICOM/OVERSEER, GAME OWNER, HOLDER)        → HICOMM
//   Supervisor (rank 20)                                        → SUPERVISOR
//   Investigator tiers (Probationary/Junior/Investigator/Senior, rank 1–15)
//                                                               → IA
//   Guest / Member / anything else                             → null (no access)
function roleFromIaGroupRank(name, rank) {
  const n = (name || '').toString().toLowerCase().trim();
  const r = Number(rank);

  // Explicit non-staff base ranks
  if (n === 'guest' || n === 'member') return null;

  // High Command and above
  if (/director|administration|hicom|overseer|owner|holder/.test(n)) return 'HICOMM';
  if (Number.isFinite(r) && r >= 30) return 'HICOMM';

  // Supervisor — case/ticket approval perms only (no audit/quota)
  if (n === 'supervisor' || r === 20) return 'SUPERVISOR';

  // Investigator tiers (incl. Senior Investigator) — standard IA access
  if (/investigator/.test(n)) return 'IA';
  if (Number.isFinite(r) && r >= 1 && r <= 15) return 'IA';

  return null;
}

// Derive a site role from Discord role IDs (fallback path).
function roleFromDiscordRoles(roleIds) {
  const ids = Array.isArray(roleIds) ? roleIds : [];
  const devRoleIds = getDeveloperRoleIds();
  if (ids.some(id => devRoleIds.includes(id))) return 'DEVELOPER';
  if (ids.includes(getRoleHICOMM()))     return 'HICOMM';
  if (ids.includes(getRoleSUPERVISOR())) return 'SUPERVISOR';
  if (ids.includes(getRoleIA()))         return 'IA';
  return null;
}

// Resolve a Discord user's role, reporting whether the result is CONCLUSIVE.
// Returns { role: string|null, conclusive: boolean }.
//   role        — the derived site role (or null = no qualifying role found)
//   conclusive  — true only when we're certain. A null role is conclusive only
//                 when the IA group rank was definitively read (so we KNOW they
//                 aren't staff). If RoVer/group lookups failed or the user isn't
//                 linked, a null role is INCONCLUSIVE — callers must NOT revoke
//                 access on it (that was the cause of users being booted on a
//                 transient RoVer hiccup).
async function resolveSiteRoleDetailed({ discordId, memberRoles = [] }) {
  // 1) Developer override — by user id, or by holding a developer Discord role.
  if (discordId === getDeveloperDiscordId()) return { role: 'DEVELOPER', conclusive: true };
  const devRoleIds = getDeveloperRoleIds();
  if (Array.isArray(memberRoles) && memberRoles.some(id => devRoleIds.includes(id)))
    return { role: 'DEVELOPER', conclusive: true };

  // 2) Explicit access grant
  const grant = await prisma.accessGrant.findUnique({ where: { discordId } }).catch(() => null);
  if (grant) return { role: grant.role, conclusive: true };

  // 3) IA Roblox group rank (primary)
  let groupConclusive = false; // true only when we positively read their rank
  try {
    const { getRobloxIdFromDiscord, getUserGroupRole } = require('./roblox');
    const iaGroupId = process.env.IA_GROUP_ID || '407296071';
    const rId = await getRobloxIdFromDiscord(discordId);
    if (rId) {
      const groupRole = await getUserGroupRole(rId, iaGroupId);
      if (groupRole) {
        // We have their actual rank — a definitive signal either way.
        groupConclusive = true;
        const r = roleFromIaGroupRank(groupRole.name, groupRole.rank);
        if (r) return { role: r, conclusive: true };
      }
      // groupRole null is ambiguous (not-in-group OR API error) → inconclusive
    }
    // rId null → not RoVer-linked → can't check the group → inconclusive
  } catch (e) { /* RoVer/group error → inconclusive, fall through */ }

  // 4) Discord role fallback (reliable when memberRoles came from the bot)
  const discRole = roleFromDiscordRoles(memberRoles);
  if (discRole) return { role: discRole, conclusive: true };

  // No role found anywhere. Only treat that as a real "no access" when the
  // group rank was conclusively read; otherwise we just couldn't determine it.
  return { role: null, conclusive: groupConclusive };
}

// Thin wrapper for callers that only need the role (e.g. login).
async function resolveSiteRole(opts) {
  return (await resolveSiteRoleDetailed(opts)).role;
}

// ─────────────────────────────────────────────────────────────────
// Multi-division access — additive, does not change anything above.
// Each division has a MEMBER role id and an optional LEAD role id,
// following the existing ROLE_IA / ROLE_HICOMM env var pattern.
// ─────────────────────────────────────────────────────────────────

const DIVISION_DEFAULT_ROLE_IDS = {
  CID:   { member: '1398071208343244871', lead: '1398071208343244872' },
  SCO19: { member: '1398071208343244873', lead: '1398071208343244874' },
  FLP:   { member: '1398071208343244875', lead: '1398071208343244876' },
  HPC:   { member: '1398071208343244877', lead: '1398071208343244878' },
};

// IA has its own well-established role IDs already (ROLE_IA / ROLE_HICOMM) —
// treat IA membership + HICOMM/SUPERVISOR/DEVELOPER site roles as LEAD-level
// IA division access so the division model can gate the /ia/* routes too,
// without touching how ROLE_IA/ROLE_HICOMM are read anywhere else.
function getDivisionRoleIds(division) {
  if (division === 'IA') {
    return { member: getRoleIA(), lead: getRoleHICOMM() };
  }
  const d = DIVISION_DEFAULT_ROLE_IDS[division];
  return {
    member: process.env[`ROLE_${division}`]      || (d && d.member),
    lead:   process.env[`ROLE_${division}_LEAD`] || (d && d.lead),
  };
}

const ALL_DIVISIONS = ['CID', 'SCO19', 'IA', 'FLP', 'HPC'];

// Resolve which divisions a user has access to, and their rank in each, from
// the same memberRoles array already fetched for resolveSiteRoleDetailed (no
// extra Discord/Roblox calls). Returns [{ division, rank }].
//   rank — 'LEAD' | 'MEMBER'
// A developer (by user id or DEVELOPER_ROLE_ID) gets LEAD in every division.
function resolveDivisionsForUser({ discordId, memberRoles = [] }) {
  const ids = Array.isArray(memberRoles) ? memberRoles : [];

  const isDeveloper =
    discordId === getDeveloperDiscordId() ||
    getDeveloperRoleIds().some(id => ids.includes(id));
  if (isDeveloper) {
    return ALL_DIVISIONS.map(division => ({ division, rank: 'LEAD' }));
  }

  const divisions = [];
  for (const division of ALL_DIVISIONS) {
    const { member, lead } = getDivisionRoleIds(division);
    if (lead && ids.includes(lead))        divisions.push({ division, rank: 'LEAD' });
    else if (member && ids.includes(member)) divisions.push({ division, rank: 'MEMBER' });
  }
  return divisions;
}

function hasDivisionAccess(divisions, division) {
  return Array.isArray(divisions) && divisions.some(d => d.division === division);
}

function divisionRank(divisions, division) {
  const entry = Array.isArray(divisions) && divisions.find(d => d.division === division);
  return entry ? entry.rank : null;
}

module.exports = {
  resolveSiteRole, resolveSiteRoleDetailed, roleFromIaGroupRank, roleFromDiscordRoles,
  resolveDivisionsForUser, getDivisionRoleIds, hasDivisionAccess, divisionRank, ALL_DIVISIONS,
};
