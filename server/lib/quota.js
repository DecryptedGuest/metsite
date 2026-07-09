// server/lib/quota.js
// Adds quota points to the Internal Affairs Database Google Sheet when a ticket
// log (+2) or case (+4) is approved. Matches the IA member's row by Discord ID
// or Roblox username and increments the column for the current day of the week.
//
// Required env:
//   GOOGLE_SERVICE_ACCOUNT_JSON  full service-account key JSON (one line)
//   QUOTA_SHEET_ID               spreadsheet id (default: the IA database)
//   QUOTA_SHEET_NAME             tab name (optional — defaults to the first tab)
//   QUOTA_TIMEZONE               IANA tz for "today" (default Europe/London)
//
// Fails soft: any problem is logged and never breaks the approval flow.

let google = null;
try { google = require('googleapis').google; } catch (e) { /* dependency optional */ }

const DEFAULT_SHEET_ID = '18BbP-zYFZlsMQsPuGT9zFQHgwEK4aqv_NtFXjPV8eM0';
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_FULL  = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// ── Division-aware config ─────────────────────────────────────────
// The same sheet engine now serves three divisions. IA uses the original,
// UNPREFIXED env names so its behaviour is byte-identical to before; FLP and
// MET use FLP_/MET_ prefixed vars. Everything a sheet-touching function needs
// (sheet id, tab, timezone, webhook, results webhook, rank→target resolver) is
// resolved through quotaConfig(division), which defaults to 'IA'.
const DIVISION_PREFIX = { IA: '', FLP: 'FLP_', MET: 'MET_', SCO19: 'SCO19_', CID: 'CID_' };

// Build a rank→{exempt,target,tier} resolver for FLP/MET from env:
//   <PREFIX>QUOTA_TARGETS = JSON array of { match:"<regex>", target:<int|null>,
//                           tier:"<label>", exempt:<bool> } — evaluated in order,
//                           first match (case-insensitive on the rank) wins.
//   <PREFIX>QUOTA_TARGET  = flat int fallback applied to all non-exempt ranks
//                           (tier label = <PREFIX>QUOTA_TIER or "Member").
// "loa" is always exempt; any "director" rank is exempt (universal defaults).
function envTargetsResolver(prefix) {
  return function (rank) {
    const r = (rank || '').toString().trim().toLowerCase();
    if (!r) return { exempt: false, target: null, tier: null };
    if (r === 'loa')        return { exempt: true, target: 0, tier: 'LOA' };
    if (/director/.test(r)) return { exempt: true, target: 0, tier: 'High Command' };
    const raw = process.env[`${prefix}QUOTA_TARGETS`];
    if (raw) {
      try {
        const rules = JSON.parse(raw);
        if (Array.isArray(rules)) {
          for (const rule of rules) {
            if (!rule || !rule.match) continue;
            let re; try { re = new RegExp(rule.match, 'i'); } catch (e) { continue; }
            if (re.test(r)) {
              if (rule.exempt) return { exempt: true, target: 0, tier: rule.tier || 'Exempt' };
              const t = rule.target != null ? parseInt(rule.target, 10) : null;
              return { exempt: false, target: Number.isFinite(t) ? t : null, tier: rule.tier || null };
            }
          }
        }
      } catch (e) { console.warn(`[quota] ${prefix}QUOTA_TARGETS is not valid JSON — ignoring.`); }
    }
    const flat = process.env[`${prefix}QUOTA_TARGET`];
    if (flat != null && flat !== '') {
      const t = parseInt(flat, 10);
      if (Number.isFinite(t)) return { exempt: false, target: t, tier: process.env[`${prefix}QUOTA_TIER`] || 'Member' };
    }
    return { exempt: false, target: null, tier: null };
  };
}

