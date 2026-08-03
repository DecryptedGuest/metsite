// server/lib/iaApplication.js
// The Internal Affairs application — the paper, as data.
//
// A structural twin of lib/hpcExam.js, deliberately NOT importing it. The two
// papers change for different reasons at different times, and a shared question
// list would mean editing the Hendon exam to add an IA question.
//
// This file is only the paper and the rules for reading it. No database, no
// routes, no HTTP. That is what makes it testable, and it is the piece the rest
// of the system is built on: the form renders from SECTIONS, the validator runs
// the same functions on the client and the server, and the marking view reads the
// same structure with the guidance attached.
//
// ── Six sections, as written ──────────────────────────────────────
//
// hpcExam is a flat array because the Hendon exam is one page. This is six, so
// the unit is a SECTION with questions inside it, numbered 1..6 to match what the
// applicant is told ("Section 3 of 6"). `flatQuestions()` flattens for the places
// that want every question at once — validation, scoring, the marking view.
//
// ── Two views of the same paper, and why that matters ─────────────
//
// `publicPaper()` is what the applicant is sent. `markerPaper()` is what a
// Deputy Director is sent, and it carries `guidance` and `correct` — what a good
// answer contains, and the right answer to a multiple-choice question. Those must
// NEVER reach the applicant: handing somebody the marking key turns an
// examination into a comprehension test. publicPaper() therefore builds its
// output by NAMING the fields it includes rather than by deleting the ones it
// doesn't, so a marker-only field added below is private by default instead of
// leaking the first time somebody forgets.
//
// ── What is not asked ─────────────────────────────────────────────
//
// Anything the site already knows is captured rather than typed. The Discord
// identity comes from the session; the Roblox identity from the linked account;
// the timezone from the browser; the device from the user agent. A typed Discord
// username is a free-text field that can name somebody else, and asking for a
// timezone in a text box gets you "GMT+1 i think".
//
// Age is the exception: there is no honest way to detect it, so it is declared —
// and it is on section one, because a fifteen-year-old minimum checked at the end
// is six sections of somebody's evening wasted.

// ── Answer types ──────────────────────────────────────────────────
//   short      one line
//   paragraph  several sentences or a word count, with a minimum (and sometimes a maximum)
//   choice     one of `options`
//   multi      any of `options`
//   agreement  a tick against `statement`
//   typed      they must type `expect` (or `expectTemplate`) out — a signature, not a checkbox
const TYPES = ['short', 'paragraph', 'choice', 'multi', 'agreement', 'typed'];

// The longest any single answer may be. Generous — a scenario answer can
// legitimately run long — but bounded, because an unbounded text field is a way
// to put a megabyte in the database.
const MAX_CHARS = 5000;

// Six sections, numbered from 1, the way the applicant is told.
const EXPECTED_PAGES = 6;

// The mark needed to pass. The same 80% the Hendon exam uses, and overridable,
// because "we are very selective" is a policy that can change without a deploy.
const PASS_PERCENT = () => {
  const n = parseInt(process.env.IA_APP_PASS_PERCENT, 10);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : 80;
};

// Every marked question is worth the same. Nothing in this paper is obviously
// worth more than anything else in it, and a weighting invented here would be a
// judgement the department never made.
const POINTS_PER_QUESTION = 2;
const P = POINTS_PER_QUESTION;

// ── The notices ───────────────────────────────────────────────────
// The applicant's own words, kept as their own words. These are the terms of the
// thing — the record that somebody was told AI use gets them blacklisted — so
// they are quoted, not paraphrased.
const GUIDELINES = [
  'Answer every question with full grammar. Not using proper grammar can fail the application.',
  'No troll applications. They result in punishment.',
  'Respect the MINIMUM word count on every question.',
  'Give as much detail as you can. It is the single biggest thing in your favour.',
  'Do not cut sentences short. A cut-off sentence does not count as a sentence.',
  'Have activity within MET.',
  'Understand MET policy and regulations.',
  'No strikes or punishments in the past week.',
  'You must be 15 or over to be in Internal Affairs.',
  'Maturity and professionalism are a must.',
];

