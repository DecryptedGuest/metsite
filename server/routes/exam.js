// server/routes/exam.js — cadet-facing Final Examination (MET-wide).
// Mounted at /api/exam behind requireAuth only (NOT the HPC division gate),
// because a cadet sitting the exam is usually not yet an HPC member — their
// eligibility is the HPC final-exam Discord role captured at login.
const express = require('express');
const prisma  = require('../lib/db');
const hpcExam = require('../lib/hpcExam');
const { userNeedsFinalExam, userHpcTier } = require('../middleware/division');

const router = express.Router();

// Who may even see the paper: eligible cadets, HPC instructors (to review), and
// developers. Everyone else is kept out — leaking the exam is a blacklist offence.
function mayViewPaper(user) {
  return user.role === 'DEVELOPER' || userNeedsFinalExam(user) || userHpcTier(user, 'instructor');
}

function summariseOwn(s) {
  if (!s) return null;
  return {
    id: s.id, status: s.status, score: s.score, maxScore: s.maxScore,
    percentage: s.percentage, markerNote: s.markerNote,
    markedByName: s.markedByName, markedAt: s.markedAt, createdAt: s.createdAt,
  };
}

// GET /api/exam/my — the cadet's eligibility + latest attempt status.
router.get('/my', async (req, res) => {
  try {
    const eligible = req.user.role === 'DEVELOPER' || userNeedsFinalExam(req.user);
    const latest = await prisma.hpcExamSubmission.findFirst({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
    });
    res.json({
      eligible,
      canRetake: eligible && (!latest || latest.status === 'FAILED'),
      latest: summariseOwn(latest),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load exam status' });
  }
});

// GET /api/exam/paper — the questions (gated; never includes an answer key).
router.get('/paper', (req, res) => {
  if (!mayViewPaper(req.user)) return res.status(403).json({ error: 'You are not eligible to take this exam.' });
  res.json(hpcExam.publicPaper());
});

// POST /api/exam/submit — submit answers + anti-cheat telemetry.
router.post('/submit', async (req, res) => {
  const eligible = req.user.role === 'DEVELOPER' || userNeedsFinalExam(req.user);
  if (!eligible) return res.status(403).json({ error: 'You are not eligible to take this exam.' });

  const { answers, detection } = req.body || {};
  if (!answers || typeof answers !== 'object') return res.status(400).json({ error: 'answers are required' });

  // Block a second attempt while one is still awaiting marking.
  const pending = await prisma.hpcExamSubmission.findFirst({ where: { userId: req.user.id, status: 'PENDING' } });
  if (pending) return res.status(409).json({ error: 'You already have an exam awaiting marking.' });

  // Validate required questions are answered.
  const missing = hpcExam.QUESTIONS.filter(q => q.required && !String(answers[q.id] || '').trim()).map(q => q.id);
  if (missing.length) return res.status(400).json({ error: `Please answer all required questions (${missing.length} missing).`, missing });

  // Keep only known question ids, capped length.
  const clean = {};
  for (const q of hpcExam.QUESTIONS) {
    if (answers[q.id] != null) clean[q.id] = String(answers[q.id]).slice(0, 5000);
  }

  const flags = hpcExam.computeFlags(clean, detection || {});

  try {
    const sub = await prisma.hpcExamSubmission.create({
      data: {
        userId:          req.user.id,
        discordId:       req.user.discordId,
        discordUsername: req.user.discordUsername,
        robloxUsername:  req.user.robloxUsername || clean.roblox_username || null,
        answers:         clean,
        detection:       detection || {},
        flags,
        maxScore:        hpcExam.totalPoints(),
        status:          'PENDING',
      },
    });
    res.status(201).json({ success: true, id: sub.id });
  } catch (err) {
    console.error('[Exam] submit failed:', err.message);
    res.status(500).json({ error: 'Failed to submit exam' });
  }
});

module.exports = router;
