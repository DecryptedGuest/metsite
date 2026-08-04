// server/lib/loa.js — Leave of absence, the rules and the record.
//
// Everything about an LOA happens in Discord: /loa request, active, admin,
// history, manage, pending. There is no page for it. The people who need leave
// are in Discord and the people who grant it are in Discord, and a workflow
// that lives in two places is a workflow where one of them is always stale.
//
// This module is the half with no Discord in it — durations, dates, the state
// machine, who may decide — so all of it can be tested without a gateway
// connection. loaCommand.js is the half that draws it.
//
// The rules, as MET runs them:
//
//   · duration is written the way people write it: 7d, 2w, 10 days, 1 week
//   · nothing starts in the past and nothing is auto-approved. Jade Command
//     decide, by hand, every time
//   · two weeks is the ceiling. Longer is not refused outright — command may
//     still grant it — but it is flagged as over the limit so the decision is
//     a decision rather than an oversight
//   · one live leave per person. Asking again while one is pending or running
//     is a mistake, not a second holiday
//
// Env:
//   LOA_ADMIN_ROLE_ID   the Discord role that reviews (default: Jade Command)
//   LOA_CHANNEL_ID      where request cards are posted for review
//   LOA_MAX_DAYS        the soft ceiling, in days (default 14)
//   LOA_ROLE_ID         the ON-LEAVE role, taken off when the leave finishes

const prisma = require('./db');

const ADMIN_ROLE = () => process.env.LOA_ADMIN_ROLE_ID || '1422406753231966290';
// The role that says somebody is away. Unset until it is configured, and every
// caller treats "no role configured" as "nothing to do" rather than as an error —
// the leave still closes, it just closes without touching anybody's roles.
//
// Note that nothing here ADDS it: it is put on by hand, or was already on before
// this system existed. That asymmetry is deliberate — see removeLeaveRole.
const LEAVE_ROLE = () => process.env.LOA_ROLE_ID || '';
// The MET leave-of-absence channel. Request cards are posted here and pinged
// at Jade Command; every later change to a leave is replied to the same card,
// so one request reads as one thread rather than as scattered messages.
const CHANNEL    = () => process.env.LOA_CHANNEL_ID || process.env.LOA_REQUEST_CHANNEL_ID
                       || '1499804454906630217';
const MAX_DAYS   = () => {
  const n = parseInt(process.env.LOA_MAX_DAYS, 10);
  return Number.isFinite(n) && n > 0 ? n : 14;
};

// Absolute ceiling, separate from the soft one. Beyond this it stops being
// leave — the message in the server says as much — and a typo like "365d"
// should not be able to book a year off.
const HARD_MAX_DAYS = 90;

const DAY = 86400000;

// ── Duration ──────────────────────────────────────────────────────
/**
 * Read a duration the way somebody writes it: "7d", "2w", "10 days", "1 week",
 * "3". A bare number is days, because that is what people mean.
 *
 * @param {string} raw
 * @returns {{ days: number|null, why: string|null }}
 */
function parseDuration(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s) return { days: null, why: 'Say how long, like `7d` or `2w`.' };

  const m = /^(\d{1,3})\s*(d|day|days|w|wk|wks|week|weeks|m|mo|month|months)?$/.exec(s);
  if (!m) {
    return { days: null, why: 'That is not a duration I can read. Write it like `7d`, `2w` or `10 days`.' };
  }
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return { days: null, why: 'A leave has to be at least one day.' };

  const unit = m[2] || 'd';
  const days = /^w/.test(unit) ? n * 7
             : /^m/.test(unit) ? n * 30
             : n;

  if (days > HARD_MAX_DAYS) {
    return { days: null, why: `${days} days is not a leave of absence. If you need longer than ${HARD_MAX_DAYS} days, speak to command directly.` };
  }
  return { days, why: null };
}

/** "7 days" / "2 weeks" / "1 day" — the length said back in words. */
function humanDays(days) {
  const d = Math.max(0, Math.round(Number(days) || 0));
  if (d === 0) return 'less than a day';
  if (d % 7 === 0 && d >= 7) {
    const w = d / 7;
    return `${w} week${w === 1 ? '' : 's'}`;
  }
  return `${d} day${d === 1 ? '' : 's'}`;
}

