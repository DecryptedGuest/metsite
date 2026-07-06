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

// GET /api/exam/lookup?roblox=&discord= — identity confirmation before the exam.
// Resolves the typed Roblox username (public Roblox API → avatar + display name)
// and the typed Discord username (via the bot, best-effort), and always returns
// the signed-in account so the cadet can cross-check "is this you?".
router.get('/lookup', async (req, res) => {
  const roblox  = String(req.query.roblox || '').trim();
  const discord = String(req.query.discord || '').trim();
  const out = { roblox: null, discord: null,
    me: { discordId: req.user.discordId, discordUsername: req.user.discordUsername,
      displayName: req.user.displayName, avatar: req.user.discordAvatar, robloxUsername: req.user.robloxUsername } };

  if (roblox) {
    try {
      const rlib = require('../lib/roblox');
      const r = await rlib.getRobloxIdFromUsername(roblox);
      if (r && r.id) {
        let avatar = null;
        try { avatar = await rlib.getRobloxAvatarHeadshot(r.id); } catch (e) {}
        out.roblox = { found: true, id: r.id, username: r.username, displayName: r.displayName, avatar };
      } else out.roblox = { found: false };
    } catch (e) { out.roblox = { found: false, error: 'lookup failed' }; }
  }

  if (discord) {
    try {
      const bot = require('../lib/bot');
      const list = await bot.searchGuildMembers(discord, 1).catch(() => []);
      const m = (list && list[0]) || null;
      if (m) out.discord = { found: true, id: m.id, username: m.username, displayName: m.displayName, avatar: m.avatar || null, inServer: true };
      else out.discord = { found: false };
    } catch (e) { out.discord = { found: false }; }
  }

  res.json(out);
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
    try {
      require('../lib/audit').record({
        req, action: 'EXAM_SUBMIT', category: 'exam', targetType: 'submission', targetId: sub.id,
        summary: `Submitted the HPC final exam${flags && flags.length ? ` (${flags.length} integrity flag(s))` : ''}`,
        metadata: { flags },
      });
    } catch (e) { /* non-fatal */ }
    res.status(201).json({ success: true, id: sub.id });
  } catch (err) {
    console.error('[Exam] submit failed:', err.message);
    res.status(500).json({ error: 'Failed to submit exam' });
  }
});

module.exports = router;
