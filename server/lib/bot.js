// server/lib/bot.js
// Discord.js bot — runs in the same process as Express.
// Handles: role assignment after case approval, member lookup.

const { Client, GatewayIntentBits, Partials, SlashCommandBuilder,
        EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, UserSelectMenuBuilder,
        StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
        GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel } = require('discord.js');

// The MET emoji set. e('met_tick') is "<:met_tick:…>" once the guild upload has
// happened and the plain unicode character until then, so it is always safe to
// interpolate straight into message content and embed fields.
const { e } = require('./emoji');

// Per-division co-host restriction: a tryout co-host must be "staff" in that
// division's server (a specific role). The picker then only offers those members.
// HPC is restricted by default (role provided); CID only when its role env is
// set; any other division stays unrestricted (pick anyone) unless configured.
const HPC_GUILD_ID      = () => process.env.HPC_GUILD_ID || process.env.DISCORD_GUILD_ID;
const HPC_STAFF_ROLE_ID = () => process.env.HPC_STAFF_ROLE_ID || '1426660644093952281';
function coHostStaffConfig(division) {
  const d = String(division || '').toUpperCase();
  if (d === 'HPC') return { guildId: HPC_GUILD_ID(), roleId: HPC_STAFF_ROLE_ID() };
  if (d === 'CID' && process.env.CID_STAFF_ROLE_ID) {
    return { guildId: process.env.CID_GUILD_ID || process.env.DISCORD_GUILD_ID, roleId: process.env.CID_STAFF_ROLE_ID };
  }
  return null; // unrestricted → pick anybody in the server
}

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
// retries WITHOUT it if the dashboard rejects it (role assignment etc. keep working).
// Patrol-log + event-log channels — the bot reads new logs here (needs Message
// Content) and reacts ✅/❌ once the site approves/denies them.
const PATROL_CHANNEL_ID    = process.env.PATROL_CHANNEL_ID || null;
const EVENTLOGS_CHANNEL_ID = process.env.EVENTLOGS_CHANNEL_ID || null;
// Promotions/demotions channel → RankHistory; infractions/strikes → punishment
// history. Both are ingested the same way patrol logs are (needs Message Content).
const PROMOTIONS_CHANNEL_ID  = process.env.PROMOTIONS_CHANNEL_ID  || null;
const INFRACTIONS_CHANNEL_ID = process.env.INFRACTIONS_CHANNEL_ID || null;
// CAD radio channel — officers type free-text transmissions here; the CAD
// intent parser reads them (needs Message Content), so enabling it turns the
// message-content intent on.
const CAD_RADIO_CHANNEL_ID = process.env.CAD_RADIO_CHANNEL_ID || null;
// The IA suggestions channel — the classifier there reads what people wrote in
// order to tell a suggestion from chat, so it needs Message Content too. It has a
// default channel id rather than being off until configured, so it belongs in this
// chain on its own account: leaving it out would mean the intent was only ever
// requested as a side effect of some OTHER channel being set.
const SUGGESTIONS_CHANNEL_ID = () => {
  try { return require('./suggestions').CHANNEL_ID(); } catch (e) { return null; }
};
const WANT_MESSAGE_CONTENT = !!(IMPORT_GUILD_ID || TICKET_LOG_CHANNEL_ID || PATROL_CHANNEL_ID || EVENTLOGS_CHANNEL_ID || PROMOTIONS_CHANNEL_ID || INFRACTIONS_CHANNEL_ID || CAD_RADIO_CHANNEL_ID || SUGGESTIONS_CHANNEL_ID());
// A patrol/event log is signed off by somebody ticking or crossing the message
// in Discord, so those channels also need the reaction gateway events.
const WANT_REACTIONS = !!(PATROL_CHANNEL_ID || EVENTLOGS_CHANNEL_ID);

let ready = false;
let client;

async function onReady() {
  ready = true;
  console.log(`[Bot] online as ${client.user.tag}`);
  // Upload the MET emoji set to the guild (or adopt what's already there) so
  // e('met_tick') resolves to our artwork instead of falling back to unicode.
  try { require('./emoji').startEmojiSync(client); }
  catch (e) { console.warn('[Emoji] sync not started:', e.message); }
  await registerCommands();
  // Bring up the CAD dispatch system (radio listener + voice). Best-effort —
  // never let a CAD misconfig take the bot down.
  try { require('./cad').init(client); } catch (e) { console.warn('[CAD] init failed:', e.message); }
  // Mirror the closed-ticket logs onto the site (All Tickets / My Tickets).
  try { require('./ticketIngest').startTicketLogWorker(client); }
  catch (e) { console.warn('[TicketLogs] worker not started:', e.message); }
  // Re-read tick/cross reactions on recent patrol/event logs. Gateway events
  // are not replayed after a disconnect, so without this a sign-off made while
  // the bot was restarting would never reach the site.
  try { require('./patrolReactions').startReactionReconciler(client); }
  catch (e) { console.warn('[PatrolLog] reaction reconciler not started:', e.message); }
  // Say once, at boot, whether the suggestions channel is actually reachable and
  // which permissions are missing. Every failure in there looks the same from the
  // channel — nothing happens — so the only way to tell "no Add Reactions" from
  // "no View Channel" from "working fine, nobody posted" is to ask and print it.
  try { await require('./suggestions').checkPermissions(client); }
  catch (e) { console.warn('[Suggestions] permission check failed:', e.message); }
  // Mirror the Roblox group's own audit log into Discord — every rank change,
  // join request, removal and configuration change in the MET group, whoever
  // made it and wherever they made it from.
  try { require('./groupAuditLog').startGroupAuditWorker(client); }
  catch (e) { console.warn('[GroupAudit] worker not started:', e.message); }
}

function buildClient(withMessageContent) {
  // GuildVoiceStates is REQUIRED by @discordjs/voice — without it a voice
  // connection can't complete its handshake and churns connect→drop. It's a
  // non-privileged intent, so it's always safe to request.
  const intents  = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates];
  const partials = [Partials.GuildMember];
  if (withMessageContent) intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
  if (WANT_REACTIONS) {
    // GuildMessageReactions is NOT privileged, so requesting it can't fail login
    // the way MessageContent can. The partials are what let us see a reaction on
    // a message posted before the bot started.
    intents.push(GatewayIntentBits.GuildMessageReactions);
    partials.push(Partials.Message, Partials.Channel, Partials.Reaction, Partials.User);
  }
  const c = new Client({ intents, partials });
  // discord.js renamed this event: 14.27 emits `clientReady`, and the old
  // `ready` is deprecated and disappears in v15. Listen for the new one, and
  // keep the old as a fallback for older versions — `once` on both would run
  // onReady twice on 14.27, so it's guarded.
  let started = false;
  const boot = () => { if (started) return; started = true; onReady().catch(err => console.error('[Bot] startup failed:', err)); };
  c.once('clientReady', boot);
  c.once('ready', boot);
  c.on('interactionCreate', onInteraction);
  if (withMessageContent) c.on('messageCreate', onPatrolMessage);
  if (WANT_REACTIONS) {
    // Ticking or crossing a patrol/event log IS the sign-off, whoever does it.
    const onReaction = added => (reaction, user) =>
      require('./patrolReactions').applyReaction(reaction, user, added)
        .catch(e => console.warn('[PatrolLog] reaction handler error:', e.message));
    c.on('messageReactionAdd',    onReaction(true));
    c.on('messageReactionRemove', onReaction(false));
  }
  // A punishment role has to survive somebody leaving and rejoining, or every
  // punishment is one /leave away from being undone. GuildMembers is already
  // requested above, which is what makes this event fire at all.
  c.on('guildMemberAdd', member => {
    require('./punishmentPersist').reapplyOnJoin(member)
      .catch(e => console.warn('[Punishments] rejoin re-apply failed:', e.message));
    // Same event, different question: is this a blacklisted/punished Roblox
    // account back under a new Discord one? Re-applies the safe roles by Roblox
    // identity and alerts Internal Affairs when it is evasion.
    require('./evasion').scanJoin(member)
      .catch(e => console.warn('[Evasion] join scan failed:', e.message));
  });
  c.on('error', err => console.error('Discord bot error:', err.message));
  return c;
}

// The live client, for callers that need to talk to Discord directly (the
// ticket-log backfill sweep, the MET database sync). Null until the gateway
// connects.
function getClient() { return ready ? client : null; }

client = buildClient(WANT_MESSAGE_CONTENT);

// The MET server. DISCORD_GUILD_ID alone is NOT good enough: the rest of the
// app resolves "the MET server" as MET_GUILD_ID first and falls back to
// DISCORD_GUILD_ID (see middleware/division.js, emoji.js, tryoutGuildId), and
// in a deployment where those two are different servers, registering against
// DISCORD_GUILD_ID puts the commands somewhere nobody is looking.
//
// So take BOTH, deduplicated. Registering /xp and /discipline in each costs
// nothing — who may actually run them is decided in code, not by where they
// appear — and it removes a whole class of "the command isn't there" that is
// invisible from the outside.
/**
 * Which guild a command belongs in.
 *
 * This used to union the command's own guild with MET_GUILD_ID and
 * DISCORD_GUILD_ID, so every command landed in every configured server — IA
 * tooling showed up in the MET server and vice versa. Commands are now scoped
 * to exactly one server, because who can SEE a command is part of the
 * permission model, not just a convenience.
 *
 * `specific` still wins when set, so a one-off override is possible without
 * moving the whole set.
 */
function guildFor(specific, fallbackEnv) {
  const id = process.env[specific]
    || process.env[fallbackEnv]
    || process.env.DISCORD_GUILD_ID;
  return id ? [String(id)] : [];
}

// Internal Affairs server: cases, tickets, quota, discipline, LOA.
const iaGuild  = (specific) => guildFor(specific, 'IA_GUILD_ID');
// MET server: Roblox group administration and MET-wide info.
const metGuild = (specific) => guildFor(specific, 'MET_GUILD_ID');

/**
 * Which commands the IA server actually shows.
 *
 * Everything IA-scoped is BUILT; this decides what is registered. Kept as a
 * list rather than scattered per-command flags so the answer to "why can I see
 * this" is one line, and trimming the set never means editing the plan.
 *
 * Default is the IA working set: file a case, see the table, adjust points,
 * check priors, put a mistake back. Anything built but not listed simply is not
 * registered there, so trimming the server is a variable change rather than a
 * deploy — and a name in the list that is not built yet is harmless.
 *
 * Override with IA_COMMANDS as a comma-separated list, or "*" for everything.
 */
const IA_COMMAND_ALLOWLIST = () => {
  const raw = (process.env.IA_COMMANDS || '').trim();
  if (raw === '*') return null;                       // null = no filtering
  const list = raw
    ? raw.split(',').map(x => x.trim().toLowerCase()).filter(Boolean)
    : ['submit-case', 'leaderboard', 'add-qp', 'remove-qp', 'check-record', 'undo'];
  return new Set(list);
};

