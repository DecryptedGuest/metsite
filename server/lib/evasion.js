// server/lib/evasion.js
// Blacklist and punishment evasion — the record follows the ROBLOX account, not
// the Discord one.
//
// The hole this closes: every punishment used to be keyed on a Discord id.
// Blacklist somebody, they make a new Discord account, re-verify the same Roblox
// user with RoVer, and rejoin — and to the bot they are a stranger with a clean
// slate, because none of the roles or rows are on the new id. The record was
// real all along; it was just being looked up by the wrong key.
//
// So on every join we resolve the member's Roblox id, gather what that Roblox
// identity carries across EVERY Discord account it has ever been seen on, and:
//
//   * re-apply any still-active NON-exile punishment role the new account is
//     missing (a strike or suspension is the person's, not the account's) — but
//     never auto-apply a blacklist or termination to a new account, because a
//     wrong RoVer match must not exile the wrong person;
//   * when the identity is blacklisted, or an active punishment sits on a
//     DIFFERENT account, post a detailed alert to Internal Affairs with buttons
//     to blacklist, kick, view the record or dismiss it.
//
// The flag is written to the database and is permanent. One per (robloxId,
// discordId), so the same alt rejoining does not re-post.

const prisma = require('./db');
const { e } = require('./emoji');
const { ACTION_CONFIG } = require('./actions');

// The IA server and the channel evasion alerts go to.
const IA_GUILD_ID       = () => process.env.IA_GUILD_ID || '1424498408009240649';
const IA_ALERT_CHANNEL  = () => process.env.IA_ALERT_CHANNEL_ID || '1534508917718126653';
// Which servers a join is worth scanning. The MET server is the one being
// evaded; DISCORD_GUILD_ID as a fallback for a single-server deployment.
function watchedGuildIds() {
  return [...new Set([process.env.MET_GUILD_ID, process.env.DISCORD_GUILD_ID].filter(Boolean).map(String))];
}
const ENABLED = () => String(process.env.EVASION_ALERTS || '').toLowerCase() !== 'off';

