// server/routes/iaApplication.js
// The applicant's half of the Internal Affairs application.
//
//   GET  /api/ia-application/meta      may I apply, and where am I up to
//   GET  /api/ia-application/paper      the six sections (no answer key)
//   GET  /api/ia-application/captured   what the site already knows about me
//   GET  /api/ia-application/mine       my draft or my submission
//   PUT  /api/ia-application/draft      save progress
//   POST /api/ia-application/submit     send it
//   POST /api/ia-application/discard    throw the draft away
//
// requireAuth only. Anybody signed in may apply — that is the point of an
// application. The MARKING half is a separate router behind requireHICOMMStrict,
// so no route in this file can ever return somebody else's answers.

const express = require('express');
const router  = express.Router();
const prisma  = require('../lib/db');
const app     = require('../lib/iaApplication');
const audit   = require('../lib/audit');

// ── What the site already knows ───────────────────────────────────
//
// Every field here is something an applicant would otherwise be asked to type,
// and typing it is worse in every case: a typed Discord username can name
// somebody else, a typed timezone comes out as "GMT+1 i think", and a typed
// Roblox name can be one letter off from an account that does exist.
async function captureFor(req) {
  const u = req.user;
  const out = {
    discord: {
      id: u.discordId || null,
      username: u.discordUsername || null,
      displayName: u.displayName || null,
      avatar: u.discordAvatar || null,
    },
    roblox: { id: u.robloxId || null, username: u.robloxUsername || null, avatar: null, source: 'account' },
    device: null,
  };

  // The linked Roblox account, or a resolution from the Discord id when the
  // account has none — RoVer, then the dashboard record, then the MET nickname.
  if (!out.roblox.username) {
    try {
      const { resolveRoblox } = require('../lib/robloxLink');
      const r = await resolveRoblox(u.discordId);
      if (r && r.username) {
        out.roblox = { id: r.id || null, username: r.username, avatar: null, source: 'resolved' };
      }
    } catch (e) { /* an unlinked applicant types it instead; not fatal */ }
  }

  // The avatar is what makes the identity card checkable. "Is this you?" is a
  // question a picture answers and a username does not.
  if (out.roblox.id) {
    try {
      const { getRobloxAvatarHeadshot } = require('../lib/roblox');
      out.roblox.avatar = await getRobloxAvatarHeadshot(out.roblox.id);
    } catch (e) { /* cosmetic */ }
  }

  try {
    const describeDevice = require('./auth').describeDevice;
    if (typeof describeDevice === 'function') {
      out.device = describeDevice(req.headers['user-agent'] || '');
    }
  } catch (e) { /* cosmetic */ }

  return out;
}

// ── Context for the marker, asked of nobody ───────────────────────
//
// Snapshotted at submit, not joined at read time, because it is evidence about
// the moment they applied. A marker should never have to go and look up whether
// we have punished this person before, or whether they are in a division — and
// "the divisionless get first pick" is a rule the marker can only apply if the
// answer is in front of them.
async function contextFor(user) {
  const ctx = {
    siteAccountCreated: user.createdAt || null,
    lastLogin: user.lastLogin || null,
    siteRole: user.role || null,
    iaRankName: user.iaRankName || null,
    metRank: (user.metRankOverride && user.metRankOverride.name)
          || (user.metRankNatural && user.metRankNatural.name) || null,
    isBlacklisted: !!user.isBlacklisted,
  };

  // Divisions, and therefore whether they are "divisionless" — which decides
  // where they sit in the queue.
  try {
    const divs = Array.isArray(user.divisions) ? user.divisions : [];
    ctx.divisions = divs.map(d => d && d.division).filter(Boolean);
    ctx.divisionless = ctx.divisions.length === 0;
  } catch (e) { ctx.divisions = null; ctx.divisionless = null; }

  // Their record. The application says "no strikes or punishments in the past
  // week", and this is the only way a marker can check it without going digging.
  try {
    const weekAgo = new Date(Date.now() - 7 * 86400000);
    const [cases, recent] = await Promise.all([
      prisma.case.count({ where: { officerDiscordId: String(user.discordId) } }).catch(() => null),
      prisma.case.count({
        where: { officerDiscordId: String(user.discordId), createdAt: { gte: weekAgo } },
      }).catch(() => null),
    ]);
    ctx.casesAgainstThem = cases;
    ctx.casesInLastWeek = recent;
  } catch (e) { /* the application is still worth taking */ }

  return ctx;
}

