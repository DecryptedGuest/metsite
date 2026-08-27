// Quota points ("XP") — the Google Sheet, the per-rank targets, and the durable
// award outbox.
//
// Awards are never written directly from an approval: they go into the
// QuotaAward table first and a worker drains it. A transient Sheets failure or
// a burst of approvals can therefore never lose a point, and the
// @@unique([refType, refId]) constraint makes re-approval a no-op.
let google = null;
try { google = require('googleapis').google; } catch { /* optional until configured */ }

const prisma  = require('./db');
const { env, envI } = require('./env');

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_FULL  = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MAX_ATTEMPTS = 40;

// Header/section labels that are never member rows.
const NON_MEMBER = new Set([
  'username', 'roblox username', 'roblox user', 'roblox', 'user',
  'discord id', 'discordid', 'discord', 'rank', 'role',
  'high command', 'middle command', 'low command',
  'staff information + quota', 'total', 'warning', 'strikes', 'timezone', 'wtbt',
]);

// ── helpers ───────────────────────────────────────────────────────
function dayIndexFromHeader(v) {
  const di = DAY_NAMES.indexOf(v); if (di >= 0) return di;
  const fi = DAY_FULL.indexOf(v);  if (fi >= 0) return fi;
  for (let i = 0; i < DAY_NAMES.length; i++) if (v.startsWith(DAY_NAMES[i])) return i;
  return -1;
}

/** Base-26 column letter — needed past column Z. */
function colLetter(idx) {
  let s = '', n = idx;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

function currentDayIndex(tz) {
  try {
    const wd = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: tz }).format(new Date());
    return DAY_NAMES.indexOf(wd.slice(0, 3).toLowerCase());
  } catch { return new Date().getDay(); }
}

/** Lowercase, strip anything not a-z0-9 — "Bruh_Lord", "bruh lord", "bruhlord" all match. */
function normName(s) { return (s || '').toString().toLowerCase().replace(/[^a-z0-9]/g, ''); }

function getSheetsClient() {
  if (!google) { console.warn('[quota] googleapis not installed'); return null; }
  const raw = env('GOOGLE_SERVICE_ACCOUNT_JSON');
  if (!raw) return null;
  let creds;
  try { creds = JSON.parse(raw); }
  catch { console.warn('[quota] GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON'); return null; }
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

/** Locate the username / discord id / rank / weekday columns by header text. */
function findColumns(rows) {
  const out = { username: null, discordId: null, rank: null, days: {} };
  const USER    = ['username', 'roblox username', 'roblox user', 'roblox', 'user'];
  const DISCORD = ['discord id', 'discordid', 'discord'];
  const RANK    = ['rank', 'role'];
  for (const row of rows) {
    for (let c = 0; c < row.length; c++) {
      const v = (row[c] || '').toString().trim().toLowerCase();
      if (!v) continue;
      if      (out.username  == null && USER.includes(v))    out.username  = c;
      else if (out.discordId == null && DISCORD.includes(v)) out.discordId = c;
      else if (out.rank      == null && RANK.includes(v))    out.rank      = c;
      else { const di = dayIndexFromHeader(v); if (di >= 0 && out.days[di] == null) out.days[di] = c; }
    }
  }
  return out;
}

/**
 * Find a member's row: Discord id exact → digits-only → username exact →
 * username normalised. Renames are common, so callers pass every candidate
 * name they have.
 */
function findMemberRow(rows, cols, discordId, robloxCandidates) {
  const did = (discordId || '').toString().trim();
  const cands = (Array.isArray(robloxCandidates) ? robloxCandidates : [robloxCandidates])
    .map(c => (c || '').toString().trim()).filter(Boolean);

  if (did && cols.discordId != null) {
    const wantDigits = did.replace(/\D/g, '');
    for (let r = 0; r < rows.length; r++) {
      const cell = (rows[r][cols.discordId] || '').toString().trim();
      if (cell === did || cell.replace(/\D/g, '') === wantDigits) return r;
    }
  }
  if (cands.length && cols.username != null) {
    const lowers = cands.map(c => c.toLowerCase());
    for (let r = 0; r < rows.length; r++) {
      const cell = (rows[r][cols.username] || '').toString().trim().toLowerCase();
      if (cell && lowers.includes(cell)) return r;
    }
    const norms = cands.map(normName).filter(Boolean);
    for (let r = 0; r < rows.length; r++) {
      const cell = normName(rows[r][cols.username]);
      if (cell && norms.includes(cell)) return r;
    }
  }
  return -1;
}

async function resolveSheetName(sheets, spreadsheetId) {
  const name = env('QUOTA_SHEET_NAME');
  if (name) return name;
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
  return meta.data.sheets?.[0]?.properties?.title || 'Sheet1';
}

// ── Weekly targets ────────────────────────────────────────────────
function quotaForRank(rank) {
  const r = (rank || '').toString().trim().toLowerCase();
  if (!r) return { exempt: false, target: null, tier: null };
  if (r === 'loa')                                return { exempt: true,  target: 0,  tier: 'LOA' };
  if (/director/.test(r))                         return { exempt: true,  target: 0,  tier: 'High Command' };
  if (/senior\s*investigator|supervisor/.test(r)) return { exempt: false, target: 20, tier: 'Middle Command' };
  if (/junior\s*investigator|probationary\s*investigator/.test(r))
                                                  return { exempt: false, target: 30, tier: 'Low Command' };
  return { exempt: false, target: null, tier: null };
}

const REDUCTION_GUILD_ID = () => env('QUOTA_REDUCTION_GUILD_ID') || env('DISCORD_GUILD_ID');
const REDUCTION_ROLE_ID  = () => env('QUOTA_REDUCTION_ROLE_ID');
const REDUCTION_AMOUNT   = () => envI('QUOTA_REDUCTION_AMOUNT', 10);

function applyQuotaReduction(quota) {
  const amt = REDUCTION_AMOUNT();
  if (!quota || quota.exempt || quota.target == null) return quota;
  return { ...quota, target: Math.max(0, quota.target - amt), reducedBy: amt };
}

function holdsReductionRole(holders, discordId) {
  if (!holders || !discordId) return false;
  return holders.has(String(discordId).replace(/\D/g, ''));
}

async function getReductionHolders(bot) {
  try { return await bot.getRoleHolders(REDUCTION_GUILD_ID(), REDUCTION_ROLE_ID()); }
  catch { return null; }
}

// ── Writes ────────────────────────────────────────────────────────
async function postToWebhook(payload) {
  const url = env('QUOTA_WEBHOOK_URL');
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      redirect: 'follow',   // Apps Script 302s to its execution host
      body: JSON.stringify({ secret: env('QUOTA_WEBHOOK_SECRET', ''), ...payload }),
    });
    return await res.json().catch(() => ({}));
  } catch (err) {
    console.warn('[quota] webhook error:', err.message);
    return null;
  }
}

