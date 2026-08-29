// server/lib/punishmentPersist.js
// Punishment roles survive leaving and rejoining the server.
//
// Discord throws a member's roles away the moment they leave. Without this,
// every punishment role is a suggestion: pick up a strike, leave, come back,
// and the strike is gone from the server even though it is still on the record.
//
// That has always mattered. It matters MORE now that /infract treats the
// role as the truth — a strike the officer isn't wearing is discounted, and
// their next Strike 1 goes through as a Strike 1. Which is right when the role
// was taken off deliberately, and wrong if it vanished because they rejoined
// and this file didn't put it back. So this is the thing standing between "the
// roles are authoritative" and "leaving the server wipes your record", and it
// is written to be exactly as careful as that makes it.
//
// What it re-applies, from the same two tables the strike counter reads:
//
//   MetPunishment    rows that are active and not past their expiry
//   CasePunishment   roles from APPROVED cases, not lifted, not expired
//
// What it never re-applies: anything expired, lifted by an appeal, marked
// inactive, or belonging to a case that isn't approved. Those are precisely the
// cases where the role is supposed to be gone.
//
// Roles are resolved through ACTION_CONFIG at re-apply time rather than from
// whatever id was stored, so a role since re-created with a new id resolves to
// the current one — with the stored id kept as a fallback for actions that have
// left the config entirely.
//
// Set PUNISHMENT_REAPPLY=off to disable.

const prisma = require('./db');
const { ACTION_CONFIG } = require('./actions');

// The guild the punishment roles live in. Historically DISCORD_GUILD_ID; the
// MET server is configured separately and the roles are in fact there, so both
// count — checking one and silently doing nothing in the other is how this
// quietly stopped working before.
function punishmentGuildIds() {
  return [...new Set([process.env.DISCORD_GUILD_ID, process.env.MET_GUILD_ID]
    .filter(Boolean).map(String))];
}

/**
 * Every punishment role a member should currently be wearing.
 *
 * Deduplicated by role id, because one role can be owed by several rows (two
 * separate cases, or the MetPunishment and CasePunishment halves of the same
 * /infract action) and adding it twice is a wasted API call. The reasons are
 * merged rather than dropped so the audit line names every claim on the role.
 *
 * @returns {Promise<Array<{ roleId: string, action: string, why: string, claims: number }>>}
 */
/**
 * Every Discord account this person is known on.
 *
 * Punishments are stored against a Discord id, but the person is a ROBLOX
 * account. Looking up by Discord id alone means a punished member who comes back
 * on a second Discord account, re-verified to the same Roblox user, is a
 * stranger with a clean slate — the record was real, it was just filed under a
 * key nobody checked.
 *
 * Never throws and never returns an empty list: the account being asked about is
 * always in it, so a failure here degrades to exactly the old behaviour.
 */
async function linkedAccounts(discordId) {
  const ids = new Set([String(discordId)]);
  try {
    // Their Roblox id, from RoVer or our own link.
    let robloxId = null;
    try {
      const link = await require('./robloxLink').resolveRoblox(String(discordId));
      if (link && link.robloxId) robloxId = String(link.robloxId);
    } catch (e) { /* unresolved */ }
    if (!robloxId) {
      const me = await prisma.user.findUnique({
        where: { discordId: String(discordId) }, select: { robloxId: true },
      }).catch(() => null);
      if (me && me.robloxId) robloxId = String(me.robloxId);
    }
    if (!robloxId) return [...ids];

    // Every dashboard account on that Roblox id.
    const users = await prisma.user.findMany({
      where: { robloxId }, select: { discordId: true },
    }).catch(() => []);
    for (const u of users) if (u.discordId) ids.add(String(u.discordId));

    // And every account a case has ever been filed against for it. A punished
    // person may never have signed in, so the case table is the other half of
    // the identity.
    const cases = await prisma.case.findMany({
      where: { robloxUserId: robloxId, officerDiscordId: { not: null } },
      select: { officerDiscordId: true }, take: 100,
    }).catch(() => []);
    for (const c of cases) if (c.officerDiscordId) ids.add(String(c.officerDiscordId));
  } catch (e) { /* the caller's own id is always enough to carry on with */ }
  return [...ids];
}

