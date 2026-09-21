// server/routes/iaPatrols.js
// Internal Affairs patrol logs, filed on the site.
//
//   GET    /api/ia-patrols               list (scope=mine, status=PENDING…)
//   GET    /api/ia-patrols/meta          what a patrol is worth, and what you may do
//   GET    /api/ia-patrols/pending-count for the nav badge
//   POST   /api/ia-patrols               file one — this pays NOBODY
//   POST   /api/ia-patrols/:id/review    approve or deny — approving pays
//   POST   /api/ia-patrols/:id/void      withdraw an approved one and reverse it
//
// The access levels are the event log's, deliberately, because they are the same
// decision:
//
//   read     any Internal Affairs member.
//   file     any Internal Affairs member. A patrol is not a privilege — every
//            officer goes out, and every officer's shift counts towards quota.
//            (Events are Senior Investigator and above because hosting one is.)
//   review   supervisor and above, and never your own.
//   withdraw high command, because unwinding a payment is a decision.
//
// The people search the partner picker uses is the event route's — one search,
// one behaviour, rather than two that drift apart.

const express = require('express');
const router  = express.Router();
const patrols = require('../lib/iaPatrols');
const { requireHICOMM, requireHICOMMStrict } = require('../middleware/auth');

const canReview = (u) => !!u && ['SUPERVISOR', 'HICOMM', 'DEVELOPER'].includes(u.role);

// ── GET /api/ia-patrols/meta ──────────────────────────────────────
router.get('/meta', (req, res) => {
  res.json({
    pointsEach:    patrols.POINTS_EACH(),
    minMinutes:    patrols.MIN_MINUTES(),
    maxMinutes:    patrols.MAX_MINUTES,
    maxPartners:   patrols.MAX_PARTNERS,
    maxProof:      patrols.MAX_PROOF,
    maxProofMb:    Math.round(patrols.MAX_PROOF_BYTES / (1024 * 1024)),
    // The XP rule, as a block size rather than a flat number, so the form can
    // show what a given shift will actually be worth instead of guessing.
    xpPerMinutes:  require('../lib/logXpAward').PATROL_XP_MINUTES(),
    canFile:       !!req.user,
    canReview:     canReview(req.user),
    canVoid:       ['HICOMM', 'DEVELOPER'].includes(req.user.role),
  });
});

// ── GET /api/ia-patrols/pending-count ─────────────────────────────
router.get('/pending-count', requireHICOMM, async (req, res) => {
  try { res.json({ pending: await patrols.pendingCount() }); }
  catch (err) { res.status(500).json({ error: 'Failed to count the queue.' }); }
});

// ── GET /api/ia-patrols ───────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const mine = req.query.scope === 'mine';
    const status = req.query.status ? String(req.query.status).toUpperCase() : null;
    // The queue itself is a reviewer's view.
    if (status === 'PENDING' && !canReview(req.user)) {
      return res.status(403).json({ error: 'Supervisor access required' });
    }
    res.json(await patrols.listPatrols({
      mine, officerId: req.user.id, status, take: req.query.take,
    }));
  } catch (err) {
    console.error('[IA patrols] list error:', err.message);
    res.status(500).json({ error: 'Failed to load the patrol log.' });
  }
});

// ── POST /api/ia-patrols ──────────────────────────────────────────
// Files it. Pays nobody — a supervisor signs it off.
router.post('/', async (req, res) => {
  try {
    const out = await patrols.submitPatrol(req.body || {}, req.user);
    if (!out.ok) return res.status(400).json({ error: out.problems.join(' '), problems: out.problems });
    res.status(201).json({
      patrol: out.patrol,
      dropped: out.dropped,
      selfRemoved: out.selfRemoved,
      crossedMidnight: out.crossedMidnight,
      pointsEach: out.pointsEach,
      xpEach: out.xpEach,
    });
  } catch (err) {
    console.error('[IA patrols] submit error:', err.message);
    res.status(500).json({ error: 'Failed to file the patrol.' });
  }
});

// ── POST /api/ia-patrols/:id/review ───────────────────────────────
router.post('/:id/review', requireHICOMM, async (req, res) => {
  try {
    const body = req.body || {};
    const out = await patrols.reviewPatrol(req.params.id, body.action, req.user, body.note);
    if (!out.ok) return res.status(409).json({ error: out.why });
    res.json(out);
  } catch (err) {
    console.error('[IA patrols] review error:', err.message);
    res.status(500).json({ error: 'Failed to record the decision.' });
  }
});

// ── POST /api/ia-patrols/:id/void ─────────────────────────────────
router.post('/:id/void', requireHICOMMStrict, async (req, res) => {
  try {
    const out = await patrols.voidPatrol(req.params.id, req.user, (req.body || {}).reason);
    if (!out.ok) return res.status(409).json({ error: out.why });
    res.json(out);
  } catch (err) {
    console.error('[IA patrols] void error:', err.message);
    res.status(500).json({ error: 'Failed to withdraw the patrol.' });
  }
});

module.exports = router;
