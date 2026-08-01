// server/lib/metDatabase.js
// Keeps the MET / Internal Affairs database sheet honest:
//
//   * KICK  — anyone on the sheet who is no longer in the MET Roblox group has
//             their row cleared out. (Left the group, exiled after a
//             Termination/Blacklist, or simply never joined.)
//   * ADD   — newly joined members at the entry rank ("Constable" by default)
//             who aren't on the sheet yet are added, filling the rows the kicks
//             just freed. That's the "replace" half: departures out, new
//             constables in.
//
// The sheet is read with the Google service account and written through the
// Apps Script webhook (the path that already works for points), falling back to
// the service account when no webhook is configured.
//
// Env:
//   MET_DB_GROUP_ID     Roblox group whose membership the sheet mirrors
//                       (default: ROBLOX_GROUP_ID, i.e. the IA group).
//   MET_DB_JOIN_RANKS   comma-separated rank names treated as "newly joined"
//                       and eligible to be added (default "Constable").
//   MET_DB_MIN_RANK     optional numeric floor — members below this group rank
//                       are removed even if they're technically in the group.
//   MET_DB_MAX_ADD      cap on how many members one sync may add (default 25).
//   MET_DB_AUTO_SYNC    "true" to run the sync automatically every 24h.

const prisma = require('./db');
const quota  = require('./quota');

const GROUP_ID   = () => process.env.MET_DB_GROUP_ID || process.env.ROBLOX_GROUP_ID || null;
const JOIN_RANKS = () => (process.env.MET_DB_JOIN_RANKS || 'Constable')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const MIN_RANK   = () => { const n = parseInt(process.env.MET_DB_MIN_RANK || '', 10); return Number.isFinite(n) ? n : null; };
const MAX_ADD    = () => { const n = parseInt(process.env.MET_DB_MAX_ADD || '25', 10); return Number.isFinite(n) && n > 0 ? n : 25; };
// Share of the sheet the sync may remove before it refuses. A junk value must
// fall back to the default, not to NaN — `x > NaN` is always false, which would
// silently switch the guard off.
const MAX_REMOVE_SHARE = () => {
  const n = parseFloat(process.env.MET_DB_MAX_REMOVE_SHARE || '');
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
};

// Rows we must never touch: headers, section labels, notes, spacers, totals.
// A real member row carries BOTH a username and a rank (the same test the quota
// reader uses), so a stray label in the username column can't be mistaken for a
// person and cleared.
function isMemberRow(cols, row) {
  const uname = cols.username != null ? (row[cols.username] || '').toString().trim() : '';
  if (!uname) return false;
  if (quota.NON_MEMBER.has(uname.toLowerCase())) return false;
  if (cols.rank != null) {
    const rank = (row[cols.rank] || '').toString().trim();
    if (!rank) return false;
    if (quota.NON_MEMBER.has(rank.toLowerCase())) return false;
  }
  return true;
}

// ── Read the current roster off the sheet ─────────────────────────
// [{ rowIndex (0-based), username, discordId, rank }]
async function readRoster() {
  const sheet = await quota.readSheet();
  if (!sheet) return null;
  const { rows, cols } = sheet;
  const roster = [];
  for (let r = 0; r < rows.length; r++) {
    if (!isMemberRow(cols, rows[r])) continue;
    roster.push({
      rowIndex:  r,
      username:  (rows[r][cols.username] || '').toString().trim(),
      discordId: cols.discordId != null ? (rows[r][cols.discordId] || '').toString().trim() : '',
      rank:      cols.rank      != null ? (rows[r][cols.rank]      || '').toString().trim() : '',
    });
  }
  return { sheet, roster };
}

