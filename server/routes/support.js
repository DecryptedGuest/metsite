// server/routes/support.js — /support help desk API
// Mounted at /api/support behind requireAuth (any logged-in user can OPEN a
// ticket; handling is gated per type). Realtime via SSE. Attachments are stored
// as Media rows but served through a ticket-scoped, access-checked route so
// evidence never leaks to people outside the ticket.
const express = require('express');
const crypto  = require('crypto');
const prisma  = require('../lib/db');
const support = require('../lib/support');

const router = express.Router();

// ── Optional-login identity ──────────────────────────────────────────
// Login is optional. A logged-in opener is matched by openerId; an anonymous
// opener holds a per-ticket secret token (localStorage) sent as ?token= /
// x-support-token / body.token.
function reqToken(req) { return req.get('x-support-token') || (req.query && req.query.token) || (req.body && req.body.token) || null; }

// ── Guest ticket-blacklist ───────────────────────────────────────────
// The requester's network identity: IP (via the trusted proxy) + a per-browser
// fingerprint the client persists in localStorage (x-support-fp).
function clientNet(req) {
  return {
    ip: (req.ip || '').replace(/^::ffff:/, '') || null,
    fp: (req.get('x-support-fp') || '').slice(0, 128) || null,
    ua: (req.get('user-agent') || '').slice(0, 400) || null,
  };
}
// Is this requester currently ticket-blacklisted (by IP or browser fingerprint)?
async function blacklistMatch(req) {
  const { ip, fp } = clientNet(req);
  const or = [];
  if (ip) or.push({ ip });
  if (fp) or.push({ fingerprint: fp });
  if (!or.length) return null;
  try { return await prisma.supportBlacklist.findFirst({ where: { active: true, OR: or } }); }
  catch (e) { return null; }
}
// Is the OPENER of THIS ticket currently ticket-blacklisted? Matches the
// ticket's stored opener IP/fingerprint against the active blacklist — used to
// stop a blacklisted opener from posting further in their own ticket, and to
// tell their client to lock the composer. (Also honours an account-level ban.)
async function openerIsBlacklisted(t) {
  if (t.openerId) {
    try {
      const u = await prisma.user.findUnique({ where: { id: t.openerId }, select: { isBlacklisted: true } });
      if (u && u.isBlacklisted) return true;
    } catch (e) { /* ignore */ }
  }
  const or = [];
  if (t.openerIp) or.push({ ip: t.openerIp });
  if (t.openerFp) or.push({ fingerprint: t.openerFp });
  if (!or.length) return false;
  try { return !!(await prisma.supportBlacklist.findFirst({ where: { active: true, OR: or } })); }
  catch (e) { return false; }
}
function isOpener(req, t) {
  if (req.user && t.openerId && String(t.openerId) === String(req.user.id)) return true;
  const tok = reqToken(req);
  return !!(tok && t.openerToken && String(tok) === String(t.openerToken));
}
function isHandler(req, t) { return !!req.user && support.canHandleTicket(req.user, t); }
// Can the requester SEE this ticket? The opener, or staff who handle the type.
function canSee(req, t) {
  if (isOpener(req, t)) return true;
  return req.user ? support.canHandle(req.user, t.type) : false;
}

// ── serialisers ──────────────────────────────────────────────────────
function attWithUrls(ticketId, atts) {
  return (Array.isArray(atts) ? atts : []).map(a => ({
    mediaId: a.mediaId, kind: a.kind, name: a.name,
    url: `/api/support/tickets/${ticketId}/media/${a.mediaId}`,
  }));
}
// A short, plain-text preview of a message for reply references (no markdown).
function replyPreview(m) {
  if (!m) return null;
  const snippet = m.body
    ? String(m.body).replace(/\s+/g, ' ').trim().slice(0, 120)
    : ((m.attachments && m.attachments.length) ? '📎 Attachment' : '');
  return { id: m.id, authorName: m.authorName, authorKind: m.authorKind, snippet };
}

function serializeMessage(ticketId, m, avatarMap, msgById) {
  const meta = (m.authorId && avatarMap) ? avatarMap.get(m.authorId) : null;
  return {
    id: m.id, authorId: m.authorId, authorName: m.authorName, authorKind: m.authorKind,
    authorAvatar: (meta ? meta.avatar : (m.authorAvatar || null)),
    authorDiscordId: (meta ? meta.discordId : (m.authorDiscordId || null)),
    body: m.body, attachments: attWithUrls(ticketId, m.attachments), createdAt: m.createdAt,
    replyToId: m.replyToId || null,
    // Reply reference resolves only against messages the viewer can see (msgById
    // is built from the already-filtered list, so INTERNAL parents stay hidden).
    replyTo: (m.replyToId && msgById) ? replyPreview(msgById.get(m.replyToId)) : (m.replyTo || null),
  };
}
// What the viewing staff member may do with this ticket (server-authoritative).
function ticketCaps(user, t) {
  const hic = support.isHicomm(user);
  const handler = support.canHandleTicket(user, t);
  const claimant = !!(t.claimedById && user && t.claimedById === user.id);
  // Oversight tier that may act on a ticket claimed by someone else — IA
  // Supervisor (rank 20) and above, NOT Senior Investigator (site role SUPERVISOR).
  const supPlus = support.canOverrideClaimLock(user);
  const open = t.status !== 'CLOSED';
  // Once claimed, a ticket is locked to its claimant — other investigators can't
  // act on it unless they're Supervisor+ (oversight). Unclaimed tickets are open
  // to any handler so they can pick one up.
  const claimGate = !t.claimedById || claimant || supPlus;
  return {
    isHicomm: hic,
    canClaim:       handler && open && (!t.claimedById || hic),
    canRelease:     (claimant || hic) && t.status === 'CLAIMED',
    canClose:       (claimant || hic) && open,
    canReply:       handler && open && claimGate,
    canInternalNote: handler && claimGate,
    canPriority:    (claimant || hic) && open,
    canReassign:    (claimant || hic) && open,
    canEscalate:    handler && open && !t.escalated,
    canDeEscalate:  hic && t.escalated,
    canDelete:      hic,
    // Guest openers only (no linked account) with a captured IP/fingerprint can
    // be ticket-blacklisted. HICOMM can always lift.
    canBlacklist:   (claimant || hic) && !t.openerId && !!(t.openerIp || t.openerFp),
    isGuestOpener:  !t.openerId,
  };
}
function serializeTicket(t, { full = false, user = null, avatarMap = null, opener = false } = {}) {
  const cfg = support.typeConfig(t.type);
  const staffView = user ? support.canHandleTicket(user, t) : false;
  const base = {
    id: t.id, type: t.type, typeLabel: cfg ? cfg.label : t.type, status: t.status,
    priority: t.priority || 'NORMAL', escalated: !!t.escalated,
    // escalatedNote is an internal staff note (stored as an INTERNAL message and
    // published staffOnly over SSE) — never expose it to the opener.
    escalatedNote: staffView ? (t.escalatedNote || null) : null,
    openerId: t.openerId, openerName: t.openerName,
    openerAvatar: (avatarMap && avatarMap.get(t.openerId) && avatarMap.get(t.openerId).avatar) || null,
    claimedById: t.claimedById, claimedByName: t.claimedByName, claimedAt: t.claimedAt,
    closeReason: t.closeReason, closedAt: t.closedAt, createdAt: t.createdAt,
    isMine: opener || (user ? t.openerId === user.id : false),
    canManage: staffView,
    caps: user ? ticketCaps(user, t) : null,
  };
  if (!full) return base;
  const intake = (Array.isArray(t.intake) ? t.intake : []).map(q => ({
    id: q.id, prompt: q.prompt, answer: q.answer, identity: q.identity || null, attachments: attWithUrls(t.id, q.attachments),
  }));
  // Internal staff notes are never shown to the opener / non-handlers.
  let msgs = t.messages || [];
  if (!staffView) msgs = msgs.filter(m => (m.authorKind || '') !== 'INTERNAL');
  const msgById = new Map(msgs.map(m => [m.id, m]));
  return { ...base, intake, messages: msgs.map(m => serializeMessage(t.id, m, avatarMap, msgById)) };
}

