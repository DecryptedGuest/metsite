// server/routes/dev.js — developer-only maintenance tools.
// Mounted at /api/dev behind requireAuth. Every route is gated to DEVELOPER.
// Lets developers delete on-site log records (tryouts, tryout logs, patrol/event
// logs) regardless of division — a catch-all cleanup for anything log-related
// that lingers on the site.
const express = require('express');
const prisma  = require('../lib/db');
const audit   = require('../lib/audit');
const ipIntel = require('../lib/ipIntel');

const router = express.Router();

// Developer gate for the whole router.
router.use((req, res, next) => {
  if (!req.user || req.user.role !== 'DEVELOPER') return res.status(403).json({ error: 'Developers only.' });
  next();
});

// POST /api/dev/patrol-backfill — import EVERY historical patrol/event log from
// the configured channels (even very old ones), reusing the live ingest logic
// and skipping misc chatter. Idempotent. Runs in the background (large channels
// take a while); watch the logs / the review queue fills as it goes. ?wait=1
// awaits and returns the counts (only for smaller channels).
let _backfillRunning = false;
router.post('/patrol-backfill', async (req, res) => {
  const bot = require('../lib/bot');
  if (!bot.isReady()) return res.status(503).json({ error: 'Bot not connected yet — try again shortly.' });
  if (_backfillRunning) return res.status(409).json({ error: 'A backfill is already running.' });

  const run = async () => {
    _backfillRunning = true;
    try {
      const result = await bot.backfillPatrolLogs();
      const sum = Object.values(result).map(r => `${r.type}: +${r.imported}/${r.scanned}`).join(', ') || 'nothing (no channels configured)';
      audit.log(req.user, { category: 'DEV', action: 'PATROL_BACKFILL', summary: `Backfilled patrol/event logs — ${sum}` });
      console.log('[Backfill] complete:', JSON.stringify(result));
      return result;
    } finally { _backfillRunning = false; }
  };

  if (req.query.wait) {
    try { return res.json({ ok: true, result: await run() }); }
    catch (e) { return res.status(500).json({ error: 'Backfill failed: ' + e.message }); }
  }
  run().catch(e => console.error('[Backfill] failed:', e.message));
  res.json({ ok: true, started: true, message: 'Backfill started — logs will import in the background. Refresh the review queue to watch them appear.' });
});

