// server/lib/bot.js
// Discord.js bot — runs in the same process as Express.
// Handles: role assignment after case approval, member lookup.

const { Client, GatewayIntentBits, Partials, SlashCommandBuilder,
        EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, UserSelectMenuBuilder } = require('discord.js');

// The bulk-import feature needs to read forum starter messages, and the ticket
// transcript import needs to read Tickety's log embeds + "View Transcript"
// button links — both require the (privileged) Message Content intent. We only
// request it when an import guild OR a ticket-log channel is configured, so the
// main bot is unaffected if you use neither.
const IMPORT_GUILD_ID = process.env.IMPORT_GUILD_ID;
// Where the Tickety bot posts its closed-ticket logs. Defaults to the IA server's
// #ticket-logs channel; override via env if your setup differs.
const TICKET_LOG_GUILD_ID   = process.env.TICKET_LOG_GUILD_ID   || '1191048287315304470';
const TICKET_LOG_CHANNEL_ID = process.env.TICKET_LOG_CHANNEL_ID || '1455877424582492264';
// MessageContent is a PRIVILEGED intent: if it isn't enabled in the Discord
// Developer Portal, requesting it makes login fail outright. We want it (to read
// forum starter messages + Tickety transcript logs), but must never take the
// whole bot offline over it — so startBot() logs in WITH it and transparently
// retries WITHOUT it if the portal rejects it (role assignment etc. keep working).
// Patrol-log + event-log channels — the bot reads new logs here (needs Message
// Content) and reacts ✅/❌ once the site approves/denies them.
const PATROL_CHANNEL_ID    = process.env.PATROL_CHANNEL_ID || null;
const EVENTLOGS_CHANNEL_ID = process.env.EVENTLOGS_CHANNEL_ID || null;
const WANT_MESSAGE_CONTENT = !!(IMPORT_GUILD_ID || TICKET_LOG_CHANNEL_ID || PATROL_CHANNEL_ID || EVENTLOGS_CHANNEL_ID);

let ready = false;
let client;

async function onReady() {
  ready = true;
  console.log(`🤖  Discord bot online as ${client.user.tag}`);
  await registerImportCommand();
}

function buildClient(withMessageContent) {
  const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers];
  if (withMessageContent) intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
  const c = new Client({ intents, partials: [Partials.GuildMember] });
  c.once('ready', onReady);
  c.on('interactionCreate', onInteraction);
  if (withMessageContent) c.on('messageCreate', onPatrolMessage);
  c.on('error', err => console.error('Discord bot error:', err.message));
  return c;
}

client = buildClient(WANT_MESSAGE_CONTENT);

// Register the dev-only /import-cases command in the import guild
async function registerImportCommand() {
  if (!IMPORT_GUILD_ID) return;
  try {
    const guild = await client.guilds.fetch(IMPORT_GUILD_ID);
    await guild.commands.set([
      new SlashCommandBuilder()
        .setName('import-cases')
        .setDescription('Bulk-import cases from a forum channel into the website')
        .addChannelOption(o => o.setName('channel').setDescription('The forum channel to import from').setRequired(true))
        .addBooleanOption(o => o.setName('dry').setDescription('Preview only — write nothing'))
        // Visible to everyone in the (private) import guild; execution is gated
        // in code to the developer user ID below — so admins see it but can't run it.
        .toJSON(),
    ]);
    console.log(`🤖  /import-cases registered in guild ${IMPORT_GUILD_ID}`);
  } catch (err) {
    console.error('Failed to register /import-cases:', err.message);
  }
}

// Handle the import slash command (restricted to the developer user)
async function onInteraction(interaction) {
  // Tryout DM buttons / co-host select menu.
  if (interaction.isButton() || (interaction.isUserSelectMenu && interaction.isUserSelectMenu())) {
    if ((interaction.customId || '').startsWith('tryout_')) {
      return handleTryoutComponent(interaction).catch(e => console.error('[Bot] tryout component error:', e.message));
    }
    return;
  }

  if (!interaction.isChatInputCommand() || interaction.commandName !== 'import-cases') return;

  const DEV = process.env.DEVELOPER_DISCORD_ID || '1227866745201627137';
  if (interaction.user.id !== DEV) {
    return interaction.reply({ content: '⛔ You are not authorised to use this command.', flags: 64 });
  }

  const channel = interaction.options.getChannel('channel');
  const dry     = interaction.options.getBoolean('dry') || false;
  await interaction.deferReply({ flags: 64 }); // 64 = EPHEMERAL

  // Send the very first reply immediately so Discord doesn't expire the token
  await interaction.editReply('⏳ Starting import — fetching forum posts…').catch(() => {});

  const { importForumCases } = require('./forumImport');
  // Update Discord on every progress event — keep-alive interval handles rate limiting.
  const onProgress = (msg) => {
    interaction.editReply(`⏳ ${msg}`).catch(() => {});
  };

  // Keep-alive: ping Discord every 10s so the deferred reply token stays valid
  const keepAlive = setInterval(() => {
    interaction.editReply('⏳ Still working…').catch(() => {});
  }, 10_000);

  try {
    const s = await importForumCases(client, channel.id, { dry, onProgress });
    clearInterval(keepAlive);
    if (s.dry) {
      const header =
        `🔎 **Dry run** — found **${s.parsed}** cases, skipped **${s.skipped}** (bad title format).\n` +
        `Status: Pending **${s.byStatus.PENDING}** · Approved **${s.byStatus.APPROVED}** · Denied **${s.byStatus.DENIED}**\n` +
        `Docs linked: **${s.preview.filter(p => p.caseLink).length}** of first ${s.preview.length} shown.\n\n` +
        `Run again without **dry** to import all ${s.parsed} cases.`;
      // Build a compact table capped at 1800 chars to stay under Discord's 2000 limit
      const lines = [];
      for (const p of s.preview) {
        const inv = p.investigator ? ` · ${p.investigator}` : '';
        const pun = p.punishments  ? ` · ${p.punishments.slice(0, 35)}` : '';
        const lnk = p.caseLink     ? ' ✓' : ' ✗';
        lines.push(`${p.caseRef} ${p.username} · ${p.status}${lnk}${inv}${pun}`);
      }
      const table = lines.join('\n');
      const preview = table.length > 1400 ? table.slice(0, 1400) + '\n…(truncated)' : table;
      await interaction.editReply(`${header}\n\`\`\`\n${preview}\n\`\`\``);
    } else {
      await interaction.editReply(
        `✅ **Import complete** — created **${s.created}** cases (parsed ${s.parsed}, skipped ${s.skipped} bad-format).\n` +
        `Status: Pending ${s.byStatus.PENDING} · Approved ${s.byStatus.APPROVED} · Denied ${s.byStatus.DENIED}\n` +
        `Cases are numbered #1 … #${s.created} oldest → newest.`,
      );
    }
  } catch (err) {
    clearInterval(keepAlive);
    await interaction.editReply('❌ Import failed: ' + err.message).catch(() => {});
  }
}