// Build a Map(userId -> discordAvatar URL) for a set of user ids (openers/authors).
// Map(userId → { avatar, discordId }) for a set of user ids. discordId lets the
// client colour author names by their Discord role (like Discord).
async function avatarsFor(ids) {
  const uniq = [...new Set((ids || []).filter(Boolean))];
  if (!uniq.length) return new Map();
  const users = await prisma.user.findMany({ where: { id: { in: uniq } }, select: { id: true, discordAvatar: true, discordId: true } });
  return new Map(users.map(u => [u.id, { avatar: u.discordAvatar || null, discordId: u.discordId || null }]));
}

// ── Auto ticket-log on close ─────────────────────────────────────────
// When a support ticket is closed, mint a normal IA ticket log (PENDING) so IA
// HICOMM review/approve/deny it exactly like a manually-filed one. All fields
// are autofilled from the support ticket. Best-effort; never blocks the close.
const SUPPORT_TO_TICKETTYPE = {
  OFFICER_COMPLAINT: 'OFFICER_REPORT', DISCIPLINARY_APPEAL: 'APPEAL',
  IA_COMPLAINT: 'HICOMM', GENERAL_SUPPORT: 'GENERAL_SUPPORT',
};
async function subjectRobloxUsername(t) {
  const intake = Array.isArray(t.intake) ? t.intake : [];
  const idq = intake.find(q => q.identity && q.identity.robloxUsername);
  if (idq) return idq.identity.robloxUsername; // the reported person
  if (!t.openerId) return t.openerName;        // anonymous opener — no linked account
  try {
    const opener = await prisma.user.findUnique({ where: { id: t.openerId }, select: { robloxUsername: true, discordId: true } });
    if (opener && opener.robloxUsername) return opener.robloxUsername;
    if (opener && opener.discordId) {
      const roblox = require('../lib/roblox');
      const rid = await roblox.getRobloxIdFromDiscord(opener.discordId).catch(() => null);
      if (rid) { const info = await roblox.getRobloxUserInfo(rid).catch(() => null); if (info) return info.username; }
    }
  } catch (e) { /* fall through */ }
  return t.openerName;
}
async function createIaTicketLog(t, closer) {
  try {
    const cfg = support.typeConfig(t.type);
    const ticketType = SUPPORT_TO_TICKETTYPE[t.type] || 'GENERAL_SUPPORT';
    const robloxUsername = await subjectRobloxUsername(t);
    const intake = Array.isArray(t.intake) ? t.intake : [];
    const lines = intake.map(q => `• ${q.prompt}\n   ${q.answer || (q.attachments && q.attachments.length ? `(${q.attachments.length} attachment(s))` : '—')}`);
    const conclusion = [
      `Auto-generated from a closed ${cfg ? cfg.label : t.type} support ticket.`,
      `Closed by: ${closer.displayName || closer.discordUsername}${t.closeReason ? ` — ${t.closeReason}` : ''}`,
      '', 'Intake:', ...lines,
    ].join('\n').slice(0, 6000);
    const base = process.env.PUBLIC_BASE_URL ? process.env.PUBLIC_BASE_URL.replace(/\/$/, '') : '';
    const counter = await prisma.ticketCounter.upsert({ where: { id: 1 }, update: { count: { increment: 1 } }, create: { id: 1, count: 1 } });
    const ticketRef = `TKT-${String(counter.count).padStart(4, '0')}`;
    await prisma.ticket.create({ data: {
      ticketRef, userId: closer.id, robloxUsername: robloxUsername || t.openerName,
      ticketType, submittedAt: new Date().toISOString(), timezone: process.env.QUOTA_TIMEZONE || 'Europe/London',
      conclusion, transcriptLink: `${base}/support?ticket=${t.id}`, proofImages: [], status: 'PENDING',
    } });
    console.log(`[Support] auto-created ticket log ${ticketRef} from closed support ticket ${t.id}`);
  } catch (e) {
    console.error('[Support] auto ticket-log failed:', e.message);
  }
}

// ── GET /api/support/config — landing catalogue + this user's capabilities ──
router.get('/config', async (req, res) => {
  const prefs = (req.user && req.user.supportPrefs && typeof req.user.supportPrefs === 'object') ? req.user.supportPrefs : {};
  // Whether the staffer is a Probationary Investigator (drives the {supervision}
  // placeholder + auto-clause). Only looked up for staff; best-effort.
  let isProbationary = false;
  if (req.user && support.isStaff(req.user) && req.user.robloxId) {
    try {
      const role = await require('../lib/roblox').getUserGroupRole(req.user.robloxId, process.env.IA_GROUP_ID || '407296071');
      isProbationary = !!(role && role.name && /probationary/i.test(role.name));
    } catch (e) { /* omit → false */ }
  }
  res.json({
    types: support.publicCatalogue(),
    knowledge: support.KNOWLEDGE, // member-facing FAQ for the help bot
    loggedIn: !!req.user,
    isStaff: support.isStaff(req.user),
    isHicomm: support.isHicomm(req.user),
    handleableTypes: support.handleableTypes(req.user),
    priorities: support.PRIORITIES,
    me: req.user ? {
      id: req.user.id, name: req.user.displayName || req.user.discordUsername, avatar: req.user.discordAvatar || null,
      isProbationary,
      // Support-desk settings (staff): effective claim greetings + saved quick replies.
      greetings: { ...support.DEFAULT_GREETINGS, ...(prefs.greetings || {}) },
      quickReplies: Array.isArray(prefs.quickReplies) ? prefs.quickReplies : null,
    } : null,
  });
});

