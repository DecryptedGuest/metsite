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
  //
  //    THIS division's webhook. The test used to be `process.env.QUOTA_WEBHOOK_URL`
  //    and the call took no division — and that variable is the INTERNAL AFFAIRS
  //    script. So a MET sync built its plan from the MET sheet and then posted the
  //    whole thing, removals included, to the IA sheet.
  if (quota.hasQuotaWebhook(scope.division)) {
    const viaWebhook = await quota.callQuotaWebhook({
      action:  'roster',
      remove:  plan.remove.map(r => ({ username: r.username, discordId: r.discordId || null })),
      add:     plan.add.map(a => ({ username: a.username, rank: a.rank || '', discordId: a.discordId || '' })),
    }, scope.division).catch(err => ({ ok: false, error: err.message }));

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
      writes.push({ range: quota.sheetRef(sheetName, `${quota.colLetter(c)}${rowIdx + 1}`), values: [['']] });
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
      // Member objects, `cols` and the sheet as read — not pre-built row arrays.
      // appendToSheet stopped taking those when it stopped using values.append,
      // which was writing every field one column to the right of where it belonged.
      // This call site was missed, and with `cols` arriving as undefined the add
      // half of every sync threw before writing anything.
      await appendToSheet(sheets, spreadsheetId, sheetName,
        plan.add.map(a => ({ username: a.username, rank: a.rank, discordId: a.discordId })),
        cols, rows);
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

  // Everyone the database is not FOR. The IA group contains the whole umbrella
  // above Internal Affairs — the game owner, the holders, MET Overseer, MET
  // Administration — and none of them belong on a sheet of investigators with a
  // weekly quota. Offering to add them is noise at best and a row somebody has to
  // delete at worst.
  const ceiling = await rankCeiling(scope);

  const missing = [];
  const above = [];
  for (const m of all) {
    if (onSheetNames.has(quota.normName(m.username))) continue;
    if (onSheetRobloxIds.has(String(m.userId))) continue;
    if (isAboveCeiling(m, ceiling)) { above.push({ username: m.username, rank: m.roleName || '' }); continue; }
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
    // Rows that exist but are not where anybody looking at the sheet would find
    // them. Reported here because they are the reason somebody who is plainly
    // absent from the database stops being offered: they DO have a row, just not
    // one in their rank's section, so "already on the sheet" was true and useless.
    stray: strayMembers(sheet.rows, sheet.cols)
      // Rows in their block but in the wrong order within it: somebody trained
      // sitting under somebody of the same rank who is still waiting. Reported
      // alongside the strays because the same button fixes both.
      .concat(wtbtOutOfOrder(sheet.rows, sheet.cols)),
    // Rows an older version of the append fallback wrote into the wrong columns.
    // Reported, never touched: which columns were meant is a guess, and these have
    // to be deleted by a person.
    misaligned: misalignedRows(sheet.rows, sheet.cols),
    groupSize: all.length,
    sheetRows: roster.length,
    division:  scope.division,
    group:     scope.name || scope.division,
    sheetName: sheet.sheetName,
    // Whether the sheet even HAS a column to write the mark into. Without one the
    // UI must not offer a toggle whose value goes nowhere.
    hasWtbtColumn: sheet.cols.wtbt != null,
    // Ranks above the ceiling that were left out, and the ceiling itself. Reported
    // rather than silently dropped: "13 in the group with no row" turning into 2
    // needs an explanation, or it reads as the list being broken.
    aboveCeiling: above,
    ceiling: ceiling ? { name: ceiling.name, rank: ceiling.rank } : null,
  };
}

// The rank the database stops at. Everything above it is the umbrella that owns
// the group rather than the division that lives in it.
//
// Settable, because a group can rename its ranks: MET_DB_TOP_RANK="Director".
const TOP_RANK_NAME = () => (process.env.MET_DB_TOP_RANK || 'Director').trim();

// Names that are never division members whatever their number says. A group whose
// ranks are numbered oddly — an umbrella rank sitting below Director — would
// otherwise slip through the numeric test, and these are unmistakable.
const NEVER_MEMBERS = [
  /\bholder\b/i, /game\s*owner/i, /\bowner\b/i, /overseer/i,
  /administration/i, /\bhicom+\b/i, /high\s*com+and/i, /\bbot\b/i, /\bapi\b/i,
];

