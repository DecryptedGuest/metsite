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

const PATROL_TZ = () => process.env.PATROL_TIMEZONE || process.env.QUOTA_TIMEZONE || 'Europe/London';

// Format a unix-seconds epoch as a short "05 Jul, 14:21" label in the patrol TZ.
function fmtEpoch(sec) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
      hour12: false, timeZone: PATROL_TZ(),
    }).format(new Date(sec * 1000));
  } catch (e) { return null; }
}

// Parse a time value out of arbitrary text. Handles:
//   - Discord timestamps  <t:1783244460:f>  → exact epoch
//   - clock times with tolerant separators   4;28  10.33am  13:55  9：42
// Returns { epoch, minutes, label } (epoch OR minutes is set) or null.
function parseTimeValue(str) {
  const s = String(str || '');
  const dt = s.match(/<t:(\d{6,}):?[a-zA-Z]?>/);
  if (dt) {
    const epoch = parseInt(dt[1], 10);
    return { epoch, minutes: null, label: fmtEpoch(epoch) || `<t:${epoch}>` };
  }
  // Accept :  ;  .  and the full-width colon ：  as separators; optional am/pm.
  const re = /(\d{1,2})\s*[:;.：]\s*(\d{2})\s*(am|pm)?/gi;
  let m, last = null;
  while ((m = re.exec(s)) !== null) last = m;
  if (last) {
    let h = parseInt(last[1], 10);
    const min = parseInt(last[2], 10);
    const ap = last[3] ? last[3].toLowerCase() : null;
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (h <= 23 && min <= 59) {
      // `hour` + `hadMeridiem` let the caller resolve the 12:xx (noon vs
      // midnight) ambiguity when no am/pm was written.
      return { epoch: null, minutes: h * 60 + min, hour: h, hadMeridiem: !!ap,
        label: `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}` };
    }
  }
  return null;
}

// Back-compat: a clock time → { minutes, label } (or null). Delegates to parseTimeValue.
function parseClock(str) { return parseTimeValue(str); }

// Pull the "Shift Started/Ended" time out of the content. Tolerant of wording,
// misspellings and separators (only the LINE has to name the shift; the value
// can be a clock time or a Discord timestamp).
function shiftTime(content, kind /* 'start' | 'end' */) {
  const label = kind === 'start'
    ? /(shift\s*)?(start(?:ed|ing)?|beg[au]n|clock(?:ed)?\s*in|time\s*on|on\s*duty)/i
    : /(shift\s*)?(end(?:ed|ing)?|finish(?:ed)?|clock(?:ed)?\s*out|time\s*off|off\s*duty)/i;
  for (const line of String(content || '').split(/\r?\n/)) {
    if (!label.test(line)) continue;
    const t = parseTimeValue(line);
    if (t) return t;
  }
  return null;
}

// Parse an EXPLICIT date written in the log (not the shift times). Handles:
//   - "Date: 05/07/2025", "Date - 5.7.25", or a bare DD/MM/YYYY (UK day-first)
//   - a Discord date timestamp <t:epoch:D> / <t:epoch:d>
// Returns a Date, or null when no explicit date is present (caller then falls
// back to the message-sent date).
function parseLogDate(content) {
  const s = String(content || '');
  let m = s.match(/date\s*[:\-]?\s*([0-3]?\d)\s*[\/\-.]\s*([01]?\d)\s*[\/\-.]\s*(\d{2,4})/i)
       || s.match(/\b([0-3]?\d)\s*[\/\-.]\s*([01]?\d)\s*[\/\-.]\s*(\d{2,4})\b/);
  if (m) {
    let d = parseInt(m[1], 10), mo = parseInt(m[2], 10), y = parseInt(m[3], 10);
    if (y < 100) y += 2000;
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12 && y >= 2000 && y <= 2100) {
      const dt = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0)); // noon UTC → no TZ day-shift
      if (!isNaN(dt.getTime())) return dt;
    }
  }
  // Discord DATE timestamps only (D/d); not :t/:T/:f/:F which are shift times.
  const dt = s.match(/<t:(\d{6,}):[Dd]>/);
  if (dt) { const d = new Date(parseInt(dt[1], 10) * 1000); if (!isNaN(d.getTime())) return d; }
  return null;
}

// Division value after "Division:" (tolerant of "Div", separators, trailing pings).
function parseDivision(content) {
  const m = String(content || '').match(/^\s*div\w*\s*[:;\-]?\s*(.*)$/im);
  if (!m) return null;
  const v = m[1].replace(/<[^>]+>/g, '').replace(/[.\s]+$/, '').trim();
  return v || null;
}