// ── PATCH /api/support/settings — staff save their greetings + quick replies ──
router.patch('/settings', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in first.' });
  if (!support.isStaff(req.user)) return res.status(403).json({ error: 'Support staff only.' });
  try {
    const body = req.body || {};
    const prefs = (req.user.supportPrefs && typeof req.user.supportPrefs === 'object') ? { ...req.user.supportPrefs } : {};
    if (body.greetings && typeof body.greetings === 'object') {
      const g = {};
      for (const k of Object.keys(support.DEFAULT_GREETINGS)) {
        // Only persist a non-empty override — a blank field means "use the
        // default", so it's shown (via the /config spread) and used (via the
        // claim-time `||`) consistently instead of storing a dead empty string.
        if (typeof body.greetings[k] === 'string' && body.greetings[k].trim()) g[k] = body.greetings[k].slice(0, 1200);
      }
      prefs.greetings = g;
    }
    if (Array.isArray(body.quickReplies)) {
      prefs.quickReplies = body.quickReplies.filter(x => typeof x === 'string').map(s => s.slice(0, 1000).trim()).filter(Boolean).slice(0, 40);
    }
    await prisma.user.update({ where: { id: req.user.id }, data: { supportPrefs: prefs } });
    res.json({ ok: true, supportPrefs: prefs });
  } catch (e) {
    console.error('[Support] settings save failed:', e.message);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// ── GET /api/support/tryouts — upcoming MET (HPC) tryouts, for the help bot ──
router.get('/tryouts', async (req, res) => {
  try {
    const { isServerLocked } = require('../lib/tryouts');
    const rows = await prisma.tryout.findMany({
      where: { division: 'HPC', status: { in: ['SCHEDULED', 'LIVE'] }, scheduledAt: { gte: new Date(Date.now() - 2 * 60 * 60 * 1000) } },
      orderBy: { scheduledAt: 'asc' }, take: 10,
    });
    res.json(rows.map(t => ({
      id: t.id, scheduledAt: t.scheduledAt ? t.scheduledAt.getTime() : null, status: t.status,
      hostName: t.hostRobloxName || t.hostName || null, locked: isServerLocked(t),
    })));
  } catch (e) { res.status(500).json({ error: 'Failed to load tryouts' }); }
});

// ── GET /api/support/my-punishments — the signed-in member's disciplinary
// history with expiry, for the Disciplinary Appeal picker. Guests → []. ──
router.get('/my-punishments', async (req, res) => {
  if (!req.user) return res.json({ punishments: [] });
  try {
    const { getCasePunishments } = require('../lib/punishments');
    const [botPuns, casePuns] = await Promise.all([
      prisma.metPunishment.findMany({ where: { discordId: req.user.discordId }, orderBy: { issuedAt: 'desc' }, take: 100 }).catch(() => []),
      getCasePunishments({ discordId: req.user.discordId, robloxId: req.user.robloxId, robloxUsername: req.user.robloxUsername }).catch(() => []),
    ]);
    const now = Date.now();
    const punishments = casePuns
      .concat(botPuns.map(p => ({ id: p.id, type: p.type, reason: p.reason, issuedBy: p.issuedBy, caseRef: p.caseRef, active: p.active, issuedAt: p.issuedAt, expiresAt: p.expiresAt, source: 'bot' })))
      .sort((a, b) => new Date(b.issuedAt) - new Date(a.issuedAt))
      .map(p => {
        const exp = p.expiresAt ? new Date(p.expiresAt).getTime() : null;
        const permanent = exp == null;
        const expired = exp != null && exp <= now;
        const daysLeft = exp != null ? Math.max(0, Math.ceil((exp - now) / 86400000)) : null;
        return { id: String(p.id), source: p.source, type: p.type || 'Punishment', reason: p.reason || null,
          caseRef: p.caseRef || null, issuedAt: p.issuedAt, expiresAt: p.expiresAt || null, permanent, expired, daysLeft };
      });
    res.json({ punishments });
  } catch (e) { res.json({ punishments: [] }); }
});

// ── POST /api/support/tickets { type } — open a ticket, start intake ──
router.post('/tickets', async (req, res) => {
  const type = String((req.body && req.body.type) || '').toUpperCase();
  const cfg  = support.typeConfig(type);
  if (!cfg) return res.status(400).json({ error: 'Unknown ticket type.' });
  // Import-only types (Website Support) can't be opened here — they arrive via
  // Discord transcript import.
  if (cfg.importOnly) return res.status(400).json({ error: 'This ticket type cannot be opened here.' });
  // Refuse blacklisted GUESTS (matched by IP/fingerprint). Signed-in members are
  // accountable via their openerId and handled by account-level isBlacklisted,
  // so the IP/fingerprint blacklist never applies to them.
  const bl = req.user ? null : await blacklistMatch(req);
  if (bl) return res.status(403).json({ error: 'You have been blacklisted from opening support tickets.' });
  try {
    // Anonymous openers get a per-ticket token; logged-in openers are matched by id.
    const token = crypto.randomBytes(24).toString('hex');
    const anonName = (req.body && req.body.name ? String(req.body.name).slice(0, 60).trim() : '') || 'Guest';
    const net = clientNet(req);
    const t = await prisma.supportTicket.create({
      data: {
        type, status: 'INTAKE', openerToken: token,
        openerId:        req.user ? req.user.id : null,
        openerDiscordId: req.user ? req.user.discordId : null,
        openerName:      req.user ? (req.user.displayName || req.user.discordUsername || 'User') : anonName,
        openerIp:        net.ip, openerFp: net.fp, openerUa: net.ua,
      },
    });
    // Assistant greeting (shown at the top of the transcript).
    await prisma.supportMessage.create({ data: {
      ticketId: t.id, authorKind: 'BOT', authorName: support.BOT_NAME,
      body: `Hi — I'm the MET support assistant. I'll take a few details for your **${cfg.label}**, then hand you to the right team. You can answer below.`,
    } });
    // Appeals: a short pointer on how appeals work before the questions start.
    if (type === 'DISCIPLINARY_APPEAL') {
      await prisma.supportMessage.create({ data: {
        ticketId: t.id, authorKind: 'BOT', authorName: support.BOT_NAME,
        body: `**Before you appeal:** if you believe the punishment was a mistake or you're innocent, you can appeal it now. If it was valid but you'd like it reviewed, appeals open after a short waiting period — around **2 weeks** for minor punishments and **3 weeks** for more serious ones — and you'll need to explain why it should be reconsidered. An **expired** punishment no longer counts against you, but you can still raise one here to speak with an investigator.`,
      } });
    }
    res.status(201).json({ ticket: serializeTicket(t, { user: req.user, opener: true }), questions: cfg.questions, token });
  } catch (e) {
    console.error('[Support] create ticket failed:', e.message);
    res.status(500).json({ error: 'Failed to open the ticket.' });
  }
});

// ── POST /api/support/tickets/:id/upload — attach a file to a ticket ──
// Raw binary body (Content-Type = the file type); ?filename=&kind= in query.
// Returns { mediaId, kind, name, url }. Openers & handling staff only.
const rawUpload = express.raw({ type: () => true, limit: process.env.BODY_LIMIT || '64mb' });
router.post('/tickets/:id/upload', rawUpload, async (req, res) => {
  try {
    const t = await prisma.supportTicket.findUnique({ where: { id: req.params.id } });
    if (!t) return res.status(404).json({ error: 'Ticket not found' });
    if (!canSee(req, t)) return res.status(403).json({ error: 'Not your ticket.' });
    if (t.status === 'CLOSED') return res.status(400).json({ error: 'This ticket is closed.' });

    const buf = Buffer.isBuffer(req.body) ? req.body : null;
    const mimeType = req.query.mimeType || req.headers['content-type'] || '';
    const filename = String(req.query.filename || 'upload').slice(0, 200);
    if (!buf || !buf.length || !mimeType) return res.status(400).json({ error: 'Missing file data.' });
    const isImage = /^image\//.test(mimeType), isVideo = /^video\//.test(mimeType);
    if (!isImage && !isVideo) return res.status(400).json({ error: 'Only images and videos are allowed.' });

    // Stored as a Media row locked to DEVELOPER on the generic route; the real
    // access check happens on the ticket-scoped serving route below.
    const m = await prisma.media.create({ data: {
      title: null, filename, mimeType, size: buf.length, data: buf,
      kind: isVideo ? 'video' : 'image', visibility: 'DEVELOPER',
      uploaderId: req.user ? req.user.id : null, // guest openers have no account
    } });
    res.status(201).json({ mediaId: m.id, kind: m.kind, name: filename, url: `/api/support/tickets/${t.id}/media/${m.id}` });
  } catch (e) {
    console.error('[Support] upload failed:', e.message);
    res.status(500).json({ error: 'Upload failed.' });
  }
});

// ── GET /api/support/tickets/:id/media/:mediaId — serve an attachment ──
router.get('/tickets/:id/media/:mediaId', async (req, res) => {
  try {
    const t = await prisma.supportTicket.findUnique({
      where: { id: req.params.id },
      include: { messages: { select: { attachments: true } } },
    });
    if (!t || !canSee(req, t)) return res.status(403).end();
    // The media must actually belong to THIS ticket (intake or a message
    // attachment) — otherwise it's an IDOR to serve any Media row by id.
    const allowed = new Set();
    for (const q of (Array.isArray(t.intake) ? t.intake : []))
      for (const a of (Array.isArray(q.attachments) ? q.attachments : []))
        if (a && a.mediaId) allowed.add(String(a.mediaId));
    for (const msg of (t.messages || []))
      for (const a of (Array.isArray(msg.attachments) ? msg.attachments : []))
        if (a && a.mediaId) allowed.add(String(a.mediaId));
    if (!allowed.has(String(req.params.mediaId))) return res.status(404).end();
    const m = await prisma.media.findUnique({ where: { id: req.params.mediaId }, select: { data: true, mimeType: true } });
    if (!m) return res.status(404).end();
    // Never render svg/html/xml inline on our origin (stored-XSS vector).
    const unsafeInline = /svg|html|xml/i.test(m.mimeType || '');
    res.set('Content-Type', unsafeInline ? 'text/plain; charset=utf-8' : m.mimeType);
    if (unsafeInline) res.set('Content-Disposition', 'attachment');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'private, no-cache');
    res.send(m.data);
  } catch (e) {
    res.status(500).end();
  }
});

// ── POST /api/support/tickets/:id/submit-intake { answers } ──
// answers: [{ id, answer, attachments:[{mediaId,kind,name}] }]. Opener only,
// while the ticket is still in INTAKE. Stores the record, posts a bot summary,
// and opens the ticket for staff.
router.post('/tickets/:id/submit-intake', async (req, res) => {
  try {
    const t = await prisma.supportTicket.findUnique({ where: { id: req.params.id } });
    if (!t) return res.status(404).json({ error: 'Ticket not found' });
    if (!isOpener(req, t)) return res.status(403).json({ error: 'Not your ticket.' });
    if (t.status !== 'INTAKE') return res.status(400).json({ error: 'Intake already completed.' });
    if (await openerIsBlacklisted(t)) return res.status(403).json({ error: 'You have been blocked from opening support tickets by Internal Affairs.', locked: true });

    const cfg = support.typeConfig(t.type);
    const submitted = Array.isArray(req.body && req.body.answers) ? req.body.answers : [];
    const byId = new Map(submitted.map(a => [a.id, a]));
    const intake = cfg.questions.map(q => {
      const a = byId.get(q.id) || {};
      const atts = Array.isArray(a.attachments) ? a.attachments
        .filter(x => x && x.mediaId).slice(0, 20)
        .map(x => ({ mediaId: String(x.mediaId), kind: x.kind || 'image', name: (x.name || '').toString().slice(0, 200) })) : [];
      // For identity questions, keep the confirmed person (roblox id/username/
      // headshot) so staff see exactly who was reported.
      let identity = null;
      if (q.kind === 'identity' && a.identity && a.identity.robloxId) {
        identity = {
          robloxId: String(a.identity.robloxId),
          robloxUsername: a.identity.robloxUsername || null,
          robloxDisplayName: a.identity.robloxDisplayName || null,
          headshotUrl: a.identity.headshotUrl || null,
          robloxUrl: a.identity.robloxUrl || `https://www.roblox.com/users/${a.identity.robloxId}/profile`,
          discordId: a.identity.discordId || null,
          discordUsername: a.identity.discordUsername || null,
          discordAvatar: a.identity.discordAvatar || null,
        };
      }
      return { id: q.id, prompt: q.prompt, answer: (a.answer != null ? String(a.answer) : '').slice(0, 4000), attachments: atts, identity };
    });
    // Require the non-optional questions to be answered (text or attachment).
    for (const q of cfg.questions) {
      if (q.optional) continue;
      const row = intake.find(i => i.id === q.id);
      if (!row.answer.trim() && !row.attachments.length) return res.status(400).json({ error: `Please answer: ${q.prompt}` });
    }

    // Appeals: persist the structured punishment the opener picked (for the
    // IA-only card). Guarded to the appeal type; ignored otherwise.
    let appealMeta;
    if (t.type === 'DISCIPLINARY_APPEAL' && req.body && req.body.appeal && typeof req.body.appeal === 'object') {
      const a = req.body.appeal;
      appealMeta = {
        id: a.id != null ? String(a.id) : null,
        type: a.type ? String(a.type).slice(0, 60) : null,
        caseRef: a.caseRef ? String(a.caseRef).slice(0, 120) : null,
        source: a.source ? String(a.source).slice(0, 20) : null,
        reason: a.reason ? String(a.reason).slice(0, 1000) : null,
        issuedAt: a.issuedAt || null,
        expiresAt: a.expiresAt || null,
      };
    }
    const updated = await prisma.supportTicket.update({ where: { id: t.id }, data: { intake, status: 'OPEN', ...(appealMeta ? { appealMeta } : {}) } });
    const handoffMsg = await prisma.supportMessage.create({ data: {
      ticketId: t.id, authorKind: 'BOT', authorName: support.BOT_NAME,
      body: support.handoffMessage(t.type),
    } });
    support.publish(t.id, 'message', serializeMessage(t.id, handoffMsg));
    support.publish(t.id, 'update', { status: 'OPEN' });
    // Ticket transferred to Internal Affairs (ready to claim): alert every
    // eligible IA staffer — instant in-page popup + loud chime (events-client.js
    // 'support_open') AND a durable web push with Claim/Go action buttons. This
    // one call handles both, and targets role IA too (not just HICOMM).
    // Fully defensive: alerting must NEVER be able to fail the submission.
    try {
      const p = typeof support.broadcastOpenTicket === 'function' && support.broadcastOpenTicket(updated);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) { /* alerting is best-effort */ }
    res.json({ ok: true, ticket: serializeTicket(updated, { user: req.user }) });
  } catch (e) {
    console.error('[Support] submit-intake failed:', e.message);
    res.status(500).json({ error: 'Failed to submit.' });
  }
});

// ── GET /api/support/tickets/mine — the opener's own tickets ──
router.get('/tickets/mine', async (req, res) => {
  if (!req.user) return res.json([]); // anonymous openers track their tickets client-side
  try {
    const rows = await prisma.supportTicket.findMany({ where: { openerId: req.user.id }, orderBy: { createdAt: 'desc' }, take: 100 });
    res.json(rows.map(t => serializeTicket(t, { user: req.user })));
  } catch (e) { res.status(500).json({ error: 'Failed to load your tickets' }); }
});

// ── GET /api/support/tickets/queue?status= — staff queue (handleable types) ──
router.get('/tickets/queue', async (req, res) => {
  const types = support.handleableTypes(req.user);
  if (!types.length) return res.json([]);
  const where = { type: { in: types } };
  // You can't handle your own ticket, so keep it out of your staff queue
  // (developers still see everything, for testing). NOTE: openerId is NULL for
  // guest (not-signed-in) tickets, and Prisma `not: id` on a nullable column
  // compiles to SQL `openerId <> $1`, which drops NULL rows — that would hide
  // EVERY guest ticket from staff. Admit NULL explicitly so guests are seen.
  if (req.user.role !== 'DEVELOPER') {
    where.OR = [{ openerId: null }, { openerId: { not: req.user.id } }];
  }

  // Filters: ?status= / ?mine=1 (claimed by me) / ?unclaimed=1 / ?escalated=1 / ?type=
  if (['INTAKE', 'OPEN', 'CLAIMED', 'CLOSED'].includes(req.query.status)) where.status = req.query.status;
  else where.status = { in: ['OPEN', 'CLAIMED'] }; // default: active work
  if (req.query.mine === '1') where.claimedById = req.user.id;
  if (req.query.unclaimed === '1') { where.claimedById = null; where.status = 'OPEN'; }
  if (req.query.escalated === '1') where.escalated = true;
  if (types.includes(String(req.query.type))) where.type = String(req.query.type);

  try {
    const rows = await prisma.supportTicket.findMany({ where, take: 300, orderBy: [{ createdAt: 'desc' }] });
    // Sort escalated + high-priority to the top, then newest first.
    const rank = { URGENT: 0, HIGH: 1, NORMAL: 2, LOW: 3 };
    rows.sort((a, b) => (Number(b.escalated) - Number(a.escalated))
      || ((rank[a.priority] ?? 2) - (rank[b.priority] ?? 2))
      || (new Date(b.createdAt) - new Date(a.createdAt)));
    res.json(rows.map(t => serializeTicket(t, { user: req.user })));
  } catch (e) { res.status(500).json({ error: 'Failed to load the queue' }); }
});

// ── GET /api/support/tickets/:id — full ticket + messages ──
router.get('/tickets/:id', async (req, res) => {
  try {
    const t = await prisma.supportTicket.findUnique({ where: { id: req.params.id }, include: { messages: { orderBy: { createdAt: 'asc' } } } });
    if (!t) return res.status(404).json({ error: 'Ticket not found' });
    if (!canSee(req, t)) return res.status(403).json({ error: 'You cannot view this ticket.' });
    const avatarMap = await avatarsFor([t.openerId, ...(t.messages || []).map(m => m.authorId)]);
    const out = serializeTicket(t, { full: true, user: req.user, avatarMap, opener: isOpener(req, t) });
    // Tell handling staff whether this guest opener is currently blacklisted.
    if (req.user && support.canHandleTicket(req.user, t) && !t.openerId && (t.openerIp || t.openerFp)) {
      const or = [];
      if (t.openerIp) or.push({ ip: t.openerIp });
      if (t.openerFp) or.push({ fingerprint: t.openerFp });
      const active = or.length ? await prisma.supportBlacklist.findFirst({ where: { active: true, OR: or } }).catch(() => null) : null;
      out.openerBlacklisted = !!active;
    }
    // Tell the OPENER (not staff) if they've been blocked, so their client locks
    // the composer the instant IA blacklists them — checked on every poll/SSE refresh.
    if (isOpener(req, t) && !(req.user && support.canHandleTicket(req.user, t))) {
      out.locked = await openerIsBlacklisted(t);
    }
    // Claimant ("investigator") card — shown to everyone who can see the ticket,
    // so the opener knows exactly who's helping them and staff see who owns it.
    // Carries the investigator's Discord + Roblox avatars, names and IA rank.
    if (t.claimedById) out.claimant = await buildClaimantCard(t.claimedById);
    // Appeal card — handlers/IA only. Enriches the punishment being appealed
    // with the opener's Roblox + Discord identity and a jump-to-case link.
    // Never attached for the opener, so it stays invisible to them.
    if (req.user && support.canHandleTicket(req.user, t) && t.appealMeta) {
      try {
        const appeal = { punishment: t.appealMeta, opener: null, caseUrl: null };
        if (t.openerId) {
          const u = await prisma.user.findUnique({
            where: { id: t.openerId },
            select: { robloxId: true, robloxUsername: true, discordId: true, discordUsername: true, displayName: true },
          }).catch(() => null);
          if (u) {
            let headshot = null;
            if (u.robloxId) { try { headshot = await require('../lib/roblox').getRobloxAvatarHeadshot(u.robloxId); } catch (e) {} }
            appeal.opener = {
              robloxId: u.robloxId || null,
              robloxUsername: u.robloxUsername || null,
              robloxUrl: u.robloxId ? `https://www.roblox.com/users/${u.robloxId}/profile` : null,
              headshotUrl: headshot,
              discordId: u.discordId || null,
              discordUsername: u.discordUsername || null,
            };
          }
        }
        if (t.appealMeta.source === 'case' && t.appealMeta.id) {
          appeal.caseUrl = `/ia/dashboard?page=all-cases&case=${encodeURIComponent(t.appealMeta.id)}`;
        }
        out.appeal = appeal;
      } catch (e) { /* enrichment is best-effort */ }
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: 'Failed to load the ticket' }); }
});

