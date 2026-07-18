// server/lib/webhook.js
const fetch = require('node-fetch');
const { ACTION_CONFIG } = require('./actions');

// Build a human-readable punishment list (shared by the embed + previews).
// Only TIMED punishments (Zero Tolerance, Suspension) carry a duration: show
// (Nd) when a length is set, else (Permanent) for an indefinite timed one.
// Untimed actions (warnings, strikes, demotion, termination, blacklist) are
// one-off and get no duration tag — the old logic wrongly stamped '(Permanent)'
// on every warning/strike.
function buildActionList({ actions, action }) {
  return Array.isArray(actions) && actions.length
    ? actions.map(a => {
        const timed = ACTION_CONFIG[a.action] ? ACTION_CONFIG[a.action].timed : false;
        const suffix = timed ? (a.durationDays ? ` (${a.durationDays}d)` : ' (Permanent)') : '';
        return `• ${a.action}${suffix}`;
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
  // Discord rejects the whole webhook (HTTP 400) if any embed field value exceeds
  // 1024 chars — which silently dropped the admin log (and left case.logMessageId
  // null, so edits could never target it) for long reasons/notes. Cap each field.
  const cap = (s) => { s = String(s == null ? '' : s); return s.length > 1024 ? s.slice(0, 1021) + '…' : s; };
  const embed = {
    color:       0x2f3136,
    title:       'Staff Consequences & Discipline',
    author:      { name: SIGN_AUTHOR_NAME, icon_url: SIGN_AUTHOR_ICON },
    fields: [
      { name: '• Staff Member:',  value: cap(staffMemberValue),                     inline: false },
      { name: '• Punishment(s):', value: cap(buildActionList({ actions, action })), inline: false },
      { name: '• Reason:',        value: cap(reason || 'N/A'),                      inline: false },
      { name: '• Notes:',         value: cap(notes || 'N/A'),                       inline: false },
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
async function sendQuotaCheckWebhook({ reviewerName, reviewerId, results, weekLabel, iotwUsername, webhookUrl, mentionRoleId, divisionLabel }) {
  // A scoped (division) call passes `webhookUrl` + `divisionLabel`; the IA path
  // passes neither, so its URL/ping/labels stay exactly as before.
  const url = webhookUrl || process.env.QUOTA_RESULTS_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL;
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
    title: `${divisionLabel ? divisionLabel + ' ' : ''}Weekly Quota Review${weekLabel ? ` — ${weekLabel}` : ''}`,
    description: desc || '*No members.*',
    fields: [
      { name: 'Reviewed by', value: reviewerId ? `<@${reviewerId}>` : (reviewerName || 'Unknown'), inline: true },
      { name: 'Passed',      value: String(passed), inline: true },
      { name: 'Failed',      value: String(failed), inline: true },
    ],
    footer:    { text: `${divisionLabel || 'Internal Affairs'} · Quota Check` },
    timestamp: new Date().toISOString(),
  };

  // IA keeps its hardcoded role ping; a scoped call pings mentionRoleId when set,
  // otherwise no ping.
  const content = divisionLabel
    ? (mentionRoleId ? `<@&${mentionRoleId}>` : '')
    : '<@&1424504802741588019>';

  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, embeds: [embed] }),
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
  // Plain-text format matching how markers post results in #final-exam-results:
  //   Username of student: <@id>       (renders their MET nickname; no ping)
  //   Mark: 33/36
  //   Percentage: 92%
  //   PASS ✅            (or FAIL ❌)
  //   Notes: N/A
  // Resolve the student's ACTUAL MET server nickname and post it as plain text.
  // A raw <@id> mention renders as "@unknown-user" whenever Discord can't resolve
  // the member in the results channel's guild (e.g. the results channel lives in a
  // different guild than the one the student is in) — which is exactly the reported
  // bug. Resolving the nickname server-side (from the MET guild) and posting it as
  // text guarantees a readable name. Fall back through Roblox/Discord username, then
  // the mention, then Unknown.
  let resolvedName = null;
  if (discordId) {
    try { resolvedName = await require('./bot').getMemberDisplayName(discordId); } catch (e) { resolvedName = null; }
  }
  const student = resolvedName || robloxUsername || discordUsername || (discordId ? `<@${discordId}>` : 'Unknown');
  const content =
    `Username of student: ${student}\n` +
    `Mark: ${score}/${maxScore}\n` +
    `Percentage: ${percentage}%\n` +
    `${passed ? 'PASS ✅' : 'FAIL ❌'}\n` +
    `Notes: ${note ? String(note).slice(0, 1500) : 'N/A'}`;
  // Render the mention (nickname) but never PING the student.
  const body = { content, allowedMentions: { parse: [] } };

  // Post AS THE MET BOT to the final-exam-results channel (default the linked
  // channel). Fall back to the results webhook only if the bot can't deliver.
  const chId = process.env.FINAL_EXAM_CHANNEL_ID || '1509522116590960640';
  try {
    const bot = require('./bot');
    if (chId && typeof bot.postChannelMessage === 'function') {
      const id = await bot.postChannelMessage(chId, body);
      if (id) return id;
    }
  } catch (e) { console.error('HPC exam bot post error:', e.message); }

  const url = process.env.FINAL_EXAM_WEBHOOK || process.env.HPC_RESULTS_WEBHOOK_URL;
  if (url) {
    try {
      const res = await fetch(url + (url.includes('?') ? '&' : '?') + 'wait=true', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (res.ok) { const msg = await res.json().catch(() => ({})); return msg.id || 'sent'; }
      console.error(`HPC exam webhook failed [${res.status}]:`, await res.text().catch(() => ''));
    } catch (err) { console.error('HPC exam webhook error:', err.message); }
  }
  console.warn('[Exam] result was NOT delivered — check the bot is in the guild or set FINAL_EXAM_WEBHOOK.');
  return null;
}

// Route + embed for a tryout log. CID → CID_TRYOUT_LOG_*, HPC/SCO19 → HPC_*.
function tryoutLogRoute(log) {
  const isCid = String(log.division || '').toUpperCase() === 'CID';
  return {
    isCid,
    url:  (isCid && process.env.CID_TRYOUT_LOG_WEBHOOK) || process.env.HPC_TRYOUT_LOG_WEBHOOK || null,
    chId: (isCid && process.env.CID_TRYOUT_LOG_CHANNEL_ID) || process.env.HPC_TRYOUT_LOG_CHANNEL_ID || null,
  };
}
function buildTryoutLogEmbed(log, event) {
  const isCid = String(log.division || '').toUpperCase() === 'CID';
  const footerText = isCid ? 'Criminal Investigation Department · Tryout Log' : 'Hendon Police College · Tryout Log';
  const colorFor = { submitted: 0xf5b730, approved: 0x2ed896, denied: 0xf04f5e };
  const titleFor = { submitted: 'Tryout Log — Pending Review', approved: 'Tryout Log — Approved', denied: 'Tryout Log — Denied' };

  const A       = Array.isArray(log.attendees) ? log.attendees : [];
  const names   = A.map(a => a && a.username).filter(Boolean);
  const passed  = A.filter(a => a && a.result === 'PASS').map(a => a.username).filter(Boolean);
  const failed  = A.filter(a => a && a.result === 'FAIL').map(a => a.username).filter(Boolean);
  const hostName = log.hostRobloxName || log.hostName || 'Unknown';
  const coHost   = log.coHostName || 'N/A';
  const proof    = log.proof ? String(log.proof).slice(0, 500) : '';

  const lines = isCid
    ? [`**Host:** ${hostName}`, `**Co-Host:** ${coHost}`, `**Attendees:** ${names.join(' - ') || 'N/A'}`,
       `**Failed:** ${failed.join(', ') || 'None'}`, `**Passed:** ${passed.join(', ') || 'None'}`, `**Proof:** ${proof}`]
    : [`**User:** ${hostName}`, `**Co-Host:** ${coHost}`, `**Tryout Passer:** ${passed.join(', ') || 'None'}`, `**Proof:** ${proof}`];
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
  if (/^https?:\/\/\S+\.(png|jpe?g|gif|webp)(\?\S*)?$/i.test(proof)) embed.image = { url: proof };
  return embed;
}

// Post a tryout log for review. Returns the message id, or null.
async function sendTryoutLog(log, { event = 'submitted' } = {}) {
  const { url, chId } = tryoutLogRoute(log);
  if (!url && !chId) { console.warn('No tryout-log webhook or channel configured — skipping tryout log post.'); return null; }
  const embed = buildTryoutLogEmbed(log, event);

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

// EDIT the existing posted tryout log in place (used on approve/deny so the
// pending message updates rather than a second message being posted). Falls back
// to posting a fresh message if there's nothing to edit or the edit fails.
async function editTryoutLog(log, { event = 'submitted' } = {}) {
  if (!log.logMessageId) return sendTryoutLog(log, { event });
  const { url, chId } = tryoutLogRoute(log);
  const embed = buildTryoutLogEmbed(log, event);

  if (url) {
    const base = url.split('?')[0].replace(/\/+$/, '');
    try {
      const res = await fetch(`${base}/messages/${log.logMessageId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ embeds: [embed] }),
      });
      if (res.ok) return log.logMessageId;
      console.error(`Tryout log webhook edit failed [${res.status}]:`, await res.text().catch(() => ''));
    } catch (err) { console.error('Tryout log webhook edit error:', err.message); }
  }
  if (chId) {
    try {
      const bot = require('./bot');
      if (typeof bot.editChannelMessage === 'function') {
        const ok = await bot.editChannelMessage(chId, log.logMessageId, { embeds: [embed] });
        if (ok) return log.logMessageId;
      }
    } catch (e) { console.error('Tryout log channel edit error:', e.message); }
  }
  // Couldn't edit → post a fresh one so the outcome is still visible.
  return sendTryoutLog(log, { event });
}

module.exports = { sendApprovalWebhook, editApprovalWebhook, buildCaseEmbed, sendQuotaCheckWebhook, sendHpcExamResult, sendTryoutLog, editTryoutLog };
