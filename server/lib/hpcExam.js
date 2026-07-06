// server/lib/hpcExam.js
// Metropolitan Police Final Examination — question definition, scoring rules,
// and server-side computation of anti-cheat / AI-usage flags from the signals
// the exam page collects while a cadet takes the test.
//
// The marker assigns points per question (0..points); pass = >= PASS_PERCENT of
// the total. Edit QUESTIONS to change the paper; everything else derives from it.

const PASS_PERCENT = 80;

// type: 'short' (one line) | 'paragraph' (multi-sentence) | 'choice' | 'agreement'
const QUESTIONS = [
  { id: 'roblox_username',    type: 'short',     points: 2, required: true,  prompt: 'Roblox Username:' },
  { id: 'discord_username',   type: 'short',     points: 2, required: true,  prompt: 'Discord Username:' },
  { id: 'arrest_speech',      type: 'paragraph', points: 2, required: true,  minSentences: 2,
    prompt: 'When patrolling, Jamal Smith stops you, stares at you, verbally assaults you, then spits on you. After dealing with the situation, what do you say to the suspect when you are arresting them?' },
  { id: 'drive_vehicle',      type: 'choice',    points: 2, required: true,  options: ['Yes', 'No'],
    prompt: 'When patrolling as a Community Support Officer or a Constable, are you allowed to drive any vehicle or scooter?' },
  { id: 'patrol_alone',       type: 'choice',    points: 2, required: true,  options: ['Yes', 'No'],
    prompt: 'When hired as a Community Support Officer, can you patrol alone?' },
  { id: 'cso_firearm',        type: 'choice',    points: 2, required: true,  options: ['Yes', 'No'],
    prompt: 'Can a Community Support Officer use a firearm?' },
  { id: 'tasing_warning',     type: 'short',     points: 2, required: true,
    prompt: 'When tasing a suspect, what are you required to say?' },
  { id: 'holstered_arrest',   type: 'choice',    points: 2, required: true,  options: ['Yes', 'No', 'Maybe'],
    prompt: 'If someone has their gun holstered, can you arrest them?' },
  { id: 'revolver',           type: 'paragraph', points: 2, required: true,  minSentences: 2,
    prompt: 'When patrolling, a suspect points a loaded revolver at you. How will you handle the situation? Your life may be at harm…' },
  { id: 'frisk_cause',        type: 'choice',    points: 2, required: true,  options: ['Probable Cause', 'Reasonable Suspicion'],
    prompt: 'A known thug, Jamal Smith, is with local gang members and criminals. He approaches you and looks violent. You are able to detain and frisk him on the basis of?' },
  { id: 'rifle_store',        type: 'paragraph', points: 2, required: true,  minSentences: 2,
    prompt: 'There is a fella standing outside of a store with a massive rifle holstered. He looks suspicious. What step would you take next?' },
  { id: 'shooter_booking',    type: 'paragraph', points: 2, required: true,  minSentences: 2,
    prompt: 'You saw a shooter outside the Police Station. Someone similar-looking is sitting in the Booking area with a Glock on his hip. What would you do?' },
  { id: 'chain_of_command',   type: 'paragraph', points: 2, required: false,
    prompt: 'List the Chain of Command starting from Commissioner and below.' },
  { id: 'shoes',              type: 'choice',    points: 2, required: true,  options: ['Black', 'White', 'Any shoes.'],
    prompt: 'What shoes should you be wearing when patrolling?' },
  { id: 'agreement',          type: 'agreement', points: 2, required: true,
    prompt: 'Put your username below agreeing to the terms for Hendon Police College with the format: "I (USERNAME) Agree that I will not leak this exam or cheat and use help with Google or a friend for this exam or I will be blacklisted and banned."' },
];

function totalPoints() { return QUESTIONS.reduce((s, q) => s + q.points, 0); }
function passMark()    { return Math.ceil(totalPoints() * PASS_PERCENT / 100); }
function questionById(id) { return QUESTIONS.find(q => q.id === id) || null; }

