// server/lib/emoji.js
// The MET custom emoji, everywhere.
//
// Every emoji the bot, its embeds and the webhooks use is a MET emoji rather
// than a stock unicode one. This module owns three things:
//
//   * SYNC   — on bot ready, every emoji in scripts/emoji/manifest.js that is
//              missing is uploaded from its committed PNG. Ones already there
//              are adopted by name, so a re-sync is free.
//
//              They are uploaded as APPLICATION emoji, not guild emoji. An
//              application emoji belongs to the bot rather than to a server, so
//              it renders in DMs, in servers the bot was never given emoji
//              permissions in, and in every embed the bot sends anywhere —
//              which a guild emoji does not. There are 2000 slots instead of
//              50, and no "Manage Expressions" permission to chase.
//
//              A guild is still used as a fallback for the case where the
//              application route is refused.
//   * RESOLVE— e('met_tick') → "<:met_tick:123…>" for use in message content
//              and embeds.
//   * FALL BACK — if the upload never happened (no Manage Expressions
//              permission, guild emoji slots full, bot offline, someone deleted
//              one), e() returns the unicode character that emoji replaced.
//              Nothing ever renders as a broken tag; the worst case is that a
//              message looks the way it did before this existed.
//
// Site-only emoji (the seasonal effects) are marked `discord: false` in the
// manifest and never uploaded — a non-boosted guild only has 50 slots and they
// are better spent on the ones Discord actually shows.

const fs   = require('fs');
const path = require('path');
const { EMOJI } = require('../../scripts/emoji/manifest');

const PNG_DIR = path.join(__dirname, '../../client/public/img/emoji');

// name → { id, animated } once resolved from the guild.
const resolved = new Map();
let lastSync = null;

const byName = new Map(EMOJI.map(d => [d.name, d]));

function guildId() {
  return process.env.EMOJI_GUILD_ID || process.env.MET_GUILD_ID || process.env.DISCORD_GUILD_ID || null;
}

// ── Other people's emoji ──────────────────────────────────────────
// The MET server already has rank emoji (:CON:, :SGT:, :INS:, :CINS: …) that
// long predate this file. Rank displays should use those rather than anything
// we drew — they are the marks the server already recognises.
//
// Resolved from the bot's guild caches by name, case-insensitively, and cached
// so a lookup is free after the first.
//
// Keyed by CLIENT, not module-global. A single shared index would answer for
// whichever client happened to build it first — harmless in production, where
// there is one, but it means a lookup with no client returns somebody else's
// answer instead of nothing, which is the wrong shape for something whose whole
// contract is "returns '' if it isn't there".
const foreignByClient = new WeakMap();   // client → { at, map }
const FOREIGN_TTL = 10 * 60 * 1000;      // adding an emoji shouldn't need a restart

function foreignIndex(client) {
  if (!client || !client.guilds || !client.guilds.cache) return null;
  const hit = foreignByClient.get(client);
  if (hit && Date.now() - hit.at < FOREIGN_TTL) return hit.map;

  const map = new Map();
  for (const guild of client.guilds.cache.values()) {
    const cache = guild && guild.emojis && guild.emojis.cache;
    if (!cache) continue;
    for (const em of cache.values()) {
      if (!em || !em.name) continue;
      const key = em.name.toLowerCase();
      // First guild wins, so a duplicate name elsewhere can't shadow the one
      // in the server people actually look at.
      if (!map.has(key)) map.set(key, { id: em.id, name: em.name, animated: !!em.animated });
    }
  }
  foreignByClient.set(client, { at: Date.now(), map });
  return map;
}

/**
 * An emoji that already exists in one of the bot's servers, by name.
 * @returns {string} "<:CON:123…>", or '' when there is no such emoji
 */
function byGuildName(client, name) {
  if (!name) return '';
  const idx = foreignIndex(client);
  if (!idx) return '';
  const hit = idx.get(String(name).toLowerCase());
  // Its real casing, not what was asked for.
  return hit ? `<${hit.animated ? 'a' : ''}:${hit.name}:${hit.id}>` : '';
}

/** The first of `names` that exists, or ''. */
function firstGuildEmoji(client, names) {
  for (const n of (names || [])) {
    const hit = byGuildName(client, n);
    if (hit) return hit;
  }
  return '';
}

// ── Resolution ────────────────────────────────────────────────────
// The string to drop into message content or an embed. Falls back to the
// unicode character the emoji replaces, so callers never have to check.
function e(name) {
  const hit = resolved.get(name);
  if (hit) return `<${hit.animated ? 'a' : ''}:${name}:${hit.id}>`;
  const def = byName.get(name);
  return def ? def.fallback : '';
}

// The form Discord's reaction API wants: "name:id" for a custom emoji, or the
// raw unicode character.
function reactionFor(name) {
  const hit = resolved.get(name);
  if (hit) return `${name}:${hit.id}`;
  const def = byName.get(name);
  return def ? def.fallback : null;
}

