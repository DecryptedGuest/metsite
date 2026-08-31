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
  if (!bot.isReady()) return res.status(503).json({ error: 'Bot not connected yet · try again shortly.' });
  if (_backfillRunning) return res.status(409).json({ error: 'A backfill is already running.' });

  const run = async () => {
    _backfillRunning = true;
    try {
      const result = await bot.backfillPatrolLogs();
      const sum = Object.values(result).map(r => `${r.type}: +${r.imported}/${r.scanned}`).join(', ') || 'nothing (no channels configured)';
      audit.log(req.user, { category: 'DEV', action: 'PATROL_BACKFILL', summary: `Backfilled patrol/event logs · ${sum}` });
      console.log('[Backfill] complete:', JSON.stringify(result));
      return result;
    } finally { _backfillRunning = false; }
  };

  if (req.query.wait) {
    try { return res.json({ ok: true, result: await run() }); }
    catch (e) { return res.status(500).json({ error: 'Backfill failed: ' + e.message }); }
  }
  run().catch(e => console.error('[Backfill] failed:', e.message));
  res.json({ ok: true, started: true, message: 'Backfill started · logs will import in the background. Refresh the review queue to watch them appear.' });
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

  // ── Is that host even there? ─────────────────────────────────────
  //
  // Prisma says "can't reach database server" for every failure between here and
  // a query, which lumps together three things that mean completely different
  // things for a recovery:
  //
  //   * the name does not resolve            → the service is GONE
  //   * it resolves and the port is OPEN     → something IS listening, so the
  //                                            database is alive and the failure
  //                                            is above the network layer
  //   * it resolves and the port REFUSES     → nothing listening there any more
  //   * it resolves and the port TIMES OUT    → blocked, not absent. This is what
  //                                            Railway's own public proxy looks
  //                                            like from inside Railway, and it
  //                                            means the data may well be fine
  //
  // Done at the TCP layer with no credential, so it works regardless of the
  // password and cannot leak one. This is the test somebody would otherwise need
  // psql installed to run.
  const tcpProbe = (host, port) => new Promise((resolve) => {
    if (!host) return resolve(null);
    const dns = require('dns'), net = require('net');
    dns.lookup(host, (dnsErr, address) => {
      if (dnsErr) {
        return resolve({
          resolves: false, dnsError: dnsErr.code || dnsErr.message,
          meaning: dnsErr.code === 'ENOTFOUND'
            ? 'That hostname does not exist. The service has been deleted.'
            : 'The hostname could not be looked up.',
        });
      }
      const started = Date.now();
      const sock = new net.Socket();
      let settled = false;
      const done = (out) => {
        if (settled) return; settled = true;
        try { sock.destroy(); } catch (e) { /* already gone */ }
        resolve({ resolves: true, address, ms: Date.now() - started, ...out });
      };
      sock.setTimeout(6000);
      sock.once('connect', () => done({
        open: true,
        meaning: 'The port is OPEN, so a database is listening there. It is alive · '
               + 'whatever is failing is not reachability.',
      }));
      sock.once('timeout', () => done({
        open: false, why: 'timed out',
        meaning: 'The name resolves but the port never answers. That is BLOCKED, not absent · '
               + "which is what Railway's public proxy looks like from inside Railway. The "
               + 'database is probably fine and reachable from your own machine.',
      }));
      sock.once('error', (e) => done({
        open: false, why: e.code || e.message,
        meaning: e.code === 'ECONNREFUSED'
          ? 'The name resolves but nothing is listening on that port · the service is stopped, '
          + 'deleted, or the port has changed.'
          : 'The connection failed before the database was reached.',
      }));
      sock.connect(Number(port) || 5432, host);
    });
  });

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
  const iaTcp = await tcpProbe(ia.host, ia.port);
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
    ? 'IA_DATABASE_URL is not set, so the IA sync does nothing. It needs the connection string of the OLD database that still holds the cases · not this one.'
    : sameTarget
      ? 'IA_DATABASE_URL points at THE SAME DATABASE as the app itself, so the sync has nowhere to pull from and cannot recover anything. It has to point at a DIFFERENT database that still holds the cases. If there is no such database, use the Discord forum import instead.'
      // The TCP probe is what makes this specific, so it leads. "Gone" and
      // "blocked" are the same Prisma error and completely different outcomes.
      : !iaProbe.ok && iaTcp && iaTcp.resolves === false
        ? `${iaTcp.meaning} There is nothing to recover from it · use the Discord forum import instead.`
        : !iaProbe.ok && iaTcp && iaTcp.open === true
          ? 'A database IS listening on that host and port, so it is alive and the problem is not reachability · '
            + 'check the password and the database name in IA_DATABASE_URL. '
            + (couldBeSameService ? 'Note it may still be the same database the app already uses, by its other address. ' : '')
            + 'Press Sync again once the credentials are right.'
          : !iaProbe.ok && iaTcp && iaTcp.why === 'timed out'
            ? `${iaTcp.meaning} `
              + (couldBeSameService
                ? 'It may also be the SAME database the app already uses, reached by its public address instead of its private one · every Railway Postgres has both. Check DATABASE_PUBLIC_URL on the Postgres service: if it is this host and port, this is the same empty database and the sync can never recover anything. '
                : '')
              + 'If that database is in this Railway project, put its private *.railway.internal address in IA_DATABASE_URL instead and press Sync again.'
            : !iaProbe.ok && iaTcp && iaTcp.why === 'ECONNREFUSED'
              ? `${iaTcp.meaning} Use the Discord forum import instead.`
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
    // The TCP probe is the one that tells "gone" from "blocked", which Prisma's
    // error message cannot.
    iaTcp,
    mainProbe, iaProbe, mainCounts, iaCounts, verdict,
  });
});