// Client-safe paper (no answer keys are stored here — marking is manual).
function publicPaper() {
  return {
    title: 'Metropolitan Police Final Examination',
    subtitle: 'Professionalism, Uniform, and Respect.',
    passPercent: PASS_PERCENT,
    total: totalPoints(),
    rules: [
      'Cheating will result in a blacklist.',
      'Any use of Google or AI will result in a blacklist.',
      'Do not beg for results to be read or you will be blacklisted.',
      'Grammar is needed, for the betterment of your score.',
      'LEAKING THIS EXAM WILL RESULT IN A BLACKLIST!!!',
    ],
    questions: QUESTIONS.map(q => ({
      id: q.id, type: q.type, points: q.points, required: q.required,
      options: q.options || null, minSentences: q.minSentences || null, prompt: q.prompt,
    })),
  };
}

// ── Anti-cheat / AI-usage flags ──────────────────────────────────────
// Computed server-side from the raw `detection` telemetry the exam page sends,
// so markers get plain-English warnings. Best-effort (a determined cheat can
// tamper with client signals), but catches the common cases: pasting answers,
// tab-switching to Google, instant AI paste, devtools, etc.
// Heuristic AI-writing detector for free-text answers. Returns { score, reasons }.
// Deliberately conservative for short in-character police answers to avoid
// punishing genuinely tidy writers — a flag needs multiple independent tells.
function aiWritingSignals(text) {
  const reasons = [];
  let score = 0;
  const t = String(text);
  const lower = t.toLowerCase();

  // 1) Phrases strongly associated with LLM output / essay register.
  const tells = [
    /\bas an ai\b/, /\blanguage model\b/, /\bit(?:'|’| i)s important to (?:note|remember|understand)\b/,
    /\bfurthermore\b/, /\bmoreover\b/, /\bin conclusion\b/, /\bit is worth noting\b/,
    /\bensure(?:s|d)? the safety and well-?being\b/, /\bde-?escalat/, /\bmaintain(?:ing)? (?:composure|professionalism)\b/,
    /\bfirstly\b[\s\S]*\bsecondly\b/, /\bin accordance with (?:established )?protocol/,
  ];
  const hit = tells.filter(re => re.test(lower));
  if (hit.length >= 2) { score += 2; reasons.push(`${hit.length} essay/LLM-style phrases`); }
  else if (hit.length === 1) { score += 1; reasons.push('an essay/LLM-style phrase'); }

  // 2) Typographic tells not produced by plain textarea typing: em-dashes,
  //    curly quotes — usually copied from a word processor or AI output.
  if (/[—]/.test(t)) { score += 1; reasons.push('em-dashes (—)'); }
  if (/[‘’“”]/.test(t)) { score += 1; reasons.push('curly quotes'); }

  // 3) Low burstiness: AI produces uniform sentence lengths; humans vary a lot.
  const sentences = t.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 0);
  if (sentences.length >= 3) {
    const lens = sentences.map(s => s.split(/\s+/).length);
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    const variance = lens.reduce((a, b) => a + (b - mean) * (b - mean), 0) / lens.length;
    const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
    if (mean >= 10 && cv < 0.25) { score += 1; reasons.push('uniform sentence lengths (low burstiness)'); }
  }

  return { score, reasons };
}