// GET /api/dev/db-targets — WHICH databases is this app actually talking to?
//
// This exists because "can't reach the database server" is the same message for
// three completely different problems, and telling them apart by guessing costs
// hours:
//
//   1. IA_DATABASE_URL points at the SAME database as DATABASE_URL. Then the IA
//      sync reads the app's own tables, finds whatever is already there, and can
//      recover nothing — by definition, because there is nothing else in it. This
//      is the one that looks like a connection problem and isn't.
//   2. It points at Railway's PUBLIC TCP proxy (*.proxy.rlwy.net) from inside
//      Railway. A container generally cannot reach its own project's public proxy;
//      the internal hostname (*.railway.internal) is the one that works from in
//      there, and the public one is for connecting from your laptop.
//   3. The database really is gone — service deleted, stopped, or the volume
//      replaced — and the host no longer resolves.
//
// So it reports the host, port and database NAME of each target, whether the two
// are the same target, and a live probe of each. Never the password: the URL is
// parsed and only its safe parts are returned, so this endpoint cannot leak a
// credential even to the developer looking at it.
router.get('/db-targets', async (req, res) => {
  const describe = (raw, label) => {
    if (!raw) return { label, set: false };
    let u = null;
    try { u = new URL(raw); } catch (e) { return { label, set: true, parseError: 'not a valid URL' }; }
    return {
      label, set: true,
      host: u.hostname,
      port: u.port || '5432',
      database: (u.pathname || '').replace(/^\//, '') || null,
      user: u.username || null,
      // The shape of the host tells you which network you are on.
      kind: /\.proxy\.rlwy\.net$/i.test(u.hostname) ? 'railway public TCP proxy'
          : /\.railway\.internal$/i.test(u.hostname) ? 'railway private network'
          : /^(localhost|127\.|::1)/.test(u.hostname) ? 'local'
          : 'other',
    };
  };

  const main = describe(process.env.DATABASE_URL, 'DATABASE_URL');
  const ia   = describe(process.env.IA_DATABASE_URL, 'IA_DATABASE_URL');

  // The question that actually matters for a recovery: are these two the same
  // place? If they are, the IA sync has nowhere to pull FROM.
  //
  // Comparing hostnames is NOT enough, and this is the trap. Every Railway
  // Postgres service has TWO addresses for the same database — a private
  // `*.railway.internal` one and a public `*.proxy.rlwy.net` one. Pointing
  // DATABASE_URL at the private address and IA_DATABASE_URL at the public address
  // of the same service gives two different hostnames and one database, so a
  // hostname comparison says "different" about a setup that cannot recover
  // anything. `sameCluster` below settles it properly by asking both databases
  // for their own identity; this stays as the cheap, always-available hint.
  const sameHost = !!(main.set && ia.set && !main.parseError && !ia.parseError
    && main.host === ia.host && String(main.port) === String(ia.port) && main.database === ia.database);
  // One address private and the other public is the exact shape of the trap, so
  // say so even when we cannot prove it.
  const couldBeSameService = !!(main.set && ia.set && !main.parseError && !ia.parseError
    && main.database === ia.database
    && ((main.kind === 'railway private network' && ia.kind === 'railway public TCP proxy')
     || (main.kind === 'railway public TCP proxy' && ia.kind === 'railway private network')));

  // Probe each one for real, with a short timeout — an unreachable host otherwise
  // holds this request open for the driver's full connect timeout.
  const probe = async (client, name) => {
    if (!client) return { ok: false, why: name + ' is not configured' };
    const t0 = Date.now();
    try {
      const r = await Promise.race([
        client.$queryRawUnsafe('SELECT current_database() AS db, current_user AS "user"'),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timed out after 8s')), 8000)),
      ]);
      return { ok: true, ms: Date.now() - t0, db: r && r[0] ? r[0].db : null, user: r && r[0] ? r[0].user : null };
    } catch (e) {
      return { ok: false, ms: Date.now() - t0, why: e.message };
    }
  };

  // How many cases and tickets each one is actually holding. This is the number
  // the recovery turns on, and it is the one nobody can see from Railway's UI.
  const counts = async (client) => {
    if (!client) return null;
    const one = async (sql) => {
      try {
        const r = await Promise.race([
          client.$queryRawUnsafe(sql),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), 8000)),
        ]);
        return r && r[0] ? Number(r[0].n) : null;
      } catch (e) { return { error: e.message.slice(0, 200) }; }
    };
    return {
      cases:   await one('SELECT COUNT(*)::int AS n FROM cases'),
      tickets: await one('SELECT COUNT(*)::int AS n FROM ticket_logs'),
    };
  };

  // Which physical Postgres cluster this is. `system_identifier` is stamped once,
  // when the cluster is first created, so it identifies the DATABASE rather than
  // the route taken to reach it — which is the only way to tell a private and a
  // public address for one service apart from two genuinely separate services.
  const identity = async (client) => {
    if (!client) return null;
    try {
      const r = await Promise.race([
        client.$queryRawUnsafe('SELECT system_identifier::text AS id FROM pg_control_system()'),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), 8000)),
      ]);
      return r && r[0] ? String(r[0].id) : null;
    } catch (e) { return null; }
  };

  const iaClient = require('../lib/dbIa').getIaClient();
  const [mainProbe, iaProbe] = await Promise.all([probe(prisma, 'DATABASE_URL'), probe(iaClient, 'IA_DATABASE_URL')]);
  const [mainCounts, iaCounts, mainId, iaId] = await Promise.all([
    mainProbe.ok ? counts(prisma) : null,
    iaProbe.ok ? counts(iaClient) : null,
    mainProbe.ok ? identity(prisma) : null,
    iaProbe.ok ? identity(iaClient) : null,
  ]);
  // null when either side is unreachable — unknown, not "different".
  const sameCluster = (mainId && iaId) ? (mainId === iaId) : null;
  const sameTarget = sameCluster === true ? true : sameHost;

  // Say what to DO, not just what is broken.
  const verdict = !ia.set
    ? 'IA_DATABASE_URL is not set, so the IA sync does nothing. It needs the connection string of the OLD database that still holds the cases — not this one.'
    : sameTarget
      ? 'IA_DATABASE_URL points at THE SAME DATABASE as the app itself, so the sync has nowhere to pull from and cannot recover anything. It has to point at a DIFFERENT database that still holds the cases. If there is no such database, use the Discord forum import instead.'
      : !iaProbe.ok && ia.kind === 'railway public TCP proxy'
        ? 'The IA database is unreachable, and it is addressed by Railway\'s PUBLIC TCP proxy, which a container usually cannot use to reach its own project. '
          + (couldBeSameService
            ? 'WARNING: this may well be the SAME database the app already uses, reached by its public address instead of its private one — every Railway Postgres has both. Open the Postgres service in Railway and look at DATABASE_PUBLIC_URL: if it is this host and port, then this is the same empty database and the sync can never recover anything. Use the Discord forum import instead. '
            : '')
          + 'Test it from your OWN machine, where the public proxy does work: if it connects and has cases in it, the data is alive and recoverable — point IA_DATABASE_URL at that service\'s *.railway.internal address, or dump the cases table across. If it does not connect from there either, the service is gone.'
        : !iaProbe.ok
          ? 'The IA database is unreachable. Either the service is stopped or deleted, or the host is wrong.'
          : (iaCounts && Number(iaCounts.cases) > 0)
            ? `Reachable, and it is holding ${iaCounts.cases} case(s). Press "Sync IA cases & tickets" and they come across.`
            : 'Reachable, but there are no cases in it, so there is nothing for the sync to bring over.';

  res.json({
    main, ia,
    // sameHost is the cheap check; sameCluster is the real one and is null when
    // either side could not be asked. sameTarget prefers the real one.
    sameTarget, sameHost, sameCluster, couldBeSameService,
    mainProbe, iaProbe, mainCounts, iaCounts, verdict,
  });
});

