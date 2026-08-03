// server/lib/robloxAssets.js — push audio to Roblox and hand back the asset ids.
//
// Two ways in, because Roblox has two:
//
//   apikey  Open Cloud (apis.roblox.com/assets/v1). An API key created at
//           create.roblox.com/credentials, scoped to asset:write. Supported,
//           documented, revocable on its own, and it cannot log into the account
//           or read anything. This is the one to use.
//
//   cookie  The .ROBLOSECURITY session cookie, against the legacy publish
//           endpoint. Works, and is the only option if key creation is not
//           available — but that cookie IS the account: it authenticates past
//           two-factor, and anything holding it can do anything the account can.
//           Stored encrypted, never sent back to the browser, never logged.
//
// Whichever is configured is used. Audio only for now; the Open Cloud path takes
// other asset types with a one-word change, which is why assetType is a
// parameter rather than a constant.
const prisma    = require('./db');
const secretBox = require('./secretBox');

const SETTING_KEY = 'roblox.uploadCredential';

// Roblox takes .mp3 and .ogg for audio, nothing else, and rejects anything over
// 7 minutes long. Duration needs the file decoded to know, so that one is left
// to Roblox to refuse — its message is passed through verbatim.
const AUDIO_MIME = {
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/ogg': '.ogg',
  'application/ogg': '.ogg',
};
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const MAX_BATCH = 50;

// Roblox rate-limits audio hard, and a burst that trips it wastes the whole
// batch rather than slowing it down. Two at a time, backing off on a 429.
const CONCURRENCY = 2;

const OPEN_CLOUD = 'https://apis.roblox.com/assets/v1';

// ── The credential ────────────────────────────────────────────────
// One row in system_settings holding the sealed secret plus the un-secret parts
// (which kind it is, who it belongs to, when it was set).

