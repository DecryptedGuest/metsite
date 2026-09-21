'use strict';

const prisma = require('./db');

const MET_GROUP = () => String(process.env.GROUP_MET || '17275620');

function nullable(v) { return v === undefined ? null : v; }

async function linkedAccounts(robloxId) {
  const out = { users: [], viaRover: [], portalOk: false, roverOk: false };
  try {
    out.users = await prisma.user.findMany({
      where: { robloxId: String(robloxId) },
      select: { id: true, discordId: true, discordUsername: true, robloxUsername: true },
    });
    out.portalOk = true;
  } catch (e) { out.users = []; }
  try {
    const { getDiscordFromRoblox } = require('./roblox');
    const m = await getDiscordFromRoblox(String(robloxId));
    out.viaRover = Array.isArray(m) ? m.map(x => String(x.discordId || x.id)).filter(Boolean) : [];
    out.roverOk = true;
  } catch (e) { out.viaRover = []; }
  return out;
}

async function otherRobloxOnSameDiscord(discordIds, robloxId) {
  if (!discordIds.length) return { rows: [], ok: true };
  try {
    const rows = await prisma.user.findMany({
      where: { discordId: { in: discordIds }, robloxId: { not: null } },
      select: { discordId: true, robloxId: true, robloxUsername: true },
    });
    return { rows: rows.filter(r => String(r.robloxId) !== String(robloxId)), ok: true };
  } catch (e) { return { rows: [], ok: false }; }
}

// ── Identity: who is this Roblox player in the MET Discord server ──────
//
// The rule is membership of the MET server, and we recognise somebody by their
// Roblox username sitting in their server nickname. Nicknames look like
// "PC 442 | realangeloo", so the username has to be one of the nickname's own
// tokens rather than any substring of it: a substring match would let the
// three letter end of one name swallow half the server.
//
// Underscore is NOT a separator, because Roblox usernames contain it.
function nickTokens(value) {
  return String(value == null ? '' : value)
    .split(/[^A-Za-z0-9_]+/)
    .filter(Boolean)
    .map(t => t.toLowerCase());
}

// The server nickname only, deliberately. A member with no nickname set cannot
// be recognised this way, and the hint prompt is what rescues them.
function nickCarries(member, robloxUsername) {
  const want = String(robloxUsername || '').trim().toLowerCase();
  if (!want) return false;
  return nickTokens(member && member.nickname).includes(want);
}

function hintMatches(member, hint) {
  const h = String(hint || '').trim().replace(/^@/, '').toLowerCase();
  if (!h) return false;
  if (/^\d{15,25}$/.test(h)) return String(member.id) === h;
  const fields = [member.username, member.globalName, member.nickname].filter(Boolean);
  if (fields.some(v => String(v).toLowerCase() === h)) return true;
  // A nickname is worth matching token by token too, so "realangeloo" finds
  // "PC 442 | realangeloo" without the player having to type the rank.
  return nickTokens(member.nickname).includes(h);
}

const UNRESOLVED = {
  resolved: false, matchedBy: null, discordId: null, discordUsername: null, discordNickname: null,
  discordAvatarAssetId: null, discordAvatarUrl: null,
};

function resolvedFrom(member, matchedBy) {
  return {
    resolved: true,
    matchedBy,
    discordId: String(member.id),
    discordUsername: member.username || null,
    discordNickname: member.nickname || null,
    // The picture is filled in by the caller, which is where the await belongs.
    discordAvatarAssetId: null,
    discordAvatarUrl: null,
  };
}

/**
 * Work out who this Roblox player is in the MET server.
 *
 * @returns {{ identity, inMetServer: boolean|null, reason: string|null }}
 *   inMetServer is null wherever we could not tell, which is every case except
 *   a confident match (true) and a portal session whose member is genuinely
 *   absent (false). "Nobody matched the nickname" is NOT false: the player may
 *   well be in the server under a nickname we cannot read, which is what the
 *   hint prompt is for.
 */