// Serialise sheet writes: two concurrent read-modify-writes on one cell each
// read the old value and write back old+points, silently losing an increment.
let writeChain = Promise.resolve();
function serialise(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => {});
  return run;
}

async function addQuotaPointsImpl(member, points, label = '') {
  const viaWebhook = await postToWebhook({
    action: 'add',
    username:  member.robloxUsername || '',
    discordId: member.discordId || '',
    points,
  });
  if (viaWebhook?.ok) {
    console.log(`[quota] +${points} ${label} → row ${viaWebhook.row}, ${viaWebhook.day} = ${viaWebhook.newValue}`);
    return true;
  }

  const sheets = getSheetsClient();
  if (!sheets) return false;
  try {
    const spreadsheetId = env('QUOTA_SHEET_ID');
    if (!spreadsheetId) return false;
    const sheetName = await resolveSheetName(sheets, spreadsheetId);
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId, range: sheetName, valueRenderOption: 'FORMATTED_VALUE', majorDimension: 'ROWS',
    });
    const rows = resp.data.values || [];
    const cols = findColumns(rows);
    const rowIdx = findMemberRow(rows, cols, member.discordId, [member.robloxUsername]);
    if (rowIdx < 0) return false;

    const dayIdx = currentDayIndex(env('QUOTA_TIMEZONE', 'Europe/London'));
    const col = cols.days[dayIdx];
    if (col == null) return false;

    const a1   = `${sheetName}!${colLetter(col)}${rowIdx + 1}`;
    const base = parseFloat((rows[rowIdx][col] || '').toString().trim());
    const newVal = (Number.isFinite(base) ? base : 0) + points;

    await sheets.spreadsheets.values.update({
      spreadsheetId, range: a1, valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[newVal]] },
    });
    console.log(`[quota] +${points} ${label} → row ${rowIdx + 1}, ${DAY_LABELS[dayIdx]} = ${newVal}`);
    return true;
  } catch (err) {
    console.error('[quota] sheet write failed:', err.message);
    return false;
  }
}

const addQuotaPoints = (member, points, label) =>
  serialise(() => addQuotaPointsImpl(member, points, label));

