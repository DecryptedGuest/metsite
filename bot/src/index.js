// METAdministration — MET server Discord bot.
// Discipline, quota points, LOA, Roblox group admin, and IA cases/tickets.
require('dotenv').config();

const { Client, GatewayIntentBits, Collection, MessageFlags } = require('discord.js');
const { assertEnv, env } = require('./lib/env');
const perms  = require('./lib/perms');
const roblox = require('./lib/roblox');
const { startQuotaWorker } = require('./lib/quota');
const { startExpiryWorker } = require('./lib/discipline');
const { handleReviewButton } = require('./lib/reviewCard');

assertEnv();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

// ── Command registry ──────────────────────────────────────────────
const COMMANDS = [
  require('./commands/discipline'),
  require('./commands/check-record'),
  require('./commands/xp'),
  require('./commands/loa'),
  require('./commands/pendingjoin'),
  require('./commands/promote'),
  require('./commands/ia'),
];
client.commands = new Collection(COMMANDS.map(c => [c.data.name, c]));

// ── Guild helpers ─────────────────────────────────────────────────
// Every one of these fails soft: a not-ready client or a missing role must
// never throw out of an interaction handler.
let ready = false;
const roleHolderCache = new Map();   // `${guildId}:${roleId}` -> { at, set }

const bot = {
  async assignRole(discordUserId, roleId) {
    if (!ready) { console.warn('Bot not ready — cannot assign role'); return false; }
    const guildId = env('DISCORD_GUILD_ID');
    if (!guildId || !roleId) return false;
    try {
      const guild  = await client.guilds.fetch(guildId);
      const member = await guild.members.fetch(discordUserId);
      await member.roles.add(roleId);
      console.log(`Role ${roleId} assigned to ${discordUserId}`);
      return true;
    } catch (err) {
      console.error(`Failed to assign role ${roleId} to ${discordUserId}: ${err.message}`);
      return false;
    }
  },

  async removeRole(discordUserId, roleId) {
    if (!ready) { console.warn('Bot not ready — cannot remove role'); return false; }
    const guildId = env('DISCORD_GUILD_ID');
    if (!guildId || !roleId) return false;
    try {
      const guild  = await client.guilds.fetch(guildId);
      const member = await guild.members.fetch(discordUserId);
      await member.roles.remove(roleId);
      console.log(`Role ${roleId} removed from ${discordUserId}`);
      return true;
    } catch (err) {
      console.error(`Failed to remove role ${roleId} from ${discordUserId}: ${err.message}`);
      return false;
    }
  },

  /** Digit-only Discord ids holding `roleId`, or null if unreadable. Cached 5 min. */
  async getRoleHolders(guildId, roleId) {
    if (!ready || !guildId || !roleId) return null;
    const key = `${guildId}:${roleId}`;
    const hit = roleHolderCache.get(key);
    if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.set;
    try {
      const guild   = await client.guilds.fetch(guildId);
      const members = await guild.members.fetch();
      const set = new Set();
      members.forEach(m => { if (m.roles.cache.has(roleId)) set.add(String(m.user.id).replace(/\D/g, '')); });
      roleHolderCache.set(key, { at: Date.now(), set });
      return set;
    } catch (err) {
      console.warn('[bot] role holder lookup failed:', err.message);
      return null;
    }
  },

  /** Make `discordId` the only holder of `roleId`. Falsy id clears it from everyone. */
  async setExclusiveRoleHolder(guildId, roleId, discordId) {
    if (!ready || !guildId || !roleId) return { ok: false, error: 'bot not ready or role not configured' };
    try {
      const guild = await client.guilds.fetch(guildId);
      const role  = await guild.roles.fetch(roleId).catch(() => null);
      if (!role) return { ok: false, error: 'role not found in guild' };

      await guild.members.fetch();               // populate role.members
      const want = discordId ? String(discordId).replace(/\D/g, '') : null;
      let removed = 0;
      for (const [, m] of role.members) {
        if (String(m.user.id) !== want) { await m.roles.remove(roleId).catch(() => {}); removed++; }
      }
      if (want) {
        const target = await guild.members.fetch(want).catch(() => null);
        if (target) await target.roles.add(roleId).catch(() => {});
      }
      roleHolderCache.delete(`${guildId}:${roleId}`);
      return { ok: true, removed };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },
};

// ── Interactions ──────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      const cmd = client.commands.get(interaction.commandName);
      if (cmd?.autocomplete) await cmd.autocomplete(interaction);
      return;
    }

    if (interaction.isButton()) {
      const id = interaction.customId || '';
      if (id.startsWith('ia:'))       return handleReviewButton(interaction, bot);
      if (id.startsWith('xp:reset:')) return require('./commands/xp').handleButton(interaction);
      return;
    }

    if (!interaction.isChatInputCommand()) return;
    const cmd = client.commands.get(interaction.commandName);
    if (!cmd) return;
    await cmd.execute(interaction, bot);
  } catch (err) {
    console.error(`[interaction] ${interaction.commandName || interaction.customId} failed:`, err);
    const body = { content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) await interaction.editReply(body).catch(() => {});
    else await interaction.reply(body).catch(() => {});
  }
});

client.once('clientReady', async () => {
  ready = true;
  console.log(`🤖  Discord bot online as ${client.user.tag}`);
  await roblox.initCsrf();
  startExpiryWorker(bot);
  startQuotaWorker();
});

client.on('error', err => console.error('Discord client error:', err.message));
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));

client.login(env('DISCORD_BOT_TOKEN')).catch(err => {
  console.error('Login failed:', err.message);
  process.exit(1);
});
