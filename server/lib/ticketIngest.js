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

  // Match the closer (Tickety's "executor") to a site account so the ticket
  // shows up under their My Tickets.
  let closerUserId = null, closerUsername = null;
  if (parsed.executorId) {
    try {
      const u = await prisma.user.findUnique({
        where:  { discordId: String(parsed.executorId) },
        select: { id: true, displayName: true, discordUsername: true },
      });
      if (u) { closerUserId = u.id; closerUsername = u.displayName || u.discordUsername; }
    } catch (e) { /* unmatched closers are fine — they just have no owner */ }
    if (!closerUsername) {
      try {
        const { getMemberRecord } = require('./bot');
        const rec = await getMemberRecord(parsed.executorId);
        closerUsername = (rec && (rec.displayName || rec.username)) || null;
      } catch (e) { /* leave null */ }
    }
  }

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
  'closerDiscordId', 'closerUsername', 'closerUserId',
];

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
    await prisma.ticketLog.create({ data });
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
    if (s.created || s.updated || s.error) {
      console.log(`[TicketLogs] sweep — scanned ${s.scanned}, new ${s.created}, refreshed ${s.updated}${s.error ? `, error: ${s.error}` : ''}`);
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
  ingestMessage,
  backfill,
  sweep,
  startTicketLogWorker,
  TICKET_LOG_CHANNEL_ID,
  TICKET_LOG_GUILD_ID,
};
