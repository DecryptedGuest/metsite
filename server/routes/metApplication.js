// MET Constable recruitment application submissions.
const express = require('express');
const router = express.Router();
const prisma = require('../lib/db');

const GROUP_ID = '17275620';
const GROUP_URL = 'https://www.roblox.com/communities/17275620/Metropolitan-Police-SLR#!/about';

const QUESTIONS = {
  q1: { type: 'agreement' },
  q2: { type: 'agreement' },
  q3: { min: 20, max: 2500 },
  q4: { min: 20, max: 2500 },
  q5: { min: 1, max: 1500 },
  q6: { min: 20, max: 2500 },
  q7: { type: 'activity' },
  q8: { min: 20, max: 2500 },
  q9: { min: 20, max: 2500 },
  q10: { type: 'agreement' },
};

async function groupMembership(user) {
  if (!user || !user.robloxId) return { member: false, available: false };
  // This is a previously resolved natural Roblox group rank, not a site-only override.
  if (user.metRankNatural && user.metRankNatural.name) return { member: true, available: true, source: 'account' };
  try {
    const { getUserGroupRoles } = require('../lib/roblox');
    const diag = {};
    const roles = await getUserGroupRoles(String(user.robloxId), GROUP_ID, diag);
    if (diag.failed) return { member: null, available: false };
    return { member: Array.isArray(roles) && roles.length > 0, available: true, source: 'roblox' };
  } catch (e) {
    console.warn('[MET application] group membership check unavailable:', e.message);
    return { member: null, available: false };
  }
}

async function nextRef(attempt = 0) {
  const latest = await prisma.metApplication.findFirst({
    where: { appRef: { startsWith: 'MET-' } },
    orderBy: { appRef: 'desc' },
    select: { appRef: true },
  });
  const highest = latest ? parseInt(String(latest.appRef).replace(/\D/g, ''), 10) : 0;
  return 'MET-' + String((Number.isFinite(highest) ? highest : 0) + 1 + attempt).padStart(4, '0');
}

router.get('/meta', async (req, res) => {
  try {
    const user = req.user;
    if (!user.robloxId) {
      return res.json({
        canApply: false, needsRobloxLink: true,
        message: 'Your Roblox account is not linked to this MET account. Sign in with Roblox first, then return here.',
        groupUrl: GROUP_URL,
      });
    }
    const [membership, existing] = await Promise.all([
      groupMembership(user),
      prisma.metApplication.findFirst({
        where: { applicantId: user.id, status: 'SUBMITTED' },
        select: { appRef: true, submittedAt: true, status: true },
      }),
    ]);
    res.set('Cache-Control', 'no-store');
    res.json({
      canApply: !existing,
      isMember: membership.member,
      membershipCheckAvailable: membership.available,
      groupUrl: GROUP_URL,
      pendingRequestCheckAvailable: false,
      existing,
      robloxUsername: user.robloxUsername || null,
      groupStepRequired: membership.member !== true,
    });
  } catch (e) {
    console.error('[MET application] meta error:', e.message);
    res.status(500).json({ error: 'Could not load the application.' });
  }
});

router.post('/submit', async (req, res) => {
  try {
    const user = req.user;
    if (!user.robloxId) return res.status(400).json({ error: 'Link your Roblox account before applying.' });

    const existing = await prisma.metApplication.findFirst({
      where: { applicantId: user.id, status: 'SUBMITTED' },
      select: { appRef: true },
    });
    if (existing) return res.status(409).json({ error: 'You already have an application awaiting review.', appRef: existing.appRef });

    const answers = req.body && req.body.answers;
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
      return res.status(400).json({ error: 'Please complete every question.' });
    }
    for (const [id, rule] of Object.entries(QUESTIONS)) {
      const value = answers[id];
      if (rule.type === 'agreement') {
        if (value !== true) return res.status(400).json({ error: 'You must agree to every required declaration.' });
      } else if (rule.type === 'activity') {
        if (!Number.isInteger(Number(value)) || Number(value) < 0 || Number(value) > 10) {
          return res.status(400).json({ error: 'Choose an activity rating from 0 to 10.' });
        }
      } else {
        const text = String(value || '').trim();
        if (text.length < rule.min || text.length > rule.max) {
          return res.status(400).json({ error: 'Please complete every written answer (minimum 20 characters).' });
        }
      }
    }

    const membership = await groupMembership(user);
    const member = membership.member === true;
    const groupRequestConfirmed = req.body.groupRequestConfirmed === true;
    if (!member && !groupRequestConfirmed) {
      return res.status(400).json({ error: 'Request to join the Roblox group first, then confirm that you have sent the request.' });
    }

    let row = null;
    for (let attempt = 0; !row && attempt < 8; attempt++) {
      try {
        row = await prisma.metApplication.create({
          data: {
            appRef: await nextRef(attempt),
            applicantId: user.id,
            discordId: String(user.discordId || ''),
            discordUsername: user.discordUsername || null,
            robloxId: String(user.robloxId),
            robloxUsername: user.robloxUsername || null,
            answers: {
              q1: true, q2: true,
              q3: String(answers.q3).trim(),
              q4: String(answers.q4).trim(),
              q5: String(answers.q5).trim(),
              q6: String(answers.q6).trim(),
              q7: Number(answers.q7),
              q8: String(answers.q8).trim(),
              q9: String(answers.q9).trim(),
              q10: true,
            },
            groupRequestConfirmed: member || groupRequestConfirmed,
            status: 'SUBMITTED',
          },
        });
      } catch (e) {
        if (e && e.code === 'P2002') continue;
        throw e;
      }
    }
    if (!row) return res.status(500).json({ error: 'Could not submit your application. Please try again.' });

    try {
      await require('../lib/audit').record({
        req, action: 'MET_APPLICATION_SUBMITTED', category: 'RECRUITMENT',
        targetType: 'met_application', targetId: row.id,
        summary: 'MET Constable application submitted (' + row.appRef + ').',
        metadata: { appRef: row.appRef, robloxId: String(user.robloxId) },
      });
    } catch (e) { /* submission remains valid if audit logging is unavailable */ }

    res.status(201).json({ ok: true, appRef: row.appRef, submittedAt: row.submittedAt });
  } catch (e) {
    console.error('[MET application] submit error:', e.message);
    res.status(500).json({ error: 'Could not submit your application.' });
  }
});

module.exports = router;
