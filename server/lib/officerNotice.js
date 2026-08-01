// server/lib/officerNotice.js
// What the officer on the receiving end is told.
//
// Three things can happen to somebody: a case against them is approved, a
// direct action is taken with /discipline, or an appeal lifts one of those. All
// three are the same event from where they are standing — their record changed
// — and all three used to be told differently or not at all. A case approval
// notified the *submitter* and left the officer to find out from a role
// appearing on their account.
//
// So one format, one place. If the wording needs to change it changes once.

const { e } = require('./emoji');
const { ACTION_CONFIG } = require('./actions');

const COLOR = { punished: 0xf04f5e, appealed: 0x2ed896 };

function baseUrl() {
  return (process.env.PUBLIC_BASE_URL || 'https://metia.uk').replace(/\/+$/, '');
}

function short(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** "• Disciplinary Strike 2" / "• Suspension (14d)" — the case-log wording. */
function actionList(actions, fallbackAction) {
  const list = Array.isArray(actions) && actions.length
    ? actions
    : (fallbackAction ? [{ action: fallbackAction }] : []);
  if (!list.length) return '• *Unspecified*';
  return list.map(a => {
    const cfg = ACTION_CONFIG[a.action] || {};
    const suffix = cfg.timed ? (a.durationDays ? ` (${a.durationDays}d)` : ' (Permanent)') : '';
    return `• **${a.action}**${suffix}`;
  }).join('\n');
}

/**
 * Tell an officer they have been disciplined.
 *
 * @returns {Promise<boolean|'off'>} whether the DM landed, or 'off' when
 *   member notices are turned off entirely.
 */
async function notifyPunished(o) {
  if (process.env.MEMBER_ACTION_DM === 'off') return 'off';
  if (!o || !o.discordId) return false;

  const lines = [
    `${e('met_gavel')} **Action${(o.actions && o.actions.length > 1) ? 's' : ''} taken**`,
    actionList(o.actions, o.action),
    '',
    `**Reason:** ${short(o.reason || 'N/A', 900)}`,
  ];
  if (o.notes && o.notes !== 'N/A') lines.push(`**Notes:** ${short(o.notes, 500)}`);
  if (o.caseRef)   lines.push(`**Infraction ID:** \`${o.caseRef}\``);
  if (o.caseLink)  lines.push(`**Case:** ${short(o.caseLink, 300)}`);
  if (o.expiresAt) lines.push(`**Expires:** <t:${Math.floor(new Date(o.expiresAt).getTime() / 1000)}:D>`);
  lines.push('');
  lines.push(o.direct
    // Said plainly. Being disciplined without an investigation is a legitimate
    // outcome, and somebody is entitled to know which one theirs was.
    ? 'This was a direct disciplinary action, not the outcome of an investigation.'
    : 'This case has been reviewed and approved by Internal Affairs High Command.');
  lines.push('If you believe this is a mistake, open your record below and file an appeal — an investigator will review it.');

  return require('./bot').dmMemberNotice(o.discordId, {
    color: COLOR.punished,
    title: 'You have received a disciplinary action',
    description: lines.join('\n'),
    appealUrl: o.caseId ? `${baseUrl()}/profile?case=${encodeURIComponent(o.caseId)}` : `${baseUrl()}/profile`,
    appealLabel: 'View my record',
  }).catch(() => false);
}

/**
 * Tell an officer an action against them has been lifted.
 *
 * This one is good news and reads like it. It also names who granted it and
 * why, because "your punishment is gone" with no explanation invites exactly
 * the question the DM was meant to answer.
 */
async function notifyAppealed(o) {
  if (process.env.MEMBER_ACTION_DM === 'off') return 'off';
  if (!o || !o.discordId) return false;

  const lines = [
    `${e('met_tick')} **Your appeal has been granted.**`,
    '',
    `**Lifted:**\n${actionList(o.actions, o.action)}`,
  ];
  if (o.caseRef) lines.push(`**Infraction ID:** \`${o.caseRef}\``);
  lines.push(`**Granted by:** ${short(o.by || 'Internal Affairs', 100)}${o.rank ? ` (${short(o.rank, 60)})` : ''}`);
  if (o.reason) lines.push(`**Reason:** ${short(o.reason, 900)}`);
  lines.push('');
  lines.push('The punishment no longer counts toward your record, and any roles it added have been removed.');
  if (o.manual && o.manual.length) {
    lines.push(`${e('met_warn')} Some of it has to be undone by hand (${short(o.manual.join('; '), 300)}) — High Command have been told.`);
  }

  return require('./bot').dmMemberNotice(o.discordId, {
    color: COLOR.appealed,
    title: 'A disciplinary action against you has been lifted',
    description: lines.join('\n'),
    appealUrl: o.caseId ? `${baseUrl()}/profile?case=${encodeURIComponent(o.caseId)}` : `${baseUrl()}/profile`,
    appealLabel: 'View my record',
  }).catch(() => false);
}

module.exports = { notifyPunished, notifyAppealed, actionList };
