// server/lib/ipIntel.js
// Best-effort VPN / proxy / datacenter detection for an IP address. Used ONLY by
// the developer security panel — to flag sessions that came in over a VPN and to
// track each account's most recent REAL (non-VPN) IP. Never blocks a request:
// lookups are fire-and-forget and cached in memory (VPN status is stable).
//
// Detection, in order of confidence:
//   1. proxycheck.io  — authoritative proxy/VPN flag (needs a free PROXYCHECK_API_KEY).
//   2. ipwho.is       — free, HTTPS, no key: gives the ISP/org, then a datacenter
//                       /VPN keyword heuristic decides. Consumer ISPs pass;
//                       hosting + commercial-VPN providers match.
// If every provider fails, the IP is treated as NON-VPN (unknown) so devs still
// see it — we never falsely hide a real IP just because a lookup timed out.
const prisma = require('./db');

const cache = new Map(); // ip -> { at, val }
const TTL = 12 * 60 * 60 * 1000; // 12h — VPN/hosting status is stable

// ISP/org names that indicate a datacenter, hosting provider or commercial VPN.
const DC_PATTERNS = /\b(vpn|proxy|hosting|datacenter|data ?center|colo(cation)?|cloud|dedicated server|ovh|hetzner|digitalocean|linode|vultr|amazon|aws|google llc|microsoft|azure|oracle cloud|leaseweb|m247|choopa|quadranet|nordvpn|mullvad|proton|expressvpn|surfshark|private internet access|cyberghost|ipvanish|torguard|windscribe|tunnelbear|packethub|datacamp|g-?core|contabo|scaleway|zenlayer|zscaler|frantech|cloudvps)\b/i;

// Local / private / reserved ranges never count as a VPN (and never need a lookup).
function isLocalOrPrivate(ip) {
  if (!ip) return true;
  const v = String(ip);
  if (v === '::1' || v.startsWith('127.') || v.startsWith('::ffff:127.')) return true;
  if (v.startsWith('10.') || v.startsWith('192.168.') || v.startsWith('169.254.')) return true;
  const m = v.match(/^172\.(\d+)\./); if (m && +m[1] >= 16 && +m[1] <= 31) return true;
  if (/^(fc|fd|fe80)/i.test(v)) return true; // unique-local / link-local IPv6
  return false;
}

async function fetchJson(url) {
  const opts = {};
  try { if (AbortSignal.timeout) opts.signal = AbortSignal.timeout(5000); } catch (e) {}
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function queryProvider(ip) {
  const key = process.env.PROXYCHECK_API_KEY;
  if (key) {
    const j = await fetchJson(`https://proxycheck.io/v2/${ip}?vpn=1&asn=1&key=${encodeURIComponent(key)}`);
    const rec = j && j[ip];
    if (rec) {
      return {
        vpn:     String(rec.proxy || '').toLowerCase() === 'yes',
        org:     rec.provider || rec.organisation || null,
        country: rec.isocode || null,
        source:  'proxycheck',
      };
    }
  }
  // Free HTTPS fallback: ISP/org + keyword heuristic.
  const j = await fetchJson(`https://ipwho.is/${ip}`);
  if (j && j.success !== false) {
    const org = (j.connection && (j.connection.isp || j.connection.org)) || j.org || j.isp || null;
    return { vpn: org ? DC_PATTERNS.test(org) : false, org, country: j.country_code || null, source: 'ipwho' };
  }
  throw new Error('no provider result');
}

async function lookupIp(ip) {
  if (isLocalOrPrivate(ip)) return { vpn: false, org: 'Local/Private', private: true };
  const hit = cache.get(ip);
  if (hit && Date.now() - hit.at < TTL) return hit.val;
  let val;
  try { val = await queryProvider(ip); }
  catch (e) { val = { vpn: false, unknown: true }; }
  cache.set(ip, { at: Date.now(), val });
  return val;
}

// Classify an IP and persist the result: mark the session VPN/org, and (only when
// it's NOT a VPN) update the account's most-recent real IP. Fire-and-forget —
// never throws to the caller, never blocks the request.
async function classifyAndRecord({ userId, sessionId, ip }) {
  try {
    if (!ip) return;
    const r = await lookupIp(ip);
    if (sessionId) {
      await prisma.session.update({ where: { id: sessionId }, data: { ipVpn: !!r.vpn, ipOrg: r.org || null } }).catch(() => {});
    }
    // Real IP = the most recent NON-VPN address. Unknown (lookup failed) is
    // treated as real so devs still get an address; only a confident VPN is skipped.
    if (userId && !r.vpn) {
      await prisma.user.update({ where: { id: userId }, data: { lastRealIp: ip, lastRealIpAt: new Date() } }).catch(() => {});
    }
  } catch (e) { /* best-effort */ }
}

module.exports = { lookupIp, classifyAndRecord, isLocalOrPrivate };
