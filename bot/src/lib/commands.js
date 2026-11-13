// The single source of truth for which command lives in which server.
//
// IA commands (cases, tickets, quota, LOA, sync) belong to the Internal Affairs
// server. MET commands (Roblox group administration) belong to the MET server.
// Nothing is registered in both — a stray IA command in the MET server leaks
// disciplinary tooling to people who should never see it.
const ALL = [
  require('../commands/discipline'),
  require('../commands/check-record'),
  require('../commands/xp'),
  require('../commands/loa'),
  require('../commands/ia'),
  require('../commands/submit-case'),
  require('../commands/leaderboard'),
  require('../commands/sync'),
  require('../commands/qp').addQp,
  require('../commands/qp').removeQp,
  require('../commands/pendingjoin'),
  require('../commands/promote'),
  require('../commands/panel'),
];

// Temporarily hidden from Discord; command implementations remain in place.
// Remove names from this set to restore their slash-command registration.
const DISABLED_COMMANDS = new Set(['add-qp', 'leaderboard', 'remove-qp', 'submit-case', 'undo']);

const SCOPES = ['ia', 'met'];

// A missing scope is a programming error, not a default — fail at boot rather
// than silently registering something in the wrong server.
for (const c of ALL) {
  if (!SCOPES.includes(c.scope)) {
    throw new Error(`Command /${c.data?.name} has no valid scope (${SCOPES.join(' / ')})`);
  }
}

const ENABLED = ALL.filter(c => !DISABLED_COMMANDS.has(c.data.name));
const forScope = (scope) => ENABLED.filter(c => c.scope === scope);

module.exports = { ALL, ENABLED, forScope, SCOPES, IA: forScope('ia'), MET: forScope('met') };
