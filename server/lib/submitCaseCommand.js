// server/lib/submitCaseCommand.js
// Private, interactive IA case builder. /case takes only a Roblox username;
// all remaining fields are collected in an ephemeral Discord panel + modal.
const {
  SlashCommandBuilder, MessageFlags, EmbedBuilder, ActionRowBuilder,
  StringSelectMenuBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const prisma = require('./db');
const { e, startLoading } = require('./emoji');
const { ACTION_NAMES, roleIdForAction } = require('./actions');

const DURATION_ACTIONS = ['Zero Tolerance', 'Suspension'];
function needsDuration(action) { return DURATION_ACTIONS.includes(action); }
const { generateCaseRef } = require('./caseRef');
const { HICOMM_ONLY_ACTIONS } = require('./iaRank');
const { resolveAuthority, canView } = require('./iaAuthority');
const cards = require('./iaReviewCards');
const roblox = require('./roblox');

const COLOUR = 0x26384d;
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

function showTimedPanelNotice(message, notice) {
  // Give longer notices a little more reading time, with a five-second minimum.
  const seconds = Math.max(5, Math.min(10, Math.ceil(String(notice).length / 90) + 4));
  let remaining = seconds;
  const render = () => `⚠️ ${notice}\n\n_Clear in ${remaining}s_`;
  message.edit({ content: render() }).catch(() => {});
  const timer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(timer);
      message.edit({ content: null }).catch(() => {});
      return;
    }
    message.edit({ content: render() }).catch(() => {});
  }, 1000);
  timer.unref?.();
}
const CURRENT_PUNISHMENT_ACTIONS = [
  'Disciplinary Strike 1',
  'Disciplinary Strike 2',
  'Zero Tolerance',
  'Suspension',
  'Activity Strike',
];

function remainingLabel(expiresAt) {
  if (!expiresAt) return 'Permanent / no expiry recorded';
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return 'Expired';
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (days > 0) return `${days}d ${hours}h remaining`;
  if (hours > 0) return `${hours}h ${minutes}m remaining`;
  return `${Math.max(1, minutes)}m remaining`;
}

