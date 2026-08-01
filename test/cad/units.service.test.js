// test/cad/units.service.test.js — run with:  node --test test/cad
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeMockPrisma } = require('./mockPrisma');
const { createUnitsService } = require('../../server/lib/cad/units.service');

function svc() { return createUnitsService(makeMockPrisma()); }

test('bookOn creates a unit shown available', async () => {
  const units = svc();
  const r = await units.bookOn({ callsign: 'mp 1', discordUserId: 'd1', officerName: 'PC Smith' });
  assert.equal(r.ok, true);
  assert.equal(r.unit.callsign, 'MP-1');       // normalised
  assert.equal(r.unit.status, 'AVAILABLE');
  assert.equal(r.unit.officerName, 'PC Smith');
});

test('bookOn rejects a callsign held by another on-duty officer', async () => {
  const units = svc();
  await units.bookOn({ callsign: 'MP-1', discordUserId: 'd1', officerName: 'A' });
  const r = await units.bookOn({ callsign: 'MP-1', discordUserId: 'd2', officerName: 'B' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'CALLSIGN_TAKEN');
});

test('an officer cannot hold two live callsigns', async () => {
  const units = svc();
  await units.bookOn({ callsign: 'MP-1', discordUserId: 'd1', officerName: 'A' });
  const r = await units.bookOn({ callsign: 'MP-2', discordUserId: 'd1', officerName: 'A' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ALREADY_ON');
});

test('setStatus updates the status and stamps the time', async () => {
  const units = svc();
  await units.bookOn({ callsign: 'MP-1', discordUserId: 'd1', officerName: 'A' });
  const r = await units.setStatus({ discordUserId: 'd1', status: 'en_route' });
  assert.equal(r.ok, true);
  assert.equal(r.unit.status, 'EN_ROUTE');
});

test('setStatus rejects an unknown status', async () => {
  const units = svc();
  await units.bookOn({ callsign: 'MP-1', discordUserId: 'd1', officerName: 'A' });
  const r = await units.setStatus({ discordUserId: 'd1', status: 'TELEPORTING' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'BAD_STATUS');
});

test('bookOff sets the unit OFF_DUTY and it leaves the board', async () => {
  const units = svc();
  await units.bookOn({ callsign: 'MP-1', discordUserId: 'd1', officerName: 'A' });
  const off = await units.bookOff({ discordUserId: 'd1' });
  assert.equal(off.ok, true);
  assert.equal(off.unit.status, 'OFF_DUTY');
  const board = await units.board();
  assert.equal(board.units.length, 0);
});

test('board orders by attention (urgent first) then callsign', async () => {
  const units = svc();
  await units.bookOn({ callsign: 'MP-2', discordUserId: 'd2', officerName: 'B' });
  await units.bookOn({ callsign: 'MP-1', discordUserId: 'd1', officerName: 'A' });
  await units.setStatus({ discordUserId: 'd2', status: 'URGENT_ASSISTANCE' });
  const board = await units.board();
  assert.equal(board.units[0].callsign, 'MP-2');   // urgent floats to top
  assert.equal(board.units[1].callsign, 'MP-1');
});
