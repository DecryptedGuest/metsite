const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const prisma = require('../lib/db');
const { ACTION_NAMES, parseActions, caseHasHicommOnlyPunishment } = require('../lib/actions');
const { isIA, isSupervisor, isHicomm, DENIED } = require('../lib/perms');
const { createCase, approveCase, denyCase } = require('../lib/discipline');
const { postCaseCard } = require('../lib/reviewCard');

const data = new SlashCommandBuilder()
  .setName('discipline')
  .setDescription('File and review disciplinary cases')
  .addSubcommand(s => s.setName('file').setDescription('File a disciplinary case')
    .addStringOption(o => o.setName('punishments')
      .setDescription('Comma-separated punishments').setRequired(true).setAutocomplete(true))
    .addStringOption(o => o.setName('reason').setDescription('Why this case is being filed').setRequired(true))
    .addUserOption(o => o.setName('subject').setDescription('The Discord member this case is against'))
    .addStringOption(o => o.setName('roblox').setDescription('The subject\'s Roblox username, if not in Discord'))
    .addIntegerOption(o => o.setName('duration').setDescription('Days, for timed punishments').setMinValue(1))
    .addStringOption(o => o.setName('notes').setDescription('Extra notes'))
    .addStringOption(o => o.setName('evidence').setDescription('Evidence link')))
  .addSubcommand(s => s.setName('approve').setDescription('Approve a pending case')
    .addStringOption(o => o.setName('ref').setDescription('Case ref, e.g. #12').setRequired(true)))
  .addSubcommand(s => s.setName('deny').setDescription('Deny a pending case')
    .addStringOption(o => o.setName('ref').setDescription('Case ref, e.g. #12').setRequired(true))
    .addStringOption(o => o.setName('note').setDescription('Why it was denied')))
  .addSubcommand(s => s.setName('lookup').setDescription("Show a member's case history")
    .addUserOption(o => o.setName('user').setDescription('The member').setRequired(true)));

async function autocomplete(interaction) {
  const typed = interaction.options.getFocused();
  // Autocomplete the last item of a comma-separated list, keeping the prefix.
  const parts  = typed.split(',');
  const prefix = parts.slice(0, -1).join(',');
  const last   = (parts.at(-1) || '').trim().toLowerCase();
  const choices = ACTION_NAMES
    .filter(a => a.toLowerCase().includes(last))
    .map(a => {
      const value = prefix ? `${prefix.trim()}, ${a}` : a;
      return { name: value.slice(0, 100), value: value.slice(0, 100) };
    })
    .slice(0, 25);
  await interaction.respond(choices).catch(() => {});
}

/** Cases are looked up by "#12" or bare "12". */
function normaliseRef(raw) {
  const t = String(raw || '').trim();
  return t.startsWith('#') ? t : `#${t.replace(/^#/, '')}`;
}

async function execute(interaction, bot) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'file') {
    if (!isIA(interaction.member)) {
      return interaction.reply({ content: DENIED, flags: MessageFlags.Ephemeral });
    }
    const subject = interaction.options.getUser('subject');
    const roblox  = interaction.options.getString('roblox');
    if (!subject && !roblox) {
      return interaction.reply({ content: '❌ Give either a `subject` or a `roblox` username.', flags: MessageFlags.Ephemeral });
    }

    const { actions, invalid } = parseActions(interaction.options.getString('punishments'));
    if (invalid.length) {
      return interaction.reply({ content: `❌ Invalid action: ${invalid[0]}`, flags: MessageFlags.Ephemeral });
    }
    if (!actions.length) {
      return interaction.reply({ content: '❌ Pick at least one punishment.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const created = await createCase({
      submitterDiscordId: interaction.user.id,
      subjectDiscordId: subject?.id || null,
      subjectRobloxUsername: roblox || null,
      actions,
      reason: interaction.options.getString('reason'),
      notes: interaction.options.getString('notes'),
      evidence: interaction.options.getString('evidence'),
      durationDays: interaction.options.getInteger('duration'),
    });

    const cardId = await postCaseCard(interaction.client, created, {
      displayName: interaction.member?.displayName || interaction.user.username,
      avatarURL: interaction.user.displayAvatarURL({ extension: 'png', size: 64 }),
    });
    if (cardId) await prisma.case.update({ where: { id: created.id }, data: { cardMessageId: cardId } }).catch(() => {});

    return interaction.editReply(`✅ Filed case **${created.caseRef}** — awaiting review.`);
  }

  if (sub === 'approve' || sub === 'deny') {
    if (!isSupervisor(interaction.member)) {
      return interaction.reply({ content: DENIED, flags: MessageFlags.Ephemeral });
    }
    const ref = normaliseRef(interaction.options.getString('ref'));
    const c = await prisma.case.findUnique({ where: { caseRef: ref } });
    if (!c) return interaction.reply({ content: `❌ No case ${ref}.`, flags: MessageFlags.Ephemeral });
    if (c.submitterDiscordId === interaction.user.id) {
      return interaction.reply({ content: '❌ You cannot review your own submission.', flags: MessageFlags.Ephemeral });
    }
    if (sub === 'approve' && !isHicomm(interaction.member) && caseHasHicommOnlyPunishment(c.actions || [])) {
      return interaction.reply({
        content: 'Only HICOMM can approve a case involving a Blacklist or Termination.',
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = sub === 'approve'
      ? await approveCase(c.id, interaction.user.id, bot)
      : await denyCase(c.id, interaction.user.id, interaction.options.getString('note'));
    if (!result.ok) return interaction.editReply(`❌ ${result.error}`);
    return interaction.editReply(`✅ Case ${ref} ${sub === 'approve' ? 'approved' : 'denied'}.`);
  }

  if (sub === 'lookup') {
    if (!isIA(interaction.member)) {
      return interaction.reply({ content: DENIED, flags: MessageFlags.Ephemeral });
    }
    const user = interaction.options.getUser('user');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const cases = await prisma.case.findMany({
      where: { officerDiscordId: user.id },
      include: { casePunishments: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!cases.length) return interaction.editReply(`No cases on record for ${user}.`);

    const approved = cases.filter(c => c.status === 'APPROVED');
    const other    = cases.filter(c => c.status !== 'APPROVED');
    const now = new Date();
    const activeLines = [];
    for (const c of approved) {
      for (const p of c.casePunishments) {
        const active = !p.roleRemoved && (!p.expiresAt || p.expiresAt > now);
        if (active) {
          activeLines.push(`• ${p.action}${p.expiresAt ? ` — until <t:${Math.floor(p.expiresAt / 1000)}:R>` : ' — permanent'}`);
        }
      }
    }

    const embed = new EmbedBuilder()
      .setColor(0x2f3136)
      .setTitle(`Case history — ${user.tag}`)
      .addFields(
        { name: `Approved (${approved.length})`,
          value: approved.length ? approved.map(c => `${c.caseRef} · ${c.action}`).join('\n').slice(0, 1000) : '*None*' },
        { name: 'Currently active punishments',
          value: activeLines.length ? activeLines.join('\n').slice(0, 1000) : '*None*' },
        { name: `Pending / denied (${other.length})`,
          value: other.length ? other.map(c => `${c.caseRef} · ${c.status}`).join('\n').slice(0, 1000) : '*None*' },
      )
      .setFooter({ text: 'Only approved cases count toward the record' });
    return interaction.editReply({ embeds: [embed] });
  }
}

module.exports = { data, execute, autocomplete };
