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
    key: 'OFFICER_COMPLAINT', label: 'Officer Complaint', button: 'Officer Reports', icon: 'ti-user-exclamation',
    blurb: 'Have you experienced misconduct, abuse of authority, or disrespect from an officer? Submit a ticket here to initiate a formal review—follow-up actions will be taken to ensure accountability.',
    roles: IA_STAFF,
    questions: [
      { id: 'officer',  prompt: "Which officer is this about? Enter their Discord username, Roblox username, or a Discord/Roblox ID and I'll look them up.", kind: 'identity' },
      { id: 'what',     prompt: 'What happened? Describe the incident in as much detail as you can.', kind: 'longtext' },
      { id: 'when',     prompt: 'When did this happen? (date & time, or roughly)', kind: 'text' },
      { id: 'evidence', prompt: 'Attach any evidence — screenshots, clips, or links. Upload files below or paste links.', kind: 'evidence', optional: true },
      { id: 'outcome',  prompt: 'What outcome are you hoping for?', kind: 'text', optional: true },
    ],
  },
  DISCIPLINARY_APPEAL: {
    key: 'DISCIPLINARY_APPEAL', label: 'Disciplinary Action Appeal', button: 'Disciplinary Action', icon: 'ti-gavel',
    blurb: 'Have you been unfairly striked, demoted, exiled, or blacklisted without clear justification? Submit a ticket to request support and a thorough review of your case.',
    roles: IA_STAFF,
    questions: [
      { id: 'action',   prompt: 'What action was taken against you?', kind: 'choice', choices: ['Strike', 'Demotion', 'Exile', 'Blacklist', 'Other'] },
      { id: 'why',      prompt: 'Why do you believe it was unjustified? Explain your side.', kind: 'longtext' },
      { id: 'evidence', prompt: 'Attach any supporting evidence — screenshots, clips, or links.', kind: 'evidence', optional: true },
    ],
  },
  IA_COMPLAINT: {
    key: 'IA_COMPLAINT', label: 'Internal Affairs Complaint', button: 'HICOMM Only', icon: 'ti-lock', restricted: true,
    blurb: 'Have Discord usernames, screenshots, video clips, or clear evidence of internal affairs misusing their power or authority? Submit a ticket below to report it directly to IA-HICOMM and AC+. We take these matters seriously — your case will be reviewed with discretion and action.',
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
    key: 'GENERAL_SUPPORT', label: 'General Support', button: 'General Support', icon: 'ti-lifebuoy',
    blurb: 'Get in touch with an experienced Officer to resolve any issues in the Metropolitan Police Department.',
    roles: IA_STAFF,
    questions: [
      { id: 'issue', prompt: 'How can we help? Briefly describe your issue and someone will be with you shortly.', kind: 'longtext', optional: true },
    ],
  },
};

// The intake bot's presentation (a generic assistant — not a named person). Its
// avatar is the MET crest (this is a MET site, not IA-branded).
const BOT_NAME   = 'MET Assistant';
const BOT_AVATAR = '/img/divisions/met.png';

function typeConfig(type) { return TYPES[String(type || '').toUpperCase()] || null; }
function isStaff(user)    { return !!user && IA_STAFF.includes(user.role); }

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
    restricted: !!t.restricted, questions: t.questions,
  }));
}

// ── In-process SSE hub ───────────────────────────────────────────────
// One process on Railway → an in-memory pub/sub is enough for realtime.
// (Multi-instance would need Redis; noted for later.)
const _subs = new Map(); // ticketId -> Set(res)

function subscribe(ticketId, res) {
  const key = String(ticketId);
  if (!_subs.has(key)) _subs.set(key, new Set());
  _subs.get(key).add(res);
  res.on('close', () => {
    const set = _subs.get(key);
    if (set) { set.delete(res); if (!set.size) _subs.delete(key); }
  });
}

function publish(ticketId, event, data) {
  const set = _subs.get(String(ticketId));
  if (!set || !set.size) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) { try { res.write(frame); } catch (e) { /* dropped client */ } }
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
  return {
    robloxId: String(robloxId),
    robloxUsername: info ? info.username : null,
    robloxDisplayName: info ? info.displayName : null,
    headshotUrl: head || null,
    ...extra,
  };
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
        const rid = await roblox.getRobloxIdFromUsername(raw).catch(() => null);
        if (rid) person = await _buildPerson(rid, {});
      }
    }
  } catch (e) { person = null; }

  _idCache.set(key, { at: Date.now(), person });
  return person;
}

module.exports = {
  TYPES, typeConfig, isStaff, canHandle, canHandleTicket, handleableTypes, canView, publicCatalogue,
  handoffMessage, resolveIdentity, subscribe, publish,
  BOT_NAME, BOT_AVATAR, IA_STAFF, IA_HICOMM,
};
