// server/lib/offenses.js
// Reads the MET penal-code / offence catalog from the Google Sheet and returns
// only the ACTIVE offences. Cached for an hour.
const fetch = require('node-fetch');

const SHEET_ID = process.env.OFFENSE_SHEET_ID || '1IAeiOW1HR-Knl9LaI3dFOTb4r0acD5U1lOuNPLo2yf8';
let cache = { at: 0, data: null };

// Minimal CSV parser that handles quoted fields and embedded commas/quotes.
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (ch === '\r') { /* ignore */ }
      else field += ch;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function getActiveOffenses() {
  if (cache.data && Date.now() - cache.at < 60 * 60 * 1000) return cache.data;

  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error('Could not read the offence sheet (is it shared "anyone with the link can view"?).');
  const rows = parseCSV(await res.text());
  if (!rows.length) return [];

  const header = rows.shift().map(h => h.trim().toLowerCase());
  const ci = (...names) => header.findIndex(h => names.some(n => h.includes(n)));
  const codeI  = ci('penal', 'code');
  const offI   = ci('offense', 'offence');
  const classI = ci('class');
  const defI   = ci('defin', 'definition', 'oversimplified');
  const statI  = ci('status', 'active');

  const out = [];
  for (const r of rows) {
    const status = statI >= 0 ? (r[statI] || '').trim().toLowerCase() : 'active';
    if (statI >= 0 && status && !status.startsWith('active')) continue; // skip "Not Active"
    const code    = (r[codeI]  || '').trim();
    const offense = (r[offI]   || '').trim();
    if (!code && !offense) continue;
    out.push({
      code,
      offense,
      class:      (r[classI] || '').trim(),
      definition: (r[defI]   || '').trim(),
    });
  }
  cache = { at: Date.now(), data: out };
  return out;
}

module.exports = { getActiveOffenses };