// The log's own stated "Total Time" (fallback only). Handles "2 hours",
// "3hrs 1min", "1h 30m", or a bare "2:30" clock-style duration → minutes.
function parseStatedTotal(content) {
  const m = String(content || '').match(/total\s*time\s*[:;\-]?\s*(.+)/i);
  if (!m) return null;
  const v = m[1];
  let mins = 0, found = false;
  const h  = v.match(/(\d+(?:\.\d+)?)\s*(?:h\b|hr|hrs|hour|hours)/i);
  if (h)  { mins += Math.round(parseFloat(h[1]) * 60); found = true; }
  const mm = v.match(/(\d+)\s*(?:m\b|min|mins|minute|minutes)/i);
  if (mm) { mins += parseInt(mm[1], 10); found = true; }
  if (!found) { const c = v.match(/(\d{1,2})\s*[:;.]\s*(\d{2})/); if (c) { mins = parseInt(c[1], 10) * 60 + parseInt(c[2], 10); found = true; } }
  return found ? mins : null;
}

// Parse the message content → { division, shiftStart, shiftEnd, totalMinutes }.
// Total is COMPUTED from start→end (exact when both are Discord timestamps;
// clock times cross midnight by adding 24h). Falls back to the log's stated
// "Total Time:" when start/end can't both be resolved, so the site shows a real
// value instead of dashes.
function parsePatrolLog(content) {
  const start = shiftTime(content, 'start');
  const end   = shiftTime(content, 'end');
  let totalMinutes = null;
  if (start && end) {
    if (start.epoch != null && end.epoch != null) {
      totalMinutes = Math.max(0, Math.round((end.epoch - start.epoch) / 60));
    } else if (start.minutes != null && end.minutes != null) {
      const cross = (endMin, startMin) => ((endMin - startMin) % 1440 + 1440) % 1440;
      let diff = cross(end.minutes, start.minutes);
      // 12:xx ambiguity: a bare "12:01" after a late start almost always means
      // 00:01 (just past midnight), not 12:01 noon — e.g. 23:29 → 12:01 is 32
      // minutes, not 12h32m. Try the midnight reading and prefer the shorter,
      // more plausible shift length. Same for a bare "12:xx" start.
      if (end.hour === 12 && !end.hadMeridiem) { const alt = cross(end.minutes - 720, start.minutes); if (alt < diff) diff = alt; }
      if (start.hour === 12 && !start.hadMeridiem) { const alt = cross(end.minutes, start.minutes - 720); if (alt < diff && alt > 0) diff = alt; }
      totalMinutes = diff;
    }
  }
  if (totalMinutes == null) totalMinutes = parseStatedTotal(content);

  // Did the shift run past midnight? For clock times: ended earlier in the day
  // than it started. For Discord timestamps: start and end fall on different
  // calendar days (in the patrol timezone).
  let crossedMidnight = false;
  if (start && end) {
    if (start.epoch != null && end.epoch != null) {
      const dayOf = (sec) => { try { return new Intl.DateTimeFormat('en-CA', { timeZone: PATROL_TZ(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(sec * 1000)); } catch (e) { return String(Math.floor(sec / 86400)); } };
      crossedMidnight = dayOf(start.epoch) !== dayOf(end.epoch);
    } else if (start.minutes != null && end.minutes != null) {
      crossedMidnight = end.minutes < start.minutes;
    }
  }

  return {
    division:     parseDivision(content),
    shiftStart:   start ? start.label : null,
    shiftEnd:     end ? end.label : null,
    totalMinutes,
    crossedMidnight,
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
// If the Discord message already carries a tick/cross reaction from a reviewer,
// derive the verdict from it so the log isn't left PENDING. A ✅ → APPROVED,
// a ❌ → DENIED (approval wins if both are present). By default ANY such
// reaction is honoured (only staff react in a log channel); set
// FLP_REVIEWER_ROLE_IDS (and/or METHICOMM_ROLE_ID) to require the reactor to
// hold one of those roles — the bot's own reaction (a site verdict) always
// counts. Returns { status, by } or null.
const APPROVE_EMOJI = new Set(['✅', '☑️', '✔️']);
const DENY_EMOJI    = new Set(['❌', '✖️', '⛔', '🚫']);
async function reviewFromReactions(message) {
  try {
    const cache = message && message.reactions && message.reactions.cache;
    if (!cache || cache.size === 0) return null;
    let approve = null, deny = null;
    for (const r of cache.values()) {
      const n = r.emoji && r.emoji.name;
      if (APPROVE_EMOJI.has(n)) approve = r; else if (DENY_EMOJI.has(n)) deny = r;
    }
    if (!approve && !deny) return null;

    const roleIds = String(process.env.FLP_REVIEWER_ROLE_IDS || '')
      .split(',').map(s => s.trim()).filter(Boolean)
      .concat(process.env.METHICOMM_ROLE_ID ? [String(process.env.METHICOMM_ROLE_ID)] : []);

    async function reviewer(reaction) {
      if (!reaction) return null;
      if (!roleIds.length) return { name: 'Reviewed in Discord' }; // no restriction → honour presence
      try {
        const users = await reaction.users.fetch();
        for (const u of users.values()) {
          if (u.bot) return { name: 'MET Bot' }; // bot reaction = a site verdict
          const member = message.guild ? await message.guild.members.fetch(u.id).catch(() => null) : null;
          if (member && member.roles.cache.some(rr => roleIds.includes(String(rr.id)))) return { name: member.displayName || u.username };
        }
      } catch (e) { /* couldn't resolve reactors */ }
      return null;
    }

    const a = await reviewer(approve);
    if (a) return { status: 'APPROVED', by: a.name };
    const d = await reviewer(deny);
    if (d) return { status: 'DENIED', by: d.name };
    return null;
  } catch (e) { return null; }
}

// opts.status: 'APPROVED' writes the log straight in as approved (used by the
// historical backfill — no review queue, no sheet point award), stamped as
// imported. Default (live ingestion) creates it PENDING for review. A tick/cross
// reaction already on the message overrides both (→ APPROVED / DENIED).
async function createFromMessage(message, type = 'PATROL', opts = {}) {
  try {
    const existing = await prisma.patrolLog.findUnique({ where: { messageId: String(message.id) } }).catch(() => null);
    if (existing) return existing;

    const parsed  = parsePatrolLog(message.content || '');
    const display = (message.member && message.member.displayName) || message.author.globalName || message.author.username;
    // A tick/cross reaction already on the message decides the verdict; else the
    // caller's opts.status (backfill = APPROVED); else PENDING for live review.
    const verdict = await reviewFromReactions(message);
    const status = (verdict && verdict.status) || (opts.status === 'APPROVED' ? 'APPROVED' : 'PENDING');
    const reviewed = status === 'APPROVED' || status === 'DENIED';
    const reviewedByName = verdict ? verdict.by : (status === 'APPROVED' ? (opts.reviewedByName || 'Imported') : null);
    // The shift's date: an explicit date written in the log if present, else the
    // date the message was sent (Discord createdAt). For a shift that crossed
    // midnight this is the message-sent day (the shift started the night before).
    const logDate = parseLogDate(message.content || '') || message.createdAt || new Date();

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
        logDate:              logDate,
        crossedMidnight:      !!parsed.crossedMidnight,
        images:               imageUrls(message),
        rawContent:           (message.content || '').slice(0, 4000),
        status:               status,
        ...(reviewed ? { reviewedByName, reviewedAt: message.createdAt || new Date() } : {}),
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
  // Re-derive times from the raw content on every read, so parser improvements
  // apply retroactively to logs captured earlier (and correct any stale/wrong
  // stored value). Falls back to the stored value when re-parsing yields nothing.
  let shiftStart = p.shiftStart || null, shiftEnd = p.shiftEnd || null;
  let totalMinutes = p.totalMinutes, division = p.division;
  let crossedMidnight = !!p.crossedMidnight;
  // The log's date: stored logDate (explicit-in-log or message-sent), else fall
  // back to the row's createdAt so older rows still show something.
  let logDate = p.logDate || p.createdAt || null;
  if (p.rawContent) {
    try {
      const re = parsePatrolLog(p.rawContent);
      if (re.shiftStart) shiftStart = re.shiftStart;
      if (re.shiftEnd)   shiftEnd   = re.shiftEnd;
      if (re.totalMinutes != null) totalMinutes = re.totalMinutes;
      if (re.division)   division   = re.division;
      crossedMidnight = !!re.crossedMidnight;
      // An explicit date in the log always wins over the stored/message date.
      const explicit = parseLogDate(p.rawContent);
      if (explicit) logDate = explicit;
    } catch (e) { /* keep stored values */ }
  }
  const dateLabel = logDate ? (() => { try {
    return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: PATROL_TZ() }).format(new Date(logDate));
  } catch (e) { return null; } })() : null;
  return {
    id: p.id, type: p.type || 'PATROL', messageId: p.messageId, channelId: p.channelId,
    pointAwarded: !!p.pointAwarded,
    submitterDiscordId: p.submitterDiscordId,
    submitterUsername: p.submitterUsername, submitterDisplayName: p.submitterDisplayName,
    division: division || 'N/A',
    shiftStart: shiftStart, shiftEnd: shiftEnd,
    totalMinutes: totalMinutes, totalLabel: formatTotal(totalMinutes),
    logDate: logDate, dateLabel, crossedMidnight,
    images: Array.isArray(p.images) ? p.images : [],
    status: p.status, reviewedByName: p.reviewedByName, reviewedAt: p.reviewedAt,
    createdAt: p.createdAt,
  };
}

module.exports = { parseClock, shiftTime, parseDivision, parsePatrolLog, formatTotal, imageUrls, createFromMessage, serialize, robloxNameCandidates, awardMetEventPoint };
