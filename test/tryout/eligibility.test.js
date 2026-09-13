// test/tryout/eligibility.test.js — run with:  node --test test/tryout
//
// The gate is three valued on purpose. "Could not tell" must never read as
// "no", because the people it turns away are exactly the people it exists to
// let in: applicants who are waiting to be accepted into the MET group.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installStubs, state, reset } = require('./stubs');

installStubs();

// The MET server membership check, stubbed so these tests are about the group
// and blacklist rules rather than about identity. identity.test.js covers that.
const server = { members: [{ id: '111', username: 'ang', globalName: null,
                             nickname: 'PC 442 | realangeloo', displayName: 'PC 442 | realangeloo' }] };
const botPath = require.resolve(require('path').join(__dirname, '..', '..', 'server', 'lib', 'bot.js'));
require.cache[botPath] = { id: botPath, filename: botPath, loaded: true,
  exports: { listMetServerMembers: async () => server.members } };

delete process.env.ROBLOX_COOKIE;
delete process.env.ROBLOX_GROUP_COOKIE;
const { checkEligibility } = require('../../server/lib/tryoutEligibility');

const LINKED = [{ id: 1, discordId: '111', discordUsername: 'ang', robloxUsername: 'realangeloo' }];
const ID = '4455667788';

test('a bad id is refused before any lookup', async () => {
  reset();
  const r = await checkEligibility('not-a-number');
  assert.equal(r.ok, false);
  assert.match(r.error, /numeric Roblox user id/);
});

test('an applicant waiting to be accepted is eligible, not refused', async () => {
  reset({ portalUsers: LINKED });
  const r = await checkEligibility(ID, { username: 'realangeloo' });
  assert.equal(r.eligible, true);
  assert.equal(r.checks.metPending, null, 'no group cookie means we cannot see join requests');
  assert.ok(r.undetermined.includes('metPending'));
  assert.deepEqual(r.reasons, [], 'we must not claim they have no pending request');
});

test('a member of the MET group is eligible', async () => {
  reset({ portalUsers: LINKED, groupRole: { id: 55, rank: 1, name: 'PCSO' } });
  const r = await checkEligibility(ID, { username: 'realangeloo' });
  assert.equal(r.eligible, true);
  assert.equal(r.checks.metPending, true);
  assert.equal(r.checks.inMetServer, true);
  assert.deepEqual(r.undetermined, []);
});

test('somebody we cannot identify is undetermined rather than refused', async () => {
  // The rule is MET server membership now. Nobody carrying this username in a
  // nickname does not mean they are absent: the game prompts them instead.
  reset();
  server.members = [{ id: '222', username: 'other', globalName: null,
                      nickname: 'CSO 118 | someuser', displayName: 'CSO 118 | someuser' }];
  const r = await checkEligibility(ID, { username: 'realangeloo' });
  assert.equal(r.identity.resolved, false);
  assert.equal(r.checks.inMetServer, null);
  assert.ok(r.undetermined.includes('inMetServer'));
  assert.deepEqual(r.reasons, [], 'nothing is asserted about them, so nothing is said to them');
  server.members = [{ id: '111', username: 'ang', globalName: null,
                      nickname: 'PC 442 | realangeloo', displayName: 'PC 442 | realangeloo' }];
});

test('a blacklisted account is refused', async () => {
  reset({ portalUsers: LINKED, groupRole: { id: 55, rank: 1, name: 'PCSO' },
          blacklistSources: [{ reason: 'mass exploiting' }] });
  const r = await checkEligibility(ID, { username: 'realangeloo' });
  assert.equal(r.eligible, false);
  assert.equal(r.checks.blacklisted, true);
  assert.match(r.reasons.join(' '), /blacklisted/);
});

test('a clean account reports no alt rather than an unknown one', async () => {
  reset({ portalUsers: LINKED, groupRole: { id: 55, rank: 1, name: 'PCSO' } });
  const r = await checkEligibility(ID, { username: 'realangeloo' });
  assert.equal(r.checks.multiAccount, false);
  assert.ok(!r.undetermined.includes('multiAccount'));
});

test('a second Roblox account on the same Discord is flagged but not barred', async () => {
  reset({
    portalUsers: LINKED,
    otherRoblox: [{ discordId: '111', robloxId: '999', robloxUsername: 'altaccount' }],
    groupRole: { id: 55, rank: 1, name: 'PCSO' },
  });
  const r = await checkEligibility(ID, { username: 'realangeloo' });
  assert.equal(r.checks.multiAccount, true);
  assert.match(r.checks.multiAccountDetail, /altaccount/);
  assert.equal(r.eligible, true, 'an alt is for an instructor to judge, not a bar');
});

test('a database outage asserts nothing and does not turn anyone away', async () => {
  reset({ portalThrows: true });
  const r = await checkEligibility(ID, { username: 'realangeloo' });
  assert.equal(r.eligible, true);
  assert.equal(r.checks.multiAccount, null);
  assert.deepEqual(r.reasons, []);
  assert.ok(r.undetermined.includes('multiAccount'));
});

test('undetermined names exactly the checks that came back null', async () => {
  reset({ portalUsers: LINKED });
  const r = await checkEligibility(ID, { username: 'realangeloo' });
  const nulls = Object.entries(r.checks)
    .filter(([k, v]) => v === null && k !== 'multiAccountDetail')
    .map(([k]) => k);
  assert.deepEqual(r.undetermined.slice().sort(), nulls.sort());
});

test('a blacklist check that could not run refuses rather than waving them through', async () => {
  // The one check that fails CLOSED. gatherRecord degrades rather than throwing,
  // so an unreadable case table used to come back as "no sources found" and
  // therefore "not blacklisted", which is the same answer a clean account gets.
  reset({ portalUsers: LINKED, groupRole: { id: 55, rank: 1, name: 'PCSO' }, blacklistDegraded: ['cases'] });
  const r = await checkEligibility(ID, { username: 'realangeloo' });
  assert.equal(r.checks.blacklisted, null, 'unreadable is not the same as clean');
  assert.equal(r.eligible, false, 'a tryout must not admit somebody whose blacklist was never checked');
  assert.ok(r.undetermined.includes('blacklisted'));
  assert.match(r.reasons.join(' '), /could not check the blacklist/);
});

test('a clean record still reads as clean', async () => {
  reset({ portalUsers: LINKED, groupRole: { id: 55, rank: 1, name: 'PCSO' } });
  const r = await checkEligibility(ID, { username: 'realangeloo' });
  assert.equal(r.checks.blacklisted, false);
  assert.equal(r.eligible, true);
});

test('every spoken reason stays free of dashes and markup', async () => {
  reset({ portalUsers: LINKED, groupRole: { id: 55, rank: 1, name: 'PCSO' }, blacklistDegraded: ['cases'] });
  const degraded = (await checkEligibility(ID, { username: 'realangeloo' })).reasons;
  reset({ portalUsers: LINKED, blacklistSources: [{ reason: 'mass exploiting' }] });
  const listed = (await checkEligibility(ID, { username: 'realangeloo' })).reasons;
  for (const r of [...degraded, ...listed]) {
    assert.doesNotMatch(r, /[-–—]/, 'a spoken reason carries no dash: ' + JSON.stringify(r));
  }
});
