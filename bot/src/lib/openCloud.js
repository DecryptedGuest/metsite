// Roblox Open Cloud — the bridge from Discord to in-game code.
//
// The bot has no web server (by design), so instead of the game calling us, we
// push into a DataStore the game already reads. That inverts the dependency:
// the game needs no network permissions and no uptime from the bot, it just
// reads a key.
const { env } = require('./env');

const BASE = 'https://apis.roblox.com/datastores/v1/universes';

function config() {
  return {
    universeId: env('ROBLOX_UNIVERSE_ID'),
    apiKey:     env('ROBLOX_OPENCLOUD_KEY'),
    datastore:  env('ROBLOX_DATASTORE_NAME', 'MET_Sync'),
    scope:      env('ROBLOX_DATASTORE_SCOPE', 'global'),
  };
}

function isConfigured() {
  const c = config();
  return !!(c.universeId && c.apiKey);
}

/**
 * Write one entry. Open Cloud wants the value as a JSON string and requires a
 * content-md5 header on writes.
 */
async function setEntry(key, value) {
  const c = config();
  if (!isConfigured()) {
    return { ok: false, error: 'Open Cloud is not configured (ROBLOX_UNIVERSE_ID / ROBLOX_OPENCLOUD_KEY).' };
  }

  const body = JSON.stringify(value);
  const md5  = require('crypto').createHash('md5').update(body).digest('base64');
  const url  = `${BASE}/${c.universeId}/standard-datastores/datastore/entries/entry`
             + `?datastoreName=${encodeURIComponent(c.datastore)}`
             + `&scope=${encodeURIComponent(c.scope)}`
             + `&entryKey=${encodeURIComponent(key)}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'x-api-key': c.apiKey,
        'Content-Type': 'application/json',
        'content-md5': md5,
      },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `Open Cloud ${res.status}: ${text.slice(0, 200)}` };
    }
    return { ok: true, key, datastore: c.datastore, scope: c.scope };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function getEntry(key) {
  const c = config();
  if (!isConfigured()) return { ok: false, error: 'Open Cloud is not configured.' };
  const url = `${BASE}/${c.universeId}/standard-datastores/datastore/entries/entry`
            + `?datastoreName=${encodeURIComponent(c.datastore)}`
            + `&scope=${encodeURIComponent(c.scope)}`
            + `&entryKey=${encodeURIComponent(key)}`;
  try {
    const res = await fetch(url, { headers: { 'x-api-key': c.apiKey } });
    if (res.status === 404) return { ok: true, value: null };
    if (!res.ok) return { ok: false, error: `Open Cloud ${res.status}` };
    return { ok: true, value: await res.json() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { setEntry, getEntry, isConfigured, config };