/**
 * Start the bot. Called from server/index.js at startup.
 */
function startBot() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.warn('⚠  No DISCORD_BOT_TOKEN set — bot features disabled.');
    return;
  }
  client.login(token).catch(err => {
    const disallowed = err && (/disallowed intent/i.test(err.message || '') || err.code === 'DisallowedIntents');
    if (WANT_MESSAGE_CONTENT && disallowed) {
      console.warn('⚠  Message Content intent is NOT enabled in the Discord Developer Portal — starting the bot WITHOUT it. Role assignment still works, but forum + ticket-transcript reads are disabled until you enable "Message Content Intent" in the portal.');
      client = buildClient(false);
      client.login(token).catch(e => console.error('Bot login failed (fallback):', e.message));
    } else {
      console.error('Bot login failed:', err.message);
    }
  });
}

/**
 * Fetch a guild member's display name (server nickname > global username).
 * Returns null if not found or bot not ready.
 */
async function getMemberDisplayName(discordUserId) {
  if (!ready) return null;
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) return null;

  try {
    const guild  = await client.guilds.fetch(guildId);
    const member = await guild.members.fetch(discordUserId);
    return member.displayName || member.user.username;
  } catch {
    return null;
  }
}

// A member's display name (nickname) and avatar URL in a SPECIFIC guild.
// Used for the administrative-log "Signed, <name>" author. Returns null if the
// bot can't read that guild or the member isn't in it.
async function getGuildMemberInfo(discordUserId, guildId) {
  if (!ready || !guildId || !discordUserId) return null;
  try {
    const guild  = await client.guilds.fetch(guildId);
    const member = await guild.members.fetch(discordUserId);
    return {
      displayName: member.displayName || member.user.username,
      avatar:      member.user.displayAvatarURL({ size: 128, extension: 'png' }),
    };
  } catch {
    return null;
  }
}

/**
 * Assign a role to a guild member.
 * @param {string} discordUserId  — the member to assign to
 * @param {string} roleId         — Discord role ID to assign
 */
async function assignRole(discordUserId, roleId) {
  if (!ready) {
    console.warn('Bot not ready — cannot assign role');
    return false;
  }
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId || !roleId) return false;

  try {
    const guild  = await client.guilds.fetch(guildId);
    const member = await guild.members.fetch(discordUserId);
    await member.roles.add(roleId);
    console.log(`Role ${roleId} assigned to ${discordUserId}`);
    return true;
  } catch (err) {
    console.error(`Failed to assign role ${roleId} to ${discordUserId}:`, err.message);
    return false;
  }
}

/**
 * Look up a user's display name in the guild by their Discord user ID.
 * Used to resolve officer names when a case is submitted.
 */
async function lookupMember(discordUserId) {
  if (!ready) return null;
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) return null;

  try {
    const guild  = await client.guilds.fetch(guildId);
    const member = await guild.members.fetch(discordUserId);
    return {
      id:          member.user.id,
      username:    member.user.username,
      displayName: member.displayName || member.user.username,
      avatar:      member.user.displayAvatarURL({ size: 64 }),
    };
  } catch {
    return null;
  }
}

/**
 * Fetch a member's presence + role IDs in the guild.
 * Returns { inDiscord: true|false|null, roleIds, displayName, username }.
 *   inDiscord === null  → bot not ready / no guild configured (unknown)
 *   inDiscord === false → confirmed not a member
 */
async function getMemberRecord(discordUserId) {
  const unknown = { inDiscord: null, roleIds: [], displayName: null, username: null };
  if (!ready) return unknown;
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) return unknown;

  try {
    const guild  = await client.guilds.fetch(guildId);
    const member = await guild.members.fetch(discordUserId);
    return {
      inDiscord:   true,
      roleIds:     [...member.roles.cache.keys()],
      displayName: member.displayName || member.user.username,
      username:    member.user.username,
    };
  } catch {
    // Unknown member → not in the guild
    return { inDiscord: false, roleIds: [], displayName: null, username: null };
  }
}

/**
 * Find a guild member by Discord username or server nickname.
 * Returns { id, username, displayName, roleIds, inDiscord:true } or null.
 */
async function findMemberByUsername(query) {
  if (!ready || !query) return null;
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) return null;

  try {
    const guild   = await client.guilds.fetch(guildId);
    const results = await guild.members.fetch({ query, limit: 10 });
    if (!results || results.size === 0) return null;

    const q = String(query).toLowerCase().replace(/^@/, '');
    const member =
      results.find(m => m.user.username.toLowerCase() === q) ||
      results.find(m => (m.displayName || '').toLowerCase() === q) ||
      results.first();

    return {
      id:          member.user.id,
      username:    member.user.username,
      displayName: member.displayName || member.user.username,
      roleIds:     [...member.roles.cache.keys()],
      inDiscord:   true,
    };
  } catch {
    return null;
  }
}

/**
 * Remove a role from a guild member.
 */
async function removeRole(discordUserId, roleId) {
  if (!ready) { console.warn('Bot not ready — cannot remove role'); return false; }
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId || !roleId) return false;

  try {
    const guild  = await client.guilds.fetch(guildId);
    const member = await guild.members.fetch(discordUserId);
    await member.roles.remove(roleId);
    console.log(`Role ${roleId} removed from ${discordUserId}`);
    return true;
  } catch (err) {
    console.error(`Failed to remove role ${roleId} from ${discordUserId}:`, err.message);
    return false;
  }
}

/**
 * Check for expired CasePunishments and remove the corresponding Discord roles.
 * Called on startup and every 5 minutes.
 */
async function checkExpiredPunishments() {
  const prisma = require('./db');
  try {
    const expired = await prisma.casePunishment.findMany({
      where: {
        expiresAt:   { lte: new Date() },
        roleRemoved: false,
        roleId:      { not: null },
      },
      include: { case: { select: { officerDiscordId: true, caseRef: true } } },
    });

    for (const p of expired) {
      if (p.case?.officerDiscordId && p.roleId) {
        const removed = await removeRole(p.case.officerDiscordId, p.roleId);
        if (removed) {
          await prisma.casePunishment.update({
            where: { id: p.id },
            data:  { roleRemoved: true },
          });
          console.log(`Expired role ${p.roleId} removed from ${p.case.officerDiscordId} (${p.case.caseRef})`);
        }
      }
    }
  } catch (err) {
    console.error('Role expiry checker error:', err.message);
  }
}

function startRoleExpiryChecker() {
  checkExpiredPunishments();
  setInterval(checkExpiredPunishments, 5 * 60 * 1000);
}

