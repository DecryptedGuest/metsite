// server/lib/permsGroup.js
// Single source of truth for the MET "permissions" group (Roblox group
// 381582724 by default) and the MET-server disciplinary/standing Discord roles.
//
// Two things live here:
//   1. PERMS GROUP — the roles a member holds in the perms group become the
//      "Permissions" chips on their profile (QUOTA EXEMPT, GANG PERMS, MULTI
//      DIVISION PERMS, the BUYER perms, the RANK-LOCK perms, …). Only ranks
//      2..99 are surfaced: everything at rank 100+ (MET ADMINISTRATION, MET
//      HICOMM, MET Overseer, PERMS GROUP HOLDER) and the base Guest/Member
//      ranks are their MET *rank*, not a perm, so they're filtered out. The
//      pure-divider roles ("-----", "----", …) are dropped too.
//   2. STANDING FLAGS — disciplinary Discord roles (activity strike, strikes
//      1-3, suspended, verbal warning, zero-tolerance) whose IDs come from env
//      vars. If a member holds one, it shows as a coloured flag chip.
//
// Both degrade gracefully: no group id / no Roblox link / Roblox unreachable →
// empty perms; no env role ids or no captured Discord roles → empty flags.

const fetch = require('node-fetch');
const { getUserGroupRoles, getGroupRolesPublic } = require('./roblox');

// The perms group id. Override with PERMS_GROUP_ID if it ever changes.
function permsGroupId() { return process.env.PERMS_GROUP_ID || '381582724'; }

// Open Cloud API key (group read scope). REQUIRED for multiple-roles-per-member
// (live 2026-03) — the legacy public endpoint returns only one role per group,
// so without this a member's extra perm roles won't show. Create one at
// create.roblox.com → Open Cloud → API Keys, scoped to this group's memberships.
function openCloudKey() { return process.env.PERMS_GROUP_API_KEY || process.env.ROBLOX_OPEN_CLOUD_KEY || null; }

// Ranks at/above this are MET ranks (MET ADMINISTRATION = 100, MET HICOMM = 110,
// MET Overseer = 250, PERMS GROUP HOLDER = 255) — never shown as a perm.
const PERM_RANK_MAX = 99;

// Guilded/Discord-style colour palette index → hex. The perms-group role list
// tags each role with a small colour index (0..16); this maps them to hexes
// that follow the uploaded MET colour scheme (CID orange, MI5 sky, IA teal,
// SCO grey, …). Index 0 / null = no colour (neutral chip).
const PALETTE = {
  0:  null,        // default / none
  1:  '#3b82f6',   // blue      — SUP / CSUP rank lock
  2:  '#57f287',   // green     — MET ADMINISTRATION
  3:  '#e8842a',   // orange    — CID (matches CID division)
  4:  '#eb459e',   // magenta   — MET HICOMM
  5:  '#f5c518',   // gold      — COMM rank lock
  6:  '#e0503a',   // red
  7:  '#9b6ef3',   // purple    — SAS BUYER
  8:  '#6b7280',   // grey      — SCO BUYER (matches SCO-19 division)
  9:  '#3ba55d',   // perm green — QUOTA/UNIFORM EXEMPT, GANG/MULTI-DIV PERMS, rank locked
  10: '#d98324',   // dark amber — CSO/CON/SGT/INS/CINS rank lock
  11: '#c0392b',   // dark red   — DAC…MO rank lock
  12: '#9146ff',   // violet     — MET Overseer
  13: '#ad1457',   // deep pink  — Deputy Commissioner rank lock
  14: '#38bdf8',   // sky        — MI5 BUYER (matches MI5)
  15: '#4b5563',   // dim grey   — dividers
  16: '#14b8a6',   // teal       — IA BUYER (matches IA division)
};

function paletteHex(colorIndex) {
  return Object.prototype.hasOwnProperty.call(PALETTE, colorIndex) ? PALETTE[colorIndex] : null;
}

