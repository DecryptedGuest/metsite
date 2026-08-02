// server/lib/assets.js
// Serves minified JS and comment-stripped HTML to make client code harder to
// read from "view source" / devtools. This is a deterrent only — anything sent
// to the browser is ultimately retrievable. Always falls back to raw content
// so the app can never break because of minification.
const fs = require('fs');

let terser = null;
try { terser = require('terser'); } catch (e) { /* optional dependency */ }

let obfuscator = null;
try { obfuscator = require('javascript-obfuscator'); } catch (e) { /* optional dependency */ }

// Obfuscation settings tuned to be STRONG but safe for this codebase:
//  • renameGlobals:false — the app calls top-level functions across files and
//    from inline onclick="…" handlers, so globals must keep their names.
//  • stringArray + base64 + splitStrings — string literals become opaque
//    lookups instead of readable text.
//  • controlFlowFlattening (moderate) + numbersToExpressions — scrambles the
//    logic structure. deadCodeInjection / selfDefending / debugProtection are
//    left OFF to avoid any runtime or performance surprises on a live site.
const OBF_OPTS = {
  compact: true,
  renameGlobals: false,
  identifierNamesGenerator: 'hexadecimal',
  stringArray: true,
  stringArrayThreshold: 1,
  stringArrayEncoding: ['base64', 'rc4'],
  stringArrayCallsTransform: true,
  stringArrayWrappersType: 'function',
  stringArrayWrappersCount: 2,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  splitStrings: true,
  splitStringsChunkLength: 8,
  numbersToExpressions: true,
  simplify: true,
  transformObjectKeys: false,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.75,
  deadCodeInjection: false,
  selfDefending: false,
  debugProtection: false,
  disableConsoleOutput: false,
};

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

  // 1) Minify with terser (mangle function-scoped names, strip comments).
  if (terser) {
    try {
      const result = await terser.minify(raw, {
        compress: { passes: 3, drop_debugger: true, booleans_as_integers: true },
        mangle:   { toplevel: false }, // keep cross-file globals working
        format:   { comments: false, beautify: false, semicolons: true },
      });
      if (result && result.code) out = result.code;
    } catch (e) {
      out = raw; // any failure → fall back to the original, unbroken file
    }
  }

  // 2) Obfuscate the minified code (string-array + control-flow flattening).
  //    Skippable via OBFUSCATE_JS=off. Any error → keep the minified output.
  if (obfuscator && process.env.OBFUSCATE_JS !== 'off') {
    try {
      const code = obfuscator.obfuscate(out, OBF_OPTS).getObfuscatedCode();
      if (code && code.length) out = code;
    } catch (e) {
      /* keep the minified (still-working) output */
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
  let out = raw
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\n\s*\n+/g, '\n')
    .replace(/\?v=[\w.-]+/g, '?v=' + ASSET_VERSION);
  // Site-wide micro-interaction / polish layer, loaded last so it can refine
  // the base styles. Injected once, on every page.
  if (!/\/css\/enhance\.css/.test(out)) {
    out = out.replace(/<\/head>/i, `<link rel="stylesheet" href="/css/enhance.css?v=${ASSET_VERSION}"></head>`);
  }
  // Passive behavioural bot detection (telemetry only — never blocks). Injected
  // once on every page, deferred so it never delays first paint.
  if (!/\/js\/bot-sentinel\.js/.test(out)) {
    out = out.replace(/<\/body>/i, `<script src="/js/bot-sentinel.js?v=${ASSET_VERSION}" defer></script></body>`);
  }
  // Opt every page out of AI training/scraping (advisory, honoured by the major
  // AI crawlers). noindex is deliberately NOT set here — that stays governed by
  // robots.txt so search behaviour is unchanged.
  if (!/name="robots"/i.test(out)) {
    out = out.replace(/<head[^>]*>/i, (m) => `${m}<meta name="robots" content="noai, noimageai, noarchive">`);
  }

  cache.set('html:' + filePath, { mtimeMs: stat.mtimeMs, content: out });
  return out;
}

// ── Anti-copy / anti-save guard ──────────────────────────────────────
// Injected inline into every served HTML page, baked with the ACTUAL host
// that served the page. If the page is later opened as a saved file
// (file://) or re-hosted on a different domain, the guard blanks the UI and
// shows a full-screen, self-healing "not the official site" error that keeps
// re-asserting itself if removed from the DOM.
//
// Baking the serving host means the real site can NEVER lock itself out — the
// allowed host is literally whatever domain delivered the page. This is a
// strong deterrent against casual copying; it is not unbreakable (a determined
// person can disable JS or edit the saved file), which is inherent to the web.
function buildAllowlist(host) {
  const allow = [];
  if (host) allow.push(host);
  (process.env.OFFICIAL_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean).forEach(h => allow.push(h));
  // Only trust localhost in dev (or when we were actually served from it), so a
  // production page can't be re-hosted behind a local web server to dodge the guard.
  if (process.env.NODE_ENV !== 'production' || /^(localhost|127\.0\.0\.1|\[?::1\]?)(:|$)/.test(host || '')) {
    allow.push('localhost', '127.0.0.1');
  }
  return [...new Set(allow)];
}

