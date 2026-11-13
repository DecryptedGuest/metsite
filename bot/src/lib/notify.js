// What happens to the SUBJECT once a case is approved: a DM, a notice in the
// MET server, and their punishment roles.
//
// Every step is independent and best-effort — a closed DM must not stop the
// notice, and a failed notice must not stop the roles.
const { EmbedBuilder } = require('discord.js');
const { env } = require('./env');
const { e } = require('./emoji');

const APPEAL_NOTE = 'If you believe this is a mistake, open an appeal ticket with Internal Affairs.';

function noticeActions(c) {
  const actions = Array.isArray(c.actions) ? c.actions : [];
  if (actions.length) return actions.map(a => {
    const duration = a.durationDays ? ` (${a.durationDays} day${a.durationDays === 1 ? '' : 's'})` : '';
    return `${a.action}${duration}`;
  }).join(', ');
  return c.action || 'N/A';
}

/** The notice sent to the subject and posted in the MET server. */
function buildNoticeEmbed(c, { forDm }) {
  const subject = c.officerDiscordId ? `<@${c.officerDiscordId}>` : (c.robloxUsername || 'N/A');
  const duration = (c.actions || [])
    .filter(a => a.durationDays)
    .map(a => `${a.durationDays} day${a.durationDays === 1 ? '' : 's'}`)
    .join(', ') || 'N/A';

  const embed = new EmbedBuilder()
    .setColor(0xf04f5e)
    .setTitle(`${e('IA')} | MET HR NOTICE`)
    .addFields(
      { name: 'HR', value: c.reviewedBy ? `<@${c.reviewedBy}>` : 'N/A', inline: false },
      { name: 'Member', value: subject, inline: false },
      { name: 'Reason', value: c.reason || 'N/A', inline: false },
      { name: 'Action', value: noticeActions(c), inline: false },
      { name: 'Duration', value: duration, inline: false },
      { name: 'Proof', value: c.caseLink || 'N/A', inline: false },
    )
    .setFooter({ text: `MET Internal Affairs · ${c.caseRef || 'Notice'}` })
    .setTimestamp();

  if (forDm) {
    embed.setDescription(
      `A disciplinary action has been approved for your account. If you think this is wrong, contact Internal Affairs.`);
  }
  if (c.blacklistCode) {
    embed.addFields({
      name: 'Blacklist code',
      value: `\\`${c.blacklistCode}\\`${c.blacklistReason ? ` · ${c.blacklistReason}` : ''}`,
      inline: false,
    });
  }
  return embed;
}

/** DM the subject. Returns true only if it actually landed. */
async function dmSubject(client, c) {
  if (!c.officerDiscordId) return false;
  try {
    const user = await client.users.fetch(c.officerDiscordId);
    await user.send({ embeds: [buildNoticeEmbed(c, { forDm: true })] });
    console.log(`[notify] DM sent to ${c.officerDiscordId} for ${c.caseRef}`);
    return true;
  } catch (err) {
    // Closed DMs are normal and not an error worth failing the approval over.
    console.warn(`[notify] could not DM ${c.officerDiscordId} for ${c.caseRef}: ${err.message}`);
    return false;
  }
}

/** Post the public notice in the MET server. */
async function postMetNotice(client, c) {
  const channelId = env('MET_NOTICES_CHANNEL_ID');
  if (!channelId) return false;
  try {
    const channel = await client.channels.fetch(channelId);
    await channel.send({
      content: c.officerDiscordId ? `<@${c.officerDiscordId}>` : undefined,
      embeds: [buildNoticeEmbed(c, { forDm: false })],
    });
    return true;
  } catch (err) {
    console.error(`[notify] MET notice failed for ${c.caseRef}: ${err.message}`);
    return false;
  }
}

/**
 * Run every downstream effect of an approval.
 * Returns a per-step result so the reviewer can be told exactly what landed.
 */
async function announceApproval(client, c) {
  const [dm, notice] = await Promise.all([
    dmSubject(client, c),
    postMetNotice(client, c),
  ]);
  return { dm, notice };
}

module.exports = { announceApproval, dmSubject, postMetNotice, buildNoticeEmbed, punishmentLines };
