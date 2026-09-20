// server/lib/exileCommand.js
// /exile — immediate MET termination, wired through the same discipline engine
// used by /infract so the Roblox action, Discord punishment, dashboard case,
// administrative log and officer notice stay in one audit trail.

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { e } = require('./emoji');

const SAS_HIGH_COMMAND_ROLE = '1507077818251743373';

function buildCommand() {
  return new SlashCommandBuilder()
    .setName('exile')
    .setDescription('Exile a person from the MET Roblox group and record the punishment')
    .addUserOption(o => o.setName('officer').setDescription('The Discord member to exile').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason for the exile').setRequired(true).setMaxLength(900));
}

function roleIdsOf(interaction) {
  const roles = interaction.member && interaction.member.roles;
  if (roles && roles.cache) return [...roles.cache.keys()].map(String);
  if (Array.isArray(roles)) return roles.map(String);
  return [];
}

async function mayExile(interaction) {
  const roleIds = roleIdsOf(interaction);
  if (roleIds.includes(SAS_HIGH_COMMAND_ROLE)) return { ok: true, label: 'SAS High Command' };
  try {
    const { canDiscipline } = require('./disciplineAccess');
    const verdict = await canDiscipline(String(interaction.user.id), roleIds);
    if (verdict && verdict.ok && verdict.isMetHicomm) return { ok: true, label: verdict.label || 'MET High Command' };
  } catch (err) { console.error('[/exile] access check failed:', err.message); }
  return { ok: false, why: 'Only MET High Command and SAS High Command can use /exile.' };
}

async function handleExileCommand(interaction) {
  const access = await mayExile(interaction);
  if (!access.ok) return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xf04f5e).setTitle(e('met_denied') + ' Not for you').setDescription(access.why)], flags: 64 });
  const target = interaction.options.getUser('officer');
  const reason = String(interaction.options.getString('reason') || '').trim();
  if (!target || !reason) return interaction.reply({ content: e('met_warn') + ' A target and reason are required.', flags: 64 });
  await interaction.deferReply({ flags: 64 });
  try {
    const R = require('./roblox');
    const robloxId = await R.getRobloxIdFromDiscord(String(target.id));
    if (!robloxId) return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xf5b730).setTitle(e('met_warn') + ' No Roblox account linked').setDescription('<@' + target.id + '> does not have a Roblox account linked to Discord. Verify them with RoVer and run `/exile` again.\n\nNothing was changed.')] });
    const membership = await R.getGroupMembership(String(robloxId));
    if (!membership || !membership.role || Number(membership.role.rank) <= 0) return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xf5b730).setTitle(e('met_warn') + ' Not in the MET group').setDescription('Roblox account **' + target.username + '** is not currently in the MET group. Nothing was changed.')] });
    const info = await R.getRobloxUserInfo(String(robloxId));
    const issuerName = (interaction.member && interaction.member.displayName) || interaction.user.globalName || interaction.user.username;
    const D = require('./discipline');
    const result = await D.applyDiscipline({
      action: 'Termination', targetDiscordId: String(target.id), targetRobloxId: String(robloxId),
      targetName: (info && info.username) || target.username, issuerDiscordId: String(interaction.user.id),
      issuerName, issuerUsername: interaction.user.username, reason, notes: 'Issued with /exile.', signedBy: issuerName, onStep: async () => {},
    });
    const colour = result.ok ? 0x2ed896 : (result.caseRef ? 0xf5b730 : 0xf04f5e);
    const embed = new EmbedBuilder().setColor(colour)
      .setTitle((result.ok ? e('met_tick') : e('met_warn')) + ' ' + (result.ok ? 'Exile completed' : 'Exile completed with warnings'))
      .setDescription('**' + ((info && info.username) || target.username) + '** was processed as a **Termination**.\n'
        + (result.caseRef ? 'Punishment record: **' + result.caseRef + '**' : 'A dashboard case could not be created.')
        + (result.warnings.length ? '\n\n' + result.warnings.map(w => '• ' + w).join('\n') : ''))
      .setFooter({ text: 'Issued by ' + issuerName }).setTimestamp(new Date());
    return interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error('[/exile] failed:', err);
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xf04f5e).setTitle(e('met_cross') + ' Exile failed').setDescription('Nothing was safely completed. ' + (err.message || 'Unknown error'))] });
  }
}

module.exports = { buildCommand, handleExileCommand, mayExile, SAS_HIGH_COMMAND_ROLE };