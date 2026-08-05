// server/lib/caseLogImport.js
// Rebuild the case archive from the Administrative Log messages in Discord.
//
// ── Why this can exist at all ─────────────────────────────────────
//
// Every case approved on the site posted an Administrative Log to the discipline
// channel, built FROM that case: the officer as a mention, each punishment with its
// duration, the reason, the notes, the case ref, the timestamp. That is not a
// summary of a case. It is very nearly the row, written out in public, kept by
// Discord for free, forever.
//
// So the channel is the durable copy and the database was only ever the convenient
// one. The 811 ticket logs came back for exactly this reason; cases have the same
// property. This reads the whole channel, back to its first message, and rebuilds.
//
// ── Built to be run again ─────────────────────────────────────────
//
// Not a one-off rescue. Identity is the LOG MESSAGE, so a second run updates what it
// already created instead of piling up duplicates, and a case somebody typed on the
// site is never overwritten by a reconstruction of it. Moving the database becomes a
// re-import rather than a loss.
//
// ── Formats ───────────────────────────────────────────────────────
//
// The log has not always looked the same. Field names changed, the ref has lived in
// the footer and in the title, and the oldest ones are plain text with no embed. So
// parsing is a LIST of shapes tried in order, each reporting which it matched, and
// every message that looks like a case but matches none of them is kept as a sample.
// That census is the point: it is how you find out what is still not being read,
// instead of assuming the number that came back was all of it.
//
// ── What cannot come back ─────────────────────────────────────────
//
// Cases never approved. A PENDING or DENIED case posted no log, so there is nothing
// to read — which is the right way round, since an approved case is the one that is
// a record of something.
//
// And Discord truncated any field over 1024 characters when the log was POSTED, so a
// very long reason came back shortened. That is counted and reported, not hidden.

const prisma = require('./db');

const clean = (v, max = 2000) =>
  String(v == null ? '' : v).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim().slice(0, max);

