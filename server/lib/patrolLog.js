// server/lib/patrolLog.js
// Parse an FLP patrol-log Discord message and persist it for site review.
// Logs are free-form, e.g.:
//   User: <@123>            (or a plain username)
//   Division: CID           (optional)
//   Shift Started: 10:33am  (or 13:55)
//   Shift Ended: 1:34pm
//   Total Time: 3hrs 1min.  (ignored — we compute it from start/end)
//   Ping: <@&...>
const prisma = require('./db');

// Parse a clock time ("10:33am", "1:34pm", "13:55", "9:42am") → 24h fields.
function parseClock(str) {
  const m = String(str || '').trim().match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ap = m[3] ? m[3].toLowerCase() : null;
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return { minutes: h * 60 + min, label: `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}` };
}

// Pull the "Shift Started/Ended" time out of the content (24h label).
function shiftTime(content, kind /* 'start' | 'end' */) {
  const re = new RegExp(`shift\\s+${kind}(?:ed)?\\s*:?\\s*(\\d{1,2}:\\d{2}\\s*(?:am|pm)?)`, 'i');
  const m = String(content || '').match(re);
  return m ? parseClock(m[1]) : null;
}

// Division value after "Division:", or null if absent/blank.
function parseDivision(content) {
  const m = String(content || '').match(/^\s*division\s*:?\s*(.*)$/im);
  if (!m) return null;
  const v = m[1].replace(/[.\s]+$/, '').trim();
  return v || null;
}

// Parse the message content → { division, shiftStart, shiftEnd, totalMinutes }.
// Total time is COMPUTED from start→end (crossing midnight adds 24h), never the
// log's own stated total.
function parsePatrolLog(content) {
  const start = shiftTime(content, 'start');
  const end   = shiftTime(content, 'end');
  let totalMinutes = null;
  if (start && end) {
    let diff = end.minutes - start.minutes;
    if (diff < 0) diff += 24 * 60;
    totalMinutes = diff;
  }
  return {
    division:     parseDivision(content),
    shiftStart:   start ? start.label : null,
    shiftEnd:     end ? end.label : null,
    totalMinutes,
  };
}

// Human total, e.g. 189 → "3h 9m". Null-safe.
function formatTotal(mins) {
  if (mins == null) return null;
  const h = Math.floor(mins / 60), m = mins % 60;
  return (h ? `${h}h ` : '') + `${m}m`;
}

// Image attachment URLs from a discord.js message.
function imageUrls(message) {
  const out = [];
  try {
    for (const a of message.attachments.values()) {
      const ct = (a.contentType || '').toLowerCase();
      if (ct.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(a.name || a.url || '')) out.push(a.url);
    }
  } catch (e) { /* no attachments */ }
  return out;
}

// Create a PENDING log (PATROL or EVENT) from a discord.js message
// (idempotent on messageId). Returns the row, or null on error / duplicate.
async function createFromMessage(message, type = 'PATROL') {
  try {
    const existing = await prisma.patrolLog.findUnique({ where: { messageId: String(message.id) } }).catch(() => null);
    if (existing) return existing;

    const parsed  = parsePatrolLog(message.content || '');
    const display = (message.member && message.member.displayName) || message.author.globalName || message.author.username;

    return await prisma.patrolLog.create({
      data: {
        type:                 type === 'EVENT' ? 'EVENT' : 'PATROL',
        messageId:            String(message.id),
        channelId:            String(message.channelId),
        submitterDiscordId:   String(message.author.id),
        submitterUsername:    message.author.username || null,
        submitterDisplayName: display || null,
        division:             parsed.division,
        shiftStart:           parsed.shiftStart,
        shiftEnd:             parsed.shiftEnd,
        totalMinutes:         parsed.totalMinutes,
        images:               imageUrls(message),
        rawContent:           (message.content || '').slice(0, 4000),
        status:               'PENDING',
      },
    });
  } catch (err) {
    console.error('[PatrolLog] createFromMessage failed:', err.message);
    return null;
  }
}

