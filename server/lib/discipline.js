// server/lib/discipline.js
// The engine behind /discipline — direct disciplinary action, no case attached.
//
// The IA case system already does all of this, but only at the end of a case:
// somebody files it, somebody reviews it, and approval fires the side effects.
// Plenty of discipline never needs that ceremony. This is the same machinery
// with the case removed and the case link demoted to an optional field:
//
//   * work out what the officer already has on their record, so a strike
//     escalates instead of stacking a second Strike 1
//   * write the punishment
//   * add the Discord role
//   * demote / exile in the Roblox group when the action calls for it
//   * post the SAME administrative-log embed the case system posts
//   * tell the officer, with a link to their record
//
// Everything in here is deliberately free of discord.js interaction objects so
// it can be tested without a gateway connection. The panel that drives it lives
// in disciplineCommand.js.

const prisma = require('./db');
const { ACTION_CONFIG, ACTION_NAMES } = require('./actions');

// ── Strikes ───────────────────────────────────────────────────────
// "Strike" is a ladder, not a label: issuing one to somebody who already has
// Strike 1 has to produce Strike 2. The whole point of the command is that the
// issuer doesn't have to go and look that up.
const STRIKE_ACTIONS = ['Disciplinary Strike 1', 'Disciplinary Strike 2', 'Disciplinary Strike 3'];
const MAX_STRIKE = STRIKE_ACTIONS.length;

// The pseudo-action the slash command offers. Picking it resolves to whichever
// rung of the ladder comes next for that officer.
const AUTO_STRIKE = 'Strike (auto-escalate)';

// Every action the command can issue, auto-escalating strike first because it's
// the one that gets used.
const COMMAND_ACTIONS = [AUTO_STRIKE, ...ACTION_NAMES];

// A strike level out of anything that names one: 'Disciplinary Strike 2' → 2,
// 'STRIKE 3' → 3, a bare 'STRIKE' → 1 (the ingest writes those for infraction
// posts that don't number themselves).
function strikeLevelOf(type) {
  const s = String(type || '');
  const numbered = s.match(/strike\s*([123])\b/i);
  if (numbered) return Number(numbered[1]);
  if (/\bstrike\b/i.test(s) && !/activity strike/i.test(s)) return 1;
  return 0;
}

/**
 * The officer's current strike level, read from every place a strike can live.
 *
 * Three sources, because none of them is complete on its own:
 *   punishments  — /discipline and the Discord infraction ingest write here
 *   cases        — an approved IA case with a strike among its actions
 *   roles        — what they are actually wearing in the server right now
 *
 * The Discord roles matter most: a strike handed out by hand, before any of
 * this existed, shows up nowhere in the database but is plainly on the record.
 * Taking the highest of the three is what makes "shows if they already have a
 * strike" true rather than only-true-for-strikes-we-issued.
 *
 * @param {object} opts
 * @param {string} opts.discordId
 * @param {string[]} [opts.roleIds] the member's current Discord role ids
 * @returns {Promise<{ level: number, sources: string[] }>}
 */
async function currentStrikeLevel({ discordId, roleIds }) {
  let level = 0;
  const sources = [];

  const bump = (n, why) => { if (n > level) { level = n; } if (n > 0) sources.push(why); };

  // 1. Punishment history (includes everything /discipline has ever issued).
  try {
    const rows = await prisma.metPunishment.findMany({
      where: { discordId: String(discordId), active: true },
      select: { type: true, issuedAt: true },
    });
    for (const r of rows) {
      const n = strikeLevelOf(r.type);
      if (n) bump(n, `${r.type} on record`);
    }
  } catch (e) { /* a missing table must not block the command */ }

  // 2. Strikes issued through an approved IA case.
  try {
    const rows = await prisma.casePunishment.findMany({
      where: { action: { in: STRIKE_ACTIONS }, case: { officerDiscordId: String(discordId) } },
      select: { action: true },
    });
    for (const r of rows) bump(strikeLevelOf(r.action), `${r.action} from a case`);
  } catch (e) { /* ditto */ }

  // 3. The roles they're wearing — catches anything done by hand.
  if (Array.isArray(roleIds) && roleIds.length) {
    for (let i = 0; i < STRIKE_ACTIONS.length; i++) {
      const rid = ACTION_CONFIG[STRIKE_ACTIONS[i]].roleId;
      if (rid && roleIds.includes(String(rid))) bump(i + 1, `wearing the ${STRIKE_ACTIONS[i]} role`);
    }
  }

  return { level, sources: [...new Set(sources)] };
}

