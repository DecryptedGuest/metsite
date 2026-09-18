'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const XP = require('../../server/lib/xp');

test('superintendent names are capped at the chief inspector XP ceiling', async () => {
  const names = ['Superintendent', 'Chief Superintendent', 'Commander'];

  for (const name of names) {
    const hit = await XP.rungForGroupRank({ name, rank: 0 });
    assert.ok(hit, `${name} should resolve to a rung`);
    assert.equal(hit.code, 'CINS', `${name} should cap at Chief Inspector`);
    assert.equal(hit.at, 100, `${name} should use the maximum XP value`);
  }
});
