// server/routes/sco19.js — SCO-19 (Specialist Firearms Command)
// Deployment/operations log: firearms deployments & authorisations, officer
// callsigns, incident type, lead sign-off. Mounted at /api/sco19 behind
// requireDivision('SCO19').
const express = require('express');
const prisma  = require('../lib/db');
const { nextRef } = require('../lib/refGen');
const { requireDivisionLead } = require('../middleware/division');

const router = express.Router();
const lead = requireDivisionLead('SCO19');

function summarise(d) {
  return {
    id: d.id,
    deploymentRef: d.deploymentRef,
    callsign: d.callsign,
    incidentType: d.incidentType,
    authorisation: d.authorisation,
    summary: d.summary,
    status: d.status,
    officerId: d.officerId,
    officer: d.officer && { id: d.officer.id, displayName: d.officer.displayName || d.officer.discordUsername },
    signedOffById: d.signedOffById,
    signedOffAt: d.signedOffAt,
    createdAt: d.createdAt,
  };
}

// GET /api/sco19/deployments
router.get('/deployments', async (req, res) => {
  try {
    const deployments = await prisma.sco19Deployment.findMany({
      include: { officer: { select: { id: true, displayName: true, discordUsername: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(deployments.map(summarise));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load deployments' });
  }
});

// POST /api/sco19/deployments — log a deployment
router.post('/deployments', async (req, res) => {
  try {
    const { callsign, incidentType, authorisation, summary } = req.body || {};
    if (!callsign || !incidentType || !authorisation || !summary) {
      return res.status(400).json({ error: 'callsign, incidentType, authorisation and summary are required' });
    }
    const d = await prisma.sco19Deployment.create({
      data: {
        deploymentRef: nextRef('SCO19'),
        officerId: req.user.id,
        callsign: String(callsign).slice(0, 40),
        incidentType: String(incidentType).slice(0, 120),
        authorisation: String(authorisation).slice(0, 200),
        summary: String(summary).slice(0, 5000),
      },
      include: { officer: { select: { id: true, displayName: true, discordUsername: true } } },
    });
    res.status(201).json(summarise(d));
  } catch (err) {
    res.status(500).json({ error: 'Failed to log deployment' });
  }
});

// PATCH /api/sco19/deployments/:id/sign-off — lead review (approve/reject)
router.patch('/deployments/:id/sign-off', lead, async (req, res) => {
  try {
    const { approve } = req.body || {};
    const d = await prisma.sco19Deployment.update({
      where: { id: req.params.id },
      data: {
        status: approve ? 'SIGNED_OFF' : 'REJECTED',
        signedOffById: req.user.id,
        signedOffAt: new Date(),
      },
      include: { officer: { select: { id: true, displayName: true, discordUsername: true } } },
    });
    res.json(summarise(d));
  } catch (err) {
    res.status(500).json({ error: 'Failed to sign off deployment' });
  }
});

module.exports = router;