async function resolveIdentity(robloxUsername, opts = {}) {
  const bot = require('./bot');

  // The portal already knows who is signed in, so there is nothing to guess at.
  if (opts.discordId) {
    let members = null;
    try { members = await bot.listMetServerMembers(); } catch (e) { members = null; }
    if (!members) return { identity: UNRESOLVED, inMetServer: null, reason: null };
    const found = members.find(m => String(m.id) === String(opts.discordId));
    if (!found) {
      return {
        identity: UNRESOLVED,
        inMetServer: false,
        reason: 'You are not in the MET Discord server. Join it and then try again.',
      };
    }
    return { identity: resolvedFrom(found, 'session'), member: found, inMetServer: true, reason: null };
  }

  if (!robloxUsername) return { identity: UNRESOLVED, inMetServer: null, reason: null };

  const hint = String(opts.hint == null ? '' : opts.hint).trim().slice(0, 64);

  let members = null;
  try { members = await bot.listMetServerMembers(); } catch (e) { members = null; }
  if (!members) {
    // A hint means the player has already been prompted once and typed
    // something. Saying nothing leaves them staring at a refusal, and saying we
    // could not find their account blames them for an outage that is ours.
    return {
      identity: UNRESOLVED,
      inMetServer: null,
      reason: hint ? 'We cannot check the MET Discord server right now. Try again in a minute.' : null,
    };
  }

  if (hint) {
    // The hint finds candidates. It never vouches for them: the nickname still
    // has to carry the caller's Roblox username, or anyone could name a member
    // and be treated as them.
    const candidates = members.filter(m => hintMatches(m, hint));
    if (!candidates.length) {
      return {
        identity: UNRESOLVED,
        inMetServer: null,
        reason: 'We could not find that Discord account in the MET server. Check the spelling and try again.',
      };
    }
    const verified = candidates.filter(m => nickCarries(m, robloxUsername));
    if (verified.length === 1) {
      return { identity: resolvedFrom(verified[0], 'hint'), member: verified[0], inMetServer: true, reason: null };
    }
    if (!verified.length) {
      return {
        identity: UNRESOLVED,
        inMetServer: null,
        reason: 'That Discord account does not have your Roblox username in its nickname in the MET server.',
      };
    }
    return {
      identity: UNRESOLVED,
      inMetServer: null,
      reason: 'More than one Discord account in the MET server matches that. Tell us your Discord user id instead.',
    };
  }

  const matches = members.filter(m => nickCarries(m, robloxUsername));
  if (matches.length === 1) {
    return { identity: resolvedFrom(matches[0], 'nickname'), member: matches[0], inMetServer: true, reason: null };
  }
  // None, or more than one. Either way we cannot say who they are, so the game
  // asks them rather than us guessing or declaring them absent.
  return { identity: UNRESOLVED, inMetServer: null, reason: null };
}

async function metStanding(robloxId) {
  let accepted = null;
  try {
    const { getUserGroupRole } = require('./roblox');
    const role = await getUserGroupRole(String(robloxId), MET_GROUP());
    accepted = !!(role && (role.id || role.rank || role.name));
  } catch (e) { accepted = null; }

  let pending = null;
  try {
    const cookie = process.env.ROBLOX_COOKIE || process.env.ROBLOX_GROUP_COOKIE || null;
    if (cookie) {
      const { listJoinRequests } = require('./roblox');
      let token = null, found = false, pages = 0;
      do {
        const page = await listJoinRequests(token, MET_GROUP(), cookie);
        const data = (page && page.data) || [];
        if (data.some(r => String(r.requester && r.requester.userId) === String(robloxId))) { found = true; break; }
        token = page && page.nextPageCursor ? page.nextPageCursor : null;
        pages += 1;
      } while (token && pages < 20);
      pending = found;
    }
  } catch (e) { pending = null; }

  return { accepted, pending };
}

async function blacklistStanding(robloxId, username) {
  try {
    const { gatherRecord } = require('./evasion');
    const rec = await gatherRecord({ robloxId: String(robloxId), robloxUsername: username || null });
    const sources = (rec && rec.blacklistSources) || [];
    if (sources.length) {
      return {
        blacklisted: true,
        reason: sources[0].reason || sources[0].ref || null,
        linkedDiscordIds: (rec && rec.otherAccounts) || [],
      };
    }
    // No sources found is only a clean record if every lookup actually ran.
    // gatherRecord never throws, it degrades, so the outer catch below would
    // never have seen this.
    if (rec && Array.isArray(rec.degraded) && rec.degraded.length) {
      return { blacklisted: null, reason: null, linkedDiscordIds: (rec && rec.otherAccounts) || [] };
    }
    return { blacklisted: false, reason: null, linkedDiscordIds: (rec && rec.otherAccounts) || [] };
  } catch (e) {
    return { blacklisted: null, reason: null, linkedDiscordIds: [] };
  }
}

