// server/routes/devControl.js
// The developer "Server Control" API: full control over every guild the bot is
// in. Mounted at /api/dev/control, behind requireAuth + requireDeveloper at the
// mount AND re-gated here, matching the belt-and-suspenders pattern the other
// dev routers use. Every mutation is written to the audit trail.
//
// The heavy lifting lives in lib/guildControl; this file is only routing,
// validation of the request shape, auditing, and turning a thrown Error (which
// carries a `.status`) into the JSON error the front-end expects.

const express = require('express');
const router = express.Router();

const GC = require('../lib/guildControl');
const audit = require('../lib/audit');

// Suspenders: refuse anyone who is not a developer even if the mount ever
// changes. Mirrors the router-level gate in routes/dev.js.
router.use((req, res, next) => {
  if (!req.user || req.user.role !== 'DEVELOPER') return res.status(403).json({ error: 'Developers only.' });
  next();
});

// Wrap an async handler so a thrown Error with `.status` becomes the right JSON
// response, and anything unexpected is a 500 rather than a hung request.
function h(fn) {
  return (req, res) => Promise.resolve(fn(req, res)).catch(err => {
    const status = err && err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) console.error('[DevControl]', req.method, req.originalUrl, '-', err && err.message);
    res.status(status).json({ error: (err && err.message) || 'Something went wrong.' });
  });
}

// Audit helper: one line per mutation, category DEV, with the guild as target.
function note(req, action, gid, summary, metadata) {
  audit.log(req.user, { category: 'DEV', action: `GUILD_${action}`, target: { type: 'guild', id: gid }, summary, metadata });
}

// ── Guilds ────────────────────────────────────────────────────────
router.get('/guilds', h(async (req, res) => {
  res.json({ guilds: GC.listGuilds() });
}));

router.get('/guilds/:gid/overview', h(async (req, res) => {
  res.json(await GC.guildOverview(req.params.gid));
}));

router.get('/permissions', h(async (req, res) => {
  res.json({ permissions: GC.permissionCatalogue() });
}));

// ── Channels ──────────────────────────────────────────────────────
router.get('/guilds/:gid/channels', h(async (req, res) => {
  res.json({ channels: await GC.listChannels(req.params.gid) });
}));

router.post('/guilds/:gid/channels', h(async (req, res) => {
  const out = await GC.createChannel(req.params.gid, req.body || {});
  note(req, 'CHANNEL_CREATE', req.params.gid, `Created #${out.name} (${out.type})`, { channelId: out.id });
  res.json({ ok: true, channel: out });
}));

router.patch('/guilds/:gid/channels/:cid', h(async (req, res) => {
  const out = await GC.editChannel(req.params.gid, req.params.cid, req.body || {});
  note(req, 'CHANNEL_EDIT', req.params.gid, `Edited #${out.name}`, { channelId: out.id });
  res.json({ ok: true, channel: out });
}));

router.delete('/guilds/:gid/channels/:cid', h(async (req, res) => {
  const out = await GC.deleteChannel(req.params.gid, req.params.cid);
  note(req, 'CHANNEL_DELETE', req.params.gid, `Deleted #${out.name}`, { channelId: out.id });
  res.json({ ok: true });
}));

router.get('/guilds/:gid/channels/:cid/messages', h(async (req, res) => {
  res.json(await GC.listMessages(req.params.gid, req.params.cid, req.query.limit));
}));

router.delete('/guilds/:gid/channels/:cid/messages/:mid', h(async (req, res) => {
  await GC.deleteMessage(req.params.gid, req.params.cid, req.params.mid);
  note(req, 'MESSAGE_DELETE', req.params.gid, 'Deleted a message', { channelId: req.params.cid, messageId: req.params.mid });
  res.json({ ok: true });
}));

router.post('/guilds/:gid/channels/:cid/purge', h(async (req, res) => {
  const out = await GC.purgeMessages(req.params.gid, req.params.cid, (req.body || {}).count);
  note(req, 'MESSAGE_PURGE', req.params.gid, `Purged ${out.deleted} messages`, { channelId: req.params.cid });
  res.json({ ok: true, ...out });
}));

// ── Roles ─────────────────────────────────────────────────────────
router.get('/guilds/:gid/roles', h(async (req, res) => {
  res.json({ roles: await GC.listRoles(req.params.gid) });
}));

router.post('/guilds/:gid/roles', h(async (req, res) => {
  const out = await GC.createRole(req.params.gid, req.body || {});
  note(req, 'ROLE_CREATE', req.params.gid, `Created role ${out.name}`, { roleId: out.id });
  res.json({ ok: true, role: out });
}));

router.patch('/guilds/:gid/roles/:rid', h(async (req, res) => {
  const out = await GC.editRole(req.params.gid, req.params.rid, req.body || {});
  note(req, 'ROLE_EDIT', req.params.gid, `Edited role ${out.name}`, { roleId: out.id });
  res.json({ ok: true, role: out });
}));

router.delete('/guilds/:gid/roles/:rid', h(async (req, res) => {
  const out = await GC.deleteRole(req.params.gid, req.params.rid);
  note(req, 'ROLE_DELETE', req.params.gid, `Deleted role ${out.name}`, { roleId: out.id });
  res.json({ ok: true });
}));

// ── Members ───────────────────────────────────────────────────────
// Reads and search reuse the bot's existing, already-tested helpers.
router.get('/guilds/:gid/members', h(async (req, res) => {
  const members = await require('../lib/bot').searchGuildMembers(String(req.query.search || ''), 25, req.params.gid);
  res.json({ members });
}));