// ── Read the group's live membership ──────────────────────────────
// Returns a Map keyed by normalised username → { userId, username, roleName, roleRank }.
async function readGroupMembers() {
  const groupId = GROUP_ID();
  if (!groupId) throw new Error('No MET group configured (set MET_DB_GROUP_ID or ROBLOX_GROUP_ID).');
  const { listGroupMembers } = require('./roblox');

  const byName = new Map();
  const all    = [];
  let cursor = null, guard = 0, pages = 0;
  do {
    // A failure mid-listing must NOT look like "the group is empty" — that would
    // mark every member for removal. Any error aborts the whole sync.
    let page;
    try {
      // Pass the group explicitly — the MET database may mirror a different
      // group from the one the Group Panel manages (ROBLOX_GROUP_ID).
      page = await listGroupMembers(cursor, groupId);
    } catch (err) {
      throw new Error(`Could not read the MET group membership (page ${pages + 1}): ${err.message}`);
    }
    pages++;
    for (const m of page.members) {
      all.push(m);
      byName.set(quota.normName(m.username), m);
    }
    cursor = page.nextPageToken;
  } while (cursor && guard++ < 200);   // 200 pages × 100 = 20k members

  if (cursor) throw new Error('The MET group is larger than this sync can page through — aborting rather than removing members it never saw.');
  if (!all.length) throw new Error('The MET group returned no members — refusing to treat that as "everyone left".');
  return { byName, all };
}

/**
 * Work out what the sync WOULD do. Pure — touches nothing.
 * Returns { remove: [...], add: [...], keep: n, groupSize, note }.
 */
async function planSync() {
  const rosterRead = await readRoster();
  if (!rosterRead) {
    return { error: 'The quota sheet is not readable (set GOOGLE_SERVICE_ACCOUNT_JSON).', remove: [], add: [], keep: 0 };
  }
  const { sheet, roster } = rosterRead;
  const { byName, all }   = await readGroupMembers();

  // Roblox ids of everyone in the group, so a member who simply RENAMED is
  // recognised instead of being treated as having left. The sheet's Discord id
  // column resolves to a Roblox id through the accounts we already have linked
  // (no RoVer calls — the link is stored on every user who has signed in).
  const byRobloxId = new Map();
  all.forEach(m => byRobloxId.set(String(m.userId), m));
  const discordIds = roster.map(r => (r.discordId || '').replace(/\D/g, '')).filter(Boolean);
  const linked = discordIds.length
    ? await prisma.user.findMany({
        where:  { discordId: { in: discordIds } },
        select: { discordId: true, robloxId: true, robloxUsername: true },
      }).catch(() => [])
    : [];
  const robloxByDiscord = new Map();
  linked.forEach(u => { if (u.robloxId) robloxByDiscord.set(String(u.discordId), String(u.robloxId)); });

  const minRank = MIN_RANK();
  const remove  = [];
  const keptKeys = new Set();
  const renamed  = [];

  for (const row of roster) {
    const key = quota.normName(row.username);
    let member = key ? byName.get(key) : null;

    // Not found by name — try their Discord id → Roblox id. This is what stops
    // a rename from being read as "left the group" and wiping their row.
    if (!member && row.discordId) {
      const rid = robloxByDiscord.get(row.discordId.replace(/\D/g, ''));
      if (rid && byRobloxId.has(rid)) {
        member = byRobloxId.get(rid);
        renamed.push({ was: row.username, now: member.username });
      }
    }

    if (!member) {
      remove.push({ ...row, why: 'not in the MET group' });
      continue;
    }
    if (minRank != null && Number(member.roleRank) < minRank) {
      remove.push({ ...row, why: `group rank ${member.roleName} is below the minimum` });
      continue;
    }
    keptKeys.add(quota.normName(member.username));
    if (key) keptKeys.add(key);
  }

  // Newly joined members at the entry rank who aren't on the sheet yet.
  // `keptKeys` (not just the raw sheet names) is what stops a renamed member
  // from being re-added alongside the row they already occupy.
  const joinRanks = JOIN_RANKS();
  const onSheet   = new Set(roster.map(r => quota.normName(r.username)));
  const add = [];
  for (const m of all) {
    const key = quota.normName(m.username);
    if (onSheet.has(key) || keptKeys.has(key)) continue;
    const rankName = (m.roleName || '').toLowerCase();
    if (joinRanks.length && !joinRanks.some(j => rankName === j || rankName.includes(j))) continue;
    add.push({ username: m.username, robloxId: m.userId, rank: m.roleName });
    if (add.length >= MAX_ADD()) break;
  }

  // Last line of defence against a bad read wiping the roster: if the sync wants
  // to remove most of the sheet, something is wrong with the data, not the
  // roster. Refuse and say so rather than quietly emptying the database.
  const removeShare = roster.length ? remove.length / roster.length : 0;
  const guardShare  = MAX_REMOVE_SHARE();
  if (roster.length >= 5 && removeShare > guardShare) {
    return {
      error: `Refusing to sync: ${remove.length} of ${roster.length} rows (${Math.round(removeShare * 100)}%) `
           + `would be removed, which is over the ${Math.round(guardShare * 100)}% safety limit. `
           + `Check that the MET group id is right and Roblox is reachable, then raise MET_DB_MAX_REMOVE_SHARE if this really is correct.`,
      remove, add, keep: keptKeys.size, groupSize: all.length, sheetRows: roster.length, joinRanks,
    };
  }

  return {
    remove, add, renamed,
    keep:      roster.length - remove.length,
    groupSize: all.length,
    sheetRows: roster.length,
    joinRanks,
    sheetName: sheet.sheetName,
    // A fingerprint of exactly this plan. The apply step requires it, so what
    // gets written is always the plan the operator actually reviewed.
    token: planToken(remove, add),
  };
}

