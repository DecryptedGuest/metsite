// server/routes/hpc.js — HPC (Hendon Police College)
// Mounted at /api/hpc behind requireAuth + requireDivision('HPC') (Junior
// Instructor and above). Provides:
//   • Final-exam marking (Database Manager and above)
//   • Quota check (Assistant Director and above) — DB wiring pending
const express = require('express');
const prisma  = require('../lib/db');
const hpcExam = require('../lib/hpcExam');
const { sendHpcExamResult } = require('../lib/webhook');
const { requireHpcMarker, requireHpcQuota, userHpcTier, userHpcReviewer } = require('../middleware/division');
const audit = require('../lib/audit');

const router = express.Router();

// When a cadet PASSES the final exam, accept them into the MET Roblox group as
// Community Support Officer (first rank) — but ONLY if they have a pending join
// request (so we never rank someone who never asked to join). Fully best-effort:
// resolves the Roblox id from the linked account (or the typed username), finds
// the CSO role, approves the pending request, then sets the CSO rank. Never
// throws onto the mark handler. Returns a small result object for logging.
async function acceptPassedCadetIntoMet(s, req) {
  try {
    const rlib = require('../lib/roblox');
    const { metGroupId } = require('../lib/divisions');
    const gid = metGroupId();
    const cookie = rlib.cookieForDivision('MET');
    if (!gid || !cookie) return { ok: false, reason: 'MET group / cookie not configured' };

    // Whose account this acts on — and it must be an identity the cadet PROVED,
    // never one they typed.
    //
    // This used to fall back to `getRobloxIdFromUsername(s.robloxUsername)`, and
    // that username is a free-text box the cadet fills in on the exam page. So a
    // cadet could type somebody else's Roblox username, pass the exam, and have the
    // bot approve THAT person's pending join request and rank them Community
    // Support Officer. The only thing standing in the way was needing the victim to
    // have a join request open, which every applicant does.
    //
    // The fallback was also unnecessary: a submission always carries userId and
    // discordId (both non-null in the schema, with a real relation on userId), so
    // there is always a verified identity to work from. Two sources, both proved:
    //
    //   1. the linked site account's robloxId — set at login through OAuth, and
    //   2. RoVer's answer for the submitter's own Discord id.
    //
    // If neither can answer, this REFUSES and says so. A cadet accepted by hand is
    // a minute of somebody's time; the wrong account ranked into the MET group is a
    // security incident.
    let robloxId = null, via = null;
    const u = await prisma.user.findUnique({
      where: { id: s.userId }, select: { robloxId: true, robloxUsername: true },
    }).catch(() => null);
    if (u && u.robloxId) { robloxId = String(u.robloxId); via = 'their linked account'; }
    if (!robloxId && s.discordId) {
      const fromRover = await rlib.getRobloxIdFromDiscord(String(s.discordId)).catch(() => null);
      // RoVer answers with an id, or with an array of them for a multi-link setup.
      const first = Array.isArray(fromRover) ? fromRover[0] : fromRover;
      if (first) { robloxId = String(first); via = 'RoVer'; }
    }
    if (!robloxId) {
      return { ok: false, reason: 'the cadet has no verified Roblox account — '
        + 'their site account is not linked and RoVer does not know them, so accept them by hand' };
    }

    // The typed name disagreeing with the verified one is worth saying out loud. It
    // is usually a typo, and it is exactly what an attempt to redirect a pass looks
    // like — either way the person marking it should be told rather than have it
    // silently corrected.
    let typedMismatch = null;
    if (s.robloxUsername) {
      const typed = String(s.robloxUsername).trim().toLowerCase();
      const known = String((u && u.robloxUsername) || '').trim().toLowerCase();
      if (known && typed && typed !== known) typedMismatch = { typed: s.robloxUsername, actual: u.robloxUsername };
      else if (!known) {
        const check = await rlib.getRobloxUserInfo(robloxId).catch(() => null);
        const real = String((check && check.username) || '').trim().toLowerCase();
        if (real && typed && typed !== real) typedMismatch = { typed: s.robloxUsername, actual: check.username };
      }
      if (typedMismatch) {
        console.warn(`[HPC] cadet ${s.discordUsername || s.discordId} typed Roblox username `
          + `"${typedMismatch.typed}" but their verified account is "${typedMismatch.actual}" — `
          + 'acting on the verified one.');
      }
    }

    // Find the Community Support Officer role (env override, else by name, else
    // the lowest member rank — roles come back sorted rank ASC, Guest = rank 0).
    let csoRoleId = process.env.MET_CSO_ROLE_ID || null;
    let roles = [];
    if (!csoRoleId) {
      roles = await rlib.listGroupRoles(gid, cookie).catch(() => []);
      const named = roles.find(r => /community support officer/i.test(r.name || ''));
      const lowest = roles.find(r => Number(r.rank) > 0);
      csoRoleId = (named || lowest) ? String((named || lowest).id) : null;
    }

    // Only proceed if there's a PENDING join request for this user.
    let found = false, token = null, guard = 0;
    do {
      const page = await rlib.listJoinRequests(token, gid, cookie).catch(() => null);
      if (!page) break;
      if ((page.requests || []).some(r => String(r.userId) === robloxId)) { found = true; break; }
      token = page.nextPageToken || null;
    } while (token && ++guard < 20);
    if (!found) return { ok: false, reason: 'no pending join request' };

    await rlib.resolveJoinRequest(robloxId, 'approve', gid, cookie);
    // Approve lands them at the default rank; only claim a CSO rank change in the
    // audit trail if changeGroupRank actually succeeded (it's best-effort — the
    // member may not have propagated yet, or the role id may be unresolved).
    let ranked = false;
    if (csoRoleId) ranked = await rlib.changeGroupRank(robloxId, csoRoleId, gid, cookie).then(() => true).catch(() => false);

    // The audit trail names the account that was actually acted on and how it was
    // established — not the name the cadet typed, which is the whole point.
    const acted = (u && u.robloxUsername) || (typedMismatch && typedMismatch.actual) || robloxId;
    audit.log(req && req.user, {
      category: 'GROUP', action: ranked ? 'RANK_CHANGE' : 'GROUP_JOIN_APPROVED', division: 'MET',
      target: { type: 'roblox_user', id: robloxId, name: acted },
      summary: (ranked
        ? `Accepted ${acted} into the MET group as Community Support Officer (passed final exam)`
        : `Approved ${acted}'s MET group join request (passed final exam) — CSO rank not applied`)
        + ` — identity from ${via}`
        + (typedMismatch ? `; they had typed "${typedMismatch.typed}" on the exam, which was NOT used` : ''),
    });
    return { ok: true, ranked, robloxId, csoRoleId, via, typedMismatch };
  } catch (e) {
    console.warn('[HPC] acceptPassedCadetIntoMet failed:', e.message);
    return { ok: false, reason: e.message };
  }
}

