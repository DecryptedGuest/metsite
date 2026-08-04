// server/lib/clanslabsXp.js
// Import the Clans Labs XP leaderboard as everyone's starting XP.
//
// Clans Labs is a separate Roblox bot with its own XP numbers, on its own scale:
// the top of the list is 289,997 and the bottom is 5. Ours is a ladder that ends
// at 100 (Chief Inspector), so every number is capped on the way in. Somebody on
// 289,997 there and somebody on 200 there both arrive here as 100 — which is
// correct, because both are already above everything our ladder can award.
//
// The list names ROBLOX accounts. Our XP is keyed on DISCORD ids. So the import
// has three outcomes per row, and says how many landed in each:
//
//   SET      we know their Discord id, so their balance is set now.
//   PENDING  we do not, so it is held against their Roblox account and claimed
//            the first time they log in or somebody looks them up.
//   UNKNOWN  Roblox does not have an account by that name, so nothing is stored.
//
// UNKNOWN matters more than it looks. The pasted leaderboard has rows like "the",
// "big", "con" and "080" — usernames cut short by the bot's own column width.
// Roblox will happily resolve "the" to a real account belonging to a stranger, so
// resolution is EXACT only: a row is either the account it names or it is
// nothing. Guessing would award a stranger 15 XP in the Metropolitan Police.
//
// Re-running it is safe and is the intended way to use it. Every write takes the
// higher of the two numbers, so a second pass with a shorter page cannot demote
// anybody, and rows already claimed are left alone.

const fs = require('fs');
const path = require('path');
const prisma = require('./db');
const XP = require('./xp');

const DATA_FILE = () => process.env.CLANSLABS_XP_FILE
  || path.join(__dirname, '..', '..', 'data', 'clanslabs-xp.txt');

// "#42 SomeUser: 220". The position is ignored — it is a property of the page it
// was read from, not of the person.
const ROW = /^\s*#?\s*(\d+)?\s*([A-Za-z0-9_.]{2,40})\s*:\s*(-?\d+)\s*$/;

/**
 * Parse the pasted leaderboard.
 *
 * Keeps the highest XP seen per account, and remembers how many times each was
 * seen so a re-import can be told apart from a paste with genuine duplicates.
 *
 * @returns {{ rows: Array<{username, xp, seen}>, lines: number, skipped: string[] }}
 */
function parse(text) {
  const byKey = new Map();
  const skipped = [];
  let lines = 0;

  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#!') || line.startsWith('//')) continue;
    // A comment line in the data file, as opposed to "#42 name: 10". A bare "#"
    // on its own is a comment too — it is how the header block separates
    // paragraphs, and reporting it as an unreadable row is noise.
    if (/^#(\s|$)/.test(line) || /^#[^0-9]/.test(line)) continue;
    if (/^Leaderboard\b/i.test(line) || /Viewable\b/i.test(line)) continue;

    const m = ROW.exec(line);
    if (!m) { skipped.push(line.slice(0, 80)); continue; }
    lines++;

    const username = m[2];
    const xp = parseInt(m[3], 10);
    if (!Number.isFinite(xp) || xp < 0) { skipped.push(line.slice(0, 80)); continue; }

    const key = XP.usernameKey(username);
    const hit = byKey.get(key);
    if (!hit) byKey.set(key, { username, xp, seen: 1 });
    else {
      hit.seen++;
      // The highest number wins, and so does the spelling that came with it.
      if (xp > hit.xp) { hit.xp = xp; hit.username = username; }
    }
  }

  const rows = [...byKey.values()].sort((a, b) => b.xp - a.xp || a.username.localeCompare(b.username));
  return { rows, lines, skipped };
}

/** The leaderboard as it sits on disk. */
function readFile(file) {
  const p = file || DATA_FILE();
  if (!fs.existsSync(p)) throw new Error(`No leaderboard file at ${p}`);
  return fs.readFileSync(p, 'utf8');
}

/**
 * Every Discord id we can find for a set of Roblox ids, without asking anybody.
 *
 * Our own tables know this for everybody who has ever logged into the dashboard
 * or been given XP, which is most of the people who matter and costs two queries.
 * RoVer is the fallback (see resolveDiscord) and it costs a call per person.
 */