/** Whole days between now and `when`, never negative. */
function daysUntil(when) {
  const ms = new Date(when).getTime() - Date.now();
  return ms <= 0 ? 0 : Math.ceil(ms / DAY);
}

/** Discord's own relative timestamp, so everyone reads it in their own zone. */
function ts(date, style = 'D') {
  return `<t:${Math.floor(new Date(date).getTime() / 1000)}:${style}>`;
}

// ── Status ────────────────────────────────────────────────────────
const OPEN_STATUSES   = ['PENDING', 'APPROVED'];
const CLOSED_STATUSES = ['DENIED', 'CANCELLED', 'ENDED', 'EXPIRED'];

/** Is this leave running right now? */
function isActive(r, at = new Date()) {
  if (!r || r.status !== 'APPROVED') return false;
  if (r.endedAt) return false;
  const t = new Date(at).getTime();
  return new Date(r.startAt).getTime() <= t && new Date(r.endAt).getTime() >= t;
}

/** How a status reads to a person. */
const STATUS_LABEL = {
  PENDING:   'Awaiting a decision',
  APPROVED:  'Approved',
  DENIED:    'Denied',
  CANCELLED: 'Withdrawn',
  ENDED:     'Ended early',
  EXPIRED:   'Finished',
};

// ── Who may decide ────────────────────────────────────────────────
/**
 * Only the admin role reviews leave. Deliberately not "or anyone with
 * Administrator": the server has one group who own this, and widening it by
 * permission bit is how a decision ends up made by somebody who was never
 * meant to make it. The developer id is allowed so the system can be operated
 * when the role is misconfigured.
 *
 * @param {import('discord.js').GuildMember|null} member
 * @param {string} [userId]
 */
function canReview(member, userId) {
  const dev = process.env.DEVELOPER_DISCORD_ID;
  if (dev && userId && String(userId) === String(dev)) return true;
  if (!member || !member.roles || !member.roles.cache) return false;
  return member.roles.cache.has(ADMIN_ROLE());
}

// ── Reading ───────────────────────────────────────────────────────
/** Somebody's leave they could still act on: pending, or approved and running. */
async function openFor(discordId) {
  if (!discordId) return null;
  const rows = await prisma.loaRequest.findMany({
    where: { discordId: String(discordId), status: { in: OPEN_STATUSES }, endedAt: null },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });
  // A leave whose end date has passed is not open any more, whatever the row
  // still says — the sweep may simply not have run yet.
  return rows.find(r => r.status === 'PENDING' || new Date(r.endAt).getTime() > Date.now()) || null;
}

/** Every leave running right now, soonest to end first. */
async function activeNow(take = 25) {
  const now = new Date();
  const rows = await prisma.loaRequest.findMany({
    where: { status: 'APPROVED', endedAt: null, startAt: { lte: now }, endAt: { gte: now } },
    orderBy: { endAt: 'asc' },
    take: Math.min(Math.max(parseInt(take, 10) || 25, 1), 200),
  });
  return rows;
}

/** Everything waiting on a decision, oldest first — the queue, in order. */
async function pending(take = 25) {
  return prisma.loaRequest.findMany({
    where: { status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
    take: Math.min(Math.max(parseInt(take, 10) || 25, 1), 200),
  });
}

/** One person's leave, newest first — or everyone's, when no id is given. */
async function history(discordId, take = 15) {
  return prisma.loaRequest.findMany({
    where: discordId ? { discordId: String(discordId) } : {},
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(parseInt(take, 10) || 15, 1), 100),
  });
}

async function byId(id) {
  if (!id) return null;
  return prisma.loaRequest.findUnique({ where: { id } }).catch(() => null);
}

// ── Writing ───────────────────────────────────────────────────────
function clean(v, max) {
  return String(v == null ? '' : v).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max);
}

/**
 * File a request. Starts NOW — the command deliberately does not take a start
 * date, because the bot this replaces had one and it was the single biggest
 * source of broken requests.
 *
 * @param {object} o
 * @param {string} o.discordId
 * @param {string} [o.discordUsername]
 * @param {string} [o.displayName]
 * @param {number} o.days
 * @param {string} o.reason
 * @returns {Promise<{ ok: boolean, why?: string, request?: object, overLimit?: boolean }>}
 */
