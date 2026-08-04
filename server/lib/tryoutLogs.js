// server/lib/tryoutLogs.js
// Tryout-log pipeline: the in-game HPCInstructorPanel POSTs a snapshot when the
// host concludes a tryout; we resolve the host to a site user, store a DRAFT
// log, and (later) the host posts it → HICOMM approve/deny → +1 HPC point.
const prisma = require('./db');

// Division slug for review links (CID logs review on /cid, HPC on /hpc).
// Normalise a tryout division to one of the REVIEWABLE tryout programmes. SCO-19
// has no tryout dashboard anymore, so any stray SCO19 payload is folded into HPC
// rather than landing in a queue with no UI to view/submit/approve it.
function normTryoutDivision(v) {
  const d = String(v || '').toUpperCase();
  return d === 'CID' ? 'CID' : 'HPC';
}
function divSlug(division) {
  return normTryoutDivision(division) === 'CID' ? 'cid' : 'hpc';
}

// The inbound game payload can carry the shared secret (when a game authenticates
// via body.secret rather than the header). Never persist that credential at rest.
function stripSecret(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const p = { ...payload };
  delete p.secret; delete p.signature;
  return p;
}

// ── Attendee / event normalisation ────────────────────────────────
// The game sends loosely-shaped data; normalise it and compute counts so the
// site never trusts the client's own totals.
function toResult(v) {
  const s = String(v || '').toUpperCase();
  if (s === 'PASS' || s === 'PASSED') return 'PASS';
  if (s === 'FAIL' || s === 'FAILED') return 'FAIL';
  return 'PENDING';
}

// Keep an attendee's optional written-quiz result if the game sends one:
//   { score, outOf, verdict, answers:[{ q, answer, verdict }] }
function normaliseQuiz(q) {
  if (!q || typeof q !== 'object') return null;
  const answers = Array.isArray(q.answers) ? q.answers.slice(0, 40).map(a => ({
    q: a.q != null ? a.q : (a.question != null ? a.question : null),
    answer: a.answer != null ? String(a.answer).slice(0, 300) : null,
    verdict: a.verdict != null ? String(a.verdict).slice(0, 20) : null,
  })) : [];
  const out = {
    score:   Number.isFinite(+q.score) ? +q.score : null,
    outOf:   Number.isFinite(+q.outOf) ? +q.outOf : (Number.isFinite(+q.total) ? +q.total : null),
    verdict: q.verdict ? String(q.verdict).slice(0, 20) : null,
    // Possible answer-copying flags (in-game anti-cheat). copyWith names the
    // other attendee(s) the answers matched.
    copyFlag: q.copyFlag != null ? !!q.copyFlag : undefined,
    copyWith: q.copyWith != null ? String(q.copyWith).slice(0, 200) : undefined,
    answers,
  };
  if (out.copyFlag === undefined) delete out.copyFlag;
  if (out.copyWith === undefined) delete out.copyWith;
  return (out.score != null || out.verdict != null || out.copyFlag || answers.length) ? out : null;
}

function normaliseAttendees(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list.map(a => {
    const out = {
      robloxId:  a.robloxId != null ? String(a.robloxId) : null,
      username:  a.username || a.name || 'Unknown',
      joinedAt:  a.joinedAt || a.joined || null,
      leftAt:    a.leftAt || a.left || null,
      kicked:    !!a.kicked,
      result:    toResult(a.result),
      strikes:   Math.max(0, parseInt(a.strikes, 10) || 0),
      note:      a.note ? String(a.note).slice(0, 300) : null,
      quiz:      normaliseQuiz(a.quiz),
    };
    // Optional live-feed extras: movement-watch flag + accumulated points.
    if (a.flagged != null) out.flagged = !!a.flagged;
    if (a.pts != null && Number.isFinite(+a.pts)) out.pts = +a.pts;
    return out;
  });
}