function short(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// The actions that mean "blacklisted" wherever they appear on a case.
const BLACKLIST_ACTIONS = new Set(['Blacklist']);
const EXILE_ACTIONS = new Set(
  Object.entries(ACTION_CONFIG).filter(([, c]) => c && c.exile).map(([k]) => k),
);
// Punishment TYPES on a MetPunishment that count as a blacklist/ban.
const BLACKLIST_TYPES = /^(blacklist|ban)$/i;

// The action NAMES on a case. `kase.actions` is a JSON array of objects
// ({ action, roleId, durationDays }), not strings, so pulling `.action` out is
// what stops it rendering as "[object Object]".
function caseActions(kase) {
  const out = new Set();
  if (kase.action) out.add(String(kase.action));
  if (Array.isArray(kase.actions)) {
    for (const a of kase.actions) {
      if (!a) continue;
      const name = typeof a === 'object' ? a.action : a;
      if (name) out.add(String(name));
    }
  }
  return out;
}

/**
 * Everything this Roblox identity carries, across every Discord account.
 *
 * @param {object} subject  { robloxId, robloxUsername, discordId } — discordId is
 *                          the account that just appeared, and is what "another
 *                          account" is measured against.
 */
async function gatherRecord(subject) {
  const robloxId = subject.robloxId ? String(subject.robloxId) : null;
  const username = subject.robloxUsername || null;
  const here = subject.discordId ? String(subject.discordId) : null;

  const linked = new Set();           // every Discord id this Roblox user is known on
  if (here) linked.add(here);

  // 1. Dashboard accounts linked to this Roblox id.
  if (robloxId) {
    try {
      const users = await prisma.user.findMany({
        where: { robloxId }, select: { discordId: true, isBlacklisted: true, blacklistReason: true },
      });
      for (const u of users) if (u.discordId) linked.add(String(u.discordId));
      subject._users = users;
    } catch (e) { subject._users = []; }
  }

  // 2. Cases against this identity — by Roblox id, then by username.
  const or = [];
  if (robloxId) or.push({ robloxUserId: robloxId });
  if (username) or.push({ robloxUsername: { equals: username, mode: 'insensitive' } });
  if (here)     or.push({ officerDiscordId: here });
  let cases = [];
  if (or.length) {
    try {
      cases = await prisma.case.findMany({
        where: { OR: or },
        select: {
          caseRef: true, action: true, actions: true, status: true,
          officerDiscordId: true, robloxUserId: true, robloxUsername: true, createdAt: true,
        },
        orderBy: { createdAt: 'desc' }, take: 100,
      });
    } catch (e) { cases = []; }
  }
  for (const c of cases) if (c.officerDiscordId) linked.add(String(c.officerDiscordId));

  // 3. MetPunishments for every account we now know about.
  const ids = [...linked];
  let punishments = [];
  if (ids.length) {
    try {
      punishments = await prisma.metPunishment.findMany({
        where: { discordId: { in: ids }, active: true },
        select: { discordId: true, type: true, reason: true, caseRef: true, issuedAt: true, expiresAt: true },
        orderBy: { issuedAt: 'desc' }, take: 100,
      });
    } catch (e) { punishments = []; }
  }
  const now = Date.now();
  punishments = punishments.filter(p => !p.expiresAt || new Date(p.expiresAt).getTime() > now);

  // Is the identity blacklisted, and where from?
  const blacklistSources = [];
  for (const c of cases) {
    if (c.status !== 'APPROVED') continue;
    if ([...caseActions(c)].some(a => BLACKLIST_ACTIONS.has(a))) {
      blacklistSources.push({ kind: 'case', ref: c.caseRef, on: c.officerDiscordId || null });
    }
  }
  for (const p of punishments) {
    if (BLACKLIST_TYPES.test(String(p.type))) blacklistSources.push({ kind: 'punishment', ref: p.caseRef || null, on: p.discordId });
  }
  for (const u of (subject._users || [])) {
    if (u.isBlacklisted) blacklistSources.push({ kind: 'account', on: u.discordId, reason: u.blacklistReason || null });
  }

  const otherAccounts = ids.filter(id => id !== here);

  return {
    robloxId, username, here,
    linked: ids,
    otherAccounts,
    cases,
    punishments,
    blacklisted: blacklistSources.length > 0,
    blacklistSources,
  };
}

// ── The alert ─────────────────────────────────────────────────────
const COLOR = { blacklist: 0xf04f5e, punishment: 0xe8842a, done: 0x2ed896, quiet: 0x5a6478, info: 0x4a8fff };

function buildAlertEmbed(flag, record, avatar) {
  const bl = flag.kind === 'BLACKLIST_EVASION';

  // A valid Roblox id is all digits — never build a profile link out of a
  // stray "[object Object]" or a name.
  const rbxId = /^\d+$/.test(String(record.robloxId || '')) ? String(record.robloxId) : null;
  const rbxName = record.username && String(record.username) !== '[object Object]' ? String(record.username) : null;
  // The mention resolves in the client, but a fresh alt often will not — so the
  // Discord tag is shown alongside it, and the id after, so there is always a
  // readable name rather than a bare number.
  const tag = flag.discordTag ? ` \`${short(flag.discordTag, 40)}\`` : '';
  // The best name we have for the headline: the Roblox username, else the
  // Discord tag, else nothing dressed up as "unknown".
  const who = rbxName || flag.discordTag || 'unknown account';

  const title = bl
    ? `${e('met_denied')} Blacklist evasion — ${short(who, 40)}`
    : `${e('met_warn')} Punishment evasion — ${short(who, 40)}`;

  const lines = [
    `${e('met_user')} **This account** <@${record.here}>${tag} \`${record.here}\``,
    rbxId
      ? `${e('met_search')} **Roblox** [${short(rbxName || rbxId, 40)}](https://www.roblox.com/users/${rbxId}/profile) \`${rbxId}\``
      : `${e('met_search')} **Roblox** ${rbxName ? short(rbxName, 40) : '*not linked*'}`,
  ];
  if (record.otherAccounts.length) {
    lines.push(`${e('met_bot')} **Also seen as** ` + record.otherAccounts.slice(0, 8).map(id => `<@${id}>`).join(' · ')
      + (record.otherAccounts.length > 8 ? ` *and ${record.otherAccounts.length - 8} more*` : ''));
  }

  const fields = [];
  if (record.blacklistSources.length) {
    fields.push({
      name: `${e('met_stop')} Blacklisted`,
      value: short(record.blacklistSources.map(s => s.kind === 'case'
        ? `Case \`${s.ref}\`${s.on ? ` (on <@${s.on}>)` : ''}`
        : s.kind === 'account'
          ? `Dashboard account <@${s.on}> blacklisted${s.reason ? ` — ${short(s.reason, 80)}` : ''}`
          : `Punishment${s.ref ? ` \`${s.ref}\`` : ''} on <@${s.on}>`).join('\n'), 1000),
      inline: false,
    });
  }
  const active = record.punishments.filter(p => !BLACKLIST_TYPES.test(String(p.type)));
  if (active.length) {
    fields.push({
      name: `${e('met_gavel')} Active punishments · ${active.length}`,
      value: short(active.slice(0, 8).map(p =>
        `**${short(p.type, 30)}**${p.caseRef ? ` \`${p.caseRef}\`` : ''} — on <@${p.discordId}>`
        + (p.expiresAt ? ` · until <t:${Math.floor(new Date(p.expiresAt).getTime() / 1000)}:d>` : '')).join('\n'), 1000),
      inline: false,
    });
  }
  if (record.cases.length) {
    fields.push({
      name: `${e('met_folder')} Cases on record · ${record.cases.length}`,
      value: short(record.cases.slice(0, 6).map(c =>
        `\`${c.caseRef}\` ${short([...caseActions(c)].join(', ') || '—', 40)}`
        + ` · ${c.status === 'APPROVED' ? 'approved' : short(String(c.status || '').toLowerCase(), 12)}`).join('\n'), 1000),
      inline: false,
    });
  }

  const embed = {
    color: bl ? COLOR.blacklist : COLOR.punishment,
    title,
    description: lines.join('\n'),
    fields,
    footer: { text: bl
      ? 'A blacklisted Roblox account is in the server under this Discord account.'
      : 'An active punishment for this Roblox account sits on a different Discord account.' },
    timestamp: new Date().toISOString(),
  };
  if (avatar) embed.thumbnail = { url: avatar };
  return embed;
}