// ── GET /api/support/user-profile?userId=|discordId= — a participant's card ──
// Basic identity for anyone signed in; IA staff additionally see the person's
// IA rank (site role) + divisions. Used by the clickable profile cards in chat.
router.get('/user-profile', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in first.' });
  try {
    const { userId, discordId } = req.query;
    let u = null;
    if (userId) u = await prisma.user.findUnique({ where: { id: String(userId) } });
    else if (discordId) u = await prisma.user.findUnique({ where: { discordId: String(discordId) } });
    if (!u) return res.status(404).json({ error: 'Not found' });

    const out = {
      name: u.displayName || u.discordUsername, discordUsername: u.discordUsername, discordId: u.discordId,
      avatar: u.discordAvatar || null, robloxUsername: u.robloxUsername || null, robloxId: u.robloxId || null,
      createdAt: u.createdAt || null,
    };
    if (u.robloxId) { try { out.headshot = await require('../lib/roblox').getRobloxAvatarHeadshot(u.robloxId); } catch (e) {} }
    if (support.isStaff(req.user)) {
      out.role = u.role;
      out.divisions = Array.isArray(u.divisions) ? u.divisions : [];
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: 'Failed to load profile' }); }
});

// ── POST /api/support/resolve-identity { input } — look up a person ──
// Used by identity intake questions so the opener can confirm the right person.
router.post('/resolve-identity', async (req, res) => {
  try {
    const person = await support.resolveIdentity(req.body && req.body.input);
    if (!person) return res.json({ ok: false });
    res.json({ ok: true, person });
  } catch (e) { res.status(500).json({ error: 'Lookup failed' }); }
});

