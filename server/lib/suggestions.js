// server/lib/suggestions.js
// Keep the Internal Affairs suggestions channel to suggestions and questions.
//
// Every message in the channel gets one of exactly two outcomes. There is no
// third, silent one:
//
//   * a suggestion or a question is KEPT — it gets reactions, so the room can
//     vote on it or mark it seen without anybody adding them by hand, and it
//     gets a thread hung off it, so the discussion happens there instead of
//     burying the next suggestion under twenty replies;
//   * anything else is DELETED, and ONE notice is posted covering the whole
//     burst rather than one per message — then that notice deletes itself, so
//     the channel is left holding suggestions and questions and nothing else.
//
// ── The bias ──────────────────────────────────────────────────────
//
// Deleting somebody's genuine suggestion is far worse than leaving a bit of
// chat up. One is a person's contribution destroyed and a reason to distrust the
// channel; the other is a line of noise a human can remove in two seconds. So
// the two outcomes are NOT symmetrical:
//
//   * deleting needs stronger evidence than keeping does;
//   * a long message is never deleted, whatever it scores. Nobody writes two
//     hundred words of "free chat", and if they have, a human can judge it;
//   * anything the score cannot place is resolved by asking one question: does
//     this say something ABOUT the department, or is it addressed AT the people
//     in the room? A statement about the department is content and is kept. A
//     call to the room — "anyone wanna patrol", "who's on" — is not.
//
// That tie-break used to be "do nothing at all", which read as the bot being
// broken: real suggestions sat there with no reactions on them and nobody could
// tell whether they had been seen. Uncertainty now resolves towards keeping and
// reacting, never towards silence.
//
// ── "Advanced" without an LLM ─────────────────────────────────────
//
// No model call. A classifier that can delete a member's message has to be
// explainable after the fact — you have to be able to say WHY a message went —
// and it has to give the same answer twice. So it is a weighted scorer over
// signals that each mean something on their own, and every decision carries the
// list of signals that produced it. That list is logged with the deletion.
//
// SUGGESTIONS_MODE=observe    classify, react and thread, but delete nothing
// SUGGESTIONS_MODE=off        do nothing at all
// SUGGESTIONS_CHANNEL_ID      the channel (defaults to the IA suggestions channel)
// SUGGESTIONS_LOG_CHANNEL_ID  mirror deleted messages here, so nothing is lost
// SUGGESTIONS_THREADS=off     keep the reactions, stop opening threads
// SUGGESTIONS_THREAD_OPENER=off  open the thread without a first message in it

const CHANNEL_ID = () => process.env.SUGGESTIONS_CHANNEL_ID || '1533870983251755109';
const MODE = () => {
  const m = String(process.env.SUGGESTIONS_MODE || 'on').toLowerCase();
  return ['on', 'observe', 'off'].includes(m) ? m : 'on';
};
const LOG_CHANNEL_ID = () => process.env.SUGGESTIONS_LOG_CHANNEL_ID || null;
const off = (v) => ['off', '0', 'false', 'no'].includes(String(v || '').toLowerCase());
const THREADS_ON = () => !off(process.env.SUGGESTIONS_THREADS);
const OPENER_ON  = () => !off(process.env.SUGGESTIONS_THREAD_OPENER);

// Discord only accepts these four. Anything else is rejected outright, so an
// unrecognised value falls back to a week rather than failing every thread.
const ARCHIVE_ALLOWED = [60, 1440, 4320, 10080];
const THREAD_ARCHIVE = () => {
  const n = parseInt(process.env.SUGGESTIONS_THREAD_ARCHIVE, 10);
  return ARCHIVE_ALLOWED.includes(n) ? n : 10080;
};

// How long the single notice stays up. Long enough to read, short enough that
// the channel is clean again by the time anybody scrolls back.
const WARN_TTL_MS = () => num(process.env.SUGGESTIONS_WARN_TTL_MS, 15000, 3000, 120000);
// A burst of chat keeps the SAME notice alive rather than posting another.
const WARN_MAX_LIFE_MS = () => num(process.env.SUGGESTIONS_WARN_MAX_MS, 45000, 5000, 300000);
// A cap, because a classifier bug that deletes everything would otherwise empty
// the channel before anybody noticed. Past this it stops deleting and says so.
const MAX_DELETES_PER_HOUR = () => num(process.env.SUGGESTIONS_MAX_DELETES_HOUR, 40, 1, 500);

function num(v, dflt, lo, hi) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

// ── Lexicons ──────────────────────────────────────────────────────