// The perms group's full role catalog (group 381582724). Kept here so the site
// can colour + label a member's role without a second API round-trip, and so
// the rank/name filtering is deterministic. `isBase` marks the base Member role.
const PERMS_ROLES = [
  { id: '772094045',   name: 'Guest',                          rank: 0,   color: 0 },
  { id: '12884901889', name: 'Member',                         rank: 1,   color: 0, isBase: true },
  { id: '773126050',   name: 'QUOTA EXEMPT',                   rank: 1,   color: 9 },
  { id: '770559040',   name: 'UNIFORM EXEMPT',                 rank: 2,   color: 9 },
  { id: '772046031',   name: 'GANG PERMS',                     rank: 3,   color: 9 },
  { id: '773235023',   name: 'MULTI DIVISION PERMS',           rank: 4,   color: 9 },
  { id: '771127026',   name: 'RANK LOCKED',                    rank: 5,   color: 9 },
  { id: '770931053',   name: 'UNRANK LOCKED',                  rank: 6,   color: 9 },
  { id: '770269085',   name: '-----',                          rank: 7,   color: 15 },
  { id: '770651039',   name: 'SCO BUYER',                      rank: 30,  color: 8 },
  { id: '770931054',   name: 'CID BUYER',                      rank: 31,  color: 3 },
  { id: '771047069',   name: 'MI5 BUYER',                      rank: 32,  color: 14 },
  { id: '770919060',   name: 'IA BUYER',                       rank: 34,  color: 16 },
  { id: '771629070',   name: 'SAS BUYER',                      rank: 35,  color: 7 },
  { id: '773349029',   name: '----',                           rank: 36,  color: 15 },
  { id: '770967047',   name: 'CSO RANK LOCK',                  rank: 40,  color: 10 },
  { id: '773349027',   name: 'CON RANK LOCK',                  rank: 41,  color: 10 },
  { id: '771119057',   name: 'SGT RANK LOCK',                  rank: 42,  color: 10 },
  { id: '771407056',   name: 'INS RANK LOCK',                  rank: 43,  color: 10 },
  { id: '770753063',   name: 'CINS RANK LOCK',                 rank: 44,  color: 10 },
  { id: '771389027',   name: '---',                            rank: 49,  color: 15 },
  { id: '771007057',   name: 'SUP RANK LOCK',                  rank: 50,  color: 1 },
  { id: '770753064',   name: 'CSUP RANK LOCK',                 rank: 51,  color: 1 },
  { id: '771413052',   name: 'COMM RANK LOCK',                 rank: 52,  color: 5 },
  { id: '770541067',   name: 'DEPUTY COMMISSIONER RANK LOCK',  rank: 53,  color: 13 },
  { id: '771107026',   name: '--',                             rank: 53,  color: 15 },
  { id: '770867041',   name: 'DAC RANK LOCK',                  rank: 61,  color: 11 },
  { id: '771009073',   name: 'AC RANK LOCK',                   rank: 62,  color: 11 },
  { id: '771417071',   name: 'DC RANK LOCK',                   rank: 63,  color: 11 },
  { id: '770859042',   name: 'HS RANK LOCK',                   rank: 64,  color: 11 },
  { id: '770711048',   name: 'CMSR RANK LOCK',                 rank: 65,  color: 11 },
  { id: '770699086',   name: 'MO RANK LOCK',                   rank: 66,  color: 11 },
  { id: '770931052',   name: '-',                              rank: 99,  color: 15 },
  { id: '771930057',   name: 'MET ADMINISTRATION',            rank: 100, color: 2 },
  { id: '771850030',   name: 'MET HICOMM',                    rank: 110, color: 4 },
  { id: '772094046',   name: 'MET Overseer',                  rank: 250, color: 12 },
  { id: '770777040',   name: 'PERMS GROUP HOLDER',            rank: 255, color: 15 },
];

const PERMS_BY_ID   = new Map(PERMS_ROLES.map(r => [String(r.id), r]));
const PERMS_BY_NAME = new Map(PERMS_ROLES.map(r => [r.name.toLowerCase(), r]));

// A pure-divider role is just dashes (visual separators in the group ladder).
function isDividerName(name) { return /^-+$/.test(String(name || '').trim()); }

// Is this catalog role a real, surfaceable permission?
//   rank 1..99, not the base Member/Guest role, not a divider.
function isPermRole(role) {
  if (!role) return false;
  if (role.isBase) return false;
  const n = String(role.name || '').toLowerCase().trim();
  if (n === 'guest' || n === 'member') return false;
  if (isDividerName(role.name)) return false;
  const r = Number(role.rank);
  return Number.isFinite(r) && r >= 1 && r <= PERM_RANK_MAX;
}

// A profile-ready perm chip: { key, label, category, color }.
function permChip(role) {
  return { key: String(role.id), label: role.name, category: 'perm', color: paletteHex(role.color) };
}

// Turn the roles a member holds in the perms group into perm chips. Accepts
// either the single Roblox group role object ({ id, name, rank }) that the
// public API returns, or an array of such roles / role ids / role names — so a
// future multi-role source (e.g. a bot writing every held perm) works too.
function permsFromGroupRoles(input) {
  const list = Array.isArray(input) ? input : (input == null ? [] : [input]);
  const out = [];
  const seen = new Set();
  for (const item of list) {
    let role = null;
    if (item && typeof item === 'object') {
      role = PERMS_BY_ID.get(String(item.id)) ||
             PERMS_BY_NAME.get(String(item.name || '').toLowerCase()) ||
             // Not in the catalog but the live rank qualifies — surface it raw.
             (isPermRole(item) ? { id: item.id || item.name, name: item.name, rank: item.rank, color: 0 } : null);
    } else if (item != null) {
      role = PERMS_BY_ID.get(String(item)) || PERMS_BY_NAME.get(String(item).toLowerCase());
    }
    if (role && isPermRole(role) && !seen.has(String(role.id))) {
      seen.add(String(role.id));
      out.push(permChip(role));
    }
  }
  return out;
}

