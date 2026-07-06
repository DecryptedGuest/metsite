// server/routes/hpc.js — HPC (Hendon Police College)
// Mounted at /api/hpc behind requireAuth + requireDivision('HPC') (Junior
// Instructor and above). Provides:
//   • Final-exam marking (Database Manager and above)
//   • Quota check (Assistant Director and above) — DB wiring pending
const express = require('express');
const prisma  = require('../lib/db');
const hpcExam = require('../lib/hpcExam');
const { sendHpcExamResult } = require('../lib/webhook');
const { requireHpcMarker, requireHpcQuota, userHpcTier } = require('../middleware/division');
const audit = require('../lib/audit');

const router = express.Router();

// GET /api/hpc/context — what the current HPC member can do (drives the UI).
router.get('/context', (req, res) => {
  res.json({
    canMark:    userHpcTier(req.user, 'marker'),
    canQuota:   userHpcTier(req.user, 'quota'),
    canApprove: userHpcTier(req.user, 'quota') || ['HICOMM', 'DEVELOPER'].includes(req.user.role),
    isDev:      req.user.role === 'DEVELOPER',
  });
});

// GET /api/hpc/exam/paper — the paper, for markers to see each prompt.
router.get('/exam/paper', requireHpcMarker, (req, res) => res.json(hpcExam.publicPaper()));

function summariseSubmission(s, full) {
  const base = {
    id: s.id,
    discordId: s.discordId,
    discordUsername: s.discordUsername,
    robloxUsername: s.robloxUsername,
    status: s.status,
    score: s.score,
    maxScore: s.maxScore,
    percentage: s.percentage,
    flagCount: Array.isArray(s.flags) ? s.flags.length : 0,
    highFlags: Array.isArray(s.flags) ? s.flags.filter(f => f.severity === 'high').length : 0,
    markedByName: s.markedByName,
    markedAt: s.markedAt,
    createdAt: s.createdAt,
  };
  if (!full) return base;
  return { ...base, answers: s.answers, detection: s.detection, flags: s.flags, scores: s.scores, markerNote: s.markerNote };
}

// GET /api/hpc/exam/results — read-only list of ALL exams + marks/status for
// any HPC member (Junior Instructor+). No answers/AI detail (that's marker-only).
router.get('/exam/results', async (req, res) => {
  try {
    const subs = await prisma.hpcExamSubmission.findMany({ orderBy: { createdAt: 'desc' }, take: 500 });
    res.json(subs.map(s => ({
      id: s.id, discordUsername: s.discordUsername, discordId: s.discordId,
      robloxUsername: s.robloxUsername, status: s.status, score: s.score,
      maxScore: s.maxScore, percentage: s.percentage,
      markedByName: s.markedByName, markedAt: s.markedAt, createdAt: s.createdAt,
    })));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load results' });
  }
});

