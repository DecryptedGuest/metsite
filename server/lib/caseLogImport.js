// server/lib/caseLogImport.js
// Rebuild cases from the Administrative Log embeds the site posted to Discord.
//
// ── Why this can exist at all ─────────────────────────────────────
//
// Every case approved on the site posted an "Administrative Log" embed to the
// discipline channel, and that embed was built from the case itself — the officer
// as a Discord mention, the punishments with their durations, the reason, the
// notes, the case ref in the footer, and the timestamp. It is not a summary of a
// case. It is very nearly the case row, written out in public and kept by Discord
// for free, forever.
//
// So when the database goes, the record does not. This reads those embeds back.
// It is the same trick that brought 811 ticket logs back from their own channel,
// and it works for the same reason: the log was always the durable copy and the
// database was always the convenient one.
//
// ── What comes back, and what does not ────────────────────────────
//
// Comes back: the case ref, the officer's Discord id, every punishment with its
// duration, the reason, the notes, when it happened, whether it was a direct
// action, who signed it, and the message id — so a re-run updates rather than
// duplicates, and a later edit to the log still finds its case.
//
// Does not: cases that were never approved. A PENDING or DENIED case posted no
// log, so there is nothing to read. That is the honest limit of this, and it is
// the right way round — an approved case is the one that is a record of something.
// The suspect's Roblox username is also absent unless the log named it, because
// the embed identifies the officer, not the suspect.
//
// One more limit, found by round-tripping a real embed rather than assumed: the log
// only ever wrote a duration for punishments the system treats as TIMED — Zero
// Tolerance, Suspension, Disciplinary Strike 1/2/3. The others have no duration to
// lose (a Written Warning has no length; a Blacklist is permanent by nature), so
// nothing is missing for them. But a case filed under an action name that has since
// been RENAMED or retired was written without its duration, because the builder
// looked the name up to decide whether to print one. Those come back as the
// punishment with no length attached, which is the truth about what the log holds.
//
// Everything imported is marked so it can be told apart from a case filed on the
// site, and so a re-run can be a refresh rather than a pile of duplicates.

const prisma = require('./db');

const ADMIN_LOG_TITLE = /staff consequences|administrative log/i;

