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

// ── EVENT log parsing ─────────────────────────────────────────────────
// Event logs follow a semi-structured host template, e.g.:
//   8/10  <:FLP:…>              (a quota counter — ignored)
//   Event-Type: MP
//   Host: <@123>
//   Co-Host: N/A
//   Attendees: <@1> <@2> <@3>
//   Rank: SUP
//   Start-Time: 8:56           (already picked up by shiftTime())
//   End-Time: 9:26
//   NOTES: free text
//   Notes: <@4> <@5>           (sign-off / witness mentions)
function mentionsIn(str) {
  const out = []; const re = /<@!?(\d+)>/g; let m;
  while ((m = re.exec(String(str || ''))) !== null) out.push(m[1]);
  return out;
}

// Pull the raw fields (values + mention ids) out of an event-log message body.
function parseEventLog(content) {
  const lines = String(content || '').split(/\r?\n/);
  const val = (re) => { for (const l of lines) { const m = l.match(re); if (m) return (m[1] || '').trim(); } return null; };
  const clean = (s) => s ? s.replace(/<a?:\w+:\d+>/g, '').replace(/[*_`~]/g, '').trim() : null;

  const eventType = clean(val(/^\s*event[\s\-_]*type\s*[:\-]?\s*(.+)$/i));
  const rank      = clean(val(/^\s*rank\s*[:\-]?\s*(.+)$/i));
  const hostLine  = lines.find(l => /^\s*host\s*[:\-]/i.test(l)) || '';
  const coHostLine= lines.find(l => /^\s*co[\s\-_]*host\s*[:\-]/i.test(l)) || '';
  const attLine   = lines.find(l => /^\s*attend(?:ee|ees|ance)?\s*[:\-]/i.test(l)) || '';

  const coHostIds = mentionsIn(coHostLine);
  const coHostRaw = clean(coHostLine.replace(/^\s*co[\s\-_]*host\s*[:\-]?/i, ''));

  // Every "notes" line: free text → notesText, mentions → noteMentionIds.
  const noteLines = lines.filter(l => /^\s*notes?\s*[:\-]/i.test(l));
  const noteMentionIds = []; const notesTextParts = [];
  for (const l of noteLines) {
    noteMentionIds.push(...mentionsIn(l));
    const txt = clean(l.replace(/^\s*notes?\s*[:\-]?/i, '').replace(/<@!?\d+>/g, ''));
    if (txt) notesTextParts.push(txt);
  }

  return {
    eventType: eventType || null,
    rank: rank || null,
    hostId: mentionsIn(hostLine)[0] || null,
    coHostId: coHostIds[0] || null,
    coHostText: coHostIds.length ? null : (coHostRaw || null),
    attendeeIds: mentionsIn(attLine),
    noteMentionIds: [...new Set(noteMentionIds)],
    notesText: notesTextParts.join(' ') || null,
  };
}

// Server nickname of a resolved member (falls back to global/username).
function nickOf(gm) {
  if (!gm) return null;
  return gm.nickname || (gm.user && (gm.user.globalName || gm.user.username)) || null;
}
// Roblox username = the server nickname minus its "RANK | " prefix.
function robloxFromNick(nick) {
  if (!nick) return null;
  return nick.includes('|') ? nick.split('|').pop().trim() : nick.trim();
}
// Resolve a set of Discord ids to members: cached mentions first, then ONE bulk
// REST fetch for the rest (no privileged intent needed for id lookups).
async function resolveMembers(message, ids) {
  const map = new Map();
  const uniq = [...new Set((ids || []).filter(Boolean))];
  if (!uniq.length || !message.guild) return map;
  for (const id of uniq) {
    const gm = (message.mentions && message.mentions.members && message.mentions.members.get(id))
            || message.guild.members.cache.get(id);
    if (gm) map.set(id, gm);
  }
  const missing = uniq.filter(id => !map.has(id));
  if (missing.length) {
    try { (await message.guild.members.fetch({ user: missing })).forEach((gm, id) => map.set(id, gm)); }
    catch (e) { /* leave unresolved — the id still shows */ }
  }
  return map;
}
// A person entry for the event card. Keeps both the full nickname (host shows
// this, with its rank prefix) and the prefix-stripped Roblox username (attendees).
function personEntry(message, mentionUsers, id, map) {
  if (!id) return null;
  const gm = map.get(id);
  const user = (gm && gm.user) || (mentionUsers && mentionUsers.get(id)) || null;
  const nick = nickOf(gm);
  return {
    id,
    discordUsername: user ? user.username : null,
    nickname: nick,                 // full server nickname (with prefix)
    roblox: robloxFromNick(nick),   // nickname minus "RANK | " prefix
  };
}

// Build the resolved event-card metadata from a discord.js message.
async function buildEventMeta(message) {
  const ev = parseEventLog(message.content || '');
  const allIds = [ev.hostId, ev.coHostId, ...ev.attendeeIds, ...ev.noteMentionIds].filter(Boolean);
  const map = await resolveMembers(message, allIds);
  const users = message.mentions && message.mentions.users;
  const one = (id) => personEntry(message, users, id, map);
  return {
    eventType:   ev.eventType,
    rank:        ev.rank,
    host:        one(ev.hostId),
    coHost:      one(ev.coHostId),
    coHostText:  ev.coHostText,
    attendees:   ev.attendeeIds.map(one).filter(Boolean),
    notesText:   ev.notesText,
    noteMembers: ev.noteMentionIds.map(one).filter(Boolean),
  };
}

// Status comes from the message's tick/cross reaction: ✅ → APPROVED, ❌ →
// DENIED, none → PENDING. opts.reconcile updates an already-imported row's
// status/date from the message (so re-running the backfill corrects statuses),
// but never clobbers a manual site review.
const IMPORT_REVIEWERS = new Set(['Imported', 'Reviewed in Discord', 'MET Bot']);

async function createFromMessage(message, type = 'PATROL', opts = {}) {
  try {
    const messageId = String(message.id);
    const existing = await prisma.patrolLog.findUnique({ where: { messageId } }).catch(() => null);

    const parsed  = parsePatrolLog(message.content || '');
    const verdict = await reviewFromReactions(message);       // { status, by } | null
    const status  = verdict ? verdict.status : 'PENDING';     // tick/cross/none
    const reviewed = status !== 'PENDING';
    // The shift's date: an explicit date in the log if present, else the message-
    // sent date. For a shift past midnight this is the message-sent day.
    const logDate = parseLogDate(message.content || '') || message.createdAt || new Date();
    // EVENT logs: resolve the host template (host / co-host / attendees / notes)
    // into the pretty on-site card. Best-effort — never blocks ingestion.
    let eventMeta = null;
    if (type === 'EVENT') eventMeta = await buildEventMeta(message).catch(() => null);

    if (existing) {
      if (!opts.reconcile) return existing;
      // Only reconcile import-created rows — never overwrite a real site review.
      const humanReviewed = existing.reviewedByName && !IMPORT_REVIEWERS.has(existing.reviewedByName);
      const data = { logDate, crossedMidnight: !!parsed.crossedMidnight };
      if (eventMeta) data.eventMeta = eventMeta;
      if (!humanReviewed) {
        data.status = status;
        data.reviewedByName = reviewed ? verdict.by : null;
        data.reviewedAt = reviewed ? (message.createdAt || new Date()) : null;
      }
      return await prisma.patrolLog.update({ where: { id: existing.id }, data }).catch(() => existing);
    }

    const display = (message.member && message.member.displayName) || message.author.globalName || message.author.username;
    return await prisma.patrolLog.create({
      data: {
        type:                 type === 'EVENT' ? 'EVENT' : 'PATROL',
        messageId,
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
        eventMeta:            eventMeta,
        images:               imageUrls(message),
        rawContent:           (message.content || '').slice(0, 4000),
        status:               status,
        ...(reviewed ? { reviewedByName: verdict.by, reviewedAt: message.createdAt || new Date() } : {}),
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

// EVENT logs: on approval, add +1 to the member's current-day cell on the given
// division's sheet (via quotaConfig(division) → sheetId). The correct tab is
// found by SEARCHING every tab for the member's username — each member sits on
// exactly one rank tab (Chief Inspector / Inspector / …), so no rank lookup is
// needed. Best-effort. division ∈ {'FLP','MET','IA'} (default 'MET').
async function awardEventPoint(log, division = 'MET') {
  const q = require('./quota');
  const cfg = q.quotaConfig(division);
  const spreadsheetId = cfg.sheetId;
  if (!spreadsheetId) { console.warn(`[EventLog] no sheet configured for ${division} — skipping point.`); return { ok: false, reason: `${division} sheet not set`, division }; }
  try {
    const sheets = q.getSheetsClient(cfg);
    if (!sheets) return { ok: false, reason: 'Google Sheets not configured', division };
    const tz = cfg.timezone;

    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
    // If a specific tab is configured for the division, only search that one;
    // otherwise search every tab (per-rank tabs).
    const allTabs = (meta.data.sheets || []).map(s => s.properties.title);
    const tabs = cfg.sheetName ? allTabs.filter(t => t === cfg.sheetName) : allTabs;
    const candidates = robloxNameCandidates(log);
    if (!candidates.length) return { ok: false, reason: 'no username to match', division };

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
      if (dayCol == null) return { ok: false, reason: 'day column not found', tab, division };
      const cellRaw = (rows[rowIdx][dayCol] || '').toString().trim();
      if (cellRaw && isNaN(parseFloat(cellRaw))) return { ok: false, reason: `cell is "${cellRaw}" (e.g. EX) — left untouched`, tab, division };
      const newVal = (cellRaw ? parseFloat(cellRaw) : 0) + 1;
      await sheets.spreadsheets.values.update({
        spreadsheetId, range: `${tab}!${q.colLetter(dayCol)}${rowIdx + 1}`,
        valueInputOption: 'USER_ENTERED', requestBody: { values: [[newVal]] },
      });
      console.log(`[EventLog] +1 → ${division}:${tab} / ${candidates[0]} (now ${newVal})`);
      return { ok: true, tab, username: candidates[0], newVal, division };
    }
    return { ok: false, reason: 'member not found on any tab', division };
  } catch (err) {
    console.error('[EventLog] awardEventPoint failed:', err.message);
    return { ok: false, reason: err.message, division };
  }
}

// Award the event point to the sheet(s) named by EVENT_POINT_TARGET:
//   FLP (default) | MET | BOTH. Best-effort across each target; returns the
//   primary (first successful, else first) result plus a `results` array so
//   callers can see per-division outcomes.
// Approved EVENT logs award points through the division quota WEBHOOKS (so they
// work with the same setup the panels use — no service-account sharing needed):
//   • the HOST gets +EVENT_HOST_POINTS (default 1) in the FLP database
//   • every ATTENDEE listed on the log gets +EVENT_ATTENDEE_POINTS (default 1) in
//     the MET database
// Best-effort per person; a member who can't be matched on the sheet is skipped.
async function awardEventPoints(log) {
  const q = require('./quota');
  const meta = (log && log.eventMeta) || {};
  const HOST_POINTS = Number(process.env.EVENT_HOST_POINTS) || 1;
  const ATT_POINTS  = Number(process.env.EVENT_ATTENDEE_POINTS) || 1;

  const out = { host: null, hostDivision: 'FLP', attendeeDivision: 'MET', attendees: [] };

  // Host → FLP database.
  const host = meta.host || null;
  const hostDiscordId = (host && host.id) || log.submitterDiscordId || null;
  const hostRoblox    = (host && host.roblox) || null;
  if (hostDiscordId || hostRoblox) {
    try {
      out.host = !!(await q.addQuotaPoints({ discordId: hostDiscordId, robloxUsername: hostRoblox }, HOST_POINTS, 'event host', 'FLP'));
    } catch (e) { out.host = false; }
  }

  // Attendees → MET database (one point each, de-duplicated).
  const seen = new Set();
  for (const a of (Array.isArray(meta.attendees) ? meta.attendees : [])) {
    if (!a || (!a.id && !a.roblox)) continue;
    const key = (a.id || a.roblox || '').toString().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    let ok = false;
    try { ok = !!(await q.addQuotaPoints({ discordId: a.id || null, robloxUsername: a.roblox || null }, ATT_POINTS, 'event attendee', 'MET')); } catch (e) { ok = false; }
    out.attendees.push({ id: a.id || null, roblox: a.roblox || null, ok });
  }

  out.ok = out.host === true || out.attendees.some(x => x.ok);
  out.attendeesAwarded = out.attendees.filter(x => x.ok).length;
  return out;
}

// Back-compat: original name kept (writes to the MET database).
function awardMetEventPoint(log) { return awardEventPoint(log, 'MET'); }

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
    eventMeta: p.eventMeta || null,
    images: Array.isArray(p.images) ? p.images : [],
    status: p.status, reviewedByName: p.reviewedByName, reviewedAt: p.reviewedAt,
    createdAt: p.createdAt,
  };
}

module.exports = { parseClock, shiftTime, parseDivision, parsePatrolLog, formatTotal, imageUrls, createFromMessage, serialize, robloxNameCandidates, awardMetEventPoint, awardEventPoint, awardEventPoints, parseEventLog, buildEventMeta };
