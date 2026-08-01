// server/lib/activityLogs.js
// Patrol and event logs, mirrored from Discord onto the site.
//
// Officers post their patrol/event logs in Discord and a supervisor signs one
// off by reacting to the message: a tick approves it, a cross denies it.
//
// The whole point of this module is that the decision is read off the MESSAGE
// ITSELF. Whoever adds the tick or the cross — the officer's own supervisor,
// a different supervisor, high command, somebody who has never opened this
// site — the log still shows up here as approved or denied. Nothing about the
// status depends on the decision having been taken through our UI.
//
// Three paths keep it current, same shape as the ticket-log mirror:
//   * live message   — bot.js forwards new messages in the log channels here.
//   * live reaction  — bot.js forwards reaction add/remove here.
//   * catch-up sweep — pages back through history re-reading reactions, which
//     heals anything missed while the bot was down (gateway events are not
//     replayed, so without this a tick added during a restart is lost).

const prisma = require('./db');

// ── Configuration ────────────────────────────────────────────────
// Channels are comma-separated so a division can have more than one.
function idList(value) {
  return String(value || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function patrolChannelIds() { return idList(process.env.PATROL_LOG_CHANNEL_ID); }
function eventChannelIds()  { return idList(process.env.EVENT_LOG_CHANNEL_ID); }
function activityGuildId()  { return process.env.ACTIVITY_LOG_GUILD_ID || process.env.GUILD_ID || null; }

// Which kind of log a channel holds, or null if it isn't a log channel at all.
function channelKind(channelId) {
  const id = String(channelId || '');
  if (!id) return null;
  if (patrolChannelIds().includes(id)) return 'PATROL';
  if (eventChannelIds().includes(id))  return 'EVENT';
  return null;
}

function isConfigured() { return patrolChannelIds().length > 0 || eventChannelIds().length > 0; }
function allChannels() {
  return [
    ...patrolChannelIds().map(id => ({ id, kind: 'PATROL' })),
    ...eventChannelIds().map(id  => ({ id, kind: 'EVENT'  })),
  ];
}

// ── What counts as a tick and what counts as a cross ─────────────
// Servers don't all use the same emoji, and plenty use a custom one, so both
// sets are overridable. A custom emoji is matched on its NAME (":approve:" is
// configured as "approve"), because its id differs per server.
const DEFAULT_TICKS   = ['✅', '✔️', '✔', '☑️', '☑', '🟢'];
const DEFAULT_CROSSES = ['❌', '✖️', '✖', '❎', '🔴', '🚫'];

function tickEmojis()  { return idList(process.env.ACTIVITY_TICK_EMOJI).concat(DEFAULT_TICKS); }
function crossEmojis() { return idList(process.env.ACTIVITY_CROSS_EMOJI).concat(DEFAULT_CROSSES); }

// Normalise a discord.js emoji to the two forms we might have configured:
// its unicode character, and its custom-emoji name.
function emojiKeys(emoji) {
  if (!emoji) return [];
  const keys = [];
  if (emoji.name) keys.push(String(emoji.name));
  if (emoji.id) keys.push(String(emoji.id));       // allow pinning a custom emoji by id
  return keys;
}

function reactionVerdict(emoji) {
  const keys = emojiKeys(emoji);
  if (!keys.length) return null;
  const ticks   = tickEmojis();
  const crosses = crossEmojis();
  // A cross is checked first: if a server has somehow configured the same
  // emoji as both, refusing the log is the safer reading.
  if (keys.some(k => crosses.includes(k))) return 'DENIED';
  if (keys.some(k => ticks.includes(k)))   return 'APPROVED';
  return null;
}

// ── Reading the decision off a message ───────────────────────────
// Returns { tick, cross, deciders: [{id, name, verdict}] }.
//
// Two exclusions, and only two:
//   * bots — a log bot that pre-adds ✅/❌ as clickable buttons would
//     otherwise mark every log both approved and denied the moment it posts.
//     (The logger bot is also the message author for a relayed log, so this is
//     what stops a relay from signing off its own post.)
//   * the officer the log belongs to — "ticked by somebody else" is the
//     requirement; an officer can't sign off their own patrol.
// Everybody else counts, whoever they are, and whether or not they have ever
// opened this site.
async function tallyReactions(msg, excludeIds = []) {
  const out = { tick: 0, cross: 0, deciders: [] };
  if (!msg || !msg.reactions) return out;

  const excluded = new Set(excludeIds.filter(Boolean).map(String));
  const reactions = msg.reactions.cache ? [...msg.reactions.cache.values()] : [];

  for (const reaction of reactions) {
    const verdict = reactionVerdict(reaction.emoji);
    if (!verdict) continue;

    let users = [];
    try {
      // fetch() pages up to 100 reactors, which is far more than a sign-off
      // ever has; the cache alone is empty for messages we didn't see live.
      const fetched = await reaction.users.fetch({ limit: 100 });
      users = [...fetched.values()];
    } catch (e) {
      // Fall back to whatever is cached rather than losing the reaction.
      users = reaction.users.cache ? [...reaction.users.cache.values()] : [];
    }

    for (const u of users) {
      if (!u || u.bot) continue;
      if (excluded.has(String(u.id))) continue;
      if (verdict === 'DENIED') out.cross++; else out.tick++;
      out.deciders.push({ id: String(u.id), name: u.globalName || u.username || null, verdict });
    }
  }
  return out;
}

// A cross outranks a tick: if anyone has objected to a log, it is not approved.
function statusFromTally(tally) {
  if (!tally) return 'PENDING';
  if (tally.cross > 0) return 'DENIED';
  if (tally.tick > 0)  return 'APPROVED';
  return 'PENDING';
}

function firstDecider(tally, status) {
  if (!tally || status === 'PENDING') return null;
  const want = status === 'DENIED' ? 'DENIED' : 'APPROVED';
  return tally.deciders.find(d => d.verdict === want) || null;
}

// ── Turning a Discord message into a row ─────────────────────────
// Attachments and embed images are the "proof" officers post with a log.
function attachmentUrls(msg) {
  const urls = [];
  try {
    for (const [, a] of (msg.attachments || new Map())) {
      if (a && a.url) urls.push({ url: a.url, name: a.name || null, contentType: a.contentType || null });
    }
  } catch (e) { /* no attachments */ }
  for (const embed of (msg.embeds || [])) {
    if (embed && embed.image && embed.image.url) urls.push({ url: embed.image.url, name: null, contentType: 'image' });
  }
  return urls;
}

// The officer's Roblox username, in descending order of confidence — the same
// ladder the ticket-log mirror uses.
async function robloxNameFor(discordId, rawNick) {
  try {
    const { parseRankNick, getRobloxNameFromNick } = require('./bot');
    if (rawNick && rawNick.includes('|')) {
      const parsed = parseRankNick(rawNick).robloxUsername;
      if (parsed) return parsed;
    }
    if (discordId) {
      const fromNick = await getRobloxNameFromNick(discordId);
      if (fromNick) return fromNick;
      const { getRobloxIdFromDiscord, getRobloxUserInfo } = require('./roblox');
      const rid = await getRobloxIdFromDiscord(discordId);
      if (rid) {
        const info = await getRobloxUserInfo(rid);
        if (info && info.username) return info.username;
      }
    }
  } catch (e) { /* best-effort — the log is still worth storing */ }
  return null;
}

// The labels the MET patrol logger and the FLP event logger use for "whose log
// is this". Checked in order; the first one present wins. Extra labels can be
// added via ACTIVITY_OFFICER_LABELS without touching this file.
const OFFICER_LABELS = [
  'Officer', 'Officer Name', 'Username', 'Roblox Username', 'Roblox User', 'Roblox',
  'Submitted By', 'Logged By', 'Logged by', 'Host', 'Hosted By', 'Host Username',
  'User', 'Name', 'Callsign',
];
function officerLabels() { return idList(process.env.ACTIVITY_OFFICER_LABELS).concat(OFFICER_LABELS); }

// Pull the officer out of a bot-relayed log embed. Returns
// { discordId, username, raw } with whatever could be read.
function officerFromEmbeds(msg) {
  const { flattenEmbed, labelled, firstMentionId } = require('./ticketLog');
  const out = { discordId: null, username: null, raw: null, text: '' };

  const texts = [];
  for (const embed of (msg.embeds || [])) {
    const flat = flattenEmbed(embed);
    if (flat) texts.push(flat);
    // An embed's author line is very often the officer ("PC | Someone").
    if (!out.raw && embed && embed.author && embed.author.name) out.raw = String(embed.author.name);
  }
  out.text = texts.join('\n');
  if (!out.text && !out.raw) return out;

  const labels = officerLabels();
  const norm = s => String(s || '').replace(/[*_`|]/g, '').replace(/\s+/g, ' ').replace(/:$/, '').trim().toLowerCase();
  const wanted = new Set(labels.map(norm));

  // Two layouts to cover. An embed FIELD carries the label as the field name
  // and the officer as its value ("Officer" / "<@id>"), with no colon anywhere;
  // a description-style embed puts them on one line ("Officer: <@id>"). Fields
  // are checked first because they're the more specific match.
  let value = null;
  for (const embed of (msg.embeds || [])) {
    for (const f of (embed && embed.fields) || []) {
      if (f && f.name && f.value && wanted.has(norm(f.name))) { value = String(f.value); break; }
    }
    if (value) break;
  }
  if (!value) {
    for (const label of labels) {
      const v = labelled(out.text, label);
      if (v) { value = v; break; }
    }
  }

  if (value) {
    const mention = firstMentionId(value);
    if (mention) out.discordId = mention;
    // A labelled value that isn't a mention is the name itself — often a
    // "RANK | RobloxUser" nickname, which robloxNameFor() knows how to read.
    else {
      const name = value.replace(/[*_`]/g, '').trim().replace(/^@/, '');
      if (name) { out.username = name; if (!out.raw) out.raw = name; }
    }
  }

  // Any mention anywhere is a decent last resort for the Discord id.
  if (!out.discordId) out.discordId = firstMentionId(out.text) || firstMentionId(msg.content || '');
  return out;
}

