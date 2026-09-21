// server/lib/dbIa.js
// Read-only Prisma client bound to the STILL-RUNNING old IA site's database
// (IA_DATABASE_URL). Used only to PULL cases + tickets into the MET database
// (see lib/iaSync.js) — the MET app's own data always lives on DATABASE_URL.
// Returns null when IA_DATABASE_URL isn't configured, so everything no-ops
// until you set it. We read via $queryRaw (not model queries) so an older IA
// schema with extra/renamed columns can't break us.
const { PrismaClient } = require('@prisma/client');

let _client = null;
let _tried = false;

function getIaClient() {
  if (_tried) return _client;
  _tried = true;
  const url = process.env.IA_DATABASE_URL;
  if (!url) { _client = null; return null; }
  try {
    _client = new PrismaClient({ datasources: { db: { url } }, log: ['error'] });
  } catch (e) {
    console.error('[IA] failed to init IA database client:', e.message);
    _client = null;
  }
  return _client;
}

module.exports = { getIaClient };
