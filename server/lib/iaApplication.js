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
// ── Pages, not one long list ──────────────────────────────────────
//
// hpcExam is a flat array of fifteen questions because the Hendon exam is one
// page. This is six, so the unit here is a SECTION with questions inside it, and
// `flatQuestions()` flattens for the places that want every question at once
// (validation, scoring, the marking view).
//
// ── Two views of the same paper, and why that matters ─────────────
//
// `publicPaper()` is what the applicant is sent. `markerPaper()` is what a
// Deputy Director is sent, and it carries `guidance` and `lookFor` — what a good
// answer contains and what should worry you. Those must NEVER reach the
// applicant: handing somebody the marking rubric turns an examination into a
// comprehension test. publicPaper() therefore builds its output by naming the
// fields it includes rather than by deleting the ones it doesn't, so a new
// marker-only field added below is private by default instead of leaking the
// first time somebody forgets.
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
// and it is on page one, because a fifteen-year-old minimum that is checked at
// the end is six pages of somebody's evening wasted.

// ── Answer types ──────────────────────────────────────────────────
//   short      one line
//   paragraph  several sentences, with a minimum
//   choice     one of `options`
//   multi      any of `options`
//   agreement  a tick against `statement`
//   typed      they must type `expect` exactly — a signature, not a checkbox
const TYPES = ['short', 'paragraph', 'choice', 'multi', 'agreement', 'typed'];

// The longest any single answer may be. Generous — a scenario answer can
// legitimately run long — but bounded, because an unbounded text field is a way
// to put a megabyte in the database.
const MAX_CHARS = 5000;

// How many pages the finished paper has. Stated so an incomplete build is
// obvious: `isComplete()` reports it rather than the form quietly ending early.
const EXPECTED_PAGES = 6;

