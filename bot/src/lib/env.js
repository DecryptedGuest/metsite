// Boot-time environment validation. Required vars fail loudly and exit;
// optional ones only disable the feature that needs them.
const REQUIRED = [
  ['DISCORD_BOT_TOKEN', 'the bot token from the Discord Developer Portal'],
  ['DISCORD_CLIENT_ID', "the application's client id (Developer Portal → General Information)"],
  ['DISCORD_GUILD_ID',  'the MET server id — commands register here'],
  ['DATABASE_URL',      'the PostgreSQL connection string'],
];

function assertEnv() {
  const missing = REQUIRED.filter(([k]) => !process.env[k]);
  if (missing.length) {
    console.error('\nMissing required environment variables:\n');
    for (const [k, why] of missing) console.error(`  ${k}  — ${why}`);
    console.error('\nCopy .env.example to .env and fill these in.\n');
    process.exit(1);
  }
}

// Read at call time, never captured at import — role ids can change without a redeploy.
const env  = (name, fallback = null) => process.env[name] || fallback;
const envI = (name, fallback) => {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) ? n : fallback;
};

module.exports = { assertEnv, env, envI };