/**
 * The numeric rank of the highest role the database covers.
 *
 * Read from the group's own role list, so it is right even when nobody currently
 * holds the rank. Falls back to null — and with no ceiling the name list below is
 * the only filter, which is the safe direction: it excludes the handful of ranks
 * that are unmistakably not investigators and keeps everybody else.
 */
async function rankCeiling(scope) {
  const groupId = (scope && scope.groupId) || GROUP_ID();
  if (!groupId) return null;
  try {
    const roles = await require('./roblox').listGroupRoles(groupId);
    const want = TOP_RANK_NAME().toLowerCase();
    // Exact name first. "Director" must not match "Assistant Director" or "Deputy
    // Director", both of which are BELOW it and must stay on the list.
    const exact = roles.find(r => String(r.name || '').trim().toLowerCase() === want);
    if (exact) return { name: exact.name, rank: Number(exact.rank) };
    return null;
  } catch (err) {
    console.warn('[MetDB] could not read the group roles to find the rank ceiling:', err.message);
    return null;
  }
}

/** Is this member above the rank the database covers? */
function isAboveCeiling(member, ceiling) {
  const name = String((member && member.roleName) || '');
  if (NEVER_MEMBERS.some(re => re.test(name))) return true;
  if (!ceiling || !Number.isFinite(ceiling.rank)) return false;
  const rank = Number(member && member.roleRank);
  return Number.isFinite(rank) && rank > ceiling.rank;
}

/**
 * Member rows that sit outside their rank's block.
 *
 * A rank's rows are contiguous on a sheet that anybody has looked at: three
 * Probationary Investigators are three rows in a row, under the heading that says
 * so. A fourth one further down, past a heading or a footer or a blank, is a row
 * that was appended rather than placed — which is exactly what the append fallback
 * does when it cannot insert.
 *
 * That matters more than tidiness. A stray row still counts as "on the sheet", so
 * the person stops appearing in the missing list and stops being offered — they
 * are invisible in both directions at once.
 *
 * The test is contiguity: group the member rows by rank, and split each rank into
 * runs broken by any NON-member row. The first run is the block; anything in a
 * later run is stray. A rank with only one run is never stray, however far down it
 * sits, because a single block is where that rank lives.
 *
 * @returns {Array<{username, row, rank, blockEndsAt}>} 1-based rows
 */
function strayMembers(rows, cols) {
  if (!rows || !rows.length || cols.username == null) return [];
  const memberAt = rows.map(r => isMemberRow(cols, r));

  const byRank = new Map();   // rankKey → indices, ascending
  for (let i = 0; i < rows.length; i++) {
    if (!memberAt[i]) continue;
    const key = cols.rank != null ? rankKey(rows[i][cols.rank]) : '';
    if (!byRank.has(key)) byRank.set(key, []);
    byRank.get(key).push(i);
  }

  const out = [];
  for (const [key, idx] of byRank) {
    // Split into runs: two rows of the same rank belong to the same run only if
    // every row between them is also a member row.
    const runs = [[idx[0]]];
    for (let k = 1; k < idx.length; k++) {
      let joined = true;
      for (let b = idx[k - 1] + 1; b < idx[k]; b++) if (!memberAt[b]) { joined = false; break; }
      if (joined) runs[runs.length - 1].push(idx[k]);
      else runs.push([idx[k]]);
    }
    if (runs.length < 2) continue;
    const block = runs[0];
    for (const run of runs.slice(1)) {
      for (const i of run) {
        out.push({
          username: String(rows[i][cols.username] || '').trim(),
          row: i + 1,
          rank: cols.rank != null ? String(rows[i][cols.rank] || '').trim() : '',
          rankKey: key,
          // Where it should be: straight after the last row of the real block.
          shouldBeRow: block[block.length - 1] + 2,
        });
      }
    }
  }
  return out.sort((a, b) => a.row - b.row);
}

