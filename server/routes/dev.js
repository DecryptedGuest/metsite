// server/routes/dev.js — developer-only maintenance tools.
// Mounted at /api/dev behind requireAuth. Every route is gated to DEVELOPER.
// Lets developers delete on-site log records (tryouts, tryout logs, patrol/event
// logs) regardless of division — a catch-all cleanup for anything log-related
// that lingers on the site.
const express = require('express');
const prisma  = require('../lib/db');
const audit   = require('../lib/audit');
const ipIntel = require('../lib/ipIntel');

const router = express.Router();

// Developer gate for the whole router.
router.use((req, res, next) => {
  if (!req.user || req.user.role !== 'DEVELOPER') return res.status(403).json({ error: 'Developers only.' });
  next();
});

// POST /api/dev/patrol-backfill — import EVERY historical patrol/event log from
// the configured channels (even very old ones), reusing the live ingest logic
// and skipping misc chatter. Idempotent. Runs in the background (large channels
// take a while); watch the logs / the review queue fills as it goes. ?wait=1
// awaits and returns the counts (only for smaller channels).
let _backfillRunning = false;
router.post('/patrol-backfill', async (req, res) => {
  const bot = require('../lib/bot');
  if (!bot.isReady()) return res.status(503).json({ error: 'Bot not connected yet — try again shortly.' });
  if (_backfillRunning) return res.status(409).json({ error: 'A backfill is already running.' });

  const run = async () => {
    _backfillRunning = true;
    try {
      const result = await bot.backfillPatrolLogs();
      const sum = Object.values(result).map(r => `${r.type}: +${r.imported}/${r.scanned}`).join(', ') || 'nothing (no channels configured)';
      audit.log(req.user, { category: 'DEV', action: 'PATROL_BACKFILL', summary: `Backfilled patrol/event logs — ${sum}` });
      console.log('[Backfill] complete:', JSON.stringify(result));
      return result;
    } finally { _backfillRunning = false; }
  };

  if (req.query.wait) {
    try { return res.json({ ok: true, result: await run() }); }
    catch (e) { return res.status(500).json({ error: 'Backfill failed: ' + e.message }); }
  }
  run().catch(e => console.error('[Backfill] failed:', e.message));
  res.json({ ok: true, started: true, message: 'Backfill started — logs will import in the background. Refresh the review queue to watch them appear.' });
});

// POST /api/dev/ia-sync — pull cases + tickets from the live IA database
// (IA_DATABASE_URL) into the MET database. Idempotent; safe to run repeatedly.
router.post('/ia-sync', async (req, res) => {
  try {
    const result = await require('../lib/iaSync').syncAll();
    if (!result.ok) return res.status(400).json({ error: result.reason || 'IA sync not configured' });
    audit.log(req.user, { category: 'DEV', action: 'IA_SYNC',
      summary: `Synced IA data — cases ${result.cases && result.cases.synced}/${result.cases && result.cases.total}, tickets ${result.tickets && result.tickets.synced}/${result.tickets && result.tickets.total}` });
    res.json(result);
  } catch (e) {
    console.error('[Dev] IA sync failed:', e.message);
    res.status(500).json({ error: 'IA sync failed: ' + e.message });
  }
});

// DELETE /api/dev/tryouts/:id — remove a tryout (any division). Best-effort
// removal of its Discord announcement + host DM, and its queued commands.
router.delete('/tryouts/:id', async (req, res) => {
  try {
    const t = await prisma.tryout.findUnique({ where: { id: req.params.id } });
    if (!t) return res.status(404).json({ error: 'Tryout not found' });
    // Tidy the Discord side (never blocks the delete).
    try {
      const bot = require('../lib/bot');
      await bot.deleteTryoutAnnouncement(t).catch(() => {});
    } catch (e) { /* bot not ready */ }
    // TryoutCommand rows reference the tryout by id (no FK cascade) — clear them.
    await prisma.tryoutCommand.deleteMany({ where: { tryoutId: t.id } }).catch(() => {});
    // Purge any analytics tied to this tryout: the concluded TryoutLog(s) linked
    // back to it feed every dashboard stat, so a deleted tryout must leave none.
    await prisma.tryoutLog.deleteMany({ where: { tryoutId: t.id } }).catch(() => {});
    await prisma.tryout.delete({ where: { id: t.id } });
    audit.log(req.user, { category: 'DEV', action: 'DELETE', division: t.division,
      target: { type: 'tryout', id: t.id, name: t.hostName }, summary: `Deleted ${t.division} tryout hosted by ${t.hostName}` });
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'P2025') return res.status(404).json({ error: 'Not found' });
    console.error('[Dev] delete tryout failed:', e.message);
    res.status(500).json({ error: 'Failed to delete tryout' });
  }
});

