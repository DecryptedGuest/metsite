// server/routes/adonis.js
// The Adonis command bridge API.
//
// Two audiences, two authentications, and they must not be confused:
//
//   the GAME   heartbeats, collects commands, acks them. Authenticated with the
//              shared game secret, exactly as /api/game already is. Mounted
//              WITHOUT requireAuth, because a Roblox server is not a logged-in
//              user.
//   the SITE   lists servers and players, and queues commands. Behind the
//              normal session auth, and queuing is gated to High Command,
//              because a command here runs on a live server.
//
// The original bridge had one bearer token for everything and no rank check at
// all, so anyone who could reach the Discord command could run any Adonis
// command on any server. That is the main thing fixed here.
'use strict';

const express = require('express');
const adonis  = require('../lib/adonis');

const router = express.Router();          // game-facing, secret-authenticated
const site   = express.Router();          // site-facing, session-authenticated

// ── Game authentication ──────────────────────────────────────────────────
// The same secret /api/game uses, under either of its names, so there is one
// value to set rather than a second AUTH_TOKEN that means the same thing.
// The Authorization: Bearer form is accepted too, so the Lua that was written
// against the original bridge keeps working unchanged.
function gameSecret() {
  return process.env.TRYOUT_GAME_SECRET || process.env.GAME_SECRET || null;
}
function requireGameSecret(req, res, next) {
  const want = gameSecret();
  if (!want) {
    return res.status(503).json({ error: 'The game secret is not configured on the server.' });
  }
  const auth = String(req.headers.authorization || '');
  const got = req.headers['x-game-secret']
    || (auth.startsWith('Bearer ') ? auth.slice(7) : null)
    || (req.body && req.body.secret)
    || null;
  if (!got || String(got) !== String(want)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Game-facing ──────────────────────────────────────────────────────────

// The game says it is alive and who is in it.
router.post('/heartbeat', requireGameSecret, (req, res) => {
  const row = adonis.heartbeat(req.body || {});
  if (!row) return res.status(400).json({ error: 'serverId is required.' });
  // Answered with the commands waiting for it, so a heartbeat and a poll can be
  // one request instead of two. The Lua may ignore this and keep polling.
  res.json({ ok: true, commands: adonis.collect(row.serverId) });
});

router.post('/shutdown', requireGameSecret, (req, res) => {
  const id = String((req.body && req.body.serverId) || '');
  if (!id) return res.status(400).json({ error: 'serverId is required.' });
  adonis.forget(id);
  res.json({ ok: true });
});

router.get('/commands/pending', requireGameSecret, (req, res) => {
  res.json({ commands: adonis.collect(req.query.serverId || '') });
});

router.post('/commands/:id/ack', requireGameSecret, (req, res) => {
  const b = req.body || {};
  const found = adonis.ack(req.params.id, b.serverId, { ok: b.ok, output: b.output });
  res.json({ ok: true, known: found });
});

// ── Site-facing ──────────────────────────────────────────────────────────

site.get('/servers', (req, res) => {
  // stats() also has a `servers` key, the COUNT, so spreading it over the list
  // replaced the array with a number and the dashboard got nothing to render.
  const { servers, ...counts } = adonis.stats();
  res.json({ servers: adonis.listServers(), counts: { ...counts, servers } });
});

site.get('/servers/:id', (req, res) => {
  const s = adonis.getServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'That server is not online.' });
  res.json({ server: s, teams: adonis.teams(req.params.id) });
});

site.get('/players', (req, res) => {
  const q = String(req.query.q || '').trim();
  res.json({ players: q ? adonis.findPlayer(q) : adonis.allPlayers() });
});

site.get('/teams', (req, res) => res.json({ teams: adonis.teams(req.query.serverId || '') }));

site.get('/commands', (req, res) => res.json({ commands: adonis.recentCommands(req.query.limit) }));

site.get('/stats', (req, res) => res.json(adonis.stats()));

// Queuing a command RUNS it on a live game server, so it is gated separately
// from merely looking at the servers, and every one is journalled with who
// asked for it. The original bridge had no check here at all.
const { requireMetHicomm } = require('../middleware/division');

site.post('/commands', requireMetHicomm, async (req, res) => {
  const b = req.body || {};
  const command = String(b.command || '').trim();
  if (!command) return res.status(400).json({ error: 'A command is required.' });
  if (command.length > 300) return res.status(400).json({ error: 'That command is too long.' });

  const by = {
    userId: req.user.id,
    discordId: req.user.discordId || null,
    name: req.user.displayName || req.user.discordUsername || 'Someone',
  };
  const r = adonis.queueCommand({ command, serverId: b.serverId, source: 'site', by });
  if (r.error) return res.status(400).json({ error: r.error });

  // The accountability record. Best effort: a command that ran but was not
  // journalled is better than one that was refused because the journal was
  // unavailable, and the in-memory history has it either way.
  try {
    require('../lib/audit').record({
      req, action: 'ADONIS_COMMAND', category: 'game',
      targetType: 'roblox_server', targetId: b.serverId || 'ALL',
      summary: `Ran "${command}" on ${b.serverId || 'every live server'} (${r.targets} server(s))`,
      metadata: { command, serverId: b.serverId || null, targets: r.targets, commandId: r.id },
    });
  } catch (e) {}
  console.log(`[Adonis] ${by.name} queued "${command}" for ${r.targets} server(s)`);
  res.status(201).json(r);
});

module.exports = { router, site, requireGameSecret, gameSecret };
