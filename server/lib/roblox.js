// server/lib/roblox.js
// Roblox integration: RoVer lookup, group membership, group exile.

const fetch = require('node-fetch');

const ROVER_API  = 'https://registry.rover.link/api/guilds';
const ROBLOX_API = 'https://apis.roblox.com/cloud/v2';

// In-process RoVer cache — avoids hammering rate limits for repeated lookups.
// A Discord↔Roblox link almost never changes, so cache it for a long time.
const roverCache  = new Map(); // discordId → { robloxId, expires }
const ROVER_TTL   = 6 * 60 * 60 * 1000; // 6 hours

// When RoVer rate-limits us (429), stop calling it entirely until this time —
// hammering during a ban only extends it. Serve cached values meanwhile.
let roverCooldownUntil = 0;
function roverOnCooldown() { return Date.now() < roverCooldownUntil; }
function tripRoverCooldown(retryAfterSec) {
  const ms = (Number(retryAfterSec) > 0 ? Number(retryAfterSec) : 900) * 1000; // default 15 min
  roverCooldownUntil = Date.now() + ms;
  console.warn(`[RoVer] rate-limited — pausing all RoVer lookups for ${Math.round(ms / 60000)} min.`);
}

// Called on server startup — warm up the Roblox CSRF token if a cookie is set.
async function initCsrf() { await initCsrfReal(); }

/**
 * Look up a Roblox user ID from a Discord user ID via RoVer.
 *
 * Strategy:
 *   1. If ROVER_API_KEY + DISCORD_GUILD_ID are set → use the registry API
 *      (registry.rover.link) which is guild-scoped and authoritative.
 *   2. Otherwise fall back to the public RoVer API (verify.eryn.io) which
 *      requires no key but is rate-limited to ~60 req/min.
 *
 * Returns { robloxId: string } or null if not linked.
 * Throws an Error with a human-readable message if the API is unreachable
 * or returns an unexpected error, so callers can surface the reason.
 */
// Look up a stored Roblox link for a Discord ID from our own DB (set at login).
async function storedRobloxId(discordUserId) {
  try {
    const prisma = require('./db');
    const u = await prisma.user.findUnique({
      where: { discordId: String(discordUserId) }, select: { robloxId: true },
    });
    return (u && u.robloxId) ? String(u.robloxId) : null;
  } catch (e) { return null; }
}

