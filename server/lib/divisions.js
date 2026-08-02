// server/lib/divisions.js
// Central registry for the MET dashboard's divisions and their Roblox groups.
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
const fs   = require('fs');
const path = require('path');
const { getRobloxIdFromUsername, getUserGroupRole } = require('./roblox');

// The Roblox account that holds every divisional group (and their icons).
function holderUsername() { return process.env.DIVISION_HOLDER_USERNAME || 'FNTHOLDER_V2'; }

// Committed local logos live here and take priority over the live Roblox group
// icon (Roblox's thumbnail API is flaky and can fail to load). Drop a file named
// <slug>.<ext> (cid/sco19/ia/flp/hpc/met) into this folder and it's used as-is.
const DIVISION_IMG_DIR = path.join(__dirname, '../../client/public/img/divisions');
const ICON_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'svg', 'gif'];
function localIcon(slug) {
  try {
    for (const ext of ICON_EXTS) {
      if (fs.existsSync(path.join(DIVISION_IMG_DIR, `${slug}.${ext}`))) {
        return `/img/divisions/${slug}.${ext}`;
      }
    }
  } catch (e) { /* fall through to Roblox */ }
  return null;
}

// Division metadata. `groupEnv` is the env var that pins the group id;
// `match` recognises the group by name during holder auto-discovery.
// Roblox group ids are known/fixed (provided by MET), so they're the defaults;
// the GROUP_* / IA_GROUP_ID env vars still override if ever needed.
// `color` is the division's colour from the MET brief — CID orange, SCO-19
// black, IA administrative orange, FLP light blue, HPC white — and is what the
// profile renders as a role chip.
//
// `accent` is that same identity rendered for UI chrome: every /<slug>/… page is
// themed with it, alongside the division's logo, wordmark and favicon, so you
// can tell at a glance whose side of the dashboard you're on. It matches `color`
// wherever the brief colour works as an accent; SCO-19's black and HPC's white
// are lifted to a readable sibling of the same hue, because the accent has to
// carry nav text and borders on BOTH the dark and light themes. Accents stay
// clear of the semantic status hues (green approved, amber pending, red denied)
// so badges read the same in every division.
const META = {
  CID:   { name: 'CID',    slug: 'cid',   fullName: 'Criminal Investigation Department', color: '#e8842a', accent: '#e8842a', short: 'Criminal Investigation', tagline: 'Investigations · Casework',    groupEnv: 'GROUP_CID',    defaultGroupId: '12697126',  match: /criminal invest|\bcid\b/i },
  SCO19: { name: 'SCO-19', slug: 'sco19', fullName: 'Specialist Firearms Command',       color: '#4b5563', accent: '#8fa3bd', short: 'Specialist Firearms',    tagline: 'Armed Response · Deployments', groupEnv: 'GROUP_SCO19',  defaultGroupId: '14063116',  match: /sco[\s-]?19|specialist firearms|firearms command/i },
  IA:    { name: 'IA',     slug: 'ia',    fullName: 'Internal Affairs',                  color: '#c2701f', accent: '#c2701f', short: 'Internal Affairs',       tagline: 'Case Management System',       groupEnv: 'IA_GROUP_ID',  defaultGroupId: '407296071', match: /internal affairs/i },
  FLP:   { name: 'FLP',    slug: 'flp',   fullName: 'Frontline Policing',                color: '#5cc0ff', accent: '#5cc0ff', short: 'Frontline Policing',     tagline: 'Patrols · Response',           groupEnv: 'GROUP_FLP',    defaultGroupId: '233530818', match: /frontline/i },
  HPC:   { name: 'HPC',    slug: 'hpc',   fullName: 'Hendon Police College',             color: '#e8eef7', accent: '#9fb4d0', short: 'Hendon Police College',  tagline: 'Training · Examinations',      groupEnv: 'GROUP_HPC',    defaultGroupId: '35685825',  match: /hendon|police college|\bhpc\b/i },
};

// Extra divisional colours for divisions that exist in the MET server but not
// (yet) as dashboard divisions — kept so a perms-group chip / future division can
// reuse the same palette. MI5 = Military Intelligence 5 (sky), SAS (purple).
const DIVISION_COLORS_EXTRA = { MI5: '#38bdf8', SAS: '#9b6ef3' };

