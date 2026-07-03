// scripts/import-forum-cases.js
//
// CLI alternative to the /import-cases slash command. Bulk-imports cases from a
// Discord forum channel into the website.
//
// USAGE:
//   node scripts/import-forum-cases.js <forumChannelId> [--dry]
//   node scripts/import-forum-cases.js            (reads IMPORT_FORUM_CHANNEL_ID)
//
// Requires env: DISCORD_BOT_TOKEN, DATABASE_URL. The bot must be in the guild,
// able to view the forum channel, and have the MESSAGE CONTENT intent enabled.
require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { importForumCases } = require('../server/lib/forumImport');

const CHANNEL_ID = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : process.env.IMPORT_FORUM_CHANNEL_ID;
const DRY_RUN = process.argv.includes('--dry');

(async () => {
  if (!CHANNEL_ID) { console.error('Provide the forum channel ID (arg or IMPORT_FORUM_CHANNEL_ID).'); process.exit(1); }
  if (!process.env.DISCORD_BOT_TOKEN) { console.error('DISCORD_BOT_TOKEN is required.'); process.exit(1); }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });

  await client.login(process.env.DISCORD_BOT_TOKEN);
  await new Promise(res => client.once('ready', res));
  console.log('Bot ready.', DRY_RUN ? '(DRY RUN)' : '');

  try {
    const summary = await importForumCases(client, CHANNEL_ID, { dry: DRY_RUN, onProgress: m => console.log('  ' + m) });
    console.log('\n=== Summary ===');
    console.log(JSON.stringify(summary, null, 2));
  } catch (e) {
    console.error('Import failed:', e.message);
  } finally {
    await client.destroy();
    process.exit(0);
  }
})().catch(e => { console.error(e); process.exit(1); });