async function getRobloxIdFromDiscord(discordUserId, opts = {}) {
  const fresh = !!opts.fresh; // login forces a fresh RoVer lookup to refresh the link
  // Serve from cache if still fresh
  const hit = roverCache.get(discordUserId);
  if (!fresh && hit && Date.now() < hit.expires) return hit.robloxId;

  // DB-FIRST: every logged-in user's link is stored on their account. Use it
  // and skip RoVer entirely — this is what keeps us off RoVer's rate limit.
  if (!fresh) {
    const dbId = await storedRobloxId(discordUserId);
    if (dbId) { roverCache.set(discordUserId, { robloxId: dbId, expires: Date.now() + ROVER_TTL }); return dbId; }
  }

  // While rate-limited, never call RoVer — serve any cached/stored value or
  // null. This prevents extending the ban and keeps the app responsive.
  if (roverOnCooldown()) return hit ? hit.robloxId : (await storedRobloxId(discordUserId));

  const guildId = process.env.DISCORD_GUILD_ID;
  const apiKey  = process.env.ROVER_API_KEY;

  let robloxId;

  if (guildId && apiKey) {
    // Registry API — Bearer scheme as per RoVer API docs
    const url = `${ROVER_API}/${guildId}/discord-to-roblox/${discordUserId}`;
    const res  = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });

    if (res.status === 404) {
      roverCache.set(discordUserId, { robloxId: null, expires: Date.now() + ROVER_TTL });
      return null;
    }

    if (!res.ok) {
      const contentType = res.headers.get('content-type') || '';
      const body = contentType.includes('application/json')
        ? await res.json()
        : { errorCode: 'cloudflare', message: await res.text() };

      // Rate limited → pause all RoVer calls and return cached/null (no throw,
      // no retry storm) so we don't extend the ban.
      if (res.status === 429) {
        tripRoverCooldown(body && body.detail && body.detail.retryAfter);
        return hit ? hit.robloxId : null;
      }

      // "not verified" is a normal, non-error outcome — cache as unlinked
      if (body.errorCode === 'user_not_found') {
        roverCache.set(discordUserId, { robloxId: null, expires: Date.now() + ROVER_TTL });
        return null;
      }

      console.error(`RoVer registry API error [${res.status}]:`, body);
      throw new Error(
        body.message
          ? `${body.errorCode}: ${body.message}`
          : `RoVer returned ${res.status}`,
      );
    }

    const data = await res.json();
    robloxId = data.robloxId ? String(data.robloxId) : null;
  } else {
    // Public fallback — no key required
    console.warn('ROVER_API_KEY not set — falling back to public RoVer API (rate-limited).');
    const res = await fetch(`https://verify.eryn.io/api/user/${discordUserId}`);

    if (res.status === 404) {
      roverCache.set(discordUserId, { robloxId: null, expires: Date.now() + ROVER_TTL });
      return null;
    }
    if (res.status === 429) {
      tripRoverCooldown(parseInt(res.headers.get('retry-after'), 10));
      return hit ? hit.robloxId : null;
    }
    if (!res.ok) {
      console.error(`Public RoVer API error [${res.status}]`);
      throw new Error(`RoVer public API returned ${res.status}`);
    }

    const data = await res.json();
    robloxId = (data.status === 'error' || !data.robloxId) ? null : String(data.robloxId);
  }

  roverCache.set(discordUserId, { robloxId, expires: Date.now() + ROVER_TTL });
  // Persist the resolved link onto the user (if they exist) so all future
  // lookups hit the DB instead of RoVer.
  if (robloxId) {
    try {
      const prisma = require('./db');
      await prisma.user.updateMany({ where: { discordId: String(discordUserId) }, data: { robloxId: String(robloxId) } });
    } catch (e) { /* non-blocking */ }
  }
  return robloxId;
}

// roblox-to-discord cache: robloxId → { members, expires }
const roverReverseCache = new Map();

/**
 * Resolve the Discord member(s) in this guild that have verified as a given
 * Roblox user ID, via RoVer's roblox-to-discord endpoint.
 *
 * Returns an array of { discordId, username, displayName, roleIds } — possibly
 * empty (nobody in the guild has verified as that Roblox account) or with more
 * than one entry (the same Roblox account verified on multiple Discord users).
 * Throws only on genuine API errors (not on "not found").
 */
async function getDiscordFromRoblox(robloxUserId) {
  const key = String(robloxUserId);
  const hit = roverReverseCache.get(key);
  if (hit && Date.now() < hit.expires) return hit.members;

  const guildId = process.env.DISCORD_GUILD_ID;
  const apiKey  = process.env.ROVER_API_KEY;
  if (!guildId || !apiKey) return [];

  const url = `${ROVER_API}/${guildId}/roblox-to-discord/${key}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });

  if (res.status === 404) {
    roverReverseCache.set(key, { members: [], expires: Date.now() + ROVER_TTL });
    return [];
  }
  if (!res.ok) {
    const contentType = res.headers.get('content-type') || '';
    const body = contentType.includes('application/json')
      ? await res.json()
      : { errorCode: 'cloudflare', message: await res.text() };
    if (body.errorCode === 'user_not_found') {
      roverReverseCache.set(key, { members: [], expires: Date.now() + ROVER_TTL });
      return [];
    }
    console.error(`RoVer roblox-to-discord error [${res.status}]:`, body);
    throw new Error(body.message ? `${body.errorCode}: ${body.message}` : `RoVer returned ${res.status}`);
  }

  const data    = await res.json();
  const members = (data.discordUsers || []).map(m => ({
    discordId:   m.user?.id || null,
    username:    m.user?.username || null,
    displayName: m.nick || m.user?.global_name || m.user?.username || null,
    roleIds:     Array.isArray(m.roles) ? m.roles : [],
  })).filter(m => m.discordId);

  roverReverseCache.set(key, { members, expires: Date.now() + ROVER_TTL });
  return members;
}

/**
 * Fetch a Roblox user's username and displayName by Roblox user ID.
 * Uses the public Roblox Users API — no auth needed.
 */
async function getRobloxUserInfo(robloxUserId) {
  try {
    const res = await fetch(`https://users.roblox.com/v1/users/${robloxUserId}`);
    if (!res.ok) return null;
    const data = await res.json();
    return {
      id:          String(data.id),
      username:    data.name,
      displayName: data.displayName,
    };
  } catch (err) {
    console.error('Roblox user info error:', err.message);
    return null;
  }
}

