// test/tryout/automatedTryout.test.js — run with:  node --test test/tryout
//
// The embed reads the stored row, never the raw request body. The body carries
// host.name; the embed reads hostName, so feeding it the body showed every
// tryout as hosted by "INSTRUCTOR" with no co host.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installStubs } = require('./stubs');

installStubs();
const at = require('../../server/lib/automatedTryout');

const BODY = {
  sessionId: 'ps_123',
  division: 'HPC',
  host: { type: 'npc', name: 'Sergeant Hale' },
  coHost: { name: 'PC Okafor' },
  attendee: {
    userId: '4455667788', username: 'realangeloo', result: 'passed',
    strikes: 1, strikeReasons: ['spoke out of turn'], quizScore: 9, quizTotal: 10,
    flags: ['alt suspected'], failReason: null,
  },
};

const ROW = {
  id: 'row-1', division: 'HPC', hostName: 'Sergeant Hale', coHostName: 'PC Okafor',
  attendeeRobloxId: '4455667788', attendeeName: 'realangeloo', result: 'passed',
  strikes: 1, quizScore: 9, quizTotal: 10, flags: 'alt suspected',
  startedAt: new Date('2026-09-12T16:00:00.000Z'),
  endedAt: new Date('2026-09-12T16:28:00.000Z'),
  payload: JSON.stringify(BODY),
};

function fields(row, payload, actioned) {
  const j = at.buildEmbed(at.viewFromRow(row, payload), actioned || null).toJSON();
  return Object.fromEntries(j.fields.map(f => [f.name, f.value]));
}

test('the host and co host come through from the stored row', () => {
  const f = fields(ROW, BODY);
  assert.equal(f.Host, 'Sergeant Hale');
  assert.equal(f['Co host'], 'PC Okafor');
});

test('the trainee, result and quiz are rendered', () => {
  const f = fields(ROW, BODY);
  assert.match(f.Trainee, /realangeloo/);
  assert.match(f.Trainee, /4455667788/);
  assert.equal(f.Result, 'Passed');
  assert.equal(f.Quiz, '9 of 10');
  assert.equal(f.Strikes, '1');
});

test('an unset co host reads as none rather than undefined', () => {
  const f = fields({ ...ROW, coHostName: null }, BODY);
  assert.equal(f['Co host'], 'none');
});

test('a missing quiz reads as not taken', () => {
  const f = fields({ ...ROW, quizScore: null, quizTotal: null }, BODY);
  assert.equal(f.Quiz, 'not taken');
});

test('strike reasons and the fail reason come from the payload', () => {
  const body = { attendee: { strikeReasons: ['late', 'out of uniform'], failReason: 'did not follow instructions' } };
  const f = fields({ ...ROW, result: 'failed' }, body);
  assert.match(f['Strike reasons'], /late/);
  assert.match(f['Strike reasons'], /out of uniform/);
  assert.equal(f['Fail reason'], 'did not follow instructions');
});

test('a corrupt payload still renders from the columns alone', () => {
  for (const bad of [{}, null, undefined, [1, 2, 3]]) {
    const f = fields(ROW, bad);
    assert.equal(f.Host, 'Sergeant Hale');
    assert.equal(f.Flags, 'alt suspected', 'flags fall back to the stored column');
  }
});

test('an unreadable timestamp reads as unknown instead of throwing', () => {
  const f = fields({ ...ROW, startedAt: new Date('nonsense'), endedAt: null }, BODY);
  assert.equal(f.Ran, 'unknown to unknown');
});

test('an actioned tryout names who actioned it', () => {
  const f = fields(ROW, BODY, { kind: 'approve', byId: '999', reason: 'Ranked to PCSO.' });
  assert.match(f['Ranked by'], /<@999>/);
  assert.match(f['Ranked by'], /Ranked to PCSO/);
});

test('a rejected tryout is labelled as rejected', () => {
  const f = fields(ROW, BODY, { kind: 'reject', byId: '999' });
  assert.ok(f['Rejected by'], 'a rejection names the rejecter');
  assert.equal(f['Ranked by'], undefined);
});

test('every embed field carries a non empty value', () => {
  // discord.js throws on an empty field value, which would lose the whole log.
  for (const row of [ROW, { ...ROW, coHostName: null, quizScore: null, quizTotal: null, flags: null, strikes: 0 }]) {
    const j = at.buildEmbed(at.viewFromRow(row, {}), null).toJSON();
    for (const f of j.fields) {
      assert.ok(String(f.value).trim().length > 0, 'empty value for field ' + f.name);
    }
  }
});

test('the buttons are addressed to the record they belong to', () => {
  const row = at.buildRow('row-1', false).toJSON();
  const ids = row.components.map(c => c.custom_id);
  assert.deepEqual(ids, ['atr_ok_row-1', 'atr_no_row-1']);
  // Both prefixes are seven characters, which is what the handler slices off.
  for (const id of ids) assert.equal(id.slice(7), 'row-1');
});
