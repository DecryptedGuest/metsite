// test/tryout/gameDate.test.js — run with:  node --test test/tryout
//
// Timestamps arrive from the Roblox side as ISO strings, epoch seconds (what
// os.time() gives) or epoch milliseconds, as numbers or as text. Prisma throws
// on an invalid date, so anything unreadable has to become null: a stamp we
// cannot parse must never cost the record it came with, and a concluded tryout
// must always produce a log.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installStubs } = require('./stubs');

installStubs();
const { gameDate } = require('../../server/lib/tryoutLogs');

const WANT = '2026-09-12T16:00:00.000Z';

test('an ISO string comes back as itself', () => {
  assert.equal(gameDate(WANT).toISOString(), WANT);
});

test('epoch seconds and milliseconds both resolve, as numbers or as text', () => {
  for (const v of [1789228800, '1789228800', 1789228800000, '1789228800000', ' 1789228800 ']) {
    assert.equal(gameDate(v).toISOString(), WANT, 'failed for ' + JSON.stringify(v));
  }
});

test('a Date passes through, an invalid one does not', () => {
  const d = new Date(WANT);
  assert.equal(gameDate(d).toISOString(), WANT);
  assert.equal(gameDate(new Date('not a date')), null);
});

test('nothing unreadable ever becomes a date', () => {
  for (const v of ['yesterday', 'soon', '', '   ', null, undefined, {}, [], NaN, Infinity, -Infinity]) {
    assert.equal(gameDate(v), null, 'should be null for ' + JSON.stringify(v));
  }
});

test('zero and negative numbers are refused rather than reinterpreted', () => {
  // These used to fall through to string parsing, where "0" reads as the year
  // 2000 and "-5" as 2001. Both are nonsense dates presented as real ones.
  for (const v of [0, '0', -5, '-5', -1789228800]) {
    assert.equal(gameDate(v), null, 'should be null for ' + JSON.stringify(v));
  }
});

test('a plausible year is treated as an epoch, not a year', () => {
  // Wholly numeric input is always an epoch. "2026" is not a timestamp in any
  // of the three documented forms, so it lands in 1970 rather than quietly
  // becoming a date in the future that nobody sent.
  assert.equal(gameDate('2026').getUTCFullYear(), 1970);
});