// "Infraction ID | #123", possibly prefixed with the direct-action note.
const REF_RE = /infraction\s*id\s*\|\s*(#?[\w-]+)/i;

const clean = (v, max = 2000) =>
  String(v == null ? '' : v).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim().slice(0, max);

/**
 * Read one Administrative Log embed back into case fields.
 * Returns null when the embed is not one of ours.
 */
function parseAdminLogEmbed(embed, msg) {
  if (!embed) return null;

  const title  = String(embed.title || '');
  const footer = String((embed.footer && embed.footer.text) || '');
  // Identified by its own footer, not by the title alone: the title is a phrase
  // anybody could type, whereas "Infraction ID | ..." in a footer is this system's
  // own signature. Both, so a retitled log still parses and a lookalike does not.
  const refMatch = REF_RE.exec(footer);
  if (!refMatch && !ADMIN_LOG_TITLE.test(title)) return null;
  if (!refMatch) return null;

  const fields = Array.isArray(embed.fields) ? embed.fields : [];
  const field = (want) => {
    const f = fields.find(x => x && new RegExp('^\\s*[•·]?\\s*' + want, 'i').test(String(x.name || '')));
    return f ? String(f.value || '') : '';
  };

  const officerRaw   = field('officer');
  const punishRaw    = field('punishment');
  const reason       = clean(field('reason'), 2000);
  const notes        = clean(field('notes'), 2000);

  // The officer, as a mention if the log had one — which it did whenever the site
  // knew their Discord id, i.e. almost always.
  const mention = /<@!?(\d{15,21})>/.exec(officerRaw);
  const officerDiscordId = mention ? mention[1] : null;

  // "[name](https://www.roblox.com/users/123/profile)" when there was no Discord
  // id — so a case against somebody who never signed in is still attributable.
  const link = /\[([^\]]+)\]\(https:\/\/www\.roblox\.com\/users\/(\d+)/.exec(officerRaw);
  const robloxUsername = link ? clean(link[1], 80) : null;
  const robloxUserId   = link ? link[2] : null;
  // A bare name, with no mention and no link.
  const bareName = (!mention && !link && !/unknown officer/i.test(officerRaw))
    ? clean(officerRaw.replace(/[*_`]/g, ''), 80) : null;

  const { actions, summary } = parseActions(punishRaw);

  let caseRef = clean(refMatch[1], 40);
  if (caseRef && !/^#/.test(caseRef) && /^\d+$/.test(caseRef)) caseRef = '#' + caseRef;
  if (/^pending$/i.test(caseRef)) return null;   // never got a ref; nothing to key on

  const signed = (embed.author && embed.author.name)
    ? clean(String(embed.author.name).replace(/^signed,\s*/i, '').replace(/\.$/, ''), 120) : null;

  return {
    caseRef,
    officerDiscordId,
    robloxUsername: robloxUsername || null,
    robloxUserId:   robloxUserId || null,
    officerName:    robloxUsername || bareName || null,
    action:  summary || 'N/A',
    actions: actions.length ? actions : null,
    reason:  reason || 'N/A',
    notes:   notes || 'N/A',
    direct:  /direct action/i.test(footer),
    signedBy: signed,
    createdAt: embed.timestamp
      ? new Date(embed.timestamp)
      : (msg && (msg.createdAt || msg.createdTimestamp) ? new Date(msg.createdAt || msg.createdTimestamp) : new Date()),
    logMessageId: msg ? String(msg.id) : null,
  };
}

/**
 * Reverse buildActionList().
 *
 *   • Strike 1 (7d)
 *   • Blacklist (Permanent)
 *   • Written Warning
 *
 * The duration is in the brackets, and "Permanent" means a timed punishment with
 * no end rather than a duration of zero — those are different facts and storing
 * one as the other would misstate somebody's record.
 */
function parseActions(raw) {
  const text = String(raw == null ? '' : raw);
  const actions = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*[•·*-]\s*(.+?)\s*$/.exec(line);
    const body = m ? m[1] : line.trim();
    if (!body) continue;
    const dur = /^(.*?)\s*\((\d+)\s*d\)\s*$/i.exec(body);
    const perm = /^(.*?)\s*\(permanent\)\s*$/i.exec(body);
    if (dur) actions.push({ action: clean(dur[1], 80), durationDays: parseInt(dur[2], 10) });
    else if (perm) actions.push({ action: clean(perm[1], 80), durationDays: null, permanent: true });
    else actions.push({ action: clean(body, 80) });
  }
  const summary = actions.map(a =>
    a.action + (a.durationDays ? ` (${a.durationDays}d)` : (a.permanent ? ' (Permanent)' : ''))
  ).join(', ');
  return { actions, summary: clean(summary, 200) };
}

// Every case this brings back is owned by one placeholder account, so imported
// cases can be told from cases filed on the site — and so a re-run can clear its
// own previous work without touching anything a person created.
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
 * Read a channel's history and rebuild cases from every Administrative Log in it.
 *
 * @param {object} client   a ready discord.js client
 * @param {string} channelId
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun]  parse and report, write nothing
 * @param {number}  [opts.maxPages]
 * @param {function} [opts.onProgress]
 */
async function importFromChannel(client, channelId, opts = {}) {
  const out = { ok: false, scanned: 0, parsed: 0, created: 0, updated: 0, skipped: 0, pages: 0,
                dryRun: !!opts.dryRun, samples: [], errors: [] };
  if (!client) { out.error = 'the bot is not connected'; return out; }
  if (!channelId) { out.error = 'no channel id given'; return out; }

  let channel;
  try { channel = await client.channels.fetch(String(channelId)); }
  catch (e) { out.error = 'cannot open that channel: ' + e.message; return out; }
  if (!channel || typeof channel.messages?.fetch !== 'function') {
    out.error = 'that is not a text channel the bot can read';
    return out;
  }

  const importer = out.dryRun ? null : await importerUser();
  const maxPages = Math.min(Number(opts.maxPages) || 400, 2000);
  const progress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};

  // Deduplicate within the run: an edited log can appear more than once in
  // history, and the LAST version of a ref is the current one.
  const byRef = new Map();

  let before;
  while (out.pages < maxPages) {
    let page;
    try { page = await channel.messages.fetch({ limit: 100, before }); }
    catch (e) { out.errors.push('fetch failed: ' + e.message); break; }
    if (!page || page.size === 0) break;
    out.pages++;

    for (const [, msg] of page) {
      out.scanned++;
      let parsed = null;
      for (const embed of (msg.embeds || [])) {
        parsed = parseAdminLogEmbed(embed, msg);
        if (parsed) break;
      }
      if (!parsed) { out.skipped++; continue; }
      out.parsed++;
      // Paging runs newest-first, so the FIRST time a ref is seen is its newest
      // version. Keep that one.
      if (!byRef.has(parsed.caseRef)) byRef.set(parsed.caseRef, parsed);
      if (out.samples.length < 8) out.samples.push({
        caseRef: parsed.caseRef, officer: parsed.officerDiscordId || parsed.officerName,
        action: parsed.action, reason: String(parsed.reason).slice(0, 60),
        at: parsed.createdAt,
      });
    }

    before = page.last()?.id;
    if (!before || page.size < 100) break;
    if (out.pages % 5 === 0) progress(`…${out.scanned} messages, ${out.parsed} logs found`);
    // Gentle on the rate limit; this can be forty thousand messages.
    await new Promise(r => setTimeout(r, 320));
  }

  out.uniqueCases = byRef.size;
  if (out.dryRun) { out.ok = true; return out; }

  // Oldest first, so the numbering and the reading order match the history.
  const rows = [...byRef.values()].sort((a, b) => a.createdAt - b.createdAt);
  for (const r of rows) {
    try {
      // Keyed on the case ref. A case already on the site KEEPS ITS OWN DATA — this
      // fills gaps, it does not overwrite somebody's work with a reconstruction.
      const existing = await prisma.case.findUnique({
        where: { caseRef: r.caseRef },
        select: { id: true, userId: true, reason: true, notes: true, logMessageId: true },
      });

      if (existing) {
        const patch = {};
        if (!existing.logMessageId && r.logMessageId) patch.logMessageId = r.logMessageId;
        if ((!existing.reason || existing.reason === 'N/A') && r.reason !== 'N/A') patch.reason = r.reason;
        if ((!existing.notes  || existing.notes  === 'N/A') && r.notes  !== 'N/A') patch.notes  = r.notes;
        if (!Object.keys(patch).length) { out.skipped++; continue; }
        await prisma.case.update({ where: { id: existing.id }, data: patch });
        out.updated++;
        continue;
      }

      await prisma.case.create({
        data: {
          caseRef: r.caseRef,
          // Marked as recovered rather than pretending to be a native case.
          origin: 'ADMINLOG',
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
      if (e && e.code === 'P2002') { out.skipped++; continue; }
      out.errors.push(`${r.caseRef}: ${e.message.slice(0, 160)}`);
    }
  }

  // Keep the site's own counter ahead of everything recovered, or the next case
  // filed on the site collides with an imported ref.
  try {
    const top = [...byRef.keys()]
      .map(k => parseInt(String(k).replace(/\D/g, ''), 10))
      .filter(Number.isFinite);
    if (top.length) {
      const highest = Math.max(...top);
      await prisma.caseCounter.upsert({
        where: { id: 1 },
        update: { count: highest },
        create: { id: 1, count: highest },
      });
      out.counterSetTo = highest;
    }
  } catch (e) { out.errors.push('could not move the case counter: ' + e.message); }

  out.ok = true;
  console.log('[AdminLogImport] ' + JSON.stringify({
    scanned: out.scanned, parsed: out.parsed, unique: out.uniqueCases,
    created: out.created, updated: out.updated, skipped: out.skipped,
  }));
  return out;
}

module.exports = { parseAdminLogEmbed, parseActions, importFromChannel, importerUser };
