const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const prisma = require('../lib/db');
const { isHR } = require('../lib/iaRanks');
const { isDeveloper } = require('../lib/perms');
const { e, startLoading } = require('../lib/emoji');
const { getMemberPoints, enqueueQuotaAward } = require('../lib/quota');
const roblox = require('../lib/roblox');

// "HR" here means IA Deputy Director and above (or the developer).
const allowed = (member) => isHR(member) || isDeveloper(member);
const HR_DENIED = '⛔ This is an HR command — Deputy Director and above.';

function build(name, verb) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(`[HR] ${verb} quota points ${verb === 'Add' ? 'to' : 'from'} a member`)
    .addUserOption(o => o.setName('member').setDescription('The member').setRequired(true))
    .addIntegerOption(o => o.setName('points').setDescription('How many points').setRequired(true).setMinValue(1).setMaxValue(1000))
    .addStringOption(o => o.setName('reason').setDescription('Why — recorded in the audit trail').setRequired(true));
}

async function adjust(interaction, sign) {
  if (!allowed(interaction.member)) {
    return interaction.reply({ content: HR_DENIED, flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const loader = startLoading(interaction, sign > 0 ? 'Adding points' : 'Removing points');

  try {
    const member = interaction.options.getUser('member');
    const points = interaction.options.getInteger('points') * sign;
    const reason = interaction.options.getString('reason');

    const rbxId = await roblox.getRobloxIdFromDiscord(member.id);
    const robloxUsername = rbxId ? (await roblox.getRobloxUserInfo(rbxId))?.name : null;
    if (!robloxUsername) {
      loader.stop();
      return interaction.editReply(`${e('DENY')} ${member} is not linked to a Roblox account, so there is no sheet row to adjust.`);
    }

    // Manual adjustments go through the same durable outbox as automatic
    // awards, so they retry identically and show up in the same audit trail.
    // The ref is unique per adjustment, never per member.
    const refId = `manual:${interaction.id}`;
    await enqueueQuotaAward({
      refType: 'manual', refId,
      discordId: member.id, robloxUsername,
      points,
      label: `${sign > 0 ? 'added' : 'removed'} by ${interaction.user.tag}: ${reason}`.slice(0, 180),
    });

    loader.update('Reading the sheet back…');
    // Give the outbox a moment to land before reporting the new total.
    await new Promise(r => setTimeout(r, 1200));
    const after = await getMemberPoints({ discordId: member.id, robloxUsername }, interaction.client.bot);

    loader.stop();
    return interaction.editReply({ content: '', embeds: [new EmbedBuilder()
      .setColor(sign > 0 ? 0x2ed896 : 0xf5b730)
      .setTitle(`${e('POINTS')} Quota ${sign > 0 ? 'credited' : 'deducted'}`)
      .setDescription(`${sign > 0 ? '**+' : '**−'}${Math.abs(points)} pts** for ${member}`)
      .addFields(
        { name: 'Roblox',  value: `\`${robloxUsername}\``, inline: true },
        { name: 'New total', value: after?.found ? `**${after.total}**${after.quota?.target != null ? ` / ${after.quota.target}` : ''}` : '*queued — sheet not read back*', inline: true },
        { name: 'By',      value: `${interaction.user}`, inline: true },
        { name: 'Reason',  value: reason, inline: false },
      )
      .setTimestamp()] });
  } catch (err) {
    loader.stop();
    return interaction.editReply(`${e('DENY')} ${err.message}`);
  }
}

module.exports = {
  addQp: {
    data: build('add-qp', 'Add'),
    execute: (i) => adjust(i, +1),
  },
  removeQp: {
    data: build('remove-qp', 'Remove'),
    execute: (i) => adjust(i, -1),
  },
};
