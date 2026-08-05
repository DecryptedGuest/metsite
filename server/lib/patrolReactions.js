// server/lib/patrolReactions.js
// Sign-off for patrol and event logs, read off the Discord message itself.
//
// A log is approved by somebody ticking it and denied by somebody crossing it.
// patrolLog.js already knew how to read that (reviewFromReactions), but it only
// ran at the moment a log was first ingested — and the bot subscribed to no
// reaction events at all. So the normal case (log posted, supervisor ticks it a
// minute later) never reached the site and the log sat PENDING forever.
//
// This module closes that gap two ways:
//   * live      — messageReactionAdd / messageReactionRemove, wired in bot.js.
//   * reconcile — a periodic sweep of recent PENDING logs that re-reads their
//     reactions. Gateway events are not replayed after a disconnect, so without
//     this a tick added while the bot was restarting would be lost for good.
//
// Whoever reacts, the verdict counts: the officer's own supervisor, a different
// supervisor, high command, somebody who has never opened the site. The only
// reactions ignored are bots (a logger that pre-adds ✅/❌ as clickable buttons
// would otherwise approve and deny every log the moment it posts) and the
// officer who filed the log — "ticked by somebody else" is the requirement.

const prisma = require('./db');

// Emoji sets, matching patrolLog.js. Overridable for servers using a custom
// emoji: give its NAME (":signed:" → "signed") or its id, comma-separated.
//
// The MET custom emoji (met_tick / met_cross / met_online / met_offline) are in
// here alongside the stock ones, matched by name. Reviewers keep clicking the
// plain ✅ — a guild emoji is only free to click for members of the guild it
// lives in, so making our own the *only* accepted mark would lock out anyone
// reviewing from another server. Both count, which is what we want.
const APPROVE = ['✅', '☑️', '✔️', '✔', '☑', '🟢', 'met_tick', 'met_online'];
const DENY    = ['❌', '✖️', '✖', '❎', '⛔', '🚫', '🔴', 'met_cross', 'met_denied', 'met_offline'];

function idList(v) {
  return String(v || '').split(',').map(s => s.trim()).filter(Boolean);
}
function approveEmoji() { return idList(process.env.PATROL_APPROVE_EMOJI).concat(APPROVE); }
function denyEmoji()    { return idList(process.env.PATROL_DENY_EMOJI).concat(DENY); }

// A discord.js emoji matches on its unicode character, its custom-emoji name,
// or its id — whichever the server configured.
function emojiKeys(emoji) {
  if (!emoji) return [];
  const keys = [];
  if (emoji.name) keys.push(String(emoji.name));
  if (emoji.id)   keys.push(String(emoji.id));
  return keys;
}

// 'APPROVED' | 'DENIED' | null
function verdictFor(emoji) {
  const keys = emojiKeys(emoji);
  if (!keys.length) return null;
  // Deny is checked first: if a server has somehow configured the same emoji as
  // both, refusing the log is the safer reading.
  if (keys.some(k => denyEmoji().includes(k)))    return 'DENIED';
  if (keys.some(k => approveEmoji().includes(k))) return 'APPROVED';
  return null;
}

// Everyone who reacted with a decisive emoji, minus bots and the log's own
// submitter. Returns { approve: [...], deny: [...] } of { id, name }.
async function tallyReactions(message, submitterDiscordId) {
  const out = { approve: [], deny: [] };
  const cache = message && message.reactions && message.reactions.cache;
  if (!cache || cache.size === 0) return out;

  for (const reaction of cache.values()) {
    const verdict = verdictFor(reaction.emoji);
    if (!verdict) continue;

    let users = [];
    try {
      // fetch() pages up to 100 reactors — far more than a sign-off ever has.
      // The cache alone is empty for messages the bot didn't see live.
      users = [...(await reaction.users.fetch({ limit: 100 })).values()];
    } catch (e) {
      users = reaction.users.cache ? [...reaction.users.cache.values()] : [];
    }

    for (const u of users) {
      if (!u || u.bot) continue;
      if (submitterDiscordId && String(u.id) === String(submitterDiscordId)) continue;
      let name = u.globalName || u.username || String(u.id);
      // roleIds stays null unless we genuinely read them — the XP award treats
      // "couldn't read their roles" as no permission, not as permission.
      let roleIds = null;
      try {
        const member = message.guild ? await message.guild.members.fetch(u.id).catch(() => null) : null;
        if (member) {
          name = member.displayName || name;
          if (member.roles && member.roles.cache) roleIds = [...member.roles.cache.keys()];
        }
      } catch (e) { /* the raw username is fine */ }
      out[verdict === 'DENIED' ? 'deny' : 'approve'].push({ id: String(u.id), name, roleIds });
    }
  }
  return out;
}

// A cross outranks a tick: if anybody has objected, the log is not approved.
function statusFrom(tally) {
  if (tally.deny.length)    return { status: 'DENIED',   by: tally.deny[0] };
  if (tally.approve.length) return { status: 'APPROVED', by: tally.approve[0] };
  return { status: 'PENDING', by: null };
}

