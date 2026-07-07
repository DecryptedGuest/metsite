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
//
// Membership + rank in the four new divisions (CID/SCO19/FLP/HPC) comes
// ONLY from each division's Roblox GROUP rank (see lib/divisions.js) — no
// Discord-role fallback. IA is deliberately resolved from its existing site
// role instead, so IA's own pipeline (resolveSiteRole* above) is untouched.
// ─────────────────────────────────────────────────────────────────

const ALL_DIVISIONS = ['CID', 'SCO19', 'IA', 'FLP', 'HPC'];

// Map an IA site role to an IA-division tier. HICOMM/SUPERVISOR/DEVELOPER can
// approve → LEAD; a plain IA member → MEMBER. Mirrors the IA route guards.
function iaTierFromSiteRole(siteRole) {
  if (!siteRole) return null;
  if (['HICOMM', 'SUPERVISOR', 'DEVELOPER'].includes(siteRole)) return 'LEAD';
  if (siteRole === 'IA') return 'MEMBER';
  return null;
}

// Resolve every division the user can access, with their tier + Roblox rank.
// Returns [{ division, tier, rankName, rank }] where tier is 'LEAD' | 'MEMBER'.
//   - IA: from the site role (no Roblox group query — unchanged behaviour).
//   - CID/SCO19/FLP/HPC: from each division's Roblox group rank.
// A developer (by id or DEVELOPER site role) gets LEAD in every division.
async function resolveDivisionsForUser({ discordId, siteRole = null, robloxId = null }) {
  const { resolveGroupDivisions } = require('./divisions');

  const isDeveloper = discordId === getDeveloperDiscordId() || siteRole === 'DEVELOPER';
  if (isDeveloper) {
    return ALL_DIVISIONS.map(division => ({ division, tier: 'LEAD', rankName: 'Developer', rank: null }));
  }

  const divisions = [];

  // IA — from the site role, keeping IA fully decoupled from the group logic.
  const iaTier = iaTierFromSiteRole(siteRole);
  if (iaTier) divisions.push({ division: 'IA', tier: iaTier, rankName: siteRole, rank: null });

  // CID / SCO19 / FLP / HPC — Roblox group rank only. Resolve the user's Roblox
  // id from the stored/RoVer link if the caller didn't supply one.
  let rId = robloxId;
  if (!rId) {
    try {
      const { getRobloxIdFromDiscord } = require('./roblox');
      rId = await getRobloxIdFromDiscord(discordId);
    } catch (e) { rId = null; }
  }
  if (rId) {
    try {
      const groupDivs = await resolveGroupDivisions(rId);
      divisions.push(...groupDivs);
    } catch (e) { /* Roblox unreachable → no group divisions this pass */ }

    // MET High Command (Deputy Commissioner+ in the MET group, not a developer):
    // LEAD access to EVERY division, ranked by their MET rank — which outranks
    // divisional HICOMM. The dev panel stays developer-only (handled elsewhere).
    try {
      const { metHicommRoleByRoblox } = require('./metRank');
      const hc = await metHicommRoleByRoblox(rId);
      if (hc) {
        const lead = ALL_DIVISIONS.map(division => ({ division, tier: 'LEAD', rankName: hc.name, rank: hc.rank, metHicomm: true }));
        lead.push({ division: 'MET', tier: 'LEAD', rankName: hc.name, rank: hc.rank, metHicomm: true });
        return lead;
      }
    } catch (e) { /* MET lookup failed → normal divisions only this pass */ }
  }

  return divisions;
}

function hasDivisionAccess(divisions, division) {
  return Array.isArray(divisions) && divisions.some(d => d.division === division);
}

// The user's tier ('LEAD' | 'MEMBER') in a division, or null if no access.
function divisionTier(divisions, division) {
  const entry = Array.isArray(divisions) && divisions.find(d => d.division === division);
  return entry ? entry.tier : null;
}

module.exports = {
  resolveSiteRole, resolveSiteRoleDetailed, roleFromIaGroupRank, roleFromDiscordRoles,
  resolveDivisionsForUser, hasDivisionAccess, divisionTier, ALL_DIVISIONS,
};
