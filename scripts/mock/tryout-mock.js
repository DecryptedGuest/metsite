#!/usr/bin/env node
// scripts/mock/tryout-mock.js
// A standalone stand-in for the tryout portal, for driving the in-game
// instructor panel from Roblox Studio.
//
//   GAME_SECRET=whatever-you-like PORT=3000 node scripts/mock/tryout-mock.js
//
// No dependencies, no database, no Discord. It answers every endpoint the two
// server scripts call, in EXACTLY the shape the real portal answers, and keeps
// its state in memory so a full host → command → ack → conclude loop behaves
// like the real thing rather than returning the same canned blob every time.
//
// Roblox Studio will not call http://localhost. Put this behind any public
// HTTPS host — see the README note at the bottom of this file.
//
// ── What it deliberately does NOT do ──────────────────────────────
// Nothing here authenticates anybody for real, and the secret comparison is a
// plain === rather than the constant-time compare the portal uses. It is a test
// double. Do not put it in front of anything that matters, and do not give it
// the production GAME_SECRET.

const http = require('http');
const { URL } = require('url');

const SECRET = process.env.GAME_SECRET || 'mock-secret';
const PORT   = Number(process.env.PORT || 3000);

// ── In-memory state ───────────────────────────────────────────────
// Enough to make the loop realistic: one live tryout, a queue of commands the
// panel must apply and ack, and a record of what it acked.
const state = {
  tryouts: new Map(),          // id → { id, division, host, status }
  commands: new Map(),         // id → { id, tryoutId, action, ..., applied }
  seq: 0,
  // Roblox ids this mock treats as linked. Add your own test account here.
  linked: new Map([
    ['1521189335230316675', { username: 'Test Host', discordId: '1521189335230316675' }],
  ]),
};

const nextId = (prefix) => `${prefix}_${String(++state.seq).padStart(6, '0')}`;

/** Queue a command the in-game panel will pick up on its next poll. */
function queueCommand(tryoutId, action, target = {}) {
  const id = nextId('cmd');
  state.commands.set(id, {
    id, tryoutId, action,
    targetRobloxId: target.robloxId != null ? Number(target.robloxId) : null,
    targetUsername: target.username || null,
    detail: target.detail || null,
    applied: false,
  });
  return id;
}

// ── Plumbing ──────────────────────────────────────────────────────
function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
  });
}

/** The same auth shape the portal uses: header, or a `secret` body field. */
function authed(req, body, url) {
  const provided = req.headers['x-game-secret'] || (body && body.secret) || url.searchParams.get('secret') || '';
  return String(provided) === String(SECRET);
}