/**
 * Apply a host's edits to the attendee list WITHOUT letting them add anybody.
 *
 * The list on a DRAFT log was written by the in-game panel from who was actually in
 * the server. The submit endpoint then accepted a replacement list from the browser,
 * wholesale — so any HPC Junior Instructor could host one real tryout and submit it
 * carrying twenty accounts that were never there, each marked PASS. Approval grants
 * every passer the final-exam role, and the exam is the door into the MET group. One
 * legitimate tryout was a licence to admit as many alts as you liked.
 *
 * A host does need to correct results and strikes on the site — that is what the
 * screen is for. So edits to somebody already on the log are applied, and anybody
 * NOT on it is refused and named. Refused rather than dropped: silently discarding
 * half a submission is how somebody concludes the feature is broken and stops using
 * it, and it hides the attempt.
 *
 * Matched on Roblox id where the draft has one, falling back to the username,
 * because that is the only identity the panel is guaranteed to send.
 *
 * @returns {{ attendees: object[], rejected: string[] }}
 */
function applyAttendeeEdits(draft, incoming) {
  const original = Array.isArray(draft) ? draft : [];
  const edits = normaliseAttendees(incoming);

  const key = (a) => (a && a.robloxId ? 'id:' + String(a.robloxId)
                     : 'name:' + String((a && a.username) || '').trim().toLowerCase());
  const byKey = new Map(original.map(a => [key(a), a]));

  const rejected = [];
  const out = [];
  const seen = new Set();
  for (const e of edits) {
    const k = key(e);
    const was = byKey.get(k);
    if (!was) { rejected.push(e.username || '(unnamed)'); continue; }
    if (seen.has(k)) continue;          // the same person twice in one submission
    seen.add(k);
    // The host owns the judgement: result, strikes, the note, the quiz marks. They
    // do not own who was in the room — joinedAt/leftAt/kicked/robloxId stay as the
    // panel recorded them.
    out.push({
      ...was,
      result:  e.result,
      strikes: e.strikes,
      note:    e.note,
      quiz:    e.quiz != null ? e.quiz : was.quiz,
      ...(e.flagged != null ? { flagged: e.flagged } : {}),
      ...(e.pts != null ? { pts: e.pts } : {}),
    });
  }
  // Anybody the host left out of the submission keeps their recorded row. Omission
  // is not removal: the panel saw them in the server, and a shorter list must not be
  // a way to make an attendee disappear.
  for (const [k, a] of byKey) if (!seen.has(k)) out.push(a);

  return { attendees: out, rejected };
}

function normaliseEvents(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const TYPES = ['JOIN', 'LEAVE', 'KICK', 'STRIKE', 'PASS', 'FAIL', 'NOTE'];
  return list.slice(0, 2000).map(e => ({
    at:       e.at || e.time || null,
    type:     TYPES.includes(String(e.type).toUpperCase()) ? String(e.type).toUpperCase() : 'NOTE',
    username: e.username || e.name || null,
    by:       e.by || null,
    detail:   e.detail ? String(e.detail).slice(0, 300) : null,
  }));
}

function countsFor(attendees) {
  return {
    totalAttendees: attendees.length,
    passedCount:    attendees.filter(a => a.result === 'PASS').length,
    failedCount:    attendees.filter(a => a.result === 'FAIL').length,
    leftCount:      attendees.filter(a => a.leftAt && !a.kicked).length,
    kickedCount:    attendees.filter(a => a.kicked).length,
    strikeCount:    attendees.reduce((n, a) => n + (a.strikes || 0), 0),
  };
}

