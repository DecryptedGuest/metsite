// server/lib/quota.js
// Adds quota points to the Internal Affairs Database Google Sheet when a case
// (+4) or a ticket log (+2) is approved. Matches the IA member's row by Discord
// ID or Roblox username and increments the column for the current day of the
// week.
//
// The weekly target is per rank — 30 for Low Command, 20 for Middle Command,
// exempt for High Command and LOA (see quotaForRank).
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
const DIVISION_PREFIX = { IA: '', FLP: 'FLP_', MET: 'MET_', SCO19: 'SCO19_', CID: 'CID_', HPC: 'HPC_' };

// Build a rank→{exempt,target,tier} resolver for FLP/MET from env:
//   <PREFIX>QUOTA_TARGETS = JSON array of { match:"<regex>", target:<int|null>,
//                           tier:"<label>", exempt:<bool> } — evaluated in order,
//                           first match (case-insensitive on the rank) wins.
//   <PREFIX>QUOTA_TARGET  = flat int fallback applied to all non-exempt ranks
//                           (tier label = <PREFIX>QUOTA_TIER or "Member").
// "loa" is always exempt; any "director" rank is exempt (universal defaults).
function envTargetsResolver(prefix, builtin) {
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
    // Built-in default for the division (used when nothing is configured in env).
    if (builtin) return builtin(rank);
    return { exempt: false, target: null, tier: null };
  };
}

// Built-in CID weekly quota (env <CID_QUOTA_TARGETS> still overrides):
//   Detective Constable / Sergeant → 8   ·   Detective Inspector / Chief
//   Inspector / Superintendent → 7   ·   Instructor Unit + Database Managers +
//   any Director rank → exempt.
function cidQuotaForRank(rank) {
  const r = (rank || '').toString().trim().toLowerCase();
  if (!r) return { exempt: false, target: null, tier: null };
  if (r === 'loa')                        return { exempt: true, target: 0, tier: 'LOA' };
  if (/director/.test(r))                 return { exempt: true, target: 0, tier: 'High Command' };
  if (/instructor|database/.test(r))      return { exempt: true, target: 0, tier: 'Exempt' };
  if (/superintendent/.test(r))           return { exempt: false, target: 7, tier: 'Command' };
  if (/inspector/.test(r))                return { exempt: false, target: 7, tier: 'Senior' }; // Chief Inspector + Inspector
  if (/sergeant/.test(r))                 return { exempt: false, target: 8, tier: 'Junior' };
  if (/constable/.test(r))                return { exempt: false, target: 8, tier: 'Junior' };
  return { exempt: false, target: null, tier: null };
}
// Built-in SCO-19 weekly quota (env <SCO19_QUOTA_TARGETS> still overrides):
//   Overseer / Commander / Deputy Commander / Assistant Commander → exempt.
//   Middle Ranks (Firearms Chief Inspector … Unit Commander) → patrol 1h30m +
//     host 5+ events  (target 5).
//   Low Ranks (Firearms Constable … Firearms Inspector) → patrol 2h30m as SCO +
//     attend 3+ events  (target 3).
// "Unit Commander" is a MIDDLE rank, so it must be matched before the exempt
// "Commander" ranks; "Chief Inspector" (middle) before the bare "Inspector" (low).
function sco19QuotaForRank(rank) {
  const r = (rank || '').toString().trim().toLowerCase();
  if (!r) return { exempt: false, target: null, tier: null };
  if (r === 'loa')                 return { exempt: true,  target: 0, tier: 'LOA' };
  if (/overseer/.test(r))          return { exempt: true,  target: 0, tier: 'High Command' };
  if (/unit\s*commander/.test(r))  return { exempt: false, target: 5, tier: 'Middle Ranks' }; // middle (before Commander)
  if (/commander/.test(r))         return { exempt: true,  target: 0, tier: 'High Command' };  // Commander/Deputy/Assistant
  if (/chief\s*inspector/.test(r)) return { exempt: false, target: 5, tier: 'Middle Ranks' };
  if (/superintendent/.test(r))    return { exempt: false, target: 5, tier: 'Middle Ranks' };
  if (/inspector/.test(r))         return { exempt: false, target: 3, tier: 'Low Ranks' };     // Firearms Inspector
  if (/sergeant/.test(r))          return { exempt: false, target: 3, tier: 'Low Ranks' };
  if (/constable/.test(r))         return { exempt: false, target: 3, tier: 'Low Ranks' };
  return { exempt: false, target: null, tier: null };
}

