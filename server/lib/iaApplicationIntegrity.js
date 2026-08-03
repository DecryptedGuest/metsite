// server/lib/iaApplicationIntegrity.js
// What the telemetry actually shows, said as evidence rather than as a score.
//
// ── Why there is no percentage here ───────────────────────────────
//
// The obvious thing to build is "87% likely AI". It would be the single most
// misleading number on the page. Nobody — not us, not any commercial detector —
// can turn "this person typed quickly" into a calibrated probability that they
// cheated, and a number that LOOKS calibrated gets treated as though it is. A
// Deputy Director reading "87%" will refuse the application; a Deputy Director
// reading "1,100 characters arrived in a single paste event, and the answer shows
// 40 keystrokes for 1,100 characters" will go and look, and might discover the
// applicant writes in Notes on their phone.
//
// So every finding is a FACT with the numbers attached, and the severities say how
// much the fact is worth:
//
//   evidence    the fact itself is close to conclusive on its own. A paste
//               happened. The keystroke count cannot produce the character count.
//   suggestive  the fact is consistent with cheating and also consistent with
//               ordinary behaviour, and it should never be decisive alone. Being
//               away from the tab. Writing quickly. Even cadence.
//
// A marker sees both, labelled, and decides. That is the whole design: this
// module's job is to make things visible, not to reach a verdict.

// A person typing flat-out manages perhaps 120 words per minute, which is around
// 10 characters a second, and cannot hold it for long. Well above that is not
// somebody typing.
const SUPERHUMAN_CPS = () => num(process.env.IA_APP_SUPERHUMAN_CPS, 14, 5, 60);
// Below this ratio of keystrokes to characters, the characters did not come from
// the keyboard. 0.4 is generous: it allows for held-down keys, autocomplete,
// mobile predictive text and a lot of copy-editing within the box.
const MIN_KEYSTROKE_RATIO = () => numF(process.env.IA_APP_MIN_KEYSTROKE_RATIO, 0.4, 0.05, 1);
// A paste worth mentioning at all. Small pastes are a name, a rank, a channel id.
const PASTE_CHARS = () => num(process.env.IA_APP_PASTE_CHARS, 60, 5, 5000);

