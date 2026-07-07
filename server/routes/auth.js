// server/routes/auth.js
const express = require('express');
const jwt     = require('jsonwebtoken');
const fetch   = require('node-fetch');
const prisma  = require('../lib/db');
const siteConfig = require('../lib/siteConfig');

const router = express.Router();
const DISCORD_API = 'https://discord.com/api/v10';

// Read at call-time, not module-load-time, so .env is always populated
function getRoleIA()          { return process.env.ROLE_IA           || '1398071208343244870'; }
function getRoleHICOMM()      { return process.env.ROLE_HICOMM       || '1399746451453644860'; }
function getRoleSUPERVISOR()   { return process.env.ROLE_SUPERVISOR   || '1424505342129082571'; }
function getDeveloperDiscordId() { return process.env.DEVELOPER_DISCORD_ID || '1227866745201627137'; }

// Map an IA group role → site role. Shared with the access revalidator so the
// two never drift. (Director/HICOM/+ → HICOMM, Supervisor → SUPERVISOR,
// Investigator tiers → IA, Guest/Member → no access.)
const { roleFromIaGroupRank, resolveDivisionsForUser } = require('../lib/roleResolver');

// Turn a raw User-Agent string into a short human label ("Chrome on Windows")
// for the Active Sessions panel and new-device alerts. Best-effort only.
function describeDevice(ua = '') {
  const s = String(ua);
  let browser = 'Browser';
  if (/Edg\//.test(s))                       browser = 'Edge';
  else if (/OPR\/|Opera/.test(s))            browser = 'Opera';
  else if (/Chrome\//.test(s) && !/Chromium/.test(s)) browser = 'Chrome';
  else if (/Chromium/.test(s))               browser = 'Chromium';
  else if (/Firefox\//.test(s))              browser = 'Firefox';
  else if (/Safari\//.test(s))               browser = 'Safari';

  let os = 'Unknown OS';
  if (/Windows NT/.test(s))                  os = 'Windows';
  else if (/iPhone|iPad|iPod/.test(s))       os = 'iOS';
  else if (/Android/.test(s))                os = 'Android';
  else if (/Mac OS X/.test(s))               os = 'macOS';
  else if (/Linux/.test(s))                  os = 'Linux';

  if (browser === 'Browser' && os === 'Unknown OS') return 'Unknown device';
  return `${browser} on ${os}`;
}

// Build the OAuth callback URL so the user stays on the domain they came from
// (e.g. https://metia.uk/...). PUBLIC_BASE_URL forces a fixed base if set.
function buildRedirectUri(req) {
  if (process.env.PUBLIC_BASE_URL) {
    return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '') + '/auth/discord/callback';
  }
  const host = req.get('host');
  if (host) {
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
    return `${proto}://${host}/auth/discord/callback`;
  }
  return process.env.DISCORD_REDIRECT_URI;
}

// Redirect to the login page with a server_error AND a short, sanitised reason
// (message only, truncated) so a failed sign-in shows what actually broke
// instead of a bare "server error" — invaluable when you can't tail the logs.
function serverErr(res, e) {
  const detail = encodeURIComponent(String((e && e.message) || 'unknown').slice(0, 160));
  return res.redirect('/login?error=server_error&detail=' + detail);
}

// ── GET /auth/discord ─────────────────────────────────────────────
router.get('/discord', (req, res) => {
  const params = new URLSearchParams({
    client_id:     process.env.DISCORD_CLIENT_ID,
    redirect_uri:  buildRedirectUri(req),
    response_type: 'code',
    scope:         'identify guilds.members.read',
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

// ── GET /auth/discord/callback ────────────────────────────────────
router.get('/discord/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect('/login?error=oauth_cancelled');

  try {
    // ── Step 1: Exchange code for access token ────────────────────
    console.log('[Auth] Exchanging code for token...');
    const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type:    'authorization_code',
        code,
        redirect_uri:  buildRedirectUri(req),
      }),
    });
    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      console.error('[Auth] Token exchange failed:', JSON.stringify(tokenData));
      return res.redirect('/login?error=token_failed');
    }
    console.log('[Auth] Token obtained, scope:', tokenData.scope);

    const authHeader = `${tokenData.token_type} ${tokenData.access_token}`;

    // ── Step 2: Fetch Discord identity ────────────────────────────
    console.log('[Auth] Fetching Discord user...');
    const userRes     = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: authHeader },
    });
    const discordUser = await userRes.json();

    if (!discordUser.id) {
      console.error('[Auth] User fetch failed:', JSON.stringify(discordUser));
      return res.redirect('/login?error=user_fetch_failed');
    }
    console.log('[Auth] Discord user:', discordUser.username, '| ID:', discordUser.id);

    const isDeveloper = discordUser.id === getDeveloperDiscordId();
    console.log('[Auth] isDeveloper:', isDeveloper, '| devId env:', process.env.DEVELOPER_DISCORD_ID);

    // Developer-authorised access grant (lets a Discord ID in without roles)
    const grant = await prisma.accessGrant
      .findUnique({ where: { discordId: discordUser.id } })
      .catch(() => null);
    if (grant) console.log('[Auth] Access grant found → role:', grant.role);

    // ── Step 3: Fetch guild member (for roles + display name) ─────
    const guildId   = process.env.DISCORD_GUILD_ID;
    let memberRoles = [];
    let displayName = discordUser.global_name || discordUser.username;

    console.log('[Auth] Fetching guild member for guild:', guildId);
    try {
      const memberRes = await fetch(
        `${DISCORD_API}/users/@me/guilds/${guildId}/member`,
        { headers: { Authorization: authHeader } }
      );
      const member = await memberRes.json();
      console.log('[Auth] Guild member response code:', member.code, '| has roles:', !!member.roles);

      if (!member.code && Array.isArray(member.roles)) {
        memberRoles = member.roles;
        displayName = member.nick || discordUser.global_name || discordUser.username;
        console.log('[Auth] Roles:', memberRoles.join(', ') || 'none');
      } else {
        // Not in the guild — allowed only for the developer or a granted user
        if (!isDeveloper && !grant) {
          console.warn('[Auth] User not in guild — denying');
          return res.redirect('/denied?reason=not_in_server');
        }
        console.warn('[Auth] Not in guild but developer/granted — allowing');
      }
    } catch (memberErr) {
      console.error('[Auth] Guild member fetch threw:', memberErr.message);
      if (!isDeveloper && !grant) return res.redirect('/denied?reason=not_in_server');
    }

    // ── Step 4: Determine system role ────────────────────────────
    let systemRole;
    if (isDeveloper) {
      systemRole = 'DEVELOPER';
    } else if (grant) {
      // Developer-authorised — role comes from the grant, roles not required
      systemRole = grant.role;
      console.log('[Auth] Role from access grant:', systemRole);
    } else {
      // Primary: derive the role from the IA Roblox group rank (via RoVer).
      systemRole = null;
      try {
        const { getRobloxIdFromDiscord, getUserGroupRole } = require('../lib/roblox');
        const iaGroupId = process.env.IA_GROUP_ID || '407296071';
        // Login is the natural, low-frequency point to refresh the stored link.
        const rId = await getRobloxIdFromDiscord(discordUser.id, { fresh: true });
        if (rId) {
          const groupRole = await getUserGroupRole(rId, iaGroupId);
          if (groupRole) {
            systemRole = roleFromIaGroupRank(groupRole.name, groupRole.rank);
            console.log(`[Auth] IA group rank: ${groupRole.name} (${groupRole.rank}) → ${systemRole}`);
          }
        }
      } catch (e) { console.warn('[Auth] IA group rank lookup failed (non-blocking):', e.message); }

      // Fallback: Discord roles, if the group lookup didn't resolve a staff role.
      if (!systemRole) {
        const hasHICOMM     = memberRoles.includes(getRoleHICOMM());
        const hasSUPERVISOR = memberRoles.includes(getRoleSUPERVISOR());
        const hasIA         = memberRoles.includes(getRoleIA());
        console.log('[Auth] Discord-role fallback — HICOMM:', hasHICOMM, '| SUPERVISOR:', hasSUPERVISOR, '| IA:', hasIA);
        if (hasHICOMM)          systemRole = 'HICOMM';
        else if (hasSUPERVISOR) systemRole = 'SUPERVISOR';
        else if (hasIA)         systemRole = 'IA';
      }
      // Note: systemRole may still be null here — that's fine as long as the
      // user has access to some *other* division. See step 4b below, which
      // is the single place login is actually denied.
    }
    // ── Step 4b: Resolve division access (CID/SCO19/IA/FLP/HPC) ──────
    // A user may belong to a division's Roblox group without holding any IA
    // role at all — the portal login must not gate on IA membership alone.
    // Division membership comes from each division's Roblox group rank
    // (resolveDivisionsForUser resolves the user's Roblox id internally).
    // Only block login entirely when the user has neither an IA system role
    // nor access to any other division.
    const divisions = await resolveDivisionsForUser({ discordId: discordUser.id, siteRole: systemRole });
    console.log('[Auth] Divisions resolved:', divisions.map(d => `${d.division}:${d.tier}`).join(', ') || 'none');

    if (!isDeveloper && !grant && !systemRole && divisions.length === 0) {
      console.warn('[Auth] No IA group rank or division group membership — denying');
      return res.redirect('/denied?reason=no_role');
    }
    console.log('[Auth] System role assigned:', systemRole || '(none — division-only access)');

    // ── Login lockdown: developers only ──────────────────────────
    if (!isDeveloper && siteConfig.isOn('loginLockdown')) {
      console.log('[Auth] Login blocked by lockdown for non-developer.');
      return res.redirect('/denied?reason=lockdown');
    }

    // ── Step 5: Upsert user in database ──────────────────────────
    const avatarUrl = discordUser.avatar
      ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
      : null;

    console.log('[Auth] Upserting user in DB...');

    // First try: full upsert including displayName
    // `role` is only included when a systemRole was actually resolved — a
    // division-only user (no IA/HICOMM role) keeps whatever `role` they
    // already had (or the schema default on first creation) since `role` no
    // longer gates division access on its own.
    let user;
    try {
      user = await prisma.user.upsert({
        where:  { discordId: discordUser.id },
        update: {
          discordUsername: discordUser.username,
          discordAvatar:   avatarUrl,
          displayName,
          ...(systemRole ? { role: systemRole } : {}),
          divisions:       divisions,
          metRoleIds:      Array.isArray(memberRoles) ? memberRoles : [],
          mustReauth:      false,
          lastLogin:       new Date(),
        },
        create: {
          discordId:       discordUser.id,
          discordUsername: discordUser.username,
          discordAvatar:   avatarUrl,
          displayName,
          metRoleIds:      Array.isArray(memberRoles) ? memberRoles : [],
          ...(systemRole ? { role: systemRole } : {}),
          divisions:       divisions,
        },
      });
      console.log('[Auth] DB upsert succeeded, userId:', user.id);
    } catch (dbErr) {
      // This fires if:
      // (a) displayName/divisions column doesn't exist yet (old schema) — retry without them
      // (b) DEVELOPER enum value doesn't exist yet (old schema) — map to HICOMM as fallback
      console.error('[Auth] DB upsert failed:', dbErr.message);

      const fallbackRole = systemRole === 'DEVELOPER' ? 'HICOMM' : systemRole;
      console.warn('[Auth] Retrying with fallbackRole:', fallbackRole, '(DEVELOPER mapped to HICOMM if enum missing)');

      try {
        user = await prisma.user.upsert({
          where:  { discordId: discordUser.id },
          update: {
            discordUsername: discordUser.username,
            discordAvatar:   avatarUrl,
            ...(fallbackRole ? { role: fallbackRole } : {}),
            lastLogin:       new Date(),
          },
          create: {
            discordId:       discordUser.id,
            discordUsername: discordUser.username,
            discordAvatar:   avatarUrl,
            ...(fallbackRole ? { role: fallbackRole } : {}),
          },
        });
        console.log('[Auth] Fallback DB upsert succeeded, userId:', user.id);
      } catch (dbErr2) {
        console.error('[Auth] Fallback DB upsert also failed:', dbErr2.message);
        return serverErr(res, dbErr2);
      }
    }

    // ── Step 5b: Capture IP + RoVer-linked Roblox identity ────────
    try {
      const { getClientIp } = require('../middleware/visit');
      const { getRobloxIdFromDiscord, getRobloxUserInfo } = require('../lib/roblox');
      const ip = getClientIp(req);

      // DB-FIRST to stay off RoVer's rate limit: if this account already has a
      // stored Roblox link, reuse it and DON'T call RoVer. Only hit RoVer when
      // the link is missing (first sign-in, or a previously-unlinked user).
      let rbxId = user.robloxId || null, rbxName = user.robloxUsername || null;
      if (!rbxId) {
        try {
          rbxId = await getRobloxIdFromDiscord(discordUser.id, { fresh: true });
          if (rbxId) { const info = await getRobloxUserInfo(rbxId); rbxName = info?.username || null; }
        } catch (rvErr) {
          console.warn('[Auth] RoVer link lookup failed (non-blocking):', rvErr.message);
        }
      }

      await prisma.user.update({
        where: { id: user.id },
        data:  { lastIp: ip, ...(rbxId ? { robloxId: rbxId, robloxUsername: rbxName } : {}) },
      });
      console.log('[Auth] Stored IP + Roblox link:', ip, '|', rbxName || 'unlinked', rbxId && user.robloxId ? '(cached)' : '(fresh)');
    } catch (enrichErr) {
      // Old schema (columns missing) or transient error — non-fatal
      console.warn('[Auth] IP/Roblox enrich skipped:', enrichErr.message);
    }

    // ── Step 6: Create the server-side session + cookie, then redirect ──
    return establishSession(req, res, user);

  } catch (err) {
    console.error('[Auth] Unhandled error in OAuth callback:', err.stack || err.message);
    serverErr(res, err);
  }
});

