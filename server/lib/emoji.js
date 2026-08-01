// server/lib/emoji.js
// The MET custom emoji, everywhere.
//
// Every emoji the bot, its embeds and the webhooks use is a MET emoji rather
// than a stock unicode one. This module owns three things:
//
//   * SYNC   — on bot ready, every emoji in scripts/emoji/manifest.js that is
//              missing from the guild is uploaded from its committed PNG. Ones
//              already there are adopted by name, so a re-sync is free.
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
    total: wanted.length,
    synced: wanted.filter(d => resolved.has(d.name)).length,
    missing: wanted.filter(d => !resolved.has(d.name)).map(d => d.name),
    lastSync,
  };
}

// ── Sync ──────────────────────────────────────────────────────────
// Adopt what's already in the guild, upload what isn't. Never throws: a failure
// here must not stop the bot coming up, it just means e() keeps returning
// unicode.
async function syncGuildEmoji(client, opts = {}) {
  const out = { ok: false, adopted: 0, created: 0, failed: 0, skipped: 0, errors: [] };
  if (!client) { out.errors.push('bot not ready'); return out; }

  const gid = opts.guildId || guildId();
  if (!gid) { out.errors.push('no guild configured (set EMOJI_GUILD_ID)'); return out; }

  let guild;
  try {
    guild = await client.guilds.fetch(gid);
    await guild.emojis.fetch();          // populate the cache before we compare
  } catch (err) {
    out.errors.push(`cannot read guild ${gid}: ${err.message}`);
    return out;
  }

  const existing = new Map();
  for (const [, em] of guild.emojis.cache) if (em.name) existing.set(em.name, em);

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
      try { await already.delete('MET emoji re-sync'); } catch (err) { /* fall through; the create will tell us */ }
    }

    try {
      const created = await guild.emojis.create({
        attachment: fs.readFileSync(file),
        name: def.name,
        reason: 'MET emoji sync',
      });
      resolved.set(def.name, { id: created.id, animated: !!created.animated });
      out.created++;
    } catch (err) {
      out.failed++;
      // The three that actually happen, named plainly so the log is useful.
      const msg = /Missing Permissions/i.test(err.message)
        ? 'the bot needs the "Manage Expressions" permission in this guild'
        : /Maximum number of emojis/i.test(err.message)
          ? 'the guild has no emoji slots left'
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
  console.log(`[Emoji] ${total}/${EMOJI.filter(d => d.discord !== false).length} available `
    + `(${out.created} uploaded, ${out.adopted} already there)`
    + (out.failed ? ` — ${out.failed} failed: ${out.errors[0]}` : ''));
  return out;
}

// Called from bot.js on ready. Deliberately delayed a little so it doesn't
// compete with the other boot work, and re-run hourly so an emoji someone
// deletes by hand comes back on its own.
function startEmojiSync(client) {
  setTimeout(() => { syncGuildEmoji(client).catch(() => {}); }, 12 * 1000);
  setInterval(() => { syncGuildEmoji(client).catch(() => {}); }, 60 * 60 * 1000);
}

module.exports = {
  e, reactionFor, urlFor, isSynced, status,
  syncGuildEmoji, startEmojiSync,
  EMOJI, PNG_DIR,
};