// DELETE /api/dev/tryout-logs/:id — remove a tryout log (any division).
router.delete('/tryout-logs/:id', async (req, res) => {
  try {
    await prisma.tryoutLog.delete({ where: { id: req.params.id } });
    audit.log(req.user, { category: 'DEV', action: 'DELETE', target: { type: 'tryout_log', id: req.params.id }, summary: `Deleted tryout log ${req.params.id}` });
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'P2025') return res.status(404).json({ error: 'Not found' });
    console.error('[Dev] delete tryout log failed:', e.message);
    res.status(500).json({ error: 'Failed to delete tryout log' });
  }
});

// GET /api/dev/game-logs?source=&q=&before= — in-game log feed (Adonis / join /
// leave / chat) ingested from the training game. Same data the MET HICOMM feed
// shows; exposed here so developers can read it from the dev panel too.
router.get('/game-logs', async (req, res) => {
  try {
    const where = {};
    const src = String(req.query.source || '').toUpperCase();
    if (['ADONIS', 'JOIN', 'LEAVE', 'CHAT'].includes(src)) where.source = src;
    const q = String(req.query.q || '').trim();
    if (q) where.OR = [
      { actor:   { contains: q, mode: 'insensitive' } },
      { target:  { contains: q, mode: 'insensitive' } },
      { message: { contains: q, mode: 'insensitive' } },
      { action:  { contains: q, mode: 'insensitive' } },
    ];
    if (req.query.before) where.createdAt = { lt: new Date(req.query.before) };
    const rows = await prisma.gameLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: 150 });
    const { deriveTarget } = require('../lib/gameLog');
    res.json(rows.map(r => ({
      id: r.id, source: r.source, actor: r.actor, actorId: r.actorId,
      target: deriveTarget(r), action: r.action, message: r.message, place: r.place,
      createdAt: r.createdAt,
    })));
  } catch (e) {
    console.error('[Dev] game-logs failed:', e.message);
    res.status(500).json({ error: 'Failed to load game logs' });
  }
});

// POST /api/dev/patrols/void-all?type=PATROL|EVENT — clear the pending queue by
// marking every PENDING log of that type APPROVED. This is an on-site bulk
// action only: it does NOT react in Discord and does NOT award MET event points
// (that would spam the sheet for a big import). Use to dismiss a backlog.
router.post('/patrols/void-all', async (req, res) => {
  const type = req.query.type === 'EVENT' ? 'EVENT' : 'PATROL';
  try {
    const result = await prisma.patrolLog.updateMany({
      where: { type, status: 'PENDING' },
      data: {
        status: 'APPROVED',
        reviewedById: req.user.id,
        reviewedByName: `${req.user.displayName || req.user.discordUsername || 'Developer'} (void)`,
        reviewedAt: new Date(),
      },
    });
    audit.log(req.user, { category: 'DEV', action: 'VOID_PENDING',
      summary: `Voided ${result.count} pending ${type} log(s) → approved (no reaction, no points)` });
    res.json({ ok: true, type, count: result.count });
  } catch (e) {
    console.error('[Dev] void-all pending failed:', e.message);
    res.status(500).json({ error: 'Failed to void pending logs' });
  }
});

