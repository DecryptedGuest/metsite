// server/lib/cad/intent/parser.js
// IntentParser: turns a free-text radio message into a structured intent. Calls
// Claude (Anthropic Messages API over fetch — no SDK) with a strict JSON-only
// prompt when ANTHROPIC_API_KEY is set; otherwise falls back to a deterministic
// rule-based parser so the radio channel still works with no key configured.
//
// Shape (validated below): { callsign, intent, entities, confidence }
//   entities: { vrm?, surname?, forename?, location?, incidentRef?, status? }
const fetch = require('node-fetch');

const INTENTS = ['BOOK_ON', 'BOOK_OFF', 'STATUS_UPDATE', 'VRM_CHECK', 'PERSON_CHECK', 'ASSIGN_REQUEST', 'ON_SCENE', 'INCIDENT_UPDATE', 'REQUEST_BACKUP', 'UNKNOWN'];
const STATUSES = ['OFF_DUTY', 'AVAILABLE', 'EN_ROUTE', 'ON_SCENE', 'BUSY', 'MEAL_BREAK', 'URGENT_ASSISTANCE'];
const CONFIDENCE_FLOOR = Number(process.env.CAD_INTENT_MIN_CONFIDENCE || 0.6);
const MODEL = process.env.CAD_INTENT_MODEL || 'claude-sonnet-5';

// ── Lightweight validation (project doesn't use zod) ─────────────────
function validateIntent(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const intent = String(obj.intent || '').toUpperCase();
  if (!INTENTS.includes(intent)) return null;
  const confidence = Number(obj.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  const e = obj.entities && typeof obj.entities === 'object' ? obj.entities : {};
  const str = (v) => (v == null ? undefined : String(v).slice(0, 200));
  const status = e.status ? String(e.status).toUpperCase() : undefined;
  return {
    callsign: obj.callsign ? String(obj.callsign).toUpperCase().replace(/\s+/g, '-').slice(0, 16) : null,
    intent,
    entities: {
      vrm: e.vrm ? String(e.vrm).toUpperCase().replace(/\s+/g, '') : undefined,
      surname: str(e.surname),
      forename: str(e.forename),
      location: str(e.location),
      incidentRef: e.incidentRef ? String(e.incidentRef).toUpperCase() : undefined,
      status: STATUSES.includes(status) ? status : undefined,
    },
    confidence,
  };
}

// ── Rule-based fallback (runs when no ANTHROPIC_API_KEY) ─────────────
function extractCallsign(text) {
  const m = text.match(/\b([A-Z]{1,4}[- ]?\d{1,3})\b/i);
  return m ? m[1].toUpperCase().replace(/\s+/g, '-') : null;
}
function extractVrm(text) {
  // UK current (AA00 AAA), plus a looser 5–8 char alnum plate.
  const m = text.match(/\b([A-Z]{2}\d{2}\s?[A-Z]{3})\b/i) || text.match(/\b([A-Z0-9]{5,8})\b(?=.*(?:vrm|plate|reg|vehicle|check))/i);
  return m ? m[1].toUpperCase().replace(/\s+/g, '') : undefined;
}
function extractIncidentRef(text) {
  const m = text.match(/\b(INC-\d{8}-\d{3})\b/i) || text.match(/\bincident\s+(\d{1,3})\b/i) || text.match(/\bref(?:erence)?\s+([A-Z0-9-]{3,20})\b/i);
  return m ? m[1].toUpperCase() : undefined;
}

function ruleBasedParse(rawText, knownCallsign) {
  const text = String(rawText || '').trim();
  const lower = text.toLowerCase();
  const callsign = extractCallsign(text) || knownCallsign || null;
  const mk = (intent, entities, confidence) => ({ callsign, intent, entities: entities || {}, confidence });

  if (/\bbook(?:ing)?\s*on\b|\bshow(?:ing)?\s*me\s*on\b/.test(lower)) return mk('BOOK_ON', {}, 0.8);
  if (/\bbook(?:ing)?\s*off\b|\boff\s*duty\b/.test(lower)) return mk('BOOK_OFF', {}, 0.8);

  if (/urgent\s*assistance|request(?:ing)?\s*backup|\bbackup\b|assistance\s*required|officer\s*(?:down|needs)/.test(lower)) return mk('REQUEST_BACKUP', {}, 0.85);

  if (/on\s*scene|\barrived\b|show\s*me\s*(?:on\s*scene|at\s*scene)/.test(lower)) return mk('ON_SCENE', { incidentRef: extractIncidentRef(text) }, 0.8);

  if (/vrm|number\s*plate|\bplate\b|reg(?:istration)?\s*check|vehicle\s*check|pnc.*vehicle|check\s*on\s*[A-Z]{2}\d{2}/i.test(text)) {
    return mk('VRM_CHECK', { vrm: extractVrm(text) }, extractVrm(text) ? 0.85 : 0.55);
  }
  if (/person\s*check|pnc.*person|name\s*check|check\s*(?:on\s*)?(?:the\s*)?(?:name|surname|male|female|subject)/i.test(text)) {
    const nm = text.match(/(?:surname|name|for)\s+([A-Za-z'-]+)(?:\s+([A-Za-z'-]+))?/i);
    return mk('PERSON_CHECK', { surname: nm ? nm[1] : undefined, forename: nm && nm[2] ? nm[2] : undefined }, nm ? 0.8 : 0.5);
  }

  if (/assign|attach\s*me|can\s*i\s*(?:be\s*)?(?:take|attend|assign)/.test(lower)) return mk('ASSIGN_REQUEST', { incidentRef: extractIncidentRef(text) }, 0.75);

  if (/\ben\s*route\b|making\s*my\s*way|\btravelling\b|shows?\s*me\s*en\s*route/.test(lower)) return mk('STATUS_UPDATE', { status: 'EN_ROUTE' }, 0.85);
  if (/\bavailable\b|\bclear\b|\bfree\b|state\s*available|show\s*me\s*(?:up|clear|available)/.test(lower)) return mk('STATUS_UPDATE', { status: 'AVAILABLE' }, 0.8);
  if (/state\s*busy|\bbusy\b|committed/.test(lower)) return mk('STATUS_UPDATE', { status: 'BUSY' }, 0.75);
  if (/\brefs\b|meal\s*break|scoff/.test(lower)) return mk('STATUS_UPDATE', { status: 'MEAL_BREAK' }, 0.75);

  if (/update|\bsitrep\b|to\s*advise|be\s*advised/.test(lower)) return mk('INCIDENT_UPDATE', { incidentRef: extractIncidentRef(text), location: undefined }, 0.6);

  return mk('UNKNOWN', {}, 0.3);
}

