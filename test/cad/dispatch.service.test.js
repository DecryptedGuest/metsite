// test/cad/dispatch.service.test.js — run with:  node --test test/cad
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeMockPrisma } = require('./mockPrisma');
const { createDispatchService } = require('../../server/lib/cad/dispatch.service');
const { createUnitsService } = require('../../server/lib/cad/units.service');

function ctx() {
  const prisma = makeMockPrisma();
  return { prisma, dispatch: createDispatchService(prisma), units: createUnitsService(prisma) };
}

test('createIncident allocates INC-YYYYMMDD-001 and logs CREATED', async () => {
  const { prisma, dispatch } = ctx();
  const r = await dispatch.createIncident({ grade: 'I', location: 'Trafalgar Square', category: 'Affray', description: 'Fight in progress' });
  assert.equal(r.ok, true);
  assert.match(r.incident.cadRef, /^INC-\d{8}-001$/);
  assert.equal(r.incident.status, 'OPEN');
  const logs = prisma.cadIncidentLog._store;
  assert.equal(logs.length, 1);
  assert.equal(logs[0].type, 'CREATED');
});

test('createIncident rejects an invalid grade', async () => {
  const { dispatch } = ctx();
  const r = await dispatch.createIncident({ grade: 'X', location: 'A', category: 'B', description: 'C' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'BAD_GRADE');
});

test('daily refs increment', async () => {
  const { dispatch } = ctx();
  const a = await dispatch.createIncident({ grade: 'S', location: 'A', category: 'B', description: '' });
  const b = await dispatch.createIncident({ grade: 'S', location: 'A', category: 'B', description: '' });
  assert.match(a.incident.cadRef, /-001$/);
  assert.match(b.incident.cadRef, /-002$/);
});

test('assign puts the unit en route and the incident ASSIGNED', async () => {
  const { dispatch, units } = ctx();
  await units.bookOn({ callsign: 'MP-1', discordUserId: 'd1', officerName: 'A' });
  const inc = await dispatch.createIncident({ grade: 'S', location: 'Soho', category: 'Theft', description: '' });
  const r = await dispatch.assign({ ref: inc.incident.cadRef, callsign: 'MP-1' });
  assert.equal(r.ok, true);
  assert.equal(r.incident.status, 'ASSIGNED');
  const u = await units.findUnit({ callsign: 'MP-1' });
  assert.equal(u.status, 'EN_ROUTE');
  assert.equal(u.currentIncidentId, inc.incident.id);
});

test('assign fails for an unknown incident', async () => {
  const { dispatch, units } = ctx();
  await units.bookOn({ callsign: 'MP-1', discordUserId: 'd1', officerName: 'A' });
  const r = await dispatch.assign({ ref: 'INC-20000101-999', callsign: 'MP-1' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NO_INCIDENT');
});

test('closeIncident releases attached units and marks CLOSED', async () => {
  const { dispatch, units } = ctx();
  await units.bookOn({ callsign: 'MP-1', discordUserId: 'd1', officerName: 'A' });
  const inc = await dispatch.createIncident({ grade: 'S', location: 'Soho', category: 'Theft', description: '' });
  await dispatch.assign({ ref: inc.incident.cadRef, callsign: 'MP-1' });
  const r = await dispatch.closeIncident({ ref: inc.incident.cadRef, outcome: 'Words of advice' });
  assert.equal(r.ok, true);
  assert.equal(r.incident.status, 'CLOSED');
  assert.equal(r.incident.closedOutcome, 'Words of advice');
  const u = await units.findUnit({ callsign: 'MP-1' });
  assert.equal(u.status, 'AVAILABLE');
  assert.equal(u.currentIncidentId, null);
});

test('listOpen sorts by grade I→R', async () => {
  const { dispatch } = ctx();
  await dispatch.createIncident({ grade: 'R', location: 'A', category: 'x', description: '' });
  await dispatch.createIncident({ grade: 'I', location: 'B', category: 'y', description: '' });
  await dispatch.createIncident({ grade: 'S', location: 'C', category: 'z', description: '' });
  const r = await dispatch.listOpen();
  assert.deepEqual(r.incidents.map(i => i.grade), ['I', 'S', 'R']);
});

test('requestBackup marks the unit URGENT_ASSISTANCE and returns a location', async () => {
  const { dispatch, units } = ctx();
  await units.bookOn({ callsign: 'MP-1', discordUserId: 'd1', officerName: 'A' });
  const inc = await dispatch.createIncident({ grade: 'I', location: 'Trafalgar Square', category: 'Affray', description: '' });
  await dispatch.assign({ ref: inc.incident.cadRef, callsign: 'MP-1' });
  const r = await dispatch.requestBackup({ callsign: 'MP-1' });
  assert.equal(r.ok, true);
  assert.equal(r.unit.status, 'URGENT_ASSISTANCE');
  assert.equal(r.location, 'Trafalgar Square');
});