// ── RoVer nickname fallback ───────────────────────────────────────
// Members are nicknamed "RANK | RobloxUsername" (e.g. "CON | realangeloo").
// When RoVer can't resolve a link, we parse this to bridge Discord ↔ Roblox.
function parseRankNick(nick) {
  if (!nick) return { rank: null, robloxUsername: null };
  const s = String(nick).trim();
  const i = s.indexOf('|');
  if (i >= 0) {
    return {
      rank:           s.slice(0, i).trim() || null,
      robloxUsername: s.slice(i + 1).trim().replace(/\s+/g, '') || null,
    };
  }
  // No separator — treat the whole thing as a possible Roblox username
  return { rank: null, robloxUsername: s.replace(/\s+/g, '') || null };
}

// Discord ID → Roblox username parsed from their server nickname (RoVer fallback).
async function getRobloxNameFromNick(discordUserId) {
  const rec = await getMemberRecord(discordUserId);
  if (!rec || rec.inDiscord !== true) return null;
  return parseRankNick(rec.displayName).robloxUsername;
}

// Cached full guild member list (5-min TTL) for nickname scans.
let _memberCache = null, _memberCacheAt = 0;
async function getAllGuildMembers() {
  if (!ready) return null;
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) return null;
  if (_memberCache && Date.now() - _memberCacheAt < 5 * 60 * 1000) return _memberCache;
  try {
    const guild   = await client.guilds.fetch(guildId);
    const members = await guild.members.fetch(); // requires GuildMembers intent
    _memberCache = members; _memberCacheAt = Date.now();
    return members;
  } catch (err) {
    console.error('getAllGuildMembers error:', err.message);
    return null;
  }
}

// Return a Set of (digit-only) Discord user IDs who hold `roleId` in `guildId`.
// Used for the quota reduction role. Returns null if the bot can't read that
// guild (not in it / not ready) so callers can safely skip the reduction.
const _roleHolderCache = {}; // key `${guildId}:${roleId}` -> { at, set }
async function getRoleHolders(guildId, roleId) {
  if (!ready || !guildId || !roleId) return null;
  const key = `${guildId}:${roleId}`;
  const cached = _roleHolderCache[key];
  if (cached && Date.now() - cached.at < 60 * 1000) return cached.set;
  try {
    const guild   = await client.guilds.fetch(guildId);
    const members = await guild.members.fetch(); // requires GuildMembers intent
    const set = new Set();
    members.forEach(m => { if (m.roles.cache.has(roleId)) set.add(String(m.user.id).replace(/\D/g, '')); });
    _roleHolderCache[key] = { at: Date.now(), set };
    return set;
  } catch (err) {
    console.warn('[bot] getRoleHolders error for', key, '-', err.message);
    return null;
  }
}

