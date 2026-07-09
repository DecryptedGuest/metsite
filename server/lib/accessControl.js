// server/lib/accessControl.js
// Periodically re-derives each active user's site role from Discord/Roblox so
// that members who lose their roles also lose site access. requireAuth reads the
// role live from the DB, so updating it here takes effect on the next request.
const prisma = require('./db');
const { resolveSiteRoleDetailed, resolveDivisionsForUser, effectiveSiteRole } = require('./roleResolver');

const DEVELOPER_DISCORD_ID = () => process.env.DEVELOPER_DISCORD_ID || '1227866745201627137';

// Re-check a single user. Returns a short status string for logging.
async function revalidateUser(user, getMemberRecord) {
  // Developers are never revalidated away.
  if (user.role === 'DEVELOPER' || user.discordId === DEVELOPER_DISCORD_ID()) return 'dev-skip';

  let memberRoles = [];
  let inDiscord = null;
  try {
    const rec = await getMemberRecord(user.discordId);
    inDiscord = rec.inDiscord;
    // inDiscord === null → bot not ready / unknown; skip rather than risk a false revoke
    if (inDiscord === null) return 'unknown-skip';
    memberRoles = rec.roleIds || [];
  } catch (e) {
    return 'fetch-error-skip';
  }

  const { role: newRole, conclusive } =
    await resolveSiteRoleDetailed({ discordId: user.discordId, memberRoles });

  // Refresh the cached per-division access alongside the site role. IA comes
  // from the (freshly resolved) site role; the other divisions come from their
  // Roblox group rank (resolved from the user's stored Roblox link).
  let divisions;
  try {
    divisions = await resolveDivisionsForUser({
      discordId: user.discordId,
      siteRole:  newRole || user.role,
      robloxId:  user.robloxId || null,
    });
  } catch (e) {
    divisions = Array.isArray(user.divisions) ? user.divisions : [];
  }
  // Also refresh the member's Discord role IDs so role-gated features stay
  // current WITHOUT a re-login — e.g. removing the final-exam role hides the
  // exam, losing the British-citizen role hides tryouts, perms flags update.
  // MET High Command counts as HICOMM portal-wide, even with no IA group rank.
  const effRole = effectiveSiteRole(newRole, divisions);
  const stamp = { lastRoleCheck: new Date(), divisions, metRoleIds: memberRoles };

  // A member who has LEFT the MET Discord loses access (confirmed not-in-guild).
  // Being in the guild with NO qualifying role is now VALID — a base NONE
  // account — so we no longer revoke for "no role" (that used to boot ordinary
  // members). `conclusive` guards against a transient lookup wrongly revoking.
  if (inDiscord === false && conclusive) {
    if (!user.mustReauth) {
      await prisma.user.update({ where: { id: user.id }, data: { ...stamp, mustReauth: true } });
      console.log(`[Access] Revoked ${user.discordUsername} (${user.discordId}) — no longer in the MET Discord.`);
      return 'revoked';
    }
    await prisma.user.update({ where: { id: user.id }, data: stamp });
    return 'already-revoked';
  }

  // In the guild (or an inconclusive check — fail open): sync the role. Never a
  // logout. A resolved role wins; otherwise NONE only when the lookup was
  // CONCLUSIVE (they genuinely hold nothing) — on a transient/inconclusive
  // failure keep their existing role rather than downgrading it.
  const roleToSet = effRole || (conclusive ? 'NONE' : user.role);
  if (roleToSet !== user.role) {
    await prisma.user.update({ where: { id: user.id }, data: { ...stamp, role: roleToSet } });
    console.log(`[Access] ${user.discordUsername} role ${user.role} → ${roleToSet}.`);
    return 'changed';
  }
  await prisma.user.update({ where: { id: user.id }, data: stamp });
  return 'unchanged';
}

// ── Blocking freshness check for rank-locked gates ───────────────────
// When a user hits a rank-locked route (a division, a lead tier, HPC marker…)
// and their cached role/divisions are older than GATE_REVALIDATE_TTL_MS, re-
// derive them LIVE before the gate decides — so a member removed from a
// division (or demoted) loses access on THIS request, not a later one, and
// their stored role/divisions/metRoleIds (and thus perms) are corrected.
// Best-effort: on a bot/API failure or an inconclusive lookup it returns the
// user unchanged (fail-open — never a false revoke, matching revalidateUser).
// Concurrent gated requests for the same user share one in-flight re-check.
const GATE_TTL_MS = () => { const n = parseInt(process.env.GATE_REVALIDATE_TTL_MS, 10); return Number.isFinite(n) ? n : 60 * 1000; };
const _gateInflight = new Map(); // userId → Promise

async function ensureFreshUser(user) {
  try {
    if (!user || user.role === 'DEVELOPER') return user;
    const last = user.lastRoleCheck ? new Date(user.lastRoleCheck).getTime() : 0;
    if (Date.now() - last < GATE_TTL_MS()) return user;

    if (!_gateInflight.has(user.id)) {
      _gateInflight.set(user.id, (async () => {
        try {
          const { getMemberRecord } = require('./bot');
          await revalidateUser(user, getMemberRecord);
        } catch (e) { /* fail-open */ }
        finally { _gateInflight.delete(user.id); }
      })());
    }
    await _gateInflight.get(user.id);
    const fresh = await prisma.user.findUnique({ where: { id: user.id } }).catch(() => null);
    return fresh || user;
  } catch (e) {
    return user;
  }
}

// Walk all non-developer users that haven't been checked recently, a few at a
// time, with a small delay to stay friendly to the Discord / RoVer APIs.
async function revalidateBatch() {
  let getMemberRecord;
  try { ({ getMemberRecord } = require('./bot')); }
  catch (e) { return; }

  const STALE_MS = 10 * 60 * 1000; // re-check users older than 10 minutes
  const cutoff   = new Date(Date.now() - STALE_MS);

  try {
    const users = await prisma.user.findMany({
      where: {
        isBlacklisted: false,
        role: { not: 'DEVELOPER' },
        OR: [{ lastRoleCheck: null }, { lastRoleCheck: { lt: cutoff } }],
      },
      orderBy: { lastRoleCheck: { sort: 'asc', nulls: 'first' } },
      take: 10, // batch size per tick
    });

    for (const u of users) {
      try { await revalidateUser(u, getMemberRecord); }
      catch (e) { console.warn('[Access] revalidate error for', u.discordId, e.message); }
      await new Promise(r => setTimeout(r, 1200)); // gentle pacing
    }
  } catch (e) {
    console.error('[Access] revalidateBatch error:', e.message);
  }
}

function startAccessRevalidator() {
  // First sweep shortly after boot (give the bot time to log in), then every 3 min.
  setTimeout(revalidateBatch, 60 * 1000);
  setInterval(revalidateBatch, 3 * 60 * 1000);
}

module.exports = { startAccessRevalidator, revalidateUser, revalidateBatch, ensureFreshUser };
