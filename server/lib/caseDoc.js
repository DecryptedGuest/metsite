// server/lib/caseDoc.js
// Builds a completed disciplinary-action Google Doc from a copy of the template:
// resolves penal codes, processes evidence (URLs passthrough; uploaded media →
// hosted on the site), generates an AI summary (Gemini), fills the template
// placeholders, hyperlinks the evidence exhibits, then shares the doc
// (anyone-with-link can view + the investigator's email as editor).
//
// Required env: the GOOGLE_OAUTH_* set (see googleOAuth.js),
//   GOOGLE_CASE_TEMPLATE_ID  — a Doc the OAuth account can copy, containing the
//                              {{PLACEHOLDER}} tokens listed below.
const fetch  = require('node-fetch');
const prisma = require('./db');
const { docsClient, driveClient, isConfigured } = require('./googleOAuth');
const { resolveCodes } = require('./penalCodes');

const TEMPLATE_ID = () => process.env.GOOGLE_CASE_TEMPLATE_ID || '';
function baseUrl() {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  if (process.env.CANONICAL_HOST)  return 'https://' + process.env.CANONICAL_HOST.replace(/\/+$/, '');
  return 'https://metia.uk';
}

// ── Evidence ──────────────────────────────────────────────────────
// item: { url } (use as-is) OR { dataBase64, mimeType, filename } (host it).
async function processEvidence(items, uploaderId) {
  const out = [];
  for (const it of (items || [])) {
    if (!it) continue;
    if (it.url && String(it.url).trim()) {
      out.push({ url: String(it.url).trim(), hosted: false });
      continue;
    }
    if (it.dataBase64 && it.mimeType && it.filename) {
      const isVideo = /^video\//.test(it.mimeType);
      const isImage = /^image\//.test(it.mimeType);
      if (!isVideo && !isImage) continue;
      const buf = Buffer.from(String(it.dataBase64).replace(/^data:[^,]*,/, ''), 'base64');
      if (!buf.length) continue;
      const m = await prisma.media.create({
        data: {
          title: it.filename, filename: String(it.filename).slice(0, 200),
          mimeType: it.mimeType, size: buf.length, data: buf,
          kind: isVideo ? 'video' : 'image', visibility: 'PUBLIC', uploaderId,
        },
      });
      out.push({ url: `${baseUrl()}/m/${m.id}`, hosted: true });
    }
  }
  return out;
}

function exhibitLabels(n) {
  const labels = [];
  for (let i = 0; i < n; i++) labels.push('Exhibit ' + String.fromCharCode(65 + i)); // A, B, C…
  return labels;
}

// ── Gemini summary ────────────────────────────────────────────────
async function generateSummary({ suspect, punishment, allegations, exhibits }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const model = (process.env.GEMINI_MODEL || 'gemini-2.0-flash').split(',')[0].trim();

  const allegText = allegations.map(a => `${a.code}${a.offense ? ` (${a.offense})` : ''}`).join(', ');
  const evidenceText = exhibits.map((e, i) => `${exhibitLabels(exhibits.length)[i]}: ${e.url}`).join('\n');
  const prompt =
    `You are an Internal Affairs officer writing the "Summary of case" line for a Metropolitan Police disciplinary notice.\n` +
    `Write ONE concise, professional paragraph. Reference the relevant exhibit(s) by label (e.g. "As shown in Exhibit A"). ` +
    `State only what the evidence supports — no speculation. Use formal IA language. Do not use markdown, headings or bullet points.\n\n` +
    `Suspect: ${suspect.rank || ''} ${suspect.user || ''}\n` +
    `Allegation(s): ${allegText || 'N/A'}\n` +
    `Punishment to be issued: ${punishment || 'N/A'}\n` +
    `Evidence exhibits:\n${evidenceText || 'None'}\n\n` +
    `Return only the summary paragraph text.`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) }
    );
    const d = await res.json().catch(() => ({}));
    const txt = d?.candidates?.[0]?.content?.parts?.map(p => p.text).join('').trim();
    return txt || null;
  } catch (e) {
    console.warn('[caseDoc] summary error:', e.message);
    return null;
  }
}

// ── Google Docs helpers ───────────────────────────────────────────
// Find the first contiguous [start,end) range of `text` within a text run.
function findFirstRange(doc, text) {
  const content = doc?.body?.content || [];
  for (const el of content) {
    const elems = el.paragraph?.elements || [];
    for (const e of elems) {
      const run = e.textRun?.content;
      if (run && run.indexOf(text) >= 0) {
        const off = run.indexOf(text);
        return { startIndex: e.startIndex + off, endIndex: e.startIndex + off + text.length };
      }
    }
  }
  return null;
}

