// server/routes/debug.js
// TEMPORARY — remove this file and its route in index.js once login is confirmed working.
const express = require('express');
const router  = express.Router();

router.get('/', (req, res) => {
  // The exact redirect_uri the app sends to Discord — this string MUST be added
  // verbatim to the Discord Developer Portal → OAuth2 → Redirects. If it doesn't
  // match, Discord returns "Invalid OAuth2 redirect_uri".
  let computedRedirectUri = null;
  try { computedRedirectUri = require('./auth').buildRedirectUri(req); } catch (e) {}

  // Never exposes secrets — client_id is public (it's in the OAuth URL anyway).
  res.json({
    oauth: {
      // 👉 Copy this into Discord → OAuth2 → Redirects (exactly, no trailing slash):
      redirect_uri_to_register: computedRedirectUri,
      DISCORD_CLIENT_ID:        process.env.DISCORD_CLIENT_ID || 'NOT SET',
      PUBLIC_BASE_URL:          process.env.PUBLIC_BASE_URL || 'NOT SET',
      seen_host:                req.get('host') || null,
      seen_proto:               (req.headers['x-forwarded-proto'] || req.protocol || '') ,
    },
    env_checks: {
      DISCORD_CLIENT_ID:     !!process.env.DISCORD_CLIENT_ID,
      DISCORD_CLIENT_SECRET: !!process.env.DISCORD_CLIENT_SECRET,
      DISCORD_REDIRECT_URI:  !!process.env.DISCORD_REDIRECT_URI,
      DISCORD_GUILD_ID:      !!process.env.DISCORD_GUILD_ID,
      DISCORD_BOT_TOKEN:     !!process.env.DISCORD_BOT_TOKEN,
      DEVELOPER_DISCORD_ID:  !!process.env.DEVELOPER_DISCORD_ID,
      ROLE_IA:               !!process.env.ROLE_IA,
      ROLE_HICOMM:           !!process.env.ROLE_HICOMM,
      JWT_SECRET:            !!process.env.JWT_SECRET,
      DATABASE_URL:          !!process.env.DATABASE_URL,
      NODE_ENV:              process.env.NODE_ENV || 'NOT SET',
    },
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
