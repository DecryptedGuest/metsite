// Discord webhook posts: the Administrative Log notice and the weekly quota
// review. Both are plain webhook calls rather than bot messages so they carry
// the configured webhook identity in the target channel.
const { env } = require('./env');

const SIGN_AUTHOR_NAME = 'Signed, Internal Affairs High Command';

/** Human-readable punishment list for the log embed. */
function buildActionList({ actions, action }) {
  if (!Array.isArray(actions) || !actions.length) return `• ${action}`;
  return actions.map(a => {
    const dur = a.durationDays ? ` (${a.durationDays}d)` : ' (Permanent)';
    // These read wrong with a duration when they carry no role.
    const noDur = ['Verbal Warning', 'Termination', 'Demotion', 'Blacklist'].includes(a.action) && !a.roleId;
    return `• ${a.action}${noDur ? '' : dur}`;
  }).join('\n');
}

function buildCaseEmbed({ caseRef, action, actions, reason, notes, officerDiscordId,
                          officerName, officerRobloxId, suspectAvatar, timestamp }) {
  let staffMemberValue;
  if (officerDiscordId) staffMemberValue = `<@${officerDiscordId}>`;
  else if (officerName) staffMemberValue = officerRobloxId
    ? `[${officerName}](https://www.roblox.com/users/${officerRobloxId}/profile)`
    : officerName;
  else staffMemberValue = '*Unknown Officer*';

  const embed = {
    color:  0x2f3136,
    title:  'Staff Consequences & Discipline',
    author: { name: SIGN_AUTHOR_NAME, ...(env('SIGNATURE_ICON_URL') ? { icon_url: env('SIGNATURE_ICON_URL') } : {}) },
    fields: [
      { name: '• Staff Member:',  value: staffMemberValue,                     inline: false },
      { name: '• Punishment(s):', value: buildActionList({ actions, action }), inline: false },
      { name: '• Reason:',        value: reason || 'N/A',                      inline: false },
      { name: '• Notes:',         value: notes  || 'N/A',                      inline: false },
    ],
    footer:    { text: `Infraction ID | ${caseRef || 'pending'}` },
    timestamp: new Date(timestamp || Date.now()).toISOString(),
  };
  if (suspectAvatar) embed.thumbnail = { url: suspectAvatar };
  return embed;
}

/** Post the approved-case notice. Returns the message id so edits can find it. */
async function sendApprovalWebhook(data) {
  const url = env('DISCORD_WEBHOOK_URL');
  if (!url) { console.warn('No DISCORD_WEBHOOK_URL configured — skipping webhook.'); return null; }

  const embed = buildCaseEmbed(data);
  if (data.edited) embed.title = 'Staff Consequences & Discipline (updated)';
  const body = { embeds: [embed] };
  if (data.officerDiscordId) body.content = `<@${data.officerDiscordId}>`;

  try {
    // ?wait=true is what makes Discord return the created message (with its id).
    const res = await fetch(url + (url.includes('?') ? '&' : '?') + 'wait=true', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) { console.error(`Webhook failed [${res.status}]:`, await res.text()); return null; }
    const msg = await res.json().catch(() => ({}));
    console.log(`Webhook sent for case ${data.caseRef} (msg ${msg.id})`);
    return msg.id || null;
  } catch (err) {
    console.error('Webhook error:', err.message);
    return null;
  }
}

/** Edit an already-posted notice in place. */
async function editApprovalWebhook(messageId, data) {
  const url = env('DISCORD_WEBHOOK_URL');
  if (!url || !messageId) return false;

  const embed = buildCaseEmbed(data);
  embed.title = 'Staff Consequences & Discipline (updated)';
  const body = { embeds: [embed] };
  if (data.officerDiscordId) body.content = `<@${data.officerDiscordId}>`;

  const base = url.split('?')[0].replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/messages/${messageId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) { console.error(`Webhook edit failed [${res.status}]:`, await res.text()); return false; }
    return true;
  } catch (err) {
    console.error('Webhook edit error:', err.message);
    return false;
  }
}

/** Weekly quota review. results: [{ username, rank, total, target, status, reason, exempt }] */
async function sendQuotaCheckWebhook({ reviewerName, reviewerId, results, weekLabel, iotwUsername }) {
  const url = env('QUOTA_RESULTS_WEBHOOK_URL') || env('DISCORD_WEBHOOK_URL');
  if (!url) { console.warn('No webhook URL for the quota check — skipping.'); return false; }

  const passed = results.filter(r => r.status === 'pass').length;
  const failed = results.filter(r => r.status === 'fail').length;
  const iotwLc = (iotwUsername || '').toString().trim().toLowerCase();

  const line = (r) => {
    const icon = r.status === 'pass' ? '✅' : '❌';
    const pts  = r.exempt ? 'Exempt'
      : `${r.total != null ? r.total : '?'}${r.target != null ? '/' + r.target : ''} pts`;
    const reason = (r.status === 'fail' && r.reason) ? ` — ${String(r.reason).slice(0, 120)}` : '';
    const iotw   = (iotwLc && String(r.username).trim().toLowerCase() === iotwLc) ? ' — ⭐ IOTW' : '';
    return `${icon} **${r.username}**${r.rank ? ` · ${r.rank}` : ''} — ${pts}${reason}${iotw}`;
  };

  let desc = results.map(line).join('\n');
  if (desc.length > 3900) desc = desc.slice(0, 3850) + '\n… (list truncated)';

  const embed = {
    color: 0x4a8fff,
    title: `Weekly Quota Review${weekLabel ? ` — ${weekLabel}` : ''}`,
    description: desc || '*No members.*',
    fields: [
      { name: 'Reviewed by', value: reviewerId ? `<@${reviewerId}>` : (reviewerName || 'Unknown'), inline: true },
      { name: 'Passed',      value: String(passed), inline: true },
      { name: 'Failed',      value: String(failed), inline: true },
    ],
    footer:    { text: 'Internal Affairs · Quota Check' },
    timestamp: new Date().toISOString(),
  };

  const body = { embeds: [embed] };
  const ping = env('QUOTA_PING_ROLE_ID');
  if (ping) body.content = `<@&${ping}>`;

  try {
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) { console.error(`Quota webhook failed [${res.status}]:`, await res.text()); return false; }
    return true;
  } catch (err) {
    console.error('Quota webhook error:', err.message);
    return false;
  }
}

module.exports = { buildCaseEmbed, buildActionList, sendApprovalWebhook, editApprovalWebhook, sendQuotaCheckWebhook };
