const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { isHicomm, DENIED } = require('../lib/perms');
const { setMemberLOA } = require('../lib/quota');
const roblox = require('../lib/roblox');

const data = new SlashCommandBuilder()
  .setName('loa')
  .setDescription('Leave of absence')
  .addSubcommand(s => s.setName('set').setDescription('Mark a member on leave of absence (writes LOA to the quota sheet)')
    .addStringOption(o => o.setName('user')
      .setDescription('Roblox username, or a Discord mention/ID to resolve').setRequired(true)));

async function execute(interaction) {
  if (!isHicomm(interaction.member)) {
    return interaction.reply({ content: DENIED, flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const raw = interaction.options.getString('user').trim();
  const mention = raw.match(/^<@!?(\d+)>$/);
  const discordId = mention ? mention[1] : (/^\d{15,25}$/.test(raw) ? raw : null);

  let username = raw;
  if (discordId) {
    const rbxId = await roblox.getRobloxIdFromDiscord(discordId);
    const info  = rbxId ? await roblox.getRobloxUserInfo(rbxId) : null;
    if (!info) return interaction.editReply('❌ That Discord account is not linked to a Roblox account.');
    username = info.name;
  }

  const result = await setMemberLOA(username);
  if (!result.ok) return interaction.editReply(`❌ ${result.error}`);
  return interaction.editReply(`✅ **${username}** is now marked **LOA** — exempt from quota until the marker is cleared.`);
}

module.exports = { data, execute };
