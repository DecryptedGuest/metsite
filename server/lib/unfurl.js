// server/lib/unfurl.js
// Discord-style link unfurling for support-ticket messages. Given a URL, fetch
// the page and pull its Open Graph / Twitter-card / oEmbed metadata into a small
// embed object the client renders as a card (site, title, description, image,
// colour). Direct image/video links unfurl straight into a media embed.
//
// Safety (this fetches an arbitrary user-supplied URL server-side):
//   • http/https only; no other schemes.
//   • Every hop (initial + each redirect) is DNS-resolved and rejected if it
//     points at a loopback / private / link-local / reserved address — blocks
//     SSRF against the internal network / cloud metadata endpoints.
//   • Redirects are followed MANUALLY (max 3) so each hop is re-validated.
//   • 5s timeout, 512 KB body cap, HTML (or image/video) content-types only.
// Results are cached in-memory for 30 min (previews are stable enough).
const dns  = require('dns').promises;
const net  = require('net');
const { isLocalOrPrivate } = require('./ipIntel');
// undici's Agent lets us PIN the vetted IP for the actual TCP connect, so the
// request can't be re-resolved to an internal address after validation (the
// DNS-rebinding TOCTOU). Required at runtime (Node's fetch is undici); loaded
// defensively so a missing package degrades to name-based fetch rather than crash.
let UndiciAgent = null;
try { UndiciAgent = require('undici').Agent; } catch (e) { UndiciAgent = null; }

const cache = new Map(); // url -> { at, val }
const TTL = 30 * 60 * 1000;
const MAX_BODY = 512 * 1024;
const TIMEOUT = 5000;
const MAX_REDIRECTS = 3;

// Reject anything that isn't a routable public address. Covers the ranges
// isLocalOrPrivate misses (CGNAT 100.64/10, 0.0.0.0/8, IPv6 ULA/mapped, etc.).
function isBlockedAddress(ip) {
  if (!ip) return true;
  if (isLocalOrPrivate(ip)) return true;
  const v = String(ip);
  if (net.isIPv4(v)) {
    const p = v.split('.').map(Number);
    if (p[0] === 0) return true;                       // 0.0.0.0/8
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    if (p[0] >= 224) return true;                      // multicast / reserved
    return false;
  }
  if (net.isIPv6(v)) {
    const low = v.toLowerCase();
    if (low === '::' || low === '::1') return true;
    if (low.startsWith('fe80') || low.startsWith('fc') || low.startsWith('fd')) return true;
    if (low.startsWith('ff')) return true;             // multicast
    const m = low.match(/::ffff:(\d+\.\d+\.\d+\.\d+)/); // IPv4-mapped (dotted form)
    if (m) return isBlockedAddress(m[1]);
    // IPv4-mapped in HEX form, e.g. ::ffff:7f00:1 == 127.0.0.1. The dotted regex
    // above misses this, so decode the low 32 bits and re-check as IPv4.
    const hm = low.match(/^(?:::ffff:|::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hm) {
      const hi = parseInt(hm[1], 16), lo = parseInt(hm[2], 16);
      return isBlockedAddress(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
    }
    return false;
  }
  return true;
}

// Resolve a host to a SINGLE vetted public IP (or null if unsafe). Blocks the
// whole host if ANY resolved address is private/loopback/link-local/reserved, so
// a rebinding record can't slip a bad answer in beside a good one. The returned
// IP is then PINNED for the actual connect (see safeFetch) — validating and
// connecting to the same address closes the DNS-rebinding TOCTOU.
async function resolveVetted(hostname) {
  if (!hostname) return null;
  const bare = hostname.replace(/^\[|\]$/g, ''); // strip brackets from an IPv6 literal host
  if (/^::1$/.test(bare) || /^localhost$/i.test(bare)) return null;
  if (net.isIP(bare)) return isBlockedAddress(bare) ? null : { address: bare, family: net.isIPv6(bare) ? 6 : 4 };
  let addrs;
  try { addrs = await dns.lookup(bare, { all: true }); } catch (e) { return null; }
  if (!addrs.length || addrs.some(a => isBlockedAddress(a.address))) return null;
  return { address: addrs[0].address, family: addrs[0].family };
}

function decodeEntities(s) {
  if (!s) return s;
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(+n); } catch (e) { return _; } })
    .trim();
}

