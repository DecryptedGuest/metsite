// server/lib/aiDetect.js
// Multi-provider "was this written by AI?" detection for final-exam answers.
// Markers trigger a scan; we run every configured detector in parallel, add up
// their AI-probability (0–100), and collect the individual sentences each flags
// as AI so the marker can see exactly which text was highlighted.
//
// FREE by default — no paid keys required:
//   • ZeroGPT   (api.zerogpt.com)  — free, no key, returns an AI % + AI sentences.
//   • Heuristic (local)            — always on, no network: burstiness + AI-phrase
//                                    + contraction analysis. An independent signal
//                                    that still works if every API is down.
// Optional extra providers activate only if their key is set (so no single tool
// is trusted alone, and you can add as many as you like):
//   SAPLING_API_KEY · GPTZERO_API_KEY · WINSTON_API_KEY
//   AIDETECT_URL/_KEY/_NAME/_AUTH/_FIELD (+ AIDETECT2_*) — plug in any other API.
// Every call is best-effort + timed out: a provider that errors just reports no
// score. Disable ZeroGPT with AIDETECT_DISABLE_ZEROGPT=true.

const MIN_CHARS = 60; // below this a verdict is unreliable — we skip the answer

async function postJson(url, { headers = {}, body, timeoutMs = 12000 } = {}) {
  const opts = { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) };
  try { if (AbortSignal.timeout) opts.signal = AbortSignal.timeout(timeoutMs); } catch (e) {}
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) {}
  if (!res.ok) throw new Error(`HTTP ${res.status}${json && json.message ? ' · ' + json.message : ''}`);
  return json;
}

// Normalise any 0..1 or 0..100 number to a 0..100 percentage.
function toPct(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  const pct = v <= 1 ? v * 100 : v;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

function splitSentences(text) {
  return String(text || '').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
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
      for (const [k, v] of Object.entries(cur)) if (typeof v === 'number' && AI_KEYS.includes(k.toLowerCase())) return toPct(v);
      for (const v of Object.values(cur)) if (v && typeof v === 'object') stack.push(v);
    }
  }
  return null;
}

// ── Individual providers → { aiProbability (0..100)|null, aiSentences:[] } ──
async function zerogpt(text) {
  const j = await postJson('https://api.zerogpt.com/api/detect/detectText', { body: { input_text: text } });
  const d = (j && j.data) ? j.data : j;
  if (!d) return { aiProbability: null, aiSentences: [] };
  let pct = null;
  if (d.fakePercentage != null) pct = toPct(d.fakePercentage);
  else if (d.is_gpt_generated != null) pct = toPct(d.is_gpt_generated);
  else if (d.aiWords != null && d.textWords) pct = toPct(Number(d.aiWords) / Number(d.textWords)); // derive from word counts
  else pct = pickAiScore(d);
  const aiSentences = Array.isArray(d.h) ? d.h
    : (Array.isArray(d.highlightSentences) ? d.highlightSentences
      : (Array.isArray(d.sentences) ? d.sentences.filter(s => typeof s === 'string') : []));
  return { aiProbability: pct, aiSentences: aiSentences.filter(Boolean) };
}

