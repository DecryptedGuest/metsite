// server/lib/qpCommand.js
// /add-qp and /remove-qp — manual quota-point adjustments.
//
// Both go through the SAME durable outbox as automatic awards
// (lib/quota.enqueueQuotaAward), so a manual adjustment retries on a sheet
// failure exactly like an approved case does, and lands in the same audit
// trail. Writing the sheet directly from here would have been shorter and
// would have silently lost points whenever Google was having a bad minute.
//
// The ref is unique per adjustment (`manual:<interaction id>`), never per
// member: the outbox de-duplicates on the ref, so a per-member ref would make
// the second adjustment of the week a no-op.
const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { e, startLoading } = require('./emoji');
const { enqueueQuotaAward, getMemberPoints } = require('./quota');
const { resolveAuthority, isReviewer } = require('./iaAuthority');
const journal = require('./actionJournal');
const roblox = require('./roblox');

function buildCommand(name, verb) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(`${verb} quota points ${verb === 'Add' ? 'to' : 'from'} an IA member`)
    .addUserOption(o => o.setName('member').setDescription('The member').setRequired(true))
    .addIntegerOption(o => o.setName('points').setDescription('How many points')
      .setRequired(true).setMinValue(1).setMaxValue(1000))
    .addStringOption(o => o.setName('reason').setDescription('Why: recorded in the audit trail').setRequired(true))
    .toJSON();
}

const buildCommands = () => [buildCommand('add-qp', 'Add'), buildCommand('remove-qp', 'Remove')];

async function handleQp(interaction, sign) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const loader = startLoading(interaction, sign > 0 ? 'Adding points' : 'Removing points');

  // Supervisor and above. Same gate the site uses to approve a case, because
  // handing somebody points is the same kind of decision.
  const auth = await resolveAuthority(interaction);
  if (!auth.ok || !isReviewer(auth)) {
    loader.stop();
    return interaction.editReply(
      `${e('met_denied')} ${auth.why || 'Supervisor and above only.'}`);
  }

  const member = interaction.options.getUser('member');
  const points = interaction.options.getInteger('points') * sign;
  const reason = interaction.options.getString('reason');

  // The sheet is keyed by Roblox username, so an unlinked member has no row to
  // adjust. Say that rather than queueing an award that can never apply.
  loader.update('Resolving their Roblox account');
  let robloxUsername = null;
  try {
    const rbxId = await roblox.getRobloxIdFromDiscord(member.id);
    if (rbxId) {
      const info = await roblox.getRobloxUserInfo(rbxId);
      robloxUsername = (info && (info.name || info.username)) || null;
    }
  } catch (err) { /* fall through to the refusal below */ }

  if (!robloxUsername) {
    loader.stop();
    return interaction.editReply(
      `${e('met_denied')} ${member} has no linked Roblox account, so there is no sheet row to adjust.`);
  }

  loader.update('Queueing the adjustment');
  const refId = `manual:${interaction.id}`;
  await enqueueQuotaAward({
    refType: 'manual', refId,
    discordId: member.id, robloxUsername,
    points, division: 'IA',
    label: `${sign > 0 ? 'added' : 'removed'} by ${interaction.user.tag}: ${reason}`.slice(0, 180),
  });

  await journal.record({
    kind: 'QUOTA_ADJUST',
    actorId: interaction.user.id,
    actorName: interaction.member?.displayName || interaction.user.username,
    targetType: 'quota', targetId: member.id,
    summary: `${sign > 0 ? '+' : '−'}${Math.abs(points)} pts for ${robloxUsername}`,
    payload: { discordId: member.id, robloxUsername, points, reason, refId },
  }).catch(() => {});

  // Give the outbox a moment to land before reading the total back, so the
  // reply shows the number the sheet actually holds rather than the one before.
  loader.update('Reading the sheet back');
  await new Promise(r => setTimeout(r, 1500));
  let after = null;
  try { after = await getMemberPoints({ discordId: member.id, robloxUsername }, 'IA'); }
  catch (err) { after = null; }

  loader.stop();
  const embed = new EmbedBuilder()
    .setColor(sign > 0 ? 0x2ed896 : 0xf5b730)
    .setTitle(`${e('met_chart')} Quota ${sign > 0 ? 'credited' : 'deducted'}`)
    .setDescription(`**${sign > 0 ? '+' : '−'}${Math.abs(points)} pts** for ${member}`)
    .addFields(
      { name: 'Roblox', value: `\`${robloxUsername}\``, inline: true },
      { name: 'New total', value: after && after.found
          ? `**${after.total}**${after.quota && after.quota.target != null ? ` / ${after.quota.target}` : ''}`
          : '*queued: the sheet was not read back*', inline: true },
      { name: 'By', value: `${interaction.user}`, inline: true },
      { name: 'Reason', value: String(reason).slice(0, 1000), inline: false },
    )
    .setFooter({ text: 'Internal Affairs · /undo reverses this' })
    .setTimestamp();

  return interaction.editReply({ content: '', embeds: [embed] });
}

module.exports = { buildCommands, buildCommand, handleQp };
