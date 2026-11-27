// server/lib/submitCaseCommand.js
// Private, interactive IA case builder. /case takes only a Roblox username;
// all remaining fields are collected in an ephemeral Discord panel + modal.
const {
  SlashCommandBuilder, MessageFlags, EmbedBuilder, ActionRowBuilder,
  StringSelectMenuBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const prisma = require('./db');
const { e } = require('./emoji');
const { ACTION_NAMES, isTimed, roleIdForAction } = require('./actions');
const { generateCaseRef } = require('./caseRef');
const { HICOMM_ONLY_ACTIONS } = require('./iaRank');
const { resolveAuthority, canView } = require('./iaAuthority');
const cards = require('./iaReviewCards');
const roblox = require('./roblox');

const COLOUR = 0x26384d;
const TIMED = ACTION_NAMES.filter(isTimed);
const ACTION_META = {
  'Written Warning': 'AUTO-ROLE · Permanent',
  'Zero Tolerance': 'AUTO-ROLE · Permanent or timed',
  'Suspension': 'AUTO-ROLE · Permanent or timed',
  'Activity Strike': 'AUTO-ROLE · Permanent',
  'Disciplinary Strike 1': 'AUTO-ROLE · Permanent or timed',
  'Disciplinary Strike 2': 'AUTO-ROLE · Permanent or timed',
  'Demotion': 'NO ROLE · Rank demotion',
  'Termination': 'EXILE · MET and divisional groups',
  'Blacklist': 'EXILE + ROLE · Blacklist role',
};

function buildCommand() {
  return new SlashCommandBuilder()
    .setName('case')
    .setDescription('Open the private IA case builder')
    .addStringOption(o => o.setName('officer')
      .setDescription('Officer Roblox username')
      .setRequired(true)
      .setMaxLength(20))
    .toJSON();
}

function selectedNames(indexes) {
  return indexes.map(n => ACTION_NAMES[Number(n)]).filter(Boolean);
}
function encodeIndexes(names) {
  return names.map(name => ACTION_NAMES.indexOf(name)).filter(n => n >= 0).join('.');
}
function ownerCheck(interaction, ownerId) {
  return String(interaction.user.id) === String(ownerId);
}
function panelEmbed(username, selected) {
  const embed = new EmbedBuilder()
    .setColor(COLOUR)
    .setTitle('<:IA:1552764629204205619>  INTERNAL AFFAIRS  /  NEW CASE')
    .setDescription('**Case builder**\nChoose one or more punishments, then continue to the case details. This panel is private to you.')
    .addFields(
      { name: 'OFFICER', value: '`' + String(username).slice(0, 80) + '`', inline: true },
      { name: 'CASE NUMBER', value: 'Assigned automatically on submission', inline: true },
      { name: 'PUNISHMENTS SELECTED', value: selected.length ? selected.map(a => '• **' + a + '** — ' + ACTION_META[a]).join('\n').slice(0, 1024) : '*Choose one or more below*' },
      { name: 'PERMANENCE', value: 'Timed punishments can be made permanent by leaving the duration blank. A duration applies to all timed punishments selected.', inline: false },
    )
    .setFooter({ text: 'Metropolitan Police Service  ·  Internal Affairs' });
  return embed;
}
function panelComponents(ownerId, robloxId, username, selected) {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`casebuilder:pick:${ownerId}:${robloxId}`)
    .setPlaceholder('Select one or more punishments')
    .setMinValues(1)
    .setMaxValues(Math.max(1, ACTION_NAMES.length))
    .addOptions(ACTION_NAMES.map((name, index) => ({
      label: name,
      value: String(index),
      description: ACTION_META[name].slice(0, 100),
      default: selected.includes(name),
    })));
  const row = new ActionRowBuilder().addComponents(select);
  const continueButton = new ButtonBuilder()
    .setCustomId(`casebuilder:continue:${ownerId}:${robloxId}:${encodeIndexes(selected)}`)
    .setLabel('Continue to case details')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(!selected.length);
  const cancelButton = new ButtonBuilder()
    .setCustomId(`casebuilder:cancel:${ownerId}`)
    .setLabel('Cancel')
    .setStyle(ButtonStyle.Secondary);
  return [row, new ActionRowBuilder().addComponents(continueButton, cancelButton)];
}
function detailsModal(ownerId, robloxId, indexes) {
  const modal = new ModalBuilder()
    .setCustomId(`casebuilder:form:${ownerId}:${robloxId}:${indexes}`)
    .setTitle('Submit IA Case');
  const reason = new TextInputBuilder()
    .setCustomId('reason').setLabel('Reason').setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('Explain the conduct and relevant circumstances')
    .setRequired(true).setMaxLength(4000);
  const link = new TextInputBuilder()
    .setCustomId('case_link').setLabel('Case link / evidence document')
    .setStyle(TextInputStyle.Short).setPlaceholder('https://...')
    .setRequired(true).setMaxLength(500);
  const notes = new TextInputBuilder()
    .setCustomId('notes').setLabel('Notes (optional)').setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('Additional context for reviewers')
    .setRequired(false).setMaxLength(1500);
  const duration = new TextInputBuilder()
    .setCustomId('duration').setLabel('Timed punishment durations (optional)')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('Suspension=14, Disciplinary Strike 1=30. Blank = Permanent.')
    .setRequired(false).setMaxLength(500);
  const blacklist = new TextInputBuilder()
    .setCustomId('blacklist_code').setLabel('Blacklist code (optional)')
    .setStyle(TextInputStyle.Short).setPlaceholder('Only used for a Blacklist')
    .setRequired(false).setMaxLength(80);
  modal.addComponents(
    new ActionRowBuilder().addComponents(reason),
    new ActionRowBuilder().addComponents(link),
    new ActionRowBuilder().addComponents(notes),
    new ActionRowBuilder().addComponents(duration),
    new ActionRowBuilder().addComponents(blacklist),
  );
  return modal;
}

