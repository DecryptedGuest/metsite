// server/lib/ticketIngest.js
// Pulls "Ticket Closed" logs out of the IA ticket-logs Discord channel and
// stores them as TicketLog rows, so the site can show real closed tickets in
// All Tickets / My Tickets without anyone hand-logging anything.
//
// Nobody submits a ticket on the site — this mirrors what the Tickety bot
// already posts in Discord. A supervisor then approves or denies each log on
// the site (see routes/tickets.js), which awards the closer 2 quota points.
//
// Two paths keep it current:
//   * live   — bot.js forwards every new message in the log channel here.
//   * catch-up — a backfill sweep on boot and every few minutes, which pages
//     back through history until it reaches messages we already have. That is
//     what fills the table in the first place and what heals any gap caused by
//     downtime or a missed gateway event.

const prisma = require('./db');
const { parseTicketLogEmbed, transcriptUrlFromComponents } = require('./ticketLog');

const TICKET_LOG_GUILD_ID   = () => process.env.TICKET_LOG_GUILD_ID   || '1191048287315304470';
const TICKET_LOG_CHANNEL_ID = () => process.env.TICKET_LOG_CHANNEL_ID || '1455877424582492264';

// ── Where ticket logs come from ───────────────────────────────────
// Three servers now, not one. Internal Affairs handles tickets for the MET, for
// CID and for SCO-19, so all three land in the same queue and carry a tag
// saying which department they came out of. Each is overridable by env so a
// server move does not need a deploy.
const CID_TICKET_GUILD_ID   = () => process.env.CID_TICKET_LOG_GUILD_ID   || '1438215998338760887';
const CID_TICKET_CHANNEL_ID = () => process.env.CID_TICKET_LOG_CHANNEL_ID || '1438215999231885505';
const SCO_TICKET_GUILD_ID   = () => process.env.SCO_TICKET_LOG_GUILD_ID   || '1438247592071921919';
const SCO_TICKET_CHANNEL_ID = () => process.env.SCO_TICKET_LOG_CHANNEL_ID || '1438247593011581092';

/** Every configured ticket-log source, in the order they are swept. */
function ticketSources() {
  return [
    { division: 'MET', guildId: TICKET_LOG_GUILD_ID(),   channelId: TICKET_LOG_CHANNEL_ID() },
    { division: 'CID', guildId: CID_TICKET_GUILD_ID(),   channelId: CID_TICKET_CHANNEL_ID() },
    { division: 'SCO', guildId: SCO_TICKET_GUILD_ID(),   channelId: SCO_TICKET_CHANNEL_ID() },
  ].filter(s => s.guildId && s.channelId);
}

/** Is this channel one we ingest from? Returns its division, or null. */
function divisionForChannel(channelId) {
  const id = String(channelId || '');
  const hit = ticketSources().find(s => String(s.channelId) === id);
  return hit ? hit.division : null;
}

/**
 * The handler's rank, as their nickname printed it.
 *
 * Tickety prints the executor exactly as the server shows them: "DUC | Sirrto49",
 * "FCINS | Calebjayce7", "IA | DCI | White_Bullet8". The rank is everything
 * before the LAST separator — splitting on the first one would read
 * "IA | DCI | White_Bullet8" as rank "IA", losing the DCI.
 */
function rankFromRaw(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(/^@/, '');
  if (!s || !s.includes('|')) return null;
  const rank = s.slice(0, s.lastIndexOf('|')).trim();
  return rank || null;
}

// Site roles that mean "this person is Internal Affairs".
const IA_SITE_ROLES = new Set(['IA', 'SUPERVISOR', 'HICOMM', 'DEVELOPER']);

/**
 * Is the person who closed this ticket Internal Affairs?
 *
 * Quota points belong to IA, so a ticket a CID or SCO-19 officer handled is
 * still logged and still reviewed — it just pays nobody. Cheapest signal first:
 * their dashboard account, then the rank their own nickname printed, then a live
 * resolve. Never throws; unknown means "not IA", which only costs points that a
 * re-ingest can correct.
 */
async function resolveCloserIsIa({ discordId, siteRole, rank }) {
  if (siteRole && IA_SITE_ROLES.has(siteRole)) return true;
  // "IA | DCI | White_Bullet8" — the department is in the nickname itself.
  if (rank && /(^|\|)\s*ia\b/i.test(rank)) return true;
  if (!discordId) return false;
  try {
    const { resolveSiteRoleDetailed } = require('./roleResolver');
    const live = await resolveSiteRoleDetailed({ discordId: String(discordId), memberRoles: [] });
    return !!(live && live.role && IA_SITE_ROLES.has(live.role));
  } catch (e) { return false; }
}

// How far back the first (empty-table) backfill reaches. Later sweeps stop as
// soon as they hit a message that is already stored, so this only really
// applies to the very first run.
const FIRST_BACKFILL_LIMIT = () => {
  const n = parseInt(process.env.TICKET_LOG_BACKFILL || '1500', 10);
  return Number.isFinite(n) && n > 0 ? n : 1500;
};

