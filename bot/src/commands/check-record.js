const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const prisma = require('../lib/db');
const { isIA, DENIED } = require('../lib/perms');
const roblox = require('../lib/roblox');

const data = new SlashCommandBuilder()
  .setName('check-record')
  .setDescription("Look up a member's disciplinary record and the suggested next step")
  .addStringOption(o => o.setName('user')
    .setDescription('A Discord mention/ID or a Roblox username').setRequired(true));

// First match wins — the ladder is ordered from most to least severe.
const LADDER = [
  ['Disciplinary Strike 2', 'Termination',           'Existing Disciplinary Strike 2 on record'],
  ['Disciplinary Strike 1', 'Disciplinary Strike 2', 'Existing Disciplinary Strike 1 on record'],
  ['Activity Strike',       'Disciplinary Strike 1', 'Existing Activity Strike on record'],
  ['Written Warning',       'Disciplinary Strike 1', 'Existing Written Warning on record'],
];

/** "RANK | RobloxUsername" — the server's nickname convention. */
function robloxNameFromNick(nick) {
  if (!nick || !nick.includes('|')) return null;
  const name = nick.split('|').pop().trim();
  return /^[A-Za-z0-9_]{3,20}$/.test(name) ? name : null;
}

async function execute(interaction) {
  if (!isIA(interaction.member)) {
    return interaction.reply({ content: DENIED, flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const raw = interaction.options.getString('user').trim();
  const mention = raw.match(/^<@!?(\d+)>$/);
  const discordId = mention ? mention[1] : (/^\d{15,25}$/.test(raw) ? raw : null);

  let robloxId = null, robloxUsername = null, displayName = null;

  if (discordId) {
    robloxId = await roblox.getRobloxIdFromDiscord(discordId);
    if (!robloxId) {
      // Fall back to the nickname convention before giving up.
      const member = await interaction.guild.members.fetch(discordId).catch(() => null);
      const nickName = robloxNameFromNick(member?.nickname || member?.displayName);
      if (nickName) {
        const u = await roblox.getRobloxIdFromUsername(nickName);
        if (u) { robloxId = u.id; robloxUsername = u.name; displayName = u.displayName; }
      }
    }
    if (robloxId && !robloxUsername) {
      const info = await roblox.getRobloxUserInfo(robloxId);
      robloxUsername = info?.name || null;
      displayName    = info?.displayName || null;
    }
    if (!robloxId) return interaction.editReply(`❌ <@${discordId}> is not linked to a Roblox account (not_linked).`);
  } else {
    const u = await roblox.getRobloxIdFromUsername(raw);
    if (!u) return interaction.editReply(`❌ No Roblox user called \`${raw}\` (not_found).`);
    robloxId = u.id; robloxUsername = u.name; displayName = u.displayName;
  }

  const membership = await roblox.getGroupMembership(robloxId);

  const orClauses = [];
  if (discordId)      orClauses.push({ officerDiscordId: discordId });
  if (robloxId)       orClauses.push({ robloxUserId: robloxId });
  if (robloxUsername) orClauses.push({ robloxUsername });

  const approvedCases = await prisma.case.findMany({
    where:   { OR: orClauses, status: 'APPROVED' },
    select:  { action: true, actions: true, caseRef: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  const approvedActionSet = new Set();
  for (const c of approvedCases) {
    if (Array.isArray(c.actions)) c.actions.forEach(a => approvedActionSet.add(a.action));
    else if (c.action) c.action.split(',').forEach(a => approvedActionSet.add(a.trim()));
  }
  const approvedActions = [...approvedActionSet];

  let suggestedAction = null, warning = null;
  for (const [held, next, warn] of LADDER) {
    if (approvedActions.includes(held)) { suggestedAction = next; warning = warn; break; }
  }

  const embed = new EmbedBuilder()
    .setColor(warning ? 0xf5b730 : 0x2f3136)
    .setTitle(`Record — ${robloxUsername}`)
    .setURL(`https://www.roblox.com/users/${robloxId}/profile`)
    .addFields(
      { name: 'Roblox',   value: `${robloxUsername}${displayName && displayName !== robloxUsername ? ` (${displayName})` : ''}`, inline: true },
      { name: 'Discord',  value: discordId ? `<@${discordId}>` : '*not linked*', inline: true },
      { name: 'In group', value: membership ? `Yes — ${membership.role?.name || 'unknown rank'}` : 'No', inline: true },
      { name: `Approved actions (${approvedActions.length})`,
        value: approvedActions.length ? approvedActions.map(a => `• ${a}`).join('\n').slice(0, 1000) : '*Clean record*' },
      { name: `History (${approvedCases.length})`,
        value: approvedCases.length
          ? approvedCases.map(c => `${c.caseRef} · ${c.action} · <t:${Math.floor(c.createdAt / 1000)}:d>`).join('\n').slice(0, 1000)
          : '*None*' },
    );

  const avatar = await roblox.getRobloxAvatarHeadshot(robloxId);
  if (avatar) embed.setThumbnail(avatar);
  if (suggestedAction) {
    embed.addFields({ name: '⚠️ Suggested next step', value: `**${suggestedAction}** — ${warning}` });
  }
  return interaction.editReply({ embeds: [embed] });
}

module.exports = { scope: 'ia', data, execute };