function alertButtons(flagId, resolved) {
  const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
  const { buttonEmoji } = require('./emoji');
  const btn = (id, label, style, emojiName) => {
    const b = new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
    const em = buttonEmoji(emojiName);
    if (em) b.setEmoji(em);   // the MET custom emoji, or its unicode fallback
    return b;
  };
  if (resolved) {
    return [new ActionRowBuilder().addComponents(
      btn(`evade_view_${flagId}`, 'View record', ButtonStyle.Secondary, 'met_search'),
    )];
  }
  return [new ActionRowBuilder().addComponents(
    btn(`evade_bl_${flagId}`,   'Blacklist this account', ButtonStyle.Danger,    'met_denied'),
    btn(`evade_kick_${flagId}`, 'Kick',                   ButtonStyle.Danger,    'met_kick'),
    btn(`evade_view_${flagId}`, 'View record',            ButtonStyle.Secondary, 'met_search'),
    btn(`evade_ok_${flagId}`,   'Not evasion',            ButtonStyle.Secondary, 'met_dot_off'),
  )];
}

// ── Scan on join ──────────────────────────────────────────────────
/**
 * The guildMemberAdd hook. Never throws — a member joining must not be blocked.
 */
async function scanJoin(member) {
  if (!ENABLED() || !member || !member.id) return { skipped: 'off or no member' };
  const guildId = String((member.guild && member.guild.id) || '');
  if (!watchedGuildIds().includes(guildId)) return { skipped: 'guild not watched' };

  const discordId = String(member.id);

  // The identity. RoVer first (a fresh alt has no dashboard account), then our
  // own link as a fallback.
  let robloxId = null, robloxUsername = null;
  try {
    const link = await require('./robloxLink').resolveRoblox(discordId);
    if (link && link.robloxId) { robloxId = String(link.robloxId); robloxUsername = link.username || null; }
  } catch (e) { /* unresolved — still worth checking by discord id below */ }

  const record = await gatherRecord({ robloxId, robloxUsername, discordId });
  // Nothing on record under any identity → an ordinary join.
  if (!record.blacklisted && !record.punishments.length && !record.cases.length) {
    return { clean: true };
  }

  // 1. Re-apply the safe roles this account is missing — the record is theirs.
  const reapplied = await reapplySafeRoles(member, record).catch(() => ({ added: [] }));

  // 2. Decide whether this is worth an alert.
  const activePunish = record.punishments.filter(p => !BLACKLIST_TYPES.test(String(p.type)));
  const punishmentOnOther = activePunish.some(p => String(p.discordId) !== discordId);
  let kind = null;
  if (record.blacklisted) kind = 'BLACKLIST_EVASION';
  else if (punishmentOnOther) kind = 'PUNISHMENT_EVASION';
  if (!kind) return { clean: false, reapplied: reapplied.added };

  await postAlert(member, record, kind, reapplied);
  return { flagged: kind, reapplied: reapplied.added };
}