// ── Host resolution ──────────────────────────────────────────
// The host must be a site user (an HPC instructor who has logged in). Resolve
// by Discord id, then by stored Roblox id, then via RoVer (roblox → discord).
async function resolveHostUser({ hostDiscordId, hostRobloxId, hostRobloxName } = {}) {
  if (hostDiscordId) {
    const u = await prisma.user.findUnique({ where: { discordId: String(hostDiscordId) } }).catch(() => null);
    if (u) return u;
  }
  if (hostRobloxId) {
    const byRoblox = await prisma.user.findFirst({ where: { robloxId: String(hostRobloxId) } }).catch(() => null);
    if (byRoblox) return byRoblox;
    // Fall back to RoVer reverse lookup → discord id → user.
    try {
      const { getDiscordFromRoblox } = require('./roblox');
      const matches = await getDiscordFromRoblox(String(hostRobloxId));
      for (const m of matches) {
        const u = await prisma.user.findUnique({ where: { discordId: String(m.discordId) } }).catch(() => null);
        if (u) return u;
      }
    } catch (e) { /* RoVer down → can't resolve */ }
  }
  // Last resort: a signed-in user whose stored Roblox username matches (handles a
  // stale/absent robloxId link when the name is still on record).
  if (hostRobloxName) {
    const byName = await prisma.user.findFirst({
      where: { robloxUsername: { equals: String(hostRobloxName), mode: 'insensitive' } },
    }).catch(() => null);
    if (byName) return byName;
  }
  return null;
}

// Fill in any attendee usernames the game didn't send, from their Roblox id
// (batched, best-effort). Lets the in-game panel send only ids.
async function enrichAttendeeNames(attendees) {
  const need = attendees.filter(a => a.robloxId && (!a.username || a.username === 'Unknown')).map(a => a.robloxId);
  if (!need.length) return attendees;
  try {
    const { getRobloxUsersInfo } = require('./roblox');
    const info = await getRobloxUsersInfo(need.slice(0, 100));
    for (const a of attendees) {
      if (a.robloxId && info.has(a.robloxId) && (!a.username || a.username === 'Unknown')) a.username = info.get(a.robloxId).username;
    }
  } catch (e) { /* names stay as sent */ }
  return attendees;
}

// Resolve the co-host's Roblox id → username (and, best-effort, Discord id).
async function resolveCoHost(coHost) {
  if (!coHost) return { name: null, robloxId: null };
  let name = coHost.username || coHost.name || null;
  const robloxId = coHost.robloxId ? String(coHost.robloxId) : null;
  if (robloxId && !name) {
    try { const { getRobloxUserInfo } = require('./roblox'); const u = await getRobloxUserInfo(robloxId); if (u) name = u.username; }
    catch (e) { /* leave null */ }
  }
  return { name, robloxId };
}