/**
 * @param {string} discordId
 * @param {object} [opts]
 * @param {string[]} [opts.accounts] every Discord id this person is known on.
 *   Defaults to just `discordId`; pass the linked set to make the lookup follow
 *   the person rather than the account.
 */
async function rolesOwedTo(discordId, { accounts } = {}) {
  const ids = (accounts && accounts.length) ? accounts.map(String) : [String(discordId)];
  const owed = new Map();   // roleId → { roleId, action, why, claims }
  const now = new Date();

  const add = (roleId, action, why) => {
    const key = String(roleId);
    const prev = owed.get(key);
    if (!prev) { owed.set(key, { roleId: key, action, why, claims: 1 }); return; }
    prev.claims++;
    if (!prev.why.includes(why)) prev.why += `, ${why}`;
  };

  // Direct actions (/infract, the Discord infraction ingest).
  try {
    const rows = await prisma.metPunishment.findMany({
      where: {
        discordId: { in: ids },
        active: true,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { type: true, caseRef: true, issuedAt: true },
    });
    for (const r of rows) {
      const cfg = ACTION_CONFIG[r.type];
      if (!cfg || !cfg.roleId) continue;      // ingest rows use loose labels; nothing to re-apply
      add(cfg.roleId, r.type, r.caseRef ? `active punishment ${r.caseRef}` : 'active punishment');
    }
  } catch (e) { /* a query failure must not stop the member joining */ }

  // Case-issued punishments.
  try {
    const rows = await prisma.casePunishment.findMany({
      where: {
        roleRemoved: false,
        roleId: { not: null },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        case: { officerDiscordId: { in: ids }, status: 'APPROVED' },
      },
      select: { action: true, roleId: true, case: { select: { caseRef: true } } },
    });
    for (const r of rows) {
      // Prefer the CURRENT configured role for the action; fall back to the id
      // snapshotted on the punishment for actions no longer in the config.
      const cfg = ACTION_CONFIG[r.action];
      const roleId = (cfg && cfg.roleId) || r.roleId;
      if (!roleId) continue;
      add(roleId, r.action, r.case && r.case.caseRef ? `case ${r.case.caseRef}` : 'approved case');
    }
  } catch (e) { /* ditto */ }

  return [...owed.values()];
}

// Errors worth trying again: Discord 5xx and rate limits. A 403 (missing
// permission) or 404 (role gone) will fail identically forever, so retrying
// those just delays the member's join for nothing.
function isTransient(err) {
  const status = err && (err.status || err.httpStatus);
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500) return true;
  const msg = String((err && err.message) || '');
  return /timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed/i.test(msg);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Put back whatever a rejoining member should be wearing.
 *
 * Best-effort and silent when there's nothing to do — most joins are clean.
 * Never throws: a member joining must not be blocked by any of this.
 *
 * @returns {Promise<{
 *   restored: string[],   actions whose role is now on them
 *   failed: string[],     actions we could not restore, with the reason
 *   skipped: number,      already wearing it
 *   unusable: string[],   roles the bot cannot apply (missing, or above it)
 * }>}
 */
async function reapplyOnJoin(member) {
  const out = { restored: [], failed: [], skipped: 0, unusable: [] };
  if (!member || !member.id || process.env.PUNISHMENT_REAPPLY === 'off') return out;

  const guilds = punishmentGuildIds();
  const here = String((member.guild && member.guild.id) || '');
  if (!guilds.length || !guilds.includes(here)) return out;

  let owed;
  try {
    // Follow the PERSON, not the account: a punished member returning on a
    // second Discord account verified to the same Roblox user is owed the same
    // roles as the account that was punished.
    const accounts = await linkedAccounts(member.id).catch(() => [String(member.id)]);
    owed = await rolesOwedTo(member.id, { accounts });
  } catch (e) { owed = []; }
  if (!owed.length) return out;

  // Split what's actually applicable from what isn't, BEFORE touching the API.
  // A role that doesn't exist in this guild, or sits above the bot in the
  // hierarchy, will fail every time — naming it is far more use than a stack of
  // identical 403s in the log.
  const guild = member.guild;
  const me = guild && guild.members ? guild.members.me : null;
  const myTop = me && me.roles && me.roles.highest ? me.roles.highest.position : null;
  const toAdd = [];
  for (const item of owed) {
    if (member.roles && member.roles.cache && member.roles.cache.has(item.roleId)) { out.skipped++; continue; }
    const role = guild && guild.roles && guild.roles.cache ? guild.roles.cache.get(item.roleId) : null;
    // An uncached role isn't necessarily a missing one, so only rule it out
    // when the guild's role cache is actually populated.
    const cacheUsable = guild && guild.roles && guild.roles.cache && guild.roles.cache.size > 0;
    if (cacheUsable && !role) { out.unusable.push(`${item.action}: role ${item.roleId} no longer exists`); continue; }
    if (role && myTop != null && role.position >= myTop) {
      out.unusable.push(`${item.action}: role is above the bot in the hierarchy`);
      continue;
    }
    if (role && role.managed) { out.unusable.push(`${item.action}: role is managed by an integration`); continue; }
    toAdd.push(item);
  }
  if (!toAdd.length) { report(member, out); return out; }

  const reason = (items) => `Punishment still active on rejoin · `
    + items.map(i => `${i.action} (${i.why})`).join('; ');

  // One PATCH for the lot. Discord takes a whole role array, and a member who
  // rejoins with three punishments should not generate three separate audit-log
  // entries and three chances to be rate-limited.
  const attempt = async (fn) => {
    for (let tries = 0; ; tries++) {
      try { return await fn(); } catch (err) {
        if (tries >= 2 || !isTransient(err)) throw err;
        await sleep(500 * Math.pow(2, tries));   // 500ms, 1s
      }
    }
  };

  try {
    await attempt(() => member.roles.add(toAdd.map(i => i.roleId), reason(toAdd)));
    out.restored.push(...toAdd.map(i => i.action));
  } catch (err) {
    // The batch failed. It may have been ONE bad role taking the rest down with
    // it, so fall back to one at a time — restoring two of three punishments is
    // a much better outcome than restoring none.
    for (const item of toAdd) {
      try {
        await attempt(() => member.roles.add(item.roleId, reason([item])));
        out.restored.push(item.action);
      } catch (e2) {
        out.failed.push(`${item.action}: ${e2.message}`);
      }
    }
  }

  // Confirm rather than assume. The API returning 2xx and the member actually
  // wearing the role are different claims, and this one is worth checking:
  // /infract reads the role as proof, so a role we only THINK we restored
  // silently clears a strike.
  try {
    const fresh = await member.fetch(true).catch(() => null);
    if (fresh && fresh.roles && fresh.roles.cache) {
      for (const item of toAdd) {
        if (out.restored.includes(item.action) && !fresh.roles.cache.has(item.roleId)) {
          out.restored = out.restored.filter(a => a !== item.action);
          out.failed.push(`${item.action}: Discord accepted the change but the role is not on them`);
        }
      }
    }
  } catch (e) { /* verification is a bonus, not a requirement */ }

  report(member, out);
  return out;
}

// One line per rejoin, and only when something happened. Failures are warnings,
// not info: an unrestored strike is a punishment that has effectively been
// lifted by leaving the server, and somebody needs to see that.
function report(member, out) {
  if (out.restored.length) {
    console.log(`[Punishments] ${member.id} rejoined · restored ${out.restored.join(', ')}`
      + (out.skipped ? ` · ${out.skipped} already worn` : ''));
  }
  if (out.failed.length) {
    console.warn(`[Punishments] ${member.id} rejoined · COULD NOT restore: ${out.failed.join(' | ')}`);
  }
  if (out.unusable.length) {
    console.warn(`[Punishments] ${member.id} rejoined · unusable roles: ${out.unusable.join(' | ')}`);
  }
}

module.exports = { rolesOwedTo, reapplyOnJoin, punishmentGuildIds, linkedAccounts };