// Make `discordId` the ONLY holder of `roleId` in `guildId`: remove the role
// from every current holder except the target, then add it to the target. If
// the target already has it (and is the only one), nothing changes. Pass a
// falsy discordId to simply clear the role from everyone.
async function setExclusiveRoleHolder(guildId, roleId, discordId) {
  if (!ready || !guildId || !roleId) return { ok: false, error: 'bot not ready or missing ids' };
  const wantDigits = (discordId || '').toString().replace(/\D/g, '');
  try {
    const guild = await client.guilds.fetch(guildId);
    const role  = await guild.roles.fetch(roleId).catch(() => null);
    if (!role) return { ok: false, error: 'role not found in guild' };

    await guild.members.fetch(); // populate role.members
    let removed = 0, assigned = false;

    for (const [, m] of role.members) {
      if (String(m.user.id) !== wantDigits) { await m.roles.remove(roleId).catch(() => {}); removed++; }
      else assigned = true; // target already holds it
    }
    if (wantDigits && !assigned) {
      const target = await guild.members.fetch(wantDigits).catch(() => null);
      if (!target) return { ok: false, error: 'target member not in guild', removed };
      await target.roles.add(roleId).catch(() => {});
      assigned = true;
    }
    // Invalidate the cached holder set so quota reflects the change immediately.
    delete _roleHolderCache[`${guildId}:${roleId}`];
    return { ok: true, removed, assigned: !!wantDigits && assigned };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Roblox username → Discord member by scanning server nicknames (reverse RoVer fallback).
// Full MET-server profile for a Discord member: their nickname, the Roblox
// username + rank parsed from that nick, and every role NAME they hold (not just
// ids). Reads the primary guild (DISCORD_GUILD_ID = the MET server) unless an
// explicit guildId is passed. Returns null if the bot is down or they're not in
// the server. Used by the officer 360 to show MET details for anyone — even
// members who never signed into the dashboard.
async function getMetMemberProfile(discordUserId, guildId) {
  if (!ready || !discordUserId) return null;
  const gId = targetGuildId(guildId);
  if (!gId) return null;
  try {
    const guild  = await guild_(gId);
    const member = await guild.members.fetch(String(discordUserId));
    const parsed = parseRankNick(member.displayName || member.user.username);
    const roles  = [...member.roles.cache.values()]
      .filter(r => r.name && r.name !== '@everyone')
      .sort((a, b) => b.position - a.position)
      .map(r => ({ id: r.id, name: r.name, color: r.hexColor && r.hexColor !== '#000000' ? r.hexColor : null }));
    return {
      inServer:    true,
      discordId:   member.user.id,
      username:    member.user.username,
      nick:        member.displayName || member.user.username,
      avatar:      member.user.displayAvatarURL({ size: 128, extension: 'png' }),
      robloxName:  parsed.robloxUsername || null,
      rank:        parsed.rank || null,
      roles,
      joinedAt:    member.joinedAt ? member.joinedAt.toISOString() : null,
      timedOutUntil: member.communicationDisabledUntil ? member.communicationDisabledUntil.toISOString() : null,
    };
  } catch (e) {
    return null;
  }
}

async function findMemberByRobloxNick(robloxUsername) {
  const target = String(robloxUsername || '').trim().toLowerCase();
  if (!target) return null;
  const members = await getAllGuildMembers();
  if (!members) return null;
  let found = null;
  members.forEach(m => {
    if (found) return;
    const parsed = parseRankNick(m.displayName || m.user.username);
    if (parsed.robloxUsername && parsed.robloxUsername.toLowerCase() === target) found = m;
  });
  if (!found) return null;
  return {
    id:          found.user.id,
    username:    found.user.username,
    displayName: found.displayName || found.user.username,
    roleIds:     [...found.roles.cache.keys()],
    rank:        parseRankNick(found.displayName || found.user.username).rank,
    inDiscord:   true,
  };
}

// ── Ticket transcript matching (Tickety logs) ─────────────────────
// Given a "View Transcript" link the IA member pasted, scan the recent
// closed-ticket logs in the Tickety log channel, find the message whose
// transcript button URL matches, and return the parsed log so the ticket form
// can be autofilled. Returns { matched:false } when nothing lines up.
//
// `scan` is how many recent messages to look through (default 100 ≫ the "past 5
// closed logs" mentioned in the spec — matching by exact transcript URL can't
// mis-match, so scanning more only makes it more reliable).
async function matchTicketTranscript(transcriptLink, opts = {}) {
  const { normalizeUrl, parseTicketLogEmbed, transcriptUrlFromComponents } = require('./ticketLog');
  const scan = opts.scan || 100;

  if (!ready) return { matched: false, error: 'bot not ready' };
  if (!transcriptLink || !String(transcriptLink).trim()) return { matched: false, error: 'no link' };
  if (!TICKET_LOG_GUILD_ID || !TICKET_LOG_CHANNEL_ID)     return { matched: false, error: 'ticket log channel not configured' };

  const want = normalizeUrl(transcriptLink);
  if (!want) return { matched: false, error: 'invalid link' };

  let channel;
  try {
    const guild = await client.guilds.fetch(TICKET_LOG_GUILD_ID);
    channel = await guild.channels.fetch(TICKET_LOG_CHANNEL_ID);
  } catch (e) {
    return { matched: false, error: `cannot access ticket log channel: ${e.message}` };
  }
  if (!channel || typeof channel.messages?.fetch !== 'function') {
    return { matched: false, error: 'ticket log channel is not a text channel' };
  }

  // Page back through recent messages (100 per fetch) until we hit `scan`.
  let before, seen = 0, guard = 0;
  while (seen < scan && guard++ < 20) {
    let page;
    try {
      page = await channel.messages.fetch({ limit: 100, before });
    } catch (e) {
      return { matched: false, error: `cannot read ticket logs: ${e.message}` };
    }
    if (!page || page.size === 0) break;

    for (const [, msg] of page) {
      seen++;
      const url = transcriptUrlFromComponents(msg.components);
      if (!url || normalizeUrl(url) !== want) continue;

      // Match — parse the first Tickety-looking embed on the message.
      let log = null;
      for (const embed of msg.embeds || []) {
        const parsed = parseTicketLogEmbed(embed);
        if (parsed) { log = parsed; break; }
      }
      if (!log) return { matched: false, error: 'matched a message but could not parse its embed' };

      return {
        matched: true,
        log: {
          ...log,
          transcriptUrl: url,
          sentAt: (msg.createdAt || new Date(msg.createdTimestamp || Date.now())).toISOString(),
        },
      };
    }

    before = page.last()?.id;
    if (!before) break;
  }

  return { matched: false, error: 'no matching transcript found in recent ticket logs' };
}

// ─────────────────────────────────────────────────────────────────
// MET tryouts — DM the host when their tryout fires, with buttons to pick a
// co-host and post the announcement. Interaction handlers live in
// onInteraction (customIds prefixed "tryout_").
// ─────────────────────────────────────────────────────────────────

// The action buttons attached to a host's tryout DM: pick a co-host, and
// post/update the channel announcement. The announce label reflects whether the
// announcement has already gone out (the game flow auto-announces first).
function tryoutHostDmButtons(tryout) {
  const announced = !!tryout.announcementMsgId;
  const joinable  = !!tryout.joinable;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tryout_cohost_${tryout.id}`).setLabel('Pick Co-Host').setStyle(ButtonStyle.Secondary),
  );
  // No manual "Update Announcement" — once posted, the announcement updates
  // itself automatically on any change (co-host, lock state, join link). We only
  // offer a one-time "Send Announcement" when it hasn't gone out yet.
  if (!announced) {
    row.addComponents(new ButtonBuilder().setCustomId(`tryout_announce_${tryout.id}`).setLabel('Send Announcement').setStyle(ButtonStyle.Success));
  }
  row.addComponents(new ButtonBuilder().setCustomId(`tryout_join_${tryout.id}`).setLabel(joinable ? 'Remove Join Link' : 'Post Join Link').setStyle(joinable ? ButtonStyle.Danger : ButtonStyle.Primary));
  return row;
}

// DM the host their tryout details + action buttons. Returns the DM message id.
async function sendTryoutHostDM(tryout) {
  if (!ready) { console.warn('[Tryout] bot not ready — cannot DM host'); return null; }
  try {
    const user  = await client.users.fetch(tryout.hostDiscordId);
    const cfg   = require('./tryouts').divisionConfig(tryout.division);
    const embed = new EmbedBuilder()
      .setColor(tryout.privateServerLink ? 0x2ed896 : 0xf5b730)
      .setTitle(cfg.dmTitle)
      .setDescription(`Your scheduled ${cfg.eventType} has started. Pick a co-host, then post the announcement when you\'re ready.`)
      .addFields(
        { name: 'Private server link', value: tryout.privateServerLink || 'Not provisioned — set `TRYOUT_PRIVATE_SERVER_LINK` (or configure dynamic creation).', inline: false },
        { name: 'Status', value: require('./tryouts').isServerLocked(tryout) ? 'Locked' : 'Unlocked', inline: true },
      );
    const msg = await user.send({ embeds: [embed], components: [tryoutHostDmButtons(tryout)] });
    return msg.id;
  } catch (e) {
    console.error('[Tryout] sendTryoutHostDM failed:', e.message);
    return null;
  }
}

// ── Patrol + event logs ───────────────────────────────────────────────
// A new message in PATROL_CHANNEL_ID / EVENTLOGS_CHANNEL_ID that looks like a
// log → capture it for site review. (Pure chat without "shift" and no image is
// ignored.)
async function onPatrolMessage(message) {
  try {
    if (message.author && message.author.bot) return;
    const ch = String(message.channelId);
    let type = null;
    if (PATROL_CHANNEL_ID && ch === String(PATROL_CHANNEL_ID)) type = 'PATROL';
    else if (EVENTLOGS_CHANNEL_ID && ch === String(EVENTLOGS_CHANNEL_ID)) type = 'EVENT';
    if (!type) return;
    if (!/shift/i.test(message.content || '') && message.attachments.size === 0) return; // not a log
    const { createFromMessage } = require('./patrolLog');
    await createFromMessage(message, type);
  } catch (e) {
    console.error('[Log] messageCreate error:', e.message);
  }
}

// Post a message (content and/or embeds) to a channel by id. Returns the message
// id, or null. Used as a delivery fallback when a webhook isn't configured.
async function postChannelMessage(channelId, payload) {
  if (!ready || !channelId || !payload) return null;
  try {
    const ch = await client.channels.fetch(String(channelId));
    const msg = await ch.send(payload);
    return msg.id;
  } catch (e) {
    console.warn('[Bot] postChannelMessage failed:', e.message);
    return null;
  }
}

// Edit a message the bot posted to a channel (by ids). Returns true on success.
async function editChannelMessage(channelId, messageId, payload) {
  if (!ready || !channelId || !messageId || !payload) return false;
  try {
    const ch  = await client.channels.fetch(String(channelId));
    const msg = await ch.messages.fetch(String(messageId));
    await msg.edit(payload);
    return true;
  } catch (e) {
    console.warn('[Bot] editChannelMessage failed:', e.message);
    return false;
  }
}

// React to a message with an emoji (used to mark a patrol log ✅ approved / ❌ denied).
async function reactToMessage(channelId, messageId, emoji) {
  if (!ready) return false;
  try {
    const ch  = await client.channels.fetch(String(channelId));
    const msg = await ch.messages.fetch(String(messageId));
    await msg.react(emoji);
    return true;
  } catch (e) {
    console.warn('[Patrol] reactToMessage failed:', e.message);
    return false;
  }
}

// Post the tryout announcement to the configured channel and record the message
// id on the tryout. Returns the message id, or null if it couldn't post.
async function postTryoutAnnouncement(tryout) {
  if (!ready) return null;
  const { formatAnnouncement, formatCidRecruitment, announcementAllowedMentions, divisionConfig, announceChannelId } = require('./tryouts');
  const chId = announceChannelId(tryout);
  if (!chId) { console.warn(`[Tryout] no announce channel configured for division ${tryout.division || 'HPC'} — cannot announce.`); return null; }
  try {
    const ch  = await client.channels.fetch(chId);
    const msg = await ch.send({ content: formatAnnouncement(tryout), allowedMentions: announcementAllowedMentions(tryout) });
    const data = { announcementSent: true, announcementMsgId: msg.id };

    // CID: auto-react ✅ so members react toward the 3-reaction start threshold.
    // TODO(CONFIRM): detect when 3 ✅ is reached and ping/notify the host.
    if (String(tryout.division).toUpperCase() === 'CID') await msg.react('✅').catch(() => {});

    // Optional CID recruitment cross-post (longer format in a second channel).
    const cfg = divisionConfig(tryout.division);
    if (cfg.division === 'CID' && cfg.recruitmentChannelId) {
      try {
        const rch  = await client.channels.fetch(cfg.recruitmentChannelId);
        const rmsg = await rch.send({ content: formatCidRecruitment(tryout), allowedMentions: announcementAllowedMentions(tryout) });
        data.recruitmentMsgId = rmsg.id;
      } catch (e) { console.warn('[Tryout] CID recruitment cross-post failed:', e.message); }
    }

    await require('./db').tryout.update({ where: { id: tryout.id }, data }).catch(() => {});
    return msg.id;
  } catch (e) {
    console.warn('[Tryout] postTryoutAnnouncement failed:', e.message);
    return null;
  }
}

// The host-DM status embed — a live "Status" field so it can be rebuilt
// identically when we edit the DM. While the tryout is running the Status
// tracks the server lock (🔒 Locked / 🔓 Unlocked); once the tryout is
// cancelled or concluded it flips to a terminal ❌ Cancelled / ✅ Concluded.
function tryoutDmEmbed(tryout, { reviewUrl } = {}) {
  const status = String(tryout.status || '').toUpperCase();
  const cfg    = require('./tryouts').divisionConfig(tryout.division);

  if (status === 'CANCELLED') {
    return new EmbedBuilder()
      .setColor(0xe74c3c)
      .setTitle(`${cfg.eventType} — Cancelled`)
      .setDescription('This tryout has been cancelled and its announcement removed from the channel.')
      .addFields({ name: 'Status', value: 'Cancelled', inline: true });
  }
  if (status === 'COMPLETED') {
    return new EmbedBuilder()
      .setColor(0x3b82f6)
      .setTitle(`${cfg.eventType} — Concluded`)
      .setDescription('This tryout has concluded and its announcement removed from the channel. Review and post the results on the site.')
      .addFields(
        { name: 'Status', value: 'Concluded', inline: true },
        ...(reviewUrl ? [{ name: 'Review & post results', value: reviewUrl, inline: false }] : []),
      );
  }

  const joinUrl = require('./tryouts').tryoutJoinUrl(tryout);
  return new EmbedBuilder()
    .setColor(cfg.dmColor || 0x2ed896)
    .setTitle(cfg.dmTitle)
    .setDescription(`Your tryout has started and been announced. Run it in-game from the ${cfg.panelName}, then conclude it to log the results.`)
    .addFields(
      { name: 'Status', value: require('./tryouts').isServerLocked(tryout) ? 'Locked' : 'Unlocked', inline: true },
      { name: 'Joining', value: tryout.joinable ? '🟢 Open — players can join via the link below' : '🔴 Closed', inline: true },
      ...(tryout.coHostName ? [{ name: 'Co-host', value: String(tryout.coHostName), inline: true }] : []),
      ...(joinUrl ? [{ name: '🔗 Join link', value: joinUrl, inline: false }] : []),
      ...(reviewUrl ? [{ name: 'Review & post afterwards', value: reviewUrl, inline: false }] : []),
    );
}

// DM a user their one-time "open on your phone" install link (with a tap button).
// Returns true if delivered. Best-effort.
async function dmInstallLink(discordId, url) {
  if (!ready || !discordId || !url) return false;
  try {
    const user  = await client.users.fetch(String(discordId));
    const embed = new EmbedBuilder()
      .setColor(0x3b82f6)
      .setTitle('Open the MET Dashboard on your phone')
      .setDescription('Tap the button on your phone to open the dashboard **already signed in**, then add it to your home screen. This link is single-use and expires in 5 minutes.');
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Open MET Dashboard').setURL(url),
    );
    await user.send({ embeds: [embed], components: [row] });
    return true;
  } catch (e) {
    console.warn('[App] dmInstallLink failed:', e.message);
    return false;
  }
}

