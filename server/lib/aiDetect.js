// server/lib/aiDetect.js
// Multi-provider "was this written by AI?" detection for final-exam answers.
// Markers trigger a scan; we run every configured detector in parallel and
// aggregate their AI-probability (0–100) so no single tool is trusted alone.
//
// A provider is active only when its API key env var is set — so the site works
// with zero, one, or several detectors. Well-documented providers are wired in
// directly; JustDone and two GENERIC slots let you plug in any other detector
// (URL + key + where the score lives) without code changes. Every call is
// best-effort: a provider that errors or times out just reports no score.
//
// Env:
//   SAPLING_API_KEY        — sapling.ai      (score 0..1)
//   GPTZERO_API_KEY        — gptzero.me      (class_probabilities.ai)
//   WINSTON_API_KEY        — gowinston.ai    (human "score" 0..100 → inverted)
//   JUSTDONE_API_KEY [+ JUSTDONE_API_URL]    — justdone.ai (bearer; score auto-parsed)
//   AIDETECT_URL/_KEY/_NAME/_AUTH/_FIELD     — generic detector slot 1
//   AIDETECT2_URL/_KEY/_NAME/_AUTH/_FIELD    — generic detector slot 2
//     _AUTH: 'bearer' (default) | 'x-api-key' | 'none'
//     _FIELD: JSON body field the text goes in (default 'text')

const MIN_CHARS = 120; // below this a detector's verdict is unreliable — we skip

async function postJson(url, { headers = {}, body, timeoutMs = 12000 } = {}) {
  const opts = { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) };
  try { if (AbortSignal.timeout) opts.signal = AbortSignal.timeout(timeoutMs); } catch (e) {}
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) {}
  if (!res.ok) throw new Error(`HTTP ${res.status}${json && json.message ? ' — ' + json.message : ''}`);
  return json;
}