// POST /api/dev/ia-sync — pull cases + tickets from the live IA database
// (IA_DATABASE_URL) into the MET database. Idempotent; safe to run repeatedly.
router.post('/ia-sync', async (req, res) => {
  try {
    const result = await require('../lib/iaSync').syncAll();
    if (!result.ok) return res.status(400).json({ error: result.reason || 'IA sync not configured' });
    audit.log(req.user, { category: 'DEV', action: 'IA_SYNC',
      summary: `Synced IA data — cases ${result.cases && result.cases.synced}/${result.cases && result.cases.total}, tickets ${result.tickets && result.tickets.synced}/${result.tickets && result.tickets.total}` });
    res.json(result);
  } catch (e) {
    console.error('[Dev] IA sync failed:', e.message);
    res.status(500).json({ error: 'IA sync failed: ' + e.message });
  }
});

// DELETE /api/dev/tryouts/:id — remove a tryout (any division). Best-effort
// removal of its Discord announcement + host DM, and its queued commands.
router.delete('/tryouts/:id', async (req, res) => {
  try {
    const t = await prisma.tryout.findUnique({ where: { id: req.params.id } });
    if (!t) return res.status(404).json({ error: 'Tryout not found' });
    // Tidy the Discord side (never blocks the delete).
    try {
      const bot = require('../lib/bot');
      await bot.deleteTryoutAnnouncement(t).catch(() => {});
    } catch (e) { /* bot not ready */ }
    // TryoutCommand rows reference the tryout by id (no FK cascade) — clear them.
    await prisma.tryoutCommand.deleteMany({ where: { tryoutId: t.id } }).catch(() => {});
    // Purge any analytics tied to this tryout: the concluded TryoutLog(s) linked
    // back to it feed every dashboard stat, so a deleted tryout must leave none.
    await prisma.tryoutLog.deleteMany({ where: { tryoutId: t.id } }).catch(() => {});
    await prisma.tryout.delete({ where: { id: t.id } });
    audit.log(req.user, { category: 'DEV', action: 'DELETE', division: t.division,
      target: { type: 'tryout', id: t.id, name: t.hostName }, summary: `Deleted ${t.division} tryout hosted by ${t.hostName}` });
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'P2025') return res.status(404).json({ error: 'Not found' });
    console.error('[Dev] delete tryout failed:', e.message);
    res.status(500).json({ error: 'Failed to delete tryout' });
  }
});

// DELETE /api/dev/tryout-logs/:id — remove a tryout log (any division).
router.delete('/tryout-logs/:id', async (req, res) => {
  try {
    await prisma.tryoutLog.delete({ where: { id: req.params.id } });
    audit.log(req.user, { category: 'DEV', action: 'DELETE', target: { type: 'tryout_log', id: req.params.id }, summary: `Deleted tryout log ${req.params.id}` });
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'P2025') return res.status(404).json({ error: 'Not found' });
    console.error('[Dev] delete tryout log failed:', e.message);
    res.status(500).json({ error: 'Failed to delete tryout log' });
  }
});

