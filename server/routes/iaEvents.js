// server/routes/iaEvents.js
// Internal Affairs event logs, filed on the site.
//
//   GET    /api/ia-events            list (scope=mine for your own)
//   GET    /api/ia-events/meta       event types + what an attendee is worth
//   POST   /api/ia-events            file one — this AWARDS the roll
//   POST   /api/ia-events/:id/void   withdraw one and reverse its awards
//
// Filing is the award, so there is no review route. Withdrawing is High
// Command's — anybody who can file can make a mistake, but unwinding twenty
// people's points is a decision, not a correction.

const express = require('express');
const router  = express.Router();
const prisma  = require('../lib/db');
const events  = require('../lib/iaEvents');
const { requireHICOMMStrict } = require('../middleware/auth');

// ── GET /api/ia-events/meta ───────────────────────────────────────
router.get('/meta', (req, res) => {
  res.json({
    eventTypes:   events.EVENT_TYPES,
    pointsEach:   events.POINTS_EACH(),
    maxAttendees: events.MAX_ATTENDEES,
  });
});

// ── GET /api/ia-events ────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const mine = req.query.scope === 'mine';
    const rows = await events.listEvents({ mine, hostId: req.user.id, take: req.query.take });
    res.json(rows);
  } catch (err) {
    console.error('[IA events] list error:', err.message);
    res.status(500).json({ error: 'Failed to load the event log.' });
  }
});

// ── POST /api/ia-events ───────────────────────────────────────────
// Filing an event pays every attendee immediately.
router.post('/', async (req, res) => {
  try {
    const out = await events.submitEvent(req.body || {}, req.user);
    if (!out.ok) return res.status(400).json({ error: out.problems.join(' '), problems: out.problems });
    res.status(201).json({
      event: out.event,
      awarded: out.awarded,
      dropped: out.dropped,
      selfRemoved: out.selfRemoved,
      pointsEach: out.event.pointsEach,
    });
  } catch (err) {
    console.error('[IA events] submit error:', err.message);
    res.status(500).json({ error: 'Failed to file the event.' });
  }
});

// ── POST /api/ia-events/:id/void ──────────────────────────────────
router.post('/:id/void', requireHICOMMStrict, async (req, res) => {
  try {
    const out = await events.voidEvent(req.params.id, req.user, (req.body || {}).reason);
    if (!out.ok) return res.status(409).json({ error: out.why });
    res.json(out);
  } catch (err) {
    console.error('[IA events] void error:', err.message);
    res.status(500).json({ error: 'Failed to withdraw the event.' });
  }
});

module.exports = router;