// Resolve the full per-division config. division ∈ {'IA','FLP','MET'} (default IA).
function quotaConfig(division) {
  const div = (division || 'IA').toString().toUpperCase();
  const prefix = DIVISION_PREFIX[div] != null ? DIVISION_PREFIX[div] : '';
  const tz = process.env[`${prefix}QUOTA_TIMEZONE`] || process.env.QUOTA_TIMEZONE || 'Europe/London';

  let sheetId;
  if (div === 'FLP')        sheetId = process.env.FLP_SHEET_ID || '';
  else if (div === 'MET')   sheetId = process.env.MET_SHEET_ID || '';
  else if (div === 'SCO19') sheetId = process.env.SCO19_SHEET_ID || '';
  else if (div === 'CID')   sheetId = process.env.CID_SHEET_ID || '';
  else                      sheetId = process.env.QUOTA_SHEET_ID || DEFAULT_SHEET_ID; // IA (+ fallback)

  const resultsWebhookUrl = div === 'IA'
    ? (process.env.QUOTA_RESULTS_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL || '')
    : (process.env[`${prefix}QUOTA_RESULTS_WEBHOOK_URL`] || '');

  return {
    division:          div,
    prefix,
    sheetId,
    sheetName:         process.env[`${prefix}QUOTA_SHEET_NAME`] || '',
    timezone:          tz,
    webhookUrl:        process.env[`${prefix}QUOTA_WEBHOOK_URL`] || '',
    webhookSecret:     process.env[`${prefix}QUOTA_WEBHOOK_SECRET`] || '',
    resultsWebhookUrl,
    targets:           div === 'IA' ? quotaForRank : envTargetsResolver(prefix),
  };
}

// Map a header cell to a day index (0=Sun). Accepts "mon", "monday", "mon." etc.
function dayIndexFromHeader(v) {
  const di = DAY_NAMES.indexOf(v); if (di >= 0) return di;
  const fi = DAY_FULL.indexOf(v);  if (fi >= 0) return fi;
  for (let i = 0; i < DAY_NAMES.length; i++) if (v.startsWith(DAY_NAMES[i])) return i;
  return -1;
}

function colLetter(idx) {
  let s = '';
  let n = idx;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

function currentDayIndex(tz) {
  try {
    const wd = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: tz }).format(new Date());
    return DAY_NAMES.indexOf(wd.slice(0, 3).toLowerCase());
  } catch (e) {
    return new Date().getDay();
  }
}

function getSheetsClient() {
  if (!google) { console.warn('[quota] googleapis not installed — run npm install.'); return null; }
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) { console.warn('[quota] GOOGLE_SERVICE_ACCOUNT_JSON not set — quota disabled.'); return null; }
  let creds;
  try { creds = JSON.parse(raw); } catch (e) { console.warn('[quota] GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON'); return null; }
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

// Locate USERNAME / DISCORD ID / day columns from the header rows
function findColumns(rows) {
  const out = { username: null, discordId: null, rank: null, days: {} };
  const USER_HEADERS    = ['username', 'roblox username', 'roblox user', 'roblox', 'user'];
  const DISCORD_HEADERS = ['discord id', 'discordid', 'discord'];
  const RANK_HEADERS    = ['rank', 'role'];
  for (const row of rows) {
    for (let c = 0; c < row.length; c++) {
      const v = (row[c] || '').toString().trim().toLowerCase();
      if (!v) continue;
      if      (out.username  == null && USER_HEADERS.includes(v))    out.username  = c;
      else if (out.discordId == null && DISCORD_HEADERS.includes(v)) out.discordId = c;
      else if (out.rank      == null && RANK_HEADERS.includes(v))    out.rank      = c;
      else { const di = dayIndexFromHeader(v); if (di >= 0 && out.days[di] == null) out.days[di] = c; }
    }
  }
  return out;
}

// Normalise a username for tolerant comparison: lowercase, drop anything that
// isn't a letter or digit. So "Bruh_Lord", "bruh lord" and "bruhlord" all match.
function normName(s) { return (s || '').toString().toLowerCase().replace(/[^a-z0-9]/g, ''); }

