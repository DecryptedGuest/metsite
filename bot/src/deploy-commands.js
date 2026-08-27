// Register the slash commands with Discord. Run once after any command change:
//   npm run deploy
// Guild-scoped registration is instant; global takes up to an hour to appear.
require('dotenv').config();
const { REST, Routes } = require('discord.js');
const { assertEnv, env } = require('./lib/env');

assertEnv();

const commands = [
  require('./commands/discipline'),
  require('./commands/check-record'),
  require('./commands/xp'),
  require('./commands/loa'),
  require('./commands/pendingjoin'),
  require('./commands/promote'),
  require('./commands/ia'),
  require('./commands/submit-case'),
  require('./commands/leaderboard'),
  require('./commands/sync'),
  require('./commands/qp').addQp,
  require('./commands/qp').removeQp,
].map(c => c.data.toJSON());

(async () => {
  const rest = new REST({ version: '10' }).setToken(env('DISCORD_BOT_TOKEN'));
  try {
    await rest.put(
      Routes.applicationGuildCommands(env('DISCORD_CLIENT_ID'), env('DISCORD_GUILD_ID')),
      { body: commands },
    );
    console.log(`✅ Registered ${commands.length} commands in guild ${env('DISCORD_GUILD_ID')}:`);
    for (const c of commands) console.log(`   /${c.name}`);
  } catch (err) {
    console.error('❌ Command registration failed:', err.message);
    process.exit(1);
  }
})();
