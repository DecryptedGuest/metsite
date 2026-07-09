// server/lib/support.js
// Support help desk (/support): the four ticket types, their fixed intake
// questions (rule-based — no AI yet), the role → who-can-handle mapping, and a
// tiny in-process SSE hub for realtime ticket updates.
//
// Intake is rule-based for now (a fixed question script per type). The MET
// Policing Handbook + Disciplinary Infraction List can later feed an AI intake;
// AI_PROVIDER / AI_MODEL / AI_API_KEY are reserved for that.

// Site roles that can HANDLE each ticket type (opener always sees their own).
//   IA Complaint          → IA HICOMM only (reports against IA members)
//   Officer Complaint     → IA + HICOMM+   (accountability reviews)
//   Disciplinary Appeal   → Investigator+  (IA staff)
//   General Support       → any staff (Investigator+)
const IA_STAFF   = ['IA', 'SUPERVISOR', 'HICOMM', 'DEVELOPER']; // "Investigator+"
const IA_HICOMM  = ['HICOMM', 'DEVELOPER'];

const TYPES = {
  OFFICER_COMPLAINT: {
    key: 'OFFICER_COMPLAINT', label: 'Officer Complaint', button: 'Report an officer', icon: 'ti-user-exclamation',
    blurb: 'Report an officer for misconduct or abuse of power.',
    roles: IA_STAFF,
    questions: [
      { id: 'officer',  prompt: "Which officer is this about? Enter their Discord username, Roblox username, or a Discord/Roblox ID and I'll look them up.", kind: 'identity' },
      { id: 'what',     prompt: 'What happened? Describe the incident in as much detail as you can.', kind: 'longtext' },
      { id: 'evidence', prompt: 'Attach any evidence — screenshots, clips, or links. Upload files below or paste links.', kind: 'evidence', optional: true },
    ],
  },
  DISCIPLINARY_APPEAL: {
    key: 'DISCIPLINARY_APPEAL', label: 'Disciplinary Action Appeal', button: 'Appeal a punishment', icon: 'ti-gavel',
    blurb: 'Appeal a strike, demotion, exile, or blacklist you think was unfair.',
    roles: IA_STAFF,
    questions: [
      // `punishment` kind → the client offers the opener's own punishments (with
      // expiry countdowns) to pick from; `choices` is the guest / no-history fallback.
      { id: 'action',   prompt: 'Which punishment are you appealing?', kind: 'punishment', choices: ['Strike', 'Demotion', 'Exile', 'Blacklist', 'Other'] },
      { id: 'why',      prompt: 'Why would you like to appeal this punishment?', kind: 'longtext' },
      { id: 'evidence', prompt: 'Attach any supporting evidence — screenshots, clips, or links.', kind: 'evidence', optional: true },
    ],
  },
  IA_COMPLAINT: {
    key: 'IA_COMPLAINT', label: 'Internal Affairs Complaint', button: 'Report Internal Affairs', icon: 'ti-lock', restricted: true,
    blurb: 'Report Internal Affairs misusing their power. Seen only by IA HICOMM.',
    roles: IA_HICOMM,
    questions: [
      { id: 'evidence', prompt: 'Please provide your evidence first — files, clips, or links.', kind: 'evidence' },
      { id: 'what',     prompt: 'Describe what happened.', kind: 'longtext' },
      { id: 'who',      prompt: "Who is this about? Enter their Discord username, Roblox username, or a Discord/Roblox ID and I'll look them up.", kind: 'identity' },
      { id: 'when',     prompt: 'When did it occur?', kind: 'text' },
      { id: 'else',     prompt: 'Anything else relevant?', kind: 'longtext', optional: true },
    ],
  },
  GENERAL_SUPPORT: {
    key: 'GENERAL_SUPPORT', label: 'Website Support', button: 'Ask a question', icon: 'ti-lifebuoy', helpBot: true,
    blurb: 'Ask a question or get help — how to join, tryouts, anything.',
    roles: IA_STAFF,
    questions: [
      { id: 'issue', prompt: 'What do you need help with?', kind: 'longtext', optional: true },
    ],
  },
};