// Compose the greeting an investigator auto-pastes when claiming a ticket:
// their IA rank + Roblox username, category-aware wording, and a supervision
// line for Probationary Investigators. Uses the staffer's saved template when
// set, else the default. Best-effort — returns null if anything is unavailable.
// Build the investigator ("claimant") card for a ticket's claimer — Discord +
// Roblox avatars, names and IA rank. Shared by GET /tickets/:id and the live
// claim broadcast so the opener sees the same rich card the instant it's claimed.
async function buildClaimantCard(claimedById) {
  if (!claimedById) return null;
  try {
    const c = await prisma.user.findUnique({
      where: { id: claimedById },
      select: { id: true, displayName: true, discordUsername: true, discordId: true, discordAvatar: true, robloxId: true, robloxUsername: true },
    });
    if (!c) return null;
    const roblox = require('../lib/roblox');
    let headshot = null, rankName = null;
    if (c.robloxId) {
      try { headshot = await roblox.getRobloxAvatarHeadshot(c.robloxId); } catch (e) {}
      try {
        const role = await roblox.getUserGroupRole(c.robloxId, process.env.IA_GROUP_ID || '407296071');
        if (role && role.name) rankName = role.name;
      } catch (e) {}
    }
    return {
      id: c.id,
      name: c.displayName || c.discordUsername,
      discordUsername: c.discordUsername || null,
      discordId: c.discordId || null,
      discordAvatar: c.discordAvatar || null,
      robloxId: c.robloxId || null,
      robloxUsername: c.robloxUsername || null,
      robloxUrl: c.robloxId ? `https://www.roblox.com/users/${c.robloxId}/profile` : null,
      headshotUrl: headshot,
      rankName,
    };
  } catch (e) { return null; }
}

async function buildClaimGreeting(user, ticket) {
  const username = user.robloxUsername || user.displayName || user.discordUsername || '';
  let rankName = '', isProbationary = false;
  if (user.robloxId) {
    try {
      const { getUserGroupRole } = require('../lib/roblox');
      const role = await getUserGroupRole(user.robloxId, process.env.IA_GROUP_ID || '407296071');
      if (role && role.name) { rankName = role.name; isProbationary = /probationary/i.test(role.name); }
    } catch (e) { /* group lookup unavailable → omit rank */ }
  }
  const saved = (user.supportPrefs && user.supportPrefs.greetings) || {};
  const template = saved[ticket.type] || support.DEFAULT_GREETINGS[ticket.type] || support.DEFAULT_GREETINGS.GENERAL_SUPPORT;
  return support.fillGreeting(template, { rank: rankName, username, isProbationary });
}

// ── POST /api/support/tickets/:id/claim — staff claim ──
router.post('/tickets/:id/claim', async (req, res) => {
  try {
    const t = await prisma.supportTicket.findUnique({ where: { id: req.params.id } });
    if (!t) return res.status(404).json({ error: 'Ticket not found' });
    if (!support.canHandleTicket(req.user, t)) return res.status(403).json({ error: 'You cannot handle this ticket (you cannot claim a ticket you opened).' });
    if (t.status === 'CLOSED') return res.status(400).json({ error: 'This ticket is closed.' });
    if (t.claimedById && t.claimedById !== req.user.id) return res.status(409).json({ error: `Already claimed by ${t.claimedByName}.` });

    const name = req.user.displayName || req.user.discordUsername;
    // Claim atomically: only take the ticket if it is still unclaimed (or already
    // ours) and not closed. Two investigators clicking Claim at once would both
    // pass the read-time checks above; this conditional write means the loser
    // gets count===0 and a 409 instead of silently stealing the first claimant's
    // ticket. (Handleability was already checked above.)
    const claim = await prisma.supportTicket.updateMany({
      where: { id: t.id, status: { not: 'CLOSED' }, OR: [{ claimedById: null }, { claimedById: req.user.id }] },
      data: { status: 'CLAIMED', claimedById: req.user.id, claimedByName: name, claimedAt: new Date() },
    });
    if (claim.count === 0) {
      const fresh = await prisma.supportTicket.findUnique({ where: { id: t.id } }).catch(() => null);
      return res.status(409).json({ error: `Already claimed by ${(fresh && fresh.claimedByName) || 'another investigator'}.` });
    }
    const updated = await prisma.supportTicket.findUnique({ where: { id: t.id } });

    // Claim-race cleanup: any STAFF message from a NON-claimant investigator who
    // isn't oversight-tier (IA Supervisor 20+ / HICOMM), sent in the moments
    // before the claim landed, is auto-removed so it can't overlap the claimant's
    // handling. Broadcast a 'delete' so every client drops the bubble too.
    try {
      const since = new Date(Date.now() - 20000);
      const racers = await prisma.supportMessage.findMany({
        where: { ticketId: t.id, authorKind: 'STAFF', authorId: { not: req.user.id }, createdAt: { gte: since } },
        select: { id: true, authorId: true },
      });
      if (racers.length) {
        const authorIds = [...new Set(racers.map(m => m.authorId).filter(Boolean))];
        const authors = await prisma.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, role: true, divisions: true } });
        const byId = new Map(authors.map(u => [u.id, u]));
        const toDelete = racers.filter(m => !support.canOverrideClaimLock(byId.get(m.authorId))).map(m => m.id);
        if (toDelete.length) {
          await prisma.supportMessage.deleteMany({ where: { id: { in: toDelete } } });
          for (const id of toDelete) support.publish(t.id, 'delete', { id });
        }
      }
    } catch (e) { /* race cleanup is best-effort */ }

    const claimMsg = await prisma.supportMessage.create({ data: { ticketId: t.id, authorKind: 'BOT', authorName: support.BOT_NAME, body: `${name} has claimed this ticket and will assist you.` } });
    // Push the claimant card FIRST (with the investigator's avatars/rank) so it's
    // already on the opener's client when the "claimed" panel message renders —
    // otherwise the card shows with no avatars. Order matters: SSE delivers in
    // send order, and the client sets cur.claimant synchronously on 'update'.
    const claimant = await buildClaimantCard(req.user.id);
    support.publish(t.id, 'update', { status: 'CLAIMED', claimedByName: name, claimant });
    support.publish(t.id, 'message', serializeMessage(t.id, claimMsg));
    // Compose the investigator's greeting to prefill their composer (never posted
    // automatically — they review/edit and send it themselves).
    const greeting = await buildClaimGreeting(req.user, t).catch(() => null);
    res.json({ ok: true, ticket: serializeTicket(updated, { user: req.user }), greeting });
  } catch (e) { res.status(500).json({ error: 'Failed to claim' }); }
});