// Create a DRAFT tryout log from a game conclusion payload. Idempotent on
// payload.sessionId (a per-tryout GUID): a retried POST returns the existing
// log instead of creating a duplicate. Returns { ok, id, reviewUrl, existing? }
// or { ok:false, error }.
async function createFromGamePayload(payload = {}) {
  // ── Idempotency: if this game session already logged, return it. ──
  const sessionId = payload.sessionId || payload.gameSessionId || null;
  if (sessionId) {
    const existing = await prisma.tryoutLog.findUnique({ where: { gameSessionId: String(sessionId) } }).catch(() => null);
    if (existing) {
      const base = process.env.PUBLIC_BASE_URL || '';
      return { ok: true, id: existing.id, reviewUrl: `${base}/${divSlug(payload.division)}/dashboard?tryoutLog=${existing.id}`, existing: true };
    }
  }

  const host = payload.host || {};
  // Resolve the host to a linked site user IF we can — but a concluded tryout
  // must ALWAYS produce a log. An unresolved host just yields a host-less log
  // that goes straight to the reviewer queue (PENDING) instead of failing.
  const hostUser = await resolveHostUser({ hostDiscordId: host.discordId, hostRobloxId: host.robloxId, hostRobloxName: host.username });

  // Auto-fill the host's Roblox name from Roblox even when unlinked.
  let hostRobloxName = host.username || (hostUser && hostUser.robloxUsername) || null;
  const anyRobloxId = host.robloxId || (hostUser && hostUser.robloxId);
  if (!hostRobloxName && anyRobloxId) {
    try { const { getRobloxUserInfo } = require('./roblox'); const u = await getRobloxUserInfo(String(anyRobloxId)); if (u) hostRobloxName = u.username; }
    catch (e) { /* ok */ }
  }
  const coHost    = await resolveCoHost(payload.coHost);
  const attendees = await enrichAttendeeNames(normaliseAttendees(payload.attendees));
  const events    = normaliseEvents(payload.events);
  const counts    = countsFor(attendees);
  // Linked host → DRAFT (they review + post). No linked host → nobody can review
  // a draft, so send it straight to the division's review queue.
  const status = hostUser ? 'DRAFT' : 'PENDING';

  let log;
  try {
    log = await prisma.tryoutLog.create({
      data: {
        gameSessionId:  sessionId ? String(sessionId) : null,
        tryoutId:       payload.tryoutId || null,
        hostId:         hostUser ? hostUser.id : null,
        hostDiscordId:  hostUser ? hostUser.discordId : (host.discordId ? String(host.discordId) : null),
        hostName:       (hostUser && (hostUser.displayName || hostUser.discordUsername)) || hostRobloxName || 'Host',
        hostRobloxId:   host.robloxId ? String(host.robloxId) : ((hostUser && hostUser.robloxId) || null),
        hostRobloxName,
        coHostName:     coHost.name,
        coHostRobloxId: coHost.robloxId,
        startedAt:      payload.startedAt ? new Date(payload.startedAt) : null,
        concludedAt:    payload.concludedAt ? new Date(payload.concludedAt) : new Date(),
        attendees, events, ...counts,
        status,
        division:       normTryoutDivision(payload.division),
        gamePayload:    stripSecret(payload),
      },
    });
  } catch (e) {
    // Unique-violation race on gameSessionId → the log was created concurrently.
    if (sessionId) {
      const existing = await prisma.tryoutLog.findUnique({ where: { gameSessionId: String(sessionId) } }).catch(() => null);
      if (existing) {
        const base = process.env.PUBLIC_BASE_URL || '';
        return { ok: true, id: existing.id, reviewUrl: `${base}/${divSlug(payload.division)}/dashboard?tryoutLog=${existing.id}`, existing: true };
      }
    }
    throw e;
  }

  const base = process.env.PUBLIC_BASE_URL || '';
  return { ok: true, id: log.id, status: log.status, hostLinked: !!hostUser,
    reviewUrl: `${base}/${divSlug(log.division)}/dashboard?tryoutLog=${log.id}` };
}

// ── Serialisation for the API ───────────────────────────────────
function serialize(log, { full = false } = {}) {
  const base = {
    id: log.id, hostName: log.hostName, hostDiscordId: log.hostDiscordId,
    coHostName: log.coHostName, status: log.status,
    totalAttendees: log.totalAttendees, passedCount: log.passedCount,
    failedCount: log.failedCount, leftCount: log.leftCount,
    kickedCount: log.kickedCount, strikeCount: log.strikeCount,
    startedAt: log.startedAt, concludedAt: log.concludedAt,
    reviewedByName: log.reviewedByName, reviewedAt: log.reviewedAt, reviewNote: log.reviewNote,
    pointAwarded: log.pointAwarded, createdAt: log.createdAt,
    division: log.division || 'HPC',
  };
  if (!full) return base;
  return { ...base, attendees: log.attendees || [], events: log.events || [], notes: log.notes, proof: log.proof || null, hostRobloxName: log.hostRobloxName || null };
}

