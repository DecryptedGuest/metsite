// server/routes/support.js — /support help desk API
// Mounted at /api/support behind requireAuth (any logged-in user can OPEN a
// ticket; handling is gated per type). Realtime via SSE. Attachments are stored
// as Media rows but served through a ticket-scoped, access-checked route so
// evidence never leaks to people outside the ticket.
const express = require('express');
const prisma  = require('../lib/db');
const support = require('../lib/support');

const router = express.Router();

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
function serializeTicket(t, { full = false, user = null, avatarMap = null } = {}) {
  const cfg = support.typeConfig(t.type);
  const base = {
    id: t.id, type: t.type, typeLabel: cfg ? cfg.label : t.type, status: t.status,
    openerId: t.openerId, openerName: t.openerName,
    openerAvatar: (avatarMap && avatarMap.get(t.openerId)) || null,
    claimedById: t.claimedById, claimedByName: t.claimedByName, claimedAt: t.claimedAt,
    closeReason: t.closeReason, closedAt: t.closedAt, createdAt: t.createdAt,
    isMine: user ? t.openerId === user.id : false,
    canManage: user ? support.canHandleTicket(user, t) : false,
  };
  if (!full) return base;
  const intake = (Array.isArray(t.intake) ? t.intake : []).map(q => ({
    id: q.id, prompt: q.prompt, answer: q.answer, identity: q.identity || null, attachments: attWithUrls(t.id, q.attachments),
  }));
  return { ...base, intake, messages: (t.messages || []).map(m => serializeMessage(t.id, m, avatarMap)) };
}

// Build a Map(userId -> discordAvatar URL) for a set of user ids (openers/authors).
async function avatarsFor(ids) {
  const uniq = [...new Set((ids || []).filter(Boolean))];
  if (!uniq.length) return new Map();
  const users = await prisma.user.findMany({ where: { id: { in: uniq } }, select: { id: true, discordAvatar: true } });
  return new Map(users.map(u => [u.id, u.discordAvatar || null]));
}

// ── GET /api/support/config — landing catalogue + this user's capabilities ──
router.get('/config', (req, res) => {
  res.json({
    types: support.publicCatalogue(),
    isStaff: support.isStaff(req.user),
    handleableTypes: support.handleableTypes(req.user),
    me: { id: req.user.id, name: req.user.displayName || req.user.discordUsername, avatar: req.user.discordAvatar || null },
  });
});

// ── POST /api/support/tickets { type } — open a ticket, start intake ──
router.post('/tickets', async (req, res) => {
  const type = String((req.body && req.body.type) || '').toUpperCase();
  const cfg  = support.typeConfig(type);
  if (!cfg) return res.status(400).json({ error: 'Unknown ticket type.' });
  try {
    const t = await prisma.supportTicket.create({
      data: {
        type, status: 'INTAKE',
        openerId: req.user.id, openerDiscordId: req.user.discordId,
        openerName: req.user.displayName || req.user.discordUsername || 'User',
      },
    });
    // Assistant greeting (shown at the top of the transcript).
    await prisma.supportMessage.create({ data: {
      ticketId: t.id, authorKind: 'BOT', authorName: support.BOT_NAME,
      body: `Hi — I'm the MET support assistant. I'll take a few details for your **${cfg.label}**, then hand you to the right team. You can answer below.`,
    } });
    res.status(201).json({ ticket: serializeTicket(t, { user: req.user }), questions: cfg.questions });
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
    if (!support.canView(req.user, t)) return res.status(403).json({ error: 'Not your ticket.' });
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
    if (!t || !support.canView(req.user, t)) return res.status(403).end();
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
    if (t.openerId !== req.user.id) return res.status(403).json({ error: 'Not your ticket.' });
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
  if (['INTAKE', 'OPEN', 'CLAIMED', 'CLOSED'].includes(req.query.status)) where.status = req.query.status;
  else where.status = { in: ['OPEN', 'CLAIMED'] }; // default: active work
  try {
    const rows = await prisma.supportTicket.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 });
    res.json(rows.map(t => serializeTicket(t, { user: req.user })));
  } catch (e) { res.status(500).json({ error: 'Failed to load the queue' }); }
});

// ── GET /api/support/tickets/:id — full ticket + messages ──
router.get('/tickets/:id', async (req, res) => {
  try {
    const t = await prisma.supportTicket.findUnique({ where: { id: req.params.id }, include: { messages: { orderBy: { createdAt: 'asc' } } } });
    if (!t) return res.status(404).json({ error: 'Ticket not found' });
    if (!support.canView(req.user, t)) return res.status(403).json({ error: 'You cannot view this ticket.' });
    const avatarMap = await avatarsFor([t.openerId, ...(t.messages || []).map(m => m.authorId)]);
    res.json(serializeTicket(t, { full: true, user: req.user, avatarMap }));
  } catch (e) { res.status(500).json({ error: 'Failed to load the ticket' }); }
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
    if (!support.canView(req.user, t)) return res.status(403).json({ error: 'Not your ticket.' });
    if (t.status === 'CLOSED') return res.status(400).json({ error: 'This ticket is closed.' });

    const body = (req.body && req.body.body != null ? String(req.body.body) : '').slice(0, 4000).trim();
    const attachments = Array.isArray(req.body && req.body.attachments) ? req.body.attachments
      .filter(x => x && x.mediaId).slice(0, 10)
      .map(x => ({ mediaId: String(x.mediaId), kind: x.kind || 'image', name: (x.name || '').toString().slice(0, 200) })) : [];
    if (!body && !attachments.length) return res.status(400).json({ error: 'Empty message.' });

    const isOpener = t.openerId === req.user.id;
    const msg = await prisma.supportMessage.create({ data: {
      ticketId: t.id, authorId: req.user.id, authorName: req.user.displayName || req.user.discordUsername,
      authorKind: isOpener ? 'OPENER' : 'STAFF', body: body || null, attachments,
    } });
    const out = serializeMessage(t.id, msg);
    out.authorAvatar = req.user.discordAvatar || null; // denormalise the poster's PFP
    support.publish(t.id, 'message', out);
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
    res.json({ ok: true, ticket: serializeTicket(updated, { user: req.user }) });
  } catch (e) { res.status(500).json({ error: 'Failed to close' }); }
});

// ── GET /api/support/tickets/:id/stream — SSE realtime (messages + status) ──
router.get('/tickets/:id/stream', async (req, res) => {
  try {
    const t = await prisma.supportTicket.findUnique({ where: { id: req.params.id } });
    if (!t || !support.canView(req.user, t)) return res.status(403).end();
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders && res.flushHeaders();
    res.write('event: ready\ndata: {}\n\n');
    support.subscribe(t.id, res);
    // Heartbeat so proxies keep the connection open.
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
    res.on('close', () => clearInterval(hb));
  } catch (e) { res.status(500).end(); }
});

module.exports = router;
