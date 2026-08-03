// server/routes/iaApplicationReview.js
// Reading and marking Internal Affairs applications. DEPUTY DIRECTOR AND ABOVE.
//
//   GET  /api/ia-application-review/queue      what is waiting, oldest first
//   GET  /api/ia-application-review/stats      the counts, for the nav badge
//   GET  /api/ia-application-review/:id        one application, in full
//   POST /api/ia-application-review/:id/ai-scan   run the detectors on the prose
//   POST /api/ia-application-review/:id/decide    accept or reject
//
// ── The gate, and why it is this one ──────────────────────────────
//
// requireHICOMMStrict, applied to the WHOLE ROUTER on the line below rather than
// per route. Per-route gating is one forgotten middleware away from an open
// endpoint, and what leaks is every applicant's written work.
//
// It has to be the STRICT gate. requireHICOMM also admits SUPERVISOR, and the role
// resolver maps SUPERVISOR to both Supervisor AND Assistant Director — its regex
// is tested before the generic director rule. So the loose gate would quietly let
// Assistant Directors mark applications, which is not what "Deputy Director and
// above" means. The numeric fallback in the resolver puts rank >= 35 at HICOMM,
// and rank 35 is Deputy Director: HICOMM *is* Deputy-Director-and-above.
//
// Note that MET High Command also resolves to HICOMM site-wide, so MET HICOMM can
// mark these too. That is deliberate — they sit above Internal Affairs — and it is
// written down here so it is a decision rather than a surprise.

const express = require('express');
const router  = express.Router();
const prisma  = require('../lib/db');
const app     = require('../lib/iaApplication');
const integrity = require('../lib/iaApplicationIntegrity');
const audit   = require('../lib/audit');
const { requireHICOMMStrict } = require('../middleware/auth');

// The gate for everything below, in one place.
router.use(requireHICOMMStrict);

// A row as it appears in the QUEUE. No answers: the list is for choosing what to
// read, and shipping every applicant's prose to render a table is both slow and
// more exposure than the page needs.
function summarise(row) {
  // `flags` is only STORED when a decision is taken — frozen as they were in front
  // of the person who took it. So a row still waiting has none, and reading the
  // column alone reported zero evidence on exactly the applications a marker is
  // triaging, which is the only time the count is any use. Compute it for those.
  const flags = Array.isArray(row.flags) && row.flags.length
    ? row.flags
    : integrity.inspect(row.telemetry, row.answers, app.flatQuestions()).flags;
  return {
    id: row.id, appRef: row.appRef, status: row.status,
    discordUsername: row.discordUsername, robloxUsername: row.robloxUsername,
    submittedAt: row.submittedAt, markedAt: row.markedAt,
    markedByName: row.markedByName,
    score: row.score, maxScore: row.maxScore, percentage: row.percentage,
    // The two counts a marker triages on, without the findings themselves.
    evidenceCount: flags.filter(f => f && f.severity === 'evidence').length,
    suggestiveCount: flags.filter(f => f && f.severity === 'suggestive').length,
    // "The divisionless get first pick" is a real rule, so the queue has to show
    // who is divisionless or it cannot be applied.
    divisionless: row.context && typeof row.context === 'object' ? row.context.divisionless : null,
    divisions: row.context && typeof row.context === 'object' ? row.context.divisions : null,
  };
}

// ── GET /gate ─────────────────────────────────────────────────────
// Whether applications are being taken, and what an applicant is told while
// they are not. Behind the same Deputy-Director gate as everything else here.
router.get('/gate', async (req, res) => {
  try { res.json(await app.gateState()); }
  catch (err) {
    console.error('[IA app review] gate read failed:', err.message);
    res.status(500).json({ error: 'Could not read whether applications are open.' });
  }
});

// ── POST /gate ────────────────────────────────────────────────────
// Open or close them. Closing does NOT touch anybody's work: drafts are kept and
// applications already submitted still need marking. It stops new ones arriving,
// which is the whole point of closing during an intake.
router.post('/gate', async (req, res) => {
  try {
    const body = req.body || {};
    if (typeof body.open !== 'boolean') {
      return res.status(400).json({ error: 'Say whether applications should be open, as { "open": true }.' });
    }
    const before = await app.gateState();
    const state = await app.setGate(body.open, body.note);
    // Recorded under SECURITY so it persists: "why could nobody apply for a
    // fortnight" is a question somebody eventually asks.
    if (before.open !== state.open) {
      audit.log(req.user, {
        category: 'SECURITY',
        action: state.open ? 'IA_APPLICATIONS_OPENED' : 'IA_APPLICATIONS_CLOSED',
        summary: state.open
          ? 'Reopened Internal Affairs applications'
          : 'Closed Internal Affairs applications'
            + (state.note ? ` — applicants are told: ${state.note}` : ''),
      });
    }
    res.json(state);
  } catch (err) {
    console.error('[IA app review] gate write failed:', err.message);
    res.status(500).json({ error: 'Could not change whether applications are open.' });
  }
});

