// server/routes/flp.js — FLP (Frontline Policing)
// Day-to-day patrol logging: shift start/end, incidents attended, arrests
// made, simple stats. Mounted at /api/flp behind requireDivision('FLP').
const express = require('express');
const prisma  = require('../lib/db');

const router = express.Router();

function summarise(s) {
  return {
    id: s.id,
    officerId: s.officerId,
    officer: s.officer && { id: s.officer.id, displayName: s.officer.displayName || s.officer.discordUsername },
    shiftStart: s.shiftStart,
    shiftEnd: s.shiftEnd,
    incidentsCount: s.incidentsCount,
    arrestsCount: s.arrestsCount,
    notes: s.notes,
    createdAt: s.createdAt,
  };
}

// GET /api/flp/shifts — everyone's logged shifts (recent first)
router.get('/shifts', async (req, res) => {
  try {
    const shifts = await prisma.flpShiftLog.findMany({
      include: { officer: { select: { id: true, displayName: true, discordUsername: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json(shifts.map(summarise));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load shifts' });
  }
});

// GET /api/flp/shifts/my — the current officer's own shift history
router.get('/shifts/my', async (req, res) => {
  try {
    const shifts = await prisma.flpShiftLog.findMany({
      where: { officerId: req.user.id },
      orderBy: { createdAt: 'desc' },
    });
    res.json(shifts.map(summarise));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load your shifts' });
  }
});

// GET /api/flp/stats — simple aggregate stats for the dashboard
router.get('/stats', async (req, res) => {
  try {
    const [totalShifts, aggregates, myShifts] = await Promise.all([
      prisma.flpShiftLog.count(),
      prisma.flpShiftLog.aggregate({ _sum: { incidentsCount: true, arrestsCount: true } }),
      prisma.flpShiftLog.count({ where: { officerId: req.user.id } }),
    ]);
    res.json({
      totalShifts,
      totalIncidents: aggregates._sum.incidentsCount || 0,
      totalArrests: aggregates._sum.arrestsCount || 0,
      myShifts,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

// POST /api/flp/shifts — start a shift
router.post('/shifts', async (req, res) => {
  try {
    const s = await prisma.flpShiftLog.create({
      data: { officerId: req.user.id, shiftStart: new Date() },
      include: { officer: { select: { id: true, displayName: true, discordUsername: true } } },
    });
    res.status(201).json(summarise(s));
  } catch (err) {
    res.status(500).json({ error: 'Failed to start shift' });
  }
});

// PATCH /api/flp/shifts/:id/end — end a shift, recording incidents/arrests/notes
router.patch('/shifts/:id/end', async (req, res) => {
  try {
    const { incidentsCount, arrestsCount, notes } = req.body || {};
    const existing = await prisma.flpShiftLog.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Shift not found' });
    if (existing.officerId !== req.user.id && req.user.role !== 'DEVELOPER') {
      return res.status(403).json({ error: 'You can only end your own shift' });
    }

    const s = await prisma.flpShiftLog.update({
      where: { id: req.params.id },
      data: {
        shiftEnd: new Date(),
        incidentsCount: Number.isFinite(+incidentsCount) ? Math.max(0, +incidentsCount) : 0,
        arrestsCount: Number.isFinite(+arrestsCount) ? Math.max(0, +arrestsCount) : 0,
        notes: notes ? String(notes).slice(0, 2000) : null,
      },
      include: { officer: { select: { id: true, displayName: true, discordUsername: true } } },
    });
    res.json(summarise(s));
  } catch (err) {
    res.status(500).json({ error: 'Failed to end shift' });
  }
});

module.exports = router;