// ── Parse a discord.js Message into a TicketLog row ───────────────
// Returns the row data, or null when the message isn't a closed-ticket log.
async function rowFromMessage(msg) {
  if (!msg) return null;

  let parsed = null;
  for (const embed of (msg.embeds || [])) {
    // The message's own content counts as part of the log. Some Tickety
    // configurations put the sentence naming the closer there and leave only the
    // ticket details in the embed, and reading the embed alone found no executor
    // on a message that named one in plain sight.
    const p = parseTicketLogEmbed(embed, msg.content || '');
    if (p) { parsed = p; break; }
  }
  if (!parsed) return null;

  const transcriptUrl = transcriptUrlFromComponents(msg.components) || null;

  // The creator's Roblox username, in descending order of confidence:
  //   1. the "RANK | RobloxUser" nickname Tickety already printed,
  //   2. their current server nickname, looked up by Discord id,
  //   3. RoVer (DB-first, cooldown-aware).
  let creatorRoblox = null;
  try {
    const { parseRankNick, getRobloxNameFromNick } = require('./bot');
    if (parsed.creatorRaw && parsed.creatorRaw.includes('|')) {
      creatorRoblox = parseRankNick(parsed.creatorRaw).robloxUsername || null;
    }
    if (!creatorRoblox && parsed.creatorId) {
      creatorRoblox = (await getRobloxNameFromNick(parsed.creatorId)) || null;
    }
    if (!creatorRoblox && parsed.creatorId) {
      const { getRobloxIdFromDiscord, getRobloxUserInfo } = require('./roblox');
      const rid = await getRobloxIdFromDiscord(parsed.creatorId);
      if (rid) { const info = await getRobloxUserInfo(rid); creatorRoblox = info?.username || null; }
    }
  } catch (e) { /* best-effort — the row is still worth storing */ }

  // Who handled it. This column is the one people scan the queue by, and a
  // blank in it is useless — so every source is tried, in descending order of
  // how current the name is, and the log's own words are the floor:
  //
  //   1. their MET Dashboard account   (a display name they chose)
  //   2. the live member record        (their server nickname right now)
  //   3. a live guild fetch            (in case the record cache is cold)
  //   4. what the log printed          (always there when it named anybody)
  //   5. the bare Discord id           (better than an em dash)
  //
  // Only closerUserId being null is acceptable — that just means the closer has
  // no site account, which is normal and only affects "My Tickets".
  let closerUserId = null, closerUsername = null, closerSiteRole = null;
  const closerRaw = parsed.executorRaw || null;

  // The log named nobody. One more place to look before giving up: if the log was
  // posted in response to somebody running a command or pressing a button, the
  // gateway tells us who that was, and that person is who closed the ticket.
  if (!parsed.executorId) {
    const via = msg.interactionMetadata || msg.interaction || null;
    const uid = via && (via.user?.id ?? via.userId ?? via.authorizingUserId ?? null);
    if (uid && /^\d{15,21}$/.test(String(uid))) parsed.executorId = String(uid);
  }

  if (parsed.executorId) {
    try {
      const u = await prisma.user.findUnique({
        where:  { discordId: String(parsed.executorId) },
        select: { id: true, displayName: true, discordUsername: true, role: true },
      });
      if (u) {
        closerUserId = u.id;
        closerUsername = u.displayName || u.discordUsername || null;
        closerSiteRole = u.role || null;
      }
    } catch (e) { /* unmatched closers are fine — they just have no owner */ }

    if (!closerUsername) {
      try {
        const { getMemberRecord } = require('./bot');
        const rec = await getMemberRecord(parsed.executorId);
        closerUsername = (rec && (rec.displayName || rec.username)) || null;
      } catch (e) { /* keep going */ }
    }

    if (!closerUsername) {
      try {
        const { getGuildMemberInfo } = require('./bot');
        const gid = process.env.MET_GUILD_ID || process.env.DISCORD_GUILD_ID;
        const info = gid && typeof getGuildMemberInfo === 'function'
          ? await getGuildMemberInfo(parsed.executorId, gid) : null;
        closerUsername = (info && (info.displayName || info.nickname || info.username)) || null;
      } catch (e) { /* keep going */ }
    }
  }

  // The floor. A row that names nobody is a row nobody can action.
  if (!closerUsername) closerUsername = closerRaw || (parsed.executorId ? String(parsed.executorId) : null);

  const closedAt = msg.createdAt
    ? new Date(msg.createdAt)
    : new Date(msg.createdTimestamp || Date.now());

  // Which department's logs this came out of, and — when the handler is not IA
  // — what rank they hold there, so a CID ticket closed by a CID officer still
  // names who at what rank.
  const division = divisionForChannel(msg.channelId) || 'MET';
  const closerRank = rankFromRaw(closerRaw) || rankFromRaw(closerUsername) || null;
  const closerIsIa = await resolveCloserIsIa({
    discordId: parsed.executorId, siteRole: closerSiteRole, rank: closerRank,
  });

  return {
    messageId:             String(msg.id),
    channelId:             msg.channelId ? String(msg.channelId) : TICKET_LOG_CHANNEL_ID(),
    division,
    closerRank,
    closerIsIa,
    ticketRef:             parsed.ticketId || null,
    ticketName:            parsed.effectiveName || parsed.ticketName || null,
    ticketType:            parsed.ticketType || 'GENERAL_SUPPORT',
    reason:                parsed.reason || null,
    transcriptUrl,
    creatorDiscordId:      parsed.creatorId || null,
    creatorUsername:       parsed.creatorUsername || null,
    creatorRobloxUsername: creatorRoblox,
    closerDiscordId:       parsed.executorId || null,
    closerUsername,
    closerRaw,
    closerUserId,
    closedAt,
    raw: {
      ticketName: parsed.ticketName || null,
      oldName:    parsed.oldName || null,
      newName:    parsed.newName || null,
      creatorRaw: parsed.creatorRaw || null,
      // Only when nobody could be identified. Every source has been tried by
      // this point, so a blank here is the log's own fault — and the only way to
      // fix a parser for a shape you cannot see is to keep the shape. Bounded,
      // because this is a diagnostic, not an archive.
      ...(closerUsername ? {} : {
        noExecutor: {
          at:   new Date().toISOString(),
          text: String(parsed.sourceText || '').slice(0, 1500),
        },
      }),
    },
  };
}

// Fields that a transient lookup failure can leave null. When re-ingesting an
// existing row we must never overwrite a good stored value with null — RoVer
// being rate-limited for one sweep would otherwise erase every creator name.
const RESOLVED_FIELDS = [
  'ticketRef', 'ticketName', 'reason', 'transcriptUrl',
  'creatorDiscordId', 'creatorUsername', 'creatorRobloxUsername',
  'closerDiscordId', 'closerUsername', 'closerRaw', 'closerUserId',
  // The handler's rank is parsed from what the log printed, so it is only null
  // when the log named nobody — never overwrite a good one with that.
  'closerRank',
];

// The next readable ticket number, from a Postgres sequence — concurrent
// ingests can't collide on it and there are no gaps to reason about.
// Whether we have already tried to create the sequence this process. One
// attempt is enough — retrying per row would hammer the database.
let _seqChecked = false;

async function nextTicketNo() {
  try {
    const r = await prisma.$queryRaw`SELECT nextval('ticket_log_no_seq')::int AS n`;
    return r && r[0] ? Number(r[0].n) : null;
  } catch (e) {
    // The sequence is missing. This is not hypothetical: `prisma db push` syncs
    // the schema's columns and enums but never runs a migration's hand-written
    // SQL, so a deployment done that way has the ticketNo COLUMN and no
    // sequence to fill it — which is how nine thousand rows ended up numbered
    // null. Create it once, seeded past whatever is already stored, then retry.
    if (!_seqChecked) {
      _seqChecked = true;
      try {
        const top = await prisma.ticketLog.aggregate({ _max: { ticketNo: true } });
        const start = (top && top._max && top._max.ticketNo ? top._max.ticketNo : 0) + 1;
        await prisma.$executeRawUnsafe(
          `CREATE SEQUENCE IF NOT EXISTS ticket_log_no_seq START WITH ${Math.max(1, start)}`);
        console.warn('[TicketLogs] ticket_log_no_seq was missing · created it, starting at ' + start);
        const again = await prisma.$queryRaw`SELECT nextval('ticket_log_no_seq')::int AS n`;
        return again && again[0] ? Number(again[0].n) : null;
      } catch (e2) {
        console.error('[TicketLogs] could not create ticket_log_no_seq:', e2.message);
      }
    }
    // Still no sequence. A log without a number is still worth storing.
    return null;
  }
}

/**
 * Give a number to every stored log that has none.
 *
 * Rows written while the sequence was missing carry ticketNo = null, so the
 * table shows Tickety's random id instead of "#0001". Numbering them by the
 * order they were closed is the only ordering that means anything.
 */
async function backfillTicketNumbers(limit = 20000) {
  const rows = await prisma.ticketLog.findMany({
    where: { ticketNo: null }, orderBy: { closedAt: 'asc' },
    select: { id: true }, take: limit,
  });
  if (!rows.length) return { numbered: 0 };
  let numbered = 0;
  for (const r of rows) {
    const n = await nextTicketNo();
    if (n == null) break;                       // no sequence — stop, don't spin
    try {
      await prisma.ticketLog.update({ where: { id: r.id }, data: { ticketNo: n } });
      numbered++;
    } catch (e) { /* a clash just means that number is taken; move on */ }
  }
  console.log(`[TicketLogs] numbered ${numbered} log(s) that had none`);
  return { numbered };
}

