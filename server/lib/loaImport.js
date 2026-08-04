// server/lib/loaImport.js
// Bring leave that already exists elsewhere into the LOA system.
//
// Nine people are on leave right now, recorded in whatever was keeping the list
// before this. Their leave is real — the dates are agreed, the reasons are given,
// and they already hold the on-leave role — but none of it is in the database, so
// `/loa active` shows nothing, the quota check cannot see who is exempt, and
// nothing will take the role off them when their leave finishes.
//
// ── Why this is not `loa.create()` ────────────────────────────────
//
// create() is for somebody asking for leave now: it stamps startAt as the current
// moment and computes endAt from a number of days. Leave that started on 21 July
// cannot be expressed that way. This writes the row directly, backdated, already
// APPROVED — the decision was made by a person, off-system, and re-litigating it
// would be inventing a review that did not happen.
//
// ── What it will not do ───────────────────────────────────────────
//
//   * It never adds the on-leave role. They already have it. Adding it again
//     would be harmless but it would also mean this code cannot tell the
//     difference between "already on leave" and "just put on leave", and the
//     whole point is that the sweep takes the role OFF at the end.
//   * It never overwrites. A row whose id is already there is left exactly as it
//     is and reported as already imported, so running this twice is safe.
//   * It never creates a second live leave for somebody who already has one.
//
// ── The end date is inclusive ─────────────────────────────────────
//
// "21 July 2026 - 04 August 2026" means the person is away THROUGH the 4th, not
// until the 4th began. So endAt is the last moment of the end date rather than
// midnight at the start of it, in UTC. Getting this wrong by one day means the
// sweep strips somebody's role while they are still on leave — the first entry in
// the list ends today, so this is not a theoretical off-by-one.

const fs = require('fs');
const path = require('path');
const prisma = require('./db');

const DEFAULT_FILE = () => process.env.LOA_IMPORT_FILE
  || path.join(__dirname, '../../data/loa-import.txt');

const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11,
};

/** "21 July 2026" → a Date at the START of that day, UTC. Null if unreadable. */
function parseDay(text) {
  const m = /^\s*(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\.?\s+(\d{4})\s*$/.exec(String(text || ''));
  if (!m) return null;
  const month = MONTHS[m[2].toLowerCase()];
  if (month == null) return null;
  const day = parseInt(m[1], 10);
  const year = parseInt(m[3], 10);
  if (!(day >= 1 && day <= 31)) return null;
  const d = new Date(Date.UTC(year, month, day));
  // Reject 31 February and friends — Date rolls them over silently.
  if (d.getUTCDate() !== day || d.getUTCMonth() !== month) return null;
  return d;
}

/** The last millisecond of the day a Date falls on, UTC. */
function endOfDay(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
}

/**
 * Read the pasted "Active LOAs" list.
 *
 * The shape is four lines per person, and a reason that may run over several:
 *
 *   @username
 *   ID: Mgc9YsnB
 *   Duration: 21 July 2026 - 04 August 2026
 *   Reason: …
 *
 * A reason ends where the next person's "@" line starts, not at the end of its own
 * line — several of these are long enough to wrap, and cutting at the newline
 * would file half a sentence.
 *
 * @returns {{ entries: Array, problems: string[] }}
 */
function parse(text) {
  const lines = String(text || '').split(/\r?\n/);
  const entries = [];
  const problems = [];

  let cur = null;
  const finish = () => {
    if (!cur) return;
    const missing = [];
    if (!cur.id) missing.push('an ID');
    if (!cur.startText) missing.push('a duration');
    if (!cur.reason) missing.push('a reason');
    if (missing.length) {
      problems.push(`@${cur.username}: no ${missing.join(', no ')} — skipped.`);
      cur = null;
      return;
    }
    const start = parseDay(cur.startText);
    const end   = parseDay(cur.endText);
    if (!start || !end) {
      problems.push(`@${cur.username}: could not read the dates "${cur.startText} - ${cur.endText}" — skipped.`);
      cur = null;
      return;
    }
    if (end < start) {
      problems.push(`@${cur.username}: the leave ends before it starts — skipped.`);
      cur = null;
      return;
    }
    entries.push({
      id: cur.id,
      username: cur.username,
      startAt: start,
      endAt: endOfDay(end),
      reason: cur.reason.replace(/\s+/g, ' ').trim().slice(0, 900),
    });
    cur = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^active\s+loas?$/i.test(line)) continue;      // the heading

    const at = /^@\s*(\S+)\s*$/.exec(line);
    if (at) { finish(); cur = { username: at[1].replace(/^@/, ''), reason: '' }; continue; }
    if (!cur) { problems.push(`Ignored a line before the first person: "${line.slice(0, 60)}"`); continue; }

    let m;
    if ((m = /^ID\s*:\s*(\S+)\s*$/i.exec(line)))          { cur.id = m[1]; continue; }
    if ((m = /^Duration\s*:\s*(.+?)\s*[-–—]\s*(.+)$/i.exec(line))) {
      cur.startText = m[1].trim(); cur.endText = m[2].trim(); continue;
    }
    if ((m = /^Reason\s*:\s*(.*)$/i.exec(line)))          { cur.reason = m[1]; continue; }
    // A continuation of the reason.
    if (cur.reason) { cur.reason += ' ' + line; continue; }
    problems.push(`@${cur.username}: did not recognise "${line.slice(0, 60)}"`);
  }
  finish();

  return { entries, problems };
}

