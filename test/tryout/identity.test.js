// test/tryout/identity.test.js — run with:  node --test test/tryout
//
// Eligibility no longer asks whether somebody linked an account to the portal.
// It asks whether they are in the MET Discord server, and recognises them by
// their Roblox username sitting in their server nickname ("PC 442 | angelo").
//
// identity.resolved drives the in game prompt, so it has to be false whenever
// we could not confidently name one member, and true only on a confident match.
// "Nobody matched" is not the same as "they are not in the server": it is
// undetermined, because they may be in there under a nickname we cannot read.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { installStubs, state, reset } = require('./stubs');

installStubs();

// The MET server, as the bot would report it.
const server = { members: null };
const botPath = require.resolve(path.join(__dirname, '..', '..', 'server', 'lib', 'bot.js'));
require.cache[botPath] = {
  id: botPath, filename: botPath, loaded: true,
  exports: { listMetServerMembers: async () => server.members },
};

delete process.env.ROBLOX_COOKIE;
delete process.env.ROBLOX_GROUP_COOKIE;
const { checkEligibility } = require('../../server/lib/tryoutEligibility');

const ID = '3439167760';
const member = (over) => ({ id: '100', username: 'someone', globalName: null, nickname: null, displayName: 'someone', ...over });

function setServer(members) { server.members = members; }

async function check(opts) {
  reset({ groupRole: { id: 55, rank: 1, name: 'PCSO' } });   // in the MET group, not blacklisted
  return checkEligibility(ID, { username: 'realangeloo', ...(opts || {}) });
}

test('one nickname carrying the username resolves them', async () => {
  setServer([member({ id: '111', nickname: 'PC 442 | realangeloo' }), member({ id: '222', nickname: 'CSO 118 | someuser' })]);
  const r = await check();
  assert.equal(r.identity.resolved, true);
  assert.equal(r.identity.matchedBy, 'nickname');
  assert.equal(r.identity.discordId, '111');
  assert.equal(r.checks.inMetServer, true);
  assert.deepEqual(r.undetermined.filter(k => k === 'inMetServer'), []);
  assert.equal(r.eligible, true);
});

test('nobody in the server is undetermined, not absent', async () => {
  setServer([member({ id: '222', nickname: 'CSO 118 | someuser' })]);
  const r = await check();
  assert.equal(r.identity.resolved, false);
  assert.equal(r.checks.inMetServer, null);
  assert.ok(r.undetermined.includes('inMetServer'));
});

test('a member whose nickname does not carry the username is not a match', async () => {
  setServer([member({ id: '333', username: 'realangeloo', nickname: 'PC 9 | someoneelse' })]);
  const r = await check();
  assert.equal(r.identity.resolved, false);
});

test('a member with no nickname at all cannot be matched by nickname', async () => {
  // displayName falls back to the Discord name, which is not the server
  // nickname and must not stand in for one.
  setServer([member({ id: '444', username: 'realangeloo', nickname: null, displayName: 'realangeloo' })]);
  const r = await check();
  assert.equal(r.identity.resolved, false);
});

test('two members carrying the username resolve to neither', async () => {
  setServer([member({ id: '111', nickname: 'PC 442 | realangeloo' }), member({ id: '555', nickname: 'CSO 7 | realangeloo' })]);
  const r = await check();
  assert.equal(r.identity.resolved, false);
  assert.equal(r.checks.inMetServer, null);
});

test('a short username does not swallow longer nicknames', async () => {
  setServer([member({ id: '666', nickname: 'PC 1 | bobby' }), member({ id: '777', nickname: 'PC 2 | bobbington' })]);
  reset({ groupRole: { id: 55, rank: 1, name: 'PCSO' } });
  const r = await checkEligibility(ID, { username: 'bob' });
  assert.equal(r.identity.resolved, false, 'bob must not match bobby or bobbington');
});

test('an underscore stays part of the username', async () => {
  setServer([member({ id: '888', nickname: 'PC 3 | real_angeloo' })]);
  reset({ groupRole: { id: 55, rank: 1, name: 'PCSO' } });
  const r = await checkEligibility(ID, { username: 'real_angeloo' });
  assert.equal(r.identity.resolved, true);
  assert.equal(r.identity.discordId, '888');
});