// Active, non-exile punishment roles the member is not already wearing. Applied
// straight away — a strike or suspension follows the person. A blacklist or
// termination is never auto-applied to a new account: those exile, and a wrong
// RoVer match must not exile the wrong person. They go to the IA button instead.
async function reapplySafeRoles(member, record) {
  const out = { added: [], skipped: 0 };
  const owed = new Map();
  const now = Date.now();

  // From MetPunishments on any linked account.
  for (const p of record.punishments) {
    if (BLACKLIST_TYPES.test(String(p.type))) continue;
    const cfg = ACTION_CONFIG[p.type];
    if (!cfg || cfg.exile || !cfg.roleId) continue;
    owed.set(cfg.roleId, p.type);
  }
  // From approved cases' punishments — read the role off the action config.
  try {
    const ids = record.linked;
    if (ids.length) {
      const rows = await prisma.casePunishment.findMany({
        where: {
          roleRemoved: false, roleId: { not: null },
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          case: { officerDiscordId: { in: ids }, status: 'APPROVED' },
        },
        select: { action: true, roleId: true },
      });
      for (const r of rows) {
        const cfg = ACTION_CONFIG[r.action];
        if (cfg && cfg.exile) continue;                 // never auto-exile
        const roleId = (cfg && cfg.roleId) || r.roleId;
        if (roleId) owed.set(roleId, r.action);
      }
    }
  } catch (e) { /* best-effort */ }

  if (!owed.size) return out;
  const guild = member.guild;
  const me = guild && guild.members ? guild.members.me : null;
  const myTop = me && me.roles && me.roles.highest ? me.roles.highest.position : null;
  const toAdd = [];
  for (const [roleId, action] of owed) {
    if (member.roles && member.roles.cache && member.roles.cache.has(roleId)) { out.skipped++; continue; }
    const role = guild && guild.roles && guild.roles.cache ? guild.roles.cache.get(roleId) : null;
    if (role && myTop != null && role.position >= myTop) continue;   // above the bot
    if (role && role.managed) continue;
    toAdd.push({ roleId, action });
  }
  if (!toAdd.length) return out;
  try {
    await member.roles.add(toAdd.map(x => x.roleId), 'Punishment still active — re-applied by Roblox identity on rejoin');
    out.added = toAdd.map(x => x.action);
  } catch (e) {
    for (const x of toAdd) {
      try { await member.roles.add(x.roleId, 'Punishment still active on rejoin'); out.added.push(x.action); }
      catch (e2) { /* one bad role must not stop the rest */ }
    }
  }
  return out;
}

async function postAlert(member, record, kind, reapplied) {
  const discordId = String(member.id);
  const robloxId = record.robloxId || `unknown:${discordId}`;   // key must be stable

  // Dedupe: one flag per (robloxId, discordId). A re-join re-opens nothing —
  // the row already exists, so the alert is not posted twice.
  let flag;
  try {
    flag = await prisma.evasionFlag.findUnique({
      where: { robloxId_discordId: { robloxId, discordId } },
    });
  } catch (e) { flag = null; }
  if (flag) return { deduped: true, flag };

  const evidence = {
    blacklistSources: record.blacklistSources,
    punishments: record.punishments.map(p => ({ type: p.type, on: p.discordId, ref: p.caseRef || null })),
    caseRefs: record.cases.map(c => c.caseRef),
    reapplied: reapplied ? reapplied.added : [],
  };
  const summary = kind === 'BLACKLIST_EVASION'
    ? `Blacklisted Roblox account ${record.username || record.robloxId} rejoined as ${member.user ? member.user.tag : discordId}`
    : `Active punishment for ${record.username || record.robloxId} on another account; now on ${member.user ? member.user.tag : discordId}`;

  try {
    flag = await prisma.evasionFlag.create({
      data: {
        robloxId, robloxUsername: record.username || null,
        discordId, discordTag: member.user ? member.user.tag : null,
        kind, knownDiscordIds: record.linked, evidence, summary,
      },
    });
  } catch (err) {
    // A racing join created it first — that is exactly what the unique key is for.
    if (err && err.code === 'P2002') return { deduped: true };
    console.warn('[Evasion] could not record the flag:', err.message);
    return { error: err.message };
  }

  let avatar = null;
  try { if (record.robloxId) avatar = await require('./roblox').getRobloxAvatarHeadshot(record.robloxId); } catch (e) {}

  const embed = buildAlertEmbed(flag, record, avatar);
  // Note the auto-reapplied roles so IA know what already happened.
  if (reapplied && reapplied.added && reapplied.added.length) {
    embed.fields.push({ name: `${e('met_tick')} Re-applied automatically`,
      value: short(reapplied.added.join(', '), 400), inline: false });
  }

  const messageId = await require('./bot').postChannelMessage(IA_ALERT_CHANNEL(), {
    content: `${e('met_denied')} <@&${process.env.IA_PING_ROLE_ID || ''}>`.replace(/<@&>/, '').trim() || undefined,
    embeds: [embed],
    components: alertButtons(flag.id, false),
    allowedMentions: { parse: process.env.IA_PING_ROLE_ID ? ['roles'] : [] },
  });

  if (messageId) {
    await prisma.evasionFlag.update({
      where: { id: flag.id }, data: { messageId, channelId: IA_ALERT_CHANNEL() },
    }).catch(() => {});
  }
  return { flag, messageId };
}