/**
 * Get a Roblox user's role in a SPECIFIC group (public API, no auth).
 * Returns { id, name, rank } or null if not a member / lookup failed.
 */
const groupRoleCache = new Map(); // `${robloxUserId}:${groupId}` → { role, expires }
const GROUP_ROLE_TTL = 30 * 60 * 1000; // 30 min — ranks rarely change minute-to-minute
async function getUserGroupRole(robloxUserId, groupId) {
  const roles = await getUserGroupRoles(robloxUserId, groupId);
  if (!roles || !roles.length) return null;
  // Backwards-compatible single-role callers get the highest-rank role held.
  return roles.reduce((a, b) => (Number(b.rank) > Number(a.rank) ? b : a));
}

// Get ALL of a user's roles in a SPECIFIC group. Roblox now lets a member hold
// more than one role in a single group; the public v2 endpoint surfaces that as
// multiple `{ group, role }` entries for the same group id, so we collect every
// match (not just the first). Returns [{ id, name, rank }] — empty if not a
// member / lookup failed. Cached for 30 min (ranks rarely change minute-to-minute).
const groupRolesCache = new Map(); // `${robloxUserId}:${groupId}` → { roles, expires }
async function getUserGroupRoles(robloxUserId, groupId) {
  if (!groupId || !robloxUserId) return [];
  const key = `${robloxUserId}:${groupId}`;
  const hit = groupRolesCache.get(key);
  if (hit && Date.now() < hit.expires) return hit.roles;
  try {
    const res = await fetch(`https://groups.roblox.com/v2/users/${robloxUserId}/groups/roles`);
    if (!res.ok) return hit ? hit.roles : []; // serve stale on transient error
    const data = await res.json();
    const roles = (data.data || [])
      .filter(x => x && x.group && String(x.group.id) === String(groupId) && x.role)
      .map(x => x.role);
    groupRolesCache.set(key, { roles, expires: Date.now() + GROUP_ROLE_TTL });
    // Keep the legacy single-role cache warm too, for getGroupMembership callers.
    groupRoleCache.set(key, {
      role: roles.length ? roles.reduce((a, b) => (Number(b.rank) > Number(a.rank) ? b : a)) : null,
      expires: Date.now() + GROUP_ROLE_TTL,
    });
    return roles;
  } catch (err) {
    console.error('Group roles lookup error:', err.message);
    return hit ? hit.roles : [];
  }
}

/**
 * Batch-resolve many Roblox user IDs to { id, username, displayName } in one
 * request (public Users API, no auth). Returns a Map keyed by string id.
 * Best-effort: unresolved / errored ids are simply absent from the map.
 */
async function getRobloxUsersInfo(userIds) {
  const ids = [...new Set((userIds || []).map(String).filter(Boolean))].map(Number).filter(Number.isFinite);
  const out = new Map();
  if (!ids.length) return out;
  try {
    const res = await fetch('https://users.roblox.com/v1/users', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ userIds: ids, excludeBannedUsers: false }),
    });
    if (!res.ok) return out;
    const data = await res.json();
    for (const u of (data.data || [])) out.set(String(u.id), { id: String(u.id), username: u.name, displayName: u.displayName });
    return out;
  } catch (err) {
    console.error('Roblox batch user info error:', err.message);
    return out;
  }
}

