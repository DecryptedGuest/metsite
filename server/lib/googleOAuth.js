// server/lib/googleOAuth.js
// OAuth2 Google client used for the AI case-document feature (Docs + Drive).
// A plain service account can't create/copy Docs (no Drive storage quota), so
// the docs are owned by a real Google account via a stored refresh token.
//
// Required env:
//   GOOGLE_OAUTH_CLIENT_ID
//   GOOGLE_OAUTH_CLIENT_SECRET
//   GOOGLE_OAUTH_REFRESH_TOKEN   (one-time consent; account that owns the docs)
//
// Scopes the refresh token must have been granted:
//   https://www.googleapis.com/auth/documents
//   https://www.googleapis.com/auth/drive
let google = null;
try { google = require('googleapis').google; } catch (e) { /* optional dep */ }

function getOAuthClient() {
  if (!google) return null;
  const id      = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const secret  = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refresh = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  if (!id || !secret || !refresh) return null;
  const client = new google.auth.OAuth2(id, secret);
  client.setCredentials({ refresh_token: refresh });
  return client;
}

function isConfigured() { return !!getOAuthClient(); }

function docsClient()  { const a = getOAuthClient(); return a ? google.docs({ version: 'v1', auth: a }) : null; }
function driveClient() { const a = getOAuthClient(); return a ? google.drive({ version: 'v3', auth: a }) : null; }

module.exports = { getOAuthClient, docsClient, driveClient, isConfigured };