const NOTICES = [
  { tone: 'danger',  text: 'This application is CLASSIFIED. Do not share this document, or any question in it, '
                         + 'anywhere. Doing so is a disciplinary matter.' },
  { tone: 'danger',  text: 'Using Artificial Intelligence on this application will get you BLACKLISTED from MET. '
                         + 'This is an official exam and it is treated as one.' },
  { tone: 'warning', text: 'Trolling this application results in disciplinary action.' },
  { tone: 'info',    text: 'Internal Affairs is demanding, and it needs you to be genuinely active.' },
  { tone: 'info',    text: 'Officers with NO division get first pick. Anybody already in a division is '
                         + 'considered after them.' },
];

// ── The paper ─────────────────────────────────────────────────────
const SECTIONS = [
  {
    id: 'about_you',
    page: 1,
    title: 'About you',
    // No `heading` on purpose: the page's own hero already says "Internal Affairs
    // Application", and repeating it here put the same words twice on one screen.
    blurb: 'Thanks for your interest in Internal Affairs. We are very selective — there are only '
         + 'so many places. If you are serious about this, put the effort in and read the guidelines '
         + 'below before you start.\n\n'
         + 'Apply to become an Internal Affairs investigator, deal with the corruption, and support '
         + 'MET where it counts.',
    guidelines: GUIDELINES,
    notices: NOTICES,
    // Most of this section is filled in for them, so say so rather than
    // presenting four boxes and hoping.
    note: 'Most of this is already filled in from your account. Check it is right, and answer the two that are not.',
    questions: [
      // ── Captured, not asked ──────────────────────────────────────
      // Still QUESTIONS in the schema, because the marking view has to show them
      // and the record has to keep them. `captured` means the form renders them
      // read-only and the server fills them in: an applicant cannot type a
      // different person's Discord name into their own application.
      { id: 'discord_username', type: 'short', required: true, points: 0, captured: 'discord',
        prompt: 'Discord username',
        help: 'Taken from the account you signed in with. If this is the wrong account, sign out and back in.' },
      { id: 'roblox_username', type: 'short', required: true, points: 0, captured: 'roblox',
        prompt: 'Roblox username',
        help: 'Taken from your linked Roblox account. Check the avatar shown is you.' },
      { id: 'timezone', type: 'short', required: true, points: 0, captured: 'timezone',
        // Editable, unlike the two above. A VPN or a shared computer can report
        // the wrong zone, and the marker uses this to arrange an interview — so a
        // wrong one costs a real appointment. Whether it was edited is recorded.
        editable: true,
        prompt: 'Your timezone',
        help: 'Detected from your browser. Change it if it is wrong.' },
      { id: 'device', type: 'short', required: false, points: 0, captured: 'device',
        prompt: 'Device you are applying from',
        help: 'Detected. Context for the marker; it is not marked.' },

      // ── Declared, because nothing can honestly detect it ─────────
      { id: 'age_band', type: 'choice', required: true, points: 0,
        // The original form offered ">14" and "15+", which are the same answer
        // written twice — anybody over 14 is 15 or over. Three bands instead:
        // it asks one question rather than two pretending to be one, "Under 15"
        // becomes a stop instead of an answer nobody could give honestly, and a
        // marker reading "15 to 17" learns something.
        options: ['18 or over', '15 to 17', 'Under 15'],
        prompt: 'How old are you?',
        help: 'Internal Affairs has a minimum age of 15. Answer honestly; it is checked at interview.' },
      { id: 'platform', type: 'choice', required: true, points: 0,
        options: ['PC', 'Mobile', 'Console'],
        prompt: 'What do you play Roblox on?',
        // The auto-detected device does NOT answer this. Somebody who plays on an
        // Xbox is applying from a phone or a laptop, so the user agent says
        // "Safari on iPhone" while the honest answer is Console. Two different
        // facts, which is why this one is still asked.
        help: 'What you actually play on, not what you are filling this in on.' },
    ],
  },

  {
    id: 'questionnaire',
    page: 2,
    title: 'Questionnaire',
    heading: 'Internal Affairs Questionnaire',
    note: 'Every question here has a minimum word count. The form will not let you go on until you have met it.',
    questions: [
      { id: 'why_ia', type: 'paragraph', required: true, points: P, minWords: 80,
        prompt: 'Why do you want to become a member of Internal Affairs?' },
      { id: 'what_offer', type: 'paragraph', required: true, points: P, minWords: 60,
        prompt: 'What do you have to offer the Internal Affairs team?' },
      { id: 'what_improve', type: 'paragraph', required: true, points: P, minWords: 60,
        prompt: 'What do you think you could help improve within MET as part of Internal Affairs?' },
      { id: 'two_skills', type: 'paragraph', required: true, points: P, minWords: 60,
        prompt: 'Name two skills of yours that would benefit Internal Affairs, and explain why.' },
    ],
  },

  {
    id: 'activity',
    page: 3,
    title: 'Activity',
    heading: 'Internal Affairs Activity',
    note: 'Be specific. "Quite active" tells a marker nothing, and vagueness here is what fails people.',
    questions: [
      { id: 'activity_rating', type: 'paragraph', required: true, points: P, minWords: 15,
        prompt: 'How would you rate your activity out of 10, and why that number?',
        help: 'Give the number and then justify it. Do not be vague.' },
      { id: 'upcoming_events', type: 'paragraph', required: false, points: P, minWords: 10,
        // Not required in the original, and left that way: somebody with nothing
        // coming up has nothing to write, and forcing them to invent something is
        // worse than an empty box. Answering it honestly still earns the marks.
        prompt: 'Is anything coming up that would get in the way of your activity in Internal Affairs?',
        help: 'Exams, holidays, work — anything. Saying so counts in your favour, not against you. '
            + 'Leave it blank if there is genuinely nothing.' },
      { id: 'time_spent', type: 'paragraph', required: true, points: P, minWords: 15,
        prompt: 'On average, how much time do you spend on Roblox and on Discord?',
        help: 'Hours per day or per week, on each. Do not be vague.' },
    ],
  },

  {
    id: 'multiple_choice',
    page: 4,
    title: 'Multiple choice',
    heading: 'Internal Affairs Multiple Choice',
    note: 'One answer each. Answer to the best of your ability.',
    questions: [
      // ── The answer key ────────────────────────────────────────────
      // `correct` is deliberately ABSENT on every question here, not guessed.
      //
      // These have objectively right answers, and auto-marking them would save a
      // Deputy Director real time — but only if the key is right. A key invented
      // by whoever wrote this file would fail honest applicants on the strength of
      // a guess, and they would never know why. So until somebody who knows the
      // penal codes fills them in, every one of these is marked by hand like the
      // rest of the paper. `answerKeyStatus()` reports which are still unset.
      //
      // `correct` is not in PUBLIC_QUESTION_FIELDS, so adding one cannot leak it
      // to the applicant.
      { id: 'mc_director', type: 'choice', required: true, points: P,
        options: ['Nobody', 'FNTDrippy', 'iicast', 'NobleSoop', 'AkzX', 'White_Bullet8', 'Rudy', 'FNTClout', 'Rodzina'],
        prompt: 'Who is currently the Director of Internal Affairs?' },
      { id: 'mc_blacklist', type: 'choice', required: true, points: P,
        options: ['Yes', 'No', "Only if the person they're blacklisting is an SAS member"],
        prompt: 'Are Internal Affairs agents allowed to blacklist personnel from MET?' },
      { id: 'mc_code_zfb101', type: 'choice', required: true, points: P,
        options: ['Gang Affiliation', 'Discrimination', 'Inappropriate Behaviour', 'Falsifying an Official Exam / AI Usage'],
        prompt: 'Penal code ZF-B101 means:' },
      { id: 'mc_code_plm303', type: 'choice', required: true, points: P,
        options: ['General Misconduct', 'Improper Use of Channels', 'Violation of Uniform Regulations', 'Asking for Promotions'],
        prompt: 'Penal code PL-M303 means:' },
      { id: 'mc_code_mcs215', type: 'choice', required: true, points: P,
        options: ['Random Frisking/Cuffing', 'Arbitrary Arrest', 'Cufftapping', 'Failing to follow IA orders'],
        prompt: 'Penal code MC-S215 means:' },
      { id: 'mc_immune', type: 'choice', required: true, points: P,
        options: ['True', 'False', "Only if the person they're abusing is a low rank"],
        prompt: 'Internal Affairs agents may violate any Disciplinary Action, because they are immune.' },
    ],
  },

  {
    id: 'written',
    page: 5,
    title: 'Written exam',
    heading: 'Internal Affairs Written Exam',
    note: 'Between 50 and 100 words each. Under 50 will not pass; over 100 and you are padding, '
        + 'so say it in the space given.',
    questions: [
      { id: 'sc_friend_report', type: 'paragraph', required: true, points: P, minWords: 50, maxWords: 100,
        prompt: 'A player opens an Officer Report ticket about your friend. You can see your friend was '
              + 'abusing, but you might be biased. What do you do?' },
      { id: 'sc_false_case', type: 'paragraph', required: true, points: P, minWords: 50, maxWords: 100,
        prompt: 'You notice an Internal Affairs agent building a biased and false case. What do you do?' },
      { id: 'sc_cufftapping', type: 'paragraph', required: true, points: P, minWords: 50, maxWords: 100,
        prompt: 'While patrolling in-game you spot a Constable, in no division, cuff-tapping citizens for '
              + 'no reason. What do you do?' },
      { id: 'sc_strike_favour', type: 'paragraph', required: true, points: P, minWords: 50, maxWords: 100,
        prompt: 'You are in a MET voice channel and you hear another Internal Affairs agent telling their '
              + 'friend they will remove their strike because they are friends. What do you do?' },
    ],
  },

  {
    id: 'declaration',
    page: 6,
    title: 'Declaration',
    heading: 'Internal Affairs Submission',
    blurb: 'Thank you for the time and effort you have put into this.\n\n'
         + 'Before you submit, go back and read your answers through. You cannot change them afterwards.',
    questions: [
      // Typed, not ticked, and carrying their OWN name — which is why these are
      // templates. A checkbox is one click and means nothing; writing the sentence
      // out with your name in it is a deliberate act, and it is the thing that
      // gets quoted back if an application turns out to be dishonest.
      { id: 'agree_unbiased', type: 'typed', required: true, points: 0,
        expectTemplate: 'I {username} agree to remain unbiased and fair in every decision I make '
                      + 'while employed within Internal Affairs.',
        prompt: 'Type this out, exactly as it appears, with your username already filled in.' },
      { id: 'agree_no_ai', type: 'typed', required: true, points: 0,
        // Required, where the original form left the asterisk off. An optional
        // "I did not use AI" declaration is not a declaration — and this paper
        // says three separate times that AI use means a blacklist, so leaving it
        // skippable would be the one place the application contradicts itself.
        expectTemplate: 'I {username} agree that I have not used any Artificial Intelligence on this '
                      + 'application. If I have, I may be blacklisted from MET.',
        // Every prompt has to stand on its own, because it is quoted back in the
        // "not finished yet" list. "And this one." read as a complete non-sequitur
        // there — a refusal that names the question it is about only helps if the
        // name means something.
        prompt: 'Now type the Artificial Intelligence declaration out, the same way.' },
    ],
  },
];