/** Read whichever file holds the list. */
function readFile(file) {
  const p = file || DEFAULT_FILE();
  try { return { ok: true, text: fs.readFileSync(p, 'utf8'), file: p }; }
  catch (err) { return { ok: false, error: `Could not read ${p}: ${err.message}`, file: p }; }
}

/**
 * Turn a Discord username into a member of the guild.
 *
 * Exact match only, on the username or the display name. A leave imported against
 * the wrong person takes somebody else's role off at the end of it, and a
 * near-match is exactly how that happens — "noir.n" and "noir" are different
 * people. Anything not matched exactly is reported by name, not guessed at.
 */
async function resolveMember(guild, username) {
  if (!guild) return null;
  const want = String(username || '').trim().toLowerCase();
  if (!want) return null;
  try {
    const hits = await guild.members.fetch({ query: want.replace(/[.]+$/, ''), limit: 10 });
    for (const m of hits.values()) {
      if (String(m.user.username || '').toLowerCase() === want) return m;
    }
    for (const m of hits.values()) {
      if (String(m.displayName || '').toLowerCase() === want) return m;
      // "PC | someone" — the Roblox half of a rank nickname.
      if (String(m.displayName || '').split('|').pop().trim().toLowerCase() === want) return m;
    }
  } catch (err) { /* the query found nothing, or the fetch failed */ }
  return null;
}

/**
 * Import the list.
 *
 * @param {object}  opts
 * @param {boolean} opts.dryRun    read and resolve, write nothing
 * @param {object}  opts.guild     a discord.js Guild, for resolving usernames
 * @param {string}  opts.file      override the file
 * @param {Array}   opts.entries   supply the rows directly (tests)
 * @param {string}  opts.scope     'MET' (default) or 'DIVISION'
 * @param {string}  opts.division  when scope is DIVISION
 */
async function importLoas(opts = {}) {
  const dry = opts.dryRun === true;
  const out = {
    ok: true, dryRun: dry, file: null, read: 0,
    imported: [], alreadyThere: [], unresolved: [], skipped: [], problems: [], errors: [],
  };

  let entries = opts.entries;
  if (!entries) {
    const read = readFile(opts.file);
    out.file = read.file;
    if (!read.ok) { out.ok = false; out.errors.push(read.error); return out; }
    const parsed = parse(read.text);
    entries = parsed.entries;
    out.problems = parsed.problems;
  }
  out.read = entries.length;
  if (!entries.length) {
    out.ok = false;
    out.errors.push('Nothing in the list could be read.');
    return out;
  }

  for (const en of entries) {
    try {
      // Already imported? Left alone — never overwritten. Somebody may have
      // extended or ended it since, and this must not undo that.
      const existing = await prisma.loaRequest.findUnique({ where: { id: en.id } }).catch(() => null);
      if (existing) {
        out.alreadyThere.push({ id: en.id, username: en.username, status: existing.status });
        continue;
      }

      const member = en.discordId
        ? { id: en.discordId, user: { username: en.username }, displayName: en.displayName }
        : await resolveMember(opts.guild, en.username);
      if (!member) {
        out.unresolved.push({ id: en.id, username: en.username });
        continue;
      }
      const discordId = String(member.id);

      // One live leave per person. If they already have one — imported under a
      // different id, or filed through /loa — this is a duplicate of it.
      const open = await prisma.loaRequest.findFirst({
        where: { discordId, status: { in: ['PENDING', 'APPROVED'] }, endedAt: null, expiredAt: null },
        select: { id: true, status: true, endAt: true },
      }).catch(() => null);
      if (open) {
        out.skipped.push({ id: en.id, username: en.username,
          why: `already has ${open.status === 'PENDING' ? 'a request waiting' : 'leave running'} (${open.id})` });
        continue;
      }

      // Their site account, when they have one, so their leave and their
      // dashboard are the same person.
      const user = await prisma.user.findUnique({
        where: { discordId },
        select: { id: true, displayName: true, discordUsername: true },
      }).catch(() => null);

      const row = {
        id:              en.id,
        userId:          user ? user.id : null,
        userName:        (user && (user.displayName || user.discordUsername))
                          || member.displayName || en.username,
        discordId,
        discordUsername: (member.user && member.user.username) || en.username,
        scope:           opts.scope === 'DIVISION' ? 'DIVISION' : 'MET',
        division:        opts.scope === 'DIVISION' ? (opts.division || null) : null,
        reason:          en.reason,
        startAt:         en.startAt,
        endAt:           en.endAt,
        status:          'APPROVED',
        // The decision was made by a person before this existed. Recording it as
        // reviewed by the importer would be inventing a reviewer; saying where it
        // came from is the honest version.
        reviewerName:    'Imported from the existing leave list',
        reviewedAt:      new Date(),
      };

      if (dry) {
        out.imported.push({ id: en.id, username: en.username, discordId,
                            startAt: en.startAt, endAt: en.endAt, hasAccount: !!user });
        continue;
      }
      await prisma.loaRequest.create({ data: row });
      out.imported.push({ id: en.id, username: en.username, discordId,
                          startAt: en.startAt, endAt: en.endAt, hasAccount: !!user });
    } catch (err) {
      out.errors.push(`${en.username} (${en.id}): ${err.message}`);
    }
  }

  if (!dry && out.imported.length) {
    console.log(`[LOA] imported ${out.imported.length} existing leave record(s)`);
  }
  return out;
}

module.exports = { parse, parseDay, endOfDay, readFile, resolveMember, importLoas, DEFAULT_FILE };
