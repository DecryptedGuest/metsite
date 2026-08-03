#!/usr/bin/env node
// scripts/start.js — bring the app up, whether or not the database is reachable.
//
// This used to be `npx prisma db push && node server/index.js`, and that `&&` was
// a single point of failure for the entire site: when Postgres was unreachable the
// schema sync failed, so the server was never started, so the container
// crash-looped. A database outage therefore became a total outage — no site, no
// health check, and no way to reach the env-var kill switches that turn the
// background workers off, which is exactly when you most want them.
//
// So the sync is attempted, given a bounded amount of time, and its failure is
// reported rather than fatal. The server then starts regardless. A site that is up
// and honest about the database being down beats a site that is not up at all:
// pages still render, the health check still answers, and configuration can still
// be changed.
//
// SCHEMA_SYNC=off        skip the sync entirely (it has already been applied)
// SCHEMA_SYNC_TIMEOUT_MS how long to wait for it (default 90s)
// SCHEMA_SYNC_REQUIRED=1 go back to the old behaviour and refuse to start without
//                        it, for anyone who would rather fail loudly

const { spawn } = require('child_process');
const path = require('path');

const TIMEOUT = Number(process.env.SCHEMA_SYNC_TIMEOUT_MS || 90000);
const SKIP     = String(process.env.SCHEMA_SYNC || '').toLowerCase() === 'off';
const REQUIRED = String(process.env.SCHEMA_SYNC_REQUIRED || '') === '1';

function syncSchema() {
  return new Promise((resolve) => {
    const child = spawn('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
      env: process.env,
    });

    // A database that accepts the connection but never answers would otherwise
    // hold the boot open until the platform's own deploy timeout kills it.
    const killer = setTimeout(() => {
      console.error(`[Start] the schema sync has taken longer than ${TIMEOUT}ms — giving up on it and starting anyway.`);
      try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
      resolve(false);
    }, TIMEOUT);

    child.on('error', (e) => { clearTimeout(killer); console.error('[Start] could not run the schema sync:', e.message); resolve(false); });
    child.on('exit', (code) => { clearTimeout(killer); resolve(code === 0); });
  });
}

(async () => {
  if (SKIP) {
    console.log('[Start] skipping the schema sync (SCHEMA_SYNC=off).');
  } else {
    const ok = await syncSchema();
    if (ok) {
      console.log('[Start] schema is in sync.');
    } else if (REQUIRED) {
      console.error('[Start] the schema sync failed and SCHEMA_SYNC_REQUIRED=1, so not starting.');
      process.exit(1);
    } else {
      console.error('[Start] THE SCHEMA SYNC FAILED — starting the server anyway so the site is up.');
      console.error('[Start] Database-backed pages will error until the database is reachable. If the');
      console.error('[Start] schema also needs changes, run `npx prisma db push` once it is back.');
    }
  }

  // Not spawned as a child: the server should own the process, so signals, exit
  // codes and the platform's health checks all behave as if it were started
  // directly.
  //
  // It only binds a port for a real long-lived process, and it decides that from
  // `require.main` — which is THIS file, not that one. So say so explicitly, or it
  // loads every route and then listens on nothing.
  process.env.MET_LISTEN = '1';
  require(path.join(__dirname, '../server/index.js'));
})();