const server = http.createServer(async (req, res) => {
  const url  = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const body = req.method === 'POST' ? await readBody(req) : {};

  console.log(`${req.method} ${path}${url.search} ${req.method === 'POST' ? JSON.stringify(body).slice(0, 200) : ''}`);

  // Unauthenticated, like the real /health — so you can check reachability from
  // Studio before you have the secret right.
  if (path === '/api/game/health') {
    return send(res, 200, { ok: true, mock: true, secretSet: true, signingSet: false,
      roverConfigured: true, announceChannelSet: true, publicBaseUrlSet: true, botReady: true });
  }

  if (!authed(req, body, url)) return send(res, 401, { error: 'Bad game secret or signature.' });

  // GET /api/game/tryout/linkstatus?robloxId=
  if (req.method === 'GET' && path === '/api/game/tryout/linkstatus') {
    const raw = url.searchParams.get('robloxId');
    if (raw == null || raw.trim() === '') return send(res, 400, { error: 'robloxId is required.' });
    const text = raw.trim();
    if (!/^[0-9]+$/.test(text) || text === '0') {
      return send(res, 400, { error: 'robloxId must be a positive integer.' });
    }
    const hit = state.linked.get(text);
    return hit
      ? send(res, 200, { linked: true, username: hit.username, discordId: hit.discordId })
      : send(res, 200, { linked: false, reason: 'no linked account for this Roblox id' });
  }

  // POST /api/game/tryout/create
  if (req.method === 'POST' && path === '/api/game/tryout/create') {
    const host = body.host || {};
    // Mirror the real 422: an unlinked host cannot start a tryout. Use an id
    // that is NOT in state.linked to exercise the panel's failure path.
    if (!host.robloxId || !state.linked.has(String(host.robloxId))) {
      return send(res, 422, {
        error: `No linked account was found for Roblox user ${host.robloxId || '?'}`
             + `${host.username ? ` (${host.username})` : ''}. That person must sign in at the portal`
             + ' with the Discord account RoVer-verified to that Roblox account, then retry.',
        robloxId: host.robloxId != null ? String(host.robloxId) : null,
        roverConfigured: true,
      });
    }
    const live = [...state.tryouts.values()].find(t => t.status === 'LIVE'
      && t.division === (body.division || 'HPC'));
    if (live) return send(res, 409, { error: 'A tryout is already ongoing.', tryoutId: live.id });

    const id = nextId('tryout');
    state.tryouts.set(id, { id, division: body.division || 'HPC', host, status: 'LIVE' });

    // Queue a couple of commands straight away so the very first poll has
    // something to apply and ack — otherwise the panel's command path is only
    // exercised if somebody happens to click something on the site mid-test.
    queueCommand(id, 'strike', { robloxId: 1234567, username: 'TestCadet1', detail: 'late' });
    queueCommand(id, 'kick',   { robloxId: 7654321, username: 'TestCadet2' });

    return send(res, 201, { tryoutId: id, dmed: true, announced: true });
  }

  // POST /api/game/tryout/start-scheduled
  if (req.method === 'POST' && path === '/api/game/tryout/start-scheduled') {
    if (!body.scheduledId) return send(res, 400, { error: 'scheduledId is required.' });
    const id = String(body.scheduledId);
    state.tryouts.set(id, { id, division: body.division || 'HPC', host: body.host || {}, status: 'LIVE' });
    queueCommand(id, 'pass', { robloxId: 1234567, username: 'TestCadet1' });
    return send(res, 200, { tryoutId: id, dmed: true, announced: true });
  }

  // GET /api/game/tryout/commands?tryoutId=&division=
  if (req.method === 'GET' && path === '/api/game/tryout/commands') {
    const tryoutId = url.searchParams.get('tryoutId');
    if (!tryoutId) return send(res, 400, { error: 'tryoutId required' });
    const commands = [...state.commands.values()]
      .filter(c => c.tryoutId === String(tryoutId) && !c.applied)
      .map(({ id, action, targetRobloxId, targetUsername, detail }) =>
        ({ id, action, targetRobloxId, targetUsername, detail }));
    return send(res, 200, { commands });
  }

  // POST /api/game/tryout/commands/ack  { ids: [...] }
  if (req.method === 'POST' && path === '/api/game/tryout/commands/ack') {
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    if (!ids.length) return send(res, 200, { ok: true, acked: 0 });
    let acked = 0;
    for (const id of ids) {
      const c = state.commands.get(id);
      // Only an un-applied command counts, so a double-ack reports 1 then 0 —
      // which is what the real updateMany does, and what tells you the panel is
      // acking correctly rather than re-acking the same ids for ever.
      if (c && !c.applied) { c.applied = true; acked++; }
    }
    return send(res, 200, { ok: true, acked });
  }

  // POST /api/game/tryout/live
  if (req.method === 'POST' && path === '/api/game/tryout/live') {
    return send(res, 200, { ok: true });
  }

  // POST /api/game/tryout/conclude
  if (req.method === 'POST' && path === '/api/game/tryout/conclude') {
    const t = body.tryoutId ? state.tryouts.get(String(body.tryoutId)) : null;
    if (t) t.status = 'COMPLETED';
    const id = nextId('log');
    return send(res, 201, {
      ok: true, id, status: 'DRAFT', hostLinked: true,
      reviewUrl: `https://example.invalid/hpc/dashboard?tryoutLog=${id}`,
    });
  }

  // POST /api/game/tryout/summary
  if (req.method === 'POST' && path === '/api/game/tryout/summary') {
    return send(res, 200, { ok: true });
  }

  // POST /api/game/tryout/cancel
  if (req.method === 'POST' && path === '/api/game/tryout/cancel') {
    const t = body.tryoutId ? state.tryouts.get(String(body.tryoutId)) : null;
    if (t) t.status = 'CANCELLED';
    return send(res, 200, { ok: true, tryoutId: t ? t.id : null });
  }

  // A test hook, not part of the real API: queue a command by hand so you can
  // drive the panel's apply/ack path without the site.
  if (req.method === 'POST' && path === '/mock/queue-command') {
    if (!body.tryoutId || !body.action) return send(res, 400, { error: 'tryoutId and action required' });
    return send(res, 200, { ok: true, id: queueCommand(String(body.tryoutId), String(body.action), body.target || {}) });
  }

  return send(res, 404, { error: `No mock route for ${req.method} ${path}` });
});

server.listen(PORT, () => {
  console.log(`[mock] tryout portal on :${PORT} · secret "${SECRET}"`);
  console.log('[mock] Roblox Studio needs a PUBLIC HTTPS url · put this behind a tunnel or a host.');
});