// ── The buttons ───────────────────────────────────────────────────
async function handleEvasionButton(interaction) {
  const m = /^evade_(bl|kick|view|ok)_(.+)$/.exec(interaction.customId || '');
  if (!m) return;
  const [, verb, flagId] = m;

  const flag = await prisma.evasionFlag.findUnique({ where: { id: flagId } }).catch(() => null);
  if (!flag) {
    return interaction.reply({ content: `${e('met_warn')} That alert is no longer on file.`, flags: 64 }).catch(() => {});
  }

  // Only Internal Affairs may act. View is read-only, so it is open to anyone
  // who can see the channel.
  if (verb !== 'view') {
    const roleIds = interaction.member && interaction.member.roles && interaction.member.roles.cache
      ? [...interaction.member.roles.cache.keys()].map(String) : [];
    let allowed = false;
    try {
      const v = await require('./disciplineAccess').canDiscipline(String(interaction.user.id), roleIds);
      allowed = !!(v && v.ok);
    } catch (e) { allowed = false; }
    if (!allowed) {
      return interaction.reply({ content: `${e('met_denied')} Internal Affairs only.`, flags: 64 }).catch(() => {});
    }
  }

  if (verb === 'view') return viewRecord(interaction, flag);
  if (verb === 'ok')   return dismiss(interaction, flag);
  if (verb === 'kick') return doKick(interaction, flag);
  if (verb === 'bl')   return doBlacklist(interaction, flag);
}

async function viewRecord(interaction, flag) {
  await interaction.deferReply({ flags: 64 }).catch(() => {});
  const record = await gatherRecord({
    robloxId: /^unknown:/.test(flag.robloxId) ? null : flag.robloxId,
    robloxUsername: flag.robloxUsername, discordId: flag.discordId,
  });
  const embed = buildAlertEmbed(flag, record, null);
  embed.title = `${e('met_search')} Record — ${short(flag.robloxUsername || flag.robloxId, 40)}`;
  embed.color = COLOR.info;
  return interaction.editReply({ embeds: [embed] }).catch(() => {});
}

async function finish(interaction, flag, { status, actionTaken, note }) {
  const name = (interaction.member && interaction.member.displayName)
    || (interaction.user && (interaction.user.globalName || interaction.user.username)) || 'IA';
  await prisma.evasionFlag.update({
    where: { id: flag.id },
    data: { status, actionTaken, actionedById: String(interaction.user.id), actionedByName: name, actionedAt: new Date() },
  }).catch(() => {});

  // Edit the alert so it reads as handled rather than still open.
  try {
    const colour = status === 'DISMISSED' ? COLOR.quiet : COLOR.done;
    const mark = status === 'DISMISSED' ? e('met_dot_off') : e('met_tick');
    const original = interaction.message && interaction.message.embeds && interaction.message.embeds[0];
    const base = original ? (original.data || original) : { title: 'Evasion alert', fields: [] };
    const embed = {
      color: colour,
      title: base.title,
      description: base.description,
      fields: (base.fields || []).slice(0, 10),
      footer: { text: `${status === 'DISMISSED' ? 'Dismissed' : 'Actioned'} by ${name}` },
      timestamp: new Date().toISOString(),
    };
    embed.fields.push({ name: `${mark} ${note}`, value: `by ${name} · <t:${Math.floor(Date.now() / 1000)}:R>`, inline: false });
    await interaction.update({ embeds: [embed], components: alertButtons(flag.id, true) }).catch(async () => {
      await interaction.reply({ content: `${mark} ${note}`, flags: 64 }).catch(() => {});
    });
  } catch (e) { /* the row is updated regardless of the cosmetic edit */ }
}