// ── Reads ─────────────────────────────────────────────────────────
async function getMemberPoints(member, bot) {
  const sheets = getSheetsClient();
  if (!sheets) return null;
  try {
    const spreadsheetId = env('QUOTA_SHEET_ID');
    if (!spreadsheetId) return null;
    const sheetName = await resolveSheetName(sheets, spreadsheetId);
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId, range: sheetName, valueRenderOption: 'FORMATTED_VALUE', majorDimension: 'ROWS',
    });
    const rows = resp.data.values || [];
    const cols = findColumns(rows);
    const rowIdx = findMemberRow(rows, cols, member.discordId, [member.robloxUsername]);
    if (rowIdx < 0) return { found: false };

    const days = {};
    let total = 0;
    for (let d = 0; d < 7; d++) {
      const col = cols.days[d];
      const raw = col != null ? (rows[rowIdx][col] || '').toString().trim() : '';
      const num = parseFloat(raw);
      days[DAY_LABELS[d]] = raw && isNaN(num) ? raw : (Number.isFinite(num) ? num : 0);
      if (Number.isFinite(num)) total += num;
    }

    const rank = cols.rank != null ? (rows[rowIdx][cols.rank] || '').toString().trim() : '';
    let quota  = quotaForRank(rank);
    const did  = cols.discordId != null
      ? (rows[rowIdx][cols.discordId] || '').toString().trim()
      : (member.discordId || '');
    const holders = bot ? await getReductionHolders(bot) : null;
    if (holdsReductionRole(holders, did)) quota = applyQuotaReduction(quota);

    const remaining = quota.exempt || quota.target == null ? 0 : Math.max(0, quota.target - total);
    return { found: true, rank, quota, remaining, days, total };
  } catch (err) {
    console.error('[quota] read failed:', err.message);
    return null;
  }
}

async function getAllMembersPoints(bot) {
  const sheets = getSheetsClient();
  if (!sheets) return null;
  try {
    const spreadsheetId = env('QUOTA_SHEET_ID');
    if (!spreadsheetId) return null;
    const sheetName = await resolveSheetName(sheets, spreadsheetId);
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId, range: sheetName, valueRenderOption: 'FORMATTED_VALUE', majorDimension: 'ROWS',
    });
    const rows = resp.data.values || [];
    const cols = findColumns(rows);
    if (cols.username == null && cols.rank == null) return [];

    const holders = bot ? await getReductionHolders(bot) : null;
    const members = [];
    for (let r = 0; r < rows.length; r++) {
      const uname = cols.username  != null ? (rows[r][cols.username]  || '').toString().trim() : '';
      const rank  = cols.rank      != null ? (rows[r][cols.rank]      || '').toString().trim() : '';
      const did   = cols.discordId != null ? (rows[r][cols.discordId] || '').toString().trim() : '';
      if (!uname || NON_MEMBER.has(uname.toLowerCase())) continue;
      if (!rank  || NON_MEMBER.has(rank.toLowerCase()))  continue;

      let total = 0;
      const days = {};
      for (let d = 0; d < 7; d++) {
        const col = cols.days[d];
        const raw = col != null ? (rows[r][col] || '').toString().trim() : '';
        const num = parseFloat(raw);
        if (Number.isFinite(num)) total += num;
        days[DAY_LABELS[d]] = raw && isNaN(num) ? raw : (Number.isFinite(num) ? num : 0);
      }
      let quota = quotaForRank(rank);
      if (holdsReductionRole(holders, did)) quota = applyQuotaReduction(quota);
      members.push({
        username: uname, discordId: did || null, rank, quota, total, days,
        met: quota.exempt ? true : (quota.target != null ? total >= quota.target : null),
      });
    }
    return members;
  } catch (err) {
    console.error('[quota] getAllMembersPoints failed:', err.message);
    return null;
  }
}

// ── Markers (EX / LOA) and reset ──────────────────────────────────
async function setMemberMarker(username, marker) {
  const target = (username || '').trim();
  if (!target) return { ok: false, error: 'No username.' };
  const mark = (marker || 'EX').toString();

  const viaWebhook = await postToWebhook({ action: 'exempt', marker: mark, username: target });
  if (viaWebhook?.ok) return { ok: true };

  const sheets = getSheetsClient();
  if (!sheets) return { ok: false, error: 'Quota sheet is not configured.' };
  try {
    const spreadsheetId = env('QUOTA_SHEET_ID');
    if (!spreadsheetId) return { ok: false, error: 'Quota sheet is not configured.' };
    const sheetName = await resolveSheetName(sheets, spreadsheetId);
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId, range: sheetName, valueRenderOption: 'FORMATTED_VALUE', majorDimension: 'ROWS',
    });
    const rows = resp.data.values || [];
    const cols = findColumns(rows);
    if (cols.username == null) return { ok: false, error: 'No username column found.' };

    const lc = target.toLowerCase();
    let rowIdx = -1;
    for (let r = 0; r < rows.length; r++) {
      if ((rows[r][cols.username] || '').toString().trim().toLowerCase() === lc) { rowIdx = r; break; }
    }
    if (rowIdx < 0) return { ok: false, error: 'Member not found on the sheet.' };

    const data = Object.values(cols.days).map(c => ({
      range: `${sheetName}!${colLetter(c)}${rowIdx + 1}`, values: [[mark]],
    }));
    if (data.length) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId, requestBody: { valueInputOption: 'USER_ENTERED', data },
      });
    }
    return { ok: true };
  } catch (err) {
    console.error('[quota] setMemberMarker failed:', err.message);
    return { ok: false, error: err.message };
  }
}