function guardScript(host) {
  const allow = JSON.stringify(buildAllowlist(host));
  // Kept compact and dependency-free; runs before the rest of the page.
  return '<script>(function(){try{' +
    'var A=' + allow + ';var p=location.protocol,h=(location.hostname||"").toLowerCase();' +
    'var web=(p==="http:"||p==="https:");' +
    'var official=web&&(A.length===0||A.indexOf(h)!==-1);' +
    'if(official)return;' +
    'try{document.documentElement.style.setProperty("visibility","hidden","important");}catch(e){}' +
    'var MSG=\'<div style="max-width:520px"><div style="font-size:48px;line-height:1">\\u26D4</div>' +
    '<div style="font-size:22px;font-weight:800;margin:12px 0 8px;color:#ff5d6c">This is not the official MET Police site</div>' +
    '<div style="font-size:14px;line-height:1.7;color:#c9d1e0">This page has been saved, copied or re-hosted. The Metropolitan Police dashboard only runs on its official website — saved and cloned copies are disabled for security. Please return to the official site.</div></div>\';' +
    'function L(){try{if(document.getElementById("__sl__"))return;var d=document.createElement("div");d.id="__sl__";' +
    'd.setAttribute("style","position:fixed;inset:0;z-index:2147483647;background:#0b0f1a;color:#fff;display:flex;align-items:center;justify-content:center;text-align:center;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:24px;");' +
    'd.innerHTML=MSG;(document.body||document.documentElement).appendChild(d);' +
    'document.documentElement.style.setProperty("visibility","visible","important");' +
    'try{document.body.style.setProperty("overflow","hidden","important");}catch(e){}}catch(e){}}' +
    'function E(){L();try{var b=document.body;if(b){for(var i=b.children.length-1;i>=0;i--){var c=b.children[i];if(c.id!=="__sl__")b.removeChild(c);}}}catch(e){}}' +
    'if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",E);else E();' +
    'setInterval(E,500);try{new MutationObserver(E).observe(document.documentElement,{childList:true,subtree:true});}catch(e){}' +
    '}catch(e){}})();</script>';
}

// Right-click / devtools / view-source / save deterrents. Soft by nature —
// trivially bypassable — but they stop casual inspection and copying. A quiet
// bypass (localStorage `iacms_devtools`) lets the site owner still debug: open
// devtools from the browser menu once, run localStorage.iacms_devtools='1'.
function deterrentScript() {
  return '<script>(function(){try{try{if(localStorage.getItem("iacms_devtools"))return;}catch(e){}' +
    'document.addEventListener("contextmenu",function(e){e.preventDefault();},{capture:true});' +
    'document.addEventListener("keydown",function(e){var k=(e.key||"").toLowerCase();var mod=e.ctrlKey||e.metaKey;' +
    'var block=(k==="f12")' +
    '||(mod&&e.shiftKey&&(k==="i"||k==="j"||k==="c"))' +
    '||(e.metaKey&&e.altKey&&(k==="i"||k==="j"||k==="c"))' +
    '||(mod&&(k==="u"||k==="s"));' +
    'if(block){e.preventDefault();e.stopPropagation();return false;}},{capture:true});' +
    '}catch(e){}})();</script>';
}

// Insert the guard + deterrents as early as possible (right after <head>) so
// they run before the UI paints. Falls back to prepending if there's no <head>.
//
// `devState` describes who the page is being served to:
//   'dev'     — a signed-in developer: keep full devtools/right-click access.
//               We skip the deterrent and persist a bypass flag so public pages
//               (hub/login, where the server can't see who they are) also skip.
//   'nondev'  — a signed-in non-developer: apply the deterrent AND clear any
//               bypass flag they may have set themselves, so they can't opt out.
//   'unknown' — a public/unauthenticated page: apply the deterrent, which
//               self-skips only if a dev bypass flag is already present.
function injectAntiCopyGuard(html, host, devState) {
  let extra;
  if (devState === 'dev') {
    extra = '<script>try{localStorage.setItem("iacms_devtools","1")}catch(e){}</script>';
  } else if (devState === 'nondev') {
    extra = '<script>try{localStorage.removeItem("iacms_devtools")}catch(e){}</script>' + deterrentScript();
  } else {
    extra = deterrentScript();
  }
  const inject = guardScript(host) + extra;
  let injected = false;
  const out = html.replace(/<head[^>]*>/i, (m) => { injected = true; return m + inject; });
  return injected ? out : (inject + html);
}

// Pre-build the obfuscated JS cache at boot so the (one-time, CPU-heavy)
// obfuscation cost is paid at startup — when no user is waiting on a page —
// instead of on the first request for each file. Yields between files so it
// never hogs the event loop for long. Best-effort; failures are ignored.
async function warmJsCache(dir) {
  try {
    const path = require('path');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
    for (const f of files) {
      try { await getMinifiedJs(path.join(dir, f)); } catch (e) { /* skip */ }
      await new Promise(r => setImmediate(r)); // yield to keep the server responsive
    }
  } catch (e) { /* directory unreadable → nothing to warm */ }
}

module.exports = { getMinifiedJs, getMinifiedHtml, injectAntiCopyGuard, warmJsCache };