// DELETE /api/dev/patrol-logs/:id — remove a patrol/event log.
router.delete('/patrol-logs/:id', async (req, res) => {
  try {
    await prisma.patrolLog.delete({ where: { id: req.params.id } });
    audit.log(req.user, { category: 'DEV', action: 'DELETE', target: { type: 'patrol_log', id: req.params.id }, summary: `Deleted patrol/event log ${req.params.id}` });
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'P2025') return res.status(404).json({ error: 'Not found' });
    console.error('[Dev] delete patrol log failed:', e.message);
    res.status(500).json({ error: 'Failed to delete patrol log' });
  }
});

// ── Emergency alerts ─────────────────────────────────────────────────
// Push a full-screen, sound‑playing "Emergency Alert" overlay to people who are
// currently on the site (an open SSE connection), targeted at everyone, one or
// more divisions, or specific users. Delivery is live-only (SSE), so it reaches
// exactly the people currently online. DEVELOPER only; every send is audited.

// The site divisions a member can be targeted by (matches the cached
// user.divisions[].division values + the synthetic MET High Command entry).
const ALERT_DIVISIONS = ['IA', 'HPC', 'CID', 'FLP', 'SCO19', 'MET'];
function userDivisionNames(u) {
  const out = new Set();
  const divs = Array.isArray(u.divisions) ? u.divisions : [];
  for (const d of divs) { if (d && d.division) out.add(String(d.division).toUpperCase()); }
  // Site role IA/SUPERVISOR/HICOMM implies the IA division for targeting.
  if (['IA', 'SUPERVISOR', 'HICOMM'].includes(u.role)) out.add('IA');
  return out;
}

// GET /api/dev/online — everyone with a live page open right now, for the picker.
router.get('/online', async (req, res) => {
  try {
    const events = require('../lib/events');
    const ids = events.connectedUserIds();
    if (!ids.length) return res.json({ users: [] });
    const users = await prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, displayName: true, discordUsername: true, role: true, divisions: true },
    });
    res.json({
      divisions: ALERT_DIVISIONS,
      users: users.map(u => ({
        id: u.id,
        name: u.displayName || u.discordUsername,
        role: u.role,
        divisions: [...userDivisionNames(u)],
      })).sort((a, b) => a.name.localeCompare(b.name)),
    });
  } catch (e) {
    console.error('[Dev] online list failed:', e.message);
    res.status(500).json({ error: 'Failed to load online users.' });
  }
});

// POST /api/dev/emergency-alert { target:'everyone'|'divisions'|'users', message, divisions?, userIds? }
router.post('/emergency-alert', async (req, res) => {
  try {
    const body = req.body || {};
    const message = String(body.message || '').trim().slice(0, 1000);
    if (!message) return res.status(400).json({ error: 'A message is required.' });
    const target = ['everyone', 'divisions', 'users'].includes(body.target) ? body.target : 'everyone';
    const events = require('../lib/events');
    const payload = {
      message,
      by: req.user.displayName || req.user.discordUsername || 'Developer',
      at: new Date().toISOString(),
    };

    let sent = 0, recipients = 0;
    if (target === 'everyone') {
      sent = events.broadcast('emergency_alert', payload);
      recipients = events.connectedUserIds().length;
    } else if (target === 'divisions') {
      const wanted = new Set((Array.isArray(body.divisions) ? body.divisions : []).map(d => String(d).toUpperCase()).filter(d => ALERT_DIVISIONS.includes(d)));
      if (!wanted.size) return res.status(400).json({ error: 'Pick at least one division.' });
      const ids = events.connectedUserIds();
      if (ids.length) {
        const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, role: true, divisions: true } });
        for (const u of users) {
          const names = userDivisionNames(u);
          if ([...wanted].some(w => names.has(w))) { recipients++; sent += events.publishToUser(u.id, 'emergency_alert', payload); }
        }
      }
    } else { // specific users
      const ids = [...new Set((Array.isArray(body.userIds) ? body.userIds : []).map(String).filter(Boolean))];
      if (!ids.length) return res.status(400).json({ error: 'Select at least one recipient.' });
      for (const id of ids) { const n = events.publishToUser(id, 'emergency_alert', payload); if (n) recipients++; sent += n; }
    }

    // Deliberately NOT audit-logged — developer actions never appear in any log.
    res.json({ ok: true, sent, recipients });
  } catch (e) {
    console.error('[Dev] emergency alert failed:', e.message);
    res.status(500).json({ error: 'Failed to send emergency alert.' });
  }
});

