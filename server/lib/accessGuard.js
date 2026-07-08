// server/lib/accessGuard.js
// Advanced alt detection + VPN/proxy access blocking.
//
//  • Alt detection — links accounts that share a hard signal (a real, non-VPN
//    IP or an identical device string). When an account is blacklisted, its
//    detected alts are blacklisted too, and any future login that shares a
//    signal with a blacklisted account is blocked at the door.
//  • VPN blocking — logins/requests coming over a detected VPN, proxy or
//    datacenter IP are blocked (real IPs are needed for alt detection to work).
//
// Both are developer-toggleable (Site Control: `vpnBlock`, `altBlock`) and
// DEFAULT ON, but always FAIL OPEN — an external-lookup failure or a DB blip
// never locks a legitimate member out. Developers are always exempt so an
// admin on a VPN can never be locked out of their own site.
const prisma     = require('./db');
const ipIntel    = require('./ipIntel');
const siteConfig = require('./siteConfig');

// Default-ON flag: enabled unless a developer has explicitly turned it off.
function flagOn(key) {
  const v = siteConfig.getCached()[key];
  return v !== 'false' && v !== '0' && v !== 'off';
}

// Collect the hard signals (real IPs + device strings) tied to an account.
async function signalsFor(user) {
  const ips = new Set();
  const devices = new Set();
  if (user.lastRealIp) ips.add(user.lastRealIp);
  try {
    const sess = await prisma.session.findMany({
      where: { userId: user.id },
      select: { ip: true, ipVpn: true, device: true },
    });
    sess.forEach(s => {
      if (s.ip && !s.ipVpn && !ipIntel.isLocalOrPrivate(s.ip)) ips.add(s.ip); // real IPs only
      if (s.device) devices.add(s.device);
    });
  } catch (e) { /* best-effort */ }
  return { ips: [...ips], devices: [...devices] };
}

// Find other accounts that share a real IP or device with this one.
async function findAlts(user) {
  const { ips, devices } = await signalsFor(user);
  if (!ips.length && !devices.length) return [];
  const or = [];
  if (ips.length) {
    or.push({ lastRealIp: { in: ips } });
    or.push({ sessions: { some: { ip: { in: ips }, ipVpn: false } } });
  }
  if (devices.length) or.push({ sessions: { some: { device: { in: devices } } } });
  try {
    return await prisma.user.findMany({
      where: { id: { not: user.id }, OR: or },
      select: { id: true, discordId: true, discordUsername: true, displayName: true, isBlacklisted: true, blacklistReason: true },
    });
  } catch (e) { return []; }
}

// Is this account an alt of (shares a signal with) a blacklisted account?
async function altOfBlacklisted(user) {
  const alts = await findAlts(user);
  return alts.find(a => a.isBlacklisted) || null;
}

// When an account is blacklisted, propagate the blacklist to its detected
// alts. Conservative: only touches accounts that are not already blacklisted
// and are not developers. Returns the list of newly-blacklisted alt ids.
async function propagateBlacklistToAlts(user, reason) {
  if (!flagOn('altBlock')) return [];
  let alts;
  try { alts = await findAlts(user); } catch (e) { return []; }
  const targets = alts.filter(a => !a.isBlacklisted);
  const done = [];
  const label = `Automatically blacklisted — detected as an alt of ${user.displayName || user.discordUsername || user.id}` +
    (reason ? ` (${String(reason).slice(0, 160)})` : '');
  for (const a of targets) {
    try {
      const fresh = await prisma.user.findUnique({ where: { id: a.id }, select: { role: true, isBlacklisted: true } });
      if (!fresh || fresh.isBlacklisted || fresh.role === 'DEVELOPER') continue;
      await prisma.user.update({ where: { id: a.id }, data: { isBlacklisted: true, blacklistReason: label } });
      await prisma.session.updateMany({ where: { userId: a.id, revokedAt: null }, data: { revokedAt: new Date() } }).catch(() => {});
      done.push(a.id);
    } catch (e) { /* skip this alt */ }
  }
  return done;
}

// Does this raw IP belong to a blacklisted account (as a real, non-VPN IP)?
// Catches a freshly-created alt logging in from a blacklisted main's IP before
// any of its own signals have been recorded.
async function ipBelongsToBlacklisted(ip, exceptUserId) {
  if (!ip || ipIntel.isLocalOrPrivate(ip)) return null;
  try {
    return await prisma.user.findFirst({
      where: {
        isBlacklisted: true,
        ...(exceptUserId ? { id: { not: exceptUserId } } : {}),
        OR: [{ lastRealIp: ip }, { sessions: { some: { ip, ipVpn: false } } }],
      },
      select: { id: true, discordUsername: true },
    });
  } catch (e) { return null; }
}

// Blocking evaluation used at login time (a one-off, so an external VPN lookup
// is acceptable). Returns { block, reason: 'vpn'|'alt', detail } — never throws.
async function evaluateLogin({ ip, user }) {
  try {
    if (user && user.role === 'DEVELOPER') return { block: false };
    // One VPN lookup, reused for both the VPN block and to avoid alt-matching
    // on a shared VPN IP (which would false-positive heavily).
    let vpn = null;
    if (ip && !ipIntel.isLocalOrPrivate(ip)) {
      try { vpn = await ipIntel.lookupIp(ip); } catch (e) { vpn = null; }
    }
    if (flagOn('vpnBlock') && vpn && vpn.vpn) {
      return { block: true, reason: 'vpn', detail: { org: vpn.org || null } };
    }
    if (flagOn('altBlock')) {
      // (a) shares a stored real IP / device with a blacklisted account.
      if (user) {
        const bad = await altOfBlacklisted(user);
        if (bad) return { block: true, reason: 'alt', detail: { of: bad.discordUsername || bad.id } };
      }
      // (b) the current real IP is one a blacklisted account uses.
      if (!(vpn && vpn.vpn)) {
        const bad2 = await ipBelongsToBlacklisted(ip, user && user.id);
        if (bad2) return { block: true, reason: 'alt', detail: { of: bad2.discordUsername || bad2.id } };
      }
    }
  } catch (e) { /* fail open */ }
  return { block: false };
}

module.exports = { flagOn, findAlts, altOfBlacklisted, propagateBlacklistToAlts, evaluateLogin };