// The top-level Metropolitan Police group — the umbrella every officer belongs
// to. Its rank drives MET-wide quota (low rank / senior officer / high rank),
// and its icon is the dashboard's brand mark. Not a "division", so it's not in ALL.
function metGroupId() { return process.env.GROUP_MET || '17275620'; }

// Division order the dashboard shows everywhere.
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
  // Prefer the authoritative rank→tier table (ranks.js): LEAD = the division's
  // HIGH tier. This avoids the loose regex swallowing lower ranks by substring
  // (e.g. "Unit Commander" is MIDDLE, not Command; "Assistant Director" is HIGH).
  const { tierForRank } = require('./ranks');
  const t = tierForRank(division, roleName);
  if (t) return t === 'HIGH';
  // Fallback for role names not present in the table (whitespace/suffix variants).
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

  // Prefer a committed local logo; only hit Roblox for icons we don't have one for.
  for (const d of ALL) data[d].icon = localIcon(META[d].slug);
  const metId = metGroupId();
  const metLocal = localIcon('met');

  const needIds = ALL.filter(d => !data[d].icon).map(d => data[d].groupId).filter(Boolean);
  if (!metLocal) needIds.push(metId);
  const icons = needIds.length ? await fetchGroupIcons(needIds) : {};
  for (const d of ALL) if (!data[d].icon && data[d].groupId) data[d].icon = icons[data[d].groupId] || null;

  // The MET umbrella group's icon (dashboard brand mark). Kept off ALL so it's
  // never rendered as a division card.
  data.MET = { groupId: metId, icon: metLocal || icons[metId] || null };

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
      // HPC only counts as a division site-wide for Junior Instructor and above —
      // cadets / lower HPC group ranks don't get the HPC division on the dashboard.
      if (division === 'HPC' && !hpcRankAtLeast(role.name, role.rank, 'instructor')) continue;
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
// The Developer "division" — not a real MET division (never in ALL / the public
// switcher), but developers get it in their `mine` list so it shows on their
// profile + division switcher and links to the developer tools at /dev/dashboard.
const DEV_META = { name: 'DEV', slug: 'dev', fullName: 'Developer Tools', color: '#f5c518', icon: '/img/divisions/dev.svg' };

function meta(division) {
  if (division === 'DEV') return { ...DEV_META };
  const m = META[division];
  return m ? {
    name: m.name, slug: m.slug, fullName: m.fullName,
    short: m.short || m.fullName, tagline: m.tagline || '',
    color: m.color || null,
    accent: m.accent || m.color || MET_BRAND.accent,
    logo: brandLogo(m.slug),
  } : null;
}

// The MET role-scheme colour for a division (or null if unknown).
function divisionColor(division) {
  if (division === 'DEV') return DEV_META.color;
  return (META[division] && META[division].color) || DIVISION_COLORS_EXTRA[division] || null;
}
function allMeta() { return ALL.map(d => ({ division: d, ...meta(d) })); }


// ── Per-division page branding ───────────────────────────────────────
// Everything under /ia, /cid, /sco19, /flp and /hpc is themed with its own
// division's colour, logo and wordmark. The theme is injected server-side (see
// brandHead below) so it is already correct on first paint — no flash of the
// wrong division while a script runs.
const MET_BRAND = {
  name: 'MET', slug: 'met', fullName: 'Metropolitan Police Service',
  short: 'Metropolitan Police Service', tagline: 'Officer Dashboard', accent: '#4a8fff',
};

// The committed logo for a slug, or the dashboard mark when there isn't one. Never
// the live Roblox icon: this has to resolve synchronously on the page path, and
// Roblox's thumbnail API is too flaky to sit in front of first paint.
function brandLogo(slug) { return localIcon(slug) || '/img/logo.png'; }

function brandFor(division) {
  const m = division && META[division];
  const base = m
    ? { name: m.name, slug: m.slug, fullName: m.fullName, short: m.short || m.fullName,
        tagline: m.tagline || '', accent: m.accent || m.color || MET_BRAND.accent }
    : { ...MET_BRAND };
  return { ...base, logo: brandLogo(base.slug) };
}