// The intake bot's presentation (a generic assistant — not a named person). Its
// avatar is the MET crest (this is a MET site, not IA-branded).
const BOT_NAME   = 'MET Assistant';
const BOT_AVATAR = '/img/divisions/met.png';

// ── Help-bot knowledge base (member-facing, sanitized) ────────────────
// Informational FAQ the General Support assistant can surface. Deliberately
// high-level: no internal IA thresholds, staff names, case-file handling or
// classified process — just what a member needs to understand outcomes and how
// to appeal. `body` uses the same **bold**/[link](url) markdown the chat renders.
const KNOWLEDGE = [
  {
    key: 'appeals',
    label: 'Punishments & appeals',
    body: `**Punishments & appeals**
The Metropolitan Police takes conduct seriously. Depending on how serious a rule-break is, outcomes can range from a **warning** or **strike** up to a **suspension**, **removal from the force**, or a **blacklist**. Minor issues are usually handled with a warning first; more serious ones carry heavier action.

**If you think a punishment was a mistake**
If you believe you were punished in error or you're innocent, you can appeal **straight away** — open a **Disciplinary Action Appeal** ticket and explain what happened.

**Appealing a valid punishment**
If the punishment was correct but you'd still like it reviewed, there's a short waiting period first — around **2 weeks** for minor punishments and **3 weeks** for more serious ones — and you'll need to write a clear explanation of why it should be reconsidered.

**Good to know**
• Removals from the force, and blacklists issued for **exploiting or cheating**, are generally final and can't be appealed. Blacklists for other reasons may be appealed.
• Every appeal is reviewed by Internal Affairs, and the final decision rests with them.

To start an appeal, choose **Appeal a punishment** on the support home.`,
  },
];

// ── Claim greeting templates (per ticket type) ────────────────────────
// The auto-pasted opener an investigator sends when they claim a ticket. Staff
// can override these per-user in the support desk settings. Placeholders:
//   {rank}     → the claimant's IA rank name (e.g. "Investigator")
//   {username} → the claimant's Roblox username
// Probationary Investigators automatically get ", working under the supervision
// of IA High Command" inserted after "Internal Affairs" (they can also place it
// explicitly with the {supervision} placeholder). Non-PINV never see it.
const DEFAULT_GREETINGS = {
  GENERAL_SUPPORT:     "G'day, I am {rank} {username} with Internal Affairs. I will be handling your Website Support ticket today and will assist you with any queries or concerns you may have.",
  DISCIPLINARY_APPEAL: "G'day, I am {rank} {username} with Internal Affairs. I will be reviewing your Disciplinary Action Appeal today.",
  OFFICER_COMPLAINT:   "G'day, I am {rank} {username} with Internal Affairs. I will be handling your Officer Complaint today.",
  IA_COMPLAINT:        "G'day, I am {rank} {username} with Internal Affairs. I will be handling your Internal Affairs complaint today.",
};
// Fill a greeting template. isProbationary → include the supervision clause
// (either at the explicit {supervision} placeholder, or auto-inserted after the
// first "Internal Affairs" mention). Spacing/punctuation is normalised so the
// result always reads cleanly regardless of how the template was written.
function fillGreeting(template, { rank, username, isProbationary } = {}) {
  const clause = isProbationary ? ', working under the supervision of IA High Command' : '';
  let out = String(template || '')
    .replace(/\{rank\}/g, rank || '')
    .replace(/\{username\}/g, username || '');
  if (out.includes('{supervision}')) {
    out = out.replace(/\{supervision\}/g, clause);
  } else if (clause) {
    out = out.replace(/Internal Affairs/i, m => m + clause); // auto-insert for PINV
  }
  return out
    .replace(/ {2,}/g, ' ')          // collapse doubled spaces (e.g. empty rank)
    .replace(/ +([.,])/g, '$1')      // no space before punctuation
    .replace(/,\s*,/g, ',')          // guard against a doubled comma
    .trim();
}