// Pull <meta property/name="..." content="..."> pairs + <title> from HTML head.
function parseMeta(html) {
  const head = html.slice(0, 96 * 1024); // metadata lives in <head>; cap work
  const meta = {};
  const re = /<meta\s+[^>]*?(?:property|name)\s*=\s*["']([^"']+)["'][^>]*?content\s*=\s*["']([^"']*)["'][^>]*>/gi;
  const re2 = /<meta\s+[^>]*?content\s*=\s*["']([^"']*)["'][^>]*?(?:property|name)\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(head))) { const k = m[1].toLowerCase(); if (!(k in meta)) meta[k] = decodeEntities(m[2]); }
  while ((m = re2.exec(head))) { const k = m[2].toLowerCase(); if (!(k in meta)) meta[k] = decodeEntities(m[1]); }
  const t = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (t) meta.__title = decodeEntities(t[1].replace(/\s+/g, ' '));
  const icon = head.match(/<link\s+[^>]*rel\s*=\s*["'][^"']*icon[^"']*["'][^>]*>/i);
  if (icon) { const h = icon[0].match(/href\s*=\s*["']([^"']+)["']/i); if (h) meta.__icon = decodeEntities(h[1]); }
  return meta;
}

function absolutize(base, ref) {
  if (!ref) return null;
  try { return new URL(ref, base).toString(); } catch (e) { return null; }
}

// Build a per-request undici dispatcher that forces the TCP connect to the
// pre-validated IP (TLS SNI + Host header still use the hostname). Returns null
// when undici isn't available (falls back to name-based fetch).
function pinnedDispatcher(vetted) {
  if (!UndiciAgent) return null;
  return new UndiciAgent({
    connect: {
      timeout: TIMEOUT,
      // Handle both dns.lookup signatures undici may use (all vs single).
      lookup: (h, o, cb) => (o && o.all)
        ? cb(null, [{ address: vetted.address, family: vetted.family }])
        : cb(null, vetted.address, vetted.family),
    },
  });
}

async function safeFetch(startUrl) {
  let url = startUrl;
  let dispatcher = null;
  const closeDisp = () => { if (dispatcher) { try { dispatcher.close(); } catch (e) {} dispatcher = null; } };
  try {
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      closeDisp();
      let u;
      try { u = new URL(url); } catch (e) { return null; }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      const vetted = await resolveVetted(u.hostname);
      if (!vetted) return null;
      dispatcher = pinnedDispatcher(vetted);

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
      let res;
      try {
        res = await fetch(u.toString(), {
          redirect: 'manual', signal: ctrl.signal,
          ...(dispatcher ? { dispatcher } : {}),
          headers: {
            // A browser-like UA so sites that gate OG tags behind a real browser
            // or a known unfurler still return them.
            'User-Agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com) MET-Portal-LinkPreview/1.0',
            'Accept': 'text/html,application/xhtml+xml,image/*;q=0.8,*/*;q=0.5',
          },
        });
      } catch (e) { clearTimeout(timer); return null; }
      clearTimeout(timer);

      // Manual redirect handling so every hop is re-validated + re-pinned.
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) return null;
        const next = absolutize(u.toString(), loc);
        if (!next) return null;
        url = next;
        continue;
      }
      if (!res.ok) return null;
      // Hand the still-open dispatcher to the caller for the body read; it closes
      // it afterwards. Detach so `finally` below doesn't close it prematurely.
      const d = dispatcher; dispatcher = null;
      return { res, finalUrl: u.toString(), dispatcher: d };
    }
    return null; // too many redirects
  } finally {
    closeDisp();
  }
}

async function readCapped(res) {
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if (!reader) { const t = await res.text().catch(() => ''); return t.slice(0, MAX_BODY); }
  const chunks = []; let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length; chunks.push(value);
      if (total >= MAX_BODY) { try { reader.cancel(); } catch (e) {} break; }
    }
  } catch (e) { /* return what we have */ }
  return Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');
}

async function unfurl(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL) return hit.val;

  let val = null;
  let fetched = null;
  try {
    fetched = await safeFetch(url);
    if (fetched) {
      const { res, finalUrl } = fetched;
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      const host = (() => { try { return new URL(finalUrl).hostname.replace(/^www\./, ''); } catch (e) { return null; } })();

      if (/^image\//.test(ct)) {
        val = { url: finalUrl, host, type: 'image', title: null, description: null, image: finalUrl, siteName: host };
      } else if (/^video\//.test(ct)) {
        val = { url: finalUrl, host, type: 'video', title: null, description: null, video: finalUrl, image: null, siteName: host };
      } else if (/text\/html|application\/xhtml/.test(ct) || !ct) {
        const html = await readCapped(res);
        const m = parseMeta(html);
        const title = m['og:title'] || m['twitter:title'] || m.__title || null;
        const description = m['og:description'] || m['twitter:description'] || m['description'] || null;
        let image = m['og:image:secure_url'] || m['og:image'] || m['twitter:image'] || m['twitter:image:src'] || null;
        image = absolutize(finalUrl, image);
        let icon = absolutize(finalUrl, m.__icon) || absolutize(finalUrl, '/favicon.ico');
        const siteName = m['og:site_name'] || host;
        const color = normalizeColor(m['theme-color']);
        const type = /video/.test(m['og:type'] || '') || m['twitter:card'] === 'player' ? 'video' : 'link';
        const width = intOrNull(m['og:image:width']);
        const height = intOrNull(m['og:image:height']);
        const bigImage = m['twitter:card'] === 'summary_large_image' || (width && width >= 480);
        // Only surface an embed if there's something worth showing.
        if (title || description || image) {
          val = { url: finalUrl, host, type, title: cap(title, 300), description: cap(description, 600), image, icon, siteName: cap(siteName, 120), color, bigImage: !!bigImage, imageWidth: width, imageHeight: height };
        }
      }
    }
  } catch (e) { val = null; }
  finally { if (fetched && fetched.dispatcher) { try { fetched.dispatcher.close(); } catch (e) {} } }

  cache.set(url, { at: Date.now(), val });
  return val;
}

function cap(s, n) { if (!s) return s; s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function intOrNull(s) { const n = parseInt(s, 10); return Number.isFinite(n) ? n : null; }
function normalizeColor(c) {
  if (!c) return null;
  c = String(c).trim();
  if (/^#[0-9a-f]{3,8}$/i.test(c)) return c;
  if (/^rgb/i.test(c)) return c;
  return null;
}

module.exports = { unfurl };
