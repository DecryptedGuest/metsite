'use strict';

const express = require('express');
const prisma = require('../lib/db');

const router = express.Router();

const PLACE_ID = () => String(process.env.TRYOUT_JOIN_PLACE_ID || '111602481402239');

function launchLink(payload) {
  const data = encodeURIComponent(JSON.stringify(payload));
  return `https://www.roblox.com/games/start?placeId=${PLACE_ID()}&launchData=${data}`;
}

router.get('/me', async (req, res) => {
  try {
    const me = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { robloxId: true, robloxUsername: true, discordUsername: true, displayName: true },
    });
    if (!me || !me.robloxId) {
      return res.json({
        ok: true,
        linked: false,
        eligible: false,
        reasons: ['Your Roblox account is not linked yet. Verify with RoVer in the Discord server, then reload this page.'],
        checks: null,
      });
    }
    const { checkEligibility } = require('../lib/tryoutEligibility');
    const out = await checkEligibility(me.robloxId, { username: me.robloxUsername });
    res.json({ ...out, linked: true, username: me.robloxUsername || out.username });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Could not check your eligibility just now.' });
  }
});

router.post('/request', async (req, res) => {
  try {
    const me = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { robloxId: true, robloxUsername: true },
    });
    if (!me || !me.robloxId) {
      return res.status(400).json({ ok: false, error: 'Link your Roblox account first.' });
    }
    const { checkEligibility } = require('../lib/tryoutEligibility');
    const elig = await checkEligibility(me.robloxId, { username: me.robloxUsername });
    if (!elig.ok || !elig.eligible) {
      return res.status(403).json({ ok: false, error: 'You are not eligible right now.', reasons: elig.reasons || [] });
    }
    const division = String(req.body && req.body.division ? req.body.division : 'HPC').toUpperCase();
    res.json({
      ok: true,
      placeId: PLACE_ID(),
      launchData: { d: division },
      link: launchLink({ d: division }),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Could not start a tryout just now.' });
  }
});

module.exports = router;