// POST /api/dev/case-log-import — rebuild cases from Discord.
//
// The last resort that turns out not to be a resort at all: every case approved on
// the site posted an Administrative Log embed built FROM that case, and Discord
// keeps those forever, for free. When the database goes, the record does not.
//
// Body: { channelId, dry, maxPages }
//   dry:true  parses and reports what it found, writes nothing. Always do this
//             first — it costs one pass and it tells you whether the channel is the
//             right one before anything is created.
router.post('/case-log-import', async (req, res) => {
  const body = req.body || {};
  // The MET administrative-log channel, hardcoded: it is where the case logs
  // live and it is not moving, so it should not need setting up.
  const channelId = String(
    body.channelId || process.env.CASE_LOG_CHANNEL_ID || '1458943564456399091').trim();
  const dry = body.dry === true || body.dry === 'true' || req.query.dry === '1';
  if (!channelId) {
    return res.status(400).json({
      error: 'Give the channel id the Administrative Logs were posted to '
           + '(the channel your DISCORD_WEBHOOK_URL points at), as { "channelId": "..." }.',
    });
  }
  try {
    const { getClient } = require('../lib/bot');
    const client = getClient();
    if (!client) return res.status(503).json({ error: 'The Discord bot is not connected yet · try again shortly.' });

    const out = await require('../lib/caseLogImport')
      .importFromChannel(client, channelId, { dryRun: dry, maxPages: body.maxPages });

    if (!out.ok) return res.status(502).json(out);

    if (!dry) {
      audit.log(req.user, { category: 'SECURITY', action: 'CASE_LOG_IMPORT',
        summary: `Rebuilt cases from Discord channel ${channelId}: `
               + `${out.created} created, ${out.updated} filled in, from ${out.parsed} logs` });
    }
    res.json(out);
  } catch (err) {
    console.error('[Dev] case log import failed:', err.message);
    res.status(500).json({ error: 'The import failed: ' + err.message });
  }
});

// ── IA Database sync ──────────────────────────────────────────────
//
// One place to reconcile the sheet with what the site knows. Split into a plan
// and an apply so the destructive half is never the first thing that happens:
// a sync you cannot preview is one nobody runs on a Sunday night.

// GET /api/dev/ia-sync/plan — what WOULD be written. Reads only.
router.get('/ia-sync/plan', async (req, res) => {
  try {
    const { getClient } = require('../lib/bot');
    const plan = await require('../lib/iaSheetSync').planSync(getClient());
    res.json(plan);
  } catch (err) {
    console.error('[Dev] IA sync plan failed:', err.message);
    res.status(500).json({ error: 'Could not build the plan: ' + err.message });
  }
});

