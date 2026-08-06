#!/usr/bin/env node
// scripts/import-clanslabs-xp.js
// Set everyone's XP from the Clans Labs leaderboard in data/clanslabs-xp.txt.
//
// The same thing the developer dashboard's "Clans Labs XP" panel does, for anyone
// who would rather do it from a shell. All the reasoning lives in
// server/lib/clanslabsXp.js — this is only an entry point and a report.
//
//   node scripts/import-clanslabs-xp.js --dry        rehearse, write nothing
//   node scripts/import-clanslabs-xp.js              do it
//   node scripts/import-clanslabs-xp.js --no-rover   skip RoVer; match only
//                                                    against our own tables
//   node scripts/import-clanslabs-xp.js --limit 50   the top 50 only
//   node scripts/import-clanslabs-xp.js --sweep      no import; just retry the
//                                                    rows still waiting
//   node scripts/import-clanslabs-xp.js --file x.txt a different leaderboard
//
// Re-running it is safe: every write takes the higher of the two numbers, so it
// can raise a balance and never lower one.

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

(async () => {
  const lib = require('../server/lib/clanslabsXp');
  const dry = has('--dry') || has('-n');
  const rover = !has('--no-rover');

  if (has('--sweep')) {
    const out = await lib.sweepPending({
      limit: parseInt(val('--limit', '200'), 10), rover, dryRun: dry,
    });
    console.log(`\n${dry ? 'Would claim' : 'Claimed'} ${out.claimed} of ${out.looked} waiting row(s)`
      + ` · ${out.raised} actually raised · ${out.stillWaiting} still waiting`
      + (out.resolvedIds ? ` · ${out.resolvedIds} username(s) resolved` : '')
      + (out.failed ? ` · ${out.failed} failed` : ''));
    for (const n of out.notes || []) console.log('  · ' + n);
    process.exit(0);
  }

  const out = await lib.importLeaderboard({
    dryRun: dry, rover,
    file: val('--file', null) || undefined,
    limit: has('--limit') ? parseInt(val('--limit', '0'), 10) : undefined,
  });

  console.log('');
  console.log(dry ? 'DRY RUN — nothing was written' : 'Imported');
  console.log(`  rows read              ${out.parsed}`);
  console.log(`  distinct accounts      ${out.accounts}`);
  console.log(`  resolved on Roblox     ${out.resolved}`);
  if (out.unasked) console.log(`  rate-limited, NOT read ${out.unasked}   <- run it again for these`);
  console.log(`  not a Roblox account   ${out.unknown}`);
  console.log(`  over ${out.cap}, so capped     ${out.capped}`);
  console.log(`  ${dry ? 'would be set now  ' : 'set now           '}     ${out.set}`);
  if (!dry) {
    console.log(`  of those, raised       ${out.raised}`);
    console.log(`  already high enough    ${out.unchanged}`);
  }
  console.log(`  held for later         ${out.pending}`);
  if (out.roverLookups) console.log(`  RoVer lookups          ${out.roverLookups}`);
  if (out.failed) console.log(`  FAILED                 ${out.failed}`);
  for (const n of out.notes || []) console.log('  · ' + n);
  if ((out.unknownNames || []).length) {
    console.log('\n  unresolvable: ' + out.unknownNames.join(', ')
      + (out.unknown > out.unknownNames.length ? `, and ${out.unknown - out.unknownNames.length} more` : ''));
  }
  process.exit(0);
})().catch(err => {
  console.error('\nThe import failed:', err.message);
  process.exit(1);
});