async function rowFromMessage(msg) {
  if (!msg) return null;
  const kind = channelKind(msg.channelId);
  if (!kind) return null;

  const authorIsBot = !!(msg.author && msg.author.bot);
  const embeds = msg.embeds || [];
  // A bot message only counts as a log when it carries an embed — that's the
  // MET patrol logger / FLP event logger relaying an officer's submission.
  // Bot chatter without an embed isn't a log.
  if (authorIsBot && !embeds.length) return null;

  const fromEmbed = embeds.length ? officerFromEmbeds(msg) : { discordId: null, username: null, raw: null, text: '' };

  // Whose log is it? An embed naming the officer beats the message author,
  // because when a bot relays the log the author is the bot.
  const discordId = fromEmbed.discordId || (authorIsBot ? null : (msg.author ? String(msg.author.id) : null));
  const username  = fromEmbed.username
    || (authorIsBot ? null : (msg.author ? (msg.author.globalName || msg.author.username) : null));
  const rawNick   = fromEmbed.raw || (msg.member && msg.member.nickname) || null;

  // A log we can't attribute to anybody is not worth storing — it would show up
  // as an ownerless row nobody can act on.
  if (!discordId && !username && !rawNick) return null;

  let officerId = null;
  if (discordId) {
    try {
      const u = await prisma.user.findUnique({ where: { discordId }, select: { id: true } });
      if (u) officerId = u.id;
    } catch (e) { /* unmatched authors are fine — the log just has no owner */ }
  }

  const loggedAt = msg.createdAt ? new Date(msg.createdAt) : new Date(msg.createdTimestamp || Date.now());

  // The log body: the officer's own text, or the embed for a relayed log.
  const content = (msg.content && msg.content.trim()) || fromEmbed.text || null;

  return {
    messageId:        String(msg.id),
    channelId:        String(msg.channelId),
    guildId:          msg.guildId ? String(msg.guildId) : activityGuildId(),
    kind,
    officerId,
    officerDiscordId: discordId,
    officerUsername:  username,
    officerRobloxUsername: await robloxNameFor(discordId, rawNick),
    content,
    attachments: attachmentUrls(msg),
    loggedAt,
    raw: { nickname: rawNick, relayed: authorIsBot, embedCount: embeds.length },
  };
}