// GET /api/hpc/exam/results/:id — read-only exam detail for ANY HPC member
// (Junior Instructor+). Shows the mark, status, feedback note and timing — but
// NOT the answers or anti-cheat detail (those stay marker-only via the
// /exam/submissions/:id route). Lets everyone click a Final Exam to see more.
router.get('/exam/results/:id', async (req, res) => {
  try {
    const s = await prisma.hpcExamSubmission.findUnique({ where: { id: req.params.id } });
    if (!s) return res.status(404).json({ error: 'Exam not found' });
    res.json({
      id: s.id, discordUsername: s.discordUsername, discordId: s.discordId,
      robloxUsername: s.robloxUsername, status: s.status,
      score: s.score, maxScore: s.maxScore, percentage: s.percentage,
      markerNote: s.markerNote, markedByName: s.markedByName, markedAt: s.markedAt,
      createdAt: s.createdAt,
      // Whether the viewer can open the full marked paper (answers + AI flags).
      canMark: userHpcTier(req.user, 'marker'),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load exam' });
  }
});

// GET /api/hpc/exam/submissions?status=PENDING — marker queue / archive.
router.get('/exam/submissions', requireHpcMarker, async (req, res) => {
  try {
    const where = {};
    if (['PENDING', 'PASSED', 'FAILED'].includes(req.query.status)) where.status = req.query.status;
    const subs = await prisma.hpcExamSubmission.findMany({ where, orderBy: { createdAt: 'desc' }, take: 300 });
    res.json(subs.map(s => summariseSubmission(s, false)));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load submissions' });
  }
});

// GET /api/hpc/exam/submissions/:id — full detail (answers + AI flags) to mark.
router.get('/exam/submissions/:id', requireHpcMarker, async (req, res) => {
  try {
    const s = await prisma.hpcExamSubmission.findUnique({ where: { id: req.params.id } });
    if (!s) return res.status(404).json({ error: 'Submission not found' });
    res.json({ paper: hpcExam.publicPaper(), submission: summariseSubmission(s, true) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load submission' });
  }
});

// POST /api/hpc/exam/submissions/:id/mark { scores:{qid:points}, note }
router.post('/exam/submissions/:id/mark', requireHpcMarker, async (req, res) => {
  const { scores, note } = req.body || {};
  if (!scores || typeof scores !== 'object') return res.status(400).json({ error: 'scores are required' });
  try {
    const s = await prisma.hpcExamSubmission.findUnique({ where: { id: req.params.id } });
    if (!s) return res.status(404).json({ error: 'Submission not found' });

    // Clamp each score to its question's max; sum the total.
    const clean = {};
    let total = 0;
    for (const q of hpcExam.QUESTIONS) {
      const raw = Number(scores[q.id]);
      const pts = Number.isFinite(raw) ? Math.max(0, Math.min(q.points, raw)) : 0;
      clean[q.id] = pts;
      total += pts;
    }
    const maxScore   = hpcExam.totalPoints();
    const percentage = Math.round((total / maxScore) * 100);
    const passed     = percentage >= hpcExam.PASS_PERCENT;

    const updated = await prisma.hpcExamSubmission.update({
      where: { id: s.id },
      data: {
        scores: clean,
        score: total,
        percentage,
        status: passed ? 'PASSED' : 'FAILED',
        markerNote: note ? String(note).slice(0, 2000) : null,
        markedById: req.user.id,
        markedByName: req.user.displayName || req.user.discordUsername,
        markedAt: new Date(),
      },
    });

    // Post the result to the MET results channel (best-effort).
    const msgId = await sendHpcExamResult({
      discordId: s.discordId,
      robloxUsername: s.robloxUsername,
      discordUsername: s.discordUsername,
      score: total, maxScore, percentage, passed,
      note,
    }).catch(() => null);
    if (msgId) await prisma.hpcExamSubmission.update({ where: { id: s.id }, data: { resultMessageId: msgId } }).catch(() => {});

    audit.record({
      req, action: 'EXAM_MARK', category: 'exam', targetType: 'submission', targetId: s.id,
      summary: `Marked ${s.discordUsername || s.robloxUsername || 'a cadet'}'s final exam: ${total}/${maxScore} (${percentage}%) — ${updated.status}`,
      metadata: { score: total, maxScore, percentage, status: updated.status },
    });

    // Live in-page notification to the cadet (best-effort).
    try {
      require('../lib/events').publishToUser(s.userId, 'exam_marked', {
        status: updated.status, score: total, maxScore, percentage,
        message: `Your final exam has been marked: ${percentage}% — ${passed ? 'PASSED' : 'FAILED'}.`,
      });
    } catch (e) { /* non-fatal */ }

    res.json({ success: true, status: updated.status, score: total, maxScore, percentage, posted: !!msgId });
  } catch (err) {
    console.error('[HPC] mark failed:', err.message);
    res.status(500).json({ error: 'Failed to mark exam' });
  }
});

// DELETE /api/hpc/exam/submissions/:id — DEVELOPER ONLY. Voids a final exam
// entirely: deletes the record so the cadet is treated as if they never sat it
// (they become eligible to take it again).
router.delete('/exam/submissions/:id', async (req, res) => {
  if (req.user.role !== 'DEVELOPER') return res.status(403).json({ error: 'Developer access required.' });
  try {
    await prisma.hpcExamSubmission.delete({ where: { id: req.params.id } });
    res.json({ success: true, voided: true });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Exam not found' });
    console.error('[HPC] delete exam failed:', err.message);
    res.status(500).json({ error: 'Failed to delete exam' });
  }
});

// GET /api/hpc/quota — Assistant Director+. DB not wired yet (provided later).
router.get('/quota', requireHpcQuota, (req, res) => {
  res.json({ configured: false, message: 'The HPC quota database has not been connected yet.' });
});

// ── Tryouts (any HPC member — Junior Instructor+ — can schedule/view) ──
function tryoutSummary(t) {
  return {
    id: t.id, hostName: t.hostName, hostDiscordId: t.hostDiscordId,
    coHostName: t.coHostName, coHostDiscordId: t.coHostDiscordId,
    scheduledAt: t.scheduledAt, status: t.status, lockState: t.lockState,
    privateServerLink: t.privateServerLink, announcementSent: t.announcementSent,
    notes: t.notes, createdAt: t.createdAt,
    isMine: undefined,
  };
}

// GET /api/hpc/tryouts — upcoming + recent tryouts.
router.get('/tryouts', async (req, res) => {
  try {
    const tryouts = await prisma.tryout.findMany({ orderBy: { scheduledAt: 'desc' }, take: 100 });
    res.json(tryouts.map(t => ({ ...tryoutSummary(t), isMine: t.hostId === req.user.id })));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load tryouts' });
  }
});

// Can this user manage (strike/pass/fail/kick) this tryout from the site?
// Host, co-host, or developer.
function canManageTryout(user, t) {
  if (user.role === 'DEVELOPER') return true;
  if (t.hostId === user.id) return true;
  if (t.coHostDiscordId && String(t.coHostDiscordId) === String(user.discordId)) return true;
  return false;
}

// GET /api/hpc/tryouts/live — live tryouts + their latest in-game overview
// snapshot, so instructors can watch a running tryout from the site; the host/
// co-host also get `canManage:true` to drive it from here.
router.get('/tryouts/live', async (req, res) => {
  try {
    const live = await prisma.tryout.findMany({ where: { status: 'LIVE' }, orderBy: { scheduledAt: 'desc' }, take: 20 });
    res.json(live.map(t => ({
      id: t.id, hostName: t.hostName, coHostName: t.coHostName,
      lockState: t.lockState, scheduledAt: t.scheduledAt,
      snapshot: t.liveSnapshot || null, // { at, attendees:[...], totalAttendees, passedCount, ... }
      canManage: canManageTryout(req.user, t),
    })));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load live tryouts' });
  }
});

// POST /api/hpc/tryouts/:id/command — host/co-host queue a live action
// (STRIKE | UNSTRIKE | PASS | FAIL | KICK | NOTE). The in-game panel polls and
// applies it, so the site can drive the tryout like the in-game panel.
router.post('/tryouts/:id/command', async (req, res) => {
  try {
    const t = await prisma.tryout.findUnique({ where: { id: req.params.id } });
    if (!t) return res.status(404).json({ error: 'Tryout not found' });
    if (!canManageTryout(req.user, t)) return res.status(403).json({ error: 'Only the host or co-host can manage this tryout.' });
    if (t.status !== 'LIVE') return res.status(400).json({ error: 'This tryout is not live.' });

    const { action, targetRobloxId, targetUsername, detail } = req.body || {};
    const ACTIONS = ['STRIKE', 'UNSTRIKE', 'PASS', 'FAIL', 'KICK', 'NOTE'];
    const act = String(action || '').toUpperCase();
    if (!ACTIONS.includes(act)) return res.status(400).json({ error: 'Invalid action' });
    if (act !== 'NOTE' && !targetRobloxId && !targetUsername) return res.status(400).json({ error: 'A target is required.' });

    const cmd = await prisma.tryoutCommand.create({ data: {
      tryoutId: t.id, action: act,
      targetRobloxId: targetRobloxId ? String(targetRobloxId) : null,
      targetUsername: targetUsername || null,
      detail: detail ? String(detail).slice(0, 200) : null,
      issuedById: req.user.id, issuedByName: req.user.displayName || req.user.discordUsername,
    } });
    res.status(201).json({ success: true, id: cmd.id });
  } catch (err) {
    console.error('[HPC] tryout command failed:', err.message);
    res.status(500).json({ error: 'Failed to queue command' });
  }
});

// POST /api/hpc/tryouts { scheduledAt, lockState, notes } — schedule one.
router.post('/tryouts', async (req, res) => {
  try {
    const { scheduledAt, lockState, notes } = req.body || {};
    const when = new Date(scheduledAt);
    if (isNaN(when.getTime())) return res.status(400).json({ error: 'A valid date/time is required.' });
    if (when.getTime() < Date.now() - 60 * 1000) return res.status(400).json({ error: 'The scheduled time must be in the future.' });

    const t = await prisma.tryout.create({
      data: {
        hostId: req.user.id,
        hostDiscordId: req.user.discordId,
        hostName: req.user.displayName || req.user.discordUsername,
        scheduledAt: when,
        lockState: ['UNLOCKED', 'UNSLOCKED'].includes(String(lockState).toUpperCase()) ? 'UNLOCKED' : 'LOCKED',
        notes: notes ? String(notes).slice(0, 500) : null,
      },
    });
    audit.record({
      req, action: 'TRYOUT_SCHEDULE', category: 'tryout', targetType: 'tryout', targetId: t.id,
      summary: `Scheduled a MET tryout for ${when.toISOString()}`,
      metadata: { scheduledAt: when.toISOString(), lockState: t.lockState },
    });
    res.status(201).json(tryoutSummary(t));
  } catch (err) {
    console.error('[HPC] schedule tryout failed:', err.message);
    res.status(500).json({ error: 'Failed to schedule tryout' });
  }
});

// POST /api/hpc/tryouts/:id/cancel — host (or developer) cancels a tryout.
router.post('/tryouts/:id/cancel', async (req, res) => {
  try {
    const t = await prisma.tryout.findUnique({ where: { id: req.params.id } });
    if (!t) return res.status(404).json({ error: 'Tryout not found' });
    if (t.hostId !== req.user.id && req.user.role !== 'DEVELOPER') {
      return res.status(403).json({ error: 'Only the host can cancel this tryout.' });
    }
    if (['COMPLETED', 'CANCELLED'].includes(t.status)) return res.status(400).json({ error: 'This tryout is already finished.' });
    await prisma.tryout.update({ where: { id: t.id }, data: { status: 'CANCELLED' } });
    audit.record({ req, action: 'TRYOUT_CANCEL', category: 'tryout', targetType: 'tryout', targetId: t.id, summary: 'Cancelled a MET tryout' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to cancel tryout' });
  }
});

// POST /api/hpc/tryouts/:id/complete — mark a live tryout finished.
router.post('/tryouts/:id/complete', async (req, res) => {
  try {
    const t = await prisma.tryout.findUnique({ where: { id: req.params.id } });
    if (!t) return res.status(404).json({ error: 'Tryout not found' });
    if (t.hostId !== req.user.id && req.user.role !== 'DEVELOPER') {
      return res.status(403).json({ error: 'Only the host can end this tryout.' });
    }
    await prisma.tryout.update({ where: { id: t.id }, data: { status: 'COMPLETED' } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to complete tryout' });
  }
});

// ── Tryout logs ───────────────────────────────────────────────────────
// Host reviews + posts the log the in-game panel created; HPC HICOMM (quota
// tier / site HICOMM / developer) approve or deny; approval awards +1 point.
const tryoutLogsLib = require('../lib/tryoutLogs');
const { sendTryoutLog } = require('../lib/webhook');

// Who can approve/deny tryout logs: Assistant Director+ (HPC quota tier), or a
// site HICOMM / developer.
function canApproveTryouts(user) {
  return userHpcTier(user, 'quota') || ['HICOMM', 'DEVELOPER'].includes(user.role);
}
function requireTryoutApprover(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (canApproveTryouts(req.user)) return next();
  return res.status(403).json({ error: 'HPC HICOMM access required to review tryout logs.' });
}

// GET /api/hpc/tryout-logs/context — what the UI should show for this user.
router.get('/tryout-logs/context', (req, res) => {
  res.json({ canApprove: canApproveTryouts(req.user) });
});

// GET /api/hpc/tryout-logs/mine — the host's own logs (drafts + submitted).
router.get('/tryout-logs/mine', async (req, res) => {
  try {
    const logs = await prisma.tryoutLog.findMany({ where: { hostId: req.user.id }, orderBy: { createdAt: 'desc' }, take: 100 });
    res.json(logs.map(l => tryoutLogsLib.serialize(l)));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load your tryout logs' });
  }
});

// GET /api/hpc/tryout-logs/pending — the HICOMM review queue.
router.get('/tryout-logs/pending', requireTryoutApprover, async (req, res) => {
  try {
    const status = ['PENDING', 'APPROVED', 'DENIED'].includes(req.query.status) ? req.query.status : 'PENDING';
    const logs = await prisma.tryoutLog.findMany({ where: { status }, orderBy: { createdAt: 'desc' }, take: 200 });
    res.json(logs.map(l => tryoutLogsLib.serialize(l)));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load the review queue' });
  }
});

// GET /api/hpc/tryout-logs/:id — full detail (owner or approver only).
router.get('/tryout-logs/:id', async (req, res) => {
  try {
    const log = await prisma.tryoutLog.findUnique({ where: { id: req.params.id } });
    if (!log) return res.status(404).json({ error: 'Tryout log not found' });
    if (log.hostId !== req.user.id && !canApproveTryouts(req.user)) {
      return res.status(403).json({ error: 'Not your tryout log.' });
    }
    res.json(tryoutLogsLib.serialize(log, { full: true }));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load the tryout log' });
  }
});

// POST /api/hpc/tryout-logs/:id/submit { notes?, attendees? } — host posts the
// log for review (DRAFT → PENDING). Lets the host tweak notes + attendee
// results/strikes on the site before submitting.
router.post('/tryout-logs/:id/submit', async (req, res) => {
  try {
    const log = await prisma.tryoutLog.findUnique({ where: { id: req.params.id } });
    if (!log) return res.status(404).json({ error: 'Tryout log not found' });
    if (log.hostId !== req.user.id) return res.status(403).json({ error: 'Only the host can submit this log.' });
    if (log.status !== 'DRAFT') return res.status(400).json({ error: 'This log has already been submitted.' });

    const { notes, attendees } = req.body || {};
    const data = { status: 'PENDING' };
    if (typeof notes === 'string') data.notes = notes.slice(0, 3000);
    if (Array.isArray(attendees)) {
      const clean = tryoutLogsLib.normaliseAttendees(attendees);
      Object.assign(data, { attendees: clean, ...tryoutLogsLib.countsFor(clean) });
    }

    const updated = await prisma.tryoutLog.update({ where: { id: log.id }, data });
    const msgId = await sendTryoutLog(updated, { event: 'submitted' }).catch(() => null);
    if (msgId) await prisma.tryoutLog.update({ where: { id: log.id }, data: { logMessageId: msgId } }).catch(() => {});
    tryoutLogsLib.notifyTryoutApprovers(updated).catch(() => {}); // push HICOMM (fire-and-forget)
    res.json({ success: true, status: 'PENDING', posted: !!msgId });
  } catch (err) {
    console.error('[HPC] submit tryout log failed:', err.message);
    res.status(500).json({ error: 'Failed to submit the tryout log' });
  }
});

// POST /api/hpc/tryout-logs/:id/approve { note? } — HICOMM approves → +1 point.
router.post('/tryout-logs/:id/approve', requireTryoutApprover, async (req, res) => {
  try {
    const log = await prisma.tryoutLog.findUnique({ where: { id: req.params.id } });
    if (!log) return res.status(404).json({ error: 'Tryout log not found' });
    if (log.status !== 'PENDING') return res.status(400).json({ error: 'Only pending logs can be approved.' });

    // Award the host their +1 HPC point (best-effort; never blocks approval).
    const awarded = await tryoutLogsLib.awardHpcPoint(log).catch(() => false);
    // Optionally sync each attendee's pass/fail to the recruits sheet.
    tryoutLogsLib.syncAttendanceToSheet(log).catch(() => {});

    const updated = await prisma.tryoutLog.update({
      where: { id: log.id },
      data: {
        status: 'APPROVED', pointAwarded: awarded,
        reviewNote: req.body && req.body.note ? String(req.body.note).slice(0, 2000) : null,
        reviewedById: req.user.id, reviewedByName: req.user.displayName || req.user.discordUsername,
        reviewedAt: new Date(),
      },
    });
    await sendTryoutLog(updated, { event: 'approved' }).catch(() => null);
    res.json({ success: true, status: 'APPROVED', pointAwarded: awarded });
  } catch (err) {
    console.error('[HPC] approve tryout log failed:', err.message);
    res.status(500).json({ error: 'Failed to approve the tryout log' });
  }
});

// POST /api/hpc/tryout-logs/:id/deny { note } — HICOMM denies.
router.post('/tryout-logs/:id/deny', requireTryoutApprover, async (req, res) => {
  try {
    const log = await prisma.tryoutLog.findUnique({ where: { id: req.params.id } });
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
    await sendTryoutLog(updated, { event: 'denied' }).catch(() => null);
    res.json({ success: true, status: 'DENIED' });
  } catch (err) {
    console.error('[HPC] deny tryout log failed:', err.message);
    res.status(500).json({ error: 'Failed to deny the tryout log' });
  }
});

// ── GET /api/hpc/analytics?days= — HPC tryout analytics for the dashboard. ──
router.get('/analytics', async (req, res) => {
  try {
    const analytics = require('../lib/analytics');
    const days = Math.min(180, Math.max(7, parseInt(req.query.days, 10) || 30));
    const [tryouts, funnel] = await Promise.all([
      analytics.tryoutAnalytics('HPC', days),
      analytics.recruitmentFunnel('HPC', days),
    ]);
    res.json({ division: 'HPC', days, tryouts, funnel });
  } catch (e) { res.status(500).json({ error: 'Failed to load analytics' }); }
});

module.exports = router;
