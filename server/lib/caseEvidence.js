// server/lib/caseEvidence.js
// Pull the exhibits out of a case, wherever they happen to live.
//
// Evidence on a case reaches us three different ways, and an investigator
// looking somebody up should not have to know which one they are dealing with:
//
//   1. the built-in case document, where exhibits are a real structured list
//      ({ label, url, note }) written by the document builder. Clean.
//   2. free text inside that document — the summary, the allegations, the final
//      decision, the notes. People paste "Exhibit A: <link>" into a paragraph
//      as often as they use the exhibit list, and older documents were written
//      before the list existed.
//   3. an external caseLink — a Google Doc from before the builder. We cannot
//      read the inside of one of those, so the link itself is the exhibit and
//      is offered as such rather than pretended away.
//
// Labels vary: "Exhibit A", "EXHIBIT B -", "Exhibit 1)", "Evidence C:". They
// are all matched, and anything that carries a URL but no recognisable label at
// all still comes back — an unlabelled link on a case is still evidence, and
// dropping it because it was not formatted the expected way would be the one
// failure mode that matters here.

const prisma = require('./db');

// A URL we are willing to hand somebody as a clickable link. Deliberately
// http/https only: the document builder already rejects javascript: on save,
// and this is the second line of defence for rows written by any other path.
const URL_RE = /https?:\/\/[^\s<>"'`)\]}]+/gi;

function safeUrl(raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (!/^https?:\/\//i.test(v)) return null;
  try { const u = new URL(v); return /^https?:$/.test(u.protocol) ? u.toString() : null; }
  catch (e) { return null; }
}

// "Exhibit A", "EXHIBIT 12", "Evidence C" — with any of the separators people
// actually type after them.
const LABEL_RE = /\b(exhibit|evidence|annex|appendix)\s*([a-z0-9]{1,3})\b\s*[:\-–—.)\]]?/gi;

function tidyLabel(kind, mark) {
  const k = String(kind || 'Exhibit').toLowerCase();
  const nice = k.charAt(0).toUpperCase() + k.slice(1);
  return `${nice} ${String(mark || '').toUpperCase()}`.trim();
}

// Strip tags from the rich-text fields so a paragraph reads as prose, while
// keeping href targets — an exhibit is very often a hyperlink whose visible
// text is just "Exhibit A", so throwing the tags away would throw away the URL.
function textAndLinks(html) {
  const s = String(html || '');
  const links = [];
  // <a href="…">label</a> → remember both halves.
  const A_RE = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = A_RE.exec(s)) !== null) {
    const url = safeUrl(m[1]);
    if (url) links.push({ url, text: m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() });
  }
  const text = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ');
  return { text, links };
}

/**
 * Find exhibits in a block of free text (or rich text).
 *
 * Two passes, because the two shapes need different handling:
 *   · a hyperlink whose visible text names an exhibit — the label and the URL
 *     are already paired, which is the most reliable form there is
 *   · a plain "Exhibit A: https://…" line — label and URL sit next to each
 *     other and are paired by position
 *
 * Anything left over that is a bare URL still comes back, unlabelled.
 */
function fromText(html, sourceLabel) {
  const { text, links } = textAndLinks(html);
  const out = [];
  const claimed = new Set();

  // 1. Hyperlinks whose own text names the exhibit.
  const labelled = new Set();
  for (const l of links) {
    LABEL_RE.lastIndex = 0;
    const hit = LABEL_RE.exec(l.text || '');
    if (hit) {
      const label = tidyLabel(hit[1], hit[2]);
      out.push({ label, url: l.url, note: null, source: sourceLabel });
      claimed.add(l.url);
      // Pass 2 reads the tag-stripped text, where "<a…>Exhibit A</a>" is just
      // the words "Exhibit A" — the same exhibit, now with its URL invisible.
      // Without this it comes back a second time with no link at all.
      labelled.add(label);
    }
  }

  // 2. "Exhibit A: <url>" written out in the prose. Each label takes the first
  //    URL that appears after it and before the next label, which is how a list
  //    of exhibits reads to a human.
  const marks = [];
  LABEL_RE.lastIndex = 0;
  let m;
  while ((m = LABEL_RE.exec(text)) !== null) {
    marks.push({ label: tidyLabel(m[1], m[2]), at: m.index, end: m.index + m[0].length });
  }
  for (let i = 0; i < marks.length; i++) {
    const from = marks[i].end;
    const to = i + 1 < marks.length ? marks[i + 1].at : text.length;
    const slice = text.slice(from, to);
    URL_RE.lastIndex = 0;
    const u = URL_RE.exec(slice);
    const url = u ? safeUrl(u[0].replace(/[.,;]+$/, '')) : null;
    // The words between the label and its URL are the note, when there are any.
    const note = slice.slice(0, u ? u.index : Math.min(slice.length, 160))
      .replace(/\s+/g, ' ').trim().replace(/^[:\-–—.)\]]\s*/, '') || null;
    if (url && claimed.has(url)) continue;
    // Already found as a hyperlink, and this pass turned up no NEW link for it.
    if (!url && labelled.has(marks[i].label)) continue;
    if (!url && !note) continue;
    if (out.some(x => x.label === marks[i].label && x.url === url)) continue;
    if (url) claimed.add(url);
    out.push({ label: marks[i].label, url, note: note && note.length > 200 ? note.slice(0, 199) + '…' : note, source: sourceLabel });
  }

  // 3. Bare links nobody labelled. Still evidence.
  for (const l of links) {
    if (claimed.has(l.url)) continue;
    claimed.add(l.url);
    out.push({ label: null, url: l.url, note: l.text || null, source: sourceLabel, unlabelled: true });
  }
  URL_RE.lastIndex = 0;
  let bare;
  while ((bare = URL_RE.exec(text)) !== null) {
    const url = safeUrl(bare[0].replace(/[.,;]+$/, ''));
    if (!url || claimed.has(url)) continue;
    claimed.add(url);
    out.push({ label: null, url, note: null, source: sourceLabel, unlabelled: true });
  }

  return out;
}