async function create(o) {
  const days = Math.trunc(Number(o.days));
  if (!o.discordId) return { ok: false, why: 'I could not work out who you are.' };
  if (!Number.isFinite(days) || days <= 0) return { ok: false, why: 'A leave has to be at least one day.' };
  if (days > HARD_MAX_DAYS) return { ok: false, why: `${days} days is beyond what leave covers.` };

  const reason = clean(o.reason, 900);
  if (reason.length < 3) return { ok: false, why: 'Give a reason — command decide on it, and "n/a" is not one.' };

  const already = await openFor(o.discordId);
  if (already) {
    return {
      ok: false,
      why: already.status === 'PENDING'
        ? 'You already have a request waiting on a decision. Use `/loa manage` to withdraw it first.'
        : 'You are already on leave. Use `/loa manage` to change it or end it early.',
      existing: already,
    };
  }

  const startAt = new Date();
  const endAt   = new Date(startAt.getTime() + days * DAY);

  // A site account when they have one, so their leave and their dashboard are
  // the same person. Not required — plenty of members have never signed in.
  let user = null;
  try {
    user = await prisma.user.findUnique({
      where: { discordId: String(o.discordId) },
      select: { id: true, displayName: true, discordUsername: true },
    });
  } catch (e) { /* the request does not depend on it */ }

  const request = await prisma.loaRequest.create({
    data: {
      userId:          user ? user.id : null,
      userName:        o.displayName || (user && (user.displayName || user.discordUsername)) || o.discordUsername || null,
      discordId:       String(o.discordId),
      discordUsername: o.discordUsername || null,
      scope:           'MET',
      division:        null,
      reason,
      startAt, endAt,
      status:          'PENDING',
      forwardedTo:     'Jade Command',
    },
  });

  return { ok: true, request, overLimit: days > MAX_DAYS() };
}

/**
 * Approve or deny. Atomic on PENDING, so two reviewers pressing at once cannot
 * both win — the second is told it was already decided rather than overwriting
 * the first.
 */
async function decide(id, action, reviewer, note) {
  const act = String(action || '').toLowerCase();
  if (!['approve', 'deny'].includes(act)) return { ok: false, why: 'That is not a decision.' };

  const before = await byId(id);
  if (!before) return { ok: false, why: 'That request no longer exists.' };
  if (before.status !== 'PENDING') {
    return { ok: false, why: `That request was already ${STATUS_LABEL[before.status].toLowerCase()}.`, request: before };
  }
  // Nobody decides their own leave, whatever role they hold.
  if (reviewer && before.discordId && String(before.discordId) === String(reviewer.id)) {
    return { ok: false, why: 'You cannot decide your own leave.', request: before };
  }

  const claim = await prisma.loaRequest.updateMany({
    where: { id, status: 'PENDING' },
    data: {
      status:       act === 'approve' ? 'APPROVED' : 'DENIED',
      reviewerId:   reviewer ? String(reviewer.id) : null,
      reviewerName: reviewer ? (reviewer.name || null) : null,
      reviewNote:   note ? clean(note, 900) : null,
      reviewedAt:   new Date(),
      // An approved leave starts the moment it is granted, not when it was
      // asked for — otherwise a request sat on for three days quietly spends
      // three days of the member's leave.
      ...(act === 'approve' ? { startAt: new Date() } : {}),
    },
  });
  if (!claim.count) {
    const now = await byId(id);
    return { ok: false, why: 'Somebody decided that one first.', request: now };
  }

  // Approving keeps the length that was asked for, measured from now.
  if (act === 'approve') {
    const days = Math.max(1, Math.round((new Date(before.endAt) - new Date(before.startAt)) / DAY));
    await prisma.loaRequest.update({
      where: { id },
      data:  { endAt: new Date(Date.now() + days * DAY) },
    });
  }

  return { ok: true, request: await byId(id), action: act };
}

