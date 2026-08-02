// server/lib/metDatabaseAudit.js
// Read the whole MET database, say exactly what is wrong with it, and fix the
// parts that can be fixed safely.
//
// The MET database is one tab per rank (Chief Inspector / Inspector / Sergeant
// / Constable), each tab a list of members with seven day columns. Over time it
// drifts in four ways:
//
//   · people sitting on the wrong rank tab, because they were promoted and
//     nobody moved the row
//   · blank day cells, which read as "no data" when they mean "no points" —
//     and a blank is indistinguishable from a cell somebody meant to fill in
//   · junk in a day cell: a dash, a tick, a note. Not a number, not EX/LOA
//   · people in the MET group who are on no tab at all, and rows for people who
//     have left the group entirely
//
// What this module DOES fix, because these are cell writes and nothing else:
//   fillBlanks   every blank or non-numeric day cell becomes 0. EX and LOA are
//                left alone — they are deliberate marks, not missing data.
//   reset        every day cell becomes 0, so counting starts from a known
//                zero. Again EX/LOA survive.
//
// What it REPORTS rather than performs: moving somebody to their correct rank
// tab, adding a missing member, removing somebody who has left. Those are
// structural edits to a live sheet — a row deleted from one tab and appended to
// another, with no undo — and the audit gives you the exact list to act on
// instead of guessing on your behalf. metDatabase.js already owns add/remove
// against the group and is the right place to run those from.
//
// Everything reads through the same helpers the quota engine uses, so "who is a
// member row" means exactly what it means everywhere else.

const quota = require('./quota');

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// A cell that is a deliberate mark rather than a number: exempt, or on leave.
// Never overwritten — somebody wrote it on purpose.
function isMarker(raw) { return /^(ex|loa)$/i.test(String(raw || '').trim()); }

// Which rank tab does this rank name belong on? Reuses the quota tab mapping so
// the audit and the profile card cannot disagree about where somebody sits.
// Returns null for a rank the MET database doesn't track (CSO, and everyone
// above Chief Inspector).
function tabForRank(name) {
  const n = String(name || '').toLowerCase();
  if (/chief\s*inspector/.test(n)) return 'Chief Inspector';
  if (/inspector/.test(n))         return 'Inspector';
  if (/sergeant/.test(n))          return 'Sergeant';
  if (/constable/.test(n))         return 'Constable';
  return null;
}

// Does a tab NAME look like one of the four rank tabs? A sheet often carries
// extra tabs (notes, blacklist, a template) and those are not rank rosters.
function rankTabName(tab) { return tabForRank(tab); }

/**
 * Read every tab and every member row, with each row's problems attached.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.checkGroup=true] cross-check against the live MET
 *        Roblox group. Off makes the audit sheet-only and much faster.
 * @returns {Promise<object>} the full report
 */
