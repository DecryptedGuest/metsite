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
      { id: 'why',      prompt: 'Why do you believe it was unjustified? Explain your side.', kind: 'longtext' },
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
    key: 'GENERAL_SUPPORT', label: 'General Support', button: 'Ask a question', icon: 'ti-lifebuoy', helpBot: true,
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
//   {rank}        → the claimant's IA rank name (e.g. "Investigator")
//   {username}    → the claimant's Roblox username
//   {supervision} → ", working under the supervision of IA High Command"
//                   (auto-added only for Probationary Investigators)
const DEFAULT_GREETINGS = {
  GENERAL_SUPPORT:     "G'day, I am {rank} {username} with Internal Affairs{supervision}. I will be handling your General Support ticket today and will assist you with any queries or concerns you may have.",
  DISCIPLINARY_APPEAL: "G'day, I am {rank} {username} with Internal Affairs{supervision}. I will be reviewing your Disciplinary Action Appeal today.",
  OFFICER_COMPLAINT:   "G'day, I am {rank} {username} with Internal Affairs{supervision}. I will be handling your Officer Complaint today.",
  IA_COMPLAINT:        "G'day, I am {rank} {username} with Internal Affairs{supervision}. I will be handling your Internal Affairs complaint today.",
};
// Fill a greeting template. isProbationary → include the supervision clause.
function fillGreeting(template, { rank, username, isProbationary } = {}) {
  const supervision = isProbationary ? ', working under the supervision of IA High Command' : '';
  return String(template || '')
    .replace(/\{rank\}/g, rank || '')
    .replace(/\{username\}/g, username || '')
    .replace(/\{supervision\}/g, supervision)
    .replace(/\s{2,}/g, ' ')   // collapse doubled spaces (e.g. when rank is empty)
    .replace(/\s+([.,])/g, '$1')
    .trim();
}

const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
function normPriority(p) { const v = String(p || '').toUpperCase(); return PRIORITIES.includes(v) ? v : 'NORMAL'; }

function typeConfig(type) { return TYPES[String(type || '').toUpperCase()] || null; }
function isStaff(user)    { return !!user && IA_STAFF.includes(user.role); }
// IA HICOMM (High Command) — the elevated tier that overlooks everything.
function isHicomm(user)   { return !!user && ['HICOMM', 'DEVELOPER'].includes(user.role); }

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

// Can this user HANDLE this specific ticket? Same as canHandle, but you can
// never claim/close/handle a ticket you opened yourself (except DEVELOPER, for
// testing) — you interact with it purely as its opener.
function canHandleTicket(user, ticket) {
  if (!user || !ticket) return false;
  if (user.role === 'DEVELOPER') return true;
  if (ticket.openerId === user.id) return false;
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
  TYPES, typeConfig, isStaff, isHicomm, canHandle, canHandleTicket, handleableTypes, canView, publicCatalogue,
  handoffMessage, resolveIdentity, subscribe, publish, PRIORITIES, normPriority,
  BOT_NAME, BOT_AVATAR, IA_STAFF, IA_HICOMM,
  KNOWLEDGE, DEFAULT_GREETINGS, fillGreeting,
};