const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
function normPriority(p) { const v = String(p || '').toUpperCase(); return PRIORITIES.includes(v) ? v : 'NORMAL'; }

function typeConfig(type) { return TYPES[String(type || '').toUpperCase()] || null; }
function isStaff(user)    { return !!user && IA_STAFF.includes(user.role); }
// IA HICOMM (High Command) — the elevated tier that overlooks everything.
function isHicomm(user)   { return !!user && ['HICOMM', 'DEVELOPER'].includes(user.role); }

// May this user type in a ticket ALREADY CLAIMED by someone else? Only the
// genuine oversight tier — IA Supervisor (group rank 20) and above, or HICOMM /
// DEVELOPER. Deliberately NOT the coarse SUPERVISOR *site role*, which also
// covers Senior Investigator (rank 15): a Senior Investigator who didn't claim
// must be locked out of another investigator's claimed ticket. The IA group
// rank comes from the user's cached divisions; falls back to the rank name.
const IA_CLAIM_OVERRIDE_MIN_RANK = () => { const n = parseInt(process.env.IA_CLAIM_OVERRIDE_MIN_RANK, 10); return Number.isFinite(n) ? n : 20; };
function iaDivisionEntry(user) {
  const divs = (user && Array.isArray(user.divisions)) ? user.divisions : [];
  return divs.find(d => d && d.division === 'IA') || null;
}
function canOverrideClaimLock(user) {
  if (!user) return false;
  if (user.role === 'DEVELOPER' || user.role === 'HICOMM') return true;
  const e = iaDivisionEntry(user);
  const rank = e && Number.isFinite(Number(e.rank)) ? Number(e.rank) : null;
  if (rank != null) return rank >= IA_CLAIM_OVERRIDE_MIN_RANK();
  // No cached rank number → fall back to the rank NAME, but ONLY when it's a real
  // group rank name. Before enrichment runs, rankName is just the site-role string
  // ("SUPERVISOR"), which is ambiguous — a Senior Investigator (rank 15) also has
  // the SUPERVISOR site role — so we ignore that placeholder and stay locked.
  const name = (e && e.rankName ? String(e.rankName) : '');
  if (!name || name.toUpperCase() === String(user.role || '').toUpperCase()) return false;
  return /supervisor|assistant\s*director|deputy\s*director|\bdirector\b|administration|hicom|overseer|met hicomm/i.test(name);
}

// The "you're now in the queue" message, worded for who actually handles the type.
function handoffMessage(type) {
  const cfg = typeConfig(type);
  const hicommOnly = cfg && cfg.roles.length && cfg.roles.every(r => IA_HICOMM.includes(r));
  const who = hicommOnly ? 'An Internal Affairs High Command member' : 'An Internal Affairs Investigator';
  return `Thanks — your details have been recorded and your ticket is now open. ${who} will be with you shortly.`;
}

// Can this user HANDLE (view as staff / claim / reply) tickets of `type`?
function canHandle(user, type) {
  if (!user) return false;
  if (user.role === 'DEVELOPER') return true;
  const cfg = typeConfig(type);
  return !!cfg && cfg.roles.includes(user.role);
}

// Is this user the SUBJECT of a report ticket (the person being reported)?
// Checks the intake identity answers against the user's Discord/Roblox ids.
// IA must never see or handle a report filed about themselves.
function isSubjectOfReport(user, ticket) {
  if (!user || !ticket) return false;
  if (ticket.type !== 'OFFICER_COMPLAINT' && ticket.type !== 'IA_COMPLAINT') return false;
  const intake = Array.isArray(ticket.intake) ? ticket.intake : [];
  for (const q of intake) {
    const id = q && q.identity;
    if (!id) continue;
    if (id.discordId && user.discordId && String(id.discordId) === String(user.discordId)) return true;
    if (id.robloxId && user.robloxId && String(id.robloxId) === String(user.robloxId)) return true;
  }
  return false;
}