async function auditMet(opts = {}) {
  // Which database. IA audits its own sheet from the IA dashboard; FLP High
  // Command audits the MET one from theirs. Same checks, different sheet.
  const division = (opts.division || 'MET').toString().toUpperCase();
  const cfg = quota.quotaConfig(division);
  const sheets = quota.getSheetsClient(cfg);
  // Name the setting. "Not configured" without saying WHICH variable is missing
  // is a dead end for whoever has to fix it.
  const sheetEnv = division === 'IA' ? 'QUOTA_SHEET_ID' : `${division}_SHEET_ID`;
  if (!sheets) {
    return { ok: false, error: `Google Sheets is not configured for ${division} `
      + `(set GOOGLE_SERVICE_ACCOUNT_JSON / ${division}_GOOGLE_SERVICE_ACCOUNT_JSON).` };
  }
  if (!cfg.sheetId) return { ok: false, error: `No ${division} sheet configured (set ${sheetEnv}).` };

  const report = {
    ok: true,
    division,
    sheetId: cfg.sheetId,
    target: quota.MET_TARGET(),
    tabs: [],
    members: [],
    issues: [],
    summary: {
      members: 0, rankTabs: 0,
      wrongTab: 0, notInGroup: 0, missingFromSheet: 0,
      blankDays: 0, junkDays: 0, missingDiscordId: 0, duplicates: 0,
      markers: 0, pointsToClear: 0,
    },
    missingFromSheet: [],
  };

  let tabs;
  try { tabs = await quota.resolveQuotaTabs(sheets, cfg); }
  catch (err) { return { ok: false, error: `Could not list the sheet's tabs: ${err.message}` }; }

  // ── Read every tab ──
  for (const tab of tabs) {
    let rows;
    try {
      const resp = await sheets.spreadsheets.values.get({
        spreadsheetId: cfg.sheetId, range: tab,
        valueRenderOption: 'FORMATTED_VALUE', majorDimension: 'ROWS',
      });
      rows = resp.data.values || [];
    } catch (e) {
      report.tabs.push({ tab, readable: false, error: e.message, members: 0 });
      continue;
    }

    const cols = quota.findColumns(rows);
    const isRankTab = !!rankTabName(tab);
    const entry = {
      tab, readable: true, isRankTab, rows: rows.length, members: 0,
      hasUsernameColumn: cols.username != null,
      hasDiscordColumn: cols.discordId != null,
      dayColumns: Object.keys(cols.days).length,
    };
    if (isRankTab) report.summary.rankTabs++;

    // A rank tab with no day columns is a structural problem of its own — every
    // member on it is uncountable, and silently reporting them as 0 points would
    // be worse than saying the tab is broken.
    if (isRankTab && entry.dayColumns < 7) {
      report.issues.push({ kind: 'TAB_MISSING_DAYS', tab,
        detail: `only ${entry.dayColumns} of 7 day columns found — points on this tab cannot be counted` });
    }

    if (cols.username != null) {
      for (let r = 0; r < rows.length; r++) {
        const uname = (rows[r][cols.username] || '').toString().trim();
        let rank = cols.rank != null ? (rows[r][cols.rank] || '').toString().trim() : '';
        if (!rank) rank = String(tab).trim();
        if (!uname || quota.NON_MEMBER.has(uname.toLowerCase())) continue;
        if (quota.NON_MEMBER.has(rank.toLowerCase())) continue;
        if (!quota.isMemberRow(uname, rank)) continue;

        const discordId = cols.discordId != null ? (rows[r][cols.discordId] || '').toString().trim() : '';
        const days = {}, problems = [];
        let total = 0, blanks = 0, junk = 0, markers = 0;
        for (let d = 0; d < 7; d++) {
          const col = cols.days[d];
          if (col == null) continue;
          const raw = (rows[r][col] || '').toString().trim();
          days[DAY_LABELS[d]] = raw;
          if (isMarker(raw)) { markers++; continue; }
          if (!raw) { blanks++; continue; }
          const num = parseFloat(raw);
          if (Number.isFinite(num)) total += num;
          else junk++;
        }

        if (blanks) problems.push({ kind: 'BLANK_DAYS', count: blanks });
        if (junk)   problems.push({ kind: 'JUNK_DAYS', count: junk });
        if (!discordId && cols.discordId != null) problems.push({ kind: 'MISSING_DISCORD_ID' });

        const m = {
          tab, rowIndex: r, row: r + 1, username: uname, discordId, rank,
          days, total, markers,
          expectedTab: isRankTab ? tab : null,
          groupRank: null, groupRankName: null,
          problems,
        };
        report.members.push(m);
        entry.members++;
        report.summary.members++;
        report.summary.blankDays += blanks;
        report.summary.junkDays  += junk;
        report.summary.markers   += markers;
        report.summary.pointsToClear += total;
        if (!discordId && cols.discordId != null) report.summary.missingDiscordId++;
      }
    }
    report.tabs.push(entry);
  }

  // ── Duplicates: the same person on more than one row, anywhere ──
  const byName = new Map();
  for (const m of report.members) {
    const key = quota.normName(m.username);
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(m);
  }
  for (const [, list] of byName) {
    if (list.length < 2) continue;
    report.summary.duplicates += list.length - 1;
    const where = list.map(m => `${m.tab} row ${m.row}`).join(', ');
    for (const m of list) m.problems.push({ kind: 'DUPLICATE', detail: where });
    report.issues.push({ kind: 'DUPLICATE', username: list[0].username, detail: where });
  }

  // ── Cross-check against the live group ──
  if (opts.checkGroup !== false) {
    let group = null;
    try { group = await require('./metDatabase').readGroupMembers(); }
    catch (err) { report.groupError = err.message; }

    if (group) {
      report.summary.groupSize = group.all.length;
      const onSheet = new Set(report.members.map(m => quota.normName(m.username)));

      for (const m of report.members) {
        const hit = group.byName.get(quota.normName(m.username));
        if (!hit) {
          m.problems.push({ kind: 'NOT_IN_GROUP' });
          report.summary.notInGroup++;
          continue;
        }
        m.groupRank = hit.roleRank != null ? Number(hit.roleRank) : null;
        m.groupRankName = hit.roleName || null;
        const should = tabForRank(hit.roleName);
        // Only a rank the database actually tracks can be on a wrong tab; a
        // Superintendent on a rank tab is a different problem (they have no MET
        // quota at all), and it is reported as its own kind.
        if (!should) {
          m.problems.push({ kind: 'RANK_NOT_TRACKED', detail: hit.roleName || 'unknown rank' });
        } else if (rankTabName(m.tab) && should !== rankTabName(m.tab)) {
          m.problems.push({ kind: 'WRONG_TAB', detail: `is ${hit.roleName} — belongs on "${should}"`, shouldBe: should });
          report.summary.wrongTab++;
        }
      }

      // In the group at a tracked rank, on no tab at all.
      for (const g of group.all) {
        const should = tabForRank(g.roleName);
        if (!should) continue;
        if (onSheet.has(quota.normName(g.username))) continue;
        report.missingFromSheet.push({ username: g.username, rank: g.roleName, shouldBe: should, userId: g.userId });
      }
      report.summary.missingFromSheet = report.missingFromSheet.length;
    }
  }

  report.summary.clean = report.members.filter(m => !m.problems.length).length;
  return report;
}