const DISCIPLINE_GUILD_IDS  = () => iaGuild('DISCIPLINE_GUILD_ID');
const XP_GUILD_IDS          = () => iaGuild('XP_GUILD_ID');
const IA_GUILD_IDS          = () => iaGuild('IA_PANEL_GUILD_ID');
const LOA_GUILD_IDS         = () => iaGuild('LOA_GUILD_ID');
const PROMOTE_GUILD_IDS     = () => metGuild('PROMOTE_GUILD_ID');
const MET_GUILD_IDS         = () => metGuild('MET_INFO_GUILD_ID');
const PENDINGJOIN_GUILD_IDS = () => metGuild('PENDINGJOIN_GUILD_ID');

// Register slash commands, GROUPED BY GUILD.
//
// guild.commands.set() replaces that guild's whole command list, so every
// command for a guild has to go in one call — registering them one at a time
// would have each one delete the last. That was harmless while /import-cases
// was the only command and lived in its own private guild; it stops being
// harmless the moment two commands share a guild.
/**
 * Which commands go to which guilds. Split out from the registering so the
 * targeting can be checked without a gateway connection — getting this wrong is
 * exactly the failure that looks like nothing happened at all.
 */
function buildCommandPlan() {
  const byGuild = new Map();
  const iaAllow = IA_COMMAND_ALLOWLIST();
  const iaGuildId = process.env.IA_GUILD_ID || process.env.DISCORD_GUILD_ID;

  const add = (guildIds, json) => {
    // Filter only the IA server: the MET set is small and deliberate already.
    if (iaAllow && json && json.name && iaGuildId
        && (guildIds || []).some(g => String(g) === String(iaGuildId))
        && !iaAllow.has(String(json.name).toLowerCase())) {
      return;
    }
    for (const guildId of (Array.isArray(guildIds) ? guildIds : [guildIds])) {
      if (!guildId) continue;
      if (!byGuild.has(guildId)) byGuild.set(guildId, []);
      byGuild.get(guildId).push(json);
    }
  };

  // Read from the environment rather than the module constant: the constant is
  // captured at load time (it decides which gateway intents to request, which
  // genuinely is a load-time question), but where a command is registered is
  // not, and reading it live keeps every target in this function consistent.
  const importGuildId = process.env.IMPORT_GUILD_ID;
  if (importGuildId) {
    add(importGuildId, new SlashCommandBuilder()
      .setName('import-cases')
      .setDescription('Import cases')
      .addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true))
      .addBooleanOption(o => o.setName('dry').setDescription('Dry run'))
      // Visible to everyone in the (private) import guild; execution is gated
      // in code to the developer user ID below — so admins see it but can't run it.
      .toJSON());
  }

  // /discipline is visible to everyone; who may actually run it is decided in
  // code (Internal Affairs, or Deputy Commissioner and above). Gating it with
  // Discord's own default_member_permissions would tie it to a permission bit
  // rather than to rank, which is not the same thing at all.
  const global = [];
  try {
    const cmd = require('./disciplineCommand').buildCommand();
    add(DISCIPLINE_GUILD_IDS(), cmd);
    global.push(cmd);
  } catch (err) {
    console.error('[Bot] could not build /discipline:', err.message);
  }

  // /xp — everyone can look; who may change XP is decided in code.
  try {
    const cmd = require('./xpCommand').buildCommand();
    add(XP_GUILD_IDS(), cmd);
    global.push(cmd);
  } catch (err) {
    console.error('[Bot] could not build /xp:', err.message);
  }

  // /check-record — the Internal Affairs panel. Visible to everyone, gated in code
  // to the same people /discipline is, because it shows the same material. It was
  // called /ia, which named the department rather than the thing it does.
  try {
    const cmd = require('./iaPanel').buildCommand();
    add(IA_GUILD_IDS(), cmd);
    global.push(cmd);
  } catch (err) {
    console.error('[Bot] could not build /check-record:', err.message);
  }

  // /ia — the Internal Affairs dashboard. Registered in the MET server (and the
  // IA panel guild) like /check-record; who may actually use it, and what they
  // may decide, is settled in code by lib/iaAuthority.
  try {
    const cmd = require('./iaDashboard').buildCommand();
    add(IA_GUILD_IDS(), cmd);
    global.push(cmd);
  } catch (err) {
    console.error('[Bot] could not build /ia:', err.message);
  }

  // /promote — one rank up in the MET group. Gated in code, like the rest.
  try {
    const cmd = require('./promoteCommand').buildCommand();
    add(PROMOTE_GUILD_IDS(), cmd);
    global.push(cmd);
  } catch (err) {
    console.error('[Bot] could not build /promote:', err.message);
  }

  // /loa — leave of absence. Everyone can request and manage their own; the
  // reviewing half is gated in code to the LOA admin role, not by a Discord
  // permission bit, for the same reason /discipline is.
  // /undo — reverse one of your own recent actions (see lib/actionJournal).
  try {
    const cmd = require('./undoCommand').buildCommand();
    add(iaGuild('UNDO_GUILD_ID'), cmd);
    global.push(cmd);
  } catch (err) {
    console.error('[Bot] could not build /undo:', err.message);
  }

  try {
    const cmd = require('./loaCommand').buildCommand();
    add(LOA_GUILD_IDS(), cmd);
    global.push(cmd);
  } catch (err) {
    console.error('[Bot] could not build /loa:', err.message);
  }

  // /met — how to join. Visible to everyone so the recruitment path is not a
  // secret, and gated in code to the people who should be posting to a channel:
  // Internal Affairs, MET High Command, and server administrators.
  try {
    const cmd = require('./metCommand').buildCommand();
    add(MET_GUILD_IDS(), cmd);
    global.push(cmd);
  } catch (err) {
    console.error('[Bot] could not build /met:', err.message);
  }

  // /pendingjoin — the MET group's join-request queue. Gated in code to MET High
  // Command and administrators, because letting somebody into the group is a
  // Roblox action with no undo from here.
  try {
    const cmd = require('./pendingJoinCommand').buildCommand();
    add(PENDINGJOIN_GUILD_IDS(), cmd);
    global.push(cmd);
  } catch (err) {
    console.error('[Bot] could not build /pendingjoin:', err.message);
  }

  return { byGuild, global };
}

/**
 * Push the plan to Discord.
 * @param {object} [c] a client to use instead of the live one (tests)
 */
async function registerCommands(c) {
  const api = c || client;
  const { byGuild, global } = buildCommandPlan();
  const out = { guilds: [], global: null, errors: [] };

  if (!byGuild.size) {
    console.warn('[Bot] no guild configured for slash commands · set MET_GUILD_ID or DISCORD_GUILD_ID.');
  }

  let anyGuildOk = false;
  for (const [guildId, cmds] of byGuild) {
    const names = cmds.map(c => '/' + c.name).join(' ');
    try {
      const guild = await api.guilds.fetch(guildId);
      await guild.commands.set(cmds);
      anyGuildOk = true;
      out.guilds.push({ guildId, name: guild.name, commands: cmds.map(c => c.name), ok: true });
      console.log(`[Bot] registered ${names} in "${guild.name}" (${guildId})`);
    } catch (err) {
      // The three that actually happen, named so the log says what to DO.
      const why = /Missing Access|50001/i.test(err.message)
        ? 'the bot is missing the "applications.commands" scope in that server · re-invite it with that scope ticked (its existing roles and messages are unaffected)'
        : /Unknown Guild|10004/i.test(err.message)
          ? 'the bot is not in that server, or the id is wrong'
          : err.message;
      out.guilds.push({ guildId, ok: false, error: why });
      out.errors.push(`${guildId}: ${why}`);
      console.error(`[Bot] could not register ${names} in guild ${guildId} · ${why}`);
    }
  }

  // Guild commands and global commands STACK: the same command registered both
  // ways renders twice in the picker. So the rule is not "prefer guild" — it is
  // that the two can never coexist.
  //
  // Global is therefore only ever a fallback for a total failure, and
  // REGISTER_GLOBAL_COMMANDS cannot override that. Setting it while guild
  // registration works would put every command in every server AND duplicate
  // each one, which is never what anybody wants.
  const askedGlobal = process.env.REGISTER_GLOBAL_COMMANDS === '1';
  const wantGlobal  = askedGlobal && !anyGuildOk;

  if (askedGlobal && anyGuildOk) {
    console.warn('[Bot] REGISTER_GLOBAL_COMMANDS=1 is set but guild registration worked · '
      + 'ignoring it. Registering the same command globally AND per guild shows it '
      + 'twice in every server · unset the variable.');
  }
  if (!anyGuildOk && !askedGlobal) {
    console.error('[Bot] NO guild registration succeeded and the global fallback is off · '
      + 'check IA_GUILD_ID / MET_GUILD_ID and that the bot was invited with the '
      + '"applications.commands" scope. No slash commands are registered.');
  }

  if (wantGlobal && api.application) {
    try {
      await api.application.commands.set(global);
      out.global = global.map(c => c.name);
      console.log(`[Bot] registered ${global.map(c => '/' + c.name).join(' ')} GLOBALLY `
        + '(no guild registration succeeded · these can take up to an hour to appear)');
    } catch (err) {
      out.errors.push(`global: ${err.message}`);
      console.error('[Bot] global command registration failed:', err.message);
    }
  } else if (api.application) {
    // Discord keeps a command until something deletes it, so anything an older
    // deploy registered outlives the code that put it there. Clear the global
    // set on EVERY boot that is not deliberately global-only: it is the copy
    // that duplicates the guild ones and leaks commands into servers the plan
    // never mentioned.
    try {
      const stale = await api.application.commands.fetch();
      if (stale.size) {
        await api.application.commands.set([]);
        console.log(`[Bot] cleared ${stale.size} stale GLOBAL command(s): `
          + `${[...stale.values()].map(c => '/' + c.name).join(' ')} `
          + '· clients can take up to an hour to stop showing them');
        out.clearedGlobal = [...stale.values()].map(c => c.name);
      } else {
        console.log('[Bot] no global commands registered · nothing to clear');
      }
    } catch (err) {
      console.warn('[Bot] could not clear global commands:', err.message);
    }
  }

  // Any server the bot is in that the plan does not mention should have NO
  // commands — the CID server, for instance, is joined only to read a role.
  // Without this, commands registered there by an earlier deploy stay forever.
  try {
    const planned = new Set([...byGuild.keys()].map(String));
    const summary = [];
    for (const [, guild] of api.guilds.cache) {
      const isPlanned = planned.has(String(guild.id));
      let existing = null;
      try { existing = await guild.commands.fetch(); }
      catch (err) {
        summary.push(`${guild.name} (${guild.id}): cannot read commands · ${err.message}`);
        continue;
      }
      if (!isPlanned && existing.size) {
        await guild.commands.set([]);
        console.log(`[Bot] cleared ${existing.size} leftover command(s) from "${guild.name}" `
          + `(${guild.id}) · not in the command plan`);
        out.cleared = out.cleared || [];
        out.cleared.push({ guildId: guild.id, name: guild.name, removed: existing.size });
        summary.push(`${guild.name}: none (cleared ${existing.size})`);
      } else {
        summary.push(`${guild.name}: ${existing.size
          ? [...existing.values()].map(c => '/' + c.name).join(' ')
          : 'none'}`);
      }
    }
    // One line per server, so "why is this command here" is answerable from the
    // boot log alone rather than by asking Discord.
    console.log('[Bot] command layout now:\n    ' + summary.join('\n    '));
  } catch (err) {
    console.warn('[Bot] leftover-command sweep failed:', err.message);
  }

  return out;
}

