// server/routes/cid.js — CID (Criminal Investigation Department)
// Investigation/case-log tool: open a case, log evidence/notes, assign
// investigators, track status. Mounted at /api/cid behind requireDivision('CID').
const express = require('express');
const prisma  = require('../lib/db');
const { nextRef } = require('../lib/refGen');
const { requireDivisionLead } = require('../middleware/division');

const router = express.Router();
const lead = requireDivisionLead('CID');

function summarise(c) {
  return {
    id: c.id,
    caseRef: c.caseRef,
    title: c.title,
    summary: c.summary,
    status: c.status,
    leadInvestigatorId: c.leadInvestigatorId,
    leadInvestigator: c.leadInvestigator && {
      id: c.leadInvestigator.id,
      displayName: c.leadInvestigator.displayName || c.leadInvestigator.discordUsername,
    },
    assignedIds: Array.isArray(c.assignedIds) ? c.assignedIds : [],
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

// GET /api/cid/cases — every CID member can see the case log
router.get('/cases', async (req, res) => {
  try {
    const cases = await prisma.cidCase.findMany({
      include: { leadInvestigator: { select: { id: true, displayName: true, discordUsername: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(cases.map(summarise));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load cases' });
  }
});

// GET /api/cid/cases/:id — case detail incl. evidence/notes log
router.get('/cases/:id', async (req, res) => {
  try {
    const c = await prisma.cidCase.findUnique({
      where: { id: req.params.id },
      include: {
        leadInvestigator: { select: { id: true, displayName: true, discordUsername: true } },
        entries: {
          orderBy: { createdAt: 'asc' },
          include: { author: { select: { id: true, displayName: true, discordUsername: true } } },
        },
      },
    });
    if (!c) return res.status(404).json({ error: 'Case not found' });
    res.json({
      ...summarise(c),
      entries: c.entries.map(e => ({
        id: e.id, kind: e.kind, body: e.body, createdAt: e.createdAt,
        author: e.author && { id: e.author.id, displayName: e.author.displayName || e.author.discordUsername },
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load case' });
  }
});

// POST /api/cid/cases — open a new case (creator becomes lead investigator)
router.post('/cases', async (req, res) => {
  try {
    const { title, summary, assignedIds } = req.body || {};
    if (!title || !summary) return res.status(400).json({ error: 'title and summary are required' });

    const c = await prisma.cidCase.create({
      data: {
        caseRef: nextRef('CID'),
        title: String(title).slice(0, 200),
        summary: String(summary).slice(0, 5000),
        leadInvestigatorId: req.user.id,
        assignedIds: Array.isArray(assignedIds) ? assignedIds : [],
      },
      include: { leadInvestigator: { select: { id: true, displayName: true, discordUsername: true } } },
    });
    res.status(201).json(summarise(c));
  } catch (err) {
    res.status(500).json({ error: 'Failed to open case' });
  }
});

// POST /api/cid/cases/:id/entries — log a note or a piece of evidence
router.post('/cases/:id/entries', async (req, res) => {
  try {
    const { kind, body } = req.body || {};
    if (!['note', 'evidence'].includes(kind) || !body) {
      return res.status(400).json({ error: 'kind (note|evidence) and body are required' });
    }
    const c = await prisma.cidCase.findUnique({ where: { id: req.params.id } });
    if (!c) return res.status(404).json({ error: 'Case not found' });

    const entry = await prisma.cidCaseEntry.create({
      data: { caseId: c.id, authorId: req.user.id, kind, body: String(body).slice(0, 5000) },
    });
    await prisma.cidCase.update({ where: { id: c.id }, data: { updatedAt: new Date() } });
    res.status(201).json(entry);
  } catch (err) {
    res.status(500).json({ error: 'Failed to log entry' });
  }
});

// PATCH /api/cid/cases/:id/status — Open / Under Review / Closed
router.patch('/cases/:id/status', async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!['OPEN', 'UNDER_REVIEW', 'CLOSED'].includes(status)) {
      return res.status(400).json({ error: 'status must be OPEN, UNDER_REVIEW or CLOSED' });
    }
    const c = await prisma.cidCase.update({
      where: { id: req.params.id },
      data: { status },
      include: { leadInvestigator: { select: { id: true, displayName: true, discordUsername: true } } },
    });
    res.json(summarise(c));
  } catch (err) {
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// PATCH /api/cid/cases/:id/assign — reassign lead/assigned investigators (CID leads only)
router.patch('/cases/:id/assign', lead, async (req, res) => {
  try {
    const { leadInvestigatorId, assignedIds } = req.body || {};
    const data = {};
    if (leadInvestigatorId) data.leadInvestigatorId = leadInvestigatorId;
    if (Array.isArray(assignedIds)) data.assignedIds = assignedIds;

    const c = await prisma.cidCase.update({
      where: { id: req.params.id },
      data,
      include: { leadInvestigator: { select: { id: true, displayName: true, discordUsername: true } } },
    });
    res.json(summarise(c));
  } catch (err) {
    res.status(500).json({ error: 'Failed to reassign case' });
  }
});

module.exports = router;