// Stable fingerprint of a plan — order-independent, content-sensitive.
function planToken(remove, add) {
  const parts = [
    ...remove.map(r => 'R:' + quota.normName(r.username)),
    ...add.map(a => 'A:' + quota.normName(a.username)),
  ].sort();
  return require('crypto').createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

// ── Apply: clear removed rows, then write the new joiners in ──────
// Prefers the Apps Script webhook (it owns the sheet), falls back to the
// service account. Returns { ok, removed, added, errors }.
async function applySync(plan) {
  const errors = [];
  let removed = 0, added = 0;

  // 1) Webhook path — one round trip, script-side locking, no API enabling.
  //    If a webhook IS configured we commit to it: a failure there may have
  //    partially applied, so re-running the same destructive write through the
  //    service account could remove twice as much. Report and stop instead.
  if (process.env.QUOTA_WEBHOOK_URL) {
    const viaWebhook = await quota.callQuotaWebhook({
      action:  'roster',
      remove:  plan.remove.map(r => ({ username: r.username, discordId: r.discordId || null })),
      add:     plan.add.map(a => ({ username: a.username, rank: a.rank || '', discordId: '' })),
    }).catch(err => ({ ok: false, error: err.message }));

    if (viaWebhook && viaWebhook.ok) {
      return {
        ok: true, via: 'webhook',
        removed: viaWebhook.removed != null ? viaWebhook.removed : plan.remove.length,
        added:   viaWebhook.added   != null ? viaWebhook.added   : plan.add.length,
        errors,
      };
    }
    return {
      ok: false, via: 'webhook', removed: 0, added: 0,
      errors: errors.concat(`The quota webhook did not apply the change: ${(viaWebhook && viaWebhook.error) || 'unknown error'}. `
        + 'Nothing was retried through the service account, because the webhook may have applied part of it — check the sheet before running the sync again.'),
    };
  }

  // 2) Service-account path — clear the removed rows, then APPEND new joiners.
  //    Rows are re-located by name in a FRESH read: the plan's row indices came
  //    from an earlier snapshot and someone may have edited the sheet since,
  //    which would otherwise clear whoever now sits at that index.
  const sheetRead = await quota.readSheet();
  if (!sheetRead) {
    return { ok: false, removed, added, errors: errors.concat('No write path configured (no webhook, no service account).') };
  }
  const { sheets, spreadsheetId, sheetName, rows, cols } = sheetRead;
  const writes = [];

  // Widest row in the sheet — a removed member's row is cleared ACROSS ALL
  // columns, so no strikes/warnings/timezone data is left behind to be
  // inherited by whoever is added later.
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);

  const notFound = [];
  for (const r of plan.remove) {
    const want = quota.normName(r.username);
    const wantDiscord = (r.discordId || '').replace(/\D/g, '');
    let rowIdx = -1;
    for (let i = 0; i < rows.length; i++) {
      if (!isMemberRow(cols, rows[i])) continue;
      const uname = quota.normName(rows[i][cols.username]);
      const did   = cols.discordId != null ? (rows[i][cols.discordId] || '').toString().replace(/\D/g, '') : '';
      if ((want && uname === want) || (wantDiscord && did && did === wantDiscord)) { rowIdx = i; break; }
    }
    if (rowIdx < 0) { notFound.push(r.username); continue; }   // already gone — leave it
    for (let c = 0; c < width; c++) {
      writes.push({ range: `${sheetName}!${quota.colLetter(c)}${rowIdx + 1}`, values: [['']] });
    }
    removed++;
  }
  if (notFound.length) errors.push(`not found on the sheet (skipped): ${notFound.join(', ')}`);

  // New joiners are APPENDED rather than dropped into the rows just freed:
  // the sheet is grouped into rank sections, so reusing a High Command row for
  // a constable would file them under the wrong heading.
  let appendAt = rows.length;
  for (const a of plan.add) {
    const target = appendAt++;
    if (cols.username  != null) writes.push({ range: `${sheetName}!${quota.colLetter(cols.username)}${target + 1}`,  values: [[a.username]] });
    if (cols.rank      != null) writes.push({ range: `${sheetName}!${quota.colLetter(cols.rank)}${target + 1}`,      values: [[a.rank || '']] });
    if (cols.discordId != null) writes.push({ range: `${sheetName}!${quota.colLetter(cols.discordId)}${target + 1}`, values: [['']] });
    for (const d of Object.values(cols.days)) {
      writes.push({ range: `${sheetName}!${quota.colLetter(d)}${target + 1}`, values: [[0]] });
    }
    added++;
  }

  if (writes.length) {
    try {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId, requestBody: { valueInputOption: 'USER_ENTERED', data: writes },
      });
    } catch (err) {
      return { ok: false, via: 'sheets', removed: 0, added: 0, errors: errors.concat(err.message) };
    }
  }
  return { ok: true, via: 'sheets', removed, added, errors };
}

