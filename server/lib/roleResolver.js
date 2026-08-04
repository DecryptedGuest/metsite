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
//   High Command (Deputy Director rank 35 and up — incl. Director, MET
//     ADMINISTRATION/HICOM/OVERSEER, GAME OWNER, HOLDER)        → HICOMM
//   Supervisor (rank 20) / Assistant Director (rank 30)         → SUPERVISOR
//   Investigator tiers (Probationary/Junior/Investigator/Senior, rank 1–19)
//                                                               → IA
//   Guest / Member / anything else                             → null (no access)
// NOTE: Senior Investigator (rank 15) is a normal INVESTIGATOR (IA tier) — it is
// NOT a Supervisor. Only the actual "Supervisor" rank (20) and Assistant Director
// (30) get the SUPERVISOR access tier; Deputy Director (35) and up are HICOMM.
function roleFromIaGroupRank(name, rank) {
  const n = (name || '').toString().toLowerCase().trim();
  const r = Number(rank);

  // The rank NAME is authoritative — group rank NUMBERS vary between group setups
  // and an investigator (incl. Senior Investigator) must never be classified off a
  // number that happens to collide with a middle-command tier. Numbers are only a
  // fallback when the name doesn't classify.
  if (n) {
    // Explicit non-staff base ranks.
    if (n === 'guest' || n === 'member') return null;
    // High Command — Deputy Director and above (named).
    if (/deputy\s*director|administration|hicom|overseer|owner|holder/.test(n)) return 'HICOMM';
    // Middle command — Supervisor and Assistant Director ONLY (NOT Senior
    // Investigator, which is a normal investigator). Checked before the generic
    // "director" → HICOMM rule so "Assistant Director" stays SUPERVISOR.
    if (/\bsupervisor\b|assistant\s*director/.test(n)) return 'SUPERVISOR';
    // Any other "director" (Director rank 40) → High Command.
    if (/\bdirector\b/.test(n)) return 'HICOMM';
    // Investigator tiers (Probationary / Junior / Investigator / Senior
    // Investigator) — standard IA access. This wins over any numeric guess below.
    if (/investigator|probationary/.test(n)) return 'IA';
  }

  // Numeric fallback — only reached when the name gave us nothing usable.
  if (!Number.isFinite(r)) return null;
  if (r >= 35) return 'HICOMM';    // Deputy Director and above
  if (r >= 20) return 'SUPERVISOR'; // Supervisor (20), Assistant Director (30)
  if (r >= 1)  return 'IA';         // Senior Investigator (15) and below
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
  let iaRank = null, iaRankName = null; // snapshotted for the SI+ gate
  try {
    const { getRobloxIdFromDiscord, getUserGroupRole } = require('./roblox');
    const iaGroupId = process.env.IA_GROUP_ID || '407296071';
    const rId = await getRobloxIdFromDiscord(discordId);
    if (rId) {
      const groupRole = await getUserGroupRole(rId, iaGroupId);
      if (groupRole) {
        // We have their actual rank — a definitive signal either way.
        groupConclusive = true;
        iaRank     = groupRole.rank != null ? Number(groupRole.rank) : null;
        iaRankName = groupRole.name || null;
        const r = roleFromIaGroupRank(groupRole.name, groupRole.rank);
        if (r) return { role: r, conclusive: true, iaRank, iaRankName };
      }
      // groupRole null is ambiguous (not-in-group OR API error) → inconclusive
    }
    // rId null → not RoVer-linked → can't check the group → inconclusive
  } catch (e) { /* RoVer/group error → inconclusive, fall through */ }

  // 4) Discord role fallback (reliable when memberRoles came from the bot)
  const discRole = roleFromDiscordRoles(memberRoles);
  if (discRole) return { role: discRole, conclusive: true, iaRank, iaRankName };

  // No role found anywhere. Only treat that as a real "no access" when the
  // group rank was conclusively read; otherwise we just couldn't determine it.
  return { role: null, conclusive: groupConclusive, iaRank, iaRankName };
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

// Build the "MET High Command" division set — LEAD in every division plus MET,
// shown as the given MET rank. Their effective site role is upgraded to HICOMM
// (see effectiveSiteRole) so IA audit/quota tools treat them as divisional HICOMM.
function buildMetHicommLead(name, rank) {
  const lead = ALL_DIVISIONS.map(division => ({ division, tier: 'LEAD', rankName: 'MET HICOMM', rank, metRankName: name, metHicomm: true }));
  lead.push({ division: 'MET', tier: 'LEAD', rankName: 'MET HICOMM', rank, metRankName: name, metHicomm: true });
  return lead;
}

// A developer-set MET rank override that meets the HICOMM threshold → the MET
// High Command division set; otherwise null (fall through to normal resolution).
async function metHicommLeadFromOverride(metRankOverride) {
  if (!metRankOverride || !Number.isFinite(Number(metRankOverride.rank))) return null;
  try {
    const { hicommMinRank } = require('./metRank');
    const min = await hicommMinRank();
    if (min != null && Number(metRankOverride.rank) >= min) {
      return buildMetHicommLead(metRankOverride.name || 'MET HICOMM', Number(metRankOverride.rank));
    }
  } catch (e) { /* threshold discovery failed → no override this pass */ }
  return null;
}

// ── Developer-set panel grants (site-only, ADDITIVE) ─────────────────
// A grant token list gives a user extra panel access on top of their group
// ranks. Tokens: "<DIV>" (member) | "<DIV>:LEAD" (division HICOMM) | "IA" |
// "IA:SUPERVISOR" | "IA:LEAD" | "MET" (MET High Command umbrella).
const GRANT_ROLE_RANK = { NONE: 0, IA: 1, SUPERVISOR: 2, HICOMM: 3, DEVELOPER: 4 };
function maxRole(a, b) { return (GRANT_ROLE_RANK[b] || 0) > (GRANT_ROLE_RANK[a] || 0) ? b : a; }
function normalizeGrants(panelGrant) {
  if (!Array.isArray(panelGrant)) return [];
  return [...new Set(panelGrant.map(g => String(g || '').toUpperCase().trim()).filter(Boolean))];
}
// Merge additive grants into an already-resolved divisions list. Returns the
// merged list; granted entries carry `granted:true` and (for IA) a `grantRole`
// that effectiveSiteRole reads to elevate the site role. A MET grant returns the
// full MET-HICOMM lead set (it dominates).
function applyPanelGrants(divisions, panelGrant) {
  const grants = normalizeGrants(panelGrant);
  if (!grants.length) return Array.isArray(divisions) ? divisions : [];
  if (grants.some(g => g === 'MET' || g === 'MET:LEAD' || g === 'MET_HICOMM')) {
    return buildMetHicommLead('MET High Command', null);
  }
  const list = Array.isArray(divisions) ? divisions.slice() : [];
  const upsert = (division, lead, extra) => {
    let e = list.find(d => d.division === division);
    if (!e) { e = { division, tier: lead ? 'LEAD' : 'MEMBER', rankName: 'Access granted', rank: null, granted: true }; list.push(e); }
    if (lead) e.tier = 'LEAD';
    if (extra) Object.assign(e, extra);
    return e;
  };
  for (const g of grants) {
    const [div, tierTok] = g.split(':');
    if (!ALL_DIVISIONS.includes(div)) continue;
    const lead = tierTok === 'LEAD' || tierTok === 'HICOMM';
    if (div === 'IA') {
      if (tierTok === 'SUPERVISOR') upsert('IA', true, { rankName: 'Supervisor', granted: true, grantRole: 'SUPERVISOR' });
      else if (lead)                upsert('IA', true, { rankName: 'IA High Command', granted: true, grantRole: 'HICOMM' });
      else                          upsert('IA', false, { rankName: 'Internal Affairs', granted: true, grantRole: 'IA' });
    } else {
      upsert(div, lead);
    }
  }
  return list;
}

// Resolve every division the user can access, with their tier + Roblox rank.
// Returns [{ division, tier, rankName, rank }] where tier is 'LEAD' | 'MEMBER'.
//   - IA: from the site role (no Roblox group query — unchanged behaviour).
//   - CID/SCO19/FLP/HPC: from each division's Roblox group rank.
// A developer (by id or DEVELOPER site role) gets LEAD in every division.
// Developer-set `panelGrant` tokens are merged in additively at the end.
async function resolveDivisionsForUser({ discordId, siteRole = null, robloxId = null, metRankOverride = null, panelGrant = null, diag = null }) {
  const { resolveGroupDivisions } = require('./divisions');
  // `diag.degraded` means: something this needed could not be READ, so an absent
  // division here is not evidence that the member has left it. Anything that
  // persists the result must check it — see accessControl.stampDivisions.
  const d = diag || {};
  d.degraded = false; d.robloxResolved = false;

  const isDeveloper = discordId === getDeveloperDiscordId() || siteRole === 'DEVELOPER';
  if (isDeveloper) {
    return ALL_DIVISIONS.map(division => ({ division, tier: 'LEAD', rankName: 'Developer', rank: null }));
  }

  // Developer-set MET-rank override (site-only). When it meets the MET HICOMM
  // threshold it grants LEAD access to every division site-wide — shown as their
  // overridden MET rank — WITHOUT any Roblox lookup. Checked first so it wins.
  const metOverrideLead = await metHicommLeadFromOverride(metRankOverride);
  if (metOverrideLead) return applyPanelGrants(metOverrideLead, panelGrant);

  const divisions = [];

  // IA — from the site role, keeping IA fully decoupled from the group logic.
  // rankName here is only a PLACEHOLDER — it's replaced below with the member's
  // actual IA group rank name (e.g. "Senior Investigator") when Roblox is
  // reachable. Use a friendly label, never the raw site-role word, so a flaky
  // enrichment never mislabels e.g. a Senior Investigator as "SUPERVISOR".
  const iaTier = iaTierFromSiteRole(siteRole);
  const IA_ROLE_LABEL = { IA: 'Internal Affairs', SUPERVISOR: 'Supervisor', HICOMM: 'IA High Command', DEVELOPER: 'Developer' };
  if (iaTier) divisions.push({ division: 'IA', tier: iaTier, rankName: IA_ROLE_LABEL[siteRole] || 'Internal Affairs', rank: null });

  // CID / SCO19 / FLP / HPC — Roblox group rank only. Resolve the user's Roblox
  // id from the stored/RoVer link if the caller didn't supply one.
  let rId = robloxId;
  if (!rId) {
    try {
      const { getRobloxIdFromDiscord } = require('./roblox');
      rId = await getRobloxIdFromDiscord(discordId);
    } catch (e) { rId = null; }
  }
  // No Roblox id is not proof of no divisions — it is far more often RoVer being
  // unreachable or rate-limited. Every group division hangs off this one value.
  if (!rId) d.degraded = true;
  d.robloxResolved = !!rId;
  if (rId) {
    try {
      const gd = {};
      const groupDivs = await resolveGroupDivisions(rId, gd);
      divisions.push(...groupDivs);
      // Any group we could not ask about leaves this pass unable to say whether
      // they are in it.
      if (gd.failed > 0) d.degraded = true;
    } catch (e) { d.degraded = true; }

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
      if (hc) return applyPanelGrants(buildMetHicommLead(hc.name, hc.rank), panelGrant);
    } catch (e) {
      // Their MET rank decides whether they are High Command across every
      // division, so failing to read it is the most consequential gap of all.
      d.degraded = true;
    }
  }

  return applyPanelGrants(divisions, panelGrant);
}

