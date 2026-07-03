// server/lib/accessControl.js
// Periodically re-derives each active user's site role from Discord/Roblox so
// that members who lose their roles also lose site access. requireAuth reads the
// role live from the DB, so updating it here takes effect on the next request.
const prisma = require('./db');
const { resolveSiteRoleDetailed, resolveDivisionsForUser } = require('./roleResolver');

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
  const stamp = { lastRoleCheck: new Date(), divisions };

  if (newRole) {
    if (newRole !== user.role) {
      await prisma.user.update({ where: { id: user.id }, data: { ...stamp, role: newRole } });
      console.log(`[Access] ${user.discordUsername} role ${user.role} → ${newRole}.`);
      return 'changed';
    }
    await prisma.user.update({ where: { id: user.id }, data: stamp });
    return 'unchanged';
  }

  // No role resolved. Only revoke when we're CERTAIN: the bot confirms they're
  // in the guild AND the rank lookup was conclusive. A transient RoVer failure
  // (inconclusive) must never revoke — that was booting valid users on login.
  if (inDiscord === true && conclusive) {
    if (!user.mustReauth) {
      await prisma.user.update({ where: { id: user.id }, data: { ...stamp, mustReauth: true } });
      console.log(`[Access] Revoked ${user.discordUsername} (${user.discordId}) — confirmed no qualifying role.`);
      return 'revoked';
    }
    await prisma.user.update({ where: { id: user.id }, data: stamp });
    return 'already-revoked';
  }

  // Inconclusive — leave access as-is and just record that we checked.
  await prisma.user.update({ where: { id: user.id }, data: stamp });
  return 'inconclusive-skip';
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

module.exports = { startAccessRevalidator, revalidateUser, revalidateBatch };