// Local heuristic — no network. Tuned for the formal "police-report" register
// ChatGPT produces: it scores the DENSITY of formal/LLM phrasing plus structural
// tells (em-dashes, triadic "A, B, and C" lists, repetitive sentence openers,
// long uniform sentences, no contractions). Density — not a single hit — drives
// the score, so a genuinely tidy human answer with one such phrase stays low
// while stacked AI prose climbs high.
const AI_PHRASE_RES = [
  /\bfurthermore\b/, /\bmoreover\b/, /\badditionally\b/, /\bin conclusion\b/, /\bin summary\b/, /\bto summari[sz]e\b/,
  /\bit is (important|worth|essential|crucial) to (note|remember|understand|mention)\b/, /\bdelve into\b/,
  /\bsituational awareness\b/, /\bde-?escalat/, /\bin accordance with\b/, /\bproportionate\b/,
  /\bnecessary,? (and )?proportionate\b/, /\breasonable in the circumstances\b/, /\bprotect(ing)? life\b/,
  /\bmembers of the public\b/, /\brequest (urgent )?backup\b/, /\bcontrol room\b/, /\bpost-?incident\b/,
  /\bpreserve (evidence|the scene)\b/, /\buse[- ]of[- ]force\b/, /\bforce policy\b/, /\blawful (commands|instructions|justification|orders)\b/,
  /\bimmediate threat\b/, /\bmedical (assistance|attention)\b/, /\bassess (the )?(situation|threat|level of threat|risk)\b/,
  /\b(if|where) it is safe to do so\b/, /\bidentify myself as a\b/, /\bnotify (dispatch|control|other officers|the control room)\b/,
  /\bfollowing (department|departmental|standard) (procedures|policy|protocol)\b/,
  /\bmaintain(ing)? (cover|composure|situational awareness|professionalism)\b/, /\bmy (first )?priority\b/, /\bseek cover\b/,
  /\bprioriti[sz]e\b/, /\bensure (the )?(safety|scene|well-?being)\b/, /\bwhere appropriate\b/, /\bthreat to (life|the public)\b/,
  /\btake appropriate action\b/, /\bin an attempt to\b/, /\bprovide (accurate )?information\b/, /\bin line with (my|the) training\b/,
];
function heuristicDetect(text) {
  const t = String(text || '');
  const sentences = splitSentences(t);
  const words = t.split(/\s+/).filter(Boolean);
  const wc = words.length;
  if (wc < 12) return { aiProbability: null, aiSentences: [] }; // too short to judge

  const flagged = [];
  let phraseHits = 0;
  for (const s of sentences) {
    const hits = AI_PHRASE_RES.reduce((n, re) => n + (re.test(s.toLowerCase()) ? 1 : 0), 0);
    phraseHits += hits;
    if (hits >= 1) flagged.push(s);
  }

  let score = Math.min(48, (phraseHits / (wc / 100)) * 10); // density: hits per 100 words
  if (/[—–]/.test(t)) score += 12;   // em/en dashes — from a word processor / AI
  if (/[“”‘’]/.test(t)) score += 6;  // curly quotes

  const triads = (t.match(/\b[\w'-]+,\s+[\w'-]+,\s+and\s+[\w'-]+/gi) || []).length;
  if (triads >= 1) score += Math.min(16, triads * 8);

  if (sentences.length >= 3) {
    const openers = {};
    sentences.forEach(s => { const k = s.split(/\s+/).slice(0, 2).join(' ').toLowerCase(); openers[k] = (openers[k] || 0) + 1; });
    if (Math.max(0, ...Object.values(openers)) >= 3) score += 10; // repetitive "I would…" openers
    const lens = sentences.map(s => s.split(/\s+/).filter(Boolean).length);
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    const variance = lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length;
    const cv = mean ? Math.sqrt(variance) / mean : 1;
    if (mean >= 16) score += 8;  // long formal sentences
    if (cv < 0.4) score += 10;   // uniform lengths (low burstiness)
  }

  const contractions = (t.match(/\b\w+['’](s|re|ve|ll|d|t|m)\b/gi) || []).length;
  if (wc > 45 && contractions === 0) score += 8;

  return { aiProbability: Math.max(0, Math.min(100, Math.round(score))), aiSentences: flagged };
}

async function sapling(text) {
  const j = await postJson('https://api.sapling.com/api/v1/aidetect', { body: { key: process.env.SAPLING_API_KEY, text } });
  const aiSentences = Array.isArray(j && j.sentence_scores)
    ? j.sentence_scores.filter(s => Number(s.score) >= 0.5).map(s => s.sentence).filter(Boolean) : [];
  return { aiProbability: toPct(j && j.score), aiSentences };
}
async function gptzero(text) {
  const j = await postJson('https://api.gptzero.me/v2/predict/text', {
    headers: { 'x-api-key': process.env.GPTZERO_API_KEY }, body: { document: text },
  });
  const d = j && Array.isArray(j.documents) ? j.documents[0] : null;
  let pct = null;
  if (d && d.class_probabilities && d.class_probabilities.ai != null) pct = toPct(d.class_probabilities.ai);
  else if (d && d.completely_generated_prob != null) pct = toPct(d.completely_generated_prob);
  else pct = pickAiScore(j);
  const aiSentences = (d && Array.isArray(d.sentences))
    ? d.sentences.filter(s => Number(s.generated_prob) >= 0.5).map(s => s.sentence).filter(Boolean) : [];
  return { aiProbability: pct, aiSentences };
}
async function winston(text) {
  const j = await postJson('https://api.gowinston.ai/v2/ai-content-detection', {
    headers: { Authorization: `Bearer ${process.env.WINSTON_API_KEY}` }, body: { text },
  });
  // Winston's `score` is the HUMAN probability (0..100) → invert for AI.
  const pct = (j && Number.isFinite(Number(j.score))) ? Math.max(0, Math.min(100, Math.round(100 - Number(j.score)))) : pickAiScore(j);
  const aiSentences = Array.isArray(j && j.sentences)
    ? j.sentences.filter(s => Number(s.score) < 50).map(s => s.text).filter(Boolean) : [];
  return { aiProbability: pct, aiSentences };
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
    return { aiProbability: pickAiScore(j), aiSentences: [] };
  };
}

// The active provider set. ZeroGPT + Heuristic are free and always on.
function providers() {
  const list = [];
  if (process.env.AIDETECT_DISABLE_ZEROGPT !== 'true') list.push({ name: 'ZeroGPT', fn: zerogpt });
  list.push({ name: 'Heuristic', fn: (t) => Promise.resolve(heuristicDetect(t)) });
  if (process.env.SAPLING_API_KEY)  list.push({ name: 'Sapling',    fn: sapling });
  if (process.env.GPTZERO_API_KEY)  list.push({ name: 'GPTZero',    fn: gptzero });
  if (process.env.WINSTON_API_KEY)  list.push({ name: 'Winston AI', fn: winston });
  if (process.env.AIDETECT_URL)     list.push({ name: process.env.AIDETECT_NAME  || 'Detector 1', fn: genericFactory('') });
  if (process.env.AIDETECT2_URL)    list.push({ name: process.env.AIDETECT2_NAME || 'Detector 2', fn: genericFactory('2') });
  return list;
}
function configuredProviderNames() { return providers().map(p => p.name); }

function dedupeSentences(arr) {
  const seen = new Set(), out = [];
  for (const s of arr) { const k = String(s || '').trim().toLowerCase(); if (k && !seen.has(k)) { seen.add(k); out.push(String(s).trim()); } }
  return out;
}

// Rough count of characters covered by the flagged sentences (for "% of text
// flagged"), capped at the text length so overlaps can't exceed 100%.
function flaggedChars(text, sentences) {
  const lower = String(text).toLowerCase();
  let total = 0;
  for (const s of dedupeSentences(sentences)) {
    const t = String(s).trim().toLowerCase();
    if (t.length >= 8 && lower.includes(t)) total += t.length;
  }
  return Math.min(total, String(text).length);
}

// Run every active detector on one blob of text. Returns per-provider results,
// the averaged overall AI probability, and the union of flagged sentences.
async function detectText(text) {
  const active = providers();
  const results = await Promise.all(active.map(async p => {
    try {
      const r = await p.fn(text) || {};
      const v = r.aiProbability;
      return { name: p.name, aiProbability: (v == null ? null : Math.round(v)), aiSentences: r.aiSentences || [], error: null };
    } catch (e) { return { name: p.name, aiProbability: null, aiSentences: [], error: e.message }; }
  }));
  const scored = results.filter(r => r.aiProbability != null).map(r => r.aiProbability);
  const overall = scored.length ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : null;
  const aiSentences = dedupeSentences(results.flatMap(r => r.aiSentences));
  return { configured: true, providers: results, overall, aiSentences };
}

// Scan a set of exam answers. `items` = [{ qid, prompt, text }]. Each answer with
// enough text is scanned; per-answer we return the averaged score, the % of the
// answer flagged as AI, the flagged sentences (for highlighting), and each
// provider's individual score. The overall is length-weighted across answers.
async function scanAnswers(items) {
  const providerNames = configuredProviderNames();
  const scannable = items.filter(it => (it.text || '').trim().length >= MIN_CHARS);
  const perAnswer = [];
  for (const it of scannable) {
    const text = it.text.trim();
    const r = await detectText(text);
    const aiFraction = text.length ? Math.round(flaggedChars(text, r.aiSentences) / text.length * 100) : 0;
    perAnswer.push({
      qid: it.qid, prompt: it.prompt, chars: text.length,
      overall: r.overall, aiFraction, aiSentences: r.aiSentences,
      providers: r.providers.map(p => ({ name: p.name, aiProbability: p.aiProbability, error: p.error })),
    });
  }
  // No whole-exam "overall" — markers judge each answer on its own merits.
  const skipped = items.length - scannable.length;
  return { configured: true, providers: providerNames, perAnswer,
    message: skipped ? `${skipped} answer(s) too short to scan reliably (skipped).` : null };
}

module.exports = { detectText, scanAnswers, configuredProviderNames };
