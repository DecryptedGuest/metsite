// server/lib/gameLog.js
// Helpers for the in-game log feed. The training game sends Adonis command logs
// as the raw command line (action="kick", message=":kick TestCadet spamming")
// without a separate target field, so we derive the target from the command:
// the first argument after the command name. Adonis self-reference keywords
// (e.g. "me") resolve to the command executor and are labelled as such.

// Adonis commands whose first argument is text, not a player — no target here.
const NON_TARGET_CMDS = new Set([
  'm', 'message', 'h', 'hint', 'n', 'notify', 'ntf', 'ss', 'systemmessage',
  'announce', 'sm', 'servermessage', 'gm', 'globalmessage', 'bc', 'broadcast',
  'music', 'sound', 'volume', 'pitch', 'time', 'settime', 'clear', 'cleargame',
  'shutdown', 'countdown', 'timer',
]);

// Adonis "player set" keywords that resolve relative to whoever ran the command.
// Only "me" (the executor) is given a friendly label; others pass through as-is.
function specialTargetLabel(tok) {
  return String(tok).toLowerCase() === 'me' ? '[command executor for "me"]' : null;
}

// The bare command name from the action field (preferred) or the message.
function commandName(action, message) {
  const a = String(action || '').trim().replace(/^[:!;.]+/, '');
  if (a) return a.toLowerCase();
  const m = String(message || '').trim().match(/^[:!;.]?\s*([A-Za-z0-9]+)/);
  return m ? m[1].toLowerCase() : '';
}

// Derive the display target for a game-log row. Returns the game-supplied target
// when present; otherwise, for Adonis command logs, the first argument after the
// command (with "me" shown as the executor). Null when there's no target.
function deriveTarget(row) {
  if (row && row.target) return row.target;
  if (!row || row.source !== 'ADONIS') return (row && row.target) || null;
  const msg = String(row.message || '').trim();
  if (!msg) return null;
  const cmd = commandName(row.action, msg);
  if (!cmd || NON_TARGET_CMDS.has(cmd)) return null;
  // Drop the leading ":cmd " (or "cmd ") so what's left starts with the args.
  const rest = msg.replace(/^[:!;.]?\s*[A-Za-z0-9]+\s+/, '');
  if (rest === msg) return null; // command had no arguments
  const tok = rest.split(/\s+/)[0];
  if (!tok) return null;
  return specialTargetLabel(tok) || tok;
}

module.exports = { deriveTarget, commandName, NON_TARGET_CMDS };
