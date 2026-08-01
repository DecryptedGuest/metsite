/**
 * IACMS Quota Webhook — Google Apps Script
 * =========================================
 * Adds quota points to the IA database sheet when a case (+4) is approved, and
 * keeps the member roster in sync with the MET Roblox group. Because this
 * script is bound to the sheet, it already has full edit access — no service
 * account, no API enabling, no sharing required.
 *
 * Supported actions (POST body):
 *   (none)   — add `points` to the matched member's cell for `day`
 *   reset    — zero everyone's weekly points
 *   exempt   — write a marker ("EX"/"LOA") across a member's week
 *   roster   — remove members who left the MET group, add newly joined ones
 *
 * NOTE: tickets no longer award points — the weekly quota is 2 cases (8 points).
 *
 * SETUP (one time):
 *   1. Open your quota Google Sheet.
 *   2. Extensions → Apps Script. Delete any code, paste this whole file.
 *   3. Change SECRET below to a long random string (keep a copy).
 *   4. (Optional) set SHEET_NAME to a specific tab, and TIMEZONE.
 *   5. Deploy → New deployment → type "Web app".
 *        - Execute as:  Me
 *        - Who has access:  Anyone
 *      Click Deploy, authorise, and COPY the Web app URL (ends in /exec).
 *   6. In Railway set two variables:
 *        QUOTA_WEBHOOK_URL    = the /exec URL
 *        QUOTA_WEBHOOK_SECRET = the same SECRET you set below
 *
 * The sheet must have a header row containing a USERNAME and/or DISCORD ID
 * column, plus columns headed by the days of the week (Mon, Tue, … or
 * Monday, Tuesday, …). Points are added to today's column for the matched row.
 */

var SECRET     = 'mnjgbuhgvujjjjjjjjjjjjjjhbvvvvvvyuvvubvbgvyfyg7y9y9y87y8';
var SHEET_NAME = 'Staff';               // '' = first/active tab, or set a tab name
var TIMEZONE   = 'Europe/London';  // timezone that defines "today"

var DAYS  = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
var DAYF  = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
var USERH = ['username', 'roblox username', 'roblox user', 'roblox', 'user'];
var DISCH = ['discord id', 'discordid', 'discord'];

function doPost(e) {
  // Serialise concurrent executions. Without this, two approvals that arrive at
  // almost the same moment each read the old cell value and write back
  // old+points, so one increment is lost. The lock forces them to run one at a
  // time; waitLock blocks (up to 30s) instead of failing fast.
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (lockErr) {
    return json({ ok: false, error: 'busy — could not acquire lock' });
  }
  try {
    return handlePost(e);
  } finally {
    SpreadsheetApp.flush();   // ensure the write is committed before releasing
    lock.releaseLock();
  }
}