// GET /api/dev/game-logs?source=&q=&before= — in-game log feed (Adonis / join /
// leave / chat) ingested from the training game. Same data the MET HICOMM feed
// shows; exposed here so developers can read it from the dev panel too.
router.get('/game-logs', async (req, res) => {
  try {
    const where = {};
    const src = String(req.query.source || '').toUpperCase();
    if (['ADONIS', 'JOIN', 'LEAVE', 'CHAT'].includes(src)) where.source = src;
    const q = String(req.query.q || '').trim();
    if (q) where.OR = [
      { actor:   { contains: q, mode: 'insensitive' } },
      { target:  { contains: q, mode: 'insensitive' } },
      { message: { contains: q, mode: 'insensitive' } },
      { action:  { contains: q, mode: 'insensitive' } },
    ];
    if (req.query.before) where.createdAt = { lt: new Date(req.query.before) };
    const rows = await prisma.gameLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: 150 });
    const { deriveTarget } = require('../lib/gameLog');
    res.json(rows.map(r => ({
      id: r.id, source: r.source, actor: r.actor, actorId: r.actorId,
      target: deriveTarget(r), action: r.action, message: r.message, place: r.place,
      createdAt: r.createdAt,
    })));
  } catch (e) {
    console.error('[Dev] game-logs failed:', e.message);
    res.status(500).json({ error: 'Failed to load game logs' });
  }
});

// POST /api/dev/patrols/void-all?type=PATROL|EVENT — clear the pending queue by
// marking every PENDING log of that type APPROVED. This is an on-site bulk
// action only: it does NOT react in Discord and does NOT award MET event points
// (that would spam the sheet for a big import). Use to dismiss a backlog.
router.post('/patrols/void-all', async (req, res) => {
  const type = req.query.type === 'EVENT' ? 'EVENT' : 'PATROL';
  try {
    const result = await prisma.patrolLog.updateMany({
      where: { type, status: 'PENDING' },
      data: {
        status: 'APPROVED',
        reviewedById: req.user.id,
        reviewedByName: `${req.user.displayName || req.user.discordUsername || 'Developer'} (void)`,
        reviewedAt: new Date(),
      },
    });
    audit.log(req.user, { category: 'DEV', action: 'VOID_PENDING',
      summary: `Voided ${result.count} pending ${type} log(s) → approved (no reaction, no points)` });
    res.json({ ok: true, type, count: result.count });
  } catch (e) {
    console.error('[Dev] void-all pending failed:', e.message);
    res.status(500).json({ error: 'Failed to void pending logs' });
  }
});

// DELETE /api/dev/patrol-logs/:id — remove a patrol/event log.
router.delete('/patrol-logs/:id', async (req, res) => {
  try {
    await prisma.patrolLog.delete({ where: { id: req.params.id } });
    audit.log(req.user, { category: 'DEV', action: 'DELETE', target: { type: 'patrol_log', id: req.params.id }, summary: `Deleted patrol/event log ${req.params.id}` });
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'P2025') return res.status(404).json({ error: 'Not found' });
    console.error('[Dev] delete patrol log failed:', e.message);
    res.status(500).json({ error: 'Failed to delete patrol log' });
  }
});

// ── Emergency alerts ─────────────────────────────────────────────────
// Push a full-screen, sound‑playing "Emergency Alert" overlay to people who are
// currently on the site (an open SSE connection), targeted at everyone, one or
// more divisions, or specific users. Delivery is live-only (SSE), so it reaches
// exactly the people currently online. DEVELOPER only; every send is audited.

// The site divisions a member can be targeted by (matches the cached
// user.divisions[].division values + the synthetic MET High Command entry).
const ALERT_DIVISIONS = ['IA', 'HPC', 'CID', 'FLP', 'SCO19', 'MET'];
function userDivisionNames(u) {
  const out = new Set();
  const divs = Array.isArray(u.divisions) ? u.divisions : [];
  for (const d of divs) { if (d && d.division) out.add(String(d.division).toUpperCase()); }
  // Site role IA/SUPERVISOR/HICOMM implies the IA division for targeting.
  if (['IA', 'SUPERVISOR', 'HICOMM'].includes(u.role)) out.add('IA');
  return out;
}

// GET /api/dev/online — everyone with a live page open right now, for the picker.
router.get('/online', async (req, res) => {
  try {
    const events = require('../lib/events');
    const ids = events.connectedUserIds();
    if (!ids.length) return res.json({ users: [] });
    const users = await prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, displayName: true, discordUsername: true, role: true, divisions: true },
    });
    res.json({
      divisions: ALERT_DIVISIONS,
      users: users.map(u => ({
        id: u.id,
        name: u.displayName || u.discordUsername,
        role: u.role,
        divisions: [...userDivisionNames(u)],
      })).sort((a, b) => a.name.localeCompare(b.name)),
    });
  } catch (e) {
    console.error('[Dev] online list failed:', e.message);
    res.status(500).json({ error: 'Failed to load online users.' });
  }
});