function num(v, dflt, lo, hi) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}
function numF(v, dflt, lo, hi) {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

const secs = (ms) => Math.round((Number(ms) || 0) / 1000);

function human(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

/**
 * Read the telemetry.
 *
 * @param {object} telemetry  what the form recorded
 * @param {object} answers    what was written, so a finding can be sized against it
 * @param {Array}  questions  the paper's questions, for readable labels
 * @returns {{ flags: Array, summary: object }}
 */
function inspect(telemetry, answers, questions) {
  const flags = [];
  const t = telemetry && typeof telemetry === 'object' ? telemetry : null;
  const a = answers && typeof answers === 'object' ? answers : {};
  const label = (id) => {
    const q = (questions || []).find(x => x.id === id);
    if (!q) return id;
    return String(q.prompt || id).slice(0, 70);
  };

  if (!t) {
    return {
      flags: [{
        severity: 'note', code: 'no_telemetry',
        label: 'Nothing was recorded about how this was written',
        detail: 'The application has no telemetry. That happens when it was filed before this was '
              + 'added, or with scripting blocked. It is not itself suspicious, but there is nothing '
              + 'here to check either way.',
      }],
      summary: { hasTelemetry: false },
    };
  }

  // ── Pastes ──────────────────────────────────────────────────────
  // The strongest single fact available, and the reason a sample is kept: a
  // marker should be able to see WHAT was pasted, because a pasted paragraph and
  // a pasted username are not the same event.
  const pastes = (Array.isArray(t.pastes) ? t.pastes : []).filter(p => p && Number(p.chars) >= PASTE_CHARS());
  if (pastes.length) {
    const biggest = pastes.reduce((m, p) => (Number(p.chars) > Number(m.chars) ? p : m), pastes[0]);
    const total = pastes.reduce((n, p) => n + (Number(p.chars) || 0), 0);
    flags.push({
      severity: 'evidence', code: 'paste',
      label: `${pastes.length} paste${pastes.length === 1 ? '' : 's'} of real length, ${total} characters in total`,
      detail: `Largest was ${biggest.chars} characters into "${label(biggest.q)}".`
            + (biggest.sample ? ` It began: “${String(biggest.sample).slice(0, 110)}”` : ''),
      // The whole list, so nothing is hidden behind a summary.
      items: pastes.map(p => ({ question: label(p.q), chars: p.chars, at: p.at, sample: p.sample || null })),
    });
  }

  // ── Keystrokes against characters ───────────────────────────────
  const perQ = t.perQuestion && typeof t.perQuestion === 'object' ? t.perQuestion : {};
  const shortfalls = [], fast = [], quick = [];
  for (const [id, m] of Object.entries(perQ)) {
    if (!m) continue;
    const chars = Number(m.chars) || 0;
    const keys  = Number(m.keystrokes) || 0;
    const ms    = Number(m.ms) || 0;
    if (chars < 120) continue;   // too short to say anything about

    const ratio = keys / chars;
    if (ratio < MIN_KEYSTROKE_RATIO()) {
      shortfalls.push({ question: label(id), chars, keystrokes: keys, ratio: Math.round(ratio * 100) / 100 });
    }
    if (ms > 0) {
      const cps = chars / (ms / 1000);
      if (cps > SUPERHUMAN_CPS()) {
        fast.push({ question: label(id), chars, seconds: secs(ms), cps: Math.round(cps * 10) / 10 });
      } else if (ms < 20000 && chars > 400) {
        // Not superhuman, but 400+ characters in under twenty seconds is worth a
        // second look without being proof of anything.
        quick.push({ question: label(id), chars, seconds: secs(ms) });
      }
    }
  }

  if (shortfalls.length) {
    const worst = shortfalls.reduce((m, s) => (s.ratio < m.ratio ? s : m), shortfalls[0]);
    flags.push({
      severity: 'evidence', code: 'keystrokes_below_chars',
      label: `${shortfalls.length} answer${shortfalls.length === 1 ? '' : 's'} with fewer keystrokes than the text needs`,
      detail: `Worst: "${worst.question}" — ${worst.chars} characters from ${worst.keystrokes} keystrokes `
            + `(${Math.round(worst.ratio * 100)}%). Text that was typed shows roughly one keystroke per character.`,
      items: shortfalls,
    });
  }

  if (fast.length) {
    const worst = fast.reduce((m, s) => (s.cps > m.cps ? s : m), fast[0]);
    flags.push({
      severity: 'evidence', code: 'superhuman_speed',
      label: `${fast.length} answer${fast.length === 1 ? '' : 's'} written faster than anybody types`,
      detail: `Fastest: "${worst.question}" — ${worst.chars} characters in ${worst.seconds}s, `
            + `about ${worst.cps} characters a second. A fast typist manages 10.`,
      items: fast,
    });
  }

  if (quick.length) {
    flags.push({
      severity: 'suggestive', code: 'quick_answer',
      label: `${quick.length} long answer${quick.length === 1 ? '' : 's'} written very quickly`,
      detail: quick.map(x => `"${x.question}": ${x.chars} characters in ${x.seconds}s`).join('; ')
            + '. Possible if they drafted it elsewhere and retyped it, which is allowed.',
      items: quick,
    });
  }

  // ── Time away from the page ─────────────────────────────────────
  // Deliberately `suggestive` and deliberately not "tab switching detected". A
  // six-section form takes most of an hour; people eat, answer the door and look
  // things up. Being away is normal. It is only interesting next to something
  // else, which is exactly how a marker will read it here.
  const away = Number(t.awaySeconds) || 0;
  if (away > 300) {
    flags.push({
      severity: 'suggestive', code: 'time_away',
      label: `Away from the page for ${human(away)} in total`,
      detail: 'Normal on a form this long. Worth reading alongside the other findings rather than on its own.',
    });
  }

  // ── The overall shape ───────────────────────────────────────────
  const totalMs = Object.values(perQ).reduce((n, m) => n + (Number(m && m.ms) || 0), 0);
  const totalChars = Object.values(perQ).reduce((n, m) => n + (Number(m && m.chars) || 0), 0);
  const written = Object.keys(a).length;

  if (totalChars > 800 && totalMs > 0 && totalMs < 120000) {
    flags.push({
      severity: 'suggestive', code: 'whole_thing_fast',
      label: `The whole application took about ${human(secs(totalMs))} of active typing`,
      detail: `${totalChars} characters across ${written} answers. A considered application on this paper `
            + 'is usually a good deal longer than that.',
    });
  }

  return {
    flags,
    summary: {
      hasTelemetry: true,
      startedAt: t.startedAt || null,
      activeTyping: human(secs(totalMs)),
      activeTypingSeconds: secs(totalMs),
      characters: totalChars,
      awaySeconds: away,
      away: human(away),
      pasteCount: pastes.length,
      pastedCharacters: pastes.reduce((n, p) => n + (Number(p.chars) || 0), 0),
      // The two counts a marker will want at a glance.
      evidenceCount: flags.filter(f => f.severity === 'evidence').length,
      suggestiveCount: flags.filter(f => f.severity === 'suggestive').length,
    },
  };
}

module.exports = { inspect, SUPERHUMAN_CPS, MIN_KEYSTROKE_RATIO, PASTE_CHARS };