function handlePost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.secret !== SECRET) return json({ ok: false, error: 'bad secret' });

    if (body.action === 'reset')  return resetAll();
    if (body.action === 'exempt') return setExempt((body.username || '').toString().trim(), (body.marker || 'EX').toString());
    if (body.action === 'roster') return syncRoster(body.remove || [], body.add || []);

    var points         = Number(body.points) || 0;
    var discordId      = (body.discordId || '').toString().trim();
    var robloxUsername = (body.robloxUsername || '').toString().trim().toLowerCase();
    // All username candidates worth trying (current RoVer name, display name,
    // stored name). The site sends these so renamed users still match.
    var cands = [];
    if (body.robloxCandidates && body.robloxCandidates.length) {
      for (var ci = 0; ci < body.robloxCandidates.length; ci++) {
        var cc = (body.robloxCandidates[ci] || '').toString().trim().toLowerCase();
        if (cc) cands.push(cc);
      }
    }
    if (robloxUsername && cands.indexOf(robloxUsername) < 0) cands.push(robloxUsername);
    if (!points) return json({ ok: false, error: 'no points' });

    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = SHEET_NAME ? ss.getSheetByName(SHEET_NAME) : ss.getSheets()[0];
    if (!sheet) return json({ ok: false, error: 'sheet not found' });

    // Use DISPLAY values: 18-19 digit Discord IDs stored as numbers lose
    // precision via getValues(), which breaks the Discord-ID match. Display
    // values are the exact text shown in the cell.
    var values = sheet.getDataRange().getDisplayValues();

    // Locate USERNAME / DISCORD ID / day columns from the header cells
    var userCol = -1, discCol = -1, dayCols = {};
    for (var r = 0; r < values.length; r++) {
      for (var c = 0; c < values[r].length; c++) {
        var v = (values[r][c] || '').toString().trim().toLowerCase();
        if (!v) continue;
        if (userCol < 0 && USERH.indexOf(v) >= 0) userCol = c;
        else if (discCol < 0 && DISCH.indexOf(v) >= 0) discCol = c;
        else {
          var di = DAYS.indexOf(v);
          if (di < 0) di = DAYF.indexOf(v);
          if (di < 0) for (var i = 0; i < DAYS.length; i++) if (v.indexOf(DAYS[i]) === 0) { di = i; break; }
          if (di >= 0 && dayCols[di] == null) dayCols[di] = c;
        }
      }
    }
    if (userCol < 0 && discCol < 0) return json({ ok: false, error: 'no username/discord column found' });

    // Find the member's row — by Discord ID first, then any username candidate
    // (exact match, then a normalised match that ignores case/spaces/_/punct).
    var row = -1;
    if (discordId && discCol >= 0) {
      var wantDigits = discordId.replace(/\D/g, '');
      for (var r2 = 0; r2 < values.length; r2++) {
        var cell = (values[r2][discCol] || '').toString().trim();
        if (cell === discordId || cell.replace(/\D/g, '') === wantDigits) { row = r2; break; }
      }
    }
    if (row < 0 && cands.length && userCol >= 0) {
      // exact (case-insensitive)
      for (var r3 = 0; r3 < values.length && row < 0; r3++) {
        var uc = (values[r3][userCol] || '').toString().trim().toLowerCase();
        if (uc && cands.indexOf(uc) >= 0) row = r3;
      }
      // normalised
      if (row < 0) {
        var normCands = cands.map(normName);
        for (var r4 = 0; r4 < values.length && row < 0; r4++) {
          var un = normName(values[r4][userCol]);
          if (un && normCands.indexOf(un) >= 0) row = r4;
        }
      }
    }
    if (row < 0) return json({ ok: false, error: 'member not found (discord ' + discordId + ', usernames [' + cands.join(', ') + '])' });

    // Today's column. Prefer the day the server sent (computed in QUOTA_TIMEZONE);
    // otherwise compute it here without relying on locale-specific date patterns.
    var dayIdx;
    if (body.day != null && body.day !== '') {
      var dv = body.day.toString().trim().toLowerCase();
      dayIdx = DAYS.indexOf(dv);
      if (dayIdx < 0) dayIdx = DAYF.indexOf(dv);
      if (dayIdx < 0) dayIdx = parseInt(dv, 10); // allow a numeric 0–6
    } else {
      var ymd = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd').split('-');
      dayIdx = new Date(Date.UTC(parseInt(ymd[0], 10), parseInt(ymd[1], 10) - 1, parseInt(ymd[2], 10))).getUTCDay();
    }
    if (isNaN(dayIdx) || dayIdx < 0 || dayIdx > 6) return json({ ok: false, error: 'bad day index: ' + body.day });
    var dayCol = dayCols[dayIdx];
    if (dayCol == null) return json({ ok: false, error: 'day column not found for ' + DAYS[dayIdx] });

    var cellRange = sheet.getRange(row + 1, dayCol + 1);
    var cur       = cellRange.getValue();
    if (cur !== '' && cur !== null && isNaN(Number(cur))) {
      return json({ ok: false, error: 'cell is non-numeric (' + cur + ') — left untouched' });
    }
    var newVal = (Number(cur) || 0) + points;
    cellRange.setValue(newVal);

    return json({ ok: true, row: row + 1, col: dayCol + 1, day: DAYS[dayIdx], added: points, newValue: newVal });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

