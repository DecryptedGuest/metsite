// Temporary one-shot reconciliation of current MET group ranks against XP.
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const XP = require('./xp');

function buildCommand() {
  return new SlashCommandBuilder()
    .setName('tempupdate')
    .setDescription('Temporarily reconcile MET group ranks against XP')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON();
}

async function handle(interaction) {
  const isAdmin = !!(interaction.memberPermissions
    && interaction.memberPermissions.has(PermissionFlagsBits.Administrator));
  const isDev = interaction.user.id === (process.env.DEVELOPER_DISCORD_ID || '1227866745201627137');
  if (!isAdmin && !isDev) {
    return interaction.reply({ content: 'You need Server Administrator access to run this bulk rank correction.', flags: 64 });
  }
  await interaction.deferReply({ flags: 64 });
  const client = require('./bot').getClient();
  if (!client) return interaction.editReply('Bot is not ready. No ranks were changed.');
  const guildId = process.env.MET_GUILD_ID || process.env.DISCORD_GUILD_ID;
  if (!guildId) return interaction.editReply('MET_GUILD_ID is not configured. No ranks were changed.');

  let guild, members, rows;
  try {
    guild = await client.guilds.fetch(String(guildId));
    members = await guild.members.fetch();
    rows = await require('./db').metXp.findMany({ orderBy: { discordId: 'asc' } });
  } catch (err) {
    return interaction.editReply('Pre-check failed; no ranks were changed. ' + String(err.message).slice(0, 250));
  }

  const roblox = require('./roblox');
  const results = [];
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  for (const row of rows) {
    const discordId = String(row.discordId);
    const member = members.get(discordId);
    if (!member) { results.push({ status: 'skipped', label: discordId, note: 'not in MET Discord server' }); continue; }
    try {
      let robloxId = row.robloxId ? String(row.robloxId) : null;
      if (!robloxId) {
        const link = await require('./robloxLink').resolveRoblox(discordId);
        robloxId = link && link.robloxId ? String(link.robloxId) : null;
      }
      if (!robloxId) { results.push({ status: 'skipped', label: member.displayName, note: 'no linked Roblox account' }); continue; }
      const membership = await roblox.getGroupMembership(robloxId);
      if (!membership || !membership.role) {
        results.push({ status: 'skipped', label: member.displayName, note: 'not in MET Roblox group / rank unavailable' });
        continue;
      }
      const current = membership.role;
      const currentName = String(current.name || '');
      if (XP.ABOVE_LADDER.test(currentName)) {
        results.push({ status: 'skipped', label: member.displayName, note: currentName + ' is above the XP ladder' });
        continue;
      }
      const currentRung = await XP.rungForGroupRank(current);
      if (!currentRung || !XP.ladder().some(r => r.match.test(currentName))) {
        results.push({ status: 'skipped', label: member.displayName, note: currentName + ' is not an XP-ladder rank' });
        continue;
      }
      const xp = Math.max(0, Number(row.xp) || 0);
      const target = XP.rankFor(xp);
      if (currentRung.code === target.code) {
        results.push({ status: 'ok', label: member.displayName, note: currentName + ' · ' + xp + ' XP' });
        continue;
      }
      if (target.code === 'CINS' && currentRung.code !== 'CINS') {
        results.push({ status: 'skipped', label: member.displayName, note: 'CINS is not an XP-earned promotion' });
        continue;
      }
      const down = target.at < currentRung.at;
      const changed = down
        ? await XP.demoteInGroup(robloxId, target)
        : await XP.promoteInGroup(robloxId, target);
      if (!changed.ok) {
        results.push({ status: 'failed', label: member.displayName, note: changed.reason || 'Roblox rank update failed' });
        continue;
      }
      const sync = await require('./rover').syncIdentity({ discordId, robloxId, rankName: target.name })
        .catch(err => ({ note: err.message }));
      results.push({
        status: changed.unchanged ? 'ok' : 'changed',
        label: member.displayName,
        note: currentName + ' → ' + target.name + ' (' + xp + ' XP)'
          + (sync && sync.note ? ' · Discord sync: ' + String(sync.note).slice(0, 100) : ''),
      });
    } catch (err) {
      results.push({ status: 'failed', label: member.displayName, note: String(err.message).slice(0, 160) });
    }
    await pause(350);
  }
  const count = status => results.filter(r => r.status === status).length;
  const lines = results.filter(r => r.status !== 'ok').slice(0, 35)
    .map(r => (r.status === 'changed' ? '✅' : r.status === 'failed' ? '❌' : '↪️')
      + ' **' + String(r.label).replace(/[*`_]/g, '') + '** · ' + r.note);
  const embed = new EmbedBuilder()
    .setColor(count('failed') ? 0xf5b730 : 0x2ed896)
    .setTitle('MET XP rank reconciliation complete')
    .setDescription(lines.join('\n').slice(0, 3900) || 'All linked XP records already match their earned ranks.')
    .addFields(
      { name: 'Scanned', value: String(results.length), inline: true },
      { name: 'Changed', value: String(count('changed')), inline: true },
      { name: 'Already correct', value: String(count('ok')), inline: true },
      { name: 'Skipped', value: String(count('skipped')), inline: true },
      { name: 'Failed', value: String(count('failed')), inline: true },
    )
    .setFooter({ text: 'Only linked XP records for current MET Discord members were checked. Above-ladder ranks were protected.' });
  if (results.filter(r => r.status !== 'ok').length > 35) {
    embed.addFields({ name: 'More results', value: 'The report is truncated; check the bot logs for full per-member outcomes.' });
  }
  return interaction.editReply({ embeds: [embed] });
}
module.exports = { buildCommand, handle };