// ── Eligibility ───────────────────────────────────────────────────
async function eligibility(user) {
  if (user.isBlacklisted) {
    return { canApply: false, why: 'Your account is blacklisted, so an application cannot be considered.' };
  }
  // Somebody already in Internal Affairs is not an applicant.
  const divs = Array.isArray(user.divisions) ? user.divisions : [];
  if (divs.some(d => d && d.division === 'IA') || ['IA', 'SUPERVISOR', 'HICOMM'].includes(user.role)) {
    return { canApply: false, why: 'You are already in Internal Affairs.' };
  }
  // One live application at a time. A second one while the first is being read
  // is not more chances, it is two markers doing the same work.
  const open = await prisma.iaApplication.findFirst({
    where: { applicantId: user.id, status: 'SUBMITTED' },
    select: { appRef: true, submittedAt: true },
  }).catch(() => null);
  if (open) {
    return { canApply: false, pending: open,
             why: `Your application ${open.appRef} is with Internal Affairs. You will hear back on it before you can send another.` };
  }
  return { canApply: true };
}

// ── The reference ─────────────────────────────────────────────────
// From the highest in use rather than a row count, because counting breaks
// permanently the first time a row is deleted — every retry then recomputes the
// same taken number. `attempt` walks forward so a genuine race resolves next try.
async function nextAppRef(attempt = 0) {
  const latest = await prisma.iaApplication.findFirst({
    where:   { appRef: { startsWith: 'IA-' } },
    orderBy: { appRef: 'desc' },
    select:  { appRef: true },
  });
  const highest = latest ? parseInt(String(latest.appRef).replace(/\D/g, ''), 10) : 0;
  return `IA-${String((Number.isFinite(highest) ? highest : 0) + 1 + attempt).padStart(4, '0')}`;
}

// ── GET /meta ─────────────────────────────────────────────────────
router.get('/meta', async (req, res) => {
  try {
    const elig = await eligibility(req.user);
    const draft = await prisma.iaApplication.findFirst({
      where: { applicantId: req.user.id, status: 'DRAFT' },
      select: { id: true, appRef: true, updatedAt: true, answers: true },
    }).catch(() => null);
    const history = await prisma.iaApplication.findMany({
      where: { applicantId: req.user.id, status: { in: ['SUBMITTED', 'ACCEPTED', 'REJECTED'] } },
      orderBy: { submittedAt: 'desc' }, take: 5,
      select: { appRef: true, status: true, submittedAt: true, markedAt: true, markerNote: true },
    }).catch(() => []);
    res.json({
      ...elig,
      pages: app.isComplete(),
      totalPoints: app.totalPoints(),
      hasDraft: !!draft,
      draftUpdatedAt: draft ? draft.updatedAt : null,
      // How far in they are, so the page can say "carry on from section 3".
      answered: draft && draft.answers ? Object.keys(draft.answers).length : 0,
      history,
    });
  } catch (err) {
    console.error('[IA app] meta error:', err.message);
    res.status(500).json({ error: 'Could not load the application.' });
  }
});

// ── GET /paper ────────────────────────────────────────────────────
// The applicant's copy. publicPaper() is what makes this safe — the answer key
// and any marking guidance are excluded by construction, not by remembering.
router.get('/paper', (req, res) => res.json(app.publicPaper()));

// ── GET /captured ─────────────────────────────────────────────────
router.get('/captured', async (req, res) => {
  try { res.json(await captureFor(req)); }
  catch (err) {
    console.error('[IA app] capture error:', err.message);
    res.status(500).json({ error: 'Could not read your details.' });
  }
});

// ── GET /mine ─────────────────────────────────────────────────────
router.get('/mine', async (req, res) => {
  try {
    const row = await prisma.iaApplication.findFirst({
      where: { applicantId: req.user.id },
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
    });
    if (!row) return res.json(null);
    // Their own answers back, but never the marking: per-question scores and the
    // flags are a marker's working, and an applicant reading "paste detected"
    // learns how to avoid it next time.
    res.json({
      id: row.id, appRef: row.appRef, status: row.status,
      answers: row.answers || {}, captured: row.captured || null,
      submittedAt: row.submittedAt, updatedAt: row.updatedAt,
      markedAt: row.markedAt, markerNote: row.markerNote,
    });
  } catch (err) {
    console.error('[IA app] mine error:', err.message);
    res.status(500).json({ error: 'Could not load your application.' });
  }
});

