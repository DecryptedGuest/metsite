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
    const m = low.match(/::ffff:(\d+\.\d+\.\d+\.\d+)/); // IPv4-mapped
    if (m) return isBlockedAddress(m[1]);
    return false;
  }
  return true;
}

async function hostIsSafe(hostname) {
  if (!hostname) return false;
  if (/^\[?::1\]?$/.test(hostname) || /^localhost$/i.test(hostname)) return false;
  // A literal IP host is checked directly; a name is resolved (all answers).
  if (net.isIP(hostname)) return !isBlockedAddress(hostname);
  try {
    const addrs = await dns.lookup(hostname, { all: true });
    if (!addrs.length) return false;
    return addrs.every(a => !isBlockedAddress(a.address));
  } catch (e) { return false; }
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

async function safeFetch(startUrl) {
  let url = startUrl;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    let u;
    try { u = new URL(url); } catch (e) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!(await hostIsSafe(u.hostname))) return null;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    let res;
    try {
      res = await fetch(u.toString(), {
        redirect: 'manual', signal: ctrl.signal,
        headers: {
          // A browser-like UA + Discord's bot token, so sites that gate OG tags
          // behind either a real browser or a known unfurler still return them.
          'User-Agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com) MET-Portal-LinkPreview/1.0',
          'Accept': 'text/html,application/xhtml+xml,image/*;q=0.8,*/*;q=0.5',
        },
      });
    } catch (e) { clearTimeout(timer); return null; }
    clearTimeout(timer);

    // Manual redirect handling so every hop is re-validated.
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return null;
      const next = absolutize(u.toString(), loc);
      if (!next) return null;
      url = next;
      continue;
    }
    if (!res.ok) return null;
    return { res, finalUrl: u.toString() };
  }
  return null; // too many redirects
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
  try {
    const fetched = await safeFetch(url);
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
