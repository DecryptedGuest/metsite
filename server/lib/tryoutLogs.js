// server/lib/tryoutLogs.js
// Tryout-log pipeline: the in-game HPCInstructorPanel POSTs a snapshot when the
// host concludes a tryout; we resolve the host to a site user, store a DRAFT
// log, and (later) the host posts it → HICOMM approve/deny → +1 HPC point.
const prisma = require('./db');

// ── Attendee / event normalisation ───────────────────────────────────
// The game sends loosely-shaped data; normalise it and compute counts so the
// site never trusts the client's own totals.
function toResult(v) {
  const s = String(v || '').toUpperCase();
  if (s === 'PASS' || s === 'PASSED') return 'PASS';
  if (s === 'FAIL' || s === 'FAILED') return 'FAIL';
  return 'PENDING';
}

function normaliseAttendees(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list.map(a => ({
    robloxId:  a.robloxId != null ? String(a.robloxId) : null,
    username:  a.username || a.name || 'Unknown',
    joinedAt:  a.joinedAt || a.joined || null,
    leftAt:    a.leftAt || a.left || null,
    kicked:    !!a.kicked,
    result:    toResult(a.result),
    strikes:   Math.max(0, parseInt(a.strikes, 10) || 0),
    note:      a.note ? String(a.note).slice(0, 300) : null,
  }));
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

// ── Host resolution ──────────────────────────────────────────────────
// The host must be a site user (an HPC instructor who has logged in). Resolve
// by Discord id, then by stored Roblox id, then via RoVer (roblox → discord).
async function resolveHostUser({ hostDiscordId, hostRobloxId }) {
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
      return { ok: true, id: existing.id, reviewUrl: `${base}/hpc/dashboard?tryoutLog=${existing.id}`, existing: true };
    }
  }

  const host = payload.host || {};
  const hostUser = await resolveHostUser({ hostDiscordId: host.discordId, hostRobloxId: host.robloxId });
  if (!hostUser) {
    const roverConfigured = !!(process.env.ROVER_API_KEY && process.env.DISCORD_GUILD_ID);
    const site = process.env.PUBLIC_BASE_URL || 'the MET portal';
    const who  = `Roblox user ${host.robloxId || '?'}${host.username ? ` (${host.username})` : ''}`;
    return {
      ok: false,
      error: roverConfigured
        ? `No portal account is linked to ${who}. That person must sign in at ${site} with the Discord account RoVer-verified to that Roblox account, then retry.`
        : `Cannot resolve ${who}: RoVer isn't configured on the server (set ROVER_API_KEY and DISCORD_GUILD_ID).`,
      roverConfigured,
    };
  }

  // Auto-fill identities from Roblox/RoVer so the game can send ids only.
  let hostRobloxName = host.username || hostUser.robloxUsername || null;
  if (!hostRobloxName && (host.robloxId || hostUser.robloxId)) {
    try { const { getRobloxUserInfo } = require('./roblox'); const u = await getRobloxUserInfo(String(host.robloxId || hostUser.robloxId)); if (u) hostRobloxName = u.username; }
    catch (e) { /* ok */ }
  }
  const coHost    = await resolveCoHost(payload.coHost);
  const attendees = await enrichAttendeeNames(normaliseAttendees(payload.attendees));
  const events    = normaliseEvents(payload.events);
  const counts    = countsFor(attendees);

  let log;
  try {
    log = await prisma.tryoutLog.create({
      data: {
        gameSessionId:  sessionId ? String(sessionId) : null,
        tryoutId:       payload.tryoutId || null,
        hostId:         hostUser.id,
        hostDiscordId:  hostUser.discordId,
        hostName:       hostUser.displayName || hostUser.discordUsername || hostRobloxName || 'Host',
        hostRobloxId:   host.robloxId ? String(host.robloxId) : hostUser.robloxId,
        hostRobloxName,
        coHostName:     coHost.name,
        coHostRobloxId: coHost.robloxId,
        startedAt:      payload.startedAt ? new Date(payload.startedAt) : null,
        concludedAt:    payload.concludedAt ? new Date(payload.concludedAt) : new Date(),
        attendees, events, ...counts,
        status:         'DRAFT',
        gamePayload:    payload,
      },
    });
  } catch (e) {
    // Unique-violation race on gameSessionId → the log was created concurrently.
    if (sessionId) {
      const existing = await prisma.tryoutLog.findUnique({ where: { gameSessionId: String(sessionId) } }).catch(() => null);
      if (existing) {
        const base = process.env.PUBLIC_BASE_URL || '';
        return { ok: true, id: existing.id, reviewUrl: `${base}/hpc/dashboard?tryoutLog=${existing.id}`, existing: true };
      }
    }
    throw e;
  }

  const base = process.env.PUBLIC_BASE_URL || '';
  return { ok: true, id: log.id, reviewUrl: `${base}/hpc/dashboard?tryoutLog=${log.id}` };
}

// ── Serialisation for the API ────────────────────────────────────────
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
  };
  if (!full) return base;
  return { ...base, attendees: log.attendees || [], events: log.events || [], notes: log.notes };
}

// ── +1 HPC point on approval ─────────────────────────────────────────
// Writes +1 to the host's current-day cell on the HPC database sheet, reusing
// the quota sheet helpers. Best-effort: returns false (no throw) if Google
// Sheets isn't configured or the host row can't be found.
async function awardHpcPoint(log) {
  try {
    const q = require('./quota');
    const sheets = q.getSheetsClient();
    if (!sheets) return false; // sheets not configured — silent no-op

    const spreadsheetId = process.env.HPC_SHEET_ID;
    if (!spreadsheetId) { console.warn('[tryoutLog] HPC_SHEET_ID not set — skipping point award.'); return false; }
    const tz = process.env.QUOTA_TIMEZONE || 'Europe/London';

    let sheetName = process.env.HPC_SHEET_NAME;
    if (!sheetName) {
      const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
      sheetName = meta.data.sheets?.[0]?.properties?.title || 'Sheet1';
    }

    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId, range: sheetName, valueRenderOption: 'FORMATTED_VALUE', majorDimension: 'ROWS',
    });
    const rows = resp.data.values || [];
    const cols = q.findColumns(rows);

    const candidates = [log.hostRobloxName, log.hostName].filter(Boolean);
    const rowIdx = q.findMemberRow(rows, cols, log.hostDiscordId, candidates);
    if (rowIdx < 0) { console.warn(`[tryoutLog] no HPC row for host ${log.hostRobloxName || log.hostName}`); return false; }

    const dayCol = cols.days[q.currentDayIndex(tz)];
    if (dayCol == null) { console.warn('[tryoutLog] HPC day column not found for today'); return false; }

    const cellRaw = (rows[rowIdx][dayCol] || '').toString().trim();
    if (cellRaw && isNaN(parseFloat(cellRaw))) return false; // non-numeric (e.g. QE) — leave it
    const newVal = (cellRaw ? parseFloat(cellRaw) : 0) + 1;

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!${q.colLetter(dayCol)}${rowIdx + 1}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[newVal]] },
    });
    console.log(`[tryoutLog] +1 HPC point → ${log.hostRobloxName || log.hostName} (now ${newVal})`);
    return true;
  } catch (err) {
    console.error('[tryoutLog] awardHpcPoint failed:', err.message);
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
      spreadsheetId, range: sheetName, valueInputOption: 'USER_ENTERED',
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

module.exports = {
  normaliseAttendees, normaliseEvents, countsFor, resolveHostUser,
  createFromGamePayload, serialize, awardHpcPoint,
  syncAttendanceToSheet, notifyTryoutApprovers,
};