// Built-in MET weekly quota (env <MET_QUOTA_TARGETS> still overrides):
//   Constable / Sergeant / Inspector / Chief Inspector → 3 events a week, and
//   one point on the MET database is one event — so the target is 3 points.
//   That holds whether or not they are in a division: a division adds a quota,
//   it does not replace the MET one. Only a bought Quota Exempt lifts it.
//
//   Community Support Officers are still in training and are not on the list;
//   everyone above Chief Inspector (Superintendent upwards) has no MET quota of
//   their own. Both are exempt rather than "unknown" so the site says plainly
//   that there is nothing to meet instead of showing a blank target.
//
// "Chief Superintendent" must be matched before the bare "Chief Inspector"
// test would otherwise be reached, and "Chief Inspector" before "Inspector".
function metQuotaForRank(rank) {
  const r = (rank || '').toString().trim().toLowerCase();
  if (!r) return { exempt: false, target: null, tier: null };
  if (r === 'loa')                                return { exempt: true,  target: 0, tier: 'LOA' };
  if (/community\s*support|\bcso\b/.test(r))      return { exempt: true,  target: 0, tier: 'In Training' };
  if (/awaiting\s*training|recruit|trainee/.test(r)) return { exempt: true, target: 0, tier: 'In Training' };
  if (/superintendent|commander|commissioner|chief\s*of/.test(r)) return { exempt: true, target: 0, tier: 'High Command' };
  if (/chief\s*inspector/.test(r))                return { exempt: false, target: MET_TARGET(), tier: 'Officer' };
  if (/inspector/.test(r))                        return { exempt: false, target: MET_TARGET(), tier: 'Officer' };
  if (/sergeant/.test(r))                         return { exempt: false, target: MET_TARGET(), tier: 'Officer' };
  if (/constable/.test(r))                        return { exempt: false, target: MET_TARGET(), tier: 'Officer' };
  return { exempt: false, target: null, tier: null };
}

// MET quota is 3 events a week; one database point is one event. Tunable
// without a deploy, because "3" is a policy number and policy numbers move.
function MET_TARGET() {
  const n = parseInt(process.env.MET_QUOTA_EVENTS || '3', 10);
  return Number.isFinite(n) ? n : 3;
}

