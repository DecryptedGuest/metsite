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
  if (embed.title) parts.push(embed.title);
  if (embed.description) parts.push(embed.description);
  const fields = embed.fields || [];
  for (const f of fields) {
    if (f?.name)  parts.push(f.name);
    if (f?.value) parts.push(f.value);
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

// The first Discord user mention (<@id> / <@!id>) in a string, or null.
function firstMentionId(s) {
  const m = String(s || '').match(/<@!?(\d{15,21})>/);
  return m ? m[1] : null;
}

// ── Parse a single ticket-log embed ───────────────────────────────
// Returns a plain object of the fields we care about, or null if the embed
// doesn't look like a Tickety closed-ticket log.
function parseTicketLogEmbed(embed) {
  const text = flattenEmbed(embed);
  if (!text) return null;

  const footer = (embed?.footer?.text || '').toLowerCase();
  const title  = String(embed?.title || '');
  // A closed-ticket log, in any of the shapes the bot has posted it. The wording
  // of the sentence has changed between versions ("closed a ticket", "has closed
  // this ticket"), and some layouts carry only a Ticket ID rather than a name, so
  // matching on one phrase alone dropped whole batches of logs on the floor.
  const looksLikeTickety =
    /clos(?:ed|ing)\s+(?:a|this|the)\s+ticket/i.test(text) ||
    /ticket\s*name\s*:/i.test(text) ||
    /ticket\s*id\s*:/i.test(text) ||
    (/ticket/i.test(title) && /clos/i.test(title)) ||
    footer.includes('tickety');
  if (!looksLikeTickety) return null;

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
    if (v && !/^\d{15,21}$/.test(v)) { executorRaw = v; break; }
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
    ticketType: ticketTypeFromName(effectiveName),
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