async function getCurrentPunishments(client, profile) {
  if (!profile.discord?.id) return null;
  const guildId = process.env.MET_GUILD_ID || '1191048287315304470';
  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return null;
  const member = await guild.members.fetch(String(profile.discord.id)).catch(() => null);
  if (!member) return null;

  const roleMap = new Map(CURRENT_PUNISHMENT_ACTIONS.map(action => [
    action, roleIdForAction(action),
  ]));
  const activeActions = CURRENT_PUNISHMENT_ACTIONS.filter(action => {
    const roleId = roleMap.get(action);
    return roleId && member.roles.cache.has(String(roleId));
  });
  if (!activeActions.length) return [];

  const now = new Date();
  const expiryByAction = new Map();
  const recordExpiry = (action, expiresAt) => {
    if (!activeActions.includes(action)) return;
    const date = expiresAt ? new Date(expiresAt) : null;
    const hasCurrent = expiryByAction.has(action);
    const current = expiryByAction.get(action);
    // A permanent live record wins. Otherwise show the furthest valid expiry.
    if (!hasCurrent || (current !== null && (!date || date > current))) expiryByAction.set(action, date);
  };

  try {
    const caseRows = await prisma.casePunishment.findMany({
      where: {
        action: { in: activeActions },
        roleRemoved: false,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        case: {
          status: 'APPROVED',
          OR: [
            { officerDiscordId: String(profile.discord.id) },
            { robloxUserId: String(profile.robloxId) },
          ],
        },
      },
      select: { action: true, expiresAt: true },
    });
    for (const row of caseRows) recordExpiry(row.action, row.expiresAt);
  } catch (err) {
    console.warn('[IA] current case punishments lookup failed:', err.message);
  }

  try {
    const rows = await prisma.metPunishment.findMany({
      where: {
        discordId: String(profile.discord.id),
        active: true,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { type: true, expiresAt: true },
    });
    for (const row of rows) {
      const type = String(row.type || '').toUpperCase();
      const action = type.includes('ZERO') || type === 'ZT' ? 'Zero Tolerance'
        : type.includes('SUSPENSION') ? 'Suspension'
        : type.includes('STRIKE 2') || type === 'STRIKE2' ? 'Disciplinary Strike 2'
        : type.includes('STRIKE 1') || type === 'STRIKE' || type === 'STRIKE1' ? 'Disciplinary Strike 1'
        : type.includes('ACTIVITY') ? 'Activity Strike' : null;
      if (action) recordExpiry(action, row.expiresAt);
    }
  } catch (err) {
    console.warn('[IA] current MET punishments lookup failed:', err.message);
  }

  return activeActions.map(action => {
    const expiry = expiryByAction.get(action);
    return { action, remaining: remainingLabel(expiry || null) };
  });
}

function panelEmbed(profile, selected) {
  const linked = profile.discord
    ? `<@${profile.discord.id}> - \`${profile.discord.username}\`${profile.discord.inMetServer === false ? ' - Not in MET' : ''}`
    : '*No Discord account linked*';
  const created = profile.createdAt
    ? `<t:${Math.floor(new Date(profile.createdAt).getTime() / 1000)}:D>`
    : 'Not available';
  const embed = new EmbedBuilder()
    .setColor(COLOUR)
    .setTitle('<:IA:1552764629204205619>  NEW IA CASE')
    .setDescription('Check the officer details and choose the action for this case.')
    .addFields(
      { name: 'OFFICER', value: `**${String(profile.displayName || profile.username).slice(0, 80)}**\n[${String(profile.username).slice(0, 60)}](https://www.roblox.com/users/${profile.robloxId}/profile) - \`${profile.robloxId}\``, inline: true },
      { name: 'DISCORD', value: linked, inline: true },
      { name: 'ACCOUNT CREATED', value: created, inline: true },
      { name: 'MET RANK', value: profile.metGroup ? `**${profile.metGroup.roleName}**` : 'Not in MET group', inline: true },
      { name: 'IA ACCESS', value: profile.dashboardRole || 'Not set', inline: true },
      { name: 'IA RANK', value: profile.iaRankName ? `**${profile.iaRankName}** - ${profile.iaRank}` : 'Not set', inline: true },
      { name: 'CURRENT PUNISHMENTS', value: profile.currentPunishments === null ? 'Could not verify current punishments because the officer has no linked MET Discord member.' : profile.currentPunishments.length ? profile.currentPunishments.map(p => `- **${p.action}** - ${p.remaining}`).join('\n').slice(0, 1024) : 'No active strikes, Zero Tolerance, Suspension or Activity Strike roles found.', inline: false },
      { name: 'ACTIONS', value: selected.length ? selected.map(a => `- **${a}**`).join('\n').slice(0, 1024) : '*Choose the action(s) below*', inline: false },
      { name: 'CASE NUMBER', value: 'Added when submitted', inline: true },
      { name: 'NEXT', value: 'Choose the action(s), then press Continue.', inline: true },
    )
    .setFooter({ text: 'Metropolitan Police Service - Internal Affairs' });
  if (profile.avatar) embed.setThumbnail(profile.avatar);
  if (profile.discord && profile.discord.avatar) embed.setAuthor({ name: profile.discord.username, iconURL: profile.discord.avatar });
  return embed;
}

function panelComponents(ownerId, robloxId, selected) {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`casebuilder:pick:${ownerId}:${robloxId}`)
    .setPlaceholder('Select one or more punishments')
    .setMinValues(1)
    .setMaxValues(Math.max(1, ACTION_NAMES.length))
    .addOptions(ACTION_NAMES.map((name, index) => ({
      label: name, value: String(index), default: selected.includes(name),
    })));
  const continueButton = new ButtonBuilder()
    .setCustomId(`casebuilder:continue:${ownerId}:${robloxId}:${encodeIndexes(selected)}`)
    .setLabel('Continue to case details').setStyle(ButtonStyle.Primary).setDisabled(!selected.length);
  const cancelButton = new ButtonBuilder()
    .setCustomId(`casebuilder:cancel:${ownerId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary);
  return [new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(continueButton, cancelButton)];
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
  const selected = selectedNames(indexes.split('.').filter(Boolean));
  const durationActions = selected.filter(needsDuration);
  modal.addComponents(
    new ActionRowBuilder().addComponents(reason),
    new ActionRowBuilder().addComponents(link),
    new ActionRowBuilder().addComponents(notes),
  );
  for (const action of durationActions) {
    const field = new TextInputBuilder()
      .setCustomId(action === 'Zero Tolerance' ? 'duration_zero_tolerance' : 'duration_suspension')
      .setLabel(`${action} Duration (days)`)
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('Leave blank for permanent')
      .setRequired(false)
      .setMaxLength(4);
    modal.addComponents(new ActionRowBuilder().addComponents(field));
  }
  return modal;
}

async function handleSubmitCase(interaction) {
  const username = String(interaction.options.getString('officer') || '').trim();
  if (!username || /[\s]/.test(username)) {
    return interaction.reply({ content: `${e('met_denied')} Enter one Roblox username without spaces.`, flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const loading = startLoading(interaction, 'Loading officer profile');
  try {
    const auth = await resolveAuthority(interaction);
    const view = canView(auth);
    if (!view.allowed) { loading.stop(); return interaction.editReply(`${e('met_denied')} ${view.reason}`); }
    if (!auth.userId) { loading.stop(); return interaction.editReply(`${e('met_warn')} Sign in to the MET Dashboard once with Discord before filing a case.`); }

    loading.update('Verifying Roblox details, group ranks and linked Discord account');
    const target = await roblox.getRobloxIdFromUsername(username);
    if (!target) { loading.stop(); return interaction.editReply(`${e('met_denied')} I couldn't find the Roblox username **${username}**.`); }

    const [info, groups, linked] = await Promise.all([
      roblox.getRobloxUserInfo(target.id),
      roblox.getUserGroups(target.id).catch(() => []),
      prisma.user.findFirst({
        where: { robloxId: String(target.id) },
        select: { discordId: true, discordUsername: true, discordAvatar: true, role: true, iaRankName: true, iaRank: true },
      }).catch(() => null),
    ]);
    if (!info) { loading.stop(); return interaction.editReply(`${e('met_warn')} Roblox profile lookup failed. Please try again.`); }

    const mainGroupId = String(roblox.mainGroupId());
    const met = groups.find(g => String(g.group.id) === mainGroupId) || null;
    let discord = null;
    if (linked && linked.discordId) {
      discord = { id: String(linked.discordId), username: linked.discordUsername || 'Linked Discord account', avatar: linked.discordAvatar ? `https://cdn.discordapp.com/avatars/${linked.discordId}/${linked.discordAvatar}.png?size=128` : null };
      const guildId = process.env.MET_GUILD_ID || '1191048287315304470';
      const guild = interaction.client.guilds.cache.get(guildId) || await interaction.client.guilds.fetch(guildId).catch(() => null);
      if (guild) {
        const member = await guild.members.fetch(discord.id).catch(() => null);
        if (member) {
          discord.username = member.user.tag || member.user.username;
          discord.avatar = member.user.displayAvatarURL({ size: 128 });
          discord.inMetServer = true;
        } else discord.inMetServer = false;
      }
    }
    const profile = {
      robloxId: String(target.id), username: info.username || target.username || username,
      displayName: info.displayName || info.username || username, createdAt: info.createdAt,
      banned: !!info.banned, avatar: await roblox.getRobloxAvatarHeadshot(target.id).catch(() => null),
      metGroup: met ? { roleName: met.role.name, rank: met.role.rank } : null,
      discord, dashboardRole: linked && linked.role, iaRankName: linked && linked.iaRankName, iaRank: linked && linked.iaRank,
    };
    loading.update('Checking current MET punishments');
    profile.currentPunishments = await getCurrentPunishments(interaction.client, profile);
    loading.stop();
    return interaction.editReply({ content: null, embeds: [panelEmbed(profile, [])], components: panelComponents(interaction.user.id, profile.robloxId, []) });
  } catch (err) {
    loading.stop();
    console.error('[IA] /case profile lookup failed:', err.message);
    return interaction.editReply(`${e('met_cross')} I couldn't finish loading the officer profile. Please try /case again.`).catch(() => {});
  }
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
    let selected = (interaction.values || []).map(String).filter(v => /^\d+$/.test(v)).map(v => ACTION_NAMES[Number(v)]).filter(Boolean);
    const current = interaction.message.embeds && interaction.message.embeds[0];
    if (!current) return interaction.reply({ content: 'This case panel expired. Start /case again.', flags: MessageFlags.Ephemeral });

    // Check live MET roles whenever the filer changes the punishment selection.
    // A first strike cannot be re-issued to somebody already wearing that role:
    // automatically move the selection to Strike 2 and explain the correction.
    let notice = null;
    if (selected.includes('Disciplinary Strike 1')) {
      const linked = await prisma.user.findFirst({
        where: { robloxId: String(robloxId) },
        select: { discordId: true },
      }).catch(() => null);
      const discordId = linked && linked.discordId ? String(linked.discordId) : null;
      const guildId = process.env.MET_GUILD_ID || '1191048287315304470';
      const guild = interaction.client.guilds.cache.get(guildId)
        || await interaction.client.guilds.fetch(guildId).catch(() => null);
      const member = guild && discordId
        ? await guild.members.fetch(discordId).catch(() => null)
        : null;
      const strikeOneRole = roleIdForAction('Disciplinary Strike 1');
      if (member && strikeOneRole && member.roles.cache.has(String(strikeOneRole))) {
        selected = selected.filter(name => name !== 'Disciplinary Strike 1');
        if (!selected.includes('Disciplinary Strike 2')) selected.push('Disciplinary Strike 2');
        notice = 'Already has **Disciplinary Strike 1** in the MET server. Selection changed to **Disciplinary Strike 2**.';
      }
    }

    const embed = EmbedBuilder.from(current);
    const value = selected.length ? selected.map(a => `- **${a}**`).join('\n').slice(0, 1024) : '*Choose one or more below*';
    embed.setFields((current.fields || []).map(field => field.name === 'ACTIONS' ? { ...field, value } : field));
    await interaction.update({ content: notice ? `⚠️ ${notice}` : null, embeds: [embed], components: panelComponents(ownerId, robloxId, selected) });
    if (notice) showTimedPanelNotice(interaction.message, notice);
    return;
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

async function handleFormSubmit(interaction, ownerId, robloxId, indexes) {
  if (!ownerCheck(interaction, ownerId)) {
    return interaction.reply({ content: 'This private case builder belongs to another user.', flags: MessageFlags.Ephemeral });
  }
  const actions = selectedNames(indexes.split('.').filter(Boolean));
  if (!actions.length) return interaction.reply({ content: 'No punishments were selected. Start /case again.', flags: MessageFlags.Ephemeral });
  const reason = interaction.fields.getTextInputValue('reason').trim();
  const caseLink = interaction.fields.getTextInputValue('case_link').trim();
  const notes = interaction.fields.getTextInputValue('notes').trim();
  if (!/^https?:\/\//i.test(caseLink)) {
    return interaction.reply({ content: `${e('met_denied')} The case link must be a valid http(s) link.`, flags: MessageFlags.Ephemeral });
  }
  const durations = {};
  for (const action of DURATION_ACTIONS.filter(name => actions.includes(name))) {
    const fieldId = action === 'Zero Tolerance' ? 'duration_zero_tolerance' : 'duration_suspension';
    const raw = interaction.fields.getTextInputValue(fieldId).trim();
    if (!raw) continue;
    if (!/^\d+$/.test(raw) || !Number.isInteger(Number(raw)) || Number(raw) < 1 || Number(raw) > 3650) {
      return interaction.reply({ content: `${e('met_denied')} ${action} duration must be a whole number of days from 1 to 3650, or left blank for permanent.`, flags: MessageFlags.Ephemeral });
    }
    durations[action] = Number(raw);
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const loading = startLoading(interaction, 'Validating case submission');
  const auth = await resolveAuthority(interaction);
  const view = canView(auth);
  if (!view.allowed) { loading.stop(); return interaction.editReply(`${e('met_denied')} ${view.reason}`); }
  if (!auth.userId) { loading.stop(); return interaction.editReply(`${e('met_warn')} Sign in to the MET Dashboard once with Discord before filing a case.`); }

  loading.update('Re-verifying the officer Roblox account');
  const targetInfo = await roblox.getRobloxUserInfo(robloxId).catch(() => null);
  const robloxUsername = targetInfo && (targetInfo.name || targetInfo.username);
  if (!robloxUsername) { loading.stop(); return interaction.editReply(`${e('met_denied')} The officer's Roblox account could not be re-verified. Please start /case again.`); }
  const linked = await prisma.user.findFirst({
    where: { robloxId: String(robloxId) },
    select: { discordId: true },
  }).catch(() => null);
  const investigator = await prisma.user.findUnique({
    where: { id: auth.userId },
    select: { robloxUsername: true, discordUsername: true, iaRankName: true, iaRank: true },
  }).catch(() => null);
  loading.update('Preparing punishment records');
  const enriched = actions.map(action => ({
    action,
    roleId: roleIdForAction(action),
    durationDays: needsDuration(action) ? (durations[action] || null) : null,
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
        investigatorRobloxUsername: investigator?.robloxUsername || null,
        investigatorDiscordUsername: investigator?.discordUsername || interaction.user.username,
        investigatorRank: investigator?.iaRankName || (investigator?.iaRank != null ? `IA Rank ${investigator.iaRank}` : null),
        status: 'PENDING',
      },
    });
  } catch (err) {
    loading.stop();
    console.error('[IA] case create failed:', err.message);
    return interaction.editReply(`${e('met_cross')} Could not file the case. No review card was posted; check the MET database connection.`);
  }

  await prisma.caseAction.create({
    data: { caseId: created.id, actionType: 'CREATED', performedBy: auth.userId, notes: 'Submitted via private /case builder' },
  }).catch(err => console.warn('[IA] case action audit failed:', err.message));

  loading.update('Creating the IA review post');
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
    loading.stop();
    return interaction.editReply(`${e('met_warn')} Case **${created.caseRef}** was recorded, but its review card could not be posted. It remains on the dashboard for review.`);
  }
  loading.stop();
  return interaction.editReply({
    content: `${e('met_tick')} Case **${created.caseRef}** has been submitted for review. ${gate} may decide this case.`,
    embeds: [new EmbedBuilder().setColor(COLOUR).setTitle(`IA CASE  ${created.caseRef}`)
      .setDescription(`**Officer**  ${robloxUsername}\n**Punishments**\n${actions.map(a => `- ${a}`).join('\n')}\n\n**Reason**\n${reason.slice(0, 900)}`)
      .addFields({ name: 'Case link', value: caseLink.slice(0, 1024) })
      .setFooter({ text: 'Metropolitan Police Service  -  Internal Affairs' })],
    components: [],
  });
}

module.exports = { buildCommand, handleSubmitCase, handleComponent };
