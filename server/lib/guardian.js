// server/lib/guardian.js
// Anti-nuke. Watches the audit log in real time and stops a destructive spree
// while it is happening, rather than reporting it afterwards.
//
// The threat this is built against is the ordinary one: somebody gets admin,
// through a compromised staff account or a bot they control, and mass-kicks,
// mass-bans, or deletes the channels. The attacker does not need to be clever;
// they need about ninety seconds. So the only useful defence is one that reacts
// in single-digit seconds without a human being awake.
//
// THE DESIGN CONSTRAINT THAT MATTERS MOST: this must not touch ordinary staff
// doing ordinary work. A moderator banning a raider, an HR lead kicking a
// leaver, an admin tidying a channel: none of that can ever trip this. That is
// why every rule below is a BURST rule with a threshold far above normal use,
// why the owner and anyone trusted are never actioned, why a human's first
// response is to have their dangerous roles removed rather than to be banned,
// and why there is a circuit breaker that shuts the whole thing off if it ever
// starts acting on lots of people at once — because that pattern means the
// guardian is the thing malfunctioning, not the server.
'use strict';

const { AuditLogEvent, PermissionFlagsBits, EmbedBuilder } = require('discord.js');

// ── Where it shouts ──────────────────────────────────────────────────────
const ALERT_CHANNEL = () => process.env.GUARDIAN_ALERT_CHANNEL_ID || '1458943564456399091';

// ── Who it will never act against ────────────────────────────────────────
// The guild owner is always exempt. Anyone here is too. Set
// GUARDIAN_TRUSTED_IDS to a comma-separated list of user ids.
function trustedIds() {
  return new Set(String(process.env.GUARDIAN_TRUSTED_IDS || '')
    .split(',').map(s => s.trim()).filter(Boolean));
}

// ── Mode ─────────────────────────────────────────────────────────────────
//   enforce  detect, contain and alert          (the default)
//   monitor  detect and alert, change nothing   (for a nervous first week)
//   off      do nothing at all
function mode() {
  const m = String(process.env.GUARDIAN_MODE || 'enforce').toLowerCase();
  return ['enforce', 'monitor', 'off'].includes(m) ? m : 'enforce';
}

// ── The rules ────────────────────────────────────────────────────────────
// Every threshold is a COUNT within a WINDOW, chosen to sit well above what
// real moderation looks like. A human moderator does not kick five people in
// twelve seconds; a script does nothing else.
//
// `bots` is the threshold when the actor is a bot, and it is always tighter: a
// bot that mass-kicks is never doing something legitimate, and "it uses other
// bots to give me administrator" is exactly the attack described.
const RULES = {
  [AuditLogEvent.MemberKick]:       { key: 'kick',        windowMs: 12000, humans: 5, bots: 3, severity: 'high',     what: 'kicked members' },
  [AuditLogEvent.MemberBanAdd]:     { key: 'ban',         windowMs: 12000, humans: 5, bots: 3, severity: 'high',     what: 'banned members' },
  [AuditLogEvent.ChannelDelete]:    { key: 'chandel',     windowMs: 20000, humans: 3, bots: 2, severity: 'critical', what: 'deleted channels' },
  [AuditLogEvent.RoleDelete]:       { key: 'roledel',     windowMs: 20000, humans: 3, bots: 2, severity: 'critical', what: 'deleted roles' },
  [AuditLogEvent.ChannelCreate]:    { key: 'chancreate',  windowMs: 20000, humans: 8, bots: 5, severity: 'medium',   what: 'created channels' },
  [AuditLogEvent.WebhookCreate]:    { key: 'webhook',     windowMs: 20000, humans: 5, bots: 3, severity: 'high',     what: 'created webhooks' },
  [AuditLogEvent.MemberRoleUpdate]: { key: 'roleassign',  windowMs: 15000, humans: 12, bots: 8, severity: 'medium',  what: 'changed member roles' },
  [AuditLogEvent.MemberUpdate]:     { key: 'memberupd',   windowMs: 15000, humans: 20, bots: 12, severity: 'low',    what: 'edited members' },
};