// ── Reading the paper ─────────────────────────────────────────────

/** Every question, in section order, flattened. */
function flatQuestions() {
  return SECTIONS
    .slice()
    .sort((a, b) => a.page - b.page)
    .flatMap(s => s.questions.map(q => ({ ...q, sectionId: s.id, page: s.page })));
}

function questionById(id) {
  return flatQuestions().find(q => q.id === id) || null;
}

/** The marks available. Identity and the declarations carry none. */
function totalPoints() {
  return flatQuestions().reduce((n, q) => n + (q.points || 0), 0);
}

/** The mark needed to pass, rounded up — 80% of 34 is 27.2, so 28. */
function passMark() {
  return Math.ceil(totalPoints() * PASS_PERCENT() / 100);
}

/** Which sections exist, and whether the paper is finished. */
function isComplete() {
  const pages = [...new Set(SECTIONS.map(s => s.page))].sort((a, b) => a - b);
  const want = Array.from({ length: EXPECTED_PAGES }, (_, i) => i + 1);
  return {
    pages,
    expected: EXPECTED_PAGES,
    complete: want.every(p => pages.includes(p)),
    missing: want.filter(p => !pages.includes(p)),
  };
}

/**
 * How much of the multiple-choice section can be marked automatically.
 *
 * Reported rather than assumed, because the answer key is not something this file
 * is allowed to invent. Until it is filled in, those questions are marked by hand
 * like the rest — which is correct, just slower.
 */
