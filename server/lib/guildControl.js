// server/lib/guildControl.js
// Full Discord control surface for the developer Server Control panel.
//
// Everything here operates on ANY guild the bot is in, named by id, rather than
// the one MET guild the rest of the app is wired to. It is the layer the
// /api/dev/control routes call, kept apart from bot.js so the panel's reach is
// in one auditable place and none of it is reachable without the DEVELOPER gate
// on the route in front of it.
//
// It never throws a bare Discord error at the caller: every failure is turned
// into an Error with a `.status` and a sentence a human can act on, because
// "DiscordAPIError[50013]" tells the person clicking the button nothing, and the
// real cause is almost always the bot's role sitting too low in that server.

const {
  ChannelType, PermissionsBitField, PermissionFlagsBits,
} = require('discord.js');

// ── Access to the live client ─────────────────────────────────────
function client() {
  const c = require('./bot').getClient();
  if (!c) { const e = new Error('The bot is not connected to Discord yet. Try again in a moment.'); e.status = 503; throw e; }
  return c;
}

function isSnowflake(s) { return /^\d{15,25}$/.test(String(s == null ? '' : s).trim()); }

function bad(msg) { const e = new Error(msg); e.status = 400; return e; }

// Turn a raw Discord error into something with a status and a readable message.
function wrap(err, fallback) {
  const code = err && err.code;
  const map = {
    50013: [403, 'The bot does not have permission to do that in this server. Move its role higher, or grant it the permission it needs.'],
    50001: [403, 'The bot cannot access that (missing access).'],
    50035: [400, `Discord rejected that: ${err && err.message ? err.message : 'invalid form body'}.`],
    10003: [404, 'That channel no longer exists.'],
    10004: [404, 'That server could not be found.'],
    10008: [404, 'That message no longer exists.'],
    10011: [404, 'That role no longer exists.'],
    10013: [404, 'That user could not be found.'],
    10026: [404, 'That user is not banned.'],
    30005: [409, 'That server has hit Discord’s limit for that.'],
    30008: [409, 'That server has reached its emoji limit.'],
    50007: [403, 'That user has DMs closed, or does not share a server with the bot.'],
    50028: [400, 'That role cannot be edited this way.'],
  };
  const hit = code && map[code];
  const e = new Error(hit ? hit[1] : (fallback || (err && err.message) || 'Discord could not complete that.'));
  e.status = hit ? hit[0] : (err && err.status) || 502;
  return e;
}

async function getGuild(gid) {
  if (!isSnowflake(gid)) throw bad('That is not a valid server id.');
  const c = client();
  try { return await c.guilds.fetch(String(gid)); }
  catch (err) { const e = new Error('The bot is not in that server, or it could not be reached.'); e.status = 404; throw e; }
}

// ── Channel types ─────────────────────────────────────────────────
const TYPE_NAME = {
  [ChannelType.GuildText]: 'text',
  [ChannelType.GuildVoice]: 'voice',
  [ChannelType.GuildCategory]: 'category',
  [ChannelType.GuildAnnouncement]: 'announcement',
  [ChannelType.GuildStageVoice]: 'stage',
  [ChannelType.GuildForum]: 'forum',
  [ChannelType.GuildMedia]: 'media',
  [ChannelType.PublicThread]: 'thread',
  [ChannelType.PrivateThread]: 'thread',
  [ChannelType.AnnouncementThread]: 'thread',
};
const CREATE_TYPE = {
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  category: ChannelType.GuildCategory,
  announcement: ChannelType.GuildAnnouncement,
  stage: ChannelType.GuildStageVoice,
  forum: ChannelType.GuildForum,
};

