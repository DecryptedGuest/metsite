// server/lib/actions.js — canonical action definitions shared across the app.
//
// Discord role IDs are read from environment variables (with the previous
// hard-coded IDs as fallbacks) so they can be managed per-deployment without a
// code change. Roles are assigned in DISCORD_GUILD_ID when a case is approved;
// timed punishments (Zero Tolerance, Suspension) auto-expire and have their role
// removed by the background checker in bot.js.
//
// Env keys: ROLE_VERBAL_WARNING, ROLE_WRITTEN_WARNING, ROLE_ZT,
//   ROLE_ACTIVITY_STRIKE, ROLE_STRIKE_1, ROLE_STRIKE_2, ROLE_STRIKE_3,
//   ROLE_SUSPENDED, ROLE_BLACKLIST.
const env = (name, fallback = null) => process.env[name] || fallback;

// The two roles that were left without a default and so were never assigned.
// They live in the MET server; overriding them per-deployment still works.
const WRITTEN_WARNING_ROLE = '1469746159961509999';
const SUSPENSION_ROLE      = '1429561201331015781';

const ACTION_CONFIG = {
  // RETIRED. The role this pointed at is the Written Warning role, so issuing
  // a "Verbal Warning" gave somebody a written one. Kept so historical records
  // still read back; `retired` keeps it off every list you can pick from.
  // RETIRED, and its env var now points at the Written Warning role because
  // that is what it always was. Reading the same id keeps historical "Verbal
  // Warning" records resolving to the role their holder is actually wearing.
  'Verbal Warning':        { get roleId() { return env('ROLE_VERBAL_WARNING', WRITTEN_WARNING_ROLE); },   exile: false, timed: false, retired: true },
  // The default matters. With ROLE_WRITTEN_WARNING unset this returned null, so
  // a written warning assigned NO role — which meant there was nothing for the
  // rejoin persistence to re-apply, and the punishment quietly evaporated the
  // moment somebody left the server.
  'Written Warning':       { get roleId() { return env('ROLE_WRITTEN_WARNING', WRITTEN_WARNING_ROLE); },  exile: false, timed: false },
  'Zero Tolerance':        { get roleId() { return env('ROLE_ZT', '1452275521470726235'); },              exile: false, timed: true  },
  'Suspension':            { get roleId() { return env('ROLE_SUSPENDED', SUSPENSION_ROLE); },             exile: false, timed: true  },
  'Activity Strike':       { get roleId() { return env('ROLE_ACTIVITY_STRIKE', '1219011548714893343'); }, exile: false, timed: false },
  // Marked timed because they ARE. A strike filed with a duration gets a real
  // expiresAt on its CasePunishment row and the background checker takes the
  // role back when it lapses — and the case builder has always defaulted them
  // to 14 or 21 days off the penal-code class in the Reason field. Saying
  // timed: false here did not make them permanent; it only made the officer's
  // notice claim they were, and hid the length from /discipline.
  'Disciplinary Strike 1': { get roleId() { return env('ROLE_STRIKE_1', '1191048287361433738'); },        exile: false, timed: true },
  'Disciplinary Strike 2': { get roleId() { return env('ROLE_STRIKE_2', '1191048287361433739'); },        exile: false, timed: true },
  // RETIRED. There is no third strike — two strikes and the next step is
  // Termination, which somebody decides rather than a counter reaching 3. The
  // entry stays so historical records still resolve their role and their name;
  // `retired` keeps it out of every list you can pick from.
  'Disciplinary Strike 3': { get roleId() { return env('ROLE_STRIKE_3', '1513101097978564739'); },        exile: false, timed: true,  retired: true },
  'Demotion':              { get roleId() { return null; },                                               exile: false, timed: false },
  'Termination':           { get roleId() { return null; },                                               exile: true,  timed: false },
  'Blacklist':             { get roleId() { return env('ROLE_BLACKLIST', '1195557302250524764'); },       exile: true,  timed: false },
};

// What you can pick TODAY. Retired actions are excluded, so nothing new is
// ever filed against one.
const ACTION_NAMES = Object.keys(ACTION_CONFIG).filter(n => !ACTION_CONFIG[n].retired);

// Every action that has ever existed, for reading old records back. A case
// filed years ago against a since-retired action must still show its name and
// resolve its role.
const ALL_ACTION_NAMES = Object.keys(ACTION_CONFIG);

// The Discord role for an action right now (env-resolved), or null.
function roleIdForAction(action) { return ACTION_CONFIG[action] ? ACTION_CONFIG[action].roleId : null; }


// Is this action one that expires? Suspensions, Zero Tolerance and strikes all
// carry a duration; a warning does not. Reading this before storing a duration
// is what stops "Strike(s) [2]" being filed as a two-day strike.
function isTimed(action) { return !!(ACTION_CONFIG[action] && ACTION_CONFIG[action].timed); }

/**
 * Parse a comma-separated punishment list into canonical action names.
 *
 * Matching is case- and space-insensitive, and tolerates the shorthand people
 * actually type ("ws" / "written", "zt", "strike 1"), because a filer who has
 * to reproduce the exact catalogue string will get it wrong and lose the case
 * they just wrote up. Retired actions are never matched: nothing new is filed
 * against one.
 *
 * @returns {{actions: string[], invalid: string[]}}
 */
function parseActions(input) {
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const byNorm = new Map(ACTION_NAMES.map(n => [norm(n), n]));
  const ALIASES = {
    ww: 'Written Warning', written: 'Written Warning', warning: 'Written Warning',
    zt: 'Zero Tolerance', zerotolerance: 'Zero Tolerance',
    susp: 'Suspension', suspend: 'Suspension',
    as: 'Activity Strike', activitystrike: 'Activity Strike',
    strike1: 'Disciplinary Strike 1', ds1: 'Disciplinary Strike 1', s1: 'Disciplinary Strike 1',
    strike2: 'Disciplinary Strike 2', ds2: 'Disciplinary Strike 2', s2: 'Disciplinary Strike 2',
    demote: 'Demotion', term: 'Termination', terminate: 'Termination',
    bl: 'Blacklist',
  };

  const actions = [], invalid = [];
  for (const raw of String(input || '').split(',')) {
    const t = raw.trim();
    if (!t) continue;
    const k = norm(t);
    const hit = byNorm.get(k) || ALIASES[k] || null;
    if (!hit) invalid.push(t);
    else if (!actions.includes(hit)) actions.push(hit);
  }
  return { actions, invalid };
}

module.exports = { ACTION_CONFIG, ACTION_NAMES, ALL_ACTION_NAMES, roleIdForAction, isTimed, parseActions };