/**
 * Resolve a Roblox username to a user record via the public Users API.
 * Returns { id, username, displayName } or null if no such user.
 */
async function getRobloxIdFromUsername(username) {
  try {
    const res = await fetch('https://users.roblox.com/v1/usernames/users', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ usernames: [String(username)], excludeBannedUsers: false }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const u = (data.data || [])[0];
    return u ? { id: String(u.id), username: u.name, displayName: u.displayName } : null;
  } catch (err) {
    console.error('Roblox username lookup error:', err.message);
    return null;
  }
}

/**
 * Fetch a Roblox user's headshot thumbnail URL. Public API, no auth.
 * Returns a PNG URL or null.
 */
async function getRobloxAvatarHeadshot(robloxUserId) {
  try {
    const res = await fetch(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${robloxUserId}&size=150x150&format=Png&isCircular=false`,
    );
    if (!res.ok) return null;
    const data = await res.json();
    return (data.data && data.data[0] && data.data[0].imageUrl) || null;
  } catch (err) {
    console.error('Roblox avatar lookup error:', err.message);
    return null;
  }
}

/**
 * Check whether a Roblox user is a member of the configured group.
 * Uses the public Roblox Groups API — no auth needed.
 * Returns the membership object { group, role } or null if not in group.
 */
async function getGroupMembership(robloxUserId) {
  const groupId = process.env.ROBLOX_GROUP_ID;
  if (!groupId) return null;

  try {
    const res = await fetch(
      `https://groups.roblox.com/v2/users/${robloxUserId}/groups/roles`,
    );
    if (!res.ok) return null;
    const data = await res.json();
    return (data.data || []).find(g => String(g.group.id) === String(groupId)) || null;
  } catch (err) {
    console.error('Group membership check error:', err.message);
    return null;
  }
}

/**
 * Full Discord → Roblox profile pipeline.
 * Returns:
 *   { robloxId, username, displayName, inGroup, groupRole }
 *   or null if the Discord ID has no RoVer link.
 * Throws if the RoVer API itself errors (key wrong, network down, etc.)
 * so the route can distinguish "not linked" from "lookup failed".
 */
async function getOfficerProfile(discordUserId) {
  const robloxId = await getRobloxIdFromDiscord(discordUserId); // throws on API error
  if (!robloxId) return null;

  const [userInfo, membership] = await Promise.all([
    getRobloxUserInfo(robloxId),
    getGroupMembership(robloxId),
  ]);

  return {
    robloxId,
    username:    userInfo?.username    || null,
    displayName: userInfo?.displayName || null,
    inGroup:     !!membership,
    groupRole:   membership?.role?.name || null,
  };
}

/**
 * Build an officer profile directly from a Roblox user ID — no RoVer required.
 * Used when the submitter provides a Roblox ID instead of a Discord ID.
 * Returns the same shape as getOfficerProfile, or null if the user doesn't exist.
 */
async function getOfficerProfileByRobloxId(robloxUserId) {
  const [userInfo, membership] = await Promise.all([
    getRobloxUserInfo(String(robloxUserId)),
    getGroupMembership(String(robloxUserId)),
  ]);
  if (!userInfo) return null;
  return {
    robloxId:    String(robloxUserId),
    username:    userInfo.username,
    displayName: userInfo.displayName,
    inGroup:     !!membership,
    groupRole:   membership?.role?.name || null,
  };
}

// ── Account-token (cookie) authenticated group management ─────────
// Uses the Roblox web API (groups.roblox.com) authenticated with a bot
// account's .ROBLOSECURITY cookie, supplied via the ROBLOX_COOKIE env var.
// The bot account must be in the group with permission to manage members.

const ROBLOX_GROUPS = 'https://groups.roblox.com/v1';
let csrfToken = null; // cached X-CSRF-TOKEN, refreshed automatically on 403

function robloxCookie() {
  return process.env.ROBLOX_COOKIE || null;
}

/**
 * Authenticated fetch against the Roblox web API.
 * Adds the .ROBLOSECURITY cookie + X-CSRF-TOKEN, and transparently refreshes
 * the CSRF token (Roblox returns a fresh one in the 403 response header).
 */