// ── Colours and permissions ───────────────────────────────────────
function parseColor(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v & 0xffffff;
  let s = String(v).trim().replace(/^#/, '');
  if (/^[0-9a-f]{6}$/i.test(s)) return parseInt(s, 16);
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? (n & 0xffffff) : 0;
}
function hexColor(int) { return '#' + Number(int || 0).toString(16).padStart(6, '0'); }

// The full set of role permissions Discord knows about, for the role editor.
function permissionCatalogue() { return Object.keys(PermissionFlagsBits); }

function toPermissionBits(names) {
  const known = new Set(Object.keys(PermissionFlagsBits));
  const valid = (Array.isArray(names) ? names : []).filter(n => known.has(n));
  try { return new PermissionsBitField(valid).bitfield; } catch (e) { return 0n; }
}

// ── Guilds ────────────────────────────────────────────────────────
function primaryGuildId() { return process.env.MET_GUILD_ID || process.env.DISCORD_GUILD_ID || null; }

function listGuilds() {
  const c = client();
  const primary = primaryGuildId();
  const out = [];
  for (const g of c.guilds.cache.values()) {
    out.push({
      id: g.id,
      name: g.name,
      icon: g.iconURL ? g.iconURL({ size: 128, extension: 'png' }) : null,
      memberCount: g.memberCount != null ? g.memberCount : null,
      primary: String(g.id) === String(primary),
    });
  }
  out.sort((a, b) => (b.primary - a.primary) || a.name.localeCompare(b.name));
  return out;
}

async function guildOverview(gid) {
  const g = await getGuild(gid);
  let owner = null;
  try { const o = await g.fetchOwner(); owner = o ? { id: o.id, tag: o.user.tag, displayName: o.displayName } : null; } catch (e) { /* not critical */ }
  let emojiCount = g.emojis.cache.size;
  try { emojiCount = (await g.emojis.fetch()).size; } catch (e) { /* keep the cached count */ }

  // What the bot itself can do here decides which buttons will actually work,
  // so it is surfaced rather than left for the user to discover by failure.
  let me = g.members.me;
  try { if (!me) me = await g.members.fetchMe(); } catch (e) { /* may be unavailable */ }
  const perm = (flag) => !!(me && me.permissions && me.permissions.has(flag));

  return {
    id: g.id,
    name: g.name,
    icon: g.iconURL ? g.iconURL({ size: 256, extension: 'png' }) : null,
    description: g.description || null,
    owner,
    memberCount: g.memberCount,
    channelCount: g.channels.cache.size,
    roleCount: g.roles.cache.size,
    emojiCount,
    boostTier: g.premiumTier,
    boostCount: g.premiumSubscriptionCount || 0,
    createdTimestamp: g.createdTimestamp,
    vanity: g.vanityURLCode || null,
    bot: {
      isAdmin: perm(PermissionFlagsBits.Administrator),
      manageChannels: perm(PermissionFlagsBits.ManageChannels),
      manageRoles: perm(PermissionFlagsBits.ManageRoles),
      manageGuild: perm(PermissionFlagsBits.ManageGuild),
      kick: perm(PermissionFlagsBits.KickMembers),
      ban: perm(PermissionFlagsBits.BanMembers),
      timeout: perm(PermissionFlagsBits.ModerateMembers),
      manageMessages: perm(PermissionFlagsBits.ManageMessages),
      manageEmojis: perm(PermissionFlagsBits.ManageGuildExpressions) || perm(PermissionFlagsBits.ManageEmojisAndStickers),
      manageNicknames: perm(PermissionFlagsBits.ManageNicknames),
      rolePosition: me && me.roles && me.roles.highest ? me.roles.highest.position : null,
    },
  };
}

// ── Channels ──────────────────────────────────────────────────────
function channelSummary(c) {
  return {
    id: c.id,
    name: c.name,
    type: TYPE_NAME[c.type] || String(c.type),
    parentId: c.parentId || null,
    position: c.rawPosition != null ? c.rawPosition : (c.position != null ? c.position : 0),
    nsfw: !!c.nsfw,
    topic: c.topic || null,
    slowmode: c.rateLimitPerUser || 0,
    textLike: typeof c.isTextBased === 'function' ? c.isTextBased() : false,
  };
}

async function listChannels(gid) {
  const g = await getGuild(gid);
  const all = await g.channels.fetch();
  const chans = [...all.values()].filter(Boolean).map(channelSummary);
  // Categories first, then their children by position; loose channels after.
  const catPos = {};
  for (const c of chans) if (c.type === 'category') catPos[c.id] = c.position;
  chans.sort((a, b) => {
    const ca = a.type === 'category' ? a.position : (catPos[a.parentId] != null ? catPos[a.parentId] : -1);
    const cb = b.type === 'category' ? b.position : (catPos[b.parentId] != null ? catPos[b.parentId] : -1);
    if (ca !== cb) return ca - cb;
    if (a.type === 'category') return -1;
    if (b.type === 'category') return 1;
    return a.position - b.position;
  });
  return chans;
}

async function createChannel(gid, { name, type, parentId, topic } = {}) {
  const g = await getGuild(gid);
  if (!name || !String(name).trim()) throw bad('A channel name is required.');
  const t = CREATE_TYPE[String(type || 'text').toLowerCase()];
  if (t == null) throw bad('That is not a channel type I can create.');
  try {
    const opts = { name: String(name).trim(), type: t };
    if (parentId && isSnowflake(parentId)) opts.parent = String(parentId);
    if (topic && (t === ChannelType.GuildText || t === ChannelType.GuildAnnouncement || t === ChannelType.GuildForum)) opts.topic = String(topic).slice(0, 1024);
    const c = await g.channels.create(opts);
    return channelSummary(c);
  } catch (err) { throw wrap(err, 'The channel could not be created.'); }
}

async function editChannel(gid, cid, patch = {}) {
  const g = await getGuild(gid);
  if (!isSnowflake(cid)) throw bad('That is not a valid channel id.');
  const c = await g.channels.fetch(String(cid)).catch(() => null);
  if (!c) throw wrap({ code: 10003 });
  const opts = {};
  if (patch.name != null) opts.name = String(patch.name).trim();
  if (patch.topic != null) opts.topic = String(patch.topic).slice(0, 1024);
  if (patch.nsfw != null) opts.nsfw = !!patch.nsfw;
  if (patch.slowmode != null) opts.rateLimitPerUser = Math.max(0, Math.min(21600, parseInt(patch.slowmode, 10) || 0));
  if (patch.parentId !== undefined) opts.parent = patch.parentId && isSnowflake(patch.parentId) ? String(patch.parentId) : null;
  try { const updated = await c.edit(opts); return channelSummary(updated); }
  catch (err) { throw wrap(err, 'The channel could not be edited.'); }
}

async function deleteChannel(gid, cid) {
  const g = await getGuild(gid);
  if (!isSnowflake(cid)) throw bad('That is not a valid channel id.');
  const c = await g.channels.fetch(String(cid)).catch(() => null);
  if (!c) throw wrap({ code: 10003 });
  const name = c.name;
  try { await c.delete('Deleted from the developer Server Control panel'); return { id: String(cid), name }; }
  catch (err) { throw wrap(err, 'The channel could not be deleted.'); }
}

// ── Messages ──────────────────────────────────────────────────────
// Reading arbitrary message TEXT needs the MessageContent privileged intent.
// Without it, Discord returns the messages but with empty `content`, so the
// panel reports whether content is readable rather than silently showing blanks.
function messageContentReadable() {
  try {
    const c = client();
    const bits = c.options && c.options.intents;
    if (bits == null) return false;
    return new (require('discord.js').IntentsBitField)(bits).has(require('discord.js').GatewayIntentBits.MessageContent);
  } catch (e) { return false; }
}

async function listMessages(gid, cid, limit) {
  const g = await getGuild(gid);
  if (!isSnowflake(cid)) throw bad('That is not a valid channel id.');
  const c = await g.channels.fetch(String(cid)).catch(() => null);
  if (!c) throw wrap({ code: 10003 });
  if (typeof c.isTextBased !== 'function' || !c.isTextBased()) throw bad('That channel has no messages to read.');
  const n = Math.max(1, Math.min(50, parseInt(limit, 10) || 25));
  let msgs;
  try { msgs = await c.messages.fetch({ limit: n }); }
  catch (err) { throw wrap(err, 'The messages could not be read.'); }
  const rows = [...msgs.values()].map(m => ({
    id: m.id,
    authorId: m.author ? m.author.id : null,
    authorTag: m.author ? (m.author.tag || m.author.username) : 'unknown',
    authorBot: !!(m.author && m.author.bot),
    content: m.content || '',
    createdTimestamp: m.createdTimestamp,
    editedTimestamp: m.editedTimestamp || null,
    pinned: !!m.pinned,
    attachments: [...(m.attachments ? m.attachments.values() : [])].map(a => ({ name: a.name, url: a.url })),
    embeds: m.embeds ? m.embeds.length : 0,
  }));
  return { contentReadable: messageContentReadable(), messages: rows };
}

async function deleteMessage(gid, cid, mid) {
  const g = await getGuild(gid);
  if (!isSnowflake(cid) || !isSnowflake(mid)) throw bad('A valid channel and message id are required.');
  const c = await g.channels.fetch(String(cid)).catch(() => null);
  if (!c || typeof c.messages?.delete !== 'function') throw wrap({ code: 10003 });
  try { await c.messages.delete(String(mid)); return { id: String(mid) }; }
  catch (err) { throw wrap(err, 'The message could not be deleted.'); }
}

async function purgeMessages(gid, cid, count) {
  const g = await getGuild(gid);
  if (!isSnowflake(cid)) throw bad('That is not a valid channel id.');
  const c = await g.channels.fetch(String(cid)).catch(() => null);
  if (!c || typeof c.bulkDelete !== 'function') throw bad('That channel cannot be bulk-purged.');
  const n = Math.max(1, Math.min(100, parseInt(count, 10) || 0));
  if (!n) throw bad('Say how many messages to remove (1 to 100).');
  try { const deleted = await c.bulkDelete(n, true); return { requested: n, deleted: deleted.size != null ? deleted.size : n }; }
  catch (err) { throw wrap(err, 'The messages could not be purged (Discord will not bulk-delete anything older than 14 days).'); }
}

// ── Roles ─────────────────────────────────────────────────────────
function roleSummary(r, guildId) {
  return {
    id: r.id,
    name: r.name,
    color: hexColor(r.color),
    colorInt: r.color,
    position: r.position,
    hoist: !!r.hoist,
    mentionable: !!r.mentionable,
    managed: !!r.managed,
    isEveryone: String(r.id) === String(guildId),
    memberCount: r.members ? r.members.size : 0,
    permissions: r.permissions ? r.permissions.toArray() : [],
  };
}

async function listRoles(gid) {
  const g = await getGuild(gid);
  const all = await g.roles.fetch();
  const rows = [...all.values()].map(r => roleSummary(r, g.id));
  rows.sort((a, b) => b.position - a.position);
  return rows;
}

async function createRole(gid, { name, color, hoist, mentionable, permissions } = {}) {
  const g = await getGuild(gid);
  try {
    const r = await g.roles.create({
      name: (name && String(name).trim()) || 'new role',
      color: parseColor(color),
      hoist: !!hoist,
      mentionable: !!mentionable,
      permissions: toPermissionBits(permissions),
      reason: 'Created from the developer Server Control panel',
    });
    return roleSummary(r, g.id);
  } catch (err) { throw wrap(err, 'The role could not be created.'); }
}

async function editRole(gid, rid, patch = {}) {
  const g = await getGuild(gid);
  if (!isSnowflake(rid)) throw bad('That is not a valid role id.');
  const r = await g.roles.fetch(String(rid)).catch(() => null);
  if (!r) throw wrap({ code: 10011 });
  if (String(r.id) === String(g.id)) throw bad('The @everyone role cannot be edited here.');
  const opts = {};
  if (patch.name != null) opts.name = String(patch.name).trim();
  if (patch.color != null) opts.color = parseColor(patch.color);
  if (patch.hoist != null) opts.hoist = !!patch.hoist;
  if (patch.mentionable != null) opts.mentionable = !!patch.mentionable;
  if (Array.isArray(patch.permissions)) opts.permissions = toPermissionBits(patch.permissions);
  try { const updated = await r.edit(opts); return roleSummary(updated, g.id); }
  catch (err) { throw wrap(err, 'The role could not be edited.'); }
}

async function deleteRole(gid, rid) {
  const g = await getGuild(gid);
  if (!isSnowflake(rid)) throw bad('That is not a valid role id.');
  const r = await g.roles.fetch(String(rid)).catch(() => null);
  if (!r) throw wrap({ code: 10011 });
  if (String(r.id) === String(g.id)) throw bad('The @everyone role cannot be deleted.');
  if (r.managed) throw bad('That role is managed by an integration and cannot be deleted here.');
  const name = r.name;
  try { await r.delete('Deleted from the developer Server Control panel'); return { id: String(rid), name }; }
  catch (err) { throw wrap(err, 'The role could not be deleted.'); }
}

// ── Members ───────────────────────────────────────────────────────
async function memberDetail(gid, uid) {
  const g = await getGuild(gid);
  if (!isSnowflake(uid)) throw bad('That is not a valid user id.');
  const m = await g.members.fetch(String(uid)).catch(() => null);
  if (!m) throw wrap({ code: 10013 });
  const roles = [...m.roles.cache.values()]
    .filter(r => r.id !== g.id)
    .sort((a, b) => b.position - a.position)
    .map(r => ({ id: r.id, name: r.name, color: hexColor(r.color) }));
  return {
    id: m.id,
    username: m.user ? m.user.tag || m.user.username : m.id,
    displayName: m.displayName,
    avatar: m.displayAvatarURL ? m.displayAvatarURL({ size: 128 }) : null,
    isBot: !!(m.user && m.user.bot),
    nickname: m.nickname || null,
    joinedTimestamp: m.joinedTimestamp || null,
    timedOutUntil: m.communicationDisabledUntilTimestamp || null,
    bannable: !!m.bannable,
    kickable: !!m.kickable,
    manageable: !!m.manageable,
    roles,
  };
}

async function addRole(gid, uid, rid) {
  const g = await getGuild(gid);
  if (!isSnowflake(uid) || !isSnowflake(rid)) throw bad('A valid user and role id are required.');
  const m = await g.members.fetch(String(uid)).catch(() => null);
  if (!m) throw wrap({ code: 10013 });
  try { await m.roles.add(String(rid), 'Server Control panel'); return { ok: true }; }
  catch (err) { throw wrap(err, 'The role could not be added.'); }
}

async function removeRole(gid, uid, rid) {
  const g = await getGuild(gid);
  if (!isSnowflake(uid) || !isSnowflake(rid)) throw bad('A valid user and role id are required.');
  const m = await g.members.fetch(String(uid)).catch(() => null);
  if (!m) throw wrap({ code: 10013 });
  try { await m.roles.remove(String(rid), 'Server Control panel'); return { ok: true }; }
  catch (err) { throw wrap(err, 'The role could not be removed.'); }
}

async function setNickname(gid, uid, nick) {
  const g = await getGuild(gid);
  if (!isSnowflake(uid)) throw bad('That is not a valid user id.');
  const m = await g.members.fetch(String(uid)).catch(() => null);
  if (!m) throw wrap({ code: 10013 });
  try { await m.setNickname(nick ? String(nick).slice(0, 32) : null, 'Server Control panel'); return { ok: true }; }
  catch (err) { throw wrap(err, 'The nickname could not be changed.'); }
}

// ── Emojis ────────────────────────────────────────────────────────
async function listEmojis(gid) {
  const g = await getGuild(gid);
  const all = await g.emojis.fetch();
  return [...all.values()].map(em => ({
    id: em.id,
    name: em.name,
    url: em.imageURL ? em.imageURL({ size: 64 }) : (em.url || null),
    animated: !!em.animated,
    managed: !!em.managed,
  }));
}

async function createEmoji(gid, { name, imageUrl } = {}) {
  const g = await getGuild(gid);
  if (!name || !/^[\w]{2,32}$/.test(String(name))) throw bad('An emoji name of 2 to 32 letters, numbers or underscores is required.');
  if (!imageUrl || !/^(https?:\/\/|data:image\/)/i.test(String(imageUrl))) throw bad('A PNG, JPG or GIF image URL (or data URI) is required.');
  try { const em = await g.emojis.create({ attachment: String(imageUrl), name: String(name) }); return { id: em.id, name: em.name, url: em.imageURL ? em.imageURL({ size: 64 }) : null, animated: !!em.animated }; }
  catch (err) { throw wrap(err, 'The emoji could not be added (it may be too large; Discord’s limit is 256KB).'); }
}

async function deleteEmoji(gid, eid) {
  const g = await getGuild(gid);
  if (!isSnowflake(eid)) throw bad('That is not a valid emoji id.');
  try { await g.emojis.delete(String(eid), 'Server Control panel'); return { id: String(eid) }; }
  catch (err) { throw wrap(err, 'The emoji could not be deleted.'); }
}

// ── Sending ───────────────────────────────────────────────────────
function buildEmbed(embed) {
  if (!embed || typeof embed !== 'object') return null;
  const out = {};
  if (embed.title) out.title = String(embed.title).slice(0, 256);
  if (embed.description) out.description = String(embed.description).slice(0, 4096);
  if (embed.url && /^https?:\/\//i.test(embed.url)) out.url = embed.url;
  if (embed.color != null && embed.color !== '') out.color = parseColor(embed.color);
  if (embed.footer) out.footer = { text: String(embed.footer).slice(0, 2048) };
  if (embed.image && /^https?:\/\//i.test(embed.image)) out.image = { url: embed.image };
  if (embed.thumbnail && /^https?:\/\//i.test(embed.thumbnail)) out.thumbnail = { url: embed.thumbnail };
  if (embed.author) out.author = { name: String(embed.author).slice(0, 256) };
  return Object.keys(out).length ? out : null;
}

async function sendMessage(gid, { channelId, content, embed } = {}) {
  const g = await getGuild(gid);
  if (!isSnowflake(channelId)) throw bad('Pick a channel to send to.');
  const c = await g.channels.fetch(String(channelId)).catch(() => null);
  if (!c) throw wrap({ code: 10003 });
  if (typeof c.send !== 'function') throw bad('That channel cannot be posted to.');
  const built = buildEmbed(embed);
  const text = content != null ? String(content).slice(0, 2000) : '';
  if (!text && !built) throw bad('Give the message some text, an embed, or both.');
  const payload = { allowedMentions: { parse: ['users', 'roles', 'everyone'] } };
  if (text) payload.content = text;
  if (built) payload.embeds = [built];
  try { const msg = await c.send(payload); return { id: msg.id, channelId: String(channelId) }; }
  catch (err) { throw wrap(err, 'The message could not be sent.'); }
}

async function dmUser({ userId, content, embed } = {}) {
  const c = client();
  if (!isSnowflake(userId)) throw bad('A valid user id is required.');
  let user;
  try { user = await c.users.fetch(String(userId)); }
  catch (err) { throw wrap(err, 'That user could not be found.'); }
  const built = buildEmbed(embed);
  const text = content != null ? String(content).slice(0, 2000) : '';
  if (!text && !built) throw bad('Give the DM some text, an embed, or both.');
  const payload = {};
  if (text) payload.content = text;
  if (built) payload.embeds = [built];
  try { const msg = await user.send(payload); return { id: msg.id, userId: String(userId) }; }
  catch (err) { throw wrap(err, 'The DM could not be delivered (their DMs may be closed).'); }
}

module.exports = {
  isSnowflake, permissionCatalogue,
  listGuilds, guildOverview,
  listChannels, createChannel, editChannel, deleteChannel,
  listMessages, deleteMessage, purgeMessages, messageContentReadable,
  listRoles, createRole, editRole, deleteRole,
  memberDetail, addRole, removeRole, setNickname,
  listEmojis, createEmoji, deleteEmoji,
  sendMessage, dmUser,
  // exposed for tests
  parseColor, hexColor, buildEmbed, toPermissionBits,
};