test('a hint that finds a member carrying the username resolves them', async () => {
  setServer([member({ id: '111', username: 'angelo', nickname: 'PC 442 | realangeloo' }), member({ id: '222', nickname: 'CSO 118 | someuser' })]);
  const r = await check({ hint: 'angelo' });
  assert.equal(r.identity.resolved, true);
  assert.equal(r.identity.matchedBy, 'hint');
  assert.equal(r.checks.inMetServer, true);
});

test('a raw Discord id works as a hint', async () => {
  setServer([member({ id: '123456789012345678', nickname: 'PC 442 | realangeloo' })]);
  const r = await check({ hint: '123456789012345678' });
  assert.equal(r.identity.resolved, true);
  assert.equal(r.identity.matchedBy, 'hint');
});

test('a hint cannot vouch for a member whose nickname does not carry the username', async () => {
  setServer([member({ id: '999', username: 'someoneelse', nickname: 'PC 9 | someoneelse' })]);
  const r = await check({ hint: 'someoneelse' });
  assert.equal(r.identity.resolved, false, 'the hint finds candidates, it does not vouch for them');
  assert.match(r.reasons.join(' '), /does not have your Roblox username/);
});

test('a hint matching nobody says so', async () => {
  setServer([member({ id: '111', nickname: 'PC 442 | realangeloo' })]);
  const r = await check({ hint: 'nobody-at-all' });
  assert.equal(r.identity.resolved, false);
  assert.match(r.reasons.join(' '), /could not find that Discord account/);
});

test('Discord being unreachable is undetermined', async () => {
  setServer(null);
  const r = await check();
  assert.equal(r.identity.resolved, false);
  assert.equal(r.checks.inMetServer, null);
  assert.ok(r.undetermined.includes('inMetServer'));
  assert.deepEqual(r.reasons, [], 'the game prompts on the first call, so nothing is spoken yet');
});

test('an outage after the player has been prompted says so, rather than blaming them', async () => {
  setServer(null);
  const r = await check({ hint: 'angelo' });
  assert.equal(r.identity.resolved, false);
  assert.match(r.reasons.join(' '), /cannot check the MET Discord server right now/);
  assert.doesNotMatch(r.reasons.join(' '), /could not find that Discord account/);
});

test('a signed in portal user is matched by their own Discord id', async () => {
  setServer([member({ id: '111', nickname: 'PC 442 | realangeloo' })]);
  const r = await check({ discordId: '111' });
  assert.equal(r.identity.resolved, true);
  assert.equal(r.identity.matchedBy, 'session');
  assert.equal(r.checks.inMetServer, true);
});

test('a signed in portal user who has left the server is definitely absent', async () => {
  setServer([member({ id: '222', nickname: 'CSO 118 | someuser' })]);
  const r = await check({ discordId: '111' });
  assert.equal(r.checks.inMetServer, false, 'we know exactly who they are, so this is a no, not an unknown');
  assert.equal(r.eligible, false);
  assert.ok(!r.undetermined.includes('inMetServer'));
});

test('every spoken reason is free of dashes and markup', async () => {
  const seen = [];
  setServer([member({ id: '999', username: 'someoneelse', nickname: 'PC 9 | someoneelse' })]);
  seen.push(...(await check({ hint: 'someoneelse' })).reasons);
  seen.push(...(await check({ hint: 'nobody' })).reasons);
  setServer([member({ id: '222', nickname: 'CSO 118 | someuser' })]);
  seen.push(...(await check({ discordId: '111' })).reasons);
  reset({ blacklistSources: [{ reason: 'exploiting' }], groupRole: { id: 55, rank: 1, name: 'PCSO' } });
  setServer([member({ id: '111', nickname: 'PC 442 | realangeloo' })]);
  seen.push(...(await checkEligibility(ID, { username: 'realangeloo' })).reasons);

  assert.ok(seen.length >= 4, 'expected reasons to test, got ' + seen.length);
  for (const r of seen) {
    assert.doesNotMatch(r, /[-–—]/, 'a spoken reason must carry no dash of any kind: ' + JSON.stringify(r));
    assert.doesNotMatch(r, /[*_`#\[\]]|https?:\/\//, 'a spoken reason must be plain text: ' + JSON.stringify(r));
  }
});

test('undetermined still names exactly the checks that came back null', async () => {
  setServer([member({ id: '222', nickname: 'CSO 118 | someuser' })]);
  const r = await check();
  const nulls = Object.entries(r.checks)
    .filter(([k, v]) => v === null && k !== 'multiAccountDetail')
    .map(([k]) => k);
  assert.deepEqual(r.undetermined.slice().sort(), nulls.sort());
});
