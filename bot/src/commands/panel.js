const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, MessageFlags } = require('discord.js');
const { env } = require('../lib/env');
const { isHicomm, isDeveloper, DENIED } = require('../lib/perms');
const { e, startLoading } = require('../lib/emoji');
const { PANELS, syncPanel } = require('../lib/panelSync');
const openCloud = require('../lib/openCloud');

const data = new SlashCommandBuilder()
  .setName('panel')
  .setDescription('Sync Discord roles to in-game panels')
  .addSubcommand(s => s.setName('sync').setDescription('Push a role\'s members to its in-game panel')
    .addStringOption(o => o.setName('panel').setDescription('Which panel').setRequired(true)
      .addChoices(...Object.entries(PANELS).map(([k, p]) => ({ name: p.label, value: k }))))
    .addBooleanOption(o => o.setName('dry').setDescription('Show who would be synced without writing')))
  .addSubcommand(s => s.setName('status').setDescription('Show what the game is currently reading')
    .addStringOption(o => o.setName('panel').setDescription('Which panel').setRequired(true)
      .addChoices(...Object.entries(PANELS).map(([k, p]) => ({ name: p.label, value: k })))));

async function execute(interaction) {
  if (!isHicomm(interaction.member) && !isDeveloper(interaction.member)) {
    return interaction.reply({ content: DENIED, flags: MessageFlags.Ephemeral });
  }
  const sub = interaction.options.getSubcommand();
  const key = interaction.options.getString('panel');
  const panel = PANELS[key];

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (sub === 'status') {
    const res = await openCloud.getEntry(panel.key());
    if (!res.ok) return interaction.editReply(`${e('DENY')} ${res.error}`);
    if (!res.value) return interaction.editReply(`${e('WARNING')} Nothing stored yet for \`${panel.key()}\` — run \`/panel sync\`.`);

    const v = res.value;
    return interaction.editReply({ embeds: [new EmbedBuilder()
      .setColor(0x4a8fff)
      .setTitle(`${e('SYNC')} ${panel.label} — live value`)
      .addFields(
        { name: 'Members in game', value: String(v.userIds?.length ?? 0), inline: true },
        { name: 'Last synced', value: v.syncedAt ? `<t:${Math.floor(new Date(v.syncedAt) / 1000)}:R>` : 'unknown', inline: true },
        { name: 'DataStore key', value: `\`${panel.key()}\``, inline: true },
        { name: 'Members', value: (v.members || []).map(m => `${e('BULLET')} ${m.username || m.userId}`).join('\n').slice(0, 1000) || '*empty*' },
      )] });
  }

  const dry = interaction.options.getBoolean('dry') || false;
  const loader = startLoading(interaction, dry ? 'Resolving members' : `Syncing ${panel.label}`);

  try {
    if (!dry && !openCloud.isConfigured()) {
      loader.stop();
      return interaction.editReply(
        `${e('DENY')} Open Cloud is not configured. Set \`ROBLOX_UNIVERSE_ID\` and ` +
        `\`ROBLOX_OPENCLOUD_KEY\`, or run with \`dry:true\` to preview.`);
    }

    loader.update('Reading role members and resolving Roblox accounts…');
    const r = await syncPanel(interaction.client, key);
    loader.stop();

    if (!dry && !r.write.ok) {
      return interaction.editReply(`${e('DENY')} Resolved ${r.resolved.length} members but the write failed: ${r.write.error}`);
    }

    const embed = new EmbedBuilder()
      .setColor(r.unlinked.length ? 0xf5b730 : 0x2ed896)
      .setTitle(`${e('SYNC')} ${panel.label} ${dry ? '— dry run' : 'synced'}`)
      .setDescription(dry
        ? 'Nothing was written. Re-run without `dry` to push.'
        : `Pushed to \`${r.write.datastore}\` → \`${panel.key()}\`.`)
      .addFields(
        { name: 'Role', value: `<@&${panel.roleId()}>`, inline: true },
        { name: 'Holders', value: String(r.total), inline: true },
        { name: 'Synced', value: String(r.resolved.length), inline: true },
        { name: 'Members',
          value: r.resolved.map(m => `${e('BULLET')} **${m.username || '?'}** \`${m.robloxId}\``)
            .join('\n').slice(0, 1000) || '*none*' },
      )
      .setTimestamp();

    if (r.unlinked.length) {
      embed.addFields({
        name: `${e('WARNING')} No Roblox link — excluded (${r.unlinked.length})`,
        value: r.unlinked.slice(0, 15).join('\n').slice(0, 1000)
             + (r.unlinked.length > 15 ? `\n…and ${r.unlinked.length - 15} more` : '')
             + '\n\nThese members hold the role but are not verified, so the game cannot identify them.',
      });
    }

    const files = [];
    if (dry) {
      files.push(new AttachmentBuilder(
        Buffer.from(JSON.stringify(r.payload, null, 2), 'utf8'),
        { name: `${panel.key()}.json` }));
    }
    return interaction.editReply({ content: '', embeds: [embed], files });
  } catch (err) {
    loader.stop();
    return interaction.editReply(`${e('DENY')} ${err.message}`);
  }
}

// Runs in the MET server alongside the other administration commands. The
// CID server holds the role we read, but has no commands of its own.
module.exports = { scope: 'met', data, execute };
