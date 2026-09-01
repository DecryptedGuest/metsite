// server/lib/adonisCommand.js
// /adonis — the Roblox game bridge, from Discord.
//
// One parent command with subcommands rather than four top-level ones. The
// original bridge took /run, /servers and /status, which are three of the most
// collidable names on Discord and say nothing about what they act on; under
// /adonis it is obvious what is being driven and the site's own command list
// stays readable.
//
// Who may RUN a command is checked here, against the same High Command test the
// site uses. The bridge this replaces had no check at all: any member who could
// see the command could run any Adonis command on any live server.
'use strict';

const { SlashCommandBuilder } = require('discord.js');
const adonis = require('./adonis');

const COMMAND = 'adonis';

// The ONE server this command belongs in. Hardcoded on purpose: it drives live
// Roblox game servers, and it appearing anywhere else causes real damage, so
// this must not depend on an environment variable being right.
const GUILD_ID = '1521248995882696838';

// Registration is the first line and this is the second. Discord keeps a guild
// command until something deletes it, so a copy registered by an earlier deploy
// outlives the code that put it there and can still be invoked. Every entry
// point below therefore checks where it is being run, and refuses anywhere
// else, rather than trusting that the command list is already correct.
function wrongGuild(interaction) {
  return String(interaction.guildId || '') !== GUILD_ID;
}

function buildCommand() {
  return new SlashCommandBuilder()
    .setName(COMMAND)
    .setDescription('The Roblox game bridge: live servers, players and Adonis commands')
    .addSubcommand(s => s.setName('servers')
      .setDescription('Every Roblox server that is live right now'))
    .addSubcommand(s => s.setName('players')
      .setDescription('Who is in a server, by team')
      .addStringOption(o => o.setName('server')
        .setDescription('Leave empty for every live server').setRequired(false).setAutocomplete(true)))
    .addSubcommand(s => s.setName('whereis')
      .setDescription('Find which server somebody is in')
      .addStringOption(o => o.setName('player')
        .setDescription('A username, display name or user id').setRequired(true)))
    .addSubcommand(s => s.setName('run')
      .setDescription('Run an Adonis command (High Command only)')
      .addStringOption(o => o.setName('command')
        .setDescription('The Adonis command, without the prefix, e.g. m Hello everyone').setRequired(true))
      .addStringOption(o => o.setName('server')
        .setDescription('Leave empty to run it on every live server').setRequired(false).setAutocomplete(true)))
    .addSubcommand(s => s.setName('status')
      .setDescription('Bridge status: servers, players and the command queue'))
    .toJSON();
}

// ── Autocomplete: the live server list ───────────────────────────────────
async function handleAutocomplete(interaction) {
  if (wrongGuild(interaction)) return interaction.respond([]);
  const focused = String(interaction.options.getFocused() || '').toLowerCase();
  const list = adonis.listServers();
  const choices = list
    .filter(s => s.serverId.toLowerCase().includes(focused))
    .slice(0, 24)
    .map(s => ({
      name: `${s.placeName ? s.placeName + ' · ' : ''}${s.serverId.slice(0, 18)} (${s.playerCount} player${s.playerCount === 1 ? '' : 's'})`.slice(0, 100),
      value: s.serverId,
    }));
  if (!focused) choices.unshift({ name: `All live servers (${list.length})`, value: '' });
  return interaction.respond(choices.slice(0, 25));
}

// ── Who may run a command ────────────────────────────────────────────────
// The same rule as the site's /api/adonis POST: High Command, or a developer.
async function mayRun(interaction) {
  try {
    const prisma = require('./db');
    const user = await prisma.user.findFirst({
      where: { discordId: String(interaction.user.id) },
      select: { id: true, role: true, robloxId: true, displayName: true, discordUsername: true },
    });
    if (!user) return { ok: false, why: 'Link your Discord to the MET site first.' };
    if (user.role === 'DEVELOPER') return { ok: true, user };
    const { userIsMetHicomm } = require('./metRank');
    const ok = await userIsMetHicomm(user);
    return ok ? { ok: true, user } : { ok: false, why: 'Running Adonis commands is High Command only.' };
  } catch (e) {
    return { ok: false, why: 'Could not check your rank just now, so the command was not run.' };
  }
}

function fmtServer(s) {
  const bits = [`\`${s.serverId.slice(0, 24)}\``, `${s.playerCount}${s.maxPlayers ? '/' + s.maxPlayers : ''} players`];
  if (s.placeName) bits.unshift(`**${s.placeName}**`);
  if (s.region) bits.push(s.region);
  bits.push(`up ${Math.floor(s.uptimeSeconds / 60)}m`);
  return bits.join(' · ');
}

