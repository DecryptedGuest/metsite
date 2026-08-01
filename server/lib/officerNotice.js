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
//
// The notice is deliberately formal. Somebody is being told their permanent
// record has changed; a one-line DM is the wrong register for that, and a
// vague one invites a question that a complete notice would have answered.
// What it does NOT carry is who filed it or who approved it — that is
// Internal Affairs' business, not the subject's.

const { e } = require('./emoji');
const { ACTION_CONFIG } = require('./actions');

const COLOR = { punished: 0xf04f5e, appealed: 0x2ed896 };

function baseUrl() {
  return (process.env.PUBLIC_BASE_URL || 'https://metia.uk').replace(/\/+$/, '');
}

/** A deep link straight to this entry on their own record. */
function recordUrl(caseId) {
  return caseId
    ? `${baseUrl()}/profile?record=${encodeURIComponent(caseId)}#record`
    : `${baseUrl()}/profile#record`;
}

function short(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

const ts = d => `<t:${Math.floor(new Date(d).getTime() / 1000)}:F>`;

// The right MET emoji for an action, so a strike and a termination don't look
// like the same event.
function iconFor(action) {
  const a = String(action || '');
  if (/strike\s*3/i.test(a))            return e('met_strike3');
  if (/strike\s*2/i.test(a))            return e('met_strike2');
  if (/strike/i.test(a))                return e('met_strike1');
  if (/termination|blacklist/i.test(a)) return e('met_denied');
  if (/suspension|zero tolerance/i.test(a)) return e('met_stop');
  if (/demotion/i.test(a))              return e('met_leave');
  if (/warning/i.test(a))               return e('met_warn');
  return e('met_gavel');
}

/** The action list, one per line, badged and with any duration. */
function actionList(actions, fallbackAction) {
  const list = Array.isArray(actions) && actions.length
    ? actions
    : (fallbackAction ? [{ action: fallbackAction }] : []);
  if (!list.length) return `${e('met_gavel')} *Unspecified*`;
  return list.map(a => {
    const cfg = ACTION_CONFIG[a.action] || {};
    const suffix = cfg.timed ? (a.durationDays ? ` — **${a.durationDays} days**` : ' — **indefinite**') : '';
    return `${iconFor(a.action)} **${a.action}**${suffix}`;
  }).join('\n');
}

/** What each action actually means for them, in plain terms. */
function consequenceFor(actions, fallbackAction) {
  const names = (Array.isArray(actions) && actions.length ? actions : [{ action: fallbackAction }])
    .map(a => String(a && a.action || ''));
  const out = [];
  const any = re => names.some(n => re.test(n));

  if (any(/blacklist/i))     out.push(`${e('met_denied')} You have been removed from the Metropolitan Police group and are barred from rejoining.`);
  else if (any(/termination/i)) out.push(`${e('met_leave')} Your service with the Metropolitan Police has been terminated.`);
  if (any(/demotion/i))      out.push(`${e('met_rank')} Your rank has been reduced.`);
  if (any(/strike\s*1/i))    out.push(`${e('met_strike1')} This is your first strike. A second is the last one before termination is considered.`);
  if (any(/strike\s*2/i))    out.push(`${e('met_strike2')} This is your second strike — the last one. Any further misconduct will be considered for termination.`);
  if (any(/suspension/i))    out.push(`${e('met_stop')} You are suspended from duty for the period below.`);
  if (any(/zero tolerance/i))out.push(`${e('met_warn')} You are under Zero Tolerance: any further breach will be dealt with at the next level up.`);
  if (any(/warning/i))       out.push(`${e('met_warn')} This is a formal warning. It stays on your record.`);
  if (any(/activity strike/i)) out.push(`${e('met_pending')} This relates to your activity, not your conduct. Meet your quota to avoid another.`);

  return out.length ? out.join('\n') : null;
}

/**
 * Tell an officer they have been disciplined.
 *
 * @param {object} o
 * @param {string} o.discordId
 * @param {string} [o.caseRef]      the infraction id
 * @param {string} [o.caseId]       for the deep link into their record
 * @param {Array}  [o.actions]
 * @param {string} [o.reason]
 * @param {string} [o.notes]
 * @param {string} [o.caseLink]
 * @param {Date}   [o.expiresAt]
 * @param {boolean}[o.direct]       taken with /discipline rather than reviewed
 * @param {string} [o.avatar]       their Roblox headshot
 * @param {string} [o.robloxUsername]
 * @param {string} [o.robloxId]
 * @returns {Promise<boolean|'off'>} whether it landed, or 'off' when member
 *   notices are turned off entirely.
 */
async function notifyPunished(o) {
  if (process.env.MEMBER_ACTION_DM === 'off') return 'off';
  if (!o || !o.discordId) return false;

  const plural = (o.actions && o.actions.length > 1);
  const fields = [
    { name: `${e('met_gavel')} Action${plural ? 's' : ''} taken`, value: short(actionList(o.actions, o.action), 1000), inline: false },
    { name: `${e('met_edit')} Reason`, value: short(o.reason || 'No reason recorded.', 1000), inline: false },
  ];
  if (o.notes && o.notes !== 'N/A') {
    fields.push({ name: `${e('met_folder')} Notes`, value: short(o.notes, 1000), inline: false });
  }

  const consequence = consequenceFor(o.actions, o.action);
  if (consequence) fields.push({ name: `${e('met_shield')} What this means`, value: short(consequence, 1000), inline: false });

  // The short facts, side by side.
  if (o.caseRef)   fields.push({ name: `${e('met_search')} Infraction ID`, value: `\`${o.caseRef}\``, inline: true });
  fields.push({ name: `${e('met_pending')} Issued`, value: ts(o.issuedAt || Date.now()), inline: true });
  fields.push({
    name: `${e('met_lock')} Expires`,
    value: o.expiresAt ? ts(o.expiresAt) : 'Does not expire',
    inline: true,
  });
  if (o.caseLink) fields.push({ name: `${e('met_link')} Case document`, value: short(o.caseLink, 300), inline: false });

  fields.push({
    name: `${e('met_scales')} Your right of appeal`,
    value: 'If you believe this is a mistake, open your record below and file an appeal. '
         + 'An investigator will review it, and a granted appeal removes the punishment from your record entirely.',
    inline: false,
  });

  const lines = [
    o.direct
      // Said plainly. Being disciplined without an investigation is a
      // legitimate outcome, and somebody is entitled to know which one theirs
      // was rather than assuming a review happened.
      ? `${e('met_warn')} This was a **direct disciplinary action** taken by command, not the outcome of an investigation.`
      : `${e('met_tick')} This case has been **reviewed and approved** by Internal Affairs High Command.`,
    '',
    `It has been added to your **permanent record** and will remain there unless an appeal is granted.`,
  ];
  if (o.robloxUsername) {
    lines.unshift(`${e('met_user')} **${o.robloxUsername}**`
      + (o.robloxId ? ` · [Roblox profile](https://www.roblox.com/users/${o.robloxId}/profile)` : ''), '');
  }

  return require('./bot').dmMemberNotice(o.discordId, {
    color: COLOR.punished,
    authorName: 'Metropolitan Police Service · Professional Standards',
    title: 'You have received a disciplinary action',
    description: lines.join('\n'),
    fields,
    thumbnail: o.avatar || null,
    timestamp: o.issuedAt || Date.now(),
    footer: o.caseRef ? `Permanent record · Infraction ID ${o.caseRef}` : 'Permanent record',
    links: [{ label: 'View my full record', url: recordUrl(o.caseId) }],
  }).catch(() => false);
}

/**
 * Tell an officer an action against them has been lifted.
 *
 * Good news, and it reads like it. It names who granted it and why, because
 * "your punishment is gone" with no explanation invites exactly the question
 * the message was meant to answer.
 */
async function notifyAppealed(o) {
  if (process.env.MEMBER_ACTION_DM === 'off') return 'off';
  if (!o || !o.discordId) return false;

  const fields = [
    { name: `${e('met_tick')} Lifted`, value: short(actionList(o.actions, o.action), 1000), inline: false },
  ];
  if (o.caseRef) fields.push({ name: `${e('met_search')} Infraction ID`, value: `\`${o.caseRef}\``, inline: true });
  fields.push({ name: `${e('met_scales')} Granted by`, value: short(`${o.by || 'Internal Affairs'}${o.rank ? ` (${o.rank})` : ''}`, 200), inline: true });
  if (o.reason) fields.push({ name: `${e('met_edit')} Reason`, value: short(o.reason, 1000), inline: false });

  fields.push({
    name: `${e('met_shield')} What this means`,
    value: `${e('met_tick')} The punishment no longer counts toward your record.\n`
         + `${e('met_tick')} Any Discord roles it added have been removed.\n`
         + `${e('met_tick')} It stays on your record marked as **appealed**, so the history is honest — but it holds nothing against you.`,
    inline: false,
  });
  if (o.manual && o.manual.length) {
    fields.push({
      name: `${e('met_warn')} Still being put right`,
      value: short(o.manual.join('\n'), 900) + '\n\nHigh Command have been told and will action it.',
      inline: false,
    });
  }

  return require('./bot').dmMemberNotice(o.discordId, {
    color: COLOR.appealed,
    authorName: 'Metropolitan Police Service · Professional Standards',
    title: 'A disciplinary action against you has been lifted',
    description: `${e('met_celebrate')} **Your appeal has been granted.**`
      + (o.robloxUsername ? `\n\n${e('met_user')} **${o.robloxUsername}**` : ''),
    fields,
    thumbnail: o.avatar || null,
    timestamp: Date.now(),
    footer: o.caseRef ? `Permanent record · Infraction ID ${o.caseRef}` : 'Permanent record',
    links: [{ label: 'View my full record', url: recordUrl(o.caseId) }],
  }).catch(() => false);
}

module.exports = { notifyPunished, notifyAppealed, actionList, consequenceFor, recordUrl, iconFor };
