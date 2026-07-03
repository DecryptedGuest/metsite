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

const router = express.Router();

// GET /api/hpc/context — what the current HPC member can do (drives the UI).
router.get('/context', (req, res) => {
  res.json({
    canMark:  userHpcTier(req.user, 'marker'),
    canQuota: userHpcTier(req.user, 'quota'),
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

    res.json({ success: true, status: updated.status, score: total, maxScore, percentage, posted: !!msgId });
  } catch (err) {
    console.error('[HPC] mark failed:', err.message);
    res.status(500).json({ error: 'Failed to mark exam' });
  }
});

// GET /api/hpc/quota — Assistant Director+. DB not wired yet (provided later).
router.get('/quota', requireHpcQuota, (req, res) => {
  res.json({ configured: false, message: 'The HPC quota database has not been connected yet.' });
});

module.exports = router;