// ── PUT /draft ────────────────────────────────────────────────────
// Save progress. Deliberately forgiving: a draft is allowed to be incomplete,
// wrong and half-finished, because that is what a draft IS. The only thing it
// refuses is an answer to a question the paper does not ask.
router.put('/draft', async (req, res) => {
  try {
    const elig = await eligibility(req.user);
    if (!elig.canApply) return res.status(403).json({ error: elig.why });

    const answers = app.sanitiseAnswers((req.body && req.body.answers) || {});

    // Under 15 ends it here rather than at submit. Keeping the draft would be
    // keeping something they cannot use.
    const stop = app.stopFor(answers);
    if (stop) {
      await prisma.iaApplication.deleteMany({ where: { applicantId: req.user.id, status: 'DRAFT' } }).catch(() => {});
      return res.status(200).json({ stopped: stop });
    }

    const captured = await captureFor(req);
    const existing = await prisma.iaApplication.findFirst({
      where: { applicantId: req.user.id, status: 'DRAFT' }, select: { id: true, updatedAt: true },
    });

    if (existing) {
      // Two tabs. Whoever saved last wins, but the loser is TOLD rather than
      // silently overwritten — losing an hour of writing to a stale tab is the
      // worst thing a form like this can do.
      const since = req.body && req.body.knownUpdatedAt ? new Date(req.body.knownUpdatedAt) : null;
      if (since && existing.updatedAt && existing.updatedAt.getTime() > since.getTime() + 1000) {
        return res.status(409).json({
          error: 'This application was saved somewhere else more recently — probably another tab. '
               + 'Reload to pick up that version, or keep writing here and save again to overwrite it.',
          serverUpdatedAt: existing.updatedAt,
        });
      }
      const row = await prisma.iaApplication.update({
        where: { id: existing.id },
        data: { answers, captured, telemetry: normaliseTelemetry(req.body && req.body.telemetry) },
      });
      return res.json({ ok: true, id: row.id, updatedAt: row.updatedAt, savedAt: new Date() });
    }

    let row = null;
    for (let attempt = 0; !row && attempt < 10; attempt++) {
      try {
        row = await prisma.iaApplication.create({
          data: {
            appRef: await nextAppRef(attempt),
            applicantId: req.user.id,
            discordId: String(req.user.discordId || ''),
            discordUsername: req.user.discordUsername || null,
            robloxId: captured.roblox.id || null,
            robloxUsername: captured.roblox.username || null,
            answers, captured,
            telemetry: normaliseTelemetry(req.body && req.body.telemetry),
            status: 'DRAFT',
          },
        });
      } catch (e) {
        // P2002 is either the ref or the one-draft-per-user index. The second
        // means another request created the draft a moment ago, so use it.
        if (e && e.code === 'P2002') {
          const mine = await prisma.iaApplication.findFirst({
            where: { applicantId: req.user.id, status: 'DRAFT' }, select: { id: true, updatedAt: true },
          });
          if (mine) return res.json({ ok: true, id: mine.id, updatedAt: mine.updatedAt, savedAt: new Date() });
          continue;
        }
        throw e;
      }
    }
    if (!row) return res.status(500).json({ error: 'Could not start an application.' });
    res.json({ ok: true, id: row.id, updatedAt: row.updatedAt, savedAt: new Date() });
  } catch (err) {
    console.error('[IA app] draft error:', err.message);
    res.status(500).json({ error: 'Could not save your progress.' });
  }
});

// Telemetry is collected for a marker to READ, so it is bounded but not
// interpreted here. An unbounded JSON blob from a browser is a way to put a
// megabyte in the database.
function normaliseTelemetry(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const clip = (v, n) => Array.isArray(v) ? v.slice(0, n) : undefined;
  return {
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt.slice(0, 40) : null,
    sittings: Number.isFinite(raw.sittings) ? Math.min(200, raw.sittings) : null,
    // Per-question wall clock and keystroke counts, which is what makes a pasted
    // answer visible as evidence rather than as a score.
    perQuestion: raw.perQuestion && typeof raw.perQuestion === 'object'
      ? Object.fromEntries(Object.entries(raw.perQuestion).slice(0, 60).map(([k, v]) => [
          String(k).slice(0, 40),
          v && typeof v === 'object' ? {
            ms: Number.isFinite(v.ms) ? Math.min(864e5, v.ms) : null,
            keystrokes: Number.isFinite(v.keystrokes) ? Math.min(1e6, v.keystrokes) : null,
            chars: Number.isFinite(v.chars) ? Math.min(1e6, v.chars) : null,
          } : null,
        ]))
      : null,
    pastes: clip(raw.pastes, 40),
    awaySeconds: Number.isFinite(raw.awaySeconds) ? Math.min(864e5, raw.awaySeconds) : null,
  };
}

