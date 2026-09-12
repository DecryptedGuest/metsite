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
  const r = await checkEligibility(ID);
  assert.equal(r.eligible, true);
  assert.equal(r.checks.metPending, null, 'no group cookie means we cannot see join requests');
  assert.ok(r.undetermined.includes('metPending'));
  assert.deepEqual(r.reasons, [], 'we must not claim they have no pending request');
});

test('a member of the MET group is eligible', async () => {
  reset({ portalUsers: LINKED, groupRole: { id: 55, rank: 1, name: 'PCSO' } });
  const r = await checkEligibility(ID);
  assert.equal(r.eligible, true);
  assert.equal(r.checks.metPending, true);
  assert.deepEqual(r.undetermined, []);
});

test('an unlinked account is refused, with only the reason that applies', async () => {
  reset();
  const r = await checkEligibility(ID);
  assert.equal(r.eligible, false);
  assert.equal(r.checks.discordLinked, false);
  assert.equal(r.reasons.length, 1);
  assert.match(r.reasons[0], /not linked a Discord account/);
});

test('a blacklisted account is refused', async () => {
  reset({ portalUsers: LINKED, groupRole: { id: 55, rank: 1, name: 'PCSO' },
          blacklistSources: [{ reason: 'mass exploiting' }] });
  const r = await checkEligibility(ID);
  assert.equal(r.eligible, false);
  assert.equal(r.checks.blacklisted, true);
  assert.match(r.reasons.join(' '), /blacklisted/);
});

test('a clean account reports no alt rather than an unknown one', async () => {
  reset({ portalUsers: LINKED, groupRole: { id: 55, rank: 1, name: 'PCSO' } });
  const r = await checkEligibility(ID);
  assert.equal(r.checks.multiAccount, false);
  assert.ok(!r.undetermined.includes('multiAccount'));
});

test('a second Roblox account on the same Discord is flagged but not barred', async () => {
  reset({
    portalUsers: LINKED,
    otherRoblox: [{ discordId: '111', robloxId: '999', robloxUsername: 'altaccount' }],
    groupRole: { id: 55, rank: 1, name: 'PCSO' },
  });
  const r = await checkEligibility(ID);
  assert.equal(r.checks.multiAccount, true);
  assert.match(r.checks.multiAccountDetail, /altaccount/);
  assert.equal(r.eligible, true, 'an alt is for an instructor to judge, not a bar');
});

test('a database outage asserts nothing and does not turn anyone away', async () => {
  reset({ portalThrows: true });
  const r = await checkEligibility(ID);
  assert.equal(r.eligible, true);
  assert.equal(r.checks.discordLinked, null);
  assert.equal(r.checks.multiAccount, null);
  assert.deepEqual(r.reasons, []);
  for (const k of ['discordLinked', 'multiAccount']) assert.ok(r.undetermined.includes(k));
});

test('undetermined names exactly the checks that came back null', async () => {
  reset({ portalUsers: LINKED });
  const r = await checkEligibility(ID);
  const nulls = Object.entries(r.checks)
    .filter(([k, v]) => v === null && k !== 'multiAccountDetail')
    .map(([k]) => k);
  assert.deepEqual(r.undetermined.slice().sort(), nulls.sort());
});