async function readRecord() {
  const row = await prisma.systemSetting.findUnique({ where: { key: SETTING_KEY } });
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

/**
 * What the dev panel is allowed to know: everything except the secret. The value
 * is never returned by any path — not masked, not partially, not once. The
 * useful confirmation that the right credential is in place is which Roblox
 * account it resolves to, and that is what `verify` fills in.
 */
async function credentialStatus() {
  if (!secretBox.available()) {
    return { configured: false, sealingAvailable: false,
             error: 'Set JWT_SECRET (32+ characters) before storing a Roblox credential.' };
  }
  const rec = await readRecord();
  if (!rec) return { configured: false, sealingAvailable: true };
  return {
    configured: true,
    sealingAvailable: true,
    kind: rec.kind,
    creatorType: rec.creatorType || 'user',
    creatorId: rec.creatorId || null,
    updatedAt: rec.updatedAt || null,
    setByName: rec.setByName || null,
    account: rec.account || null,          // { id, name } from the last verify
    verifiedAt: rec.verifiedAt || null,
  };
}

/**
 * Store a credential. `kind` is 'apikey' or 'cookie'.
 *
 * A pasted .ROBLOSECURITY carries Roblox's own warning banner in front of it
 * (`_|WARNING:-DO-NOT-SHARE-THIS...|_`) and that banner is PART of the cookie —
 * stripping it, which is the obvious thing to do with text that looks like a
 * warning, produces a cookie that silently fails to authenticate. It is kept.
 */
async function setCredential({ kind, value, creatorType, creatorId, setBy }) {
  if (!secretBox.available()) throw new Error('Set JWT_SECRET (32+ characters) before storing a Roblox credential.');
  if (kind !== 'apikey' && kind !== 'cookie') throw new Error('Credential must be an API key or a cookie.');

  const raw = String(value || '').trim();
  if (!raw) throw new Error('Paste the credential first.');
  if (kind === 'cookie' && raw.length < 100) {
    throw new Error('That does not look like a .ROBLOSECURITY cookie — it is several hundred characters and starts with _|WARNING.');
  }
  if (kind === 'apikey' && raw.length < 20) throw new Error('That does not look like an Open Cloud API key.');

  const ct = creatorType === 'group' ? 'group' : 'user';
  if (ct === 'group' && !/^\d+$/.test(String(creatorId || ''))) {
    throw new Error('Uploading to a group needs the group id.');
  }

  const rec = {
    kind,
    sealed: secretBox.seal(raw),
    creatorType: ct,
    creatorId: ct === 'group' ? String(creatorId) : (creatorId ? String(creatorId) : null),
    updatedAt: new Date().toISOString(),
    setByName: setBy || null,
    account: null,
    verifiedAt: null,
  };
  await prisma.systemSetting.upsert({
    where: { key: SETTING_KEY },
    update: { value: JSON.stringify(rec) },
    create: { key: SETTING_KEY, value: JSON.stringify(rec) },
  });
  return credentialStatus();
}

async function clearCredential() {
  await prisma.systemSetting.deleteMany({ where: { key: SETTING_KEY } });
  return { ok: true };
}

// The secret itself. Deliberately not exported.
async function useCredential() {
  const rec = await readRecord();
  if (!rec) throw new Error('No Roblox credential is set — add one in the panel above.');
  let value;
  try { value = secretBox.open(rec.sealed); }
  catch {
    throw new Error('The stored credential can no longer be read (JWT_SECRET changed?). Paste it again.');
  }
  return { ...rec, value };
}

/**
 * Prove the credential works and record which account it belongs to. For a
 * cookie that is authenticated.roblox.com; for an API key there is no "who am
 * I", so a cheap authorised call stands in — a 401/403 means the key is wrong or
 * unscoped, which is the thing worth knowing.
 */
async function verifyCredential() {
  const cred = await useCredential();

  if (cred.kind === 'cookie') {
    const res = await fetch('https://users.roblox.com/v1/users/authenticated', {
      headers: { Cookie: `.ROBLOSECURITY=${cred.value}` },
    });
    if (res.status === 401) return { ok: false, error: 'Roblox rejected the cookie — it has expired or been invalidated. Log in again and paste a fresh one.' };
    if (!res.ok) return { ok: false, error: `Roblox replied ${res.status} when checking the cookie.` };
    const me = await res.json().catch(() => null);
    if (!me || !me.id) return { ok: false, error: 'Roblox did not say who the cookie belongs to.' };
    await stampAccount({ id: String(me.id), name: me.name || me.displayName || null });
    return { ok: true, account: { id: String(me.id), name: me.name || me.displayName || null } };
  }

  // An API key has no identity endpoint. Asking the assets service for an
  // operation that cannot exist separates "key is fine" (404) from "key is
  // wrong or missing asset:write" (401/403).
  const res = await fetch(`${OPEN_CLOUD}/operations/00000000-0000-0000-0000-000000000000`, {
    headers: { 'x-api-key': cred.value },
  });
  if (res.status === 401) return { ok: false, error: 'Roblox rejected the API key. Check it was copied whole and has not been deleted.' };
  if (res.status === 403) return { ok: false, error: 'The API key is valid but not allowed to write assets — add the asset:write scope to it.' };
  await stampAccount(null);
  return { ok: true, account: null, note: 'Key accepted. Roblox does not name the account behind an API key.' };
}

async function stampAccount(account) {
  const rec = await readRecord();
  if (!rec) return;
  rec.account = account;
  rec.verifiedAt = new Date().toISOString();
  await prisma.systemSetting.update({ where: { key: SETTING_KEY }, data: { value: JSON.stringify(rec) } });
}

// ── Errors that must not carry the secret ─────────────────────────
// Roblox echoes request context in some failures, and a stack trace of a fetch
// can carry headers. Anything on its way to a browser, a log line or the audit
// trail goes through here first.
function scrub(text, ...secrets) {
  let s = String(text == null ? '' : text);
  for (const sec of secrets) {
    if (sec && String(sec).length > 8) s = s.split(String(sec)).join('[redacted]');
  }
  // Belt and braces: a Roblox cookie is recognisable on sight.
  s = s.replace(/_\|WARNING:[^\s"']{20,}/g, '[redacted]');
  return s.slice(0, 600);
}

// ── Upload ────────────────────────────────────────────────────────

function checkAudio({ fileName, mimeType, size }) {
  const name = String(fileName || '');
  const ext  = (name.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
  const byMime = AUDIO_MIME[String(mimeType || '').toLowerCase().split(';')[0]];
  if (!byMime && ext !== '.mp3' && ext !== '.ogg') {
    return 'Roblox only takes .mp3 and .ogg audio.';
  }
  if (!size) return 'The file is empty.';
  if (size > MAX_AUDIO_BYTES) {
    return `Too large at ${(size / 1024 / 1024).toFixed(1)} MB — Roblox caps audio at ${MAX_AUDIO_BYTES / 1024 / 1024} MB.`;
  }
  return null;
}

// A display name Roblox will accept: its own moderation rejects an empty one,
// and the file name is the obvious default.
function cleanName(displayName, fileName) {
  const base = String(displayName || '').trim()
    || String(fileName || '').replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim()
    || 'Audio';
  return base.slice(0, 50);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function retryAfterMs(res) {
  const h = Number(res.headers.get('retry-after'));
  return Number.isFinite(h) && h > 0 ? Math.min(h * 1000, 60000) : 5000;
}

/**
 * Open Cloud: multipart POST, then poll the operation it returns. The upload
 * itself only ever returns an operation — the asset id arrives later, which is
 * why nothing here can be a single request.
 */
async function uploadViaApiKey({ buffer, displayName, fileName, mimeType, creatorType, creatorId, apiKey }) {
  const creator = creatorType === 'group'
    ? { groupId: String(creatorId) }
    : { userId: String(creatorId) };

  const form = new FormData();
  form.append('request', JSON.stringify({
    assetType: 'Audio',
    displayName: cleanName(displayName, fileName),
    description: 'Uploaded from the MET dev panel',
    creationContext: { creator },
  }));
  form.append('fileContent', new Blob([buffer], { type: mimeType || 'audio/mpeg' }), fileName);

  let res = await fetch(`${OPEN_CLOUD}/assets`, { method: 'POST', headers: { 'x-api-key': apiKey }, body: form });
  if (res.status === 429) {
    await sleep(retryAfterMs(res));
    res = await fetch(`${OPEN_CLOUD}/assets`, { method: 'POST', headers: { 'x-api-key': apiKey }, body: form });
  }

  const bodyText = await res.text();
  if (!res.ok) {
    const msg = (() => { try { const j = JSON.parse(bodyText); return j.message || j.error || bodyText; } catch { return bodyText; } })();
    throw new Error(`Roblox refused the upload (${res.status}): ${scrub(msg, apiKey)}`);
  }
  const started = (() => { try { return JSON.parse(bodyText); } catch { return null; } })();
  const operationId = started && (started.operationId || String(started.path || '').split('/').pop());
  if (!operationId) throw new Error('Roblox accepted the upload but did not return an operation to follow.');

  // Roblox finishes an audio in seconds when it finishes at all. Give it two
  // minutes, then say so rather than hanging — the operation id is kept, so it
  // can be followed up.
  const deadline = Date.now() + 120000;
  let wait = 1000;
  while (Date.now() < deadline) {
    await sleep(wait);
    wait = Math.min(wait * 1.4, 6000);
    const op = await fetch(`${OPEN_CLOUD}/operations/${operationId}`, { headers: { 'x-api-key': apiKey } });
    if (op.status === 429) { await sleep(retryAfterMs(op)); continue; }
    if (!op.ok) continue;
    const j = await op.json().catch(() => null);
    if (!j) continue;
    if (j.error) throw new Error(`Roblox rejected the audio: ${scrub(j.error.message || JSON.stringify(j.error), apiKey)}`);
    if (j.done) {
      const id = j.response && (j.response.assetId || j.response.id);
      if (!id) throw new Error('Roblox finished the upload without returning an asset id.');
      return { assetId: String(id), operationId };
    }
  }
  return { assetId: null, operationId, pending: true };
}

/**
 * Cookie: the legacy publish endpoint, which returns the asset id directly.
 * Needs an X-CSRF-TOKEN, which Roblox only hands out in the 403 it sends when
 * you ask without one — so the first call is expected to fail and is not an
 * error.
 */
let _csrf = null;
async function csrfToken(cookie) {
  if (_csrf) return _csrf;
  const res = await fetch('https://auth.roblox.com/v2/logout', {
    method: 'POST', headers: { Cookie: `.ROBLOSECURITY=${cookie}`, 'Content-Length': '0' },
  });
  const t = res.headers.get('x-csrf-token');
  if (!t) throw new Error('Roblox would not issue a CSRF token — the cookie is probably expired.');
  _csrf = t;
  return t;
}

async function uploadViaCookie({ buffer, displayName, fileName, creatorType, creatorId, cookie }) {
  const name = cleanName(displayName, fileName);
  const send = async (token) => fetch('https://publish.roblox.com/v1/audio', {
    method: 'POST',
    headers: {
      Cookie: `.ROBLOSECURITY=${cookie}`,
      'X-CSRF-TOKEN': token,
      'Content-Type': 'application/json',
      'User-Agent': 'Roblox/WinInet',
    },
    body: JSON.stringify({
      name,
      file: buffer.toString('base64'),
      groupId: creatorType === 'group' ? Number(creatorId) : 0,
    }),
  });

  let res = await send(await csrfToken(cookie));
  // A stale token comes back as a 403 carrying a fresh one.
  if (res.status === 403) {
    const fresh = res.headers.get('x-csrf-token');
    if (fresh) { _csrf = fresh; res = await send(fresh); }
  }
  if (res.status === 429) { await sleep(retryAfterMs(res)); res = await send(_csrf); }

  const text = await res.text();
  if (!res.ok) {
    const msg = (() => { try { const j = JSON.parse(text); return j.message || (j.errors && j.errors[0] && j.errors[0].message) || text; } catch { return text; } })();
    if (res.status === 401) throw new Error('Roblox rejected the cookie — it has expired. Paste a fresh one.');
    throw new Error(`Roblox refused the upload (${res.status}): ${scrub(msg, cookie)}`);
  }
  const j = (() => { try { return JSON.parse(text); } catch { return null; } })();
  // The field has been spelled several ways across versions of this endpoint.
  const id = j && (j.assetId || j.AssetId || j.Id || j.id);
  if (!id) throw new Error('Roblox accepted the upload but did not return an asset id.');
  return { assetId: String(id), operationId: null };
}

/**
 * Everything that is wrong with the SETUP rather than with a file — no
 * credential, or an Open Cloud key with nobody to attribute the asset to.
 * Checked once for a whole batch, because it is the same answer for every file
 * and because discovering it per-file used to abort the batch partway through.
 */
function credentialProblem(cred) {
  // Open Cloud insists on a creator. A cookie knows the account implicitly; a
  // key does not, and Roblox will not guess.
  if (cred.kind === 'apikey' && (cred.creatorType || 'user') === 'user' && !cred.creatorId) {
    return 'Set the Roblox user id that owns the API key — Open Cloud will not guess it.';
  }
  return null;
}

/**
 * Upload one audio and record it. Returns the ledger row. Never throws for a
 * Roblox-side refusal — that is written to the row as a failure, so one bad file
 * in a batch of forty does not lose the other thirty-nine.
 */
async function uploadAudio({ buffer, displayName, fileName, mimeType, uploadedById }) {
  const cred = await useCredential();
  const creatorType = cred.creatorType || 'user';
  let creatorId = cred.creatorId;

  const setup = credentialProblem(cred);
  if (setup) throw new Error(setup);

  const row = await prisma.robloxUpload.create({
    data: {
      displayName: cleanName(displayName, fileName),
      fileName: String(fileName || 'audio'),
      mimeType: String(mimeType || 'audio/mpeg'),
      size: buffer.length,
      status: 'UPLOADING',
      via: cred.kind,
      creatorType,
      creatorId: creatorId ? String(creatorId) : null,
      uploadedById: uploadedById || null,
    },
  });

  try {
    const out = cred.kind === 'apikey'
      ? await uploadViaApiKey({ buffer, displayName, fileName, mimeType, creatorType, creatorId, apiKey: cred.value })
      : await uploadViaCookie({ buffer, displayName, fileName, creatorType, creatorId, cookie: cred.value });

    return prisma.robloxUpload.update({
      where: { id: row.id },
      data: {
        assetId: out.assetId || null,
        operationId: out.operationId || null,
        status: out.assetId ? 'DONE' : 'PENDING',
        error: out.pending ? 'Roblox is still processing this one — check back shortly.' : null,
        finishedAt: out.assetId ? new Date() : null,
      },
    });
  } catch (e) {
    // Scrubbed twice over: once by the thrower, once here, because a stack from
    // fetch can carry the header it was called with.
    const msg = scrub(e.message || String(e), cred.value);
    console.error('[RobloxUpload] failed:', msg);
    return prisma.robloxUpload.update({
      where: { id: row.id },
      data: { status: 'FAILED', error: msg, finishedAt: new Date() },
    });
  }
}

/**
 * A batch, two at a time. Files that fail validation never reach Roblox and are
 * reported as rejected without a ledger row — nothing was uploaded, so there is
 * nothing to record.
 */
async function uploadBatch(files, { uploadedById } = {}) {
  const list = (Array.isArray(files) ? files : []).slice(0, MAX_BATCH);
  if (!list.length) throw new Error('No audio to upload.');

  // Anything wrong with the setup is wrong for every file, so it is settled
  // before a single one is sent. Finding it halfway through a batch of forty
  // used to abandon the rest.
  const cred = await useCredential();
  const setup = credentialProblem(cred);
  if (setup) throw new Error(setup);

  const rejected = [];
  const queue = [];
  // `at` is the file's position in what the caller sent. Two files can share a
  // name, so the caller cannot match results back by name — the position is what
  // identifies them.
  list.forEach((f, at) => {
    const buffer = toBuffer(f.data);
    if (!buffer) { rejected.push({ at, fileName: f.fileName || 'unknown', error: 'Could not read the file.' }); return; }
    const bad = checkAudio({ fileName: f.fileName, mimeType: f.mimeType, size: buffer.length });
    if (bad) { rejected.push({ at, fileName: f.fileName || 'unknown', error: bad }); return; }
    queue.push({ ...f, buffer, at });
  });

  // Written by position, not pushed. Two uploads run at once, so completion order
  // is not input order, and a caller lining results up against what it sent would
  // attribute each result to the wrong file.
  const done = new Array(queue.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      const slot = cursor++;
      const f = queue[slot];
      // A worker that throws takes every file still queued behind it with it, so
      // it is not allowed to. uploadAudio already writes Roblox refusals to the
      // row; this is for the unforeseen — a database blip, a bad buffer.
      try {
        const row = await uploadAudio({
          buffer: f.buffer, displayName: f.displayName, fileName: f.fileName,
          mimeType: f.mimeType, uploadedById,
        });
        done[slot] = { ...row, at: f.at };
      } catch (e) {
        rejected.push({ at: f.at, fileName: f.fileName || 'unknown', error: scrub(e.message || String(e), cred.value) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));

  const rows = done.filter(Boolean);
  return {
    uploaded: rows.filter(r => r.status === 'DONE').length,
    failed: rows.filter(r => r.status === 'FAILED').length,
    pending: rows.filter(r => r.status === 'PENDING').length,
    rejected: rejected.sort((a, b) => a.at - b.at),
    rows,
  };
}

// Accepts a base64 string, a data: URL, or an already-decoded buffer.
function toBuffer(data) {
  if (!data) return null;
  if (Buffer.isBuffer(data)) return data;
  const s = String(data);
  const b64 = s.startsWith('data:') ? s.slice(s.indexOf(',') + 1) : s;
  try {
    const b = Buffer.from(b64, 'base64');
    return b.length ? b : null;
  } catch { return null; }
}

/**
 * Follow up anything Roblox had not finished when we stopped waiting. Cheap, so
 * the panel calls it whenever it loads the list.
 */
async function refreshPending() {
  const stuck = await prisma.robloxUpload.findMany({
    where: { status: 'PENDING', operationId: { not: null } },
    take: 25,
  });
  if (!stuck.length) return { checked: 0, resolved: 0 };

  let cred;
  try { cred = await useCredential(); } catch { return { checked: 0, resolved: 0 }; }
  if (cred.kind !== 'apikey') return { checked: 0, resolved: 0 };

  let resolved = 0;
  for (const row of stuck) {
    try {
      const op = await fetch(`${OPEN_CLOUD}/operations/${row.operationId}`, { headers: { 'x-api-key': cred.value } });
      if (!op.ok) continue;
      const j = await op.json().catch(() => null);
      if (!j || !j.done) continue;
      if (j.error) {
        await prisma.robloxUpload.update({ where: { id: row.id },
          data: { status: 'FAILED', error: scrub(j.error.message || 'Rejected by Roblox.', cred.value), finishedAt: new Date() } });
        continue;
      }
      const id = j.response && (j.response.assetId || j.response.id);
      if (!id) continue;
      await prisma.robloxUpload.update({ where: { id: row.id },
        data: { assetId: String(id), status: 'DONE', error: null, finishedAt: new Date() } });
      resolved++;
    } catch { /* try again next load */ }
  }
  return { checked: stuck.length, resolved };
}

async function listUploads({ take = 200 } = {}) {
  return prisma.robloxUpload.findMany({
    orderBy: { createdAt: 'desc' },
    take: Math.min(Number(take) || 200, 500),
    select: {
      id: true, displayName: true, fileName: true, size: true, assetId: true,
      status: true, error: true, via: true, creatorType: true, creatorId: true,
      createdAt: true, finishedAt: true,
      uploadedBy: { select: { displayName: true, discordUsername: true } },
    },
  });
}

async function clearUploads() {
  const { count } = await prisma.robloxUpload.deleteMany({});
  return { cleared: count };
}

module.exports = {
  SETTING_KEY, MAX_AUDIO_BYTES, MAX_BATCH, AUDIO_MIME,
  credentialStatus, setCredential, clearCredential, verifyCredential,
  checkAudio, cleanName, scrub, toBuffer,
  uploadAudio, uploadBatch, refreshPending, listUploads, clearUploads,
};