// Sort exhibits the way a document lists them: labelled ones first in label
// order (A, B, C… then 1, 2, 3…), unlabelled ones after.
function labelOrder(label) {
  if (!label) return [2, 0, ''];
  const m = String(label).match(/([a-z]+)\s*([a-z0-9]+)/i);
  if (!m) return [1, 0, String(label)];
  const mark = m[2].toUpperCase();
  if (/^\d+$/.test(mark)) return [1, Number(mark), mark];
  return [0, mark.charCodeAt(0), mark];
}
function sortExhibits(list) {
  return list.slice().sort((a, b) => {
    const [ag, an, as] = labelOrder(a.label);
    const [bg, bn, bs] = labelOrder(b.label);
    return ag - bg || an - bn || as.localeCompare(bs);
  });
}

/**
 * Everything that counts as evidence on one case.
 *
 * @param {object} kase  a Case row (needs id, caseRef, documentId, caseLink)
 * @returns {Promise<{
 *   exhibits: Array<{label, url, note, source, unlabelled?}>,
 *   documentUrl: string|null,
 *   caseLink: string|null,
 *   hasDocument: boolean,
 *   note: string|null,
 * }>}
 */
async function evidenceFor(kase) {
  const out = { exhibits: [], documentUrl: null, caseLink: null, hasDocument: false, note: null };
  if (!kase) return out;

  const base = (process.env.PUBLIC_BASE_URL || 'https://metia.uk').replace(/\/+$/, '');
  out.caseLink = safeUrl(kase.caseLink);

  let doc = null;
  if (kase.documentId) {
    try { doc = await prisma.caseDocument.findUnique({ where: { id: kase.documentId } }); }
    catch (e) { doc = null; }
  }
  if (!doc) {
    // A document can be attached from the other side — caseId on the document
    // rather than documentId on the case — and older rows only ever set one.
    try { doc = await prisma.caseDocument.findFirst({ where: { caseId: kase.id } }); }
    catch (e) { doc = null; }
  }

  if (doc) {
    out.hasDocument = true;
    out.documentUrl = `${base}/case-doc/${doc.id}`;
    const d = (doc.data && typeof doc.data === 'object') ? doc.data : {};

    // 1. The structured exhibit list — the good case.
    if (Array.isArray(d.evidence)) {
      d.evidence.forEach((ev, i) => {
        if (!ev) return;
        const url = safeUrl(ev.url);
        const label = String(ev.label || '').trim() || `Exhibit ${String.fromCharCode(65 + i)}`;
        const note = String(ev.note || '').trim() || null;
        if (!url && !note) return;
        out.exhibits.push({
          label, url, note, source: 'exhibit list',
          // The builder keeps the original visible when it rejected a link;
          // pass that through rather than showing an exhibit with no link and
          // no explanation.
          rejected: !url && ev.url ? String(ev.url).slice(0, 200) : null,
        });
      });
    }

    // 2. Exhibits written into the prose of the document.
    const seen = new Set(out.exhibits.map(x => x.url).filter(Boolean));
    const fields = [
      [d.summaryHtml, 'summary'],
      [d.allegationsHtml, 'allegations'],
      [d.finalDecisionHtml, 'final decision'],
      [d.notesHtml, 'notes'],
    ];
    for (const [html, where] of fields) {
      if (!html) continue;
      for (const ex of fromText(html, where)) {
        if (ex.url && seen.has(ex.url)) continue;
        if (ex.url) seen.add(ex.url);
        out.exhibits.push(ex);
      }
    }
  }

  // 3. The case's own text, for a case with no document at all.
  const seen2 = new Set(out.exhibits.map(x => x.url).filter(Boolean));
  for (const [txt, where] of [[kase.reason, 'reason'], [kase.notes, 'notes']]) {
    if (!txt) continue;
    for (const ex of fromText(txt, where)) {
      if (ex.url && seen2.has(ex.url)) continue;
      if (ex.url) seen2.add(ex.url);
      out.exhibits.push(ex);
    }
  }

  // 4. An external case link. Not an exhibit in itself, but on a pre-builder
  //    case it is the only place the evidence lives, so it is offered as one —
  //    labelled honestly so nobody mistakes it for a catalogued exhibit.
  if (out.caseLink && !seen2.has(out.caseLink) && !out.exhibits.some(x => x.url === out.caseLink)) {
    out.exhibits.push({
      label: null, url: out.caseLink, source: 'case link', external: true,
      note: 'The case document is hosted outside the dashboard — its exhibits are inside it.',
    });
  }

  out.exhibits = sortExhibits(out.exhibits);

  if (!out.exhibits.length) {
    out.note = out.hasDocument
      ? 'The case document has no exhibits attached and no links in its text.'
      : 'No case document and no links on the case — the evidence was never filed here.';
  }
  return out;
}

module.exports = { evidenceFor, fromText, sortExhibits, safeUrl, textAndLinks };