async function localDiscordIds(robloxIds) {
  const ids = [...new Set(robloxIds.map(String).filter(Boolean))];
  const out = new Map();   // robloxId → discordId
  if (!ids.length) return out;

  const [users, xpRows] = await Promise.all([
    prisma.user.findMany({
      where: { robloxId: { in: ids } },
      select: { discordId: true, robloxId: true },
    }),
    prisma.metXp.findMany({
      where: { robloxId: { in: ids } },
      select: { discordId: true, robloxId: true },
    }),
  ]);
  // The dashboard row wins where both exist: it is the one a human verified.
  for (const r of xpRows) if (r.robloxId && r.discordId) out.set(String(r.robloxId), String(r.discordId));
  for (const u of users) if (u.robloxId && u.discordId) out.set(String(u.robloxId), String(u.discordId));
  return out;
}

/**
 * Ask RoVer who a Roblox account is on Discord.
 *
 * One call per account, so it is rate-limited from our side and given up on
 * entirely after a few refusals — the rest of the list simply stays pending,
 * which loses nothing. Never throws.
 */
async function roverDiscordId(robloxId, state) {
  if (state.roverDead) return null;
  try {
    const members = await require('./roblox').getDiscordFromRoblox(robloxId);
    state.roverCalls++;
    const first = (members || []).find(m => m && m.discordId);
    return first ? String(first.discordId) : null;
  } catch (err) {
    state.roverErrors++;
    // A couple of failures is a bad account; a run of them is a dead API or a
    // rate limit, and hammering it would only make it worse.
    if (state.roverErrors >= 5) {
      state.roverDead = true;
      state.notes.push(`RoVer stopped answering after ${state.roverCalls} lookups `
        + `(${err.message}) — the rest were left pending.`);
    }
    return null;
  }
}

/**
 * Import the leaderboard.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun]   work out what would happen and change nothing
 * @param {boolean} [opts.rover]    ask RoVer for accounts we cannot match locally
 * @param {number}  [opts.limit]    only the first N rows, highest XP first
 * @param {string}  [opts.file]     a different leaderboard file
 * @param {string}  [opts.text]     the leaderboard itself, instead of a file
 * @param {string}  [opts.actor]    who to credit on the XP events
 * @param {function} [opts.onProgress]  called with a short line of progress. This
 *        takes minutes against the live APIs, so anything driving it needs
 *        something to show; silence for three minutes is indistinguishable from a
 *        hang.
 * @returns {Promise<object>} counts, notes and a sample, never a throw for one
 *          bad row
 */