// DM the host that their tryout was created + announced. Returns the DM message
// id (so it can be edited in real time when the lock state changes), or null.
async function dmTryoutStarted(tryout, { reviewUrl } = {}) {
  if (!ready || !tryout || !tryout.hostDiscordId) return null;
  try {
    const user = await client.users.fetch(tryout.hostDiscordId);
    const components = ['CANCELLED', 'COMPLETED'].includes(String(tryout.status || '').toUpperCase())
      ? [] : [tryoutHostDmButtons(tryout)];
    const msg  = await user.send({ embeds: [tryoutDmEmbed(tryout, { reviewUrl })], components });
    return msg.id;
  } catch (e) {
    console.warn('[Tryout] dmTryoutStarted failed:', e.message);
    return null;
  }
}

// DM the host that their tryout was auto-cancelled for inactivity (they left the
// server and didn't return within the absence window). Best-effort.
async function dmTryoutAutoCancelled(tryout, minutes) {
  if (!ready || !tryout || !tryout.hostDiscordId) return false;
  try {
    const cfg  = require('./tryouts').divisionConfig(tryout.division);
    const user = await client.users.fetch(tryout.hostDiscordId);
    const embed = new EmbedBuilder()
      .setColor(0xe74c3c)
      .setTitle(`${cfg.eventType} — auto-cancelled`)
      .setDescription(`Your tryout was automatically cancelled because you left the server for more than ${minutes} minutes without returning. Its announcement has been removed. Start a new tryout in-game whenever you're ready.`);
    await user.send({ embeds: [embed] });
    return true;
  } catch (e) {
    console.warn('[Tryout] dmTryoutAutoCancelled failed:', e.message);
    return false;
  }
}