// POST /api/dev/emergency-alert { target:'everyone'|'divisions'|'users', message, divisions?, userIds? }
router.post('/emergency-alert', async (req, res) => {
  try {
    const body = req.body || {};
    const message = String(body.message || '').trim().slice(0, 1000);
    if (!message) return res.status(400).json({ error: 'A message is required.' });
    const target = ['everyone', 'divisions', 'users'].includes(body.target) ? body.target : 'everyone';
    const events = require('../lib/events');
    const payload = {
      message,
      by: req.user.displayName || req.user.discordUsername || 'Developer',
      at: new Date().toISOString(),
    };

    let sent = 0, recipients = 0;
    if (target === 'everyone') {
      sent = events.broadcast('emergency_alert', payload);
      recipients = events.connectedUserIds().length;
    } else if (target === 'divisions') {
      const wanted = new Set((Array.isArray(body.divisions) ? body.divisions : []).map(d => String(d).toUpperCase()).filter(d => ALERT_DIVISIONS.includes(d)));
      if (!wanted.size) return res.status(400).json({ error: 'Pick at least one division.' });
      const ids = events.connectedUserIds();
      if (ids.length) {
        const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, role: true, divisions: true } });
        for (const u of users) {
          const names = userDivisionNames(u);
          if ([...wanted].some(w => names.has(w))) { recipients++; sent += events.publishToUser(u.id, 'emergency_alert', payload); }
        }
      }
    } else { // specific users
      const ids = [...new Set((Array.isArray(body.userIds) ? body.userIds : []).map(String).filter(Boolean))];
      if (!ids.length) return res.status(400).json({ error: 'Select at least one recipient.' });
      for (const id of ids) { const n = events.publishToUser(id, 'emergency_alert', payload); if (n) recipients++; sent += n; }
    }

    // Deliberately NOT audit-logged — developer actions never appear in any log.
    res.json({ ok: true, sent, recipients });
  } catch (e) {
    console.error('[Dev] emergency alert failed:', e.message);
    res.status(500).json({ error: 'Failed to send emergency alert.' });
  }
});

// ── MET emoji ─────────────────────────────────────────────────────
// The set uploads itself on bot start and re-checks hourly, so neither of these
// is normally needed. They exist for the two times you do want them: seeing at a
// glance whether the guild actually has the emoji (if it doesn't, everything
// silently falls back to unicode and looks fine, which makes the failure easy to
// miss), and forcing a re-upload after editing the artwork.
router.get('/emoji', (req, res) => {
  res.json(require('../lib/emoji').status());
});

// POST /api/dev/emoji/sync
//   { force: true }       re-upload even the ones already there — that's how
//                         you push new artwork for an existing name
//   { purgeGuild: true }  delete the copies still sitting in a server. These
//                         live on the bot now, so a guild copy is redundant;
//                         only emoji whose name is exactly one of ours are
//                         touched, so the server's own rank badges are safe.
router.post('/emoji/sync', async (req, res) => {
  const bot = require('../lib/bot');
  if (!bot.isReady()) return res.status(503).json({ error: 'Bot not connected yet — try again shortly.' });
  const body = req.body || {};
  try {
    const out = await require('../lib/emoji').syncGuildEmoji(bot.getClient(), {
      force: !!body.force,
      purgeGuild: !!body.purgeGuild,
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/dev/emoji/purge-guild — the cleanup on its own, without a re-sync.
router.post('/emoji/purge-guild', async (req, res) => {
  const bot = require('../lib/bot');
  if (!bot.isReady()) return res.status(503).json({ error: 'Bot not connected yet — try again shortly.' });
  try {
    const emoji = require('../lib/emoji');
    const strays = await emoji.findGuildStrays(bot.getClient());
    // A dry run by default: say what would go before anything does.
    if (!(req.body && req.body.apply)) {
      return res.json({ dryRun: true, found: strays.map(s => ({ name: s.name, guild: s.guildName })) });
    }
    res.json({ dryRun: false, ...(await emoji.purgeGuildEmoji(bot.getClient(), strays)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Slash commands ────────────────────────────────────────────────
// A command that doesn't show up in Discord looks identical from the server
// side to one that does — we called set(), it returned, done. These read the
// truth back out of Discord.
//
//   GET  /api/dev/commands        what Discord actually has, and where
//   POST /api/dev/commands/register   re-register now, without a restart
router.get('/commands', async (req, res) => {
  try {
    res.json(await require('../lib/bot').listRegisteredCommands());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/commands/register', async (req, res) => {
  const bot = require('../lib/bot');
  if (!bot.isReady()) return res.status(503).json({ error: 'Bot not connected yet — try again shortly.' });
  try {
    const out = await bot.registerCommands();
    res.json({ ...out, now: await bot.listRegisteredCommands() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
