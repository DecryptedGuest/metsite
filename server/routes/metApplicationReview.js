// Hendon Police College application review endpoints.
const express = require('express');
const router = express.Router();
const prisma = require('../lib/db');
const { requireDivision } = require('../middleware/division');

router.use(requireDivision('HPC'));

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
    const textAnswers = Object.values(row.answers || {}).filter(v => typeof v === 'string');
    const allText = textAnswers.join(' ');
    const repeated = [];
    for (let i = 0; i < textAnswers.length; i++) {
      for (let j = i + 1; j < textAnswers.length; j++) {
        const a = textAnswers[i].toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
        const b = new Set(textAnswers[j].toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean));
        const overlap = a.filter(w => w.length > 4 && b.has(w));
        if (a.length && overlap.length / a.length > 0.65) repeated.push({ answers: [i + 1, j + 1], overlap: Math.round(overlap.length / a.length * 100) });
      }
    }
    const words = allText.trim() ? allText.trim().split(/\s+/).length : 0;
    const comparisonRows = await prisma.metApplication.findMany({
      where: { id: { not: row.id } },
      orderBy: { submittedAt: 'desc' },
      take: 300,
      select: { appRef: true, robloxId: true, answers: true },
    });
    const tokenSet = value => new Set(String(value || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 3));
    const applicantTokens = tokenSet(textAnswers.join(' '));
    const similarApplications = [];
    if (applicantTokens.size >= 12) {
      for (const other of comparisonRows) {
        const otherAnswers = Object.entries(other.answers || {}).filter(([k, v]) => /^q[3-9]$/.test(k) && typeof v === 'string').map(([, v]) => v).join(' ');
        const otherTokens = tokenSet(otherAnswers);
        if (otherTokens.size < 12) continue;
        let shared = 0;
        for (const token of applicantTokens) if (otherTokens.has(token)) shared++;
        const score = shared / Math.min(applicantTokens.size, otherTokens.size);
        if (score >= 0.58) similarApplications.push({ appRef: other.appRef, similarity: Math.round(score * 100), sameRobloxAccount: String(other.robloxId) === String(row.robloxId) });
      }
      similarApplications.sort((a, b) => b.similarity - a.similarity);
    }
    res.json({ ...row, reviewSignals: { wordCount: words, repeatedAnswerPatterns: repeated, similarApplications: similarApplications.slice(0, 8), comparisonCount: comparisonRows.length, note: 'Similarity checks are heuristic review prompts, not proof of copying or AI use. AI detectors are not integrated into this site; automated AI-writing scores are unreliable and must not decide an application. Review the answers and context yourself.' } });
  } catch (e) {
    res.status(500).json({ error: 'Could not load application.' });
  }
});

router.post('/:id/decision', async (req, res) => {
  try {
    const status = String(req.body && req.body.status || '');
    if (!['ACCEPTED', 'REJECTED'].includes(status)) return res.status(400).json({ error: 'Choose accepted or rejected.' });
    const note = String(req.body && req.body.note || '').trim().slice(0, 2000);
    const current = await prisma.metApplication.findUnique({ where: { id: String(req.params.id) } });
    if (!current) return res.status(404).json({ error: 'Application not found.' });
    if (current.status !== 'SUBMITTED') return res.status(409).json({ error: 'This application has already been decided.' });
    const row = await prisma.metApplication.update({
      where: { id: current.id },
      data: { status, markerNote: note || null, markedAt: new Date(), markedById: req.user.id, markedByName: req.user.displayName || req.user.discordUsername || 'Hendon Police College' },
      select: { id: true, appRef: true, status: true, markedAt: true, discordId: true, discordUsername: true },
    });
    await require('../lib/audit').record({ req, action: 'MET_APPLICATION_DECIDED', category: 'RECRUITMENT', targetType: 'met_application', targetId: row.id, summary: 'MET application ' + row.appRef + ' marked ' + status + '.', metadata: { appRef: row.appRef, status, note } }).catch(() => {});
    let dmSent = false;
    try {
      dmSent = await require('../lib/bot').dmMemberNotice(row.discordId, {
        color: status === 'ACCEPTED' ? 0x64748b : 0x475569,
        title: status === 'ACCEPTED' ? 'MET Application Approved' : 'MET Application Update',
        description: status === 'ACCEPTED'
          ? 'Your MET Application **' + row.appRef + '** has been approved.' + (note ? '\n\n**Reviewer note:**  + note : '')
          : 'Your MET Application **' + row.appRef + '** has been declined.' + (note ? '\n\n**Reason:**  + note : ''),
        footer: 'Metropolitan Police Service · Recruitment',
      });
    } catch (e) { console.warn('[MET application] decision DM unavailable:', e.message); }
    res.json({ ok: true, dmSent, application: { id: row.id, appRef: row.appRef, status: row.status, markedAt: row.markedAt } });
  } catch (e) {
    console.error('[MET application review] decision error:', e.message);
    res.status(500).json({ error: 'Could not save the decision.' });
  }
});

module.exports = router;