// Can this user HANDLE this specific ticket? Same as canHandle, but you can
// never claim/close/handle a ticket you opened yourself (except DEVELOPER, for
// testing) — you interact with it purely as its opener — and you can never
// handle a report filed ABOUT you (an officer report can't be claimed by the
// officer it names).
function canHandleTicket(user, ticket) {
  if (!user || !ticket) return false;
  // Developers bypass every gate — including the "can't handle your own ticket"
  // rule — so they can test the full claim/handle flow on their own tickets.
  if (user.role === 'DEVELOPER') return true;
  // Real IA staff can't claim/handle/log a ticket they opened (integrity).
  if (ticket.openerId && ticket.openerId === user.id) return false;
  // …nor a report that names them as the subject.
  if (isSubjectOfReport(user, ticket)) return false;
  return canHandle(user, ticket.type);
}

// The ticket types this user can handle (drives the staff queue + landing).
function handleableTypes(user) {
  return Object.keys(TYPES).filter(t => canHandle(user, t));
}

// Can this user VIEW this ticket at all? Opener, or handling staff.
function canView(user, ticket) {
  if (!user || !ticket) return false;
  if (ticket.openerId === user.id) return true;
  // A named subject of a report can't even view the report filed about them
  // (except DEVELOPER, for testing) — same integrity rule as canHandleTicket.
  if (user.role !== 'DEVELOPER' && isSubjectOfReport(user, ticket)) return false;
  return canHandle(user, ticket.type);
}

// Public (client-safe) view of the type catalogue for the landing page.
function publicCatalogue() {
  return Object.values(TYPES).map(t => ({
    key: t.key, label: t.label, button: t.button, blurb: t.blurb, icon: t.icon,
    restricted: !!t.restricted, helpBot: !!t.helpBot, questions: t.questions,
  }));
}

// ── In-process SSE hub ───────────────────────────────────────────────
// One process on Railway → an in-memory pub/sub is enough for realtime.
// (Multi-instance would need Redis; noted for later.)
const _subs = new Map(); // ticketId -> Set({ res, staff })

// `meta.staff` marks a subscriber as a handling staff member, so staff-only
// events (internal notes) are never written to an opener's stream.
function subscribe(ticketId, res, meta) {
  const key = String(ticketId);
  if (!_subs.has(key)) _subs.set(key, new Set());
  const sub = { res, staff: !!(meta && meta.staff) };
  _subs.get(key).add(sub);
  res.on('close', () => {
    const set = _subs.get(key);
    if (set) { set.delete(sub); if (!set.size) _subs.delete(key); }
  });
}

// opts.staffOnly → only deliver to staff subscribers (used for internal notes).
function publish(ticketId, event, data, opts) {
  const set = _subs.get(String(ticketId));
  if (!set || !set.size) return;
  const staffOnly = !!(opts && opts.staffOnly);
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const sub of set) {
    if (staffOnly && !sub.staff) continue;
    try { sub.res.write(frame); } catch (e) { /* dropped client */ }
  }
}