// POST /api/dev/ia-sync/apply — write the roster and this week's points.
router.post('/ia-sync/apply', async (req, res) => {
  try {
    const { getClient } = require('../lib/bot');
    const client = getClient();
    if (!client) return res.status(503).json({ error: 'The Discord bot is not connected yet · try again shortly.' });

    const body = req.body || {};
    const out = await require('../lib/iaSheetSync').applySync(client, {
      addMissing: body.addMissing !== false,
      borders:    body.borders    !== false,
    });
    if (out.ok) {
      audit.log(req.user, { category: 'SECURITY', action: 'IA_SHEET_SYNC',
        summary: `IA sheet sync: ${out.updated} rows updated, ${out.added.length} added` });
    }
    res.json(out);
  } catch (err) {
    console.error('[Dev] IA sync apply failed:', err.message);
    res.status(500).json({ error: 'The sync failed: ' + err.message });
  }
});

// POST /api/dev/ia-sync/tickets — pull the MET ticket-log channel again.
router.post('/ia-sync/tickets', async (req, res) => {
  try {
    const { getClient } = require('../lib/bot');
    const client = getClient();
    if (!client) return res.status(503).json({ error: 'The Discord bot is not connected yet.' });
    const ingest = require('../lib/ticketIngest');
    const fn = ingest.sweepTicketLogs || ingest.sweep || ingest.runSweep;
    if (typeof fn !== 'function') {
      return res.status(501).json({ error: 'No ticket sweep entry point is exported.' });
    }
    res.json(await fn(client, { full: req.body && req.body.full === true }));
  } catch (err) {
    console.error('[Dev] ticket sync failed:', err.message);
    res.status(500).json({ error: 'The ticket sync failed: ' + err.message });
  }
});

// GET /api/dev/ticket-diagnose — why did nothing appear in the tickets channel?
//
// Walks the whole path (read the source channel, store the row, post the card)
// and reports each step with the fix. Read-only: posts nothing, writes nothing.
router.get('/ticket-diagnose', async (req, res) => {
  try {
    const { getClient } = require('../lib/bot');
    res.json(await require('../lib/ticketDiagnose').diagnose(getClient()));
  } catch (err) {
    console.error('[Dev] ticket diagnose failed:', err.message);
    res.status(500).json({ error: 'The check failed: ' + err.message });
  }
});

// POST /api/dev/ticket-cards/since — card the tickets closed since a moment.
//
// The automatic path only cards what closed after the bot started watching, so a
// ticket closed in the gap around a restart is stored and never queued. This
// asks for those by name, with a window the caller chooses, rather than
// re-carding history.
router.post('/ticket-cards/since', async (req, res) => {
  try {
    const body = req.body || {};
    const { getClient } = require('../lib/bot');
    if (!getClient()) return res.status(503).json({ error: 'The Discord bot is not connected yet.' });

    // Default to the last two hours: long enough to cover a restart, short
    // enough that a mistyped request cannot flood the channel.
    const since = body.since ? new Date(body.since) : new Date(Date.now() - 2 * 3600 * 1000);
    const out = await require('../lib/ticketIngest')
      .cardTicketsSince(since, { limit: body.limit });
    if (!out.ok) return res.status(422).json({ error: out.reason });

    audit.log(req.user, { category: 'SECURITY', action: 'TICKET_CARDS_POSTED',
      summary: `Posted ${out.posted} review card(s) for tickets closed since ${out.since}` });
    res.json(out);
  } catch (err) {
    console.error('[Dev] ticket carding failed:', err.message);
    res.status(500).json({ error: 'Could not post the cards: ' + err.message });
  }
});

// ── Quota leaderboard screenshot ──────────────────────────────────
//
// The weekly leaderboard is rendered by a bot this codebase does not own, so
// there is no API behind it: the picture is the record. Read it once, show what
// was read, and write only what was approved.