// establishSession = createSession + redirect (used by the Discord/Roblox
// callbacks, which are full-page navigations). createSession sets the session
// cookie and does new-device/IP/audit WITHOUT redirecting, so XHR flows (the
// "try another way" options) can set the cookie then return JSON. createSession
// THROWS on session-create failure so each caller handles it its own way.
async function establishSession(req, res, user) {
  try { await createSession(req, res, user); }
  catch (e) { return serverErr(res, e); }
  console.log('[Auth] Login complete, redirecting to dashboard');
  res.redirect('/dashboard');
}

async function createSession(req, res, user) {
  const { getClientIp } = require('../middleware/visit');
  const ip = getClientIp(req);
  const ua = (req.headers['user-agent'] || '').slice(0, 400);
  const device = describeDevice(ua);
  const SESSION_DAYS = 7;
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);

  let isNewDevice = false;
  try {
    const priorCount = await prisma.session.count({ where: { userId: user.id } });
    if (priorCount > 0) {
      const seen = await prisma.session.findFirst({ where: { userId: user.id, OR: [{ ip: ip || undefined }, { device }] } });
      isNewDevice = !seen;
    }
  } catch (e) { /* non-fatal */ }

  let session;
  try {
    session = await prisma.session.create({ data: { userId: user.id, ip, userAgent: ua, device, expiresAt } });
  } catch (e) {
    console.error('[Auth] session create failed:', e.message);
    throw e;
  }

  if (ip) {
    try { require('../lib/ipIntel').classifyAndRecord({ userId: user.id, sessionId: session.id, ip }); } catch (e) {}
  }

  const jwtToken = jwt.sign({ userId: user.id, sid: session.id }, process.env.JWT_SECRET, { expiresIn: `${SESSION_DAYS}d` });
  res.cookie('iacms_token', jwtToken, {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax',
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
  });

  if (isNewDevice) {
    try {
      const { sendToUser } = require('../lib/push');
      if (typeof sendToUser === 'function') {
        sendToUser(user.id, {
          title: 'New sign-in to your MET account',
          body: `A new sign-in from ${device}${ip ? ' (' + ip + ')' : ''}. If this wasn't you, revoke it in your dashboard.`,
          url: '/dashboard',
        }).catch(() => {});
      }
    } catch (e) { /* push optional */ }
  }
  try { await require('../lib/audit').record({ req, action: 'LOGIN', category: 'auth', targetType: 'session', targetId: session.id, summary: `Signed in from ${device}`, ip }); } catch (e) {}
  return session;
}

