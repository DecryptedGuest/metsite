// server/lib/caseRef.js
// Allocating the next case number.
//
// Lifted out of routes/cases.js so /discipline can file a case with a ref from
// the SAME sequence. Two allocators would eventually hand out the same number
// and one of the two writes would die on the unique index — which, for a
// disciplinary record, means the punishment lands and the record doesn't.

const prisma = require('./db');

/**
 * The highest existing case number across the WHOLE shared database — native,
 * IA-synced and imported alike (all use "#N" refs). So new refs continue in
 * step with the IA database rather than running a separate, out-of-sync count.
 */
async function highestCaseNumber() {
  let max = 0;
  try {
    const rows = await prisma.case.findMany({ select: { caseRef: true } });
    for (const c of rows) {
      const m = String(c.caseRef || '').match(/^#?(\d+)$/);
      if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; }
    }
  } catch (e) { /* fall back to the counter below */ }
  try {
    const ctr = await prisma.caseCounter.findUnique({ where: { id: 1 } });
    if (ctr && ctr.count > max) max = ctr.count;
  } catch (e) { /* nothing else to consult */ }
  return max;
}

/** The next free "#N", with the counter kept in step. */
async function generateCaseRef() {
  let n = (await highestCaseNumber()) + 1;
  // caseRef is @unique, so confirm the ref is actually free before claiming it.
  for (let i = 0; i < 100; i++) {
    const ref = `#${n}`;
    const exists = await prisma.case.findUnique({ where: { caseRef: ref } }).catch(() => null);
    if (!exists) {
      await prisma.caseCounter.upsert({ where: { id: 1 }, update: { count: n }, create: { id: 1, count: n } }).catch(() => {});
      return ref;
    }
    n++;
  }
  return `#${n}`;
}

module.exports = { highestCaseNumber, generateCaseRef };
