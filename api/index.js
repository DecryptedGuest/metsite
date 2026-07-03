// api/index.js — Vercel serverless entrypoint.
// Vercel routes every request (see vercel.json rewrites) to this function,
// which hands off to the same Express app used on Railway/locally. The app is
// exported (not `.listen()`ed) when imported as a module, and its always-on
// background workers (Discord bot, revalidator, quota outbox) are skipped on
// serverless — see server/index.js.
module.exports = require('../server/index.js');
