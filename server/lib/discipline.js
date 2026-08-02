// server/lib/discipline.js
// The engine behind /discipline — direct disciplinary action, no case attached.
//
// The IA case system already does all of this, but only at the end of a case:
// somebody files it, somebody reviews it, and approval fires the side effects.
// Plenty of discipline never needs that ceremony. This is the same machinery
// with the case removed and the case link demoted to an optional field:
//
//   * work out what the officer already has on their record, so a second
//     Strike 1 is offered as a Strike 2 instead of quietly stacking
//   * write the punishment
//   * add the Discord role
//   * demote / exile in the Roblox group when the action calls for it
//   * post the SAME administrative-log embed the case system posts
//   * file it on the portal as an auto-approved case, so it shows in the record
//     and can be appealed like anything else
//   * tell the officer, with a link to their record
//
// Everything in here is deliberately free of discord.js interaction objects so
// it can be tested without a gateway connection. The panel that drives it lives
// in disciplineCommand.js.

const prisma = require('./db');
const { ACTION_CONFIG, ACTION_NAMES } = require('./actions');

// ── Strikes ───────────────────────────────────────────────────────
// "Strike" is a ladder, not a label: a second Strike 1 should be a Strike 2,
// and the whole point of the command is that the issuer doesn't have to go and
// look that up.
//
// Two strikes. There is no third: after two, the next step is Termination — a
// decision somebody makes, not a counter reaching 3.
const STRIKE_ACTIONS = ['Disciplinary Strike 1', 'Disciplinary Strike 2'];
const MAX_STRIKE = STRIKE_ACTIONS.length;

// Strike 3 is retired and can no longer be ISSUED, but officers given one
// before it went still have it. Reading a record uses this wider list; issuing
// uses STRIKE_ACTIONS.
const KNOWN_STRIKE_ACTIONS = [...STRIKE_ACTIONS, 'Disciplinary Strike 3'];

// What comes after the last strike. Never applied automatically; only offered.
const AFTER_LAST_STRIKE = 'Termination';

// Every action the command can issue. No "auto-escalate" pseudo-action — you
// pick the real thing and the panel tells you if their record says otherwise.
const COMMAND_ACTIONS = ACTION_NAMES.slice();

// A strike level out of anything that names one: 'Disciplinary Strike 2' → 2,
// a bare 'STRIKE' → 1 (the ingest writes those for infraction posts that don't
// number themselves).
//
// Strike 3 still reads as 3. It is retired and can no longer be issued, but
// officers who were given one before it went still have it on their record, and
// reading it as anything less would understate where they stand.
function strikeLevelOf(type) {
  const s = String(type || '');
  const numbered = s.match(/strike\s*([123])\b/i);
  if (numbered) return Number(numbered[1]);
  if (/\bstrike\b/i.test(s) && !/activity strike/i.test(s)) return 1;
  return 0;
}