function answerKeyStatus() {
  const mc = flatQuestions().filter(q => q.type === 'choice' && q.points > 0);
  const keyed = mc.filter(q => q.correct != null);
  return {
    total: mc.length,
    keyed: keyed.length,
    unkeyed: mc.filter(q => q.correct == null).map(q => q.id),
    canAutoMark: keyed.length > 0,
    complete: mc.length > 0 && keyed.length === mc.length,
  };
}

/**
 * Mark the multiple-choice answers that have a key. Returns { scores, marked }.
 * A question with no key is left out entirely rather than scored zero — an
 * unmarked question is a job for a person, not a fail.
 */
function autoMark(answers) {
  const a = answers && typeof answers === 'object' ? answers : {};
  const scores = {};
  let marked = 0, right = 0;
  for (const q of flatQuestions()) {
    if (q.type !== 'choice' || !q.points || q.correct == null) continue;
    if (!(q.id in a)) continue;
    const correct = String(a[q.id]) === String(q.correct);
    scores[q.id] = correct ? q.points : 0;
    marked++;
    if (correct) right++;
  }
  return { scores, marked, right };
}

// The fields an applicant may see. Named explicitly rather than deleted from a
// copy, so a marker-only field added to a question later is private by default
// instead of leaking the first time somebody forgets to exclude it.
//
// NOT in this list, and that is the point: `correct`, `guidance`, `lookFor`.
const PUBLIC_QUESTION_FIELDS = [
  'id', 'type', 'required', 'prompt', 'help', 'options', 'statement',
  'expect', 'expectTemplate',
  'minSentences', 'minWords', 'maxWords', 'maxChars', 'captured', 'editable', 'placeholder',
];