// Permissions that let somebody finish the job. Granting any of these is
// treated as an event in its own right, with a threshold of one, because there
// is no burst to wait for: one Administrator grant is the whole attack.
const DANGEROUS = [
  ['Administrator',    PermissionFlagsBits.Administrator],
  ['ManageGuild',      PermissionFlagsBits.ManageGuild],
  ['ManageRoles',      PermissionFlagsBits.ManageRoles],
  ['ManageChannels',   PermissionFlagsBits.ManageChannels],
  ['ManageWebhooks',   PermissionFlagsBits.ManageWebhooks],
  ['BanMembers',       PermissionFlagsBits.BanMembers],
  ['KickMembers',      PermissionFlagsBits.KickMembers],
  ['MentionEveryone',  PermissionFlagsBits.MentionEveryone],
];

// ── The circuit breaker ──────────────────────────────────────────────────
// If the guardian would act against more than this many distinct actors inside
// this window, it stops acting and only alerts. Acting on many people at once
// is not what a nuke looks like; it is what a bug looks like.
const BREAKER_WINDOW_MS = 60000;
const BREAKER_MAX_ACTORS = 3;
let breakerHits = [];
let breakerTrippedAt = 0;

// ── State ────────────────────────────────────────────────────────────────
/** actorId -> ruleKey -> timestamps[] */
const windows = new Map();
/** actorId -> when we last acted, so one spree is not punished ten times */
const actedAt = new Map();
const ACT_COOLDOWN_MS = 30000;
/** recent incidents, newest first, for the dashboard and /guardian status */
let incidents = [];
const MAX_INCIDENTS = 200;

let started = false;
let lockdown = false;

function now() { return Date.now(); }

function bump(actorId, key, windowMs) {
  if (!windows.has(actorId)) windows.set(actorId, new Map());
  const byKey = windows.get(actorId);
  const t = now();
  const list = (byKey.get(key) || []).filter(ts => t - ts < windowMs);
  list.push(t);
  byKey.set(key, list);
  return list.length;
}

function record(inc) {
  incidents.unshift({ ...inc, at: now() });
  if (incidents.length > MAX_INCIDENTS) incidents.length = MAX_INCIDENTS;
}

// ── Alerting ─────────────────────────────────────────────────────────────
async function alert(client, inc) {
  const colour = inc.severity === 'critical' ? 0xF0616F
               : inc.severity === 'high'     ? 0xE5A03F
               : 0x5B8DEF;
  const embed = new EmbedBuilder()
    .setTitle(inc.contained ? 'Nuke attempt contained' : 'Suspicious activity')
    .setColor(colour)
    .setDescription(inc.summary)
    .addFields(
      { name: 'Who',    value: `<@${inc.actorId}>${inc.actorIsBot ? ' · a bot' : ''}\n\`${inc.actorId}\``, inline: true },
      { name: 'What',   value: inc.detail || inc.what || 'unknown', inline: true },
      { name: 'Action', value: inc.action || 'alert only', inline: true },
    )
    .setTimestamp(new Date());
  if (inc.note) embed.addFields({ name: 'Note', value: inc.note });

  try {
    const ch = await client.channels.fetch(ALERT_CHANNEL()).catch(() => null);
    if (!ch || !ch.send) { console.error('[Guardian] alert channel unreachable'); return; }
    // A ping, because the whole point is that somebody finds out now.
    const ping = inc.severity === 'critical' || inc.contained ? '@here ' : '';
    await ch.send({ content: ping || undefined, embeds: [embed] });
  } catch (e) {
    console.error('[Guardian] could not post alert:', e.message);
  }
  // And onto the site, so it is on the security page too.
  try {
    require('./events').broadcast('guardian_alert', {
      severity: inc.severity, summary: inc.summary, actorId: inc.actorId, at: inc.at || now(),
    });
  } catch (e) {}
}

