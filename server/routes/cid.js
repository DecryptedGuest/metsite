// server/routes/cid.js — CID (Criminal Investigation Department) tryouts
// A parallel tryout programme to HPC, reusing the same Tryout/TryoutLog/
// TryoutCommand infrastructure but scoped to division "CID" and gated by the
// two CID Discord roles (CID_INSTRUCTORUNIT_ROLE_ID / CID_DIRECTOROFFICE_ROLE_ID)
// in CID_GUILD_ID. HPC and CID data never mix — every query is filtered by
// division. Mounted at /api/cid behind requireAuth (see server/index.js); every
// route additionally requires CID tryout access.
const express = require('express');
const prisma  = require('../lib/db');
const { requireCidTryout, requireCidLead, userIsCidLead } = require('../middleware/division');

const router = express.Router();

const DIVISION = 'CID';

// Every CID route requires CID tryout access (either CID role, or DEVELOPER).
router.use(requireCidTryout);

// GET /api/cid/context — what the current CID member can do (drives the UI).
router.get('/context', async (req, res) => {
  const isLead = await userIsCidLead(req.user).catch(() => false);
  res.json({
    canApprove: isLead, // Director's Office (or DEVELOPER) review tryout logs
    isDev:      req.user.role === 'DEVELOPER',
    division:   DIVISION,
  });
});

// ── Tryouts ───────────────────────────────────────────────────────────
function tryoutSummary(t) {
  return {
    id: t.id, hostName: t.hostName, hostDiscordId: t.hostDiscordId,
    coHostName: t.coHostName, coHostDiscordId: t.coHostDiscordId,
    scheduledAt: t.scheduledAt, status: t.status, lockState: t.lockState,
    privateServerLink: t.privateServerLink, joinUrl: require('../lib/tryouts').tryoutJoinUrl(t),
    announcementSent: t.announcementSent,
    notes: t.notes, createdAt: t.createdAt,
  };
}

// GET /api/cid/tryouts — upcoming + recent CID tryouts.
router.get('/tryouts', async (req, res) => {
  try {
    const tryouts = await prisma.tryout.findMany({ where: { division: DIVISION }, orderBy: { scheduledAt: 'desc' }, take: 100 });
    res.json(tryouts.map(t => ({ ...tryoutSummary(t), isMine: t.hostId === req.user.id })));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load tryouts' });
  }
});

// Host, co-host, or developer can manage (strike/pass/fail/kick) a tryout.
function canManageTryout(user, t) {
  if (user.role === 'DEVELOPER') return true;
  if (t.hostId === user.id) return true;
  if (t.coHostDiscordId && String(t.coHostDiscordId) === String(user.discordId)) return true;
  return false;
}

// GET /api/cid/tryouts/live — live CID tryouts + their latest in-game snapshot.
router.get('/tryouts/live', async (req, res) => {
  try {
    const live = await prisma.tryout.findMany({ where: { division: DIVISION, status: 'LIVE' }, orderBy: { scheduledAt: 'desc' }, take: 20 });
    res.json(live.map(t => ({
      id: t.id, hostName: t.hostName, coHostName: t.coHostName,
      lockState: t.lockState, scheduledAt: t.scheduledAt,
      snapshot: t.liveSnapshot || null,
      canManage: canManageTryout(req.user, t),
    })));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load live tryouts' });
  }
});

// POST /api/cid/tryouts/:id/command — host/co-host queue a live action.
// The in-game CID panel polls /api/game/tryout/commands?division=CID and applies it.
router.post('/tryouts/:id/command', async (req, res) => {
  try {
    const t = await prisma.tryout.findFirst({ where: { id: req.params.id, division: DIVISION } });
    if (!t) return res.status(404).json({ error: 'Tryout not found' });
    if (!canManageTryout(req.user, t)) return res.status(403).json({ error: 'Only the host or co-host can manage this tryout.' });
    if (t.status !== 'LIVE') return res.status(400).json({ error: 'This tryout is not live.' });

    const { action, targetRobloxId, targetUsername, detail } = req.body || {};
    const ACTIONS = ['STRIKE', 'UNSTRIKE', 'PASS', 'FAIL', 'KICK', 'NOTE'];
    const act = String(action || '').toUpperCase();
    if (!ACTIONS.includes(act)) return res.status(400).json({ error: 'Invalid action' });
    if (act !== 'NOTE' && !targetRobloxId && !targetUsername) return res.status(400).json({ error: 'A target is required.' });

    const cmd = await prisma.tryoutCommand.create({ data: {
      tryoutId: t.id, division: DIVISION, action: act,
      targetRobloxId: targetRobloxId ? String(targetRobloxId) : null,
      targetUsername: targetUsername || null,
      detail: detail ? String(detail).slice(0, 200) : null,
      issuedById: req.user.id, issuedByName: req.user.displayName || req.user.discordUsername,
    } });
    res.status(201).json({ success: true, id: cmd.id });
  } catch (err) {
    console.error('[CID] tryout command failed:', err.message);
    res.status(500).json({ error: 'Failed to queue command' });
  }
});

