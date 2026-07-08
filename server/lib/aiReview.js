// server/lib/aiReview.js
// Reviews evidence (a medal.tv clip, an uploaded video, or a text description)
// with Google Gemini and suggests matching ACTIVE offences from the catalog.
//
// Requires env: GEMINI_API_KEY (Google AI Studio). Optional: GEMINI_MODEL
// (default gemini-2.0-flash — video-capable & cheap).
const fetch = require('node-fetch');
const { getActiveOffenses } = require('./offenses');

const INLINE_MAX = 18 * 1024 * 1024; // Gemini inline-data request cap (~20MB total)

// Only ever fetch medal.tv URLs server-side — otherwise an attacker could point
// this at internal endpoints (SSRF). Restricts to medal.tv and its subdomains.
function isMedalUrl(u) {
  try {
    const url = new URL(String(u));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    const h = url.hostname.toLowerCase();
    return h === 'medal.tv' || h.endsWith('.medal.tv');
  } catch (e) { return false; }
}

// Pull the underlying MP4 URL out of a medal.tv clip page.
async function extractMedalMp4(pageUrl) {
  if (!isMedalUrl(pageUrl)) return null; // reject non-medal hosts (SSRF guard)
  const res = await fetch(pageUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (IACMS evidence bot)' }, redirect: 'follow' });
  if (!res.ok) return null;
  const html = await res.text();
  const unescape = s => s.replace(/\\u002F/gi, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&');

  let m = html.match(/<meta[^>]+(?:property|name)=["']og:video(?::secure_url|:url)?["'][^>]+content=["']([^"']+)["']/i);
  if (m && /\.mp4/i.test(m[1])) return unescape(m[1]);
  m = html.match(/"contentUrl"\s*:\s*"([^"]+\.mp4[^"]*)"/i);
  if (m) return unescape(m[1]);
  m = html.match(/(https?:(?:\\?\/){2}[^"'\s\\]*\.mp4[^"'\s\\]*)/i);
  if (m) return unescape(m[1]);
  return null;
}

// Pull "retryDelay": "5s" out of a Gemini 429 body, in ms (capped).
function parseRetryDelay(text) {
  const m = (text || '').match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i);
  if (!m) return null;
  return Math.min(Math.round(parseFloat(m[1]) * 1000), 15000);
}

// Call Gemini for one model, retrying transient 429/503 with backoff.
async function callGemini(model, key, body, retries = 2) {
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    );
    if (res.ok) return await res.json();
    const t = await res.text();
    last = { status: res.status, body: t };
    if ((res.status === 429 || res.status === 503) && attempt < retries) {
      await new Promise(r => setTimeout(r, parseRetryDelay(t) || 2000 * (attempt + 1)));
      continue;
    }
    const e = new Error(`AI request failed [${res.status}]: ${t.slice(0, 250)}`);
    e.status = res.status;
    throw e;
  }
  const e = new Error(`AI request failed [${last.status}]: ${(last.body || '').slice(0, 250)}`);
  e.status = last.status;
  throw e;
}

// Try each model in turn; a 429 (quota) on one model falls through to the next,
// since Gemini free-tier quotas are per-model.
async function callGeminiWithFallback(models, key, body) {
  for (let i = 0; i < models.length; i++) {
    try {
      return await callGemini(models[i], key, body);
    } catch (e) {
      // 429 = quota, 503 = model overloaded — both: try the next model.
      const retryable = e.status === 429 || e.status === 503;
      if (retryable && i < models.length - 1) continue;
      if (e.status === 429) {
        const friendly = new Error('The AI reviewer has hit its Google Gemini quota. This is usually the free-tier daily limit — enable billing on the Gemini API key (or add a higher-quota key) and try again, or wait for the quota to reset.');
        friendly.status = 429;
        throw friendly;
      }
      if (e.status === 503) {
        const friendly = new Error('The AI models are all busy right now (high demand). This is temporary — please try again in a moment.');
        friendly.status = 503;
        throw friendly;
      }
      throw e;
    }
  }
}

async function downloadVideo(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (IACMS evidence bot)' }, redirect: 'follow' });
  if (!res.ok) throw new Error('Could not download the clip video.');
  const buf = await res.buffer();
  if (buf.length > INLINE_MAX) {
    throw new Error('That clip is too large to analyse (max ~18 MB). Trim the clip or describe the incident instead.');
  }
  return { base64: buf.toString('base64'), mime: (res.headers.get('content-type') || 'video/mp4').split(';')[0] };
}

/**
 * Analyse evidence and return { summary, offenses:[{code,offense,class,definition,confidence,reason}] }.
 * Provide one of: videoBase64(+videoMime), medalLink, description (description may
 * also accompany a video for extra context).
 */
async function analyzeEvidence({ description, medalLink, videoBase64, videoMime }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('AI review is not configured yet (GEMINI_API_KEY is missing).');

  const offenses = await getActiveOffenses();
  if (!offenses.length) throw new Error('No active offences could be loaded from the sheet.');
  const catalog = offenses.map(o => `${o.code} | ${o.offense} | ${o.class} | ${o.definition}`).join('\n');

  // Resolve the video source (uploaded file or medal.tv link)
  let inline = null;
  if (videoBase64) {
    inline = { mime: (videoMime || 'video/mp4').split(';')[0], data: videoBase64 };
  } else if (medalLink) {
    const mp4 = await extractMedalMp4(medalLink);
    if (!mp4) throw new Error('Could not find a video in that medal.tv link. Make sure it is a public clip URL, or describe the incident instead.');
    const v = await downloadVideo(mp4);
    inline = v;
  }

  const prompt =
`You are an Internal Affairs evidence reviewer for "MET", a Roblox police roleplay group. Decide which ACTIVE offence(s) the SUSPECT (a MET officer) has committed, based strictly on the evidence.
${inline ? 'Watch the attached video carefully and describe what the officer does wrong.\n' : ''}${description ? 'Reporter context: ' + description + '\n' : ''}
Choose ONLY from this list of ACTIVE offences (CODE | OFFENCE | CLASS | DEFINITION):
${catalog}

Rules:
- Only pick offences the evidence clearly supports; never invent a code.
- You may select multiple offences, or none if nothing applies.
- "confidence" must be "high", "medium" or "low".
- In "reason", cite what in the evidence supports it (timestamp/behaviour).
Respond with JSON only.`;

  const parts = [];
  if (inline) parts.push({ inline_data: { mime_type: inline.mime, data: inline.data } });
  parts.push({ text: prompt });

  const body = {
    contents: [{ parts }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          offenses: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                code: { type: 'string' }, offense: { type: 'string' },
                class: { type: 'string' }, confidence: { type: 'string' },
                reason: { type: 'string' },
              },
              required: ['code', 'offense', 'reason'],
            },
          },
        },
        required: ['summary', 'offenses'],
      },
    },
  };

  // Model list. If GEMINI_MODEL is set (optionally comma-separated) we use it;
  // otherwise we try several models in turn. Free-tier quotas are per-model, so
  // trying more models raises the chance one still has daily allowance.
  const configured = (process.env.GEMINI_MODEL || '').split(',').map(s => s.trim()).filter(Boolean);
  const models = configured.length
    ? configured
    : ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash-lite'];

  const data = await callGeminiWithFallback(models, key, body);
  const textOut = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  let parsed;
  try { parsed = JSON.parse(textOut); } catch (e) { parsed = { summary: textOut || 'No analysis returned.', offenses: [] }; }

  // Enrich with the authoritative class/definition from the sheet
  const byCode = new Map(offenses.map(o => [o.code.toLowerCase(), o]));
  parsed.offenses = (parsed.offenses || []).map(o => {
    const cat = byCode.get((o.code || '').trim().toLowerCase());
    return {
      code:       o.code || (cat ? cat.code : ''),
      offense:    o.offense || (cat ? cat.offense : ''),
      class:      o.class || (cat ? cat.class : ''),
      definition: cat ? cat.definition : '',
      confidence: o.confidence || null,
      reason:     o.reason || '',
      inCatalog:  !!cat,
    };
  });
  parsed.usedVideo = !!inline;
  return parsed;
}

module.exports = { analyzeEvidence, extractMedalMp4 };
