// Parser for the legacy Internal Affairs case cards, so `/sync` can rebuild the
// record from channel history.
//
// The cards are embeds written by the old bot, not structured data, so this is
// deliberately forgiving: every field is optional and a card that yields a case
// number plus anything else is still worth storing. Whatever cannot be read is
// reported rather than guessed.
const { ACTION_NAMES, isTimed } = require('./actions');

// "Case #240", optionally hyperlinked: [📋 Case #240](https://…)
const RE_CASE_NO   = /Case\s*#\s*(\d+)/i;
const RE_MD_LINK   = /\[([^\]]*Case\s*#\s*\d+[^\]]*)\]\((https?:\/\/[^)\s]+)\)/i;
const RE_BARE_URL  = /(https?:\/\/[^\s)>\]]+)/;
const RE_MENTION   = /<@!?(\d+)>/;
const RE_SUBMITTED = /Submitted by\s*(.+)/i;
const RE_APPROVED  = /Approved by\s*(.+)/i;
const RE_DENIED    = /Denied by\s*(.+)/i;
// "+4 pts (44 total)"
const RE_POINTS    = /([+-]?\d+)\s*pts?\s*(?:\((\d+)\s*total\))?/i;
// "Blacklist — ZF-B106" / "Blacklist - PL-M304 (General Misconduct)"
const RE_BLACKLIST = /Blacklist\s*[—–-]\s*([A-Z]{2}-[A-Z]?\d+[^\n(]*)(?:\(([^)]+)\))?/i;
// "[3 days]" / "[1–2]" — a real value, versus the unfilled "[Specify …]" template
const RE_BRACKET   = /\[([^\]]+)\]/;
const RE_TEMPLATE  = /specify|number of days|n\/a|^-+$/i;
// "27/08/26 22:28pm"
const RE_DATETIME  = /(\d{1,2}\/\d{1,2}\/\d{2,4})\s*(\d{1,2}:\d{2}\s*(?:am|pm)?)?/i;

// Strip Discord markdown WITHOUT touching underscores (Roblox usernames are
// full of them) or the '>' inside a <@id> mention. Only a leading '>' is a
// blockquote marker.
const stripMd = (s) => String(s || '')
  .replace(/<a?:\w+:\d+>/g, '')          // custom emoji
  .replace(/\*\*|`/g, '')
  .replace(/^\s*>\s?/gm, '')             // blockquote marker, line-initial only
  .trim();

/** Flatten an embed into searchable text, keeping line structure. */
function embedText(embed) {
  const parts = [];
  if (embed.title) parts.push(embed.title);
  if (embed.author?.name) parts.push(embed.author.name);
  if (embed.description) parts.push(embed.description);
  for (const f of embed.fields || []) {
    parts.push(f.name || '');
    parts.push(f.value || '');
  }
  if (embed.footer?.text) parts.push(embed.footer.text);
  return parts.join('\n');
}

/**
 * A punishment line counts as APPLIED only if it carries a real value or is a
 * bare bullet. "Suspension [Specify number of days]" is an unfilled template
 * row from the form and must not be recorded as a punishment — that distinction
 * is the whole reason this parser is conservative.
 */
function parsePunishments(text) {
  const applied = [], template = [];

  for (const rawLine of text.split('\n')) {
    const line = stripMd(rawLine).replace(/^[•\-*]\s*/, '').trim();
    if (!line) continue;

    const action = ACTION_NAMES.find(a => line.toLowerCase().startsWith(a.toLowerCase()))
      // "Strike(s) [1-2]" is how the form writes disciplinary strikes
      || (/^strike\(s\)/i.test(line) ? 'Disciplinary Strike' : null);
    if (!action) continue;

    const bracket = line.match(RE_BRACKET)?.[1]?.trim() || null;
    const isTemplate = bracket ? RE_TEMPLATE.test(bracket) : false;
    const hasValue   = bracket && !isTemplate;

    const entry = { action, raw: line, value: hasValue ? bracket : null };

    // Days, but only for punishments that actually expire — "Strike(s) [2]"
    // is a strike NUMBER, not a duration.
    if (hasValue && isTimed(action)) {
      const days = bracket.match(/(\d+)\s*day/i)?.[1] || (/^\d+$/.test(bracket) ? bracket : null);
      if (days) entry.durationDays = Number(days);
    }
    // Blacklist codes live on the line itself, not in brackets.
    const bl = line.match(RE_BLACKLIST);
    if (bl) {
      entry.code = bl[1].trim();
      if (bl[2]) entry.codeReason = bl[2].trim();
    }

    if (isTemplate && !entry.code) template.push(entry);
    else applied.push(entry);
  }

  // "Strike(s) [1-2]" → expand to the numbered strike actions it names.
  const expanded = [];
  for (const p of applied) {
    if (p.action !== 'Disciplinary Strike') { expanded.push(p); continue; }
    const nums = (p.value || '').match(/\d/g);
    if (!nums?.length) { expanded.push({ ...p, action: 'Disciplinary Strike 1' }); continue; }
    for (const n of [...new Set(nums)]) {
      if (['1', '2', '3'].includes(n)) expanded.push({ ...p, action: `Disciplinary Strike ${n}` });
    }
  }
  return { applied: expanded, template };
}

/**
 * Parse one legacy case card.
 * Returns null when the embed carries no case number at all.
 */
function parseCaseCard(message) {
  const embed = message.embeds?.[0];
  if (!embed) return null;
  const text = embedText(embed);

  const caseNo = text.match(RE_CASE_NO)?.[1];
  if (!caseNo) return null;

  const link = text.match(RE_MD_LINK);
  const docUrl = link?.[2] || embed.url || text.match(RE_BARE_URL)?.[1] || null;

  const submittedLine = text.match(RE_SUBMITTED)?.[1] || '';
  const approvedLine  = (embed.author?.name || '').match(RE_APPROVED)?.[1]
                     || text.match(RE_APPROVED)?.[1] || null;
  const deniedLine    = (embed.author?.name || '').match(RE_DENIED)?.[1]
                     || text.match(RE_DENIED)?.[1] || null;

  const { applied, template } = parsePunishments(text);
  const pts = text.match(RE_POINTS);
  const when = text.match(RE_DATETIME);

  // The decision column is authoritative; fall back to the author line.
  const approved = /approved/i.test(text);
  const denied   = /denied/i.test(text) && !approved;

  return {
    caseRef: `#${caseNo}`,
    caseNumber: Number(caseNo),
    docUrl,
    submittedByMention: submittedLine.match(RE_MENTION)?.[1] || null,
    submittedByRaw: stripMd(submittedLine) || null,
    reviewedByRaw: stripMd(approvedLine || deniedLine || '') || null,
    status: approved ? 'APPROVED' : (denied ? 'DENIED' : 'PENDING'),
    punishments: applied,
    templateOnly: template,
    pointsAwarded: pts ? Number(pts[1]) : null,
    pointsTotalAtTime: pts?.[2] ? Number(pts[2]) : null,
    decisionAt: when ? `${when[1]}${when[2] ? ' ' + when[2] : ''}` : null,
    thumbnailUrl: embed.thumbnail?.url || null,
    sourceMessageId: message.id,
    sourceUrl: message.url || null,
    postedAt: message.createdAt || null,
  };
}

module.exports = { parseCaseCard, parsePunishments, embedText, stripMd };