// POST /api/dev/quota-shot/preview — read an image, write nothing.
// Body: { image: "<base64, with or without a data: prefix>", mediaType }
router.post('/quota-shot/preview', async (req, res) => {
  try {
    const body = req.body || {};
    let image = String(body.image || '');
    let mediaType = String(body.mediaType || 'image/png');
    // A data: URL from a paste or a file picker carries its own type. Trust the
    // one in the URL over anything the client claimed alongside it.
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(image);
    if (m) { mediaType = m[1]; image = m[2]; }
    if (!image) return res.status(400).json({ error: 'Send the screenshot as { image: "<base64>" }.' });
    if (!/^image\/(png|jpeg|jpg|webp|gif)$/i.test(mediaType)) {
      return res.status(400).json({ error: `Unsupported image type: ${mediaType}` });
    }

    const shot = require('../lib/quotaScreenshot');
    const read = await shot.readLeaderboard(image, mediaType.toLowerCase().replace('image/jpg', 'image/jpeg'));
    if (!read.ok) return res.status(422).json({ error: read.reason });

    const plan = shot.planFromRows(read.rows);
    res.json({ ...plan, trackingSince: read.trackingSince });
  } catch (err) {
    console.error('[Dev] quota screenshot preview failed:', err.message);
    res.status(500).json({ error: 'Could not read that screenshot: ' + err.message });
  }
});

// POST /api/dev/quota-shot/apply — write the plan that was previewed.
// Takes the PLAN, never the image, so what lands is what was approved.
router.post('/quota-shot/apply', async (req, res) => {
  try {
    const body = req.body || {};
    const plan = body.plan;
    if (!plan || !Array.isArray(plan.rows)) {
      return res.status(400).json({ error: 'Send the plan from the preview as { plan: ... }.' });
    }
    const shot = require('../lib/quotaScreenshot');
    const out = await shot.applyPlan({ ...plan, ok: true }, { borders: body.borders !== false });
    if (out.ok) {
      audit.log(req.user, { category: 'SECURITY', action: 'QUOTA_SCREENSHOT_IMPORT',
        summary: `Imported a quota leaderboard screenshot into the ${plan.dayKey} column: `
               + `${out.updated} row(s) updated` });
    }
    res.json(out);
  } catch (err) {
    console.error('[Dev] quota screenshot apply failed:', err.message);
    res.status(500).json({ error: 'The import failed: ' + err.message });
  }
});

// GET /api/dev/case-audit — is the case archive coherent?
//
// Read-only, and meant to be run either side of an import. Duplicate references, rows
// with no reference, a counter sitting below the highest reference in use (which
// means the next case filed collides), and references whose numbering disagrees with
// the order things actually happened.
router.get('/case-audit', async (req, res) => {
  try { res.json(await require('../lib/caseLogImport').auditRefs()); }
  catch (err) {
    console.error('[Dev] case audit failed:', err.message);
    res.status(500).json({ error: 'Could not check the archive: ' + err.message });
  }
});