/**
 * Renumber EVERY log in the order the tickets were actually closed.
 *
 * The numbers came out backwards, and there was never a way for them not to.
 * Numbers are handed out by a sequence as rows are stored, and the sweep reads
 * the Discord channel the way Discord serves it — newest message first — so the
 * newest ticket in the channel was the first row created and got #0001, and the
 * oldest ticket got the highest number. On a newest-first table that reads as a
 * countdown, which is the opposite of what a ticket number is for.
 *
 * Nothing incremental fixes that: the order the rows were CREATED in is wrong,
 * so the numbers have to be reassigned from the one ordering that means
 * something — closedAt, ascending. Oldest ticket is #0001, and the newest
 * ticket therefore carries the highest number, at the top of the table.
 *
 * Done in two statements because ticketNo is UNIQUE: assigning 1..N while some
 * row still holds a number in that range would collide, so every existing
 * number is parked a billion higher first, leaving 1..N free. The sequence is
 * then set past the new maximum so live ingests carry on above it.
 */
async function renumberTickets() {
  const total = await prisma.ticketLog.count();
  if (!total) return { renumbered: 0, total: 0 };

  // Park the current numbers out of the way. The `< 1000000000` guard makes this
  // safe to run twice — a second pass finds nothing left to park.
  await prisma.$executeRawUnsafe(
    `UPDATE ticket_logs SET "ticketNo" = "ticketNo" + 1000000000
      WHERE "ticketNo" IS NOT NULL AND "ticketNo" < 1000000000`);

  // Oldest closed ticket first. createdAt then id break ties, so two tickets
  // closed in the same second always come out in the same order.
  const renumbered = await prisma.$executeRawUnsafe(
    `UPDATE ticket_logs t SET "ticketNo" = s.rn
       FROM (SELECT id, row_number() OVER (ORDER BY "closedAt" ASC, "createdAt" ASC, id ASC) AS rn
               FROM ticket_logs) s
      WHERE t.id = s.id`);

  // And leave the sequence above the new top, or the next live ingest hands out
  // a number that is already taken.
  try {
    await prisma.$executeRawUnsafe(`CREATE SEQUENCE IF NOT EXISTS ticket_log_no_seq`);
    await prisma.$queryRawUnsafe(
      `SELECT setval('ticket_log_no_seq', GREATEST((SELECT COALESCE(MAX("ticketNo"), 0) FROM ticket_logs), 1), true)`);
  } catch (e) {
    console.warn('[TicketLogs] renumbered, but could not move the sequence:', e.message);
  }

  console.log(`[TicketLogs] renumbered ${renumbered} log(s) oldest-first · #0001 is now the oldest ticket`);
  return { renumbered: Number(renumbered) || 0, total };
}

/**
 * Clear the backlog so the queue starts from now.
 *
 * A thousand logs nobody was ever going to work through is not a queue, it is
 * a wall. Everything already waiting is marked APPROVED — not deleted, not
 * denied, and deliberately not left as an eternal to-do. `voidedAt` is stamped
 * so the row still says WHY it is approved: nobody reviewed it, the backlog was
 * cleared.
 *
 * No points are awarded. Approval normally pays the closer two quota points,
 * and paying out for a thousand historical tickets in one go would be a
 * fabricated week's work for everybody in the backlog. Future logs arrive
 * PENDING and pay on approval exactly as before.
 *
 * @returns {Promise<{ cleared: number }>}
 */
// ── The backlog watermark ─────────────────────────────────────────
// Clearing the backlog once was not enough, and could never have been. The
// clear only changed the rows that existed at the time; the next full sync
// re-read the whole Discord channel, found thousands of logs it had never
// stored, and created every one of them PENDING. The wall came straight back.
//
// So a clear records WHEN it happened, and every row ingested afterwards for a
// ticket closed before that moment arrives already cleared. The queue can only
// ever contain tickets closed since somebody last drew the line, whatever a
// sync turns up.
const BACKLOG_KEY = 'tickets.backlogClearedAt';
let _watermark = null;         // cached; null = not loaded, 0 = none set

async function backlogClearedAt() {
  if (_watermark !== null) return _watermark || null;
  try {
    const row = await prisma.systemSetting.findUnique({ where: { key: BACKLOG_KEY } });
    const t = row && Date.parse(row.value);
    _watermark = Number.isFinite(t) ? new Date(t) : 0;
  } catch (e) { _watermark = 0; }
  return _watermark || null;
}

async function setBacklogClearedAt(when) {
  const at = when || new Date();
  await prisma.systemSetting.upsert({
    where:  { key: BACKLOG_KEY },
    update: { value: at.toISOString() },
    create: { key: BACKLOG_KEY, value: at.toISOString() },
  });
  _watermark = at;
  return at;
}

// What a freshly-ingested row's status should be. Anything closed before the
// line somebody drew is history, not a decision waiting to be made.
async function statusForNewRow(closedAt) {
  const line = await backlogClearedAt();
  if (!line || !closedAt || new Date(closedAt) >= line) return null;   // normal: PENDING
  return {
    status: 'APPROVED',
    voidedAt: new Date(),
    reviewedAt: new Date(),
    reviewedByName: 'Backlog cleared',
  };
}

/**
 * Clear the pending queue, in bounded batches.
 *
 * This used to be one updateMany over the whole queue. At a hundred rows that
 * is fine; at nine thousand it is a single statement rewriting nine thousand
 * rows and their indexes, and the first thing in the stack with a timeout —
 * a connection pooler, a proxy, the browser — kills it. The write rolls back,
 * the request dies, and from the outside the button did nothing. Which is
 * exactly what it looked like.
 *
 * So it works in slices. Each statement touches at most `batch` rows and
 * commits on its own, `maxRows` bounds how much one call attempts, and the
 * count still waiting comes back so the caller can go again. Nothing is
 * all-or-nothing any more: a run that dies half way leaves half the queue
 * genuinely cleared, and pressing again picks up where it stopped.
 *
 * @param {Date}   [when]            only clear tickets closed before this
 * @param {object} [opts]
 * @param {number} [opts.batch=500]  rows per statement
 * @param {number} [opts.maxRows]    stop after this many in one call
 * @param {boolean}[opts.all=false]  ignore `when` — clear everything pending
 * @returns {Promise<{cleared:number, remaining:number, done:boolean, clearedBefore:Date}>}
 */