// ── Containment ──────────────────────────────────────────────────────────
// Take away the ability to continue, without taking away the person. For a
// human this is their dangerous roles: they keep their account, their identity
// and their history, and somebody can put it back in thirty seconds if this was
// wrong. For a bot it is every role, which stops it dead.
async function contain(guild, actorId, isBot) {
  const out = { removed: [], failed: [] };
  const member = await guild.members.fetch(actorId).catch(() => null);
  if (!member) return { ...out, note: 'that account is no longer in the server' };

  for (const role of member.roles.cache.values()) {
    if (role.id === guild.id) continue;                     // @everyone
    const risky = isBot || DANGEROUS.some(([, bit]) => role.permissions.has(bit));
    if (!risky) continue;
    // A role the bot cannot reach is not a failure of nerve, it is a hierarchy
    // fact, and it is worth reporting rather than silently skipping.
    if (role.position >= (guild.members.me ? guild.members.me.roles.highest.position : 0)) {
      out.failed.push(`${role.name} (above the bot)`); continue;
    }
    try { await member.roles.remove(role, 'Guardian: containing a destructive spree'); out.removed.push(role.name); }
    catch (e) { out.failed.push(`${role.name} (${e.message})`); }
  }
  return out;
}

function breakerOk(actorId) {
  const t = now();
  breakerHits = breakerHits.filter(h => t - h.at < BREAKER_WINDOW_MS);
  if (!breakerHits.some(h => h.actorId === actorId)) breakerHits.push({ actorId, at: t });
  const distinct = new Set(breakerHits.map(h => h.actorId)).size;
  if (distinct > BREAKER_MAX_ACTORS) {
    if (!breakerTrippedAt) {
      breakerTrippedAt = t;
      console.error(`[Guardian] CIRCUIT BREAKER: would have acted against ${distinct} different accounts in a minute. `
        + 'That is not what a nuke looks like, so enforcement is paused and this is alert-only until it settles.');
    }
    return false;
  }
  return true;
}

// ── The handler ──────────────────────────────────────────────────────────
async function onAuditEntry(client, entry, guild) {
  if (mode() === 'off') return;
  const actorId = entry.executorId ? String(entry.executorId) : null;
  if (!actorId) return;
  if (actorId === client.user.id) return;                   // us
  if (actorId === guild.ownerId) return;                    // the owner, always
  if (trustedIds().has(actorId)) return;

  const executor = entry.executor || await client.users.fetch(actorId).catch(() => null);
  const actorIsBot = !!(executor && executor.bot);

  // 1. A dangerous permission being granted. No burst: one is the attack.
  const escalation = permissionEscalation(entry);
  if (escalation) {
    return handle(client, guild, {
      actorId, actorIsBot, severity: 'critical',
      what: 'granted dangerous permissions',
      detail: escalation,
      summary: `<@${actorId}> granted **${escalation}**. That is the permission set a takeover needs, so it was contained immediately.`,
    });
  }

  // 2. A burst of something destructive.
  const rule = RULES[entry.action];
  if (!rule) return;
  const count = bump(actorId, rule.key, rule.windowMs);
  const limit = actorIsBot ? rule.bots : rule.humans;
  if (count < limit) return;

  return handle(client, guild, {
    actorId, actorIsBot, severity: rule.severity,
    what: rule.what,
    detail: `${count} × ${rule.what} in ${Math.round(rule.windowMs / 1000)}s`,
    summary: `<@${actorId}> ${rule.what} **${count} times in ${Math.round(rule.windowMs / 1000)} seconds**. `
           + `Ordinary moderation does not look like this.`,
  });
}

/** The Administrator-shaped changes in a role or member update, if any. */
function permissionEscalation(entry) {
  if (entry.action !== AuditLogEvent.RoleUpdate && entry.action !== AuditLogEvent.RoleCreate) return null;
  const change = (entry.changes || []).find(c => c.key === 'permissions' || c.key === 'permissions_new');
  if (!change) return null;
  let before = 0n, after = 0n;
  try { before = BigInt(change.old || 0); } catch (e) {}
  try { after  = BigInt(change.new || 0); } catch (e) {}
  const gained = DANGEROUS.filter(([, bit]) => (after & bit) === bit && (before & bit) !== bit).map(([name]) => name);
  return gained.length ? gained.join(', ') : null;
}