// ── POST /discard ─────────────────────────────────────────────────
router.post('/discard', async (req, res) => {
  try {
    const n = await prisma.iaApplication.deleteMany({ where: { applicantId: req.user.id, status: 'DRAFT' } });
    res.json({ ok: true, discarded: n.count });
  } catch (err) {
    console.error('[IA app] discard error:', err.message);
    res.status(500).json({ error: 'Could not discard the draft.' });
  }
});

// ── POST /submit ──────────────────────────────────────────────────
router.post('/submit', async (req, res) => {
  try {
    const elig = await eligibility(req.user);
    if (!elig.canApply) return res.status(403).json({ error: elig.why, pending: elig.pending });

    const answers  = app.sanitiseAnswers((req.body && req.body.answers) || {});
    const captured = await captureFor(req);

    const stop = app.stopFor(answers);
    if (stop) {
      await prisma.iaApplication.deleteMany({ where: { applicantId: req.user.id, status: 'DRAFT' } }).catch(() => {});
      return res.status(200).json({ stopped: stop });
    }

    // The captured fields are OURS to fill in, so fill them in rather than
    // trusting whatever the browser sent. This is what makes them uneditable in
    // any meaningful sense: a crafted request cannot put another person's Discord
    // name on an application.
    answers.discord_username = captured.discord.username || answers.discord_username || '';
    answers.roblox_username  = captured.roblox.username  || answers.roblox_username  || '';
    if (captured.device) answers.device = captured.device;

    // The declarations are checked against the name we captured, not against
    // whatever they typed into the identity fields.
    const signAs = captured.roblox.username || captured.discord.username || '';
    const v = app.validate(answers, { username: signAs });
    if (!v.ok) {
      return res.status(400).json({
        error: 'Some of it is not finished.',
        missing: v.missing, tooShort: v.tooShort, tooLong: v.tooLong, wrong: v.wrong,
      });
    }

    const context = await contextFor(req.user);
    const telemetry = normaliseTelemetry(req.body && req.body.telemetry);

    // Reuse the draft row rather than creating a second one. The draft IS the
    // application; a copy across two tables is a transaction that can half-fail.
    const draft = await prisma.iaApplication.findFirst({
      where: { applicantId: req.user.id, status: 'DRAFT' }, select: { id: true },
    });

    let row;
    if (draft) {
      row = await prisma.iaApplication.update({
        where: { id: draft.id },
        data: {
          answers, captured, context, telemetry,
          robloxId: captured.roblox.id || null,
          robloxUsername: captured.roblox.username || null,
          status: 'SUBMITTED', submittedAt: new Date(),
          maxScore: app.totalPoints(),
          // Pre-fill whatever the answer key can decide, so a marker starts from
          // the questions that need judgement. Empty until a key is supplied.
          scores: app.autoMark(answers).scores,
        },
      });
    } else {
      for (let attempt = 0; !row && attempt < 10; attempt++) {
        try {
          row = await prisma.iaApplication.create({
            data: {
              appRef: await nextAppRef(attempt),
              applicantId: req.user.id,
              discordId: String(req.user.discordId || ''),
              discordUsername: req.user.discordUsername || null,
              robloxId: captured.roblox.id || null,
              robloxUsername: captured.roblox.username || null,
              answers, captured, context, telemetry,
              status: 'SUBMITTED', submittedAt: new Date(),
              maxScore: app.totalPoints(),
              scores: app.autoMark(answers).scores,
            },
          });
        } catch (e) { if (e && e.code === 'P2002') continue; throw e; }
      }
    }
    if (!row) return res.status(500).json({ error: 'Could not submit the application.' });

    audit.record({
      req, action: 'IA_APP_SUBMIT', category: 'ia',
      targetType: 'iaApplication', targetId: row.id,
      summary: `Submitted Internal Affairs application ${row.appRef}`,
    });

    console.log(`[IA app] ${row.appRef} submitted by ${req.user.displayName || req.user.discordUsername}`);
    res.status(201).json({ ok: true, appRef: row.appRef, status: row.status, submittedAt: row.submittedAt });
  } catch (err) {
    console.error('[IA app] submit error:', err.message);
    res.status(500).json({ error: 'Could not submit the application.' });
  }
});

module.exports = router;
module.exports.captureFor = captureFor;
module.exports.contextFor = contextFor;
module.exports.nextAppRef = nextAppRef;