// ── Claude path ──────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are the intent parser for a UK police (Metropolitan Police) radio dispatch system used in a Roblox roleplay community.
You receive one short radio transmission from an officer and output ONLY a single JSON object, no prose, no markdown, no code fences.

Schema:
{"callsign": string|null, "intent": one of ["BOOK_ON","BOOK_OFF","STATUS_UPDATE","VRM_CHECK","PERSON_CHECK","ASSIGN_REQUEST","ON_SCENE","INCIDENT_UPDATE","REQUEST_BACKUP","UNKNOWN"], "entities": {"vrm"?: string, "surname"?: string, "forename"?: string, "location"?: string, "incidentRef"?: string, "status"?: one of ["OFF_DUTY","AVAILABLE","EN_ROUTE","ON_SCENE","BUSY","MEAL_BREAK","URGENT_ASSISTANCE"]}, "confidence": number between 0 and 1}

Rules:
- Callsigns look like "MP-1", "MP-12". Normalise to uppercase with a hyphen.
- "show me en route" -> STATUS_UPDATE status EN_ROUTE. "on scene"/"arrived" -> ON_SCENE. "state available"/"clear"/"free" -> STATUS_UPDATE AVAILABLE. "refs"/"meal break" -> STATUS_UPDATE MEAL_BREAK.
- "VRM check"/"PNC on <plate>" -> VRM_CHECK with entities.vrm (strip spaces, uppercase).
- "PNC on <name>"/"name check" -> PERSON_CHECK with entities.surname (and forename if given).
- "assign me to <ref>" -> ASSIGN_REQUEST with entities.incidentRef.
- "urgent assistance"/"backup"/"assistance required" -> REQUEST_BACKUP.
- If you cannot tell, use UNKNOWN with low confidence.
- Only output the JSON object.`;

async function claudeParse(rawText, knownCallsign) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const userText = knownCallsign
    ? `The sender is booked on as callsign ${knownCallsign}. Transmission: "${rawText}"`
    : `Transmission: "${rawText}"`;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 400, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: userText }] }),
  });
  if (!res.ok) throw new Error('anthropic HTTP ' + res.status);
  const data = await res.json();
  const text = (data && Array.isArray(data.content) ? data.content.map(c => c.text || '').join('') : '').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let parsed; try { parsed = JSON.parse(m[0]); } catch (e) { return null; }
  const valid = validateIntent(parsed);
  if (valid && !valid.callsign && knownCallsign) valid.callsign = knownCallsign;
  return valid;
}

// Main entry. Returns a validated intent (may be UNKNOWN/low confidence — the
// caller decides whether to act using `isActionable`). Never throws.
async function parseIntent(rawText, { knownCallsign = null } = {}) {
  try {
    const viaClaude = await claudeParse(rawText, knownCallsign);
    if (viaClaude) return { ...viaClaude, source: 'claude' };
  } catch (e) { /* fall through to rules */ }
  return { ...ruleBasedParse(rawText, knownCallsign), source: 'rules' };
}

// Below the confidence floor, or UNKNOWN → not actionable (ask to repeat).
function isActionable(intent) {
  return !!intent && intent.intent !== 'UNKNOWN' && Number(intent.confidence) >= CONFIDENCE_FLOOR;
}

module.exports = { parseIntent, ruleBasedParse, claudeParse, validateIntent, isActionable, INTENTS, STATUSES, CONFIDENCE_FLOOR };
