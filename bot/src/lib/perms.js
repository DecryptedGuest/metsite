// Permission tiers, resolved from Discord roles at call time.
const { env } = require('./env');

const TIER = { NONE: 0, IA: 1, SUPERVISOR: 2, HICOMM: 3, DEVELOPER: 4 };

/** Highest tier this member holds. */
function tierOf(member) {
  if (!member) return TIER.NONE;
  const userId = member.user?.id || member.id;
  if (userId && userId === env('DEVELOPER_DISCORD_ID')) return TIER.DEVELOPER;

  const has = (id) => id && member.roles?.cache?.has(id);
  if (has(env('DEVELOPER_ROLE_ID'))) return TIER.DEVELOPER;
  if (has(env('ROLE_HICOMM')))       return TIER.HICOMM;
  if (has(env('ROLE_SUPERVISOR')))   return TIER.SUPERVISOR;
  if (has(env('ROLE_IA')))           return TIER.IA;
  return TIER.NONE;
}

const isIA         = (m) => tierOf(m) >= TIER.IA;
const isSupervisor = (m) => tierOf(m) >= TIER.SUPERVISOR;
const isHicomm     = (m) => tierOf(m) >= TIER.HICOMM;
const isDeveloper  = (m) => tierOf(m) >= TIER.DEVELOPER;

const DENIED = '⛔ You are not authorised to use this command.';
const DENIED_REVIEW = '⛔ You are not authorised to review this.';

module.exports = { TIER, tierOf, isIA, isSupervisor, isHicomm, isDeveloper, DENIED, DENIED_REVIEW };
