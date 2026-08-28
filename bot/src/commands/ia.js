const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const prisma = require('../lib/db');
const { ACTION_NAMES, parseActions } = require('../lib/actions');
const { isIA, DENIED } = require('../lib/perms');
const { createCase, nextTicketRef } = require('../lib/discipline');
const { postCaseCard, postTicketCard } = require('../lib/reviewCard');

const TICKET_TYPES = ['GENERAL_SUPPORT', 'HICOMM', 'OFFICER_REPORT', 'APPEAL'];

const data = new SlashCommandBuilder()
  .setName('ia')
  .setDescription('Internal Affairs — file cases and log tickets')
  .addSubcommand(s => s.setName('case').setDescription('File a disciplinary case for review')
    .addStringOption(o => o.setName('punishments')
      .setDescription('Comma-separated punishments').setRequired(true).setAutocomplete(true))
    .addStringOption(o => o.setName('reason').setDescription('Why this case is being filed').setRequired(true))
    .addUserOption(o => o.setName('subject').setDescription('The Discord member this case is against'))
    .addStringOption(o => o.setName('roblox').setDescription('The subject\'s Roblox username, if not in Discord'))
    .addIntegerOption(o => o.setName('duration').setDescription('Days, for timed punishments').setMinValue(1))
    .addStringOption(o => o.setName('notes').setDescription('Extra notes'))
    .addStringOption(o => o.setName('evidence').setDescription('Evidence link')))
  .addSubcommand(s => s.setName('ticket').setDescription('Log a resolved ticket for review')
    .addStringOption(o => o.setName('roblox').setDescription('The Roblox username the ticket concerns').setRequired(true))
    .addStringOption(o => o.setName('type').setDescription('Ticket type').setRequired(true)
      .addChoices(...TICKET_TYPES.map(t => ({ name: t, value: t }))))
    .addStringOption(o => o.setName('conclusion').setDescription('How it was resolved').setRequired(true))
    .addStringOption(o => o.setName('submitted_at').setDescription('When it was submitted').setRequired(true))
    .addStringOption(o => o.setName('timezone').setDescription('Timezone of that time').setRequired(true))
    .addStringOption(o => o.setName('transcript').setDescription('Transcript link'))
    .addAttachmentOption(o => o.setName('proof1').setDescription('Proof image'))
    .addAttachmentOption(o => o.setName('proof2').setDescription('Proof image'))
    .addAttachmentOption(o => o.setName('proof3').setDescription('Proof image')));

async function autocomplete(interaction) {
  const typed  = interaction.options.getFocused();
  const parts  = typed.split(',');
  const prefix = parts.slice(0, -1).join(',');
  const last   = (parts.at(-1) || '').trim().toLowerCase();
  await interaction.respond(
    ACTION_NAMES.filter(a => a.toLowerCase().includes(last))
      .map(a => {
        const v = (prefix ? `${prefix.trim()}, ${a}` : a).slice(0, 100);
        return { name: v, value: v };
      })
      .slice(0, 25),
  ).catch(() => {});
}

async function execute(interaction) {
  if (!isIA(interaction.member)) {
    return interaction.reply({ content: DENIED, flags: MessageFlags.Ephemeral });
  }
  const sub = interaction.options.getSubcommand();
  const filer = {
    displayName: interaction.member?.displayName || interaction.user.username,
    avatarURL: interaction.user.displayAvatarURL({ extension: 'png', size: 64 }),
  };

  if (sub === 'case') {
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

    const cardId = await postCaseCard(interaction.client, created, filer);
    if (cardId) await prisma.case.update({ where: { id: created.id }, data: { cardMessageId: cardId } }).catch(() => {});
    return interaction.editReply(cardId
      ? `✅ Filed case **${created.caseRef}** — posted to the cases channel for review.`
      : `✅ Filed case **${created.caseRef}**, but the review card could not be posted (check \`CASES_CHANNEL_ID\`).`);
  }

  if (sub === 'ticket') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const proof = ['proof1', 'proof2', 'proof3']
      .map(n => interaction.options.getAttachment(n))
      .filter(Boolean)
      .map(a => a.url);

    const ticketRef = await nextTicketRef();
    const created = await prisma.ticket.create({
      data: {
        ticketRef,
        filerDiscordId: interaction.user.id,
        robloxUsername: interaction.options.getString('roblox').trim(),
        ticketType:     interaction.options.getString('type'),
        conclusion:     interaction.options.getString('conclusion'),
        submittedAt:    interaction.options.getString('submitted_at'),
        timezone:       interaction.options.getString('timezone'),
        transcriptLink: interaction.options.getString('transcript') || null,
        proofImages:    proof.length ? proof : undefined,
        status: 'PENDING',
      },
    });

    const cardId = await postTicketCard(interaction.client, created, filer);
    if (cardId) await prisma.ticket.update({ where: { id: created.id }, data: { cardMessageId: cardId } }).catch(() => {});
    return interaction.editReply(cardId
      ? `✅ Logged ticket **${ticketRef}** — posted to the tickets channel for review.`
      : `✅ Logged ticket **${ticketRef}**, but the review card could not be posted (check \`TICKETS_CHANNEL_ID\`).`);
  }
}

module.exports = { scope: 'ia', data, execute, autocomplete };