async function handle(client, guild, inc) {
  // One spree, one response.
  const last = actedAt.get(inc.actorId) || 0;
  if (now() - last < ACT_COOLDOWN_MS) return;
  actedAt.set(inc.actorId, now());

  const enforcing = mode() === 'enforce' && !breakerTrippedAt && breakerOk(inc.actorId);

  if (!enforcing) {
    inc.action = mode() === 'monitor' ? 'none · monitor mode'
               : breakerTrippedAt ? 'none · circuit breaker tripped'
               : 'none';
    record(inc);
    await alert(client, inc);
    return;
  }

  const res = await contain(guild, inc.actorId, inc.actorIsBot);
  inc.contained = res.removed.length > 0;
  inc.action = res.removed.length
    ? `removed ${res.removed.length} role(s): ${res.removed.slice(0, 6).join(', ')}`
    : 'could not remove any role';
  if (res.failed.length) inc.note = `Could not remove: ${res.failed.slice(0, 4).join(', ')}`;
  if (res.note) inc.note = res.note;

  record(inc);
  await alert(client, inc);
  console.error(`[Guardian] ${inc.actorId} · ${inc.detail} · ${inc.action}`);
}

// ── Lockdown ─────────────────────────────────────────────────────────────
// The manual stop. Denies send-messages to @everyone across every text channel,
// which buys time without deleting anything or removing anybody.
async function setLockdown(guild, on, reason) {
  const everyone = guild.roles.everyone;
  let changed = 0, failed = 0;
  for (const ch of guild.channels.cache.values()) {
    if (!ch.permissionOverwrites || typeof ch.permissionOverwrites.edit !== 'function') continue;
    try {
      await ch.permissionOverwrites.edit(everyone, { SendMessages: on ? false : null }, { reason });
      changed++;
    } catch (e) { failed++; }
  }
  lockdown = !!on;
  return { changed, failed, lockdown };
}

// ── Wiring ───────────────────────────────────────────────────────────────
function start(client) {
  if (started) return;
  started = true;

  client.on('guildAuditLogEntryCreate', (entry, guild) => {
    onAuditEntry(client, entry, guild).catch(e => console.error('[Guardian] handler error:', e.message));
  });

  // A bot joining is how "it uses other bots to give me administrator" starts,
  // so it is always worth saying out loud, even though it is not actioned.
  client.on('guildMemberAdd', async member => {
    try {
      if (!member.user.bot) return;
      const inc = {
        actorId: member.id, actorIsBot: true, severity: 'high',
        what: 'a bot joined the server', detail: 'bot added',
        action: 'alert only',
        summary: `A bot, <@${member.id}>, was just added to **${member.guild.name}**. `
               + 'If you did not add it, remove it now.',
      };
      record(inc);
      await alert(client, inc);
    } catch (e) {}
  });

  // Let the breaker reset once things are quiet.
  const t = setInterval(() => {
    if (breakerTrippedAt && now() - breakerTrippedAt > 5 * 60 * 1000) {
      breakerTrippedAt = 0; breakerHits = [];
      console.log('[Guardian] circuit breaker reset; enforcement is on again.');
    }
  }, 30000);
  if (t.unref) t.unref();

  console.log(`[Guardian] watching · mode=${mode()} · trusted=${trustedIds().size} · alerts → ${ALERT_CHANNEL()}`);
}

function status() {
  return {
    mode: mode(), lockdown,
    breakerTripped: !!breakerTrippedAt,
    trusted: [...trustedIds()],
    alertChannel: ALERT_CHANNEL(),
    incidents: incidents.length,
    recent: incidents.slice(0, 20),
  };
}

module.exports = {
  start, status, setLockdown, RULES, DANGEROUS,
  // exported for the tests
  _internals: { bump, permissionEscalation, breakerOk, windows, RULES },
};
