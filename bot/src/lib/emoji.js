// Central emoji registry.
//
// Every emoji the bot renders is configurable, because custom emoji are
// per-guild and their ids cannot be guessed. Set each one in .env as the full
// Discord token — `<:name:id>` or `<a:name:id>` for animated — and it is used
// verbatim. Anything unset falls back to Unicode so the bot still reads
// correctly before the emoji are uploaded.
//
// To find an id: type \:emojiname: in Discord and send it.
const { env } = require('./env');

const FALLBACK = {
  APPROVE: '✅', DENY: '❌', PENDING: '🕓', WARNING: '⚠️', DENIED_MARK: '⛔',
  CASE: '📋', TICKET: '🎫', POINTS: '📈', LOA: '🌙', EXEMPT: '💤',
  RANK_UP: '⬆️', RANK_DOWN: '⬇️', EXILE: '🚪', BLACKLIST: '🚫',
  IOTW: '⭐', DM: '📬', SYNC: '🔄', DB: '🗄️', CLOCK: '⏱️',
  GOLD: '🥇', SILVER: '🥈', BRONZE: '🥉', BULLET: '•',
};

// Frames for the "working…" spinner. Override with a comma-separated list of
// custom emoji to get a real animation; the default is a Unicode braille spin.
const DEFAULT_SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function e(key) {
  return env(`EMOJI_${key}`) || FALLBACK[key] || '';
}

function spinnerFrames() {
  const raw = env('EMOJI_SPINNER_FRAMES');
  if (!raw) return DEFAULT_SPINNER;
  const frames = raw.split(',').map(s => s.trim()).filter(Boolean);
  return frames.length ? frames : DEFAULT_SPINNER;
}

/**
 * A live "working…" indicator on a deferred interaction.
 *
 * Discord rate-limits message edits, so this ticks at 1.5s rather than per
 * frame of a real animation — fast enough to read as motion, slow enough not
 * to get throttled mid-job. Always call stop() in a finally block.
 */
function startLoading(interaction, label = 'Working') {
  const frames = spinnerFrames();
  let i = 0, live = true, detail = '';

  const render = () => `${frames[i % frames.length]}  **${label}**${detail ? `\n${detail}` : ''}`;
  interaction.editReply(render()).catch(() => {});

  const timer = setInterval(() => {
    if (!live) return;
    i++;
    interaction.editReply(render()).catch(() => {});
  }, 1500);

  return {
    /** Update the sub-line without resetting the spinner. */
    update(text) { detail = text; },
    stop() { live = false; clearInterval(timer); },
  };
}

module.exports = { e, spinnerFrames, startLoading, FALLBACK };