// Fields a transient lookup failure can leave null. Re-ingesting must never
// overwrite a good stored value with null — RoVer being rate-limited for one
// sweep would otherwise erase every officer's Roblox name.
const RESOLVED_FIELDS = [
  'officerId', 'officerDiscordId', 'officerUsername', 'officerRobloxUsername', 'content', 'guildId',
];

// ── Ingest ───────────────────────────────────────────────────────
// Upsert one message and resolve its status from the reactions currently on it.
// `opts.verdict` is the live path: the reaction that just arrived IS the
// decision, which is how a tick added after an earlier cross flips the log.
//
// Returns 'created' | 'updated' | 'unchanged' | null.
async function ingestMessage(msg, opts = {}) {
  const data = await rowFromMessage(msg);
  if (!data) return null;

  // The officer's own tick never counts — for a relayed log the message author
  // is the logger bot, so the officer has to be excluded by id, not by author.
  const tally = await tallyReactions(msg, [data.officerDiscordId]);

  // Same rule for the live path: if the person who just reacted turns out to be
  // the officer, their reaction isn't a sign-off, so fall back to the tally.
  const live = (opts.decider && data.officerDiscordId &&
                String(opts.decider.id) === String(data.officerDiscordId))
    ? {}
    : opts;

  const decision = decide(tally, live);

  try {
    const existing = await prisma.activityLog.findUnique({ where: { messageId: data.messageId } });
    if (!existing) {
      await prisma.activityLog.create({ data: { ...data, ...decision } });
      return 'created';
    }

    const patch = {};
    for (const f of RESOLVED_FIELDS) {
      if (data[f] != null && data[f] !== existing[f]) patch[f] = data[f];
    }
    // Attachments are re-derived every pass; only write when they changed.
    if (JSON.stringify(data.attachments) !== JSON.stringify(existing.attachments || [])) {
      patch.attachments = data.attachments;
    }

    const next = resolveAgainstExisting(existing, decision, tally);
    Object.assign(patch, next);

    if (!Object.keys(patch).length) return 'unchanged';
    await prisma.activityLog.update({ where: { messageId: data.messageId }, data: patch });
    return 'updated';
  } catch (err) {
    if (err && err.code === 'P2002') return 'unchanged';   // concurrent insert
    console.error('[ActivityLogs] ingest error:', err.message);
    return null;
  }
}

