// server/lib/divisions.js
// Central registry for the MET portal's divisions and their Roblox groups.
//
// Source of truth (per product decision): a user's membership and rank in a
// division come ONLY from that division's Roblox GROUP rank — no Discord-role
// fallback. Each division is a Roblox group held by the "holder" account
// (FNTHOLDER_V2 by default), whose group icon is used as the division icon.
//
// Group IDs are taken from env (authoritative) and, for any left unset, are
// auto-discovered by matching the holder account's groups by name. Icons are
// fetched from Roblox and cached. All Roblox calls are best-effort: if Roblox
// is unreachable the config resolves to whatever is known (fail-closed on
// access), never throwing on the request path.
const fetch = require('node-fetch');
const { getRobloxIdFromUsername, getUserGroupRole } = require('./roblox');

// The Roblox account that holds every divisional group (and their icons).
function holderUsername() { return process.env.DIVISION_HOLDER_USERNAME || 'FNTHOLDER_V2'; }

// Division metadata. `groupEnv` is the env var that pins the group id;
// `match` recognises the group by name during holder auto-discovery.
// IA keeps its long-standing group id + env var untouched.
const META = {
  CID:   { name: 'CID',    slug: 'cid',   fullName: 'Criminal Investigation Department', groupEnv: 'GROUP_CID',    match: /criminal invest|\bcid\b/i },
  SCO19: { name: 'SCO-19', slug: 'sco19', fullName: 'Specialist Firearms Command',       groupEnv: 'GROUP_SCO19',  match: /sco[\s-]?19|specialist firearms|firearms command/i },
  IA:    { name: 'IA',     slug: 'ia',    fullName: 'Internal Affairs',                  groupEnv: 'IA_GROUP_ID',  defaultGroupId: '407296071', match: /internal affairs/i },
  FLP:   { name: 'FLP',    slug: 'flp',   fullName: 'Frontline Policing',                groupEnv: 'GROUP_FLP',    match: /frontline/i },
  HPC:   { name: 'HPC',    slug: 'hpc',   fullName: 'Hendon Police College',             groupEnv: 'GROUP_HPC',    match: /hendon|police college|\bhpc\b/i },
};

// Division order the portal shows everywhere.
const ALL = ['CID', 'SCO19', 'IA', 'FLP', 'HPC'];

// New divisions resolved purely from their Roblox group. IA is resolved from
// its existing site-role pipeline (roleResolver) and handled separately, so it
// is deliberately excluded here to leave IA's behaviour untouched.
const GROUP_DIVISIONS = ['CID', 'SCO19', 'FLP', 'HPC'];

function explicitGroupId(division) {
  const m = META[division];
  return (m.groupEnv && process.env[m.groupEnv]) || m.defaultGroupId || null;
}

// High-rank ("LEAD") thresholds per division, from the divisional spec:
//   CID, SCO-19 → Assistant Commander / Director and above
//   FLP, HPC    → Deputy Director and above
// (IA is resolved from its site role, not here — see roleResolver.)
//
// Matched by rank NAME because the numeric rank differs per group. This is
// PROVISIONAL: it recognises the named threshold ranks the spec calls out, but
// "and above" ranks with other names won't match until each group's full rank
// ladder is confirmed. A numeric override via LEAD_MIN_RANK_<DIV> takes
// precedence when set (member is LEAD when their group rank number >= it).
const LEAD_RANK_PATTERNS = {
  CID:   /assistant commander|deputy commander|\bcommander\b|director/i,
  SCO19: /assistant commander|deputy commander|\bcommander\b|director/i,
  FLP:   /deputy director|director/i,
  HPC:   /deputy director|director/i,
};

function isLeadRank(division, roleName, rankNumber) {
  const envMin = parseInt(process.env[`LEAD_MIN_RANK_${division}`], 10);
  if (Number.isFinite(envMin)) return Number(rankNumber) >= envMin;
  const pat = LEAD_RANK_PATTERNS[division];
  return pat ? pat.test(String(roleName || '')) : false;
}