// GET /api/hpc/context — what the current HPC member can do (drives the UI).
router.get('/context', (req, res) => {
  res.json({
    canMark:    userHpcReviewer(req.user),
    canQuota:   userHpcTier(req.user, 'quota'),
    canApprove: userHpcReviewer(req.user) || ['HICOMM', 'DEVELOPER'].includes(req.user.role),
    isDev:      req.user.role === 'DEVELOPER',
  });
});

// GET /api/hpc/exam/paper — the paper, for markers to see each prompt.
router.get('/exam/paper', requireHpcMarker, (req, res) => res.json(hpcExam.publicPaper()));

function summariseSubmission(s, full) {
  const base = {
    id: s.id,
    discordId: s.discordId,
    discordUsername: s.discordUsername,
    robloxUsername: s.robloxUsername,
    status: s.status,
    score: s.score,
    maxScore: s.maxScore,
    percentage: s.percentage,
    flagCount: Array.isArray(s.flags) ? s.flags.length : 0,
    highFlags: Array.isArray(s.flags) ? s.flags.filter(f => f.severity === 'high').length : 0,
    markedByName: s.markedByName,
    markedAt: s.markedAt,
    createdAt: s.createdAt,
  };
  if (!full) return base;
  return { ...base, answers: s.answers, detection: s.detection, flags: s.flags, scores: s.scores, markerNote: s.markerNote, aiScan: s.aiScan || null };
}

// GET /api/hpc/exam/results — read-only list of ALL exams + marks/status for
// any HPC member (Junior Instructor+). No answers/AI detail (that's marker-only).
router.get('/exam/results', async (req, res) => {
  try {
    const subs = await prisma.hpcExamSubmission.findMany({ orderBy: { createdAt: 'desc' }, take: 500 });
    res.json(subs.map(s => ({
      id: s.id, discordUsername: s.discordUsername, discordId: s.discordId,
      robloxUsername: s.robloxUsername, status: s.status, score: s.score,
      maxScore: s.maxScore, percentage: s.percentage,
      markedByName: s.markedByName, markedAt: s.markedAt, createdAt: s.createdAt,
    })));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load results' });
  }
});

