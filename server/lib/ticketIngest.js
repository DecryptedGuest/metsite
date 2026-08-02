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
    const p = parseTicketLogEmbed(embed);
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
  let closerUserId = null, closerUsername = null;
  const closerRaw = parsed.executorRaw || null;

  if (parsed.executorId) {
    try {
      const u = await prisma.user.findUnique({
        where:  { discordId: String(parsed.executorId) },
        select: { id: true, displayName: true, discordUsername: true },
      });
      if (u) { closerUserId = u.id; closerUsername = u.displayName || u.discordUsername || null; }
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

  return {
    messageId:             String(msg.id),
    channelId:             msg.channelId ? String(msg.channelId) : TICKET_LOG_CHANNEL_ID(),
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
        console.warn('[TicketLogs] ticket_log_no_seq was missing — created it, starting at ' + start);
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

  // Raw SQL, on purpose.
  //
  // The read-then-updateMany version reported "cleared 0" against a queue of
  // nine thousand: findMany returned rows and updateMany then matched none of
  // them. Rather than keep guessing which layer lost them, this is one
  // statement the database executes itself — a bounded UPDATE against a
  // subquery — so what comes back is Postgres's own affected-row count and
  // there is nothing in between to disagree with.
  //
  // Still bounded: LIMIT keeps each statement small enough that no pooler or
  // proxy timeout can reach it, and the loop commits as it goes.
  // TWO independent ways to do the same update, because one of them has been
  // silently doing nothing in production and I could not tell which layer was
  // at fault from here. Raw SQL first — it is one statement the database runs
  // itself. If that throws, or runs and moves nothing while rows plainly match,
  // fall through to the ORM. Whatever goes wrong is RECORDED and returned
  // rather than swallowed, so the next press explains itself instead of
  // reporting a cheerful zero.
  //
  // The LIMIT is inlined as a literal integer rather than bound as a parameter:
  // it is a number this function clamps itself, never anything a caller typed,
  // and a bind parameter in LIMIT is one more thing that can behave differently
  // between environments.
  let cleared = 0;
  let via = null;
  const errors = [];

  while (cleared < maxRows) {
    const take = Math.max(1, Math.min(batch, maxRows - cleared) | 0);
    let n = null;

    try {
      const filter = opts.all
        ? `status = 'PENDING'::"TicketStatus"`
        : `status = 'PENDING'::"TicketStatus" AND "closedAt" < '${cutoff.toISOString()}'::timestamp`;
      n = await prisma.$executeRawUnsafe(
        `UPDATE ticket_logs SET
           status = 'APPROVED'::"TicketStatus",
           "voidedAt" = NOW(), "reviewedAt" = NOW(), "reviewedByName" = 'Backlog cleared'
         WHERE id IN (SELECT id FROM ticket_logs WHERE ${filter} LIMIT ${take})`);
      if (n) via = via || 'sql';
    } catch (err) {
      if (!errors.length) console.error('[TicketLogs] raw clear failed:', err.message);
      errors.push('sql: ' + err.message);
      n = null;
    }

    // The raw path did nothing. Before believing the queue is empty, ask the
    // ORM — and if IT can see rows, do the update its way.
    if (!n) {
      const slice = await prisma.ticketLog.findMany({ where, select: { id: true }, take });
      if (!slice.length) break;                 // genuinely nothing left
      try {
        const res = await prisma.ticketLog.updateMany({
          where: { id: { in: slice.map(r => r.id) } },
          data: {
            status: 'APPROVED',
            voidedAt: new Date(), reviewedAt: new Date(), reviewedByName: 'Backlog cleared',
          },
        });
        n = res.count;
        if (n) via = via || 'orm';
      } catch (err) {
        errors.push('orm: ' + err.message);
        console.error('[TicketLogs] ORM clear failed too:', err.message);
        break;                                  // both paths are broken — stop
      }
      // Both paths ran and neither moved a row the ORM can see. Spinning would
      // not help; report it.
      if (!n) { errors.push('both paths matched 0 rows while ' + slice.length + ' were readable'); break; }
    }

    cleared += n;
    if (n < take) break;   // that was the last of them
  }

  const remaining = await prisma.ticketLog.count({ where });

  // Draw the line, so a later sync cannot rebuild what was just cleared. Only
  // once the queue is actually empty — drawing it half way would pre-clear
  // rows that a resumed run still has to account for.
  if (!remaining) {
    await setBacklogClearedAt(cutoff).catch(e =>
      console.warn('[TicketLogs] could not record the backlog watermark:', e.message));
  }

  console.log(`[TicketLogs] cleared ${cleared} pending log(s)`
    + (opts.all ? '' : ` closed before ${cutoff.toISOString()}`)
    + ` (approved, no points, via ${via || 'nothing'}) — ${remaining} still waiting`
    + (errors.length ? ` · errors: ${errors.join(' | ')}` : ''));
  return {
    cleared, remaining, done: remaining === 0, clearedBefore: cutoff,
    // Which path did the work, and anything that went wrong on the way. This is
    // returned rather than logged-and-forgotten because the server log is not
    // where the person pressing the button is looking.
    via, errors,
  };
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
async function backfillHandlers(limit = 5000, opts = {}) {
  const allowRefetch = opts.refetch !== false;
  const rows = await prisma.ticketLog.findMany({
    where: { OR: [{ closerUsername: null }, { closerUsername: '' }] },
    orderBy: { closedAt: 'desc' },
    take: limit,
  });
  let fixed = 0, refetched = 0, stillBlank = 0;

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

    // Stage 2 — the row stores no executor at all. The message does.
    if (!name && allowRefetch && r.messageId) {
      try {
        const fresh = await rowFromMessageId(r.messageId, r.channelId);
        if (fresh) {
          if (fresh.closerUsername) name = fresh.closerUsername;
          // Store the ids too, so this row never needs a refetch again.
          if (fresh.closerDiscordId) patch.closerDiscordId = fresh.closerDiscordId;
          if (fresh.closerRaw)       patch.closerRaw       = fresh.closerRaw;
          if (fresh.closerUserId)    patch.closerUserId    = fresh.closerUserId;
          if (name) refetched++;
        }
      } catch (e) { /* the message may be gone — that is a real dead end */ }
    }

    if (!name) { stillBlank++; continue; }
    try {
      await prisma.ticketLog.update({ where: { id: r.id }, data: { ...patch, closerUsername: name } });
      fixed++;
    } catch (e) { stillBlank++; }
  }

  console.log(`[TicketLogs] handler backfill — ${fixed} filled (${refetched} by re-reading Discord), `
    + `${stillBlank} still unattributable of ${rows.length}`);
  return { fixed, refetched, stillBlank, checked: rows.length };
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

// Upsert one message. Returns 'created' | 'updated' | 'unchanged' | null.
async function ingestMessage(msg) {
  const data = await rowFromMessage(msg);
  if (!data) return null;
  try {
    const existing = await prisma.ticketLog.findUnique({ where: { messageId: data.messageId } });
    if (existing) {
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
    await prisma.ticketLog.create({
      data: { ...data, ...(cleared || {}), ticketNo: await nextTicketNo() },
    });
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
const FULL_SWEEP_KEY = 'ticketLogFullSweepAt';

async function fullSweepDone() {
  try {
    const row = await prisma.systemSetting.findUnique({ where: { key: FULL_SWEEP_KEY } });
    return !!(row && row.value);
  } catch (e) { return false; }
}
async function markFullSweep() {
  try {
    await prisma.systemSetting.upsert({
      where:  { key: FULL_SWEEP_KEY },
      update: { value: new Date().toISOString() },
      create: { key: FULL_SWEEP_KEY, value: new Date().toISOString() },
    });
  } catch (e) { /* the sweep still worked; this is only an optimisation */ }
}

// ── Backfill sweep ────────────────────────────────────────────────
// Pages backwards through the log channel. Routine sweeps stop as soon as they
// have seen `stopAfterKnown` consecutive messages already stored — the steady
// state, so they cost one page. `opts.full` reads the whole channel history.
async function backfill(client, opts = {}) {
  const stats = { scanned: 0, created: 0, updated: 0, unchanged: 0, skipped: 0, pages: 0, full: !!opts.full, error: null };
  if (!client) { stats.error = 'bot not ready'; return stats; }

  const guildId   = TICKET_LOG_GUILD_ID();
  const channelId = TICKET_LOG_CHANNEL_ID();
  if (!guildId || !channelId) { stats.error = 'ticket log channel not configured'; return stats; }

  let channel;
  try {
    const guild = await client.guilds.fetch(guildId);
    channel = await guild.channels.fetch(channelId);
  } catch (e) {
    stats.error = `cannot access ticket log channel: ${e.message}`;
    return stats;
  }
  if (!channel || typeof channel.messages?.fetch !== 'function') {
    stats.error = 'ticket log channel is not a text channel';
    return stats;
  }

  // A first sweep (or an explicit full re-scan) walks the whole history; after
  // that, sweeps only need to reach back far enough to close any gap.
  const swept = opts.full ? false : await fullSweepDone();
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
  if (isFirst && reachedEnd && !stats.error) await markFullSweep();

  // Reading embeds from another bot needs the (privileged) Message Content
  // intent. Without it every message parses as "not a ticket log", which looks
  // exactly like an empty channel — so say so rather than failing silently.
  if (!stats.error && stats.scanned > 0 && stats.created === 0 && stats.updated === 0 && stats.unchanged === 0) {
    stats.error = 'Read ' + stats.scanned + ' messages but could not parse any as ticket logs — '
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
      const h = await backfillHandlers(25);
      if (h.fixed) s.handlersFixed = h.fixed;
      if (h.stillBlank) s.handlersBlank = h.stillBlank;
    } catch (e) {
      console.warn('[TicketLogs] handler repair skipped:', e.message);
    }

    if (s.created || s.updated || s.error || s.handlersFixed) {
      console.log(`[TicketLogs] sweep — scanned ${s.scanned}, new ${s.created}, refreshed ${s.updated}`
        + (s.handlersFixed ? `, handlers filled ${s.handlersFixed}` : '')
        + (s.error ? `, error: ${s.error}` : ''));
    }
    return s;
  } finally {
    _sweeping = false;
  }
}

function startTicketLogWorker(client) {
  // First sweep once the gateway has had time to connect, then every 5 minutes
  // as a safety net behind the live messageCreate handler.
  setTimeout(() => { sweep(client).catch(() => {}); }, 25 * 1000);
  setInterval(() => { sweep(client).catch(() => {}); }, 5 * 60 * 1000);
}

module.exports = {
  nextTicketNo, backfillTicketNumbers, clearBacklogBefore, backfillHandlers, rowFromMessageId,
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
};