const setMemberExempt = (u) => setMemberMarker(u, 'EX');
const setMemberLOA    = (u) => setMemberMarker(u, 'LOA');

/** Clear every numeric day cell for member rows. EX/LOA markers survive. */
async function resetAllQuota() {
  const viaWebhook = await postToWebhook({ action: 'reset' });
  if (viaWebhook?.ok) return { ok: true, cleared: viaWebhook.cleared };

  const sheets = getSheetsClient();
  if (!sheets) return { ok: false, error: 'Quota sheet is not configured.' };
  try {
    const spreadsheetId = env('QUOTA_SHEET_ID');
    if (!spreadsheetId) return { ok: false, error: 'Quota sheet is not configured.' };
    const sheetName = await resolveSheetName(sheets, spreadsheetId);
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId, range: sheetName, valueRenderOption: 'FORMATTED_VALUE', majorDimension: 'ROWS',
    });
    const rows = resp.data.values || [];
    const cols = findColumns(rows);
    const data = [];
    for (let r = 0; r < rows.length; r++) {
      const uname = cols.username != null ? (rows[r][cols.username] || '').toString().trim() : '';
      if (!uname || NON_MEMBER.has(uname.toLowerCase())) continue;
      for (const c of Object.values(cols.days)) {
        const raw = (rows[r][c] || '').toString().trim();
        if (raw === '' ) continue;
        if (isNaN(parseFloat(raw))) continue;   // leave EX / LOA alone
        data.push({ range: `${sheetName}!${colLetter(c)}${r + 1}`, values: [['']] });
      }
    }
    if (data.length) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId, requestBody: { valueInputOption: 'USER_ENTERED', data },
      });
    }
    return { ok: true, cleared: data.length };
  } catch (err) {
    console.error('[quota] reset failed:', err.message);
    return { ok: false, error: err.message };
  }
}

// ── Durable award outbox ──────────────────────────────────────────
let processing = false;
async function processQuotaAwards() {
  if (processing) return;
  processing = true;
  try {
    const due = await prisma.quotaAward.findMany({
      where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' }, take: 25,
    });
    for (const a of due) {
      let ok = false, err = null;
      try {
        ok = await addQuotaPoints(
          { discordId: a.discordId, robloxUsername: a.robloxUsername }, a.points, a.label || '');
      } catch (e) { ok = false; err = e.message; }

      if (ok) {
        await prisma.quotaAward.update({
          where: { id: a.id },
          data:  { status: 'DONE', attempts: { increment: 1 }, lastError: null },
        }).catch(() => {});
      } else {
        const attempts = a.attempts + 1;
        const status   = attempts >= MAX_ATTEMPTS ? 'FAILED' : 'PENDING';
        await prisma.quotaAward.update({
          where: { id: a.id },
          data:  { attempts, status, lastError: err || 'sheet write did not apply (no row matched?)' },
        }).catch(() => {});
        if (status === 'FAILED') {
          console.warn(`[quota] award ${a.label || a.id} FAILED after ${attempts} tries — discord=${a.discordId}, roblox=${a.robloxUsername}. Add the points manually.`);
        }
      }
    }
  } catch (e) {
    console.error('[quota] processQuotaAwards error:', e.message);
  } finally {
    processing = false;
  }
}

/** Record an award durably, then nudge the processor. Idempotent per ref. */
async function enqueueQuotaAward({ refType, refId, discordId, robloxUsername, points, label }) {
  try {
    await prisma.quotaAward.upsert({
      where:  { refType_refId: { refType, refId } },
      update: {},                     // already queued or applied — never duplicate
      create: {
        refType, refId,
        discordId: discordId || null,
        robloxUsername: robloxUsername || null,
        points, label: label || null,
      },
    });
  } catch (e) {
    console.error('[quota] enqueueQuotaAward error:', e.message);
  }
  setTimeout(() => { processQuotaAwards().catch(() => {}); }, 50);
}

function startQuotaWorker() {
  setInterval(() => { processQuotaAwards().catch(() => {}); }, 30 * 1000);
  setTimeout(()  => { processQuotaAwards().catch(() => {}); }, 8 * 1000);
}

module.exports = {
  quotaForRank, applyQuotaReduction, getMemberPoints, getAllMembersPoints,
  setMemberExempt, setMemberLOA, resetAllQuota,
  enqueueQuotaAward, processQuotaAwards, startQuotaWorker,
  REDUCTION_GUILD_ID, REDUCTION_ROLE_ID,
  findColumns, findMemberRow, colLetter, normName,   // exported for tests
};