function hasDivisionAccess(divisions, division) {
  return Array.isArray(divisions) && divisions.some(d => d.division === division);
}

// The user's tier ('LEAD' | 'MEMBER') in a division, or null if no access.
function divisionTier(divisions, division) {
  const entry = Array.isArray(divisions) && divisions.find(d => d.division === division);
  return entry ? entry.tier : null;
}

// A user's EFFECTIVE site role. MET High Command is high command dashboard-wide, so
// their effective role is at least HICOMM — this makes the IA-side tools (audit,
// quota, support-desk HICOMM actions), which are gated on the site role, treat a
// MET HICOMM the same as a divisional IA HICOMM. DEVELOPER always stays DEVELOPER.
function effectiveSiteRole(baseRole, divisions) {
  if (baseRole === 'DEVELOPER') return 'DEVELOPER';
  let role = baseRole || 'NONE';
  if (Array.isArray(divisions)) {
    if (divisions.some(d => d && d.metHicomm)) role = maxRole(role, 'HICOMM');
    // Developer-granted IA access elevates the site role (IA tools gate on it).
    for (const d of divisions) if (d && d.grantRole) role = maxRole(role, d.grantRole);
  }
  return role;
}

module.exports = {
  resolveSiteRole, resolveSiteRoleDetailed, roleFromIaGroupRank, roleFromDiscordRoles,
  resolveDivisionsForUser, hasDivisionAccess, divisionTier, effectiveSiteRole, ALL_DIVISIONS,
  applyPanelGrants, normalizeGrants,
};