const BUILTIN_TARGETS = { CID: cidQuotaForRank, SCO19: sco19QuotaForRank, MET: metQuotaForRank };

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
  else if (div === 'HPC')   sheetId = process.env.HPC_SHEET_ID || '';
  else                      sheetId = process.env.QUOTA_SHEET_ID || DEFAULT_SHEET_ID; // IA (+ fallback)

  const resultsWebhookUrl = div === 'IA'
    ? (process.env.QUOTA_RESULTS_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL || '')
    : (process.env[`${prefix}QUOTA_RESULTS_WEBHOOK_URL`] || '');

  return {
    division:          div,
    prefix,
    sheetId,
    // HPC reuses the tryout points sheet, whose tab is HPC_SHEET_NAME.
    sheetName:         process.env[`${prefix}QUOTA_SHEET_NAME`] || (div === 'HPC' ? (process.env.HPC_SHEET_NAME || '') : ''),
    timezone:          tz,
    webhookUrl:        process.env[`${prefix}QUOTA_WEBHOOK_URL`] || '',
    webhookSecret:     process.env[`${prefix}QUOTA_WEBHOOK_SECRET`] || '',
    resultsWebhookUrl,
    targets:           div === 'IA' ? quotaForRank : envTargetsResolver(prefix, BUILTIN_TARGETS[div]),
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

// Resolve the service-account key JSON for a division: its own
// <PREFIX>GOOGLE_SERVICE_ACCOUNT_JSON if set, otherwise the shared, unprefixed
// GOOGLE_SERVICE_ACCOUNT_JSON. This lets each division read its own sheet with a
// dedicated service account (whose client_email is shared on that sheet) while
// IA keeps using the original variable.
function serviceAccountRaw(prefix) {
  const p = prefix || '';
  const varName = p ? `${p}GOOGLE_SERVICE_ACCOUNT_JSON` : 'GOOGLE_SERVICE_ACCOUNT_JSON';
  return { raw: (process.env[varName] || process.env.GOOGLE_SERVICE_ACCOUNT_JSON || ''), varName };
}

// Accepts an optional cfg (from quotaConfig) or a prefix string so the right
// division's service account is used. No arg → the shared IA account.
function getSheetsClient(cfgOrPrefix) {
  if (!google) { console.warn('[quota] googleapis not installed — run npm install.'); return null; }
  const prefix = cfgOrPrefix && typeof cfgOrPrefix === 'object' ? cfgOrPrefix.prefix : (cfgOrPrefix || '');
  const { raw, varName } = serviceAccountRaw(prefix);
  if (!raw) { console.warn(`[quota] ${varName} not set — quota disabled for this division.`); return null; }
  let creds;
  try { creds = JSON.parse(raw); } catch (e) { console.warn(`[quota] ${varName} is not valid JSON`); return null; }
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

// Locate USERNAME / DISCORD ID / day columns from the header rows
function findColumns(rows) {
  const out = { username: null, discordId: null, rank: null, days: {} };
  const USER_HEADERS    = ['username', 'roblox username', 'roblox user', 'roblox', 'user', 'name'];
  const DISCORD_HEADERS = ['discord id', 'discordid', 'discord'];
  // Accept the common variants divisions label their rank column with, so the
  // real rank shows instead of falling back to the tab name.
  const RANK_HEADERS    = ['rank', 'role', 'rank/role', 'rank / role', 'position',
                           'current rank', 'grade', 'sco rank', 'sco-19 rank',
                           'sco19 rank', 'division rank', 'group rank'];
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
    const cfg = quotaConfig(division);
    const sheets = getSheetsClient(cfg);
    if (!sheets) return false; // not configured — silent no-op

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
// An approved case is worth CASE_POINTS (4) to its investigator; an approved
// ticket log is worth TICKET_POINTS (2) to whoever closed the ticket.
const CASE_POINTS   = () => { const n = parseInt(process.env.IA_CASE_POINTS   || '4', 10); return Number.isFinite(n) ? n : 4; };
const TICKET_POINTS = () => { const n = parseInt(process.env.IA_TICKET_POINTS || '2', 10); return Number.isFinite(n) ? n : 2; };

function quotaForRank(rank) {
  const r = (rank || '').toString().trim().toLowerCase();
  if (!r) return { exempt: false, target: null, tier: null };
  if (r === 'loa')                                          return { exempt: true,  target: 0,  tier: 'LOA' };
  if (/director/.test(r))                                   return { exempt: true,  target: 0,  tier: 'High Command' };
  if (/senior\s*investigator|supervisor/.test(r))           return { exempt: false, target: 20, tier: 'Middle Command' };
  if (/junior\s*investigator|probationary\s*investigator/.test(r)) return { exempt: false, target: 30, tier: 'Low Command' };
  // A plain "Investigator" sits with Middle Command rather than falling through
  // as an unknown rank with no target at all.
  if (/investigator/.test(r))                               return { exempt: false, target: 20, tier: 'Middle Command' };
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

// ── Bought Quota Exempt (MET) ────────────────────────────────────
// Quota Exempt is a paid permission, held as a MET-server Discord role. One
// role-holder lookup covers the whole database — the same shape as the IA
// reduction role above — so marking the buyers exempt costs one call, not one
// per member.
const EXEMPT_GUILD_ID = () => process.env.MET_GUILD_ID || process.env.DISCORD_GUILD_ID || '';
const EXEMPT_ROLE_ID  = () => process.env.QUOTA_EXEMPT_ROLE_ID || '';

async function getQuotaExemptHolders() {
  const gid = EXEMPT_GUILD_ID(), rid = EXEMPT_ROLE_ID();
  if (!gid || !rid) return null;
  try {
    const { getRoleHolders } = require('./bot');
    return await getRoleHolders(gid, rid);
  } catch (e) { return null; }
}

// Digit-tolerant, same as the reduction check — sheets carry Discord IDs with
// stray formatting often enough that an exact match would silently miss buyers.
function holdsQuotaExempt(holders, discordId) {
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
    const cfg = quotaConfig(division);
    const sheets = getSheetsClient(cfg);
    if (!sheets) return null;
    if (!cfg.sheetId) return null;

    // Resolve the member's live identity (RoVer) so renamed users still match,
    // and search across every rank tab (MET-style split-by-rank databases put
    // each member on exactly one tab, with no rank column of their own).
    const resolved = await resolveMember(member);
    const tabs = await resolveQuotaTabs(sheets, cfg);
    const holders = cfg.division === 'IA' ? await getReductionHolders() : null;
    const exemptHolders = cfg.division === 'MET' ? await getQuotaExemptHolders() : null;
    const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    for (const tab of tabs) {
      let rows;
      try {
        const resp = await sheets.spreadsheets.values.get({
          spreadsheetId: cfg.sheetId, range: tab, valueRenderOption: 'FORMATTED_VALUE', majorDimension: 'ROWS',
        });
        rows = resp.data.values || [];
      } catch (e) { continue; }
      const cols = findColumns(rows);
      const rowIdx = findMemberRow(rows, cols, resolved.discordId, resolved.robloxCandidates);
      if (rowIdx < 0) continue;

      const days = {};
      let total = 0, exCell = false, loaCell = false;
      for (let d = 0; d < 7; d++) {
        const col = cols.days[d];
        const raw = col != null ? (rows[rowIdx][col] || '').toString().trim() : '';
        const num = parseFloat(raw);
        const val = Number.isFinite(num) ? num : 0;
        days[labels[d]] = raw && isNaN(num) ? raw : val; // keep "EX"/"LOA" as-is
        if (Number.isFinite(num)) total += num;
        else if (raw && /^loa$/i.test(raw)) loaCell = true;  // Leave of Absence marker
        else if (raw && /^ex$/i.test(raw))  exCell = true;   // Exempt marker
      }

      // Rank = the rank column if present, else the tab name (split-by-rank DBs).
      let rank = cols.rank != null ? (rows[rowIdx][cols.rank] || '').toString().trim() : '';
      if (!rank) rank = String(tab).trim();
      let quota = cfg.targets(rank);
      // IA quota-reduction role (Investigator of the Week) — IA only.
      if (cfg.division === 'IA') {
        const did = cols.discordId != null ? (rows[rowIdx][cols.discordId] || '').toString().trim() : (resolved.discordId || '');
        if (holdsReductionRole(holders, did)) quota = applyQuotaReduction(quota);
      }
      // Bought Quota Exempt — a paid MET permission, held as a Discord role.
      let bought = false;
      if (cfg.division === 'MET' && exemptHolders) {
        const did = cols.discordId != null ? (rows[rowIdx][cols.discordId] || '').toString().trim() : (resolved.discordId || '');
        bought = holdsQuotaExempt(exemptHolders, did) || holdsQuotaExempt(exemptHolders, resolved.discordId);
      }
      // Exempt if the rank/target says so OR the sheet cells are marked EX/LOA
      // OR they bought the exemption.
      const exempt = !!quota.exempt || exCell || loaCell || bought;
      quota = { ...quota, exempt };
      // Distinguish Leave of Absence from a bought exemption from an ordinary
      // one, so the UI can say exactly which it is rather than a flat "Exempt".
      let exemptKind = null;
      if (loaCell || /loa/i.test(quota.tier || '')) exemptKind = 'LOA';
      else if (bought) exemptKind = 'PURCHASED';
      else if (exempt) exemptKind = 'EXEMPT';
      const remaining = exempt || quota.target == null ? 0 : Math.max(0, quota.target - total);
      return { found: true, rank, quota, remaining, days, total, exemptKind };
    }
    return { found: false };
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
  // Division title / header rows — the sheet's own name or description showing up
  // as a row (e.g. "SCO-19 · Specialist Firearms Command"). Codes + full names.
  'sco-19', 'sco 19', 'sco19', 'cid', 'flp', 'hpc', 'met', 'ia',
  'specialist firearms command', 'criminal investigation department',
  'frontline policing', 'hendon police college', 'internal affairs',
  'metropolitan police service', 'metropolitan police', 'met police',
  'developer', 'hicomm',
]);

// Distinguish a real member row from the sheet's section headings ("HIGH RANKS",
// "LOW RANKS", "DATABASE TEAM"…), instruction/annotation rows ("This is your
// weekly quota", "Anyone on this sheet is banned…") and the whole BLACKLIST
// section. Real Roblox usernames have NO spaces and are ≤20 chars; blacklisted
// people are banned, not members, so they never count towards quota/activity.
function isMemberRow(uname, rank) {
  const u = (uname || '').trim();
  const r = (rank || '').trim().toLowerCase();
  if (!u) return false;
  if (/\s/.test(u)) return false;            // headings & sentences contain spaces
  if (u.length > 20) return false;           // Roblox usernames are ≤20 chars
  if (/^n\/?a$/i.test(u)) return false;      // "N/A" placeholder rows
  if (/blacklist/.test(r)) return false;     // banned users, not members
  if (/(^|[^a-z])(rank|ranks|command|blacklist)$/.test(r) && /^(high|middle|low|database|instructor)/.test(r)) return false; // "High Rank", "Database Command"…
  return true;
}

/**
 * Read EVERY IA member's quota row from the sheet (for the HICOMM Quota Check).
 * Returns an array of { username, discordId, rank, quota, total, days, met }
 * or null if the read path (service account) isn't configured.
 */
// Parse a sheet's raw grid (rows of cells) into member objects — shared by the
// service-account read and the webhook read so both produce identical results.
// `fallbackRank` (the tab name) is used as the rank when the tab has no rank
// column — this is how MET-style databases that split ranks across TABS work
// (each rank tab has username + day columns but no rank column of its own).
function buildMembersFromRows(rows, cfg, reductionHolders, fallbackRank, exemptHolders) {
  const cols = findColumns(rows);
  if (cols.username == null && cols.rank == null) return [];
  const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const members = [];
  for (let r = 0; r < rows.length; r++) {
    const uname = cols.username  != null ? (rows[r][cols.username]  || '').toString().trim() : '';
    let   rank  = cols.rank      != null ? (rows[r][cols.rank]      || '').toString().trim() : '';
    const did   = cols.discordId != null ? (rows[r][cols.discordId] || '').toString().trim() : '';
    if (!rank && fallbackRank) rank = String(fallbackRank).trim();   // rank = tab name
    if (!uname || NON_MEMBER.has(uname.toLowerCase())) continue;
    if (!rank  || NON_MEMBER.has(rank.toLowerCase()))   continue; // member rows carry a rank
    if (!isMemberRow(uname, rank)) continue;                       // skip headings / notes / blacklist

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
    // Bought Quota Exempt — the one thing that lifts the MET quota.
    let bought = false;
    if (holdsQuotaExempt(exemptHolders, did)) {
      bought = true;
      quota = { ...quota, exempt: true, target: 0, tier: quota.tier || 'Exempt' };
    }
    members.push({
      username: uname, discordId: did || null, rank, quota, total, days,
      exemptKind: bought ? 'PURCHASED' : (quota.exempt ? 'EXEMPT' : null),
      met: quota.exempt ? true : (quota.target != null ? total >= quota.target : null),
    });
  }
  return members;
}

// Read every member's points via the Google Sheets API (service account). Needs
// the sheet SHARED with the service account. Returns members, [] or null.
// Resolve which tabs to read for a division. A configured sheetName that EXACTLY
// names one real tab restricts to it; IA stays single-tab (first tab) for
// backward-compatibility; every other division reads + merges EVERY tab (MET-
// style split-by-rank databases: Chief Inspector / Inspector / Sergeant /
// Constable). This also means a bad/multi-value QUOTA_SHEET_NAME (e.g. a comma-
// joined list Google can't parse as a range) no longer errors the whole read —
// it's simply ignored and all tabs are read.
async function resolveQuotaTabs(sheets, cfg) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: cfg.sheetId, fields: 'sheets.properties.title' });
  const allTabs = (meta.data.sheets || []).map(s => s.properties.title).filter(Boolean);
  if (cfg.sheetName && allTabs.includes(cfg.sheetName)) return [cfg.sheetName];
  if (cfg.division === 'IA') return allTabs.slice(0, 1);
  return allTabs;
}

