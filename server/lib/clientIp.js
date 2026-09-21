// server/lib/clientIp.js
// The visitor's real IP address, behind Cloudflare and Railway.
//
// Every address in the visit log was a Cloudflare edge — 172.64–172.71,
// 104.22–104.23, 162.158, 198.41.227 and so on. Not one of them belonged to a
// person. The site sits behind Cloudflare, which sits in front of Railway, and
// `x-forwarded-for` as it arrives here has been rewritten along the way: what
// reaches Express names the last proxy that spoke to it, not the browser.
//
// That is worse than a cosmetic problem in the dev panel. Alt detection links
// accounts that share a real, non-VPN IP — and every member of the server was
// sharing a handful of Cloudflare addresses. Blacklisting one account would have
// propagated to everybody who happened through the same edge. `isCloudflare` is
// what stops an edge address from ever being mistaken for somebody's own.
//
// Cloudflare's own header is the answer: CF-Connecting-IP is set on every request
// it proxies and holds the address that actually connected to it. It is trusted
// ONLY when the request came through Cloudflare, so a header somebody typed
// themselves into a direct request cannot forge it.

// Cloudflare's published ranges. https://www.cloudflare.com/ips/
// Kept as prefixes rather than fetched: this is on the request path, the list
// changes about once a year, and a lookup that fails must not decide an IP is
// personal when it is not.
const CF_V4 = [
  [ip4('173.245.48.0'), 20], [ip4('103.21.244.0'), 22], [ip4('103.22.200.0'), 22],
  [ip4('103.31.4.0'), 22],   [ip4('141.101.64.0'), 18], [ip4('108.162.192.0'), 18],
  [ip4('190.93.240.0'), 20], [ip4('188.114.96.0'), 20], [ip4('197.234.240.0'), 22],
  [ip4('198.41.128.0'), 17], [ip4('162.158.0.0'), 15],  [ip4('104.16.0.0'), 13],
  [ip4('104.24.0.0'), 14],   [ip4('172.64.0.0'), 13],   [ip4('131.0.72.0'), 22],
];
const CF_V6 = ['2400:cb00:', '2606:4700:', '2803:f800:', '2405:b500:', '2405:8100:', '2a06:98c0:', '2c0f:f248:'];

function ip4(s) {
  const p = String(s).split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const part of p) {
    const v = Number(part);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n * 256) + v;
  }
  return n;
}

/** Strip the IPv4-mapped IPv6 prefix and any port, so "::ffff:1.2.3.4" compares. */
function normalise(ip) {
  let v = String(ip == null ? '' : ip).trim();
  if (!v) return '';
  if (v.startsWith('[')) v = v.slice(1, v.indexOf(']') > 0 ? v.indexOf(']') : undefined);
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(v);
  if (m) return m[1];
  // "1.2.3.4:5678" — a port on an IPv4 address. An IPv6 address has colons of
  // its own, so only strip when what is left still looks like IPv4.
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(v)) return v.split(':')[0];
  return v;
}

/** Is this one of Cloudflare's own edge addresses? */
function isCloudflare(ip) {
  const v = normalise(ip);
  if (!v) return false;
  if (v.includes(':')) {
    const low = v.toLowerCase();
    return CF_V6.some(p => low.startsWith(p));
  }
  const n = ip4(v);
  if (n == null) return false;
  return CF_V4.some(([base, bits]) => {
    if (base == null) return false;
    const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === ((base & mask) >>> 0);
  });
}

function isPrivate(ip) {
  const v = normalise(ip);
  if (!v) return true;
  if (v === '::1' || v.startsWith('127.')) return true;
  if (v.startsWith('10.') || v.startsWith('192.168.') || v.startsWith('169.254.')) return true;
  const m = /^172\.(\d+)\./.exec(v);
  if (m && +m[1] >= 16 && +m[1] <= 31) return true;
  return /^(fc|fd|fe80)/i.test(v);
}

/** A value that is somebody's address rather than a proxy's or a placeholder. */
function isRealClientIp(ip) {
  const v = normalise(ip);
  return !!v && !isPrivate(v) && !isCloudflare(v);
}

/**
 * The visitor's IP.
 *
 * In order:
 *   CF-Connecting-IP  Cloudflare's own, and only when the request came through
 *                     Cloudflare — otherwise it is a header anybody can type
 *   True-Client-IP    the enterprise spelling of the same thing
 *   X-Forwarded-For   the first entry that is neither a proxy nor private
 *   req.ip            whatever Express made of it
 *
 * Never throws, and never returns an empty string — null when there is genuinely
 * nothing to report, so a caller cannot mistake '' for an address.
 */
function clientIp(req) {
  if (!req) return null;
  const h = req.headers || {};
  const viaCloudflare = !!h['cf-ray'] || isCloudflare(req.ip)
    || isCloudflare((req.socket && req.socket.remoteAddress) || '')
    || String(h['x-forwarded-for'] || '').split(',').some(p => isCloudflare(p));

  if (viaCloudflare) {
    for (const key of ['cf-connecting-ip', 'true-client-ip']) {
      const v = normalise(h[key]);
      if (v && !isCloudflare(v)) return v;
    }
  }

  // Left to right: the client is first, each proxy appended after it. Take the
  // first entry that is not itself a proxy — which also means a spoofed private
  // or Cloudflare address at the front cannot shadow the real one.
  const xff = String(h['x-forwarded-for'] || '').split(',').map(normalise).filter(Boolean);
  const real = xff.find(isRealClientIp);
  if (real) return real;

  const direct = normalise(h['x-real-ip']);
  if (direct && isRealClientIp(direct)) return direct;

  // Nothing usable. Fall back to what Express worked out rather than null — it is
  // at least the truth about who connected, and the callers that care whether it
  // is a PERSON'S address ask isRealClientIp.
  const fallback = normalise(req.ip || (req.socket && req.socket.remoteAddress) || '');
  return fallback || null;
}

module.exports = { clientIp, isCloudflare, isPrivate, isRealClientIp, normalise };