// ── POST /auth/logout ─────────────────────────────────────────────
router.post('/logout', async (req, res) => {
  // Revoke the server-side session so the token can never be replayed, even if
  // it was copied elsewhere. Best-effort — always clear the cookie regardless.
  try {
    const token = req.cookies?.iacms_token;
    if (token) {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      if (payload?.sid) {
        await prisma.session.update({
          where: { id: payload.sid },
          data:  { revokedAt: new Date() },
        }).catch(() => {});
      }
    }
  } catch (e) { /* token invalid/expired — nothing to revoke */ }
  res.clearCookie('iacms_token');
  res.redirect('/login');
});

// ─────────────────────────────────────────────────────────────────
// Sign in with Roblox (Roblox OAuth 2.0 / OIDC). Resolves the user's Discord
// automatically — first from a stored account (robloxId already on file → NO
// RoVer call), else via RoVer's roblox-to-discord reverse lookup. Roblox's own
// OAuth is not RoVer, so we read its userinfo freely; the RoVer reverse lookup
// (the rate-limited bit) is skipped whenever we already know the account.
// ─────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function robloxRedirectUri(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '') + '/auth/roblox/callback';
  const host = req.get('host');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  return `${proto}://${host}/auth/roblox/callback`;
}

// GET /auth/roblox — kick off the Roblox OAuth flow (PKCE + state in a cookie).
router.get('/roblox', (req, res) => {
  const clientId = process.env.ROBLOX_OAUTH_CLIENT_ID;
  if (!clientId) return res.redirect('/login?error=roblox_not_configured');
  const verifier  = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state     = b64url(crypto.randomBytes(16));
  const stateToken = jwt.sign({ state, verifier }, process.env.JWT_SECRET, { expiresIn: '10m' });
  res.cookie('roblox_oauth', stateToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 10 * 60 * 1000 });
  const params = new URLSearchParams({
    client_id:             clientId,
    redirect_uri:          robloxRedirectUri(req),
    scope:                 'openid profile',
    response_type:         'code',
    state,
    code_challenge:        challenge,
    code_challenge_method: 'S256',
  });
  res.redirect(`https://apis.roblox.com/oauth/v1/authorize?${params}`);
});

