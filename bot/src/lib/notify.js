// What happens to the SUBJECT once a case is approved: a DM, a notice in the
// MET server, and their punishment roles.
//
// Every step is independent and best-effort — a closed DM must not stop the
// notice, and a failed notice must not stop the roles.
const { EmbedBuilder } = require('discord.js');
const { env } = require('./env');
const { e } = require('./emoji');

const APPEAL_NOTE = 'If you believe this is a mistake, open an appeal ticket with Internal Affairs.';

function punishmentLines(actions) {
  return (actions || []).map(a => {
    const dur  = a.durationDays ? ` — **${a.durationDays} day${a.durationDays === 1 ? '' : 's'}**` : '';
    const code = a.code ? ` \`${a.code}\`` : '';
    return `${e('BULLET')} **${a.action}**${dur}${code}`;
  }).join('\n') || '*None recorded*';
}

/** The embed the subject receives, and the one posted publicly. */
function buildNoticeEmbed(c, { forDm }) {
  const embed = new EmbedBuilder()
    .setColor(0xf04f5e)
    .setTitle(`${e('CASE')} Disciplinary Action — ${c.caseRef}`)
    .addFields(
      { name: 'Punishment(s)', value: punishmentLines(c.actions), inline: false },
      { name: 'Reason',        value: c.reason || 'N/A', inline: false },
    )
    .setFooter({ text: 'Metropolitan Police · Internal Affairs' })
    .setTimestamp();

  if (c.notes && c.notes !== 'N/A') embed.addFields({ name: 'Notes', value: c.notes, inline: false });
  if (c.blacklistCode) {
    embed.addFields({
      name: `${e('BLACKLIST')} Blacklist code`,
      value: `\`${c.blacklistCode}\`${c.blacklistReason ? ` — ${c.blacklistReason}` : ''}`,
      inline: true,
    });
  }
  if (forDm) {
    embed.setDescription(
      `A disciplinary case has been **approved** against your account.\n\n${APPEAL_NOTE}`);
  } else {
    embed.setDescription(c.officerDiscordId
      ? `<@${c.officerDiscordId}>${c.robloxUsername ? ` (\`${c.robloxUsername}\`)` : ''}`
      : (c.robloxUsername ? `\`${c.robloxUsername}\`` : '*Unknown officer*'));
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