async function doKick(interaction, flag) {
  const guildId = process.env.MET_GUILD_ID || process.env.DISCORD_GUILD_ID;
  let ok = false, why = '';
  try {
    const bot = require('./bot');
    ok = await bot.kickMember(flag.discordId, {
      guildId,
      reason: `Evasion (${flag.kind === 'BLACKLIST_EVASION' ? 'blacklist' : 'punishment'}) — ${flag.robloxUsername || flag.robloxId}`,
    }) === true;
  } catch (err) { why = err.message; }
  if (!ok) {
    return interaction.reply({ content: `${e('met_cross')} Could not kick them${why ? ` — ${short(why, 120)}` : ''}.`, flags: 64 }).catch(() => {});
  }
  return finish(interaction, flag, { status: 'ACTIONED', actionTaken: 'KICK', note: 'Kicked from the server' });
}

async function doBlacklist(interaction, flag) {
  const guildId = process.env.MET_GUILD_ID || process.env.DISCORD_GUILD_ID;
  const reason = `Ban evasion — same Roblox account (${flag.robloxUsername || flag.robloxId}) as a blacklisted/punished user`;
  const steps = [];

  // 1. The blacklist Discord role, in the MET server.
  const roleId = ACTION_CONFIG['Blacklist'].roleId;
  try {
    const bot = require('./bot');
    const done = roleId ? await bot.assignRole(flag.discordId, roleId, guildId) : false;
    steps.push(`${done ? e('met_tick') : e('met_cross')} Blacklist role`);
  } catch (e) { steps.push(`${e('met_cross')} Blacklist role — ${short(e.message, 60)}`); }

  // 2. Exile the Roblox account from the MET group.
  if (flag.robloxId && !/^unknown:/.test(flag.robloxId)) {
    try {
      const R = require('./roblox');
      const done = await R.exileFromGroup(flag.robloxId, R.mainGroupId(), R.cookieForDivision('MET'));
      steps.push(`${done ? e('met_tick') : e('met_cross')} Exiled from the MET group`);
    } catch (e) { steps.push(`${e('met_cross')} Group exile — ${short(e.message, 60)}`); }
  }

  // 3. A permanent MetPunishment row on THIS account, so the record now names it
  //    too and the role re-applies if they leave and rejoin.
  try {
    await prisma.metPunishment.create({
      data: {
        discordId: flag.discordId, type: 'Blacklist', reason,
        issuedById: String(interaction.user.id),
        issuedBy: (interaction.member && interaction.member.displayName) || interaction.user.username,
      },
    });
    steps.push(`${e('met_tick')} Recorded on their record`);
  } catch (e) { steps.push(`${e('met_cross')} Record — ${short(e.message, 60)}`); }

  // 4. Blacklist any dashboard account on this Discord id.
  try {
    const r = await prisma.user.updateMany({
      where: { discordId: flag.discordId }, data: { isBlacklisted: true, blacklistReason: reason },
    });
    if (r.count) steps.push(`${e('met_tick')} Dashboard account blocked`);
  } catch (e) { /* they may have no dashboard account */ }

  return finish(interaction, flag, {
    status: 'ACTIONED', actionTaken: 'BLACKLIST',
    note: 'Blacklisted\n' + steps.join('\n'),
  });
}

async function dismiss(interaction, flag) {
  return finish(interaction, flag, { status: 'DISMISSED', actionTaken: 'DISMISS', note: 'Marked not evasion' });
}

module.exports = {
  scanJoin, gatherRecord, buildAlertEmbed, handleEvasionButton,
  IA_ALERT_CHANNEL, IA_GUILD_ID, watchedGuildIds, ENABLED,
  // tests
  reapplySafeRoles, caseActions, EXILE_ACTIONS,
};
