// server/lib/ticketLog.js
// Pure parsing helpers for Discord ticket-log messages posted by the Tickety bot
// (https://tickety.top). No Discord/network I/O lives here — it operates on
// already-fetched discord.js Message objects (or plain equivalents) so the logic
// stays unit-testable. The Discord fetching + matching lives in bot.js.
//
// A closed-ticket log embed looks like:
//
//   Ticket Closed
//   <@executorId> closed a ticket.
//
//   Close Information
//     Ticket Name: general-support-noirn
//     Ticket ID:   BSC1K0kp6HHhmgr2nff
//     Reason:      handled
//
//   Creator Information
//     Creator:          <@creatorId>            (or a nickname like "CSUP | VuRSED_Amplifii")
//     Creator Username: @noir.n
//     Creator ID:       1304943623363760132
//
//   Executor Information
//     Executor:          <@executorId>
//     Executor Username: @zep22
//     Executor ID:       728569217716191252
//
//   [ View Transcript ]  ← a link-style button component carrying the transcript URL
//
// Some tickets get renamed; when both an "Old Name" and a "New Name" appear we
// use the OLD name to classify the ticket type (that's the name the opener chose).

// ── URL normalisation ─────────────────────────────────────────────
// Make two transcript links comparable: trim, drop the protocol, lower-case the
// host, and strip a trailing slash / query / fragment. Two links that differ
// only by "http vs https", a trailing slash, or tracking query params match.
function normalizeUrl(u) {
  if (!u) return '';
  let s = String(u).trim();
  s = s.replace(/^https?:\/\//i, '');       // drop protocol
  s = s.replace(/[?#].*$/, '');             // drop query + fragment
  s = s.replace(/\/+$/, '');                // drop trailing slashes
  return s.toLowerCase();
}

// ── Ticket-type classification from the ticket name ───────────────
// Names look like "general-support-noirn", "IA Complaint-lkblaze31",
// "officer-complaint-kis7ua", "Appeal-someone". Maps to the TicketType enum:
//   GENERAL_SUPPORT | HICOMM | OFFICER_REPORT | APPEAL
function ticketTypeFromName(name) {
  const s = String(name || '').toLowerCase();
  if (!s) return 'GENERAL_SUPPORT';
  if (/appeal/.test(s))                                   return 'APPEAL';
  // An "IA Complaint" is a complaint about Internal Affairs itself — a HICOMM
  // matter. Match it (and plain "hicomm"/"high command") before officer reports.
  if (/hicomm|high[\s-]*command|ia[\s-]*complaint/.test(s)) return 'HICOMM';
  // "officer-complaint", "officer report", "report" → officer report
  if (/officer|complaint|report|misconduct/.test(s))      return 'OFFICER_REPORT';
  // "website-support-<user>" (Tickety) and other general enquiries.
  if (/general|website|support|question|inquir|help/.test(s)) return 'GENERAL_SUPPORT';
  return 'GENERAL_SUPPORT';
}

// ── Embed flattening ──────────────────────────────────────────────
// Tickety renders the log as a single embed. Depending on the bot version the
// labelled lines live either in the embed description or across embed fields, so
// we flatten title + description + every field (name + value) into one string
// and pull the labelled values out with regex. Works regardless of layout.
function flattenEmbed(embed) {
  if (!embed) return '';
  const parts = [];
  // The author line. Some Tickety layouts put "Closed by <name>" up here rather
  // than in the body, and leaving it out meant those logs named nobody at all —
  // which is exactly what "Not recorded" on a row looks like from the outside.
  if (embed.author?.name) parts.push(embed.author.name);
  if (embed.title) parts.push(embed.title);
  if (embed.description) parts.push(embed.description);
  const fields = embed.fields || [];
  for (const f of fields) {
    const name  = f?.name  ? String(f.name).trim()  : '';
    const value = f?.value ? String(f.value).trim() : '';
    if (name)  parts.push(name);
    if (value) parts.push(value);
    // Tickety has two field layouts, and only one of them was readable.
    //
    // The common one puts a whole section in one field — "Executor Information"
    // as the name, "Executor: <@id>\nExecutor Username: @zep22" as the value —
    // and every label there carries its own colon.
    //
    // The other puts ONE label per field: "Ticket ID" as the field name and the
    // id as its value. Flattened, that is two separate lines with no colon
    // between them, so the "Label: value" form every reader below looks for never
    // appeared anywhere in the text — and a log in that layout yielded no ticket
    // name, no reason, no creator and NO EXECUTOR. That is a whole layout's worth
    // of rows reading "Not recorded". Joining the pair restores it.
    //
    // Single-line values only: a multi-line value is a section block, which
    // already labels its own contents.
    if (name && value && !value.includes('\n')) parts.push(name + ': ' + value);
  }
  if (embed.footer?.text) parts.push(embed.footer.text);
  return parts.join('\n');
}

// Pull the first labelled value out of the flattened text, e.g. label "Reason"
// matches "Reason: handled" → "handled". Stops at the end of the line.
//
// The colon is REQUIRED so a label like "Creator" matches "**Creator:** <@id>"
// and not the section header "Creator Information" (no colon) that precedes it.
// Markdown bold (**Label:**) is tolerated on either side of the colon.
function labelled(text, label) {
  const re = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*\\*{0,2}\\s*([^\\n]+)', 'i');
  const m = String(text || '').match(re);
  return m ? m[1].replace(/\*+/g, '').trim() : null;
}

// Words a "closed by" phrase can produce that are not somebody's name. An
// auto-closed ticket says "Closed by inactivity", and that is the log telling us
// there was no executor, not telling us who it was.
const NOT_A_PERSON = /^(?:unknown|none|nobody|n\/?a|null|nil|system|bot|inactivity|inactive|timeout|timed\s*out|auto(?:matic(?:ally)?)?(?:\s*clos(?:e|ed|ure))?|the\s+system|staff)$/i;

// The first Discord user mention (<@id> / <@!id>) in a string, or null.
function firstMentionId(s) {
  const m = String(s || '').match(/<@!?(\d{15,21})>/);
  return m ? m[1] : null;
}

// ── Parse a single ticket-log embed ───────────────────────────────
// Returns a plain object of the fields we care about, or null if the embed
// doesn't look like a Tickety closed-ticket log.
// `extraText` is anything outside the embed that belongs to the same log — in
// practice the message's own content. Some Tickety configurations post the
// sentence naming the closer as plain message text and keep only the ticket
// details in the embed, so a parser that reads the embed alone finds no executor
// on a message that plainly names one.
function parseTicketLogEmbed(embed, extraText) {
  const embedText = flattenEmbed(embed);
  if (!embedText) return null;

  const footer = (embed?.footer?.text || '').toLowerCase();
  const title  = String(embed?.title || '');
  // A closed-ticket log, in any of the shapes the bot has posted it. The wording
  // of the sentence has changed between versions ("closed a ticket", "has closed
  // this ticket"), and some layouts carry only a Ticket ID rather than a name, so
  // matching on one phrase alone dropped whole batches of logs on the floor.
  //
  // Decided on the EMBED alone, deliberately. Text from outside it widens where
  // the executor is looked for, below — it must not widen what counts as a ticket
  // log, or an ordinary message that happens to mention closing a ticket next to
  // some unrelated embed would be ingested as one.
  const looksLikeTickety =
    /clos(?:ed|ing)\s+(?:a|this|the)\s+ticket/i.test(embedText) ||
    /ticket\s*name\s*:/i.test(embedText) ||
    /ticket\s*id\s*:/i.test(embedText) ||
    (/ticket/i.test(title) && /clos/i.test(title)) ||
    footer.includes('tickety');
  if (!looksLikeTickety) return null;

  // ── ...and it has to be a CLOSE ─────────────────────────────────
  // Tickety logs a ticket's whole life into the same channel with the same
  // layout: opened, claimed, renamed, transferred, reopened, closed. Every one
  // of those carries "Ticket Name:" and a Tickety footer, so the test above
  // matches all of them — and each was being stored as a closed ticket, given a
  // ticket number, queued for review and, on approval, PAID. One ticket could
  // be worth points several times over just by being renamed.
  //
  // The TicketLog table means "a ticket that was closed" everywhere it is read:
  // the site's All Tickets and My Tickets, the weekly count, the review queue.
  // So the parser has to mean it too.
  //
  // Decided on the embed alone, like the test above, and stated as an explicit
  // NO before a YES: a log that says both (a close whose reason mentions
  // reopening) is a close, but a log that only says "Ticket Opened" must never
  // be read as one because it happens to carry the word "closed" in a
  // transcript link.
  const notAClose =
    /\bticket\s+(?:opened|created|claimed|unclaimed|renamed|reopened|re-opened|transferred|locked|unlocked|deleted)\b/i
      .test(title || embedText.split('\n')[0] || '');
  const isAClose =
    /clos(?:ed|ing)\s+(?:a|this|the)\s+ticket/i.test(embedText) ||
    /clos(?:ed|ing)\s+by\b/i.test(embedText) ||
    /\bclose\s+information\b/i.test(embedText) ||
    /\bclosed\s*(?:at|on|reason)\s*:/i.test(embedText) ||
    /\bticket\s+closed\b/i.test(embedText) ||
    (/ticket/i.test(title) && /clos/i.test(title));
  if (notAClose || !isAClose) return null;

  // Everything belonging to this log, embed and message content alike. Field
  // extraction reads this; the classifier above did not.
  const outside = String(extraText == null ? '' : extraText).trim();
  const text = outside ? embedText + '\n' + outside : embedText;

  const ticketName = labelled(text, 'Ticket Name');
  const ticketId   = labelled(text, 'Ticket ID');
  const oldName    = labelled(text, 'Old Name');
  const newName    = labelled(text, 'New Name');
  // Classify off the OLD name when a rename happened, else the current name.
  const effectiveName = oldName || ticketName || newName || null;

  const reason = labelled(text, 'Reason');

  // Creator: prefer the "Creator:" line (a mention or a "RANK | RobloxUser" nick).
  // Fall back to the "Creator ID:" numeric field for RoVer resolution.
  const creatorRaw = labelled(text, 'Creator');
  const creatorUsername = labelled(text, 'Creator Username'); // Discord username (e.g. @noir.n)
  const creatorId = labelled(text, 'Creator ID') || firstMentionId(creatorRaw || '');

  // ── Who closed it ───────────────────────────────────────────────
  // Every place the executor can appear, because a log that names nobody is a
  // row nobody can action — and "Not recorded" on every row is exactly what
  // happens when this misses.
  //
  // The sentence at the top of the embed is the one that is ALWAYS there:
  // "<@id> closed a ticket." Older versions of this only read the labelled
  // "Executor ID:" / "Executor:" fields, so an embed carrying just the sentence
  // yielded no id AND no name — the mention was stripped out of the raw text as
  // markup, leaving an empty string. Both halves now read the sentence.
  const closedBySentence = /<@!?(\d{15,21})>\s*(?:\([^)]*\)\s*)?(?:has\s+)?clos(?:ed|ing)\b/i.exec(text);

  // "Closed by zep22", with no colon — how the embed's author line says it. The
  // labelled reader needs a colon, so this shape was invisible to it.
  const closedByPhrase = /clos(?:ed|ing)\s+by\s*:?\s*([^\n]+)/i.exec(text);

  // Where the executor came from matters. An explicitly labelled Executor /
  // Closer / Closed By field is the log telling us outright; the sentence at the
  // top is an inference from prose. Only the labelled fields are strong enough
  // to overrule the "that is the creator" test below.
  const labelledExecutorId =
       labelled(text, 'Executor ID')
    || labelled(text, 'Closer ID')
    || labelled(text, 'Staff ID')
    || firstMentionId(labelled(text, 'Executor')  || '')
    || firstMentionId(labelled(text, 'Closed By') || '')
    || firstMentionId(labelled(text, 'Handled By')|| '')
    || null;

  const executorId =
       labelled(text, 'Executor ID')
    || labelled(text, 'Closer ID')
    || labelled(text, 'Staff ID')
    || firstMentionId(labelled(text, 'Executor')  || '')
    || firstMentionId(labelled(text, 'Closed By') || '')
    || firstMentionId(labelled(text, 'Closed')    || '')
    || firstMentionId(labelled(text, 'Handled By')|| '')
    || firstMentionId(labelled(text, 'Staff')     || '')
    || firstMentionId(labelled(text, 'Moderator') || '')
    || firstMentionId(closedByPhrase ? closedByPhrase[1] : '')
    || (closedBySentence ? closedBySentence[1] : null)
    // Last resort: the executor block by name, in case the label carries the
    // mention on the following line rather than after the colon.
    || firstMentionId((/Executor[^\n]*\n([^\n]+)/i.exec(text) || [])[1] || '')
    || null;

  // What the log actually PRINTED for them, mention markup stripped. The id
  // resolves to a name most of the time, but not always — a closer who has left
  // the server resolves to nothing, and "Not recorded" is worse than the name
  // the message already gave us.
  //
  // A candidate that is EMPTY once the markup comes off is no candidate at all,
  // so each one is tested after cleaning rather than before. That is the other
  // half of the same bug: "<@id> closed a ticket" cleaned down to "" and was
  // still accepted as the answer.
  const clean = (v) => String(v == null ? '' : v)
    .replace(/<@[!&]?\d+>/g, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const rawCandidates = [
    labelled(text, 'Executor Username'),
    labelled(text, 'Closer Username'),
    labelled(text, 'Staff Username'),
    labelled(text, 'Executor'),
    labelled(text, 'Closed By'),
    labelled(text, 'Handled By'),
    labelled(text, 'Staff'),
    labelled(text, 'Moderator'),
    // "Closed by zep22" — no colon, so nothing above sees it.
    closedByPhrase ? closedByPhrase[1] : null,
    // "<@id> has closed this ticket" — the optional "has" is part of the
    // sentence, not part of their name. Without it the capture ended up as the
    // literal word "has".
    (/(.+?)\s+(?:has\s+|have\s+)?clos(?:ed|ing)\s+(?:a|this|the)\s+ticket/i.exec(text) || [])[1],
  ];
  let executorRaw = null;
  for (const c of rawCandidates) {
    const v = clean(c);
    // A bare id is not a name — the ingest already falls back to the id itself,
    // and storing it here would hide a real name found later.
    if (!v || /^\d{15,21}$/.test(v)) continue;
    // Nor is "inactivity". A ticket closed automatically has no executor, and
    // naming one after the reason it closed is worse than admitting the log
    // recorded nobody — it puts a word in the Handled by column that somebody
    // will read as a person.
    if (NOT_A_PERSON.test(v)) continue;
    executorRaw = v; break;
  }

  return {
    ticketName,
    ticketId,
    oldName,
    newName,
    effectiveName,
    reason,
    creatorRaw,
    creatorUsername,
    creatorId,
    executorId,
    executorRaw,
    // True when the id came from a labelled Executor/Closer field rather than
    // from the prose sentence. The ingest uses this to refuse a "closer" who is
    // really the creator.
    executorLabelled: !!labelledExecutorId,
    ticketType: ticketTypeFromName(effectiveName),
    // Everything the log said, kept so a row that named nobody can be looked at
    // later without another round trip to Discord. "Not recorded" is only worth
    // fixing if you can see what shape the log that caused it was.
    sourceText: text,
  };
}

// ── Transcript button URL ─────────────────────────────────────────
// Tickety attaches a link-style button ("View Transcript") whose URL is the
// transcript. discord.js exposes message.components as ActionRows, each holding
// button components; link buttons carry a `.url`. Returns the first button URL
// that mentions "transcript" (by label or url), else the first link-button URL.
// Tickety hosts the transcripts, so a tickety.top link is the one that actually
// opens a transcript — anything else on the message is some other button. It is
// preferred over a merely transcript-shaped URL rather than taken on order, but
// never invented: a message that only offers another host keeps that link,
// because a fabricated tickety URL is a dead one.
const TICKETY_HOST = /(^|\.)tickety\.top$/i;
function isTicketyUrl(url) {
  try { return TICKETY_HOST.test(new URL(String(url)).hostname); } catch (e) { return false; }
}

function transcriptUrlFromComponents(components) {
  if (!Array.isArray(components)) return null;
  let firstUrl = null, namedTranscript = null;
  for (const row of components) {
    const children = row?.components || [];
    for (const c of children) {
      const url = c?.url || (typeof c?.toJSON === 'function' ? c.toJSON().url : null);
      if (!url) continue;
      if (isTicketyUrl(url)) return url;                 // the real transcript
      if (!firstUrl) firstUrl = url;
      const label = (c?.label || '').toLowerCase();
      if (!namedTranscript && (label.includes('transcript') || /transcript/i.test(url))) namedTranscript = url;
    }
  }
  return namedTranscript || firstUrl;
}

module.exports = {
  normalizeUrl,
  ticketTypeFromName,
  flattenEmbed,
  labelled,
  firstMentionId,
  parseTicketLogEmbed,
  transcriptUrlFromComponents,
  isTicketyUrl,
};