// ── Resolved config cache: { [division]: { groupId, icon } } ─────────
let configCache = { at: 0, data: null };
const CONFIG_TTL = 60 * 60 * 1000; // 1h — group ids/icons basically never change

async function fetchHolderGroups() {
  try {
    const holder = await getRobloxIdFromUsername(holderUsername());
    if (!holder) return [];
    const res = await fetch(`https://groups.roblox.com/v1/users/${holder.id}/groups/roles`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data || []).map(g => ({ id: String(g.group.id), name: g.group.name || '' }));
  } catch (e) {
    console.warn('[Divisions] holder group discovery failed:', e.message);
    return [];
  }
}

async function fetchGroupIcons(groupIds) {
  const ids = groupIds.filter(Boolean);
  if (!ids.length) return {};
  try {
    const res = await fetch(`https://thumbnails.roblox.com/v1/groups/icons?groupIds=${ids.join(',')}&size=150x150&format=Png&isCircular=false`);
    if (!res.ok) return {};
    const data = await res.json();
    return (data.data || []).reduce((acc, x) => {
      if (x.imageUrl) acc[String(x.targetId)] = x.imageUrl;
      return acc;
    }, {});
  } catch (e) {
    console.warn('[Divisions] icon fetch failed:', e.message);
    return {};
  }
}

// Resolve { [division]: { groupId, icon } } for all divisions, using explicit
// env group ids first and holder auto-discovery to fill any gaps. Cached.
async function getDivisionConfig() {
  if (configCache.data && Date.now() - configCache.at < CONFIG_TTL) return configCache.data;

  const data = {};
  for (const d of ALL) data[d] = { groupId: explicitGroupId(d), icon: null };

  // Auto-discover any division whose group id wasn't pinned via env.
  const missing = ALL.filter(d => !data[d].groupId);
  if (missing.length) {
    const holderGroups = await fetchHolderGroups();
    for (const d of missing) {
      const hit = holderGroups.find(g => META[d].match.test(g.name));
      if (hit) data[d].groupId = hit.id;
    }
  }

  const icons = await fetchGroupIcons(ALL.map(d => data[d].groupId));
  for (const d of ALL) if (data[d].groupId) data[d].icon = icons[data[d].groupId] || null;

  configCache = { at: Date.now(), data };
  return data;
}

// Force the next getDivisionConfig() to re-resolve (e.g. after changing env).
function invalidateConfig() { configCache = { at: 0, data: null }; }

// ── Per-user division resolution (Roblox group rank only) ────────────
// Given a Roblox user id, return the divisions (of the four group-backed ones)
// the user is a member of, with their group rank. IA is NOT included here.
//   → [{ division, rank, rankName, tier }]
async function resolveGroupDivisions(robloxId) {
  if (!robloxId) return [];
  const cfg = await getDivisionConfig();
  const out = [];
  for (const division of GROUP_DIVISIONS) {
    const groupId = cfg[division] && cfg[division].groupId;
    if (!groupId) continue;
    let role = null;
    try { role = await getUserGroupRole(robloxId, groupId); } catch (e) { role = null; }
    if (role && Number(role.rank) > 0) {
      out.push({
        division,
        rank:     Number(role.rank),
        rankName: role.name || null,
        tier:     isLeadRank(division, role.name, role.rank) ? 'LEAD' : 'MEMBER',
      });
    }
  }
  return out;
}

// Client-safe metadata only — never leak group ids / discovery regexes.
function meta(division) {
  const m = META[division];
  return m ? { name: m.name, slug: m.slug, fullName: m.fullName } : null;
}
function allMeta() { return ALL.map(d => ({ division: d, ...meta(d) })); }

module.exports = {
  ALL, GROUP_DIVISIONS, META,
  meta, allMeta,
  getDivisionConfig, invalidateConfig,
  resolveGroupDivisions,
  explicitGroupId, isLeadRank, holderUsername,
};
