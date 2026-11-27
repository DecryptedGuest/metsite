// HICOMM-only review endpoints for MET Constable applications.
const express = require('express');
const router = express.Router();
const prisma = require('../lib/db');
const { requireMetHicomm } = require('../middleware/division');

router.use(requireMetHicomm);

router.get('/queue', async (_req, res) => {
  try {
    const rows = await prisma.metApplication.findMany({
      orderBy: { submittedAt: 'asc' },
      select: { id: true, appRef: true, discordUsername: true, robloxUsername: true, status: true, submittedAt: true },
      take: 200,
    });
    res.json(rows);
  } catch (e) {
    console.error('[MET application review] queue error:', e.message);
    res.status(500).json({ error: 'Could not load applications.' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const row = await prisma.metApplication.findUnique({ where: { id: String(req.params.id) } });
    if (!row) return res.status(404).json({ error: 'Application not found.' });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: 'Could not load application.' });
  }
});

router.post('/:id/decision', async (req, res) => {
  try {
    const status = String(req.body && req.body.status || '');
    if (!['ACCEPTED', 'REJECTED'].includes(status)) return res.status(400).json({ error: 'Choose accepted or rejected.' });
    const note = String(req.body && req.body.note || '').trim().slice(0, 2000);
    const row = await prisma.metApplication.update({
      where: { id: String(req.params.id) },
      data: {
        status, markerNote: note || null, markedAt: new Date(),
        markedById: req.user.id,
        markedByName: req.user.displayName || req.user.discordUsername || 'MET High Command',
      },
      select: { id: true, appRef: true, status: true, markedAt: true },
    });
    await require('../lib/audit').record({
      req, action: 'MET_APPLICATION_DECIDED', category: 'RECRUITMENT',
      targetType: 'met_application', targetId: row.id,
      summary: 'MET application ' + row.appRef + ' marked ' + status + '.',
      metadata: { appRef: row.appRef, status, note },
    }).catch(() => {});
    res.json({ ok: true, application: row });
  } catch (e) {
    console.error('[MET application review] decision error:', e.message);
    res.status(500).json({ error: 'Could not save the decision.' });
  }
});

module.exports = router;
