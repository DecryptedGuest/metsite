// server/lib/cad/voice/gateway.js
// WebSocket gateway the external voice worker DIALS IN TO.
//
// Free Discord-bot hosts (bot-hosting.net etc.) give the worker outbound network
// but no public inbound URL, so the worker can't be called over HTTP. Instead the
// worker opens a secure WebSocket to THIS app and we push it commands
// (join / leave / speak); it pushes back periodic status. Only outbound network
// is needed on the worker's side, which every host allows.
//
// Enabled whenever CAD_VOICE_WORKER_SECRET is set — the worker authenticates with
// that same secret (as a ?secret= query param over wss). Only one worker is held
// at a time (last valid connection wins).
// `ws` is a normal dependency, but require it defensively so a missing/broken
// install degrades to "gateway disabled" instead of breaking the whole CAD module.
let WebSocketServer = null;
try { WebSocketServer = require('ws').WebSocketServer; } catch (e) { /* gateway stays disabled */ }

let wss = null;
let workerSocket = null;
let lastStatus = null;     // last {type:'status'} payload the worker reported
let lastSeenAt = null;

function secret() { return process.env.CAD_VOICE_WORKER_SECRET || null; }

// Attach to the shared HTTP server (called once, from server/index.js, only when
// run as a long-lived process — never on serverless).
function attach(server) {
  if (wss || !secret() || !WebSocketServer) return;
  wss = new WebSocketServer({ server, path: '/cad-voice' });
  wss.on('connection', (ws, req) => {
    // Auth: ?secret= must match. (wss encrypts the query string in transit.)
    let ok = false;
    try {
      const u = new URL(req.url, 'http://x');
      ok = u.searchParams.get('secret') === secret();
    } catch (e) { ok = false; }
    if (!ok) { try { ws.close(4001, 'bad secret'); } catch (e) {} return; }

    // Last valid worker wins — drop any previous one.
    if (workerSocket && workerSocket !== ws) { try { workerSocket.close(4000, 'replaced'); } catch (e) {} }
    workerSocket = ws;
    lastSeenAt = Date.now();
    console.log('[CAD] voice worker connected via gateway');

    ws.on('message', (buf) => {
      lastSeenAt = Date.now();
      let msg = null;
      try { msg = JSON.parse(buf.toString()); } catch (e) { return; }
      if (msg && msg.type === 'status') lastStatus = msg;
    });
    ws.on('close', () => { if (workerSocket === ws) { workerSocket = null; console.log('[CAD] voice worker disconnected'); } });
    ws.on('error', () => {});

    // Greet + ask for a status snapshot immediately.
    _send(ws, { type: 'hello' });
  });
  console.log('[CAD] voice gateway listening on /cad-voice');
}

function _send(ws, obj) {
  try { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; } } catch (e) {}
  return false;
}

// Is the gateway available to be used at all (secret configured + lib present)?
function enabled() { return !!(secret() && WebSocketServer); }
// Is a worker actually connected right now?
function hasWorker() { return !!(workerSocket && workerSocket.readyState === 1); }

function speak(guildId, channelId, text, grade) { return _send(workerSocket, { type: 'speak', guildId, channelId, text, grade }); }
function join(guildId, channelId) { return _send(workerSocket, { type: 'join', guildId, channelId }); }
function leave() { return _send(workerSocket, { type: 'leave' }); }

// Snapshot for status(): connection + the worker's last self-reported health.
function getState() {
  return {
    connected: hasWorker(),
    lastSeenAt: lastSeenAt ? new Date(lastSeenAt).toISOString() : null,
    health: lastStatus ? {
      ok: true,
      connected: !!lastStatus.voiceConnected,
      hasElevenKey: !!lastStatus.hasElevenKey,
      lastError: lastStatus.lastError || null,
      lastSpokeAt: lastStatus.lastSpokeAt || null,
      lastAttemptAt: lastStatus.lastAttemptAt || null,
      events: lastStatus.events || [],
    } : null,
  };
}

module.exports = { attach, enabled, hasWorker, speak, join, leave, getState };
