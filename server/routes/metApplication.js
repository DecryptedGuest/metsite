// MET recruitment application submissions and server-side eligibility.
const express = require('express');
const router = express.Router();
const prisma = require('../lib/db');

const MET_GROUP_ID = '17275620';
const SAS_GROUP_ID = '15614475';
const GROUP_URL = 'https://www.roblox.com/communities/17275620/Metropolitan-Police-SLR#!/about';

const QUESTIONS = {
  q1: { type: 'agreement' }, q2: { type: 'agreement' },
  q3: { min: 20, max: 2500 }, q4: { min: 20, max: 2500 },
  q5: { min: 1, max: 1500 }, q6: { min: 20, max: 2500 },
  q7: { type: 'activity' }, q8: { min: 20, max: 2500 },
  q9: { min: 20, max: 2500 }, q10: { type: 'agreement' },
};

async function checkGroup(user, groupId, cachedMet = false) {
  if (!user || !user.robloxId) return { member: false, available: true };
  if (cachedMet && user.metRankNatural && user.metRankNatural.name) return { member: true, available: true };
  try {
    const { getUserGroupRoles } = require('../lib/roblox');
    const diag = {};
    const roles = await getUserGroupRoles(String(user.robloxId), String(groupId), diag);
    if (diag.failed) return { member: null, available: false };
    return { member: Array.isArray(roles) && roles.length > 0, available: true };
  } catch (e) {
    console.warn('[MET application] Roblox eligibility check unavailable:', e.message);
    return { member: null, available: false };
  }
}

async function eligibility(user) {
  const [met, sas, cases] = await Promise.all([
    checkGroup(user, MET_GROUP_ID, true),
    checkGroup(user, SAS_GROUP_ID),
    prisma.case.findMany({
      where: { robloxUserId: String(user.robloxId || ''), status: 'APPROVED' },
      select: { caseRef: true, action: true, reason: true, actions: true },
      take: 100,
    }),
  ]);
  const restrictions = [];
  if (user.isBlacklisted) restrictions.push({ code: 'SITE_BLACKLIST', label: 'This account is currently blacklisted.' });
  if (user.mustReauth) restrictions.push({ code: 'ACCOUNT_REVIEW', label: 'This account requires an access review.' });
  if (met.member === true) restrictions.push({ code: 'ALREADY_MET', label: 'This Roblox account is already a member of the MET group.' });
  if (sas.member === true) restrictions.push({ code: 'SAS_MEMBER', label: 'This Roblox account is a member of the SAS group.' });
  const barred = cases.filter(c => {
    const text = [c.action, c.reason, JSON.stringify(c.actions || {})].join(' ').toUpperCase();
    return /BLACKLIST|TERMINAT|EXILE|PERMANENT BAN/.test(text);
  });
  if (barred.length) restrictions.push({ code: 'DISCIPLINARY_BAR', label: 'An active approved disciplinary record prevents this account from applying.' });
  return {
    eligible: restrictions.length === 0 && met.available && sas.available,
    restrictions, met, sas,
    checksAvailable: met.available && sas.available,
    barredCases: barred.map(c => ({ caseRef: c.caseRef, action: c.action })),
  };
}

async function nextRef(attempt = 0) {
  const latest = await prisma.metApplication.findFirst({ where: { appRef: { startsWith: 'MET-' } }, orderBy: { appRef: 'desc' }, select: { appRef: true } });
  const highest = latest ? parseInt(String(latest.appRef).replace(/\D/g, ''), 10) : 0;
  return 'MET-' + String((Number.isFinite(highest) ? highest : 0) + 1 + attempt).padStart(4, '0');
}

router.get('/meta', async (req, res) => {
  try {
    const user = req.user;
    res.set('Cache-Control', 'no-store');
    if (!user.robloxId) return res.json({ canApply: false, needsRobloxLink: true, message: 'Link your Roblox account before applying.', groupUrl: GROUP_URL });
    const [check, existing] = await Promise.all([
      eligibility(user),
      prisma.metApplication.findFirst({ where: { applicantId: user.id, status: 'SUBMITTED' }, select: { appRef: true, submittedAt: true, status: true } }),
    ]);
    res.json({
      canApply: check.eligible && !existing,
      eligibility: { eligible: check.eligible, restrictions: check.restrictions, checksAvailable: check.checksAvailable },
      isMember: check.met.member,
      membershipCheckAvailable: check.met.available,
      sasCheckAvailable: check.sas.available,
      groupUrl: GROUP_URL, pendingRequestCheckAvailable: false, existing,
      robloxUsername: user.robloxUsername || null,
      groupStepRequired: check.met.member !== true,
    });
  } catch (e) {
    console.error('[MET application] meta error:', e.message);
    res.status(500).json({ error: 'Could not load application eligibility.' });
  }
});

