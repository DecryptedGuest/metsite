// test/tryout/discordAvatar.test.js — run with:  node --test test/tryout
//
// Re-hosting a member's Discord avatar makes OUR Roblox account the publisher of
// somebody else's image, and Roblox moderation acts on the publisher. Nothing
// here can stop Roblox moderating an upload. These tests pin the things that
// decide whether a questionable picture ever reaches it at all.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const LIB = path.join(__dirname, '..', '..', 'server', 'lib');
function seed(name, exports) {
  const r = require.resolve(path.join(LIB, name));
  require.cache[r] = { id: r, filename: r, loaded: true, exports };
}
seed('db.js', { discordAvatarAsset: { findUnique: async () => null, findFirst: async () => null, count: async () => 0, upsert: async () => null, update: async () => null, findMany: async () => [] } });

for (const k of ['AVATAR_VISION_KEY', 'GOOGLE_SERVICE_ACCOUNT_JSON']) delete process.env[k];
const av = require('../../server/lib/discordAvatar');

const GUILD = '111111111111111111';
const member = (over) => ({ id: '222222222222222222', username: 'someone', avatar: null, guildAvatar: null, joinedAt: null, ...over });
const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

test('a server specific avatar is preferred over the account one', () => {
  const src = av.avatarSourceFor(member({ avatar: 'aaa', guildAvatar: 'bbb' }), GUILD);
  assert.equal(src.source, 'guild');
  assert.equal(src.hash, 'bbb');
  assert.match(src.url, new RegExp(`/guilds/${GUILD}/users/222222222222222222/avatars/bbb\\.png`));
  assert.match(src.url, /size=256/);
});

test('the account avatar is used when there is no server one', () => {
  const src = av.avatarSourceFor(member({ avatar: 'aaa' }), GUILD);
  assert.equal(src.source, 'user');
  assert.match(src.url, /\/avatars\/222222222222222222\/aaa\.png/);
});

test('no hash at all means no picture, not a default one', () => {
  assert.equal(av.avatarSourceFor(member(), GUILD), null);
});

test('animated avatars are declined', () => {
  // Discord serves these as a gif. A Decal is a still image, and an animation is
  // more surface than this needs.
  assert.equal(av.avatarSourceFor(member({ avatar: 'a_abc123' }), GUILD), null);
  assert.equal(av.avatarSourceFor(member({ guildAvatar: 'a_abc123', avatar: null }), GUILD), null);
});

test('an animated server avatar falls back to a static account one', () => {
  const src = av.avatarSourceFor(member({ guildAvatar: 'a_moving', avatar: 'still' }), GUILD);
  assert.equal(src.source, 'user');
  assert.equal(src.hash, 'still');
});

test('somebody who just joined is not published under our account', () => {
  const before = process.env.DISCORD_AVATAR_MIN_DAYS;
  process.env.DISCORD_AVATAR_MIN_DAYS = '7';
  try {
    assert.equal(av.settledEnough(member({ joinedAt: daysAgo(0) })), false);
    assert.equal(av.settledEnough(member({ joinedAt: daysAgo(3) })), false);
    assert.equal(av.settledEnough(member({ joinedAt: daysAgo(30) })), true);
  } finally {
    if (before === undefined) delete process.env.DISCORD_AVATAR_MIN_DAYS;
    else process.env.DISCORD_AVATAR_MIN_DAYS = before;
  }
});

test('an unknown join date is not treated as a yes', () => {
  const before = process.env.DISCORD_AVATAR_MIN_DAYS;
  process.env.DISCORD_AVATAR_MIN_DAYS = '7';
  try {
    assert.equal(av.settledEnough(member({ joinedAt: null })), false);
    assert.equal(av.settledEnough(member({ joinedAt: 'not a date' })), false);
  } finally {
    if (before === undefined) delete process.env.DISCORD_AVATAR_MIN_DAYS;
    else process.env.DISCORD_AVATAR_MIN_DAYS = before;
  }
});

test('only a real png is sent to Roblox', () => {
  const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]);
  assert.equal(av.isPng(png), true);
  assert.equal(av.isPng(Buffer.from('GIF89a and then some')), false);
  assert.equal(av.isPng(Buffer.from('<?php echo 1; ?>')), false);
  assert.equal(av.isPng(Buffer.from([0xFF, 0xD8, 0xFF])), false, 'a jpeg is not a png');
  assert.equal(av.isPng(Buffer.alloc(0)), false);
  assert.equal(av.isPng(null), false);
});

