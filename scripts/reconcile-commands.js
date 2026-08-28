#!/usr/bin/env node
/**
 * Reconcile Discord slash commands across every server the bot is in.
 *
 * Discord keeps a command registered until something explicitly replaces or
 * deletes it. So commands registered by an older deploy — especially GLOBAL
 * ones, which appear in every server the bot joins — linger indefinitely even
 * after the code stops registering them. That is why servers show commands
 * nobody put there.
 *
 * This walks every guild the bot is a member of and forces it to match the
 * plan, which means:
 *   - guilds in the plan get exactly their intended set (extras removed)
 *   - guilds NOT in the plan (e.g. CID, which the bot only joins to read a
 *     role) are emptied
 *   - global commands are cleared, because they defeat per-server scoping
 *
 * The plan comes from buildCommandPlan() in server/lib/bot.js, so this can
 * never drift from what the bot itself registers.
 *
 *   node scripts/reconcile-commands.js --dry     show the changes, touch nothing
 *   node scripts/reconcile-commands.js           apply them
 */
try { require('dotenv').config(); } catch { /* optional */ }

const { REST, Routes } = require('discord.js');

const DRY = process.argv.includes('--dry') || process.argv.includes('-n');

function need(name) {
  const v = process.env[name];
  if (!v) { console.error(`Missing ${name} — set it and re-run.`); process.exit(1); }
  return v;
}

(async () => {
  const token    = need('DISCORD_BOT_TOKEN');
  const clientId = process.env.DISCORD_CLIENT_ID || process.env.DISCORD_APPLICATION_ID;
  const rest = new REST({ version: '10' }).setToken(token);

  // Resolve the application id from the token if it was not configured.
  let appId = clientId;
  if (!appId) {
    const me = await rest.get(Routes.currentApplication());
    appId = me.id;
    console.log(`(application id resolved from the token: ${appId})`);
  }

  // The intended layout, straight from the bot's own planner.
  const { buildCommandPlan } = require('../server/lib/bot');
  const { byGuild } = buildCommandPlan();

  const intended = new Map();          // guildId -> [command json]
  for (const [guildId, cmds] of byGuild) intended.set(String(guildId), cmds);

  console.log(`\n${DRY ? 'DRY RUN — nothing will change' : 'Applying'}\n`);
  console.log('Intended layout:');
  if (!intended.size) console.log('  (none — no guild ids configured!)');
  for (const [g, cmds] of intended) {
    console.log(`  ${g}  ${cmds.map(c => '/' + c.name).join(' ')}`);
  }

  // ── Global commands ──────────────────────────────────────────────
  const globals = await rest.get(Routes.applicationCommands(appId));
  if (globals.length) {
    console.log(`\nGlobal commands to remove (${globals.length}): ${globals.map(c => '/' + c.name).join(' ')}`);
    console.log('  These are why commands appear in servers nobody registered them in.');
    if (!DRY) {
      await rest.put(Routes.applicationCommands(appId), { body: [] });
      console.log('  ✓ cleared (can take up to an hour to disappear in clients)');
    }
  } else {
    console.log('\nGlobal commands: none — good.');
  }

  // ── Per guild ────────────────────────────────────────────────────
  const guilds = await rest.get(Routes.userGuilds());
  console.log(`\nThe bot is in ${guilds.length} server(s):\n`);

  let changed = 0;
  for (const g of guilds) {
    const want = intended.get(String(g.id)) || [];
    let have = [];
    try {
      have = await rest.get(Routes.applicationGuildCommands(appId, g.id));
    } catch (err) {
      console.log(`  ${g.name} (${g.id}) — cannot read commands: ${err.message}`);
      console.log('     the bot likely lacks the "applications.commands" scope here · re-invite it with that scope');
      continue;
    }

    const haveNames = have.map(c => c.name).sort();
    const wantNames = want.map(c => c.name).sort();
    const same = haveNames.join(',') === wantNames.join(',');

    const label = want.length ? wantNames.map(n => '/' + n).join(' ') : '(none — this server should have no commands)';
    if (same) {
      console.log(`  ✓ ${g.name} (${g.id})\n      already correct: ${label}`);
      continue;
    }

    const removing = haveNames.filter(n => !wantNames.includes(n));
    const adding   = wantNames.filter(n => !haveNames.includes(n));
    console.log(`  → ${g.name} (${g.id})`);
    if (removing.length) console.log(`      remove: ${removing.map(n => '/' + n).join(' ')}`);
    if (adding.length)   console.log(`      add:    ${adding.map(n => '/' + n).join(' ')}`);

    if (!DRY) {
      try {
        await rest.put(Routes.applicationGuildCommands(appId, g.id), { body: want });
        console.log('      ✓ applied');
        changed++;
      } catch (err) {
        console.log(`      ✗ failed: ${err.message}`);
      }
    } else {
      changed++;
    }
  }

  console.log(`\n${DRY ? 'Would change' : 'Changed'} ${changed} server(s).`);
  if (DRY) console.log('Re-run without --dry to apply.');
  else console.log('Guild commands update instantly; cleared global ones can take up to an hour.');
  process.exit(0);
})().catch(err => {
  console.error('\nreconcile failed:', err.message);
  process.exit(1);
});
