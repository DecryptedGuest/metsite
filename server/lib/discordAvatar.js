'use strict';

// Re-hosts a member's Discord avatar as a Roblox Decal so the in game "is this
// you" card can show it. ImageLabel.Image takes rbxassetid:// and nothing else,
// so a cdn.discordapp.com url can never render there, and the picture has to
// exist as an asset owned by whoever owns the experience.
//
// That last part is the whole reason this file is careful. The uploading
// account is the publisher as far as Roblox is concerned, so anybody who can
// join the MET server and set an avatar could otherwise make our account
// publish their image, and Roblox moderation acts on the uploader. Nothing here
// can stop Roblox moderating an upload. What it can do is make sure only a
// settled member's plain static picture is ever sent, cap how many go per day,
// never retry anything Roblox has already refused, and stop dead on one switch.
//
// Everything is best effort and nothing blocks a tryout: an eligibility check
// returns whatever is already approved and asks for the rest in the background.

const prisma = require('./db');

const CDN = 'https://cdn.discordapp.com';
const SIZE = 256;

// Off switch. Set DISCORD_AVATAR_REHOST=off and not one more byte is uploaded;
// whatever is already approved still gets served from the cache.
function rehostEnabled() {
  return String(process.env.DISCORD_AVATAR_REHOST || '').trim().toLowerCase() !== 'off';
}

// How long somebody has to have been in the MET server before we will publish
// their picture under our account. A drive by who joined ten minutes ago to sit
// a tryout does not get their avatar re-hosted; they see the fallback.
function minMemberDays() {
  const n = parseInt(process.env.DISCORD_AVATAR_MIN_DAYS, 10);
  return Number.isFinite(n) && n >= 0 ? n : 7;
}

// A ceiling on the damage a coordinated attempt could do in a day.
function maxPerDay() {
  const n = parseInt(process.env.DISCORD_AVATAR_MAX_PER_DAY, 10);
  return Number.isFinite(n) && n > 0 ? n : 25;
}

function maxBytes() {
  const n = parseInt(process.env.DISCORD_AVATAR_MAX_BYTES, 10);
  return Number.isFinite(n) && n > 0 ? n : 1024 * 1024;
}

/**
 * Which picture to re-host, and the hash that identifies it.
 *
 * A server specific avatar wins, because that is the face they chose to wear in
 * the MET server and it is the one staff can see. Animated avatars are refused:
 * Discord serves those as a gif, a Decal is a still image, and an animation is
 * more surface than this feature needs.
 */
function avatarSourceFor(member, guildId) {
  if (!member || !member.id) return null;
  const guildHash = member.guildAvatar || null;
  const userHash  = member.avatar || null;

  if (guildHash && guildId && !String(guildHash).startsWith('a_')) {
    return {
      source: 'guild',
      hash: String(guildHash),
      url: `${CDN}/guilds/${guildId}/users/${member.id}/avatars/${guildHash}.png?size=${SIZE}`,
    };
  }
  if (userHash && !String(userHash).startsWith('a_')) {
    return {
      source: 'user',
      hash: String(userHash),
      url: `${CDN}/avatars/${member.id}/${userHash}.png?size=${SIZE}`,
    };
  }
  // No hash at all is a default Discord avatar, and an animated one we decline.
  return null;
}

/** Has this member been around long enough for us to publish their picture? */
function settledEnough(member) {
  const days = minMemberDays();
  if (!days) return true;
  const joined = member && member.joinedAt ? Date.parse(member.joinedAt) : NaN;
  if (!Number.isFinite(joined)) return false;   // unknown is not a yes
  return (Date.now() - joined) >= days * 24 * 60 * 60 * 1000;
}

function isPng(buf) {
  return !!buf && buf.length > 8
    && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47
    && buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A;
}

/** What we already hold for this exact picture. Null when we hold nothing. */
async function cached(discordId, hash) {
  if (!discordId || !hash) return null;
  return prisma.discordAvatarAsset
    .findUnique({ where: { discordId_avatarHash: { discordId: String(discordId), avatarHash: String(hash) } } })
    .catch(() => null);
}