async function handleSubmitCase(interaction) {
  const username = String(interaction.options.getString('officer') || '').trim();
  if (!username || /[\\s]/.test(username)) {
    return interaction.reply({ content: `${e('met_denied')} Enter one Roblox username without spaces.`, flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const auth = await resolveAuthority(interaction);
  const view = canView(auth);
  if (!view.allowed) return interaction.editReply(`${e('met_denied')} ${view.reason}`);
  if (!auth.userId) {
    return interaction.editReply(`${e('met_warn')} Sign in to the MET Dashboard once with Discord before filing a case. The case needs a filer account for its audit history.`);
  }

  const target = await roblox.getRobloxIdFromUsername(username);
  if (!target) return interaction.editReply(`${e('met_denied')} I couldn't find the Roblox username **${username}**. Check the spelling and try again.`);

  const info = await roblox.getRobloxUserInfo(target.id).catch(() => null);
  const canonicalName = (info && (info.name || info.username)) || target.username || username;
  await interaction.editReply({
    embeds: [panelEmbed(canonicalName, [])],
    components: panelComponents(interaction.user.id, target.id, canonicalName, []),
    content: null,
  });
}

async function handleComponent(interaction) {
  const parts = String(interaction.customId || '').split(':');
  const action = parts[1];
  const ownerId = parts[2];
  if (!ownerCheck(interaction, ownerId)) {
    return interaction.reply({ content: 'This private case builder belongs to another user.', flags: MessageFlags.Ephemeral });
  }
  if (action === 'cancel') {
    return interaction.update({ content: 'Case builder cancelled. No case was created.', embeds: [], components: [] });
  }
  if (action === 'pick') {
    const robloxId = parts[3];
    const selected = (interaction.values || []).map(String).filter(v => /^\d+$/.test(v)).map(v => ACTION_NAMES[Number(v)]).filter(Boolean);
    const member = await roblox.getRobloxUserInfo(robloxId).catch(() => null);
    const username = member && member.name ? member.name : 'Roblox user';
    return interaction.update({
      embeds: [panelEmbed(username, selected)],
      components: panelComponents(ownerId, robloxId, username, selected),
    });
  }
  if (action === 'continue') {
    const robloxId = parts[3];
    const indexes = parts[4] || '';
    const selected = selectedNames(indexes.split('.').filter(Boolean));
    if (!selected.length) return interaction.reply({ content: 'Choose at least one punishment first.', flags: MessageFlags.Ephemeral });
    return interaction.showModal(detailsModal(ownerId, robloxId, indexes));
  }
  if (action === 'form') return handleFormSubmit(interaction, ownerId, parts[3], parts[4] || '');
}

function parseDurations(raw, selected) {
  const out = {};
  const value = String(raw || '').trim();
  if (!value) return { durations: out, error: null };
  const selectedTimed = selected.filter(isTimed);
  if (/^\\d+$/.test(value)) {
    const days = Number(value);
    if (!Number.isInteger(days) || days < 1 || days > 3650) return { durations: {}, error: 'Duration must be 1–3650 days.' };
    for (const action of selectedTimed) out[action] = days;
    return { durations: out, error: null };
  }
  const entries = value.split(/[,;\\n]+/).map(x => x.trim()).filter(Boolean);
  for (const entry of entries) {
    const match = entry.match(/^(.+?)\\s*=\\s*(\\d+|permanent)$/i);
    if (!match) return { durations: {}, error: 'Use Action=days, for example Suspension=14. Use Permanent to keep an action permanent.' };
    const action = selected.find(name => name.toLowerCase() === match[1].trim().toLowerCase());
    if (!action || !isTimed(action)) return { durations: {}, error: `“${match[1]}” is not a selected timed punishment.` };
    if (/^permanent$/i.test(match[2])) { out[action] = null; continue; }
    const days = Number(match[2]);
    if (!Number.isInteger(days) || days < 1 || days > 3650) return { durations: {}, error: 'Each duration must be 1–3650 days or Permanent.' };
    out[action] = days;
  }
  return { durations: out, error: null };
}

async function handleFormSubmit(interaction, ownerId, robloxId, indexes) {
  if (!ownerCheck(interaction, ownerId)) {
    return interaction.reply({ content: 'This private case builder belongs to another user.', flags: MessageFlags.Ephemeral });
  }
  const actions = selectedNames(indexes.split('.').filter(Boolean));
  if (!actions.length) return interaction.reply({ content: 'No punishments were selected. Start /case again.', flags: MessageFlags.Ephemeral });
  const reason = interaction.fields.getTextInputValue('reason').trim();
  const caseLink = interaction.fields.getTextInputValue('case_link').trim();
  const notes = interaction.fields.getTextInputValue('notes').trim();
  const durationRaw = interaction.fields.getTextInputValue('duration').trim();
  const blacklistCode = interaction.fields.getTextInputValue('blacklist_code').trim();
  if (!/^https?:\/\//i.test(caseLink)) {
    return interaction.reply({ content: `${e('met_denied')} The case link must be a valid http(s) link.`, flags: MessageFlags.Ephemeral });
  }
  const durationResult = parseDurations(durationRaw, actions);
  if (durationResult.error) {
    return interaction.reply({ content: `${e('met_denied')} ${durationResult.error}`, flags: MessageFlags.Ephemeral });
  }
  const durations = durationResult.durations;
  if (actions.includes('Blacklist') && blacklistCode.length > 80) {
    return interaction.reply({ content: `${e('met_denied')} The blacklist code is too long.`, flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const auth = await resolveAuthority(interaction);
  const view = canView(auth);
  if (!view.allowed) return interaction.editReply(`${e('met_denied')} ${view.reason}`);
  if (!auth.userId) return interaction.editReply(`${e('met_warn')} Sign in to the MET Dashboard once with Discord before filing a case.`);

  const targetInfo = await roblox.getRobloxUserInfo(robloxId).catch(() => null);
  const robloxUsername = targetInfo && (targetInfo.name || targetInfo.username);
  if (!robloxUsername) return interaction.editReply(`${e('met_denied')} The officer's Roblox account could not be re-verified. Please start /case again.`);
  const linked = await prisma.user.findFirst({
    where: { robloxId: String(robloxId) },
    select: { discordId: true },
  }).catch(() => null);
  const enriched = actions.map(action => ({
    action,
    roleId: roleIdForAction(action),
    durationDays: isTimed(action) ? (durations[action] || null) : null,
    ...(action === 'Blacklist' && blacklistCode ? { code: blacklistCode } : {}),
  }));
  const caseRef = await generateCaseRef();
  let created;
  try {
    created = await prisma.case.create({
      data: {
        caseRef,
        userId: auth.userId,
        officerDiscordId: linked ? String(linked.discordId) : null,
        robloxUserId: String(robloxId),
        robloxUsername,
        action: actions.join(', '),
        actions: enriched,
        reason,
        notes: notes || 'N/A',
        caseLink,
        investigatorDiscordUsername: interaction.user.username,
        status: 'PENDING',
      },
    });
  } catch (err) {
    console.error('[IA] case create failed:', err.message);
    return interaction.editReply(`${e('met_cross')} Could not file the case. No review card was posted; check the MET database connection.`);
  }

  await prisma.caseAction.create({
    data: { caseId: created.id, actionType: 'CREATED', performedBy: auth.userId, notes: 'Submitted via private /case builder' },
  }).catch(err => console.warn('[IA] case action audit failed:', err.message));

  let messageId = null;
  try {
    const filer = interaction.member || interaction.user;
    const avatar = await roblox.getRobloxAvatarHeadshot(robloxId).catch(() => null);
    messageId = await cards.postCaseCard(interaction.client, created, { filer, subjectAvatar: avatar });
    if (messageId) await prisma.case.update({ where: { id: created.id }, data: { cardMessageId: messageId } }).catch(() => {});
  } catch (err) {
    console.warn('[IA] case review card not posted:', err.message);
  }

  const needsAdir = enriched.some(item => HICOMM_ONLY_ACTIONS.includes(item.action));
  const gate = needsAdir ? 'Assistant Director and above' : 'Supervisor and above';
  if (!messageId) {
    return interaction.editReply(`${e('met_warn')} Case **${created.caseRef}** was recorded, but its review card could not be posted. It remains on the dashboard for review.`);
  }
  return interaction.editReply({
    content: `${e('met_tick')} Case **${created.caseRef}** has been submitted for review. ${gate} may decide this case.`,
    embeds: [new EmbedBuilder().setColor(COLOUR).setTitle(`IA CASE  ${created.caseRef}`)
      .setDescription(`**Officer**  ${robloxUsername}\n**Punishments**\n${actions.map(a => `• ${a}${isTimed(a) ? (durationDays ? ` · ${durationDays} days` : ' · Permanent') : ''}`).join('\n')}\n\n**Reason**\n${reason.slice(0, 900)}`)
      .addFields({ name: 'Case link', value: caseLink.slice(0, 1024) })
      .setFooter({ text: 'Metropolitan Police Service  ·  Internal Affairs' })],
    components: [],
  });
}

module.exports = { buildCommand, handleSubmitCase, handleComponent };
