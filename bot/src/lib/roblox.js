// Roblox integration: identity (via RoVer), public reads, and authenticated
// group writes (exile / rank change / join requests).
//
// Two things here are load-bearing and easy to get wrong:
//   1. The RoVer 429 cooldown — retrying into a rate limit extends the ban, so
//      while it holds we serve cached/stored values and never call out.
//   2. The X-CSRF-TOKEN dance — Roblox hands back a fresh token on a 403; we
//      capture it and retry exactly once, otherwise every write fails.
const prisma = require('./db');
const { env } = require('./env');

const ROBLOX_GROUPS = 'https://groups.roblox.com/v1';
const ROVER_API     = 'https://registry.rover.link/api/guilds';
const ROVER_TTL     = 30 * 60 * 1000;   // 30 min — links rarely change
const GROUP_ROLE_TTL = 30 * 60 * 1000;

const roverCache = new Map();           // discordId -> { robloxId, expires }
const groupRoleCache = new Map();       // robloxId  -> { role, expires }
let roverCooldownUntil = 0;
let csrfToken = null;

const groupId = () => env('ROBLOX_GROUP_ID');
const cookie  = () => env('ROBLOX_COOKIE');

function roverOnCooldown() { return Date.now() < roverCooldownUntil; }
function tripRoverCooldown(retryAfterSec) {
  const ms = (Number(retryAfterSec) > 0 ? Number(retryAfterSec) : 300) * 1000;
  roverCooldownUntil = Date.now() + ms;
  console.warn(`[roblox] RoVer rate-limited — pausing lookups for ${Math.round(ms / 1000)}s`);
}

// ── Identity ──────────────────────────────────────────────────────
async function storedLink(discordId) {
  try { return await prisma.robloxLink.findUnique({ where: { discordId } }); }
  catch { return null; }
}

async function cacheLink(discordId, robloxUserId, robloxUsername) {
  if (!discordId) return;
  try {
    await prisma.robloxLink.upsert({
      where:  { discordId },
      update: { robloxUserId, robloxUsername },
      create: { discordId, robloxUserId, robloxUsername },
    });
  } catch (e) { console.warn('[roblox] link cache write failed:', e.message); }
}

/**
 * Resolve a Discord user to a Roblox id.
 * Order: memory cache → our own DB → RoVer. Hitting the DB before RoVer is
 * what keeps us off its rate limit. Returns a string id, or null if unlinked.
 */
async function getRobloxIdFromDiscord(discordUserId, { fresh = false } = {}) {
  const hit = roverCache.get(discordUserId);
  if (!fresh && hit && Date.now() < hit.expires) return hit.robloxId;

  if (!fresh) {
    const link = await storedLink(discordUserId);
    if (link?.robloxUserId) {
      roverCache.set(discordUserId, { robloxId: link.robloxUserId, expires: Date.now() + ROVER_TTL });
      return link.robloxUserId;
    }
  }

  if (roverOnCooldown()) {
    if (hit) return hit.robloxId;
    return (await storedLink(discordUserId))?.robloxUserId || null;
  }

  const guildId = env('DISCORD_GUILD_ID');
  const apiKey  = env('ROVER_API_KEY');
  let robloxId = null;

  try {
    if (guildId && apiKey) {
      const res = await fetch(`${ROVER_API}/${guildId}/discord-to-roblox/${discordUserId}`,
        { headers: { Authorization: `Bearer ${apiKey}` } });

      if (res.status === 404) {
        roverCache.set(discordUserId, { robloxId: null, expires: Date.now() + ROVER_TTL });
        return null;
      }
      if (res.status === 429) {
        const body = await res.json().catch(() => ({}));
        tripRoverCooldown(body?.detail?.retryAfter);
        return hit ? hit.robloxId : null;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (body.errorCode === 'user_not_found') {
          roverCache.set(discordUserId, { robloxId: null, expires: Date.now() + ROVER_TTL });
          return null;
        }
        console.error(`[roblox] RoVer error ${res.status}:`, body.message || '');
        return null;
      }
      const data = await res.json();
      robloxId = data.robloxId ? String(data.robloxId) : null;
    } else {
      // Public fallback — heavily rate-limited, no key required.
      console.warn('[roblox] ROVER_API_KEY not set — using the public RoVer API');
      const res = await fetch(`https://verify.eryn.io/api/user/${discordUserId}`);
      if (res.status === 429) { tripRoverCooldown(); return hit ? hit.robloxId : null; }
      if (!res.ok) return null;
      const data = await res.json();
      robloxId = data.robloxId ? String(data.robloxId) : null;
    }
  } catch (err) {
    console.error('[roblox] identity lookup failed:', err.message);
    return hit ? hit.robloxId : null;
  }

  roverCache.set(discordUserId, { robloxId, expires: Date.now() + ROVER_TTL });
  if (robloxId) {
    const info = await getRobloxUserInfo(robloxId);
    await cacheLink(discordUserId, robloxId, info?.name || null);
  }
  return robloxId;
}

