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
const { roleFromIaGroupRank, resolveDivisionsForUser, effectiveSiteRole } = require('../lib/roleResolver');

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


// The DEVICE, rather than the browser.
//
// describeDevice above answers "what software is this" — "Chrome on Windows" —
// which is what a session list wants. An IA marker wants a different question
// answered: what is this person actually sitting at. "PC" and "Apple iPhone" are
// the words they would use, and the difference matters, because how somebody
// plays changes what they can reasonably be asked to do.
//
// Android carries the model in the user agent, so the brand is read from it where
// it is recognisable and the answer falls back to "Android phone" where it is
// not. A wrong brand is worse than no brand.
const ANDROID_BRANDS = [
  [/\bSM-|\bGT-|\bSAMSUNG\b/i,        'Samsung Galaxy'],
  [/\bPixel\b/i,                       'Google Pixel'],
  [/\bONEPLUS\b|\bKB2\d|\bLE2\d/i,   'OnePlus'],
  [/\bRedmi\b|\bPOCO\b|\bMi \d|\bXiaomi\b/i, 'Xiaomi'],
  [/\bMoto|\bmoto |\bXT\d{4}/i,       'Motorola'],
  [/\bHUAWEI\b|\bhonor\b/i,           'Huawei'],
  [/\bOPPO\b|\bCPH\d/i,               'OPPO'],
  [/\bvivo\b/i,                        'vivo'],
  [/\bNokia\b/i,                       'Nokia'],
];

function simpleDevice(ua = '') {
  const s = String(ua);
  if (!s.trim()) return null;

  // Consoles first: a console user agent also mentions an OS, and the console is
  // the more specific truth.
  if (/Xbox/i.test(s))                        return 'Xbox';
  if (/PlayStation 5/i.test(s))               return 'PlayStation 5';
  if (/PlayStation 4/i.test(s))               return 'PlayStation 4';
  if (/PlayStation/i.test(s))                 return 'PlayStation';
  if (/Nintendo Switch/i.test(s))             return 'Nintendo Switch';

  if (/\biPad\b/i.test(s))                   return 'Apple iPad';
  if (/\biPod\b/i.test(s))                   return 'Apple iPod';
  if (/\biPhone\b/i.test(s))                 return 'Apple iPhone';
  // An iPad on recent iOS reports itself as a Mac, and the touch points are what
  // give it away. Getting this wrong calls a tablet a laptop.
  if (/Macintosh/i.test(s) && /Mobile/i.test(s)) return 'Apple iPad';
  if (/Macintosh|Mac OS X/i.test(s))          return 'Mac';

  if (/CrOS/i.test(s))                        return 'Chromebook';

  if (/Android/i.test(s)) {
    const tablet = !/Mobile/i.test(s);
    for (const [re, brand] of ANDROID_BRANDS) {
      if (re.test(s)) return brand + (tablet ? ' tablet' : '');
    }
    return tablet ? 'Android tablet' : 'Android phone';
  }

  if (/Windows Phone/i.test(s))               return 'Windows phone';
  if (/Windows NT|Windows/i.test(s))          return 'PC';
  if (/Linux/i.test(s))                       return 'Linux PC';
  return null;
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
  // Log the real reason server-side ONLY. Never reflect internal exception text
  // (Prisma schema/driver strings, column/enum names) into the client-visible
  // redirect URL — the login page already shows a generic message for this code.
  try { console.error('[Auth] server error during OAuth callback:', (e && e.stack) || e); } catch (_) {}
  return res.redirect('/login?error=server_error');
}

