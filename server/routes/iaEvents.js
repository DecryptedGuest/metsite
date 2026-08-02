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
//
// The whole area is supervisor and above. Filing an event moves real quota
// points and real XP for up to sixty people with nobody signing it off, so it
// is not something an investigator gets to do; requireHICOMM is this codebase's
// "supervisor or higher" (SUPERVISOR, HICOMM, DEVELOPER).

const express = require('express');
const router  = express.Router();
const prisma  = require('../lib/db');
const events  = require('../lib/iaEvents');
const { requireHICOMM, requireHICOMMStrict } = require('../middleware/auth');

router.use(requireHICOMM);

// ── GET /api/ia-events/meta ───────────────────────────────────────
router.get('/meta', (req, res) => {
  res.json({
    eventTypes:   events.EVENT_TYPES,
    pointsEach:   events.POINTS_EACH(),
    xpEach:       events.XP_EACH(),
    maxAttendees: events.MAX_ATTENDEES,
    maxProof:     events.MAX_PROOF,
    maxProofMb:   Math.round(events.MAX_PROOF_BYTES / (1024 * 1024)),
  });
});

// ── GET /api/ia-events/people?q= ──────────────────────────────────
// Who could be on a roll, for the attendee picker.
//
// The roll used to be typed by hand, which meant a misspelling paid nobody and
// a pasted nickname paid somebody only as reliably as it was spelled. Picking a
// person from a list attaches their Discord id, which is what both the quota
// award and the XP award are keyed on.
//
// Everyone who has signed in, not just IA — a Mass Patrol is attended by
// whoever turned up.
router.get('/people', async (req, res) => {
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
      xpAwarded: out.xpAwarded,
      xpSkipped: out.xpSkipped,
      xpEach: out.xpEach,
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