// GET /api/hpc/exam/analytics — aggregate exam insights for the overview.
// Same audience as /exam/results (any HPC member). Best-effort.
router.get('/exam/analytics', async (req, res) => {
  try {
    const subs = await prisma.hpcExamSubmission.findMany({
      select: { status: true, percentage: true, markedAt: true, createdAt: true, robloxUsername: true, discordUsername: true, score: true, maxScore: true },
      orderBy: { createdAt: 'desc' }, take: 1000,
    });
    const total = subs.length;
    const passed = subs.filter(s => s.status === 'PASSED').length;
    const failed = subs.filter(s => s.status === 'FAILED').length;
    const pending = subs.filter(s => s.status === 'PENDING').length;
    const marked = subs.filter(s => s.percentage != null);
    const avgPercentage = marked.length ? Math.round(marked.reduce((a, s) => a + s.percentage, 0) / marked.length) : null;
    const passRate = (passed + failed) ? Math.round((passed / (passed + failed)) * 100) : null;
    // Distribution of marked results into 10-point bands.
    const bands = [[0, 49], [50, 59], [60, 69], [70, 79], [80, 89], [90, 100]];
    const distribution = bands.map(([lo, hi]) => ({
      label: lo === 0 ? '<50' : (hi === 100 ? '90+' : lo + '–' + hi),
      count: marked.filter(s => s.percentage >= lo && s.percentage <= hi).length,
    }));
    // Simple 30-day trend: exams taken per week (4 buckets).
    const now = Date.now(), wk = 7 * 86400000;
    const weekly = [0, 1, 2, 3].map(i => {
      const end = now - i * wk, start = end - wk;
      return { weeksAgo: i, count: subs.filter(s => { const t = new Date(s.createdAt).getTime(); return t > start && t <= end; }).length };
    }).reverse();
    res.json({ total, passed, failed, pending, avgPercentage, passRate, distribution, weekly });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load exam analytics' });
  }
});