async function handle(interaction) {
  if (wrongGuild(interaction)) {
    console.warn(`[Adonis] /adonis was invoked in ${interaction.guildId}, which is not the bridge server · refused`);
    return interaction.reply({ ephemeral: true,
      content: 'This command does not belong in this server and will not run here.' });
  }
  const sub = interaction.options.getSubcommand();

  if (sub === 'status') {
    const st = adonis.stats();
    return interaction.reply({ ephemeral: true, content:
      `**Adonis bridge**\n`
      + `Live servers: **${st.servers}**\n`
      + `Players online: **${st.players}**\n`
      + `Commands waiting to be collected: **${st.queued}**`
    });
  }

  if (sub === 'servers') {
    const list = adonis.listServers();
    if (!list.length) return interaction.reply({ ephemeral: true, content: 'No Roblox servers are online right now.' });
    const lines = list.slice(0, 20).map((s, i) => `${i + 1}. ${fmtServer(s)}`);
    const more = list.length > 20 ? `\n…and ${list.length - 20} more.` : '';
    return interaction.reply({ ephemeral: true, content:
      `**Live servers (${list.length}) · ${list.reduce((n, s) => n + s.playerCount, 0)} players**\n${lines.join('\n')}${more}` });
  }

  if (sub === 'players') {
    const serverId = interaction.options.getString('server') || '';
    if (serverId && !adonis.getServer(serverId)) {
      return interaction.reply({ ephemeral: true, content: 'That server is not online.' });
    }
    const groups = adonis.teams(serverId);
    if (!groups.length) {
      return interaction.reply({ ephemeral: true, content: serverId ? 'That server is empty.' : 'Nobody is online.' });
    }
    const head = serverId ? `**Players in \`${serverId.slice(0, 24)}\`**` : '**Players across every live server**';
    const body = groups.slice(0, 10).map(g => {
      const names = g.members.slice(0, 25).map(m => m.displayName || m.name || m.userId).join(', ');
      const extra = g.members.length > 25 ? ` …+${g.members.length - 25}` : '';
      return `__${g.team}__ (${g.count})\n${names}${extra}`;
    }).join('\n\n');
    return interaction.reply({ ephemeral: true, content: `${head}\n\n${body}`.slice(0, 1950) });
  }

  if (sub === 'whereis') {
    const q = interaction.options.getString('player');
    const hits = adonis.findPlayer(q);
    if (!hits.length) return interaction.reply({ ephemeral: true, content: `No live player matches "${q}".` });
    const lines = hits.slice(0, 15).map(p =>
      `**${p.displayName || p.name}**${p.name && p.displayName && p.name !== p.displayName ? ` (@${p.name})` : ''}`
      + ` · \`${p.serverId.slice(0, 20)}\`${p.team ? ` · ${p.team}` : ''}${p.rank ? ` · ${p.rank}` : ''}`);
    return interaction.reply({ ephemeral: true, content: `**${hits.length} match(es) for "${q}"**\n${lines.join('\n')}`.slice(0, 1950) });
  }

  if (sub === 'run') {
    const gate = await mayRun(interaction);
    if (!gate.ok) return interaction.reply({ ephemeral: true, content: gate.why });

    const command  = interaction.options.getString('command');
    const serverId = interaction.options.getString('server') || '';
    const by = {
      userId: gate.user.id, discordId: String(interaction.user.id),
      name: gate.user.displayName || gate.user.discordUsername || interaction.user.username,
    };
    const r = adonis.queueCommand({ command, serverId, source: 'discord', by });
    if (r.error) return interaction.reply({ ephemeral: true, content: r.error });

    try {
      require('./audit').record({
        action: 'ADONIS_COMMAND', category: 'game',
        actorId: gate.user.id, actorName: by.name, actorRole: gate.user.role,
        targetType: 'roblox_server', targetId: serverId || 'ALL',
        summary: `Ran "${command}" on ${serverId || 'every live server'} (${r.targets} server(s)) from Discord`,
        metadata: { command, serverId: serverId || null, targets: r.targets, commandId: r.id },
      });
    } catch (e) {}
    console.log(`[Adonis] ${by.name} queued "${command}" for ${r.targets} server(s) from Discord`);

    return interaction.reply({ ephemeral: true, content:
      `Queued \`${command}\`\nOn: ${serverId ? `\`${serverId.slice(0, 24)}\`` : `every live server (${r.targets})`}\n`
      + `It runs the next time each server checks in, within about fifteen seconds.` });
  }
}

module.exports = { COMMAND, GUILD_ID, buildCommand, handle, handleAutocomplete };
