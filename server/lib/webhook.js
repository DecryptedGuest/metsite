// server/lib/webhook.js
const fetch = require('node-fetch');

// Build a human-readable punishment list (shared by the embed + previews).
function buildActionList({ actions, action }) {
  return Array.isArray(actions) && actions.length
    ? actions.map(a => {
        const dur = a.durationDays ? ` (${a.durationDays}d)` : ' (Permanent)';
        const noDur = ['Verbal Warning', 'Termination', 'Demotion', 'Blacklist'].includes(a.action) && !a.roleId;
        return `• ${a.action}${noDur ? '' : dur}`;
      }).join('\n')
    : `• ${action}`;
}

/**
 * Build the Administrative Log embed object for a case.
 * Used both to send the webhook and to render a preview before sending.
 */
// Fixed signature shown on every administrative-log notice.
const SIGN_AUTHOR_NAME = 'Signed, Internal Affairs High Command';
const SIGN_AUTHOR_ICON = 'https://metia.uk/media/880b6a85-064d-4c5a-a36f-c3d1fc8e7569';

function buildCaseEmbed({ caseRef, action, actions, reason, notes, officerDiscordId, officerName, officerRobloxId, suspectAvatar, timestamp }) {
  // Prefer a Discord mention; otherwise fall back to the Roblox username (with a
  // profile link if we have the id) so a known officer is never "Unknown".
  let staffMemberValue;
  if (officerDiscordId) staffMemberValue = `<@${officerDiscordId}>`;
  else if (officerName) staffMemberValue = officerRobloxId
    ? `[${officerName}](https://www.roblox.com/users/${officerRobloxId}/profile)`
    : officerName;
  else staffMemberValue = '*Unknown Officer*';
  const embed = {
    color:       0x2f3136,
    title:       'Staff Consequences & Discipline',
    author:      { name: SIGN_AUTHOR_NAME, icon_url: SIGN_AUTHOR_ICON },
    fields: [
      { name: '• Staff Member:',  value: staffMemberValue,                     inline: false },
      { name: '• Punishment(s):', value: buildActionList({ actions, action }), inline: false },
      { name: '• Reason:',        value: reason || 'N/A',                      inline: false },
      { name: '• Notes:',         value: notes || 'N/A',                       inline: false },
    ],
    footer:    { text: `Infraction ID | ${caseRef || 'pending'}` },
    timestamp: new Date(timestamp || Date.now()).toISOString(),
  };
  if (suspectAvatar) embed.thumbnail = { url: suspectAvatar };        // suspect's Roblox headshot
  return embed;
}

/**
 * Sends an approved-case notification to #administrative-logs.
 * Returns the posted message ID (so edits can update it in place), or null.
 */
async function sendApprovalWebhook(data) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn('No DISCORD_WEBHOOK_URL configured — skipping webhook.');
    return null;
  }

  const embed = buildCaseEmbed(data);
  if (data.edited) embed.title = 'Staff Consequences & Discipline (updated)';

  const body = { embeds: [embed] };
  if (data.officerDiscordId) body.content = `<@${data.officerDiscordId}>`;

  try {
    // ?wait=true makes Discord return the created message (with its id)
    const res = await fetch(webhookUrl + (webhookUrl.includes('?') ? '&' : '?') + 'wait=true', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`Webhook failed [${res.status}]:`, text);
      return null;
    }
    const msg = await res.json().catch(() => ({}));
    console.log(`Webhook sent for case ${data.caseRef} (msg ${msg.id})`);
    return msg.id || null;
  } catch (err) {
    console.error('Webhook error:', err.message);
    return null;
  }
}

/**
 * Edit an already-posted Administrative Log message in place.
 * Returns true on success.
 */
async function editApprovalWebhook(messageId, data) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl || !messageId) return false;

  const embed = buildCaseEmbed(data);
  embed.title = 'Staff Consequences & Discipline (updated)';
  const body = { embeds: [embed] };
  if (data.officerDiscordId) body.content = `<@${data.officerDiscordId}>`;

  // Webhook message edit: PATCH {webhookUrl}/messages/{messageId}
  const base = webhookUrl.split('?')[0].replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/messages/${messageId}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`Webhook edit failed [${res.status}]:`, text);
      return false;
    }
    console.log(`Webhook edited for case ${data.caseRef} (msg ${messageId})`);
    return true;
  } catch (err) {
    console.error('Webhook edit error:', err.message);
    return false;
  }
}

/**
 * Post the weekly Quota Check results to Discord.
 * results: [{ username, rank, total, target, status:'pass'|'fail', reason }]
 * Sends to QUOTA_RESULTS_WEBHOOK_URL, falling back to DISCORD_WEBHOOK_URL.
 */
async function sendQuotaCheckWebhook({ reviewerName, reviewerId, results, weekLabel, iotwUsername }) {
  const url = process.env.QUOTA_RESULTS_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL;
  if (!url) { console.warn('No webhook URL for quota check — skipping.'); return false; }

  const passed = results.filter(r => r.status === 'pass').length;
  const failed = results.filter(r => r.status === 'fail').length;
  const iotwLc = (iotwUsername || '').toString().trim().toLowerCase();

  const line = (r) => {
    const icon   = r.status === 'pass' ? '✅' : '❌';
    const pts    = r.exempt
      ? 'Exempt'
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

  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
  content: "<@&1424504802741588019>",
  embeds: [embed]
}),
    });
    if (!res.ok) { console.error(`Quota webhook failed [${res.status}]:`, await res.text()); return false; }
    return true;
  } catch (err) {
    console.error('Quota webhook error:', err.message);
    return false;
  }
}

module.exports = { sendApprovalWebhook, editApprovalWebhook, buildCaseEmbed, sendQuotaCheckWebhook };