// GET /api/hpc/exam/results/:id — read-only exam detail for ANY HPC member
// (Junior Instructor+). Shows the mark, status, feedback note and timing — but
// NOT the answers or anti-cheat detail (those stay marker-only via the
// /exam/submissions/:id route). Lets everyone click a Final Exam to see more.
router.get('/exam/results/:id', async (req, res) => {
  try {
    const s = await prisma.hpcExamSubmission.findUnique({ where: { id: req.params.id } });
    if (!s) return res.status(404).json({ error: 'Exam not found' });
    res.json({
      id: s.id, discordUsername: s.discordUsername, discordId: s.discordId,
      robloxUsername: s.robloxUsername, status: s.status,
      score: s.score, maxScore: s.maxScore, percentage: s.percentage,
      markerNote: s.markerNote, markedByName: s.markedByName, markedAt: s.markedAt,
      createdAt: s.createdAt,
      // Whether the viewer can open the full marked paper (answers + AI flags).
      canMark: userHpcReviewer(req.user),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load exam' });
  }
});

// GET /api/hpc/exam/submissions?status=PENDING — marker queue / archive.
router.get('/exam/submissions', requireHpcMarker, async (req, res) => {
  try {
    const where = {};
    if (['PENDING', 'PASSED', 'FAILED'].includes(req.query.status)) where.status = req.query.status;
    const subs = await prisma.hpcExamSubmission.findMany({ where, orderBy: { createdAt: 'desc' }, take: 300 });
    res.json(subs.map(s => summariseSubmission(s, false)));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load submissions' });
  }
});

// GET /api/hpc/exam/submissions/:id — full detail (answers + AI flags) to mark.
router.get('/exam/submissions/:id', requireHpcMarker, async (req, res) => {
  try {
    const s = await prisma.hpcExamSubmission.findUnique({ where: { id: req.params.id } });
    if (!s) return res.status(404).json({ error: 'Submission not found' });
    res.json({ paper: hpcExam.publicPaper(), submission: summariseSubmission(s, true) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load submission' });
  }
});

// POST /api/hpc/exam/submissions/:id/ai-scan — run the free-text answers through
// every configured AI detector and store the aggregated result on the exam.
// Only scans substantive written answers (paragraph/short), never the
// multiple-choice / username / agreement fields. Marker-gated.
router.post('/exam/submissions/:id/ai-scan', requireHpcMarker, async (req, res) => {
  try {
    const s = await prisma.hpcExamSubmission.findUnique({ where: { id: req.params.id } });
    if (!s) return res.status(404).json({ error: 'Submission not found' });

    const answers = s.answers || {};
    const items = hpcExam.QUESTIONS
      .filter(q => q.type === 'paragraph' || q.type === 'short')
      .filter(q => !['roblox_username', 'discord_username'].includes(q.id))
      .map(q => ({ qid: q.id, prompt: q.prompt, text: String(answers[q.id] || '') }))
      .filter(it => it.text.trim());

    const aiDetect = require('../lib/aiDetect');
    const scan = await aiDetect.scanAnswers(items);
    const record = {
      at: new Date().toISOString(),
      scannedById: req.user.id,
      scannedByName: req.user.displayName || req.user.discordUsername,
      ...scan,
    };
    await prisma.hpcExamSubmission.update({ where: { id: s.id }, data: { aiScan: record } }).catch(() => {});

    audit.record({
      req, action: 'EXAM_AI_SCAN', category: 'exam', targetType: 'submission', targetId: s.id,
      summary: `AI-scanned ${s.discordUsername || s.robloxUsername || 'a cadet'}'s final exam — overall ${scan.overall == null ? 'n/a' : scan.overall + '%'} across ${scan.providers.length} detector(s)`,
      metadata: { overall: scan.overall, providers: scan.providers },
    });

    res.json(record);
  } catch (err) {
    console.error('[HPC] exam AI scan failed:', err.message);
    res.status(500).json({ error: 'Failed to run AI scan' });
  }
});

// POST /api/hpc/exam/submissions/:id/mark { scores:{qid:points}, note }
router.post('/exam/submissions/:id/mark', requireHpcMarker, async (req, res) => {
  const { scores, note } = req.body || {};
  if (!scores || typeof scores !== 'object') return res.status(400).json({ error: 'scores are required' });
  try {
    const s = await prisma.hpcExamSubmission.findUnique({ where: { id: req.params.id } });
    if (!s) return res.status(404).json({ error: 'Submission not found' });

    // Clamp each score to its question's max; sum the total.
    const clean = {};
    let total = 0;
    for (const q of hpcExam.QUESTIONS) {
      const raw = Number(scores[q.id]);
      const pts = Number.isFinite(raw) ? Math.max(0, Math.min(q.points, raw)) : 0;
      clean[q.id] = pts;
      total += pts;
    }
    const maxScore   = hpcExam.totalPoints();
    const percentage = Math.round((total / maxScore) * 100);
    const passed     = percentage >= hpcExam.PASS_PERCENT;

    const updated = await prisma.hpcExamSubmission.update({
      where: { id: s.id },
      data: {
        scores: clean,
        score: total,
        percentage,
        status: passed ? 'PASSED' : 'FAILED',
        markerNote: note ? String(note).slice(0, 2000) : null,
        markedById: req.user.id,
        markedByName: req.user.displayName || req.user.discordUsername,
        markedAt: new Date(),
      },
    });

    // Post the result to the MET results channel (best-effort).
    const msgId = await sendHpcExamResult({
      discordId: s.discordId,
      robloxUsername: s.robloxUsername,
      discordUsername: s.discordUsername,
      score: total, maxScore, percentage, passed,
      note,
    }).catch(() => null);
    if (msgId) await prisma.hpcExamSubmission.update({ where: { id: s.id }, data: { resultMessageId: msgId } }).catch(() => {});

    // Also post the marking LOG to the HPC server's #final-exam-log (pings the
    // Database Manager to verify). Best-effort — never blocks the mark.
    require('../lib/bot').postHpcExamLog({
      markerDiscordId: req.user.discordId || null,
      markerName: req.user.displayName || req.user.discordUsername || 'Marker',
      studentName: s.discordUsername || s.robloxUsername || 'Unknown',
      percentage, robloxUsername: s.robloxUsername, discordUsername: s.discordUsername,
    }).catch(() => {});

    // On a pass, accept the cadet into the MET group as CSO (best-effort, only if
    // they have a pending join request). Fire-and-forget so the mark returns fast —
    // but NOT silent. A refusal used to leave nothing but a console line, so a cadet
    // who passed and was never actually accepted looked identical to one who was,
    // and the first anybody knew was them asking why they had no rank. Now every
    // outcome lands in the audit trail, with the reason and what to do about it.
    if (passed) {
      acceptPassedCadetIntoMet(s, req)
        .then((r) => {
          if (r && r.ok) return;
          audit.record({
            req, action: 'EXAM_PASS_NOT_ACCEPTED', category: 'exam',
            targetType: 'submission', targetId: s.id,
            summary: `${s.discordUsername || s.robloxUsername || 'A cadet'} passed the final exam but was `
                   + `NOT accepted into the MET group — ${(r && r.reason) || 'unknown reason'}. `
                   + `Accept them by hand.`,
            metadata: { reason: (r && r.reason) || null },
          });
        })
        .catch(() => {});
    }

    audit.record({
      req, action: 'EXAM_MARK', category: 'exam', targetType: 'submission', targetId: s.id,
      summary: `Marked ${s.discordUsername || s.robloxUsername || 'a cadet'}'s final exam: ${total}/${maxScore} (${percentage}%) — ${updated.status}`,
      metadata: { score: total, maxScore, percentage, status: updated.status },
    });

    // Live in-page notification to the cadet (best-effort).
    try {
      require('../lib/events').publishToUser(s.userId, 'exam_marked', {
        status: updated.status, score: total, maxScore, percentage,
        message: `Your final exam has been marked: ${percentage}% — ${passed ? 'PASSED' : 'FAILED'}.`,
      });
    } catch (e) { /* non-fatal */ }

    res.json({ success: true, status: updated.status, score: total, maxScore, percentage, posted: !!msgId });
  } catch (err) {
    console.error('[HPC] mark failed:', err.message);
    res.status(500).json({ error: 'Failed to mark exam' });
  }
});

// DELETE /api/hpc/exam/submissions/:id — DEVELOPER ONLY. Voids a final exam
// entirely: deletes the record so the cadet is treated as if they never sat it
// (they become eligible to take it again).
router.delete('/exam/submissions/:id', async (req, res) => {
  if (req.user.role !== 'DEVELOPER') return res.status(403).json({ error: 'Developer access required.' });
  try {
    await prisma.hpcExamSubmission.delete({ where: { id: req.params.id } });
    res.json({ success: true, voided: true });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Exam not found' });
    console.error('[HPC] delete exam failed:', err.message);
    res.status(500).json({ error: 'Failed to delete exam' });
  }
});

// GET /api/hpc/quota — Assistant Director+. DB not wired yet (provided later).
router.get('/quota', requireHpcQuota, (req, res) => {
  res.json({ configured: false, message: 'The HPC quota database has not been connected yet.' });
});

// ── Tryouts (any HPC member — Junior Instructor+ — can schedule/view) ──
function tryoutSummary(t) {
  return {
    id: t.id, hostName: t.hostName, hostDiscordId: t.hostDiscordId,
    coHostName: t.coHostName, coHostDiscordId: t.coHostDiscordId,
    scheduledAt: t.scheduledAt, status: t.status, lockState: t.lockState,
    privateServerLink: t.privateServerLink, joinUrl: require('../lib/tryouts').tryoutJoinUrl(t),
    announcementSent: t.announcementSent,
    notes: t.notes, createdAt: t.createdAt,
    isMine: undefined,
  };
}

// GET /api/hpc/tryouts — upcoming + recent tryouts.
router.get('/tryouts', async (req, res) => {
  try {
    const tryouts = await prisma.tryout.findMany({ where: { division: 'HPC' }, orderBy: { scheduledAt: 'desc' }, take: 100 });
    res.json(tryouts.map(t => ({ ...tryoutSummary(t), isMine: t.hostId === req.user.id })));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load tryouts' });
  }
});

// Can this user manage (strike/pass/fail/kick/cancel/complete) this tryout from
// the site? ONLY the host (or co-host), HPC HICOMM (rank 247+), MET HICOMM, or a
// developer — NOT other HPC members.
function canManageTryout(user, t) {
  if (t.hostId && t.hostId === user.id) return true;
  if (t.coHostDiscordId && String(t.coHostDiscordId) === String(user.discordId)) return true;
  return canApproveTryouts(user); // HPC HICOMM (rank 247+) / MET HICOMM / developer
}

// GET /api/hpc/tryouts/live — live tryouts + their latest in-game overview
// snapshot, so instructors can watch a running tryout from the site; the host/
// co-host also get `canManage:true` to drive it from here.
router.get('/tryouts/live', async (req, res) => {
  try {
    const live = await prisma.tryout.findMany({ where: { status: 'LIVE', division: 'HPC' }, orderBy: { scheduledAt: 'desc' }, take: 20 });
    res.json(live.map(t => ({
      id: t.id, hostName: t.hostName, coHostName: t.coHostName,
      lockState: t.lockState, scheduledAt: t.scheduledAt,
      snapshot: t.liveSnapshot || null, // { at, attendees:[...], totalAttendees, passedCount, ... }
      canManage: canManageTryout(req.user, t),
    })));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load live tryouts' });
  }
});

// POST /api/hpc/tryouts/:id/command — host/co-host queue a live action
// (STRIKE | UNSTRIKE | PASS | FAIL | KICK | NOTE). The in-game panel polls and
// applies it, so the site can drive the tryout like the in-game panel.
router.post('/tryouts/:id/command', async (req, res) => {
  try {
    const t = await prisma.tryout.findFirst({ where: { id: req.params.id, division: 'HPC' } });
    if (!t) return res.status(404).json({ error: 'Tryout not found' });
    if (!canManageTryout(req.user, t)) return res.status(403).json({ error: 'Only the host or co-host can manage this tryout.' });
    if (t.status !== 'LIVE') return res.status(400).json({ error: 'This tryout is not live.' });

    const { action, targetRobloxId, targetUsername, detail } = req.body || {};
    const ACTIONS = ['STRIKE', 'UNSTRIKE', 'PASS', 'FAIL', 'KICK', 'NOTE'];
    const act = String(action || '').toUpperCase();
    if (!ACTIONS.includes(act)) return res.status(400).json({ error: 'Invalid action' });
    if (act !== 'NOTE' && !targetRobloxId && !targetUsername) return res.status(400).json({ error: 'A target is required.' });

    const cmd = await prisma.tryoutCommand.create({ data: {
      tryoutId: t.id, action: act,
      targetRobloxId: targetRobloxId ? String(targetRobloxId) : null,
      targetUsername: targetUsername || null,
      detail: detail ? String(detail).slice(0, 200) : null,
      issuedById: req.user.id, issuedByName: req.user.displayName || req.user.discordUsername,
    } });
    res.status(201).json({ success: true, id: cmd.id });
  } catch (err) {
    console.error('[HPC] tryout command failed:', err.message);
    res.status(500).json({ error: 'Failed to queue command' });
  }
});

// POST /api/hpc/tryouts { scheduledAt, lockState, notes } — schedule one.
router.post('/tryouts', async (req, res) => {
  try {
    const { scheduledAt, lockState, notes } = req.body || {};
    const when = new Date(scheduledAt);
    if (isNaN(when.getTime())) return res.status(400).json({ error: 'A valid date/time is required.' });
    if (when.getTime() < Date.now() - 60 * 1000) return res.status(400).json({ error: 'The scheduled time must be in the future.' });

    const t = await prisma.tryout.create({
      data: {
        hostId: req.user.id,
        hostDiscordId: req.user.discordId,
        hostName: req.user.displayName || req.user.discordUsername,
        scheduledAt: when,
        lockState: ['UNLOCKED', 'UNSLOCKED'].includes(String(lockState).toUpperCase()) ? 'UNLOCKED' : 'LOCKED',
        notes: notes ? String(notes).slice(0, 500) : null,
      },
    });
    audit.record({
      req, action: 'TRYOUT_SCHEDULE', category: 'tryout', targetType: 'tryout', targetId: t.id,
      summary: `Scheduled a MET tryout for ${when.toISOString()}`,
      metadata: { scheduledAt: when.toISOString(), lockState: t.lockState },
    });
    // Create a native Discord Scheduled Event in the MET server (best-effort).
    try {
      const bot = require('../lib/bot');
      const evId = await bot.createTryoutScheduledEvent(t, bot.tryoutGuildId(t.division));
      if (evId) { t.scheduledEventId = evId; await prisma.tryout.update({ where: { id: t.id }, data: { scheduledEventId: evId } }).catch(() => {}); }
      // Post the announcement immediately on schedule (best-effort).
      bot.postTryoutAnnouncement(t).catch(() => {});
    } catch (e) { /* best-effort */ }
    res.status(201).json(tryoutSummary(t));
  } catch (err) {
    console.error('[HPC] schedule tryout failed:', err.message);
    res.status(500).json({ error: 'Failed to schedule tryout' });
  }
});

// POST /api/hpc/tryouts/:id/cancel — host (or developer) cancels a tryout.
router.post('/tryouts/:id/cancel', async (req, res) => {
  try {
    const t = await prisma.tryout.findFirst({ where: { id: req.params.id, division: 'HPC' } });
    if (!t) return res.status(404).json({ error: 'Tryout not found' });
    if (!canManageTryout(req.user, t)) {
      return res.status(403).json({ error: 'Only the host, HPC/MET HICOMM or a developer can cancel this tryout.' });
    }
    if (['COMPLETED', 'CANCELLED'].includes(t.status)) return res.status(400).json({ error: 'This tryout is already finished.' });
    const updated = await prisma.tryout.update({ where: { id: t.id }, data: { status: 'CANCELLED' } });
    // End the Discord side: remove the announcement, end the scheduled event, flip the host DM.
    try {
      const bot = require('../lib/bot');
      await bot.deleteTryoutAnnouncement(updated).catch(() => {});
      await bot.deleteTryoutScheduledEvent(updated, bot.tryoutGuildId(updated.division)).catch(() => {});
      await bot.editTryoutHostDM(updated).catch(() => {});
    } catch (e) { /* Discord side is best-effort */ }
    audit.record({ req, action: 'TRYOUT_CANCEL', category: 'tryout', targetType: 'tryout', targetId: t.id, summary: 'Cancelled a MET tryout' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to cancel tryout' });
  }
});

// POST /api/hpc/tryouts/:id/complete — mark a live tryout finished.
router.post('/tryouts/:id/complete', async (req, res) => {
  try {
    const t = await prisma.tryout.findFirst({ where: { id: req.params.id, division: 'HPC' } });
    if (!t) return res.status(404).json({ error: 'Tryout not found' });
    if (!canManageTryout(req.user, t)) {
      return res.status(403).json({ error: 'Only the host, HPC/MET HICOMM or a developer can end this tryout.' });
    }
    const updated = await prisma.tryout.update({ where: { id: t.id }, data: { status: 'COMPLETED' } });
    // Now the tryout has concluded: remove its channel announcement, end the
    // Discord scheduled event, and flip the host DM — same as CID's complete.
    try {
      const bot = require('../lib/bot');
      await bot.deleteTryoutAnnouncement(updated).catch(() => {});
      await bot.deleteTryoutScheduledEvent(updated, bot.tryoutGuildId(updated.division)).catch(() => {});
      await bot.editTryoutHostDM(updated).catch(() => {});
    } catch (e) { /* Discord side is best-effort */ }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to complete tryout' });
  }
});

// ── Tryout logs ───────────────────────────────────────────────────────
// Host reviews + posts the log the in-game panel created; HPC HICOMM (quota
// tier / site HICOMM / developer) approve or deny; approval awards +1 point.
const tryoutLogsLib = require('../lib/tryoutLogs');
const { sendTryoutLog, editTryoutLog } = require('../lib/webhook');

// Who can approve/deny tryout logs: Assistant Director+ (HPC quota tier), or a
// site HICOMM / developer.
function canApproveTryouts(user) {
  return userHpcReviewer(user) || ['HICOMM', 'DEVELOPER'].includes(user.role);
}
function requireTryoutApprover(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (canApproveTryouts(req.user)) return next();
  return res.status(403).json({ error: 'HPC HICOMM access required to review tryout logs.' });
}

// GET /api/hpc/tryout-logs/context — what the UI should show for this user.
router.get('/tryout-logs/context', (req, res) => {
  res.json({ canApprove: canApproveTryouts(req.user) });
});

// GET /api/hpc/tryout-logs/mine — the host's own logs (drafts + submitted).
router.get('/tryout-logs/mine', async (req, res) => {
  try {
    const logs = await prisma.tryoutLog.findMany({ where: { hostId: req.user.id, division: 'HPC' }, orderBy: { createdAt: 'desc' }, take: 100 });
    res.json(logs.map(l => tryoutLogsLib.serialize(l)));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load your tryout logs' });
  }
});

// GET /api/hpc/tryout-logs/pending — the HICOMM review queue.
router.get('/tryout-logs/pending', requireTryoutApprover, async (req, res) => {
  try {
    const status = ['PENDING', 'APPROVED', 'DENIED'].includes(req.query.status) ? req.query.status : 'PENDING';
    const logs = await prisma.tryoutLog.findMany({ where: { status, division: 'HPC' }, orderBy: { createdAt: 'desc' }, take: 200 });
    res.json(logs.map(l => tryoutLogsLib.serialize(l)));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load the review queue' });
  }
});

// GET /api/hpc/tryout-logs/:id — full detail (owner or approver only).
router.get('/tryout-logs/:id', async (req, res) => {
  try {
    const log = await prisma.tryoutLog.findFirst({ where: { id: req.params.id, division: 'HPC' } });
    if (!log) return res.status(404).json({ error: 'Tryout log not found' });
    if (log.hostId !== req.user.id && !canApproveTryouts(req.user)) {
      return res.status(403).json({ error: 'Not your tryout log.' });
    }
    res.json(tryoutLogsLib.serialize(log, { full: true }));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load the tryout log' });
  }
});

// POST /api/hpc/tryout-logs/:id/submit { notes?, attendees? } — host posts the
// log for review (DRAFT → PENDING). Lets the host tweak notes + attendee
// results/strikes on the site before submitting.
router.post('/tryout-logs/:id/submit', async (req, res) => {
  try {
    const log = await prisma.tryoutLog.findFirst({ where: { id: req.params.id, division: 'HPC' } });
    if (!log) return res.status(404).json({ error: 'Tryout log not found' });
    if (log.hostId !== req.user.id) return res.status(403).json({ error: 'Only the host can submit this log.' });
    if (log.status !== 'DRAFT') return res.status(400).json({ error: 'This log has already been submitted.' });

    const { notes, attendees, proof } = req.body || {};
    const data = { status: 'PENDING' };
    if (typeof notes === 'string') data.notes = notes.slice(0, 3000);
    if (typeof proof === 'string') data.proof = proof.slice(0, 500);
    if (Array.isArray(attendees)) {
      const clean = tryoutLogsLib.normaliseAttendees(attendees);
      Object.assign(data, { attendees: clean, ...tryoutLogsLib.countsFor(clean) });
    }

    const updated = await prisma.tryoutLog.update({ where: { id: log.id }, data });
    const msgId = await sendTryoutLog(updated, { event: 'submitted' }).catch(() => null);
    if (msgId) await prisma.tryoutLog.update({ where: { id: log.id }, data: { logMessageId: msgId } }).catch(() => {});
    tryoutLogsLib.notifyTryoutApprovers(updated).catch(() => {}); // push HICOMM (fire-and-forget)
    res.json({ success: true, status: 'PENDING', posted: !!msgId });
  } catch (err) {
    console.error('[HPC] submit tryout log failed:', err.message);
    res.status(500).json({ error: 'Failed to submit the tryout log' });
  }
});

// POST /api/hpc/tryout-logs/:id/approve { note? } — HICOMM approves → +1 point.
router.post('/tryout-logs/:id/approve', requireTryoutApprover, async (req, res) => {
  try {
    const log = await prisma.tryoutLog.findFirst({ where: { id: req.params.id, division: 'HPC' } });
    if (!log) return res.status(404).json({ error: 'Tryout log not found' });
    if (log.status !== 'PENDING') return res.status(400).json({ error: 'Only pending logs can be approved.' });

    // Award the host their +1 HPC point (best-effort; never blocks approval).
    const award = await tryoutLogsLib.awardHpcPoint(log).catch(() => ({ ok: false, reason: 'error', detail: 'Unexpected error.' }));
    // Optionally sync each attendee's pass/fail to the recruits sheet.
    tryoutLogsLib.syncAttendanceToSheet(log).catch(() => {});

    const updated = await prisma.tryoutLog.update({
      where: { id: log.id },
      data: {
        status: 'APPROVED', pointAwarded: award.ok,
        reviewNote: req.body && req.body.note ? String(req.body.note).slice(0, 2000) : null,
        reviewedById: req.user.id, reviewedByName: req.user.displayName || req.user.discordUsername,
        reviewedAt: new Date(),
      },
    });
    await editTryoutLog(updated, { event: 'approved' }).catch(() => null);
    // Everyone who PASSED this MET tryout gets the final-exam role in the MET
    // server so they can sit the exam. Fire-and-forget — never blocks approval.
    tryoutLogsLib.grantFinalExamRoleToPassers(updated)
      .then(r => { if (r && r.total) console.log(`[HPC] final-exam role granted to ${r.granted}/${r.total} passers of tryout ${updated.id}`); })
      .catch(() => {});
    res.json({ success: true, status: 'APPROVED', pointAwarded: award.ok, pointReason: award.reason, pointDetail: award.detail });
  } catch (err) {
    console.error('[HPC] approve tryout log failed:', err.message);
    res.status(500).json({ error: 'Failed to approve the tryout log' });
  }
});

// POST /api/hpc/tryout-logs/:id/deny { note } — HICOMM denies.
router.post('/tryout-logs/:id/deny', requireTryoutApprover, async (req, res) => {
  try {
    const log = await prisma.tryoutLog.findFirst({ where: { id: req.params.id, division: 'HPC' } });
    if (!log) return res.status(404).json({ error: 'Tryout log not found' });
    if (log.status !== 'PENDING') return res.status(400).json({ error: 'Only pending logs can be denied.' });

    const updated = await prisma.tryoutLog.update({
      where: { id: log.id },
      data: {
        status: 'DENIED',
        reviewNote: req.body && req.body.note ? String(req.body.note).slice(0, 2000) : null,
        reviewedById: req.user.id, reviewedByName: req.user.displayName || req.user.discordUsername,
        reviewedAt: new Date(),
      },
    });
    await editTryoutLog(updated, { event: 'denied' }).catch(() => null);
    res.json({ success: true, status: 'DENIED' });
  } catch (err) {
    console.error('[HPC] deny tryout log failed:', err.message);
    res.status(500).json({ error: 'Failed to deny the tryout log' });
  }
});

// ── GET /api/hpc/analytics?days= — HPC tryout analytics for the dashboard. ──
router.get('/analytics', async (req, res) => {
  try {
    const analytics = require('../lib/analytics');
    const days = analytics.normDays(req.query.days); // number, or 0 = all time
    const [tryouts, funnel] = await Promise.all([
      analytics.tryoutAnalytics('HPC', days),
      analytics.recruitmentFunnel('HPC', days),
    ]);
    res.json({ division: 'HPC', days: tryouts.days, allTime: tryouts.allTime, tryouts, funnel });
  } catch (e) { res.status(500).json({ error: 'Failed to load analytics' }); }
});

// Exposed for tests. This function decides which Roblox account gets ranked into
// the MET group off the back of an exam pass, and it used to take that from a
// free-text box the cadet filled in — so it is worth being able to prove, directly,
// that a typed username can no longer drive it.
module.exports = router;
module.exports.__acceptPassedCadetIntoMet = acceptPassedCadetIntoMet;