// ── GET /queue ────────────────────────────────────────────────────
router.get('/queue', async (req, res) => {
  try {
    const status = String(req.query.status || 'SUBMITTED').toUpperCase();
    const allowed = ['SUBMITTED', 'ACCEPTED', 'REJECTED'];
    const where = allowed.includes(status) ? { status } : { status: { in: allowed } };
    const rows = await prisma.iaApplication.findMany({
      where,
      // The queue is OLDEST first: a marker works through what has been waiting
      // longest, not what arrived most recently. Decided applications read
      // newest-first, because that is a record rather than a queue.
      orderBy: status === 'SUBMITTED' ? { submittedAt: 'asc' } : { markedAt: 'desc' },
      take: 300,
    });
    res.json(rows.map(summarise));
  } catch (err) {
    console.error('[IA app review] queue error:', err.message);
    res.status(500).json({ error: 'Could not load the queue.' });
  }
});

// ── GET /stats ────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const [waiting, accepted, rejected, drafts] = await Promise.all([
      prisma.iaApplication.count({ where: { status: 'SUBMITTED' } }),
      prisma.iaApplication.count({ where: { status: 'ACCEPTED' } }),
      prisma.iaApplication.count({ where: { status: 'REJECTED' } }),
      prisma.iaApplication.count({ where: { status: 'DRAFT' } }),
    ]);
    res.json({
      waiting, accepted, rejected, drafts,
      passMark: app.passMark(), totalPoints: app.totalPoints(), passPercent: app.PASS_PERCENT(),
      answerKey: app.answerKeyStatus(),
      pages: app.isComplete(),
      // Which detectors are actually configured, so the page can say "no providers
      // configured" rather than offering a button that silently does nothing.
      aiProviders: (() => {
        try { return require('../lib/aiDetect').configuredProviderNames(); } catch (e) { return []; }
      })(),
    });
  } catch (err) {
    console.error('[IA app review] stats error:', err.message);
    res.status(500).json({ error: 'Could not count the queue.' });
  }
});

// ── GET /:id ──────────────────────────────────────────────────────
// Everything: the paper WITH its guidance and key, the answers, what the site knew
// about the applicant, and the integrity findings.
router.get('/:id', async (req, res) => {
  try {
    const row = await prisma.iaApplication.findUnique({ where: { id: req.params.id } });
    if (!row) return res.status(404).json({ error: 'No such application.' });

    const questions = app.flatQuestions();
    // Computed on READ rather than stored at submit, so improving the inspector
    // improves every application already in the queue instead of only new ones.
    const found = integrity.inspect(row.telemetry, row.answers, questions);

    res.json({
      application: {
        id: row.id, appRef: row.appRef, status: row.status,
        discordId: row.discordId, discordUsername: row.discordUsername,
        robloxId: row.robloxId, robloxUsername: row.robloxUsername,
        answers: row.answers || {}, captured: row.captured || null, context: row.context || null,
        submittedAt: row.submittedAt, createdAt: row.createdAt,
        scores: row.scores || {}, score: row.score, maxScore: row.maxScore, percentage: row.percentage,
        markerNote: row.markerNote, markedByName: row.markedByName, markedAt: row.markedAt,
      },
      paper: app.markerPaper(),
      integrity: found,
      // Only present once somebody has pressed the button. Absent means "not run",
      // which is different from "run and found nothing".
      aiScan: row.telemetry && row.telemetry.aiScan ? row.telemetry.aiScan : null,
    });
  } catch (err) {
    console.error('[IA app review] detail error:', err.message);
    res.status(500).json({ error: 'Could not load the application.' });
  }
});

// ── GET /:id/profile ──────────────────────────────────────────────
// Everything about the applicant, assembled live.
//
// Its OWN endpoint rather than part of /:id on purpose: this makes external calls
// to Roblox, and the paper should be on screen and readable while that happens
// rather than after it. A slow group lookup must never be the reason somebody
// cannot start marking.
router.get('/:id/profile', async (req, res) => {
  try {
    const row = await prisma.iaApplication.findUnique({ where: { id: req.params.id } });
    if (!row) return res.status(404).json({ error: 'No such application.' });
    const profile = await require('../lib/iaApplicantProfile').build(row);
    res.json(profile);
  } catch (err) {
    console.error('[IA app review] profile error:', err.message);
    res.status(500).json({ error: 'Could not build their profile: ' + err.message });
  }
});

