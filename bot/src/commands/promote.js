const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { isHicomm, DENIED } = require('../lib/perms');
const roblox = require('../lib/roblox');

const data = new SlashCommandBuilder()
  .setName('promote')
  .setDescription("Set a member's Roblox group rank")
  .addStringOption(o => o.setName('user')
    .setDescription('Roblox username, or a Discord mention/ID').setRequired(true))
  .addStringOption(o => o.setName('rank')
    .setDescription('The target rank').setRequired(true).setAutocomplete(true));

// The group is the source of truth for ranks — never hard-code a ladder.
let rolesCache = { at: 0, roles: [] };
async function cachedRoles() {
  if (Date.now() - rolesCache.at < 5 * 60 * 1000 && rolesCache.roles.length) return rolesCache.roles;
  const roles = await roblox.listGroupRoles();
  rolesCache = { at: Date.now(), roles };
  return roles;
}

async function autocomplete(interaction) {
  const typed = (interaction.options.getFocused() || '').toLowerCase();
  try {
    const roles = await cachedRoles();
    await interaction.respond(
      roles.filter(r => r.rank > 0 && r.name.toLowerCase().includes(typed))
        .slice(0, 25)
        .map(r => ({ name: `${r.name} (rank ${r.rank})`, value: String(r.id) })),
    );
  } catch { await interaction.respond([]).catch(() => {}); }
}

async function execute(interaction) {
  if (!isHicomm(interaction.member)) {
    return interaction.reply({ content: DENIED, flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const raw = interaction.options.getString('user').trim();
  const mention = raw.match(/^<@!?(\d+)>$/);
  const discordId = mention ? mention[1] : (/^\d{15,25}$/.test(raw) ? raw : null);

  let robloxId = null, username = raw;
  if (discordId) {
    robloxId = await roblox.getRobloxIdFromDiscord(discordId);
    if (!robloxId) return interaction.editReply('❌ That Discord account is not linked to a Roblox account.');
    username = (await roblox.getRobloxUserInfo(robloxId))?.name || robloxId;
  } else {
    const u = await roblox.getRobloxIdFromUsername(raw);
    if (!u) return interaction.editReply(`❌ No Roblox user called \`${raw}\`.`);
    robloxId = u.id; username = u.name;
  }

  const roleId = interaction.options.getString('rank');
  try {
    const before = await roblox.getGroupMembership(robloxId);
    await roblox.changeGroupRank(robloxId, roleId);
    const roles  = await cachedRoles();
    const target = roles.find(r => String(r.id) === String(roleId).split('/').pop());
    return interaction.editReply(
      `✅ **${username}** — ${before?.role?.name || 'unknown'} → **${target?.name || roleId}**`);
  } catch (err) {
    return interaction.editReply(`❌ ${err.message}`);
  }
}

module.exports = { data, execute, autocomplete };
