// server/lib/bot.js
// Discord.js bot — runs in the same process as Express.
// Handles: role assignment after case approval, member lookup.

const { Client, GatewayIntentBits, Partials, SlashCommandBuilder } = require('discord.js');

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
const WANT_MESSAGE_CONTENT = !!(IMPORT_GUILD_ID || TICKET_LOG_CHANNEL_ID);

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
  getRoleHolders, setExclusiveRoleHolder, getGuildMemberInfo, startRoleExpiryChecker,
  matchTicketTranscript,
  searchGuildMembers, listGuildBans, banMember, unbanMember, kickMember, timeoutMember,
};
