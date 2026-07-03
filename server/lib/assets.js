// server/lib/assets.js
// Serves minified JS and comment-stripped HTML to make client code harder to
// read from "view source" / devtools. This is a deterrent only — anything sent
// to the browser is ultimately retrievable. Always falls back to raw content
// so the app can never break because of minification.
const fs = require('fs');

let terser = null;
try { terser = require('terser'); } catch (e) { /* optional dependency */ }

const cache = new Map(); // key -> { mtimeMs, content }

// Cache-busting version for client assets. Derived once per deploy from the git
// commit SHA (Railway injects RAILWAY_GIT_COMMIT_SHA) so every deploy serves a
// fresh ?v=… automatically — no more manually bumping ?v=NN in the HTML. Falls
// back to an explicit ASSET_VERSION, then to a per-boot timestamp.
const ASSET_VERSION = (
  process.env.RAILWAY_GIT_COMMIT_SHA ||
  process.env.RAILWAY_GIT_COMMIT ||
  process.env.SOURCE_VERSION ||
  process.env.ASSET_VERSION ||
  String(Date.now())
).slice(0, 12);

async function getMinifiedJs(filePath) {
  let stat;
  try { stat = fs.statSync(filePath); } catch (e) { return null; }

  const hit = cache.get('js:' + filePath);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.content;

  const raw = fs.readFileSync(filePath, 'utf8');
  let out = raw;

  if (terser) {
    try {
      const result = await terser.minify(raw, {
        compress: true,
        // Mangle only function-scoped names (toplevel:false) so cross-file
        // globals like `api`, `openDetail`, etc. keep working.
        mangle:   { toplevel: false },
        format:   { comments: false },
      });
      if (result && result.code) out = result.code;
    } catch (e) {
      out = raw; // any failure → serve the original, unbroken file
    }
  }

  cache.set('js:' + filePath, { mtimeMs: stat.mtimeMs, content: out });
  return out;
}

function getMinifiedHtml(filePath) {
  const stat = fs.statSync(filePath); // throws → caller falls back to sendFile

  const hit = cache.get('html:' + filePath);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.content;

  const raw = fs.readFileSync(filePath, 'utf8');
  // Strip HTML comments (section labels / structure hints), collapse the blank
  // lines between tags, and rewrite every local asset's ?v=… to the deploy
  // version so a new deploy always busts the browser cache automatically.
  const out = raw
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\n\s*\n+/g, '\n')
    .replace(/\?v=[\w.-]+/g, '?v=' + ASSET_VERSION);

  cache.set('html:' + filePath, { mtimeMs: stat.mtimeMs, content: out });
  return out;
}

module.exports = { getMinifiedJs, getMinifiedHtml };