async function uploadedToday() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return prisma.discordAvatarAsset
    .count({ where: { requestedAt: { gte: since }, state: { in: ['PENDING', 'APPROVED', 'REJECTED'] } } })
    .catch(() => maxPerDay());   // unknown counts as full, so we hold rather than flood
}

/**
 * Ask for a picture to be re-hosted. Returns nothing and throws nothing: the
 * caller is an eligibility check that must stay fast and must never fail over
 * this.
 */
async function requestRehost(member, guildId, src) {
  if (!rehostEnabled()) return;
  if (!src || !member) return;

  const already = await cached(member.id, src.hash);
  if (already) return;   // pending, approved, refused or blocked: all mean leave it

  if (!settledEnough(member)) {
    await note(member.id, src, 'BLOCKED', `member has been in the server less than ${minMemberDays()} days`);
    return;
  }
  if (await uploadedToday() >= maxPerDay()) {
    console.warn('[Avatar] the daily re-host ceiling is reached, so nothing more goes up today');
    return;
  }

  let assets;
  try { assets = require('./robloxAssets'); } catch (e) { return; }

  let cred = null;
  try { cred = await assets.useCredential(); } catch (e) { cred = null; }
  if (!cred || cred.kind !== 'apikey' || !cred.creatorId) return;   // Open Cloud only

  let buf = null;
  try {
    const res = await fetch(src.url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) { await note(member.id, src, 'FAILED', `Discord answered ${res.status}`); return; }
    const len = Number(res.headers.get('content-length') || 0);
    if (len && len > maxBytes()) { await note(member.id, src, 'BLOCKED', `picture is ${len} bytes`); return; }
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    await note(member.id, src, 'FAILED', 'could not fetch the picture: ' + e.message);
    return;
  }

  if (buf.length > maxBytes()) { await note(member.id, src, 'BLOCKED', `picture is ${buf.length} bytes`); return; }
  // Roblox is told this is a png, so it had better be one. A mislabelled file is
  // a refused upload against our account for no reason.
  if (!isPng(buf)) { await note(member.id, src, 'BLOCKED', 'the picture is not a png'); return; }

  const row = await note(member.id, src, 'PENDING', null, buf.length);
  if (!row) return;

  try {
    const out = await assets.uploadViaApiKey({
      buffer: buf,
      displayName: `discord-${member.id}`,
      fileName: `discord-${member.id}.png`,
      assetType: 'Decal',
      contentType: 'image/png',
      description: 'Discord avatar',
      creatorType: cred.creatorType || 'user',
      creatorId: cred.creatorId,
      apiKey: cred.value,
    });
    await prisma.discordAvatarAsset.update({
      where: { id: row.id },
      data: {
        operationId: out && out.operationId ? String(out.operationId) : null,
        assetId: out && out.assetId ? String(out.assetId) : null,
        moderation: (out && out.moderation) || null,
        ...settle(out && out.moderation, out && out.assetId),
      },
    }).catch(() => {});
  } catch (e) {
    await prisma.discordAvatarAsset.update({
      where: { id: row.id },
      data: { state: 'FAILED', error: String(e.message || e).slice(0, 500), decidedAt: new Date() },
    }).catch(() => {});
  }
}

// Roblox's word for it, turned into ours. Only APPROVED is ever served.
function settle(moderation, assetId) {
  const m = String(moderation || '').toUpperCase();
  if (m === 'APPROVED' && assetId) return { state: 'APPROVED', decidedAt: new Date() };
  if (m === 'REJECTED') return { state: 'REJECTED', decidedAt: new Date() };
  return {};
}