// ── Finding the reference ─────────────────────────────────────────
// In descending order of how deliberate it is. The footer form is this system's own
// signature; the rest are what older logs did.
const REF_PATTERNS = [
  { name: 'infraction-id', re: /infraction\s*id\s*[|:#-]*\s*#?(\d{1,6})\b/i },
  { name: 'case-id',       re: /\bcase\s*(?:id|ref(?:erence)?|number|no)\.?\s*[|:#-]*\s*#?(\d{1,6})\b/i },
  { name: 'case-hash',     re: /\bcase\s*[#-]\s*(\d{1,6})\b/i },
  { name: 'infraction-hash', re: /\binfraction\s*[#-]\s*(\d{1,6})\b/i },
  { name: 'bare-hash',     re: /(?:^|\s)#(\d{1,6})(?:\s|$)/ },
];

// Infraction IDs that are CODES rather than numbers: "Infraction ID | MH71",
// "Infraction ID | 0Q71". Newer logs use these, and because every pattern above
// insists on digits, a whole run of real cases was unreadable — the reference was
// right there and nothing would take it.
//
// Tried only after all the numeric forms, so a log that has a number still gets
// its number.
//
// Finding the code is only about RECOGNISING the message as a case. The case does
// not keep it: references have to be one consistent numbering or they are useless
// for saying when something happened, so the importer assigns a number continuing
// from the most recent and keeps the code in sourceRef. Somebody quoting "MH71"
// can still be answered; somebody reading a list of refs sees one sequence.
const REF_CODE = /infraction\s*id\s*[|:#-]*\s*`?([A-Z0-9][A-Z0-9_-]{2,15})`?/i;

// Words that sit in that slot and are not references. "pending" is this system's
// OWN placeholder, written into the footer when a case is logged before it has a
// ref — reading it as one would invent a case called #PENDING and then merge every
// later unreferenced log into it.
const REF_PLACEHOLDER = /^(?:pending|n\/?a|none|null|nil|tbd|tba|unknown|unassigned|xxx+|\?+|-+)$/i;

function findRef(...texts) {
  for (const pat of REF_PATTERNS) {
    for (const t of texts) {
      if (!t) continue;
      const m = pat.re.exec(String(t));
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && n > 0) return { ref: '#' + n, num: n, via: pat.name };
      }
    }
  }
  for (const t of texts) {
    if (!t) continue;
    const m = REF_CODE.exec(String(t));
    if (m && !REF_PLACEHOLDER.test(m[1])) {
      return { ref: '#' + m[1].toUpperCase(), num: null, via: 'infraction-code' };
    }
  }
  return null;
}

// ── Finding the fields ────────────────────────────────────────────
// Every label this log has used for the same thing. Matched against an embed field
// name OR a "Label: value" line, so one list covers embeds and plain text both.
const LABELS = {
  officer: ['officer', 'staff member', 'staff', 'member', 'user', 'offender', 'subject',
            'punished', 'recipient', 'target', 'against'],
  punishment: ['punishment(s)', 'punishments', 'punishment', 'action(s)', 'actions', 'action',
               'discipline', 'disciplinary action', 'consequence(s)', 'consequences',
               'sanction(s)', 'sanction'],
  reason: ['reason(s)', 'reasons', 'reason', 'reasoning', 'details', 'description'],
  notes: ['notes', 'note', 'additional notes', 'additional information', 'extra notes',
          'comments', 'comment'],
  issuer: ['issued by', 'issuer', 'signed by', 'signed', 'handled by', 'investigator'],
};

const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function embedField(embed, kind) {
  const fields = Array.isArray(embed && embed.fields) ? embed.fields : [];
  for (const label of LABELS[kind]) {
    const m = new RegExp('^\\s*[•·*\\-–—]?\\s*\\*{0,2}' + escRe(label) + '\\*{0,2}\\s*:?\\s*$', 'i');
    const hit = fields.find(f => f && m.test(String(f.name || '')));
    if (hit) return String(hit.value || '');
  }
  return '';
}

// Where a value must stop even though no other field follows it: the reference
// trailer the log puts at the end. Without this the LAST field on a line absorbs
// it, and every one of those cases came back with a note reading
// "N/A` Infraction ID | MH71".
const REF_MARK = /\s*\*{0,2}(?:infraction|case)\s*(?:id|ref(?:erence)?|number|no)\.?\s*\*{0,2}\s*[|:#-]/i;

// A value that is nothing but markdown — "**" left over from "**Punishment:**" —
// is not a value. Reading it as one is how a label sitting alone above its own
// bulleted list came back as a single punishment called "**".
const EMPTY_ISH = /^[*_`~\s:•·-]*$/;

function tidyValue(v) {
  let s = String(v == null ? '' : v);
  const cut = REF_MARK.exec(s);
  if (cut && cut.index > 0) s = s.slice(0, cut.index);
  return s.replace(/[\s]*[-–—•·|]+\s*$/, '').trim().replace(/^`+|`+$/g, '').trim();
}

// Does this line START a field? Used to know where a value that runs over several
// lines has to stop. A bulleted punishment ("• Written Warning") has no colon, so
// it is never mistaken for one.
const LABEL_LINE = /^\s*[•·*\-–—]?\s*\*{0,2}[A-Za-z][A-Za-z ()/]{0,28}\*{0,2}\s*:/;

function textField(text, kind) {
  const body = String(text || '');

  // 1. "Label: value", both on the same line.
  //
  // Spaces and tabs only, never \s — \s matches a NEWLINE, so a pattern built
  // from it will happily step over the end of the line and take the first line of
  // the next field as this one's value. That is precisely what turned
  //
  //     **Punishment:**
  //     • Written Warning
  //     • Disciplinary Strike 1 (14d)
  //
  // into a single punishment called "Written Warning", losing the strike and its
  // fourteen days off somebody's record.
  //
  // The \*{0,2} after the colon is the closing marker of "**Reason:**"; without it
  // every bold label handed back a value beginning with "** ".
  const SP = '[ \\t]*';
  for (const label of LABELS[kind]) {
    const re = new RegExp('^' + SP + '[•·*\\-–—]?' + SP + '\\*{0,2}' + escRe(label)
      + '\\*{0,2}' + SP + '[:\\-]' + SP + '\\*{0,2}' + SP + '(.+)$', 'im');
    const m = re.exec(body);
    if (m && !EMPTY_ISH.test(m[1])) {
      const v = tidyValue(m[1]);
      if (v) return v;
    }
  }

  // 2. The label alone on its line, with the value on the lines below it — how a
  //    list of punishments is written.
  const lines = body.split(/\r?\n/);
  for (const label of LABELS[kind]) {
    const head = new RegExp('^\\s*[•·*\\-–—]?\\s*\\*{0,2}' + escRe(label)
      + '\\*{0,2}\\s*[:\\-]\\s*\\*{0,2}\\s*$', 'i');
    const at = lines.findIndex(l => head.test(l));
    if (at < 0) continue;
    const took = [];
    for (let i = at + 1; i < lines.length; i++) {
      if (!lines[i].trim()) break;             // a blank line ends the value
      if (LABEL_LINE.test(lines[i])) break;    // so does the next field
      took.push(lines[i]);
    }
    const v = tidyValue(took.join('\n'));
    if (v) return v;
  }

  // 3. Everything on one line, several fields deep.
  const inline = inlineFields(body);
  return inline[kind] || '';
}

/**
 * Read labelled fields that all sit on ONE line.
 *
 *   <@123> Staff Consequences & Discipline - **Staff Member:** <@123>
 *   - **Action:** Termination - **Reason:** Patrolling as a CSO unsupervised.
 *
 * The line-anchored reader above cannot see any of that: only the first label on a
 * line can ever start it. So every label is located instead, and each value is
 * whatever sits between its own label and the next one.
 *
 * A label only counts when it is **bold** or at the start of a line. Without that
 * rule the word "action" in the middle of somebody's reason would be read as the
 * start of a new field and cut the reason in half, which is a quieter kind of
 * wrong than not reading it at all.
 *
 * Cached per string: parseMessage asks for four fields from the same text, and
 * scanning it four times for the same answer is waste.
 */
const inlineCache = new Map();
const INLINE_CACHE_MAX = 200;

function inlineFields(text) {
  const body = String(text || '');
  if (!body) return {};
  if (inlineCache.has(body)) return inlineCache.get(body);

  const hits = [];
  for (const kind of Object.keys(LABELS)) {
    for (const label of LABELS[kind]) {
      // Either **Label:** anywhere, or Label: at the start of a line.
      const re = new RegExp('(\\*\\*\\s*' + escRe(label) + '\\s*\\*\\*\\s*:'
        + '|\\*\\*\\s*' + escRe(label) + '\\s*:\\s*\\*\\*'
        + '|(?:^|\\n)\\s*[•·*\\-–—]?\\s*' + escRe(label) + '\\s*:)', 'gi');
      let m;
      while ((m = re.exec(body))) {
        hits.push({ kind, start: m.index, from: m.index + m[0].length, len: label.length });
        if (re.lastIndex === m.index) re.lastIndex++;   // never loop on a zero-width match
      }
    }
  }
  if (!hits.length) { remember(body, {}); return {}; }

  // Where every value has to stop: the next label along, whichever kind it is.
  const starts = [...new Set(hits.map(h => h.start))].sort((a, b) => a - b);
  const out = {};
  // Longest label first at a given position, so "Staff Member" wins over "Staff"
  // and the value does not begin with "Member:".
  hits.sort((a, b) => a.start - b.start || b.len - a.len);
  for (const h of hits) {
    if (out[h.kind] !== undefined) continue;          // the first one wins
    const next = starts.find(s => s > h.start);
    const value = tidyValue(body.slice(h.from, next == null ? undefined : next));
    if (value) out[h.kind] = value;
  }
  remember(body, out);
  return out;
}

function remember(key, value) {
  // A bounded cache: this runs over thousands of messages in one import, and an
  // unbounded map keyed on message text is a leak with a long channel behind it.
  if (inlineCache.size >= INLINE_CACHE_MAX) inlineCache.clear();
  inlineCache.set(key, value);
}

// ── Who it was about ──────────────────────────────────────────────
function readOfficer(raw, fallbackText) {
  const src = String(raw || '');
  const out = { officerDiscordId: null, robloxUsername: null, robloxUserId: null, officerName: null };

  const mention = /<@!?(\d{15,21})>/.exec(src);
  if (mention) out.officerDiscordId = mention[1];

  // "[name](https://www.roblox.com/users/123/profile)" — how the log named an
  // officer the site knew only on Roblox.
  const link = /\[([^\]]+)\]\(https:\/\/www\.roblox\.com\/users\/(\d+)/.exec(src);
  if (link) { out.robloxUsername = clean(link[1], 80); out.robloxUserId = link[2]; }

  // A bare snowflake, which some older logs used instead of a mention.
  if (!out.officerDiscordId) {
    const bare = /(?:^|[^\d])(\d{17,21})(?:[^\d]|$)/.exec(src);
    if (bare) out.officerDiscordId = bare[1];
  }

  if (!out.officerDiscordId && !out.robloxUsername && src && !/unknown officer/i.test(src)) {
    const name = clean(src.replace(/[*_`>]/g, '').replace(/^@/, ''), 80);
    // Guard against taking a whole sentence as somebody's name.
    if (name && name.length <= 60 && name.split(/\s+/).length <= 5) out.officerName = name;
  }

  // Last resort: a mention anywhere in the message. Better a named officer found in
  // the wrong field than an unattributable case.
  if (!out.officerDiscordId && !out.robloxUsername && !out.officerName && fallbackText) {
    const any = /<@!?(\d{15,21})>/.exec(String(fallbackText));
    if (any) out.officerDiscordId = any[1];
  }

  if (!out.officerName) out.officerName = out.robloxUsername || null;
  return out;
}

/**
 * Reverse the punishment list.
 *
 *   • Disciplinary Strike 1 (7d)
 *   • Suspension (Permanent)
 *   • Written Warning
 *
 * "Permanent" is a timed punishment with no end, which is a different fact from a
 * duration of zero — storing one as the other would misstate somebody's record.
 */
function parseActions(raw) {
  const text = String(raw == null ? '' : raw);
  const actions = [];
  let truncated = false;
  const multiline = /\r?\n/.test(text);

  for (let line of text.split(/\r?\n/)) {
    // Discord truncated the field at 1024 characters when this was POSTED, so the
    // last line of a long list can be cut off mid-word.
    if (/…\s*$/.test(line)) { truncated = true; line = line.replace(/…\s*$/, ''); }
    const m = /^\s*[•·*\-–—]\s*(.+?)\s*$/.exec(line);
    const body = (m ? m[1] : line).trim();
    if (!body) continue;
    // One per line normally; comma-separated in some older logs.
    const parts = multiline ? [body] : body.split(/\s*,\s*(?=[A-Z])/);
    for (const part of parts) {
      const p = part.trim();
      if (!p) continue;
      const dur  = /^(.*?)\s*\((\d+)\s*(?:d|days?)\)\s*$/i.exec(p);
      const perm = /^(.*?)\s*\(permanent\)\s*$/i.exec(p);
      if (dur) actions.push({ action: clean(dur[1], 80), durationDays: parseInt(dur[2], 10) });
      else if (perm) actions.push({ action: clean(perm[1], 80), durationDays: null, permanent: true });
      else actions.push({ action: clean(p, 80) });
    }
  }
  const summary = actions.map(a =>
    a.action + (a.durationDays ? ` (${a.durationDays}d)` : (a.permanent ? ' (Permanent)' : ''))).join(', ');
  return { actions, summary: clean(summary, 200), truncated };
}

// Does this message look like it is ABOUT a disciplinary case? Used to decide
// whether a message that failed to parse is worth reporting as an unread FORMAT, or
// is just an unrelated message in the channel.
//
// NOTE the missing trailing \b, which was a real bug. Several of these are STEMS,
// and `/\bdisciplin\b/` can never match "disciplinary" — the 'a' after 'n' is a word
// character, so there is no boundary there. The same killed `punish` against
// "punishment". Those are the two words most likely to appear in an old log, so the
// unrecognised-format detector — the entire mechanism for finding shapes we cannot
// read yet — was blind to exactly the messages it existed to catch. A leading
// boundary is what is wanted; the end must be free to continue.
const CASE_ISH = /\b(?:infraction|disciplin|punish|sanction|strike|blacklist|suspend|suspension|zero tolerance|written warning|verbal warning|demot|terminat|staff consequences|misconduct)/i;

function msgDate(msg) {
  if (!msg) return new Date();
  if (msg.createdAt) return new Date(msg.createdAt);
  if (msg.createdTimestamp) return new Date(msg.createdTimestamp);
  // A Discord snowflake carries its own timestamp — the last resort for a message
  // object that arrived without one.
  try { return new Date(Number((BigInt(msg.id) >> 22n) + 1420070400000n)); }
  catch (e) { return new Date(); }
}

// ── The formats ───────────────────────────────────────────────────

function fromEmbed(embed, msg) {
  if (!embed) return null;
  const title  = String(embed.title || '');
  const desc   = String(embed.description || '');
  const footer = String((embed.footer && embed.footer.text) || '');
  const author = String((embed.author && embed.author.name) || '');
  const fieldText = (Array.isArray(embed.fields) ? embed.fields : [])
    .map(f => `${(f && f.name) || ''}: ${(f && f.value) || ''}`).join('\n');
  const whole = [author, title, desc, fieldText, footer].filter(Boolean).join('\n');

  const found = findRef(footer, title, desc, fieldText);
  if (!found) return null;

  const officerRaw = embedField(embed, 'officer') || textField(desc, 'officer');
  const punishRaw  = embedField(embed, 'punishment') || textField(desc, 'punishment');
  const reasonRaw  = embedField(embed, 'reason') || textField(desc, 'reason');
  const notesRaw   = embedField(embed, 'notes') || textField(desc, 'notes');

  // A reference alone is not a case. Something has to say what was DONE or WHY, or
  // this is just a message that mentions a case number.
  if (!punishRaw && !reasonRaw && !officerRaw) return null;

  const acts = parseActions(punishRaw);
  const who  = readOfficer(officerRaw, whole);
  const reason = clean(reasonRaw, 2000);
  const notes  = clean(notesRaw, 2000);

  return {
    format: 'embed/' + found.via,
    caseRef: found.ref, refNum: found.num,
    ...who,
    action: acts.summary || clean(punishRaw, 200) || 'N/A',
    actions: acts.actions.length ? acts.actions : null,
    reason: reason || 'N/A',
    notes: notes || 'N/A',
    direct: /direct action/i.test(whole),
    signedBy: author ? clean(author.replace(/^signed,\s*/i, '').replace(/\.$/, ''), 120) : null,
    truncated: acts.truncated || /…$/.test(reason) || /…$/.test(notes),
    createdAt: embed.timestamp ? new Date(embed.timestamp) : msgDate(msg),
  };
}

// The oldest logs: no embed, just a message with labelled lines.
function fromPlainText(msg) {
  const text = String((msg && msg.content) || '');
  if (!text.trim()) return null;
  const found = findRef(text);
  if (!found) return null;
  if (!CASE_ISH.test(text)) return null;

  const officerRaw = textField(text, 'officer');
  const punishRaw  = textField(text, 'punishment');
  const reasonRaw  = textField(text, 'reason');
  const notesRaw   = textField(text, 'notes');
  if (!punishRaw && !reasonRaw) return null;

  const acts = parseActions(punishRaw);
  const who  = readOfficer(officerRaw, text);
  const issuer = textField(text, 'issuer');
  return {
    format: 'text/' + found.via,
    caseRef: found.ref, refNum: found.num,
    ...who,
    action: acts.summary || clean(punishRaw, 200) || 'N/A',
    actions: acts.actions.length ? acts.actions : null,
    reason: clean(reasonRaw, 2000) || 'N/A',
    notes: clean(notesRaw, 2000) || 'N/A',
    direct: /direct action/i.test(text),
    signedBy: issuer ? clean(issuer, 120) : null,
    truncated: acts.truncated,
    createdAt: msgDate(msg),
  };
}

/** Read one message into case fields, trying every known format. */
function parseMessage(msg) {
  for (const embed of ((msg && msg.embeds) || [])) {
    const out = fromEmbed(embed, msg);
    if (out) return { ...out, logMessageId: msg && msg.id ? String(msg.id) : null };
  }
  const text = fromPlainText(msg);
  if (text) return { ...text, logMessageId: msg && msg.id ? String(msg.id) : null };
  return null;
}

/**
 * Why a message that looks like a case was not read as one.
 *
 * The census exists so that "123 cases found" can be checked rather than
 * believed, and a list of 25 messages with no explanation only tells you that
 * something is wrong. This says which half is missing, which is the difference
 * between "teach it another reference format" and "teach it another field layout".
 *
 * @returns {string|null} null when the message parses perfectly well
 */
function whyNotParsed(msg) {
  if (parseMessage(msg)) return null;
  const parts = [String((msg && msg.content) || '')];
  for (const e of ((msg && msg.embeds) || [])) {
    parts.push(String(e.title || ''), String(e.description || ''),
      String((e.footer && e.footer.text) || ''),
      (Array.isArray(e.fields) ? e.fields : []).map(f => `${f && f.name}: ${f && f.value}`).join('\n'));
  }
  const blob = parts.filter(Boolean).join('\n');
  if (!CASE_ISH.test(blob)) return 'not about a case';
  if (!findRef(blob)) return 'no reference';
  const hasFields = ['punishment', 'reason', 'officer'].some(k => textField(blob, k));
  if (!hasFields) return 'nothing said about what was done or why';
  return 'the fields are laid out in a way this cannot read yet';
}

function parseAdminLogEmbed(embed, msg) {
  const out = fromEmbed(embed, msg);
  return out ? { ...out, logMessageId: msg && msg.id ? String(msg.id) : null } : null;
}

const ORIGIN = 'ADMINLOG';

// Everything recovered is owned by one placeholder account, so it can always be
// told apart from a case somebody filed on the site.
async function importerUser() {
  return prisma.user.upsert({
    where:  { discordId: 'SYSTEM_ADMINLOG_IMPORT' },
    update: {},
    create: {
      discordId: 'SYSTEM_ADMINLOG_IMPORT',
      discordUsername: 'Administrative Log import',
      displayName: 'Recovered from Discord',
      role: 'IA',
    },
  });
}

/**
 * Walk a channel to its very first message and rebuild every case in it.
 *
 * @param {object} client     a ready discord.js client
 * @param {string} channelId
 * @param {object} [opts]
 * @param {boolean}  [opts.dryRun]     read and report, write nothing
 * @param {number}   [opts.maxPages]   safety stop; high enough for a full history
 * @param {function} [opts.onProgress]
 */
async function importFromChannel(client, channelId, opts = {}) {
  const out = {
    ok: false, dryRun: !!opts.dryRun, channelId: String(channelId || ''),
    scanned: 0, parsed: 0, pages: 0,
    created: 0, updated: 0, unchanged: 0, movedAside: 0, moves: [],
    reachedStart: false, uniqueCases: 0, highestRef: 0,
    formats: {}, unrecognised: [], samples: [], errors: [],
    truncatedCases: 0, oldest: null, newest: null,
  };
  if (!client) { out.error = 'the bot is not connected'; return out; }
  if (!channelId) { out.error = 'no channel id given'; return out; }

  let channel;
  try { channel = await client.channels.fetch(String(channelId)); }
  catch (e) { out.error = 'cannot open that channel: ' + e.message; return out; }
  if (!channel || typeof channel.messages?.fetch !== 'function') {
    out.error = 'that is not a text channel the bot can read';
    return out;
  }

  // High by default: "as far back as it can" means walking to the first message, and
  // 4,000 pages is 400,000 messages.
  const maxPages = Math.min(Number(opts.maxPages) || 4000, 20000);
  const progress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};

  // Keyed on the log message: that is the identity of a log-derived case, and it is
  // what makes a second run an update rather than a duplicate.
  const byMessage = new Map();

  let before;
  while (out.pages < maxPages) {
    // Retry a transient failure rather than ending a 40,000-message walk on one
    // blip. Three attempts with backoff.
    let page = null;
    for (let attempt = 0; attempt < 3 && !page; attempt++) {
      try { page = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) }); }
      catch (e) {
        if (attempt === 2) out.errors.push('fetch failed at ' + (before || 'the start') + ': ' + e.message);
        else await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
      }
    }
    if (!page) break;
    if (page.size === 0) { out.reachedStart = true; break; }
    out.pages++;

    // Page strictly backward by the OLDEST (smallest) snowflake in the batch,
    // regardless of the collection's iteration order. Trusting that order is how a
    // paged walk silently skips a page.
    let oldestId = null;
    for (const msg of page.values()) {
      out.scanned++;
      if (oldestId === null || BigInt(msg.id) < BigInt(oldestId)) oldestId = msg.id;

      let parsed = null;
      try { parsed = parseMessage(msg); }
      catch (e) { if (out.errors.length < 40) out.errors.push('parse failed on ' + msg.id + ': ' + e.message); }

      if (!parsed) {
        // A message that looks like it is about a case but matched no format is the
        // thing worth reporting: it is how a format we cannot read yet gets found.
        const blob = [msg.content || '',
          ...((msg.embeds || []).map(e => [e.title, e.description,
            (e.footer && e.footer.text) || '',
            (Array.isArray(e.fields) ? e.fields : []).map(f => `${f.name}: ${f.value}`).join(' | ')
          ].filter(Boolean).join(' ')))].join(' ');
        if (CASE_ISH.test(blob) && out.unrecognised.length < 25) {
          out.unrecognised.push({
            messageId: String(msg.id),
            at: msgDate(msg).toISOString(),
            hasEmbed: !!(msg.embeds && msg.embeds.length),
            text: blob.replace(/\s+/g, ' ').trim().slice(0, 400),
          });
        }
        continue;
      }

      out.parsed++;
      out.formats[parsed.format] = (out.formats[parsed.format] || 0) + 1;
      if (parsed.truncated) out.truncatedCases++;
      byMessage.set(parsed.logMessageId, parsed);
      if (out.samples.length < 10) out.samples.push({
        caseRef: parsed.caseRef, format: parsed.format,
        officer: parsed.officerDiscordId || parsed.officerName || '—',
        action: parsed.action, reason: String(parsed.reason).slice(0, 70),
        at: parsed.createdAt,
      });
    }

    if (!oldestId) { out.reachedStart = true; break; }
    before = oldestId;
    if (page.size < 100) { out.reachedStart = true; break; }
    if (out.pages % 5 === 0) progress(`${out.scanned} messages read, ${out.parsed} cases found…`);
    // Gentle on the rate limit; this can be a very long channel. Settable so a test
    // driving a fake channel does not spend real seconds being polite to nobody.
    const pause = opts.pauseMs == null ? 320 : Number(opts.pauseMs);
    if (pause > 0) await new Promise(r => setTimeout(r, pause));
  }

  const rows = [...byMessage.values()].sort((a, b) => a.createdAt - b.createdAt);
  out.uniqueCases = rows.length;
  if (rows.length) {
    out.oldest = rows[0].createdAt;
    out.newest = rows[rows.length - 1].createdAt;
    out.highestRef = Math.max(...rows.map(r => r.refNum || 0));
  }
  out.codedRefs = rows.filter(r => r.refNum == null).length;

  // Every identity we can find for the officer each case is about, so it turns up
  // on their record however they are looked up.
  out.officers = await resolveOfficers(rows, out);

  if (out.dryRun || !rows.length) { out.ok = true; return out; }

  const importer = await importerUser();

  // ── Refs that two different cases both claim ────────────────────
  //
  // This is specific and it WILL happen. A fresh database numbers its first case
  // #1. Discord's history also contains a #1, from long ago, about somebody else
  // entirely. Keyed on the ref alone, the import treats them as one case and
  // quietly merges two unrelated records.
  //
  // The Discord ref is the authoritative one — it is what the log says and what
  // people quote at each other — so the case filed on the SITE is the one that
  // moves. It keeps all of its data and simply takes a ref above everything
  // recovered.
  // ── One numbering, in the order things happened ─────────────────
  //
  // References have to be consistent: the same three-digit numbering all the way
  // through, continuing from the most recent. A log whose Infraction ID was a CODE
  // ("MH71") is therefore given a number rather than keeping the code, and the
  // code is kept in sourceRef so anybody quoting it can still be answered.
  //
  // Assigned oldest-first, so the newest case ends up with the highest number.
  // Only ever to a row that does not exist yet: identity is the log message, so a
  // re-run finds its own work and never renumbers it again.
  const takenRefs = new Set(rows.map(r => r.caseRef));
  let assignFrom = Math.max(out.highestRef, await highestRefInDb()) + 1;
  const nextRef = () => {
    for (;;) {
      const candidate = '#' + assignFrom++;
      if (!takenRefs.has(candidate)) { takenRefs.add(candidate); return candidate; }
    }
  };
  for (const r of rows) {
    if (r.refNum != null) continue;
    const already = r.logMessageId
      ? await prisma.case.findFirst({ where: { logMessageId: r.logMessageId },
                                      select: { caseRef: true } }).catch(() => null)
      : null;
    if (already) { r.caseRef = already.caseRef; continue; }   // it has a number already
    r.sourceRef = r.caseRef;
    r.caseRef = nextRef();
    out.numbered = (out.numbered || 0) + 1;
    if ((out.renames = out.renames || []).length < 20) out.renames.push({ from: r.sourceRef, to: r.caseRef });
  }

  const incoming = new Set(rows.map(r => r.caseRef));
  let nextFree = assignFrom;
  for (const ref of incoming) {
    const holder = await prisma.case.findUnique({
      where: { caseRef: ref },
      select: { id: true, origin: true, logMessageId: true },
    }).catch(() => null);
    if (!holder || holder.origin === ORIGIN) continue;
    // Genuinely the same log, so nothing to resolve.
    if (holder.logMessageId
        && rows.some(r => r.caseRef === ref && r.logMessageId === holder.logMessageId)) continue;

    for (let tries = 0; tries < 10000; tries++) {
      const candidate = '#' + nextFree++;
      if (incoming.has(candidate)) continue;
      try {
        await prisma.case.update({ where: { id: holder.id }, data: { caseRef: candidate } });
        out.movedAside++;
        out.moves.push({ from: ref, to: candidate, origin: holder.origin });
        break;
      } catch (e) {
        if (e && e.code === 'P2002') continue;   // that number is taken as well
        out.errors.push(`could not move ${ref} aside: ${e.message.slice(0, 120)}`);
        break;
      }
    }
  }

  // ── Write, oldest first ─────────────────────────────────────────
  for (const r of rows) {
    try {
      // Identity is the LOG MESSAGE, so a re-run finds its own work.
      let existing = r.logMessageId
        ? await prisma.case.findFirst({
            where: { logMessageId: r.logMessageId },
            select: { id: true, origin: true, reason: true, notes: true, caseRef: true,
                      actions: true, logMessageId: true },
          })
        : null;
      // Then the ref, for a case created before the message id was kept, or one the
      // site filed and logged itself.
      if (!existing) {
        existing = await prisma.case.findUnique({
          where: { caseRef: r.caseRef },
          select: { id: true, origin: true, reason: true, notes: true, caseRef: true,
                    actions: true, logMessageId: true },
        });
      }

      if (existing) {
        const patch = {};
        if (existing.origin === ORIGIN) {
          // Ours: refresh, because a re-run should pick up a better parse.
          if (existing.caseRef !== r.caseRef) patch.caseRef = r.caseRef;
          if (existing.reason !== r.reason) patch.reason = r.reason;
          if (existing.notes !== r.notes) patch.notes = r.notes;
          patch.action = r.action;
          patch.actions = r.actions ?? undefined;
          patch.officerDiscordId = r.officerDiscordId;
          patch.robloxUsername = r.robloxUsername;
          patch.robloxUserId = r.robloxUserId;
          patch.logMessageId = r.logMessageId;
          patch.createdAt = r.createdAt;
        } else {
          // Somebody's own work. FILL GAPS ONLY — never overwrite what a person
          // typed with a reconstruction of it.
          if (!existing.logMessageId && r.logMessageId) patch.logMessageId = r.logMessageId;
          if ((!existing.reason || existing.reason === 'N/A') && r.reason !== 'N/A') patch.reason = r.reason;
          if ((!existing.notes  || existing.notes  === 'N/A') && r.notes  !== 'N/A') patch.notes  = r.notes;
          if (!existing.actions && r.actions) patch.actions = r.actions;
        }
        if (!Object.keys(patch).length) { out.unchanged++; continue; }
        await prisma.case.update({ where: { id: existing.id }, data: patch });
        out.updated++;
        continue;
      }

      await prisma.case.create({
        data: {
          caseRef: r.caseRef,
          sourceRef: r.sourceRef || null,
          origin: ORIGIN,
          userId: importer.id,
          officerDiscordId: r.officerDiscordId,
          robloxUserId: r.robloxUserId,
          robloxUsername: r.robloxUsername,
          action: r.action,
          actions: r.actions ?? undefined,
          reason: r.reason,
          notes: r.notes,
          // Only approved cases ever posted a log, so that is what these are.
          status: 'APPROVED',
          logMessageId: r.logMessageId,
          createdAt: r.createdAt,
        },
      });
      out.created++;
    } catch (e) {
      if (e && e.code === 'P2002') { out.unchanged++; continue; }
      if (out.errors.length < 40) out.errors.push(`${r.caseRef}: ${e.message.slice(0, 160)}`);
    }
  }

  // The site's counter has to sit above EVERYTHING, or the next case filed collides
  // with a recovered ref.
  out.counter = await raiseCounter();
  out.ok = true;
  console.log('[AdminLogImport] ' + JSON.stringify({
    scanned: out.scanned, parsed: out.parsed, unique: out.uniqueCases,
    created: out.created, updated: out.updated, unchanged: out.unchanged,
    movedAside: out.movedAside, reachedStart: out.reachedStart, formats: out.formats,
  }));
  return out;
}

/**
 * Fill in every identity we can find for the officer each log is about.
 *
 * A record lookup matches on officerDiscordId OR robloxUserId OR robloxUsername
 * (see routes/cases.js), so which of the three a case happens to carry decides
 * whether it appears on somebody's record at all. The log usually gives exactly
 * one of them — a Discord mention — and that is enough only for a lookup that
 * starts from Discord. Somebody searched for by Roblox username would not find
 * their own case.
 *
 * So all three are filled in wherever they can be, in order of cost:
 *
 *   1. our own User rows, for every mentioned Discord id at once (one query);
 *   2. Roblox's batch username endpoint, for names with no id (paced, retried);
 *   3. RoVer, for the rest — CAPPED, because its rate limit is the one every
 *      login depends on. Being thorough about a historical import is not worth
 *      locking people out of the dashboard, and anything left unresolved keeps
 *      whichever identity the log gave it.
 *
 * Mutates `rows` in place. Never throws.
 */
const MAX_ROVER_PER_IMPORT = () => {
  const n = parseInt(process.env.CASE_IMPORT_ROVER_MAX, 10);
  return Number.isFinite(n) && n >= 0 ? n : 25;
};

async function resolveOfficers(rows, out) {
  const stats = { fromSite: 0, fromRoblox: 0, fromRover: 0, unresolved: 0 };
  if (!rows.length) return stats;

  // 1. Our own accounts. Everybody who has ever signed in is here, with their
  //    Roblox link already verified — the cheapest and most trustworthy source.
  const ids = [...new Set(rows.map(r => r.officerDiscordId).filter(Boolean))];
  if (ids.length) {
    try {
      const users = await prisma.user.findMany({
        where: { discordId: { in: ids } },
        select: { discordId: true, robloxId: true, robloxUsername: true, displayName: true },
      });
      const byId = new Map(users.map(u => [String(u.discordId), u]));
      for (const r of rows) {
        const u = r.officerDiscordId && byId.get(String(r.officerDiscordId));
        if (!u) continue;
        let gained = false;
        if (!r.robloxUserId && u.robloxId) { r.robloxUserId = String(u.robloxId); gained = true; }
        if (!r.robloxUsername && u.robloxUsername) { r.robloxUsername = u.robloxUsername; gained = true; }
        if (!r.officerName) r.officerName = u.displayName || u.robloxUsername || null;
        if (gained) stats.fromSite++;
      }
    } catch (e) { /* the other two routes still apply */ }
  }

  // 2. A username with no id behind it. One batched call for all of them.
  const needId = rows.filter(r => r.robloxUsername && !r.robloxUserId);
  if (needId.length) {
    try {
      const got = await require('./roblox')
        .getRobloxIdsFromUsernames(needId.map(r => r.robloxUsername));
      const found = got.users || got;
      for (const r of needId) {
        const rec = found.get(String(r.robloxUsername).toLowerCase());
        if (!rec) continue;
        r.robloxUserId = rec.id;
        r.robloxUsername = rec.username;   // whatever they are called NOW
        stats.fromRoblox++;
      }
    } catch (e) { /* keep the name alone */ }
  }

  // 3. RoVer, for a mention we still cannot tie to a Roblox account. Capped.
  const budget = MAX_ROVER_PER_IMPORT();
  let spent = 0, stop = false;
  for (const r of rows) {
    if (stop || spent >= budget) break;
    if (!r.officerDiscordId || r.robloxUserId) continue;
    spent++;
    try {
      const { getRobloxIdFromDiscord, getRobloxUserInfo } = require('./roblox');
      const rid = await getRobloxIdFromDiscord(r.officerDiscordId);
      if (!rid) continue;
      r.robloxUserId = String(rid);
      if (!r.robloxUsername) {
        const info = await getRobloxUserInfo(rid).catch(() => null);
        if (info && info.username) r.robloxUsername = info.username;
      }
      stats.fromRover++;
    } catch (e) {
      // A rate limit is not worth one more call — see the same lesson in
      // clanslabsXp.
      if (/rate.?limit|429|paused/i.test(e.message)) stop = true;
    }
  }
  const capped = rows.some(r => r.officerDiscordId && !r.robloxUserId) && (spent >= budget || stop);
  if (capped && out) {
    out.notes = out.notes || [];
    out.notes.push(`Stopped asking RoVer for Roblox links after ${spent} lookups — its rate limit is `
      + `the one every login uses. Those cases keep the Discord id they were logged with, so they `
      + `still appear on a record looked up by Discord.`);
  }

  for (const r of rows) {
    if (!r.officerDiscordId && !r.robloxUserId && !r.robloxUsername) stats.unresolved++;
  }
  return stats;
}

/** The biggest number any case ref currently holds. 0 when there are none. */
async function highestRefInDb() {
  try {
    const refs = await prisma.case.findMany({ select: { caseRef: true } });
    return refs.reduce((n, c) => {
      const v = sequenceNumberOf(c.caseRef);
      return v != null && v > n ? v : n;
    }, Math.max(0, MIN_REF() - 1));
  } catch (e) { return 0; }
}

/** The number inside a ref, or null when it does not hold one ("#MH71"). */
function refNumberOf(ref) {
  const m = /^#?(\d{1,9})$/.exec(String(ref == null ? '' : ref).trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

// The window a ref has to be inside to count as part of OUR numbering.
//
// The floor is what makes every reference at least three digits: "#3" is a
// reference somebody has to ask about, and it is what a counter that had been
// reset produces. The ceiling is what keeps a foreign numbering scheme out —
// "#8665476" is not case eight and a half million, it is a number from
// somewhere else, and treating it as the top of the sequence made the next case
// #8665477 and the one after that #8665478.
const MIN_REF = () => { const n = parseInt(process.env.CASE_REF_MIN || '', 10); return Number.isFinite(n) && n > 0 ? n : 100; };
const MAX_REF = () => { const n = parseInt(process.env.CASE_REF_MAX || '', 10); return Number.isFinite(n) && n > 0 ? n : 99999; };

// Where a full resequence starts counting. Deliberately NOT the validity floor:
// that is 100 because three digits is the rule, and starting a resequence at 100
// would hand #663 to a different case from the one the archive has called #663 for
// years. Starting above the old top instead means a reference somebody half
// remembers cannot silently resolve to the wrong case — the old ones are simply
// gone, and the row that used to hold them says so in sourceRef.
const RESEQ_START = () => {
  const n = parseInt(process.env.CASE_REF_START || '', 10);
  return Math.max(Number.isFinite(n) && n > 0 ? n : 700, MIN_REF());
};

/**
 * The number a ref contributes to the sequence, or null if it is not part of it.
 *
 * This is the test that matters, and it is NOT "does it contain digits". Stripping
 * the non-digits out of a ref — which is what set the case counter — reads
 * "#FOU98FV810" as 98810 and "#0M87MHCU8Y" as 878. Those are not case numbers;
 * they are the digits that happened to be in a random code, and one of them
 * pushed the counter five digits up. Every case created afterwards took its number
 * from there.
 */
function sequenceNumberOf(ref) {
  const n = refNumberOf(ref);
  if (n == null) return null;
  return n >= MIN_REF() && n <= MAX_REF() ? n : null;
}

/**
 * Put every case reference into one consistent numbering, in the order things
 * actually happened.
 *
 * Why this is needed: the archive holds refs up to #674 from years of logs, then a
 * handful of #1, #2, #3 from a counter that had been reset, then #8665474 upwards
 * from a counter that a random code had poisoned, and hundreds of rows whose
 * reference is a code like #MH186KUCS3 with no number in it at all. Four numbering
 * schemes at once, and the lowest numbers on the list belonging to the most recent
 * cases.
 *
 * Two modes, because they trade different things away:
 *
 *   'repair' (the default) — a case whose number is already part of the sequence
 *     and already in the right place KEEPS it. Only the ones that are not — a code,
 *     a number below three digits, a number from a foreign scheme, or one that
 *     goes backwards in time — are renumbered, continuing from the top. Nothing
 *     anybody has quoted changes. The cost is that a July case renumbered to #675
 *     then sits above an August case that kept #663, so the refs do not strictly
 *     climb with time.
 *
 *   'resequence' — EVERY case is renumbered in date order from one base, so the
 *     refs climb with time and there is exactly one scheme. The cost is that refs
 *     people have already quoted change. It is not as destructive as it sounds:
 *     the old ref is kept in sourceRef either way, and a record lookup answers a
 *     quote of it.
 *
 * Two-phase, because caseRef is unique: everything moving goes to a temporary ref
 * first, then to its final one. A half-finished run therefore leaves rows with a
 * visible "#tmp-…" ref rather than a collision, and running it again finishes the
 * job.
 *
 * NOTE: it does not edit the Discord log messages, which still show the number
 * they were posted with. The site is what people search; rewriting history in the
 * channel is a bigger and less reversible thing than this.
 */
async function renumberRefs(opts = {}) {
  const dry = opts.dryRun === true;
  const mode = opts.mode === 'resequence' ? 'resequence' : 'repair';
  const out = { ok: true, dryRun: dry, mode, total: 0, moved: 0, unchanged: 0,
                moves: [], errors: [], counter: null, floor: MIN_REF(),
                startsAt: mode === 'resequence' ? RESEQ_START() : null };
  try {
    const cases = await prisma.case.findMany({
      // The extra fields are for re-editing the posted Discord infraction log to
      // the new ref, so the number in the channel matches the number on the site.
      select: {
        id: true, caseRef: true, sourceRef: true, createdAt: true, origin: true,
        action: true, actions: true, reason: true, notes: true,
        officerDiscordId: true, robloxUsername: true, robloxUserId: true,
        suspectRobloxDisplayName: true, logMessageId: true,
        appealedAt: true, appealedByName: true, appealReason: true,
      },
      orderBy: [{ createdAt: 'asc' }, { caseRef: 'asc' }],
    });
    out.total = cases.length;
    if (!cases.length) return out;

    // The top of OUR sequence — never a number from a foreign scheme, or the
    // renumbered refs continue from eight and a half million.
    let highest = cases.reduce((n, c) => {
      const v = sequenceNumberOf(c.caseRef);
      return v != null && v > n ? v : n;
    }, Math.max(0, MIN_REF() - 1));

    // Which ones are out of place, oldest first.
    //
    // A repair moves a ref that is not part of the numbering — a code, a number
    // below three digits, a number from another scheme — and NOTHING else.
    //
    // It deliberately does NOT move a ref that is merely out of step with its date.
    // That test used to be here and it made the operation unstable: the codes are
    // the OLDEST cases in this archive, so renumbering them to continue from the top
    // put #675 in front of #663, which made #663 look out of order on the next run,
    // which moved it, which made something else look out of order. It never settled.
    // Chronological order is what 'resequence' is for, and it is reported below
    // either way so the choice is an informed one.
    const moving = [];
    let seen = 0;
    for (const c of cases) {
      if (mode === 'resequence') { moving.push(c); continue; }
      const n = sequenceNumberOf(c.caseRef);
      if (n == null) { moving.push(c); continue; }        // a code, too small, or a foreign scheme
      if (n < seen) out.outOfOrder = (out.outOfOrder || 0) + 1;
      seen = Math.max(seen, n);
    }
    out.unchanged = cases.length - moving.length;
    if (!moving.length) { out.counter = await raiseCounter(); return out; }

    // Their new refs, oldest of the moving set first, so the newest case ends up
    // with the highest number. A repair continues from the top of what is there; a
    // resequence starts from the floor, because nothing is being kept.
    const taken = mode === 'resequence' ? new Set() : new Set(cases.map(c => String(c.caseRef)));
    let next = mode === 'resequence' ? RESEQ_START() : highest + 1;
    const plan = moving.map(c => {
      let to;
      for (;;) { to = '#' + next++; if (!taken.has(to)) { taken.add(to); break; } }
      return { id: c.id, from: c.caseRef, to, sourceRef: c.sourceRef };
    });
    // A resequence that would rename a case to the ref it already has is not a
    // rename at all, and reporting it as one buries the ones that matter.
    for (const p of plan) p.same = String(p.from) === p.to;
    const real = plan.filter(p => !p.same);
    out.unchanged += plan.length - real.length;
    out.moves = real.map(p => ({ from: p.from, to: p.to }));
    out.moved = real.length;
    if (dry) return out;
    if (!real.length) { out.counter = await raiseCounter(); return out; }

    // Phase one: out of the way. Nothing can collide with a name like this.
    for (const p of real) {
      await prisma.case.update({
        where: { id: p.id },
        data: { caseRef: `#tmp-${p.id.slice(0, 8)}` },
      });
    }
    // Phase two: into place, recording where each came from.
    for (const p of real) {
      await prisma.case.update({
        where: { id: p.id },
        data: { caseRef: p.to, sourceRef: p.sourceRef || p.from },
      });
    }
    out.counter = await raiseCounter();
    console.log(`[AdminLogImport] renumbered ${real.length} case ref(s) into sequence (${mode})`);

    // ── Keep Discord in step with the website ──
    // The renamed cases still have their OLD ref in the infraction log posted to
    // the channel. Edit each one to the new ref so the number people quote in
    // Discord is the number on the site. Best-effort and paced — a rate-limited
    // or missing message is reported, never fatal to the renumber that already
    // succeeded in the database.
    if (opts.syncDiscord !== false) {
      const byId = new Map(cases.map(c => [c.id, c]));
      let synced = 0;
      const editable = real.filter(p => byId.get(p.id) && byId.get(p.id).logMessageId);
      for (const p of editable) {
        const c = byId.get(p.id);
        try {
          let suspectAvatar = null;
          try { if (c.robloxUserId) suspectAvatar = await require('./roblox').getRobloxAvatarHeadshot(c.robloxUserId); } catch (e) {}
          const okEdit = await require('./webhook').editApprovalWebhook(c.logMessageId, {
            caseRef: p.to, action: c.action,
            actions: Array.isArray(c.actions) && c.actions.length ? c.actions : undefined,
            reason: c.reason, notes: c.notes,
            officerDiscordId: c.officerDiscordId,
            officerName: c.robloxUsername || c.suspectRobloxDisplayName || null,
            officerRobloxId: c.robloxUserId || null,
            suspectAvatar, timestamp: c.createdAt,
            appealed: c.appealedAt
              ? { by: c.appealedByName || 'Internal Affairs', reason: c.appealReason || null, at: c.appealedAt }
              : undefined,
          });
          if (okEdit) synced++;
          else out.errors.push(`Discord log for ${p.to} (was ${p.from}) could not be edited`);
        } catch (e) {
          out.errors.push(`Discord log for ${p.to}: ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 350));   // stay under the webhook rate limit
      }
      out.discordSynced = synced;
      out.discordToSync = editable.length;
      if (editable.length) console.log(`[AdminLogImport] re-synced ${synced}/${editable.length} Discord infraction log(s) to the new refs`);
    }
  } catch (e) {
    out.ok = false;
    out.errors.push(e.message);
  }
  return out;
}

/**
 * Put the case counter above the highest ref in use.
 *
 * RAISED, never lowered. Setting it to the imported maximum when the site already
 * holds something higher would hand the next case a number that is taken.
 */
async function raiseCounter() {
  try {
    const refs = await prisma.case.findMany({ select: { caseRef: true } });
    // sequenceNumberOf, NOT the digits in the string. This line used to be
    // `parseInt(caseRef.replace(/\D/g, ''))`, which read the random code
    // "#FOU98FV810" as 98810 and set the counter to it — so the next case the site
    // created was #98811, and from there the archive grew a second numbering
    // scheme five digits above the real one.
    const highest = refs.reduce((n, c) => {
      const v = sequenceNumberOf(c.caseRef);
      return v != null && v > n ? v : n;
    }, 0);
    const current = await prisma.caseCounter.findUnique({ where: { id: 1 } }).catch(() => null);
    const want = Math.max(highest, (current && current.count) || 0);
    await prisma.caseCounter.upsert({
      where: { id: 1 }, update: { count: want }, create: { id: 1, count: want },
    });
    return { highestRefInUse: highest, counter: want };
  } catch (e) { return { error: e.message }; }
}

/**
 * What is wrong with the case refs as they stand. Read-only.
 *
 * Run it before and after an import: it is how the archive is CHECKED rather than
 * assumed. Duplicate numbers, unnumbered rows, a counter sitting below the highest
 * ref in use, and refs whose numerical order disagrees with the order things
 * actually happened.
 */
async function auditRefs() {
  const cases = await prisma.case.findMany({
    select: { id: true, caseRef: true, origin: true, createdAt: true, logMessageId: true },
    orderBy: { createdAt: 'asc' },
  });
  const seen = new Map();
  const duplicates = [], unnumbered = [], outOfOrder = [];
  let previous = null;

  for (const c of cases) {
    const n = parseInt(String(c.caseRef || '').replace(/\D/g, ''), 10);
    if (!Number.isFinite(n)) { unnumbered.push({ id: c.id, caseRef: c.caseRef }); continue; }
    if (seen.has(n)) duplicates.push({ num: n, ids: [seen.get(n), c.id] });
    else seen.set(n, c.id);
    // Chronological and numerical order should agree. Where they do not, the ref was
    // assigned out of sequence — worth SEEING, not worth silently "fixing", because
    // the ref is what people quote at each other.
    if (previous != null && n < previous) {
      outOfOrder.push({ caseRef: c.caseRef, at: c.createdAt, after: '#' + previous });
    }
    previous = n;
  }

  const counter = await prisma.caseCounter.findUnique({ where: { id: 1 } }).catch(() => null);
  const highestRef = seen.size ? Math.max(...seen.keys()) : 0;
  const byOrigin = {};
  for (const c of cases) byOrigin[c.origin || 'NATIVE'] = (byOrigin[c.origin || 'NATIVE'] || 0) + 1;

  return {
    total: cases.length,
    byOrigin,
    oldest: cases.length ? cases[0].createdAt : null,
    newest: cases.length ? cases[cases.length - 1].createdAt : null,
    highestRef,
    counter: counter ? counter.count : null,
    counterBelowHighest: counter ? counter.count < highestRef : null,
    duplicates, unnumbered,
    outOfOrderCount: outOfOrder.length,
    outOfOrder: outOfOrder.slice(0, 20),
    withoutLogMessage: cases.filter(c => !c.logMessageId).length,
  };
}

module.exports = {
  parseMessage, parseAdminLogEmbed, parseActions, findRef, readOfficer,
  importFromChannel, importerUser, raiseCounter, auditRefs, ORIGIN, LABELS, CASE_ISH,
  whyNotParsed, textField, inlineFields,
  renumberRefs, resolveOfficers, highestRefInDb, refNumberOf, sequenceNumberOf,
};