async function importLeaderboard(opts = {}) {
  const dry = opts.dryRun === true;
  const useRover = opts.rover !== false;
  const text = opts.text != null ? opts.text : readFile(opts.file);
  const say = (stage, extra) => {
    if (typeof opts.onProgress === 'function') {
      try { opts.onProgress(Object.assign({ stage }, extra || {})); } catch (e) {}
    }
  };

  const parsed = parse(text);
  let rows = parsed.rows;
  if (opts.limit && opts.limit > 0) rows = rows.slice(0, opts.limit);

  const cap = XP.maxXp();
  const state = { roverCalls: 0, roverErrors: 0, roverDead: !useRover, notes: [] };
  const out = {
    ok: true, dryRun: dry, cap,
    parsed: parsed.lines, accounts: parsed.rows.length, considered: rows.length,
    resolved: 0, unknown: 0, unasked: 0, capped: 0,
    set: 0, raised: 0, unchanged: 0, pending: 0, failed: 0,
    unknownNames: [], samples: [], notes: state.notes,
    skippedLines: parsed.skipped.slice(0, 10),
  };
  if (parsed.skipped.length) {
    out.notes.push(`${parsed.skipped.length} line(s) in the file were not "#n name: xp" and were ignored.`);
  }

  // 1. Names → Roblox ids, in paced batches of a hundred.
  say('Asking Roblox who these usernames are', { done: 0, total: rows.length });
  const roblox = require('./roblox');
  const lookup = await roblox.getRobloxIdsFromUsernames(rows.map(r => r.username), {
    onBatch: (p) => say('Asking Roblox who these usernames are',
                        { done: p.done, total: p.total }),
  });
  const resolved = lookup.users || lookup;                 // tolerate an older shape
  const unasked = new Set((lookup.failed || []).map(n => XP.usernameKey(n)));
  if (lookup.retries) out.roblox = { calls: lookup.calls, retries: lookup.retries };

  const hits = [];
  for (const r of rows) {
    const key = XP.usernameKey(r.username);
    const rec = resolved.get(key);
    if (!rec) {
      // "Roblox never answered about them" and "Roblox says there is no such
      // account" are completely different facts, and only the second one means
      // the row is junk. Reporting a rate limit as a non-existent officer is how
      // somebody ends up deleting real people from a list.
      if (unasked.has(key)) out.unasked++;
      else {
        out.unknown++;
        if (out.unknownNames.length < 40) out.unknownNames.push(r.username);
      }
      continue;
    }
    out.resolved++;
    if (r.xp > cap) out.capped++;
    hits.push({ ...r, robloxId: rec.id, robloxUsername: rec.username, capped: Math.min(r.xp, cap) });
  }
  if (out.unasked) {
    out.notes.push(`Roblox rate-limited ${out.unasked} name(s) — they were NOT looked at, and nothing `
      + `was stored or ruled out for them. Run it again in a few minutes to pick them up; `
      + `nothing already imported will be touched.`);
  }

  // 2. Roblox ids → Discord ids, from our own tables first.
  say('Matching them against our own records', { done: 0, total: hits.length });
  const local = await localDiscordIds(hits.map(h => h.robloxId));

  // 3. One row at a time, so a single failure is one row.
  let n = 0;
  for (const h of hits) {
    // Every twenty-five, which is often enough to look alive and rare enough not
    // to be the expensive part of the loop.
    if (n % 25 === 0) {
      say(dry ? 'Working out what would change' : 'Writing the balances',
          { done: n, total: hits.length });
    }
    n++;
    let discordId = local.get(h.robloxId) || null;
    if (!discordId && useRover) discordId = await roverDiscordId(h.robloxId, state);

    try {
      if (dry) {
        if (discordId) out.set++; else out.pending++;
        if (out.samples.length < 12) {
          out.samples.push({ username: h.robloxUsername, xp: h.capped, from: h.xp,
                             to: discordId ? 'discord' : 'pending', discordId });
        }
        continue;
      }

      if (!discordId) {
        await XP.holdPending({
          robloxUsername: h.robloxUsername, robloxId: h.robloxId,
          xp: h.capped, source: 'clanslabs',
          note: h.xp > cap ? `Clans Labs had ${h.xp}, capped to ${cap}.` : null,
        });
        out.pending++;
      } else {
        // Held first, then claimed, so the same code path does both and there is
        // a record of where the number came from either way. claimPending takes
        // the higher of the two, so this cannot lower a balance somebody earned.
        await XP.holdPending({
          robloxUsername: h.robloxUsername, robloxId: h.robloxId,
          xp: h.capped, source: 'clanslabs',
          note: h.xp > cap ? `Clans Labs had ${h.xp}, capped to ${cap}.` : null,
        });
        const claim = await XP.claimPending({
          discordId, robloxId: h.robloxId, robloxUsername: h.robloxUsername,
        });
        out.set++;
        if (claim && claim.raised > 0) out.raised++;
        else out.unchanged++;
      }

      if (out.samples.length < 12) {
        out.samples.push({ username: h.robloxUsername, xp: h.capped, from: h.xp,
                           to: discordId ? 'discord' : 'pending', discordId });
      }
    } catch (err) {
      out.failed++;
      if (out.notes.length < 20) out.notes.push(`${h.robloxUsername}: ${err.message}`);
    }
  }

  if (state.roverCalls) out.roverLookups = state.roverCalls;
  if (out.unknown) {
    out.notes.push(`${out.unknown} name(s) are not Roblox accounts — the leaderboard cuts long `
      + `usernames short, and a shortened name is a different account or none at all. `
      + `Nothing was stored for them.`);
  }
  // The one number somebody should act on: how much of the list is still to do.
  out.complete = out.unasked === 0;
  say('Done', { done: hits.length, total: hits.length });
  return out;
}

