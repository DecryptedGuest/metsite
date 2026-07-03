// server/routes/debug.js
// TEMPORARY — remove this file and its route in index.js once login is confirmed working.
const express = require('express');
const router  = express.Router();

router.get('/', (req, res) => {
  // Only callable from Railway logs — never exposes secrets, just presence checks
  res.json({
    env_checks: {
      DISCORD_CLIENT_ID:     !!process.env.DISCORD_CLIENT_ID,
      DISCORD_CLIENT_SECRET: !!process.env.DISCORD_CLIENT_SECRET,
      DISCORD_REDIRECT_URI:  process.env.DISCORD_REDIRECT_URI || 'NOT SET',
      DISCORD_GUILD_ID:      !!process.env.DISCORD_GUILD_ID,
      DISCORD_BOT_TOKEN:     !!process.env.DISCORD_BOT_TOKEN,
      DEVELOPER_DISCORD_ID:  process.env.DEVELOPER_DISCORD_ID || 'NOT SET',
      ROLE_IA:               process.env.ROLE_IA    || 'NOT SET',
      ROLE_HICOMM:           process.env.ROLE_HICOMM || 'NOT SET',
      JWT_SECRET:            !!process.env.JWT_SECRET,
      DATABASE_URL:          !!process.env.DATABASE_URL,
      NODE_ENV:              process.env.NODE_ENV || 'NOT SET',
    },
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