// ── +1 HPC point on approval ──────────────────────────────────
// Writes +1 to the host's current-day cell on the HPC database sheet, reusing
// the quota sheet helpers. Best-effort: returns false (no throw) if Google
// Sheets isn't configured or the host row can't be found.
// Returns { ok, reason, detail } so the approver is told exactly why a point was
// skipped (sheet not configured vs. host not on the sheet vs. date column, etc.).
async function awardHpcPoint(log) {
  const who = log.hostRobloxName || log.hostName || 'the host';
  try {
    const q = require('./quota');
    const sheets = q.getSheetsClient();
    if (!sheets) return { ok: false, reason: 'sheets_not_configured', detail: 'Google Sheets credentials are not configured on the server.' };

    const spreadsheetId = process.env.HPC_SHEET_ID;
    if (!spreadsheetId) { console.warn('[tryoutLog] HPC_SHEET_ID not set — skipping point award.'); return { ok: false, reason: 'no_sheet_id', detail: 'HPC_SHEET_ID is not set.' }; }
    const tz = process.env.QUOTA_TIMEZONE || 'Europe/London';

    let sheetName = process.env.HPC_SHEET_NAME;
    if (!sheetName) {
      const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
      sheetName = meta.data.sheets?.[0]?.properties?.title || 'Sheet1';
    }

    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId, range: q.sheetRef(sheetName), valueRenderOption: 'FORMATTED_VALUE', majorDimension: 'ROWS',
    });
    const rows = resp.data.values || [];
    const cols = q.findColumns(rows);

    const candidates = [log.hostRobloxName, log.hostName].filter(Boolean);
    const rowIdx = q.findMemberRow(rows, cols, log.hostDiscordId, candidates);
    if (rowIdx < 0) { console.warn(`[tryoutLog] no HPC row for host ${who}`); return { ok: false, reason: 'host_not_on_sheet', detail: `"${who}" was not found on the "${sheetName}" tab. Add their row (or check the username matches).` }; }

    const dayCol = cols.days[q.currentDayIndex(tz)];
    if (dayCol == null) { console.warn('[tryoutLog] HPC day column not found for today'); return { ok: false, reason: 'no_day_column', detail: 'Today\'s date column was not found on the sheet — check the header row / date format.' }; }

    const cellRaw = (rows[rowIdx][dayCol] || '').toString().trim();
    if (cellRaw && isNaN(parseFloat(cellRaw))) return { ok: false, reason: 'cell_locked', detail: `Today's cell already holds a non-numeric value ("${cellRaw}") — left untouched.` };
    const newVal = (cellRaw ? parseFloat(cellRaw) : 0) + 1;

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: q.sheetRef(sheetName, `${q.colLetter(dayCol)}${rowIdx + 1}`),
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[newVal]] },
    });
    console.log(`[tryoutLog] +1 HPC point → ${who} (now ${newVal})`);
    return { ok: true, reason: null, detail: `+1 point written to ${who} (now ${newVal}).` };
  } catch (err) {
    console.error('[tryoutLog] awardHpcPoint failed:', err.message);
    return { ok: false, reason: 'error', detail: `Sheet error: ${err.message}` };
  }
}

