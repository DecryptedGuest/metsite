// scripts/dedupe-migration-logs.js
// CLI wrapper around server/lib/dedupeMigration.js — removes DUPLICATE case /
// ticket logs created during the old-IA-website → MET-website transition.
//
// DRY RUN by default (reports only). Pass --apply to actually delete.
//   node scripts/dedupe-migration-logs.js            # dry run
//   node scripts/dedupe-migration-logs.js --apply
//   node scripts/dedupe-migration-logs.js --apply --cases-only
//   node scripts/dedupe-migration-logs.js --apply --tickets-only
//
// A dev-panel button (Dev Panel → System) runs the same logic if you'd rather
// not use a shell.
const prisma = require('../server/lib/db');
const { runDedupe } = require('../server/lib/dedupeMigration');

const apply = process.argv.includes('--apply');
const scope = process.argv.includes('--cases-only') ? 'cases'
  : process.argv.includes('--tickets-only') ? 'tickets' : 'all';

function printSection(name, sec) {
  console.log(`\n${name}: ${sec.count} duplicate(s) ${apply ? `— deleted ${sec.deleted}` : '(dry run)'}`);
  for (const g of sec.report) {
    console.log(`  keep ${g.keep} (${g.keepOrigin}) — remove ${g.remove.map(r => `${r.ref}(${r.origin})`).join(', ')}`);
  }
}

(async () => {
  console.log(apply ? '=== DEDUPE MIGRATION LOGS (APPLY) ===' : '=== DEDUPE MIGRATION LOGS (dry run — pass --apply to delete) ===');
  const res = await runDedupe({ apply, scope });
  if (scope !== 'cases')   printSection('Tickets', res.tickets);
  if (scope !== 'tickets') printSection('Cases', res.cases);
  const total = res.tickets.count + res.cases.count;
  console.log(`\nDone. ${total} duplicate row(s) ${apply ? 'deleted' : 'identified'}.`);
  if (!apply && total) console.log('Re-run with --apply to delete them.');
  await prisma.$disconnect();
  process.exit(0);
})().catch(async (e) => {
  console.error('dedupe failed:', e);
  try { await prisma.$disconnect(); } catch (x) {}
  process.exit(1);
});