// Build the status/decision fields from a tally (plus an optional live verdict).
function decide(tally, opts = {}) {
  const status = opts.verdict || statusFromTally(tally);
  const who = opts.verdict
    ? (opts.decider || null)
    : firstDecider(tally, status);

  return {
    status,
    tickCount:  tally.tick,
    crossCount: tally.cross,
    decidedAt:          status === 'PENDING' ? null : (opts.decidedAt || new Date()),
    decidedByDiscordId: status === 'PENDING' ? null : (who ? who.id : null),
    decidedByName:      status === 'PENDING' ? null : (who ? who.name : null),
    decisionSource:     status === 'PENDING' ? null : (opts.source || 'DISCORD_REACTION'),
  };
}

// Merge a freshly-computed decision over what's stored, and return only what
// actually changed.
//
// The one special case: a decision taken on the SITE stands even when the
// message shows no reactions. The site mirrors its decision back to Discord as
// a reaction, but if that mirror call failed we must not let the next sweep
// quietly undo an approval a supervisor made here. A decision that came from a
// reaction, by contrast, does revert to pending when the reaction is removed —
// that is somebody deliberately un-ticking it.
function resolveAgainstExisting(existing, decision, tally) {
  const patch = {};
  const siteDecided = existing.decisionSource === 'SITE' && existing.status !== 'PENDING';
  const noReactions = tally.tick === 0 && tally.cross === 0;

  if (siteDecided && noReactions) {
    // Keep the site's decision; still refresh the (zero) tallies.
    if (existing.tickCount !== 0)  patch.tickCount = 0;
    if (existing.crossCount !== 0) patch.crossCount = 0;
    return patch;
  }

  for (const key of ['status', 'tickCount', 'crossCount', 'decidedByDiscordId', 'decidedByName', 'decisionSource']) {
    if (decision[key] !== undefined && decision[key] !== existing[key]) patch[key] = decision[key];
  }
  // Only re-stamp decidedAt when the verdict itself moved, so a sweep doesn't
  // keep bumping the timestamp of a log nobody has touched.
  if (patch.status !== undefined) {
    patch.decidedAt = decision.decidedAt;
    // A reaction has taken the decision over from the site (or cleared it), so
    // the site user who decided it before is no longer who decided it.
    if (existing.decidedByUserId != null) patch.decidedByUserId = null;
  }

  return patch;
}