async function getAllMembersViaServiceAccount(cfg) {
  try {
    const sheets = getSheetsClient(cfg);
    if (!sheets) return null;
    if (!cfg.sheetId) return null;
    const tabs = await resolveQuotaTabs(sheets, cfg);
    const reductionHolders = cfg.division === 'IA' ? await getReductionHolders() : null;
    const exemptHolders = cfg.division === 'MET' ? await getQuotaExemptHolders() : null;
    const seen = new Set();
    const out = [];
    for (const tab of tabs) {
      let rows;
      try {
        const resp = await sheets.spreadsheets.values.get({
          spreadsheetId: cfg.sheetId, range: tab, valueRenderOption: 'FORMATTED_VALUE', majorDimension: 'ROWS',
        });
        rows = resp.data.values || [];
      } catch (e) { continue; } // skip an unreadable tab rather than failing the whole read
      // The tab name is the rank fallback for split-by-rank databases (MET).
      for (const m of buildMembersFromRows(rows, cfg, reductionHolders, tab, exemptHolders)) {
        const key = (m.username || '').toLowerCase();
        if (key && !seen.has(key)) { seen.add(key); out.push(m); }
      }
    }
    return out;
  } catch (err) {
    console.warn('[quota] service-account read failed:', err.message);
    return null;
  }
}

