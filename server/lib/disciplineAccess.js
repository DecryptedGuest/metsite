// server/lib/disciplineAccess.js
// Who is allowed to run /discipline.
//
// Two groups, as asked for: Internal Affairs, and Deputy Commissioner or above
// in the MET group.
//
// The site already knows both of those things about anyone who has logged in,
// so the first thing we try is their portal account. But plenty of MET High
// Command have never touched the portal, and refusing a Deputy Commissioner
// because they haven't logged into a website would be an absurd way for this to
// fail. So there are three routes in, checked in order of how cheap and how
// certain they are:
//
//   1. their portal account's IA role                (no network calls)
//   2. a configured Discord role in the MET server   (no network calls)
//   3. their live MET group rank via RoVer + Roblox  (two API calls, cached)
//
// Env:
//   IA_COMMAND_ROLE_IDS  comma-separated Discord roles that count as IA
//   METHICOMM_ROLE_ID    the MET High Command Discord role (already used site-wide)
//   METHICOMM_MIN_RANK / METHICOMM_RANK_NAME  the DC threshold (see metRank.js)

const prisma = require('./db');

const IA_SITE_ROLES = new Set(['IA', 'SUPERVISOR', 'HICOMM', 'DEVELOPER']);

function idList(v) {
  return String(v || '').split(',').map(s => s.trim()).filter(Boolean);
}

// Short-lived cache. The group-rank route costs two Roblox calls, and somebody
// issuing several strikes in a row shouldn't pay for them each time.
const cache = new Map();   // discordId → { at, verdict }
const TTL = 5 * 60 * 1000;

/**
 * @param {string} discordId
 * @param {string[]} roleIds the invoker's role ids in the guild they ran the command in
 * @returns {Promise<{ ok: boolean, via: string|null, label: string, name: string|null, why: string|null }>}
 *   `label` is how they should be described on the log ("Internal Affairs",
 *   "Deputy Commissioner"), `why` explains a refusal.
 */
async function canDiscipline(discordId, roleIds = []) {
  const hit = cache.get(String(discordId));
  if (hit && Date.now() - hit.at < TTL) return hit.verdict;
  const verdict = await evaluate(String(discordId), roleIds);
  cache.set(String(discordId), { at: Date.now(), verdict });
  return verdict;
}

function forget(discordId) { cache.delete(String(discordId)); }

async function evaluate(discordId, roleIds) {
  const has = id => Array.isArray(roleIds) && roleIds.includes(String(id));

  // 2 first among the no-network checks — a role id match is unambiguous.
  const metHicommRole = process.env.METHICOMM_ROLE_ID;
  if (metHicommRole && has(metHicommRole)) {
    return { ok: true, via: 'discord-role', label: 'MET High Command', name: null, why: null };
  }
  for (const rid of idList(process.env.IA_COMMAND_ROLE_IDS)) {
    if (has(rid)) return { ok: true, via: 'discord-role', label: 'Internal Affairs', name: null, why: null };
  }

  // 1. Their portal account.
  let user = null;
  try {
    user = await prisma.user.findUnique({
      where: { discordId },
      select: {
        role: true, robloxId: true, robloxUsername: true, displayName: true,
        discordUsername: true, iaRankName: true, metRoleIds: true,
        metRankOverride: true, isBlacklisted: true,
      },
    });
  } catch (e) { user = null; }

  const name = user ? (user.displayName || user.discordUsername || null) : null;

  if (user && user.isBlacklisted) {
    return { ok: false, via: null, label: '', name, why: 'Your portal account is blacklisted.' };
  }

  if (user && IA_SITE_ROLES.has(user.role)) {
    return {
      ok: true, via: 'site-role',
      label: user.role === 'DEVELOPER' ? 'Developer' : (user.iaRankName || 'Internal Affairs'),
      name, why: null,
    };
  }

  // 3. Live MET group rank. userIsMetHicomm already handles the site-only rank
  //    override and the DC threshold discovery, so reuse it rather than
  //    re-deriving the threshold here.
  const { userIsMetHicomm, metRole } = require('./metRank');
  let robloxId = user ? user.robloxId : null;
  if (!robloxId) {
    // No portal account (or no link on it) — ask RoVer.
    try {
      const { getRobloxIdFromDiscord } = require('./roblox');
      robloxId = await getRobloxIdFromDiscord(discordId);
    } catch (e) { robloxId = null; }
  }

  if (robloxId) {
    const shell = {
      role: user ? user.role : 'NONE',
      robloxId: String(robloxId),
      metRoleIds: user ? user.metRoleIds : roleIds,
      metRankOverride: user ? user.metRankOverride : null,
    };
    let ok = false;
    try { ok = await userIsMetHicomm(shell); } catch (e) { ok = false; }
    if (ok) {
      let label = 'MET High Command';
      try { const r = await metRole(robloxId); if (r && r.name) label = r.name; } catch (e) { /* keep the generic label */ }
      return { ok: true, via: 'group-rank', label, name, why: null };
    }
  }

  return {
    ok: false, via: null, label: '', name,
    why: robloxId
      ? 'This command is for Internal Affairs and Deputy Commissioner and above.'
      : 'This command is for Internal Affairs and Deputy Commissioner and above. '
        + 'We could not find a Roblox account linked to your Discord — verify with RoVer, or log into the portal once, and try again.',
  };
}

module.exports = { canDiscipline, forget, IA_SITE_ROLES };