// ── POST /:id/ai-scan ─────────────────────────────────────────────
// Marker-triggered, never automatic. These are third-party detectors with real
// false-positive rates; running them on every submission and storing a number
// would turn a guess into a permanent part of somebody's record.
router.post('/:id/ai-scan', async (req, res) => {
  try {
    const row = await prisma.iaApplication.findUnique({ where: { id: req.params.id } });
    if (!row) return res.status(404).json({ error: 'No such application.' });

    const aiDetect = require('../lib/aiDetect');
    const providers = aiDetect.configuredProviderNames();

    // Only the prose. Running a detector over "PC" or a copied declaration tells
    // nobody anything and spends a request doing it.
    const items = app.flatQuestions()
      .filter(q => q.type === 'paragraph' && q.points > 0)
      .map(q => ({ id: q.id, prompt: q.prompt, text: String((row.answers || {})[q.id] || '') }))
      .filter(x => x.text.trim().length >= 120);

    if (!items.length) {
      return res.json({ ok: false, why: 'There is not enough written prose here to scan.' });
    }

    const scan = await aiDetect.scanAnswers(items);
    const stored = {
      at: new Date().toISOString(),
      scannedById: req.user.id,
      scannedByName: req.user.displayName || req.user.discordUsername,
      providers,
      ...scan,
    };
    // Kept on telemetry rather than in its own column: it is another thing
    // observed about how the application was produced, and it means no migration.
    await prisma.iaApplication.update({
      where: { id: row.id },
      data: { telemetry: { ...(row.telemetry || {}), aiScan: stored } },
    });

    audit.record({
      req, action: 'IA_APP_AI_SCAN', category: 'ia',
      targetType: 'iaApplication', targetId: row.id,
      summary: `Ran an AI scan on ${row.appRef}`,
    });

    res.json({ ok: true, aiScan: stored });
  } catch (err) {
    console.error('[IA app review] ai-scan error:', err.message);
    res.status(500).json({ error: 'The scan could not be run: ' + err.message });
  }
});

// ── POST /:id/decide ──────────────────────────────────────────────
// Body: { scores: { qid: points }, note, decision: 'accept' | 'reject' }
//
// ACCEPT/REJECT rather than PASS/FAIL, because this is a selection. Somebody can
// write a strong application and still not be taken — there are only so many
// places — so the decision is a person's, and the score is evidence for it rather
// than a threshold that decides it.
router.post('/:id/decide', async (req, res) => {
  const body = req.body || {};
  const decision = String(body.decision || '').toLowerCase();
  if (!['accept', 'reject'].includes(decision)) {
    return res.status(400).json({ error: "decision must be 'accept' or 'reject'." });
  }

  try {
    const row = await prisma.iaApplication.findUnique({ where: { id: req.params.id } });
    if (!row) return res.status(404).json({ error: 'No such application.' });
    if (row.status === 'DRAFT') {
      return res.status(409).json({ error: 'That one has not been submitted yet.' });
    }
    if (row.status !== 'SUBMITTED') {
      return res.status(409).json({ error: `That application has already been ${row.status.toLowerCase()}.` });
    }
    // Nobody marks their own.
    if (String(row.applicantId) === String(req.user.id)) {
      return res.status(403).json({ error: 'You cannot mark your own application.' });
    }

    // Clamp every score to what the question is worth. A marker typing 20 into a
    // 2-point box is a slip, and silently accepting it would put a percentage over
    // 100 into somebody's record.
    const scores = {};
    let total = 0;
    for (const q of app.flatQuestions()) {
      if (!q.points) continue;
      const raw = Number((body.scores || {})[q.id]);
      const n = Number.isFinite(raw) ? Math.max(0, Math.min(q.points, Math.round(raw))) : 0;
      scores[q.id] = n;
      total += n;
    }
    const maxScore = app.totalPoints();
    const percentage = maxScore ? Math.round((total / maxScore) * 100) : 0;

    const found = integrity.inspect(row.telemetry, row.answers, app.flatQuestions());

    // Claim it first. Two Deputy Directors pressing at once must not both decide
    // it; the second is told it was already done.
    const claim = await prisma.iaApplication.updateMany({
      where: { id: row.id, status: 'SUBMITTED' },
      data: {
        status: decision === 'accept' ? 'ACCEPTED' : 'REJECTED',
        scores, score: total, maxScore, percentage,
        markerNote: body.note ? String(body.note).slice(0, 2000) : null,
        markedById: req.user.id,
        markedByName: req.user.displayName || req.user.discordUsername || null,
        markedAt: new Date(),
        // The findings AS THEY WERE when the decision was made. The inspector can
        // improve later, and a decision has to stay readable against what was in
        // front of the person who took it.
        flags: found.flags,
      },
    });
    if (!claim.count) return res.status(409).json({ error: 'Somebody decided that one first.' });

    audit.record({
      req, action: decision === 'accept' ? 'IA_APP_ACCEPT' : 'IA_APP_REJECT', category: 'ia',
      targetType: 'iaApplication', targetId: row.id,
      summary: `${decision === 'accept' ? 'Accepted' : 'Rejected'} Internal Affairs application ${row.appRef}`
             + ` (${total}/${maxScore}, ${percentage}%)`,
    });

    console.log(`[IA app review] ${row.appRef} ${decision}ed by `
      + `${req.user.displayName || req.user.discordUsername} — ${total}/${maxScore} (${percentage}%)`);

    const updated = await prisma.iaApplication.findUnique({ where: { id: row.id } });
    res.json({ ok: true, application: summarise(updated), score: total, maxScore, percentage });
  } catch (err) {
    console.error('[IA app review] decide error:', err.message);
    res.status(500).json({ error: 'Could not record that decision.' });
  }
});

module.exports = router;