/**
 * Move stray rows into their rank's block.
 *
 * moveDimension rather than delete-and-rewrite: it is the same operation as
 * dragging the row by its number, so the values, the formatting, the checkbox
 * validation and the formulas all travel with it and nothing has to be copied by
 * hand. Nothing is ever deleted here.
 *
 * One move per pass, re-reading the sheet in between. The alternative is index
 * arithmetic over a sheet that is changing under you, and this is a tidy-up of at
 * most a handful of rows — correctness is worth more than the round trips.
 *
 * Only ever moves a row UPWARDS, into a block above it. A downward move has
 * different destination-index semantics and no case here needs one, so it is
 * refused rather than guessed at.
 */
const MAX_TIDY = 25;

async function tidyStrayRows(division, actor, opts = {}) {
  const scope = scopeFor(division || 'IA');
  const dry = opts.dryRun === true;
  const moved = [], skipped = [], errors = [];

  for (let pass = 0; pass < MAX_TIDY; pass++) {
    const read = scope.division !== 'IA'
      ? await quota.readSheetFor(scope.cfg)
      : await quota.readSheet();
    if (!read) return { ok: false, error: 'The quota sheet is not readable.', moved, skipped };
    const { sheets, spreadsheetId, sheetName, rows, cols } = read;

    // Rows outside their block first, then rows inside it but in the wrong order.
    // In that order because moving a stray row INTO a block changes what "in the
    // wrong order" means for that block, and the other way round would have to be
    // redone.
    const strays = strayMembers(rows, cols).concat(wtbtOutOfOrder(rows, cols))
      // Anything we have already tried is not tried again, or a move that silently
      // does nothing becomes an endless loop.
      .filter(s => !moved.some(m => m.username === s.username)
                && !skipped.some(k => k.username === s.username));
    if (!strays.length) break;

    const s = strays[0];
    const from = s.row - 1;                 // 0-based
    const to = s.shouldBeRow - 1;           // 0-based, where it should start
    if (!(to < from)) {
      skipped.push({ ...s, why: 'its block is below it, and this only moves rows up' });
      continue;
    }
    if (dry) { moved.push({ ...s, to: s.shouldBeRow }); continue; }

    try {
      const { sheetId } = await sheetMetaFor(sheets, spreadsheetId, sheetName);
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [{
          moveDimension: {
            source: { sheetId, dimension: 'ROWS', startIndex: from, endIndex: from + 1 },
            destinationIndex: to,
          },
        }] },
      });

      // Did it land? Same reasoning as the placement read-back: a request that is
      // accepted and does nothing must not be reported as a move.
      const check = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: quota.sheetRef(sheetName, `${quota.colLetter(cols.username)}${to + 1}`),
        valueRenderOption: 'FORMATTED_VALUE',
      }).catch(() => null);
      const landed = check && quota.normName((((check.data.values || [])[0] || [])[0]))
        === quota.normName(s.username);
      if (!landed) {
        skipped.push({ ...s, why: 'the move was accepted but the row is not there afterwards — '
          + 'the service account may not be allowed to change the sheet\'s structure' });
        break;   // it will not work for the next one either
      }
      moved.push({ ...s, to: s.shouldBeRow });
    } catch (err) {
      errors.push(`${s.username}: ${err.message}`);
      break;
    }
  }

  if (moved.length && !dry) {
    console.log(`[MetDB] ${scope.division} database — moved ${moved.length} stray row(s) `
      + `into place${actor && actor.name ? ` for ${actor.name}` : ''}`);
  }
  return { ok: !errors.length, dryRun: dry, moved, skipped, errors };
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