/**
 * The officer's current strike level.
 *
 * THE ROLE IS THE TRUTH. A strike they are not wearing is a strike they do not
 * have, whatever the database still says. Roles get taken off by hand all the
 * time — a strike served, a mistake undone, an amnesty — and none of those ever
 * touch the record. Escalating a Strike 1 to a Strike 2 because of a row nobody
 * has looked at in six months, while the officer plainly wears no strike role,
 * is the command inventing a punishment out of stale data.
 *
 * So the rule is: if we could read their roles, the roles decide. The record
 * still gets read, and anything it claims that the roles don't back is reported
 * as CLEARED so the issuer can see it was considered and discounted — but it
 * does not raise the level and does not trigger an escalation offer.
 *
 * Three things the roles cannot settle, where the record stands in:
 *   · we couldn't read the roles at all (they've left the server, or the fetch
 *     failed) — an unknown is not a clearance, so the record is used
 *   · a strike with no role configured for it — there is no role to be missing,
 *     so "not wearing it" proves nothing and the record is used for that level
 *   · a strike whose configured role does not exist in the server. The action
 *     config carries hard-coded role ids as fallbacks, and a wrong one would
 *     otherwise mean NOBODY ever wears that strike and every record is silently
 *     discounted — a misconfiguration quietly becoming an amnesty. Pass
 *     `guildRoleIds` and a role the server has never heard of stops counting as
 *     evidence of anything.
 *
 * `roleIds` must be null/undefined when the roles are UNKNOWN and an empty
 * array when they are known to be empty. Those two are opposite answers and
 * conflating them is how an officer wearing nothing keeps a phantom strike.
 *
 * @param {object} opts
 * @param {string} opts.discordId
 * @param {string[]|null} [opts.roleIds] current Discord role ids, or null if unknown
 * @param {string[]|null} [opts.guildRoleIds] every role id the server has, if known
 * @returns {Promise<{
 *   level: number,          what they stand at, after the roles have their say
 *   sources: string[],      how that level was established
 *   rolesKnown: boolean,    were the roles readable at all
 *   recordLevel: number,    what the record alone would have said
 *   roleLevel: number,      what the roles alone say
 *   cleared: string[],      strikes on record that no worn role backs
 * }>}
 */