/**
 * Write the fixable half of the audit back to the sheet.
 *
 * Both flags are cell writes into the seven day columns. Nothing else on the
 * sheet is touched: no rows added, no rows deleted, no names, no Discord ids,
 * and never a cell holding EX or LOA.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.fillBlanks=true]  blank / junk day cells → 0
 * @param {boolean} [opts.reset=false]      EVERY day cell → 0
 * @param {boolean} [opts.dryRun=false]     work out the writes, send none
 * @returns {Promise<{ok, cellsWritten, cleared, filled, tabs, dryRun, error}>}
 */
async function normaliseMet(opts = {}) {
  const fillBlanks = opts.fillBlanks !== false;
  const reset = !!opts.reset;
  const dryRun = !!opts.dryRun;
  if (!fillBlanks && !reset) return { ok: false, error: 'Nothing to do — pass fillBlanks or reset.' };

  const division = (opts.division || 'MET').toString().toUpperCase();
  const cfg = quota.quotaConfig(division);
  const sheets = quota.getSheetsClient(cfg);
  // Name the setting. "Not configured" without saying WHICH variable is missing
  // is a dead end for whoever has to fix it.
  const sheetEnv = division === 'IA' ? 'QUOTA_SHEET_ID' : `${division}_SHEET_ID`;
  if (!sheets) {
    return { ok: false, error: `Google Sheets is not configured for ${division} `
      + `(set GOOGLE_SERVICE_ACCOUNT_JSON / ${division}_GOOGLE_SERVICE_ACCOUNT_JSON).` };
  }
  if (!cfg.sheetId) return { ok: false, error: `No ${division} sheet configured (set ${sheetEnv}).` };

  let tabs;
  try { tabs = await quota.resolveQuotaTabs(sheets, cfg); }
  catch (err) { return { ok: false, error: `Could not list the sheet's tabs: ${err.message}` }; }

  const data = [];
  const out = { ok: true, division, dryRun, cellsWritten: 0, filled: 0, cleared: 0, kept: 0, tabs: [] };

  for (const tab of tabs) {
    let rows;
    try {
      const resp = await sheets.spreadsheets.values.get({
        spreadsheetId: cfg.sheetId, range: tab,
        valueRenderOption: 'FORMATTED_VALUE', majorDimension: 'ROWS',
      });
      rows = resp.data.values || [];
    } catch (e) { out.tabs.push({ tab, skipped: e.message }); continue; }

    const cols = quota.findColumns(rows);
    const dayCols = Object.values(cols.days);
    if (cols.username == null || !dayCols.length) { out.tabs.push({ tab, skipped: 'no member/day columns' }); continue; }

    let filled = 0, cleared = 0, kept = 0;
    for (let r = 0; r < rows.length; r++) {
      const uname = (rows[r][cols.username] || '').toString().trim();
      let rank = cols.rank != null ? (rows[r][cols.rank] || '').toString().trim() : '';
      if (!rank) rank = String(tab).trim();
      if (!uname || quota.NON_MEMBER.has(uname.toLowerCase())) continue;
      if (quota.NON_MEMBER.has(rank.toLowerCase())) continue;
      if (!quota.isMemberRow(uname, rank)) continue;   // never write into a heading

      for (const c of dayCols) {
        const raw = (rows[r][c] || '').toString().trim();
        if (isMarker(raw)) { kept++; continue; }        // EX / LOA are deliberate
        const num = parseFloat(raw);
        const isNumber = Number.isFinite(num);

        let write = false;
        if (reset && (isNumber || raw)) write = true;   // wipe anything countable
        else if (!isNumber && fillBlanks) write = true; // blank or junk → 0
        if (!write) continue;

        // A cell that is already exactly 0 needs no write.
        if (isNumber && num === 0) continue;
        if (isNumber) cleared++; else filled++;
        data.push({ range: `${tab}!${quota.colLetter(c)}${r + 1}`, values: [[0]] });
      }
    }
    out.filled += filled; out.cleared += cleared; out.kept += kept;
    out.tabs.push({ tab, filled, cleared, kept });
  }

  out.cellsWritten = data.length;
  if (!data.length || dryRun) return out;

  try {
    // One batch. Thousands of individual updates would rate-limit long before
    // they finished, and a half-reset database is worse than an unreset one.
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: cfg.sheetId,
      requestBody: { valueInputOption: 'USER_ENTERED', data },
    });
  } catch (err) {
    return { ...out, ok: false, error: `The batch write failed: ${err.message}` };
  }
  return out;
}