// ── POST /api/support/tickets/:id/messages { body, attachments } ──
router.post('/tickets/:id/messages', async (req, res) => {
  try {
    const t = await prisma.supportTicket.findUnique({ where: { id: req.params.id } });
    if (!t) return res.status(404).json({ error: 'Ticket not found' });
    if (!canSee(req, t)) return res.status(403).json({ error: 'Not your ticket.' });
    if (t.status === 'CLOSED') return res.status(400).json({ error: 'This ticket is closed.' });
    // A ticket-blacklisted opener can no longer type in their own ticket.
    if (isOpener(req, t) && !isHandler(req, t) && await openerIsBlacklisted(t)) {
      return res.status(403).json({ error: 'You have been blocked from this ticket by Internal Affairs.', locked: true });
    }
    // A CLAIMED ticket is locked to its claimant (+ Supervisor+ oversight); the
    // opener always keeps posting. Other investigators can't reply to a case
    // someone else is handling.
    if (!isOpener(req, t) && t.status === 'CLAIMED' && t.claimedById && String(t.claimedById) !== String(req.user && req.user.id)) {
      const supPlus = support.canOverrideClaimLock(req.user);
      if (!supPlus) return res.status(403).json({ error: 'This ticket is being handled by its claimant — only they or a supervisor can reply.' });
    }

    const body = (req.body && req.body.body != null ? String(req.body.body) : '').slice(0, 4000).trim();
    const attachments = Array.isArray(req.body && req.body.attachments) ? req.body.attachments
      .filter(x => x && x.mediaId).slice(0, 10)
      .map(x => ({ mediaId: String(x.mediaId), kind: x.kind || 'image', name: (x.name || '').toString().slice(0, 200) })) : [];
    if (!body && !attachments.length) return res.status(400).json({ error: 'Empty message.' });

    const opener = isOpener(req, t);
    // Internal notes: staff-only, hidden from the opener. Only handling staff can post them.
    const internal = !opener && !!(req.body && req.body.internal) && isHandler(req, t);
    const authorKind = internal ? 'INTERNAL' : (opener ? 'OPENER' : 'STAFF');

    // Reply-to: must reference a real message ON THIS ticket. An opener may only
    // quote messages they can see (never an INTERNAL staff note).
    let replyToId = null, replyParent = null;
    const wantReply = req.body && req.body.replyToId ? String(req.body.replyToId) : '';
    if (wantReply) {
      replyParent = await prisma.supportMessage.findFirst({ where: { id: wantReply, ticketId: t.id } });
      if (replyParent && !(opener && (replyParent.authorKind || '') === 'INTERNAL')) replyToId = replyParent.id;
      else replyParent = null;
    }

    const msg = await prisma.supportMessage.create({ data: {
      ticketId: t.id,
      authorId:   req.user ? req.user.id : null,
      authorName: req.user ? (req.user.displayName || req.user.discordUsername) : t.openerName,
      authorKind, body: body || null, attachments, replyToId,
    } });
    const out = serializeMessage(t.id, msg);
    out.authorAvatar = req.user ? (req.user.discordAvatar || null) : null; // poster's PFP
    out.authorDiscordId = req.user ? (req.user.discordId || null) : null;  // for name colour
    out.replyTo = replyParent ? replyPreview(replyParent) : null;          // self-contained for SSE
    support.publish(t.id, 'message', out, { staffOnly: internal });

    // Notify the claimant when someone else speaks in a ticket they claimed
    // (respects their notifications toggle in the IA notifications tab).
    try {
      const authorId = req.user ? req.user.id : null;
      if (t.claimedById && t.claimedById !== authorId) {
        const cfg = support.typeConfig(t.type);
        const who = req.user ? (req.user.displayName || req.user.discordUsername) : (t.openerName || 'Someone');
        const preview = body ? body.slice(0, 100) : (attachments.length ? '📎 Attachment' : 'New activity');
        require('../lib/push').sendCustomNotification({
          userIds: [t.claimedById],
          title: `New reply · ${cfg ? cfg.label : t.type}`,
          body: `${who}: ${preview}`,
          url: `/support?ticket=${t.id}`,
        }).catch(() => {});
      }
    } catch (e) { /* notification is best-effort */ }
    res.status(201).json(out);
  } catch (e) {
    console.error('[Support] message failed:', e.message);
    res.status(500).json({ error: 'Failed to send' });
  }
});

// ── POST /api/support/tickets/:id/typing — broadcast a "typing…" ping ──
// No body stored; just fans a transient 'typing' event to the ticket's stream so
// the other side can show an indicator. Rate-limited by the client (~every 2s).
router.post('/tickets/:id/typing', async (req, res) => {
  try {
    const t = await prisma.supportTicket.findUnique({ where: { id: req.params.id } });
    if (!t) return res.status(404).end();
    if (!canSee(req, t)) return res.status(403).end();
    if (t.status === 'CLOSED') return res.status(204).end();
    const opener = isOpener(req, t);
    const name = req.user ? (req.user.displayName || req.user.discordUsername) : (t.openerName || 'Guest');
    support.publish(t.id, 'typing', { name, who: opener ? 'OPENER' : 'STAFF', userId: req.user ? req.user.id : null });
    res.status(204).end();
  } catch (e) { res.status(204).end(); }
});

// A guaranteed Discord avatar URL — the user's default embed avatar (new
// username system: (id >> 22) % 6), used only when no real avatar is available.
function defaultDiscordAvatar(id) {
  try { return `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(id) >> 22n) % 6n)}.png`; }
  catch (e) { return 'https://cdn.discordapp.com/embed/avatars/0.png'; }
}

// Parse a Roblox username out of a MET nickname like "DEV | realangeloo".
function robloxFromNick(nick) {
  if (!nick) return null;
  const parts = String(nick).split('|');
  const last = parts[parts.length - 1].trim().replace(/[^A-Za-z0-9_]/g, '');
  return last || null;
}