async function currentStrikeLevel({ discordId, roleIds, guildRoleIds }) {
  const rolesKnown = Array.isArray(roleIds);
  const worn = new Set(rolesKnown ? roleIds.map(String) : []);
  // Only meaningful when we were actually given the server's roles; an empty
  // list means "not told", not "the server has no roles".
  const guildRoles = Array.isArray(guildRoleIds) && guildRoleIds.length
    ? new Set(guildRoleIds.map(String)) : null;
  const roleExists = rid => !guildRoles || guildRoles.has(String(rid));
  const now = new Date();

  // What the record claims, level → why.
  const claimed = new Map();
  const claim = (n, why) => { if (n > 0 && !claimed.has(n)) claimed.set(n, why); };

  // 1. Punishment history (/discipline and the Discord infraction ingest).
  //    Only rows that are still live: an inactive or expired punishment is over,
  //    and counting it would hold somebody to a strike they have served.
  try {
    const rows = await prisma.metPunishment.findMany({
      where: {
        discordId: String(discordId),
        active: true,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { type: true, issuedAt: true },
    });
    for (const r of rows) claim(strikeLevelOf(r.type), `${r.type} on record`);
  } catch (e) { /* a missing table must not block the command */ }

  // 2. Strikes from an approved IA case — again only the ones still standing.
  //    roleRemoved is set when an appeal is granted or the punishment expires,
  //    so it is exactly the "this is over" flag.
  try {
    const rows = await prisma.casePunishment.findMany({
      where: {
        action: { in: KNOWN_STRIKE_ACTIONS },
        roleRemoved: false,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        case: { officerDiscordId: String(discordId), status: 'APPROVED' },
      },
      select: { action: true },
    });
    for (const r of rows) claim(strikeLevelOf(r.action), `${r.action} from a case`);
  } catch (e) { /* ditto */ }

  const recordLevel = claimed.size ? Math.max(...claimed.keys()) : 0;

  // 3. What they are actually wearing.
  let roleLevel = 0;
  const sources = [];
  const cleared = [];
  for (let i = 0; i < KNOWN_STRIKE_ACTIONS.length; i++) {
    const n = i + 1;
    const name = KNOWN_STRIKE_ACTIONS[i];
    const rid = ACTION_CONFIG[name] && ACTION_CONFIG[name].roleId;
    if (rid && worn.has(String(rid))) {
      roleLevel = Math.max(roleLevel, n);
      sources.push(`wearing the ${name} role`);
    }
  }

  // 4. Settle it.
  let level = roleLevel;
  for (const [n, why] of claimed) {
    const name = KNOWN_STRIKE_ACTIONS[n - 1];
    const rid = name && ACTION_CONFIG[name] && ACTION_CONFIG[name].roleId;
    const checkable = !!rid && roleExists(rid);
    if (rolesKnown && checkable && !worn.has(String(rid))) {
      // On record, not worn → cleared. Reported, never counted.
      cleared.push(why);
      continue;
    }
    // The roles are unknown, or there is no role for this strike to be missing
    // from, or the configured role isn't a role this server has. The record is
    // the best evidence there is.
    if (n > level) level = n;
    sources.push(rolesKnown && !checkable
      ? `${why} (${rid ? 'that role does not exist here' : 'no role configured'}, so it could not be checked)`
      : why);
  }

  return {
    level,
    sources: [...new Set(sources)],
    rolesKnown,
    recordLevel,
    roleLevel,
    cleared: [...new Set(cleared)],
  };
}

/**
 * What the issuer picked is what gets issued — full stop. This works out
 * whether their record suggests something HEAVIER, so the panel can offer it as
 * a second button.
 *
 * The distinction matters. Silently upgrading a Strike 1 to a Strike 2 because
 * of something on a record the issuer may not have seen is the command deciding
 * a disciplinary outcome on its own. Offering it, with the record shown, is the
 * command doing its job. Both buttons are always live: whatever it suggests,
 * the original choice still goes through in one click.
 *
 * @param {string} choice the action they picked
 * @param {number} currentLevel their strike level right now
 * @returns {{
 *   action: string,            what they asked for — always issuable
 *   suggested: string|null,    the heavier action worth offering, or null
 *   reason: string|null,       one line explaining why, for the panel
 *   level: number,             the strike level `action` represents (0 if not a strike)
 * }}
 */
function escalationFor(choice, currentLevel) {
  const asked = strikeLevelOf(choice);
  const out = { action: choice, suggested: null, reason: null, level: asked };

  // Only strikes escalate. A Verbal Warning is a Verbal Warning whatever else
  // is on the record.
  if (!asked) return out;

  // They already hold a strike at or above the one they picked.
  if (currentLevel >= asked) {
    if (currentLevel >= MAX_STRIKE) {
      out.suggested = AFTER_LAST_STRIKE;
      out.reason = `They already hold **Strike ${currentLevel}**, which is the last one. `
        + `The next step up is **${AFTER_LAST_STRIKE}**.`;
    } else {
      const next = currentLevel + 1;
      out.suggested = STRIKE_ACTIONS[next - 1];
      out.reason = `They already hold **Strike ${currentLevel}**, so this would be their second Strike ${asked}. `
        + `**Strike ${next}** is the next one up.`;
    }
  }
  return out;
}

// ── Record ────────────────────────────────────────────────────────
/**
 * Everything already on the officer's record, newest first, merged from the
 * punishment table and their approved cases. Used to show the issuer what they
 * are escalating from before anything is applied.
 */
async function loadRecord(discordId, limit = 6) {
  const out = [];
  try {
    const rows = await prisma.metPunishment.findMany({
      where: { discordId: String(discordId) },
      orderBy: { issuedAt: 'desc' },
      take: 25,
    });
    for (const r of rows) {
      out.push({ type: r.type, at: r.issuedAt, by: r.issuedBy, ref: r.caseRef, active: r.active, source: 'direct' });
    }
  } catch (e) { /* best effort */ }
  try {
    // CasePunishment has no timestamp of its own, so the case's own createdAt
    // is what dates the entry.
    const rows = await prisma.casePunishment.findMany({
      where: { case: { officerDiscordId: String(discordId), status: 'APPROVED' } },
      orderBy: { case: { createdAt: 'desc' } },
      take: 25,
      include: { case: { select: { caseRef: true, createdAt: true } } },
    });
    for (const r of rows) {
      out.push({
        type: r.action, at: r.case ? r.case.createdAt : null, by: null,
        ref: r.case ? r.case.caseRef : null,
        active: !r.roleRemoved, source: 'case',
      });
    }
  } catch (e) { /* best effort */ }

  out.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));

  // A /discipline action exists in both tables by design — the bot reads one,
  // the portal reads the other — and they share a case ref. Show it once.
  const seen = new Set();
  const merged = out.filter(en => {
    if (!en.ref) return true;
    const key = `${en.ref}::${en.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { entries: merged.slice(0, limit), total: merged.length };
}

// ── What an action will actually do ───────────────────────────────
/**
 * A plain-language list of the side effects, computed BEFORE anything runs so
 * the confirmation panel can promise exactly what the confirm button does.
 */
function plannedEffects(action, { hasRoblox, durationDays } = {}) {
  const cfg = ACTION_CONFIG[action] || {};
  const effects = [];
  if (cfg.roleId) effects.push({ kind: 'role', text: `Add the <@&${cfg.roleId}> role` });
  else effects.push({ kind: 'role', text: 'No Discord role is mapped to this action' });

  if (action === 'Demotion') {
    effects.push({ kind: 'group', text: hasRoblox ? 'Demote one rank in the MET group' : 'Cannot demote — no linked Roblox account' });
  }
  if (cfg.exile) {
    effects.push({ kind: 'group', text: hasRoblox ? 'Remove from the MET Roblox group' : 'Cannot exile — no linked Roblox account' });
  }
  if (cfg.timed) {
    effects.push({ kind: 'expiry', text: durationDays ? `Expires after ${durationDays} day${durationDays === 1 ? '' : 's'}` : 'No end date — stays until lifted' });
  }
  effects.push({ kind: 'log',  text: 'Post to the administrative log' });
  effects.push({ kind: 'site', text: 'File it on the portal as an approved record they can appeal' });
  effects.push({ kind: 'dm', text: 'DM the officer with the reason and a link to their record' });
  return effects;
}

// ── The website record ────────────────────────────────────────────
/**
 * File the action as a case on the portal, so it shows up in the record, in
 * search, and — the point of it — can be APPEALED like anything else.
 *
 * It is auto-approved. There is nothing to review: the action has already been
 * taken by somebody who was allowed to take it, and a pending case for a
 * punishment already applied would just be a queue item nobody can act on. The
 * issuer is recorded as the approver.
 *
 * origin='DISCIPLINE' is what makes it honest. This is not an investigation
 * that reached a conclusion; it is a direct action, and the record says so
 * everywhere it is shown.
 *
 * Never throws — the punishment has already landed by the time this runs, and
 * a portal write failing must not make a successful action report as failed.
 */
async function fileCase(o) {
  const cfg = ACTION_CONFIG[o.action] || {};

  // The case's owner is whoever ran the command. Plenty of people who can
  // discipline have never opened the portal, so a shell account is created for
  // them rather than refusing to file the record — same pattern the bulk
  // importer uses.
  const owner = await prisma.user.upsert({
    where:  { discordId: String(o.issuerDiscordId) },
    update: {},
    create: {
      discordId: String(o.issuerDiscordId),
      discordUsername: o.issuerUsername || o.issuerName || 'unknown',
      displayName: o.issuerName || null,
    },
  });

  const caseRef = await require('./caseRef').generateCaseRef();

  const row = await prisma.case.create({
    data: {
      caseRef,
      origin: 'DISCIPLINE',
      userId: owner.id,
      officerDiscordId: String(o.targetDiscordId),
      robloxUserId:   o.targetRobloxId || null,
      robloxUsername: o.targetName || null,
      action:  o.action,
      actions: [{ action: o.action, roleId: cfg.roleId || null, durationDays: o.durationDays || null }],
      reason:  o.reason || 'N/A',
      notes:   o.notes || 'N/A',
      // Only when there actually is one. A direct action usually has no case
      // document, and inventing a dead link would be worse than none.
      caseLink: o.caseLink || null,
      status:  'APPROVED',
      logMessageId: o.logMessageId || null,
      investigatorDiscordUsername: o.issuerName || null,
    },
  });

  // The approval, attributed to whoever ran the command.
  await prisma.caseAction.create({
    data: {
      caseId: row.id,
      actionType: 'APPROVED',
      performedBy: owner.id,
      notes: `Issued directly with /discipline by ${o.issuerName || o.issuerDiscordId} — no review required.`,
    },
  }).catch(() => {});

  // The punishment rows the record and the rejoin-persistence both read.
  if (cfg.roleId) {
    await prisma.casePunishment.create({
      data: {
        caseId: row.id,
        action: o.action,
        roleId: cfg.roleId,
        durationDays: o.durationDays || null,
        expiresAt: cfg.timed && o.durationDays
          ? new Date(Date.now() + Number(o.durationDays) * 86400000)
          : null,
      },
    }).catch(() => {});
  }

  return row;
}

// ── Apply ─────────────────────────────────────────────────────────
/**
 * Carry out a disciplinary action.
 *
 * Reports progress through `onStep` so the panel can animate, and never throws:
 * a failure in one step is recorded on that step and the rest still run. That
 * matters — a Discord role failing to apply must not stop the punishment being
 * written or the log being posted.
 *
 * @param {object} o
 * @param {string} o.action           canonical name from ACTION_CONFIG
 * @param {string} o.targetDiscordId
 * @param {string} [o.targetRobloxId]
 * @param {string} [o.targetName]     Roblox username, for the log embed
 * @param {string} [o.targetAvatar]
 * @param {string} o.reason
 * @param {string} [o.notes]
 * @param {string} [o.caseLink]       optional — a case URL or reference
 * @param {number} [o.durationDays]   timed actions only
 * @param {string} o.issuerDiscordId
 * @param {string} o.issuerName
 * @param {string} [o.issuerUsername]
 * @param {function} [o.onStep]       async (stepKey, state, detail) => void
 */
async function applyDiscipline(o) {
  const cfg = ACTION_CONFIG[o.action] || {};
  const onStep = o.onStep || (async () => {});
  const result = { ok: true, punishmentId: null, logMessageId: null, caseId: null, caseRef: null, steps: {}, warnings: [] };

  const step = async (key, fn) => {
    await onStep(key, 'running');
    try {
      const detail = await fn();
      result.steps[key] = { ok: true, detail: detail || null };
      await onStep(key, 'done', detail);
      return detail;
    } catch (err) {
      result.ok = false;
      result.steps[key] = { ok: false, detail: err.message };
      result.warnings.push(`${key}: ${err.message}`);
      await onStep(key, 'failed', err.message);
      return null;
    }
  };

  const expiresAt = cfg.timed && o.durationDays
    ? new Date(Date.now() + Number(o.durationDays) * 86400000)
    : null;

  // 1. Write it down first. If everything after this fails, the record still
  //    exists and the action can be re-driven by hand — the reverse (roles
  //    applied, nothing recorded) is the one that leaves no trail.
  await step('record', async () => {
    const row = await prisma.metPunishment.create({
      data: {
        discordId:  String(o.targetDiscordId),
        type:       o.action,
        reason:     o.reason || null,
        issuedById: o.issuerDiscordId ? String(o.issuerDiscordId) : null,
        issuedBy:   o.issuerName || null,
        // Filled in with the portal case ref once the case is filed, which is
        // also what links the two rows so the record shows the action once.
        caseRef:    null,
        active:     true,
        expiresAt,
      },
    });
    result.punishmentId = row.id;
    return `#${row.id.slice(0, 8)}`;
  });

  // 2. Discord role.
  if (cfg.roleId) {
    await step('role', async () => {
      const ok = await require('./bot').assignRole(o.targetDiscordId, cfg.roleId);
      if (!ok) throw new Error('the bot could not add the role (check its position and permissions)');
      return 'added';
    });
  }

  // 3. Roblox group — demotion or exile, whichever the action calls for.
  if (o.targetRobloxId && (cfg.exile || o.action === 'Demotion')) {
    await step('group', async () => {
      const roblox = require('./roblox');
      if (cfg.exile) {
        const exiled = await roblox.exileFromGroup(o.targetRobloxId);
        if (!exiled) throw new Error('the group exile was rejected');
        return 'removed from the group';
      }
      const res = await roblox.demoteByOneRank(o.targetRobloxId);
      if (!res.ok) throw new Error(res.reason || 'demotion failed');
      return `${res.from} → ${res.to}`;
    });
  }

  // 4. The portal record, BEFORE the log. The log's footer carries the
  //    infraction id, and that id is the case number — so the case has to
  //    exist first. Its logMessageId is filled in straight after, which is
  //    what lets an appeal edit the original notice in place.
  let filed = null;
  await step('record_site', async () => {
    filed = await fileCase(o);
    result.caseId = filed.id;
    result.caseRef = filed.caseRef;
    // Stamp the punishment with the case it was filed as. The same action now
    // exists as a MetPunishment (what the bot reads) and a CasePunishment (what
    // the portal reads), and without this link the record shows it twice.
    if (result.punishmentId) {
      await prisma.metPunishment.update({
        where: { id: result.punishmentId },
        data:  { caseRef: filed.caseRef },
      }).catch(() => {});
    }
    return filed.caseRef;
  });

  // 5. The administrative log — the same embed the case system posts, so the
  //    channel reads as one consistent history rather than two formats.
  await step('log', async () => {
    const { sendApprovalWebhook } = require('./webhook');
    const id = await sendApprovalWebhook({
      direct: true,
      signedBy: o.signedBy || null,
      caseRef: result.caseRef,
      action:  o.action,
      actions: [{ action: o.action, roleId: cfg.roleId || null, durationDays: o.durationDays || null }],
      reason:  o.reason,
      notes:   o.notes || null,
      officerDiscordId: o.targetDiscordId,
      officerName:      o.targetName || null,
      officerRobloxId:  o.targetRobloxId || null,
      suspectAvatar:    o.targetAvatar || null,
      timestamp: new Date(),
    });
    if (!id) throw new Error('no DISCORD_WEBHOOK_URL configured, or Discord rejected it');
    result.logMessageId = id;
    if (filed) {
      await prisma.case.update({ where: { id: filed.id }, data: { logMessageId: id } }).catch(() => {});
    }
    return 'posted';
  });

  // 6. Tell the officer. Best-effort by nature — plenty of people have DMs
  //    closed, and that is not a failure of the punishment. Same notice an
  //    approved case sends, so being disciplined reads the same either way.
  await step('notify', async () => {
    const sent = await require('./officerNotice').notifyPunished({
      discordId: o.targetDiscordId,
      caseRef:   result.caseRef,
      caseId:    result.caseId,
      actions:   [{ action: o.action, durationDays: o.durationDays || null }],
      reason:    o.reason,
      notes:     o.notes || null,
      caseLink:  o.caseLink || null,
      expiresAt,
      direct:    true,
      avatar:         o.targetAvatar || null,
      robloxUsername: o.targetName || null,
      robloxId:       o.targetRobloxId || null,
    });
    if (sent === 'off') return 'skipped (DMs turned off)';
    if (!sent) throw new Error('their DMs are closed');
    return 'sent';
  });

  return result;
}

module.exports = {
  COMMAND_ACTIONS, STRIKE_ACTIONS, KNOWN_STRIKE_ACTIONS, MAX_STRIKE, AFTER_LAST_STRIKE,
  strikeLevelOf, currentStrikeLevel, escalationFor,
  loadRecord, plannedEffects, applyDiscipline, fileCase,
};
