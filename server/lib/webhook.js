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

/**
 * Post a marked HPC Final Exam result to the MET results channel.
 * Mirrors the channel's existing format:
 *   Username of student: @<discord>
 *   Mark: 30/36 · Percentage: 83% · PASS ✅ / FAIL ❌ · NOTE: …
 * Uses HPC_RESULTS_WEBHOOK_URL (a webhook on the results channel). Returns the
 * posted message id, or null if no webhook is configured / it failed.
 */
async function sendHpcExamResult({ discordId, robloxUsername, discordUsername, score, maxScore, percentage, passed, note }) {
  const embed = {
    color: passed ? 0x2ed896 : 0xf04f5e,
    title: `Final Exam Result — ${passed ? 'PASS ✅' : 'FAIL ❌'}`,
    fields: [
      { name: 'Student',    value: discordId ? `<@${discordId}>${discordUsername ? ` (@${discordUsername})` : ''}` : (discordUsername || 'Unknown'), inline: false },
      ...(robloxUsername ? [{ name: 'Roblox', value: String(robloxUsername), inline: true }] : []),
      { name: 'Mark',       value: `${score}/${maxScore}`, inline: true },
      { name: 'Percentage', value: `${percentage}%`, inline: true },
    ],
    description: note ? `**NOTE:** ${String(note).slice(0, 1500)}` : undefined,
    footer:    { text: 'Hendon Police College · Final Examination' },
    timestamp: new Date().toISOString(),
  };
  const body = { embeds: [embed] };
  if (discordId) body.content = `<@${discordId}>`;

  // Primary: the results webhook. Fallback: post via the bot to a channel id
  // (FINAL_EXAM_CHANNEL_ID) so results still deliver if the webhook is unset/broken.
  const url = process.env.FINAL_EXAM_WEBHOOK || process.env.HPC_RESULTS_WEBHOOK_URL;
  if (url) {
    try {
      const res = await fetch(url + (url.includes('?') ? '&' : '?') + 'wait=true', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (res.ok) { const msg = await res.json().catch(() => ({})); return msg.id || 'sent'; }
      console.error(`HPC exam webhook failed [${res.status}]:`, await res.text().catch(() => ''));
    } catch (err) { console.error('HPC exam webhook error:', err.message); }
  } else {
    console.warn('No FINAL_EXAM_WEBHOOK / HPC_RESULTS_WEBHOOK_URL configured.');
  }

  const chId = process.env.FINAL_EXAM_CHANNEL_ID;
  if (chId) {
    try {
      const bot = require('./bot');
      if (typeof bot.postChannelMessage === 'function') {
        const id = await bot.postChannelMessage(chId, body);
        if (id) return id;
      }
    } catch (e) { console.error('HPC exam channel fallback error:', e.message); }
  }
  console.warn('[Exam] result was NOT delivered — set FINAL_EXAM_WEBHOOK or FINAL_EXAM_CHANNEL_ID.');
  return null;
}

// Post a submitted tryout log to the HPC tryout-logs channel for HICOMM review.
// Returns the message id, or null if no webhook is configured / it fails.
async function sendTryoutLog(log, { event = 'submitted' } = {}) {
  // Route by division: CID logs to CID_TRYOUT_LOG_WEBHOOK, HPC to
  // HPC_TRYOUT_LOG_WEBHOOK (CID falls back to the HPC webhook if unset).
  const isCid = String(log.division || '').toUpperCase() === 'CID';
  const url = (isCid && process.env.CID_TRYOUT_LOG_WEBHOOK) || process.env.HPC_TRYOUT_LOG_WEBHOOK;
  const chId = (isCid && process.env.CID_TRYOUT_LOG_CHANNEL_ID) || process.env.HPC_TRYOUT_LOG_CHANNEL_ID;
  if (!url && !chId) { console.warn('No tryout-log webhook or channel configured — skipping tryout log post.'); return null; }
  const footerText = isCid ? 'Criminal Investigation Department · Tryout Log' : 'Hendon Police College · Tryout Log';

  const colorFor = { submitted: 0xf5b730, approved: 0x2ed896, denied: 0xf04f5e };
  const titleFor = { submitted: 'Tryout Log — Pending Review', approved: 'Tryout Log — Approved', denied: 'Tryout Log — Denied' };

  // Build the CID / HPC log body in the exact requested format from the
  // per-attendee results (roblox usernames).
  const A       = Array.isArray(log.attendees) ? log.attendees : [];
  const names   = A.map(a => a && a.username).filter(Boolean);
  const passed  = A.filter(a => a && a.result === 'PASS').map(a => a.username).filter(Boolean);
  const failed  = A.filter(a => a && a.result === 'FAIL').map(a => a.username).filter(Boolean);
  const hostName = log.hostRobloxName || log.hostName || 'Unknown';
  const coHost   = log.coHostName || 'N/A';
  const proof    = log.proof ? String(log.proof).slice(0, 500) : '';

  const lines = isCid
    ? [
        `**Host:** ${hostName}`,
        `**Co-Host:** ${coHost}`,
        `**Attendees:** ${names.join(' - ') || 'N/A'}`,
        `**Failed:** ${failed.join(', ') || 'None'}`,
        `**Passed:** ${passed.join(', ') || 'None'}`,
        `**Proof:** ${proof}`,
      ]
    : [
        `**User:** ${hostName}`,
        `**Co-Host:** ${coHost}`,
        `**Tryout Passer:** ${passed.join(', ') || 'None'}`,
        `**Proof:** ${proof}`,
      ];
  if ((event === 'approved' || event === 'denied') && log.reviewNote) {
    lines.push('', `**${event === 'approved' ? 'Note' : 'Reason'}:** ${String(log.reviewNote).slice(0, 1000)}`);
  }

  const embed = {
    color: colorFor[event] || 0x4a8fff,
    title: titleFor[event] || 'Tryout Log',
    description: lines.join('\n'),
    footer:    { text: footerText },
    timestamp: new Date().toISOString(),
  };
  // If the proof is an image/link, surface it as the embed image too.
  if (/^https?:\/\/\S+\.(png|jpe?g|gif|webp)(\?\S*)?$/i.test(proof)) embed.image = { url: proof };

  // Primary: webhook. Fallback: post via the bot to the log channel id.
  if (url) {
    try {
      const res = await fetch(url + (url.includes('?') ? '&' : '?') + 'wait=true', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ embeds: [embed] }),
      });
      if (res.ok) { const msg = await res.json().catch(() => ({})); return msg.id || 'sent'; }
      console.error(`Tryout log webhook failed [${res.status}]:`, await res.text().catch(() => ''));
    } catch (err) { console.error('Tryout log webhook error:', err.message); }
  }
  if (chId) {
    try {
      const bot = require('./bot');
      if (typeof bot.postChannelMessage === 'function') {
        const id = await bot.postChannelMessage(chId, { embeds: [embed] });
        if (id) return id;
      }
    } catch (e) { console.error('Tryout log channel fallback error:', e.message); }
  }
  return null;
}

module.exports = { sendApprovalWebhook, editApprovalWebhook, buildCaseEmbed, sendQuotaCheckWebhook, sendHpcExamResult, sendTryoutLog };