/**
 * A short, readable summary of an audit — for a Discord embed or a log line.
 */
function summarise(report) {
  if (!report || !report.ok) return report && report.error ? report.error : 'Audit failed.';
  const s = report.summary;
  const lines = [
    `${s.members} members across ${s.rankTabs} rank tab${s.rankTabs === 1 ? '' : 's'} · ${s.clean} with nothing wrong`,
  ];
  if (s.wrongTab)         lines.push(`${s.wrongTab} on the wrong rank tab`);
  if (s.missingFromSheet) lines.push(`${s.missingFromSheet} in the group but on no tab`);
  if (s.notInGroup)       lines.push(`${s.notInGroup} on the sheet but not in the group`);
  if (s.duplicates)       lines.push(`${s.duplicates} duplicate row${s.duplicates === 1 ? '' : 's'}`);
  if (s.blankDays)        lines.push(`${s.blankDays} blank day cell${s.blankDays === 1 ? '' : 's'}`);
  if (s.junkDays)         lines.push(`${s.junkDays} day cell${s.junkDays === 1 ? '' : 's'} holding something that isn't a number`);
  if (s.missingDiscordId) lines.push(`${s.missingDiscordId} with no Discord ID`);
  if (s.markers)          lines.push(`${s.markers} EX/LOA cell${s.markers === 1 ? '' : 's'} (left alone)`);
  if (report.groupError)  lines.push(`Group cross-check unavailable: ${report.groupError}`);
  return lines.join('\n');
}

module.exports = { auditMet, normaliseMet, summarise, tabForRank, isMarker };
