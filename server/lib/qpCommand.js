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


const {
  SlashCommandBuilder: QpSlashCommandBuilder,
  EmbedBuilder: QpEmbedBuilder,
  MessageFlags: QpMessageFlags,
} = require('discord.js');
const { startLoading: startQpLoading } = require('./emoji');
const { resolveAuthority: resolveQpAuthority, isAssistantDirectorPlus } = require('./iaAuthority');
const quotaApi = require('./quota');

function buildQuotaCommand() {
  return new QpSlashCommandBuilder()
    .setName('qp')
    .setDescription('View your IA quota or manage quota points')
    .addUserOption(o => o.setName('member').setDescription('Member to view or manage'))
    .addStringOption(o => o.setName('action').setDescription('Management action')
      .addChoices(
        { name: 'Add points', value: 'ADD' },
        { name: 'Remove points', value: 'REMOVE' },
        { name: 'Set total points', value: 'SET' },
      ))
    .addIntegerOption(o => o.setName('points').setDescription('Points to add, remove, or set')
      .setMinValue(0).setMaxValue(10000))
    .addStringOption(o => o.setName('reason').setDescription('Reason for the adjustment').setMaxLength(500))
    .toJSON();
}

function quotaProgressEmbed(member, viewer, actionNote) {
  const q = member.quota || {};
  const total = Number(member.total) || 0;
  const target = q.target == null ? null : Number(q.target);
  const exempt = !!q.exempt;
  const remaining = exempt || target == null ? 0 : Math.max(0, target - total);
  const ratio = target > 0 ? Math.min(1, total / target) : (exempt ? 1 : 0);
  const filled = Math.round(ratio * 12);
  const meter = target == null ? 'Quota target unavailable'
    : exempt ? 'Exempt from weekly quota'
    : `${'█'.repeat(filled)}${'░'.repeat(12 - filled)}  ${Math.round(ratio * 100)}%`;
  const embed = new QpEmbedBuilder()
    .setColor(exempt || (target != null && total >= target) ? 0x2ed896 : 0x4a8fff)
    .setTitle('INTERNAL AFFAIRS | QUOTA')
    .setDescription(`**${member.username || viewer.username}**${member.rank ? ` · ${member.rank}` : ''}\n\n**${total} QP**${target == null ? '' : ` / ${target} QP`}\n${meter}`)
    .addFields(
      { name: 'Remaining', value: exempt ? 'Exempt' : target == null ? 'N/A' : `**${remaining} QP**`, inline: true },
      { name: 'Status', value: exempt ? (member.exemptKind || 'Exempt') : target == null ? 'No target' : total >= target ? 'Quota met' : 'In progress', inline: true },
      { name: 'Tier', value: q.tier || 'Unranked', inline: true },
    )
    .setFooter({ text: 'Internal Affairs · weekly quota' })
    .setTimestamp();
  if (actionNote) embed.addFields({ name: 'Adjustment', value: actionNote, inline: false });
  return embed;
}

async function findQuotaMember(user, interaction) {
  const roblox = require('./roblox');
  let robloxUsername = null;
  try {
    const robloxId = await roblox.getRobloxIdFromDiscord(user.id);
    if (robloxId) {
      const info = await roblox.getRobloxUserInfo(robloxId);
      robloxUsername = info && (info.name || info.username || info.displayName) || null;
    }
  } catch (err) { /* try the quota roster by Discord ID */ }

  const members = await quotaApi.getAllMembersPoints('IA');
  if (members == null) throw new Error('The IA quota sheet could not be read. Check the sheet connection and try again.');
  const id = String(user.id);
  const row = members.find(m => String(m.discordId || '').replace(/\D/g, '') === id.replace(/\D/g, ''))
    || (robloxUsername ? members.find(m => String(m.username || '').toLowerCase() === robloxUsername.toLowerCase()) : null);
  if (!row) throw new Error(robloxUsername
    ? `No IA quota row was found for ${robloxUsername}. Check that their Discord ID or Roblox username is on the IA quota sheet.`
    : 'No IA quota row was found for this Discord account. Link the Roblox account and add the member to the IA quota sheet.');
  return row;
}

