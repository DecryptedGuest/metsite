// server/lib/undoCommand.js
// /undo — reverse something you just did.
//
// Deliberately scoped to YOUR OWN recent actions. An undo that can reach
// anyone's work is not an undo, it is an override, and it needs a different
// conversation about who may use it.
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder,
        StringSelectMenuBuilder, MessageFlags } = require('discord.js');
const journal = require('./actionJournal');

function buildCommand() {
  return new SlashCommandBuilder()
    .setName('undo')
    .setDescription('Reverse one of your recent actions')
    .toJSON();
}

const when = (d) => `<t:${Math.floor(new Date(d).getTime() / 1000)}:R>`;

async function handleUndo(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const entries = await journal.recent(interaction.user.id, { limit: 10 });
  if (!entries.length) {
    return interaction.editReply(
      `Nothing to undo. Only your own actions from the last ${journal.WINDOW_HOURS()} hours can be reversed.`);
  }

  const embed = new EmbedBuilder()
    .setColor(0x4a8fff)
    .setTitle('Undo')
    .setDescription(entries.map((e, i) =>
      `**${i + 1}.** ${e.summary || e.action} · ${when(e.createdAt)}`).join('\n'))
    .setFooter({ text: `Your actions from the last ${journal.WINDOW_HOURS()} hours` });

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`undo:pick:${interaction.user.id}`)
    .setPlaceholder('Choose what to reverse')
    .addOptions(entries.map((e, i) => ({
      label: `${i + 1}. ${(e.summary || e.action).slice(0, 90)}`,
      // Say what reversing it actually does BEFORE it is chosen, not after.
      description: (journal.KINDS[e.action]?.reversal || 'reverses this action').slice(0, 100),
      value: e.id,
    })));

  return interaction.editReply({
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(menu)],
  });
}

async function handleUndoComponent(interaction) {
  const [, , ownerId] = String(interaction.customId || '').split(':');
  if (ownerId && interaction.user.id !== ownerId) {
    return interaction.reply({ content: '⛔ That menu is not yours.', flags: MessageFlags.Ephemeral });
  }

  await interaction.deferUpdate();
  const entryId = interaction.values && interaction.values[0];
  if (!entryId) return;

  const prisma = require('./db');
  const entry = await prisma.auditLog.findUnique({ where: { id: entryId } }).catch(() => null);
  if (!entry) {
    return interaction.editReply({ content: 'That entry is gone.', embeds: [], components: [] });
  }
  // Re-check ownership against the record, not just the menu: a stale message
  // could otherwise be reused by whoever can see it.
  if (entry.actorId !== interaction.user.id) {
    return interaction.editReply({ content: '⛔ You can only undo your own actions.', embeds: [], components: [] });
  }

  const actor = {
    id: interaction.user.id,
    displayName: interaction.member?.displayName || interaction.user.username,
  };

  const result = await journal.undo(entry, actor);
  if (!result.ok) {
    return interaction.editReply({
      content: `Could not undo that: ${result.error}`, embeds: [], components: [],
    });
  }
  await journal.markUndone(entry.id, actor.displayName);

  const done = new EmbedBuilder()
    .setColor(0x2ed896)
    .setTitle('Undone')
    .setDescription(`**${entry.summary || entry.action}**`)
    .addFields({ name: 'What changed', value: result.notes.map(n => `› ${n}`).join('\n') || '—' })
    .setFooter({ text: `Reversed by ${actor.displayName}` })
    .setTimestamp();

  return interaction.editReply({ content: '', embeds: [done], components: [] });
}

module.exports = { buildCommand, handleUndo, handleUndoComponent };