router.get('/guilds/:gid/members/:uid', h(async (req, res) => {
  res.json(await GC.memberDetail(req.params.gid, req.params.uid));
}));

router.patch('/guilds/:gid/members/:uid', h(async (req, res) => {
  await GC.setNickname(req.params.gid, req.params.uid, (req.body || {}).nickname);
  note(req, 'MEMBER_NICK', req.params.gid, `Set nickname for ${req.params.uid}`, { userId: req.params.uid });
  res.json({ ok: true });
}));

router.put('/guilds/:gid/members/:uid/roles/:rid', h(async (req, res) => {
  await GC.addRole(req.params.gid, req.params.uid, req.params.rid);
  note(req, 'MEMBER_ROLE_ADD', req.params.gid, `Added role ${req.params.rid} to ${req.params.uid}`, { userId: req.params.uid, roleId: req.params.rid });
  res.json({ ok: true });
}));

router.delete('/guilds/:gid/members/:uid/roles/:rid', h(async (req, res) => {
  await GC.removeRole(req.params.gid, req.params.uid, req.params.rid);
  note(req, 'MEMBER_ROLE_REMOVE', req.params.gid, `Removed role ${req.params.rid} from ${req.params.uid}`, { userId: req.params.uid, roleId: req.params.rid });
  res.json({ ok: true });
}));

router.post('/guilds/:gid/members/:uid/kick', h(async (req, res) => {
  const reason = ((req.body || {}).reason || '').toString().slice(0, 400) || 'Server Control panel';
  await require('../lib/bot').kickMember(req.params.uid, { reason, guildId: req.params.gid });
  note(req, 'MEMBER_KICK', req.params.gid, `Kicked ${req.params.uid}: ${reason}`, { userId: req.params.uid });
  res.json({ ok: true });
}));

router.post('/guilds/:gid/members/:uid/ban', h(async (req, res) => {
  const b = req.body || {};
  const reason = (b.reason || '').toString().slice(0, 400) || 'Server Control panel';
  const deleteMessageSeconds = Math.max(0, Math.min(604800, parseInt(b.deleteMessageSeconds, 10) || 0));
  await require('../lib/bot').banMember(req.params.uid, { reason, deleteMessageSeconds, guildId: req.params.gid });
  note(req, 'MEMBER_BAN', req.params.gid, `Banned ${req.params.uid}: ${reason}`, { userId: req.params.uid });
  res.json({ ok: true });
}));

router.delete('/guilds/:gid/members/:uid/ban', h(async (req, res) => {
  await require('../lib/bot').unbanMember(req.params.uid, { reason: 'Server Control panel', guildId: req.params.gid });
  note(req, 'MEMBER_UNBAN', req.params.gid, `Unbanned ${req.params.uid}`, { userId: req.params.uid });
  res.json({ ok: true });
}));

router.post('/guilds/:gid/members/:uid/timeout', h(async (req, res) => {
  const b = req.body || {};
  const durationMinutes = parseInt(b.minutes, 10) || 0;
  const reason = (b.reason || '').toString().slice(0, 400) || 'Server Control panel';
  await require('../lib/bot').timeoutMember(req.params.uid, { durationMinutes, reason, guildId: req.params.gid });
  note(req, durationMinutes > 0 ? 'MEMBER_TIMEOUT' : 'MEMBER_UNTIMEOUT', req.params.gid,
    durationMinutes > 0 ? `Timed out ${req.params.uid} for ${durationMinutes}m` : `Cleared timeout on ${req.params.uid}`, { userId: req.params.uid });
  res.json({ ok: true });
}));

router.get('/guilds/:gid/bans', h(async (req, res) => {
  const bans = await require('../lib/bot').listGuildBans(String(req.query.search || ''), req.params.gid);
  res.json({ bans });
}));

// ── Emojis ────────────────────────────────────────────────────────
router.get('/guilds/:gid/emojis', h(async (req, res) => {
  res.json({ emojis: await GC.listEmojis(req.params.gid) });
}));

router.post('/guilds/:gid/emojis', h(async (req, res) => {
  const out = await GC.createEmoji(req.params.gid, req.body || {});
  note(req, 'EMOJI_CREATE', req.params.gid, `Added emoji :${out.name}:`, { emojiId: out.id });
  res.json({ ok: true, emoji: out });
}));

router.delete('/guilds/:gid/emojis/:eid', h(async (req, res) => {
  await GC.deleteEmoji(req.params.gid, req.params.eid);
  note(req, 'EMOJI_DELETE', req.params.gid, `Deleted emoji ${req.params.eid}`, { emojiId: req.params.eid });
  res.json({ ok: true });
}));

// ── Sending ───────────────────────────────────────────────────────
router.post('/guilds/:gid/send', h(async (req, res) => {
  const out = await GC.sendMessage(req.params.gid, req.body || {});
  note(req, 'MESSAGE_SEND', req.params.gid, 'Sent a message', { channelId: out.channelId, messageId: out.id });
  res.json({ ok: true, ...out });
}));

router.post('/dm', h(async (req, res) => {
  const out = await GC.dmUser(req.body || {});
  audit.log(req.user, { category: 'DEV', action: 'GUILD_DM', target: { type: 'user', id: out.userId }, summary: 'Sent a DM' });
  res.json({ ok: true, ...out });
}));

module.exports = router;