// Find the member's row — by Discord ID first, then any Roblox username
// candidate (exact, then normalised). `robloxCandidates` is a list because the
// RoVer-resolved current name and the stored name can differ; trying both (plus
// a normalised pass) is what makes matching reliable for renamed users.
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
    // Pass 1: exact (case-insensitive) match
    const lowers = cands.map(c => c.toLowerCase());
    for (let r = 0; r < rows.length; r++) {
      const cell = (rows[r][cols.username] || '').toString().trim().toLowerCase();
      if (cell && lowers.includes(cell)) return r;
    }
    // Pass 2: normalised match (ignores case, spaces, underscores, punctuation)
    const norms = cands.map(normName).filter(Boolean);
    for (let r = 0; r < rows.length; r++) {
      const cell = normName(rows[r][cols.username]);
      if (cell && norms.includes(cell)) return r;
    }
  }
  return -1;
}

/**
 * Add `points` to the IA member's current-day quota cell.
 * member = { discordId, robloxUsername }
 * Returns true if a cell was updated, false otherwise (logged).
 */
// Primary path: POST to a Google Apps Script Web App bound to the sheet.
// Configure with QUOTA_WEBHOOK_URL + QUOTA_WEBHOOK_SECRET (see scripts/quota-webhook.gs).
async function addQuotaViaWebhook(member, points, label, division = 'IA') {
  const cfg = quotaConfig(division);
  const url = cfg.webhookUrl;
  if (!url) return null; // webhook not configured → let caller fall back
  try {
    const fetch = require('node-fetch');
    const tz = cfg.timezone;
    const dayName = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: tz })
      .format(new Date()).slice(0, 3).toLowerCase(); // "mon", "tue", …
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      redirect: 'follow',
      body: JSON.stringify({
        secret:           cfg.webhookSecret,
        discordId:        member.discordId || null,
        robloxUsername:   member.robloxUsername || null,
        robloxCandidates: member.robloxCandidates || [],  // try-all list for renamed users
        points,
        day: dayName,  // server-computed — avoids Apps Script date-format quirks
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (data && data.ok) {
      console.log(`[quota] +${points} ${label} → row ${data.row}, ${data.day} = ${data.newValue}`);
      return true;
    }
    console.warn(`[quota] webhook did not apply for ${label}: ${data && data.error}`);
    return false;
  } catch (err) {
    console.error('[quota] webhook error:', err.message);
    return false;
  }
}

// Resolve the member's CURRENT, authoritative identity so points always land on
// the right person: the Roblox username is taken from the RoVer link of their
// Discord ID (overriding any stale cached username), and the Discord ID stays
// the primary match key.
async function resolveMember(member) {
  const stored = member.robloxUsername || null;
  const out = {
    discordId:      member.discordId || null,
    robloxUsername: stored,              // primary (kept for backward compat)
    robloxCandidates: [],                // all usernames worth trying
  };
  const candidates = [];
  if (stored) candidates.push(stored);

  if (out.discordId) {
    try {
      const { getRobloxIdFromDiscord, getRobloxUserInfo } = require('./roblox');
      const rId = await getRobloxIdFromDiscord(out.discordId);
      if (rId) {
        const info = await getRobloxUserInfo(rId);
        // Try the live RoVer username AND the display name — the sheet may use
        // either, and either can differ from the stored value after a rename.
        if (info && info.username)    { out.robloxUsername = info.username; candidates.unshift(info.username); }
        if (info && info.displayName) { candidates.push(info.displayName); }
      }
    } catch (e) { /* keep the stored username on failure */ }
  }

  // De-dupe (case-insensitive), preserve order
  const seen = new Set();
  out.robloxCandidates = candidates.filter(c => {
    const k = (c || '').toString().trim().toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k); return true;
  });
  return out;
}