// POST /api/cid/tryouts { scheduledAt, lockState, notes } — schedule one.
router.post('/tryouts', async (req, res) => {
  try {
    const { scheduledAt, lockState, notes } = req.body || {};
    const when = new Date(scheduledAt);
    if (isNaN(when.getTime())) return res.status(400).json({ error: 'A valid date/time is required.' });
    if (when.getTime() < Date.now() - 60 * 1000) return res.status(400).json({ error: 'The scheduled time must be in the future.' });

    const t = await prisma.tryout.create({
      data: {
        division: DIVISION,
        hostId: req.user.id,
        hostDiscordId: req.user.discordId,
        hostName: req.user.displayName || req.user.discordUsername,
        scheduledAt: when,
        lockState: ['UNLOCKED', 'UNSLOCKED'].includes(String(lockState).toUpperCase()) ? 'UNLOCKED' : 'LOCKED',
        notes: notes ? String(notes).slice(0, 500) : null,
      },
    });
    res.status(201).json(tryoutSummary(t));
  } catch (err) {
    console.error('[CID] schedule tryout failed:', err.message);
    res.status(500).json({ error: 'Failed to schedule tryout' });
  }
});

// POST /api/cid/tryouts/:id/cancel — host (or developer) cancels a tryout.
router.post('/tryouts/:id/cancel', async (req, res) => {
  try {
    const t = await prisma.tryout.findFirst({ where: { id: req.params.id, division: DIVISION } });
    if (!t) return res.status(404).json({ error: 'Tryout not found' });
    if (t.hostId !== req.user.id && req.user.role !== 'DEVELOPER') {
      return res.status(403).json({ error: 'Only the host can cancel this tryout.' });
    }
    if (['COMPLETED', 'CANCELLED'].includes(t.status)) return res.status(400).json({ error: 'This tryout is already finished.' });
    const updated = await prisma.tryout.update({ where: { id: t.id }, data: { status: 'CANCELLED' } });
    // Remove the CID announcement + flip the host DM, like the game cancel path.
    try {
      const bot = require('../lib/bot');
      await bot.deleteTryoutAnnouncement(updated).catch(() => {});
      await bot.editTryoutHostDM(updated).catch(() => {});
    } catch (e) { /* best-effort */ }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to cancel tryout' });
  }
});

// POST /api/cid/tryouts/:id/complete — mark a live tryout finished.
router.post('/tryouts/:id/complete', async (req, res) => {
  try {
    const t = await prisma.tryout.findFirst({ where: { id: req.params.id, division: DIVISION } });
    if (!t) return res.status(404).json({ error: 'Tryout not found' });
    if (t.hostId !== req.user.id && req.user.role !== 'DEVELOPER') {
      return res.status(403).json({ error: 'Only the host can end this tryout.' });
    }
    const updated = await prisma.tryout.update({ where: { id: t.id }, data: { status: 'COMPLETED' } });
    try {
      const bot = require('../lib/bot');
      await bot.deleteTryoutAnnouncement(updated).catch(() => {});
      await bot.editTryoutHostDM(updated).catch(() => {});
    } catch (e) { /* best-effort */ }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to complete tryout' });
  }
});

// ── Tryout logs (conclude → host reviews/posts → Director's Office approves) ──
const tryoutLogsLib = require('../lib/tryoutLogs');
const { sendTryoutLog, editTryoutLog } = require('../lib/webhook');

// GET /api/cid/tryout-logs/context — what the UI should show for this user.
router.get('/tryout-logs/context', async (req, res) => {
  const canApprove = await userIsCidLead(req.user).catch(() => false);
  res.json({ canApprove });
});

// GET /api/cid/tryout-logs/mine — the host's own CID logs (drafts + submitted).
router.get('/tryout-logs/mine', async (req, res) => {
  try {
    const logs = await prisma.tryoutLog.findMany({ where: { division: DIVISION, hostId: req.user.id }, orderBy: { createdAt: 'desc' }, take: 100 });
    res.json(logs.map(l => tryoutLogsLib.serialize(l)));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load your tryout logs' });
  }
});

// GET /api/cid/tryout-logs/pending — the Director's Office review queue.
router.get('/tryout-logs/pending', requireCidLead, async (req, res) => {
  try {
    const status = ['PENDING', 'APPROVED', 'DENIED'].includes(req.query.status) ? req.query.status : 'PENDING';
    const logs = await prisma.tryoutLog.findMany({ where: { division: DIVISION, status }, orderBy: { createdAt: 'desc' }, take: 200 });
    res.json(logs.map(l => tryoutLogsLib.serialize(l)));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load the review queue' });
  }
});