// Roblox username candidates for matching the MET database: the server nickname
// after its "RANK | " prefix ("SGT | imad599" → "imad599"), the log's "User:"
// line if it's a plain name, then the Discord username.
function robloxNameCandidates(log) {
  const out = [];
  const dn = log.submitterDisplayName || '';
  if (dn.includes('|')) out.push(dn.split('|').pop().trim());
  else if (dn) out.push(dn.trim());
  const m = String(log.rawContent || '').match(/^\s*user\s*:?\s*(.+)$/im);
  if (m) { const v = m[1].trim(); if (!/^<@/.test(v)) out.push(v.replace(/[<>@!]/g, '').trim()); }
  if (log.submitterUsername) out.push(log.submitterUsername);
  return [...new Set(out.filter(Boolean))];
}

// EVENT logs: on approval, add +1 to the member's current-day cell in the MET
// database (MET_SHEET_ID). The correct tab is found by SEARCHING every tab for
// the member's username — each member sits on exactly one rank tab (Chief
// Inspector / Inspector / …), so no rank lookup is needed. Best-effort.
async function awardMetEventPoint(log) {
  const spreadsheetId = process.env.MET_SHEET_ID;
  if (!spreadsheetId) { console.warn('[EventLog] MET_SHEET_ID not set — skipping point.'); return { ok: false, reason: 'MET_SHEET_ID not set' }; }
  try {
    const q = require('./quota');
    const sheets = q.getSheetsClient();
    if (!sheets) return { ok: false, reason: 'Google Sheets not configured' };
    const tz = process.env.QUOTA_TIMEZONE || 'Europe/London';

    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
    const tabs = (meta.data.sheets || []).map(s => s.properties.title);
    const candidates = robloxNameCandidates(log);
    if (!candidates.length) return { ok: false, reason: 'no username to match' };

    for (const tab of tabs) {
      let rows;
      try {
        const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range: tab, valueRenderOption: 'FORMATTED_VALUE', majorDimension: 'ROWS' });
        rows = resp.data.values || [];
      } catch (e) { continue; }
      const cols = q.findColumns(rows);
      if (cols.username == null) continue;
      const rowIdx = q.findMemberRow(rows, cols, log.submitterDiscordId, candidates);
      if (rowIdx < 0) continue;

      const dayCol = cols.days[q.currentDayIndex(tz)];
      if (dayCol == null) return { ok: false, reason: 'day column not found', tab };
      const cellRaw = (rows[rowIdx][dayCol] || '').toString().trim();
      if (cellRaw && isNaN(parseFloat(cellRaw))) return { ok: false, reason: `cell is "${cellRaw}" (e.g. EX) — left untouched`, tab };
      const newVal = (cellRaw ? parseFloat(cellRaw) : 0) + 1;
      await sheets.spreadsheets.values.update({
        spreadsheetId, range: `${tab}!${q.colLetter(dayCol)}${rowIdx + 1}`,
        valueInputOption: 'USER_ENTERED', requestBody: { values: [[newVal]] },
      });
      console.log(`[EventLog] +1 → ${tab} / ${candidates[0]} (now ${newVal})`);
      return { ok: true, tab, username: candidates[0], newVal };
    }
    return { ok: false, reason: 'member not found on any tab' };
  } catch (err) {
    console.error('[EventLog] awardMetEventPoint failed:', err.message);
    return { ok: false, reason: err.message };
  }
}

function serialize(p) {
  return {
    id: p.id, type: p.type || 'PATROL', messageId: p.messageId, channelId: p.channelId,
    pointAwarded: !!p.pointAwarded,
    submitterDiscordId: p.submitterDiscordId,
    submitterUsername: p.submitterUsername, submitterDisplayName: p.submitterDisplayName,
    division: p.division || 'N/A',
    shiftStart: p.shiftStart || null, shiftEnd: p.shiftEnd || null,
    totalMinutes: p.totalMinutes, totalLabel: formatTotal(p.totalMinutes),
    images: Array.isArray(p.images) ? p.images : [],
    status: p.status, reviewedByName: p.reviewedByName, reviewedAt: p.reviewedAt,
    createdAt: p.createdAt,
  };
}

module.exports = { parseClock, shiftTime, parseDivision, parsePatrolLog, formatTotal, imageUrls, createFromMessage, serialize, robloxNameCandidates, awardMetEventPoint };
