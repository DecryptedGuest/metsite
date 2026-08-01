// server/lib/dedupeMigration.js
// Finds (and optionally removes) DUPLICATE case logs created during the
// IA-website → MET-website transition. Shared by scripts/dedupe-migration-logs.js
// (CLI) and the dev-panel maintenance endpoint.
//
// Duplicate source (see server/lib/iaSync.js): the same case under an old-IA ref
// and a new ref — matched by an identical caseLink or logMessageId (strong
// identity only; no soft key).
//
// Tickets used to be deduped here too. They aren't any more: no ticket table is
// synced from IA, and the ingested Discord ticket logs are keyed on the Discord
// message id, so they can't duplicate in the first place.
//
// SAFETY: only groups that SPAN THE TRANSITION are touched (must contain an
// origin='IA' row or a "-IA" ref); within a group one canonical row is kept
// (prefer NATIVE → most activity → oldest) and the rest removed. apply=false
// reports without deleting.
const prisma = require('./db');
const { normalizeUrl } = require('./ticketLog');

const baseRef = (ref) => String(ref || '').replace(/-IA$/i, '');

function pickKeeper(rows, activity) {
  return rows.slice().sort((a, b) => {
    const an = a.origin === 'IA' ? 1 : 0, bn = b.origin === 'IA' ? 1 : 0;
    if (an !== bn) return an - bn;                        // NATIVE first
    const aa = activity ? (activity.get(a.id) || 0) : 0;
    const ba = activity ? (activity.get(b.id) || 0) : 0;
    if (aa !== ba) return ba - aa;                        // more activity first
    return new Date(a.createdAt) - new Date(b.createdAt); // oldest first
  })[0];
}

// A group is a migration artifact only if it mixes native + IA (or has a -IA ref).
function spansTransition(rows) {
  return rows.length > 1 && rows.some(r => r.origin === 'IA' || /-IA$/i.test(r.ticketRef || ''));
}

async function planCases() {
  const cases = await prisma.case.findMany({
    select: {
      id: true, caseRef: true, origin: true, caseLink: true, logMessageId: true, createdAt: true,
      _count: { select: { caseActions: true, casePunishments: true } },
    },
  });
  const activity = new Map(cases.map(c => [c.id, (c._count.caseActions || 0) + (c._count.casePunishments || 0)]));
  const groups = new Map();
  for (const c of cases) {
    let key = null;
    if (c.caseLink)          key = 'link:' + normalizeUrl(c.caseLink);
    else if (c.logMessageId) key = 'msg:' + String(c.logMessageId);
    if (!key) continue; // no strong identity → never auto-dedupe
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const del = [], report = [];
  for (const [key, rows] of groups) {
    if (!spansTransition(rows)) continue;
    const keeper = pickKeeper(rows, activity);
    const remove = rows.filter(r => r.id !== keeper.id);
    if (!remove.length) continue;
    report.push({ key, keep: keeper.caseRef, keepOrigin: keeper.origin, remove: remove.map(r => ({ ref: r.caseRef, origin: r.origin })) });
    del.push(...remove.map(r => r.id));
  }
  return { ids: del, report };
}

// scope: 'all' | 'cases'. apply=false → report only. ('tickets' is accepted and
// is now a no-op, so an old caller doesn't break.)
async function runDedupe({ apply = false, scope = 'all' } = {}) {
  const out = { apply, tickets: { count: 0, deleted: 0, report: [] }, cases: { count: 0, deleted: 0, report: [] } };

  if (scope !== 'tickets') {
    const c = await planCases();
    out.cases.count = c.ids.length; out.cases.report = c.report;
    if (apply && c.ids.length) {
      let deleted = 0;
      for (const id of c.ids) {
        try {
          await prisma.$transaction([
            prisma.caseAction.deleteMany({ where: { caseId: id } }),
            prisma.casePunishment.deleteMany({ where: { caseId: id } }),
            prisma.case.delete({ where: { id } }),
          ]);
          deleted++;
        } catch (e) { /* skip a case that won't delete (e.g. new FK) */ }
      }
      out.cases.deleted = deleted;
    }
  }
  return out;
}

module.exports = { runDedupe };