router.post('/submit', async (req, res) => {
  try {
    const user = req.user;
    if (!user.robloxId) return res.status(400).json({ error: 'Link your Roblox account before applying.' });
    const check = await eligibility(user);
    if (!check.checksAvailable) return res.status(503).json({ error: 'We cannot verify Roblox group eligibility right now. Please try again later.' });
    if (!check.eligible) return res.status(403).json({ error: check.restrictions[0]?.label || 'This account is not eligible to apply.' });

    const existing = await prisma.metApplication.findFirst({ where: { applicantId: user.id, status: 'SUBMITTED' }, select: { appRef: true } });
    if (existing) return res.status(409).json({ error: 'You already have an application awaiting review.', appRef: existing.appRef });

    const answers = req.body && req.body.answers;
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return res.status(400).json({ error: 'Please complete every question.' });
    for (const [id, rule] of Object.entries(QUESTIONS)) {
      const value = answers[id];
      if (rule.type === 'agreement' && value !== true) return res.status(400).json({ error: 'You must agree to every required declaration.' });
      if (rule.type === 'activity' && (!Number.isInteger(Number(value)) || Number(value) < 0 || Number(value) > 10)) return res.status(400).json({ error: 'Choose an activity rating from 0 to 10.' });
      if (!rule.type) {
        const answer = String(value || '').trim();
        if (answer.length < rule.min || answer.length > rule.max) return res.status(400).json({ error: 'Please complete every written answer (minimum 20 characters).' });
      }
    }
    const groupRequestConfirmed = req.body.groupRequestConfirmed === true;
    if (!groupRequestConfirmed) return res.status(400).json({ error: 'Confirm that you have requested to join the MET Roblox group.' });

    let row = null;
    for (let attempt = 0; !row && attempt < 8; attempt++) {
      try {
        row = await prisma.metApplication.create({ data: {
          appRef: await nextRef(attempt), applicantId: user.id,
          discordId: String(user.discordId || ''), discordUsername: user.discordUsername || null,
          robloxId: String(user.robloxId), robloxUsername: user.robloxUsername || null,
          answers: { q1: true, q2: true, q3: String(answers.q3).trim(), q4: String(answers.q4).trim(), q5: String(answers.q5).trim(), q6: String(answers.q6).trim(), q7: Number(answers.q7), q8: String(answers.q8).trim(), q9: String(answers.q9).trim(), q10: true },
          groupRequestConfirmed, status: 'SUBMITTED',
        } });
      } catch (e) { if (e && e.code === 'P2002') continue; throw e; }
    }
    if (!row) return res.status(500).json({ error: 'Could not submit your application. Please try again.' });

    try {
      await require('../lib/audit').record({ req, action: 'MET_APPLICATION_SUBMITTED', category: 'RECRUITMENT', targetType: 'met_application', targetId: row.id, summary: 'MET application submitted (' + row.appRef + ').', metadata: { appRef: row.appRef, robloxId: String(user.robloxId) } });
    } catch (e) {}
    try {
      await require('../lib/bot').dmMemberNotice(user.discordId, {
        color: 0x64748b, title: 'MET Application Received',
        description: 'Your MET Application **' + row.appRef + '** has been received and is awaiting review by Hendon Police College.',
        footer: 'Metropolitan Police Service · Recruitment',
      });
    } catch (e) { console.warn('[MET application] receipt DM unavailable:', e.message); }
    res.status(201).json({ ok: true, appRef: row.appRef, submittedAt: row.submittedAt });
  } catch (e) {
    console.error('[MET application] submit error:', e.message);
    res.status(500).json({ error: 'Could not submit your application.' });
  }
});

module.exports = router;
