// The Internal Affairs rank ladder and who may approve what.
//
// Ranks are matched against the member's Discord roles by NAME (case- and
// punctuation-insensitive), with an optional explicit role id per rank so a
// server that names roles differently can pin them. Rank order is the source
// of authority: higher index = more authority.
const { env } = require('./env');

// Lowest → highest. The abbreviations are the ones used in server nicknames
// (e.g. "IA-PINV | Opticx_onYT12").
const IA_RANKS = [
  { key: 'PINV',  abbr: 'IA-PINV',  name: 'Probationary Investigator' },
  { key: 'JINV',  abbr: 'IA-JINV',  name: 'Junior Investigator' },
  { key: 'INV',   abbr: 'IA-INV',   name: 'Investigator' },
  { key: 'SINV',  abbr: 'IA-SINV',  name: 'Senior Investigator' },
  { key: 'SPVR',  abbr: 'IA-SPVR',  name: 'Supervisor' },
  { key: 'ADIR',  abbr: 'IA-ADIR',  name: 'Assistant Director' },
  { key: 'DDIR',  abbr: 'IA-DDIR',  name: 'Deputy Director' },
  { key: 'DIR',   abbr: 'IA-DIR',   name: 'Director' },
];

const RANK_INDEX = Object.fromEntries(IA_RANKS.map((r, i) => [r.key, i]));

// "HR" in the command descriptions means Deputy Director and above.
const HR_MIN = RANK_INDEX.DDIR;
// Approving anything at all starts here.
const REVIEW_MIN = RANK_INDEX.SPVR;

/**
 * Approval authority per punishment. A reviewer must hold at least this rank
 * for EVERY punishment on the case, so one Blacklist pulls the whole case up
 * to Director.
 */
const APPROVAL_MIN = {
  'Verbal Warning':        RANK_INDEX.SPVR,
  'Written Warning':       RANK_INDEX.SPVR,
  'Activity Strike':       RANK_INDEX.SPVR,
  'Disciplinary Strike 1': RANK_INDEX.SPVR,
  'Disciplinary Strike 2': RANK_INDEX.ADIR,
  'Disciplinary Strike 3': RANK_INDEX.ADIR,
  'Zero Tolerance':        RANK_INDEX.ADIR,
  'Suspension':            RANK_INDEX.ADIR,
  'Demotion':              RANK_INDEX.DDIR,
  'Termination':           RANK_INDEX.DIR,
  'Blacklist':             RANK_INDEX.DIR,
};

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Highest IA rank this member holds, or null. */
function rankOf(member) {
  if (!member) return null;
  let best = null;

  for (const rank of IA_RANKS) {
    const pinned = env(`IA_ROLE_${rank.key}`);
    if (pinned && member.roles?.cache?.has(pinned)) {
      best = rank; continue;                       // keep scanning: later = higher
    }
    const wantName = norm(rank.name);
    const wantAbbr = norm(rank.abbr);
    const found = member.roles?.cache?.some(r => {
      const n = norm(r.name);
      return n === wantName || n === wantAbbr || n === norm(rank.key);
    });
    if (found) best = rank;
  }
  return best;
}

const rankIndexOf = (member) => {
  const r = rankOf(member);
  return r ? RANK_INDEX[r.key] : -1;
};

const isHR      = (member) => rankIndexOf(member) >= HR_MIN;
const canReview = (member) => rankIndexOf(member) >= REVIEW_MIN;

/**
 * May this member approve a case carrying these punishments?
 * Returns { ok } or { ok:false, blocking, required } naming the punishment
 * that outranks them.
 */
function canApproveActions(member, actionNames) {
  const idx = rankIndexOf(member);
  let worst = null;
  for (const a of actionNames || []) {
    const need = APPROVAL_MIN[a];
    if (need == null) continue;
    if (need > idx && (worst == null || need > APPROVAL_MIN[worst])) worst = a;
  }
  if (!worst) return { ok: true };
  return { ok: false, blocking: worst, required: IA_RANKS[APPROVAL_MIN[worst]] };
}

/**
 * Parse "IA-SPVR | Fxkresl" or "PINV - Opticx_onYT12" out of a nickname.
 *
 * Split on a pipe first, and only then on a SPACED dash — an unspaced hyphen
 * belongs to the rank abbreviation itself ("IA-SPVR"), so splitting on it
 * blindly loses the rank.
 */
function parseNickname(nick) {
  if (!nick) return { rank: null, username: null };
  const raw = String(nick).trim();

  let parts;
  if (raw.includes('|')) parts = raw.split('|');
  else if (/\s[-–]\s/.test(raw)) parts = raw.split(/\s[-–]\s/);
  else parts = [raw];

  parts = parts.map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) return { rank: null, username: raw };
  const rankPart = norm(parts[0]);
  const rank = IA_RANKS.find(r => norm(r.abbr) === rankPart || norm(r.key) === rankPart
                               || norm(r.name) === rankPart) || null;
  return { rank, username: parts.slice(1).join(' ').trim() };
}

module.exports = {
  IA_RANKS, RANK_INDEX, APPROVAL_MIN, HR_MIN, REVIEW_MIN,
  rankOf, rankIndexOf, isHR, canReview, canApproveActions, parseNickname,
};
