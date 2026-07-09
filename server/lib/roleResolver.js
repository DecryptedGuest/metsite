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
// Map an IA Roblox-group rank to a site role. Aligned to the real IA group:
//   Guest(0)/Member(1) → none · Probationary(1)/Junior(5)/Investigator(10) → IA
//   Senior Investigator(15)/Supervisor(20)/Assistant Director(30) → SUPERVISOR (middle)
//   Deputy Director(35)/Director(40)/administration/hicom/… → HICOMM (high command)
// HICOMM = the IA High Command tools (audit, quota) — only Deputy Director and
// above; Assistant Director is deliberately MIDDLE, not HICOMM.
function roleFromIaGroupRank(name, rank) {
  const n = (name || '').toString().toLowerCase().trim();
  const r = Number(rank);

  // The rank NAME is authoritative — group rank NUMBERS vary between group setups
  // and a Probationary/Junior Investigator must never be classified off a number
  // that happens to collide with a middle-command tier (the cause of a
  // Probationary Investigator wrongly showing as SUPERVISOR). Numbers are only a
  // fallback when the name doesn't classify.
  if (n) {
    // Explicit non-staff base ranks.
    if (n === 'guest' || n === 'member') return null;
    // High Command — Deputy Director and above (named).
    if (/deputy\s*director|administration|hicom|overseer|owner|holder/.test(n)) return 'HICOMM';
    // Middle command — Senior Investigator, Supervisor, Assistant Director.
    // (Checked BEFORE the generic "director" → HICOMM rule so "Assistant Director"
    // stays SUPERVISOR; only Deputy Director and above is HICOMM.)
    if (/senior\s*investigator|supervisor|assistant\s*director/.test(n)) return 'SUPERVISOR';
    // Any other "director" (Director rank 40) → High Command.
    if (/\bdirector\b/.test(n)) return 'HICOMM';
    // Investigator tiers (Probationary / Junior / Investigator) — standard IA
    // access. This wins over any numeric guess below.
    if (/investigator|probationary/.test(n)) return 'IA';
  }

  // Numeric fallback — only reached when the name gave us nothing usable.
  if (!Number.isFinite(r)) return null;
  if (r >= 35) return 'HICOMM';
  if (r === 15 || r === 20 || r === 30) return 'SUPERVISOR';
  if (r >= 1 && r <= 14) return 'IA';
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

    // Show the member's ACTUAL IA group rank name (e.g. "Senior Investigator")
    // instead of the coarse site role. Permissions/tier still come from the site
    // role; only the displayed rank name + number are enriched.
    if (iaTier) {
      try {
        const { getUserGroupRole } = require('./roblox');
        const iaRole = await getUserGroupRole(rId, process.env.IA_GROUP_ID || '407296071');
        if (iaRole && iaRole.name) {
          const e = divisions.find(d => d.division === 'IA');
          if (e) { e.rankName = iaRole.name; e.rank = Number(iaRole.rank) || null; }
        }
      } catch (e) { /* keep the site-role name */ }
    }

    // MET High Command (Deputy Commissioner+ in the MET group, not a developer):
    // LEAD access to EVERY division, ranked by their MET rank — which outranks
    // divisional HICOMM. The dev panel stays developer-only (handled elsewhere).
    try {
      const { metHicommRoleByRoblox } = require('./metRank');
      const hc = await metHicommRoleByRoblox(rId);
      if (hc) {
        // MET High Command → LEAD (divisional-HICOMM level) access to EVERY
        // division, shown as "MET HICOMM". Their effective site role is upgraded
        // to HICOMM (see effectiveSiteRole) so the IA audit/quota tools treat
        // them as divisional HICOMM too.
        const lead = ALL_DIVISIONS.map(division => ({ division, tier: 'LEAD', rankName: 'MET HICOMM', rank: hc.rank, metRankName: hc.name, metHicomm: true }));
        lead.push({ division: 'MET', tier: 'LEAD', rankName: 'MET HICOMM', rank: hc.rank, metRankName: hc.name, metHicomm: true });
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

// A user's EFFECTIVE site role. MET High Command is high command portal-wide, so
// their effective role is at least HICOMM — this makes the IA-side tools (audit,
// quota, support-desk HICOMM actions), which are gated on the site role, treat a
// MET HICOMM the same as a divisional IA HICOMM. DEVELOPER always stays DEVELOPER.
function effectiveSiteRole(baseRole, divisions) {
  if (baseRole === 'DEVELOPER') return 'DEVELOPER';
  if (Array.isArray(divisions) && divisions.some(d => d && d.metHicomm)) return 'HICOMM';
  return baseRole;
}

module.exports = {
  resolveSiteRole, resolveSiteRoleDetailed, roleFromIaGroupRank, roleFromDiscordRoles,
  resolveDivisionsForUser, hasDivisionAccess, divisionTier, effectiveSiteRole, ALL_DIVISIONS,
};