async function handleQuotaCommand(interaction) {
  const action = interaction.options.getString('action');
  const points = interaction.options.getInteger('points');
  const reason = interaction.options.getString('reason');
  const targetUser = interaction.options.getUser('member') || interaction.user;
  const changing = !!action;

  await interaction.deferReply(changing ? { flags: QpMessageFlags.Ephemeral } : {});
  const loader = startQpLoading(interaction, changing ? 'Checking IA authority' : 'Reading your IA quota');

  try {
    let auth = null;
    if (changing) {
      auth = await resolveQpAuthority(interaction);
      if (!auth.ok || !isAssistantDirectorPlus(auth)) {
        loader.stop();
        return interaction.editReply({
          embeds: [new QpEmbedBuilder().setColor(0xf04f5e)
            .setTitle('Access Denied')
            .setDescription(auth.why || 'Only IA Assistant Director and above can add, remove, or set quota points.')],
        });
      }
      if (points == null || !reason || !reason.trim()) {
        loader.stop();
        return interaction.editReply({
          embeds: [new QpEmbedBuilder().setColor(0xf04f5e)
            .setTitle('Missing details')
            .setDescription('Choose an action, enter the points value, and provide a reason.')],
        });
      }
      if ((action === 'ADD' || action === 'REMOVE') && points < 1) {
        loader.stop();
        return interaction.editReply('Add and remove require at least 1 point. Use Set total to set a member to 0.');
      }
    } else if (points != null || reason) {
      loader.stop();
      return interaction.editReply('Choose an action before entering points or a reason.');
    }

    loader.update('Looking up the IA quota record');
    const member = await findQuotaMember(targetUser, interaction);
    const total = Number(member.total) || 0;
    let note = null;

    if (changing) {
      if (member.quota && member.quota.exempt) {
        loader.stop();
        return interaction.editReply('This member is exempt from weekly quota, so their points cannot be adjusted.');
      }
      const delta = action === 'ADD' ? points : action === 'REMOVE' ? -points : points - total;
      if (delta !== 0) {
        loader.update('Queueing the quota adjustment');
        const queued = await quotaApi.enqueueQuotaAward({
          refType: 'manual',
          refId: `qp:${interaction.id}`,
          discordId: member.discordId || targetUser.id,
          robloxUsername: member.username,
          points: delta,
          division: 'IA',
          label: `/qp ${action.toLowerCase()} by ${interaction.user.username}: ${reason.trim()}`.slice(0, 180),
        });
        if (!queued) throw new Error('The quota adjustment could not be queued. No points were changed.');
        note = `${action === 'SET' ? `Set total to ${points} QP` : `${delta > 0 ? '+' : ''}${delta} QP`} for <@${targetUser.id}>. Reason: ${reason.trim()}`;
        await require('./actionJournal').record({
          kind: 'QUOTA_ADJUST',
          actorId: interaction.user.id,
          actorName: interaction.member?.displayName || interaction.user.username,
          targetType: 'quota',
          targetId: targetUser.id,
          summary: `${delta > 0 ? '+' : ''}${delta} QP for ${member.username}`,
          payload: { discordId: targetUser.id, robloxUsername: member.username, points: delta, action, reason: reason.trim() },
        }).catch(() => {});
        loader.update('Applying the adjustment and refreshing the leaderboard');
        await quotaApi.processQuotaAwards().catch(() => {});
      } else {
        note = `Already at ${total} QP. No adjustment was needed.`;
      }
    }

    loader.update('Refreshing the quota record');
    const refreshed = await findQuotaMember(targetUser, interaction);
    loader.stop();
    return interaction.editReply({
      content: '',
      embeds: [quotaProgressEmbed(refreshed, targetUser, note)],
    });
  } catch (err) {
    loader.stop();
    return interaction.editReply({
      embeds: [new QpEmbedBuilder().setColor(0xf04f5e)
        .setTitle('Quota lookup failed')
        .setDescription(String(err.message || err).slice(0, 1000))],
    }).catch(() => {});
  }
}

module.exports.buildQuotaCommand = buildQuotaCommand;
module.exports.handleQuotaCommand = handleQuotaCommand;