// Things people say that are only ever conversation. Matched as WHOLE messages
// (after stripping punctuation), never as substrings — "ok" inside a sentence is
// not the message "ok".
const CHAT_WHOLE = new Set([
  'hi', 'hii', 'hiii', 'hello', 'hey', 'heyy', 'yo', 'yoo', 'sup', 'wsp', 'wassup',
  'gm', 'gn', 'good morning', 'good night', 'goodnight', 'morning', 'night', 'nighty',
  'lol', 'lmao', 'lmfao', 'xd', 'haha', 'hahaha', 'hehe', 'kek', 'lel',
  'ok', 'okay', 'okey', 'oki', 'k', 'kk', 'alr', 'alright', 'aight', 'ight',
  'yes', 'yea', 'yeah', 'yep', 'yup', 'ya', 'no', 'nope', 'nah', 'naw',
  'true', 'fr', 'frfr', 'facts', 'real', 'based', 'same', 'mood',
  'bruh', 'bro', 'brop', 'bruv', 'mate', 'man', 'wtf', 'wth', 'omg', 'oml',
  'w', 'l', 'ratio', 'ez', 'gg', 'ggs', 'rip', 'oof', 'bet', 'cap', 'nocap',
  '+1', '-1', 'this', 'that', '^', '^^', '^^^', 'agreed', 'agree', 'disagree',
  'ty', 'tysm', 'thanks', 'thank you', 'thx', 'np', 'yw', 'sry', 'sorry', 'my bad',
  'sure', 'ig', 'idk', 'idc', 'nvm', 'nevermind', 'oh', 'ohh', 'ah', 'ahh', 'huh',
  'wait', 'wait what', 'what', 'why', 'how', 'when', 'who', 'where', 'fine',
  'cool', 'nice', 'noice', 'pog', 'poggers', 'sheesh', 'damn', 'dang', 'yikes',
  'hm', 'hmm', 'hmmm', 'welp', 'anyway', 'anyways', 'brb', 'afk', 'gtg', 'cya',
  'bye', 'byee', 'o7', 'salute', 'yessir', 'no problem', 'all good', 'gotcha',
  'wrong channel', 'wrong chat', 'my fault', 'oops', 'lmk', 'ok ty', 'ok thanks',
]);

// Phrases that only make sense as conversation with a person, not as a proposal
// to the department or a question about it. Substring-matched, so they work
// inside a longer message.
const CHAT_PHRASES = [
  /\bare you (?:there|on|free|around|online)\b/i,
  /\bis anyone (?:there|on|online|free|around)\b/i,
  /\bcan (?:someone|somebody|anyone) (?:help|dm|pm|invite|add)\b/i,
  /\bwhat time\b/i,
  /\bhow (?:are|r) (?:you|u|ya)\b/i,
  /\bgood (?:morning|afternoon|evening|night) (?:everyone|all|guys|lads)\b/i,
  /\b(?:dm|pm) me\b/i,
  /\bjoin (?:the )?(?:vc|call)\b/i,
  /\bwrong (?:channel|chat|place)\b/i,
  /\bmy bad\b/i,
  /\bhappy birthday\b/i,
  /\bcongrats?(?:ulations)?\b/i,
  /\bcongratulations\b/i,
];