// ── Public reads (no auth) ────────────────────────────────────────
async function getRobloxUserInfo(robloxUserId) {
  try {
    const res = await fetch(`https://users.roblox.com/v1/users/${robloxUserId}`);
    if (!res.ok) return null;
    const d = await res.json();
    return { id: String(d.id), name: d.name, displayName: d.displayName || d.name };
  } catch { return null; }
}

async function getRobloxIdFromUsername(username) {
  try {
    const res = await fetch('https://users.roblox.com/v1/usernames/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
    });
    if (!res.ok) return null;
    const d = await res.json();
    const u = d.data?.[0];
    return u ? { id: String(u.id), name: u.name, displayName: u.displayName || u.name } : null;
  } catch { return null; }
}

async function getRobloxAvatarHeadshot(robloxUserId) {
  try {
    const res = await fetch(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${robloxUserId}&size=150x150&format=Png&isCircular=false`);
    if (!res.ok) return null;
    const d = await res.json();
    return d.data?.[0]?.imageUrl || null;
  } catch { return null; }
}

/** The member's role in the configured group, or null if not a member. */
async function getGroupMembership(robloxUserId) {
  const gid = groupId();
  if (!gid) return null;
  const cached = groupRoleCache.get(String(robloxUserId));
  if (cached && Date.now() < cached.expires) return cached.role;
  try {
    const res = await fetch(`https://groups.roblox.com/v2/users/${robloxUserId}/groups/roles`);
    if (!res.ok) return null;
    const d = await res.json();
    const found = (d.data || []).find(g => String(g.group.id) === String(gid)) || null;
    groupRoleCache.set(String(robloxUserId), { role: found, expires: Date.now() + GROUP_ROLE_TTL });
    return found;
  } catch (err) {
    console.error('[roblox] group membership lookup failed:', err.message);
    return null;
  }
}

// ── Authenticated writes ──────────────────────────────────────────
async function robloxAuthFetch(url, options = {}, allowRetry = true) {
  const c = cookie();
  if (!c) throw new Error('ROBLOX_COOKIE is not set');

  const headers = {
    Cookie: `.ROBLOSECURITY=${c}`,
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  if (csrfToken) headers['X-CSRF-TOKEN'] = csrfToken;

  const res = await fetch(url, { ...options, headers });

  // Roblox returns a fresh token in the 403 response header — grab it and retry once.
  if (res.status === 403 && allowRetry) {
    const fresh = res.headers.get('x-csrf-token');
    if (fresh) { csrfToken = fresh; return robloxAuthFetch(url, options, false); }
  }
  return res;
}

/** Warm the CSRF token at boot so the first real write doesn't pay for the retry. */
async function initCsrf() {
  if (!cookie()) return;
  try {
    const res = await robloxAuthFetch('https://auth.roblox.com/v2/logout', { method: 'POST' }, false);
    const fresh = res.headers.get('x-csrf-token');
    if (fresh) csrfToken = fresh;
  } catch { /* fetched lazily on the first real call */ }
}

async function exileFromGroup(robloxUserId) {
  const gid = groupId();
  if (!gid || !cookie()) {
    console.warn('Group exile skipped — ROBLOX_GROUP_ID or ROBLOX_COOKIE not set.');
    return false;
  }
  try {
    const res = await robloxAuthFetch(`${ROBLOX_GROUPS}/groups/${gid}/users/${robloxUserId}`, { method: 'DELETE' });
    if (res.ok) {
      console.log(`Roblox exile: user ${robloxUserId} removed from group ${gid}`);
      return true;
    }
    console.error(`Roblox exile failed [${res.status}]:`, (await res.text()).slice(0, 200));
    return false;
  } catch (err) {
    console.error('Roblox exile error:', err.message);
    return false;
  }
}

/** The group's roles, ascending by rank. */
async function listGroupRoles() {
  const gid = groupId();
  if (!gid) throw new Error('ROBLOX_GROUP_ID is not set');
  const res = await fetch(`${ROBLOX_GROUPS}/groups/${gid}/roles`);
  if (!res.ok) throw new Error(`Roblox API ${res.status} listing roles`);
  const d = await res.json();
  return (d.roles || [])
    .map(r => ({ id: r.id, name: r.name, rank: r.rank, memberCount: r.memberCount }))
    .sort((a, b) => a.rank - b.rank);
}

async function changeGroupRank(robloxUserId, roleId) {
  const gid = groupId();
  if (!gid) throw new Error('ROBLOX_GROUP_ID is not set');
  // Accept a bare numeric id or a full "groups/x/roles/y" path.
  const numeric = String(roleId).includes('/') ? String(roleId).split('/').pop() : String(roleId);
  const res = await robloxAuthFetch(`${ROBLOX_GROUPS}/groups/${gid}/users/${robloxUserId}`, {
    method: 'PATCH',
    body:   JSON.stringify({ roleId: Number(numeric) }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Roblox API ${res.status} changing rank: ${body.slice(0, 200)}`);
  }
  groupRoleCache.delete(String(robloxUserId));
}

/** Drop a member exactly one rank. Returns { ok, from, to } or { ok:false, reason }. */
async function demoteByOneRank(robloxUserId) {
  try {
    const membership = await getGroupMembership(robloxUserId);
    if (!membership) return { ok: false, reason: 'not in the group' };
    const currentRank = membership.role?.rank;
    const currentName = membership.role?.name || '';
    if (currentRank == null) return { ok: false, reason: 'current rank unknown' };

    const roles = await listGroupRoles();
    // Member ranks (rank > 0 excludes Guest) strictly below the current one.
    const lower = roles.filter(r => r.rank > 0 && r.rank < currentRank);
    if (!lower.length) return { ok: false, reason: 'already at the lowest rank' };
    const target = lower.reduce((a, b) => (b.rank > a.rank ? b : a));

    await changeGroupRank(robloxUserId, target.id);
    return { ok: true, from: currentName, to: target.name };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

async function listJoinRequests(pageToken = null) {
  const gid = groupId();
  if (!gid) throw new Error('ROBLOX_GROUP_ID is not set');
  let url = `${ROBLOX_GROUPS}/groups/${gid}/join-requests?limit=100&sortOrder=Asc`;
  if (pageToken) url += `&cursor=${encodeURIComponent(pageToken)}`;

  const res = await robloxAuthFetch(url, { method: 'GET' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Roblox API ${res.status} listing join requests: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return {
    requests: (data.data || []).map(r => ({
      userId:      String(r.requester.userId),
      username:    r.requester.username,
      displayName: r.requester.displayName || r.requester.username,
      requestedAt: r.created || null,
    })),
    nextPageToken: data.nextPageCursor || null,
  };
}

/** Approve (POST) or decline (DELETE) — same URL, different method. */
async function resolveJoinRequest(robloxUserId, action) {
  const gid = groupId();
  if (!gid) throw new Error('ROBLOX_GROUP_ID is not set');
  const res = await robloxAuthFetch(
    `${ROBLOX_GROUPS}/groups/${gid}/join-requests/users/${robloxUserId}`,
    { method: action === 'approve' ? 'POST' : 'DELETE' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Roblox API ${res.status} on ${action}: ${body.slice(0, 200)}`);
  }
}

module.exports = {
  getRobloxIdFromDiscord, getRobloxUserInfo, getRobloxIdFromUsername,
  getRobloxAvatarHeadshot, getGroupMembership, cacheLink, storedLink,
  initCsrf, exileFromGroup, listGroupRoles, changeGroupRank, demoteByOneRank,
  listJoinRequests, resolveJoinRequest,
};