async function clearBacklogBefore(when, opts = {}) {
  const cutoff  = when || new Date();
  const batch   = Math.min(Math.max(parseInt(opts.batch, 10) || 500, 50), 2000);
  const maxRows = Math.max(parseInt(opts.maxRows, 10) || 5000, batch);

  // `all` exists because a cutoff can strand rows: a ticket whose closedAt is
  // in the future (clock skew on the log, a bad parse) is never < cutoff and
  // would sit in the queue forever, un-clearable, with no way to see why.
  const where = opts.all ? { status: 'PENDING' } : { status: 'PENDING', closedAt: { lt: cutoff } };
  const sqlFilter = opts.all
    ? `status = 'PENDING'::"TicketStatus"`
    : `status = 'PENDING'::"TicketStatus" AND "closedAt" < '${cutoff.toISOString()}'::timestamp`;
  const SET = `status = 'APPROVED'::"TicketStatus", "voidedAt" = NOW(), `
            + `"reviewedAt" = NOW(), "reviewedByName" = 'Backlog cleared'`;

  // FIVE ways to perform the same update, tried in order.
  //
  // Not belt and braces for its own sake. This clear has now reported "cleared
  // 0" against a queue of nine thousand rows that every COUNT — Prisma's and
  // the database's own — agrees are sitting right there, with no error from
  // either path. A statement that matches nothing while the rows plainly match
  // is not something I can reason my way to from here, so instead of picking
  // one more mechanism and hoping, the clear tries every mechanism there is and
  // RECORDS what each one did. Whichever works, works; and if none of them
  // does, the answer comes back with the response instead of another silent
  // zero.
  //
  // Ordered cheapest and most bounded first:
  //   1 id-subquery   the ordinary bounded UPDATE
  //   2 ctid          the same thing keyed on the physical row pointer, which
  //                   sidesteps anything odd about the id column or its index
  //   3 raw id list   ids read by the ORM, updated in raw SQL — this is the one
  //                   that proves whether the two layers are seeing the same
  //                   rows, because the ids come from one and the write from
  //                   the other
  //   4 ORM           updateMany over that same id list
  //   5 one row       a single ORM update, purely to surface the error that a
  //                   bulk statement swallows as "0 rows"
  const strategies = [
    { name: 'id-subquery', run: async (take) => prisma.$executeRawUnsafe(
        `UPDATE ticket_logs SET ${SET}
         WHERE id IN (SELECT id FROM ticket_logs WHERE ${sqlFilter} LIMIT ${take})`) },
    { name: 'ctid', run: async (take) => prisma.$executeRawUnsafe(
        `UPDATE ticket_logs SET ${SET}
         WHERE ctid IN (SELECT ctid FROM ticket_logs WHERE ${sqlFilter} LIMIT ${take})`) },
    { name: 'raw-id-list', run: async (take) => {
        const ids = await prisma.ticketLog.findMany({ where, select: { id: true }, take });
        if (!ids.length) return 0;
        const list = ids.map(r => `'${String(r.id).replace(/'/g, "''")}'`).join(',');
        return prisma.$executeRawUnsafe(`UPDATE ticket_logs SET ${SET} WHERE id IN (${list})`);
      } },
    { name: 'orm', run: async (take) => {
        const ids = await prisma.ticketLog.findMany({ where, select: { id: true }, take });
        if (!ids.length) return 0;
        const res = await prisma.ticketLog.updateMany({
          where: { id: { in: ids.map(r => r.id) } },
          data: { status: 'APPROVED', voidedAt: new Date(), reviewedAt: new Date(), reviewedByName: 'Backlog cleared' },
        });
        return res.count;
      } },
    { name: 'one-row', run: async () => {
        const row = await prisma.ticketLog.findFirst({ where, select: { id: true } });
        if (!row) return 0;
        await prisma.ticketLog.update({
          where: { id: row.id },
          data: { status: 'APPROVED', voidedAt: new Date(), reviewedAt: new Date(), reviewedByName: 'Backlog cleared' },
        });
        return 1;
      } },
    // Last resort, and only ever reached because the four bounded mechanisms
    // above all moved nothing: the plainest statement Postgres can be given —
    // no subquery, no id list, no LIMIT. If something about the bounded form
    // is what the planner is choking on, this is the one that works. It is not
    // first because it is unbounded, so it carries its own timeout; the whole
    // reason the clear is batched is that one long statement is what a pooler
    // kills, and a killed statement rolls back and looks like nothing happened.
    { name: 'whole-table', run: async () => {
        return prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '120s'`);
          return tx.$executeRawUnsafe(`UPDATE ticket_logs SET ${SET} WHERE ${sqlFilter}`);
        }, { timeout: 130000 });
      } },
  ];

  let cleared = 0;
  let via = null;
  const errors = [];
  // What each strategy actually did, every round. A strategy that runs cleanly
  // and moves nothing is recorded too — that silence is exactly the thing that
  // has been impossible to see from the outside.
  const attempts = [];
  // Once one of them works, stay on it: no point re-running four that don't.
  let chosen = null;

  while (cleared < maxRows) {
    const take = Math.max(1, Math.min(batch, maxRows - cleared) | 0);
    let n = 0;
    let moved = false;

    for (const st of (chosen ? [chosen] : strategies)) {
      let got = null, err = null;
      try { got = await st.run(take); }
      catch (e) { err = e.message; }
      attempts.push({ strategy: st.name, rows: got, error: err });
      if (err) { errors.push(`${st.name}: ${err}`); continue; }
      if (got) { n = got; moved = true; chosen = st; via = via || st.name; break; }
      // Ran fine, moved nothing. If there is genuinely nothing left to match,
      // that is the end of the queue rather than a failure — check before
      // escalating to the next mechanism.
      const left = await prisma.ticketLog.count({ where });
      if (!left) { moved = false; n = 0; break; }
      errors.push(`${st.name}: matched 0 of ${left} rows that are still pending`);
    }

    if (!moved) break;
    cleared += n;
    if (n < take) break;   // that was the last of them
  }

  const remaining = await prisma.ticketLog.count({ where });

  // Nothing moved and rows remain. At that point the only useful thing left to
  // report is what the DATABASE says about itself: who we are connected as,
  // whether that role may write to this table at all, and whether anything is
  // sitting between the statement and the row. Row-level security, a rule, or a
  // BEFORE-UPDATE trigger that returns NULL all produce precisely this symptom
  // — an UPDATE that succeeds and affects nothing.
  let probe = null;
  if (!cleared && remaining) {
    probe = await probeTicketTable().catch(e => ({ probeError: e.message }));
    console.error('[TicketLogs] backlog clear moved NOTHING ·', JSON.stringify({ attempts, probe }));
  }

  // Draw the line, so a later sync cannot rebuild what was just cleared. Only
  // once the queue is actually empty — drawing it half way would pre-clear
  // rows that a resumed run still has to account for.
  if (!remaining) {
    await setBacklogClearedAt(cutoff).catch(e =>
      console.warn('[TicketLogs] could not record the backlog watermark:', e.message));
  }

  console.log(`[TicketLogs] cleared ${cleared} pending log(s)`
    + (opts.all ? '' : ` closed before ${cutoff.toISOString()}`)
    + ` (approved, no points, via ${via || 'nothing'}) · ${remaining} still waiting`
    + (errors.length ? ` · errors: ${errors.join(' | ')}` : ''));
  return {
    cleared, remaining, done: remaining === 0, clearedBefore: cutoff,
    // Which path did the work, what every path did, and anything that went
    // wrong on the way. Returned rather than logged-and-forgotten because the
    // server log is not where the person pressing the button is looking.
    via, errors, attempts, probe,
  };
}

/**
 * Ask the database why an UPDATE it accepted changed nothing.
 *
 * Everything here is a silent-zero cause: a role without UPDATE on the table
 * (Postgres raises an error for that, but not for the RLS variant), row-level
 * security with a SELECT policy and no UPDATE policy, a rewrite RULE, or a
 * BEFORE UPDATE trigger that returns NULL. It also confirms which database and
 * schema the writes are actually going to, so "the app is pointed somewhere
 * else" stops being a theory.
 */
async function probeTicketTable() {
  const one = async (sql) => {
    try { const r = await prisma.$queryRawUnsafe(sql); return r && r[0] ? r[0] : null; }
    catch (e) { return { error: e.message }; }
  };
  const who = await one(`SELECT current_user::text AS role, session_user::text AS login,
                                current_database()::text AS db, current_schema()::text AS schema,
                                pg_is_in_recovery() AS replica,
                                current_setting('transaction_read_only')::text AS read_only`);
  const priv = await one(`SELECT has_table_privilege('ticket_logs','UPDATE') AS can_update,
                                 has_table_privilege('ticket_logs','SELECT') AS can_select`);
  const rls = await one(`SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS rls_forced,
                                (SELECT COUNT(*)::int FROM pg_policies p
                                  WHERE p.tablename = 'ticket_logs') AS policies,
                                (SELECT COUNT(*)::int FROM pg_trigger t
                                  WHERE t.tgrelid = c.oid AND NOT t.tgisinternal) AS triggers,
                                (SELECT COUNT(*)::int FROM pg_rules r
                                  WHERE r.tablename = 'ticket_logs') AS rules
                           FROM pg_class c
                           JOIN pg_namespace n ON n.oid = c.relnamespace
                          WHERE c.relname = 'ticket_logs' AND n.nspname = current_schema()`);
  return { ...(who || {}), ...(priv || {}), ...(rls || {}) };
}

/**
 * Merge duplicate rows that are the same real ticket.
 *
 * One closed ticket produced more than one row because the only thing making a
 * row unique was the MESSAGE id, and a ticket can be logged more than once.
 * This groups what is already stored by the thing that actually identifies a
 * ticket — Tickety's own id, and the transcript link where there is no id — and
 * folds each group down to one row.
 *
 * Which row survives is not arbitrary. The keeper is the one carrying the most
 * information, because the whole point of the merge is not to lose any:
 *
 *   1. a row somebody has already decided beats a pending one — a decision is
 *      the one thing here that cannot be reconstructed
 *   2. then a row that names its handler
 *   3. then a row with a transcript
 *   4. then the lowest ticket number, so the number people have already seen in
 *      the queue is the number that stays
 *
 * Anything the keeper is missing is copied off the rows being removed before
 * they go, so a duplicate that knew the handler hands it over rather than taking
 * it with it.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun]  report what it would do, change nothing
 * @param {number}  [opts.limit]   groups per call
 * @returns {Promise<{groups, merged, removed, kept, dryRun, examples}>}
 */
async function mergeDuplicates(opts = {}) {
  const dryRun = !!opts.dryRun;
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 500, 1), 5000);

  // Group by ticketRef, then by transcript for the rows that have no ref. Two
  // passes rather than one COALESCE so a row with neither is never grouped with
  // another row that also has neither.
  const groups = [];
  for (const key of ['ticketRef', 'transcriptUrl']) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT "${key}" AS k, COUNT(*)::int AS n
         FROM ticket_logs
        WHERE "${key}" IS NOT NULL AND "${key}" <> ''
          ${key === 'transcriptUrl' ? `AND ("ticketRef" IS NULL OR "ticketRef" = '')` : ''}
        GROUP BY "${key}"
        HAVING COUNT(*) > 1
        ORDER BY COUNT(*) DESC
        LIMIT ${limit}`);
    for (const r of (rows || [])) groups.push({ by: key, key: r.k, count: Number(r.n) });
  }

  let merged = 0, removed = 0;
  const examples = [];

  for (const g of groups) {
    const where = g.by === 'ticketRef'
      ? { ticketRef: g.key }
      : { transcriptUrl: g.key, OR: [{ ticketRef: null }, { ticketRef: '' }] };
    const rows = await prisma.ticketLog.findMany({ where, orderBy: { createdAt: 'asc' } });
    if (rows.length < 2) continue;

    const score = (r) => (
      (r.status !== 'PENDING' && r.reviewedByName !== 'Backlog cleared' ? 8 : 0)
      + (r.closerUsername ? 4 : 0)
      + (r.transcriptUrl ? 2 : 0)
      + (r.closerDiscordId ? 1 : 0)
    );
    const keeper = rows.slice().sort((a, b) =>
      score(b) - score(a)
      || (a.ticketNo == null ? Infinity : a.ticketNo) - (b.ticketNo == null ? Infinity : b.ticketNo)
      || new Date(a.createdAt) - new Date(b.createdAt))[0];
    const losers = rows.filter(r => r.id !== keeper.id);

    // Everything the keeper is short of, taken off the ones going away.
    const patch = {};
    for (const f of RESOLVED_FIELDS) {
      if (keeper[f] != null) continue;
      const donor = losers.find(r => r[f] != null);
      if (donor) patch[f] = donor[f];
    }
    // The lowest number in the group, so the reference people have seen sticks.
    const lowest = rows.map(r => r.ticketNo).filter(n => n != null).sort((a, b) => a - b)[0];
    if (lowest != null && keeper.ticketNo !== lowest) patch.ticketNo = lowest;

    if (examples.length < 10) {
      examples.push({
        by: g.by, key: g.key, of: rows.length,
        keeping: keeper.ticketNo != null ? '#' + keeper.ticketNo : keeper.id.slice(0, 8),
        gains: Object.keys(patch),
      });
    }

    if (!dryRun) {
      // The losers go first, so freeing the number cannot collide with taking it.
      await prisma.quotaAward.deleteMany({
        where: { refType: 'ticket', refId: { in: losers.map(r => r.id) } },
      }).catch(() => {});
      await prisma.ticketLog.deleteMany({ where: { id: { in: losers.map(r => r.id) } } });
      if (Object.keys(patch).length) {
        await prisma.ticketLog.update({ where: { id: keeper.id }, data: patch }).catch(async (e) => {
          // A number clash can only be the unique index on ticketNo; keep the
          // row's own number rather than losing the merge over cosmetics.
          if (e && e.code === 'P2002') {
            delete patch.ticketNo;
            if (Object.keys(patch).length) {
              await prisma.ticketLog.update({ where: { id: keeper.id }, data: patch }).catch(() => {});
            }
          }
        });
      }
    }
    merged++;
    removed += losers.length;
  }

  console.log(`[TicketLogs] duplicate merge${dryRun ? ' (dry run)' : ''} · `
    + `${groups.length} group(s), ${merged} merged, ${removed} row(s) removed`);
  return { groups: groups.length, merged, removed, kept: merged, dryRun, examples };
}

/**
 * Fill in the handler on rows that have none.
 *
 * The column has to name somebody, and one repair pass was not enough to make
 * that true. Rows ingested by older code can have closerDiscordId AND closerRaw
 * both null — the executor was never captured — and no amount of resolving from
 * stored columns can invent it. Those are the rows still reading "Not recorded"
 * next to a Discord log that plainly says who closed the ticket.
 *
 * So this has two stages, and the second is the one that makes it permanent:
 *
 *   1. Resolve from what is stored: site account → live member record → the
 *      captured executor text → the bare id.
 *   2. When that yields nothing, GO BACK TO THE SOURCE. messageId and channelId
 *      are on every row, so the original embed can be refetched and re-parsed
 *      with today's parser. A row whose message still exists can always be
 *      attributed, whatever version of the code first stored it.
 *
 * Stage 2 costs a Discord fetch per row, so it only runs for rows stage 1 could
 * not touch — in practice a handful, once.
 *
 * @param {number} [limit]
 * @param {object} [opts]
 * @param {boolean} [opts.refetch=true] allow stage 2
 * @returns {Promise<{ fixed: number, refetched: number, stillBlank: number, checked: number }>}
 */
// Rows whose handler column is empty — the ones that render as "Not recorded".
const BLANK_HANDLER = { OR: [{ closerUsername: null }, { closerUsername: '' }] };

// Where the rotating pass got to. The sweep only takes a small slice each time,
// and it used to take the SAME slice each time: the newest blank rows, ordered by
// closedAt desc, take 25. When those 25 are genuinely unattributable — a log that
// named nobody, a message since deleted — the sweep re-checked exactly those 25
// every five minutes forever and never looked at row 26. Every fixable row below
// them stayed "Not recorded" indefinitely, which is the bug.
let _handlerCursor = 0;

async function backfillHandlers(limit = 5000, opts = {}) {
  const allowRefetch = opts.refetch !== false;
  const rotate       = opts.rotate === true;
  // Re-reading Discord for a row we already re-read, and which already told us
  // the log names nobody, is a wasted request every time. `force` is for when the
  // parser itself has changed and the answer might genuinely differ.
  const force        = opts.force === true;

  if (rotate) {
    const blank = await prisma.ticketLog.count({ where: BLANK_HANDLER }).catch(() => 0);
    if (!blank || _handlerCursor >= blank) _handlerCursor = 0;
  }

  const rows = await prisma.ticketLog.findMany({
    where: BLANK_HANDLER,
    orderBy: [{ closedAt: 'desc' }, { id: 'asc' }],
    take: limit,
    skip: rotate ? _handlerCursor : 0,
  });
  // Advance past what we just looked at, so the next sweep starts where this one
  // stopped and the whole table gets covered.
  if (rotate) _handlerCursor = rows.length < limit ? 0 : _handlerCursor + rows.length;

  let fixed = 0, refetched = 0, stillBlank = 0, skippedProbed = 0;

  for (const r of rows) {
    let name = null;
    let patch = {};

    if (r.closerDiscordId) {
      try {
        const u = await prisma.user.findUnique({
          where: { discordId: String(r.closerDiscordId) },
          select: { displayName: true, discordUsername: true },
        });
        name = (u && (u.displayName || u.discordUsername)) || null;
      } catch (e) { /* keep going */ }
      if (!name) {
        try {
          const { getMemberRecord } = require('./bot');
          const rec = await getMemberRecord(r.closerDiscordId);
          name = (rec && (rec.displayName || rec.username)) || null;
        } catch (e) { /* keep going */ }
      }
      if (!name) name = r.closerRaw || String(r.closerDiscordId);
    } else if (r.closerRaw) {
      name = r.closerRaw;
    }

    // Stage 2 — the row stores no executor at all. The message might.
    const probed = !!(r.raw && r.raw.noExecutor);
    if (!name && allowRefetch && r.messageId && (force || !probed)) {
      try {
        const fresh = await rowFromMessageId(r.messageId, r.channelId);
        if (fresh) {
          if (fresh.closerUsername) name = fresh.closerUsername;
          // Store the ids too, so this row never needs a refetch again.
          if (fresh.closerDiscordId) patch.closerDiscordId = fresh.closerDiscordId;
          if (fresh.closerRaw)       patch.closerRaw       = fresh.closerRaw;
          if (fresh.closerUserId)    patch.closerUserId    = fresh.closerUserId;
          if (name) refetched++;
          // It named nobody. Keep what it DID say, and the fact that we looked,
          // so this row stops costing a Discord request on every future pass and
          // somebody can see what shape defeated the parser.
          else if (fresh.raw && fresh.raw.noExecutor) {
            patch.raw = { ...(r.raw || {}), noExecutor: fresh.raw.noExecutor };
          }
        }
      } catch (e) { /* the message may be gone — that is a real dead end */ }
    } else if (!name && probed) {
      skippedProbed++;
    }

    if (!name) {
      stillBlank++;
      // Record the dead end even when there is nothing to name, so the next pass
      // knows not to try again.
      if (patch.raw) {
        try { await prisma.ticketLog.update({ where: { id: r.id }, data: { raw: patch.raw } }); }
        catch (e) { /* diagnostics are not worth failing over */ }
      }
      continue;
    }
    try {
      await prisma.ticketLog.update({ where: { id: r.id }, data: { ...patch, closerUsername: name } });
      fixed++;
    } catch (e) { stillBlank++; }
  }

  console.log(`[TicketLogs] handler backfill · ${fixed} filled (${refetched} by re-reading Discord), `
    + `${stillBlank} still unattributable of ${rows.length}`
    + (skippedProbed ? `, ${skippedProbed} already known to name nobody` : '')
    + (rotate ? `, next pass resumes at ${_handlerCursor}` : ''));
  return { fixed, refetched, stillBlank, skippedProbed, checked: rows.length,
           resumeAt: rotate ? _handlerCursor : null };
}

/**
 * Refetch one ticket-log message from Discord and re-parse it with the current
 * parser. Returns the same shape rowFromMessage() produces, or null.
 *
 * This is what makes the handler repairable rather than lost: the row keeps the
 * message id forever, and the message is the original source of truth.
 */
async function rowFromMessageId(messageId, channelId) {
  const { getClient } = require('./bot');
  const client = typeof getClient === 'function' ? getClient() : null;
  if (!client) return null;
  const chId = String(channelId || TICKET_LOG_CHANNEL_ID() || '');
  if (!chId) return null;

  const channel = await client.channels.fetch(chId).catch(() => null);
  if (!channel || typeof channel.messages?.fetch !== 'function') return null;

  const msg = await channel.messages.fetch(String(messageId)).catch(() => null);
  if (!msg) return null;
  return rowFromMessage(msg);
}

/**
 * The row this message is ABOUT, if we already have one.
 *
 * Keyed on the message first, then on Tickety's own ticket id, then on the
 * transcript link. One closed ticket can produce more than one message in the
 * channel — a summary and a transcript post, an edit that arrives as a fresh
 * message, a bot restart re-posting — and `messageId` being unique made each of
 * those a separate row. That is how the queue ended up with the same ticket in
 * it twice.
 *
 * `ticketRef` is Tickety's id for the ticket. It identifies the ticket rather
 * than the message, which is exactly the distinction that was missing.
 */
async function findExistingRow(data) {
  let row = await prisma.ticketLog.findUnique({ where: { messageId: data.messageId } });
  if (row) return { row, by: 'messageId' };

  if (data.ticketRef) {
    row = await prisma.ticketLog.findFirst({
      where: { ticketRef: data.ticketRef },
      orderBy: { createdAt: 'asc' },
    });
    if (row) return { row, by: 'ticketRef' };
  }

  // No ticket id on the log — fall back to the transcript, which is per-ticket.
  if (data.transcriptUrl) {
    row = await prisma.ticketLog.findFirst({
      where: { transcriptUrl: data.transcriptUrl },
      orderBy: { createdAt: 'asc' },
    });
    if (row) return { row, by: 'transcriptUrl' };
  }
  return { row: null, by: null };
}

// Upsert one message. Returns 'created' | 'updated' | 'unchanged' | null.
async function ingestMessage(msg) {
  const data = await rowFromMessage(msg);
  if (!data) return null;
  try {
    const { row: existing, by } = await findExistingRow(data);
    if (existing) {
      // Matched on the TICKET rather than on this message: the ticket is already
      // stored under a different message, so this is a second log for it. Fold
      // what it knows into the row that exists instead of making another one.
      if (by !== 'messageId') {
        const patch = {};
        for (const f of RESOLVED_FIELDS) {
          if (data[f] != null && existing[f] == null) patch[f] = data[f];
        }
        if (!Object.keys(patch).length) return 'unchanged';
        await prisma.ticketLog.update({ where: { id: existing.id }, data: patch });
        return 'updated';
      }

      // Only write what we actually learned. A null from this pass means "we
      // couldn't resolve it", not "it is empty" — so keep what's already stored.
      const patch = {};
      for (const f of RESOLVED_FIELDS) {
        if (data[f] != null && data[f] !== existing[f]) patch[f] = data[f];
      }
      if (data.ticketType && data.ticketType !== existing.ticketType) patch.ticketType = data.ticketType;
      if (!Object.keys(patch).length) return 'unchanged';
      await prisma.ticketLog.update({ where: { messageId: data.messageId }, data: patch });
      return 'updated';
    }
    // A ticket closed before the last backlog clear is history. It is stored,
    // it is searchable, it just never joins the queue — otherwise re-syncing
    // the channel rebuilds the exact wall somebody just cleared.
    const cleared = await statusForNewRow(data.closedAt);
    const created = await prisma.ticketLog.create({
      data: { ...data, ...(cleared || {}), ticketNo: await nextTicketNo() },
    });

    // Put it in front of a reviewer straight away. Until now the queue only
    // existed on the site, so a closed ticket sat unseen until somebody
    // remembered to look — which is why tickets went unpaid. A ticket that
    // arrived already voided (backlog clear) is history and is not re-queued.
    // A divisional ticket (CID, SCO) closed by that division's own officer is
    // not IA's to review and pays nothing, so putting it in the queue is pure
    // noise -- the row is still stored and searchable. MET tickets queue
    // regardless of who closed them, because that IS the IA queue.
    const divisional = String(created.division || 'MET').toUpperCase() !== 'MET';
    const queueable  = !divisional || created.closerIsIa === true;

    if (created.status === 'PENDING' && queueable) {
      try {
        const cards = require('./iaReviewCards');
        if (cards.ticketsChannelId()) {
          const { getClient } = require('./bot');
          const client = getClient();
          if (client) await cards.postTicketCard(client, created);
        }
      } catch (err) {
        // The row is stored; a missing card is cosmetic and must never undo it.
        console.warn('[TicketLogs] review card not posted:', err.message);
      }
    } else if (created.status === 'PENDING' && divisional) {
      console.log(`[TicketLogs] ${created.division} ticket ${created.ticketNo ?? created.id} not queued `
        + '· closed by a non-IA handler');
    }
    return 'created';
  } catch (err) {
    // A concurrent insert of the same message is harmless.
    if (err && err.code === 'P2002') return 'unchanged';
    console.error('[TicketLogs] ingest error:', err.message);
    return null;
  }
}

// Has the channel ever been swept end-to-end? Recorded so routine sweeps can
// take the cheap incremental path instead of re-reading everything, and so a
// channel with no parseable logs doesn't get re-scanned in full every 5 minutes.
// Marked PER SOURCE. The MET channel having been walked end to end says nothing
// about CID's or SCO-19's, and one shared marker would have told a newly-added
// server it was already covered, so its history would never be read. MET keeps
// the original key so an existing deployment is not re-swept from scratch.
const FULL_SWEEP_KEY = 'ticketLogFullSweepAt';
const fullSweepKeyFor = division =>
  (!division || division === 'MET') ? FULL_SWEEP_KEY : `${FULL_SWEEP_KEY}:${division}`;

async function fullSweepDone(division) {
  try {
    const row = await prisma.systemSetting.findUnique({ where: { key: fullSweepKeyFor(division) } });
    return !!(row && row.value);
  } catch (e) { return false; }
}
async function markFullSweep(division) {
  try {
    const key = fullSweepKeyFor(division);
    await prisma.systemSetting.upsert({
      where:  { key },
      update: { value: new Date().toISOString() },
      create: { key, value: new Date().toISOString() },
    });
  } catch (e) { /* the sweep still worked; this is only an optimisation */ }
}

// ── Backfill sweep ────────────────────────────────────────────────
// Pages backwards through the log channel. Routine sweeps stop as soon as they
// have seen `stopAfterKnown` consecutive messages already stored — the steady
// state, so they cost one page. `opts.full` reads the whole channel history.
/**
 * Sweep EVERY configured ticket-log channel (MET, CID, SCO-19).
 *
 * Each source is swept independently so one unreachable server — the bot not
 * invited yet, a permission missing — cannot stop the others from being read.
 * Their counts are summed; per-source outcomes are reported in `sources` and
 * any failures are collected into `error` rather than thrown.
 */
async function backfill(client, opts = {}) {
  const total = { scanned: 0, created: 0, updated: 0, unchanged: 0, skipped: 0, pages: 0,
                  full: !!opts.full, error: null, sources: [] };
  if (!client) { total.error = 'bot not ready'; return total; }

  const sources = ticketSources();
  if (!sources.length) { total.error = 'no ticket log channels configured'; return total; }

  const problems = [];
  for (const src of sources) {
    const stats = await backfillSource(client, src, opts);
    total.scanned += stats.scanned; total.created += stats.created;
    total.updated += stats.updated; total.unchanged += stats.unchanged;
    total.skipped += stats.skipped; total.pages += stats.pages;
    total.sources.push({ division: src.division, ...stats });
    if (stats.error) problems.push(`${src.division}: ${stats.error}`);
  }
  if (problems.length) total.error = problems.join(' · ');
  return total;
}

async function backfillSource(client, src, opts = {}) {
  const stats = { scanned: 0, created: 0, updated: 0, unchanged: 0, skipped: 0, pages: 0, full: !!opts.full, error: null };
  const { guildId, channelId, division } = src;

  let channel;
  try {
    const guild = await client.guilds.fetch(guildId);
    channel = await guild.channels.fetch(channelId);
  } catch (e) {
    stats.error = `cannot access the ${division} ticket log channel: ${e.message}`;
    return stats;
  }
  if (!channel || typeof channel.messages?.fetch !== 'function') {
    stats.error = `the ${division} ticket log channel is not a text channel`;
    return stats;
  }

  // A first sweep (or an explicit full re-scan) walks the whole history; after
  // that, sweeps only need to reach back far enough to close any gap.
  const swept = opts.full ? false : await fullSweepDone(division);
  const isFirst = opts.full || !swept;
  const limit = opts.limit || (isFirst ? (opts.full ? Infinity : FIRST_BACKFILL_LIMIT()) : 400);
  const stopAfterKnown = isFirst ? Infinity : 60;
  const maxPages = opts.full ? 400 : 40;   // 400 pages × 100 = 40k messages

  let before, knownStreak = 0, reachedEnd = false;
  while (stats.scanned < limit && stats.pages < maxPages) {
    let page;
    try {
      page = await channel.messages.fetch({ limit: 100, before });
    } catch (e) {
      stats.error = `cannot read ticket logs: ${e.message}`;
      break;
    }
    stats.pages++;
    if (!page || page.size === 0) { reachedEnd = true; break; }

    for (const [, msg] of page) {
      stats.scanned++;
      // One malformed message must not abort the whole sweep and strand it on
      // the same page forever.
      let result = null;
      try { result = await ingestMessage(msg); }
      catch (e) { console.warn('[TicketLogs] skipping message', msg && msg.id, '-', e.message); }

      if (result === 'created')        { stats.created++;   knownStreak = 0; }
      else if (result === 'updated')   { stats.updated++;   knownStreak = 0; }
      else if (result === 'unchanged') { stats.unchanged++; knownStreak++; }
      else                             { stats.skipped++; }
      if (knownStreak >= stopAfterKnown) break;
    }
    if (knownStreak >= stopAfterKnown) break;

    before = page.last()?.id;
    if (!before) { reachedEnd = true; break; }
    if (page.size < 100) { reachedEnd = true; break; }   // last page of history
  }

  // Only claim the history is covered when we actually walked off the end of it.
  if (isFirst && reachedEnd && !stats.error) await markFullSweep(division);

  // Reading embeds from another bot needs the (privileged) Message Content
  // intent. Without it every message parses as "not a ticket log", which looks
  // exactly like an empty channel — so say so rather than failing silently.
  if (!stats.error && stats.scanned > 0 && stats.created === 0 && stats.updated === 0 && stats.unchanged === 0) {
    stats.error = 'Read ' + stats.scanned + ' messages but could not parse any as ticket logs · '
      + 'check that the "Message Content Intent" is enabled for the bot in the Discord Developer Portal.';
  }

  return stats;
}

// ── Workers ───────────────────────────────────────────────────────
let _sweeping = false;
async function sweep(client, opts) {
  if (_sweeping) return null;
  _sweeping = true;
  try {
    const s = await backfill(client, opts);

    // A sweep that stored several logs at once has just inserted rows in the
    // order Discord serves them, which is newest first — so their numbers came
    // out backwards relative to each other, and relative to anything older that
    // turned up on a later page. Reassign them in closed order.
    //
    // Only for a bulk create. The live path stores one message at a time, and one
    // new message is always the newest ticket, so the sequence already puts it in
    // the right place; renumbering the whole table for that would be a large
    // write every five minutes for no gain.
    if (s.created > 1) {
      try {
        const r = await renumberTickets();
        if (r.renumbered) s.renumbered = r.renumbered;
      } catch (e) {
        console.warn('[TicketLogs] could not renumber after the sweep:', e.message);
      }
    }

    // Repair any blank handler on every sweep, not only when somebody presses a
    // button. A column that has to name somebody cannot depend on a human
    // noticing it is empty — the sweep runs every five minutes, so a row that
    // arrives unattributable (a closer who had left, a cold member cache) is
    // named within one cycle instead of sitting there as "Not recorded".
    // Capped small so a routine sweep never turns into a long refetch job.
    try {
      // A small slice per sweep. Refetching is allowed here because the sweep
      // is a background job with nobody waiting on it — but only 25 rows of it,
      // so a channel full of unattributable logs is chipped away at over
      // several sweeps rather than stalling one.
      //
      // `rotate` is what makes "over several sweeps" true. Without it every sweep
      // took the same newest 25 blank rows, so a handful of permanently
      // unattributable logs at the top blocked every fixable row underneath them
      // from ever being looked at.
      const h = await backfillHandlers(25, { rotate: true });
      if (h.fixed) s.handlersFixed = h.fixed;
      if (h.stillBlank) s.handlersBlank = h.stillBlank;
    } catch (e) {
      console.warn('[TicketLogs] handler repair skipped:', e.message);
    }

    if (s.created || s.updated || s.error || s.handlersFixed) {
      console.log(`[TicketLogs] sweep · scanned ${s.scanned}, new ${s.created}, refreshed ${s.updated}`
        + (s.handlersFixed ? `, handlers filled ${s.handlersFixed}` : '')
        + (s.error ? `, error: ${s.error}` : ''));
    }
    return s;
  } finally {
    _sweeping = false;
  }
}

// The one-off repair of what is already stored.
//
// Both bugs it fixes are historic — one closed ticket logged twice became two
// rows, and an embed whose executor was only "<@id> closed a ticket" stored no
// handler at all. Neither can be fixed by the parser alone: the rows are already
// there. So it runs once, on the deploy that carries the fix, and stamps itself
// so it never runs again.
//
// Stamped by VERSION, not by a boolean: if a later fix needs another pass, the
// version goes up and it runs once more.
const REPAIR_KEY = 'ticketLogRepairVersion';
// 3 — renumber every log in closed order (they were numbered backwards, newest
//     first, because that is the order the channel is read in) and re-read the
//     logs that still name nobody, now that the parser also looks at the embed
//     author line and the message's own text.
const REPAIR_VERSION = '3';

async function repairOnce(client) {
  let done = null;
  try {
    const row = await prisma.systemSetting.findUnique({ where: { key: REPAIR_KEY } });
    done = row ? String(row.value) : null;
  } catch (e) { return { skipped: 'could not read the stamp' }; }
  if (done === REPAIR_VERSION) return { skipped: 'already done' };

  console.log('[TicketLogs] repairing stored rows · merging duplicates, then filling in handlers');
  const duplicates = await mergeDuplicates({ limit: 5000 }).catch(e => ({ error: e.message }));
  // The refetch is what actually fixes a handler: the stored columns never had
  // the executor, so it has to be re-read off the original message with the
  // parser as it is now. `force` because this repair EXISTS to carry a parser
  // change — a row previously written off as naming nobody may well name
  // somebody once the author line and the message text are read too.
  const handlers = await backfillHandlers(8000, { refetch: true, force: true })
    .catch(e => ({ error: e.message }));

  // Last, because merging duplicates removes rows and the numbers have to be
  // contiguous over what survives.
  const numbers = await renumberTickets().catch(e => ({ error: e.message }));

  try {
    await prisma.systemSetting.upsert({
      where:  { key: REPAIR_KEY },
      update: { value: REPAIR_VERSION },
      create: { key: REPAIR_KEY, value: REPAIR_VERSION },
    });
  } catch (e) { console.warn('[TicketLogs] could not stamp the repair:', e.message); }

  console.log(`[TicketLogs] repair done · ${duplicates.removed || 0} duplicate row(s) removed, `
    + `${handlers.fixed || 0} handler(s) filled in, ${handlers.stillBlank || 0} still blank, `
    + `${numbers.renumbered || 0} log(s) renumbered oldest-first`);
  return { duplicates, handlers, numbers };
}

function startTicketLogWorker(client) {
  // First sweep once the gateway has had time to connect, then every 5 minutes
  // as a safety net behind the live messageCreate handler.
  setTimeout(() => { sweep(client).catch(() => {}); }, 25 * 1000);
  setInterval(() => { sweep(client).catch(() => {}); }, 5 * 60 * 1000);
  // After the first sweep, so a handler refetch is not competing with it for the
  // same Discord rate limit.
  setTimeout(() => { repairOnce(client).catch(e => console.warn('[TicketLogs] repair failed:', e.message)); }, 3 * 60 * 1000);
}

module.exports = {
  nextTicketNo, backfillTicketNumbers, renumberTickets, clearBacklogBefore, probeTicketTable, backfillHandlers, rowFromMessageId,
  mergeDuplicates, findExistingRow, repairOnce, REPAIR_KEY, REPAIR_VERSION,
  backlogClearedAt, setBacklogClearedAt, statusForNewRow,
  // Tests only: the watermark is cached for the life of the process.
  __resetWatermark: () => { _watermark = null; },
  __resetSeqCheck:  () => { _seqChecked = false; },
  ingestMessage,
  backfill,
  sweep,
  startTicketLogWorker,
  TICKET_LOG_CHANNEL_ID,
  TICKET_LOG_GUILD_ID,
  // Multi-division sources: MET, CID and SCO-19.
  ticketSources, divisionForChannel, rankFromRaw, resolveCloserIsIa,
};