// Alert eligible staff that a ticket just became ready to claim: an instant,
// in-page popup + chime on their dashboard (events-client.js 'support_open'),
// on top of the durable web-push. Best-effort — never blocks the open request.
async function broadcastOpenTicket(ticket) {
  try {
    if (!ticket) return;
    const cfg = typeConfig(ticket.type);
    const roles = (cfg && cfg.roles) || IA_STAFF;
    const prisma = require('./db');
    const events = require('./events');
    const staff = await prisma.user.findMany({
      where: { role: { in: roles }, isBlacklisted: false },
      select: { id: true },
    });
    // A one-line preview from the opener's first non-empty intake answer.
    let preview = null;
    const intake = Array.isArray(ticket.intake) ? ticket.intake : [];
    const firstAns = intake.find(q => q && q.answer && String(q.answer).trim());
    if (firstAns) preview = String(firstAns.answer).slice(0, 160);
    const idEnc = encodeURIComponent(ticket.id);
    const payload = {
      ticketId:   ticket.id,
      type:       ticket.type,
      typeLabel:  (cfg && cfg.label) || ticket.type,
      openerName: ticket.openerName || 'a member',
      preview,
      url: `/ia/dashboard?supportTicket=${idEnc}&claim=1`,
    };
    // Never alert the opener about their own ticket.
    const targetIds = staff.map(s => s.id).filter(id => !(ticket.openerId && id === ticket.openerId));
    // Instant in-page popup + loud chime for any eligible staffer on the site now.
    for (const id of targetIds) events.publishToUser(id, 'support_open', payload);
    // Durable web push to the same IA set (phone + desktop) with action buttons,
    // so investigators who aren't on the site still get alerted and can jump in.
    try {
      require('./push').sendCustomNotification({
        userIds: targetIds,
        title: `New ticket · ${(cfg && cfg.label) || 'Internal Affairs'}`,
        body:   `${ticket.openerName || 'A member'} opened a ticket — tap to claim.`,
        url:      `/ia/dashboard?supportTicket=${idEnc}&claim=1`,
        viewUrl:  `/ia/dashboard?supportTicket=${idEnc}`,
        claimUrl: `/ia/dashboard?supportTicket=${idEnc}&claim=1`,
        actions: [{ action: 'claim', title: 'Claim ticket' }, { action: 'view', title: 'Go to ticket' }],
        requireInteraction: true, vibrate: [200, 100, 200], tag: 'support-ticket-' + ticket.id,
      }).catch(() => {});
    } catch (e) { /* push is best-effort */ }

    // Discord DM to IA investigators/supervisors — "all of IA apart from IA
    // HICOMM" — who haven't opted out: a tap-to-claim link + a one-click opt-out
    // (they can turn it back on any time). Best-effort and per-user independent.
    try {
      const dmRoles = roles.filter(r => !IA_HICOMM.includes(r));
      const { siteBaseUrl, ticketDmToggleUrl } = require('./dmOptOut');
      const base = siteBaseUrl();
      if (dmRoles.length && base) {
        const dmStaff = await prisma.user.findMany({
          where: { role: { in: dmRoles }, isBlacklisted: false, discordId: { not: null } },
          select: { id: true, discordId: true, notifyPrefs: true },
        });
        const bot = require('./bot');
        for (const u of dmStaff) {
          if (ticket.openerId && u.id === ticket.openerId) continue; // never DM the opener
          const prefs = (u.notifyPrefs && typeof u.notifyPrefs === 'object') ? u.notifyPrefs : {};
          if (prefs.ticketDM === false) continue; // opted out
          bot.dmTicketAlert(u.discordId, {
            typeLabel:  (cfg && cfg.label) || 'Internal Affairs ticket',
            openerName: ticket.openerName || 'a member',
            preview,
            claimUrl:   `${base}/ia/dashboard?supportTicket=${idEnc}&claim=1`,
            optOutUrl:  ticketDmToggleUrl(u.id, true),
          }).catch(() => {});
        }
      }
    } catch (e) { /* DM alerting is best-effort */ }
  } catch (e) { /* best-effort */ }
}

// ── Identity resolution (for "which officer / who" intake questions) ──
// Accepts a Discord username, Roblox username, or a Discord/Roblox ID, and
// resolves it to a Roblox profile (username + headshot) so the opener can
// confirm they picked the right person. Cached to spare RoVer's rate limit.
const _idCache = new Map(); // key(lowercased input) -> { at, person }
const ID_TTL = 10 * 60 * 1000;