/**
 * What Discord ACTUALLY has registered right now, per guild and globally.
 *
 * A slash command that doesn't appear is invisible from the inside — the logs
 * say we called set(), and that is all anyone can see. This reads it back from
 * Discord so the answer is "here is what is really there", not "here is what we
 * think we sent".
 */
async function listRegisteredCommands() {
  if (!ready) return { ok: false, error: 'Bot not connected yet.' };
  const out = { guilds: [], global: [], botGuilds: [], resolved: {} };
  out.resolved = {
    MET_GUILD_ID: process.env.MET_GUILD_ID || null,
    DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID || null,
    disciplineTargets: DISCIPLINE_GUILD_IDS(),
    xpTargets: XP_GUILD_IDS(),
    iaTargets: IA_GUILD_IDS(),
    promoteTargets: PROMOTE_GUILD_IDS(),
    loaTargets:     LOA_GUILD_IDS(),
  };
  try {
    for (const g of client.guilds.cache.values()) out.botGuilds.push({ id: g.id, name: g.name });
  } catch (e) { /* cache only */ }
  try {
    const g = await client.application.commands.fetch();
    out.global = [...g.values()].map(c => c.name);
  } catch (e) { out.global = { error: e.message }; }
  for (const guildId of new Set([...DISCIPLINE_GUILD_IDS(), ...XP_GUILD_IDS(), ...IA_GUILD_IDS(), ...PROMOTE_GUILD_IDS(), ...LOA_GUILD_IDS(), IMPORT_GUILD_ID].filter(Boolean))) {
    try {
      const guild = await client.guilds.fetch(guildId);
      const cmds = await guild.commands.fetch();
      out.guilds.push({ guildId, name: guild.name, commands: [...cmds.values()].map(c => c.name) });
    } catch (err) {
      out.guilds.push({ guildId, error: err.message });
    }
  }
  return { ok: true, ...out };
}

// Handle the import slash command (restricted to the developer user)
async function onInteraction(interaction) {
  // Autocomplete (the /promote rank picker). Answered separately from the
  // command itself · it only ever suggests, it never runs anything.
  if (interaction.isAutocomplete && interaction.isAutocomplete()) {
    if (interaction.commandName === 'promote') {
      return require('./promoteCommand').handlePromoteAutocomplete(interaction)
        .catch(e => console.error('[Bot] promote autocomplete error:', e.message));
    }
    return;
  }

  // Tryout DM buttons / co-host select menu.
  if (interaction.isButton()
      || (interaction.isUserSelectMenu && interaction.isUserSelectMenu())
      || (interaction.isStringSelectMenu && interaction.isStringSelectMenu())
      || (interaction.isModalSubmit && interaction.isModalSubmit())) {
    const cid = interaction.customId || '';
    if (cid.startsWith('tryout_')) {
      return handleTryoutComponent(interaction).catch(e => console.error('[Bot] tryout component error:', e.message));
    }
    // IA case/ticket review cards.
    if (cid.startsWith('undo:')) {
      return require('./undoCommand').handleUndoComponent(interaction)
        .catch(e => console.error('[Bot] undo component error:', e.message));
    }
    if (cid.startsWith('iareview:')) {
      return require('./iaReviewCards').handleReviewButton(interaction)
        .catch(e => console.error('[Bot] IA review button error:', e.message));
    }
    if (cid.startsWith('disc_')) {
      return require('./disciplineCommand').handleDisciplineButton(interaction)
        .catch(e => console.error('[Bot] discipline button error:', e.message));
    }
    // The /ia dashboard. Checked BEFORE the ia_ panel below: the prefixes are
    // distinct (iad_ vs ia_) but the order makes that explicit rather than a
    // fact somebody has to re-derive from string comparison.
    if (cid.startsWith('iad_')) {
      const D = require('./iaDashboard');
      const run = (interaction.isModalSubmit && interaction.isModalSubmit())
        ? D.handleIaDashboardModal(interaction)
        : D.handleIaDashboardComponent(interaction);
      return run.catch(e => console.error('[Bot] /ia dashboard component error:', e.message));
    }
    if (cid.startsWith('ia_')) {
      return require('./iaPanel').handleIaComponent(interaction)
        .catch(e => console.error('[Bot] IA panel component error:', e.message));
    }
    if (cid.startsWith('prom_')) {
      return require('./promoteCommand').handlePromoteButton(interaction)
        .catch(e => console.error('[Bot] promote button error:', e.message));
    }
    if (cid.startsWith('evade_')) {
      return require('./evasion').handleEvasionButton(interaction)
        .catch(e => console.error('[Bot] evasion button error:', e.message));
    }
    if (cid.startsWith('met_dm_')) {
      return require('./metCommand').handleMetButton(interaction)
        .catch(e => console.error('[Bot] /met button error:', e.message));
    }
    if (cid.startsWith('loa_')) {
      const LC = require('./loaCommand');
      // The extend/reduce modals share the loa_ prefix with the buttons that
      // open them, so which handler runs depends on what came back.
      const run = (interaction.isModalSubmit && interaction.isModalSubmit())
        ? LC.handleLoaModal(interaction)
        : LC.handleLoaButton(interaction);
      return run.catch(async (err) => {
        console.error('[Bot] LOA component error:', err.message);
        const msg = { embeds: [], components: [], content: `${e('met_cross')} Something went wrong. (${err.message})` };
        await (interaction.deferred || interaction.replied
          ? interaction.editReply(msg)
          : interaction.reply({ ...msg, flags: 64 })).catch(() => {});
      });
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'undo') {
    return require('./undoCommand').handleUndo(interaction)
      .catch(e => console.error('[Bot] /undo error:', e.message));
  }

  if (interaction.commandName === 'xp') {
    return require('./xpCommand').handleXpCommand(interaction)
      .catch(async (err) => {
        console.error('[Bot] /xp failed:', err.message);
        const msg = { content: `${e('met_cross')} Something went wrong running that. (${err.message})`, embeds: [], components: [] };
        await (interaction.deferred || interaction.replied
          ? interaction.editReply(msg)
          : interaction.reply({ ...msg, flags: 64 })).catch(() => {});
      });
  }

  if (interaction.commandName === 'discipline') {
    return require('./disciplineCommand').handleDisciplineCommand(interaction)
      .catch(async (err) => {
        console.error('[Bot] /discipline failed:', err.message);
        // The panel is ephemeral and already deferred by this point, so the
        // issuer would otherwise be left staring at "thinking…" forever.
        const msg = { content: `${e('met_cross')} Something went wrong running that · nothing was issued. (${err.message})`, embeds: [], components: [] };
        await (interaction.deferred || interaction.replied
          ? interaction.editReply(msg)
          : interaction.reply({ ...msg, flags: 64 })).catch(() => {});
      });
  }

  if (interaction.commandName === 'promote') {
    return require('./promoteCommand').handlePromoteCommand(interaction)
      .catch(async (err) => {
        console.error('[Bot] /promote failed:', err.message);
        const msg = { content: `${e('met_cross')} Something went wrong · nothing was changed. (${err.message})`, embeds: [], components: [] };
        await (interaction.deferred || interaction.replied
          ? interaction.editReply(msg)
          : interaction.reply({ ...msg, flags: 64 })).catch(() => {});
      });
  }

  if (interaction.commandName === require('./iaDashboard').COMMAND) {
    return require('./iaDashboard').handleIaDashboardCommand(interaction)
      .catch(async (err) => {
        console.error('[Bot] /ia failed:', err.message);
        const msg = { content: `${e('met_cross')} Something went wrong opening the dashboard. (${err.message})`, embeds: [], components: [] };
        await (interaction.deferred || interaction.replied
          ? interaction.editReply(msg)
          : interaction.reply({ ...msg, flags: 64 })).catch(() => {});
      });
  }

  // Read from the module rather than repeated here, so a rename cannot leave the
  // command registered under one name and dispatched under another.
  if (interaction.commandName === require('./iaPanel').COMMAND) {
    return require('./iaPanel').handleIaCommand(interaction)
      .catch(async (err) => {
        console.error(`[Bot] /${require('./iaPanel').COMMAND} failed:`, err.message);
        const msg = { content: `${e('met_cross')} Something went wrong opening that. (${err.message})`, embeds: [], components: [] };
        await (interaction.deferred || interaction.replied
          ? interaction.editReply(msg)
          : interaction.reply({ ...msg, flags: 64 })).catch(() => {});
      });
  }

  if (interaction.commandName === 'met') {
    return require('./metCommand').handleMetCommand(interaction)
      .catch(async (err) => {
        console.error('[Bot] /met failed:', err.message);
        const msg = { content: `${e('met_cross')} Something went wrong posting that. (${err.message})`, embeds: [], components: [] };
        await (interaction.deferred || interaction.replied
          ? interaction.editReply(msg)
          : interaction.reply({ ...msg, flags: 64 })).catch(() => {});
      });
  }

  if (interaction.commandName === 'pendingjoin') {
    return require('./pendingJoinCommand').handlePendingJoinCommand(interaction)
      .catch(async (err) => {
        console.error('[Bot] /pendingjoin failed:', err.message);
        const msg = { content: `${e('met_cross')} Something went wrong · the queue may be part-done, `
          + `so run \`/pendingjoin list\` to see where it got to. (${err.message})`,
          embeds: [], components: [] };
        await (interaction.deferred || interaction.replied
          ? interaction.editReply(msg)
          : interaction.reply({ ...msg, flags: 64 })).catch(() => {});
      });
  }

  if (interaction.commandName === 'loa') {
    return require('./loaCommand').handleLoaCommand(interaction)
      .catch(async (err) => {
        console.error('[Bot] /loa failed:', err.message);
        const msg = { content: `${e('met_cross')} Something went wrong · nothing was changed. (${err.message})`, embeds: [], components: [] };
        await (interaction.deferred || interaction.replied
          ? interaction.editReply(msg)
          : interaction.reply({ ...msg, flags: 64 })).catch(() => {});
      });
  }

  if (interaction.commandName !== 'import-cases') return;

  const DEV = process.env.DEVELOPER_DISCORD_ID || '1227866745201627137';
  if (interaction.user.id !== DEV) {
    return interaction.reply({ content: `${e('met_denied')} You are not authorised to use this command.`, flags: 64 });
  }

  const channel = interaction.options.getChannel('channel');
  const dry     = interaction.options.getBoolean('dry') || false;
  await interaction.deferReply({ flags: 64 }); // 64 = EPHEMERAL

  // Send the very first reply immediately so Discord doesn't expire the token
  await interaction.editReply('⏳ Starting import · fetching forum posts…').catch(() => {});

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
        `${e('met_search')} **Dry run** · found **${s.parsed}** cases, skipped **${s.skipped}** (bad title format).\n` +
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
        `${e('met_tick')} **Import complete** · created **${s.created}** cases (parsed ${s.parsed}, skipped ${s.skipped} bad-format).\n` +
        `Status: Pending ${s.byStatus.PENDING} · Approved ${s.byStatus.APPROVED} · Denied ${s.byStatus.DENIED}\n` +
        `Cases are numbered #1 … #${s.created} oldest → newest.`,
      );
    }
  } catch (err) {
    clearInterval(keepAlive);
    await interaction.editReply(e('met_cross') + ' Import failed: ' + err.message).catch(() => {});
  }
}

