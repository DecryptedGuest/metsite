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
//   MET_DB_GROUP_ID     override for the Roblox group whose membership the
//                       sheet mirrors. Normally unset: each division's group
//                       comes from the division registry (IA -> IA_GROUP_ID,
//                       MET -> the umbrella group), so IA syncs against IA.
//   MET_DB_JOIN_RANKS   comma-separated rank names treated as "newly joined"
//                       and eligible to be added (default "Constable").
//   MET_DB_MIN_RANK     optional numeric floor — members below this group rank
//                       are removed even if they're technically in the group.
//   MET_DB_MAX_ADD      cap on how many members one sync may add (default 25).
//   MET_DB_AUTO_SYNC    "true" to run the sync automatically every 24h.

const prisma = require('./db');
const quota  = require('./quota');

const GROUP_ID   = () => process.env.MET_DB_GROUP_ID || process.env.ROBLOX_GROUP_ID || null;

// Which database this run is about.
//
// IA runs this against its OWN sheet from the IA dashboard; FLP High Command
// runs the same thing against the MET sheet from theirs. Same comparison, same
// safety rails, different sheet and different group — so the sheet id, the
// group and the entry ranks all travel together rather than being read from
// whichever env var happened to be nearest.
function scopeFor(division) {
  const div = (division || 'IA').toString().toUpperCase();
  const cfg = quota.quotaConfig(div);
  if (div === 'MET') {
    return {
      division: 'MET',
      name: 'MET',
      cfg,
      // The umbrella Metropolitan Police group — the same id the rest of the
      // site resolves for MET-wide rank, not whatever MET_DB_GROUP_ID happens
      // to hold.
      groupId: process.env.MET_GROUP_ID || require('./divisions').metGroupId(),
      groupEnv: 'MET_GROUP_ID',
      joinRanks: (process.env.MET_DB_JOIN_RANKS || 'Constable')
        .split(',').map(x => x.trim().toLowerCase()).filter(Boolean),
    };
  }
  // Everything else is a division, so its group comes from the division
  // registry (IA → IA_GROUP_ID / 407296071). MET_DB_GROUP_ID stays as a
  // deliberate override only; falling back to it — or to ROBLOX_GROUP_ID —
  // is what made the IA sync and audit read the MET group.
  const divisions = require('./divisions');
  const known = divisions.ALL.includes(div);
  const groupId = process.env.MET_DB_GROUP_ID
    || (known ? divisions.explicitGroupId(div) : null)
    || GROUP_ID();
  return {
    division: div,
    name: known ? divisions.META[div].name : div,
    cfg,
    groupId,
    groupEnv: known ? divisions.META[div].groupEnv : 'MET_DB_GROUP_ID',
    joinRanks: JOIN_RANKS(),
  };
}
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
async function readRoster(scope) {
  const sheet = scope && scope.division !== 'IA'
    ? await quota.readSheetFor(scope.cfg)
    : await quota.readSheet();
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
async function readGroupMembers(scope) {
  const sc      = scope || scopeFor('IA');
  const groupId = sc.groupId || GROUP_ID();
  const who     = sc.name || sc.division || 'MET';
  if (!groupId) throw new Error(`No ${who} group configured (set ${sc.groupEnv || 'MET_DB_GROUP_ID'}).`);
  const { listGroupMembers } = require('./roblox');

  const byName = new Map();
  const all    = [];
  let cursor = null, guard = 0, pages = 0;
  do {
    // A failure mid-listing must NOT look like "the group is empty" — that would
    // mark every member for removal. Any error aborts the whole sync.
    let page;
    try {
      // Pass the group explicitly — each database mirrors its OWN division's
      // group (IA → IA_GROUP_ID, MET → the umbrella group), never whichever
      // group the Group Panel happens to be pointed at.
      page = await listGroupMembers(cursor, groupId);
    } catch (err) {
      throw new Error(`Could not read the ${who} group membership (page ${pages + 1}): ${err.message}`);
    }
    pages++;
    for (const m of page.members) {
      all.push(m);
      byName.set(quota.normName(m.username), m);
    }
    cursor = page.nextPageToken;
  } while (cursor && guard++ < 200);   // 200 pages × 100 = 20k members

  if (cursor) throw new Error(`The ${who} group is larger than this sync can page through — aborting rather than removing members it never saw.`);
  if (!all.length) throw new Error(`The ${who} group returned no members — refusing to treat that as "everyone left".`);
  return { byName, all, groupId, division: sc.division };
}

/**
 * Work out what the sync WOULD do. Pure — touches nothing.
 * Returns { remove: [...], add: [...], keep: n, groupSize, note }.
 */
async function planSync(scope) {
  const rosterRead = await readRoster(scope);
  if (!rosterRead) {
    return { error: 'The quota sheet is not readable (set GOOGLE_SERVICE_ACCOUNT_JSON).', remove: [], add: [], keep: 0 };
  }
  const { sheet, roster } = rosterRead;
  const { byName, all }   = await readGroupMembers(scope);
  const groupName = (scope && (scope.name || scope.division)) || 'MET';

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
      remove.push({ ...row, why: `not in the ${groupName} group` });
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
  const joinRanks = (scope && scope.joinRanks) || JOIN_RANKS();
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

  // Their Discord id, so a new row is not written with the column blank.
  //
  // A member added with no Discord id can never be matched by id afterwards —
  // every points write, every quota read and every later sync has to fall back
  // to matching them by NAME, which breaks the moment they rename. Resolving it
  // once, here, is what keeps the row usable.
  //
  // Resolved from accounts already linked on this site first (free, no API
  // call), then RoVer for anybody who has never signed in. Best-effort: an
  // unresolvable member is still added, just without the id.
  await attachDiscordIds(add);

  // Last line of defence against a bad read wiping the roster: if the sync wants
  // to remove most of the sheet, something is wrong with the data, not the
  // roster. Refuse and say so rather than quietly emptying the database.
  const removeShare = roster.length ? remove.length / roster.length : 0;
  const guardShare  = MAX_REMOVE_SHARE();
  if (roster.length >= 5 && removeShare > guardShare) {
    return {
      error: `Refusing to sync: ${remove.length} of ${roster.length} rows (${Math.round(removeShare * 100)}%) `
           + `would be removed, which is over the ${Math.round(guardShare * 100)}% safety limit. `
           + `Check that the ${groupName} group id is right and Roblox is reachable, then raise MET_DB_MAX_REMOVE_SHARE if this really is correct.`,
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

/**
 * Fill in `discordId` on the members about to be added, in place.
 * Never throws — a lookup that fails leaves the id blank, which is the same
 * position the sheet was in before.
 */
async function attachDiscordIds(add) {
  if (!add.length) return;
  const ids = add.map(a => String(a.robloxId)).filter(Boolean);
  if (!ids.length) return;

  // 1. Accounts already linked here.
  try {
    const linked = await prisma.user.findMany({
      where:  { robloxId: { in: ids } },
      select: { robloxId: true, discordId: true },
    });
    const byRoblox = new Map(linked.map(u => [String(u.robloxId), u.discordId]));
    for (const a of add) {
      const hit = byRoblox.get(String(a.robloxId));
      if (hit) a.discordId = String(hit);
    }
  } catch (e) { /* the sheet write does not depend on this */ }

  // 2. RoVer, for the ones nobody has signed in as. Sequential and capped —
  //    this runs inside a sync somebody is waiting on, and RoVer is rate
  //    limited, so it is better to leave a few blank than to stall the plan.
  const missing = add.filter(a => !a.discordId).slice(0, 25);
  if (!missing.length) return;
  try {
    const { getDiscordFromRoblox } = require('./roblox');
    for (const a of missing) {
      try {
        const matches = await getDiscordFromRoblox(a.robloxId);
        if (matches && matches.length) a.discordId = String(matches[0].discordId);
      } catch (e) { /* leave it blank */ }
    }
  } catch (e) { /* roblox lib unavailable — leave them all blank */ }
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
async function applySync(plan, scope) {
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
      add:     plan.add.map(a => ({ username: a.username, rank: a.rank || '', discordId: a.discordId || '' })),
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
  const sheetRead = scope && scope.division !== 'IA'
    ? await quota.readSheetFor(scope.cfg)
    : await quota.readSheet();
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

  // The clears first, in one batch: those are cells that already exist.
  if (writes.length) {
    try {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId, requestBody: { valueInputOption: 'USER_ENTERED', data: writes },
      });
    } catch (err) {
      return { ok: false, via: 'sheets', removed: 0, added: 0, errors: errors.concat(err.message) };
    }
  }

  // New joiners are APPENDED rather than dropped into the rows just freed: the
  // sheet is grouped into rank sections, so reusing a High Command row for a
  // constable would file them under the wrong heading.
  //
  // And APPENDED, not written by cell address. Writing past the last row of the
  // grid is refused outright — "Range exceeds grid limits" — so a sheet with no
  // spare rows could never take a new member, which is the normal state of a
  // sheet somebody has tidied up. Timezone, WTBT and every other column are left
  // empty, because they are not ours to guess at.
  if (plan.add.length) {
    try {
      await appendToSheet(sheets, spreadsheetId, sheetName,
        plan.add.map(a => memberRow({ username: a.username, rank: a.rank, discordId: a.discordId }, cols)));
      added += plan.add.length;
    } catch (err) {
      // The clears already landed, so this is a partial success and has to say so
      // rather than reporting zero of everything.
      return { ok: false, via: 'sheets', removed, added: 0,
               errors: errors.concat('Removed rows were cleared, but the new members could not be added: ' + err.message) };
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
  const scope = scopeFor(opts.division || 'IA');
  let plan;
  try {
    plan = await planSync(scope);
  } catch (err) {
    return { ok: false, dry, error: err.message };
  }
  if (plan.error) return { ok: false, dry, error: plan.error, ...plan };

  if (dry) {
    return { ok: true, dry: true, division: scope.division, startedAt, ...plan, removed: 0, added: 0 };
  }

  if (opts.token && opts.token !== plan.token) {
    return {
      ok: false, dry: false, ...plan, removed: 0, added: 0,
      error: 'The group has changed since you ran the check — nothing was written. Run Check again and review the new plan.',
      stale: true,
    };
  }

  const result = await applySync(plan, scope);
  const summary = `${(scope && (scope.name || scope.division)) || 'MET'} database sync — removed ${result.removed}, added ${result.added}`;
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


// ── Who is in the group but not on the sheet ──────────────────────
//
// The sync's own `add` list only ever offers people at the ENTRY rank
// (MET_DB_JOIN_RANKS, "Constable" by default), because that is what an automatic
// roster sync should touch on its own. It means a Junior Investigator who never
// got a row never appears anywhere, and nobody notices until their quota reads
// as zero for a month.
//
// This lists EVERY member missing from the sheet, at any rank, for somebody to
// look at and pick from. It writes nothing.
//
// @returns {Promise<{ missing: Array, groupSize: number, sheetRows: number, … }>}
async function missingMembers(division) {
  const scope = scopeFor(division || 'IA');
  const rosterRead = await readRoster(scope);
  if (!rosterRead) {
    return { error: 'The quota sheet is not readable (set GOOGLE_SERVICE_ACCOUNT_JSON).', missing: [] };
  }
  const { sheet, roster } = rosterRead;
  const { all } = await readGroupMembers(scope);

  // Somebody who RENAMED is on the sheet under their old name, so matching by
  // name alone would offer to add them a second time. Their Discord id on the
  // sheet resolves to a Roblox id through the accounts already linked here,
  // which is the same trick planSync uses to avoid deleting renamed members.
  const onSheetNames = new Set(roster.map(r => quota.normName(r.username)));
  const sheetDiscordIds = roster.map(r => (r.discordId || '').replace(/\D/g, '')).filter(Boolean);
  const linked = sheetDiscordIds.length
    ? await prisma.user.findMany({
        where:  { discordId: { in: sheetDiscordIds } },
        select: { discordId: true, robloxId: true },
      }).catch(() => [])
    : [];
  const onSheetRobloxIds = new Set(linked.filter(u => u.robloxId).map(u => String(u.robloxId)));

  const missing = [];
  for (const m of all) {
    if (onSheetNames.has(quota.normName(m.username))) continue;
    if (onSheetRobloxIds.has(String(m.userId))) continue;
    missing.push({
      username: m.username,
      robloxId: String(m.userId),
      rank:     m.roleName || '',
      roleRank: m.roleRank != null ? Number(m.roleRank) : null,
      // Whether the "waiting to be trained" mark applies to them at all. Only a
      // Probationary Investigator can be waiting for their training session; a
      // Senior Investigator marked WTBT is a mistake, so the flag is offered
      // only where it means something.
      probationary: isProbationary(m.roleName),
    });
  }
  // Highest rank first: a missing Deputy Director is a more urgent gap than a
  // missing probationer, and sorting by name buries it.
  missing.sort((a, b) => (b.roleRank || 0) - (a.roleRank || 0)
    || a.username.localeCompare(b.username));

  // Their Discord ids, so a row is not written with the column blank — a member
  // added without one can only ever be matched by name afterwards, which breaks
  // the moment they rename.
  await attachDiscordIds(missing);

  return {
    missing,
    groupSize: all.length,
    sheetRows: roster.length,
    division:  scope.division,
    group:     scope.name || scope.division,
    sheetName: sheet.sheetName,
    // Whether the sheet even HAS a column to write the mark into. Without one the
    // UI must not offer a toggle whose value goes nowhere.
    hasWtbtColumn: sheet.cols.wtbt != null,
  };
}

// The most this will add in one press. A selection is deliberate, so this is a
// runaway guard rather than a policy — 100 rows is far more than any real intake.
const MAX_PICK = 100;

/** Is this group rank a Probationary Investigator? */
function isProbationary(roleName) {
  return /probation/i.test(String(roleName || ''));
}

// What goes in a WTBT cell. TRUE/FALSE rather than a tick, because the sheet's
// own column is read by people and by formulas, and "TRUE" is what a checkbox
// column contains.
function wtbtCell(on) { return on ? 'TRUE' : 'FALSE'; }

/**
 * Add exactly the people who were picked.
 *
 * Deliberately NOT part of the sync. The sync is a comparison that decides for
 * itself; this is a list somebody chose from, so it adds precisely what it was
 * given, refuses anything it was not asked about, and never removes anything.
 *
 * @param {Array<{username, rank?, discordId?, robloxId?, wtbt?}>} picks
 * @param {string} division
 * @param {{id, name}} [actor]
 */
async function addMembers(picks, division, actor) {
  const list = Array.isArray(picks) ? picks : [];
  if (!list.length) return { ok: false, stage: 'select', error: 'Nobody was selected.' };
  if (list.length > MAX_PICK) {
    return { ok: false, stage: 'select',
             error: `That is ${list.length} people at once. ${MAX_PICK} is the most this will write in one go — do it in batches so a mistake is small.` };
  }

  const scope = scopeFor(division || 'IA');
  // Re-read the group so the ranks written are the ranks people actually hold,
  // not whatever the browser was showing when the list was loaded.
  const { all } = await readGroupMembers(scope);
  const byName = new Map(all.map(m => [quota.normName(m.username), m]));

  const resolved = [], unknown = [], wrongRank = [];
  for (const p of list) {
    const name = String((p && p.username) || '').trim();
    if (!name) continue;
    const member = byName.get(quota.normName(name));
    if (!member) { unknown.push(name); continue; }
    const wtbt = p.wtbt === true || p.wtbt === 'true';
    // The mark means "has not had their training session yet", which only a
    // probationer can be. Refused rather than quietly dropped: it was an
    // explicit choice, and silently ignoring it teaches the wrong thing about
    // what the toggle does.
    if (wtbt && !isProbationary(member.roleName)) {
      wrongRank.push(`${member.username} (${member.roleName || 'unknown rank'})`);
      continue;
    }
    resolved.push({
      username:  member.username,
      robloxId:  String(member.userId),
      rank:      member.roleName || '',
      discordId: String((p && p.discordId) || '').replace(/\D/g, ''),
      wtbt,
    });
  }

  if (wrongRank.length) {
    return {
      ok: false, stage: 'select',
      error: 'Waiting to be trained only applies to Probationary Investigators, and it was ticked for '
           + wrongRank.join(', ') + '. Untick it for them and try again.',
    };
  }
  if (!resolved.length) {
    return { ok: false, stage: 'select', error: unknown.length
      ? `None of them are in the ${scope.name || scope.division} group any more: ${unknown.join(', ')}.`
      : 'Nobody was selected.' };
  }

  // Fill in any Discord id the caller did not send. Best-effort, the same as the
  // sync — an unresolvable member is still added, just without the id.
  await attachDiscordIds(resolved);

  const out = await appendRows(resolved, scope);
  if (unknown.length) out.skipped = unknown;

  // A failed WRITE has to arrive with a reason. appendRows reports in `errors`,
  // and nothing was copying that into `error` — so the response was a refusal
  // with no explanation in it, and the browser showed "HTTP 400" instead of what
  // actually went wrong. It is also not the caller's fault, so it is tagged as a
  // write failure rather than a bad selection.
  if (!out.ok) {
    out.stage = 'write';
    if (!out.error) {
      out.error = (out.errors || []).filter(Boolean).join(' ')
        || 'The database would not accept the write, and gave no reason.';
    }
  }

  // The wtbt count is only mentioned when something was actually written.
  // "added 0 member(s), 1 waiting to be trained" is a line about a selection,
  // not about what happened, and it reads as though a row went in.
  const marked = out.added ? resolved.filter(r => r.wtbt).length : 0;
  const summary = `${scope.name || scope.division} database — added ${out.added} member(s) by hand`
    + (marked ? `, ${marked} waiting to be trained` : '');
  console.log(`[MetDB] ${summary}${out.errors && out.errors.length ? ` (errors: ${out.errors.join('; ')})` : ''}`);
  // Logged separately and loudly on failure, so the reason is in the deploy log
  // even when the browser is showing something unhelpful.
  if (!out.ok) {
    console.error(`[MetDB] add-members FAILED via ${out.via || 'unknown path'}: ${out.error}`);
  }
  try {
    await prisma.auditLog.create({
      data: {
        action: 'MET_DB_ADD_MEMBERS', category: 'ia',
        actorId:   actor ? actor.id   : null,
        actorName: actor ? actor.name : 'system',
        targetType: 'quota-sheet', targetId: out.sheetName || null,
        summary,
        metadata: {
          added: resolved.map(r => ({ username: r.username, rank: r.rank, wtbt: r.wtbt })),
          alreadyOnSheet: out.alreadyThere || [],
          notInGroup: unknown,
          via: out.via, ok: out.ok, errors: out.errors,
        },
      },
    });
  } catch (e) { /* auditing must never break the write */ }

  return { ok: out.ok, ...out, division: scope.division };
}

/**
 * Append the rows. Same two paths as applySync: the sheet's own Apps Script
 * webhook when there is one, otherwise the service account.
 *
 * Nothing is ever removed here, and nobody already on the sheet is written
 * again — the sheet is re-read immediately before writing, so somebody added by
 * a sync in the meantime is reported as already there rather than duplicated.
 */
async function appendRows(rows, scope) {
  const errors = [];

  // The sheet's own Apps Script first, when there is one — it owns the sheet.
  //
  // Unlike applySync, a webhook failure here FALLS BACK to the service account
  // instead of stopping. applySync must not: it removes rows, so a half-applied
  // webhook write followed by a retry could remove twice as much. This operation
  // only ever appends, and it re-reads the sheet immediately before writing and
  // skips anybody already on it — so a webhook that added three of five leaves
  // the fallback adding the remaining two and reporting the three as already
  // there. Retrying is safe here in a way it is not there.
  if (process.env.QUOTA_WEBHOOK_URL) {
    const via = await quota.callQuotaWebhook({
      action: 'roster',
      remove: [],
      add: rows.map(r => ({
        username: r.username, rank: r.rank || '',
        discordId: r.discordId || '', wtbt: wtbtCell(r.wtbt),
      })),
    }).catch(err => ({ ok: false, error: err.message }));
    if (via && via.ok) {
      return { ok: true, via: 'webhook', added: via.added != null ? via.added : rows.length,
               alreadyThere: [], errors };
    }
    errors.push(`The quota webhook would not add them (${(via && via.error) || 'no reason given'}), `
      + 'so this was written with the service account instead.');
  }

  const sheetRead = scope && scope.division !== 'IA'
    ? await quota.readSheetFor(scope.cfg)
    : await quota.readSheet();
  if (!sheetRead) {
    return { ok: false, via: process.env.QUOTA_WEBHOOK_URL ? 'webhook' : 'none',
             added: 0, alreadyThere: [],
             errors: errors.concat(process.env.QUOTA_WEBHOOK_URL
               ? 'There is no service account configured to fall back to, so nothing was written.'
               : 'No write path configured: there is no quota webhook and no service account.') };
  }
  const { sheets, spreadsheetId, sheetName, rows: existing, cols } = sheetRead;

  // Fresh check for duplicates. The list in the browser could be minutes old.
  const already = new Set();
  for (let i = 0; i < existing.length; i++) {
    if (!isMemberRow(cols, existing[i])) continue;
    already.add(quota.normName(existing[i][cols.username]));
  }

  const alreadyThere = [];
  const wanted = [];
  for (const r of rows) {
    if (already.has(quota.normName(r.username))) { alreadyThere.push(r.username); continue; }
    wanted.push(r);
    // Two people picked in the same batch must not become two rows for one person.
    already.add(quota.normName(r.username));
  }

  let placed = [];
  if (wanted.length) {
    try {
      const out = await placeMembers(sheets, spreadsheetId, sheetName, wanted, existing, cols);
      placed = out.placed;
      // Placed, but not perfectly. Said out loud, because a formula cell left
      // blank is a five-second fix if somebody knows and a wrong total if not.
      for (const w of out.warnings || []) errors.push(w);
    } catch (err) {
      // Placing needs the tab's numeric id and one structural request. If either
      // is refused, a plain append at the end still gets the member onto the
      // sheet — in the wrong section, which is a tidy-up rather than a loss.
      console.warn('[MetDB] could not place the rows by rank, appending instead:', err.message);
      try {
        await appendToSheet(sheets, spreadsheetId, sheetName, wanted.map(r => memberRow(r, cols)));
        errors.push('Could not put them in their rank sections (' + err.message
          + '), so they were added at the end of the sheet instead.');
        placed = wanted.map(r => ({ username: r.username, rank: r.rank || null, row: null, under: null }));
      } catch (err2) {
        return { ok: false, via: 'sheets', added: 0, alreadyThere, sheetName,
                 errors: errors.concat(err2.message) };
      }
    }
  }
  return { ok: true, via: errors.length ? 'sheets (after the webhook failed)' : 'sheets',
           added: placed.length, alreadyThere, placed, sheetName, errors };
}


// ── Putting a new row in the right place ──────────────────────────
//
// Appending to the very bottom of the sheet is correct and useless: the sheet is
// grouped into rank sections, so a new Probationary Investigator belongs under
// the last Probationary Investigator, not below High Command's block or under
// whatever note sits at the end.
//
// Three separate things have to be true for the row to look like it belongs:
//
//   PLACE   inserted at the end of its own rank's block.
//   FORMAT  inherited from the row above it — insertDimension with
//           inheritFromBefore copies the formatting and the data validation, so a
//           checkbox column stays a checkbox and a coloured section stays coloured.
//   FORMULA carried across with copyPaste PASTE_FORMULA, which adjusts relative
//           references. Copying the formula TEXT would not: "=SUM(E12:K12)" pasted
//           into row 13 still adds up row 12.
//
// And one thing must NOT be true: nothing that was DATA on the neighbouring row
// may be inherited. A copied timezone or strike count is a lie about the new
// person, which is worse than a blank. So every column that is neither ours nor a
// formula is explicitly cleared.

/**
 * The numeric id of a tab and the ranges that are merged on it.
 *
 * Both come from one call because placement needs both: the id for every
 * structural request, and the merges because a paste that lands half inside one
 * is refused (see mergedColumnsAt).
 */
async function sheetMetaFor(sheets, spreadsheetId, sheetName) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets(properties(sheetId,title,gridProperties(rowCount)),merges)',
  });
  const found = (meta.data.sheets || [])
    .find(sh => sh.properties && sh.properties.title === sheetName);
  if (!found) throw new Error(`The sheet "${sheetName}" is not in that spreadsheet.`);
  return {
    sheetId: found.properties.sheetId,
    merges: found.merges || [],
    // How tall the grid is. Inserting rows must make this bigger, and checking
    // that is the cheapest way to catch an insert that was accepted and did
    // nothing.
    rowCount: (found.properties.gridProperties && found.properties.gridProperties.rowCount) || null,
  };
}

/** Just the id, for callers that do not care about merges. */
async function sheetIdFor(sheets, spreadsheetId, sheetName) {
  return (await sheetMetaFor(sheets, spreadsheetId, sheetName)).sheetId;
}

/**
 * Which columns of one row sit inside a merged range.
 *
 * Sheets refuses a copyPaste whose rectangle cuts a merge in half — "You can't
 * perform a paste that partially intersects a merge" — and it refuses the whole
 * request, not the offending column. A sheet with one merged section header in
 * the row above the insertion point therefore lost every formula on the row, and
 * with it the placement, because the insert travelled in the same batch.
 *
 * So merged columns are copied by nobody. They are also left alone by the
 * clearing pass: a cell merged across rows is not this person's data slot, and
 * writing into the middle of a merge is not something to find out about here.
 */
function mergedColumnsAt(merges, rowIndex, width) {
  const out = new Set();
  for (const m of merges || []) {
    const r0 = m.startRowIndex == null ? 0 : m.startRowIndex;
    const r1 = m.endRowIndex == null ? Infinity : m.endRowIndex;
    if (rowIndex < r0 || rowIndex >= r1) continue;
    const c0 = m.startColumnIndex == null ? 0 : m.startColumnIndex;
    // An absent end means "to the edge of the sheet"; cap it at the width we know
    // about rather than looping to infinity.
    const c1 = m.endColumnIndex == null ? Math.max(width, c0 + 1) : m.endColumnIndex;
    for (let c = c0; c < c1; c++) out.add(c);
  }
  return out;
}

/** Sorted column indices as contiguous [start, end) runs, so N columns side by
 *  side become one paste instead of N. */
function columnRuns(columns) {
  const runs = [];
  for (const c of [...columns].sort((a, b) => a - b)) {
    const last = runs[runs.length - 1];
    if (last && c === last.end) last.end = c + 1;
    else runs.push({ start: c, end: c + 1 });
  }
  return runs;
}

/**
 * Where a member of this rank belongs: the row index straight after the last
 * member row that holds the same rank.
 *
 * Ranks are compared loosely — a sheet writes "Probationary Investigator",
 * "Probationary Inv." and "PINV" for the same rank in different places, and a
 * strict comparison would send half of them to the bottom of the sheet.
 *
 * @returns {number|null} null when nobody of that rank is on the sheet yet, in
 *          which case the caller falls back to the end. Guessing where a section
 *          that does not exist ought to go is worse than putting the row
 *          somewhere obvious.
 */
function rankBlockEnd(existing, cols, rank) {
  if (cols.rank == null) return null;
  const want = rankKey(rank);
  if (!want) return null;
  let last = null;
  for (let i = 0; i < existing.length; i++) {
    if (!isMemberRow(cols, existing[i])) continue;
    if (rankKey(existing[i][cols.rank]) === want) last = i;
  }
  return last == null ? null : last + 1;
}

/** A rank name reduced to something two spellings of it can agree on. */
function rankKey(name) {
  const n = String(name || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!n) return '';
  // The abbreviations the sheets actually use, mapped onto the full name so a
  // "PINV" row and a "Probationary Investigator" row count as the same block.
  const SHORT = {
    pinv: 'probationaryinvestigator', jinv: 'juniorinvestigator',
    inv: 'investigator', sinv: 'seniorinvestigator',
    dd: 'deputydirector', d: 'director', sup: 'supervisor',
  };
  return SHORT[n] || n;
}

/**
 * Insert the rows where they belong, formatted and filled.
 *
 * @param {object[]} rows   [{ username, rank, discordId, wtbt }]
 * @returns {Promise<{ placed: Array<{ username, rank, row, under }>, warnings: string[] }>}
 *          where each landed, 1-based, for the report — "added at row 21, under
 *          the other probationers" is the sentence somebody wants back — plus
 *          anything the sheet would not let us finish, which is reported rather
 *          than being allowed to undo the placement.
 */
async function placeMembers(sheets, spreadsheetId, sheetName, rows, existing, cols) {
  const { sheetId, merges, rowCount } = await sheetMetaFor(sheets, spreadsheetId, sheetName);
  const endOfData = existing.length;
  const warnings = [];

  // Group by where they go, so several people of one rank become one insert.
  const groups = new Map();   // originalIndex → { at, rows[], byRank }
  for (const r of rows) {
    const at = rankBlockEnd(existing, cols, r.rank);
    const key = at == null ? endOfData : at;
    if (!groups.has(key)) groups.set(key, { at: key, rows: [], grouped: at != null });
    groups.get(key).rows.push(r);
  }

  // Ascending, to work out where each group ENDS UP once the groups above it have
  // pushed everything down.
  const ordered = [...groups.values()].sort((a, b) => a.at - b.at);
  let shift = 0;
  for (const g of ordered) { g.finalAt = g.at + shift; shift += g.rows.length; }

  const mine = new Set([cols.username, cols.rank, cols.discordId, cols.wtbt]
    .concat(Object.values(cols.days || {})).filter(c => c != null).map(Number));
  const width = existing.reduce((w, r) => Math.max(w, r.length), 0);

  // Which of each neighbour's cells hold a formula, read BEFORE anything is
  // inserted. Afterwards those rows have moved down by however many rows went in
  // above them, and reading `g.at` then is reading a different member's row.
  const formulaCols = await formulaColumnsOf(sheets, spreadsheetId, sheetName, ordered, width);

  // Columns of each neighbour row that a merge covers, and so that nothing may
  // paste into or clear.
  const mergedCols = new Map();
  for (const g of ordered) mergedCols.set(g.at, mergedColumnsAt(merges, g.at - 1, width));

  // 1. The inserts, on their own. This is the part that has to happen: the row
  //    lands in its own rank's section, with the formatting and the validation of
  //    the row above it. The formula copy used to travel in this same batch, and
  //    a sheet that refused the copy therefore lost the placement too and had
  //    everybody appended to the bottom instead.
  //
  //    They run DESCENDING by original index: inserting low would move every
  //    index below it, and the next insert would land in the wrong place.
  const inserts = [...ordered].reverse().map(g => ({
    insertDimension: {
      range: { sheetId, dimension: 'ROWS', startIndex: g.at, endIndex: g.at + g.rows.length },
      // Only possible when there IS a row above.
      inheritFromBefore: g.at > 0,
    },
  }));
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: inserts } });

  // Did that actually do anything? A batchUpdate answers 200 with a reply for
  // every request, and a sheet with three more rows in it is taller than it was.
  // Checking is what turns "reported three rows that were not there" into a plain
  // failure the caller can recover from by appending.
  const wantRows = rows.length;
  if (rowCount != null) {
    const after = await sheetMetaFor(sheets, spreadsheetId, sheetName).catch(() => null);
    if (after && after.rowCount != null && after.rowCount < rowCount + wantRows) {
      throw new Error(`the insert was accepted but the sheet still has ${after.rowCount} rows `
        + `(it had ${rowCount}, and should now have ${rowCount + wantRows}) — the service account `
        + `may be able to edit cells but not the sheet's structure`);
    }
  }

  // 2. The formulas, separately and best-effort, one paste per contiguous run of
  //    formula columns. Narrow ranges rather than the whole row, because a paste
  //    that touches a merged cell is refused outright — and by now the rows are
  //    already where they belong, so a refusal costs a few blank formula cells
  //    instead of the placement.
  //
  //    These address the sheet AFTER the inserts, hence finalAt.
  const copies = [];
  const skipped = new Set();
  for (const g of ordered) {
    if (g.at <= 0) continue;                       // nothing above to copy from
    const blocked = mergedCols.get(g.at) || new Set();
    const from = [...(formulaCols.get(g.at) || [])].filter(c => {
      if (!blocked.has(c)) return true;
      skipped.add(c);
      return false;
    });
    for (const run of columnRuns(from)) {
      copies.push({
        copyPaste: {
          source: { sheetId, startRowIndex: g.finalAt - 1, endRowIndex: g.finalAt,
                    startColumnIndex: run.start, endColumnIndex: run.end },
          destination: { sheetId, startRowIndex: g.finalAt, endRowIndex: g.finalAt + g.rows.length,
                         startColumnIndex: run.start, endColumnIndex: run.end },
          pasteType: 'PASTE_FORMULA',
          pasteOrientation: 'NORMAL',
        },
      });
    }
  }
  if (skipped.size) {
    warnings.push(`Column${skipped.size === 1 ? '' : 's'} `
      + [...skipped].sort((a, b) => a - b).map(c => quota.colLetter(c)).join(', ')
      + ` ${skipped.size === 1 ? 'holds' : 'hold'} a formula inside a merged cell, `
      + `so ${skipped.size === 1 ? 'it was' : 'they were'} `
      + 'left blank rather than pasted over the merge. Fill '
      + `${skipped.size === 1 ? 'it' : 'them'} in by dragging the row above down.`);
  }
  if (copies.length) {
    try {
      await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: copies } });
    } catch (err) {
      console.warn('[MetDB] could not carry the formulas onto the new rows:', err.message);
      warnings.push('The rows are in the right sections, but their formula cells could not be '
        + `copied down (${err.message}) — drag the row above down over them.`);
    }
  }

  // 3. The values. The rows exist, so addressing cells is safe — and per-cell
  //    rather than whole-row, so a formula column the paste just filled is left
  //    alone instead of being overwritten with a blank.
  const writes = [];
  const placed = [];
  for (const g of ordered) {
    g.rows.forEach((r, i) => {
      const rowIdx = g.finalAt + i;        // 0-based
      const cell = (col, value) => {
        if (col == null) return;
        writes.push({ range: `${sheetName}!${quota.colLetter(col)}${rowIdx + 1}`, values: [[value]] });
      };
      cell(cols.username, r.username);
      cell(cols.rank, r.rank || '');
      cell(cols.discordId, r.discordId || '');
      if (r.wtbt) cell(cols.wtbt, wtbtCell(true));
      for (const d of Object.values(cols.days || {})) cell(d, 0);
      // Everything else: cleared unless the neighbour had a formula there, or a
      // merge covers it. Inheriting a timezone or a strike count would be a lie
      // about this person; writing into the middle of a merge is a request Sheets
      // may refuse, and it would take every write above it down with it.
      const keep = formulaCols.get(g.at) || new Set();
      const merged = mergedCols.get(g.at) || new Set();
      for (let c = 0; c < width; c++) {
        if (mine.has(c) || keep.has(c) || merged.has(c)) continue;
        cell(c, '');
      }
      placed.push({
        username: r.username, rank: r.rank || null, row: rowIdx + 1,
        // Kept for the message when a row turns out not to be there: "written to
        // row 29 but not there" names the row somebody should go and look at.
        wanted: rowIdx + 1,
        under: g.grouped ? (r.rank || null) : null,
      });
    });
  }

  if (writes.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId, requestBody: { valueInputOption: 'USER_ENTERED', data: writes },
    });
  }

  // 4. Read it back, and only claim what is actually there.
  //
  // "Added at row 29" was arithmetic, not observation: it was the row the code
  // MEANT to write, reported as fact whether or not anything landed. A run that
  // reported three rows against a sheet that had not gained a single one is worse
  // than a failure, because it stops anybody looking. So the rows are read back,
  // and a member the sheet cannot show us is not reported as placed.
  const verified = await verifyPlacement(sheets, spreadsheetId, sheetName, placed, cols);
  const missing = placed.filter(p => !verified.has(p.row));
  if (missing.length === placed.length) {
    // Nothing arrived. Throwing here is deliberate: the caller's fallback appends
    // them to the end of the sheet, which is untidy and real, and infinitely
    // better than a confident report of rows that do not exist.
    throw new Error(`the sheet accepted the write but none of the ${placed.length} row(s) `
      + `are there afterwards`);
  }
  for (const p of missing) {
    p.row = null;
    p.under = null;
    warnings.push(`${p.username} was written to row ${p.wanted || '?'} but is not there on a re-read `
      + `— add them by hand.`);
  }
  return { placed, warnings };
}