async function note(discordId, src, state, error, bytes) {
  return prisma.discordAvatarAsset.upsert({
    where: { discordId_avatarHash: { discordId: String(discordId), avatarHash: src.hash } },
    create: {
      discordId: String(discordId), avatarHash: src.hash, source: src.source, url: src.url,
      state, error: error ? String(error).slice(0, 500) : null, bytes: bytes || null,
      decidedAt: state === 'PENDING' ? null : new Date(),
    },
    update: { state, error: error ? String(error).slice(0, 500) : null, bytes: bytes || null },
  }).catch(() => null);
}

/**
 * The asset id for a member's current picture, or null.
 *
 * Only an APPROVED id is handed back. An id that is still in review renders as
 * nothing in game, so returning it would show a broken image where the fallback
 * should be. Anything not held yet is asked for in the background: this call
 * returns immediately either way.
 */
async function assetIdFor(member, guildId) {
  const src = avatarSourceFor(member, guildId);
  if (!src) return { assetId: null, url: null };

  const row = await cached(member.id, src.hash);
  if (row && row.state === 'APPROVED' && row.assetId) {
    const n = Number(row.assetId);
    return { assetId: Number.isFinite(n) ? n : null, url: src.url };
  }

  // Not held, or held but not approved. Ask once, in the background.
  if (!row) requestRehost(member, guildId, src).catch(() => {});
  return { assetId: null, url: src.url };
}

/**
 * Poll everything still waiting on Roblox. Called on a timer, never from a
 * request: moderation takes as long as it takes.
 */
async function refreshPendingAvatars() {
  if (!rehostEnabled()) return { checked: 0 };
  let assets, cred;
  try { assets = require('./robloxAssets'); cred = await assets.useCredential(); } catch (e) { return { checked: 0 }; }
  if (!cred || cred.kind !== 'apikey') return { checked: 0 };

  const rows = await prisma.discordAvatarAsset
    .findMany({ where: { state: 'PENDING' }, take: 25, orderBy: { requestedAt: 'asc' } })
    .catch(() => []);

  let checked = 0;
  for (const row of rows) {
    try {
      let assetId = row.assetId;
      let moderation = null;

      if (!assetId && row.operationId) {
        const op = await fetch(`${assets.OPEN_CLOUD}/operations/${encodeURIComponent(row.operationId)}`,
          { headers: { 'x-api-key': cred.value } });
        if (!op.ok) continue;
        const j = await op.json().catch(() => null);
        if (!j || !j.done) continue;
        const got = assets.assetFromOperation(j);
        assetId = got.assetId; moderation = got.moderation;
      }

      // Even once an id exists the picture stays invisible until it is approved,
      // so the asset itself is asked rather than trusted.
      if (assetId) {
        const a = await fetch(`${assets.OPEN_CLOUD}/assets/${encodeURIComponent(assetId)}`,
          { headers: { 'x-api-key': cred.value } });
        if (a.ok) {
          const j = await a.json().catch(() => null);
          const state = String((j && j.moderationResult && j.moderationResult.moderationState) || '')
            .toUpperCase().replace(/^MODERATION_STATE_/, '');
          if (state) moderation = state;
        }
      }

      checked += 1;
      await prisma.discordAvatarAsset.update({
        where: { id: row.id },
        data: { assetId: assetId ? String(assetId) : null, moderation: moderation || null, ...settle(moderation, assetId) },
      }).catch(() => {});

      if (String(moderation || '').toUpperCase() === 'REJECTED') {
        console.warn(`[Avatar] Roblox refused the avatar for ${row.discordId}. It will not be sent again.`);
      }
    } catch (e) { /* try again on the next sweep */ }
  }
  return { checked };
}

function startAvatarWorker() {
  if (!rehostEnabled()) return;
  setTimeout(() => { refreshPendingAvatars().catch(() => {}); }, 45 * 1000);
  setInterval(() => { refreshPendingAvatars().catch(() => {}); }, 5 * 60 * 1000);
}

module.exports = {
  avatarSourceFor, assetIdFor, requestRehost, refreshPendingAvatars, startAvatarWorker,
  rehostEnabled, settledEnough, isPng, minMemberDays, maxPerDay, maxBytes,
};
