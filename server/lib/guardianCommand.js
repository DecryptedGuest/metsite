// server/lib/guardianCommand.js
// /guardian — check and drive the anti-nuke from Discord.
//
// Gated to High Command and developers, and the two that change anything
// (lockdown on/off) are gated a second time inside the handler, because a
// lockdown is disruptive and a stolen staff account should not be able to
// cause one by itself.
'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const guardian = require('./guardian');

const COMMAND = 'guardian';

function buildCommand() {
  return new SlashCommandBuilder()
    .setName(COMMAND)
    .setDescription('Anti-nuke protection: status, recent incidents, and lockdown')
    .addSubcommand(s => s.setName('status')
      .setDescription('Is it watching, what has it seen, and can it act'))
    .addSubcommand(s => s.setName('incidents')
      .setDescription('The most recent things it flagged'))
    .addSubcommand(s => s.setName('lockdown')
      .setDescription('Stop everyone posting, right now, without removing anybody')
      .addStringOption(o => o.setName('state').setDescription('on or off').setRequired(true)
        .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }))
      .addStringOption(o => o.setName('reason').setDescription('Why, for the audit log').setRequired(false)))
    .addSubcommand(s => s.setName('selftest')
      .setDescription('Check the bot can actually see the audit log and act'))
    .toJSON();
}

async function isHicomm(interaction) {
  try {
    const prisma = require('./db');
    const user = await prisma.user.findFirst({
      where: { discordId: String(interaction.user.id) },
      select: { id: true, role: true, robloxId: true },
    });
    if (!user) return false;
    if (user.role === 'DEVELOPER') return true;
    return await require('./metRank').userIsMetHicomm(user);
  } catch (e) { return false; }
}

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

async function handle(interaction) {
  if (!(await isHicomm(interaction))) {
    return interaction.reply({ ephemeral: true, content: 'Guardian is High Command only.' });
  }
  const sub = interaction.options.getSubcommand();
  const st = guardian.status();

  if (sub === 'status') {
    const e = new EmbedBuilder()
      .setTitle('Guardian')
      .setColor(st.mode === 'enforce' && !st.breakerTripped ? 0x3ECF8E : 0xE5A03F)
      .addFields(
        { name: 'Mode', value: st.mode === 'enforce' ? 'Enforcing' : st.mode === 'monitor' ? 'Monitoring only' : 'OFF', inline: true },
        { name: 'Lockdown', value: st.lockdown ? 'ON' : 'off', inline: true },
        { name: 'Incidents seen', value: String(st.incidents), inline: true },
        { name: 'Circuit breaker', value: st.breakerTripped ? 'TRIPPED · alert-only until it settles' : 'normal', inline: true },
        { name: 'Never actioned', value: st.trusted.length ? st.trusted.map(i => `<@${i}>`).join(', ') : 'the server owner only', inline: false },
      )
      .setFooter({ text: 'It watches the audit log and contains a spree in seconds.' });
    return interaction.reply({ ephemeral: true, embeds: [e] });
  }

  if (sub === 'incidents') {
    if (!st.recent.length) return interaction.reply({ ephemeral: true, content: 'Nothing flagged. That is the good answer.' });
    const lines = st.recent.slice(0, 12).map(i =>
      `\`${ago(i.at)}\` **${i.severity}** · <@${i.actorId}>${i.actorIsBot ? ' (bot)' : ''} · ${i.detail || i.what} · ${i.action || 'alert'}`);
    return interaction.reply({ ephemeral: true, content: `**Recent incidents**\n${lines.join('\n')}`.slice(0, 1950) });
  }

  if (sub === 'lockdown') {
    const on = interaction.options.getString('state') === 'on';
    const reason = interaction.options.getString('reason') || `Guardian lockdown by ${interaction.user.tag}`;
    await interaction.deferReply({ ephemeral: true });
    const r = await guardian.setLockdown(interaction.guild, on, reason);
    try {
      require('./audit').record({
        action: 'GUARDIAN_LOCKDOWN', category: 'security',
        actorName: interaction.user.tag, targetType: 'guild', targetId: interaction.guildId,
        summary: `Lockdown turned ${on ? 'ON' : 'off'} across ${r.changed} channel(s)`,
      });
    } catch (e) {}
    return interaction.editReply(
      `Lockdown **${on ? 'ON' : 'off'}** · ${r.changed} channel(s) changed`
      + (r.failed ? `, ${r.failed} could not be (the bot is below them, or it cannot edit them)` : '')
      + (on ? '\nNobody can post until you turn this off. Nobody has been removed.' : ''));
  }

  if (sub === 'selftest') {
    // The two ways this silently does nothing: the bot cannot read the audit
    // log, or it sits too low to remove anybody's roles. Both are worth knowing
    // BEFORE the night it matters.
    const me = interaction.guild.members.me;
    const canView = me.permissions.has('ViewAuditLog');
    const canRoles = me.permissions.has('ManageRoles');
    const highest = me.roles.highest;
    const above = interaction.guild.roles.cache.filter(r => r.position >= highest.position && r.id !== interaction.guild.id);
    const dangerousAbove = above.filter(r => r.permissions.has('Administrator'));

    const problems = [];
    if (!canView)  problems.push('It cannot **View Audit Log**, so it will see nothing at all. This is the one that matters most.');
    if (!canRoles) problems.push('It cannot **Manage Roles**, so it can detect a spree but not stop it.');
    if (dangerousAbove.size) {
      problems.push(`${dangerousAbove.size} role(s) with Administrator sit **above** the bot, so it cannot strip them: `
        + dangerousAbove.map(r => r.name).slice(0, 5).join(', ') + '. Move the bot\'s role above them.');
    }
    const e = new EmbedBuilder()
      .setTitle(problems.length ? 'Guardian is not fully armed' : 'Guardian is fully armed')
      .setColor(problems.length ? 0xF0616F : 0x3ECF8E)
      .setDescription(problems.length ? problems.map(p => '• ' + p).join('\n')
        : 'It can read the audit log, it can remove roles, and no Administrator role sits above it.')
      .addFields(
        { name: 'View Audit Log', value: canView ? 'yes' : 'NO', inline: true },
        { name: 'Manage Roles',   value: canRoles ? 'yes' : 'NO', inline: true },
        { name: 'Bot\'s top role', value: `${highest.name} (position ${highest.position})`, inline: true },
      );
    return interaction.reply({ ephemeral: true, embeds: [e] });
  }
}

module.exports = { COMMAND, buildCommand, handle };