async function checkEligibility(robloxUserId, opts = {}) {
  const robloxId = String(robloxUserId || '').trim();
  if (!robloxId || !/^\d+$/.test(robloxId)) {
    return { ok: false, error: 'A numeric Roblox user id is required.' };
  }

  let username = opts.username || null;
  if (!username) {
    try {
      const { getRobloxUserInfo } = require('./roblox');
      const u = await getRobloxUserInfo(robloxId);
      username = (u && u.username) || null;
    } catch (e) { username = null; }
  }

  const [links, met, bl, who] = await Promise.all([
    linkedAccounts(robloxId),
    metStanding(robloxId),
    blacklistStanding(robloxId, username),
    resolveIdentity(username, { hint: opts.hint, discordId: opts.discordId }),
  ]);

  const identity    = who.identity;
  const inMetServer = who.inMetServer;

  // The Discord picture, for the in game confirmation card. Only an asset id
  // Roblox has already approved comes back: one still in review renders as
  // nothing, so handing it over would show a broken image where the game's own
  // fallback belongs. Anything not held yet is asked for in the background, so
  // this never holds up an answer and never fails one.
  if (who.member) {
    try {
      const { assetIdFor } = require('./discordAvatar');
      const pic = await assetIdFor(who.member, require('./bot').metServerGuildId());
      identity.discordAvatarAssetId = pic.assetId;
      identity.discordAvatarUrl = pic.url;
    } catch (e) { /* the card falls back to the Discord logo */ }
  }

  // The alt check still works off whatever Discord accounts we can associate
  // with this Roblox id, which now includes the member we just identified.
  const discordIds = [...new Set([
    ...links.users.map(u => String(u.discordId)),
    ...links.viaRover,
    identity.discordId,
  ].filter(Boolean))];

  const others = await otherRobloxOnSameDiscord(discordIds, robloxId);
  const otherRoblox = others.rows;
  const manyDiscord = discordIds.length > 1;
  const manyRoblox  = otherRoblox.length > 0;
  const multiAccount = (manyDiscord || manyRoblox) ? true
                     : (links.portalOk && others.ok) ? false
                     : null;


  let multiAccountDetail = null;
  if (manyDiscord && manyRoblox) {
    multiAccountDetail = `This Roblox account is linked to ${discordIds.length} Discord accounts, and one of those is also linked to ${otherRoblox.length} other Roblox account(s).`;
  } else if (manyDiscord) {
    multiAccountDetail = `This Roblox account is linked to ${discordIds.length} different Discord accounts.`;
  } else if (manyRoblox) {
    const names = otherRoblox.map(r => r.robloxUsername || r.robloxId).slice(0, 3).join(', ');
    multiAccountDetail = `The Discord account linked here is also linked to another Roblox account (${names}).`;
  }

  const metPending = (met.accepted === true || met.pending === true) ? true
                   : (met.accepted === false && met.pending === false) ? false
                   : null;

  // Spoken aloud by the instructor NPC, so: whole sentences, plain text, and no
  // dash of any kind anywhere in them.
  const reasons = [];
  if (who.reason) reasons.push(who.reason);
  if (metPending === false) {
    reasons.push('You are not in the MET group and you have no pending join request. Request to join the MET group first.');
  }
  if (bl.blacklisted === true) {
    reasons.push('You are blacklisted from the MET. You cannot attend a tryout.');
  }
  if (bl.blacklisted === null) {
    reasons.push('We could not check the blacklist just now. Try again shortly.');
  }

  // The blacklist is the one check that fails CLOSED. Everywhere else an
  // unknown answer waves somebody through, because turning away a legitimate
  // trainee over a database blip is the worse outcome. Here it is the other way
  // round: letting a blacklisted person into a tryout is the exact harm this
  // check exists to prevent, so it has to be a definite no before we say yes.
  const eligible = inMetServer !== false && metPending !== false && bl.blacklisted === false;

  return {
    ok: true,
    eligible,
    robloxId,
    username,
    identity,
    checks: {
      inMetServer,
      metPending,
      blacklisted: nullable(bl.blacklisted),
      multiAccount,
      multiAccountDetail,
    },
    undetermined: [
      inMetServer === null ? 'inMetServer' : null,
      metPending === null ? 'metPending' : null,
      bl.blacklisted === null ? 'blacklisted' : null,
      multiAccount === null ? 'multiAccount' : null,
    ].filter(Boolean),
    reasons,
  };
}

module.exports = { checkEligibility };
