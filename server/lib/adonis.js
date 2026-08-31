// server/lib/adonis.js
// The Adonis command bridge: live Roblox server state, the command queue, and
// the record of what was run.
//
// Roblox game servers cannot be connected to. They poll. So the shape is:
//
//   game  →  POST /heartbeat          "I am alive, here is who is in me"
//   staff →  queue a command          held here until a server asks for it
//   game  →  GET  /commands/pending   takes the ones addressed to it
//   game  →  POST /commands/:id/ack   reports what happened
//
// Live state is deliberately in memory: it describes servers that exist right
// now, it is worthless a minute after the process dies, and writing a row per
// heartbeat for every server every few seconds would be a lot of database
// traffic for data with a sixty-second shelf life. The command HISTORY is a
// different matter and is kept, because "who ran what on which server" is an
// accountability question.
'use strict';

const crypto = require('crypto');

// How long after its last heartbeat a server is presumed gone. The Roblox side
// beats every ~15s, so a minute is four missed beats.
const SERVER_EXPIRY_MS  = 60 * 1000;
// A command nobody collected in this long is stale: the server it was for has
// almost certainly gone.
const COMMAND_EXPIRY_MS = 5 * 60 * 1000;
const MAX_QUEUE         = 200;
const MAX_HISTORY       = 500;

/** @type {Map<string, object>} live servers, keyed by serverId (the Roblox JobId) */
const servers = new Map();
/** @type {Array<object>} commands waiting to be collected */
let queue = [];
/** @type {Array<object>} newest first: what was run, by whom, and what came back */
let history = [];

function now() { return Date.now(); }

// ── Servers ──────────────────────────────────────────────────────────────

/**
 * Record a heartbeat. Everything but serverId is optional, because a game
 * server that can only manage its id is still more useful known than unknown.
 */
function heartbeat(body) {
  const serverId = String(body.serverId || '').trim();
  if (!serverId) return null;

  const players = Array.isArray(body.players) ? body.players.slice(0, 120).map(normalisePlayer) : [];
  const prev = servers.get(serverId);

  const row = {
    serverId,
    placeId:   body.placeId != null ? String(body.placeId) : (prev ? prev.placeId : null),
    placeName: body.placeName ? String(body.placeName).slice(0, 80) : (prev ? prev.placeName : null),
    region:    body.region ? String(body.region).slice(0, 40) : (prev ? prev.region : null),
    // playerCount is trusted only as a fallback: the list is the truth when we
    // have one, and the two disagreeing is a bug we would rather not import.
    playerCount: players.length || Number(body.playerCount) || 0,
    maxPlayers:  Number(body.maxPlayers) || (prev ? prev.maxPlayers : null),
    players,
    fps:  body.fps  != null ? Math.round(Number(body.fps))  : null,
    ping: body.ping != null ? Math.round(Number(body.ping)) : null,
    // When we first saw it, so uptime survives a heartbeat that omits it.
    firstSeen: prev ? prev.firstSeen : now(),
    lastHeartbeat: now(),
  };
  servers.set(serverId, row);
  return row;
}

function normalisePlayer(p) {
  if (!p) return null;
  if (typeof p === 'string') return { name: p.slice(0, 40), userId: null, team: null, rank: null };
  return {
    userId:      p.userId != null ? String(p.userId) : null,
    name:        String(p.name || p.username || '').slice(0, 40) || null,
    displayName: p.displayName ? String(p.displayName).slice(0, 40) : null,
    team:        p.team ? String(p.team).slice(0, 40) : null,
    rank:        p.rank ? String(p.rank).slice(0, 60) : null,
    // Adonis level: 0 player, 1 moderator, 2 admin, 3 owner, 4 creator.
    adminLevel:  p.adminLevel != null ? Number(p.adminLevel) : null,
  };
}

function forget(serverId) { return servers.delete(String(serverId)); }

/** Drop servers that stopped beating, and commands nobody came for. */
function sweep() {
  const t = now();
  let goneServers = 0, goneCommands = 0;
  for (const [id, s] of servers) {
    if (t - s.lastHeartbeat > SERVER_EXPIRY_MS) { servers.delete(id); goneServers++; }
  }
  const before = queue.length;
  queue = queue.filter(c => t - c.createdAt < COMMAND_EXPIRY_MS);
  goneCommands = before - queue.length;
  return { goneServers, goneCommands };
}

function listServers() {
  sweep();
  return [...servers.values()]
    .map(s => ({ ...s, uptimeSeconds: Math.round((now() - s.firstSeen) / 1000),
                       lastSeenSeconds: Math.round((now() - s.lastHeartbeat) / 1000) }))
    .sort((a, b) => b.playerCount - a.playerCount);
}

function getServer(serverId) {
  sweep();
  const s = servers.get(String(serverId));
  if (!s) return null;
  return { ...s, uptimeSeconds: Math.round((now() - s.firstSeen) / 1000),
                 lastSeenSeconds: Math.round((now() - s.lastHeartbeat) / 1000) };
}