/**
 * Which of the rows we just wrote actually contain the person we wrote there.
 *
 * Re-reads the username column over the affected span. Never throws: if the sheet
 * will not answer, every row is treated as verified rather than wrongly reported
 * as missing — an unreadable sheet is not evidence that the write failed.
 *
 * @returns {Promise<Set<number>>} the 1-based rows that check out
 */
async function verifyPlacement(sheets, spreadsheetId, sheetName, placed, cols) {
  const ok = new Set();
  const rows = placed.map(p => p.row).filter(r => r > 0);
  if (!rows.length || cols.username == null) return ok;
  const first = Math.min(...rows);
  const last = Math.max(...rows);
  const col = quota.colLetter(cols.username);
  try {
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!${col}${first}:${col}${last}`,
      valueRenderOption: 'FORMATTED_VALUE',
    });
    const values = resp.data.values || [];
    for (const p of placed) {
      if (!(p.row > 0)) continue;
      const got = (values[p.row - first] || [])[0];
      if (quota.normName(got) === quota.normName(p.username)) ok.add(p.row);
    }
  } catch (err) {
    console.warn('[MetDB] could not read the new rows back:', err.message);
    for (const p of placed) if (p.row > 0) ok.add(p.row);
  }
  return ok;
}

/**
 * For each insertion point, which columns of the row above hold a formula.
 *
 * Read with FORMULA rendering, which is the only way to tell "=SUM(...)" from the
 * number it evaluates to. Best-effort: if the read fails, nothing is treated as a
 * formula, which means a total might get cleared — visible and fixable, unlike a
 * silently inherited value.
 */
async function formulaColumnsOf(sheets, spreadsheetId, sheetName, groups, width) {
  const out = new Map();
  for (const g of groups) {
    out.set(g.at, new Set());
    if (g.at <= 0) continue;
    try {
      const resp = await sheets.spreadsheets.values.get({
        spreadsheetId,
        // The neighbour row, as it was BEFORE the insert — the insert pushed it
        // nowhere, because rows were added below it.
        range: `${sheetName}!${g.at}:${g.at}`,
        valueRenderOption: 'FORMULA',
      });
      const row = (resp.data.values && resp.data.values[0]) || [];
      for (let c = 0; c < Math.max(width, row.length); c++) {
        if (typeof row[c] === 'string' && row[c].charAt(0) === '=') out.get(g.at).add(c);
      }
    } catch (e) {
      console.warn(`[MetDB] could not tell which cells on row ${g.at} are formulas:`, e.message);
    }
  }
  return out;
}

/**
 * One member as a whole row, positioned by the sheet's own column indices.
 *
 * A whole row rather than a set of cells, because appending is what grows the
 * sheet and appending takes rows. Columns this does not know about are left
 * empty, which for a brand-new row is the same as not writing them.
 */
function memberRow(r, cols) {
  const idx = [cols.username, cols.rank, cols.discordId, cols.wtbt]
    .concat(Object.values(cols.days || {}))
    .filter(c => c != null)
    .map(Number);
  const width = idx.length ? Math.max.apply(null, idx) + 1 : 1;
  const row = new Array(width).fill('');
  const put = (col, value) => { if (col != null) row[col] = value; };
  put(cols.username, r.username);
  put(cols.rank, r.rank || '');
  put(cols.discordId, r.discordId || '');
  // Only when the mark was asked for. A FALSE stamped into every new row would
  // overwrite whatever convention the sheet already uses for people who ARE
  // trained; leaving it empty says nothing, which is the honest answer.
  if (r.wtbt) put(cols.wtbt, wtbtCell(true));
  // Zero, not blank: a blank day cell reads as "no data" when it means "no points".
  for (const d of Object.values(cols.days || {})) put(d, 0);
  return row;
}

/**
 * Append rows to the end of a sheet, growing it if it needs to.
 *
 * This is the whole reason it is `append` and not `batchUpdate`. batchUpdate
 * writes into cells that already exist and refuses anything past the last one:
 * a tab whose grid ends at row 36 answers "Range (Staff!D37) exceeds grid
 * limits" and the entire write fails. Every new member hit that the moment a
 * sheet had no spare rows left, which is the normal state of a sheet somebody
 * has tidied.
 *
 * insertDataOption INSERT_ROWS is what adds the rows rather than overwriting
 * whatever happens to sit below the table.
 */
async function appendToSheet(sheets, spreadsheetId, sheetName, values) {
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    // The whole sheet, so Sheets finds the real end of the data rather than the
    // end of a range we guessed at.
    range: sheetName,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
}

// ── Optional daily worker ─────────────────────────────────────────
function startMetDatabaseWorker() {
  if (process.env.MET_DB_AUTO_SYNC !== 'true') return;
  const run = () => syncMetDatabase({ dry: false, actor: { id: null, name: 'automatic sync' } })
    .catch(err => console.warn('[MetDB] auto sync failed:', err.message));
  setTimeout(run, 5 * 60 * 1000);          // 5 min after boot
  setInterval(run, 24 * 60 * 60 * 1000);   // then daily
}

module.exports = {
  planSync, applySync, syncMetDatabase, readRoster, readGroupMembers, scopeFor,
  startMetDatabaseWorker,
  missingMembers, addMembers, appendRows, isProbationary, wtbtCell, MAX_PICK,
  memberRow, appendToSheet, placeMembers, rankBlockEnd, rankKey, sheetIdFor,
  sheetMetaFor, mergedColumnsAt, columnRuns, verifyPlacement,
};
