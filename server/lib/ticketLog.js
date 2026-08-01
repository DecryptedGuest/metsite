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
  if (/general|support|question|inquir|help/.test(s))     return 'GENERAL_SUPPORT';
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
  const looksLikeTickety =
    /closed a ticket/i.test(text) ||
    /ticket\s*name\s*:/i.test(text) ||
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

  const executorId = labelled(text, 'Executor ID') || firstMentionId(labelled(text, 'Executor') || '');

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
    ticketType: ticketTypeFromName(effectiveName),
  };
}

// ── Transcript button URL ─────────────────────────────────────────
// Tickety attaches a link-style button ("View Transcript") whose URL is the
// transcript. discord.js exposes message.components as ActionRows, each holding
// button components; link buttons carry a `.url`. Returns the first button URL
// that mentions "transcript" (by label or url), else the first link-button URL.
function transcriptUrlFromComponents(components) {
  if (!Array.isArray(components)) return null;
  let firstUrl = null;
  for (const row of components) {
    const children = row?.components || [];
    for (const c of children) {
      const url = c?.url || (typeof c?.toJSON === 'function' ? c.toJSON().url : null);
      if (!url) continue;
      if (!firstUrl) firstUrl = url;
      const label = (c?.label || '').toLowerCase();
      if (label.includes('transcript') || /transcript/i.test(url)) return url;
    }
  }
  return firstUrl;
}

module.exports = {
  normalizeUrl,
  ticketTypeFromName,
  flattenEmbed,
  labelled,
  firstMentionId,
  parseTicketLogEmbed,
  transcriptUrlFromComponents,
};