const PUBLIC_SECTION_FIELDS = ['id', 'page', 'title', 'heading', 'blurb', 'note', 'guidelines', 'notices'];

/** The paper as the applicant receives it. No answer key, no marking notes. */
function publicPaper() {
  return {
    sections: SECTIONS
      .slice()
      .sort((a, b) => a.page - b.page)
      .map(s => {
        const out = {};
        for (const f of PUBLIC_SECTION_FIELDS) if (s[f] !== undefined) out[f] = s[f];
        out.questions = s.questions.map(q => {
          const qo = {};
          for (const f of PUBLIC_QUESTION_FIELDS) if (q[f] !== undefined) qo[f] = q[f];
          qo.maxChars = q.maxChars || MAX_CHARS;
          return qo;
        });
        return out;
      }),
    pages: isComplete(),
  };
}

/** The paper as a marker receives it — everything, key and guidance included. */
function markerPaper() {
  return {
    sections: SECTIONS.slice().sort((a, b) => a.page - b.page),
    totalPoints: totalPoints(),
    passMark: passMark(),
    passPercent: PASS_PERCENT(),
    pages: isComplete(),
    answerKey: answerKeyStatus(),
  };
}

// ── The declarations ──────────────────────────────────────────────

/**
 * The sentence an applicant has to type, with their own name in it.
 *
 * Kept here rather than in the form so the server checks the same string it asked
 * for. A declaration whose wording differs between what was shown and what was
 * validated is a declaration nobody signed.
 */
