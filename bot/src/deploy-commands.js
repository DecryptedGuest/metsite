// Register the slash commands, each in its own server.
//
//   npm run deploy            both servers
//   npm run deploy -- ia      just Internal Affairs
//   npm run deploy -- met     just MET
//
// Guild-scoped registration is instant. Registering a guild's exact set also
// REMOVES anything previously registered there that is no longer in the set,
// which is what clears MET commands out of the IA server (and vice versa).
require('dotenv').config();
const { REST, Routes } = require('discord.js');
const { assertEnv, env } = require('./lib/env');
const { IA, MET } = require('./lib/commands');

assertEnv();

const only = (process.argv[2] || '').toLowerCase();

const TARGETS = [
  { scope: 'ia',  label: 'Internal Affairs', guildId: env('IA_GUILD_ID'),  commands: IA  },
  { scope: 'met', label: 'MET',              guildId: env('MET_GUILD_ID'), commands: MET },
];

(async () => {
  const rest = new REST({ version: '10' }).setToken(env('DISCORD_BOT_TOKEN'));
  let failed = false;

  for (const t of TARGETS) {
    if (only && only !== t.scope) continue;
    if (!t.guildId) {
      console.error(`❌ ${t.label}: no guild id set — fill in ${t.scope.toUpperCase()}_GUILD_ID`);
      failed = true;
      continue;
    }
    try {
      await rest.put(
        Routes.applicationGuildCommands(env('DISCORD_CLIENT_ID'), t.guildId),
        { body: t.commands.map(c => c.data.toJSON()) },
      );
      console.log(`✅ ${t.label} (${t.guildId}) — ${t.commands.length} commands:`);
      for (const c of t.commands) console.log(`     /${c.data.name}`);
    } catch (err) {
      console.error(`❌ ${t.label} registration failed:`, err.message);
      failed = true;
    }
  }

  // Global commands would appear in EVERY server the bot joins, defeating the
  // split entirely. Clear any that a previous deploy left behind.
  try {
    const globals = await rest.get(Routes.applicationCommands(env('DISCORD_CLIENT_ID')));
    if (globals.length) {
      await rest.put(Routes.applicationCommands(env('DISCORD_CLIENT_ID')), { body: [] });
      console.log(`🧹 Cleared ${globals.length} stale global command(s).`);
    }
  } catch (err) {
    console.warn('⚠️  Could not check global commands:', err.message);
  }

  process.exit(failed ? 1 : 0);
})();
