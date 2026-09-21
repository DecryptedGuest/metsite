// server/lib/caseRef.js
// Allocating the next case number.
//
// Lifted out of routes/cases.js so /infract can file a case with a ref from
// the SAME sequence. Two allocators would eventually hand out the same number
// and one of the two writes would die on the unique index — which, for a
// disciplinary record, means the punishment lands and the record doesn't.

const prisma = require('./db');

// Case refs are a 3–4 digit running number, the same sequence on the website and
// in Discord (both come through generateCaseRef). The one thing that breaks that
// is the imported cases: they arrived carrying their ORIGINAL Infraction ID —
// seven digits, e.g. #8665477 — and the old generator took the max over every
// ref, so the next case after an import jumped to #8665478 and stayed there.
//
// So the sequence only ever considers refs inside a sane range. An imported
// giant is kept as the case's ref (and its sourceRef) but is invisible to the
// counter, and new refs continue the real 3–4 digit line. The same range the
// renumber tool uses, from the same env, so the two agree.
const MIN_REF   = () => { const n = parseInt(process.env.CASE_REF_MIN   || '', 10); return Number.isFinite(n) && n > 0 ? n : 100; };
const MAX_REF   = () => { const n = parseInt(process.env.CASE_REF_MAX   || '', 10); return Number.isFinite(n) && n > 0 ? n : 99999; };
// Where a fresh sequence starts when nothing in range exists yet — #700, as the
// renumber was set to.
const REF_START = () => { const n = parseInt(process.env.CASE_REF_START || '', 10); return Math.max(Number.isFinite(n) && n > 0 ? n : 700, MIN_REF()); };

function refNumber(ref) {
  const m = String(ref || '').match(/^#?(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * The highest case number IN THE NORMAL RANGE — the running 3–4 digit sequence.
 * Refs outside [MIN, MAX] (the imported giants) are deliberately ignored so they
 * cannot drag the next number up with them.
 */
async function highestCaseNumber() {
  const lo = MIN_REF(), hi = MAX_REF();
  let max = 0;
  try {
    const rows = await prisma.case.findMany({ select: { caseRef: true } });
    for (const c of rows) {
      const n = refNumber(c.caseRef);
      if (n != null && n >= lo && n <= hi && n > max) max = n;
    }
  } catch (e) { /* fall back to the counter below */ }
  try {
    const ctr = await prisma.caseCounter.findUnique({ where: { id: 1 } });
    if (ctr && ctr.count > max && ctr.count <= hi) max = ctr.count;
  } catch (e) { /* nothing else to consult */ }
  return max;
}

/** The next free "#N" in the 3–4 digit sequence, with the counter kept in step. */
async function generateCaseRef() {
  // Continue from the highest in-range ref, or start the sequence at #700 when
  // there is nothing in range yet (e.g. only imported giants exist so far).
  let n = Math.max((await highestCaseNumber()) + 1, REF_START());
  // caseRef is @unique, so confirm the ref is actually free before claiming it.
  for (let i = 0; i < 1000; i++) {
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