// Write a verdict onto a log, and award the event point on approval — the same
// award the site's own approve button performs, so it doesn't matter which way
// a log was signed off.
//
// `by` carries the approver's roleIds when we could read them. That is what
// decides whether the XP award runs: anybody may tick a log, but only an FLP
// officer's tick moves XP, and never on their own log or their own event.
async function applyVerdict(log, status, by) {
  if (log.status === status) return null;

  const data = { status };
  if (status === 'PENDING') {
    data.reviewedByName = null;
    data.reviewedAt     = null;
    data.reviewedById   = null;
  } else {
    data.reviewedByName = (by && by.name) || 'Reviewed in Discord';
    data.reviewedAt     = new Date();
  }

  // Only EVENT logs carry a point, and only once — pointAwarded is the guard,
  // and it is written in the same update as the status so a Discord sign-off
  // records exactly what the site's own approve button records.
  if (status === 'APPROVED' && log.type === 'EVENT' && !log.pointAwarded) {
    try {
      const { awardEventPoints } = require('./patrolLog');
      const result = await awardEventPoints(log);
      data.pointAwarded = !!(result && result.ok);
    } catch (e) {
      console.warn('[PatrolLog] event point award failed:', e.message);
    }
  }

  const updated = await prisma.patrolLog.update({ where: { id: log.id }, data });

  // XP last, and on the UPDATED row, so awardForLog sees the approval that has
  // actually been written. It stamps xpAwarded itself, which is what makes a
  // second tick (or the reconcile sweep re-reading the same reaction) a no-op
  // rather than a second payout.
  if (status === 'APPROVED' && !updated.xpAwarded) {
    try {
      const out = await require('./logXpAward').awardForLog(updated, by || null);
      if (out.ok) {
        console.log(`[LogXP] ${log.type} ${log.id} · ${out.total} XP across ${out.awarded.filter(a => a.ok).length} officer(s)`);
      } else if (out.skipped && out.skipped !== 'nothing to award') {
        console.log(`[LogXP] ${log.type} ${log.id} · no XP awarded (${out.skipped})`);
      }
    } catch (e) {
      console.warn('[LogXP] award failed:', e.message);
    }
  }

  return updated;
}

// ── Live path ─────────────────────────────────────────────────────
// `added` distinguishes a fresh decision (the reaction that just arrived IS the
// verdict — that's how a tick placed after an earlier cross flips a log) from a
// withdrawal (recompute from whatever reactions are left).
async function applyReaction(reaction, user, added) {
  try {
    if (!reaction || !user || user.bot) return null;

    // Reactions on messages the bot never cached arrive as partials.
    if (reaction.partial) { try { await reaction.fetch(); } catch (e) { return null; } }
    const message = reaction.message;
    if (!message) return null;
    if (message.partial) { try { await message.fetch(); } catch (e) { return null; } }

    if (!verdictFor(reaction.emoji)) return null;   // an unrelated emoji

    const log = await prisma.patrolLog.findUnique({ where: { messageId: String(message.id) } });
    if (!log) return null;                          // not a message we track

    // An officer cannot sign off their own log.
    if (log.submitterDiscordId && String(user.id) === String(log.submitterDiscordId)) return null;

    if (added) {
      const v = verdictFor(reaction.emoji);
      let name = user.globalName || user.username || String(user.id);
      let roleIds = null;
      try {
        const member = message.guild ? await message.guild.members.fetch(user.id).catch(() => null) : null;
        if (member) {
          name = member.displayName || name;
          if (member.roles && member.roles.cache) roleIds = [...member.roles.cache.keys()];
        }
      } catch (e) { /* the raw username is fine */ }
      return await applyVerdict(log, v, { id: String(user.id), name, roleIds });
    }

    const tally = await tallyReactions(message, log.submitterDiscordId);
    const { status, by } = statusFrom(tally);
    return await applyVerdict(log, status, by);
  } catch (e) {
    console.warn('[PatrolLog] reaction error:', e.message);
    return null;
  }
}

// ── Reconcile sweep ───────────────────────────────────────────────
// Re-reads reactions on recent PENDING logs. This is what heals a sign-off made
// while the bot was disconnected.
async function reconcile(client, opts = {}) {
  const stats = { checked: 0, updated: 0, error: null };
  if (!client) { stats.error = 'bot not ready'; return stats; }

  const take = opts.take || 200;
  let logs;
  try {
    logs = await prisma.patrolLog.findMany({
      where:   { status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
      take,
    });
  } catch (e) {
    stats.error = e.message;
    return stats;
  }

  for (const log of logs) {
    stats.checked++;
    try {
      const channel = await client.channels.fetch(String(log.channelId)).catch(() => null);
      if (!channel || typeof channel.messages?.fetch !== 'function') continue;
      const message = await channel.messages.fetch(String(log.messageId)).catch(() => null);
      if (!message) continue;

      const tally = await tallyReactions(message, log.submitterDiscordId);
      const { status, by } = statusFrom(tally);
      if (status === 'PENDING') continue;            // still unsigned — leave it
      if (await applyVerdict(log, status, by)) stats.updated++;
    } catch (e) {
      // One bad log must never abort the sweep.
      console.warn('[PatrolLog] reconcile skipped', log.id, '-', e.message);
    }
  }
  return stats;
}

let _running = false;
async function sweep(client, opts) {
  if (_running) return null;
  _running = true;
  try {
    const s = await reconcile(client, opts);
    if (s.updated || s.error) {
      console.log(`[PatrolLog] reaction sweep · checked ${s.checked}, signed off ${s.updated}${s.error ? `, error: ${s.error}` : ''}`);
    }
    return s;
  } finally {
    _running = false;
  }
}

function startReactionReconciler(client) {
  // Once the gateway has settled, then every 5 minutes behind the live handlers.
  setTimeout(() => { sweep(client).catch(() => {}); }, 30 * 1000);
  setInterval(() => { sweep(client).catch(() => {}); }, 5 * 60 * 1000);
}

module.exports = {
  verdictFor, tallyReactions, statusFrom, applyVerdict,
  applyReaction, reconcile, sweep, startReactionReconciler,
  approveEmoji, denyEmoji,
};