async function robloxAuthFetch(url, options = {}, allowRetry = true) {
  const cookie = robloxCookie();
  if (!cookie) throw new Error('ROBLOX_COOKIE is not set');

  const headers = {
    Cookie:         `.ROBLOSECURITY=${cookie}`,
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  if (csrfToken) headers['X-CSRF-TOKEN'] = csrfToken;

  const res = await fetch(url, { ...options, headers });

  // Roblox hands back a fresh CSRF token on a 403 — capture it and retry once
  if (res.status === 403 && allowRetry) {
    const fresh = res.headers.get('x-csrf-token');
    if (fresh) {
      csrfToken = fresh;
      return robloxAuthFetch(url, options, false);
    }
  }
  return res;
}

// Warm the CSRF token on startup so the first action doesn't pay the retry.
async function initCsrfReal() {
  if (!robloxCookie()) return;
  try {
    const res = await robloxAuthFetch('https://auth.roblox.com/v2/logout', { method: 'POST' }, false);
    const fresh = res.headers.get('x-csrf-token');
    if (fresh) csrfToken = fresh;
  } catch (e) { /* token will be fetched lazily on first real call */ }
}

/**
 * Exile (kick) a Roblox user from the configured group.
 * DELETE /groups/{groupId}/users/{userId}. Returns true/false.
 */
async function exileFromGroup(robloxUserId, gid) {
  const groupId = gid || process.env.ROBLOX_GROUP_ID;
  if (!groupId || !robloxCookie()) {
    console.warn('Group exile skipped — ROBLOX_GROUP_ID or ROBLOX_COOKIE not set.');
    return false;
  }
  try {
    const res = await robloxAuthFetch(`${ROBLOX_GROUPS}/groups/${groupId}/users/${robloxUserId}`, { method: 'DELETE' });
    if (res.ok) {
      console.log(`Roblox exile: user ${robloxUserId} removed from group ${groupId}`);
      return true;
    }
    const text = await res.text();
    console.error(`Roblox exile failed [${res.status}]:`, text);
    return false;
  } catch (err) {
    console.error('Roblox exile error:', err.message);
    return false;
  }
}

/**
 * List the group's role definitions (ranks).
 * Returns array of { id, path, name, rank, memberCount }.
 */
async function listGroupRoles(gid) {
  const groupId = gid || process.env.ROBLOX_GROUP_ID;
  if (!groupId) throw new Error('ROBLOX_GROUP_ID is not set');

  const res = await robloxAuthFetch(`${ROBLOX_GROUPS}/groups/${groupId}/roles`, { method: 'GET' });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Roblox API ${res.status} listing roles: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.roles || []).map(r => ({
    id:          String(r.id),
    path:        `groups/${groupId}/roles/${r.id}`,
    name:        r.name,
    rank:        r.rank,
    memberCount: r.memberCount ?? 0,
  })).sort((a, b) => a.rank - b.rank);
}

/**
 * List group members, paginated (100/page).
 * Returns { members: [{ userId, username, displayName, roleId }], nextPageToken }.
 */
async function listGroupMembers(pageToken = null, gid) {
  const groupId = gid || process.env.ROBLOX_GROUP_ID;
  if (!groupId) throw new Error('ROBLOX_GROUP_ID is not set');

  let url = `${ROBLOX_GROUPS}/groups/${groupId}/users?limit=100&sortOrder=Asc`;
  if (pageToken) url += `&cursor=${encodeURIComponent(pageToken)}`;

  const res = await robloxAuthFetch(url, { method: 'GET' });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Roblox API ${res.status} listing members: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const members = (data.data || []).map(m => ({
    userId:      String(m.user.userId),
    username:    m.user.username,
    displayName: m.user.displayName || m.user.username,
    roleId:      String(m.role.id),
    roleName:    m.role.name,
    roleRank:    m.role.rank,
  }));
  return { members, nextPageToken: data.nextPageCursor || null };
}