/**
 * Turn the issuer's choice into the action that will actually be applied.
 *
 * Only AUTO_STRIKE moves. If they explicitly picked "Disciplinary Strike 1"
 * they get Strike 1 — overriding the ladder is sometimes exactly what's
 * wanted, and second-guessing an explicit choice would be worse than useless.
 *
 * @returns {{ action: string|null, escalated: boolean, from: number, to: number, capped: boolean }}
 */
function resolveAction(choice, currentLevel) {
  if (choice !== AUTO_STRIKE) {
    return { action: choice, escalated: false, from: currentLevel, to: strikeLevelOf(choice), capped: false };
  }
  const next = currentLevel + 1;
  if (next > MAX_STRIKE) {
    // Already on the last rung. We do NOT silently escalate to Termination —
    // that is a decision a person makes, not a lookup table. The panel says so
    // and asks them to pick the action explicitly.
    return { action: null, escalated: false, from: currentLevel, to: currentLevel, capped: true };
  }
  return {
    action: STRIKE_ACTIONS[next - 1],
    escalated: currentLevel > 0,
    from: currentLevel, to: next, capped: false,
  };
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
  return { entries: out.slice(0, limit), total: out.length };
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
  effects.push({ kind: 'log', text: 'Post to the administrative log' });
  effects.push({ kind: 'dm', text: 'DM the officer with the reason and a link to their record' });
  return effects;
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
 * @param {function} [o.onStep]       async (stepKey, state, detail) => void
 */
async function applyDiscipline(o) {
  const cfg = ACTION_CONFIG[o.action] || {};
  const onStep = o.onStep || (async () => {});
  const result = { ok: true, punishmentId: null, logMessageId: null, steps: {}, warnings: [] };

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
        caseRef:    o.caseLink || null,
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

  // 4. The administrative log — the same embed the case system posts, so the
  //    channel reads as one consistent history rather than two formats.
  await step('log', async () => {
    const { sendApprovalWebhook } = require('./webhook');
    const id = await sendApprovalWebhook({
      caseRef: o.caseLink || 'Direct action',
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
    return 'posted';
  });

  // 5. Tell the officer. Best-effort by nature — plenty of people have DMs
  //    closed, and that is not a failure of the punishment.
  await step('notify', async () => {
    if (process.env.MEMBER_ACTION_DM === 'off') return 'skipped (DMs turned off)';
    const base = (process.env.PUBLIC_BASE_URL || 'https://metia.uk').replace(/\/+$/, '');
    const sent = await require('./bot').dmMemberNotice(o.targetDiscordId, {
      color: 0xf04f5e,
      title: 'You have received a disciplinary action',
      description:
        `**Action:** ${o.action}\n`
        + `**Reason:** ${String(o.reason || 'N/A').slice(0, 900)}\n`
        + (o.notes ? `**Notes:** ${String(o.notes).slice(0, 500)}\n` : '')
        + (o.caseLink ? `**Case:** ${o.caseLink}\n` : '')
        + (expiresAt ? `**Expires:** <t:${Math.floor(expiresAt.getTime() / 1000)}:D>\n` : '')
        + `\nYour full record is on the portal. If you believe this is a mistake, open an appeal there and an investigator will review it.`,
      appealUrl: `${base}/profile`,
      appealLabel: 'View my record',
    });
    if (!sent) throw new Error('their DMs are closed');
    return 'sent';
  });

  return result;
}

module.exports = {
  AUTO_STRIKE, COMMAND_ACTIONS, STRIKE_ACTIONS, MAX_STRIKE,
  strikeLevelOf, currentStrikeLevel, resolveAction,
  loadRecord, plannedEffects, applyDiscipline,
};