// ── Orchestrator ──────────────────────────────────────────────────
// input: { investigator{name,rank,id}, suspect{user,rank,userId}, punishment,
//          penalCodes[], evidence[], email, uploaderId, summary? }
async function buildCaseDocument(input) {
  if (!isConfigured())  throw new Error('Google Docs is not configured (set GOOGLE_OAUTH_* env vars).');
  if (!TEMPLATE_ID())   throw new Error('GOOGLE_CASE_TEMPLATE_ID is not set.');
  const docs = docsClient(), drive = driveClient();

  // 1) Resolve penal codes
  const allegations = await resolveCodes(input.penalCodes);
  const allegationsText = allegations.length
    ? allegations.map(a => `${a.code}${a.offense ? ` (${a.offense})` : ''}`).join('\n')
    : 'N/A';

  // 2) Evidence → hosted/URL list + labels
  const exhibits = await processEvidence(input.evidence, input.uploaderId);
  const labels = exhibitLabels(exhibits.length);
  const exhibitsLine = labels.length ? labels.join(' , ') : 'N/A';

  // 3) Summary (AI unless one was supplied)
  let summary = (input.summary && String(input.summary).trim()) || null;
  if (!summary) {
    summary = await generateSummary({
      suspect: input.suspect || {}, punishment: input.punishment,
      allegations, exhibits,
    });
  }
  if (!summary) summary = `As shown in the evidence exhibits, ${input.suspect?.rank || ''} ${input.suspect?.user || 'the suspect'} engaged in conduct amounting to the listed allegation(s) and shall therefore face disciplinary action.`.replace(/\s+/g, ' ').trim();

  // 4) Final decision
  const finalDecision = `On behalf of Internal Affairs, ${input.suspect?.rank || ''} ${input.suspect?.user || ''}`.trim()
    + ` will receive ${input.punishment || 'the stated punishment'}.`;

  // 5) Date / time (creator's timezone)
  const tz = process.env.QUOTA_TIMEZONE || 'Europe/London';
  const now = new Date();
  const dd = new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: '2-digit', year: '2-digit' }).format(now);
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);

  // 6) Copy the template
  const title = `IA Case — ${input.suspect?.user || 'Suspect'} — ${dd}`;
  const copy = await drive.files.copy({ fileId: TEMPLATE_ID(), requestBody: { name: title }, fields: 'id' });
  const docId = copy.data.id;

  // 7) Replace simple placeholders
  const replacements = {
    '{{REPORT_DATE}}':        dd,
    '{{REPORT_TIME}}':        hm,
    '{{SUSPECT_NAME}}':       input.suspect?.user || '',
    '{{SUSPECT_RANK}}':       input.suspect?.rank || '',
    '{{SUSPECT_ID}}':         input.suspect?.userId || '',
    '{{INVESTIGATOR_NAME}}':  input.investigator?.name || '',
    '{{INVESTIGATOR_RANK}}':  input.investigator?.rank || '',
    '{{INVESTIGATOR_ID}}':    input.investigator?.id || '',
    '{{PUNISHMENT}}':         input.punishment || '',
    '{{ALLEGATIONS}}':        allegationsText,
    '{{SUMMARY}}':            summary,
    '{{FINAL_DECISION}}':     finalDecision,
    '{{EXHIBITS}}':           exhibitsLine,
  };
  const reqs = Object.entries(replacements).map(([ph, val]) => ({
    replaceAllText: { containsText: { text: ph, matchCase: true }, replaceText: String(val) },
  }));
  await docs.documents.batchUpdate({ documentId: docId, requestBody: { requests: reqs } });

  // 8) Hyperlink each exhibit label to its evidence URL
  if (exhibits.length) {
    const doc = await docs.documents.get({ documentId: docId });
    const linkReqs = [];
    labels.forEach((label, i) => {
      const range = findFirstRange(doc.data, label);
      if (range && exhibits[i]?.url) {
        linkReqs.push({
          updateTextStyle: {
            range, textStyle: { link: { url: exhibits[i].url }, underline: true },
            fields: 'link,underline',
          },
        });
      }
    });
    if (linkReqs.length) await docs.documents.batchUpdate({ documentId: docId, requestBody: { requests: linkReqs } });
  }

  // 9) Share: anyone-with-link can view + investigator email as editor
  await drive.permissions.create({ fileId: docId, requestBody: { role: 'reader', type: 'anyone' } }).catch(e => console.warn('[caseDoc] anyone perm:', e.message));
  if (input.email) {
    await drive.permissions.create({
      fileId: docId, sendNotificationEmail: false,
      requestBody: { role: 'writer', type: 'user', emailAddress: input.email },
    }).catch(e => console.warn('[caseDoc] editor perm:', e.message));
  }

  const url = `https://docs.google.com/document/d/${docId}/edit`;
  console.log(`[caseDoc] created ${url} (codes: ${allegations.map(a => a.code).join(',')}, exhibits: ${exhibits.length})`);
  return { docId, url, allegations, summary, finalDecision, exhibits };
}

module.exports = { buildCaseDocument, processEvidence, generateSummary };