// ── +1 CID "event hosted" on approval ────────────────────────────
// Writes +1 to the host's current-day cell in the EVENTS HOSTED/ATTENDED block
// on the CID database sheet (CID_SHEET_ID). The sheet is split into rank-tier
// tabs (LOW / MIDDLE / HIGH RANK); rather than assume the host's tier we search
// every tab for their row and write to whichever one holds it. Reuses the quota
// sheet helpers (header-driven column detection + tolerant username matching).
// Best-effort: returns false (no throw) if Sheets isn't configured or no row
// matches. TODO(verify): confirmed against the MIDDLE RANK tab layout from the
// screenshot (USERNAME + MON–SUN); verify LOW/HIGH RANK tabs use the same headers.
async function awardCidEventPoint(log) {
  try {
    const q = require('./quota');
    const sheets = q.getSheetsClient();
    if (!sheets) return false; // service account not configured — silent no-op

    const spreadsheetId = process.env.CID_SHEET_ID;
    if (!spreadsheetId) { console.warn('[tryoutLog] CID_SHEET_ID not set — skipping CID event point.'); return false; }
    const tz = process.env.QUOTA_TIMEZONE || 'Europe/London';

    // All tabs on the sheet (rank-tier tabs). Prefer the host's own tier tab
    // first (from the ranks config, if we can tell), then fall back to the rest.
    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
    let tabs = (meta.data.sheets || []).map(s => s.properties && s.properties.title).filter(Boolean);
    const candidates = [log.hostRobloxName, log.hostName].filter(Boolean);

    for (const sheetName of tabs) {
      const resp = await sheets.spreadsheets.values.get({
        spreadsheetId, range: q.sheetRef(sheetName), valueRenderOption: 'FORMATTED_VALUE', majorDimension: 'ROWS',
      }).catch(() => null);
      if (!resp) continue;
      const rows = resp.data.values || [];
      const cols = q.findColumns(rows);
      if (cols.username == null && cols.discordId == null) continue; // not a member tab
      const rowIdx = q.findMemberRow(rows, cols, log.hostDiscordId, candidates);
      if (rowIdx < 0) continue;

      const dayCol = cols.days[q.currentDayIndex(tz)];
      if (dayCol == null) { console.warn(`[tryoutLog] CID: no day column on "${sheetName}"`); continue; }
      const cellRaw = (rows[rowIdx][dayCol] || '').toString().trim();
      if (cellRaw && isNaN(parseFloat(cellRaw))) continue; // non-numeric marker — leave it
      const newVal = (cellRaw ? parseFloat(cellRaw) : 0) + 1;

      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: q.sheetRef(sheetName, `${q.colLetter(dayCol)}${rowIdx + 1}`),
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[newVal]] },
      });
      console.log(`[tryoutLog] +1 CID event → ${log.hostRobloxName || log.hostName} on "${sheetName}" (now ${newVal})`);
      return true;
    }
    console.warn(`[tryoutLog] CID: no sheet row for host ${log.hostRobloxName || log.hostName} across ${tabs.length} tab(s)`);
    return false;
  } catch (err) {
    console.error('[tryoutLog] awardCidEventPoint failed:', err.message);
    return false;
  }
}

// ── Attendance sync to a "recruits" sheet (optional, on approval) ────
// Appends one row per attendee to HPC_RECRUITS_SHEET_ID:
//   [concluded date, host, recruit, roblox id, result, strikes, kicked/left]
// Best-effort: no-op if the sheet isn't configured.
async function syncAttendanceToSheet(log) {
  const spreadsheetId = process.env.HPC_RECRUITS_SHEET_ID;
  if (!spreadsheetId) return false;
  try {
    const q = require('./quota');
    const sheets = q.getSheetsClient();
    if (!sheets) return false;
    let sheetName = process.env.HPC_RECRUITS_SHEET_NAME;
    if (!sheetName) {
      const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
      sheetName = meta.data.sheets?.[0]?.properties?.title || 'Sheet1';
    }
    const when = (log.concludedAt ? new Date(log.concludedAt) : new Date()).toISOString().slice(0, 10);
    const rows = (log.attendees || []).map(a => [
      when, log.hostRobloxName || log.hostName || '', a.username || '', a.robloxId || '',
      a.result || 'PENDING', String(a.strikes || 0), a.kicked ? 'KICKED' : (a.leftAt ? 'LEFT' : ''),
    ]);
    if (!rows.length) return false;
    await sheets.spreadsheets.values.append({
      spreadsheetId, range: q.sheetRef(sheetName), valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS', requestBody: { values: rows },
    });
    console.log(`[tryoutLog] synced ${rows.length} attendees → recruits sheet`);
    return true;
  } catch (err) {
    console.error('[tryoutLog] syncAttendanceToSheet failed:', err.message);
    return false;
  }
}