function computeFlags(answers, detection) {
  const flags = [];
  const d = detection || {};
  const per = d.perQuestion || {};

  const add = (severity, code, label, detail) => flags.push({ severity, code, label, detail: detail || null });

  // Per-answer: pasting / autofill on written questions.
  for (const q of QUESTIONS) {
    if (q.type !== 'paragraph' && q.type !== 'short') continue;
    const pq = per[q.id] || {};
    const ans = (answers && answers[q.id]) || '';
    const text = String(ans).trim();
    const len = text.length;
    if ((pq.pastedChars || 0) > 0) {
      add('high', 'paste', `Pasted into "${q.id}"`, `${pq.pastedChars} characters pasted (${pq.pasteCount || 1} paste${(pq.pasteCount || 1) > 1 ? 's' : ''}).`);
    } else if (len >= 25 && (pq.keystrokes || 0) < len * 0.5) {
      add('high', 'autofill', `"${q.id}" likely auto-filled`, `Answer is ${len} chars but only ${pq.keystrokes || 0} keystrokes were recorded (typical of paste / autofill).`);
    }
    // Very fast, long, "written" answer → possible pre-written/AI paste.
    if (len >= 60 && (pq.activeMs || 0) > 0 && (pq.activeMs || 0) < 4000) {
      add('medium', 'fast_answer', `"${q.id}" written very fast`, `${len} chars in ${(pq.activeMs / 1000).toFixed(1)}s of focus.`);
    }

    // AI-writing heuristics on the answer text itself (works even if the cadet
    // retyped an AI answer by hand, which the paste/keystroke checks miss).
    if (q.type === 'paragraph' && len >= 40) {
      const ai = aiWritingSignals(text);
      if (ai.score >= 3) {
        add('high', 'ai_writing', `"${q.id}" reads as AI-generated`, `AI-writing signals: ${ai.reasons.join('; ')}.`);
      } else if (ai.score === 2) {
        add('medium', 'ai_writing', `"${q.id}" may be AI-assisted`, `Possible AI-writing signals: ${ai.reasons.join('; ')}.`);
      }
    }

    // Keystroke-cadence biometrics: superhuman sustained speed, or an
    // unnaturally uniform rhythm (bot / macro / paste-and-edit). Uses optional
    // per-question cadence telemetry when the exam page provides it.
    if (len >= 40) {
      const active = pq.activeMs || 0;
      if (active >= 1000 && (pq.pastedChars || 0) === 0) {
        const cps = len / (active / 1000);
        if (cps > 13) add('high', 'superhuman_typing', `"${q.id}" typed impossibly fast`, `${cps.toFixed(1)} chars/sec sustained over ${len} chars — beyond human typing.`);
      }
      // Coefficient of variation of inter-keystroke gaps: human typing is bursty
      // (cv typically > 0.5); a near-constant rhythm suggests automation.
      if (typeof pq.cadenceCv === 'number' && (pq.keystrokes || 0) >= 30 && pq.cadenceCv < 0.18) {
        add('medium', 'robotic_cadence', `"${q.id}" typed with robotic rhythm`, `Keystroke timing was near-uniform (cv ${pq.cadenceCv.toFixed(2)}), unusual for natural typing.`);
      }
    }
  }

  // Global signals.
  if ((d.blurCount || 0) >= 3) {
    add('high', 'tab_switch', 'Left the exam repeatedly', `Left/blurred the exam ${d.blurCount} times (${Math.round((d.blurMs || 0) / 1000)}s away) — possible external lookup (Google/AI).`);
  } else if ((d.blurCount || 0) >= 1) {
    add('medium', 'tab_switch', 'Left the exam', `Left/blurred the exam ${d.blurCount} time(s) (${Math.round((d.blurMs || 0) / 1000)}s away).`);
  }
  if (d.devtoolsOpened)               add('high',   'devtools', 'Developer tools opened', 'Browser devtools were detected open during the exam.');
  if ((d.copyCount || 0) > 0)         add('medium', 'copy', 'Copied exam text', `Copied from the exam ${d.copyCount} time(s) — possible leaking.`);
  if ((d.contextMenuCount || 0) > 0)  add('low',    'context_menu', 'Right-click used', `Right-click menu opened ${d.contextMenuCount} time(s).`);
  if ((d.pasteBlockedCount || 0) > 0) add('medium', 'paste_attempt', 'Paste attempts', `Attempted to paste ${d.pasteBlockedCount} time(s) into non-answer areas.`);

  const totalMs = d.totalMs || 0;
  if (totalMs > 0 && totalMs < 90 * 1000) {
    add('medium', 'too_fast', 'Finished suspiciously fast', `Whole exam completed in ${Math.round(totalMs / 1000)}s.`);
  }

  return flags;
}

module.exports = { QUESTIONS, PASS_PERCENT, totalPoints, passMark, questionById, publicPaper, computeFlags };
