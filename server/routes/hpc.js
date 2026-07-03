// server/routes/hpc.js — HPC (Hendon Police College)
// Cadet roster, course completion tracking, pass/fail, graduation status,
// instructor sign-off. Mounted at /api/hpc behind requireDivision('HPC').
const express = require('express');
const prisma  = require('../lib/db');
const { requireDivisionLead } = require('../middleware/division');

const router = express.Router();
const instructor = requireDivisionLead('HPC'); // HPC leads act as instructors for sign-off purposes

function summarise(r) {
  return {
    id: r.id,
    cadetId: r.cadetId,
    cadet: r.cadet && { id: r.cadet.id, displayName: r.cadet.displayName || r.cadet.discordUsername },
    courseName: r.courseName,
    status: r.status,
    instructorId: r.instructorId,
    instructorNote: r.instructorNote,
    signedOffAt: r.signedOffAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// GET /api/hpc/records — full roster / training record list
router.get('/records', async (req, res) => {
  try {
    const records = await prisma.hpcTrainingRecord.findMany({
      include: { cadet: { select: { id: true, displayName: true, discordUsername: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(records.map(summarise));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load training records' });
  }
});

// GET /api/hpc/records/my — the current cadet's own course history
router.get('/records/my', async (req, res) => {
  try {
    const records = await prisma.hpcTrainingRecord.findMany({
      where: { cadetId: req.user.id },
      orderBy: { createdAt: 'desc' },
    });
    res.json(records.map(summarise));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load your records' });
  }
});

// POST /api/hpc/records — enrol a cadet onto a course (instructors only)
// Cadets are identified by Discord ID (what an instructor actually has to
// hand) — they must have signed into the portal at least once already.
router.post('/records', instructor, async (req, res) => {
  try {
    const { cadetDiscordId, courseName } = req.body || {};
    if (!cadetDiscordId || !courseName) {
      return res.status(400).json({ error: 'cadetDiscordId and courseName are required' });
    }
    const cadet = await prisma.user.findUnique({ where: { discordId: String(cadetDiscordId) } });
    if (!cadet) return res.status(404).json({ error: 'That Discord user hasn’t signed into the portal yet' });

    const r = await prisma.hpcTrainingRecord.create({
      data: { cadetId: cadet.id, courseName: String(courseName).slice(0, 200), instructorId: req.user.id },
      include: { cadet: { select: { id: true, displayName: true, discordUsername: true } } },
    });
    res.status(201).json(summarise(r));
  } catch (err) {
    res.status(500).json({ error: 'Failed to enrol cadet' });
  }
});

// PATCH /api/hpc/records/:id/status — pass/fail/graduate a cadet (instructors only)
router.patch('/records/:id/status', instructor, async (req, res) => {
  try {
    const { status, instructorNote } = req.body || {};
    if (!['ENROLLED', 'IN_TRAINING', 'PASSED', 'FAILED', 'GRADUATED'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const signedOff = ['PASSED', 'FAILED', 'GRADUATED'].includes(status);

    const r = await prisma.hpcTrainingRecord.update({
      where: { id: req.params.id },
      data: {
        status,
        instructorId: req.user.id,
        instructorNote: instructorNote ? String(instructorNote).slice(0, 2000) : undefined,
        signedOffAt: signedOff ? new Date() : null,
      },
      include: { cadet: { select: { id: true, displayName: true, discordUsername: true } } },
    });
    res.json(summarise(r));
  } catch (err) {
    res.status(500).json({ error: 'Failed to update training record' });
  }
});

module.exports = router;
