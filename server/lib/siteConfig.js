// server/lib/siteConfig.js
// Cached key/value site settings (stored in SystemSetting) used for
// developer-controlled site-wide toggles: login lockdown, private mode,
// and "fun" event features (banner, snow, confetti).
const prisma = require('./db');

// Keys the dev Site Control panel can read/write.
const KEYS = [
  'loginLockdown',   // block all non-developer logins
  'sitePrivate',     // block the whole site (incl. login page) for non-developers
  'bannerText',      // announcement banner text ('' = off)
  'bannerColor',     // banner accent colour
  'snow',            // falling-snow effect
  'confetti',        // confetti burst when a case is approved
  // fun / event features
  'matrixRain',      // green falling-code matrix effect
  'partyMode',       // pulsing rainbow background glow
  'fireworks',       // auto-firing fireworks bursts every ~8s
  'halloween',       // halloween orange/purple theme + falling spiders
  'rainbowCursor',   // rainbow particle trail on cursor
  'spotlightUser',   // username to spotlight ('' = off)
  'countdownLabel',  // event countdown label ('' = off)
  'countdownTarget', // ISO datetime string for the countdown
  'auroraTheme',     // site-wide UI theme: on = Aurora, off = Classic
  'requirePasskeyElevated', // elevated staff must have a passkey for sensitive actions
  'altBlock',        // advanced alt detection: propagate blacklists to alts + block alt logins (default ON)
];

let cache = {};

async function refresh() {
  try {
    const rows = await prisma.systemSetting.findMany();
    const obj = {};
    rows.forEach(s => { obj[s.key] = s.value; });
    cache = obj;
  } catch (e) { /* keep last cache */ }
  return cache;
}

function getCached() { return cache; }
function isOn(key) { return cache[key] === 'true' || cache[key] === '1'; }

async function set(key, value) {
  await prisma.systemSetting.upsert({
    where:  { key },
    update: { value: String(value) },
    create: { key, value: String(value) },
  });
  cache[key] = String(value);
}

// Just the fields the client needs to render banner / effects / private state.
function publicConfig() {
  return {
    bannerText:      cache.bannerText  || '',
    bannerColor:     cache.bannerColor || '#3c6eff',
    snow:            isOn('snow'),
    confetti:        isOn('confetti'),
    sitePrivate:     isOn('sitePrivate'),
    loginLockdown:   isOn('loginLockdown'),
    matrixRain:      isOn('matrixRain'),
    partyMode:       isOn('partyMode'),
    fireworks:       isOn('fireworks'),
    halloween:       isOn('halloween'),
    rainbowCursor:   isOn('rainbowCursor'),
    spotlightUser:   cache.spotlightUser   || '',
    countdownLabel:  cache.countdownLabel  || '',
    countdownTarget: cache.countdownTarget || '',
    auroraTheme:     isOn('auroraTheme'),
  };
}

refresh();                       // initial load
setInterval(refresh, 15000);     // keep the cache fresh

module.exports = { KEYS, refresh, getCached, isOn, set, publicConfig };