// GET /api/dev/ticket-ip?q=<transcript link | ticket id | TKT-#### ref>
// Resolve the guest IP(s) captured for a support ticket. Works for PAST tickets
// too (the data is stored on the ticket + its messages). Accepts the transcript
// link (/support?ticket=<id>), the IA-desk link (?supportTicket=<id>), a bare
// ticket id/uuid, or a TKT-#### ticket-log reference.
router.get('/ticket-ip', async (req, res) => {
  try {
    const raw = (req.query.q || '').toString().trim();
    if (!raw) return res.status(400).json({ error: 'Paste a ticket transcript link, id or TKT reference.' });

    // Extract a support-ticket id.
    let id = null;
    const linkM = raw.match(/[?&](?:supportTicket|ticket)=([^&\s]+)/i);
    if (linkM) id = decodeURIComponent(linkM[1]);
    if (!id) { const u = raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i); if (u) id = u[0]; }

    let ticket = id ? await prisma.supportTicket.findUnique({ where: { id } }).catch(() => null) : null;

    // TKT-#### reference → resolve via the ticket-log's transcript link.
    if (!ticket && /^tkt-/i.test(raw)) {
      const log = await prisma.ticket.findFirst({ where: { ticketRef: raw.toUpperCase() } }).catch(() => null);
      const mm = log && log.transcriptLink && log.transcriptLink.match(/[?&]ticket=([^&\s]+)/i);
      if (mm) ticket = await prisma.supportTicket.findUnique({ where: { id: decodeURIComponent(mm[1]) } }).catch(() => null);
    }
    // Last resort: treat the raw string as an id.
    if (!ticket && !id && raw) ticket = await prisma.supportTicket.findUnique({ where: { id: raw } }).catch(() => null);

    if (!ticket) return res.status(404).json({ error: 'No support ticket found for that link / id / reference.' });

    // The opener's IP is captured once, at ticket creation (SupportTicket.openerIp).
    // Enrich it on demand with a VPN/proxy flag + ISP/org (same intel the Security
    // Center uses). Best-effort — never fails the lookup.
    let ipMeta = null;
    if (ticket.openerIp) {
      const r = await ipIntel.lookupIp(ticket.openerIp).catch(() => null);
      if (r) ipMeta = { vpn: !!r.vpn, org: r.org || null, country: r.country || null, private: !!r.private, unknown: !!r.unknown };
    }

    // Ban-evasion / repeat-opener view: OTHER tickets opened from the same IP or
    // browser fingerprint. Lets a dev see everything one guest has filed.
    const orRelated = [];
    if (ticket.openerIp) orRelated.push({ openerIp: ticket.openerIp });
    if (ticket.openerFp) orRelated.push({ openerFp: ticket.openerFp });
    let related = [];
    if (orRelated.length) {
      related = await prisma.supportTicket.findMany({
        where: { AND: [{ OR: orRelated }, { id: { not: ticket.id } }] },
        orderBy: { createdAt: 'desc' },
        take: 25,
        select: { id: true, type: true, status: true, openerName: true, openerId: true, openerIp: true, openerFp: true, createdAt: true },
      }).catch(() => []);
      related = related.map(r => ({
        id: r.id, type: r.type, status: r.status, openerName: r.openerName,
        isGuest: !r.openerId, sameIp: !!(ticket.openerIp && r.openerIp === ticket.openerIp),
        sameFp: !!(ticket.openerFp && r.openerFp === ticket.openerFp), createdAt: r.createdAt,
      }));
    }

    // Is this opener currently ticket-blacklisted (by IP or fingerprint)?
    let blacklisted = false;
    if (ticket.openerIp || ticket.openerFp) {
      const orBl = [];
      if (ticket.openerIp) orBl.push({ ip: ticket.openerIp });
      if (ticket.openerFp) orBl.push({ fingerprint: ticket.openerFp });
      const bl = await prisma.supportBlacklist.findFirst({ where: { OR: orBl } }).catch(() => null);
      blacklisted = !!bl;
    }

    audit.record({
      req, action: 'DEV_TICKET_IP_LOOKUP', category: 'SECURITY',
      targetType: 'supportTicket', targetId: ticket.id,
      summary: `Developer looked up the opener IP for support ticket ${ticket.id}`,
    });

    res.json({
      ticket: {
        id: ticket.id, type: ticket.type, status: ticket.status,
        openerName: ticket.openerName, isGuest: !ticket.openerId,
        openerId: ticket.openerId || null, openerDiscordId: ticket.openerDiscordId || null,
        openerIp: ticket.openerIp || null, openerFp: ticket.openerFp || null, openerUa: ticket.openerUa || null,
        createdAt: ticket.createdAt,
      },
      ipMeta, blacklisted, related,
    });
  } catch (e) {
    console.error('[Dev] ticket-ip lookup failed:', e.message);
    res.status(500).json({ error: 'Lookup failed.' });
  }
});