/**
 * Start the bot. Called from server/index.js at startup.
 */
function startBot() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.warn('[Bot] No DISCORD_BOT_TOKEN set · bot features disabled.');
    return;
  }
  client.login(token).catch(err => {
    const disallowed = err && (/disallowed intent/i.test(err.message || '') || err.code === 'DisallowedIntents');
    if (WANT_MESSAGE_CONTENT && disallowed) {
      console.warn('[Bot] Message Content intent is NOT enabled in the Discord Developer Portal · starting the bot WITHOUT it. Role assignment still works, but forum + ticket-transcript reads are disabled until you enable "Message Content Intent" in the portal.');
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

// List every text-like channel in the MET guild, flagged with whether the given
// member can VIEW it (locked = No-Access), plus its category. Powers the ticket
// composer's Discord-style `#` channel picker. When no user id is given, access is
// judged against @everyone. Cached briefly per user (channels change rarely).
const _channelListCache = new Map(); // key(discordUserId||'@everyone') → { at, list }
const CHANNEL_LIST_TTL = 5 * 60 * 1000;
async function listGuildChannels(forDiscordUserId) {
  if (!ready) return [];
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) return [];
  const key = forDiscordUserId ? String(forDiscordUserId) : '@everyone';
  const hit = _channelListCache.get(key);
  if (hit && Date.now() - hit.at < CHANNEL_LIST_TTL) return hit.list;
  try {
    const { ChannelType, PermissionsBitField } = require('discord.js');
    const guild = await client.guilds.fetch(guildId);
    const chans = await guild.channels.fetch();
    let member = null;
    if (forDiscordUserId) { try { member = await guild.members.fetch(forDiscordUserId); } catch (e) { member = null; } }
    const subject = member || guild.roles.everyone;
    const VIEW = PermissionsBitField.Flags.ViewChannel;
    const TYPE_LABEL = {
      [ChannelType.GuildText]: 'text',
      [ChannelType.GuildAnnouncement]: 'announcement',
      [ChannelType.GuildForum]: 'forum',
      [ChannelType.GuildVoice]: 'voice',
      [ChannelType.GuildStageVoice]: 'stage',
    };
    const list = [];
    chans.forEach((c) => {
      if (!c || !(c.type in TYPE_LABEL)) return;
      let locked = true;
      try { const p = c.permissionsFor(subject); locked = !(p && p.has(VIEW)); } catch (e) { locked = true; }
      const parent = c.parentId ? chans.get(c.parentId) : null;
      list.push({
        id: c.id,
        name: c.name,
        type: TYPE_LABEL[c.type],
        category: parent ? parent.name : null,
        categoryPosition: parent ? parent.rawPosition : -1,
        position: typeof c.rawPosition === 'number' ? c.rawPosition : 0,
        locked,
      });
    });
    list.sort((a, b) =>
      (a.categoryPosition - b.categoryPosition) ||
      String(a.category || '').localeCompare(String(b.category || '')) ||
      (a.position - b.position) ||
      String(a.name).localeCompare(String(b.name)));
    _channelListCache.set(key, { at: Date.now(), list });
    return list;
  } catch (e) {
    console.error('[bot] listGuildChannels failed:', e.message);
    return hit ? hit.list : [];
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

// A member's roles + names in a SPECIFIC guild, or null. Used to validate a
// picked co-host still holds the HPC-staff role.
async function getGuildMemberRoles(discordUserId, guildId) {
  if (!ready || !guildId || !discordUserId) return null;
  try {
    const guild  = await client.guilds.fetch(guildId);
    const member = await guild.members.fetch(discordUserId);
    return {
      id: member.id,
      username: member.user.username,
      displayName: member.displayName || member.user.username,
      roleIds: member.roles.cache.map(r => r.id),
    };
  } catch { return null; }
}

// A member's Discord DISPLAY style in a guild — like Discord colours a name:
//   { color, gradient, roleName, roleIcon }
//   color    — hex of the highest-position role that has a colour (or null)
//   gradient — [hex,…] when that role is a holographic/gradient role (or null)
//   roleName — the name of that colour role (the "role on their name")
//   roleIcon — that role's icon URL (or null)
// Best-effort: null on any failure. Cached briefly (roles/members change rarely).
const _roleStyleCache = new Map(); // `${guildId}:${discordId}` → { at, style }
function _hex(n) { if (n == null) return null; var v = (Number(n) >>> 0) & 0xffffff; return '#' + v.toString(16).padStart(6, '0'); }
async function getMemberRoleStyle(discordUserId, guildId) {
  if (!ready || !guildId || !discordUserId) return null;
  const key = guildId + ':' + discordUserId;
  const hit = _roleStyleCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.style;
  try {
    const guild  = await client.guilds.fetch(guildId);
    const member = await guild.members.fetch(discordUserId);
    const roles = [...member.roles.cache.values()].filter(r => r.id !== guild.id).sort((a, b) => b.position - a.position);
    // Highest-position role that actually sets a colour (Discord's rule).
    const colourRole = roles.find(r => (r.color && r.color !== 0) || (r.colors && r.colors.primaryColor != null)) || null;
    const nameRole = colourRole || roles[0] || null;
    let color = null, gradient = null;
    if (colourRole) {
      try { color = colourRole.hexColor && colourRole.hexColor !== '#000000' ? colourRole.hexColor : _hex(colourRole.color); } catch (e) { color = _hex(colourRole.color); }
      try {
        var c = colourRole.colors;
        if (c && c.secondaryColor != null) {
          gradient = [c.primaryColor, c.secondaryColor, c.tertiaryColor].filter(x => x != null).map(_hex).filter(Boolean);
          if (!color && gradient.length) color = gradient[0];
        }
      } catch (e) {}
    }
    let roleIcon = null;
    if (nameRole) { try { roleIcon = nameRole.iconURL ? nameRole.iconURL({ size: 32, extension: 'png' }) : null; } catch (e) {} }
    const style = { color: color || null, gradient: gradient || null, roleName: nameRole ? nameRole.name : null, roleIcon };
    _roleStyleCache.set(key, { at: Date.now(), style });
    return style;
  } catch (e) { return null; }
}

// Every member of `guildId` holding `roleId` → [{ id, username, displayName }],
// sorted by display name. Requires the Guild Members intent. [] on any failure.
async function listGuildRoleMembers(guildId, roleId) {
  if (!ready || !guildId || !roleId) return [];
  try {
    const guild = await client.guilds.fetch(guildId);
    const role  = await guild.roles.fetch(roleId).catch(() => null);
    if (!role) { console.warn(`[Bot] role ${roleId} not found in guild ${guildId}`); return []; }
    // role.members only reflects the members currently in the cache — right after
    // boot that can be just a handful (or none), so it must NOT be trusted on its
    // own. Fetch the full member list first (needs the GuildMembers privileged
    // intent, requested in startBot()) so everyone holding the role is seen.
    let members = null;
    try {
      const all = await guild.members.fetch();
      members = all.filter(m => m.roles.cache.has(roleId));
    } catch (e) {
      // Full fetch failed (intent disabled / gateway hiccup) — fall back to
      // whatever the role cache already holds rather than returning nothing.
      console.warn('[Bot] members.fetch failed, using role cache (enable the GuildMembers intent):', e.message);
      members = role.members;
    }
    return [...members.values()]
      .map(m => ({ id: m.id, username: m.user.username, displayName: m.displayName || m.user.username }))
      .sort((a, b) => String(a.displayName || '').localeCompare(String(b.displayName || '')));
  } catch (e) {
    console.error('[Bot] listGuildRoleMembers failed:', e.message);
    return [];
  }
}

/**
 * Assign a role to a guild member.
 * @param {string} discordUserId  — the member to assign to
 * @param {string} roleId         — Discord role ID to assign
 */
/**
 * @param {string} [guildId] which server the role lives in. Defaults to
 *        DISCORD_GUILD_ID, which is what every existing caller wants — but a role
 *        that lives in the MET server has to say so, because this app treats
 *        "the MET server" as MET_GUILD_ID falling back to DISCORD_GUILD_ID
 *        (middleware/division.js, quota.js, ticketIngest.js, emoji.js, and the
 *        command registration all resolve it that way). Hard-coding one of the two
 *        here meant the HPC final-exam role — which lives in MET — was added in the
 *        wrong guild whenever those two ids differ, failing for every single
 *        passer and logging "granted to 0/N".
 */
async function assignRole(discordUserId, roleId, guildId) {
  if (!ready) {
    console.warn('Bot not ready · cannot assign role');
    return false;
  }
  const gid = guildId || process.env.DISCORD_GUILD_ID;
  if (!gid || !roleId) return false;

  try {
    const guild  = await client.guilds.fetch(gid);
    const member = await guild.members.fetch(discordUserId);
    await member.roles.add(roleId);
    console.log(`Role ${roleId} assigned to ${discordUserId}`);
    return true;
  } catch (err) {
    console.error(`Failed to assign role ${roleId} to ${discordUserId} in guild ${gid}:`, err.message);
    return false;
  }
}

/**
 * Set a guild member's server nickname (max 32 chars). Used by the RoVer-style
 * rank sync to keep "RANK | RobloxUsername" current after a rank change. Needs
 * the bot to have Manage Nicknames and a role above the target. Best-effort.
 */
async function setMemberNickname(discordUserId, nick) {
  if (!ready || !nick) return false;
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) return false;
  try {
    const guild  = await client.guilds.fetch(guildId);
    const member = await guild.members.fetch(discordUserId);
    if (!member) return false;
    const clean = String(nick).slice(0, 32);
    if (member.nickname === clean) return true; // already correct — no-op
    await member.setNickname(clean, 'RoVer-style rank sync');
    console.log(`[rover] nickname set for ${discordUserId} → "${clean}"`);
    return true;
  } catch (err) {
    console.warn(`[rover] setNickname failed for ${discordUserId}:`, err.message);
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
  if (!ready) { console.warn('Bot not ready · cannot remove role'); return false; }
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
 * Strip a member of ALL their MET roles across the discipline guilds (the MET
 * server and the primary server), keeping only the roles named in keepRoleIds.
 * Used when somebody is terminated or blacklisted: an officer removed from the
 * group should not still be wearing its rank, division and permission roles.
 *
 * @everyone, managed roles (bots, boosts, integrations) and any role above the
 * bot's own top role are left alone · Discord will not let the bot touch those,
 * and pretending otherwise would report a strip that did not happen. Everything
 * else the member holds is removed.
 *
 * @param {string} discordUserId
 * @param {object} [opts]
 * @param {string[]} [opts.keepRoleIds] role ids to leave in place (e.g. Blacklist)
 * @param {string} [opts.reason]
 * @returns {Promise<{ ok, removed, kept, skipped, guilds:Array }>}
 */
async function stripMetRoles(discordUserId, opts = {}) {
  const out = { ok: false, removed: 0, kept: 0, skipped: 0, guilds: [] };
  if (!ready) { console.warn('Bot not ready · cannot strip roles'); return out; }
  const keep = new Set((opts.keepRoleIds || []).filter(Boolean).map(String));
  const reason = opts.reason || 'MET discipline';
  for (const gid of DISCIPLINE_GUILD_IDS()) {
    const g = { guildId: gid, removed: 0, kept: 0, skipped: 0 };
    try {
      const guild = await client.guilds.fetch(gid);
      const member = await guild.members.fetch(discordUserId).catch(() => null);
      if (!member) { g.note = 'not a member'; out.guilds.push(g); continue; }
      let me = guild.members.me;
      if (!me) me = await guild.members.fetchMe().catch(() => null);
      const myTop = me && me.roles && me.roles.highest ? me.roles.highest.position : 0;
      const remove = [];
      for (const role of member.roles.cache.values()) {
        if (role.id === guild.id) continue;            // @everyone
        if (keep.has(role.id)) { g.kept++; continue; } // deliberately preserved
        if (role.managed || role.position >= myTop) { g.skipped++; continue; } // the bot cannot touch these
        remove.push(role.id);
      }
      if (remove.length) await member.roles.remove(remove, reason);
      g.removed = remove.length;
      out.removed += g.removed; out.kept += g.kept; out.skipped += g.skipped;
      out.ok = true;
    } catch (err) {
      g.error = err.message;
      console.error(`[Discipline] could not strip MET roles in ${gid} for ${discordUserId}:`, err.message);
    }
    out.guilds.push(g);
  }
  return out;
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
      .map(r => ({
        id: r.id, name: r.name,
        color: r.hexColor && r.hexColor !== '#000000' ? r.hexColor : null,
        icon: (typeof r.iconURL === 'function' ? r.iconURL({ size: 24 }) : null) || null,
      }));
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

// ──────────────────────────────────────────────────
// MET tryouts — DM the host when their tryout fires, with buttons to pick a
// co-host and post the announcement. Interaction handlers live in
// onInteraction (customIds prefixed "tryout_").
// ───────────────────────────────────────────────────

// The "Private server link" DM field. Manual-link divisions (CID / MET) prompt
// the host to set their own link; SCO-19 shows the auto-provisioned one.
function privateServerLinkField(tryout) {
  const manual = require('./tryouts').tryoutManualLink(tryout.division);
  if (tryout.privateServerLink) return { name: 'Private server link', value: String(tryout.privateServerLink).slice(0, 1000), inline: false };
  if (manual) return { name: 'Private server link', value: `${e('met_warn')} **Not set** · click **Set Private Server Link** below and paste your own private-server link.`, inline: false };
  return { name: 'Private server link', value: 'Not provisioned · set `TRYOUT_PRIVATE_SERVER_LINK` (or configure dynamic creation).', inline: false };
}

// The action buttons attached to a host's tryout DM: (set link,) pick a co-host,
// and post/update the channel announcement. The announce label reflects whether
// the announcement has already gone out (the game flow auto-announces first).
function tryoutHostDmButtons(tryout) {
  const announced = !!tryout.announcementMsgId;
  const joinable  = !!tryout.joinable;
  const manualLink = require('./tryouts').tryoutManualLink(tryout.division);
  const row = new ActionRowBuilder();
  // Manual-link divisions get a prominent "Set / Update Private Server Link" button.
  if (manualLink) {
    row.addComponents(new ButtonBuilder()
      .setCustomId(`tryout_setlink_${tryout.id}`)
      .setLabel(tryout.privateServerLink ? 'Update Server Link' : 'Set Private Server Link')
      .setStyle(tryout.privateServerLink ? ButtonStyle.Secondary : ButtonStyle.Primary)
      .setEmoji(e('met_link')));
  }
  row.addComponents(
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
  if (!ready) { console.warn('[Tryout] bot not ready · cannot DM host'); return null; }
  try {
    const user  = await client.users.fetch(tryout.hostDiscordId);
    const cfg   = require('./tryouts').divisionConfig(tryout.division);
    const embed = new EmbedBuilder()
      .setColor(tryout.privateServerLink ? 0x2ed896 : 0xf5b730)
      .setTitle(cfg.dmTitle)
      .setDescription(`Your scheduled ${cfg.eventType} has started. Pick a co-host (if applicable), then post the announcement when you\'re ready.`)
      .addFields(
        privateServerLinkField(tryout),
        { name: 'Status', value: require('./tryouts').isServerLocked(tryout) ? 'Locked' : 'Unlocked', inline: true },
      );
    const msg = await user.send({ embeds: [embed], components: [tryoutHostDmButtons(tryout)] });
    return msg.id;
  } catch (e) {
    console.error('[Tryout] sendTryoutHostDM failed:', e.message);
    return null;
  }
}

// ── Patrol + event logs ────────────────────────────────────────────────────
// A new message in PATROL_CHANNEL_ID / EVENTLOGS_CHANNEL_ID that looks like a
// log → capture it for site review. (Pure chat without "shift" and no image is
// ignored.)
async function onPatrolMessage(message) {
  try {
    const ch = String(message.channelId);

    // Closed-ticket logs are posted BY a bot (Tickety), so this has to run
    // before the not-a-bot guard below. Any of the ticket-log channels counts:
    // the MET one, CID's and SCO-19's — Internal Affairs handles all three.
    if (require('./ticketIngest').divisionForChannel(ch)) {
      try { await require('./ticketIngest').ingestMessage(message); }
      catch (e) { console.warn('[TicketLogs] live ingest error:', e.message); }
      return;
    }

    if (message.author && message.author.bot) return;

    // The suggestions channel: react to a suggestion so the room can vote on it,
    // open a thread to discuss it in, delete free chat, and warn ONCE for a whole
    // burst rather than once per message. Every message gets one of those two
    // outcomes — nothing is left untouched. See the module.
    //
    // Messages inside the threads it opens are NOT handled: a thread has its own
    // channel id, so this only ever matches the channel itself. That is the point
    // of the threads — the discussion is somewhere the classifier never looks.
    try {
      const sug = require('./suggestions');
      if (ch === String(sug.CHANNEL_ID())) {
        await sug.onSuggestionMessage(message);
        return;
      }
    } catch (e) { console.warn('[Suggestions] handler error:', e.message); }

    // Promotions/demotions → RankHistory; infractions/strikes → punishment log.
    if (PROMOTIONS_CHANNEL_ID && ch === String(PROMOTIONS_CHANNEL_ID)) {
      await require('./discordIngest').ingestPromotion(message);
      return;
    }
    if (INFRACTIONS_CHANNEL_ID && ch === String(INFRACTIONS_CHANNEL_ID)) {
      await require('./discordIngest').ingestInfraction(message);
      return;
    }

    let type = null;
    if (PATROL_CHANNEL_ID && ch === String(PATROL_CHANNEL_ID)) type = 'PATROL';
    else if (EVENTLOGS_CHANNEL_ID && ch === String(EVENTLOGS_CHANNEL_ID)) type = 'EVENT';
    if (!type) return;
    if (!looksLikeLog(message, type)) return; // skip misc chatter — only actual logs
    const { createFromMessage } = require('./patrolLog');
    await createFromMessage(message, type);
  } catch (e) {
    console.error('[Log] messageCreate error:', e.message);
  }
}

// The "is this a log (vs misc chatter)?" test, shared by live ingestion and the
// backfill. PATROL logs mention a shift or carry proof. EVENT logs vary a lot
// (no reliable keyword), so any non-bot message with real content or an
// attachment in the event channel counts — that's why event logs were being
// dropped before.
function looksLikeLog(message, type) {
  if (message.author && message.author.bot) return false;
  const content = (message.content || '').trim();
  if (type === 'EVENT') {
    const hasAttach = message.attachments && message.attachments.size > 0;
    return hasAttach || content.length > 0;
  }
  // PATROL: the word "shift" alone is NOT enough — casual chatter like
  // "No vc photo on shift end." mentions it but is not a log. Require the message
  // to actually PARSE as a patrol log (a real shift start/end time, or a stated
  // total), or to carry a proof image (image-only logs are still captured).
  const { parsePatrolLog, imageUrls } = require('./patrolLog');
  const parsed = parsePatrolLog(content);
  if (parsed.shiftStart || parsed.shiftEnd || parsed.totalMinutes != null) return true;
  return imageUrls(message).length > 0;
}

// Backfill: walk a log channel's ENTIRE history (oldest included) and ingest
// every patrol/event log through the same createFromMessage path. Idempotent
// (createFromMessage keys on messageId), so it's safe to run repeatedly and
// picks up only what's missing. Best-effort + paced to respect rate limits.
async function backfillLogChannel(channelId, type, opts = {}) {
  if (!ready) return { ok: false, reason: 'bot not ready' };
  if (!channelId) return { ok: false, reason: 'channel not configured' };
  const max = opts.max || 1000000;
  const { createFromMessage } = require('./patrolLog');
  let channel;
  try { channel = await client.channels.fetch(String(channelId)); }
  catch (e) { return { ok: false, reason: 'channel fetch failed: ' + e.message }; }
  if (!channel || typeof channel.messages?.fetch !== 'function') return { ok: false, reason: 'not a text channel' };

  let before = null, scanned = 0, imported = 0, skipped = 0, pages = 0;
  while (scanned < max) {
    // Fetch a page, retrying transient errors so one blip doesn't end the run.
    let batch = null;
    for (let attempt = 0; attempt < 3 && !batch; attempt++) {
      try { batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) }); }
      catch (e) { console.warn(`[Backfill] fetch retry ${attempt + 1}:`, e.message); await new Promise(r => setTimeout(r, 800 * (attempt + 1))); }
    }
    if (!batch) { console.warn('[Backfill] giving up after fetch errors at', before); break; }
    if (batch.size === 0) break;

    // Page strictly backward by the OLDEST (smallest snowflake) id in the batch,
    // regardless of the collection's iteration order.
    let oldest = null;
    for (const msg of batch.values()) {
      scanned++;
      if (oldest === null || BigInt(msg.id) < BigInt(oldest)) oldest = msg.id;
      if (!looksLikeLog(msg, type)) { skipped++; continue; }
      // Reconcile so a re-run also corrects the status/date of earlier imports.
      try { const row = await createFromMessage(msg, type, { reconcile: true }); if (row) imported++; else skipped++; }
      catch (e) { skipped++; }
    }
    before = oldest;
    pages++;
    if (batch.size < 100) break; // reached the start of the channel
    await new Promise(r => setTimeout(r, 350)); // gentle pacing
  }
  console.log(`[Backfill] ${type} ${channelId}: scanned ${scanned}, imported ${imported}, skipped ${skipped} (${pages} pages)`);
  return { ok: true, type, scanned, imported, skipped, pages };
}

// Backfill both configured log channels (patrol + event).
async function backfillPatrolLogs(opts = {}) {
  const out = {};
  if (PATROL_CHANNEL_ID)    out.patrol = await backfillLogChannel(PATROL_CHANNEL_ID, 'PATROL', opts);
  if (EVENTLOGS_CHANNEL_ID) out.event  = await backfillLogChannel(EVENTLOGS_CHANNEL_ID, 'EVENT', opts);
  return out;
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

// Post a Tickety-style "Ticket Closed" (or "Ticket Created") log for a MET-site
// support ticket to the ticket-log channel, using the MET bot. Same layout as
// Tickety but MET-branded (footer + colour). Best-effort; null on any failure.
async function postTicketCloseLog(data = {}) {
  if (!ready || !TICKET_LOG_GUILD_ID || !TICKET_LOG_CHANNEL_ID) return null;
  try {
    const guild = await client.guilds.fetch(TICKET_LOG_GUILD_ID);
    const channel = await guild.channels.fetch(TICKET_LOG_CHANNEL_ID);
    if (!channel || typeof channel.send !== 'function') return null;
    const created = data.kind === 'created';
    const na = (v) => (v == null || v === '') ? 'N/A' : String(v);
    const embed = new EmbedBuilder()
      .setColor(0x1d4ed8) // MET blue
      .setTitle(created ? 'Ticket Created' : 'Ticket Closed')
      .setDescription(`${data.executorMention || na(data.executorName)} ${created ? 'created' : 'closed'} a ticket.`)
      .addFields(
        { name: created ? 'Ticket Information' : 'Close Information',
          value: `**Ticket Name:** ${na(data.ticketName)}\n**Ticket ID:** ${na(data.ticketId)}` + (created ? '' : `\n**Reason:** ${na(data.reason || 'Resolved')}`) },
        { name: 'Creator Information',
          value: `**Creator:** ${data.creatorMention || na(data.creatorName)}\n**Creator Username:** ${data.creatorUsername ? '@' + data.creatorUsername : 'N/A'}\n**Creator ID:** ${na(data.creatorId)}` },
      );
    if (!created) {
      embed.addFields({ name: 'Executor Information',
        value: `**Executor:** ${data.executorMention || na(data.executorName)}\n**Executor Username:** ${data.executorUsername ? '@' + data.executorUsername : 'N/A'}\n**Executor ID:** ${na(data.executorId)}` });
    }
    let iconURL; try { iconURL = guild.iconURL({ size: 64 }) || undefined; } catch (e) {}
    embed.setFooter({ text: 'Metropolitan Police Service · Internal Affairs', iconURL }).setTimestamp(new Date());
    const components = [];
    if (data.transcriptUrl) {
      components.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('View Transcript').setStyle(ButtonStyle.Link).setURL(data.transcriptUrl)));
    }
    const msg = await channel.send({ embeds: [embed], components });
    return msg.id;
  } catch (e) { console.warn('[Bot] postTicketCloseLog failed:', e.message); return null; }
}

// Post a "final exam log" to the HPC server's #final-exam-log channel — the
// marking record (who marked it, the student, percentage, proof) that pings the
// Database Manager role for verification. Format mirrors how it's posted today.
async function postHpcExamLog(data = {}) {
  if (!ready) return null;
  const chId = process.env.FINAL_EXAM_LOG_CHANNEL_ID || '1510117564733460600';
  const gId  = process.env.HPC_GUILD_ID || '1404258349981372589';
  try {
    const channel = await client.channels.fetch(chId);
    if (!channel || typeof channel.send !== 'function') return null;
    // Resolve the "Database Manager" role to ping — by env id (defaulted to the
    // known role), else by name in the guild.
    let roleId = process.env.HPC_DATABASE_MANAGER_ROLE_ID || '1412734182227972117';
    if (!roleId) {
      try { const guild = await client.guilds.fetch(gId); const roles = await guild.roles.fetch(); const role = roles.find(r => /database\s*manager/i.test(r.name)); if (role) roleId = role.id; } catch (e) {}
    }
    const dmMention = roleId ? `<@&${roleId}>` : '@Database Manager';
    const marker = data.markerDiscordId ? `<@${data.markerDiscordId}>` : (data.markerName || 'Unknown');
    const content =
      `Username: ${marker}\n` +
      `Student: ${data.studentName || 'Unknown'}\n` +
      `Percentage: ${data.percentage}%\n` +
      `Proof:\n` +
      `${dmMention}\n` +
      `Roblox Username: ${data.robloxUsername || 'N/A'}\n` +
      `Discord Username: ${data.discordUsername ? '@' + data.discordUsername : 'N/A'}`;
    // Ping ONLY the Database Manager role — never the marker/student.
    const msg = await channel.send({ content, allowedMentions: { roles: roleId ? [roleId] : [], parse: [] } });
    return msg.id;
  } catch (e) { console.warn('[Bot] postHpcExamLog failed:', e.message); return null; }
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
  // Never post twice (e.g. auto-post on schedule + the host's "Send Announcement").
  if (tryout && tryout.announcementSent) return tryout.announcementMsgId || null;
  const db = require('./db');
  // Atomically claim the announcement BEFORE posting so a double-click or a
  // concurrent auto-announce can't both post (and double-ping the role). Only
  // the caller that flips announcementSent false→true proceeds; a loser returns
  // the existing message id. The flag is rolled back if the Discord post fails.
  const claim = await db.tryout.updateMany({ where: { id: tryout.id, announcementSent: false }, data: { announcementSent: true } }).catch(() => ({ count: 0 }));
  if (!claim.count) {
    const fresh = await db.tryout.findUnique({ where: { id: tryout.id } }).catch(() => null);
    return (fresh && fresh.announcementMsgId) || (tryout && tryout.announcementMsgId) || null;
  }
  const { formatAnnouncement, formatCidRecruitment, announcementAllowedMentions, divisionConfig, announceChannelId } = require('./tryouts');
  const chId = announceChannelId(tryout);
  if (!chId) {
    console.warn(`[Tryout] no announce channel configured for division ${tryout.division || 'HPC'} · cannot announce.`);
    await db.tryout.update({ where: { id: tryout.id }, data: { announcementSent: false } }).catch(() => {}); // release claim
    return null;
  }
  try {
    const ch  = await client.channels.fetch(chId);
    const msg = await ch.send({ content: formatAnnouncement(tryout), allowedMentions: announcementAllowedMentions(tryout) });
    const data = { announcementMsgId: msg.id };

    // CID: auto-react ✅ so members react toward the 3-reaction start threshold.
    // Deliberately the stock ✅ and not the MET one: members have to be able to
    // click the SAME reaction to add to the count, and a guild emoji is only
    // free to click for members of the guild it lives in.
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

    await db.tryout.update({ where: { id: tryout.id }, data }).catch(() => {});
    return msg.id;
  } catch (e) {
    console.warn('[Tryout] postTryoutAnnouncement failed:', e.message);
    // Release the claim so a later retry can announce (the send never happened).
    await db.tryout.update({ where: { id: tryout.id }, data: { announcementSent: false } }).catch(() => {});
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
      .setTitle(`${cfg.eventType} · Cancelled`)
      .setDescription('This tryout has been cancelled and its announcement removed from the channel.')
      .addFields({ name: 'Status', value: 'Cancelled', inline: true });
  }
  if (status === 'COMPLETED') {
    return new EmbedBuilder()
      .setColor(0x3b82f6)
      .setTitle(`${cfg.eventType} · Concluded`)
      .setDescription('This tryout has concluded and its announcement removed from the channel. Review and post the results on the site.')
      .addFields(
        { name: 'Status', value: 'Concluded', inline: true },
        ...(reviewUrl ? [{ name: 'Review & post results', value: reviewUrl, inline: false }] : []),
      );
  }

  const joinUrl = require('./tryouts').tryoutJoinUrl(tryout);
  // HPC hosts run their tryouts from the Public Tryout stage — prompt them to
  // join it. CID/SCO-19 have no VC step, so cfg.stageUrl is undefined for them.
  const stageUrl = cfg.stageUrl;
  return new EmbedBuilder()
    .setColor(cfg.dmColor || 0x2ed896)
    .setTitle(cfg.dmTitle)
    .setDescription(`Your tryout has started and been announced. Run it in-game from the ${cfg.panelName}, then conclude it to log the results.`)
    .addFields(
      privateServerLinkField(tryout),
      { name: 'Status', value: require('./tryouts').isServerLocked(tryout) ? 'Locked' : 'Unlocked', inline: true },
      { name: 'Joining', value: tryout.joinable ? `${e('met_online')} Open · players can join via the link below` : `${e('met_offline')} Closed`, inline: true },
      ...(tryout.coHostName ? [{ name: 'Co-host', value: String(tryout.coHostName), inline: true }] : []),
      ...(joinUrl ? [{ name: `${e('met_link')} Join link`, value: joinUrl, inline: false }] : []),
      ...(stageUrl ? [{ name: `${e('met_mic')} Public Tryout stage`, value: `Join the stage to run your tryout: ${stageUrl}`, inline: false }] : []),
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

// DM an IA investigator that a ticket is ready to claim, with a one-tap "Claim"
// link and a one-click "opt out of these DMs" link. Best-effort — returns false
// on closed DMs / not-in-a-shared-guild / bot offline. Requires absolute https
// URLs (Discord link buttons reject relative/invalid URLs).
async function dmTicketAlert(discordId, opts) {
  opts = opts || {};
  if (!ready || !discordId || !/^https:\/\//i.test(opts.claimUrl || '')) return false;
  try {
    const user  = await client.users.fetch(String(discordId));
    const desc  = `**${opts.typeLabel || 'Support ticket'}** opened by **${opts.openerName || 'a member'}**.`
      + (opts.preview ? `\n\n> ${String(opts.preview).slice(0, 300)}` : '')
      + `\n\nTap **Claim ticket** to take it. Don't want these DMs? Use **Opt out** · you can turn them back on any time.`;
    const embed = new EmbedBuilder()
      .setColor(0x4a8fff)
      .setTitle(`${e('met_ticket')} New Internal Affairs ticket`)
      .setDescription(desc);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Claim ticket').setURL(opts.claimUrl),
    );
    if (/^https:\/\//i.test(opts.optOutUrl || '')) {
      row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Opt out of DMs').setURL(opts.optOutUrl));
    }
    await user.send({ embeds: [embed], components: [row] });
    return true;
  } catch (e) {
    return false; // closed DMs / no shared guild — never noisy
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

// Login-code DMs, tracked so we can delete them once the code is used or
// expires — a 6-digit sign-in code shouldn't linger in the member's DMs.
const _loginDms = new Map(); // challengeId -> { message, timer }
const LOGIN_DM_TTL_MS = 10 * 60 * 1000;

// DM a one-time 6-digit sign-in code to a user. Returns true if delivered.
// Used by the "get a code in Discord" login option. Best-effort. If a
// challengeId is given, the DM is auto-deleted after the code's lifetime and
// can be deleted early via deleteLoginDm() once it's consumed.
async function dmLoginCode(discordId, code, challengeId) {
  if (!ready || !discordId || !code) return false;
  try {
    const user  = await client.users.fetch(String(discordId));
    const embed = new EmbedBuilder()
      .setColor(0x3b82f6)
      .setTitle('Your MET sign-in code')
      .setDescription(`Enter this code on the sign-in page to log in:\n\n## \`${code}\`\n\nIt expires in 10 minutes and can only be used once. If you didn't request this, ignore this message · nobody can sign in without it.`);
    const msg = await user.send({ embeds: [embed] });
    if (challengeId) {
      const timer = setTimeout(() => deleteLoginDm(challengeId), LOGIN_DM_TTL_MS);
      if (timer.unref) timer.unref();
      _loginDms.set(String(challengeId), { message: msg, timer });
    }
    return true;
  } catch (e) {
    console.warn('[Auth] dmLoginCode failed:', e.message);
    return false;
  }
}

// Delete a previously-sent login-code DM (once the code is used/expired).
async function deleteLoginDm(challengeId) {
  const key = String(challengeId || '');
  const rec = _loginDms.get(key);
  if (!rec) return false;
  _loginDms.delete(key);
  if (rec.timer) clearTimeout(rec.timer);
  try { await rec.message.delete(); return true; } catch (e) { return false; }
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
      .setTitle(`${cfg.eventType} · auto-cancelled`)
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
      .setTitle(`${cfg.eventType} · log ready to review`)
      .setDescription('Your tryout concluded and a draft log has been queued on the site. Review the attendees, make any edits, then post it for approval.')
      .addFields(
        { name: 'Attendees', value: String(log.totalAttendees ?? 0), inline: true },
        { name: `${e('met_tick')} Passed`,  value: String(log.passedCount ?? 0), inline: true },
        { name: `${e('met_cross')} Failed`,  value: String(log.failedCount ?? 0), inline: true },
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
      .setTitle(`${cfg.eventType} · Summary`)
      .addFields(
        { name: 'Host',      value: host.username ? String(host.username) : '·', inline: true },
        { name: 'Co-Host',   value: coHost && coHost.username ? String(coHost.username) : 'N/A', inline: true },
        { name: 'Duration',  value: fmtDur(summary.durationSecs), inline: true },
        { name: 'Attendees', value: String(n(summary.attendees)), inline: true },
        { name: `${e('met_tick')} Passed`, value: String(n(summary.passed)), inline: true },
        { name: `${e('met_cross')} Failed`, value: String(n(summary.failed)), inline: true },
        { name: `${e('met_warn')} Strikes`, value: String(n(summary.strikes)), inline: true },
        { name: `${e('met_kick')} Kicked`, value: String(n(summary.kicked)), inline: true },
        { name: `${e('met_leave')} Left`,   value: String(n(summary.left)), inline: true },
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

  // "Set / Update Private Server Link" → open a form for the host to paste theirs.
  if (id.startsWith('tryout_setlink_') && interaction.isButton()) {
    const tryoutId = id.slice('tryout_setlink_'.length);
    const t = await prisma.tryout.findUnique({ where: { id: tryoutId }, select: { privateServerLink: true, status: true } }).catch(() => null);
    if (!t) return interaction.reply({ content: 'That tryout no longer exists.', flags: 64 });
    if (['CANCELLED', 'COMPLETED'].includes(String(t.status || '').toUpperCase())) {
      return interaction.reply({ content: 'This tryout is already finished.', flags: 64 });
    }
    const input = new TextInputBuilder()
      .setCustomId('link')
      .setLabel('Private server link')
      .setPlaceholder('https://www.roblox.com/games/...?privateServerLinkCode=...')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(500);
    if (t.privateServerLink) input.setValue(String(t.privateServerLink).slice(0, 500));
    const modal = new ModalBuilder()
      .setCustomId(`tryout_setlinkmodal_${tryoutId}`)
      .setTitle('Private server link')
      .addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }

  // Host submitted the private-server-link form → validate, save, re-render.
  if (id.startsWith('tryout_setlinkmodal_') && interaction.isModalSubmit && interaction.isModalSubmit()) {
    const tryoutId = id.slice('tryout_setlinkmodal_'.length);
    const link = (interaction.fields.getTextInputValue('link') || '').trim();
    if (!/^https?:\/\/(www\.)?roblox\.com\//i.test(link)) {
      return interaction.reply({ content: e('met_warn') + ' That doesn’t look like a Roblox link. Paste the full private-server link (it starts with `https://www.roblox.com/…`).', flags: 64 });
    }
    const updated = await prisma.tryout.update({ where: { id: tryoutId }, data: { privateServerLink: link.slice(0, 500) } }).catch(() => null);
    if (!updated) return interaction.reply({ content: 'That tryout no longer exists.', flags: 64 });
    if (updated.announcementMsgId) await editTryoutAnnouncement(updated).catch(() => {});
    await editTryoutHostDM(updated).catch(() => {});
    return interaction.reply({
      content: e('met_tick') + ' Private server link saved · it’s now in your tryout details' + (updated.announcementMsgId ? ' and the announcement has been updated.' : '. Post the announcement when you’re ready.'),
      flags: 64,
    });
  }

  // "Pick Co-Host" → show a member picker.
  if (id.startsWith('tryout_cohost_') && interaction.isButton()) {
    const tryoutId = id.slice('tryout_cohost_'.length);
    const t = await prisma.tryout.findUnique({ where: { id: tryoutId }, select: { hostDiscordId: true, division: true } }).catch(() => null);
    const cfg = coHostStaffConfig(t && t.division);
    // Unrestricted division → keep the original "pick anybody" user select.
    if (!cfg) {
      const row = new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder().setCustomId(`tryout_cohostsel_${tryoutId}`).setPlaceholder('Select a co-host').setMinValues(1).setMaxValues(1),
      );
      return interaction.reply({ content: 'Select the co-host for this tryout:', components: [row], flags: 64 });
    }
    // Restricted → only offer members holding the division's staff role.
    let staff = [];
    try { staff = await listGuildRoleMembers(cfg.guildId, cfg.roleId); }
    catch (e) { console.error('[Bot] co-host staff fetch failed:', e.message); }
    staff = staff.filter(m => !t || String(m.id) !== String(t.hostDiscordId)); // not yourself
    if (!staff.length) {
      // The staff role is empty / misconfigured, or the member list couldn't be
      // fetched. Don't dead-end the host — fall back to the open picker so they
      // can still choose any member as co-host.
      console.warn(`[Bot] co-host: no members for staff role ${cfg.roleId} in guild ${cfg.guildId} · falling back to the open picker.`);
      const row = new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder().setCustomId(`tryout_cohostsel_${tryoutId}`).setPlaceholder('Select a co-host').setMinValues(1).setMaxValues(1),
      );
      return interaction.reply({ content: 'Select the co-host for this tryout:', components: [row], flags: 64 });
    }
    const capped = staff.slice(0, 25); // Discord select menus allow at most 25 options
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`tryout_cohostsel_${tryoutId}`)
      .setPlaceholder('Select a staff co-host')
      .setMinValues(1).setMaxValues(1)
      .addOptions(capped.map(m => ({ label: (m.displayName || m.username || 'Unknown').slice(0, 100), description: ('@' + (m.username || '')).slice(0, 100), value: m.id })));
    const row = new ActionRowBuilder().addComponents(menu);
    const note = staff.length > 25 ? `\n(Showing the first 25 of ${staff.length} staff.)` : '';
    return interaction.reply({ content: 'Select the co-host for this tryout (staff only):' + note, components: [row], flags: 64 });
  }

  // Co-host chosen via the ANYBODY user-select (unrestricted divisions).
  if (id.startsWith('tryout_cohostsel_') && interaction.isUserSelectMenu && interaction.isUserSelectMenu()) {
    const tryoutId = id.slice('tryout_cohostsel_'.length);
    const picked   = interaction.users.first();
    const coName   = picked ? (picked.globalName || picked.username) : null;
    await prisma.tryout.update({ where: { id: tryoutId }, data: { coHostDiscordId: picked ? picked.id : null, coHostName: coName } }).catch(() => {});
    const fresh0 = await prisma.tryout.findUnique({ where: { id: tryoutId } }).catch(() => null);
    if (fresh0) { await editTryoutAnnouncement(fresh0).catch(() => {}); await editTryoutHostDM(fresh0).catch(() => {}); }
    return interaction.update({ content: `${e('met_tick')} Co-host set to **${coName}**.`, components: [] });
  }

  // Co-host chosen via the STAFF-only string select — value is the member's id.
  if (id.startsWith('tryout_cohostsel_') && interaction.isStringSelectMenu && interaction.isStringSelectMenu()) {
    const tryoutId = id.slice('tryout_cohostsel_'.length);
    const pickedId = (interaction.values && interaction.values[0]) || null;
    const t2  = await prisma.tryout.findUnique({ where: { id: tryoutId }, select: { division: true } }).catch(() => null);
    const cfg = coHostStaffConfig(t2 && t2.division);
    // Re-validate the pick still holds the division's staff role (defence in depth).
    let coName = null, ok = false;
    if (pickedId && cfg) {
      try {
        const info = await getGuildMemberRoles(pickedId, cfg.guildId);
        if (info && Array.isArray(info.roleIds) && info.roleIds.map(String).includes(String(cfg.roleId))) {
          ok = true; coName = info.displayName || info.username || null;
        }
      } catch (e) { /* fall through to rejection */ }
    }
    if (!ok) return interaction.update({ content: e('met_warn') + ' That member is not eligible staff · co-host not set.', components: [] });
    await prisma.tryout.update({ where: { id: tryoutId }, data: { coHostDiscordId: pickedId, coHostName: coName } }).catch(() => {});
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
        ? (hasLink ? `${e('met_tick')} Joining is **open** · the Join link is now in the announcement.`
                   : `${e('met_tick')} Joining is **open**. (No place id configured, so no launch link was added · set \`TRYOUT_JOIN_PLACE_ID\`.)`)
        : `${e('met_stop')} Joining is **closed** · new joins are stopped and the Join link removed.`,
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
    const { announceChannelId, tryoutManualLink } = require('./tryouts');
    // Manual-link divisions must have their private-server link set before the
    // announcement goes out (so it isn't posted with a "TBA" link).
    if (tryoutManualLink(t.division) && !t.privateServerLink) {
      return interaction.reply({ content: e('met_warn') + ' Set your **private server link** first (click **Set Private Server Link** above), then post the announcement.', flags: 64 });
    }
    if (!announceChannelId(t)) {
      return interaction.reply({ content: e('met_warn') + ' No announcement channel configured for this division.', flags: 64 });
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
        ? (updated ? e('met_announce') + ' Announcement updated!' : e('met_announce') + ' Announcement posted! It will now update itself automatically whenever anything changes.')
        : 'Failed to post the announcement.',
      flags: 64,
    });
  }
}

// ──────────────────────────────────────────────────
// Discord moderation — ban / unban / kick / timeout ("mute"). Used by the
// Dev Panel's Discord Moderation tool (server/routes/admin.js). Every action
// operates on DISCORD_GUILD_ID by default, or an explicit guildId if passed
// (e.g. the MET server, if it differs from the dashboard's primary guild).
// ──────────────────────────────────────────────────

function targetGuildId(guildId) { return guildId || process.env.DISCORD_GUILD_ID; }

// Search guild members by username/nickname/ID substring — for the moderation
// tool's member picker. Returns up to `limit` matches (Discord caps a single
// fetch({query}) at 1000; we ask for a bit more than `limit` and trim).
async function searchGuildMembers(query, limit = 25, guildId) {
  if (!ready) throw new Error('Bot is not connected yet · try again shortly.');
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

  const q = String(query || '').trim();
  const out = new Map();
  try {
    const results = await guild.members.fetch({ query: q, limit: Math.min(limit, 100) });
    for (const m of results.values()) out.set(m.id, m);
  } catch (e) { /* fall through to the cache pass */ }

  // Substring pass over the cached members. Discord's `query` search only matches
  // the START of a username/nickname, so a Roblox name that sits mid-nickname
  // (RoVer nicknames are "RANK | RobloxName") is never returned. Scanning the
  // cache for a substring match catches those.
  const ql = q.toLowerCase();
  if (ql.length >= 2) {
    for (const m of guild.members.cache.values()) {
      if (out.has(m.id)) continue;
      const hay = ((m.nickname || '') + ' ' + ((m.user && m.user.username) || '') + ' ' + (m.displayName || '')).toLowerCase();
      if (hay.includes(ql)) out.set(m.id, m);
      if (out.size >= limit * 4) break;
    }
  }
  return [...out.values()].slice(0, limit).map(memberSummary);
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

// Which guild a tryout's Scheduled Event lives in: CID tryouts → CID server;
// everything else (HPC/MET, SCO-19) → the MET server.
function tryoutGuildId(division) {
  if (String(division || '').toUpperCase() === 'CID') return process.env.CID_GUILD_ID || null;
  return process.env.MET_GUILD_ID || process.env.DISCORD_GUILD_ID || null;
}

// Create a native Discord Scheduled Event for a tryout (best-effort). External
// events REQUIRE an end time + a location. Returns the event id, or null.
async function createTryoutScheduledEvent(tryout, guildId) {
  if (!ready || !guildId || !tryout) return null;
  try {
    const cfg   = require('./tryouts').divisionConfig(tryout.division);
    const guild = await guild_(guildId);
    const start = new Date(tryout.scheduledAt);
    if (isNaN(start) || start.getTime() <= Date.now()) return null; // must be future
    const end   = new Date(start.getTime() + 60 * 60 * 1000);
    const ev = await guild.scheduledEvents.create({
      name: cfg.eventType,
      scheduledStartTime: start,
      scheduledEndTime: end,
      privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
      entityType: GuildScheduledEventEntityType.External,
      entityMetadata: { location: process.env.TRYOUT_EVENT_LOCATION || 'Hendon Police Campus' },
      description: `${cfg.eventType} hosted by ${tryout.hostName}`,
    });
    return ev.id;
  } catch (e) {
    console.warn('[Tryout] createTryoutScheduledEvent failed:', e.message);
    return null;
  }
}

// Delete a tryout's Scheduled Event (best-effort) on cancel/complete.
async function deleteTryoutScheduledEvent(tryout, guildId) {
  if (!ready || !guildId || !tryout || !tryout.scheduledEventId) return false;
  try {
    const guild = await guild_(guildId);
    await guild.scheduledEvents.delete(tryout.scheduledEventId);
    return true;
  } catch (e) {
    console.warn('[Tryout] deleteTryoutScheduledEvent failed:', e.message);
    return false;
  }
}

// List (optionally filtered by username/ID substring) currently-banned users.
// Discord has no server-side ban search, so this fetches the full ban list
// (fine for a single-server community) and filters in memory.
async function listGuildBans(search, guildId) {
  if (!ready) throw new Error('Bot is not connected yet · try again shortly.');
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
  if (!ready) throw new Error('Bot is not connected yet · try again shortly.');
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
  if (!ready) throw new Error('Bot is not connected yet · try again shortly.');
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
  if (!ready) throw new Error('Bot is not connected yet · try again shortly.');
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
  if (!ready) throw new Error('Bot is not connected yet · try again shortly.');
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

// Generic DM to a member with an optional "Appeal / view details" link button.
// Used for punishment, demotion and promotion notices. Best-effort — a member
// with DMs closed just silently doesn't receive it.
async function dmMemberNotice(discordId, o) {
  if (!ready || !discordId || !o) return false;
  try {
    const user  = await client.users.fetch(String(discordId));
    const embed = new EmbedBuilder()
      .setColor(o.color || 0x3b82f6)
      .setTitle(o.title || 'MET Notice')
      .setDescription(o.description || '​')
      .setFooter({ text: o.footer || 'Metropolitan Police Service' });
    // A disciplinary notice reads far better as fields than as one block of
    // text, and the officer's own avatar makes it unmistakably about them.
    if (Array.isArray(o.fields) && o.fields.length) embed.addFields(o.fields.slice(0, 25));
    if (o.thumbnail)  embed.setThumbnail(o.thumbnail);
    if (o.timestamp)  embed.setTimestamp(new Date(o.timestamp));
    if (o.authorName) embed.setAuthor({ name: o.authorName, iconURL: o.authorIcon || undefined });

    // Any number of link buttons. `appealUrl`/`appealLabel` stay for the
    // callers that only ever wanted one.
    const links = Array.isArray(o.links) ? o.links.slice() : [];
    if (o.appealUrl) links.unshift({ label: o.appealLabel || 'Appeal / view details', url: o.appealUrl });
    const components = [];
    if (links.length) {
      components.push(new ActionRowBuilder().addComponents(
        ...links.slice(0, 5).map(l => new ButtonBuilder()
          .setStyle(ButtonStyle.Link).setLabel(String(l.label).slice(0, 80)).setURL(l.url)),
      ));
    }
    await user.send({ embeds: [embed], components });
    return true;
  } catch (e) {
    console.warn('[Notice] dmMemberNotice failed:', e.message);
    return false;
  }
}

// ── CAD voice picker helpers ─────────────────────────────────────────
// Every guild the bot is a member of (for the CAD server picker).
async function listBotGuilds() {
  if (!ready) return [];
  try {
    const guilds = [];
    for (const g of client.guilds.cache.values()) guilds.push({ id: g.id, name: g.name });
    guilds.sort((a, b) => a.name.localeCompare(b.name));
    return guilds;
  } catch (e) { return []; }
}
// Voice + stage channels in a guild (for the CAD voice-channel picker).
async function listGuildVoiceChannels(guildId) {
  if (!ready || !guildId) return [];
  try {
    const { ChannelType } = require('discord.js');
    const guild = await client.guilds.fetch(String(guildId));
    const chans = await guild.channels.fetch();
    const out = [];
    chans.forEach((c) => {
      if (c && (c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice)) {
        out.push({ id: c.id, name: c.name, stage: c.type === ChannelType.GuildStageVoice });
      }
    });
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  } catch (e) { return []; }
}

module.exports = {
  startBot, assignRole, removeRole, stripMetRoles, setMemberNickname, dmMemberNotice, getMemberDisplayName, listGuildChannels, lookupMember, getMemberRecord,
  listBotGuilds, listGuildVoiceChannels,
  findMemberByUsername, parseRankNick, getRobloxNameFromNick, findMemberByRobloxNick,
  getRoleHolders, setExclusiveRoleHolder, getGuildMemberInfo, getMetMemberProfile, startRoleExpiryChecker,
  matchTicketTranscript, getClient,
  searchGuildMembers, listGuildBans, banMember, unbanMember, kickMember, timeoutMember,
  sendTryoutHostDM, editTryoutAnnouncement, postTryoutAnnouncement, deleteTryoutAnnouncement, dmTryoutStarted, editTryoutHostDM,
  postTryoutSummary, dmTryoutLogReady, dmTryoutAutoCancelled, dmInstallLink, dmTicketAlert, dmLoginCode, deleteLoginDm,
  reactToMessage, postChannelMessage, editChannelMessage, postTicketCloseLog, postHpcExamLog,
  registerCommands, buildCommandPlan, listRegisteredCommands,
  createTryoutScheduledEvent, deleteTryoutScheduledEvent, tryoutGuildId,
  backfillLogChannel, backfillPatrolLogs,
  getGuildMemberRoles, listGuildRoleMembers, getMemberRoleStyle,
  isReady: () => ready,
};