// Resolve a Discord id mentioned in a ticket → a small profile. Uses the site
// user record if they're registered; otherwise builds one from the MET server
// (nickname + avatar) and their Roblox account (parsed from the nickname).
const _mentionCache = new Map(); // discordId → { at, profile }
async function resolveMentionProfile(discordId) {
  const id = String(discordId || '').replace(/\D/g, '');
  if (!id) return null;
  const hit = _mentionCache.get(id);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.profile;

  const out = { discordId: id, name: null, discordUsername: null, discordAvatar: null, robloxUsername: null, robloxId: null, robloxHeadshot: null, hasSiteProfile: false, color: null, gradient: null, roleName: null, roleIcon: null };
  const u = await prisma.user.findUnique({
    where: { discordId: id },
    select: { discordUsername: true, displayName: true, discordAvatar: true, robloxUsername: true, robloxId: true },
  }).catch(() => null);

  // MET-server nickname + avatar (best-effort).
  let member = null;
  try { member = await require('../lib/bot').getGuildMemberInfo(id, process.env.DISCORD_GUILD_ID); } catch (e) {}

  out.name = (member && member.displayName) || (u && (u.displayName || u.discordUsername)) || null;
  // Always resolve a Discord avatar: the bot's displayAvatarURL (custom OR the
  // user's default) → the stored one → a computed Discord default so the Discord
  // logo is never missing.
  out.discordAvatar = (member && member.avatar) || (u && u.discordAvatar) || defaultDiscordAvatar(id);
  out.discordUsername = (u && u.discordUsername) || null;
  if (u) {
    out.hasSiteProfile = true;
    out.robloxUsername = u.robloxUsername || null;
    out.robloxId = u.robloxId ? String(u.robloxId) : null;
  }
  // Roblox — from the linked site account, else parsed from the nickname.
  if (!out.robloxId) {
    const guess = robloxFromNick(out.name);
    if (guess) {
      try { const r = await require('../lib/roblox').getRobloxIdFromUsername(guess); if (r && r.id) { out.robloxId = String(r.id); out.robloxUsername = r.username || guess; } } catch (e) {}
    }
  }
  if (out.robloxId) { try { out.robloxHeadshot = await require('../lib/roblox').getRobloxAvatarHeadshot(out.robloxId); } catch (e) {} }

  // Discord display style — colour their name by their highest colour role, like
  // Discord (with gradient + role name + role icon when available).
  try {
    const style = await require('../lib/bot').getMemberRoleStyle(id, process.env.DISCORD_GUILD_ID);
    if (style) { out.color = style.color || null; out.gradient = style.gradient || null; out.roleName = style.roleName || null; out.roleIcon = style.roleIcon || null; }
  } catch (e) {}
  if (!out.name) out.name = null;

  _mentionCache.set(id, { at: Date.now(), profile: out });
  return out;
}

// ── GET /api/support/mention-search?q= — @-autocomplete suggestions ──
// Signed-in staff only. Searches the MET server's members (like Discord).
router.get('/mention-search', async (req, res) => {
  try {
    if (!req.user) return res.json({ users: [] });
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ users: [] });
    let members = [];
    try { members = await require('../lib/bot').searchGuildMembers(q, 8, process.env.DISCORD_GUILD_ID); } catch (e) { members = []; }
    res.json({ users: (members || []).filter(m => !m.isBot).slice(0, 8).map(m => ({ id: m.id, name: m.displayName, username: m.username, avatar: m.avatar })) });
  } catch (e) { res.json({ users: [] }); }
});

// ── POST /api/support/tickets/:id/mention { ids } — resolve @mentions ──
router.post('/tickets/:id/mention', async (req, res) => {
  try {
    const t = await prisma.supportTicket.findUnique({ where: { id: req.params.id } });
    if (!t) return res.status(404).json({ error: 'Ticket not found' });
    if (!canSee(req, t)) return res.status(403).json({ error: 'Not your ticket.' });
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.slice(0, 30) : [];
    const map = {};
    await Promise.all(ids.map(async (raw) => {
      const p = await resolveMentionProfile(raw).catch(() => null);
      if (p) map[p.discordId] = p;
    }));
    res.json({ mentions: map });
  } catch (e) {
    res.status(500).json({ error: 'Failed to resolve mentions' });
  }
});

// ── POST /api/support/tickets/:id/close { reason } — handling staff close ──
router.post('/tickets/:id/close', async (req, res) => {
  try {
    const t = await prisma.supportTicket.findUnique({ where: { id: req.params.id } });
    if (!t) return res.status(404).json({ error: 'Ticket not found' });
    if (!support.canHandleTicket(req.user, t)) return res.status(403).json({ error: 'You cannot close this ticket.' });
    if (t.status === 'CLOSED') return res.status(400).json({ error: 'Already closed.' });

    const name = req.user.displayName || req.user.discordUsername;
    const reason = req.body && req.body.reason ? String(req.body.reason).slice(0, 1000) : null;
    const updated = await prisma.supportTicket.update({ where: { id: t.id }, data: { status: 'CLOSED', closedById: req.user.id, closedByName: name, closeReason: reason, closedAt: new Date() } });
    const closeMsg = await prisma.supportMessage.create({ data: { ticketId: t.id, authorKind: 'BOT', authorName: support.BOT_NAME, body: `This ticket was closed by ${name}.${reason ? ` Reason: ${reason}` : ''}` } });
    support.publish(t.id, 'message', serializeMessage(t.id, closeMsg));
    support.publish(t.id, 'update', { status: 'CLOSED' });
    // Auto-file an IA ticket log for HICOMM review (fire-and-forget).
    createIaTicketLog(updated, req.user).catch(() => {});
    require('../lib/audit').log(req.user, { category: 'TICKET', action: 'CLOSE', target: { type: 'support_ticket', id: t.id, name: t.type }, summary: `Closed ${t.type} ticket${reason ? ` — ${reason}` : ''}` });
    res.json({ ok: true, ticket: serializeTicket(updated, { user: req.user }) });
  } catch (e) { res.status(500).json({ error: 'Failed to close' }); }
});

// Load a ticket the current user is allowed to HANDLE, else respond + return null.
async function loadHandlable(req, res) {
  const t = await prisma.supportTicket.findUnique({ where: { id: req.params.id } });
  if (!t) { res.status(404).json({ error: 'Ticket not found' }); return null; }
  if (!support.canHandleTicket(req.user, t)) { res.status(403).json({ error: 'You cannot handle this ticket.' }); return null; }
  return t;
}

// ── POST /api/support/tickets/:id/release — claimant / HICOMM unclaim ──
router.post('/tickets/:id/release', async (req, res) => {
  try {
    const t = await loadHandlable(req, res); if (!t) return;
    if (t.claimedById !== req.user.id && !support.isHicomm(req.user)) return res.status(403).json({ error: 'Only the claimant or IA HICOMM can release this.' });
    if (t.status !== 'CLAIMED') return res.status(400).json({ error: 'This ticket is not claimed.' });
    const updated = await prisma.supportTicket.update({ where: { id: t.id }, data: { status: 'OPEN', claimedById: null, claimedByName: null, claimedAt: null } });
    const name = req.user.displayName || req.user.discordUsername;
    const bm = await prisma.supportMessage.create({ data: { ticketId: t.id, authorKind: 'BOT', authorName: support.BOT_NAME, body: `${name} released this ticket — it's back in the queue.` } });
    support.publish(t.id, 'message', serializeMessage(t.id, bm));
    support.publish(t.id, 'update', { status: 'OPEN' });
    res.json({ ok: true, ticket: serializeTicket(updated, { user: req.user }) });
  } catch (e) { res.status(500).json({ error: 'Failed to release' }); }
});

// ── POST /api/support/tickets/:id/reassign { toUserId } — claimant / HICOMM ──
router.post('/tickets/:id/reassign', async (req, res) => {
  try {
    const t = await loadHandlable(req, res); if (!t) return;
    if (t.claimedById !== req.user.id && !support.isHicomm(req.user)) return res.status(403).json({ error: 'Only the claimant or IA HICOMM can reassign.' });
    if (t.status === 'CLOSED') return res.status(400).json({ error: 'This ticket is closed.' });
    const to = await prisma.user.findUnique({ where: { id: String((req.body && req.body.toUserId) || '') } });
    if (!to) return res.status(404).json({ error: 'Staff member not found.' });
    if (!support.canHandle(to, t.type)) return res.status(400).json({ error: 'That member cannot handle this ticket type.' });
    const toName = to.displayName || to.discordUsername;
    const updated = await prisma.supportTicket.update({ where: { id: t.id }, data: { status: 'CLAIMED', claimedById: to.id, claimedByName: toName, claimedAt: new Date() } });
    const bm = await prisma.supportMessage.create({ data: { ticketId: t.id, authorKind: 'BOT', authorName: support.BOT_NAME, body: `This ticket was reassigned to ${toName}.` } });
    support.publish(t.id, 'message', serializeMessage(t.id, bm));
    support.publish(t.id, 'update', { status: 'CLAIMED', claimedByName: toName });
    res.json({ ok: true, ticket: serializeTicket(updated, { user: req.user }) });
  } catch (e) { res.status(500).json({ error: 'Failed to reassign' }); }
});