function expectedFor(q, username) {
  if (!q) return null;
  if (q.expect) return q.expect;
  if (!q.expectTemplate) return null;
  const name = String(username == null ? '' : username).trim();
  return q.expectTemplate.replace(/\{username\}/g, name || '{username}');
}

// ── Counting ──────────────────────────────────────────────────────
// The same two functions run on the client (for the live counter) and on the
// server (for validation). If they disagree, somebody sees "82 words" next to a
// refusal saying they wrote 79, and stops trusting the form.

function countWords(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return 0;
  return s.split(/\s+/).filter(Boolean).length;
}

/**
 * Sentences, counted the way a person would.
 *
 * Terminators, but only ones that actually end something: a full stop inside
 * "e.g." or "3.5" is not the end of a sentence, and a run of "!!!" is one ending,
 * not three. A final sentence with no full stop still counts — plenty of people
 * don't punctuate the last one, and refusing an otherwise good answer over a
 * missing dot would be pedantry with consequences.
 */
function countSentences(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return 0;
  const cleaned = s
    // Decimals: "3.5" is not two sentences.
    .replace(/(\d)[.,](\d)/g, '$1$2')
    // Common abbreviations, before the terminator hunt.
    .replace(/\b(?:e\.g|i\.e|etc|mr|mrs|ms|dr|vs|approx|no)\./gi, ' ')
    // Ellipses and runs of terminators are one ending.
    .replace(/[.!?]{2,}/g, '.');
  const parts = cleaned.split(/[.!?]+(?:\s|$)/).map(x => x.trim()).filter(Boolean);
  // A single word between full stops is not a sentence — "Yes. No. Maybe." is
  // somebody padding to reach a minimum, not three sentences.
  //
  // Two words IS one, though. The first version of this required three and
  // therefore scored "One here. Two here. Three here." as ZERO sentences, which
  // would have refused a real answer for not existing. Padding is guarded against
  // by minWords instead, which is the right tool for it: this function's only job
  // is to count sentences honestly.
  return parts.filter(p => countWords(p) >= 2).length;
}

// ── Validation ────────────────────────────────────────────────────

/**
 * Everything wrong with a set of answers.
 *
 * Four separate lists, because they are four different conversations:
 *   missing   they have not answered it
 *   tooShort  they answered it, but not enough
 *   tooLong   they answered it, and overran a stated maximum
 *   wrong     not one of the options, or the declaration does not match
 *
 * The word counts are enforced by REFUSING TO GO ON rather than by failing the
 * application. The paper says an unmet minimum is an instant failure, and this is
 * the same rule applied earlier and more kindly: somebody who is 12 words short
 * should be told while they can still fix it, not marked down for it afterwards.
 *
 * @returns {{ ok, missing, tooShort, tooLong, wrong, stop }}
 */