test('the off switch is honoured', () => {
  const before = process.env.DISCORD_AVATAR_REHOST;
  try {
    process.env.DISCORD_AVATAR_REHOST = 'off';
    assert.equal(av.rehostEnabled(), false);
    process.env.DISCORD_AVATAR_REHOST = 'OFF';
    assert.equal(av.rehostEnabled(), false);
    delete process.env.DISCORD_AVATAR_REHOST;
    assert.equal(av.rehostEnabled(), true);
  } finally {
    if (before === undefined) delete process.env.DISCORD_AVATAR_REHOST;
    else process.env.DISCORD_AVATAR_REHOST = before;
  }
});

test('the daily ceiling and size cap have sane defaults', () => {
  assert.equal(av.maxPerDay(), 25);
  assert.equal(av.maxBytes(), 1024 * 1024);
  assert.equal(av.minMemberDays(), 7);
});

test('nothing is uploaded while the switch is off', async () => {
  const before = process.env.DISCORD_AVATAR_REHOST;
  process.env.DISCORD_AVATAR_REHOST = 'off';
  let fetched = false;
  const realFetch = global.fetch;
  global.fetch = async () => { fetched = true; throw new Error('should never be called'); };
  try {
    await av.requestRehost(member({ avatar: 'aaa', joinedAt: daysAgo(100) }), GUILD,
      av.avatarSourceFor(member({ avatar: 'aaa' }), GUILD));
    assert.equal(fetched, false, 'the picture must not even be fetched');
  } finally {
    global.fetch = realFetch;
    if (before === undefined) delete process.env.DISCORD_AVATAR_REHOST;
    else process.env.DISCORD_AVATAR_REHOST = before;
  }
});

test('a picture we hold but Roblox has not approved is not handed over', async () => {
  const dbPath = require.resolve(path.join(LIB, 'db.js'));
  const held = (state, assetId) => { require.cache[dbPath].exports.discordAvatarAsset.findUnique = async () => ({ state, assetId }); };

  held('APPROVED', '1234567890');
  let r = await av.assetIdFor(member({ avatar: 'aaa' }), GUILD);
  assert.equal(r.assetId, 1234567890, 'an approved id is a number, ready for rbxassetid');

  for (const state of ['PENDING', 'REJECTED', 'FAILED', 'BLOCKED']) {
    held(state, '1234567890');
    r = await av.assetIdFor(member({ avatar: 'aaa' }), GUILD);
    assert.equal(r.assetId, null, state + ' must not be served: it renders as nothing in game');
    assert.ok(r.url, 'the url is still returned for the site to use');
  }
});

// The gates that decide whether anything reaches Roblox under our account.
// These are the tests that matter: each one is a picture that does NOT get
// published in our name.
function harness() {
  const rows = [], uploads = [];
  const dbPath = require.resolve(path.join(LIB, 'db.js'));
  require.cache[dbPath].exports.discordAvatarAsset = {
    findUnique: async () => null,
    findFirst: async () => null,
    count: async () => 0,
    upsert: async ({ create }) => { const r = { id: 'r', ...create }; rows.push(r); return r; },
    update: async () => null,
    findMany: async () => [],
  };
  const raPath = require.resolve(path.join(LIB, 'robloxAssets.js'));
  require.cache[raPath] = { id: raPath, filename: raPath, loaded: true, exports: {
    OPEN_CLOUD: 'x', assetFromOperation: () => ({}),
    useCredential: async () => ({ kind: 'apikey', value: 'k', creatorType: 'group', creatorId: '7777' }),
    uploadViaApiKey: async (o) => { uploads.push(o); return { assetId: '555', moderation: 'REVIEWING', operationId: 'op' }; },
  } };
  return { rows, uploads, db: require.cache[dbPath].exports.discordAvatarAsset };
}
function serve(body, headers = {}) {
  global.fetch = async () => ({ ok: true, status: 200,
    headers: { get: (k) => headers[k.toLowerCase()] || null },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) });
}
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(200)]);
const settled = { id: '2222', username: 'someone', avatar: 'hash1', guildAvatar: null, joinedAt: daysAgo(90) };

test('a settled member is uploaded as a Decal, owned by the credential holder', async () => {
  const h = harness(); serve(PNG);
  await av.requestRehost(settled, GUILD, av.avatarSourceFor(settled, GUILD));
  assert.equal(h.uploads.length, 1);
  const u = h.uploads[0];
  assert.equal(u.assetType, 'Decal');
  assert.equal(u.contentType, 'image/png');
  assert.equal(u.displayName, 'discord-2222');
  assert.equal(u.description, 'Discord avatar');
  // Group owned experiences need the group as creator, or the image will not
  // load in game however well it is moderated.
  assert.equal(u.creatorType, 'group');
  assert.equal(u.creatorId, '7777');
});

test('somebody who joined yesterday is never published in our name', async () => {
  const h = harness(); serve(PNG);
  const fresh = { ...settled, id: '3333', joinedAt: daysAgo(1) };
  await av.requestRehost(fresh, GUILD, av.avatarSourceFor(fresh, GUILD));
  assert.equal(h.uploads.length, 0);
  assert.equal(h.rows[0].state, 'BLOCKED');
  assert.match(h.rows[0].error, /less than 7 days/);
});