/** The member withdraws a request that has not been decided. */
async function cancel(id, discordId) {
  const r = await byId(id);
  if (!r) return { ok: false, why: 'That request no longer exists.' };
  if (String(r.discordId) !== String(discordId)) return { ok: false, why: 'That is not your request.' };
  if (r.status !== 'PENDING') return { ok: false, why: 'Only a request still waiting on a decision can be withdrawn.' };
  const claim = await prisma.loaRequest.updateMany({
    where: { id, status: 'PENDING' }, data: { status: 'CANCELLED' },
  });
  if (!claim.count) return { ok: false, why: 'Somebody decided that one first.' };
  return { ok: true, request: await byId(id) };
}

/**
 * End a running leave early — the member coming back, or command ending it.
 * `by` is who did it; when it is not the member themselves, the notice says so.
 */
async function end(id, by, reason) {
  const r = await byId(id);
  if (!r) return { ok: false, why: 'That leave no longer exists.' };
  if (r.status !== 'APPROVED' || r.endedAt) {
    return { ok: false, why: 'That leave is not running.', request: r };
  }
  const claim = await prisma.loaRequest.updateMany({
    where: { id, status: 'APPROVED', endedAt: null },
    data: {
      status: 'ENDED', endedAt: new Date(),
      endedById:   by ? String(by.id) : null,
      endedByName: by ? (by.name || null) : null,
      reviewNote:  reason ? clean(reason, 500) : r.reviewNote,
    },
  });
  if (!claim.count) return { ok: false, why: 'That leave had already finished.' };
  return { ok: true, request: await byId(id), byThem: !!(by && String(by.id) === String(r.discordId)) };
}

/**
 * Ask for more time, or give some back.
 *
 * MORE time is a request — it goes back to command, because "I'll just extend
 * myself" is the hole every LOA system has. LESS time is applied immediately:
 * nobody needs permission to come back sooner.
 */
async function change(id, discordId, kind, days, reason) {
  const r = await byId(id);
  if (!r) return { ok: false, why: 'That leave no longer exists.' };
  if (String(r.discordId) !== String(discordId)) return { ok: false, why: 'That is not your leave.' };
  if (r.status !== 'APPROVED' || r.endedAt) return { ok: false, why: 'That leave is not running.' };

  const n = Math.trunc(Number(days));
  if (!Number.isFinite(n) || n <= 0) return { ok: false, why: 'Say how many days.' };

  if (kind === 'REDUCE') {
    const endAt = new Date(new Date(r.endAt).getTime() - n * DAY);
    if (endAt.getTime() <= Date.now()) {
      // Taking off more than is left is just coming back now, and saying so is
      // kinder than refusing on a technicality.
      return end(id, { id: discordId, name: r.userName }, reason || 'Returned early');
    }
    const updated = await prisma.loaRequest.update({
      where: { id }, data: { endAt, changeRequest: null },
    });
    return { ok: true, request: updated, applied: true, kind: 'REDUCE' };
  }

  if (kind === 'EXTEND') {
    const endAt = new Date(new Date(r.endAt).getTime() + n * DAY);
    const total = Math.round((endAt - new Date(r.startAt)) / DAY);
    if (total > HARD_MAX_DAYS) {
      return { ok: false, why: `That would take the leave past ${HARD_MAX_DAYS} days in total.` };
    }
    const updated = await prisma.loaRequest.update({
      where: { id },
      data: {
        changeRequest: {
          kind: 'EXTEND',
          days: n,
          endAt: endAt.toISOString(),
          reason: reason ? clean(reason, 500) : null,
          at: new Date().toISOString(),
        },
      },
    });
    return { ok: true, request: updated, applied: false, kind: 'EXTEND', wouldEndAt: endAt, totalDays: total };
  }

  return { ok: false, why: 'That is not a change I can make.' };
}

