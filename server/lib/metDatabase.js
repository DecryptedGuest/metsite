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

  // New joiners are APPENDED rather than dropped into the rows just freed:
  // the sheet is grouped into rank sections, so reusing a High Command row for
  // a constable would file them under the wrong heading.
  let appendAt = rows.length;
  for (const a of plan.add) {
    const target = appendAt++;
    if (cols.username  != null) writes.push({ range: `${sheetName}!${quota.colLetter(cols.username)}${target + 1}`,  values: [[a.username]] });
    if (cols.rank      != null) writes.push({ range: `${sheetName}!${quota.colLetter(cols.rank)}${target + 1}`,      values: [[a.rank || '']] });
    // The resolved Discord id, or blank when nobody could be matched. Timezone,
    // WTBT and every other column are left untouched — they are not ours to
    // guess at, and a blank is honest.
    if (cols.discordId != null) writes.push({ range: `${sheetName}!${quota.colLetter(cols.discordId)}${target + 1}`, values: [[a.discordId || '']] });
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
  if (!list.length) return { ok: false, error: 'Nobody was selected.' };
  if (list.length > MAX_PICK) {
    return { ok: false, error: `That is ${list.length} people at once. ${MAX_PICK} is the most this will write in one go — do it in batches so a mistake is small.` };
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
      ok: false,
      error: 'Waiting to be trained only applies to Probationary Investigators, and it was ticked for '
           + wrongRank.join(', ') + '. Untick it for them and try again.',
    };
  }
  if (!resolved.length) {
    return { ok: false, error: unknown.length
      ? `None of them are in the ${scope.name || scope.division} group any more: ${unknown.join(', ')}.`
      : 'Nobody was selected.' };
  }

  // Fill in any Discord id the caller did not send. Best-effort, the same as the
  // sync — an unresolvable member is still added, just without the id.
  await attachDiscordIds(resolved);

  const out = await appendRows(resolved, scope);
  if (unknown.length) out.skipped = unknown;

  // The wtbt count is only mentioned when something was actually written.
  // "added 0 member(s), 1 waiting to be trained" is a line about a selection,
  // not about what happened, and it reads as though a row went in.
  const marked = out.added ? resolved.filter(r => r.wtbt).length : 0;
  const summary = `${scope.name || scope.division} database — added ${out.added} member(s) by hand`
    + (marked ? `, ${marked} waiting to be trained` : '');
  console.log(`[MetDB] ${summary}${out.errors && out.errors.length ? ` (errors: ${out.errors.join('; ')})` : ''}`);
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
    return { ok: false, via: 'webhook', added: 0, alreadyThere: [],
             errors: errors.concat(`The quota webhook did not add them: ${(via && via.error) || 'unknown error'}.`) };
  }

  const sheetRead = scope && scope.division !== 'IA'
    ? await quota.readSheetFor(scope.cfg)
    : await quota.readSheet();
  if (!sheetRead) {
    return { ok: false, added: 0, alreadyThere: [],
             errors: errors.concat('No write path configured (no webhook, no service account).') };
  }
  const { sheets, spreadsheetId, sheetName, rows: existing, cols } = sheetRead;

  // Fresh check for duplicates. The list in the browser could be minutes old.
  const already = new Set();
  for (let i = 0; i < existing.length; i++) {
    if (!isMemberRow(cols, existing[i])) continue;
    already.add(quota.normName(existing[i][cols.username]));
  }

  const writes = [];
  const alreadyThere = [];
  let appendAt = existing.length, added = 0;
  for (const r of rows) {
    if (already.has(quota.normName(r.username))) { alreadyThere.push(r.username); continue; }
    const target = appendAt++;
    const cell = (col, value) => {
      if (col == null) return;
      writes.push({ range: `${sheetName}!${quota.colLetter(col)}${target + 1}`, values: [[value]] });
    };
    cell(cols.username, r.username);
    cell(cols.rank, r.rank || '');
    cell(cols.discordId, r.discordId || '');
    // Only written when the sheet has the column AND the mark was asked for. A
    // FALSE stamped into every new row would overwrite whatever convention the
    // sheet already uses for people who are trained.
    if (r.wtbt) cell(cols.wtbt, wtbtCell(true));
    for (const d of Object.values(cols.days)) cell(d, 0);
    // Two people picked in the same batch must not land on the same row.
    already.add(quota.normName(r.username));
    added++;
  }

  if (writes.length) {
    try {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId, requestBody: { valueInputOption: 'USER_ENTERED', data: writes },
      });
    } catch (err) {
      return { ok: false, via: 'sheets', added: 0, alreadyThere, sheetName, errors: errors.concat(err.message) };
    }
  }
  return { ok: true, via: 'sheets', added, alreadyThere, sheetName, errors };
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
};