// Fetch ALL role IDs a user holds in the perms group via the Open Cloud v2
// memberships endpoint (supports multiple-roles-per-member). Returns catalog
// role objects [{ id, name, rank, color }]; [] on no key / error / no match.
// The membership carries `roles` (array of role paths) and `role` (primary).
async function fetchOpenCloudPermRoles(robloxId) {
  const key = openCloudKey();
  const gid = permsGroupId();
  if (!key || !gid || !robloxId) return [];
  try {
    const filter = encodeURIComponent(`user == 'users/${robloxId}'`);
    const url = `https://apis.roblox.com/cloud/v2/groups/${gid}/memberships?maxPageSize=10&filter=${filter}`;
    const res = await fetch(url, { headers: { 'x-api-key': key } });
    if (!res.ok) return [];
    const data = await res.json();
    const memberships = data.groupMemberships || data.memberships || [];
    const rolePaths = new Set();
    for (const m of memberships) {
      if (Array.isArray(m.roles)) m.roles.forEach(p => p && rolePaths.add(p));
      if (m.role) rolePaths.add(m.role);
    }
    if (!rolePaths.size) return [];
    // Resolve each "groups/{gid}/roles/{roleId}" to its REAL name + rank via the
    // live group role list (don't rely on the static catalog's ids matching).
    const liveRoles = await getGroupRolesPublic(gid);
    const byId = new Map(liveRoles.map(r => [String(r.id), r]));
    return [...rolePaths]
      .map(p => byId.get(String(p).split('/').pop()))
      .filter(Boolean); // [{ id, name, rank }] — permsFromGroupRoles filters + colours by name
  } catch (e) {
    console.error('[permsGroup] Open Cloud membership fetch failed:', e.message);
    return [];
  }
}

// Resolve a member's perm chips live from the perms group by their Roblox id.
// UNIONS every source so ALL of a member's roles show (multiple-roles-per-
// member): the Open Cloud memberships API (if a key is set) AND the public v2
// groups/roles endpoint (which returns multiple entries per group for multi-role
// members). permsFromGroupRoles de-duplicates. Best-effort.
async function resolveUserPerms(robloxId) {
  if (!robloxId) return [];
  const gid = permsGroupId();
  if (!gid) return [];
  const all = [];
  if (openCloudKey()) {
    try { all.push(...await fetchOpenCloudPermRoles(robloxId)); } catch (e) { /* ignore */ }
  }
  try { all.push(...await getUserGroupRoles(robloxId, gid)); } catch (e) { /* ignore */ }
  return permsFromGroupRoles(all);
}

// ── Standing / disciplinary Discord roles ────────────────────────────
// IDs come from env (the ones the user supplied). Each maps to a coloured flag
// chip shown on the profile when the member holds that Discord role.
const FLAG_ROLES = [
  { key: 'ACTIVITY_STRIKE', env: 'ROLE_ACTIVITY_STRIKE', label: 'Activity Strike', color: '#f5b730', category: 'flag' },
  { key: 'VERBAL_WARNING',  env: 'ROLE_VERBAL_WARNING',  label: 'Verbal Warning',  color: '#4a8fff', category: 'flag' },
  { key: 'STRIKE_1',        env: 'ROLE_STRIKE_1',        label: 'Strike 1',        color: '#f5c518', category: 'flag' },
  { key: 'STRIKE_2',        env: 'ROLE_STRIKE_2',        label: 'Strike 2',        color: '#e8842a', category: 'flag' },
  { key: 'STRIKE_3',        env: 'ROLE_STRIKE_3',        label: 'Strike 3',        color: '#f04f5e', category: 'flag' },
  { key: 'SUSPENDED',       env: 'ROLE_SUSPENDED',       label: 'Suspended',       color: '#f04f5e', category: 'flag' },
  { key: 'ZT',              env: 'ROLE_ZT',              label: 'Zero Tolerance',  color: '#c0392b', category: 'flag' },
];

// Given the Discord role IDs a member holds (captured at login → user.metRoleIds),
// return the standing/disciplinary flag chips they map to.
//   → [{ key, label, color, category, roleId }]
function flagsFromRoleIds(roleIds) {
  const ids = new Set((Array.isArray(roleIds) ? roleIds : []).map(String));
  const out = [];
  for (const f of FLAG_ROLES) {
    const rid = process.env[f.env];
    if (rid && ids.has(String(rid))) {
      out.push({ key: f.key, label: f.label, color: f.color, category: f.category, roleId: String(rid) });
    }
  }
  return out;
}

module.exports = {
  permsGroupId, openCloudKey, PERM_RANK_MAX, PALETTE, paletteHex,
  PERMS_ROLES, isDividerName, isPermRole,
  permsFromGroupRoles, resolveUserPerms, fetchOpenCloudPermRoles,
  FLAG_ROLES, flagsFromRoleIds,
};