/** Command decides on a requested extension. */
async function decideChange(id, action, reviewer) {
  const r = await byId(id);
  if (!r) return { ok: false, why: 'That leave no longer exists.' };
  if (!r.changeRequest || !r.changeRequest.kind) return { ok: false, why: 'There is no change waiting on that leave.' };
  if (r.status !== 'APPROVED' || r.endedAt) return { ok: false, why: 'That leave is not running.' };

  if (String(action).toLowerCase() === 'approve') {
    const updated = await prisma.loaRequest.update({
      where: { id },
      data: {
        endAt: new Date(r.changeRequest.endAt),
        changeRequest: null,
        reviewerId:   reviewer ? String(reviewer.id) : r.reviewerId,
        reviewerName: reviewer ? (reviewer.name || null) : r.reviewerName,
      },
    });
    return { ok: true, request: updated, granted: true, days: r.changeRequest.days };
  }
  const updated = await prisma.loaRequest.update({ where: { id }, data: { changeRequest: null } });
  return { ok: true, request: updated, granted: false, days: r.changeRequest.days };
}

/**
 * Close off leave whose end date has passed.
 *
 * Without this an approved leave stays "active" forever and `/loa active` fills
 * up with people who came back weeks ago. Idempotent: `expiredAt` is what stops
 * a second sweep touching the same rows.
 *
 * @returns {Promise<{ closed: number, people: Array<{discordId, userName}> }>}
 */
async function expire() {
  const due = await prisma.loaRequest.findMany({
    where: { status: 'APPROVED', endedAt: null, expiredAt: null, endAt: { lt: new Date() } },
    take: 200,
  });
  if (!due.length) return { closed: 0, people: [] };
  await prisma.loaRequest.updateMany({
    where: { id: { in: due.map(r => r.id) } },
    data:  { status: 'EXPIRED', expiredAt: new Date() },
  });
  return {
    closed: due.length,
    people: due.map(r => ({ id: r.id, discordId: r.discordId, userName: r.userName, endAt: r.endAt })),
  };
}

/**
 * Take the on-leave role off somebody whose leave has finished.
 *
 * The sweep used to close the record and announce the return, and leave the role
 * exactly where it was — so the list said they were back and Discord said they
 * were away, and somebody had to notice and fix it by hand. For imported leave
 * that is the whole job: the nine people brought in from the old list already hold
 * the role, and taking it off at the right moment is the only thing the system
 * needs to do for them.
 *
 * Removal only, never addition. This code cannot know whether a role it added
 * would be the same one a human meant, and a leave that is closed with the role
 * still on is a visible mistake somebody will report — whereas a role wrongly
 * ADDED to a member who is not away is an invisible one.
 *
 * Never throws. A leave has to close whether or not Discord cooperates; the
 * alternative is a sweep that dies on one missing member and leaves every later
 * leave open.
 *
 * @returns {Promise<{ ok, why? }>} why is a short, loggable reason
 */
async function removeLeaveRole(client, discordId, guildId) {
  const roleId = LEAVE_ROLE();
  if (!roleId) return { ok: false, why: 'no LOA_ROLE_ID is configured' };
  if (!client || !discordId) return { ok: false, why: 'no client or no Discord id' };
  const gid = guildId || process.env.DISCORD_GUILD_ID;
  if (!gid) return { ok: false, why: 'no DISCORD_GUILD_ID' };
  try {
    const guild = await client.guilds.fetch(gid);
    const member = await guild.members.fetch(String(discordId));
    if (!member.roles.cache.has(roleId)) return { ok: true, why: 'they did not have it' };
    await member.roles.remove(roleId, 'Leave of absence finished');
    return { ok: true };
  } catch (err) {
    // Name the two that actually happen, because both are a configuration fix
    // rather than a mystery.
    const why =
        err && err.code === 10007 ? 'they have left the server'
      : err && err.code === 50013 ? 'the bot needs "Manage Roles", and its own highest role must sit ABOVE the leave role'
      : (err && err.message) || 'unknown';
    return { ok: false, why };
  }
}

module.exports = {
  ADMIN_ROLE, CHANNEL, MAX_DAYS, HARD_MAX_DAYS, DAY, LEAVE_ROLE, removeLeaveRole,
  parseDuration, humanDays, daysUntil, ts,
  OPEN_STATUSES, CLOSED_STATUSES, STATUS_LABEL, isActive, canReview,
  openFor, activeNow, pending, history, byId,
  create, decide, cancel, end, change, decideChange, expire,
};