/** Every player across every live server, with the server they are in. */
function allPlayers() {
  const out = [];
  for (const s of listServers()) {
    for (const p of s.players) {
      if (p) out.push({ ...p, serverId: s.serverId, placeName: s.placeName });
    }
  }
  return out;
}

/** Players grouped by team, across one server or all of them. */
function teams(serverId) {
  const list = serverId ? (getServer(serverId) ? [getServer(serverId)] : []) : listServers();
  const byTeam = new Map();
  for (const s of list) {
    for (const p of s.players) {
      if (!p) continue;
      const key = p.team || 'No team';
      if (!byTeam.has(key)) byTeam.set(key, []);
      byTeam.get(key).push({ ...p, serverId: s.serverId });
    }
  }
  return [...byTeam.entries()]
    .map(([team, members]) => ({ team, count: members.length, members }))
    .sort((a, b) => b.count - a.count);
}

/** Find a player by name or id, anywhere. Case-insensitive, partial on name. */
function findPlayer(q) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return [];
  return allPlayers().filter(p =>
    (p.userId && String(p.userId) === needle) ||
    (p.name && p.name.toLowerCase().includes(needle)) ||
    (p.displayName && p.displayName.toLowerCase().includes(needle))
  );
}

// ── Commands ─────────────────────────────────────────────────────────────

/**
 * Queue a command.
 * @param {object} o
 * @param {string} o.command   the Adonis command, without the prefix
 * @param {string} [o.serverId] a single server, or empty for every live one
 * @param {object} o.by        who is running it, for the record
 */
function queueCommand(o) {
  sweep();
  if (queue.length >= MAX_QUEUE) return { error: 'The command queue is full.' };
  const command = String(o.command || '').trim();
  if (!command) return { error: 'A command is required.' };

  const target = String(o.serverId || '').trim();
  // Resolved AT QUEUE TIME, not at collection time: "all servers" means the
  // ones that existed when the order was given, so a server that joins two
  // minutes later does not silently pick up an old broadcast.
  const targets = target ? [target] : [...servers.keys()];
  if (!targets.length) return { error: 'No Roblox servers are online right now.' };
  if (target && !servers.has(target)) return { error: `Server ${target} is not online.` };

  const entry = {
    id: crypto.randomUUID(),
    command,
    args: Array.isArray(o.args) ? o.args.map(String) : [],
    serverId: target,
    targets,
    // Collected by, so a broadcast is delivered once per server rather than
    // being taken by whichever server polls first.
    collectedBy: [],
    results: [],
    source: o.source || 'site',
    by: o.by || null,
    createdAt: now(),
  };
  queue.push(entry);
  remember(entry);
  return { ok: true, id: entry.id, targets: targets.length };
}

/** What this server should run. Marks them collected so it does not run twice. */
function collect(serverId) {
  sweep();
  const id = String(serverId || '');
  if (!id) return [];
  const mine = queue.filter(c => c.targets.includes(id) && !c.collectedBy.includes(id));
  for (const c of mine) c.collectedBy.push(id);
  // Once every target has taken it, it can leave the queue.
  queue = queue.filter(c => c.targets.some(t => !c.collectedBy.includes(t)));
  return mine.map(c => ({ id: c.id, command: c.command, args: c.args }));
}

/** The game reporting back. */
function ack(id, serverId, result) {
  const rec = history.find(h => h.id === id);
  if (rec) {
    rec.results.push({
      serverId: String(serverId || ''),
      ok: result && result.ok !== false,
      output: result && result.output ? String(result.output).slice(0, 500) : null,
      at: now(),
    });
  }
  queue = queue.filter(c => c.id !== id || c.targets.some(t => !c.collectedBy.includes(t)));
  return !!rec;
}

function remember(entry) {
  history.unshift({
    id: entry.id, command: entry.command, serverId: entry.serverId,
    targets: entry.targets.length, source: entry.source, by: entry.by,
    createdAt: entry.createdAt, results: entry.results,
  });
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
}

function recentCommands(limit) { return history.slice(0, Math.min(Number(limit) || 50, MAX_HISTORY)); }

function stats() {
  sweep();
  const list = listServers();
  return {
    servers: list.length,
    players: list.reduce((n, s) => n + s.playerCount, 0),
    queued: queue.length,
    history: history.length,
  };
}

// One sweep on a timer so a dashboard that nobody is watching still tells the
// truth the moment somebody opens it.
let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(() => {
    const r = sweep();
    if (r.goneServers || r.goneCommands) {
      console.log(`[Adonis] swept ${r.goneServers} dead server(s), ${r.goneCommands} stale command(s)`);
    }
  }, 15 * 1000);
  if (timer.unref) timer.unref();
}

module.exports = {
  heartbeat, forget, listServers, getServer, allPlayers, teams, findPlayer,
  queueCommand, collect, ack, recentCommands, stats, sweep, start,
  SERVER_EXPIRY_MS, COMMAND_EXPIRY_MS,
};