// GET /api/cid/tryout-logs/:id — full detail (owner or approver only).
router.get('/tryout-logs/:id', async (req, res) => {
  try {
    const log = await prisma.tryoutLog.findFirst({ where: { id: req.params.id, division: DIVISION } });
    if (!log) return res.status(404).json({ error: 'Tryout log not found' });
    const isLead = await userIsCidLead(req.user).catch(() => false);
    if (log.hostId !== req.user.id && !isLead) return res.status(403).json({ error: 'Not your tryout log.' });
    res.json(tryoutLogsLib.serialize(log, { full: true }));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load the tryout log' });
  }
});

// POST /api/cid/tryout-logs/:id/submit { notes?, attendees? } — host posts for review.
router.post('/tryout-logs/:id/submit', async (req, res) => {
  try {
    const log = await prisma.tryoutLog.findFirst({ where: { id: req.params.id, division: DIVISION } });
    if (!log) return res.status(404).json({ error: 'Tryout log not found' });
    if (log.hostId !== req.user.id) return res.status(403).json({ error: 'Only the host can submit this log.' });
    if (log.status !== 'DRAFT') return res.status(400).json({ error: 'This log has already been submitted.' });

    const { notes, attendees, proof } = req.body || {};
    const data = { status: 'PENDING' };
    if (typeof notes === 'string') data.notes = notes.slice(0, 3000);
    if (typeof proof === 'string') data.proof = proof.slice(0, 500);
    if (Array.isArray(attendees)) {
      const clean = tryoutLogsLib.normaliseAttendees(attendees);
      Object.assign(data, { attendees: clean, ...tryoutLogsLib.countsFor(clean) });
    }
    const updated = await prisma.tryoutLog.update({ where: { id: log.id }, data });
    const msgId = await sendTryoutLog(updated, { event: 'submitted' }).catch(() => null);
    if (msgId) await prisma.tryoutLog.update({ where: { id: log.id }, data: { logMessageId: msgId } }).catch(() => {});
    res.json({ success: true, status: 'PENDING', posted: !!msgId });
  } catch (err) {
    console.error('[CID] submit tryout log failed:', err.message);
    res.status(500).json({ error: 'Failed to submit the tryout log' });
  }
});

// POST /api/cid/tryout-logs/:id/approve { note? } — Director's Office approves.
// On approval the host gets +1 "event hosted" on the CID database sheet (the
// current-day column of their row, on the matching rank-tier tab). Best-effort.
router.post('/tryout-logs/:id/approve', requireCidLead, async (req, res) => {
  try {
    const log = await prisma.tryoutLog.findFirst({ where: { id: req.params.id, division: DIVISION } });
    if (!log) return res.status(404).json({ error: 'Tryout log not found' });
    if (log.status !== 'PENDING') return res.status(400).json({ error: 'Only pending logs can be approved.' });

    // Award the host their +1 CID event (never blocks approval).
    const awarded = await tryoutLogsLib.awardCidEventPoint(log).catch(() => false);

    const updated = await prisma.tryoutLog.update({
      where: { id: log.id },
      data: {
        status: 'APPROVED', pointAwarded: awarded,
        reviewNote: req.body && req.body.note ? String(req.body.note).slice(0, 2000) : null,
        reviewedById: req.user.id, reviewedByName: req.user.displayName || req.user.discordUsername,
        reviewedAt: new Date(),
      },
    });
    await editTryoutLog(updated, { event: 'approved' }).catch(() => null);
    res.json({ success: true, status: 'APPROVED', pointAwarded: awarded });
  } catch (err) {
    console.error('[CID] approve tryout log failed:', err.message);
    res.status(500).json({ error: 'Failed to approve the tryout log' });
  }
});

// POST /api/cid/tryout-logs/:id/deny { note } — Director's Office denies.
router.post('/tryout-logs/:id/deny', requireCidLead, async (req, res) => {
  try {
    const log = await prisma.tryoutLog.findFirst({ where: { id: req.params.id, division: DIVISION } });
    if (!log) return res.status(404).json({ error: 'Tryout log not found' });
    if (log.status !== 'PENDING') return res.status(400).json({ error: 'Only pending logs can be denied.' });

    const updated = await prisma.tryoutLog.update({
      where: { id: log.id },
      data: {
        status: 'DENIED',
        reviewNote: req.body && req.body.note ? String(req.body.note).slice(0, 2000) : null,
        reviewedById: req.user.id, reviewedByName: req.user.displayName || req.user.discordUsername,
        reviewedAt: new Date(),
      },
    });
    await editTryoutLog(updated, { event: 'denied' }).catch(() => null);
    res.json({ success: true, status: 'DENIED' });
  } catch (err) {
    console.error('[CID] deny tryout log failed:', err.message);
    res.status(500).json({ error: 'Failed to deny the tryout log' });
  }
});

module.exports = router;
