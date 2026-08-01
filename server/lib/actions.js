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

const ACTION_CONFIG = {
  // RETIRED. The role this pointed at is the Written Warning role, so issuing
  // a "Verbal Warning" gave somebody a written one. Kept so historical records
  // still read back; `retired` keeps it off every list you can pick from.
  'Verbal Warning':        { get roleId() { return env('ROLE_VERBAL_WARNING'); },                       exile: false, timed: false, retired: true },
  'Written Warning':       { get roleId() { return env('ROLE_WRITTEN_WARNING'); },                        exile: false, timed: false },
  'Zero Tolerance':        { get roleId() { return env('ROLE_ZT', '1452275521470726235'); },              exile: false, timed: true  },
  'Suspension':            { get roleId() { return env('ROLE_SUSPENDED'); },                              exile: false, timed: true  },
  'Activity Strike':       { get roleId() { return env('ROLE_ACTIVITY_STRIKE', '1219011548714893343'); }, exile: false, timed: false },
  'Disciplinary Strike 1': { get roleId() { return env('ROLE_STRIKE_1', '1191048287361433738'); },        exile: false, timed: false },
  'Disciplinary Strike 2': { get roleId() { return env('ROLE_STRIKE_2', '1191048287361433739'); },        exile: false, timed: false },
  // RETIRED. There is no third strike — two strikes and the next step is
  // Termination, which somebody decides rather than a counter reaching 3. The
  // entry stays so historical records still resolve their role and their name;
  // `retired` keeps it out of every list you can pick from.
  'Disciplinary Strike 3': { get roleId() { return env('ROLE_STRIKE_3', '1513101097978564739'); },        exile: false, timed: false, retired: true },
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

module.exports = { ACTION_CONFIG, ACTION_NAMES, ALL_ACTION_NAMES, roleIdForAction };