// ── The paper ─────────────────────────────────────────────────────
//
// PAGE 1 is the applicant's own words as supplied. The rest are placeholders
// carrying the questions we already know must exist (the acknowledgements and the
// signature) and nothing invented — a made-up IA question would be marked as
// though the department had asked it.
const SECTIONS = [
  {
    id: 'gate',
    page: 0,
    title: 'Before you start',
    // Page zero is not a question page. It is the record that the applicant was
    // told the two things that get an application thrown out, and it is where the
    // hard stop lives.
    blurb: 'Read these two things. They are the only two that will end an application '
         + 'on their own, and both of them are checked.',
    questions: [
      { id: 'ack_age', type: 'agreement', required: true, points: 0,
        statement: 'I am 15 or over.' },
      { id: 'ack_conduct', type: 'agreement', required: true, points: 0,
        statement: 'I understand that using AI to write this application, or sharing '
                 + 'these questions with anybody, will get me blacklisted from Internal Affairs.' },
    ],
  },
  {
    id: 'about_you',
    page: 1,
    title: 'About you',
    blurb: 'Most of this is already filled in from your account. Check it is right, '
         + 'and answer the two that are not.',
    questions: [
      // ── Captured, not asked ──────────────────────────────────────
      // These are still QUESTIONS in the schema, because the marking view has to
      // show them and the record has to keep them. `captured` means the form
      // renders them read-only and the server fills them in: an applicant cannot
      // type a different person's Discord name into their own application.
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
        help: 'Detected. This is context for the marker, and is not marked.' },

      // ── Declared, because nothing can honestly detect it ─────────
      { id: 'age_band', type: 'choice', required: true, points: 0,
        options: ['18 or over', '15 to 17', 'Under 15'],
        // 'Under 15' is a STOP, handled by stopFor() below rather than by the
        // form remembering to check. Three bands instead of a yes/no because
        // "over 14" and "15+" were two different questions pretending to be one,
        // and because a marker reading "15 to 17" knows something useful.
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

  // ── Pages 2 to 6 ────────────────────────────────────────────────
  // Not yet written. The questions are the examination itself and cannot be
  // guessed: an invented question would be marked as though Internal Affairs had
  // asked it, and an applicant refused over it would be right to complain.
  //
  // Adding a page is one object in this array. Nothing else in the system needs
  // to change — the form, the validator, the marking view and the scoring all
  // read this list.
  {
    id: 'declaration',
    // Deliberately last, whatever the page numbers in between end up being.
    page: EXPECTED_PAGES - 1,
    title: 'Declaration',
    blurb: 'The last thing, and the only one you have to type out.',
    questions: [
      { id: 'signature', type: 'typed', required: true, points: 0,
        // Typed rather than ticked on purpose. A checkbox is one click and means
        // nothing; copying a sentence out is a deliberate act, and it is the
        // thing that gets quoted back if an application turns out to be
        // dishonest.
        expect: 'Everything I have written here is my own work and is true.',
        prompt: 'Type the line below exactly as it appears.' },
    ],
  },
];

// ── Reading the paper ─────────────────────────────────────────────

/** Every question, in page order, flattened. */
function flatQuestions() {
  return SECTIONS
    .slice()
    .sort((a, b) => a.page - b.page)
    .flatMap(s => s.questions.map(q => ({ ...q, sectionId: s.id, page: s.page })));
}

function questionById(id) {
  return flatQuestions().find(q => q.id === id) || null;
}

/** The marks available. Page one carries none: identity is not an examination. */
function totalPoints() {
  return flatQuestions().reduce((n, q) => n + (q.points || 0), 0);
}

/** Which pages exist, and whether the paper is finished. */
function isComplete() {
  const pages = [...new Set(SECTIONS.map(s => s.page))].sort((a, b) => a - b);
  return {
    pages,
    expected: EXPECTED_PAGES,
    // Page 0 is the gate, so a finished paper has EXPECTED_PAGES pages numbered
    // 0..EXPECTED_PAGES-1.
    complete: pages.length === EXPECTED_PAGES,
    missing: Array.from({ length: EXPECTED_PAGES }, (_, i) => i).filter(p => !pages.includes(p)),
  };
}

// The fields an applicant may see. Named explicitly rather than deleted from a
// copy, so a marker-only field added to a question later is private by default
// instead of leaking the first time somebody forgets to exclude it.
const PUBLIC_QUESTION_FIELDS = [
  'id', 'type', 'required', 'prompt', 'help', 'options', 'statement', 'expect',
  'minSentences', 'minWords', 'maxChars', 'captured', 'editable', 'placeholder',
];

/** The paper as the applicant receives it. No guidance, no marking notes. */
function publicPaper() {
  return {
    sections: SECTIONS
      .slice()
      .sort((a, b) => a.page - b.page)
      .map(s => ({
        id: s.id, page: s.page, title: s.title, blurb: s.blurb,
        questions: s.questions.map(q => {
          const out = {};
          for (const f of PUBLIC_QUESTION_FIELDS) if (q[f] !== undefined) out[f] = q[f];
          out.maxChars = q.maxChars || MAX_CHARS;
          return out;
        }),
      })),
    totalPoints: totalPoints(),
    pages: isComplete(),
  };
}

/** The paper as a marker receives it — everything, guidance included. */
function markerPaper() {
  return {
    sections: SECTIONS.slice().sort((a, b) => a.page - b.page),
    totalPoints: totalPoints(),
    pages: isComplete(),
  };
}

// ── Counting ──────────────────────────────────────────────────────
// The same two functions run on the client (for the live counter) and on the
// server (for validation). If they disagree, somebody sees "3 sentences" next to
// a refusal saying they wrote two, and stops trusting the form.

function countWords(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return 0;
  return s.split(/\s+/).filter(Boolean).length;
}

/**
 * Sentences, counted the way a person would.
 *
 * Terminators, but only ones that actually end something: a full stop inside
 * "e.g." or "3.5" is not the end of a sentence, and a run of "!!!" is one
 * ending, not three. A final sentence with no full stop still counts — plenty of
 * people don't punctuate the last one, and refusing an otherwise good answer over
 * a missing dot would be pedantry with consequences.
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
 * Three separate lists, because they are three different conversations:
 *   missing   they have not answered it
 *   tooShort  they answered it, but not enough
 *   wrong     the answer is not one of the options, or the signature does not match
 *
 * @returns {{ ok, missing: string[], tooShort: object[], wrong: object[], stop: object|null }}
 */
function validate(answers, opts = {}) {
  const a = answers && typeof answers === 'object' ? answers : {};
  const missing = [], tooShort = [], wrong = [];

  // The hard stop comes first and short-circuits everything. Telling a
  // fourteen-year-old that their application is refused AND that page four is
  // incomplete is a form arguing with somebody it has already turned away.
  const stop = stopFor(a);
  if (stop) return { ok: false, missing: [], tooShort: [], wrong: [], stop };

  // Only the pages being checked. A draft save validates what is filled in; a
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
    if (q.type === 'typed' && q.expect) {
      // Compared on the words, not the whitespace or the final full stop — a
      // signature that fails because of a trailing space is a form being
      // obstructive about something it can see is right.
      const norm = (v) => String(v).replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim().toLowerCase();
      if (norm(raw) !== norm(q.expect)) {
        wrong.push({ id: q.id, why: 'That does not match the line exactly.' });
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
    }
  }

  return { ok: !missing.length && !tooShort.length && !wrong.length, missing, tooShort, wrong, stop: null };
}

/**
 * A reason to end the application immediately, or null.
 *
 * Only one at the moment, and it is on page one on purpose: somebody under the
 * minimum age should be told on the first page, kindly, not after an hour of
 * writing. The draft is discarded rather than kept — there is nothing here for
 * them to come back to until their birthday.
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
      out[id] = (Array.isArray(raw) ? raw : []).slice(0, 40)
        .map(x => String(x).slice(0, 200));
      continue;
    }
    out[id] = String(raw == null ? '' : raw).slice(0, q.maxChars || MAX_CHARS);
  }
  return out;
}

module.exports = {
  TYPES, MAX_CHARS, EXPECTED_PAGES, SECTIONS,
  flatQuestions, questionById, totalPoints, isComplete,
  publicPaper, markerPaper,
  countWords, countSentences,
  validate, stopFor, sanitiseAnswers,
};
