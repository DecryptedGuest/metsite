// The canonical punishment catalog.
//
// `roleId` is a GETTER so the id is read from the environment at call time:
// a role can be re-created or swapped in Discord without redeploying the bot,
// and cases filed before a role existed still pick it up on approval.
const { env } = require('./env');

const ACTION_CONFIG = {
  'Verbal Warning':        { get roleId() { return env('ROLE_VERBAL_WARNING'); },  exile: false, timed: false },
  'Written Warning':       { get roleId() { return env('ROLE_WRITTEN_WARNING'); }, exile: false, timed: false },
  'Zero Tolerance':        { get roleId() { return env('ROLE_ZT'); },              exile: false, timed: true  },
  'Suspension':            { get roleId() { return env('ROLE_SUSPENDED'); },       exile: false, timed: true  },
  'Activity Strike':       { get roleId() { return env('ROLE_ACTIVITY_STRIKE'); }, exile: false, timed: false },
  'Disciplinary Strike 1': { get roleId() { return env('ROLE_STRIKE_1'); },        exile: false, timed: false },
  'Disciplinary Strike 2': { get roleId() { return env('ROLE_STRIKE_2'); },        exile: false, timed: false },
  'Disciplinary Strike 3': { get roleId() { return env('ROLE_STRIKE_3'); },        exile: false, timed: false },
  'Demotion':              { get roleId() { return null; },                        exile: false, timed: false },
  'Termination':           { get roleId() { return null; },                        exile: true,  timed: false },
  'Blacklist':             { get roleId() { return env('ROLE_BLACKLIST'); },       exile: true,  timed: false },
};

const ACTION_NAMES = Object.keys(ACTION_CONFIG);

// Punishments only High Command may approve.
const HICOMM_ONLY_ACTIONS = ['Blacklist', 'Termination'];

function roleIdForAction(action) {
  return ACTION_CONFIG[action] ? ACTION_CONFIG[action].roleId : null;
}
function isTimed(action) { return !!ACTION_CONFIG[action]?.timed; }
function isExile(action) { return !!ACTION_CONFIG[action]?.exile; }

/**
 * Parse a comma-separated punishment list into validated action names.
 * Returns { actions, invalid } — the caller decides how to complain.
 */
function parseActions(raw) {
  const wanted = String(raw || '').split(',').map(s => s.trim()).filter(Boolean);
  const actions = [], invalid = [];
  for (const w of wanted) {
    const match = ACTION_NAMES.find(a => a.toLowerCase() === w.toLowerCase());
    if (match) { if (!actions.includes(match)) actions.push(match); }
    else invalid.push(w);
  }
  // Keep catalog order regardless of the order they were typed.
  actions.sort((a, b) => ACTION_NAMES.indexOf(a) - ACTION_NAMES.indexOf(b));
  return { actions, invalid };
}

function caseHasHicommOnlyPunishment(actions) {
  return (actions || []).some(a => HICOMM_ONLY_ACTIONS.includes(a.action || a));
}

module.exports = {
  ACTION_CONFIG, ACTION_NAMES, HICOMM_ONLY_ACTIONS,
  roleIdForAction, isTimed, isExile, parseActions, caseHasHicommOnlyPunishment,
};