// DM the host that their concluded tryout has a DRAFT log waiting on the site,
// with a button that deep-links straight to it. Best-effort; returns the DM id.
async function dmTryoutLogReady(log) {
  if (!ready || !log || !log.hostDiscordId) return null;
  try {
    const cfg  = require('./tryouts').divisionConfig(log.division);
    const base = process.env.PUBLIC_BASE_URL ? process.env.PUBLIC_BASE_URL.replace(/\/$/, '') : null;
    const url  = base ? `${base}/${cfg.dashboardSlug}/dashboard?tryoutLog=${log.id}` : null;
    const user = await client.users.fetch(log.hostDiscordId);
    const embed = new EmbedBuilder()
      .setColor(0x3b82f6)
      .setTitle(`${cfg.eventType} — log ready to review`)
      .setDescription('Your tryout concluded and a draft log has been queued on the site. Review the attendees, make any edits, then post it for approval.')
      .addFields(
        { name: 'Attendees', value: String(log.totalAttendees ?? 0), inline: true },
        { name: '✅ Passed',  value: String(log.passedCount ?? 0), inline: true },
        { name: '❌ Failed',  value: String(log.failedCount ?? 0), inline: true },
      );
    const components = url ? [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Review & post log').setURL(url),
    )] : [];
    const msg = await user.send({ embeds: [embed], components });
    return msg.id;
  } catch (e) {
    console.warn('[Tryout] dmTryoutLogReady failed:', e.message);
    return null;
  }
}

// Re-render the host's tryout DM in place so its Status field tracks the live
// lock state. Best-effort; no-ops if we never recorded the DM message id.
async function editTryoutHostDM(tryout) {
  if (!ready || !tryout || !tryout.hostDmMessageId || !tryout.hostDiscordId) return false;
  try {
    const base = require('./tryouts').reviewUrl(tryout);
    const user = await client.users.fetch(tryout.hostDiscordId);
    const dm   = await user.createDM();
    const msg  = await dm.messages.fetch(tryout.hostDmMessageId);
    const status  = String(tryout.status || '').toUpperCase();
    const payload = { embeds: [tryoutDmEmbed(tryout, { reviewUrl: base })] };
    // Once the tryout is finished, strip the action buttons; while it's running,
    // re-render them so labels stay current (e.g. the "Allow joining" toggle).
    payload.components = (status === 'CANCELLED' || status === 'COMPLETED') ? [] : [tryoutHostDmButtons(tryout)];
    await msg.edit(payload);
    return true;
  } catch (e) {
    console.warn('[Tryout] editTryoutHostDM failed:', e.message);
    return false;
  }
}

// Delete the posted announcement from the tryouts channel (on cancel/conclude).
// Clears the stored message id so a later edit can't target a deleted message.
// Best-effort; no-ops if nothing was ever posted or the message is already gone.
async function deleteTryoutAnnouncement(tryout) {
  if (!ready || !tryout || !tryout.announcementMsgId) return false;
  const { divisionConfig, announceChannelId } = require('./tryouts');
  const chId = announceChannelId(tryout);
  if (!chId) return false;
  try {
    const ch  = await client.channels.fetch(chId);
    const msg = await ch.messages.fetch(tryout.announcementMsgId);
    await msg.delete();
    // Remove the optional CID recruitment cross-post too, if we posted one.
    const cfg = divisionConfig(tryout.division);
    if (tryout.recruitmentMsgId && cfg.recruitmentChannelId) {
      try {
        const rch  = await client.channels.fetch(cfg.recruitmentChannelId);
        const rmsg = await rch.messages.fetch(tryout.recruitmentMsgId);
        await rmsg.delete();
      } catch (e) { /* cross-post already gone */ }
    }
    await require('./db').tryout.update({
      where: { id: tryout.id }, data: { announcementSent: false, announcementMsgId: null, recruitmentMsgId: null },
    }).catch(() => {});
    return true;
  } catch (e) {
    console.warn('[Tryout] deleteTryoutAnnouncement failed:', e.message);
    return false;
  }
}

// Re-render the posted tryout announcement in place (e.g. after the game's
// server-lock state changes). No-ops safely if the announcement was never
// posted, the channel/message is gone, or the bot isn't ready.
async function editTryoutAnnouncement(tryout) {
  if (!ready) return false;
  if (!tryout || !tryout.announcementMsgId) return false;
  const chId = require('./tryouts').announceChannelId(tryout);
  if (!chId) return false;
  try {
    const { formatAnnouncement, announcementAllowedMentions } = require('./tryouts');
    const ch  = await client.channels.fetch(chId);
    const msg = await ch.messages.fetch(tryout.announcementMsgId);
    // Editing on lock/unlock must not re-introduce a ping while suppressed.
    await msg.edit({ content: formatAnnouncement(tryout), allowedMentions: announcementAllowedMentions(tryout) });
    return true;
  } catch (e) {
    console.warn('[Tryout] editTryoutAnnouncement failed:', e.message);
    return false;
  }
}

// The channel a post-tryout summary card is posted to (by division). Prefers a
// dedicated summary channel, then the events-log channel, then the announce
// channel. All optional — returns null (→ no post) if none is configured.
function tryoutSummaryChannelId(division) {
  const d = String(division || '').toUpperCase();
  if (d === 'CID') {
    return process.env.CID_TRYOUT_SUMMARY_CHANNEL_ID || process.env.TRYOUT_SUMMARY_CHANNEL_ID
      || EVENTLOGS_CHANNEL_ID || process.env.CID_TRYOUT_CHANNEL_ID || null;
  }
  return process.env.TRYOUT_SUMMARY_CHANNEL_ID || EVENTLOGS_CHANNEL_ID || process.env.TRYOUT_ANNOUNCE_CHANNEL_ID || null;
}

