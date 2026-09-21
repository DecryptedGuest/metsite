// server/lib/demoteCommand.js
// /demote — move somebody down in the MET group.

const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');

const { e } = require('./emoji');
const { canSetRank, selectableRanks, planRankChange, planDemotion, keep, recall, applyPromotion, PROMOTE_ROLE_IDS } = require('./promoteCommand');

const COLOR = { review: 0x4a8fff, working: 0x4a8fff, done: 0x2ed896, fail: 0xf04f5e, warn: 0xf5b730 };
function short(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function buildCommand() {
  return new SlashCommandBuilder()
    .setName('demote')
    .setDescription('Demote an officer')
    .addUserOption(o => o
      .setName('officer')
      .setDescription('Who')
      .setRequired(true))
    .addStringOption(o => o
      .setName('rank')
      .setDescription('Rank')
      .setAutocomplete(true))
    .addStringOption(o => o
      .setName('reason')
      .setDescription('Why')
      .setMaxLength(300))
    .toJSON();
}

async function handleDemoteAutocomplete(interaction) {
  const focused = interaction.options.getFocused ? String(interaction.options.getFocused() || '') : '';
  const q = focused.trim().toLowerCase();
  let ranks = [];
  try { ranks = await selectableRanks(); } catch (e) { ranks = []; }
  const choices = ranks
    .filter(r => !q || String(r.name || '').toLowerCase().includes(q))
    .slice(0, 25)
    .map(r => ({ name: String(r.name || ''), value: String(r.name || '') }));
  return interaction.respond(choices).catch(() => {});
}

async function handleDemoteCommand(interaction) {
  await interaction.deferReply({ flags: 64 });

  const target = interaction.options.getUser('officer');
  const reason = interaction.options.getString('reason');
  const rankArg = (interaction.options.getString('rank') || '').trim();

  const fail = (title, body) => new EmbedBuilder()
    .setColor(COLOR.fail).setTitle(`${e('met_cross')} ${title}`).setDescription(body);

  if (target.bot) {
    return interaction.editReply({ embeds: [fail("That's a bot", 'Pick an officer.')] }).catch(() => {});
  }

  const roleIds = interaction.member && interaction.member.roles && interaction.member.roles.cache
    ? [...interaction.member.roles.cache.keys()].map(String) : [];
  const isAdmin = !!(interaction.memberPermissions
    && typeof interaction.memberPermissions.has === 'function'
    && interaction.memberPermissions.has(require('discord.js').PermissionFlagsBits.Administrator));

  let access = { ok: false };
  const extraRole = PROMOTE_ROLE_IDS().find(rid => roleIds.includes(String(rid)));
  if (extraRole) {
    access = { ok: true, via: 'promote-role', label: 'HPC High Command', name: null };
  } else {
    access = await require('./xpCommand').canManageXp({ discordId: interaction.user.id, roleIds, isAdmin });
  }
  if (!access.ok) {
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLOR.fail)
      .setTitle(`${e('met_denied')} Not authorised`)
      .setDescription('Demoting is for FLP officers, HPC High Command, Deputy Commissioner and above, and server administrators.')],
    }).catch(() => {});
  }

  if (target.id === interaction.user.id) {
    return interaction.editReply({ embeds: [fail('Not yourself', 'Ask somebody else to.')] }).catch(() => {});
  }

  const [link, issuerLink] = await Promise.all([
    require('./robloxLink').resolveRoblox(target.id).catch(() => ({ robloxId: null, username: null })),
    require('./robloxLink').resolveRoblox(interaction.user.id).catch(() => ({ robloxId: null })),
  ]);
  if (!link.robloxId) {
    return interaction.editReply({ embeds: [fail('No Roblox account', `<@${target.id}> has no Roblox account we can find · verify them with RoVer, or have them log into the MET Dashboard once, and try again.`)],
    }).catch(() => {});
  }

  const metRank = require('./metRank');
  const [current, issuerRole, avatar] = await Promise.all([
    metRank.metRole(link.robloxId).catch(() => null),
    issuerLink.robloxId ? metRank.metRole(issuerLink.robloxId).catch(() => null) : null,
    require('./roblox').getRobloxAvatarHeadshot(link.robloxId).catch(() => null),
  ]);

  const issuerRank = issuerRole && issuerRole.rank != null ? Number(issuerRole.rank) : null;

  let plan, mode = 'demote', issuerLabel = access.label, issuerName = access.name;
  if (rankArg) {
    const setAuth = await canSetRank({ discordId: interaction.user.id, roleIds, isAdmin });
    if (!setAuth.ok) {
      return interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLOR.fail)
        .setTitle(`${e('met_denied')} Not authorised to set a rank`)
        .setDescription('Setting a specific rank is for Deputy Commissioner and above. You can still demote one rank below.')],
      }).catch(() => {});
    }
    issuerLabel = setAuth.label || issuerLabel;
    issuerName = setAuth.name || issuerName;

    let choices = [];
    try { choices = await selectableRanks(); } catch (e) { choices = []; }
    const wanted = rankArg.toLowerCase();
    const targetRank = choices.find(r => String(r.name || '').toLowerCase() === wanted)
      || choices.find(r => String(r.name || '').toLowerCase().includes(wanted));
    if (!targetRank) {
      return interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLOR.warn)
        .setTitle(`${e('met_warn')} No such rank`)
        .setDescription(`**${String(rankArg).slice(0, 60)}** isn't a rank I can set.`)],
      }).catch(() => {});
    }

    plan = await planRankChange(current, targetRank, issuerRank);
    mode = 'setrank';
  } else {
    plan = await planDemotion(current, issuerRank);
  }

  if (!plan.ok) {
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLOR.warn)
      .setTitle(`${e('met_warn')} ${mode === 'setrank' ? "Can't set that rank" : "Can't demote them"}`)
      .setDescription(plan.why)
      .setFooter({ text: current ? `Currently ${current.name}` : 'MET rank unknown' })],
    }).catch(() => {});
  }

  const down = true;
  const icon = n => {
    const i = require('./rankEmoji').forRank(interaction.client, n);
    return i ? i + ' ' : '';
  };

  const token = keep({
    ownerId: interaction.user.id,
    targetId: target.id,
    robloxId: String(link.robloxId),
    username: link.username || null,
    from: plan.from, to: plan.to, reason: reason || null,
    mode, direction: 'down',
    issuerId: interaction.user.id,
    issuerName: issuerName || (interaction.member && interaction.member.displayName) || interaction.user.username,
    avatar,
  });

  const heading = mode === 'setrank' ? 'Set rank' : 'Demote';
  const embed = new EmbedBuilder()
    .setColor(COLOR.review)
    .setTitle(`${e('met_warn')} ${heading}`)
    .setDescription(
      `${e('met_user')} <@${target.id}>`
      + (link.username ? ` · [${String(link.username).slice(0, 30)}](https://www.roblox.com/users/${link.robloxId}/profile)` : ''))
    .addFields(
      { name: 'From', value: `${icon(plan.from.name)} ${String(plan.from.name || '').slice(0, 40)}`, inline: true },
      { name: 'To', value: `${icon(plan.to.name)} ${String(plan.to.name || '').slice(0, 40)}`, inline: true },
      ...(reason ? [{ name: 'Reason', value: String(reason).slice(0, 500), inline: false }] : []),
      { name: 'This will', value: [
        `${e('met_dot_on')} Set their MET rank to **${plan.to.name}**`,
        `${e('met_dot_on')} Move their XP to the floor of that rank`,
        `${e('met_dot_on')} DM them and post it to the XP log`,
      ].join('\n'), inline: false },
    )
    .setFooter({ text: `By ${issuerName || interaction.user.username}${issuerLabel ? ` · ${issuerLabel}` : ''}` });
  if (avatar) embed.setThumbnail(avatar);

  const btnLabel = mode === 'setrank' ? `Set to ${String(plan.to.name).slice(0, 32)}` : `Demote to ${String(plan.to.name).slice(0, 32)}`;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`dem_go_${token}`).setLabel(btnLabel).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`dem_no_${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );

  return interaction.editReply({ embeds: [embed], components: [row] }).catch(() => {});
}

async function handleDemoteButton(interaction) {
  const m = String(interaction.customId || '').match(/^dem_(go|no)_([a-z0-9]+)$/i);
  if (!m) return;
  const [, verb, token] = m;

  const state = recall(token);
  if (!state) {
    return interaction.update({
      embeds: [new EmbedBuilder().setColor(COLOR.warn)
        .setTitle(`${e('met_warn')} This has expired`)
        .setDescription('Run `/demote` again · nothing was changed.')],
      components: [],
    }).catch(() => {});
  }
  if (String(state.ownerId) !== String(interaction.user.id)) {
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(COLOR.fail)
        .setTitle(`${e('met_denied')} Not yours`)
        .setDescription('Run `/demote` to open your own.')],
      flags: 64,
    }).catch(() => {});
  }

  if (verb === 'no') {
    return interaction.update({
      embeds: [new EmbedBuilder().setColor(COLOR.fail)
        .setTitle(`${e('met_cross')} Cancelled`)
        .setDescription('Nothing was changed.')],
      components: [],
    }).catch(() => {});
  }

  const down = true;
  const verbing = 'Demoting…';
  await interaction.update({
    embeds: [new EmbedBuilder().setColor(COLOR.working)
      .setTitle(`${e('met_load2')} ${verbing}`)
      .setDescription(`<@${state.targetId}> → **${state.to.name}**`)],
    components: [],
  }).catch(() => {});

  const result = await applyPromotion(state, interaction.client);

  const doneTitle = result.group.ok ? 'Rank changed' : 'Rank change failed';
  const line = (ok, text) => `${ok == null ? e('met_warn') : ok ? e('met_tick') : e('met_cross')} ${text}`;
  const xpText = result.xp.ok ? `XP · set to **${result.xp.value}**` : (result.xp.reason === 'not attempted' ? 'XP · not attempted' : `XP · ${String(result.xp.reason || 'unchanged').slice(0, 90)}`);
  const dmText = result.dm == null ? 'Officer notified · not attempted' : (result.dm ? 'Officer notified' : "Couldn't DM them · their DMs are closed");
  const logText = result.logged == null ? 'XP log · not attempted' : (result.logged ? 'Posted to the XP log' : 'XP log not posted');

  const embed = new EmbedBuilder()
    .setColor(result.group.ok ? COLOR.done : COLOR.fail)
    .setTitle(`${result.group.ok ? e('met_edit') : e('met_cross')} ${doneTitle}`)
    .setDescription(`${e('met_user')} <@${state.targetId}>` + (state.username ? ` · ${String(state.username).slice(0, 30)}` : ''))
    .addFields(
      { name: 'Rank', value: `${String(state.from.name || '').slice(0, 40)} → **${String(state.to.name || '').slice(0, 40)}**`, inline: false },
      { name: 'Steps', value: [
        line(result.group.ok, `MET Rank · ${result.group.ok ? `now **${state.to.name}**` : String(result.group.reason || 'failed').slice(0, 90)}`),
        line(result.xp.ok, xpText),
        line(result.dm, dmText),
        line(result.logged, logText),
      ].join('\n'), inline: false },
    )
    .setFooter({ text: `By ${state.issuerName}` });
  if (state.avatar) embed.setThumbnail(state.avatar);

  return interaction.editReply({ embeds: [embed], components: [] }).catch(() => {});
}

module.exports = {
  buildCommand,
  handleDemoteCommand,
  handleDemoteButton,
  handleDemoteAutocomplete,
};
