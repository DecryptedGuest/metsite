/**
 * METAdministration quota webhook — Google Apps Script.
 *
 * Bound to the quota sheet, so it already has edit access: no service account,
 * no API enabling, no sharing required. This is the bot's PRIMARY write path.
 *
 * SETUP (once):
 *   1. Open the quota sheet → Extensions → Apps Script.
 *   2. Delete anything there and paste this whole file.
 *   3. Change SECRET below to a long random string; keep a copy.
 *   4. Optionally set SHEET_NAME to a specific tab, and TIMEZONE.
 *   5. Deploy → New deployment → Web app.
 *        Execute as:      Me
 *        Who has access:  Anyone
 *      Deploy, authorise, and copy the /exec URL.
 *   6. In the bot's .env:
 *        QUOTA_WEBHOOK_URL    = the /exec URL
 *        QUOTA_WEBHOOK_SECRET = the same SECRET
 *
 * The sheet needs a header row with a USERNAME and/or DISCORD ID column, plus
 * columns headed by weekdays (Mon/Tue/… or Monday/Tuesday/…).
 */

var SECRET     = 'CHANGE-ME-to-a-long-random-string';
var SHEET_NAME = '';                 // '' = first/active tab
var TIMEZONE   = 'Europe/London';    // defines "today"

var DAYS  = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
var DAYF  = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
var USERH = ['username', 'roblox username', 'roblox user', 'roblox', 'user'];
var DISCH = ['discord id', 'discordid', 'discord'];
var NON_MEMBER = ['username', 'roblox username', 'roblox user', 'roblox', 'user',
  'discord id', 'discordid', 'discord', 'rank', 'role', 'high command',
  'middle command', 'low command', 'staff information + quota', 'total',
  'warning', 'strikes', 'timezone', 'wtbt'];

function doPost(e) {
  // Without this lock two approvals arriving together each read the old cell
  // value and write back old+points — one increment vanishes silently.
  var lock = LockService.getScriptLock();
  try { lock.waitLock(30000); }
  catch (err) { return json({ ok: false, error: 'busy — could not acquire lock' }); }
  try { return handlePost(e); }
  finally { SpreadsheetApp.flush(); lock.releaseLock(); }
}

function handlePost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.secret !== SECRET) return json({ ok: false, error: 'bad secret' });

    if (body.action === 'reset')  return resetAll();
    if (body.action === 'exempt') return setMarker(String(body.username || '').trim(),
                                                   String(body.marker || 'EX'));
    return addPoints(body);
  } catch (err) {
    return json({ ok: false, error: err.message });
  }
}

function sheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return SHEET_NAME ? ss.getSheetByName(SHEET_NAME) : ss.getSheets()[0];
}

function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, ''); }

function dayIndexFromHeader(v) {
  var i;
  for (i = 0; i < DAYS.length; i++) if (v === DAYS[i] || v === DAYF[i]) return i;
  for (i = 0; i < DAYS.length; i++) if (v.indexOf(DAYS[i]) === 0) return i;
  return -1;
}

function findColumns(values) {
  var cols = { username: null, discordId: null, days: {} };
  for (var r = 0; r < values.length; r++) {
    for (var c = 0; c < values[r].length; c++) {
      var v = String(values[r][c] || '').trim().toLowerCase();
      if (!v) continue;
      if (cols.username == null && USERH.indexOf(v) >= 0) { cols.username = c; continue; }
      if (cols.discordId == null && DISCH.indexOf(v) >= 0) { cols.discordId = c; continue; }
      var di = dayIndexFromHeader(v);
      if (di >= 0 && cols.days[di] == null) cols.days[di] = c;
    }
  }
  return cols;
}

/** Discord id exact → digits-only → username exact → username normalised. */
function findRow(values, cols, discordId, username) {
  var did = String(discordId || '').trim();
  var r, cell;
  if (did && cols.discordId != null) {
    var wantDigits = did.replace(/\D/g, '');
    for (r = 0; r < values.length; r++) {
      cell = String(values[r][cols.discordId] || '').trim();
      if (cell === did || cell.replace(/\D/g, '') === wantDigits) return r;
    }
  }
  var uname = String(username || '').trim();
  if (uname && cols.username != null) {
    var lc = uname.toLowerCase();
    for (r = 0; r < values.length; r++) {
      cell = String(values[r][cols.username] || '').trim().toLowerCase();
      if (cell && cell === lc) return r;
    }
    var nm = norm(uname);
    for (r = 0; r < values.length; r++) {
      if (nm && norm(values[r][cols.username]) === nm) return r;
    }
  }
  return -1;
}

function todayIndex() {
  var wd = Utilities.formatDate(new Date(), TIMEZONE, 'EEE').toLowerCase().slice(0, 3);
  return DAYS.indexOf(wd);
}

function addPoints(body) {
  var sh = sheet();
  var values = sh.getDataRange().getValues();
  var cols = findColumns(values);
  var row = findRow(values, cols, body.discordId, body.username);
  if (row < 0) return json({ ok: false, error: 'member not found' });

  var di = todayIndex();
  var col = cols.days[di];
  if (col == null) return json({ ok: false, error: 'no column for today' });

  var current = parseFloat(String(values[row][col] || '').trim());
  if (!isFinite(current)) current = 0;              // treat EX / LOA / blank as 0
  var next = current + Number(body.points || 0);

  sh.getRange(row + 1, col + 1).setValue(next);
  return json({ ok: true, row: row + 1, day: DAYS[di], newValue: next });
}

function setMarker(username, marker) {
  if (!username) return json({ ok: false, error: 'No username.' });
  var sh = sheet();
  var values = sh.getDataRange().getValues();
  var cols = findColumns(values);
  if (cols.username == null) return json({ ok: false, error: 'No username column found.' });

  var lc = username.toLowerCase(), row = -1;
  for (var r = 0; r < values.length; r++) {
    if (String(values[r][cols.username] || '').trim().toLowerCase() === lc) { row = r; break; }
  }
  if (row < 0) return json({ ok: false, error: 'Member not found on the sheet.' });

  for (var d in cols.days) sh.getRange(row + 1, cols.days[d] + 1).setValue(marker);
  return json({ ok: true });
}

/** Clear numeric day cells only — EX/LOA markers and formulas survive. */
function resetAll() {
  var sh = sheet();
  var values = sh.getDataRange().getValues();
  var cols = findColumns(values);
  var cleared = 0;

  for (var r = 0; r < values.length; r++) {
    var uname = cols.username != null ? String(values[r][cols.username] || '').trim() : '';
    if (!uname || NON_MEMBER.indexOf(uname.toLowerCase()) >= 0) continue;
    for (var d in cols.days) {
      var c = cols.days[d];
      var raw = String(values[r][c] || '').trim();
      if (raw === '' || !isFinite(parseFloat(raw))) continue;
      sh.getRange(r + 1, c + 1).setValue('');
      cleared++;
    }
  }
  return json({ ok: true, cleared: cleared });
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