// ── GET /auth/discord ──────────────────────────────────────
router.get('/discord', (req, res) => {
  // CSRF-protect the login: a random `state` echoed back by Discord and
  // verified against a signed, short-lived httpOnly cookie in the callback.
  // Without it, an attacker's captured `code` can be replayed to sign a victim
  // into the ATTACKER's account (OAuth login CSRF). Mirrors the Roblox flow.
  const state = b64url(crypto.randomBytes(16));
  const stateToken = jwt.sign({ state }, process.env.JWT_SECRET, { expiresIn: '10m' });
  res.cookie('discord_oauth', stateToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 10 * 60 * 1000 });
  const params = new URLSearchParams({
    client_id:     process.env.DISCORD_CLIENT_ID,
    redirect_uri:  buildRedirectUri(req),
    response_type: 'code',
    scope:         'identify guilds.members.read',
    state,
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

// ── GET /auth/discord/callback ───────────────────────────────
router.get('/discord/callback', async (req, res) => {
  const { code, error, state } = req.query;
  if (error || !code) return res.redirect('/login?error=oauth_cancelled');
  // Verify the CSRF state against the signed cookie before doing anything with
  // the code (single-use: clear the cookie regardless of outcome).
  let savedState;
  try { savedState = jwt.verify(req.cookies?.discord_oauth || '', process.env.JWT_SECRET); }
  catch (e) { res.clearCookie('discord_oauth'); return res.redirect('/login?error=oauth_state'); }
  res.clearCookie('discord_oauth');
  if (!savedState || !state || savedState.state !== state) return res.redirect('/login?error=oauth_state');

  try {
    // ── Step 1: Exchange code for access token ─────────────────
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

    // ── Step 2: Fetch Discord identity ───────────────────────
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
          console.warn('[Auth] User not in guild · denying');
          return res.redirect('/denied?reason=not_in_server');
        }
        console.warn('[Auth] Not in guild but developer/granted · allowing');
      }
    } catch (memberErr) {
      console.error('[Auth] Guild member fetch threw:', memberErr.message);
      if (!isDeveloper && !grant) return res.redirect('/denied?reason=not_in_server');
    }

    // ── Step 4: Determine system role ───────────────────────
    // The IA group rank is also snapshotted onto the user (iaRank/iaRankName)
    // because the site role collapses every investigator tier into "IA" — the
    // SI+ gate on case appeals needs the real rank. See lib/iaRank.js.
    let iaRank = null, iaRankName = null;
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
            iaRankName = groupRole.name || null;
            iaRank     = groupRole.rank != null ? Number(groupRole.rank) : null;
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
        console.log('[Auth] Discord-role fallback · HICOMM:', hasHICOMM, '| SUPERVISOR:', hasSUPERVISOR, '| IA:', hasIA);
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
    // role at all — the dashboard login must not gate on IA membership alone.
    // Division membership comes from each division's Roblox group rank
    // (resolveDivisionsForUser resolves the user's Roblox id internally).
    // Only block login entirely when the user has neither an IA system role
    // nor access to any other division.
    const _mroA = await prisma.user.findUnique({ where: { discordId: discordUser.id },
      select: { metRankOverride: true, panelGrant: true, divisions: true } }).catch(() => null);
    const _diagA = {};
    let divisions = await resolveDivisionsForUser({ discordId: discordUser.id, siteRole: systemRole,
      metRankOverride: _mroA?.metRankOverride || null, panelGrant: _mroA?.panelGrant || null, diag: _diagA });
    // A login that could not reach Roblox or RoVer must not overwrite a good list
    // with a short one. Signing in is the moment somebody NOTICES their divisions
    // are gone, and it used to be the moment that made it permanent.
    if (_diagA.degraded) {
      const kept = Array.isArray(_mroA?.divisions) ? _mroA.divisions : [];
      if (kept.length > divisions.length) {
        console.warn(`[Auth] Division lookup degraded for ${discordUser.id} · keeping the `
          + `${kept.length} stored division(s) rather than writing ${divisions.length}.`);
        divisions = kept;
      }
    }
    // MET High Command counts as HICOMM dashboard-wide (incl. the IA HICOMM tools).
    systemRole = effectiveSiteRole(systemRole, divisions);
    console.log('[Auth] Divisions resolved:', divisions.map(d => `${d.division}:${d.tier}`).join(', ') || 'none');

    // Anyone in the MET Discord may sign in — being in the guild (checked above)
    // is the only requirement. A member with no IA role and no division group
    // rank still gets a base account (role NONE) and can use the hub/profile;
    // division-gated features stay gated by requireDivision. We NO LONGER deny
    // login for "no role" — that locked out ordinary members who are allowed in.
    console.log('[Auth] System role assigned:', systemRole || '(none · signed in, no division access yet)');

    // ── Login lockdown: developers only ───────────────────────
    if (!isDeveloper && siteConfig.isOn('loginLockdown')) {
      console.log('[Auth] Login blocked by lockdown for non-developer.');
      return res.redirect('/denied?reason=lockdown');
    }

    // ── Step 5: Upsert user in database ───────────────────────
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
          // Reflect the resolved IA site role — NONE when there isn't one, so a
          // division-only member (e.g. CID group but no IA role) is never left
          // with the old default IA role and its IA access. Their division
          // access comes from `divisions`, not `role`.
          role:            systemRole || 'NONE',
          // Only write the IA rank when we actually read it — a transient
          // RoVer/group failure must not wipe a good snapshot.
          ...(iaRankName != null ? { iaRankName } : {}),
          ...(iaRank     != null ? { iaRank }     : {}),
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
          role:            systemRole || 'NONE',
          ...(iaRankName != null ? { iaRankName } : {}),
          ...(iaRank     != null ? { iaRank }     : {}),
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

      // XP imported for their Roblox account before anyone knew their Discord id.
      // A login is the first moment the two are tied together, so it is the right
      // place to settle it. Fire-and-forget: it can only raise a balance, and a
      // login must not fail because an XP claim did.
      if (rbxId || rbxName) {
        require('../lib/xp').claimPending({
          discordId: discordUser.id, robloxId: rbxId, robloxUsername: rbxName,
        }).then(c => {
          if (c && c.raised > 0) {
            console.log(`[Auth] Claimed ${c.raised} imported XP for ${rbxName || rbxId} `
              + `(${c.before} → ${c.after})`);
          }
        }).catch(err => console.warn('[Auth] XP claim skipped:', err.message));
      }
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
  // Advanced alt detection + VPN blocking (developer-toggleable, fails open).
  try {
    const { getClientIp } = require('../middleware/visit');
    const guard = require('../lib/accessGuard');
    const verdict = await guard.evaluateLogin({ ip: getClientIp(req), user });
    if (verdict.block) {
      try {
        require('../lib/audit').record({
          req, action: 'LOGIN_BLOCKED_ALT',
          category: 'SECURITY', targetType: 'user', targetId: user.id,
          summary: `Login blocked · detected as an alt of a blacklisted account${verdict.detail && verdict.detail.of ? ' (' + verdict.detail.of + ')' : ''}`,
        });
      } catch (e) {}
      return res.redirect('/denied?reason=' + verdict.reason);
    }
  } catch (e) { /* fail open — never block a login on a guard error */ }

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
  // Rolling "remember me" window. The session slides forward on activity
  // (see requireAuth) so a returning browser stays signed in until the user
  // logs out manually. Configurable via SESSION_DAYS; defaults to 60 days.
  const SESSION_DAYS = parseInt(process.env.SESSION_DAYS, 10) || 60;
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

// ── POST /auth/logout ──────────────────────────────────────
router.post('/logout', async (req, res) => {
  // CSRF hardening (logout CSRF → forced sign-out). A cross-site POST cannot
  // carry the SameSite=Lax auth cookie, so:
  //  • refuse a browser-reported cross-site request outright (covers the
  //    transitional Lax+POST edge on modern browsers), and
  //  • only act when a real own-session token is actually present — never clear
  //    the cookie for a request that arrived without one.
  if ((req.get('sec-fetch-site') || '') === 'cross-site') return res.status(403).end();
  const token = req.cookies?.iacms_token;
  if (!token) return res.redirect('/login');
  // Revoke the server-side session so the token can never be replayed elsewhere.
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload?.sid) {
      await prisma.session.update({
        where: { id: payload.sid },
        data:  { revokedAt: new Date() },
      }).catch(() => {});
    }
  } catch (e) { /* token invalid/expired — still clear the useless cookie below */ }
  res.clearCookie('iacms_token');
  res.redirect('/login');
});

// ──────────────────────────────────────────────────
// Sign in with Roblox (Roblox OAuth 2.0 / OIDC). Resolves the user's Discord
// automatically — first from a stored account (robloxId already on file → NO
// RoVer call), else via RoVer's roblox-to-discord reverse lookup. Roblox's own
// OAuth is not RoVer, so we read its userinfo freely; the RoVer reverse lookup
// (the rate-limited bit) is skipped whenever we already know the account.
// ──────────────────────────────────────────────────
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
    const _mroB = await prisma.user.findUnique({ where: { discordId },
      select: { metRankOverride: true, panelGrant: true, divisions: true } }).catch(() => null);
    const _diagB = {};
    let divisions = await resolveDivisionsForUser({ discordId, siteRole: systemRole, robloxId,
      metRankOverride: _mroB?.metRankOverride || null, panelGrant: _mroB?.panelGrant || null, diag: _diagB });
    if (_diagB.degraded) {
      const kept = Array.isArray(_mroB?.divisions) ? _mroB.divisions : [];
      if (kept.length > divisions.length) {
        console.warn(`[Auth] Division lookup degraded for ${discordId} · keeping the `
          + `${kept.length} stored division(s) rather than writing ${divisions.length}.`);
        divisions = kept;
      }
    }
    // MET High Command counts as HICOMM dashboard-wide (incl. the IA HICOMM tools).
    systemRole = effectiveSiteRole(systemRole, divisions);
    // Anyone in the MET Discord (guild membership checked above) may sign in —
    // no role/division required; they just get a base NONE account.
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

    // Signing in with Roblox is the strongest link there is between the two
    // accounts, so it is the best possible moment to hand over XP that was
    // imported against the Roblox side. Fire-and-forget, as on the Discord path.
    require('../lib/xp').claimPending({ discordId, robloxId, robloxUsername })
      .then(c => {
        if (c && c.raised > 0) {
          console.log(`[Auth] Claimed ${c.raised} imported XP for ${robloxUsername || robloxId} `
            + `(${c.before} → ${c.after})`);
        }
      })
      .catch(err => console.warn('[Auth] XP claim skipped:', err.message));

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
router.describeDevice = describeDevice;
router.simpleDevice = simpleDevice;

module.exports = router;
