// server/lib/ranks.js
// Data-driven rank → tier mapping for every division. The TIER drives which
// CID/whatever database sheet-tab a member's row lives on (LOW / MIDDLE / HIGH
// RANK). Kept in one place so tier lookups + DB-sheet routing are data-driven
// rather than scattered through the code. Short codes appear in older data.
//
// Full in-game rank names are confirmed (per the CID build spec).

const RANKS = {
  CID: [
    { full: 'Detective Constable',        short: 'DCON',  tier: 'LOW' },
    { full: 'Detective Sergeant',         short: 'DSGT',  tier: 'LOW' },
    { full: 'Detective Inspector',        short: 'DINS',  tier: 'LOW' },
    { full: 'Detective Chief Inspector',  short: 'DCINS', tier: 'MIDDLE' },
    { full: 'Detective Superintendent',   short: 'DSUP',  tier: 'MIDDLE' },
    { full: 'Assistant Director',         short: 'AD',    tier: 'HIGH' },
    { full: 'Deputy Director',            short: 'DD',    tier: 'HIGH' },
    { full: 'Director',                   short: 'D',     tier: 'HIGH' },
  ],
  SCO: [
    { full: 'Firearms Constable',         short: 'FCON',  tier: 'LOW' },
    { full: 'Firearms Sergeant',          short: 'FSGT',  tier: 'LOW' },
    { full: 'Firearms Inspector',         short: 'FINS',  tier: 'LOW' },
    { full: 'Firearms Chief Inspector',   short: 'FCINS', tier: 'MIDDLE' },
    { full: 'Deputy Unit Commander',      short: 'DUC',   tier: 'MIDDLE' },
    { full: 'Unit Commander',             short: 'UC',    tier: 'MIDDLE' },
    { full: 'Assistant Commander',        short: 'ACOMM', tier: 'HIGH' },
    { full: 'Deputy Commander',           short: 'DCOMM', tier: 'HIGH' },
    { full: 'Commander',                  short: 'COMM',  tier: 'HIGH' },
  ],
  HPC: [
    { full: 'Junior Instructor',          short: 'JI',    tier: 'LOW' },
    { full: 'Instructor',                 short: 'I',     tier: 'LOW' },
    { full: 'Senior Instructor',          short: 'SI',    tier: 'MIDDLE' },
    { full: 'Lead Instructor',            short: 'LI',    tier: 'MIDDLE' },
    { full: 'Database Manager',           short: 'DM',    tier: 'MIDDLE' },
    { full: 'Assistant Director',         short: 'AD',    tier: 'HIGH' },
    { full: 'Deputy Director',            short: 'DD',    tier: 'HIGH' },
    { full: 'Director',                   short: 'D',     tier: 'HIGH' },
  ],
  FLP: [
    { full: 'Junior Officer',             short: 'JO',    tier: 'LOW' },
    { full: 'Officer',                    short: 'O',     tier: 'LOW' },
    { full: 'Senior Officer',             short: 'SO',    tier: 'MIDDLE' },
    { full: 'Assistant Director',         short: 'AD',    tier: 'HIGH' },
    { full: 'Deputy Director',            short: 'DD',    tier: 'HIGH' },
    { full: 'Director',                   short: 'D',     tier: 'HIGH' },
  ],
  IA: [
    { full: 'Probationary Investigator',  short: 'PINV',  tier: 'LOW' },
    { full: 'Junior Investigator',        short: 'JINV',  tier: 'LOW' },
    { full: 'Investigator',               short: 'INV',   tier: 'LOW' },
    { full: 'Senior Investigator',        short: 'SINV',  tier: 'MIDDLE' },
    { full: 'Supervisor',                 short: '',      tier: 'MIDDLE' },
    { full: 'Deputy Director',            short: 'DD',    tier: 'HIGH' },
    { full: 'Director',                   short: 'D',     tier: 'HIGH' },
  ],
};

const TIERS = ['LOW', 'MIDDLE', 'HIGH'];

// Human labels for the tiers, for UI ("LOW" → "Low Rank").
const TIER_LABELS = { LOW: 'Low Rank', MIDDLE: 'Middle Rank', HIGH: 'High Rank' };

// The app uses a few division codes that differ from the RANKS keys
// (e.g. "SCO19"/"SCO-19" for the firearms division) — normalise them here so
// rank lookups are forgiving of the calling convention.
const DIV_ALIAS = { SCO19: 'SCO', 'SCO-19': 'SCO', SCO_19: 'SCO' };

function norm(s) { return String(s || '').trim().toLowerCase(); }

function divisionKey(division) {
  const d = String(division || '').toUpperCase().trim();
  return DIV_ALIAS[d] || d;
}

// Resolve a rank (full name OR short code, case-insensitive) → its entry.
function rankEntry(division, rank) {
  const list = RANKS[divisionKey(division)];
  if (!list) return null;
  const r = norm(rank);
  if (!r) return null;
  return list.find(e => norm(e.full) === r || (e.short && norm(e.short) === r)) || null;
}

// Resolve a rank → its tier ('LOW' | 'MIDDLE' | 'HIGH'), or null if unknown.
function tierForRank(division, rank) {
  const e = rankEntry(division, rank);
  return e ? e.tier : null;
}

// Best-effort display tier for a division membership. Prefers the real rank →
// tier mapping from the rank structure; falls back to the coarse access tier
// ('LEAD' → HIGH, anything else → LOW) so the badge always resolves to one of
// LOW / MIDDLE / HIGH. Returns null only when there's nothing to go on.
function displayTier(division, rankName, accessTier) {
  const t = tierForRank(division, rankName);
  if (t) return t;
  const a = String(accessTier || '').toUpperCase();
  if (a === 'LEAD' || a === 'HIGH') return 'HIGH';
  if (a === 'MIDDLE') return 'MIDDLE';
  if (a === 'MEMBER' || a === 'LOW') return 'LOW';
  return null;
}

function tierLabel(tier) { return TIER_LABELS[String(tier || '').toUpperCase()] || null; }

// The candidate DB sheet-tab titles for a tier, most-specific first. The real
// tabs are named like "LOW RANK" / "MIDDLE RANK" / "HIGH RANK" — we accept a few
// spellings so tab lookup is forgiving.
function tabTitlesForTier(tier) {
  const t = String(tier || '').toUpperCase();
  if (!TIERS.includes(t)) return [];
  return [`${t} RANK`, `${t} RANKS`, t];
}

module.exports = { RANKS, TIERS, TIER_LABELS, rankEntry, tierForRank, displayTier, tierLabel, tabTitlesForTier };
