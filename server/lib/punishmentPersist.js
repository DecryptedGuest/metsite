// server/lib/punishmentPersist.js
// Punishment roles survive leaving and rejoining the server.
//
// Discord throws a member's roles away the moment they leave. Until now that
// made every punishment role a suggestion: pick up a strike, leave, come back,
// and the strike is gone from the server even though it is still on the record
// and still counts towards the next one. The site knew; Discord didn't.
//
// So on guildMemberAdd we read what the member should be wearing and put it
// back. Two sources, the same two the strike counter reads:
//
//   MetPunishment    active rows whose type names a real action
//   CasePunishment   roles from approved cases that haven't expired or been lifted
//
// Roles are resolved through ACTION_CONFIG at re-apply time rather than from
// whatever id was stored, so a role that has since been re-created with a new
// id resolves to the current one.
//
// This does NOT re-apply anything that has expired, been lifted by an appeal,
// or been marked inactive — those are exactly the cases where the role is
// supposed to be gone.
//
// Set PUNISHMENT_REAPPLY=off to disable.

const prisma = require('./db');
const { ACTION_CONFIG } = require('./actions');

/**
 * Every punishment role a member should currently be wearing.
 * @returns {Promise<Array<{ roleId: string, action: string, why: string }>>}
 */
async function rolesOwedTo(discordId) {
  const owed = new Map();   // roleId → { roleId, action, why }
  const now = new Date();

  // Direct actions (/discipline, the Discord infraction ingest).
  try {
    const rows = await prisma.metPunishment.findMany({
      where: {
        discordId: String(discordId),
        active: true,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { type: true, caseRef: true, issuedAt: true },
    });
    for (const r of rows) {
      const cfg = ACTION_CONFIG[r.type];
      if (!cfg || !cfg.roleId) continue;      // ingest rows use loose labels; nothing to re-apply
      owed.set(String(cfg.roleId), { roleId: String(cfg.roleId), action: r.type, why: 'active punishment' });
    }
  } catch (e) { /* a query failure must not stop the member joining */ }

  // Case-issued punishments.
  try {
    const rows = await prisma.casePunishment.findMany({
      where: {
        roleRemoved: false,
        roleId: { not: null },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        case: { officerDiscordId: String(discordId), status: 'APPROVED' },
      },
      select: { action: true, roleId: true, case: { select: { caseRef: true } } },
    });
    for (const r of rows) {
      // Prefer the CURRENT configured role for the action; fall back to the id
      // snapshotted on the punishment for actions no longer in the config.
      const cfg = ACTION_CONFIG[r.action];
      const roleId = (cfg && cfg.roleId) || r.roleId;
      if (!roleId) continue;
      owed.set(String(roleId), {
        roleId: String(roleId), action: r.action,
        why: r.case && r.case.caseRef ? `case ${r.case.caseRef}` : 'approved case',
      });
    }
  } catch (e) { /* ditto */ }

  return [...owed.values()];
}

/**
 * Put back whatever a rejoining member should be wearing.
 * Best-effort and silent when there's nothing to do — most joins are clean.
 * @returns {Promise<{ restored: string[], failed: string[], skipped: number }>}
 */
async function reapplyOnJoin(member) {
  const out = { restored: [], failed: [], skipped: 0 };
  if (!member || !member.id || process.env.PUNISHMENT_REAPPLY === 'off') return out;

  // Only the guild the punishment roles actually live in.
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId || String(member.guild && member.guild.id) !== String(guildId)) return out;

  const owed = await rolesOwedTo(member.id);
  if (!owed.length) return out;

  for (const item of owed) {
    // Already wearing it (Discord sometimes restores roles itself, e.g. after a
    // kick that was undone) — nothing to do.
    if (member.roles && member.roles.cache && member.roles.cache.has(item.roleId)) { out.skipped++; continue; }
    try {
      await member.roles.add(item.roleId, `Punishment still active on rejoin — ${item.action} (${item.why})`);
      out.restored.push(item.action);
    } catch (err) {
      out.failed.push(`${item.action}: ${err.message}`);
    }
  }

  if (out.restored.length || out.failed.length) {
    console.log(`[Punishments] ${member.id} rejoined — restored ${out.restored.length ? out.restored.join(', ') : 'nothing'}`
      + (out.failed.length ? ` · failed: ${out.failed.join(' | ')}` : ''));
  }
  return out;
}

module.exports = { rolesOwedTo, reapplyOnJoin };
