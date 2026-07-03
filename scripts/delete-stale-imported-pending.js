// scripts/delete-stale-imported-pending.js
//
// ONE-TIME cleanup (not a scheduled/permanent behaviour): delete imported cases
// that are still PENDING and older than N days (default 10). Imported cases are
// owned by the SYSTEM_LEGACY_IMPORT user, so normal user-submitted cases are
// never touched.
//
// USAGE:
//   node scripts/delete-stale-imported-pending.js --dry        (preview only)
//   node scripts/delete-stale-imported-pending.js              (delete)
//   node scripts/delete-stale-imported-pending.js --days=14    (custom age)
//
// On Railway:  railway run node scripts/delete-stale-imported-pending.js --dry
require('dotenv').config();
const prisma = require('../server/lib/db');

(async () => {
  const dry     = process.argv.includes('--dry');
  const daysArg = (process.argv.find(a => a.startsWith('--days=')) || '').split('=')[1];
  const days    = daysArg ? parseInt(daysArg, 10) : 10;
  const cutoff  = new Date(Date.now() - days * 86400000);

  const importer = await prisma.user.findUnique({
    where:  { discordId: 'SYSTEM_LEGACY_IMPORT' },
    select: { id: true },
  });
  if (!importer) { console.log('No legacy-import user found — nothing imported. Exiting.'); process.exit(0); }

  const where = { userId: importer.id, status: 'PENDING', createdAt: { lt: cutoff } };
  const matches = await prisma.case.findMany({
    where,
    select: { id: true, caseRef: true, robloxUsername: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`Imported PENDING cases older than ${days} days (created before ${cutoff.toISOString()}): ${matches.length}`);
  matches.slice(0, 50).forEach(c =>
    console.log(`  ${c.caseRef}  ${(c.robloxUsername || '').padEnd(20)}  ${c.createdAt.toISOString().slice(0, 10)}`));
  if (matches.length > 50) console.log(`  …and ${matches.length - 50} more`);

  if (dry)            { console.log('\nDry run — nothing deleted. Re-run without --dry to delete.'); process.exit(0); }
  if (!matches.length) { process.exit(0); }

  const ids = matches.map(c => c.id);
  await prisma.caseAction.deleteMany({ where: { caseId: { in: ids } } });
  await prisma.casePunishment.deleteMany({ where: { caseId: { in: ids } } });
  const del = await prisma.case.deleteMany({ where: { id: { in: ids } } });
  console.log(`\nDeleted ${del.count} stale imported pending cases.`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