// Calls to the people in the room, rather than statements about the department.
// This is the line the tie-break turns on: "anyone wanna patrol" names something
// we have and would otherwise be kept on that alone, but it is not a suggestion
// and it is not a question about how anything works — it is organising a game.
//
// Deliberately narrow. "anyone" on its own is not enough, because "anyone else
// think the quota is too high" is a suggestion; the availability or join verb has
// to be right there next to it.
const ROOM_CALL = [
  /\b(?:any ?one|any ?body|any1|some ?one|some ?body)\b[^.?!\n]{0,24}?\b(?:wanna|want to|wants to|up for|down for|free|online|joining|join|hop on|patrol(?:ling)?|host(?:ing)?|playing|vc)\b/i,
  /\bwho'?s? (?:on|online|free|up|down|coming|joining|patrolling|hosting|about|around)\b/i,
  /\b(?:lets|let'?s) (?:go|patrol|do this|play|hop on|get on|run)\b/i,
  /\b(?:hop|get|jump) (?:on|in)\b/i,
  /\bjoin (?:me|us|my|vc)\b/i,
  /\bi'?m (?:on|online|free|hosting|patrolling)\b/i,
];

// The vocabulary of an actual proposal.
const SUGGEST_PHRASES = [
  /\bsuggest(?:ion|ing|s)?\b/i,
  /\bproposals?\b/i,
  /\bpropos(?:e|ing)\b/i,
  /\brecommend(?:ation|ing)?\b/i,
  /\bidea\b/i,
  /\bwe (?:should|could|ought to|need to|have to)\b/i,
  /\b(?:i|we) (?:think|reckon|believe|feel)\s+(?:that\s+)?(?:we|you|it|the|this|there)\b/i,
  /\bit would be (?:good|better|nice|useful|helpful|great|worth)\b/i,
  /\bwould (?:it )?be (?:possible|better|good|nice|worth)\b/i,
  /\b(?:could|can) (?:we|you|the|there)\b/i,
  /\bthere should be\b/i,
  /\bthere needs to be\b/i,
  /\bneeds? (?:to be|a|an|more|less|changing|reworking)\b/i,
  /\b(?:please )?(?:add|implement|introduce|create|make|bring back|remove|delete|scrap|rework|revamp|change|replace|reduce|increase|extend|shorten|split|merge|rename)\s+(?:a|an|the|our|this|that|more|less|some|it)\b/i,
  /\binstead of\b/i,
  /\bwhy (?:don'?t|not|can'?t) we\b/i,
  /\bmy (?:suggestion|idea|proposal)\b/i,
  /\bfeature\b/i,
  /\bimprove(?:ment)?\b/i,
  /\bfix\b/i,
  /\bwould help\b/i,
  /\bwould make\b/i,
  /\bthis would\b/i,
  /\bat the moment\b/i,
  /\bcurrently\b/i,
  /\bas it stands\b/i,
];

// Wanting more, less or different of something. Weak on its own — a suggestion
// can be three words long and consist of nothing else ("more police cars"), and
// three words is exactly where the length penalties would otherwise sink it.
const CHANGE_WORDS = [
  /\bmore\b/i, /\bless\b/i, /\bfewer\b/i, /\bextra\b/i, /\banother\b/i,
  /\btoo (?:many|much|few|little|high|low|slow|fast|strict|harsh|easy|long|short)\b/i,
  /\b(?:high|low|slow|fast|short|long|strict|hard|easy|big|small)er\b/i,
  /\bnew\b/i, /\bbring back\b/i, /\bunfair\b/i, /\bbroken\b/i, /\bpointless\b/i,
];

// A reason attached to a proposal. This is the single strongest signal that
// somebody is arguing for something rather than chatting.
const RATIONALE = [
  /\bbecause\b/i, /\bso that\b/i, /\bsince\b/i, /\bas it\b/i, /\bthis way\b/i,
  /\bwhich (?:would|will|means|helps)\b/i, /\bthe (?:reason|issue|problem) is\b/i,
  /\bat the moment\b/i, /\bright now\b/i, /\bthis means\b/i, /\botherwise\b/i,
  /\bmeaning\b/i, /\bwhereas\b/i, /\bin order to\b/i, /\bto (?:avoid|stop|prevent|reduce|save)\b/i,
];

// Things the department actually has. A message naming one is about the
// department, which is what a suggestion or a question here is about.
const DOMAIN = [
  /\bquota\b/i, /\bpatrol/i, /\broster/i, /\brank(?:s|ing)?\b/i, /\bpromot/i, /\bdemot/i,
  /\bxp\b/i, /\btraining/i, /\btryout/i, /\bsop\b/i, /\bradio/i, /\bcallsign/i,
  /\buniform/i, /\bvehicle/i, /\bloadout/i, /\bchannel/i, /\brole(?:s)?\b/i,
  /\bdiscord/i, /\bserver/i, /\bwebsite/i, /\bdashboard/i, /\bpunish/i, /\bstrike/i,
  /\bticket/i, /\bapplication/i, /\bdivision/i, /\bshift/i, /\blog(?:s|ging)?\b/i,
  /\bevents?\b/i, /\bmeeting/i, /\bbriefing/i, /\bpromotion/i, /\bdeployment/i,
  /\bcase(?:s|work)?\b/i, /\bappeal/i, /\bwarning/i, /\binterview/i, /\bexam\b/i,
  /\bmet\b/i, /\bia\b/i, /\bhicomm/i, /\bcommand\b/i, /\bofficer/i, /\bmember/i,
  /\bpolicy|policies\b/i, /\bprocess\b/i, /\bsystem\b/i, /\bform\b/i, /\bbot\b/i,
  /\bcommand(?:s)?\b/i, /\bemoji\b/i, /\bpermission/i, /\baccess\b/i, /\bdeadline/i,
  /\brules?\b/i, /\bpursuit/i, /\bcars?\b/i, /\bfleet\b/i, /\bliveryu?\b/i,
  /\bguidelines?\b/i, /\bpaperwork\b/i, /\bsheet\b/i, /\breport(?:s|ing)?\b/i,
];

// Openers that are only ever a greeting. "hi guys", "hey all", "morning
// everyone" — a greeting plus who it is aimed at, and nothing else.
const GREETING_OPENERS = new Set([
  'hi', 'hii', 'hiii', 'hello', 'hey', 'heyy', 'heya', 'yo', 'yoo', 'sup', 'wsp',
  'gm', 'gn', 'morning', 'evening', 'afternoon', 'good', 'greetings', 'ello', 'oi',
]);

// The first word of a question. A question is legitimate content in this channel
// — somebody asking how something works, or whether something could change — so
// it is kept and threaded rather than deleted, and it is only chat when one of
// the decisive rules above says so.
const QUESTION_OPENERS = new Set([
  'what', 'whats', 'why', 'how', 'when', 'where', 'which', 'who', 'whos', 'whose',
  'can', 'could', 'should', 'shall', 'would', 'will', 'do', 'does', 'did', 'is',
  'are', 'was', 'were', 'has', 'have', 'may', 'might', 'must', 'am', 'any',
]);

// Headed layouts — "Suggestion: …", "What: … Why: …". Somebody who formats a
// message like this is filing something.
const HEADED = /^\s*(?:\*{0,2})(?:suggestion|idea|proposal|what|why|reason|problem|solution|change|current|proposed|question)(?:\*{0,2})\s*:/im;

// ── Normalisation ─────────────────────────────────────────────────

// Strip the markup and the furniture, so the lexicons see words.
function normalise(raw) {
  let s = String(raw == null ? '' : raw);
  s = s.replace(/```[\s\S]*?```/g, ' ');        // code fences
  s = s.replace(/<a?:\w+:\d+>/g, ' ');          // custom emoji
  s = s.replace(/<@[!&]?\d+>/g, ' ');           // user + role mentions
  s = s.replace(/<#\d+>/g, ' ');                // channel mentions
  s = s.replace(/https?:\/\/\S+/gi, ' ');       // links
  s = s.replace(/[*_~`|>]/g, '');               // markdown
  return s.replace(/\s+/g, ' ').trim();
}

// The whole-message form: lower case, no trailing punctuation or emoji, so
// "ok!!" and "ok" are the same message.
function whole(text) {
  return String(text || '')
    .toLowerCase()
    // Latin letters, digits, +, -, ^ and spaces. Everything else — punctuation,
    // emoji, symbols — goes, so a message that is only emoji becomes empty.
    .replace(/[^a-z0-9+\-^ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countMatches(list, text) {
  let n = 0;
  for (const re of list) if (re.test(text)) n++;
  return n;
}

function hasLink(raw) { return /https?:\/\/\S+/i.test(String(raw || '')); }

/**
 * Classify one message.
 *
 * @returns {{ verdict: 'suggestion'|'question'|'chat', score: number, signals: string[] }}
 *
 * Exactly two outcomes reach the channel: 'suggestion' and 'question' are both
 * KEPT (reactions + a thread), 'chat' is DELETED. Nothing is left untouched —
 * a message with no reaction on it and no notice about it looks like a bot that
 * is not running.
 */
function classify(input) {
  const raw   = typeof input === 'string' ? input : (input && input.content) || '';
  const hasAttachment = !!(input && input.hasAttachment);
  const isReply       = !!(input && input.isReply);

  const text  = normalise(raw);
  const w     = whole(text);
  const words = w ? w.split(' ').filter(Boolean) : [];
  const signals = [];

  // ── Messages whose content is not text at all ─────────────────
  //
  // These come FIRST, and they are all KEPT rather than falling through to the
  // no-words rule below, which deletes.
  //
  // A poll IS a suggestion mechanism — "should we do X or Y" — and a forwarded
  // message can be somebody carrying a suggestion in from another channel.
  // Neither has any `content` at all: the text lives in the poll question or in
  // the forwarded snapshot. Without this they read as "nothing was said" and get
  // deleted, which is the single worst thing this module can do.
  if (input && input.isPoll) return { verdict: 'suggestion', score: 0, signals: ['a poll · the question is not in the content'] };
  if (input && input.isForward) return { verdict: 'suggestion', score: 0, signals: ['a forwarded message'] };

  // An empty message that carried a picture or a link is somebody illustrating
  // something. Not words, so not confidently a proposal — but it is content
  // somebody chose to bring here, and deleting a mockup is unforgivable.
  if (!text && (hasAttachment || hasLink(raw))) {
    return { verdict: 'suggestion', score: 0, signals: [hasAttachment ? 'a picture with no words' : 'a link with no words'] };
  }

  // ── The decisive chat cases ───────────────────────────────────
  //
  // Rules rather than weights, because each of these is certain on its own and a
  // weight big enough to carry them alone would be big enough to sink a real
  // suggestion that happened to trip it.

  // Nothing alphanumeric survived normalisation at all: only emoji, only
  // punctuation, only mentions. Nothing was proposed because nothing was said.
  if (!words.length) return { verdict: 'chat', score: -10, signals: ['no words at all'] };

  // A greeting and who it is aimed at. "hi", "hey guys", "morning everyone".
  if (words.length <= 4 && GREETING_OPENERS.has(words[0])) {
    return { verdict: 'chat', score: -9, signals: [`opens with "${words[0]}" and says nothing else`] };
  }

  // The whole message is one chat word, or two to four of them stuck together.
  if (w && CHAT_WHOLE.has(w)) {
    return { verdict: 'chat', score: -8, signals: [`the whole message is "${w}"`] };
  }
  if (words.length > 1 && words.length <= 4 && words.every(x => CHAT_WHOLE.has(x))) {
    return { verdict: 'chat', score: -7, signals: ['nothing but chat words'] };
  }

  let score = 0;

  // ── Suggestion signals ────────────────────────────────────────
  const suggestHits = countMatches(SUGGEST_PHRASES, text);
  if (suggestHits) {
    score += Math.min(4, suggestHits * 2);
    signals.push(`proposal wording ×${suggestHits}`);
  }
  const rationaleHits = countMatches(RATIONALE, text);
  if (rationaleHits) {
    score += Math.min(3, rationaleHits * 2);
    signals.push(`gives a reason ×${rationaleHits}`);
  }
  const domainHits = countMatches(DOMAIN, text);
  if (domainHits) {
    score += Math.min(2, domainHits);
    signals.push(`names something we have ×${domainHits}`);
  }
  const changeHits = countMatches(CHANGE_WORDS, text);
  if (changeHits) {
    score += 1;
    signals.push('wants more, less or different of something');
  }
  if (HEADED.test(raw)) { score += 3; signals.push('written under headings'); }

  // Length and structure. A proposal has to explain itself, so it is long, and
  // it usually has more than one sentence.
  if (words.length >= 40)      { score += 3; signals.push('long (' + words.length + ' words)'); }
  else if (words.length >= 20) { score += 2; signals.push('substantial (' + words.length + ' words)'); }
  else if (words.length >= 12) { score += 1; signals.push(words.length + ' words'); }

  const sentences = text.split(/[.!?]+\s|\n+/).map(s => s.trim()).filter(s => s.split(' ').length >= 3);
  if (sentences.length >= 3)      { score += 2; signals.push(sentences.length + ' sentences'); }
  else if (sentences.length === 2) { score += 1; signals.push('two sentences'); }

  // A bulleted or numbered list is somebody laying out options.
  if (/^\s*(?:[-*•]|\d+[.)])\s+\S/m.test(raw)) { score += 2; signals.push('a list'); }

  // A picture or a link ATTACHED TO WORDS is evidence for the words.
  if (hasAttachment) { score += 1; signals.push('brought a picture'); }
  else if (hasLink(raw)) { score += 1; signals.push('brought a link'); }

  // ── Is it a question? ─────────────────────────────────────────
  //
  // Questions are what this channel is for as much as suggestions are, so this
  // is not a chat signal. It is only a verdict once the decisive chat rules
  // below have had their say.
  const asks = /\?/.test(text) || QUESTION_OPENERS.has(words[0]);
  if (asks) signals.push('asks something');

  // ── Chat signals ──────────────────────────────────────────────
  const chatHits = countMatches(CHAT_PHRASES, text);
  if (chatHits) { score -= chatHits * 3; signals.push(`talking to a person ×${chatHits}`); }

  // Organising a game rather than proposing anything: "anyone wanna patrol",
  // "who's on", "hop on vc". Decisive, because these name real things and the
  // domain signal would otherwise keep pulling them back over the line.
  //
  // Guarded on the proposal signals, so "could we move the tryout time, since
  // nobody knows who's on" is untouched by it.
  const roomHits = countMatches(ROOM_CALL, text);
  if (roomHits && !suggestHits && !rationaleHits && words.length <= 20) {
    return { verdict: 'chat', score: score - 5, signals: signals.concat(['asking the room to do something, not proposing anything']) };
  }

  // A short question aimed at the people in the room, with no proposal wording
  // anywhere in it. "are you on", "what time is the tryout", "dm me".
  if (chatHits && !suggestHits && !rationaleHits && words.length <= 15) {
    return { verdict: 'chat', score: score - 4, signals: signals.concat(['a question for the room, not about the department']) };
  }

  if (words.length <= 3)      { score -= 5; signals.push('three words or fewer'); }
  else if (words.length <= 6) { score -= 3; signals.push('six words or fewer'); }
  else if (words.length <= 10) { score -= 1; signals.push('short'); }

  // "ohhhhh", "yesssss", "AAAAA" — a reaction, not a proposal.
  if (/(.)\1{3,}/.test(w) && words.length <= 6) { score -= 3; signals.push('drawn-out word'); }

  // ALL CAPS with nothing else going on.
  const letters = raw.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 6 && letters === letters.toUpperCase() && words.length <= 8) {
    score -= 2; signals.push('shouting');
  }

  // A reply is a conversation by construction. Not decisive — people reply with
  // a fuller version of their own suggestion — so it is a nudge, not a verdict.
  if (isReply) { score -= 2; signals.push('a reply to someone'); }

  // ── Verdict ───────────────────────────────────────────────────
  const SUGGEST_AT = 3;
  const CHAT_AT    = -6;

  // The override that matters most: length. Nobody writes this much free chat,
  // and if the score says otherwise the score is wrong.
  if (words.length >= 35) {
    return { verdict: asks ? 'question' : 'suggestion', score, signals: signals.concat(['too long to delete on a score']) };
  }
  // A proposal WITH a reason attached is a suggestion, whatever else it looks
  // like. This is the pattern the channel exists for.
  if (suggestHits && rationaleHits && words.length >= 10) {
    return { verdict: 'suggestion', score: Math.max(score, SUGGEST_AT), signals: signals.concat(['a proposal with a reason']) };
  }

  if (score >= SUGGEST_AT) return { verdict: asks ? 'question' : 'suggestion', score, signals };

  // A question about the department, rather than about who is online. It has to
  // be asking something and it has to be about something we have.
  if (asks && (domainHits || suggestHits || changeHits)) {
    return { verdict: 'question', score, signals: signals.concat(['a question about the department']) };
  }

  if (score <= CHAT_AT) return { verdict: 'chat', score, signals };

  // ── The tie-break ─────────────────────────────────────────────
  //
  // The score could not place it. Doing nothing is not one of the options —
  // that is what made the channel look broken — so the question becomes: is
  // there anything here ABOUT the department? A statement about the department
  // is content, however short. "quota is too high" is four words and is a
  // suggestion; "i went to the shop" is five and is not.
  const substance = domainHits || suggestHits || rationaleHits || changeHits || words.length >= 12;
  if (substance) {
    return { verdict: asks ? 'question' : 'suggestion', score,
             signals: signals.concat(['not clear-cut, but it is about the department · kept']) };
  }
  return { verdict: 'chat', score, signals: signals.concat(['nothing here about the department']) };
}

// ── The single notice ─────────────────────────────────────────────
//
// One notice per burst, not one per message. Somebody who posts four lines of
// chat gets one line back; the alternative is the bot out-spamming the thing it
// is cleaning up.
//
// Keyed by channel: { messageId, postedAt, timer, names, count }
const warnings = new Map();
// messageId → true, so a message is never handled twice (the live event and a
// later re-read of the same message).
const handled = new Map();
const deletes = [];      // timestamps, for the hourly cap

function recentDeletes() {
  const cutoff = Date.now() - 3600000;
  while (deletes.length && deletes[0] < cutoff) deletes.shift();
  return deletes.length;
}

function whoLine(names) {
  return names.length
    ? names.slice(0, 6).join(', ') + (names.length > 6 ? ` and ${names.length - 6} others` : '')
    : 'that';
}

// The notice is an embed, not a plain line · it reads as the bot speaking with
// one voice rather than a member talking, and it stands out from the chat it is
// clearing without shouting.
function warnEmbed(names) {
  const emoji = require('./emoji');
  const e = typeof emoji.e === 'function' ? emoji.e : () => '';
  const who = whoLine(names);
  return {
    color: 0xf5b730,
    title: `${e('met_warn')} Suggestions and questions only`.trim(),
    description:
      `**${who}**, this channel is for suggestions and questions only.\n\n`
      + 'Post an idea with a sentence on why it would help, or ask something about how the '
      + 'department works, and it stays · it gets a vote and a thread to discuss it in. '
      + 'General chat belongs elsewhere.',
    footer: { text: 'This notice removes itself.' },
  };
}

async function postOrRefreshWarning(channel, name) {
  const key = String(channel.id);
  const now = Date.now();
  let st = warnings.get(key);

  if (st && st.messageId) {
    // A notice is already up. Add the name to it, keep it alive a little longer,
    // and DO NOT post a second one — that is the whole point.
    if (name && !st.names.includes(name)) st.names.push(name);
    st.count++;
    if (st.timer) clearTimeout(st.timer);
    const lifeLeft = Math.max(0, st.postedAt + WARN_MAX_LIFE_MS() - now);
    const ttl = Math.min(WARN_TTL_MS(), lifeLeft) || WARN_TTL_MS();
    st.timer = setTimeout(() => removeWarning(channel, key).catch(() => {}), ttl);
    // Fold the extra names in, so one notice covers the whole burst.
    try { await channel.messages.edit(st.messageId, { embeds: [warnEmbed(st.names)], allowedMentions: { parse: [] } }); }
    catch (e) { /* it may already be gone; the timer will tidy up */ }
    return { posted: false, folded: true, count: st.count };
  }

  st = { messageId: null, postedAt: now, timer: null, names: name ? [name] : [], count: 1 };
  warnings.set(key, st);
  try {
    // parse: [] means the names render but nobody is pinged. They will see it —
    // it is sitting in the channel they just posted in — and a ping that then
    // vanishes leaves nothing but a notification with no message behind it.
    const msg = await channel.send({ embeds: [warnEmbed(st.names)], allowedMentions: { parse: [] } });
    st.messageId = msg.id;
    st.timer = setTimeout(() => removeWarning(channel, key).catch(() => {}), WARN_TTL_MS());
    return { posted: true, folded: false, count: 1 };
  } catch (e) {
    warnings.delete(key);
    console.warn('[Suggestions] could not post the notice:', e.message);
    return { posted: false, folded: false, error: e.message };
  }
}

async function removeWarning(channel, key) {
  const st = warnings.get(key);
  if (!st) return;
  warnings.delete(key);
  if (st.timer) clearTimeout(st.timer);
  if (!st.messageId) return;
  try { await channel.messages.delete(st.messageId); }
  catch (e) { /* somebody deleted it first, or it aged out — either is fine */ }
}

// Keep a copy of anything deleted. Content that a bot removed with no record is
// content destroyed, and "the bot ate my suggestion" needs to be answerable.
async function mirror(client, message, decision) {
  const id = LOG_CHANNEL_ID();
  const who = message.author ? (message.author.tag || message.author.username || message.author.id) : 'unknown';
  console.log(`[Suggestions] deleted free chat from ${who}: ${JSON.stringify(String(message.content || '').slice(0, 300))} `
    + `(score ${decision.score}; ${decision.signals.join('; ')})`);
  if (!id || !client) return;
  try {
    const ch = await client.channels.fetch(id);
    if (!ch || typeof ch.send !== 'function') return;
    await ch.send({
      allowedMentions: { parse: [] },
      embeds: [{
        title: 'Removed from suggestions',
        description: String(message.content || '').slice(0, 3000) || '_(no text)_',
        color: 0x9aa4b2,
        fields: [
          { name: 'Author', value: who, inline: true },
          { name: 'Score',  value: String(decision.score), inline: true },
          { name: 'Why',    value: decision.signals.join('\n').slice(0, 1000) || '·' },
        ],
        timestamp: new Date().toISOString(),
      }],
    });
  } catch (e) { console.warn('[Suggestions] could not mirror the deletion:', e.message); }
}

// ── The handler ───────────────────────────────────────────────────

/**
 * Handle one message in the suggestions channel.
 *
 * Returns what it decided, so the behaviour is testable without a gateway:
 *   { skipped } | { verdict, score, signals, reacted, deleted, thread, warning }
 */
async function onSuggestionMessage(message) {
  const mode = MODE();
  if (mode === 'off') return { skipped: 'off' };
  if (!message || String(message.channelId) !== String(CHANNEL_ID())) return { skipped: 'not the channel' };
  if (message.author && message.author.bot) return { skipped: 'a bot posted it' };
  if (message.webhookId) return { skipped: 'a webhook posted it' };
  // System messages (joins, pins, boosts) are not anybody's suggestion and are
  // not anybody's chat either. Type 21 is the "started a thread" notice — OUR
  // thread — and deleting that would take the thread with it.
  if (message.system || (message.type != null && message.type !== 0 && message.type !== 19)) {
    return { skipped: 'a system message' };
  }
  const mid = String(message.id);
  if (handled.has(mid)) return { skipped: 'already handled' };
  handled.set(mid, Date.now());
  if (handled.size > 5000) {
    // Keep the guard bounded — it only needs to remember the recent past.
    const cutoff = Date.now() - 3600000;
    for (const [k, t] of handled) if (t < cutoff) handled.delete(k);
  }

  const decision = classify({
    content: message.content || '',
    // A sticker counts as content somebody chose to send. It is not words, so it
    // is not a suggestion — but it is not "nothing was said" either, and the
    // no-words rule deletes.
    hasAttachment: !!(message.attachments && message.attachments.size)
                || !!(message.embeds && message.embeds.length)
                || !!(message.stickers && message.stickers.size),
    isReply: !!(message.reference && message.reference.messageId),
    isPoll:  !!message.poll,
    // A forward arrives as a message snapshot with empty content of its own.
    isForward: !!(message.messageSnapshots && message.messageSnapshots.size)
            || (!!message.reference && message.reference.type === 1),
  });

  // ── Kept: react, then open a thread to discuss it in ────────────
  if (decision.verdict !== 'chat') {
    const reacted = await addReactions(message, decision.verdict);
    const thread  = THREADS_ON() ? await openThread(message, decision) : null;
    return { ...decision, reacted, deleted: false, thread };
  }

  // ── Free chat ───────────────────────────────────────────────────
  if (mode === 'observe') {
    console.log(`[Suggestions] OBSERVE · would delete: ${JSON.stringify(String(message.content || '').slice(0, 200))} `
      + `(score ${decision.score}; ${decision.signals.join('; ')})`);
    return { ...decision, reacted: false, deleted: false, observed: true };
  }

  if (recentDeletes() >= MAX_DELETES_PER_HOUR()) {
    console.warn(`[Suggestions] REFUSING to delete · ${deletes.length} deletions in the last hour is `
      + 'above the cap. Something is wrong with the classifier or the channel is being raided; '
      + 'nothing more will be removed until a human looks. Set SUGGESTIONS_MODE=off to silence this.');
    return { ...decision, reacted: false, deleted: false, cappedOut: true };
  }

  const client = message.client || null;
  await mirror(client, message, decision);

  let deleted = false;
  try { await message.delete(); deleted = true; deletes.push(Date.now()); }
  catch (err) {
    // Name the causes that actually happen, so the log says what to DO. A bare
    // error message here reads as a mystery, and the most likely cause is a
    // missing permission that takes ten seconds to grant.
    const why =
        err && err.code === 50013 ? 'the bot needs the "Manage Messages" permission in that channel'
      : err && err.code === 10008 ? 'the message was already gone (somebody deleted it first)'
      : err && err.code === 50021 ? 'it is a system message, which cannot be deleted'
      : (err && err.message) || 'unknown';
    console.warn('[Suggestions] could not delete the message ·', why);
    // A permission failure means EVERY delete will fail, and the notice would
    // otherwise still be posted for each one — the bot telling people off for
    // messages it then leaves up. Say nothing rather than that.
    if (err && err.code === 50013) return { ...decision, reacted: false, deleted: false, blocked: why };
  }

  let warning = null;
  if (deleted && message.channel && typeof message.channel.send === 'function') {
    const name = message.member?.displayName
      || message.author?.globalName || message.author?.username || null;
    warning = await postOrRefreshWarning(message.channel, name);
  }

  return { ...decision, reacted: false, deleted, warning };
}

// Everything kept gets met_tick then met_cross, in that order · approve on the
// left, the way every other sign-off in this system reads. Questions get the
// same pair rather than a lone search mark: the tick and cross read as "handled,
// and here is how to weigh in", where the search icon just looked like the bot
// was still thinking about it.
const REACTIONS = {
  suggestion: ['met_tick', 'met_cross'],
  question:   ['met_tick', 'met_cross'],
};

async function addReactions(message, verdict) {
  const wanted = REACTIONS[verdict] || REACTIONS.suggestion;
  let ok = 0;
  if (!message || typeof message.react !== 'function') return false;
  try {
    const { reactionFor } = require('./emoji');
    for (const name of wanted) {
      const id = reactionFor(name);
      if (!id) continue;
      try { await message.react(id); ok++; continue; }
      catch (err) {
        // Missing permission is the one cause worth naming: it makes EVERY
        // reaction fail, in every message, silently, and the symptom is a
        // channel that looks like the bot is not running at all.
        if (err && err.code === 50013) {
          console.warn('[Suggestions] cannot react · the bot needs "Add Reactions" '
            + '(and "Read Message History") in that channel.');
          return false;
        }
        // A custom emoji the bot cannot use falls back to the plain character,
        // so the vote still works.
        try {
          const { EMOJI } = require('../../scripts/emoji/manifest');
          const def = EMOJI.find(d => d.name === name);
          if (def && def.fallback && def.fallback !== id) {
            await message.react(def.fallback); ok++;
          } else {
            console.warn(`[Suggestions] could not react with ${name}:`, (err && err.message) || 'unknown');
          }
        } catch (e2) {
          console.warn(`[Suggestions] could not react with ${name}:`, (e2 && e2.message) || 'unknown');
        }
      }
    }
  } catch (e) { console.warn('[Suggestions] could not add the reactions:', e.message); }
  return ok > 0;
}

// ── The discussion thread ─────────────────────────────────────────
//
// Replies used to pile up under a suggestion in the main channel, which pushed
// the next one out of sight and made the vote reactions meaningless — you could
// not tell which message the twenty replies were about. A thread hangs the whole
// conversation off the suggestion itself and leaves the channel as a list.

function trimTo(s, n) {
  const t = String(s || '').trim();
  return t.length <= n ? t : t.slice(0, n - 1).trimEnd() + '…';
}

function threadName(message, decision) {
  const who = message.member?.displayName
    || message.author?.globalName || message.author?.username || 'Someone';
  const kind = decision.verdict === 'question' ? 'question' : 'suggestion';
  // Drop a leading "Suggestion:" heading — the thread is already labelled by
  // being attached to a suggestion, and repeating it wastes the 100 characters
  // Discord allows.
  const base = normalise(message.content || '')
    .replace(/^\s*(?:\*{0,2})(?:suggestion|idea|proposal|question)(?:\*{0,2})\s*:\s*/i, '')
    .trim();
  if (!base) return trimTo(`${who}'s ${kind}`, 100);
  return trimTo(base, 90);
}

function openerText(message, decision) {
  const kind = decision.verdict === 'question' ? 'question' : 'suggestion';
  const who = message.member?.displayName
    || message.author?.globalName || message.author?.username || 'the poster';
  return kind === 'question'
    ? `Answers to ${who}'s question go here, so the channel itself stays a list of suggestions and questions.`
    : `Discuss ${who}'s suggestion here. Vote on the message above · this thread is for the argument, not the count.`;
}

async function openThread(message, decision) {
  if (!message || typeof message.startThread !== 'function') return { ok: false, why: 'threads are not available here' };
  // Already has one: a re-read of the same message, or somebody made it by hand.
  if (message.hasThread || message.thread) return { ok: true, existing: true };
  let thread;
  try {
    thread = await message.startThread({
      name: threadName(message, decision),
      autoArchiveDuration: THREAD_ARCHIVE(),
      reason: 'Discussion thread for a suggestion in the suggestions channel',
    });
  } catch (err) {
    // Same reasoning as the delete path: name the cause, because every one of
    // these is a two-second fix that is invisible otherwise.
    const why =
        err && err.code === 50013  ? 'the bot needs "Create Public Threads" (and "Send Messages in Threads") in that channel'
      : err && err.code === 160004 ? 'that message already has a thread'
      : err && err.code === 50024  ? 'threads cannot be created on that kind of channel'
      : err && err.code === 10008  ? 'the message was already gone'
      : (err && err.message) || 'unknown';
    console.warn('[Suggestions] could not open a discussion thread ·', why);
    return { ok: false, why };
  }
  if (OPENER_ON() && thread && typeof thread.send === 'function') {
    // An empty thread reads as broken, and the first message is where the rule
    // about voting on the parent belongs. Failing to post it does not undo the
    // thread — an empty thread still beats no thread.
    try { await thread.send({ content: openerText(message, decision), allowedMentions: { parse: [] } }); }
    catch (e) { console.warn('[Suggestions] opened the thread but could not post in it:', e.message); }
  }
  return { ok: true, id: thread && thread.id, name: thread && thread.name };
}

// ── Startup self-check ───────────────────────────────────────────
//
// Every failure mode of this module looks identical from the channel: nothing
// happens. Six different missing permissions all present as "the bot is
// ignoring us", and the only way to tell them apart is to ask Discord once, at
// boot, and print the answer.
const NEEDED = [
  ['ViewChannel',           'see the channel at all'],
  ['ReadMessageHistory',    'read what was posted'],
  ['AddReactions',          'add the vote reactions'],
  ['ManageMessages',        'delete free chat'],
  ['SendMessages',          'post the notice about a deletion'],
  ['CreatePublicThreads',   'open a discussion thread'],
  ['SendMessagesInThreads', 'post the first message in that thread'],
];

async function checkPermissions(client) {
  if (MODE() === 'off') return { skipped: 'off' };
  const id = CHANNEL_ID();
  if (!client || !id) return { skipped: 'no client or channel' };
  let ch;
  try { ch = await client.channels.fetch(id); }
  catch (e) {
    console.warn(`[Suggestions] cannot see channel ${id} · ${e.message}. `
      + 'The bot is either not in that server or has no access to that channel, '
      + 'so nothing in the suggestions channel will be handled.');
    return { ok: false, why: e.message };
  }
  if (!ch) return { ok: false, why: 'channel not found' };
  let perms = null;
  try { perms = ch.permissionsFor(client.user); } catch (e) { /* not a guild channel */ }
  if (!perms) {
    console.log(`[Suggestions] watching #${ch.name || id} (permissions could not be read).`);
    return { ok: true, unknown: true };
  }
  const missing = NEEDED.filter(([p]) => !perms.has(p));
  if (!missing.length) {
    console.log(`[Suggestions] watching #${ch.name || id} · every permission it needs is granted.`);
    return { ok: true, missing: [] };
  }
  console.warn(`[Suggestions] watching #${ch.name || id}, but MISSING permissions:`);
  for (const [p, why] of missing) console.warn(`[Suggestions]   • ${p} · needed to ${why}`);
  return { ok: false, missing: missing.map(([p]) => p) };
}

module.exports = {
  classify, onSuggestionMessage, addReactions, openThread, checkPermissions,
  CHANNEL_ID, MODE,
  // Tests only.
  __state: () => ({ warnings, handled, deletes }),
  __reset: () => {
    for (const [, st] of warnings) if (st.timer) clearTimeout(st.timer);
    warnings.clear(); handled.clear(); deletes.length = 0;
  },
};
