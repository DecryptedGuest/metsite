// server/lib/penalCodes.js
// Resolves IA penal codes → { code, offense, class } from the public penal-code
// spreadsheet (CSV export), cached for 30 minutes.
const fetch = require('node-fetch');

const SHEET_ID = process.env.PENAL_SHEET_ID || '1IAeiOW1HR-Knl9LaI3dFOTb4r0acD5U1lOuNPLo2yf8';
const CSV_URL  = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=0`;

let _cache = null;
let _at = 0;

// Minimal CSV line parser (handles quoted fields with embedded commas/quotes).
function parseCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

async function loadCodes() {
  if (_cache && Date.now() - _at < 30 * 60 * 1000) return _cache;
  try {
    const res = await fetch(CSV_URL, { redirect: 'follow' });
    if (!res.ok) throw new Error('CSV ' + res.status);
    const text = await res.text();
    const lines = text.split(/\r?\n/);
    const map = {};
    for (let i = 1; i < lines.length; i++) {            // skip header row
      if (!lines[i].trim()) continue;
      const cols = parseCsvLine(lines[i]);
      const code = (cols[0] || '').trim();
      if (!code) continue;
      map[code.toUpperCase()] = {
        code,
        offense: (cols[1] || '').trim(),
        class:   (cols[2] || '').trim(),
      };
    }
    _cache = map; _at = Date.now();
    return map;
  } catch (e) {
    console.warn('[penalCodes] load failed:', e.message);
    return _cache || {};
  }
}

// Resolve one code. Returns { code, offense, class } or null.
async function resolveCode(code) {
  const map = await loadCodes();
  const key = String(code || '').trim().toUpperCase();
  if (!key) return null;
  if (map[key]) return map[key];
  // tolerate small variants (extra spaces/dashes)
  const norm = key.replace(/\s+/g, '');
  for (const k in map) if (k.replace(/\s+/g, '') === norm) return map[k];
  return null;
}

// Resolve many → [{ code, offense, class, found }] preserving order.
async function resolveCodes(codes) {
  const list = Array.isArray(codes) ? codes : [codes];
  const out = [];
  for (const c of list) {
    const raw = String(c || '').trim();
    if (!raw) continue;
    const r = await resolveCode(raw);
    out.push(r ? { ...r, found: true } : { code: raw.toUpperCase(), offense: '', class: '', found: false });
  }
  return out;
}

module.exports = { resolveCode, resolveCodes, loadCodes };
