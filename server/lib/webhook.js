// server/lib/webhook.js
const { ACTION_CONFIG } = require('./actions');
const { e } = require('./emoji');   // MET custom emoji, unicode fallback built in

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
 * Used both to send the bot-authored notice and to render a preview.
 */
// The default signature: Internal Affairs High Command, over the IA badge.
// That is right for a case, which IA investigated and IA concluded.
//
// It is NOT right for a direct action taken by MET High Command, who are not
// Internal Affairs and shouldn't be signing as them. Those are signed
// personally — see signatureFor().
const SIGN_AUTHOR_NAME = 'Signed, Internal Affairs High Command';
const SIGN_AUTHOR_ICON = 'https://cdn.discordapp.com/icons/1574841102169669692/bdaf270aa78f376ce95c7a9ad6095858.webp?size=1024';

/**
 * Who a notice is signed by.
 * @param {{name?: string, iconUrl?: string}} [signedBy] a personal signature
 * @returns {{ name: string, icon_url: string }}
 */
function signatureFor(signedBy) {
  if (signedBy && signedBy.name) {
    return {
      name: `Signed, ${String(signedBy.name).slice(0, 200)}.`,
      icon_url: signedBy.iconUrl || SIGN_AUTHOR_ICON,
    };
  }
  return { name: SIGN_AUTHOR_NAME, icon_url: SIGN_AUTHOR_ICON };
}

function buildCaseEmbed(data) {
  const {
    caseRef, action, actions, reason, notes, officerDiscordId, officerName,
    userDiscordId, targetDiscordId, targetName, suspectName, suspectAvatar,
    timestamp, appealed, signedBy, forumUrl,
  } = data || {};
  const hrId = data.hrDiscordId || officerDiscordId;
  const userId = userDiscordId || targetDiscordId || data.suspectDiscordId;
  const cap = value => {
    const text = String(value == null ? '' : value);
    return text.length > 1024 ? text.slice(0, 1021) + '…' : (text || 'N/A');
  };
  const userValue = userId ? `<@${userId}>` : (targetName || suspectName || officerName || '*Unknown*');
  // The disciplinary channel must link to the IA forum discussion, never the
  // classified case document/evidence URL stored in caseLink.
  const caseUrl = String(forumUrl || '');
  const caseValue = caseUrl.startsWith('https://') || caseUrl.startsWith('http://')
    ? `[Case](${caseUrl})`
    : (caseRef ? `Case ${caseRef} · forum link unavailable` : 'N/A');
  const embed = {
    color: 0x24364b,
    title: `<:IA:1552764629204205619> Administrative Action · ${caseRef || 'Record'}`,
    author: signatureFor(signedBy),
    fields: [
      { name: 'HR', value: cap(hrId ? `<@${hrId}>` : officerName), inline: true },
      { name: 'USER', value: cap(userValue), inline: true },
      { name: 'ACTION', value: cap(buildActionList({ actions, action })), inline: false },
      { name: 'REASON', value: cap(reason), inline: false },
      { name: 'CASE', value: cap(caseValue), inline: false },
      { name: 'APPEALS', value: 'Contact Internal Affairs through <#1400148940560797846>.', inline: false },
      ...(notes ? [{ name: 'NOTES', value: cap(notes), inline: false }] : []),
    ],
    footer: { text: 'Metropolitan Police Service · Internal Affairs' },
    timestamp: new Date(timestamp || Date.now()).toISOString(),
  };
  if (suspectAvatar) embed.thumbnail = { url: suspectAvatar };
  if (appealed) {
    embed.color = 0x64748b;
    embed.title = `Administrative Action · ${caseRef || 'Record'} · APPEALED`;
    embed.fields.push({
      name: 'APPEAL OUTCOME',
      value: cap(`Granted by ${appealed.by || 'Internal Affairs'}${appealed.rank ? ` (${appealed.rank})` : ''}. Punishments have been lifted.${appealed.reason ? `\n${appealed.reason}` : ''}`),
      inline: false,
    });
  }
  return embed;
}

