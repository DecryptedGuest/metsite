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
        return res.redirect('/login?error=server_error');
      }
    }

    // ── Step 5b: Capture IP + RoVer-linked Roblox identity ────────
    try {
      const { getClientIp } = require('../middleware/visit');
      const { getRobloxIdFromDiscord, getRobloxUserInfo } = require('../lib/roblox');
      const ip = getClientIp(req);

      let rbxId = null, rbxName = null;
      try {
        // Force a fresh RoVer lookup on every login so a stale/missing Roblox
        // link gets corrected — otherwise the DB-first path reuses the old value
        // and "log out + back in" can't fix a wrong/absent link.
        rbxId = await getRobloxIdFromDiscord(discordUser.id, { fresh: true });
        if (rbxId) {
          const info = await getRobloxUserInfo(rbxId);
          rbxName = info?.username || null;
        }
      } catch (rvErr) {
        console.warn('[Auth] RoVer link lookup failed (non-blocking):', rvErr.message);
      }

      await prisma.user.update({
        where: { id: user.id },
        data:  { lastIp: ip, robloxId: rbxId, robloxUsername: rbxName },
      });
      console.log('[Auth] Stored IP + Roblox link:', ip, '|', rbxName || 'unlinked');
    } catch (enrichErr) {
      // Old schema (columns missing) or transient error — non-fatal
      console.warn('[Auth] IP/Roblox enrich skipped:', enrichErr.message);
    }

    // ── Step 6: Issue JWT cookie ──────────────────────────────────
    const jwtToken = jwt.sign(
      { userId: user.id },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.cookie('iacms_token', jwtToken, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge:   7 * 24 * 60 * 60 * 1000,
    });

    console.log('[Auth] Login complete, redirecting to dashboard');
    res.redirect('/dashboard');

  } catch (err) {
    console.error('[Auth] Unhandled error in OAuth callback:', err.stack || err.message);
    res.redirect('/login?error=server_error');
  }
});

// ── POST /auth/logout ─────────────────────────────────────────────
router.post('/logout', (req, res) => {
  res.clearCookie('iacms_token');
  res.redirect('/login');
});

// Exposed so the debug endpoint can show the EXACT redirect_uri the app sends
// to Discord (must be registered verbatim in the Discord Developer Portal).
router.buildRedirectUri = buildRedirectUri;

module.exports = router;
