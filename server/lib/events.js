// server/lib/events.js — lightweight Server-Sent Events hub for live, in-page
// updates (exam marked, a tryout going live, new-device sign-in, etc.).
//
// In-memory only, so it works on the always-on host (Railway) and is a no-op on
// serverless where connections can't be held open — callers must treat every
// publish as best-effort. Web Push remains the durable delivery path; SSE is
// the instant, in-page nicety on top of it.

// userId -> Set<res>
const clients = new Map();
let heartbeat = null;

function subscribe(userId, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // disable proxy buffering (nginx/Railway)
  });
  res.write('retry: 5000\n\n');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let set = clients.get(userId);
  if (!set) { set = new Set(); clients.set(userId, set); }
  set.add(res);

  const cleanup = () => {
    const s = clients.get(userId);
    if (s) { s.delete(res); if (!s.size) clients.delete(userId); }
  };
  res.on('close', cleanup);
  res.on('error', cleanup);

  ensureHeartbeat();
}

function ensureHeartbeat() {
  if (heartbeat) return;
  // Comment-line ping keeps intermediaries from closing idle connections.
  heartbeat = setInterval(() => {
    for (const set of clients.values()) {
      for (const res of set) { try { res.write(': ping\n\n'); } catch (e) { /* dropped */ } }
    }
  }, 25000);
  if (heartbeat.unref) heartbeat.unref();
}

function send(res, type, data) {
  try {
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify(data || {})}\n\n`);
  } catch (e) { /* connection gone — cleanup handlers will remove it */ }
}

function publishToUser(userId, type, data) {
  const set = clients.get(String(userId));
  if (!set) return 0;
  let n = 0;
  for (const res of set) { send(res, type, data); n++; }
  return n;
}

function broadcast(type, data) {
  let n = 0;
  for (const set of clients.values()) {
    for (const res of set) { send(res, type, data); n++; }
  }
  return n;
}

function connectionCount() {
  let n = 0;
  for (const set of clients.values()) n += set.size;
  return n;
}

module.exports = { subscribe, publishToUser, broadcast, connectionCount };