// Reading one back. A checkbox column comes back as "TRUE"/"FALSE", but the same
// column filled in by hand holds ticks, "yes", "y", "wtbt" or a 1 — and a column
// somebody has not touched holds nothing. Only an affirmative counts as waiting;
// anything unrecognised is read as trained, which is the direction that leaves a
// row where it already is rather than moving it on a guess.
const WTBT_YES = /^(?:true|yes|y|✓|✔|x|wtbt|waiting|1)$/i;
function isWtbtRow(cols, row) {
  if (!row || cols.wtbt == null) return false;
  return WTBT_YES.test(String(row[cols.wtbt] == null ? '' : row[cols.wtbt]).trim());
}

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
  if (quota.hasQuotaWebhook(scope && scope.division)) {
    const via = await quota.callQuotaWebhook({
      action: 'roster',
      remove: [],
      add: rows.map(r => ({
        username: r.username, rank: r.rank || '',
        discordId: r.discordId || '', wtbt: wtbtCell(r.wtbt),
      })),
    }, scope && scope.division).catch(err => ({ ok: false, error: err.message }));
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
      // Rows that ARE on the sheet must never be written a second time. The
      // re-read at the top of this function happened BEFORE placeMembers ran, so
      // it cannot see rows placeMembers itself inserted — which is how a partial
      // failure produced two rows for every person, one in the block and one at
      // the bottom. When the failure says the rows exist, stop.
      if (err.rowsExist) {
        const at = (err.blankRows || []).join(', ');
        errors.push(`The rows were inserted${at ? ` at row${(err.blankRows || []).length === 1 ? '' : 's'} ${at}` : ''} `
          + `but could not be completed (${err.message}). Nothing else was written, because `
          + `writing again would add a second row for each of them. Check `
          + `${at ? `row${(err.blankRows || []).length === 1 ? '' : 's'} ${at}` : 'the sheet'} `
          + `and finish or delete ${(err.blankRows || []).length === 1 ? 'it' : 'them'} by hand.`);
        return { ok: false, via: 'sheets', added: 0, alreadyThere, sheetName,
                 placed: [], partial: true, errors };
      }
      console.warn('[MetDB] could not place the rows by rank, appending instead:', err.message);
      try {
        const at = await appendToSheet(sheets, spreadsheetId, sheetName, wanted, cols, existing);
        errors.push('Could not put them in their rank sections (' + err.message
          + `), so they were written below everything else, on row${at.length === 1 ? '' : 's'} `
          + at.join(', ') + '. Use "Tidy the rows" to move them into their block.');
        placed = wanted.map((r, i) => ({ username: r.username, rank: r.rank || null,
                                         row: at[i] || null, under: null, appended: true }));
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

/**
 * The columns the member table occupies, as [start, end).
 *
 * From the columns the header row was found in — first to last, inclusive of
 * everything between them, because a table's borders and fills belong to the
 * whole run and not only to the cells this code writes into. Nothing outside it
 * is ever touched: the notes, the point system and the gold frame around the
 * table all live in columns this deliberately does not reach.
 */
function tableSpan(cols) {
  const idx = [cols.username, cols.rank, cols.discordId, cols.wtbt]
    .concat(Object.values(cols.days || {}))
    .filter(c => c != null).map(Number).filter(Number.isFinite);
  if (!idx.length) return null;
  return { start: Math.min(...idx), end: Math.max(...idx) + 1 };
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
function rankBlockEnd(existing, cols, rank, opts = {}) {
  if (cols.rank == null) return null;
  const want = rankKey(rank);
  if (!want) return null;
  const idx = [];
  for (let i = 0; i < existing.length; i++) {
    if (!isMemberRow(cols, existing[i])) continue;
    if (rankKey(existing[i][cols.rank]) === want) idx.push(i);
  }
  if (!idx.length) return null;
  const last = idx[idx.length - 1];
  // Somebody who has already been trained goes ABOVE the people still waiting
  // for their session. The waiting ones are the bottom of the block by
  // convention — that is how the sheet is read at a glance, "everyone under this
  // line still needs training" — and appending a trained officer under them
  // breaks the only thing that ordering was carrying.
  if (opts.beforeWtbt && cols.wtbt != null) {
    let cut = idx.length;
    while (cut > 0 && isWtbtRow(cols, existing[idx[cut - 1]])) cut--;
    if (cut < idx.length) return idx[cut];
  }
  return last + 1;
}

/**
 * Rows the old append fallback wrote one or more columns to the RIGHT of where
 * they belong.
 *
 * values.append writes from the first column of whatever table Sheets decides it
 * found, not from column A — so a row array built with the username at index 3
 * landed it in column E on a sheet whose content starts at column B, and every
 * other field went with it. The result is a row that looks like a member to a
 * person reading it and like an empty row to every piece of code here, sitting
 * below the table with the notes block's borders around it.
 *
 * They cannot be tidied into place: nothing here can be sure which columns were
 * meant, and shifting somebody's row sideways on a guess is worse than leaving it.
 * So they are found and named, precisely, and a person deletes them.
 *
 * The signature is exact rather than fuzzy: at the same offset, a non-empty
 * username cell AND a rank cell holding a rank the sheet actually uses. A note
 * that happens to sit under the table does not match it.
 *
 * @returns {Array<{row, username, rank, offset}>} 1-based rows
 */
function misalignedRows(rows, cols) {
  if (!rows || !rows.length || cols.username == null || cols.rank == null) return [];
  const known = new Set();
  for (const r of rows) {
    if (!isMemberRow(cols, r)) continue;
    const k = rankKey(r[cols.rank]);
    if (k) known.add(k);
  }
  if (!known.size) return [];

  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || isMemberRow(cols, row)) continue;
    for (let k = 1; k <= 8; k++) {
      const name = String(row[cols.username + k] == null ? '' : row[cols.username + k]).trim();
      const rank = String(row[cols.rank + k] == null ? '' : row[cols.rank + k]).trim();
      if (!name || !rank || !known.has(rankKey(rank))) continue;
      out.push({ row: i + 1, username: name, rank, offset: k });
      break;
    }
  }
  return out;
}

/**
 * Trained members sitting underneath somebody of the same rank who is still
 * waiting to be trained.
 *
 * Same shape as strayMembers, so the tidy pass can treat both the same way, and
 * deliberately phrased as "the trained row is in the wrong place" rather than
 * "the waiting row is": moving a row UP is the one direction moveDimension is
 * used in here, and lifting the trained row above the waiting ones puts the
 * block in order in exactly one move either way.
 *
 * @returns {Array<{username, row, rank, shouldBeRow, why}>} 1-based rows
 */
function wtbtOutOfOrder(rows, cols) {
  if (!rows || !rows.length || cols.username == null || cols.wtbt == null) return [];
  const byRank = new Map();
  for (let i = 0; i < rows.length; i++) {
    if (!isMemberRow(cols, rows[i])) continue;
    const key = cols.rank != null ? rankKey(rows[i][cols.rank]) : '';
    if (!byRank.has(key)) byRank.set(key, []);
    byRank.get(key).push(i);
  }

  const out = [];
  for (const idx of byRank.values()) {
    const firstWaiting = idx.find(i => isWtbtRow(cols, rows[i]));
    if (firstWaiting == null) continue;
    for (const i of idx) {
      if (i <= firstWaiting || isWtbtRow(cols, rows[i])) continue;
      out.push({
        username: String(rows[i][cols.username] || '').trim(),
        row: i + 1,
        rank: cols.rank != null ? String(rows[i][cols.rank] || '').trim() : '',
        rankKey: cols.rank != null ? rankKey(rows[i][cols.rank]) : '',
        // Straight above the first person of that rank who is still waiting.
        shouldBeRow: firstWaiting + 1,
        why: 'trained, but sitting below somebody of the same rank who is still waiting to be trained',
      });
    }
  }
  return out.sort((a, b) => a.row - b.row);
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
  //
  // Somebody still waiting to be trained goes at the very bottom of their rank's
  // block; somebody already trained goes above everyone of that rank who is
  // waiting. Those are two different insertion points in the same block, so they
  // become two groups — and within a group the trained ones are written first,
  // for the case where the block has no waiting rows yet and both land at the
  // same point.
  const groups = new Map();   // insertion index → { at, rows[], grouped }
  for (const r of rows) {
    const at = rankBlockEnd(existing, cols, r.rank, { beforeWtbt: !r.wtbt });
    const key = at == null ? endOfData : at;
    if (!groups.has(key)) groups.set(key, { at: key, rows: [], grouped: at != null });
    groups.get(key).rows.push(r);
  }
  for (const g of groups.values()) {
    g.rows.sort((a, b) => (a.wtbt ? 1 : 0) - (b.wtbt ? 1 : 0));
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

  // What the row above each insertion point looks like in the two columns that
  // have to MATCH it rather than be derived: the rank's spelling in this block, and
  // whatever the block puts in the WTBT column for somebody who is not waiting.
  for (const g of ordered) {
    const above = g.at > 0 ? existing[g.at - 1] : null;
    if (!above || !isMemberRow(cols, above)) continue;
    if (cols.rank != null) {
      const spelling = String(above[cols.rank] == null ? '' : above[cols.rank]).trim();
      // Only when it IS the same rank loosely. The neighbour of a group that fell
      // through to the end of the sheet is somebody else entirely.
      const same = g.rows.every(r => rankKey(r.rank) && rankKey(r.rank) === rankKey(spelling));
      if (same && spelling) g.rankAs = spelling;
    }
    if (cols.wtbt != null && !isWtbtRow(cols, above)) {
      g.neighbourWtbt = String(above[cols.wtbt] == null ? '' : above[cols.wtbt]).trim();
    }
  }

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

  // 2a. The formatting, explicitly.
  //
  //     insertDimension's inheritFromBefore is supposed to cover this, and mostly
  //     does — but a border drawn as the EDGE of a range is a property of that
  //     range, not of the row inside it, so a row inserted at the end of a bordered
  //     block lands outside the block's bottom edge and comes out with no border on
  //     it. That is exactly what the last three rows looked like: right section,
  //     right values, no gridlines.
  //
  //     So the neighbour row's format is pasted over the new rows across the
  //     table's own columns. It cannot make things worse — the answer it produces
  //     is "identical to the row above", which is the whole requirement — and it is
  //     best-effort, so a refusal costs formatting and not the placement.
  const span = tableSpan(cols);
  const formats = [];
  const copies = [];
  const skipped = new Set();
  if (span) {
    for (const g of ordered) {
      if (g.at <= 0) continue;
      const blocked = mergedCols.get(g.at) || new Set();
      const cells = [];
      for (let c = span.start; c < span.end; c++) if (!blocked.has(c)) cells.push(c);
      for (const run of columnRuns(cells)) {
        formats.push({
          copyPaste: {
            source: { sheetId, startRowIndex: g.finalAt - 1, endRowIndex: g.finalAt,
                      startColumnIndex: run.start, endColumnIndex: run.end },
            destination: { sheetId, startRowIndex: g.finalAt, endRowIndex: g.finalAt + g.rows.length,
                           startColumnIndex: run.start, endColumnIndex: run.end },
            pasteType: 'PASTE_FORMAT',
            pasteOrientation: 'NORMAL',
          },
        });
      }
    }
  }
  // A merge ACROSS the neighbour row — two columns joined into one cell, the way a
  // sheet writes a two-part heading — is not copied by anything above. insertDimension
  // does not carry merges, and PASTE_FORMAT does not create them. So the new row has
  // two separate cells where every row above it has one, which is visible: the
  // gridlines do not line up.
  //
  // Only single-row (horizontal) merges are recreated. A merge that spans several
  // rows already grew to include the new rows when they were inserted inside it, and
  // asking for it again would be asking to merge a cell that is already merged.
  const width2 = width;
  for (const g of ordered) {
    if (g.at <= 0) continue;
    const above = g.at - 1;
    for (const m of merges) {
      const r0 = m.startRowIndex == null ? 0 : m.startRowIndex;
      const r1 = m.endRowIndex == null ? r0 + 1 : m.endRowIndex;
      if (r0 !== above || r1 !== above + 1) continue;        // not a one-row merge on the neighbour
      const c0 = m.startColumnIndex == null ? 0 : m.startColumnIndex;
      const c1 = m.endColumnIndex == null ? Math.max(width2, c0 + 1) : m.endColumnIndex;
      if (c1 - c0 < 2) continue;
      for (let i = 0; i < g.rows.length; i++) {
        formats.push({
          mergeCells: {
            range: { sheetId, startRowIndex: g.finalAt + i, endRowIndex: g.finalAt + i + 1,
                     startColumnIndex: c0, endColumnIndex: c1 },
            mergeType: 'MERGE_ALL',
          },
        });
      }
    }
  }

  // Its own batch, not folded in with the formulas below. A batch is all-or-
  // nothing, and the formatting is the less important of the two: sharing a batch
  // would mean a border that could not be pasted also cost the row its =SUM().
  if (formats.length) {
    try {
      await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: formats } });
    } catch (err) {
      console.warn('[MetDB] could not copy the formatting onto the new rows:', err.message);
      warnings.push('The rows are in the right sections, but the borders and colours of the row '
        + `above could not be copied onto them (${err.message}).`);
    }
  }

  // 2b. The formulas, separately and best-effort, one paste per contiguous run of
  //    formula columns. Narrow ranges rather than the whole row, because a paste
  //    that touches a merged cell is refused outright — and by now the rows are
  //    already where they belong, so a refusal costs a few blank formula cells
  //    instead of the placement.
  //
  //    These address the sheet AFTER the inserts, hence finalAt.
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
  // Only the columns nothing else fills. A column we write ourselves — username,
  // rank, Discord id, WTBT, the days — is not left blank by skipping its paste, and
  // warning about it produced actively harmful advice: the last run told somebody
  // to drag the row above down over the RANK column, which would have overwritten
  // the rank this code had just written correctly with the previous member's.
  for (const c of [...skipped]) if (mine.has(c)) skipped.delete(c);
  if (skipped.size) {
    warnings.push(`Column${skipped.size === 1 ? '' : 's'} `
      + [...skipped].sort((a, b) => a - b).map(c => quota.colLetter(c)).join(', ')
      + ` ${skipped.size === 1 ? 'holds' : 'hold'} a formula inside a merged cell, `
      + `so ${skipped.size === 1 ? 'it was' : 'they were'} `
      + `left blank rather than pasted over the merge — copy just ${skipped.size === 1 ? 'that cell' : 'those cells'} `
      + 'down from the row above (do not drag the whole row, it would overwrite the '
      + 'rank and Discord id).');
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
        writes.push({ range: quota.sheetRef(sheetName, `${quota.colLetter(col)}${rowIdx + 1}`), values: [[value]] });
      };
      cell(cols.username, r.username);
      // The spelling the BLOCK uses, not the Roblox role name. The block is found
      // by a loose match — "PINV" and "Probationary Investigator" are the same rank
      // to rankKey — so writing the Roblox name verbatim put a row spelled one way
      // into a block spelled another, and nothing downstream could notice because
      // strayMembers compares loosely too.
      cell(cols.rank, (g.rankAs != null ? g.rankAs : r.rank) || '');
      cell(cols.discordId, r.discordId || '');
      // The mark, or the convention the neighbours use for somebody who does NOT
      // need it. Writing nothing left the cell blank where every row above it says
      // FALSE or "N/A" — and the webhook path, for the same operation, writes
      // FALSE. Copying the neighbour follows whichever convention the sheet has
      // rather than imposing one.
      if (r.wtbt) cell(cols.wtbt, wtbtCell(true));
      else if (cols.wtbt != null && g.neighbourWtbt != null) cell(cols.wtbt, g.neighbourWtbt);
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

  // The rows exist by now, so a failure here is NOT recoverable by appending — that
  // would leave the blank inserted rows in place AND add a second row for every
  // person. The error therefore carries `rowsExist`, and the caller reports it
  // instead of writing anything more.
  if (writes.length) {
    try {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId, requestBody: { valueInputOption: 'USER_ENTERED', data: writes },
      });
    } catch (err) {
      const span = placed.map(p => p.row).filter(n => n > 0);
      const e = new Error(`the rows were inserted but could not be filled in (${err.message})`);
      e.rowsExist = true;
      e.blankRows = span;
      throw e;
    }
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
    // Not one of them can be read back. Throwing is right — a confident report of
    // rows that do not exist is worse than a failure — but the rows WERE inserted
    // and the write WAS accepted, so appending on top of them would be adding a
    // second row for every person. Say so, and let the caller stop.
    const e = new Error(`the sheet accepted the write but none of the ${placed.length} row(s) `
      + `are there afterwards`);
    e.rowsExist = true;
    e.blankRows = placed.map(p => p.row).filter(n => n > 0);
    throw e;
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
  if (!rows.length) return ok;
  // No username column means there is nothing to read back — NOT that the write
  // failed. Returning an empty set here said "none of them are there" having
  // looked at nothing, which made the caller throw and append the whole batch a
  // second time, on top of rows that were already on the sheet. Same principle as
  // the catch below: an unreadable sheet is not evidence of a failed write.
  if (cols.username == null) {
    console.warn('[MetDB] the sheet has no username column, so the new rows cannot be read back.');
    for (const p of placed) if (p.row > 0) ok.add(p.row);
    return ok;
  }
  const first = Math.min(...rows);
  const last = Math.max(...rows);
  const col = quota.colLetter(cols.username);
  try {
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: quota.sheetRef(sheetName, `${col}${first}:${col}${last}`),
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
        range: quota.sheetRef(sheetName, `${g.at}:${g.at}`),
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

/** One member as a list of explicit A1 cell writes. */
function memberWrites(sheetName, rowNumber, r, cols) {
  const out = [];
  const cell = (col, value) => {
    if (col == null) return;
    out.push({ range: quota.sheetRef(sheetName, `${quota.colLetter(col)}${rowNumber}`), values: [[value]] });
  };
  cell(cols.username, r.username);
  cell(cols.rank, r.rank || '');
  cell(cols.discordId, r.discordId || '');
  if (r.wtbt) cell(cols.wtbt, wtbtCell(true));
  for (const d of Object.values(cols.days || {})) cell(d, 0);
  return out;
}

/**
 * The recovery path: put the rows on the sheet SOMEWHERE, below everything, when
 * placing them in their rank's section did not work.
 *
 * This used to be `values.append` over the whole sheet, and that is what wrecked
 * the bottom of the IA database. Two things about append made it a bad choice
 * here, and neither is obvious from the name:
 *
 *   * the values are written starting at the first column of whatever TABLE
 *     Sheets decides it found — not at column A. The IA sheet's content starts at
 *     column B, so an array built with the username at index 3 (column D) landed
 *     it in column E, and every other field was one column out with it.
 *   * INSERT_ROWS inserts at the end of that same guessed table. On a sheet with a
 *     notes block under the roster, "the end of the table" was the middle of the
 *     notes — so three rows went in there, inheriting the notes box's borders, and
 *     produced an empty bordered grid with names dangling off the side of it.
 *
 * So: explicit rows, explicit A1 cell ranges, below every row the sheet currently
 * holds. Untidy on purpose and honest about it — the row is on the sheet, the
 * missing-members list stops offering the person, and the tidy pass can move it
 * into its block afterwards, which is exactly what strayMembers exists to find.
 *
 * @param {object[]} rows [{ username, rank, discordId, wtbt }]
 * @returns {Promise<number[]>} the 1-based rows written
 */
async function appendToSheet(sheets, spreadsheetId, sheetName, rows, cols, existing) {
  if (!rows.length) return [];
  if (cols.username == null) throw new Error('the sheet has no username column to write into');
  // Below EVERYTHING. values.get trims trailing empty rows, so existing.length is
  // the last row with anything on it anywhere in the read range.
  const firstRow = (existing ? existing.length : 0) + 1;      // 1-based
  const lastRow  = firstRow + rows.length - 1;

  // The grid has to be that tall before a cell in it can be addressed: a write
  // past the last row is refused with "exceeds grid limits", and it takes the
  // whole batch with it.
  const meta = await sheetMetaFor(sheets, spreadsheetId, sheetName).catch(() => null);
  if (meta && meta.rowCount != null && meta.rowCount < lastRow) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{
        appendDimension: { sheetId: meta.sheetId, dimension: 'ROWS', length: lastRow - meta.rowCount },
      }] },
    });
  }

  const data = [];
  const written = [];
  rows.forEach((r, i) => {
    data.push(...memberWrites(sheetName, firstRow + i, r, cols));
    written.push(firstRow + i);
  });
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId, requestBody: { valueInputOption: 'USER_ENTERED', data },
  });
  return written;
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
  missingMembers, addMembers, appendRows, isProbationary, wtbtCell, isWtbtRow, MAX_PICK,
  strayMembers, wtbtOutOfOrder, misalignedRows, tidyStrayRows, rankCeiling, isAboveCeiling, NEVER_MEMBERS,
  memberWrites, appendToSheet, placeMembers, rankBlockEnd, rankKey, sheetIdFor,
  sheetMetaFor, mergedColumnsAt, columnRuns, tableSpan, verifyPlacement,
};
