// server/routes/iaEvents.js
// Internal Affairs event logs, filed on the site.
//
//   GET    /api/ia-events              list (scope=mine, status=PENDING…)
//   GET    /api/ia-events/meta         event types, what a place is worth, access
//   GET    /api/ia-events/people       the attendee picker's search
//   POST   /api/ia-events              file one — this pays NOBODY
//   POST   /api/ia-events/:id/review   approve or deny — approving pays
//   POST   /api/ia-events/:id/void     withdraw an approved one and reverse it
//
// Three levels, deliberately:
//
//   read     any Internal Affairs member. Events sit alongside cases and
//            tickets, and there is nothing sensitive about who attended one.
//   file     Senior Investigator and above.
//   review   supervisor and above, and never your own. Approving pays every
//            name on the log, so it is not the filer's decision to make.

const express = require('express');
const router  = express.Router();
const prisma  = require('../lib/db');
const events  = require('../lib/iaEvents');
const { requireHICOMM, requireHICOMMStrict } = require('../middleware/auth');
const { isSeniorInvestigatorPlus } = require('../lib/iaRank');

// Senior Investigator and above. The site role collapses every investigator
// tier into "IA", so this reads the snapshotted IA group rank — the same test
// case appeals use.
function requireSeniorInvestigator(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (isSeniorInvestigatorPlus(req.user)) return next();
  return res.status(403).json({ error: 'Event logs can only be filed by Senior Investigator and above.' });
}

const canReview = (u) => !!u && ['SUPERVISOR', 'HICOMM', 'DEVELOPER'].includes(u.role);

// ── GET /api/ia-events/meta ───────────────────────────────────────
router.get('/meta', (req, res) => {
  res.json({
    eventTypes:   events.EVENT_TYPES,
    pointsEach:   events.POINTS_EACH(),
    xpEach:       events.XP_EACH(),
    maxAttendees: events.MAX_ATTENDEES,
    maxProof:     events.MAX_PROOF,
    maxProofMb:   Math.round(events.MAX_PROOF_BYTES / (1024 * 1024)),
    // What this viewer may do, so the page does not have to infer it from a
    // role name it only half understands.
    canFile:      isSeniorInvestigatorPlus(req.user),
    canReview:    canReview(req.user),
    canVoid:      ['HICOMM', 'DEVELOPER'].includes(req.user.role),
  });
});

// ── GET /api/ia-events/pending-count ──────────────────────────────
router.get('/pending-count', requireHICOMM, async (req, res) => {
  try { res.json({ pending: await events.pendingCount() }); }
  catch (err) { res.status(500).json({ error: 'Failed to count the queue.' }); }
});

// ── GET /api/ia-events/people?q= ──────────────────────────────────
// Who could be on a log, for the attendee picker.
//
// The list used to be typed by hand, which meant a misspelling paid nobody and
// a pasted nickname paid somebody only as reliably as it was spelled. Picking a
// person attaches their Discord id, which is what both the quota award and the
// XP award are keyed on.
//
// Everyone who has signed in, not just IA — a Mass Patrol is attended by
// whoever turned up.
router.get('/people', requireSeniorInvestigator, async (req, res) => {
  const q = (req.query.q || '').toString().trim().replace(/^[@<]+|[>]+$/g, '');
  if (q.length < 2) return res.json([]);
  try {
    const rows = await prisma.user.findMany({
      where: {
        isBlacklisted: false,
        OR: [
          { displayName:     { contains: q, mode: 'insensitive' } },
          { discordUsername: { contains: q, mode: 'insensitive' } },
          { robloxUsername:  { contains: q, mode: 'insensitive' } },
          { discordId:       { contains: q } },
          { robloxId:        { contains: q } },
        ],
      },
      select: {
        discordId: true, discordUsername: true, displayName: true,
        discordAvatar: true, robloxUsername: true, role: true, lastLogin: true,
      },
      orderBy: [{ lastLogin: 'desc' }],
      take: 12,
    });
    // An exact Discord id typed in full is the person, whether or not they have
    // ever signed in here — otherwise pasting an id would find nothing and the
    // picker would look broken for the one input that is unambiguous.
    if (/^\d{15,21}$/.test(q) && !rows.some(r => r.discordId === q)) {
      rows.unshift({ discordId: q, discordUsername: null, displayName: null,
                     discordAvatar: null, robloxUsername: null, role: null, lastLogin: null });
    }
    res.json(rows.map(u => ({
      discordId: u.discordId,
      name: u.robloxUsername || u.displayName || u.discordUsername || u.discordId,
      displayName: u.displayName || null,
      discordUsername: u.discordUsername || null,
      robloxUsername: u.robloxUsername || null,
      avatar: u.discordAvatar
        ? `https://cdn.discordapp.com/avatars/${u.discordId}/${u.discordAvatar}.png?size=64`
        : null,
      role: u.role || null,
    })));
  } catch (err) {
    console.error('[IA events] people search failed:', err.message);
    res.status(500).json({ error: 'Search failed.' });
  }
});

// ── GET /api/ia-events ────────────────────────────────────────────
// Any IA member: this is the list that sits alongside cases and tickets.
router.get('/', async (req, res) => {
  try {
    const mine = req.query.scope === 'mine';
    const status = req.query.status ? String(req.query.status).toUpperCase() : null;
    // The queue itself is a reviewer's view.
    if (status === 'PENDING' && !canReview(req.user)) {
      return res.status(403).json({ error: 'Supervisor access required' });
    }
    const rows = await events.listEvents({ mine, hostId: req.user.id, status, take: req.query.take });
    res.json(rows);
  } catch (err) {
    console.error('[IA events] list error:', err.message);
    res.status(500).json({ error: 'Failed to load the event log.' });
  }
});

// ── POST /api/ia-events ───────────────────────────────────────────
// Files it. Pays nobody — a supervisor signs it off.
router.post('/', requireSeniorInvestigator, async (req, res) => {
  try {
    const out = await events.submitEvent(req.body || {}, req.user);
    if (!out.ok) return res.status(400).json({ error: out.problems.join(' '), problems: out.problems });
    res.status(201).json({
      event: out.event,
      dropped: out.dropped,
      selfRemoved: out.selfRemoved,
      pointsEach: out.pointsEach,
      xpEach: out.xpEach,
    });
  } catch (err) {
    console.error('[IA events] submit error:', err.message);
    res.status(500).json({ error: 'Failed to file the event.' });
  }
});

// ── POST /api/ia-events/:id/review ────────────────────────────────
// Supervisor and above. Approving pays every name on the log, the host
// included; denying pays nobody and costs nothing.
router.post('/:id/review', requireHICOMM, async (req, res) => {
  try {
    const body = req.body || {};
    const out = await events.reviewEvent(req.params.id, body.action, req.user, body.note);
    if (!out.ok) return res.status(409).json({ error: out.why });
    res.json(out);
  } catch (err) {
    console.error('[IA events] review error:', err.message);
    res.status(500).json({ error: 'Failed to record the decision.' });
  }
});

// ── POST /api/ia-events/:id/void ──────────────────────────────────
// High Command's. Anybody who can approve can make a mistake, but unwinding
// twenty people's points is a decision, not a correction.
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