// Absolute URL of the emoji's PNG, for embed thumbnails and the site.
function urlFor(name, base) {
  if (!byName.has(name)) return null;
  const rel = `/img/emoji/${name}.png`;
  return base ? String(base).replace(/\/+$/, '') + rel : rel;
}

function isSynced(name) { return resolved.has(name); }
function status() {
  const wanted = EMOJI.filter(d => d.discord !== false);
  return {
    guildId: guildId(),
    store: lastSync ? lastSync.where : null,
    total: wanted.length,
    synced: wanted.filter(d => resolved.has(d.name)).length,
    missing: wanted.filter(d => !resolved.has(d.name)).map(d => d.name),
    lastSync,
  };
}

// ── Sync ──────────────────────────────────────────────────────────
// Adopt what's already uploaded, upload what isn't. Never throws: a failure
// here must not stop the bot coming up, it just means e() keeps returning
// unicode.
//
// Application emoji first — those are the ones that work in DMs. If the
// application route is refused for any reason, fall back to uploading into a
// guild, which is where these used to live.
async function syncEmoji(client, opts = {}) {
  const out = { ok: false, where: null, adopted: 0, created: 0, failed: 0, skipped: 0, errors: [] };
  if (!client) { out.errors.push('bot not ready'); return out; }

  let store = null;
  if (client.application && client.application.emojis && process.env.EMOJI_STORE !== 'guild') {
    try {
      await client.application.emojis.fetch();
      store = { kind: 'application', manager: client.application.emojis, label: 'the bot application' };
    } catch (err) {
      out.errors.push(`application emoji unavailable (${err.message}) — falling back to a guild`);
    }
  }

  if (!store) {
    const gid = opts.guildId || guildId();
    if (!gid) {
      out.errors.push('no application emoji and no guild configured (set EMOJI_GUILD_ID)');
      return out;
    }
    try {
      const guild = await client.guilds.fetch(gid);
      await guild.emojis.fetch();
      store = { kind: 'guild', manager: guild.emojis, label: `"${guild.name}"` };
    } catch (err) {
      out.errors.push(`cannot read guild ${gid}: ${err.message}`);
      return out;
    }
  }
  out.where = store.kind;

  const existing = new Map();
  for (const [, em] of store.manager.cache) if (em.name) existing.set(em.name, em);

  for (const def of EMOJI) {
    if (def.discord === false) { out.skipped++; continue; }

    const already = existing.get(def.name);
    if (already && !opts.force) {
      resolved.set(def.name, { id: already.id, animated: !!already.animated });
      out.adopted++;
      continue;
    }

    const file = path.join(PNG_DIR, def.name + '.png');
    if (!fs.existsSync(file)) {
      out.failed++;
      out.errors.push(`${def.name}: ${path.relative(process.cwd(), file)} is missing — run "node scripts/build-emoji.js"`);
      continue;
    }

    // `force` re-uploads: delete the old one first, or the create 400s on a
    // duplicate name.
    if (already && opts.force) {
      try { await store.manager.delete(already); } catch (err) { /* the create will tell us */ }
    }

    try {
      const created = await store.manager.create({
        attachment: fs.readFileSync(file),
        name: def.name,
        ...(store.kind === 'guild' ? { reason: 'MET emoji sync' } : {}),
      });
      resolved.set(def.name, { id: created.id, animated: !!created.animated });
      out.created++;
    } catch (err) {
      out.failed++;
      // The three that actually happen, named plainly so the log is useful.
      const msg = /Missing Permissions/i.test(err.message)
        ? 'the bot needs the "Manage Expressions" permission in this guild'
        : /Maximum number of emojis/i.test(err.message)
          ? 'no emoji slots left'
          : err.message;
      out.errors.push(`${def.name}: ${msg}`);
      // A permission or slot problem hits every remaining emoji the same way —
      // stop rather than spraying the log and burning rate limit.
      if (/Manage Expressions|slots left/.test(msg)) break;
    }
  }

  out.ok = out.failed === 0;
  lastSync = { at: new Date().toISOString(), ...out };
  const total = out.adopted + out.created;
  console.log(`[Emoji] ${total}/${EMOJI.filter(d => d.discord !== false).length} available on ${store.label} `
    + `(${out.created} uploaded, ${out.adopted} already there)`
    + (out.failed ? ` — ${out.failed} failed: ${out.errors[0]}` : ''));
  return out;
}

// The old name, kept because the dev route and older callers use it.
const syncGuildEmoji = syncEmoji;

function startEmojiSync(client) {
  setTimeout(() => { syncEmoji(client).catch(() => {}); }, 12 * 1000);
  setInterval(() => { syncEmoji(client).catch(() => {}); }, 60 * 60 * 1000);
}

module.exports = {
  e, reactionFor, urlFor, isSynced, status,
  byGuildName, firstGuildEmoji,
  syncEmoji, syncGuildEmoji, startEmojiSync,
  EMOJI, PNG_DIR,
};
