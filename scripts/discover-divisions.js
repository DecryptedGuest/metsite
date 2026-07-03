// scripts/discover-divisions.js
// Prints what the portal auto-discovers for each division from the holder
// account's Roblox groups: group name, id, icon URL, and the full rank ladder.
//
// Run this where Roblox IS reachable (your machine, or the Railway shell) —
// the build/CI sandbox blocks the Roblox API so it can't be run there. Uses
// only PUBLIC Roblox endpoints, so no API keys are required.
//
//   node scripts/discover-divisions.js
//
// Set GROUP_CID / GROUP_SCO19 / GROUP_FLP / GROUP_HPC in .env to pin specific
// group ids; otherwise they're matched by name from the holder's groups.
require('dotenv').config();
const fetch = require('node-fetch');

const HOLDER = process.env.DIVISION_HOLDER_USERNAME || 'FNTHOLDER_V2';

// Same recognition rules the app uses (kept in sync with lib/divisions.js).
const DIVS = [
  { key: 'CID',   name: 'CID',    env: 'GROUP_CID',   match: /criminal invest|\bcid\b/i },
  { key: 'SCO19', name: 'SCO-19', env: 'GROUP_SCO19', match: /sco[\s-]?19|specialist firearms|firearms command/i },
  { key: 'IA',    name: 'IA',     env: 'IA_GROUP_ID', match: /internal affairs/i, def: '407296071' },
  { key: 'FLP',   name: 'FLP',    env: 'GROUP_FLP',   match: /frontline/i },
  { key: 'HPC',   name: 'HPC',    env: 'GROUP_HPC',   match: /hendon|police college|\bhpc\b/i },
];

async function j(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function usernameToId(username) {
  const data = await (await fetch('https://users.roblox.com/v1/usernames/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
  })).json();
  const u = (data.data || [])[0];
  return u ? String(u.id) : null;
}

async function holderGroups(robloxId) {
  const data = await j(`https://groups.roblox.com/v2/users/${robloxId}/groups/roles`);
  return (data.data || []).map(g => ({ id: String(g.group.id), name: g.group.name || '', memberRole: g.role && g.role.name }));
}

async function groupIcon(groupId) {
  try {
    const data = await j(`https://thumbnails.roblox.com/v1/groups/icons?groupIds=${groupId}&size=150x150&format=Png&isCircular=false`);
    return (data.data && data.data[0] && data.data[0].imageUrl) || null;
  } catch (e) { return null; }
}

async function groupRanks(groupId) {
  try {
    const data = await j(`https://groups.roblox.com/v1/groups/${groupId}/roles`);
    return (data.roles || []).map(r => ({ rank: r.rank, name: r.name })).sort((a, b) => a.rank - b.rank);
  } catch (e) { return []; }
}

(async () => {
  console.log(`\nHolder account: ${HOLDER}`);
  const holderId = await usernameToId(HOLDER);
  if (!holderId) { console.error('Could not resolve the holder username — check DIVISION_HOLDER_USERNAME.'); process.exit(1); }
  console.log(`Holder Roblox id: ${holderId}\n`);

  const groups = await holderGroups(holderId);
  console.log(`Groups this account is in (${groups.length}):`);
  for (const g of groups) console.log(`  ${g.id.padEnd(12)} ${g.name}`);
  console.log('');

  for (const d of DIVS) {
    const pinned = (d.env && process.env[d.env]) || d.def || null;
    const matched = pinned ? groups.find(g => g.id === pinned) : groups.find(g => d.match.test(g.name));
    const groupId = pinned || (matched && matched.id) || null;

    console.log(`── ${d.name} ${'─'.repeat(Math.max(0, 40 - d.name.length))}`);
    if (!groupId) {
      console.log(`  (no group id — set ${d.env} or ensure the holder is in a group whose name matches)\n`);
      continue;
    }
    const name = (matched && matched.name) || (groups.find(g => g.id === groupId) || {}).name || '(name unknown)';
    const [icon, ranks] = await Promise.all([groupIcon(groupId), groupRanks(groupId)]);
    console.log(`  group id : ${groupId}${pinned ? ' (pinned via env)' : ' (matched by name)'}`);
    console.log(`  name     : ${name}`);
    console.log(`  icon     : ${icon || '(none)'}`);
    console.log(`  ranks    : ${ranks.length ? '' : '(none / not readable)'}`);
    for (const r of ranks) console.log(`     ${String(r.rank).padStart(3)}  ${r.name}`);
    console.log('');
  }
})().catch(e => { console.error('Discovery failed:', e.message); process.exit(1); });
