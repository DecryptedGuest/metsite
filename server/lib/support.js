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
      { id: 'officer',  prompt: 'Which officer is this about? Give their Discord @, username, or in-game name.', kind: 'text' },
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
      { id: 'who',      prompt: 'Who was involved? (Discord usernames / in-game names)', kind: 'text' },
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

function typeConfig(type) { return TYPES[String(type || '').toUpperCase()] || null; }
function isStaff(user)    { return !!user && IA_STAFF.includes(user.role); }

// Can this user HANDLE (view as staff / claim / reply) tickets of `type`?
function canHandle(user, type) {
  if (!user) return false;
  if (user.role === 'DEVELOPER') return true;
  const cfg = typeConfig(type);
  return !!cfg && cfg.roles.includes(user.role);
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

module.exports = {
  TYPES, typeConfig, isStaff, canHandle, handleableTypes, canView, publicCatalogue,
  subscribe, publish, IA_STAFF, IA_HICOMM,
};