// Reset EVERYONE's weekly points to 0. Clears numeric day cells for member
// rows only; leaves "EX" markers, headers and the TOTAL formula untouched.
function resetAll() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = SHEET_NAME ? ss.getSheetByName(SHEET_NAME) : ss.getSheets()[0];
  if (!sheet) return json({ ok: false, error: 'sheet not found' });

  var values = sheet.getDisplayValues();
  var userCol = -1, dayCols = {};
  for (var r = 0; r < values.length; r++) {
    for (var c = 0; c < values[r].length; c++) {
      var v = (values[r][c] || '').toString().trim().toLowerCase();
      if (!v) continue;
      if (userCol < 0 && USERH.indexOf(v) >= 0) userCol = c;
      else {
        var di = DAYS.indexOf(v);
        if (di < 0) di = DAYF.indexOf(v);
        if (di < 0) for (var i = 0; i < DAYS.length; i++) if (v.indexOf(DAYS[i]) === 0) { di = i; break; }
        if (di >= 0 && dayCols[di] == null) dayCols[di] = c;
      }
    }
  }
  var cols = [];
  for (var k in dayCols) cols.push(dayCols[k]);
  if (!cols.length) return json({ ok: false, error: 'no day columns found' });

  // Member rows = a real username that isn't a header keyword
  var memberRows = [];
  for (var r2 = 0; r2 < values.length; r2++) {
    var uname = userCol >= 0 ? (values[r2][userCol] || '').toString().trim() : '';
    if (!uname) continue;
    if (USERH.indexOf(uname.toLowerCase()) >= 0) continue;
    memberRows.push(r2);
  }

  var cleared = 0, nRows = values.length;
  for (var j = 0; j < cols.length; j++) {
    var col   = cols[j];
    var range = sheet.getRange(1, col + 1, nRows, 1);
    var vals  = range.getValues();
    for (var m = 0; m < memberRows.length; m++) {
      var rr  = memberRows[m];
      var cur = vals[rr][0];
      if (cur !== '' && cur !== null && isNaN(Number(cur))) continue; // leave "EX"
      vals[rr][0] = 0; cleared++;
    }
    range.setValues(vals);
  }
  return json({ ok: true, cleared: cleared });
}

// Mark one member exempt — write "EX" into every day cell of their row.
function setExempt(username, marker) {
  var target = (username || '').toLowerCase();
  var mark   = (marker || 'EX').toString();
  if (!target) return json({ ok: false, error: 'no username' });
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = SHEET_NAME ? ss.getSheetByName(SHEET_NAME) : ss.getSheets()[0];
  if (!sheet) return json({ ok: false, error: 'sheet not found' });
  var values = sheet.getDisplayValues();
  var userCol = -1, dayCols = {};
  for (var r = 0; r < values.length; r++) for (var c = 0; c < values[r].length; c++) {
    var v = (values[r][c] || '').toString().trim().toLowerCase();
    if (!v) continue;
    if (userCol < 0 && USERH.indexOf(v) >= 0) userCol = c;
    else { var di = DAYS.indexOf(v); if (di < 0) di = DAYF.indexOf(v); if (di < 0) for (var i = 0; i < DAYS.length; i++) if (v.indexOf(DAYS[i]) === 0) { di = i; break; } if (di >= 0 && dayCols[di] == null) dayCols[di] = c; }
  }
  if (userCol < 0) return json({ ok: false, error: 'no username column' });
  var row = -1;
  for (var r2 = 0; r2 < values.length; r2++) if ((values[r2][userCol] || '').toString().trim().toLowerCase() === target) { row = r2; break; }
  if (row < 0) return json({ ok: false, error: 'member not found' });
  for (var k in dayCols) sheet.getRange(row + 1, dayCols[k] + 1).setValue(mark);
  return json({ ok: true });
}