// #rrggbb → "r, g, b" for rgba() mixes in the injected theme. Falls back to the
// dashboard blue rather than emitting a broken custom property.
function rgbTriplet(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return '74, 143, 255';
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

// Everything that goes into <head> to brand a page for one division: the
// favicon, the browser theme colour, and the accent custom properties that
// division-theme.css builds the rest of the palette from.
//
// Values come from the META table above, never from the request, so this is
// static trusted markup — but the accent is still validated by rgbTriplet and
// the slug is a fixed identifier, so a malformed table entry degrades to the
// dashboard default instead of breaking the page.
function brandHead(division) {
  const b = brandFor(division);
  const accent = /^#[0-9a-f]{6}$/i.test(b.accent) ? b.accent : MET_BRAND.accent;
  return [
    `<link rel="icon" type="image/png" href="${b.logo}" />`,
    `<link rel="apple-touch-icon" href="${b.logo}" />`,
    `<meta name="theme-color" content="${accent}" />`,
    `<link rel="stylesheet" href="/css/division-theme.css" />`,
    `<style>:root{--div-accent:${accent};--div-accent-rgb:${rgbTriplet(accent)};`
      + `--div-logo:url("${b.logo}");}</style>`,
    `<script>window.MET_BRAND=${JSON.stringify(b).replace(/</g, '\\u003c')};</script>`,
    // defer → runs after the document is parsed, and after the inline script
    // above has set window.MET_BRAND.
    `<script src="/js/division-brand.js" defer></script>`,
  ].join('\n');
}

// ── Group-panel targets ──────────────────────────────────────────────
// Selectable groups for the developer Group Panel: every division (so future
// ones added to ALL appear automatically) plus the MET umbrella group.
function panelGroups() {
  const out = ALL.map(d => ({ key: d, name: META[d].name, fullName: META[d].fullName, groupId: explicitGroupId(d) }));
  out.push({ key: 'MET', name: 'MET', fullName: 'Metropolitan Police', groupId: metGroupId() });
  return out.filter(g => g.groupId);
}

// Resolve a panel-group key ('CID' | 'IA' | 'FLP' | 'HPC' | 'SCO19' | 'MET') to
// its Roblox group id. Returns null for an unknown key.
function groupIdForKey(key) {
  if (!key) return null;
  if (key === 'MET') return metGroupId();
  if (ALL.includes(key)) return explicitGroupId(key);
  return null;
}

// ── HPC-specific rank gates ──────────────────────────────────────────
// HPC has finer, named access tiers on top of the group rank:
//   • Junior Instructor and above  → can access the HPC division
//   • Database Manager and above    → can mark final exams
//   • Assistant Director and above  → can view the HPC quota check
// Matched by rank NAME (provisional until the full HPC ladder is confirmed).
// The env override HPC_*_MIN_RANK sets a numeric-rank threshold instead.
const HPC_INSTRUCTOR = /junior instructor|instructor|database manager|deputy director|assistant director|director/i;
const HPC_MARKER     = /database manager|deputy director|assistant director|director/i;
const HPC_QUOTA      = /assistant director|deputy director|director/i;

function hpcRankAtLeast(rankName, rankNumber, kind) {
  const envKey = { instructor: 'HPC_INSTRUCTOR_MIN_RANK', marker: 'HPC_MARKER_MIN_RANK', quota: 'HPC_QUOTA_MIN_RANK' }[kind];
  const envMin = parseInt(process.env[envKey], 10);
  if (Number.isFinite(envMin)) return Number(rankNumber) >= envMin;
  const pat = { instructor: HPC_INSTRUCTOR, marker: HPC_MARKER, quota: HPC_QUOTA }[kind];
  return pat ? pat.test(String(rankName || '')) : false;
}

// The Discord role that requires a cadet to sit the final exam.
function hpcExamRoleId() { return process.env.HPC_EXAM_ROLE_ID || '1509521712058990743'; }

// Where final-exam results are posted (a webhook on the MET results channel
// 1509522116590960640 — create one there and set HPC_RESULTS_WEBHOOK_URL).
function hpcResultsWebhookUrl() { return process.env.HPC_RESULTS_WEBHOOK_URL || null; }

module.exports = {
  ALL, GROUP_DIVISIONS, META, DIVISION_COLORS_EXTRA,
  meta, allMeta, divisionColor, panelGroups, groupIdForKey,
  brandFor, brandHead, brandLogo, MET_BRAND,
  getDivisionConfig, invalidateConfig,
  resolveGroupDivisions,
  explicitGroupId, isLeadRank, holderUsername, metGroupId,
  hpcRankAtLeast, hpcExamRoleId, hpcResultsWebhookUrl,
};