// Normalise any 0..1 or 0..100 number to a 0..100 percentage.
function toPct(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  const pct = v <= 1 ? v * 100 : v;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

// Hunt for an AI-probability field anywhere in a response object.
function pickAiScore(obj) {
  if (obj == null) return null;
  const AI_KEYS = ['ai_probability', 'aiprobability', 'ai_score', 'aiscore', 'fakepercentage', 'fake_probability',
    'generated_prob', 'completely_generated_prob', 'ai', 'probability', 'score'];
  const stack = [obj];
  while (stack.length) {
    const cur = stack.shift();
    if (cur && typeof cur === 'object') {
      for (const [k, v] of Object.entries(cur)) {
        if (typeof v === 'number' && AI_KEYS.includes(k.toLowerCase())) return toPct(v);
      }
      for (const v of Object.values(cur)) if (v && typeof v === 'object') stack.push(v);
    }
  }
  return null;
}

// ── Individual providers → aiProbability (0..100) ──────────────────────
async function sapling(text) {
  const j = await postJson('https://api.sapling.com/api/v1/aidetect', { body: { key: process.env.SAPLING_API_KEY, text } });
  return toPct(j && j.score);
}
async function gptzero(text) {
  const j = await postJson('https://api.gptzero.me/v2/predict/text', {
    headers: { 'x-api-key': process.env.GPTZERO_API_KEY }, body: { document: text },
  });
  const d = j && Array.isArray(j.documents) ? j.documents[0] : null;
  if (d && d.class_probabilities && d.class_probabilities.ai != null) return toPct(d.class_probabilities.ai);
  if (d && d.completely_generated_prob != null) return toPct(d.completely_generated_prob);
  return pickAiScore(j);
}
async function winston(text) {
  const j = await postJson('https://api.gowinston.ai/v2/ai-content-detection', {
    headers: { Authorization: `Bearer ${process.env.WINSTON_API_KEY}` }, body: { text },
  });
  // Winston's `score` is the HUMAN probability (0..100) → invert for AI.
  if (j && Number.isFinite(Number(j.score))) return Math.max(0, Math.min(100, Math.round(100 - Number(j.score))));
  return pickAiScore(j);
}
async function justdone(text) {
  const url = process.env.JUSTDONE_API_URL || 'https://api.justdone.ai/v1/ai-detector';
  const j = await postJson(url, { headers: { Authorization: `Bearer ${process.env.JUSTDONE_API_KEY}` }, body: { text } });
  return pickAiScore(j);
}
function genericFactory(suffix) {
  return async function (text) {
    const url = process.env[`AIDETECT${suffix}_URL`];
    const key = process.env[`AIDETECT${suffix}_KEY`];
    const auth = (process.env[`AIDETECT${suffix}_AUTH`] || 'bearer').toLowerCase();
    const field = process.env[`AIDETECT${suffix}_FIELD`] || 'text';
    const headers = {};
    if (key && auth === 'bearer') headers.Authorization = `Bearer ${key}`;
    else if (key && auth === 'x-api-key') headers['x-api-key'] = key;
    const j = await postJson(url, { headers, body: { [field]: text } });
    return pickAiScore(j);
  };
}

// The active provider set (only those with an API key / URL configured).
function providers() {
  const list = [];
  if (process.env.SAPLING_API_KEY)  list.push({ name: 'Sapling',    fn: sapling });
  if (process.env.GPTZERO_API_KEY)  list.push({ name: 'GPTZero',    fn: gptzero });
  if (process.env.WINSTON_API_KEY)  list.push({ name: 'Winston AI', fn: winston });
  if (process.env.JUSTDONE_API_KEY) list.push({ name: 'JustDone',   fn: justdone });
  if (process.env.AIDETECT_URL)     list.push({ name: process.env.AIDETECT_NAME  || 'Detector 1', fn: genericFactory('') });
  if (process.env.AIDETECT2_URL)    list.push({ name: process.env.AIDETECT2_NAME || 'Detector 2', fn: genericFactory('2') });
  return list;
}
function configuredProviderNames() { return providers().map(p => p.name); }

// Run every active detector on one blob of text. Returns per-provider results
// and the average AI probability across the providers that returned a score.
async function detectText(text) {
  const active = providers();
  if (!active.length) return { configured: false, providers: [], overall: null };
  const results = await Promise.all(active.map(async p => {
    try { const v = await p.fn(text); return { name: p.name, aiProbability: (v == null ? null : v), error: null }; }
    catch (e) { return { name: p.name, aiProbability: null, error: e.message }; }
  }));
  const scored = results.filter(r => r.aiProbability != null).map(r => r.aiProbability);
  const overall = scored.length ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : null;
  return { configured: true, providers: results, overall };
}

// Scan a set of exam answers. `items` = [{ qid, prompt, text }]. Each answer with
// enough text is scanned individually; the overall is length-weighted across
// answers. Returns a structure ready to persist on the submission.
async function scanAnswers(items) {
  const active = providers();
  const providerNames = active.map(p => p.name);
  if (!active.length) {
    return { configured: false, providers: providerNames, overall: null, perAnswer: [],
      message: 'No AI detectors are configured. Set an API key (e.g. SAPLING_API_KEY, GPTZERO_API_KEY, WINSTON_API_KEY, JUSTDONE_API_KEY) to enable scanning.' };
  }
  const scannable = items.filter(it => (it.text || '').trim().length >= MIN_CHARS);
  const perAnswer = [];
  for (const it of scannable) {
    const r = await detectText(it.text.trim());
    perAnswer.push({ qid: it.qid, prompt: it.prompt, chars: it.text.trim().length, overall: r.overall, providers: r.providers });
  }
  // Length-weighted overall across scanned answers.
  let wsum = 0, w = 0;
  for (const a of perAnswer) if (a.overall != null) { wsum += a.overall * a.chars; w += a.chars; }
  const overall = w ? Math.round(wsum / w) : null;
  const skipped = items.length - scannable.length;
  return { configured: true, providers: providerNames, overall, perAnswer,
    message: skipped ? `${skipped} answer(s) too short to scan reliably (skipped).` : null };
}

module.exports = { detectText, scanAnswers, configuredProviderNames };
