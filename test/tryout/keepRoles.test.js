// test/tryout/keepRoles.test.js — run with:  node --test test/tryout
//
// A blacklist strips MET rank roles but must leave the identity roles alone.
// Verified in particular is what RoVer and onboarding hang off, so taking it is
// disproportionate and annoying to undo.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installStubs } = require('./stubs');

installStubs();
const bot = require('../../server/lib/bot');

function kept(name) {
  return bot.keptRoleNames().has(bot.normaliseRoleName(name));
}

test('decoration on a role name does not defeat the match', () => {
  for (const n of ['Verified', 'verified', '✅ Verified', '| Verified |', '✓ VERIFIED', '  Verified  ']) {
    assert.equal(kept(n), true, 'should keep ' + JSON.stringify(n));
  }
});

test('the British Citizen role is kept however it is written', () => {
  for (const n of ['British Citizen', 'british citizen', '🇬🇧 British Citizen', '• British Citizen •', 'British Citizens']) {
    assert.equal(kept(n), true, 'should keep ' + JSON.stringify(n));
  }
});

test('the near miss spellings a server actually uses are kept', () => {
  for (const n of ['Citizen', 'Citizens', 'Verified Member', 'Verified Members']) {
    assert.equal(kept(n), true, 'should keep ' + JSON.stringify(n));
  }
});

test('Unverified is not mistaken for Verified', () => {
  assert.equal(kept('Unverified'), false);
});

test('MET rank roles are still stripped', () => {
  for (const n of ['Police Constable', 'Sergeant', 'Inspector', 'HPC Cadet', 'CID Detective',
                   'Firearms Constable', 'Community Support Officer', 'Blacklisted', 'Chief Superintendent']) {
    assert.equal(kept(n), false, 'should strip ' + JSON.stringify(n));
  }
});

test('a server can add its own role names through the environment', () => {
  const before = process.env.DISCIPLINE_KEEP_ROLE_NAMES;
  process.env.DISCIPLINE_KEEP_ROLE_NAMES = '🏅 Long Service, Donator';
  try {
    assert.equal(kept('Long Service'), true);
    assert.equal(kept('Donator'), true);
    assert.equal(kept('Sergeant'), false, 'the override must not widen past what it names');
  } finally {
    if (before === undefined) delete process.env.DISCIPLINE_KEEP_ROLE_NAMES;
    else process.env.DISCIPLINE_KEEP_ROLE_NAMES = before;
  }
});

test('normalising a name that is only decoration yields nothing to match', () => {
  for (const n of ['✅', '• • •', '12345', '', null, undefined]) {
    assert.equal(bot.normaliseRoleName(n), '');
  }
  assert.equal(kept(''), false, 'an empty name must never match a keep entry');
});