/**
 * Try again on rows that are still waiting for a Discord id.
 *
 * The import leaves most of the list pending on purpose. This walks what is left
 * and claims anything that can be claimed now — worth running after a wave of
 * people join, and cheap enough to run on a schedule.
 *
 * @param {object} [opts]
 * @param {number} [opts.limit]  how many pending rows to try (default 200)
 * @param {boolean} [opts.rover] ask RoVer as well as our own tables
 */
async function sweepPending(opts = {}) {
  const limit = Math.max(1, Math.min(1000, opts.limit || 200));
  const useRover = opts.rover !== false;
  const dry = opts.dryRun === true;

  const rows = await prisma.metXpPending.findMany({
    where: { claimedAt: null },
    orderBy: [{ xp: 'desc' }, { id: 'asc' }],
    take: limit,
  });

  const state = { roverCalls: 0, roverErrors: 0, roverDead: !useRover, notes: [] };
  const out = { ok: true, dryRun: dry, looked: rows.length, resolvedIds: 0,
                claimed: 0, raised: 0, stillWaiting: 0, failed: 0, notes: state.notes };
  if (!rows.length) return out;

  // Fill in any missing Roblox ids first — a row imported before Roblox answered
  // has a username and nothing else.
  const needIds = rows.filter(r => !r.robloxId);
  if (needIds.length) {
    const got = await require('./roblox').getRobloxIdsFromUsernames(needIds.map(r => r.robloxUsername));
    const found = got.users || got;
    if ((got.failed || []).length) {
      out.notes.push(`Roblox rate-limited ${got.failed.length} name(s); they stay in the table `
        + `and the next sweep will try again.`);
    }
    for (const r of needIds) {
      const rec = found.get(XP.usernameKey(r.robloxUsername));
      if (!rec) continue;
      r.robloxId = rec.id;
      out.resolvedIds++;
      if (!dry) {
        await prisma.metXpPending.update({ where: { id: r.id }, data: { robloxId: rec.id } })
          .catch(() => {});
      }
    }
  }

  const local = await localDiscordIds(rows.map(r => r.robloxId).filter(Boolean));

  for (const r of rows) {
    let discordId = r.robloxId ? local.get(String(r.robloxId)) || null : null;
    if (!discordId && r.robloxId && useRover) discordId = await roverDiscordId(r.robloxId, state);
    if (!discordId) { out.stillWaiting++; continue; }
    if (dry) { out.claimed++; continue; }
    try {
      const claim = await XP.claimPending({
        discordId, robloxId: r.robloxId, robloxUsername: r.robloxUsername,
      });
      if (claim) { out.claimed++; if (claim.raised > 0) out.raised++; }
      else out.stillWaiting++;
    } catch (err) {
      out.failed++;
      if (out.notes.length < 20) out.notes.push(`${r.robloxUsername}: ${err.message}`);
    }
  }
  return out;
}

/** What is still waiting, for the dev panel. */
async function pendingSummary(take = 20) {
  const [waiting, claimed, top, sum] = await Promise.all([
    prisma.metXpPending.count({ where: { claimedAt: null } }),
    prisma.metXpPending.count({ where: { claimedAt: { not: null } } }),
    prisma.metXpPending.findMany({
      where: { claimedAt: null },
      orderBy: [{ xp: 'desc' }, { id: 'asc' }],
      take,
      select: { robloxUsername: true, robloxId: true, xp: true, source: true, note: true },
    }),
    prisma.metXpPending.aggregate({ where: { claimedAt: null }, _sum: { xp: true } }),
  ]);
  return { waiting, claimed, top, totalPendingXp: sum._sum.xp || 0, cap: XP.maxXp() };
}

module.exports = {
  parse, readFile, importLeaderboard, sweepPending, pendingSummary,
  localDiscordIds, DATA_FILE,
};