// GET /auth/roblox/callback — exchange the code, resolve Discord, sign in.
router.get('/roblox/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code) return res.redirect('/login?error=oauth_cancelled');

  let saved;
  try { saved = jwt.verify(req.cookies?.roblox_oauth || '', process.env.JWT_SECRET); } catch (e) { return res.redirect('/login?error=oauth_state'); }
  res.clearCookie('roblox_oauth');
  if (!saved || saved.state !== state) return res.redirect('/login?error=oauth_state');

  try {
    // Exchange the code (confidential client + PKCE verifier).
    const tokenRes = await fetch('https://apis.roblox.com/oauth/v1/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     process.env.ROBLOX_OAUTH_CLIENT_ID,
        client_secret: process.env.ROBLOX_OAUTH_CLIENT_SECRET || '',
        grant_type:    'authorization_code',
        code,
        redirect_uri:  robloxRedirectUri(req),
        code_verifier: saved.verifier,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) { console.error('[Auth] Roblox token exchange failed:', JSON.stringify(tokenData)); return res.redirect('/login?error=token_failed'); }

    // Roblox userinfo (its own API — free, not RoVer).
    const uiRes = await fetch('https://apis.roblox.com/oauth/v1/userinfo', { headers: { Authorization: `Bearer ${tokenData.access_token}` } });
    const ui = await uiRes.json();
    const robloxId = ui.sub ? String(ui.sub) : null;
    if (!robloxId) { console.error('[Auth] Roblox userinfo missing sub:', JSON.stringify(ui)); return res.redirect('/login?error=user_fetch_failed'); }
    const robloxUsername = ui.preferred_username || ui.name || null;
    console.log('[Auth] Roblox sign-in:', robloxUsername, '| id:', robloxId);

    // Resolve Discord: DB-first (already-linked account → no RoVer), else RoVer
    // roblox-to-discord reverse lookup.
    let user = await prisma.user.findFirst({ where: { robloxId } }).catch(() => null);
    let discordId = user ? user.discordId : null;
    let memberRoles = [];
    if (!discordId) {
      try {
        const { getDiscordFromRoblox } = require('../lib/roblox');
        const members = await getDiscordFromRoblox(robloxId);
        if (members && members.length) { discordId = String(members[0].discordId); memberRoles = members[0].roleIds || []; }
      } catch (e) { console.warn('[Auth] RoVer reverse lookup failed:', e.message); }
    }
    if (!discordId) return res.redirect('/login?error=roblox_unlinked');

    const isDeveloper = discordId === getDeveloperDiscordId();
    const grant = await prisma.accessGrant.findUnique({ where: { discordId } }).catch(() => null);

    // Guild roles + Discord display via the bot (roleIds from RoVer if we got them).
    let discordUsername = user && user.discordUsername;
    let displayName = user && user.displayName;
    try {
      const { getMemberRecord } = require('../lib/bot');
      const rec = await getMemberRecord(discordId);
      if (rec) {
        if (rec.inDiscord === false && !isDeveloper && !grant) return res.redirect('/denied?reason=not_in_server');
        if (!memberRoles.length && Array.isArray(rec.roleIds)) memberRoles = rec.roleIds;
        discordUsername = discordUsername || rec.username;
        displayName = displayName || rec.displayName;
      }
    } catch (e) { /* bot down → proceed with what we have */ }

    // System role: IA group rank (using the Roblox id we already have — no RoVer),
    // then a Discord-role fallback.
    let systemRole = isDeveloper ? 'DEVELOPER' : (grant ? grant.role : null);
    if (!systemRole && !isDeveloper) {
      try {
        const { getUserGroupRole } = require('../lib/roblox');
        const groupRole = await getUserGroupRole(robloxId, process.env.IA_GROUP_ID || '407296071');
        if (groupRole) systemRole = roleFromIaGroupRank(groupRole.name, groupRole.rank);
      } catch (e) { /* non-blocking */ }
      if (!systemRole) {
        if (memberRoles.includes(getRoleHICOMM()))          systemRole = 'HICOMM';
        else if (memberRoles.includes(getRoleSUPERVISOR())) systemRole = 'SUPERVISOR';
        else if (memberRoles.includes(getRoleIA()))         systemRole = 'IA';
      }
    }

    // Divisions — pass robloxId so this never re-hits RoVer.
    const divisions = await resolveDivisionsForUser({ discordId, siteRole: systemRole, robloxId });
    if (!isDeveloper && !grant && !systemRole && divisions.length === 0) return res.redirect('/denied?reason=no_role');
    if (!isDeveloper && siteConfig.isOn('loginLockdown')) return res.redirect('/denied?reason=lockdown');

    user = await prisma.user.upsert({
      where: { discordId },
      update: {
        robloxId, robloxUsername,
        ...(discordUsername ? { discordUsername } : {}),
        ...(displayName ? { displayName } : {}),
        ...(systemRole ? { role: systemRole } : {}),
        divisions, metRoleIds: memberRoles, mustReauth: false, lastLogin: new Date(),
      },
      create: {
        discordId,
        discordUsername: discordUsername || `roblox_${robloxId}`,
        displayName: displayName || robloxUsername || `Roblox ${robloxId}`,
        robloxId, robloxUsername,
        ...(systemRole ? { role: systemRole } : {}),
        divisions, metRoleIds: memberRoles,
      },
    });

    return establishSession(req, res, user);
  } catch (err) {
    console.error('[Auth] Roblox callback error:', err.stack || err.message);
    serverErr(res, err);
  }
});

// Exposed so the debug endpoint can show the EXACT redirect_uri the app sends
// to Discord (must be registered verbatim in the Discord Developer Portal).
router.buildRedirectUri = buildRedirectUri;
// Shared with the alternative sign-in router (routes/authAlt.js) so those flows
// end in the same session-creation path as Discord/Roblox. createSession sets
// the cookie without redirecting (for XHR flows); it throws on failure.
router.establishSession = establishSession;
router.createSession = createSession;

module.exports = router;