// ── MET database roster sync ──────────────────────────────────────
// remove: [{ username, discordId }] — members no longer in the MET group.
// add:    [{ username, rank, discordId }] — newly joined constables.
// Removed rows are cleared (username/discord/rank/day cells emptied) and the
// freed rows are reused for the new joiners, so the sheet's shape, formulas and
// section layout stay exactly as they are.
function syncRoster(remove, add) {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = SHEET_NAME ? ss.getSheetByName(SHEET_NAME) : ss.getSheets()[0];
  if (!sheet) return json({ ok: false, error: 'sheet not found' });

  var values  = sheet.getDataRange().getDisplayValues();
  var userCol = -1, discCol = -1, rankCol = -1, dayCols = {};
  var RANKH = ['rank', 'role'];
  for (var r = 0; r < values.length; r++) {
    for (var c = 0; c < values[r].length; c++) {
      var v = (values[r][c] || '').toString().trim().toLowerCase();
      if (!v) continue;
      if (userCol < 0 && USERH.indexOf(v) >= 0) userCol = c;
      else if (discCol < 0 && DISCH.indexOf(v) >= 0) discCol = c;
      else if (rankCol < 0 && RANKH.indexOf(v) >= 0) rankCol = c;
      else {
        var di = DAYS.indexOf(v);
        if (di < 0) di = DAYF.indexOf(v);
        if (di < 0) for (var i = 0; i < DAYS.length; i++) if (v.indexOf(DAYS[i]) === 0) { di = i; break; }
        if (di >= 0 && dayCols[di] == null) dayCols[di] = c;
      }
    }
  }
  if (userCol < 0) return json({ ok: false, error: 'no username column found' });

  // Locate the row for each member to remove (username first, then discord id).
  var freed = [], removed = 0;
  for (var i2 = 0; i2 < remove.length; i2++) {
    var want  = normName(remove[i2] && remove[i2].username);
    var wantD = ((remove[i2] && remove[i2].discordId) || '').toString().replace(/\D/g, '');
    var row = -1;
    for (var r2 = 0; r2 < values.length && row < 0; r2++) {
      var un = normName(values[r2][userCol]);
      if (un && want && un === want) row = r2;
      else if (wantD && discCol >= 0 && (values[r2][discCol] || '').toString().replace(/\D/g, '') === wantD) row = r2;
    }
    if (row < 0) continue;
    if (USERH.indexOf((values[row][userCol] || '').toString().trim().toLowerCase()) >= 0) continue; // never a header
    sheet.getRange(row + 1, userCol + 1).setValue('');
    if (discCol >= 0) sheet.getRange(row + 1, discCol + 1).setValue('');
    if (rankCol >= 0) sheet.getRange(row + 1, rankCol + 1).setValue('');
    for (var k in dayCols) sheet.getRange(row + 1, dayCols[k] + 1).setValue('');
    values[row][userCol] = '';
    freed.push(row);
    removed++;
  }

  // Write new joiners into the freed rows first, then append.
  var added = 0, appendAt = values.length;
  for (var i3 = 0; i3 < add.length; i3++) {
    var target = freed.length ? freed.shift() : appendAt++;
    var a = add[i3] || {};
    sheet.getRange(target + 1, userCol + 1).setValue(a.username || '');
    if (rankCol >= 0) sheet.getRange(target + 1, rankCol + 1).setValue(a.rank || '');
    if (discCol >= 0) sheet.getRange(target + 1, discCol + 1).setValue(a.discordId || '');
    for (var k2 in dayCols) sheet.getRange(target + 1, dayCols[k2] + 1).setValue(0);
    added++;
  }

  return json({ ok: true, removed: removed, added: added });
}

// Lets you sanity-check the deployment by visiting the /exec URL in a browser.
function doGet() { return json({ ok: true, service: 'IACMS quota webhook', ready: true }); }

// Normalise a username for tolerant matching: lowercase, keep only letters/digits.
function normName(s) { return (s || '').toString().toLowerCase().replace(/[^a-z0-9]/g, ''); }

function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
