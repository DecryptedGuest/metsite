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
function serializeMessage(ticketId, m, avatarMap) {
  return {
    id: m.id, authorId: m.authorId, authorName: m.authorName, authorKind: m.authorKind,
    authorAvatar: (m.authorId && avatarMap) ? (avatarMap.get(m.authorId) || null) : (m.authorAvatar || null),
    body: m.body, attachments: attWithUrls(ticketId, m.attachments), createdAt: m.createdAt,
  };
}
// What the viewing staff member may do with this ticket (server-authoritative).
function ticketCaps(user, t) {
  const hic = support.isHicomm(user);
  const handler = support.canHandleTicket(user, t);
  const claimant = !!(t.claimedById && user && t.claimedById === user.id);
  const open = t.status !== 'CLOSED';
  return {
    isHicomm: hic,
    canClaim:       handler && open && (!t.claimedById || hic),
    canRelease:     (claimant || hic) && t.status === 'CLAIMED',
    canClose:       (claimant || hic) && open,
    canReply:       handler && open,
    canInternalNote: handler,
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
    priority: t.priority || 'NORMAL', escalated: !!t.escalated, escalatedNote: t.escalatedNote || null,
    openerId: t.openerId, openerName: t.openerName,
    openerAvatar: (avatarMap && avatarMap.get(t.openerId)) || null,
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
  return { ...base, intake, messages: msgs.map(m => serializeMessage(t.id, m, avatarMap)) };
}

// Build a Map(userId -> discordAvatar URL) for a set of user ids (openers/authors).
async function avatarsFor(ids) {
  const uniq = [...new Set((ids || []).filter(Boolean))];
  if (!uniq.length) return new Map();
  const users = await prisma.user.findMany({ where: { id: { in: uniq } }, select: { id: true, discordAvatar: true } });
  return new Map(users.map(u => [u.id, u.discordAvatar || null]));
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
router.get('/config', (req, res) => {
  res.json({
    types: support.publicCatalogue(),
    loggedIn: !!req.user,
    isStaff: support.isStaff(req.user),
    isHicomm: support.isHicomm(req.user),
    handleableTypes: support.handleableTypes(req.user),
    priorities: support.PRIORITIES,
    me: req.user ? { id: req.user.id, name: req.user.displayName || req.user.discordUsername, avatar: req.user.discordAvatar || null } : null,
  });
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

// ── POST /api/support/tickets { type } — open a ticket, start intake ──
router.post('/tickets', async (req, res) => {
  const type = String((req.body && req.body.type) || '').toUpperCase();
  const cfg  = support.typeConfig(type);
  if (!cfg) return res.status(400).json({ error: 'Unknown ticket type.' });
  // Refuse blacklisted guests (matched by IP or browser fingerprint).
  const bl = await blacklistMatch(req);
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
      kind: isVideo ? 'video' : 'image', visibility: 'DEVELOPER', uploaderId: req.user.id,
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
    const t = await prisma.supportTicket.findUnique({ where: { id: req.params.id } });
    if (!t || !canSee(req, t)) return res.status(403).end();
    const m = await prisma.media.findUnique({ where: { id: req.params.mediaId }, select: { data: true, mimeType: true } });
    if (!m) return res.status(404).end();
    res.set('Content-Type', m.mimeType);
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
          discordId: a.identity.discordId || null,
          discordUsername: a.identity.discordUsername || null,
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

    const updated = await prisma.supportTicket.update({ where: { id: t.id }, data: { intake, status: 'OPEN' } });
    const handoffMsg = await prisma.supportMessage.create({ data: {
      ticketId: t.id, authorKind: 'BOT', authorName: support.BOT_NAME,
      body: support.handoffMessage(t.type),
    } });
    support.publish(t.id, 'message', serializeMessage(t.id, handoffMsg));
    support.publish(t.id, 'update', { status: 'OPEN' });
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
  // (developers still see everything, for testing).
  if (req.user.role !== 'DEVELOPER') where.openerId = { not: req.user.id };

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
    res.json(out);
  } catch (e) { res.status(500).json({ error: 'Failed to load the ticket' }); }
});

// ── GET /api/support/user-profile?userId=|discordId= — a participant's card ──
// Basic identity for anyone signed in; IA staff additionally see the person's
// IA rank (site role) + divisions. Used by the clickable profile cards in chat.
router.get('/user-profile', async (req, res) => {
  try {
    const { userId, discordId } = req.query;
    let u = null;
    if (userId) u = await prisma.user.findUnique({ where: { id: String(userId) } });
    else if (discordId) u = await prisma.user.findUnique({ where: { discordId: String(discordId) } });
    if (!u) return res.status(404).json({ error: 'Not found' });

    const out = {
      name: u.displayName || u.discordUsername, discordUsername: u.discordUsername, discordId: u.discordId,
      avatar: u.discordAvatar || null, robloxUsername: u.robloxUsername || null, robloxId: u.robloxId || null,
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

// ── POST /api/support/tickets/:id/claim — staff claim ──
router.post('/tickets/:id/claim', async (req, res) => {
  try {
    const t = await prisma.supportTicket.findUnique({ where: { id: req.params.id } });
    if (!t) return res.status(404).json({ error: 'Ticket not found' });
    if (!support.canHandleTicket(req.user, t)) return res.status(403).json({ error: 'You cannot handle this ticket (you cannot claim a ticket you opened).' });
    if (t.status === 'CLOSED') return res.status(400).json({ error: 'This ticket is closed.' });
    if (t.claimedById && t.claimedById !== req.user.id) return res.status(409).json({ error: `Already claimed by ${t.claimedByName}.` });

    const name = req.user.displayName || req.user.discordUsername;
    const updated = await prisma.supportTicket.update({ where: { id: t.id }, data: { status: 'CLAIMED', claimedById: req.user.id, claimedByName: name, claimedAt: new Date() } });
    const claimMsg = await prisma.supportMessage.create({ data: { ticketId: t.id, authorKind: 'BOT', authorName: support.BOT_NAME, body: `${name} has claimed this ticket and will assist you.` } });
    support.publish(t.id, 'message', serializeMessage(t.id, claimMsg));
    support.publish(t.id, 'update', { status: 'CLAIMED', claimedByName: name });
    res.json({ ok: true, ticket: serializeTicket(updated, { user: req.user }) });
  } catch (e) { res.status(500).json({ error: 'Failed to claim' }); }
});

// ── POST /api/support/tickets/:id/messages { body, attachments } ──
router.post('/tickets/:id/messages', async (req, res) => {
  try {
    const t = await prisma.supportTicket.findUnique({ where: { id: req.params.id } });
    if (!t) return res.status(404).json({ error: 'Ticket not found' });
    if (!canSee(req, t)) return res.status(403).json({ error: 'Not your ticket.' });
    if (t.status === 'CLOSED') return res.status(400).json({ error: 'This ticket is closed.' });

    const body = (req.body && req.body.body != null ? String(req.body.body) : '').slice(0, 4000).trim();
    const attachments = Array.isArray(req.body && req.body.attachments) ? req.body.attachments
      .filter(x => x && x.mediaId).slice(0, 10)
      .map(x => ({ mediaId: String(x.mediaId), kind: x.kind || 'image', name: (x.name || '').toString().slice(0, 200) })) : [];
    if (!body && !attachments.length) return res.status(400).json({ error: 'Empty message.' });

    const opener = isOpener(req, t);
    // Internal notes: staff-only, hidden from the opener. Only handling staff can post them.
    const internal = !opener && !!(req.body && req.body.internal) && isHandler(req, t);
    const authorKind = internal ? 'INTERNAL' : (opener ? 'OPENER' : 'STAFF');
    const msg = await prisma.supportMessage.create({ data: {
      ticketId: t.id,
      authorId:   req.user ? req.user.id : null,
      authorName: req.user ? (req.user.displayName || req.user.discordUsername) : t.openerName,
      authorKind, body: body || null, attachments,
    } });
    const out = serializeMessage(t.id, msg);
    out.authorAvatar = req.user ? (req.user.discordAvatar || null) : null; // poster's PFP
    support.publish(t.id, 'message', out, { staffOnly: internal });
    res.status(201).json(out);
  } catch (e) {
    console.error('[Support] message failed:', e.message);
    res.status(500).json({ error: 'Failed to send' });
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