// ── Live reaction handling ───────────────────────────────────────
// bot.js calls this for every reaction add/remove in a log channel. `added`
// tells us whether this is a fresh decision (use it directly) or a withdrawal
// (recompute from what's left on the message).
async function applyReaction(reaction, user, added) {
  try {
    if (!reaction || !user || user.bot) return null;

    // Reactions on messages the bot never cached arrive as partials.
    if (reaction.partial) { try { await reaction.fetch(); } catch (e) { return null; } }
    const msg = reaction.message;
    if (!msg) return null;
    if (msg.partial) { try { await msg.fetch(); } catch (e) { return null; } }

    if (!channelKind(msg.channelId)) return null;

    const verdict = reactionVerdict(reaction.emoji);
    if (!verdict) return null;                                 // an unrelated emoji

    // On an add, the reaction that just arrived is the decision — that's how a
    // tick placed after an earlier cross flips the log. On a remove, fall back
    // to whatever reactions are left. (ingestMessage drops the live verdict if
    // the reactor turns out to be the officer themselves.)
    const opts = added
      ? { verdict, decider: { id: String(user.id), name: user.globalName || user.username || null }, source: 'DISCORD_REACTION' }
      : {};
    return await ingestMessage(msg, opts);
  } catch (e) {
    console.warn('[ActivityLogs] reaction error:', e.message);
    return null;
  }
}

// ── Site-side decision ───────────────────────────────────────────
// Approving/denying from the site writes the decision here AND mirrors it back
// to Discord as a reaction, so the two never disagree. The Discord half is
// best-effort: the site decision is what the officer sees either way, and
// resolveAgainstExisting() makes sure a failed mirror isn't swept away later.
async function decideFromSite(log, status, actor) {
  if (!['APPROVED', 'DENIED'].includes(status)) throw new Error('status must be APPROVED or DENIED');

  const updated = await prisma.activityLog.update({
    where: { id: log.id },
    data: {
      status,
      decidedAt:          new Date(),
      decidedByUserId:    actor.id || null,
      decidedByDiscordId: actor.discordId || null,
      decidedByName:      actor.name || null,
      decisionSource:     'SITE',
    },
  });

  mirrorToDiscord(log, status).catch(e => console.warn('[ActivityLogs] mirror failed:', e.message));
  return updated;
}

async function mirrorToDiscord(log, status) {
  const { getClient } = require('./bot');
  const client = getClient();
  if (!client) return false;

  const channel = await client.channels.fetch(String(log.channelId)).catch(() => null);
  if (!channel || typeof channel.messages?.fetch !== 'function') return false;
  const msg = await channel.messages.fetch(String(log.messageId)).catch(() => null);
  if (!msg) return false;

  const want   = status === 'DENIED' ? crossEmojis()[0] : tickEmojis()[0];
  const unwant = status === 'DENIED' ? tickEmojis()[0]  : crossEmojis()[0];

  await msg.react(want).catch(() => {});
  // Pull our own opposite reaction if we'd previously put one there.
  try {
    const existing = msg.reactions.cache.find(r => emojiKeys(r.emoji).includes(unwant));
    if (existing) await existing.users.remove(client.user.id).catch(() => {});
  } catch (e) { /* leaving a stale reaction is cosmetic */ }
  return true;
}