test('a file that is not really a png never reaches Roblox', async () => {
  const h = harness(); serve(Buffer.from('GIF89a and whatever follows'));
  await av.requestRehost(settled, GUILD, av.avatarSourceFor(settled, GUILD));
  assert.equal(h.uploads.length, 0);
  assert.equal(h.rows[0].state, 'BLOCKED');
});

test('an oversized picture is refused on the header alone', async () => {
  const h = harness(); serve(PNG, { 'content-length': String(5 * 1024 * 1024) });
  await av.requestRehost(settled, GUILD, av.avatarSourceFor(settled, GUILD));
  assert.equal(h.uploads.length, 0);
  assert.equal(h.rows[0].state, 'BLOCKED');
});

test('the daily ceiling stops a coordinated attempt', async () => {
  const h = harness(); serve(PNG);
  h.db.count = async () => 25;
  await av.requestRehost(settled, GUILD, av.avatarSourceFor(settled, GUILD));
  assert.equal(h.uploads.length, 0, 'nothing goes up once the day is spent');
});

test('an unreadable upload count holds rather than floods', async () => {
  const h = harness(); serve(PNG);
  h.db.count = async () => { throw new Error('database down'); };
  await av.requestRehost(settled, GUILD, av.avatarSourceFor(settled, GUILD));
  assert.equal(h.uploads.length, 0, 'not knowing how many went today must not mean "send more"');
});

test('a picture Roblox already refused is never sent again', async () => {
  const h = harness(); serve(PNG);
  h.db.findUnique = async () => ({ state: 'REJECTED', assetId: null });
  await av.requestRehost(settled, GUILD, av.avatarSourceFor(settled, GUILD));
  assert.equal(h.uploads.length, 0);
});

test('without an Open Cloud key nothing is uploaded', async () => {
  const h = harness(); serve(PNG);
  const raPath = require.resolve(path.join(LIB, 'robloxAssets.js'));
  require.cache[raPath].exports.useCredential = async () => ({ kind: 'cookie', value: 'c' });
  await av.requestRehost(settled, GUILD, av.avatarSourceFor(settled, GUILD));
  assert.equal(h.uploads.length, 0, 'the cookie path is the account itself, so it is not used for this');
});

// Reuse, so the Roblox allowance is spent once per picture and not once per
// check. A gif is not a new picture: it is nothing we can upload, which is not
// the same as a reason to forget the one we already have.
test('switching to a gif keeps the still picture we already had approved', async () => {
  const h = harness();
  h.db.findFirst = async (q) => (q && q.where && q.where.state === 'APPROVED'
    ? { assetId: '777', url: 'https://cdn.discordapp.com/avatars/2222/old.png?size=256', decidedAt: new Date() }
    : null);
  const nowAnimated = { ...settled, avatar: 'a_moving', guildAvatar: null };
  const r = await av.assetIdFor(nowAnimated, GUILD);
  assert.equal(r.assetId, 777, 'the gif must not cost them their picture');
  assert.match(r.url, /old\.png/);
});

test('removing the avatar entirely also keeps the last approved one', async () => {
  const h = harness();
  h.db.findFirst = async () => ({ assetId: '777', url: 'u', decidedAt: new Date() });
  const r = await av.assetIdFor({ ...settled, avatar: null, guildAvatar: null }, GUILD);
  assert.equal(r.assetId, 777);
});

test('a gif with nothing ever approved is simply no picture', async () => {
  harness();
  const r = await av.assetIdFor({ ...settled, avatar: 'a_moving', guildAvatar: null }, GUILD);
  assert.equal(r.assetId, null);
  assert.equal(r.url, null);
});

test('the same bytes are never uploaded twice', async () => {
  const h = harness(); serve(PNG);
  // Already approved under a different avatar hash, e.g. they switched away and
  // switched back, or wear the same picture in the server as on their account.
  h.db.findFirst = async (q) => (q && q.where && q.where.contentHash ? { assetId: '4242' } : null);
  await av.requestRehost(settled, GUILD, av.avatarSourceFor(settled, GUILD));
  assert.equal(h.uploads.length, 0, 'the allowance is the scarce thing, so reuse rather than re-upload');
  const row = h.rows[h.rows.length - 1];
  assert.equal(row.state, 'APPROVED');
  assert.equal(row.assetId, '4242', 'the existing asset is adopted');
  assert.ok(row.contentHash, 'and the bytes are recorded so it happens again next time');
});