// ── Push-notify approvers when a log is submitted for review ──────────
async function notifyTryoutApprovers(log) {
  try {
    const { sendCustomNotification } = require('./push');
    // Primary approver set: site HICOMM / developers (HPC quota-tier approvers
    // still get the in-dashboard review badge). Notify those with push on.
    const approvers = await prisma.user.findMany({
      where: { role: { in: ['HICOMM', 'DEVELOPER'] } }, select: { id: true },
    });
    if (!approvers.length) return;
    await sendCustomNotification({
      userIds: approvers.map(u => u.id),
      title:   'New tryout log to review',
      body:    `${log.hostName} posted a tryout — ${log.totalAttendees} attended, ${log.passedCount} passed.`,
      url:     '/hpc/dashboard?tryoutReview=1',
    });
  } catch (e) { console.error('[tryoutLog] notifyTryoutApprovers failed:', e.message); }
}

// ── On MET-tryout approval: give everyone who PASSED the final-exam role in the
// MET server, so they can sit the exam. Best-effort per attendee — a member who
// can't be resolved to a Discord id (never linked, not in the server) is skipped.
// Returns { granted, total } for logging. ──
async function grantFinalExamRoleToPassers(log) {
  const out = { granted: 0, total: 0 };
  try {
    // Only MET tryouts (division HPC = the general MET tryout).
    if (!log || String(log.division || '').toUpperCase() !== 'HPC') return out;
    const { hpcExamRoleId } = require('./divisions');
    const roleId = hpcExamRoleId();
    if (!roleId) return out;
    const bot = require('./bot');
    const roblox = require('./roblox');
    const metGuild = process.env.MET_GUILD_ID || process.env.DISCORD_GUILD_ID || null;
    const passers = (Array.isArray(log.attendees) ? log.attendees : []).filter(a => a && a.result === 'PASS' && !a.kicked);
    out.total = passers.length;
    for (const a of passers) {
      let discordId = null;
      // 1) A linked site user with this Roblox id.
      if (a.robloxId) {
        const u = await prisma.user.findFirst({ where: { robloxId: String(a.robloxId) }, select: { discordId: true } }).catch(() => null);
        if (u && u.discordId) discordId = String(u.discordId);
      }
      // 2) RoVer: Roblox id → Discord id. getDiscordFromRoblox returns an ARRAY
      // of matches (or []); take the first real discordId. (Treating it as a
      // scalar produced "[object Object]" and skipped the nickname fallback.)
      if (!discordId && a.robloxId) {
        try { const matches = await roblox.getDiscordFromRoblox(String(a.robloxId)); if (Array.isArray(matches) && matches.length && matches[0].discordId) discordId = String(matches[0].discordId); } catch (e) {}
      }
      // 3) A guild member whose RoVer nickname matches the Roblox username.
      if (!discordId && a.username && a.username !== 'Unknown') {
        try { const m = await bot.findMemberByRobloxNick(a.username); if (m && m.id) discordId = String(m.id); } catch (e) {}
      }
      if (!discordId) continue;
      // The MET server explicitly — the exam role lives there, and this app resolves
      // "the MET server" as MET_GUILD_ID before DISCORD_GUILD_ID everywhere else.
      try { const ok = await bot.assignRole(discordId, roleId, metGuild); if (ok) out.granted++; } catch (e) {}
    }
    // Nobody got it. Worth a line, because the outcome is a room full of passers who
    // cannot sit the exam and no indication why — the two causes are the bot missing
    // Manage Roles (or sitting below the role) and the role being in another guild.
    if (out.total && !out.granted) {
      console.warn(`[tryoutLog] final-exam role ${roleId} granted to NOBODY out of ${out.total} `
        + `passer(s) in guild ${metGuild} — check the bot has "Manage Roles", that its own `
        + 'highest role is above that one, and that the role is in this guild.');
    }
  } catch (e) { console.error('[tryoutLog] grantFinalExamRoleToPassers failed:', e.message); }
  return out;
}

module.exports = {
  normaliseAttendees, applyAttendeeEdits, normaliseEvents, countsFor, resolveHostUser,
  createFromGamePayload, serialize, awardHpcPoint, awardCidEventPoint,
  syncAttendanceToSheet, notifyTryoutApprovers, grantFinalExamRoleToPassers,
};