function validate(answers, opts = {}) {
  const a = answers && typeof answers === 'object' ? answers : {};
  const missing = [], tooShort = [], tooLong = [], wrong = [];

  // The hard stop comes first and short-circuits everything. Telling a
  // fourteen-year-old that their application is refused AND that section four is
  // incomplete is a form arguing with somebody it has already turned away.
  const stop = stopFor(a);
  if (stop) return { ok: false, missing: [], tooShort: [], tooLong: [], wrong: [], stop };

  // Only the sections being checked. A draft save validates what is filled in; a
  // submit validates the lot.
  const pages = opts.pages == null ? null : [].concat(opts.pages);
  const qs = flatQuestions().filter(q => pages === null || pages.includes(q.page));

  for (const q of qs) {
    // A captured field is filled in by the server. If it is absent that is our
    // failure, not the applicant's, and it must not be reported to them as an
    // unanswered question.
    if (q.captured && !opts.checkCaptured) continue;

    const raw = a[q.id];
    const has = q.type === 'multi'
      ? Array.isArray(raw) && raw.length > 0
      : q.type === 'agreement'
        ? raw === true
        : raw != null && String(raw).trim() !== '';

    if (!has) { if (q.required) missing.push(q.id); continue; }

    if (q.type === 'choice' && Array.isArray(q.options) && !q.options.includes(String(raw))) {
      wrong.push({ id: q.id, why: 'That is not one of the options.' });
      continue;
    }
    if (q.type === 'multi' && Array.isArray(q.options)) {
      const bad = raw.filter(x => !q.options.includes(String(x)));
      if (bad.length) { wrong.push({ id: q.id, why: 'That is not one of the options.' }); continue; }
    }
    if (q.type === 'typed') {
      const want = expectedFor(q, opts.username);
      // Compared on the words, not the whitespace or a final full stop — a
      // declaration that fails because of a trailing space is a form being
      // obstructive about something it can plainly see is right.
      const norm = (v) => String(v).replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim().toLowerCase();
      if (!want) { wrong.push({ id: q.id, why: 'This declaration could not be checked — tell a developer.' }); continue; }
      if (norm(raw) !== norm(want)) {
        wrong.push({ id: q.id, why: 'That does not match the line exactly.', expected: want });
        continue;
      }
    }
    if (q.type === 'paragraph') {
      const words = countWords(raw), sentences = countSentences(raw);
      if (q.minSentences && sentences < q.minSentences) {
        tooShort.push({ id: q.id, need: q.minSentences, got: sentences, unit: 'sentences' });
        continue;
      }
      if (q.minWords && words < q.minWords) {
        tooShort.push({ id: q.id, need: q.minWords, got: words, unit: 'words' });
        continue;
      }
      if (q.maxWords && words > q.maxWords) {
        tooLong.push({ id: q.id, limit: q.maxWords, got: words, unit: 'words' });
        continue;
      }
    }
  }

  return {
    ok: !missing.length && !tooShort.length && !tooLong.length && !wrong.length,
    missing, tooShort, tooLong, wrong, stop: null,
  };
}

/**
 * A reason to end the application immediately, or null.
 *
 * Only one, and it is on section one on purpose: somebody under the minimum age
 * should be told on the first page, kindly, not after an hour of writing. The
 * draft is discarded rather than kept — there is nothing here for them to come
 * back to until their birthday.
 */
function stopFor(answers) {
  const a = answers && typeof answers === 'object' ? answers : {};
  if (String(a.age_band || '') === 'Under 15') {
    return {
      code: 'under_age',
      title: 'You are not old enough to apply yet',
      body: 'Internal Affairs has a minimum age of 15, and that is not something a marker '
          + 'can waive. Nothing you have written has been sent to anybody, and there is no '
          + 'mark against your name — come back when you turn 15 and apply then. '
          + 'In the meantime you can still patrol, attend events and work up the ranks.',
      discardDraft: true,
    };
  }
  return null;
}

/** Trim an answer set to what the paper actually asks, and cap every field. */
function sanitiseAnswers(answers) {
  const a = answers && typeof answers === 'object' ? answers : {};
  const known = new Map(flatQuestions().map(q => [q.id, q]));
  const out = {};
  for (const [id, q] of known) {
    if (!(id in a)) continue;
    const raw = a[id];
    if (q.type === 'agreement') { out[id] = raw === true; continue; }
    if (q.type === 'multi') {
      out[id] = (Array.isArray(raw) ? raw : []).slice(0, 40).map(x => String(x).slice(0, 200));
      continue;
    }
    out[id] = String(raw == null ? '' : raw).slice(0, q.maxChars || MAX_CHARS);
  }
  return out;
}

module.exports = {
  TYPES, MAX_CHARS, EXPECTED_PAGES, PASS_PERCENT, POINTS_PER_QUESTION, SECTIONS,
  GUIDELINES, NOTICES,
  flatQuestions, questionById, totalPoints, passMark, isComplete,
  answerKeyStatus, autoMark, expectedFor,
  publicPaper, markerPaper,
  countWords, countSentences,
  validate, stopFor, sanitiseAnswers,
};