test('a picture still in review shows the previous approved one, not nothing', async () => {
  const h = harness();
  h.db.findUnique = async () => ({ state: 'PENDING', assetId: '999' });
  h.db.findFirst = async () => ({ assetId: '777', url: 'u', decidedAt: new Date() });
  const r = await av.assetIdFor(settled, GUILD);
  assert.equal(r.assetId, 777, 'the one in review is not served, the last good one is');
});

test('a failed attempt is retried tomorrow, never on every check', () => {
  const hourAgo = new Date(Date.now() - 3600e3);
  const weekAgo = new Date(Date.now() - 7 * 864e5);
  assert.equal(av.retryable(null), true, 'never tried is worth trying');
  assert.equal(av.retryable({ state: 'FAILED', decidedAt: hourAgo }), false);
  assert.equal(av.retryable({ state: 'FAILED', decidedAt: weekAgo }), true);
  assert.equal(av.retryable({ state: 'BLOCKED', decidedAt: weekAgo }), false, 'we refused it, so leave it');
  assert.equal(av.retryable({ state: 'REJECTED', decidedAt: weekAgo }), false, 'Roblox refused it, so never again');
  assert.equal(av.retryable({ state: 'APPROVED', decidedAt: weekAgo }), false);
  assert.equal(av.retryable({ state: 'PENDING', requestedAt: weekAgo }), false, 'still waiting on Roblox');
});

// Screening. Off unless configured, and when it is configured a screen we
// cannot run means no upload.
test('with nothing configured, screening is skipped and behaviour is unchanged', async () => {
  const r = await av.screenImage(PNG);
  assert.equal(r.verdict, 'SKIP');
  assert.equal(av.screeningConfigured(), false);
});

test('a picture SafeSearch calls adult is refused before it is uploaded', async () => {
  const h = harness(); serve(PNG);
  process.env.AVATAR_VISION_KEY = 'k';
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('vision.googleapis.com')) {
      return { ok: true, status: 200, json: async () => ({ responses: [{ safeSearchAnnotation: { adult: 'VERY_LIKELY', violence: 'VERY_UNLIKELY', racy: 'UNLIKELY' } }] }) };
    }
    return { ok: true, status: 200, headers: { get: () => null },
             arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength) };
  };
  try {
    await av.requestRehost(settled, GUILD, av.avatarSourceFor(settled, GUILD));
    assert.equal(h.uploads.length, 0, 'nothing reaches Roblox in our name');
    assert.equal(h.rows[h.rows.length - 1].state, 'BLOCKED');
    assert.match(h.rows[h.rows.length - 1].error, /adult/);
  } finally { global.fetch = realFetch; delete process.env.AVATAR_VISION_KEY; }
});

test('an ordinary picture passes screening and goes up', async () => {
  const h = harness();
  process.env.AVATAR_VISION_KEY = 'k';
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('vision.googleapis.com')) {
      return { ok: true, status: 200, json: async () => ({ responses: [{ safeSearchAnnotation: { adult: 'VERY_UNLIKELY', violence: 'VERY_UNLIKELY', racy: 'POSSIBLE' } }] }) };
    }
    return { ok: true, status: 200, headers: { get: () => null },
             arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength) };
  };
  try {
    await av.requestRehost(settled, GUILD, av.avatarSourceFor(settled, GUILD));
    assert.equal(h.uploads.length, 1, 'racy POSSIBLE is under the bar, so a normal face is not refused');
  } finally { global.fetch = realFetch; delete process.env.AVATAR_VISION_KEY; }
});

test('screening configured but not answering means no upload', async () => {
  const h = harness();
  process.env.AVATAR_VISION_KEY = 'k';
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('vision.googleapis.com')) return { ok: false, status: 503, text: async () => 'unavailable' };
    return { ok: true, status: 200, headers: { get: () => null },
             arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength) };
  };
  try {
    await av.requestRehost(settled, GUILD, av.avatarSourceFor(settled, GUILD));
    assert.equal(h.uploads.length, 0, 'the point of screening is that nothing goes up unseen');
    assert.equal(h.rows[h.rows.length - 1].state, 'FAILED', 'recorded as failed, so it is retried tomorrow');
  } finally { global.fetch = realFetch; delete process.env.AVATAR_VISION_KEY; }
});

test('the screening bar is configurable and defaults to likely', () => {
  assert.equal(av.screenThreshold(), 4);
  const before = process.env.AVATAR_VISION_THRESHOLD;
  try {
    process.env.AVATAR_VISION_THRESHOLD = 'POSSIBLE';
    assert.equal(av.screenThreshold(), 3, 'a stricter bar refuses more');
    process.env.AVATAR_VISION_THRESHOLD = 'nonsense';
    assert.equal(av.screenThreshold(), 4, 'a bad value falls back rather than refusing everything');
  } finally {
    if (before === undefined) delete process.env.AVATAR_VISION_THRESHOLD;
    else process.env.AVATAR_VISION_THRESHOLD = before;
  }
});
