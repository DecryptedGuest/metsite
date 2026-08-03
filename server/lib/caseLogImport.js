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

function textField(text, kind) {
  const body = String(text || '');
  for (const label of LABELS[kind]) {
    const re = new RegExp('^\\s*[•·*\\-–—]?\\s*\\*{0,2}' + escRe(label)
      + '\\*{0,2}\\s*[:\\-]\\s*(.+)$', 'im');
    const m = re.exec(body);
    if (m && m[1].trim()) return m[1].trim();
  }
  return '';
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
  const incoming = new Set(rows.map(r => r.caseRef));
  let nextFree = out.highestRef + 1;
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
 * Put the case counter above the highest ref in use.
 *
 * RAISED, never lowered. Setting it to the imported maximum when the site already
 * holds something higher would hand the next case a number that is taken.
 */
async function raiseCounter() {
  try {
    const refs = await prisma.case.findMany({ select: { caseRef: true } });
    const highest = refs.reduce((n, c) => {
      const v = parseInt(String(c.caseRef || '').replace(/\D/g, ''), 10);
      return Number.isFinite(v) && v > n ? v : n;
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
};