// Read every member's points via the Apps Script webhook (action:'members').
// No service-account sharing needed — the bound script already has sheet access.
// Requires the webhook to be re-deployed with the 'members' action (see the .gs).
async function getAllMembersViaWebhook(cfg) {
  if (!cfg.webhookUrl) return null;
  try {
    const fetch = require('node-fetch');
    const res = await fetch(cfg.webhookUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'follow',
      body: JSON.stringify({ secret: cfg.webhookSecret, action: 'members' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!data || !data.ok || !Array.isArray(data.tabs)) {
      if (data && data.error) console.warn(`[quota] members webhook (${cfg.division}): ${data.error}`);
      else console.warn(`[quota] members webhook (${cfg.division}): old deployment without the 'members' action — re-deploy the Apps Script.`);
      return null;
    }
    // IA's Investigator-of-the-Week quota reduction still applies on the webhook path.
    const reductionHolders = cfg.division === 'IA' ? await getReductionHolders() : null;
    const exemptHolders = cfg.division === 'MET' ? await getQuotaExemptHolders() : null;
    const seen = new Set();
    const out = [];
    for (const tab of data.tabs) {
      const rows = Array.isArray(tab && tab.values) ? tab.values : [];
      // The tab name is the rank fallback for split-by-rank databases (MET).
      for (const m of buildMembersFromRows(rows, cfg, reductionHolders, tab && tab.name, exemptHolders)) {
        const key = (m.username || '').toLowerCase();
        if (key && !seen.has(key)) { seen.add(key); out.push(m); }
      }
    }
    return out;
  } catch (err) {
    console.error('[quota] members webhook error:', err.message);
    return null;
  }
}

// Every member with rank / weekly total / quota target. Tries the service account
// first (IA), then falls back to the division's Apps Script webhook — so a
// division only needs its webhook configured, not a shared service account.
async function getAllMembersPoints(division = 'IA') {
  const cfg = quotaConfig(division);
  const viaSA = await getAllMembersViaServiceAccount(cfg);
  if (viaSA && viaSA.length) return viaSA;      // service-account read worked
  if (cfg.webhookUrl) {
    const viaWH = await getAllMembersViaWebhook(cfg);
    if (viaWH != null) return viaWH;            // webhook read worked (may be [])
  }
  return viaSA;                                 // null (not configured) or []
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
  const sheets = getSheetsClient(cfg);
  if (sheets) {
    try {
      const spreadsheetId = cfg.sheetId;
      // Clear EVERY tab the read path merges (split-by-rank divisions have one
      // tab per rank) — not just the first — so reset matches the Activity view.
      const tabs = await resolveQuotaTabs(sheets, cfg);
      const data = [];
      for (const sheetName of tabs) {
        let rows;
        try {
          const resp = await sheets.spreadsheets.values.get({
            spreadsheetId, range: sheetName, valueRenderOption: 'FORMATTED_VALUE', majorDimension: 'ROWS',
          });
          rows = resp.data.values || [];
        } catch (e) { continue; } // skip an unreadable tab rather than failing the whole reset
        const cols = findColumns(rows);
        const dayCols = Object.values(cols.days);
        if (!dayCols.length) continue; // no day columns on this tab
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
  const sheets = getSheetsClient(cfg);
  if (sheets) {
    try {
      const spreadsheetId = cfg.sheetId;
      // Search EVERY tab the read path merges — the member may live on a non-first
      // rank tab (split-by-rank divisions), which previously 500'd "not found".
      const tabs = await resolveQuotaTabs(sheets, cfg);
      const lc = target.toLowerCase();
      for (const sheetName of tabs) {
        let rows;
        try {
          const resp = await sheets.spreadsheets.values.get({
            spreadsheetId, range: sheetName, valueRenderOption: 'FORMATTED_VALUE', majorDimension: 'ROWS',
          });
          rows = resp.data.values || [];
        } catch (e) { continue; }
        const cols = findColumns(rows);
        if (cols.username == null) continue;
        let rowIdx = -1;
        for (let r = 0; r < rows.length; r++) {
          if (((rows[r][cols.username] || '').toString().trim().toLowerCase()) === lc) { rowIdx = r; break; }
        }
        if (rowIdx < 0) continue; // not on this tab — try the next
        const data = Object.values(cols.days).map(c => ({ range: `${sheetName}!${colLetter(c)}${rowIdx + 1}`, values: [[mark]] }));
        if (data.length) await sheets.spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: 'USER_ENTERED', data } });
        return { ok: true };
      }
      return { ok: false, error: 'Member not found on the sheet.' };
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

// ── Sheet primitives, shared with the MET database sync ───────────
// lib/metDatabase.js adds/removes member ROWS on the same sheet, so it reuses
// the client, the header detection and the A1 helpers from here rather than
// duplicating (and drifting from) them.

// Resolve the tab name once — env override, else the first tab.
async function resolveSheetName(sheets, spreadsheetId) {
  if (process.env.QUOTA_SHEET_NAME) return process.env.QUOTA_SHEET_NAME;
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
  return meta.data.sheets?.[0]?.properties?.title || 'Sheet1';
}

// Read the whole sheet: { sheets, spreadsheetId, sheetName, rows, cols }.
// Returns null when the read path (service account) isn't configured.
async function readSheet() {
  const sheets = getSheetsClient();
  if (!sheets) return null;
  const spreadsheetId = process.env.QUOTA_SHEET_ID || DEFAULT_SHEET_ID;
  const sheetName = await resolveSheetName(sheets, spreadsheetId);
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId, range: sheetName, valueRenderOption: 'FORMATTED_VALUE', majorDimension: 'ROWS',
  });
  const rows = resp.data.values || [];
  return { sheets, spreadsheetId, sheetName, rows, cols: findColumns(rows) };
}

// POST an action to the Apps Script web app. Returns the parsed body, or null
// when no webhook is configured.
async function callQuotaWebhook(payload) {
  const url = process.env.QUOTA_WEBHOOK_URL;
  if (!url) return null;
  const fetch = require('node-fetch');
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'follow',
    body: JSON.stringify({ secret: process.env.QUOTA_WEBHOOK_SECRET || '', ...payload }),
  });
  return await res.json().catch(() => ({ ok: false, error: 'bad response from the quota webhook' }));
}

module.exports = {
  addQuotaPoints, getMemberPoints, getAllMembersPoints, resetAllQuota, setMemberExempt, setMemberLOA,
  enqueueQuotaAward, processQuotaAwards, startQuotaWorker,
  setInvestigatorOfWeek,
  // Low-level sheet helpers reused by other point systems (e.g. HPC tryouts)
  // and by the MET database sync.
  getSheetsClient, findColumns, findMemberRow, currentDayIndex, colLetter,
  normName, NON_MEMBER, readSheet, resolveSheetName, callQuotaWebhook, DEFAULT_SHEET_ID, CASE_POINTS, TICKET_POINTS,
  // Division-aware config resolver (IA | FLP | MET).
  quotaConfig, quotaForRank, metQuotaForRank, MET_TARGET, resolveQuotaTabs, isMemberRow, dayIndexFromHeader,
  getQuotaExemptHolders, holdsQuotaExempt,
};