// ── POST /api/support/tickets/:id/priority { priority } — claimant / HICOMM ──
router.post('/tickets/:id/priority', async (req, res) => {
  try {
    const t = await loadHandlable(req, res); if (!t) return;
    if (t.claimedById !== req.user.id && !support.isHicomm(req.user)) return res.status(403).json({ error: 'Only the claimant or IA HICOMM can set priority.' });
    const priority = support.normPriority(req.body && req.body.priority);
    await prisma.supportTicket.update({ where: { id: t.id }, data: { priority } });
    support.publish(t.id, 'update', { priority });
    res.json({ ok: true, priority });
  } catch (e) { res.status(500).json({ error: 'Failed to set priority' }); }
});

// ── POST /api/support/tickets/:id/escalate { note, off? } — flag up to IA HICOMM ──
router.post('/tickets/:id/escalate', async (req, res) => {
  try {
    const t = await loadHandlable(req, res); if (!t) return;
    const on = !(req.body && req.body.off);
    if (!on && !support.isHicomm(req.user)) return res.status(403).json({ error: 'Only IA HICOMM can clear an escalation.' });
    const note = req.body && req.body.note ? String(req.body.note).slice(0, 500) : null;
    await prisma.supportTicket.update({ where: { id: t.id }, data: { escalated: on, escalatedNote: on ? note : null } });
    const name = req.user.displayName || req.user.discordUsername;
    const bm = await prisma.supportMessage.create({ data: { ticketId: t.id, authorKind: 'INTERNAL', authorId: req.user.id, authorName: name, body: on ? `Escalated to IA HICOMM${note ? `: ${note}` : ''}.` : 'Escalation cleared.' } });
    support.publish(t.id, 'message', serializeMessage(t.id, bm), { staffOnly: true });
    support.publish(t.id, 'update', { escalated: on });
    res.json({ ok: true, escalated: on });
  } catch (e) { res.status(500).json({ error: 'Failed to escalate' }); }
});

// ── DELETE /api/support/tickets/:id — IA HICOMM only (cascades messages) ──
router.delete('/tickets/:id', async (req, res) => {
  try {
    if (!support.isHicomm(req.user)) return res.status(403).json({ error: 'IA HICOMM only.' });
    await prisma.supportTicket.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'P2025') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: 'Failed to delete' });
  }
});

// ── POST /api/support/tickets/:id/blacklist { reason, off? } ──
// IA (the claimant or IA HICOMM) blacklists a GUEST opener's IP + browser so
// they can't open new tickets. `off:true` lifts every active entry for that
// opener (claimant who issued it, or any HICOMM).
router.post('/tickets/:id/blacklist', async (req, res) => {
  try {
    const t = await loadHandlable(req, res); if (!t) return;
    const claimant = t.claimedById === req.user.id;
    if (!claimant && !support.isHicomm(req.user)) return res.status(403).json({ error: 'Only the claimant or IA HICOMM can blacklist.' });
    if (t.openerId) return res.status(400).json({ error: 'This opener is a logged-in member — blacklisting is for guest openers only.' });
    if (!t.openerIp && !t.openerFp) return res.status(400).json({ error: 'No IP or browser fingerprint was captured for this opener.' });

    const or = [];
    if (t.openerIp) or.push({ ip: t.openerIp });
    if (t.openerFp) or.push({ fingerprint: t.openerFp });
    const name = req.user.displayName || req.user.discordUsername;
    const off = !!(req.body && req.body.off);

    if (off) {
      const r = await prisma.supportBlacklist.updateMany({
        where: { active: true, OR: or },
        data: { active: false, liftedById: req.user.id, liftedByName: name, liftedAt: new Date() },
      });
      const bm = await prisma.supportMessage.create({ data: { ticketId: t.id, authorKind: 'INTERNAL', authorId: req.user.id, authorName: name, body: `Ticket blacklist lifted by ${name}${r.count ? '' : ' (no active entry)'}.` } });
      support.publish(t.id, 'message', serializeMessage(t.id, bm), { staffOnly: true });
      support.publish(t.id, 'update', { openerBlacklisted: false });
      return res.json({ ok: true, blacklisted: false });
    }

    // Don't stack duplicate active entries for the same opener.
    const existing = await prisma.supportBlacklist.findFirst({ where: { active: true, OR: or } });
    if (!existing) {
      const reason = req.body && req.body.reason ? String(req.body.reason).slice(0, 500) : null;
      await prisma.supportBlacklist.create({ data: {
        ip: t.openerIp || null, fingerprint: t.openerFp || null, ua: t.openerUa || null,
        ticketId: t.id, openerName: t.openerName, openerDiscordId: t.openerDiscordId || null,
        reason, issuedById: req.user.id, issuedByName: name,
      } });
    }
    const bm = await prisma.supportMessage.create({ data: { ticketId: t.id, authorKind: 'INTERNAL', authorId: req.user.id, authorName: name, body: `${t.openerName} was ticket-blacklisted by ${name}${req.body && req.body.reason ? `: ${String(req.body.reason).slice(0, 500)}` : ''}. They can no longer open support tickets from this IP/browser.` } });
    support.publish(t.id, 'message', serializeMessage(t.id, bm), { staffOnly: true });
    support.publish(t.id, 'update', { openerBlacklisted: true });
    require('../lib/audit').log(req.user, { category: 'SUPPORT', action: 'BLACKLIST', target: { type: 'support_guest', id: t.id, name: t.openerName }, summary: `Ticket-blacklisted guest ${t.openerName}` });
    res.json({ ok: true, blacklisted: true });
  } catch (e) {
    console.error('[Support] blacklist failed:', e.message);
    res.status(500).json({ error: 'Failed to update blacklist' });
  }
});

// ── GET /api/support/blacklist — active entries (IA HICOMM only) ──
router.get('/blacklist', async (req, res) => {
  try {
    if (!support.isHicomm(req.user)) return res.status(403).json({ error: 'IA HICOMM only.' });
    const rows = await prisma.supportBlacklist.findMany({ where: { active: true }, orderBy: { createdAt: 'desc' }, take: 300 });
    res.json(rows.map(r => ({
      id: r.id, ip: r.ip, fingerprint: r.fingerprint, openerName: r.openerName, openerDiscordId: r.openerDiscordId,
      reason: r.reason, issuedByName: r.issuedByName, ticketId: r.ticketId, createdAt: r.createdAt,
    })));
  } catch (e) { res.status(500).json({ error: 'Failed to load blacklist' }); }
});

// ── GET /api/support/staff?type= — handling staff (for the reassign picker) ──
router.get('/staff', async (req, res) => {
  try {
    if (!support.isStaff(req.user)) return res.status(403).json({ error: 'Staff only.' });
    const cfg = support.typeConfig(String(req.query.type || ''));
    const roles = cfg ? cfg.roles : support.IA_STAFF;
    const users = await prisma.user.findMany({ where: { role: { in: roles } }, select: { id: true, displayName: true, discordUsername: true, role: true }, take: 200 });
    res.json(users.map(u => ({ id: u.id, name: u.displayName || u.discordUsername, role: u.role })));
  } catch (e) { res.status(500).json({ error: 'Failed to load staff' }); }
});

// ── GET /api/support/tickets/:id/stream — SSE realtime (messages + status) ──
router.get('/tickets/:id/stream', async (req, res) => {
  try {
    const t = await prisma.supportTicket.findUnique({ where: { id: req.params.id } });
    if (!t || !canSee(req, t)) return res.status(403).end();
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // stop nginx/Railway proxy from buffering the stream
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    // A 2KB comment padding forces some proxies to flush the stream immediately.
    res.write(':' + ' '.repeat(2048) + '\n\n');
    res.write('event: ready\ndata: {}\n\n');
    support.subscribe(t.id, res, { staff: support.canHandleTicket(req.user, t) });
    // Heartbeat so proxies keep the connection open.
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 20000);
    res.on('close', () => clearInterval(hb));
  } catch (e) { res.status(500).end(); }
});

module.exports = router;
