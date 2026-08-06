// server/routes/devRoblox.js — the dev panel's Roblox audio uploader.
// Mounted at /api/dev/roblox behind requireAuth, then gated to DEVELOPER here.
//
// The credential this handles is the most dangerous thing the site stores: an
// Open Cloud key can create assets on the account, and a .ROBLOSECURITY cookie
// IS the account, past two-factor. So:
//   • it is written encrypted and never read back out to any client;
//   • only a DEVELOPER can reach any of these routes;
//   • setting, replacing, removing and using it are all written to the SECURITY
//     trail with who did it — NOT the DEV category, which audit.js deliberately
//     discards, so logging these as maintenance meant not logging them at all;
//   • no route echoes it, and every Roblox error is scrubbed before it is
//     returned or logged.
const express = require('express');
const assets  = require('../lib/robloxAssets');
const audit   = require('../lib/audit');

const router = express.Router();

// The audio arrives as base64 in a JSON body, which is about 4/3 the size of the
// files plus whatever the parser holds while decoding. The app-wide limit is
// 256 MB, which on this route is an accident waiting to happen — so this route
// gets its own, sized for one full batch and no more.
const BODY_LIMIT = process.env.ROBLOX_UPLOAD_BODY_LIMIT || '90mb';
const uploadBody = express.json({ limit: BODY_LIMIT });

router.use((req, res, next) => {
  if (!req.user || req.user.role !== 'DEVELOPER') return res.status(403).json({ error: 'Developers only.' });
  next();
});

const who = (u) => u.displayName || u.discordUsername || u.id;

// A batch of forty audio is a slow, expensive, rate-limited thing to ask Roblox
// for. One at a time, so a double-click cannot start it twice.
// Held with a timestamp rather than as a bare flag: something that hangs without
// resolving would otherwise refuse every later upload for the life of the
// process, and "an upload is already running" would be a lie.
let _uploading = 0;
const UPLOAD_LOCK_MS = 20 * 60 * 1000;
const uploadRunning = () => _uploading && (Date.now() - _uploading) < UPLOAD_LOCK_MS;

// ── The credential ────────────────────────────────────────────────

// GET /api/dev/roblox/credential — status only. The secret is never returned,
// not even masked; the account it resolves to is the useful confirmation.
//
// The remaining upload allowance rides along, because it is the ceiling people
// actually hit and finding out by having a batch of forty die halfway is the
// expensive way to learn it. Best-effort — a quota Roblox will not report is not
// a broken credential.
router.get('/credential', async (req, res) => {
  try {
    const status = await assets.credentialStatus();
    if (status.configured && req.query.quota !== '0') {
      status.quota = await assets.currentQuota();
    }
    res.json(status);
  } catch (e) { res.status(500).json({ error: 'Could not read the credential status.' }); }
});

// PUT /api/dev/roblox/credential — store or replace it.
router.put('/credential', async (req, res) => {
  const { kind, value, creatorType, creatorId } = req.body || {};
  try {
    const had = await assets.credentialStatus();
    const status = await assets.setCredential({
      kind, value, creatorType, creatorId, setBy: who(req.user),
    });
    audit.record({ req, category: 'SECURITY', action: 'ROBLOX_CRED_SET', targetType: 'site',
      summary: `${had.configured ? 'Replaced' : 'Added'} the Roblox upload credential (${kind === 'apikey' ? 'Open Cloud API key' : 'account cookie'}, ${status.creatorType})` });
    // Prove it works straight away — a credential that is stored but rejected is
    // worse than none, because it looks configured.
    //
    // Scrubbed against the value we were just handed. verifyCredential scrubs its
    // own failures too, but this is the one place the plaintext is in scope, so it
    // is also the one place a slip would matter most.
    let verify = null;
    try { verify = await assets.verifyCredential(); }
    catch (e) { verify = { ok: false, error: assets.scrub(e.message, value) }; }
    if (verify && verify.error) verify.error = assets.scrub(verify.error, value);
    res.json({ ...(await assets.credentialStatus()), verify });
  } catch (e) {
    res.status(400).json({ error: assets.scrub(e.message, value) });
  }
});

// DELETE /api/dev/roblox/credential
router.delete('/credential', async (req, res) => {
  try {
    await assets.clearCredential();
    audit.record({ req, category: 'SECURITY', action: 'ROBLOX_CRED_CLEARED', targetType: 'site',
      summary: 'Removed the Roblox upload credential' });
    res.json({ ok: true, configured: false });
  } catch (e) { res.status(500).json({ error: 'Could not remove the credential.' }); }
});

// POST /api/dev/roblox/credential/verify — ask Roblox whether it still works.
// Worth pressing before a big batch: a cookie dies whenever the account logs out
// or changes its password.
router.post('/credential/verify', async (req, res) => {
  try { res.json(await assets.verifyCredential()); }
  catch (e) {
    // The plaintext is not in scope here, so this cannot scrub against it — which
    // is exactly why verifyCredential scrubs before throwing. This is the
    // last-resort net: a message that still looks like a credential does not go
    // out at all.
    res.status(400).json({ ok: false, error: assets.scrub(e.message) });
  }
});

// ── Uploading ─────────────────────────────────────────────────────

// POST /api/dev/roblox/audio
// { files: [{ fileName, mimeType, displayName?, data: <base64 | data: URL> }] }
router.post('/audio', uploadBody, async (req, res) => {
  const files = (req.body && req.body.files) || [];
  if (!Array.isArray(files) || !files.length) return res.status(400).json({ error: 'Attach at least one audio file.' });
  if (files.length > assets.MAX_BATCH) {
    return res.status(400).json({ error: `${files.length} files at once is too many · ${assets.MAX_BATCH} is the limit per batch.` });
  }
  if (uploadRunning()) return res.status(409).json({ error: 'An upload is already running · wait for it to finish.' });

  _uploading = Date.now();
  try {
    const out = await assets.uploadBatch(files, { uploadedById: req.user.id });
    audit.record({ req, category: 'SECURITY', action: 'ROBLOX_AUDIO_UPLOAD', targetType: 'site',
      summary: `Uploaded audio to Roblox · ${out.uploaded} succeeded, ${out.failed} failed, ${out.rejected.length} rejected before sending`,
      metadata: { assetIds: out.rows.filter(r => r.assetId).map(r => r.assetId) } });
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: assets.scrub(e.message) });
  } finally {
    _uploading = 0;
  }
});

// GET /api/dev/roblox/uploads — the ledger, with anything Roblox had not
// finished last time chased up first.
router.get('/uploads', async (req, res) => {
  try {
    let refreshed = { resolved: 0 };
    try { refreshed = await assets.refreshPending(); } catch { /* the list is still worth returning */ }
    res.json({ uploads: await assets.listUploads({ take: req.query.take }), refreshed });
  } catch (e) {
    res.status(500).json({ error: 'Could not read the upload list.' });
  }
});

// DELETE /api/dev/roblox/uploads — clear the ledger. The assets stay on Roblox;
// this only forgets their ids, so it asks for confirmation on the page.
router.delete('/uploads', async (req, res) => {
  try {
    const out = await assets.clearUploads();
    audit.record({ req, category: 'SECURITY', action: 'ROBLOX_UPLOADS_CLEARED', targetType: 'site',
      summary: `Cleared the Roblox upload list (${out.cleared} row(s)) · the assets themselves are untouched` });
    res.json(out);
  } catch (e) { res.status(500).json({ error: 'Could not clear the list.' }); }
});

module.exports = router;