// Serialise all point writes through a single promise chain. Rapid approvals
// otherwise fire overlapping read-modify-write cycles against the same sheet,
// and the later write clobbers the earlier one (lost update) — so some points
// silently vanish. Queuing guarantees each increment reads the value the
// previous one just wrote.
let _quotaChain = Promise.resolve();
function addQuotaPoints(rawMember, points, label = '', division = 'IA') {
  const run = () => addQuotaPointsImpl(rawMember, points, label, division);
  const result = _quotaChain.then(run, run); // run regardless of prior outcome
  _quotaChain = result.catch(() => {});       // a failure must not break the chain
  return result;
}

async function addQuotaPointsImpl(rawMember, points, label = '', division = 'IA') {
  const member = await resolveMember(rawMember);
  const viaWebhook = await addQuotaViaWebhook(member, points, label, division);
  if (viaWebhook !== null) return viaWebhook; // webhook configured (success or fail)

  try {
    const sheets = getSheetsClient();
    if (!sheets) return false; // not configured — silent no-op

    const cfg = quotaConfig(division);
    const spreadsheetId = cfg.sheetId;
    const tz   = cfg.timezone;

    // Resolve the sheet/tab name
    let sheetName = cfg.sheetName;
    if (!sheetName) {
      const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
      sheetName = meta.data.sheets?.[0]?.properties?.title || 'Sheet1';
    }

    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: sheetName,
      valueRenderOption: 'FORMATTED_VALUE',
      majorDimension: 'ROWS',
    });
    const rows = resp.data.values || [];

    const cols = findColumns(rows);
    if (cols.username == null && cols.discordId == null) {
      console.warn('[quota] could not locate USERNAME / DISCORD ID columns'); return false;
    }

    const rowIdx = findMemberRow(rows, cols, member.discordId, member.robloxCandidates);
    if (rowIdx < 0) {
      console.warn(`[quota] no row matched for ${label} — discord=${member.discordId}, tried usernames=[${(member.robloxCandidates || []).join(', ')}] (discordCol=${cols.discordId != null}, userCol=${cols.username != null})`);
      return false;
    }

    const dayIdx = currentDayIndex(tz);
    const dayCol = cols.days[dayIdx];
    if (dayCol == null) { console.warn('[quota] day column not found for today'); return false; }

    const cellRaw = (rows[rowIdx][dayCol] || '').toString().trim();
    if (cellRaw && isNaN(parseFloat(cellRaw))) {
      console.warn(`[quota] cell "${cellRaw}" is non-numeric (e.g. EX) — leaving it untouched for ${label}`);
      return false;
    }
    const base   = cellRaw ? parseFloat(cellRaw) : 0;
    const newVal = (Number.isFinite(base) ? base : 0) + points;

    const a1 = `${sheetName}!${colLetter(dayCol)}${rowIdx + 1}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: a1,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[newVal]] },
    });

    console.log(`[quota] +${points} → ${a1} (now ${newVal}) for ${label || member.discordId || member.robloxUsername}`);
    return true;
  } catch (err) {
    console.error('[quota] update failed:', err.message);
    return false;
  }
}

// Weekly quota target based on the member's rank (from the sheet).
//   LOA (Leave of Absence)                                 → exempt
//   High Command (Director / Deputy Director)              → exempt (EX)
//   Middle Command (Senior Investigator / Supervisor)      → 20
//   Low Command (Junior / Probationary Investigator)       → 30
function quotaForRank(rank) {
  const r = (rank || '').toString().trim().toLowerCase();
  if (!r) return { exempt: false, target: null, tier: null };
  if (r === 'loa')                                          return { exempt: true,  target: 0,  tier: 'LOA' };
  if (/director/.test(r))                                  return { exempt: true,  target: 0,  tier: 'High Command' };
  if (/senior\s*investigator|supervisor/.test(r))          return { exempt: false, target: 20, tier: 'Middle Command' };
  if (/junior\s*investigator|probationary\s*investigator/.test(r)) return { exempt: false, target: 30, tier: 'Low Command' };
  return { exempt: false, target: null, tier: null }; // unknown rank
}

// A Discord role that reduces a member's weekly quota target while they hold it.
const REDUCTION_GUILD_ID = () => process.env.QUOTA_REDUCTION_GUILD_ID || '1424498408009240649';
const REDUCTION_ROLE_ID  = () => process.env.QUOTA_REDUCTION_ROLE_ID  || '1446930394699010168';
const REDUCTION_AMOUNT   = () => parseInt(process.env.QUOTA_REDUCTION_AMOUNT || '10', 10) || 10;

// Fetch the set of Discord IDs (digit-only) currently holding the reduction role.
async function getReductionHolders() {
  try {
    const { getRoleHolders } = require('./bot');
    return await getRoleHolders(REDUCTION_GUILD_ID(), REDUCTION_ROLE_ID());
  } catch (e) { return null; }
}

// Reduce a quota target by the configured amount (floors at 0). Marks the
// returned object so the UI can show the reduction.
function applyQuotaReduction(quota) {
  const amt = REDUCTION_AMOUNT();
  if (!quota || quota.exempt || quota.target == null) return quota;
  return { ...quota, target: Math.max(0, quota.target - amt), reducedBy: amt };
}

// Does this sheet Discord ID hold the reduction role? (digit-tolerant)
function holdsReductionRole(holders, discordId) {
  if (!holders || !discordId) return false;
  return holders.has(String(discordId).replace(/\D/g, ''));
}

// Set the Investigator of the Week: gives `discordId` the reduction/IOTW role
// and removes it from the previous holder. Pass falsy to clear it from everyone.
async function setInvestigatorOfWeek(discordId) {
  try {
    const { setExclusiveRoleHolder } = require('./bot');
    return await setExclusiveRoleHolder(REDUCTION_GUILD_ID(), REDUCTION_ROLE_ID(), discordId || null);
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Read an IA member's quota row from the sheet.
 * Returns { found, rank, quota:{exempt,target,tier}, remaining, days, total }
 * or { found:false }. Requires the Google service account (read path).
 */
async function getMemberPoints(member, division = 'IA') {
  try {
    const sheets = getSheetsClient();
    if (!sheets) return null;

    const cfg = quotaConfig(division);
    const spreadsheetId = cfg.sheetId;
    let sheetName = cfg.sheetName;
    if (!sheetName) {
      const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
      sheetName = meta.data.sheets?.[0]?.properties?.title || 'Sheet1';
    }

    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId, range: sheetName, valueRenderOption: 'FORMATTED_VALUE', majorDimension: 'ROWS',
    });
    const rows = resp.data.values || [];
    const cols = findColumns(rows);
    const rowIdx = findMemberRow(rows, cols, member.discordId, member.robloxUsername);
    if (rowIdx < 0) return { found: false };

    const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const days = {};
    let total = 0;
    for (let d = 0; d < 7; d++) {
      const col = cols.days[d];
      const raw = col != null ? (rows[rowIdx][col] || '').toString().trim() : '';
      const num = parseFloat(raw);
      const val = Number.isFinite(num) ? num : 0;
      days[labels[d]] = raw && isNaN(num) ? raw : val; // keep "EX" etc. as-is
      if (Number.isFinite(num)) total += num;
    }

    const rank  = cols.rank != null ? (rows[rowIdx][cols.rank] || '').toString().trim() : '';
    let quota = cfg.targets(rank);
    // Apply the quota-reduction role if this member holds it (IA only — the
    // Investigator-of-the-Week reduction is an IA feature).
    if (cfg.division === 'IA') {
      const did = cols.discordId != null ? (rows[rowIdx][cols.discordId] || '').toString().trim() : (member.discordId || '');
      const holders = await getReductionHolders();
      if (holdsReductionRole(holders, did)) quota = applyQuotaReduction(quota);
    }
    const remaining = quota.exempt || quota.target == null
      ? 0
      : Math.max(0, quota.target - total);

    return { found: true, rank, quota, remaining, days, total };
  } catch (err) {
    console.error('[quota] read failed:', err.message);
    return null;
  }
}

// Header / section labels that are never member rows.
const NON_MEMBER = new Set([
  'username', 'roblox username', 'roblox user', 'roblox', 'user',
  'discord id', 'discordid', 'discord', 'rank', 'role',
  'high command', 'middle command', 'low command',
  'staff information + quota', 'total', 'warning', 'strikes', 'timezone', 'wtbt',
]);

/**
 * Read EVERY IA member's quota row from the sheet (for the HICOMM Quota Check).
 * Returns an array of { username, discordId, rank, quota, total, days, met }
 * or null if the read path (service account) isn't configured.
 */
async function getAllMembersPoints(division = 'IA') {
  try {
    const sheets = getSheetsClient();
    if (!sheets) return null;

    const cfg = quotaConfig(division);
    const spreadsheetId = cfg.sheetId;
    let sheetName = cfg.sheetName;
    if (!sheetName) {
      const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
      sheetName = meta.data.sheets?.[0]?.properties?.title || 'Sheet1';
    }

    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId, range: sheetName, valueRenderOption: 'FORMATTED_VALUE', majorDimension: 'ROWS',
    });
    const rows = resp.data.values || [];
    const cols = findColumns(rows);
    if (cols.username == null && cols.rank == null) return [];

    // Quota-reduction role is IA-only (Investigator of the Week).
    const reductionHolders = cfg.division === 'IA' ? await getReductionHolders() : null; // null if unavailable

    const labels  = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const members = [];
    for (let r = 0; r < rows.length; r++) {
      const uname = cols.username  != null ? (rows[r][cols.username]  || '').toString().trim() : '';
      const rank  = cols.rank      != null ? (rows[r][cols.rank]      || '').toString().trim() : '';
      const did   = cols.discordId != null ? (rows[r][cols.discordId] || '').toString().trim() : '';
      if (!uname || NON_MEMBER.has(uname.toLowerCase())) continue;
      if (!rank  || NON_MEMBER.has(rank.toLowerCase()))   continue; // member rows carry a rank

      let total = 0;
      const days = {};
      for (let d = 0; d < 7; d++) {
        const col = cols.days[d];
        const raw = col != null ? (rows[r][col] || '').toString().trim() : '';
        const num = parseFloat(raw);
        if (Number.isFinite(num)) total += num;
        days[labels[d]] = raw && isNaN(num) ? raw : (Number.isFinite(num) ? num : 0);
      }
      let quota = cfg.targets(rank);
      if (cfg.division === 'IA' && holdsReductionRole(reductionHolders, did)) quota = applyQuotaReduction(quota);
      members.push({
        username: uname,
        discordId: did || null,
        rank,
        quota,
        total,
        days,
        met: quota.exempt ? true : (quota.target != null ? total >= quota.target : null),
      });
    }
    return members;
  } catch (err) {
    console.error('[quota] getAllMembersPoints failed:', err.message);
    return null;
  }
}

/**
 * Reset EVERYONE's weekly quota points to 0 on the sheet.
 * Clears every numeric day cell (Sun–Sat) for member rows; leaves exemption
 * markers like "EX" and the (formula) TOTAL column untouched.
 * Returns { ok, cleared } or { ok:false, error }.
 */
async function resetAllQuota(division = 'IA') {
  const cfg = quotaConfig(division);
  // 1) Webhook first (the path that actually works for points). Falls back to
  //    the service account only if the webhook isn't configured / errors.
  const url = cfg.webhookUrl;
  if (url) {
    try {
      const fetch = require('node-fetch');
      const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'follow',
        body: JSON.stringify({ secret: cfg.webhookSecret, action: 'reset' }),
      });
      const d = await res.json().catch(() => ({}));
      if (d && d.ok) return { ok: true, cleared: d.cleared };
      console.warn('[quota] webhook reset failed:', d && d.error);
      // fall through to service account
    } catch (err) {
      console.warn('[quota] webhook reset error:', err.message);
    }
  }

  // 2) Service-account fallback
  const sheets = getSheetsClient();
  if (sheets) {
    try {
      const spreadsheetId = cfg.sheetId;
      let sheetName = cfg.sheetName;
      if (!sheetName) {
        const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
        sheetName = meta.data.sheets?.[0]?.properties?.title || 'Sheet1';
      }
      const resp = await sheets.spreadsheets.values.get({
        spreadsheetId, range: sheetName, valueRenderOption: 'FORMATTED_VALUE', majorDimension: 'ROWS',
      });
      const rows = resp.data.values || [];
      const cols = findColumns(rows);
      const dayCols = Object.values(cols.days);
      if (!dayCols.length) return { ok: false, error: 'Could not locate the day columns on the sheet.' };

      const data = [];
      for (let r = 0; r < rows.length; r++) {
        const uname = cols.username != null ? (rows[r][cols.username] || '').toString().trim() : '';
        const rank  = cols.rank     != null ? (rows[r][cols.rank]     || '').toString().trim() : '';
        if (!uname || NON_MEMBER.has(uname.toLowerCase())) continue;          // skip headers / blanks
        if (cols.rank != null && (!rank || NON_MEMBER.has(rank.toLowerCase()))) continue; // member rows carry a rank
        for (const c of dayCols) {
          const raw = (rows[r][c] || '').toString().trim();
          if (raw && isNaN(parseFloat(raw))) continue; // leave "EX" etc.
          data.push({ range: `${sheetName}!${colLetter(c)}${r + 1}`, values: [[0]] });
        }
      }
      if (data.length) {
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId, requestBody: { valueInputOption: 'USER_ENTERED', data },
        });
      }
      return { ok: true, cleared: data.length };
    } catch (err) {
      console.error('[quota] reset (sheets) failed:', err.message);
      return { ok: false, error: err.message };
    }
  }

  return { ok: false, error: 'Quota sheet is not configured (no webhook or service account).' };
}

/**
 * Mark a single member EXEMPT by writing "EX" into all their day cells.
 * Returns { ok } or { ok:false, error }.
 */
// Write a marker (e.g. "EX" for exempt, "LOA" for leave of absence) into a
// member's day cells. Tries the webhook FIRST (the same path quota points use,
// which is the configured/working one) and falls back to the service account —
// previously it was the other way round, which 502'd when only the webhook was
// set up.
async function setMemberMarker(username, marker, division = 'IA') {
  const target = (username || '').trim();
  if (!target) return { ok: false, error: 'No username.' };
  const mark = (marker || 'EX').toString();
  const cfg = quotaConfig(division);

  // 1) Webhook (Apps Script)
  const url = cfg.webhookUrl;
  if (url) {
    try {
      const fetch = require('node-fetch');
      const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'follow',
        body: JSON.stringify({ secret: cfg.webhookSecret, action: 'exempt', marker: mark, username: target }),
      });
      const d = await res.json().catch(() => ({}));
      if (d && d.ok) return { ok: true };
      console.warn(`[quota] webhook mark "${mark}" failed for ${target}:`, d && d.error);
      // fall through to service account
    } catch (err) {
      console.warn('[quota] webhook mark error:', err.message);
    }
  }

  // 2) Service-account fallback
  const sheets = getSheetsClient();
  if (sheets) {
    try {
      const spreadsheetId = cfg.sheetId;
      let sheetName = cfg.sheetName;
      if (!sheetName) {
        const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
        sheetName = meta.data.sheets?.[0]?.properties?.title || 'Sheet1';
      }
      const resp = await sheets.spreadsheets.values.get({
        spreadsheetId, range: sheetName, valueRenderOption: 'FORMATTED_VALUE', majorDimension: 'ROWS',
      });
      const rows = resp.data.values || [];
      const cols = findColumns(rows);
      if (cols.username == null) return { ok: false, error: 'No username column found.' };
      const lc = target.toLowerCase();
      let rowIdx = -1;
      for (let r = 0; r < rows.length; r++) {
        if (((rows[r][cols.username] || '').toString().trim().toLowerCase()) === lc) { rowIdx = r; break; }
      }
      if (rowIdx < 0) return { ok: false, error: 'Member not found on the sheet.' };
      const data = Object.values(cols.days).map(c => ({ range: `${sheetName}!${colLetter(c)}${rowIdx + 1}`, values: [[mark]] }));
      if (data.length) await sheets.spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: 'USER_ENTERED', data } });
      return { ok: true };
    } catch (err) {
      console.error('[quota] setMemberMarker failed:', err.message);
      return { ok: false, error: err.message };
    }
  }

  return { ok: false, error: 'Quota sheet is not configured.' };
}

function setMemberExempt(username, division = 'IA') { return setMemberMarker(username, 'EX', division); }
function setMemberLOA(username, division = 'IA')    { return setMemberMarker(username, 'LOA', division); }

// ── Durable award outbox ──────────────────────────────────────────
// Every approved case/ticket records an award row; a worker retries it until
// the sheet write succeeds, so points are never lost to a transient failure
// (RoVer rate-limit during a spam burst, network blip, webhook hiccup, etc.).
const prisma = require('./db');
const MAX_ATTEMPTS = 40; // ~ up to several minutes of retries before giving up

let _processing = false;
async function processQuotaAwards() {
  if (_processing) return;
  _processing = true;
  try {
    const due = await prisma.quotaAward.findMany({
      where:   { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take:    25,
    });
    for (const a of due) {
      let ok = false, err = null;
      try {
        ok = await addQuotaPointsImpl(
          { discordId: a.discordId, robloxUsername: a.robloxUsername },
          a.points, a.label || '', a.division || 'IA',
        );
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
        if (status === 'FAILED')
          console.warn(`[quota] award ${a.label || a.id} FAILED after ${attempts} tries — discord=${a.discordId}, roblox=${a.robloxUsername}. Add the points manually.`);
      }
    }
  } catch (e) {
    console.error('[quota] processQuotaAwards error:', e.message);
  } finally {
    _processing = false;
  }
}

// Record an award durably, then kick the processor. Idempotent per ref so a
// re-approve (or retry) never double-awards.
async function enqueueQuotaAward({ refType, refId, discordId, robloxUsername, points, label, division }) {
  try {
    await prisma.quotaAward.upsert({
      where:  { refType_refId: { refType, refId } },
      update: {}, // already queued/applied — never duplicate
      create: {
        refType, refId,
        discordId:      discordId || null,
        robloxUsername: robloxUsername || null,
        points, label: label || null,
        division:       division || 'IA',
      },
    });
  } catch (e) {
    console.error('[quota] enqueueQuotaAward error:', e.message);
  }
  setTimeout(() => { processQuotaAwards().catch(() => {}); }, 50);
}

function startQuotaWorker() {
  setInterval(() => { processQuotaAwards().catch(() => {}); }, 30 * 1000);
  setTimeout(() => { processQuotaAwards().catch(() => {}); }, 8 * 1000); // catch up after boot
}

module.exports = {
  addQuotaPoints, getMemberPoints, getAllMembersPoints, resetAllQuota, setMemberExempt, setMemberLOA,
  enqueueQuotaAward, processQuotaAwards, startQuotaWorker,
  setInvestigatorOfWeek,
  // Low-level sheet helpers reused by other point systems (e.g. HPC tryouts).
  getSheetsClient, findColumns, findMemberRow, currentDayIndex, colLetter,
  // Division-aware config resolver (IA | FLP | MET).
  quotaConfig, quotaForRank,
};