// Post a compact post-tryout summary card to the events-log channel. Best-effort
// (fired once after a tryout concludes). Returns the message id, or null.
async function postTryoutSummary(summary) {
  if (!ready || !summary) return null;
  const div  = String(summary.division || 'HPC').toUpperCase();
  const chId = tryoutSummaryChannelId(div);
  if (!chId) return null;
  try {
    const cfg    = require('./tryouts').divisionConfig(div);
    const host   = summary.host || {};
    const coHost = summary.coHost || null;
    const n      = (v) => (Number.isFinite(+v) ? +v : 0);
    const fmtDur = (s) => { s = Math.max(0, Math.round(+s || 0)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return (h ? `${h}h ` : '') + `${m}m`; };
    const embed = new EmbedBuilder()
      .setColor(cfg.dmColor || 0x3b82f6)
      .setTitle(`${cfg.eventType} — Summary`)
      .addFields(
        { name: 'Host',      value: host.username ? String(host.username) : '—', inline: true },
        { name: 'Co-Host',   value: coHost && coHost.username ? String(coHost.username) : 'N/A', inline: true },
        { name: 'Duration',  value: fmtDur(summary.durationSecs), inline: true },
        { name: 'Attendees', value: String(n(summary.attendees)), inline: true },
        { name: '✅ Passed', value: String(n(summary.passed)), inline: true },
        { name: '❌ Failed', value: String(n(summary.failed)), inline: true },
        { name: '⚠ Strikes', value: String(n(summary.strikes)), inline: true },
        { name: '👢 Kicked', value: String(n(summary.kicked)), inline: true },
        { name: '🚪 Left',   value: String(n(summary.left)), inline: true },
      )
      .setTimestamp(new Date());
    const ch  = await client.channels.fetch(chId);
    const msg = await ch.send({ embeds: [embed] });
    return msg.id;
  } catch (e) {
    console.warn('[Tryout] postTryoutSummary failed:', e.message);
    return null;
  }
}

async function handleTryoutComponent(interaction) {
  const prisma = require('./db');
  const id = interaction.customId || '';

  // "Pick Co-Host" → show a member picker.
  if (id.startsWith('tryout_cohost_') && interaction.isButton()) {
    const tryoutId = id.slice('tryout_cohost_'.length);
    const row = new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder().setCustomId(`tryout_cohostsel_${tryoutId}`).setPlaceholder('Select a co-host').setMinValues(1).setMaxValues(1),
    );
    return interaction.reply({ content: 'Select the co-host for this tryout:', components: [row], flags: 64 });
  }

  // Co-host chosen.
  if (id.startsWith('tryout_cohostsel_') && interaction.isUserSelectMenu && interaction.isUserSelectMenu()) {
    const tryoutId = id.slice('tryout_cohostsel_'.length);
    const picked   = interaction.users.first();
    const coName   = picked ? (picked.globalName || picked.username) : null;
    await prisma.tryout.update({ where: { id: tryoutId }, data: { coHostDiscordId: picked ? picked.id : null, coHostName: coName } }).catch(() => {});
    // Reflect the co-host in the already-posted announcement + the host DM.
    const fresh = await prisma.tryout.findUnique({ where: { id: tryoutId } }).catch(() => null);
    if (fresh) {
      await editTryoutAnnouncement(fresh).catch(() => {});
      await editTryoutHostDM(fresh).catch(() => {});
    }
    return interaction.update({ content: `✅ Co-host set to **${coName}**.`, components: [] });
  }

  // "Allow players to join" / "Stop new joins" → toggle the joinable flag, then
  // re-render the announcement (adds/removes the Join launch link) and the host
  // DM (flips the button label + Joining field).
  if (id.startsWith('tryout_join_') && interaction.isButton()) {
    const tryoutId = id.slice('tryout_join_'.length);
    const t = await prisma.tryout.findUnique({ where: { id: tryoutId } });
    if (!t) return interaction.reply({ content: 'That tryout no longer exists.', flags: 64 });
    if (['CANCELLED', 'COMPLETED'].includes(String(t.status || '').toUpperCase())) {
      return interaction.reply({ content: 'This tryout is already finished.', flags: 64 });
    }
    const joinable = !t.joinable;
    const updated  = await prisma.tryout.update({ where: { id: t.id }, data: { joinable } });
    if (updated.announcementMsgId) await editTryoutAnnouncement(updated).catch(() => {});
    await editTryoutHostDM(updated).catch(() => {});
    const hasLink = !!require('./tryouts').tryoutJoinUrl(updated);
    return interaction.reply({
      content: joinable
        ? (hasLink ? '✅ Joining is **open** — the Join link is now in the announcement.'
                   : '✅ Joining is **open**. (No place id configured, so no launch link was added — set `TRYOUT_JOIN_PLACE_ID`.)')
        : '🛑 Joining is **closed** — new joins are stopped and the Join link removed.',
      flags: 64,
    });
  }

  // "Send Announcement" → post to the division's announcement channel (one-time).
  // After this, the post updates itself automatically on any change — there's no
  // manual "update" button. Refresh the host DM so the send button drops off.
  if (id.startsWith('tryout_announce_') && interaction.isButton()) {
    const tryoutId = id.slice('tryout_announce_'.length);
    const t = await prisma.tryout.findUnique({ where: { id: tryoutId } });
    if (!t) return interaction.reply({ content: 'That tryout no longer exists.', flags: 64 });
    if (['CANCELLED', 'COMPLETED'].includes(String(t.status || '').toUpperCase())) {
      return interaction.reply({ content: 'This tryout is already finished.', flags: 64 });
    }
    const { announceChannelId } = require('./tryouts');
    if (!announceChannelId(t)) {
      return interaction.reply({ content: '⚠️ No announcement channel configured for this division.', flags: 64 });
    }
    let msgId, updated = false;
    if (t.announcementMsgId) { updated = await editTryoutAnnouncement(t); msgId = t.announcementMsgId; }
    else msgId = await postTryoutAnnouncement(t);
    // Re-render the host DM so its buttons reflect the now-announced state.
    if (msgId) {
      const fresh = await prisma.tryout.findUnique({ where: { id: tryoutId } }).catch(() => null);
      if (fresh) await editTryoutHostDM(fresh).catch(() => {});
    }
    return interaction.reply({
      content: msgId
        ? (updated ? '📢 Announcement updated!' : '📢 Announcement posted! It will now update itself automatically whenever anything changes.')
        : 'Failed to post the announcement.',
      flags: 64,
    });
  }
}

// ─────────────────────────────────────────────────────────────────
// Discord moderation — ban / unban / kick / timeout ("mute"). Used by the
// Dev Panel's Discord Moderation tool (server/routes/admin.js). Every action
// operates on DISCORD_GUILD_ID by default, or an explicit guildId if passed
// (e.g. the MET server, if it differs from the portal's primary guild).
// ─────────────────────────────────────────────────────────────────

function targetGuildId(guildId) { return guildId || process.env.DISCORD_GUILD_ID; }

