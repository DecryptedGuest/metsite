// test/concurrency/standDown.test.js — run with:  node --test test/concurrency
//
// Two places insert a row after checking that no equivalent row exists, with no
// unique index in between: the final exam submission and the Internal Affairs
// application. Requests that arrive together both pass the check and both
// insert, so the one that came second stands itself down afterwards.
//
// This pins the comparison that decides which one that is. It has to be a total
// order: rows that race usually land on the same timestamp, and comparing
// timestamps alone makes every row see every other as "earlier", so they all
// stand down and the applicant is left with nothing.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

// The predicate as both routes express it in their Prisma where clause:
//   OR: [ { ts: { lt: mine.ts } }, { ts: mine.ts, id: { lt: mine.id } } ]
function findsEarlier(mine, all, ts) {
  return all.some(o => o.id !== mine.id && (
    o[ts] < mine[ts] || (Number(o[ts]) === Number(mine[ts]) && o.id < mine.id)
  ));
}
function survivors(rows, ts) {
  return rows.filter(r => !findsEarlier(r, rows, ts)).map(r => r.id);
}

const T1 = new Date('2026-09-12T18:00:00.000Z');
const T2 = new Date('2026-09-12T18:00:00.001Z');

test('two rows on the same instant leave exactly one', () => {
  assert.deepEqual(survivors([{ id: 'sub-1', createdAt: T1 }, { id: 'sub-2', createdAt: T1 }], 'createdAt'), ['sub-1']);
});

test('two rows on different instants keep the earlier one', () => {
  assert.deepEqual(survivors([{ id: 'sub-2', createdAt: T1 }, { id: 'sub-1', createdAt: T2 }], 'createdAt'), ['sub-2']);
});

test('a three way race still leaves exactly one', () => {
  const rows = [{ id: 'app-3', submittedAt: T1 }, { id: 'app-1', submittedAt: T1 }, { id: 'app-2', submittedAt: T1 }];
  assert.deepEqual(survivors(rows, 'submittedAt'), ['app-1']);
});

test('the timestamp decides before the id does', () => {
  // zzz is earlier in time, aaa is earlier by id: time has to win.
  const rows = [{ id: 'zzz', submittedAt: T1 }, { id: 'aaa', submittedAt: T2 }];
  assert.deepEqual(survivors(rows, 'submittedAt'), ['zzz']);
});

test('a lone row never stands itself down', () => {
  assert.deepEqual(survivors([{ id: 'only', createdAt: T1 }], 'createdAt'), ['only']);
});

test('comparing timestamps alone would delete every racing row', () => {
  // Why the id tiebreak exists. If this ever starts passing with one survivor,
  // the comparison has been changed and the stand-down is no longer safe.
  const rows = [{ id: 'sub-1', createdAt: T1 }, { id: 'sub-2', createdAt: T1 }];
  const naive = rows.filter(r => !rows.some(o => o.id !== r.id && o.createdAt <= r.createdAt));
  assert.equal(naive.length, 0, 'a timestamp only comparison loses both rows');
});
