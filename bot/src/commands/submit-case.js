const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
        ButtonStyle, MessageFlags } = require('discord.js');
const prisma = require('../lib/db');
const { env } = require('../lib/env');
const { ACTION_NAMES, parseActions, roleIdForAction } = require('../lib/actions');
const { isIA, DENIED } = require('../lib/perms');
const { rankOf, parseNickname, APPROVAL_MIN, IA_RANKS } = require('../lib/iaRanks');
const { e, startLoading } = require('../lib/emoji');
const { nextCaseRef } = require('../lib/discipline');
const roblox = require('../lib/roblox');

const data = new SlashCommandBuilder()
  .setName('submit-case')
  .setDescription('Submit a disciplinary case document for HR review')
  .addStringOption(o => o.setName('document').setDescription('Link to the case document').setRequired(true))
  .addStringOption(o => o.setName('punishments')
    .setDescription('Comma-separated punishments').setRequired(true).setAutocomplete(true))
  .addStringOption(o => o.setName('reason').setDescription('Summary of the misconduct').setRequired(true))
  .addUserOption(o => o.setName('subject').setDescription('The Discord member being punished'))
  .addStringOption(o => o.setName('roblox').setDescription("The subject's Roblox username"))
  .addIntegerOption(o => o.setName('duration').setDescription('Days, for Suspension / Zero Tolerance').setMinValue(1))
  .addStringOption(o => o.setName('blacklist_code').setDescription('Blacklist code, e.g. PL-M304'))
  .addStringOption(o => o.setName('notes').setDescription('Anything else the reviewer should know'));

async function autocomplete(interaction) {
  const typed  = interaction.options.getFocused();
  const parts  = typed.split(',');
  const prefix = parts.slice(0, -1).join(',');
  const last   = (parts.at(-1) || '').trim().toLowerCase();
  await interaction.respond(
    ACTION_NAMES.filter(a => a.toLowerCase().includes(last))
      .map(a => {
        const v = (prefix ? `${prefix.trim()}, ${a}` : a).slice(0, 100);
        // Show what rank each punishment needs, so the filer isn't surprised.
        const need = IA_RANKS[APPROVAL_MIN[a]]?.abbr;
        return { name: `${a}${need ? `  —  needs ${need}` : ''}`.slice(0, 100), value: v };
      })
      .slice(0, 25),
  ).catch(() => {});
}