// Search guild members by username/nickname/ID substring — for the moderation
// tool's member picker. Returns up to `limit` matches (Discord caps a single
// fetch({query}) at 1000; we ask for a bit more than `limit` and trim).
async function searchGuildMembers(query, limit = 25, guildId) {
  if (!ready) throw new Error('Bot is not connected yet — try again shortly.');
  const gId = targetGuildId(guildId);
  if (!gId) throw new Error('No guild configured (DISCORD_GUILD_ID not set).');
  const guild = await guild_(gId);

  // An exact numeric ID → fetch that one member directly (query search doesn't
  // match raw IDs).
  if (/^\d{15,25}$/.test(String(query || '').trim())) {
    try {
      const m = await guild.members.fetch(String(query).trim());
      return [memberSummary(m)];
    } catch (e) {
      return [];
    }
  }

  const results = await guild.members.fetch({ query: String(query || '').trim(), limit: Math.min(limit, 100) });
  return [...results.values()].slice(0, limit).map(memberSummary);
}

function memberSummary(member) {
  return {
    id:          member.user.id,
    username:    member.user.username,
    displayName: member.displayName || member.user.username,
    avatar:      member.user.displayAvatarURL({ size: 64 }),
    roleIds:     [...member.roles.cache.keys()],
    isBot:       !!member.user.bot,
    joinedAt:    member.joinedAt ? member.joinedAt.toISOString() : null,
    timedOutUntil: member.communicationDisabledUntil ? member.communicationDisabledUntil.toISOString() : null,
  };
}

async function guild_(guildId) { return client.guilds.fetch(guildId); }

// List (optionally filtered by username/ID substring) currently-banned users.
// Discord has no server-side ban search, so this fetches the full ban list
// (fine for a single-server community) and filters in memory.
async function listGuildBans(search, guildId) {
  if (!ready) throw new Error('Bot is not connected yet — try again shortly.');
  const gId = targetGuildId(guildId);
  if (!gId) throw new Error('No guild configured (DISCORD_GUILD_ID not set).');
  const guild = await guild_(gId);
  const bans  = await guild.bans.fetch();

  const q = String(search || '').trim().toLowerCase();
  const list = [...bans.values()]
    .map(b => ({ id: b.user.id, username: b.user.username, reason: b.reason || null }))
    .filter(b => !q || b.id === q || b.username.toLowerCase().includes(q));
  return list;
}

// Ban a Discord user from the guild. `deleteMessageSeconds` (0-604800) purges
// their recent messages too — defaults to 0 (no purge).
async function banMember(discordUserId, { reason, deleteMessageSeconds = 0, guildId } = {}) {
  if (!ready) throw new Error('Bot is not connected yet — try again shortly.');
  const gId = targetGuildId(guildId);
  if (!gId) throw new Error('No guild configured (DISCORD_GUILD_ID not set).');
  const guild = await guild_(gId);
  await guild.members.ban(discordUserId, {
    reason: reason || undefined,
    deleteMessageSeconds: Math.max(0, Math.min(604800, Number(deleteMessageSeconds) || 0)),
  });
  console.log(`[Moderation] Banned ${discordUserId} from guild ${gId}${reason ? ` (${reason})` : ''}`);
  return true;
}

// Unban a Discord user (by ID — they're not a guild member anymore, so this
// works even if the bot can't otherwise "find" them). Throws with a clear
// message when they aren't actually banned (Discord returns 10026 Unknown Ban).
async function unbanMember(discordUserId, { reason, guildId } = {}) {
  if (!ready) throw new Error('Bot is not connected yet — try again shortly.');
  const gId = targetGuildId(guildId);
  if (!gId) throw new Error('No guild configured (DISCORD_GUILD_ID not set).');
  const guild = await guild_(gId);
  try {
    await guild.bans.remove(discordUserId, reason || undefined);
  } catch (err) {
    if (err.code === 10026) throw new Error('That user is not currently banned.');
    throw err;
  }
  console.log(`[Moderation] Unbanned ${discordUserId} from guild ${gId}`);
  return true;
}

// Kick a current guild member.
async function kickMember(discordUserId, { reason, guildId } = {}) {
  if (!ready) throw new Error('Bot is not connected yet — try again shortly.');
  const gId = targetGuildId(guildId);
  if (!gId) throw new Error('No guild configured (DISCORD_GUILD_ID not set).');
  const guild  = await guild_(gId);
  const member = await guild.members.fetch(discordUserId).catch(() => null);
  if (!member) throw new Error('That user is not currently in the server.');
  await member.kick(reason || undefined);
  console.log(`[Moderation] Kicked ${discordUserId} from guild ${gId}${reason ? ` (${reason})` : ''}`);
  return true;
}

// Timeout ("mute") a member for `durationMinutes` (Discord caps timeouts at 28
// days). Pass durationMinutes <= 0 to remove an existing timeout ("unmute").
async function timeoutMember(discordUserId, { durationMinutes, reason, guildId } = {}) {
  if (!ready) throw new Error('Bot is not connected yet — try again shortly.');
  const gId = targetGuildId(guildId);
  if (!gId) throw new Error('No guild configured (DISCORD_GUILD_ID not set).');
  const guild  = await guild_(gId);
  const member = await guild.members.fetch(discordUserId).catch(() => null);
  if (!member) throw new Error('That user is not currently in the server.');

  const MAX_MINUTES = 28 * 24 * 60; // Discord's hard cap: 28 days
  const mins = Math.max(0, Math.min(MAX_MINUTES, Number(durationMinutes) || 0));
  await member.timeout(mins > 0 ? mins * 60 * 1000 : null, reason || undefined);
  console.log(`[Moderation] ${mins > 0 ? `Timed out ${discordUserId} for ${mins}m` : `Removed timeout from ${discordUserId}`} in guild ${gId}${reason ? ` (${reason})` : ''}`);
  return true;
}

module.exports = {
  startBot, assignRole, removeRole, getMemberDisplayName, lookupMember, getMemberRecord,
  findMemberByUsername, parseRankNick, getRobloxNameFromNick, findMemberByRobloxNick,
  getRoleHolders, setExclusiveRoleHolder, getGuildMemberInfo, getMetMemberProfile, startRoleExpiryChecker,
  matchTicketTranscript,
  searchGuildMembers, listGuildBans, banMember, unbanMember, kickMember, timeoutMember,
  sendTryoutHostDM, editTryoutAnnouncement, postTryoutAnnouncement, deleteTryoutAnnouncement, dmTryoutStarted, editTryoutHostDM,
  postTryoutSummary, dmTryoutLogReady, dmTryoutAutoCancelled, dmInstallLink,
  reactToMessage, postChannelMessage, editChannelMessage,
  isReady: () => ready,
};