// GET /api/dev/tickets?status=&type=&q=&guest=1&page=0
// Browse EVERY support ticket in every status, with the details needed to pick
// one out for an IP lookup (who opened it, whether they were a guest, who
// claimed/closed it, timings). Feeds the dev-panel ticket browser so a link
// doesn't have to be pasted by hand.
router.get('/tickets', async (req, res) => {
  try {
    const status = (req.query.status || '').toString().trim().toUpperCase();
    const type = (req.query.type || '').toString().trim().toUpperCase();
    const q = (req.query.q || '').toString().trim();
    const guestOnly = /^(1|true|yes)$/i.test((req.query.guest || '').toString());
    const page = Math.max(0, parseInt(req.query.page, 10) || 0);
    const take = 40;

    const where = {};
    if (['INTAKE', 'OPEN', 'CLAIMED', 'CLOSED'].includes(status)) where.status = status;
    if (type) where.type = type;
    if (guestOnly) where.openerId = null;
    if (q) {
      where.OR = [
        { openerName: { contains: q, mode: 'insensitive' } },
        { openerDiscordId: { contains: q } },
        { claimedByName: { contains: q, mode: 'insensitive' } },
        { openerIp: { contains: q } },
        { id: { contains: q } },
      ];
    }

    const [total, rows] = await Promise.all([
      prisma.supportTicket.count({ where }).catch(() => 0),
      prisma.supportTicket.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: page * take,
        take,
        select: {
          id: true, type: true, status: true, priority: true, escalated: true,
          openerId: true, openerName: true, openerDiscordId: true, openerIp: true,
          claimedByName: true, claimedAt: true, closedByName: true, closedAt: true,
          createdAt: true, _count: { select: { messages: true } },
        },
      }).catch(() => []),
    ]);

    const tickets = rows.map(t => ({
      id: t.id, type: t.type, status: t.status, priority: t.priority, escalated: !!t.escalated,
      openerName: t.openerName, isGuest: !t.openerId, openerDiscordId: t.openerDiscordId || null,
      hasIp: !!t.openerIp,
      claimedByName: t.claimedByName || null, claimedAt: t.claimedAt,
      closedByName: t.closedByName || null, closedAt: t.closedAt,
      messageCount: t._count ? t._count.messages : 0,
      createdAt: t.createdAt,
    }));

    res.json({ tickets, total, page, take, hasMore: (page + 1) * take < total });
  } catch (e) {
    console.error('[Dev] ticket list failed:', e.message);
    res.status(500).json({ error: 'Failed to load tickets.' });
  }
});

module.exports = router;
