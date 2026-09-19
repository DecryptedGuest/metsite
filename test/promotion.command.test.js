'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { applyPromotion } = require('../server/lib/promoteCommand');
const roblox = require('../server/lib/roblox');
const bot = require('../server/lib/bot');
const XP = require('../server/lib/xp');
const XPLog = require('../server/lib/xpLog');

test('failed group rank change does not mark XP, DM, or log as failed attempts', async () => {
  const originalChangeGroupRank = roblox.changeGroupRank;
  const originalRungForGroupRank = XP.rungForGroupRank;
  const originalDmMemberNotice = bot.dmMemberNotice;
  const originalLogPromotion = XPLog.logPromotion;
  const originalLogDemotion = XPLog.logDemotion;

  try {
    roblox.changeGroupRank = async () => { throw new Error('Roblox API 400: "You cannot change the user..."'); };
    XP.rungForGroupRank = async () => { throw new Error('should not run'); };
    bot.dmMemberNotice = async () => { throw new Error('should not run'); };
    XPLog.logPromotion = async () => { throw new Error('should not run'); };
    XPLog.logDemotion = async () => { throw new Error('should not run'); };

    const out = await applyPromotion({
      robloxId: 123,
      targetId: '456',
      username: 'auzvinda',
      issuerName: 'qqverx',
      issuerId: '789',
      reason: 'Test failure',
      avatar: 'https://example.com/avatar.png',
      direction: 'up',
      from: { name: 'Sergeant', rank: 11 },
      to: { id: 12, name: 'Inspector', rank: 12 },
    }, { });

    assert.equal(out.group.ok, false);
    assert.equal(out.xp.ok, null);
    assert.equal(out.dm, null);
    assert.equal(out.logged, null);
  } finally {
    roblox.changeGroupRank = originalChangeGroupRank;
    XP.rungForGroupRank = originalRungForGroupRank;
    bot.dmMemberNotice = originalDmMemberNotice;
    XPLog.logPromotion = originalLogPromotion;
    XPLog.logDemotion = originalLogDemotion;
  }
});