/**
 * List pending join requests, paginated (100/page).
 * Returns { requests: [{ userId, username, displayName, requestedAt }], nextPageToken }.
 */
async function listJoinRequests(pageToken = null, gid) {
  const groupId = gid || process.env.ROBLOX_GROUP_ID;
  if (!groupId) throw new Error('ROBLOX_GROUP_ID is not set');

  let url = `${ROBLOX_GROUPS}/groups/${groupId}/join-requests?limit=100&sortOrder=Asc`;
  if (pageToken) url += `&cursor=${encodeURIComponent(pageToken)}`;

  const res = await robloxAuthFetch(url, { method: 'GET' });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Roblox API ${res.status} listing join requests: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const requests = (data.data || []).map(r => ({
    userId:      String(r.requester.userId),
    username:    r.requester.username,
    displayName: r.requester.displayName || r.requester.username,
    requestedAt: r.created || null,
  }));
  return { requests, nextPageToken: data.nextPageCursor || null };
}

/**
 * Approve or decline a join request for a Roblox user.
 * action: 'approve' (POST) | 'decline' (DELETE)
 */
async function resolveJoinRequest(robloxUserId, action, gid) {
  const groupId = gid || process.env.ROBLOX_GROUP_ID;
  if (!groupId) throw new Error('ROBLOX_GROUP_ID is not set');

  const url = `${ROBLOX_GROUPS}/groups/${groupId}/join-requests/users/${robloxUserId}`;
  const res = await robloxAuthFetch(url, { method: action === 'approve' ? 'POST' : 'DELETE' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Roblox API ${res.status} on ${action}: ${body.slice(0, 200)}`);
  }
}

/**
 * Change a group member's rank.
 * PATCH /groups/{groupId}/users/{userId} with { roleId }.
 */
async function changeGroupRank(robloxUserId, roleId, gid) {
  const groupId = gid || process.env.ROBLOX_GROUP_ID;
  if (!groupId) throw new Error('ROBLOX_GROUP_ID is not set');

  // Accept either a numeric id or a full "groups/x/roles/y" path
  const numericRoleId = String(roleId).includes('/') ? String(roleId).split('/').pop() : String(roleId);

  const res = await robloxAuthFetch(`${ROBLOX_GROUPS}/groups/${groupId}/users/${robloxUserId}`, {
    method: 'PATCH',
    body:   JSON.stringify({ roleId: Number(numericRoleId) }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Roblox API ${res.status} changing rank: ${body.slice(0, 200)}`);
  }
}

/**
 * Demote a group member by exactly one rank (to the next-lower member rank).
 * Returns { ok, from, to } or { ok:false, reason }.
 */
async function demoteByOneRank(robloxUserId) {
  try {
    const membership = await getGroupMembership(robloxUserId);
    if (!membership) return { ok: false, reason: 'not in the group' };
    const currentRank = membership.role?.rank;
    const currentName = membership.role?.name || '';
    if (currentRank == null) return { ok: false, reason: 'current rank unknown' };

    const roles = await listGroupRoles(); // [{ id, name, rank }]
    // Candidate ranks: member ranks (rank > 0) strictly below the current rank
    const lower = roles.filter(r => r.rank > 0 && r.rank < currentRank);
    if (!lower.length) return { ok: false, reason: 'already at the lowest rank' };
    const target = lower.reduce((a, b) => (b.rank > a.rank ? b : a));

    await changeGroupRank(robloxUserId, target.id);
    return { ok: true, from: currentName, to: target.name };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

module.exports = {
  initCsrf,
  getRobloxIdFromDiscord,
  getDiscordFromRoblox,
  getRobloxIdFromUsername,
  getRobloxUserInfo,
  getRobloxUsersInfo,
  getRobloxAvatarHeadshot,
  getGroupMembership,
  getUserGroupRole,
  getUserGroupRoles,
  getOfficerProfile,
  getOfficerProfileByRobloxId,
  exileFromGroup,
  demoteByOneRank,
  listGroupRoles,
  listGroupMembers,
  listJoinRequests,
  resolveJoinRequest,
  changeGroupRank,
};