// GET /api/dev/ia-export — download everything in the IA database as one file.
//
// This exists for one situation, and it is not a hypothetical: the old database is
// alive but its hosting is about to be reclaimed, and the person who needs the data
// out of it has no Postgres tools installed and is on Windows. Telling them to go
// and install pg_dump — matching the server's major version, from the right
// installer, deselecting the server component — is several ways to fail at a task
// with a deadline on it.
//
// So the app does it. It is already the thing that can reach both databases, and it
// already has the credentials. Streamed as newline-delimited JSON rather than built
// in memory, because a big archive should not have to fit in the heap twice, and
// because a download that has started is a download that survives the source going
// away mid-transfer.
//
// This is NOT a substitute for the sync. It is the copy you keep in case the sync
// turns out to have needed a second attempt after the source is gone.
router.get('/ia-export', async (req, res) => {
  const ia = require('../lib/dbIa').getIaClient();
  if (!ia) return res.status(400).json({ error: 'IA_DATABASE_URL is not set, so there is nothing to export.' });

  // Named for the day, so two downloads never overwrite each other in a
  // downloads folder.
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="ia-database-${stamp}.ndjson"`);
  // No length is known up front, and the whole point is to start writing
  // immediately rather than buffer.
  res.setHeader('Cache-Control', 'no-store');

  const write = (obj) => res.write(JSON.stringify(obj) + '\n');
  const counts = {};

  // Everything worth having, biggest first — so if the source dies part-way, what
  // arrived is the part that matters most.
  // Every ORDER BY ends in `ctid`, and that is not decoration.
  //
  // Paging with LIMIT/OFFSET is only correct over a TOTAL order. Order by
  // "createdAt" alone and every row sharing a timestamp — which is what a bulk
  // import produces, thousands of them — is in an arbitrary position that Postgres
  // may resolve differently for each page. Rows then get skipped and duplicated,
  // and the row count can still come out right, so it looks like it worked. On an
  // export whose whole purpose is that nothing is lost, that is the worst failure
  // available.
  //
  // ctid is Postgres's physical row identifier: always present, always unique
  // within a table, no schema knowledge required. Appending it makes the order
  // total, so the paging is exact. (It moves if a row is UPDATEd mid-export, which
  // is a non-issue for the idle archive this is for, and still far better than an
  // arbitrary order.)
  const TABLES = [
    ['cases', 'SELECT * FROM cases ORDER BY "createdAt" ASC, ctid'],
    ['case_actions', 'SELECT * FROM case_actions ORDER BY ctid'],
    ['case_punishments', 'SELECT * FROM case_punishments ORDER BY ctid'],
    ['ticket_logs', 'SELECT * FROM ticket_logs ORDER BY "closedAt" ASC, ctid'],
    ['users', 'SELECT * FROM users ORDER BY ctid'],
  ];

  write({ _meta: { exportedAt: new Date().toISOString(), by: req.user.discordUsername || req.user.id,
                   note: 'One JSON object per line. The first line is this header; the rest are '
                       + '{ table, row } records.' } });

  for (const [table, sql] of TABLES) {
    try {
      // Paged, so one enormous result set never has to exist all at once on either
      // side of the connection.
      let offset = 0, n = 0;
      for (;;) {
        const page = await ia.$queryRawUnsafe(`${sql} LIMIT 500 OFFSET ${offset}`);
        if (!page || !page.length) break;
        for (const row of page) {
          // BigInt and Date are not JSON, and a serialiser that throws half way
          // through a download is worse than one that stringifies.
          write({ table, row: JSON.parse(JSON.stringify(row, (k, v) =>
            typeof v === 'bigint' ? String(v) : v)) });
          n++;
        }
        if (page.length < 500) break;
        offset += 500;
        if (offset > 500000) break;   // a runaway guard, not a real limit
      }
      counts[table] = n;
      write({ _done: table, rows: n });
    } catch (e) {
      // A table that does not exist in the old schema is normal, not fatal — the
      // export should bring back everything it CAN.
      counts[table] = 'error: ' + e.message.slice(0, 140);
      write({ _error: table, why: e.message.slice(0, 300) });
    }
  }

  write({ _summary: counts });
  audit.log(req.user, { category: 'SECURITY', action: 'IA_EXPORT',
    summary: 'Downloaded the IA database: ' + JSON.stringify(counts) });
  console.log('[Dev] IA export finished:', JSON.stringify(counts));
  res.end();
});

// POST /api/dev/ia-sync — pull cases + tickets from the live IA database
// (IA_DATABASE_URL) into the MET database. Idempotent; safe to run repeatedly.
router.post('/ia-sync', async (req, res) => {
  try {
    const result = await require('../lib/iaSync').syncAll();
    if (!result.ok) return res.status(400).json({ error: result.reason || 'IA sync not configured' });
    audit.log(req.user, { category: 'DEV', action: 'IA_SYNC',
      summary: `Synced IA data · cases ${result.cases && result.cases.synced}/${result.cases && result.cases.total}, tickets ${result.tickets && result.tickets.synced}/${result.tickets && result.tickets.total}` });
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

// GET /api/dev/game-logs — the same all-time log the MET High Command feed
// reads, exposed here so developers can read it from the dev panel too. One
// implementation, in lib/gameLog: this used to be a second copy of the query,
// with its own 150-row cap and no way past it.
router.get('/game-logs', async (req, res) => {
  try {
    res.json(await require('../lib/gameLog').page(req.query));
  } catch (e) {
    console.error('[Dev] game-logs failed:', e.message);
    res.status(500).json({ error: 'Failed to load game logs' });
  }
});

router.get('/game-logs.csv', async (req, res) => {
  try {
    const GL = require('../lib/gameLog');
    res.type('text/csv').set('Content-Disposition', `attachment; filename="${GL.csvFilename()}"`);
    await GL.writeCsv(res, req.query);
    res.end();
  } catch (e) {
    console.error('[Dev] game-logs.csv failed:', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to export game logs' });
    else res.end();
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
      // The bold line at the top of the alert. Optional: the client falls back
      // to a generic headline when it is not set.
      title: String(body.title || '').trim().slice(0, 90),
      // The label in the red band. Anything else falls back to the top level.
      level: ['emergency', 'severe', 'test'].includes(body.level) ? body.level : 'emergency',
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
  if (!bot.isReady()) return res.status(503).json({ error: 'Bot not connected yet · try again shortly.' });
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
  if (!bot.isReady()) return res.status(503).json({ error: 'Bot not connected yet · try again shortly.' });
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
  if (!bot.isReady()) return res.status(503).json({ error: 'Bot not connected yet · try again shortly.' });
  try {
    const out = await bot.registerCommands();
    res.json({ ...out, now: await bot.listRegisteredCommands() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/dev/case-renumber  { dry, mode }  — one consistent numbering
//
// The archive grew four numbering schemes at once: refs up to #674 from years of
// logs, #1-#6 from a counter that had been reset, #8665474 upwards from a counter
// a random code had poisoned, and hundreds of rows whose reference is a code like
// #MH186KUCS3 with no number in it at all.
//
//   mode 'repair' (default) — only the refs that are not part of the sequence are
//     renumbered, continuing from the top. Nothing anybody has quoted changes.
//   mode 'resequence' — every case is renumbered in date order from the floor, so
//     the refs climb with time and there is one scheme. Refs people have quoted do
//     change; the old one is kept on the row either way.
// A dry run answers in one request (it writes nothing). A real renumber does
// NOT: it rewrites two rows per moved case and then re-edits every moved case's
// Discord log at 350ms a time, which for hundreds of cases runs for minutes,
// well past the edge proxy's timeout. Run for real in the BACKGROUND and let the
// browser poll GET, the same way the XP and patrol imports do, so the work
// finishes server-side even when the request that kicked it off is long gone.
let _renumberRun = null;   // { running, mode, startedAt, finishedAt, result, error }

router.get('/case-renumber', (req, res) => {
  res.json(_renumberRun || { running: false, result: null });
});

router.post('/case-renumber', async (req, res) => {
  const body = req.body || {};
  const dry = body.dry === true || body.dry === 'true' || req.query.dry === '1';
  const mode = String(body.mode || req.query.mode || 'repair') === 'resequence' ? 'resequence' : 'repair';

  // Dry run: fast and synchronous, exactly as before.
  if (dry) {
    try {
      const out = await require('../lib/caseLogImport').renumberRefs({ dryRun: true, mode });
      return out.ok ? res.json(out) : res.status(400).json(out);
    } catch (e) {
      console.error('[Dev] case renumber (dry) failed:', e.message);
      return res.status(400).json({ error: 'Could not preview the renumber: ' + e.message });
    }
  }

  // Real run: background it and report via GET.
  if (_renumberRun && _renumberRun.running) return res.status(409).json({ error: 'A renumber is already running.', running: true });
  _renumberRun = { running: true, mode, startedAt: Date.now(), finishedAt: null, result: null, error: null };
  const actor = req.user;
  (async () => {
    try {
      const out = await require('../lib/caseLogImport').renumberRefs({ dryRun: false, mode });
      _renumberRun.result = out;
      if (!out.ok) _renumberRun.error = (out.errors && out.errors[0]) || 'The renumber reported a failure.';
      else if (out.moved) {
        audit.log(actor, { category: 'SECURITY', action: 'CASE_RENUMBER',
          summary: `Renumbered ${out.moved} case reference(s) (${mode}; ${out.unchanged} left as they were)` });
      }
    } catch (e) {
      console.error('[Dev] case renumber failed:', e.message);
      _renumberRun.error = e.message;
    } finally {
      _renumberRun.running = false;
      _renumberRun.finishedAt = Date.now();
    }
  })();

  res.status(202).json({ started: true, running: true, mode });
});

// ── Clans Labs XP import ──────────────────────────────────────────
//
//   GET  /api/dev/xp-import              the file, the holding table, and the
//                                        state of any run — poll this
//   POST /api/dev/xp-import  { dry }     start one (dry: true to rehearse)
//   POST /api/dev/xp-claim-sweep         try the still-waiting rows again
//
// It runs in the BACKGROUND and the browser polls, because it cannot be done
// inside one request: a thousand usernames is twelve paced Roblox calls with
// backoff — measured at three and a half minutes against the live API — plus a
// RoVer lookup for everyone we cannot match ourselves. Most edge proxies close an
// idle request long before that, and the run would then finish invisibly with its
// counts going nowhere.
//
// Rehearse with dry first: it does every lookup and reports exactly the same
// numbers, writing nothing.
let _xpRun = null;   // { running, dry, startedAt, finishedAt, stage, done, total, out, error }

router.get('/xp-import', async (req, res) => {
  try {
    const lib = require('../lib/clanslabsXp');
    const parsed = lib.parse(lib.readFile());
    res.json({
      file: lib.DATA_FILE(),
      rows: parsed.lines, accounts: parsed.rows.length,
      ignoredLines: parsed.skipped.length,
      cap: require('../lib/xp').maxXp(),
      highest: parsed.rows.slice(0, 10),
      pending: await lib.pendingSummary(20),
      run: _xpRun,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/xp-import', async (req, res) => {
  if (_xpRun && _xpRun.running) {
    return res.status(409).json({ error: 'An XP import is already running.', run: _xpRun });
  }
  const body = req.body || {};
  const dry = body.dry === true || body.dry === 'true' || req.query.dry === '1';
  const actor = req.user;

  _xpRun = { running: true, dry, startedAt: new Date().toISOString(), finishedAt: null,
             stage: 'Starting', done: 0, total: 0, out: null, error: null };

  const run = async () => {
    try {
      const out = await require('../lib/clanslabsXp').importLeaderboard({
        dryRun: dry,
        rover: body.rover !== false && body.rover !== 'false',
        limit: body.limit ? parseInt(body.limit, 10) : undefined,
        text: typeof body.text === 'string' && body.text.trim() ? body.text : undefined,
        onProgress: (p) => {
          if (!_xpRun) return;
          _xpRun.stage = p.stage;
          if (p.done != null) _xpRun.done = p.done;
          if (p.total != null) _xpRun.total = p.total;
        },
      });
      _xpRun.out = out;
      if (!dry) {
        audit.log(actor, { category: 'SECURITY', action: 'XP_IMPORT',
          summary: `Imported Clans Labs XP: ${out.set} set, ${out.pending} held for later, `
                 + `${out.unknown} unresolvable, capped at ${out.cap}` });
      }
    } catch (e) {
      console.error('[Dev] XP import failed:', e.message);
      _xpRun.error = 'The XP import failed: ' + e.message;
    } finally {
      _xpRun.running = false;
      _xpRun.finishedAt = new Date().toISOString();
      _xpRun.stage = _xpRun.error ? 'Failed' : 'Done';
    }
  };
  run();

  // 202: accepted and started, not finished. Poll GET /xp-import for the counts.
  res.status(202).json({ started: true, dry, run: _xpRun });
});

router.post('/xp-claim-sweep', async (req, res) => {
  const body = req.body || {};
  try {
    const out = await require('../lib/clanslabsXp').sweepPending({
      limit: body.limit ? parseInt(body.limit, 10) : undefined,
      rover: body.rover !== false && body.rover !== 'false',
      dryRun: body.dry === true || body.dry === 'true',
    });
    res.json({ ...out, pending: await require('../lib/clanslabsXp').pendingSummary(20) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Leave already in progress ─────────────────────────────────────
//
//   GET  /api/dev/loa-import          read the list, resolve who is who, write nothing
//   POST /api/dev/loa-import  { dry } import it
//
// Nine people are on leave right now with none of it in the database, so
// `/loa active` shows nothing and — the part that matters — nothing will ever take
// the on-leave role back off them. This brings the records in, backdated and
// already approved, and the sweep does the rest.
router.get('/loa-import', async (req, res) => {
  try {
    const LI = require('../lib/loaImport');
    const read = LI.readFile();
    if (!read.ok) return res.status(400).json({ error: read.error, file: read.file });
    const parsed = LI.parse(read.text);
    res.json({
      file: read.file,
      entries: parsed.entries.map(x => ({ ...x, reason: x.reason.slice(0, 200) })),
      problems: parsed.problems,
      roleConfigured: !!require('../lib/loa').LEAVE_ROLE(),
    });
  } catch (e) {
    res.status(400).json({ error: 'Could not read the leave list: ' + e.message });
  }
});

router.post('/loa-import', async (req, res) => {
  const body = req.body || {};
  const dry = body.dry === true || body.dry === 'true' || req.query.dry === '1';
  try {
    // Resolving a Discord username needs the guild, so the bot has to be up. Said
    // plainly rather than reported as "nobody could be resolved", which would look
    // like the names were wrong.
    let guild = null;
    const client = require('../lib/bot').getClient();
    const gid = process.env.DISCORD_GUILD_ID;
    if (client && gid) guild = await client.guilds.fetch(gid).catch(() => null);
    if (!guild) {
      return res.status(400).json({
        error: 'The bot is not connected to the Discord server, so the usernames in the '
             + 'list cannot be matched to members. Nothing was imported.',
      });
    }

    const out = await require('../lib/loaImport').importLoas({ dryRun: dry, guild });
    if (!out.ok) return res.status(400).json(out);
    if (!dry && out.imported.length) {
      audit.log(req.user, { category: 'SECURITY', action: 'LOA_IMPORT',
        summary: `Imported ${out.imported.length} existing leave record(s)`
               + (out.unresolved.length ? `; ${out.unresolved.length} could not be matched to a member` : '') });
    }
    res.json({ ...out, roleConfigured: !!require('../lib/loa').LEAVE_ROLE() });
  } catch (e) {
    console.error('[Dev] LOA import failed:', e.message);
    res.status(400).json({ error: 'Could not import the leave: ' + e.message });
  }
});

// ── MET group audit log ───────────────────────────────────────────
//
//   GET  /api/dev/group-audit         is it working, and what has it logged
//   POST /api/dev/group-audit/sweep   read Roblox now and post anything new
//
// Every failure mode of this thing looks the same from the channel — nothing
// arrives — so the GET says which of them it is: the cookie missing, the "View
// audit log" permission missing, the channel unset, or simply nothing having
// happened in the group yet.
router.get('/group-audit', async (req, res) => {
  try {
    const GA = require('../lib/groupAuditLog');
    const groupId = GA.GROUP_ID();
    const prisma  = require('../lib/db');

    const [total, unposted, recent] = await Promise.all([
      prisma.groupAuditEntry.count({ where: { groupId } }),
      prisma.groupAuditEntry.count({ where: { groupId, postedAt: null } }),
      prisma.groupAuditEntry.findMany({
        where: { groupId }, orderBy: { occurredAt: 'desc' }, take: 15,
        select: { actionType: true, actorName: true, targetName: true, occurredAt: true,
                  postedAt: true, messageId: true, matchedAuditId: true },
      }),
    ]);

    // Ask Roblox whether we can actually read it, rather than guessing from
    // whether anything has arrived.
    let reachable = null, readError = null;
    if (require('../lib/roblox').cookieForDivision('MET')) {
      try {
        const page = await require('../lib/roblox').getGroupAuditLog(groupId, null, { limit: 10 });
        reachable = true;
        if (!total && !(page.entries || []).length) readError = 'the group audit log is empty';
      } catch (e) { reachable = false; readError = e.message; }
    } else {
      readError = 'ROBLOX_COOKIE is not set, so the group audit log cannot be read at all';
    }

    res.json({
      enabled: GA.ENABLED(), groupId, channelId: GA.CHANNEL_ID(),
      cookieConfigured: !!require('../lib/roblox').cookieForDivision('MET'),
      reachable, readError,
      startedAt: await GA.watermark(groupId),
      total, unposted, recent,
    });
  } catch (e) {
    res.status(400).json({ error: 'Could not read the group audit state: ' + e.message });
  }
});

router.post('/group-audit/sweep', async (req, res) => {
  try {
    const out = await require('../lib/groupAuditLog').sweep(require('../lib/bot').getClient());
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: 'The sweep failed: ' + e.message });
  }
});

module.exports = router;