// ── Catch-up sweep ───────────────────────────────────────────────
// Gateway events are not replayed after a disconnect, so a tick added while
// the bot was restarting would be lost. This walks recent history and
// re-reads the reactions on each log, which heals that.
async function backfillChannel(client, channelId, opts = {}) {
  const stats = { channelId, scanned: 0, created: 0, updated: 0, unchanged: 0, skipped: 0, pages: 0, error: null };

  let channel;
  try {
    channel = await client.channels.fetch(String(channelId));
  } catch (e) {
    stats.error = `cannot access channel ${channelId}: ${e.message}`;
    return stats;
  }
  if (!channel || typeof channel.messages?.fetch !== 'function') {
    stats.error = `channel ${channelId} is not a text channel`;
    return stats;
  }

  // A routine sweep only needs to reach back far enough to cover any downtime,
  // and must re-read reactions on logs it has already stored (that's the whole
  // point) — so unlike the ticket mirror it cannot stop on "already known".
  const maxPages = opts.full ? 200 : (opts.pages || 3);

  let before;
  while (stats.pages < maxPages) {
    let page;
    try {
      page = await channel.messages.fetch({ limit: 100, before });
    } catch (e) {
      stats.error = `cannot read ${channelId}: ${e.message}`;
      break;
    }
    stats.pages++;
    if (!page || page.size === 0) break;

    for (const [, msg] of page) {
      stats.scanned++;
      let result = null;
      // One malformed message must not abort the sweep and strand it forever.
      try { result = await ingestMessage(msg); }
      catch (e) { console.warn('[ActivityLogs] skipping message', msg && msg.id, '-', e.message); }

      if (result === 'created')        stats.created++;
      else if (result === 'updated')   stats.updated++;
      else if (result === 'unchanged') stats.unchanged++;
      else                             stats.skipped++;
    }

    before = page.last()?.id;
    if (!before || page.size < 100) break;
  }

  return stats;
}

async function backfill(client, opts = {}) {
  const out = { channels: [], created: 0, updated: 0, scanned: 0, error: null };
  if (!client) { out.error = 'bot not ready'; return out; }
  if (!isConfigured()) { out.error = 'no patrol/event log channels configured'; return out; }

  for (const { id } of allChannels()) {
    const s = await backfillChannel(client, id, opts);
    out.channels.push(s);
    out.scanned += s.scanned;
    out.created += s.created;
    out.updated += s.updated;
    if (s.error && !out.error) out.error = s.error;
  }
  return out;
}

let _sweeping = false;
async function sweep(client, opts) {
  if (_sweeping) return null;
  _sweeping = true;
  try {
    const s = await backfill(client, opts);
    if (s.created || s.updated || s.error) {
      console.log(`[ActivityLogs] sweep — scanned ${s.scanned}, new ${s.created}, refreshed ${s.updated}${s.error ? `, error: ${s.error}` : ''}`);
    }
    return s;
  } finally {
    _sweeping = false;
  }
}

function startActivityLogWorker(client) {
  if (!isConfigured()) return;
  // A deeper first pass once the gateway is up, then a light sweep every few
  // minutes behind the live handlers.
  setTimeout(() => { sweep(client, { pages: 20 }).catch(() => {}); }, 30 * 1000);
  setInterval(() => { sweep(client).catch(() => {}); }, 5 * 60 * 1000);
}

module.exports = {
  // config
  isConfigured, channelKind, allChannels, patrolChannelIds, eventChannelIds, activityGuildId,
  tickEmojis, crossEmojis,
  // decision logic (unit-testable without Discord)
  reactionVerdict, tallyReactions, statusFromTally, decide, resolveAgainstExisting,
  // ingest
  rowFromMessage, ingestMessage, applyReaction, decideFromSite, mirrorToDiscord,
  // sweeps
  backfill, sweep, startActivityLogWorker,
};