async function execute(interaction) {
  if (!isIA(interaction.member)) {
    return interaction.reply({ content: DENIED, flags: MessageFlags.Ephemeral });
  }

  const subject = interaction.options.getUser('subject');
  const robloxName = interaction.options.getString('roblox');
  if (!subject && !robloxName) {
    return interaction.reply({ content: `${e('DENY')} Give either a \`subject\` or a \`roblox\` username.`, flags: MessageFlags.Ephemeral });
  }

  const doc = interaction.options.getString('document').trim();
  if (!/^https?:\/\//i.test(doc)) {
    return interaction.reply({ content: `${e('DENY')} \`document\` must be a link.`, flags: MessageFlags.Ephemeral });
  }

  const { actions, invalid } = parseActions(interaction.options.getString('punishments'));
  if (invalid.length) {
    return interaction.reply({ content: `${e('DENY')} Invalid action: ${invalid[0]}`, flags: MessageFlags.Ephemeral });
  }
  if (!actions.length) {
    return interaction.reply({ content: `${e('DENY')} Pick at least one punishment.`, flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const loader = startLoading(interaction, 'Filing case');

  try {
    loader.update('Resolving Roblox identity…');
    let robloxUserId = null, robloxUsername = robloxName || null;
    if (subject) {
      robloxUserId = await roblox.getRobloxIdFromDiscord(subject.id);
      if (robloxUserId) robloxUsername = (await roblox.getRobloxUserInfo(robloxUserId))?.name || robloxUsername;
    } else if (robloxName) {
      const u = await roblox.getRobloxIdFromUsername(robloxName);
      if (u) { robloxUserId = u.id; robloxUsername = u.name; }
    }

    const duration = interaction.options.getInteger('duration');
    const blCode   = interaction.options.getString('blacklist_code');
    const enriched = actions.map(a => ({
      action: a,
      roleId: roleIdForAction(a),
      durationDays: require('../lib/actions').isTimed(a) ? (duration || null) : null,
      ...(a === 'Blacklist' && blCode ? { code: blCode } : {}),
    }));

    loader.update('Writing the record…');
    const caseRef = await nextCaseRef();
    const created = await prisma.case.create({
      data: {
        caseRef,
        submitterDiscordId: interaction.user.id,
        officerDiscordId: subject?.id || null,
        robloxUserId, robloxUsername,
        action: enriched.map(a => a.action).join(', '),
        actions: enriched,
        reason: interaction.options.getString('reason'),
        notes:  interaction.options.getString('notes') || 'N/A',
        caseLink: doc, docUrl: doc,
        blacklistCode: blCode || null,
        status: 'PENDING',
      },
    });
    await prisma.caseAction.create({
      data: { caseId: created.id, actionType: 'CREATED', performedBy: interaction.user.id, notes: 'Submitted via /submit-case' },
    });

    loader.update('Posting for review…');
    const filerRank = rankOf(interaction.member)
      || parseNickname(interaction.member?.displayName).rank;

    // The highest rank any punishment on this case demands.
    const needIdx = Math.max(...enriched.map(a => APPROVAL_MIN[a.action] ?? 0));
    const needRank = IA_RANKS[needIdx];

    const embed = new EmbedBuilder()
      .setColor(0xf5b730)
      .setAuthor({
        name: `Submitted by ${interaction.member?.displayName || interaction.user.username}`,
        iconURL: interaction.user.displayAvatarURL({ extension: 'png', size: 64 }),
      })
      .setTitle(`${e('CASE')} Case ${caseRef}`)
      .setURL(doc)
      .addFields(
        { name: 'Subject', value: subject ? `${subject}${robloxUsername ? ` (\`${robloxUsername}\`)` : ''}` : `\`${robloxUsername}\``, inline: false },
        { name: 'Punishment(s)', value: enriched.map(a =>
            `${e('BULLET')} **${a.action}**${a.durationDays ? ` — ${a.durationDays}d` : ''}${a.code ? ` \`${a.code}\`` : ''}`).join('\n'), inline: false },
        { name: 'Reason', value: interaction.options.getString('reason').slice(0, 1000), inline: false },
        { name: 'Investigating Officer', value: filerRank ? `${filerRank.abbr} — ${interaction.user}` : `${interaction.user}`, inline: true },
        { name: 'Requires', value: `**${needRank.abbr}**+`, inline: true },
        { name: 'Status', value: `${e('PENDING')} Awaiting review`, inline: true },
      )
      .setFooter({ text: 'Internal Affairs — Case Review' })
      .setTimestamp();

    if (robloxUserId) {
      const avatar = await roblox.getRobloxAvatarHeadshot(robloxUserId);
      if (avatar) embed.setThumbnail(avatar);
    }
    if (interaction.options.getString('notes')) {
      embed.addFields({ name: 'Notes', value: interaction.options.getString('notes').slice(0, 1000) });
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`ia:case:approve:${created.id}`)
        .setLabel('Accept').setEmoji(env('EMOJI_APPROVE_RAW') || '✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`ia:case:deny:${created.id}`)
        .setLabel('Deny').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setLabel('Open document').setStyle(ButtonStyle.Link).setURL(doc),
    );

    const channel = await interaction.client.channels.fetch(env('CASES_CHANNEL_ID')).catch(() => null);
    if (!channel) {
      loader.stop();
      return interaction.editReply(`${e('WARNING')} Filed **${caseRef}**, but the cases channel is unreachable — check \`CASES_CHANNEL_ID\`.`);
    }

    const reviewerPing = env('IA_REVIEWER_ROLE_ID');
    const msg = await channel.send({
      content: reviewerPing ? `<@&${reviewerPing}>` : undefined,
      embeds: [embed], components: [row],
    });
    await prisma.case.update({ where: { id: created.id }, data: { cardMessageId: msg.id } }).catch(() => {});

    loader.stop();
    return interaction.editReply(
      `${e('APPROVE')} Filed **${caseRef}** — [review card posted](${msg.url}). Needs **${needRank.abbr}**+ to approve.`);
  } catch (err) {
    loader.stop();
    return interaction.editReply(`${e('DENY')} ${err.message}`);
  }
}

module.exports = { data, execute, autocomplete };