/**
 * Sends an approved-case notification to #administrative-logs.
 * Returns the posted message ID (so edits can update it in place), or null.
 */
async function sendApprovalWebhook(data) {
  const channelId = process.env.DISCIPLINARY_LOG_CHANNEL_ID || '1561488521230024854';
  try {
    const id = await require('./bot').postChannelMessage(channelId, {
      embeds: [buildCaseEmbed(data)],
      allowedMentions: { parse: [] },
    });
    if (!id) {
      console.error('[DisciplineLog] bot could not post to channel', channelId);
      return null;
    }
    console.log(`Disciplinary log posted to ${channelId} (msg ${id})`);
    return id;
  } catch (err) {
    console.error('[DisciplineLog] channel post failed:', err.message);
    return null;
  }
}

/**
 * Edit an already-posted Administrative Log message in place.
 * Returns true on success.
 */
async function editApprovalWebhook(messageId, data) {
  if (!messageId) return false;
  const channelId = process.env.DISCIPLINARY_LOG_CHANNEL_ID || '1561488521230024854';
  try {
    return await require('./bot').editChannelMessage(channelId, messageId, {
      embeds: [buildCaseEmbed(data)],
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    console.error('[DisciplineLog] channel edit failed:', err.message);
    return false;
  }
}

/**
 * Post a non-disciplinary MET action notice (promotions/rank changes) in the
 * dedicated MET notice channel.
 */
async function sendMetNotice({ hrId, hrName, userId, userName, reason, action, duration, proof }) {
  const channelId = process.env.MET_NOTICE_CHANNEL_ID || '1458943564456399091';
  const field = (name, value) => ({
    name,
    value: String(value || 'N/A').slice(0, 1000),
    inline: false,
  });
  const embed = {
    color: 0x1d4ed8,
    title: '<:IA:1552764629204205619> MET NOTICE',
    fields: [
      field('HR', hrId ? `<@${hrId}>` : hrName),
      field('USER', userId ? `<@${userId}>` : userName),
      field('REASON', reason),
      field('ACTION', action),
      field('DURATION', duration),
      field('PROOF', proof),
    ],
    footer: { text: 'Metropolitan Police Service' },
  };
  try {
    const id = await require('./bot').postChannelMessage(channelId, {
      embeds: [embed],
      allowedMentions: { parse: [] },
    });
    if (!id) console.error('[MetNotice] bot could not post to channel', channelId);
    return id || null;
  } catch (err) {
    console.error('[MetNotice] channel post failed:', err.message);
    return null;
  }
}
/**
 * Post the weekly Quota Check results to Discord.
 * results: [{ username, rank, total, target, status:'pass'|'fail', reason }]
 * Posts the weekly quota review directly through the MET bot.
 */
// Where the Internal Affairs weekly quota review is posted, and which role it
// pings. Both overridable, both with the real values as defaults so nothing has
// to be configured for it to work.
const IA_QUOTA_CHANNEL_ID  = () => process.env.IA_QUOTA_CHANNEL_ID  || '1520745276930003035';
const IA_QUOTA_GUILD_ID    = () => process.env.IA_QUOTA_GUILD_ID    || '1424498408009240649';
const IA_QUOTA_PING_ROLE_ID = () => process.env.IA_QUOTA_PING_ROLE_ID || '1424504802741588019';

async function sendQuotaCheckWebhook({ reviewerName, reviewerId, results, weekLabel, iotwUsername, mentionRoleId, divisionLabel, automatic, iotwTied, iotwPoints }) {
  const passed = results.filter(r => r.status === 'pass').length;
  const failed = results.filter(r => r.status === 'fail').length;
  const iotwLc = (iotwUsername || '').toString().trim().toLowerCase();

  const exempt = results.filter(r => r.status === 'exempt').length;

  // A mark per outcome rather than a tick and a cross for everything. "Met the
  // quota" is a different fact from "approved", and twenty of these are read at
  // a glance — the shape has to carry the meaning on its own.
  const line = (r) => {
    const icon   = r.status === 'exempt' ? e('met_exempt')
                 : r.status === 'pass'   ? e('met_quota_met')
                 : e('met_quota_miss');
    const pts    = r.exempt
      ? 'Exempt'
      : `**${r.total != null ? r.total : '?'}**${r.target != null ? '/' + r.target : ''} pts`;
    const reason = (r.status === 'fail' && r.reason) ? ` · ${String(r.reason).slice(0, 120)}` : '';
    const iotw   = (iotwLc && String(r.username).trim().toLowerCase() === iotwLc) ? ` ${e('met_trophy')}` : '';
    return `${icon} **${r.username}**${r.rank ? ` · ${r.rank}` : ''} · ${pts}${reason}${iotw}`;
  };

  // Highest first: a review is read to find who is short, and sorting by points
  // puts them together at the bottom instead of scattered through the list.
  const ordered = results.slice().sort((a, b) => {
    const rank = { fail: 0, pass: 1, exempt: 2 };
    return (rank[a.status] - rank[b.status]) || (Number(b.total) || 0) - (Number(a.total) || 0);
  }).reverse();

  let desc = ordered.map(line).join('\n');
  if (desc.length > 3800) desc = desc.slice(0, 3750) + '\n… (list truncated)';

  const fields = [
    { name: `${e('met_quota_met')} Met`,     value: String(passed), inline: true },
    { name: `${e('met_quota_miss')} Missed`, value: String(failed), inline: true },
    { name: `${e('met_exempt')} Exempt`,     value: String(exempt), inline: true },
  ];

  if (iotwUsername) {
    fields.push({
      name: `${e('met_trophy')} Investigator of the Week`,
      value: `**${iotwUsername}**${iotwPoints ? ` · ${iotwPoints} points` : ''}`,
      inline: false,
    });
  } else if (iotwTied && iotwTied.length > 1) {
    // Nobody, and why. A silent absence reads as an oversight.
    fields.push({
      name: `${e('met_trophy')} Investigator of the Week`,
      value: `Tied on **${iotwPoints}** points · ${iotwTied.slice(0, 8).join(', ')}. `
           + `High Command to pick one.`,
      inline: false,
    });
  }

  fields.push({
    name: `${e('met_chart')} Reviewed by`,
    value: automatic
      ? 'Automatic weekly check'
      : (reviewerId ? `<@${reviewerId}>` : (reviewerName || 'Unknown')),
    inline: false,
  });

  const embed = {
    color: failed ? 0xf5b730 : 0x2ed896,
    title: `${e('met_chart')} ${divisionLabel ? divisionLabel + ' ' : ''}Weekly Quota Review`
         + `${weekLabel ? ` · ${weekLabel}` : ''}`,
    description: desc || '*No members.*',
    fields,
    footer:    { text: `${divisionLabel || 'Internal Affairs'} · ${results.length} member(s)` },
    timestamp: new Date().toISOString(),
  };

  const division = String(divisionLabel || 'IA').toUpperCase();
  const channelId = division === 'IA'
    ? IA_QUOTA_CHANNEL_ID()
    : process.env[`${division}_QUOTA_RESULTS_CHANNEL_ID`] || null;
  if (!channelId) {
    console.error(`[Quota] No ${division} quota results channel ID is configured.`);
    return false;
  }
  const roleId = division === 'IA' ? IA_QUOTA_PING_ROLE_ID() : mentionRoleId;
  try {
    const id = await require('./bot').postChannelMessage(channelId, {
      content: roleId ? `<@&${roleId}>` : '',
      embeds: [embed],
      allowedMentions: { roles: roleId ? [roleId] : [], parse: [] },
    });
    if (!id) {
      console.error(`[Quota] Bot could not post ${division} quota results to channel ${channelId}.`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[Quota] ${division} channel post failed:`, err.message);
    return false;
  }
}

/**
 * Post a marked HPC Final Exam result to the MET results channel.
 * Mirrors the channel's existing format:
 *   Username of student: @<discord>
 *   Mark: 30/36 · Percentage: 83% · PASS ✅ / FAIL ❌ · NOTE: …
 * Posts directly through the MET bot and returns the message id, or null on failure.
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
    `${passed ? `PASS ${e('met_tick')}` : `FAIL ${e('met_cross')}`}\n` +
    `Notes: ${note ? String(note).slice(0, 1500) : 'N/A'}`;
  // Render the mention (nickname) but never PING the student.
  const body = { content, allowedMentions: { parse: [] } };

  // Send directly as the MET bot. No webhook fallback.
  const chId = process.env.FINAL_EXAM_CHANNEL_ID || '1509522116590960640';
  try {
    const id = await require('./bot').postChannelMessage(chId, body);
    if (id) return id;
    console.error('[Exam] Bot could not post to channel', chId);
  } catch (err) {
    console.error('[Exam] Bot channel post failed:', err.message);
  }
  return null;
}

// Route + embed for a tryout log. CID → CID_TRYOUT_LOG_*, HPC/SCO19 → HPC_*.
function tryoutLogRoute(log) {
  const isCid = String(log.division || '').toUpperCase() === 'CID';
  return {
    isCid,
    chId: (isCid && process.env.CID_TRYOUT_LOG_CHANNEL_ID) || process.env.HPC_TRYOUT_LOG_CHANNEL_ID || null,
  };
}
function buildTryoutLogEmbed(log, event) {
  const isCid = String(log.division || '').toUpperCase() === 'CID';
  const footerText = isCid ? 'Criminal Investigation Department · Tryout Log' : 'Hendon Police College · Tryout Log';
  const colorFor = { submitted: 0xf5b730, approved: 0x2ed896, denied: 0xf04f5e };
  const titleFor = { submitted: 'Tryout Log · Pending Review', approved: 'Tryout Log · Approved', denied: 'Tryout Log · Denied' };

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
  const { chId } = tryoutLogRoute(log);
  if (!chId) {
    console.error('[TryoutLog] No channel ID is configured for this division.');
    return null;
  }
  const embed = buildTryoutLogEmbed(log, event);
  try {
    const id = await require('./bot').postChannelMessage(chId, { embeds: [embed] });
    if (id) return id;
    console.error('[TryoutLog] Bot could not post to channel', chId);
  } catch (err) {
    console.error('[TryoutLog] Bot channel post failed:', err.message);
  }
  return null;
}

// EDIT the existing posted tryout log in place (used on approve/deny so the
// pending message updates rather than a second message being posted). Falls back
// to posting a fresh message if there's nothing to edit or the edit fails.
async function editTryoutLog(log, { event = 'submitted' } = {}) {
  if (!log.logMessageId) return sendTryoutLog(log, { event });
  const { chId } = tryoutLogRoute(log);
  const embed = buildTryoutLogEmbed(log, event);
  if (chId) {
    try {
      const ok = await require('./bot').editChannelMessage(chId, log.logMessageId, { embeds: [embed] });
      if (ok) return log.logMessageId;
    } catch (err) {
      console.error('[TryoutLog] Bot channel edit failed:', err.message);
    }
  }
  return sendTryoutLog(log, { event });
}

module.exports = {
  signatureFor, sendApprovalWebhook, editApprovalWebhook, buildCaseEmbed, sendMetNotice, sendQuotaCheckWebhook, sendHpcExamResult, sendTryoutLog, editTryoutLog,
  IA_QUOTA_CHANNEL_ID, IA_QUOTA_GUILD_ID, IA_QUOTA_PING_ROLE_ID };