async function _buildPerson(robloxId, extra) {
  const roblox = require('./roblox');
  const [info, head] = await Promise.all([
    roblox.getRobloxUserInfo(String(robloxId)).catch(() => null),
    roblox.getRobloxAvatarHeadshot(String(robloxId)).catch(() => null),
  ]);
  if (!info && !head) return null;
  const out = {
    robloxId: String(robloxId),
    robloxUsername: info ? info.username : null,
    robloxDisplayName: info ? info.displayName : null,
    headshotUrl: head || null,
    robloxUrl: `https://www.roblox.com/users/${robloxId}/profile`,
    ...(extra || {}),
  };
  // If we don't already know the Discord side, reverse-resolve it via RoVer so
  // the confirmation card can show the Discord ID next to the username.
  if (!out.discordId) {
    try {
      const matches = await roblox.getDiscordFromRoblox(String(robloxId));
      if (matches && matches[0] && matches[0].discordId) out.discordId = String(matches[0].discordId);
    } catch (e) { /* RoVer down → no discord id */ }
  }
  // Enrich with the Discord profile (avatar + display name) so the "is this the
  // right person?" card can show a Discord picture beside the Roblox one, with
  // both platform logos. Best-effort — needs the bot to be in the guild.
  if (out.discordId && !out.discordAvatar) {
    try {
      const bot = require('./bot');
      const guildId = process.env.DISCORD_GUILD_ID;
      const gm = guildId ? await bot.getGuildMemberInfo(String(out.discordId), guildId) : null;
      if (gm) {
        if (gm.avatar) out.discordAvatar = gm.avatar;
        if (gm.displayName) {
          out.discordDisplayName = gm.displayName;
          if (!out.discordUsername) out.discordUsername = gm.displayName;
        }
      }
    } catch (e) { /* bot/guild lookup unavailable → no discord avatar */ }
  }
  return out;
}

async function resolveIdentity(input) {
  const raw = String(input || '').trim().replace(/^@/, '');
  if (!raw) return null;
  const key = raw.toLowerCase();
  const cached = _idCache.get(key);
  if (cached && Date.now() - cached.at < ID_TTL) return cached.person;

  const roblox = require('./roblox');
  const allDigits = /^\d+$/.test(raw);
  let person = null;
  try {
    if (allDigits && raw.length >= 17) {
      // Discord snowflake → RoVer → Roblox
      const rid = await roblox.getRobloxIdFromDiscord(raw).catch(() => null);
      if (rid) person = await _buildPerson(rid, { discordId: raw });
    } else if (allDigits) {
      // Roblox ID
      person = await _buildPerson(raw, {});
    } else {
      // A username — try a Discord guild member first (→ RoVer), then Roblox.
      try {
        const { findMemberByUsername } = require('./bot');
        const m = await findMemberByUsername(raw);
        if (m) {
          const rid = await roblox.getRobloxIdFromDiscord(m.id).catch(() => null);
          if (rid) person = await _buildPerson(rid, { discordId: m.id, discordUsername: m.username });
        }
      } catch (e) { /* bot/guild lookup unavailable */ }
      if (!person) {
        // getRobloxIdFromUsername returns { id, username, displayName } — use .id.
        const u = await roblox.getRobloxIdFromUsername(raw).catch(() => null);
        if (u && u.id) person = await _buildPerson(u.id, {});
      }
    }
  } catch (e) { person = null; }

  _idCache.set(key, { at: Date.now(), person });
  return person;
}

module.exports = {
  TYPES, typeConfig, isStaff, isHicomm, canOverrideClaimLock, canHandle, canHandleTicket, handleableTypes, canView, publicCatalogue,
  handoffMessage, resolveIdentity, subscribe, publish, broadcastOpenTicket, PRIORITIES, normPriority,
  BOT_NAME, BOT_AVATAR, IA_STAFF, IA_HICOMM,
  KNOWLEDGE, DEFAULT_GREETINGS, fillGreeting,
};
