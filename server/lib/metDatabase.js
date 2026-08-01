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

// Rows we must never touch: headers, section labels, totals.
function isMemberRow(cols, row) {
  const uname = cols.username != null ? (row[cols.username] || '').toString().trim() : '';
  if (!uname) return false;
  if (quota.NON_MEMBER.has(uname.toLowerCase())) return false;
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
  let cursor = null, guard = 0;
  do {
    const page = await listGroupMembers(cursor);
    for (const m of page.members) {
      all.push(m);
      byName.set(quota.normName(m.username), m);
    }
    cursor = page.nextPageToken;
  } while (cursor && guard++ < 200);   // 200 pages × 100 = 20k members
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

  const minRank = MIN_RANK();
  const remove  = [];
  const keptKeys = new Set();

  for (const row of roster) {
    const key = quota.normName(row.username);
    const member = key ? byName.get(key) : null;
    if (!member) {
      remove.push({ ...row, why: 'not in the MET group' });
      continue;
    }
    if (minRank != null && Number(member.roleRank) < minRank) {
      remove.push({ ...row, why: `group rank ${member.roleName} is below the minimum` });
      continue;
    }
    keptKeys.add(key);
  }

  // Newly joined members at the entry rank who aren't on the sheet yet.
  const joinRanks = JOIN_RANKS();
  const onSheet   = new Set(roster.map(r => quota.normName(r.username)));
  const add = [];
  for (const m of all) {
    const key = quota.normName(m.username);
    if (onSheet.has(key)) continue;
    const rankName = (m.roleName || '').toLowerCase();
    if (joinRanks.length && !joinRanks.some(j => rankName === j || rankName.includes(j))) continue;
    add.push({ username: m.username, robloxId: m.userId, rank: m.roleName });
    if (add.length >= MAX_ADD()) break;
  }

  return {
    remove, add,
    keep:      keptKeys.size,
    groupSize: all.length,
    sheetRows: roster.length,
    joinRanks,
    sheetName: sheet.sheetName,
  };
}

// ── Apply: clear removed rows, then write the new joiners in ──────
// Prefers the Apps Script webhook (it owns the sheet), falls back to the
// service account. Returns { ok, removed, added, errors }.
async function applySync(plan) {
  const errors = [];
  let removed = 0, added = 0;

  // 1) Webhook path — one round trip, script-side locking, no API enabling.
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
  if (viaWebhook && viaWebhook.error) errors.push(`webhook: ${viaWebhook.error}`);

  // 2) Service-account fallback — clear the removed rows in place, then write
  //    new joiners into the freed rows (appending only if we run out).
  const sheetRead = await quota.readSheet();
  if (!sheetRead) {
    return { ok: false, removed, added, errors: errors.concat('No write path configured (no webhook, no service account).') };
  }
  const { sheets, spreadsheetId, sheetName, rows, cols } = sheetRead;
  const writes = [];

  // Every column a member row occupies, so a cleared row leaves nothing behind.
  const memberCols = [cols.username, cols.discordId, cols.rank, ...Object.values(cols.days)]
    .filter(c => c != null);

  const freedRows = [];
  for (const r of plan.remove) {
    for (const c of memberCols) {
      writes.push({ range: `${sheetName}!${quota.colLetter(c)}${r.rowIndex + 1}`, values: [['']] });
    }
    freedRows.push(r.rowIndex);
    removed++;
  }

  // Rows to write new joiners into: the ones we just cleared, then any blank
  // member rows below the roster, then fresh rows at the end.
  const nextRow = rows.length;
  for (let i = 0; i < plan.add.length; i++) {
    const target = freedRows.length ? freedRows.shift() : nextRow + i;
    const a = plan.add[i];
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
          removed: plan.remove.map(r => r.username),
          added:   plan.add.map(a => a.username),
          via:     result.via, errors: result.errors,
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