/**
 * Run the sync.
 *   opts.dry   — plan only, change nothing (default true; callers opt in).
 *   opts.token — the `token` from the dry run the operator confirmed. When it
 *                no longer matches, the roster changed between review and
 *                apply, so we refuse rather than write something unreviewed.
 *   opts.actor — { id, name } for the audit trail.
 */
async function syncMetDatabase(opts = {}) {
  const dry = opts.dry !== false;
  const startedAt = new Date();
  let plan;
  try {
    plan = await planSync();
  } catch (err) {
    return { ok: false, dry, error: err.message };
  }
  if (plan.error) return { ok: false, dry, error: plan.error, ...plan };

  if (dry) {
    return { ok: true, dry: true, startedAt, ...plan, removed: 0, added: 0 };
  }

  if (opts.token && opts.token !== plan.token) {
    return {
      ok: false, dry: false, ...plan, removed: 0, added: 0,
      error: 'The MET group has changed since you ran the check — nothing was written. Run Check again and review the new plan.',
      stale: true,
    };
  }

  const result = await applySync(plan);
  const summary = `MET database sync — removed ${result.removed}, added ${result.added}`;
  console.log(`[MetDB] ${summary}${result.errors.length ? ` (errors: ${result.errors.join('; ')})` : ''}`);

  // Record it so High Command can see who ran a destructive roster change.
  try {
    await prisma.auditLog.create({
      data: {
        action: 'MET_DB_SYNC', category: 'ia',
        actorId:   opts.actor ? opts.actor.id   : null,
        actorName: opts.actor ? opts.actor.name : 'system',
        targetType: 'quota-sheet', targetId: plan.sheetName || null,
        summary,
        metadata: {
          // The plan, AND what the write actually managed to do — they can
          // differ (a row already gone, a partial webhook failure), and the
          // audit trail has to reflect reality, not intent.
          plannedRemove: plan.remove.map(r => r.username),
          plannedAdd:    plan.add.map(a => a.username),
          appliedRemoved: result.removed,
          appliedAdded:   result.added,
          renamed: plan.renamed,
          via: result.via, ok: result.ok, errors: result.errors,
        },
      },
    });
  } catch (e) { /* auditing must never break the sync */ }

  return { ok: result.ok, dry: false, startedAt, ...plan, ...result };
}

// ── Optional daily worker ─────────────────────────────────────────
function startMetDatabaseWorker() {
  if (process.env.MET_DB_AUTO_SYNC !== 'true') return;
  const run = () => syncMetDatabase({ dry: false, actor: { id: null, name: 'automatic sync' } })
    .catch(err => console.warn('[MetDB] auto sync failed:', err.message));
  setTimeout(run, 5 * 60 * 1000);          // 5 min after boot
  setInterval(run, 24 * 60 * 60 * 1000);   // then daily
}

module.exports = { planSync, applySync, syncMetDatabase, readRoster, readGroupMembers, startMetDatabaseWorker };
