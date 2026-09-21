// test/tryout/roverIdentity.test.js — run with:  node --test test/tryout
//
// RoVer owns the Discord to Roblox mapping, so it is asked first and the bot
// only steps in when RoVer has not done the job. The endpoint answers "ok"
// before it does any work, which is why acceptance is checked rather than
// trusted. Terminated strips the rank prefix; ranked rebuilds it.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const LIB = path.join(__dirname, '..', '..', 'server', 'lib');
function seed(name, exports) {
  const r = require.resolve(path.join(LIB, name));
  require.cache[r] = { id: r, filename: r, loaded: true, exports };
}

const state = { nickOnDiscord: 'PC | EthanCaaden', setCalls: [], status: 200, throws: false, ready: true };

seed('bot.js', {
  isReady: () => state.ready,
  getRobloxNameFromNick: async () => 'EthanCaaden',
  getMemberRecord: async () => ({ displayName: state.nickOnDiscord }),
  setMemberNickname: async (id, nick) => { state.setCalls.push(nick); state.nickOnDiscord = nick; return true; },
});
seed('roblox.js', { getRobloxUserInfo: async () => ({ username: 'EthanCaaden' }) });

global.fetch = async () => {
  if (state.throws) throw new Error('ECONNREFUSED');
  return { ok: state.status >= 200 && state.status < 300, status: state.status };
};

const rover = require('../../server/lib/rover');

function reset(over) {
  Object.assign(state, { nickOnDiscord: 'PC | EthanCaaden', setCalls: [], status: 200, throws: false, ready: true }, over || {});
  for (const k of ['ROVER_UPDATE_URL', 'ROVER_UPDATE_KEY', 'MET_GUILD_ID', 'DISCORD_GUILD_ID', 'IA_GUILD_ID']) delete process.env[k];
}
function configureRover() {
  process.env.ROVER_UPDATE_URL = 'https://rover.example';
  process.env.MET_GUILD_ID = '1';
}

test('when RoVer applies the change the bot leaves it alone', async () => {
  reset({ nickOnDiscord: 'EthanCaaden' });
  configureRover();
  const r = await rover.syncIdentity({ discordId: '111', robloxId: '222', terminated: true });
  assert.equal(r.via, 'rover');
  assert.equal(r.nickname, 'EthanCaaden');
  assert.deepEqual(state.setCalls, [], 'the bot must not race RoVer');
});

test('when RoVer accepts but does nothing the bot steps in', async () => {
  reset();
  configureRover();
  const r = await rover.syncIdentity({ discordId: '111', robloxId: '222', terminated: true });
  assert.equal(r.via, 'bot');
  assert.deepEqual(state.setCalls, ['EthanCaaden']);
});

test('when RoVer errors the bot steps in and the reason is recorded', async () => {
  reset({ status: 500 });
  configureRover();
  const r = await rover.syncIdentity({ discordId: '111', robloxId: '222', terminated: true });
  assert.equal(r.via, 'bot');
  assert.match(r.note, /500/);
});

test('when RoVer is unreachable the bot steps in', async () => {
  reset({ throws: true });
  configureRover();
  const r = await rover.syncIdentity({ discordId: '111', robloxId: '222', terminated: true });
  assert.equal(r.via, 'bot');
  assert.match(r.note, /ECONNREFUSED/);
});

test('with no RoVer configured the bot does it and says so', async () => {
  reset();
  const r = await rover.syncIdentity({ discordId: '111', robloxId: '222', terminated: true });
  assert.equal(r.via, 'bot');
  assert.match(r.note, /ROVER_UPDATE_URL is not set/);
});

test('a URL with no guild ids blames the guild ids, not the URL', async () => {
  reset();
  process.env.ROVER_UPDATE_URL = 'https://rover.example';
  const r = await rover.syncIdentity({ discordId: '111', robloxId: '222', terminated: true });
  assert.match(r.note, /guild ids/, 'pointing at the wrong setting sends people to check the wrong thing');
  assert.doesNotMatch(r.note, /ROVER_UPDATE_URL is not set/);
});

test('a blacklist strips the rank prefix and keeps the username', async () => {
  reset();
  const r = await rover.syncIdentity({ discordId: '111', robloxId: '222', terminated: true });
  assert.equal(r.nickname, 'EthanCaaden');
});

test('a rank change rebuilds the nickname as RANK then username', async () => {
  reset();
  const r = await rover.syncIdentity({ discordId: '111', robloxId: '222', terminated: false, rankName: 'Sergeant' });
  assert.equal(r.nickname, 'Sergeant | EthanCaaden');
});

test('with no Discord id nothing is touched', async () => {
  reset();
  const r = await rover.syncIdentity({ robloxId: '222', terminated: true });
  assert.equal(r.via, 'none');
  assert.deepEqual(state.setCalls, []);
});

test('with the bot offline nothing is touched', async () => {
  reset({ ready: false });
  const r = await rover.syncIdentity({ discordId: '111', robloxId: '222', terminated: true });
  assert.equal(r.via, 'none');
  assert.deepEqual(state.setCalls, []);
});
