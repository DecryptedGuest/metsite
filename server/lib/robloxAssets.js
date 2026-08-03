// server/lib/robloxAssets.js — push audio to Roblox and hand back the asset ids.
//
// Two ways in, because Roblox has two:
//
//   apikey  Open Cloud (apis.roblox.com/assets/v1). An API key created in the
//           Creator Dashboard's Credentials section with the Assets API granted
//           Read AND Write. Supported, documented, revocable on its own, and it
//           cannot log into the account or read anything else. This is the one to
//           use. Note the allowance is much tighter here than through Studio: 10
//           audio a month unverified, 100 ID-verified.
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

// Roblox takes .mp3, .ogg, .wav and .flac. It also rejects anything over 7
// minutes, above 48 kHz, or with more channels than 5.1 — none of which can be
// known without decoding the file, so those are left to Roblox to refuse and its
// message is passed through verbatim.
//
// The content type has to be one Roblox names, because Open Cloud reads it off
// the multipart part. Browsers do not agree on what an mp3 is — 'audio/mp3' and
// 'application/ogg' both turn up — so the extension decides and the browser's
// guess is only a fallback.
const AUDIO_TYPES = {
  '.mp3':  'audio/mpeg',
  '.ogg':  'audio/ogg',
  '.wav':  'audio/wav',
  '.flac': 'audio/flac',
};
// What a browser might call each of those, mapped to the extension Roblox knows.
const MIME_TO_EXT = {
  'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/mpeg3': '.mp3', 'audio/x-mpeg-3': '.mp3',
  'audio/ogg': '.ogg', 'application/ogg': '.ogg', 'audio/vorbis': '.ogg',
  'audio/wav': '.wav', 'audio/wave': '.wav', 'audio/x-wav': '.wav', 'audio/vnd.wave': '.wav',
  'audio/flac': '.flac', 'audio/x-flac': '.flac',
};
// "Less than 20 MB" in Roblox's wording, so 20 MB exactly is over the line.
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const MAX_BATCH = 50;

// The extension Roblox will recognise, from the file name first and the browser's
// content type second. Null when it is not audio Roblox takes.
function audioExt({ fileName, mimeType }) {
  const byName = (String(fileName || '').match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
  if (AUDIO_TYPES[byName]) return byName;
  return MIME_TO_EXT[String(mimeType || '').toLowerCase().split(';')[0].trim()] || null;
}

// The content type to put on the part — always one of Roblox's four, never the
// browser's spelling.
function audioContentType(file) {
  const ext = audioExt(file);
  return ext ? AUDIO_TYPES[ext] : 'audio/mpeg';
}

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
  // The cached CSRF token belongs to the session that issued it, so a new
  // credential must not inherit it.
  forgetCsrf();
  return credentialStatus();
}

async function clearCredential() {
  await prisma.systemSetting.deleteMany({ where: { key: SETTING_KEY } });
  forgetCsrf();
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
 * Prove the credential works and record which account it belongs to.
 *
 * For a cookie that is users.roblox.com/v1/users/authenticated. For an API key it
 * is the introspection endpoint, which is the only way to establish the thing that
 * actually matters: whether the key may WRITE assets. Merely calling a read
 * endpoint proves asset:read, so a key created with Read but not Write passed the
 * old check and then failed on the first upload — the worst possible order to
 * find out.
 *
 * Introspection also names the account, which means the Roblox user id no longer
 * has to be typed in by hand.
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
    const account = { id: String(me.id), name: me.name || me.displayName || null };
    await stampAccount(account);
    return { ok: true, account, quota: await audioQuota(cred).catch(() => null) };
  }

  // The key goes in the BODY here, not the x-api-key header.
  const res = await fetch('https://apis.roblox.com/api-keys/v1/introspect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: cred.value }),
  });

  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: 'Roblox rejected the API key. Check it was copied whole, has not been deleted or expired, and — if it restricts IP addresses — that this server\'s address is on its list.' };
  }
  if (!res.ok) {
    // Introspection is not load-bearing enough to fail the whole credential over.
    // Fall back to proving the key is at least accepted by the assets service.
    const probe = await fetch(`${OPEN_CLOUD}/operations/00000000-0000-0000-0000-000000000000`, {
      headers: { 'x-api-key': cred.value },
    });
    if (probe.status === 401 || probe.status === 403) {
      return { ok: false, error: 'Roblox rejected the API key.' };
    }
    await stampAccount(null);
    return { ok: true, account: null,
             note: 'Accepted, but Roblox would not describe the key, so whether it may upload could not be confirmed.' };
  }

  const info = await res.json().catch(() => null) || {};
  if (info.enabled === false) return { ok: false, error: 'That API key is disabled. Enable it, or create a new one.' };
  if (info.expired === true)  return { ok: false, error: 'That API key has expired. Keys also expire after 60 days unused — create a new one.' };

  // scopes: [{ name: 'asset', operations: ['read','write'], userIds, groupIds }]
  const scopes = Array.isArray(info.scopes) ? info.scopes : [];
  const assetScope = scopes.find(s => String(s && s.name).toLowerCase() === 'asset');
  const ops = (assetScope && Array.isArray(assetScope.operations) ? assetScope.operations : []).map(o => String(o).toLowerCase());
  if (!assetScope) {
    return { ok: false, error: 'That key has no Assets permission at all — add Assets with Read and Write to it.' };
  }
  if (!ops.includes('write')) {
    return { ok: false, error: 'That key can read assets but not create them — add the Write permission to its Assets entry.' };
  }

  const account = info.authorizedUserId
    ? { id: String(info.authorizedUserId), name: info.name || null }
    : null;
  await stampAccount(account);
  // Uploading needs a creator, and the key just told us who it is — so it no
  // longer has to be typed in.
  if (account && !cred.creatorId && (cred.creatorType || 'user') === 'user') {
    await stampCreatorId(account.id);
  }
  return {
    ok: true, account,
    scopes: ops,
    note: account ? null : 'Accepted, though Roblox did not name the account behind it.',
    quota: await audioQuota(cred).catch(() => null),
  };
}

/**
 * How much of the audio allowance is left. The monthly quota is the ceiling
 * people actually hit, and through the API it is far tighter than the figure most
 * Roblox documentation quotes: 10 uploads a month without ID verification and 100
 * with it, against 100/2,000 for uploading through Studio. Finding that out by
 * having a batch of forty fail on the eleventh is the expensive way.
 *
 * Best-effort: the endpoints are beta on one path and undocumented on the other,
 * so a failure here is never a failure of the credential.
 */
async function audioQuota(cred) {
  if (cred.kind === 'cookie') {
    const res = await fetch('https://publish.roblox.com/v1/asset-quotas?resourceType=1&assetType=3', {
      headers: { Cookie: `.ROBLOSECURITY=${cred.value}` },
    });
    if (!res.ok) return null;
    const j = await res.json().catch(() => null);
    const q = j && (Array.isArray(j.quotas) ? j.quotas[0] : (Array.isArray(j) ? j[0] : j));
    if (!q) return null;
    const capacity = q.capacity != null ? Number(q.capacity) : null;
    const usage    = q.usage != null ? Number(q.usage) : null;
    if (capacity == null) return null;
    return { capacity, usage, remaining: usage == null ? null : Math.max(0, capacity - usage),
             resetsAt: q.expirationTime || q.usageResetTime || null };
  }

  const userId = cred.creatorId;
  if (!userId || (cred.creatorType || 'user') !== 'user') return null;
  const url = `https://apis.roblox.com/cloud/v2/users/${encodeURIComponent(userId)}/asset-quotas`
            + '?filter=' + encodeURIComponent('quotaType == RateLimitUpload && assetType == Audio');
  const res = await fetch(url, { headers: { 'x-api-key': cred.value } });
  if (!res.ok) return null;
  const j = await res.json().catch(() => null);
  const q = j && Array.isArray(j.assetQuotas) ? j.assetQuotas[0] : null;
  if (!q || q.capacity == null) return null;
  return { capacity: Number(q.capacity), usage: q.usage != null ? Number(q.usage) : null,
           remaining: q.usage == null ? null : Math.max(0, Number(q.capacity) - Number(q.usage)),
           resetsAt: q.usageResetTime || null, period: q.period || null };
}

async function stampAccount(account) {
  const rec = await readRecord();
  if (!rec) return;
  rec.account = account;
  rec.verifiedAt = new Date().toISOString();
  await prisma.systemSetting.update({ where: { key: SETTING_KEY }, data: { value: JSON.stringify(rec) } });
}

// Introspection names the account behind an API key, so the Roblox user id does
// not have to be typed in — it is filled in from what Roblox said.
async function stampCreatorId(id) {
  const rec = await readRecord();
  if (!rec || rec.creatorId) return;
  rec.creatorId = String(id);
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
  if (!audioExt({ fileName, mimeType })) {
    return 'Roblox takes .mp3, .ogg, .wav and .flac audio.';
  }
  if (!size) return 'The file is empty.';
  // Roblox's wording is "less than 20 MB", so exactly 20 MB is over.
  if (size >= MAX_AUDIO_BYTES) {
    return `Too large at ${(size / 1024 / 1024).toFixed(1)} MB — Roblox needs audio under ${MAX_AUDIO_BYTES / 1024 / 1024} MB.`;
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

/**
 * How long to wait after a 429. Roblox describes retry-after as a guideline and
 * asks for exponential backoff when it is absent — a flat delay is not what it
 * wants, and x-ratelimit-reset is the better signal when retry-after is missing.
 *
 * `attempt` is 1-based.
 */
function retryAfterMs(res, attempt = 1) {
  const after = Number(res.headers.get('retry-after'));
  if (Number.isFinite(after) && after > 0) return Math.min(after * 1000, 60000);
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) return Math.min(reset * 1000, 60000);
  return Math.min(1000 * Math.pow(2, Math.max(0, attempt - 1)), 60000);
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
  // The part's content type has to be one of the four Roblox names, not whatever
  // the browser guessed — 'audio/mp3' is a common browser spelling and not one
  // Roblox accepts, which comes back as an unhelpful parse failure.
  form.append('fileContent', new Blob([buffer], { type: audioContentType({ fileName, mimeType }) }), fileName);

  const post = () => fetch(`${OPEN_CLOUD}/assets`, { method: 'POST', headers: { 'x-api-key': apiKey }, body: form });
  let res = await post();
  // Backing off properly rather than once: rate limits here are pooled per
  // account across every key it owns, so a second key buys no headroom and
  // waiting is the only answer.
  for (let attempt = 1; res.status === 429 && attempt <= 3; attempt++) {
    await sleep(retryAfterMs(res, attempt));
    res = await post();
  }

  const bodyText = await res.text();
  if (!res.ok) {
    const msg = (() => { try { const j = JSON.parse(bodyText); return j.message || j.error || bodyText; } catch { return bodyText; } })();
    // The monthly allowance is the ceiling people actually hit, and it is far
    // tighter on this path than the figure most Roblox documentation quotes.
    if (res.status === 429 || /quota|limit/i.test(msg)) {
      throw new Error('Roblox says the monthly audio allowance for this account is used up. '
        + 'Through the API it is 10 uploads a month without ID verification, 100 with it. '
        + 'Verifying the account raises it; nothing else will upload until it resets. '
        + `(Roblox said: ${scrub(msg, apiKey)})`);
    }
    throw new Error(`Roblox refused the upload (${res.status}): ${scrub(msg, apiKey)}`);
  }
  const started = (() => { try { return JSON.parse(bodyText); } catch { return null; } })();
  // Documented as { "path": "operations/<id>" } and nothing else. A top-level
  // operationId is not part of the contract, so it is read only as a fallback
  // rather than preferred — preferring it would silently win if Roblox ever added
  // an unrelated field by that name.
  const operationId = started && (String(started.path || '').split('/').filter(Boolean).pop() || started.operationId);
  if (!operationId) throw new Error('Roblox accepted the upload but did not return an operation to follow.');

  // Roblox finishes an audio in seconds when it finishes at all. Give it two
  // minutes, then say so rather than hanging — the operation id is kept, so it
  // can be followed up.
  const deadline = Date.now() + 120000;
  let wait = 1000, throttled = 0;
  while (Date.now() < deadline) {
    await sleep(wait);
    wait = Math.min(wait * 1.4, 6000);
    const op = await fetch(`${OPEN_CLOUD}/operations/${encodeURIComponent(operationId)}`, { headers: { 'x-api-key': apiKey } });
    if (op.status === 429) { await sleep(retryAfterMs(op, ++throttled)); continue; }
    if (!op.ok) continue;
    const j = await op.json().catch(() => null);
    if (!j) continue;
    if (j.error) throw new Error(`Roblox rejected the audio: ${scrub(j.error.message || JSON.stringify(j.error), apiKey)}`);
    if (j.done) {
      const out = assetFromOperation(j);
      if (!out.assetId) throw new Error('Roblox finished the upload without returning an asset id.');
      return { ...out, operationId };
    }
  }
  return { assetId: null, operationId, pending: true };
}

/**
 * The asset id and its moderation state out of a finished operation.
 *
 * `done: true` only means the upload pipeline finished. Roblox queues every audio
 * for moderation, so an id can come back for something still being reviewed or
 * already rejected — calling that "uploaded" hands over an id that will not play.
 * There is no `response.id`; it is `assetId`, with `path` ("assets/123") as the
 * only other place the number appears.
 */
function assetFromOperation(j) {
  const a = (j && j.response) || {};
  const assetId = a.assetId
    || (String(a.path || '').startsWith('assets/') ? String(a.path).split('/')[1] : null)
    || null;
  const state = String((a.moderationResult && a.moderationResult.moderationState) || '')
    .toUpperCase().replace(/^MODERATION_STATE_/, '');
  return {
    assetId: assetId ? String(assetId) : null,
    moderation: state || null,   // APPROVED | REVIEWING | REJECTED
  };
}

/**
 * Cookie: the legacy publish endpoint, which returns the asset id directly.
 *
 * It needs an X-CSRF-TOKEN, and the endpoint issues one itself: asking without a
 * token comes back 403 carrying a fresh one in the response header. So the first
 * attempt is EXPECTED to be refused and that is not an error — the refusal is
 * where the token comes from.
 *
 * There is a widespread habit of warming the token up against
 * auth.roblox.com/v2/logout instead. That does not log the session out (CSRF is
 * checked before the logout runs, and no token is ever sent), but pointing a
 * credential-storing feature at a logout endpoint to obtain a token is a bad
 * trade when the endpoint being used hands one over anyway. So it is not done.
 *
 * The token is per-session, so it is dropped whenever the credential changes.
 */
let _csrf = null;
function forgetCsrf() { _csrf = null; }

async function uploadViaCookie({ buffer, displayName, fileName, creatorType, creatorId, cookie }) {
  const name = cleanName(displayName, fileName);
  const body = JSON.stringify({
    name,
    file: buffer.toString('base64'),
    // Omitted entirely for a user upload. A literal 0 is not a documented "no
    // group" value and risks being read as group id 0.
    ...(creatorType === 'group' ? { groupId: Number(creatorId) } : {}),
    // Free to supply and it saves Roblox guessing: the size before base64.
    estimatedFileSize: buffer.length,
  });

  const send = async (token) => fetch('https://publish.roblox.com/v1/audio', {
    method: 'POST',
    headers: {
      Cookie: `.ROBLOSECURITY=${cookie}`,
      'Content-Type': 'application/json',
      // Only sent once there is one. The first call deliberately goes without.
      ...(token ? { 'X-CSRF-TOKEN': token } : {}),
    },
    body,
  });

  let res = await send(_csrf);
  // The 403 that carries a token is the normal first response, not a failure.
  if (res.status === 403) {
    const fresh = res.headers.get('x-csrf-token');
    if (fresh) { _csrf = fresh; res = await send(fresh); }
  }

  // Read once. A body can only be consumed once, so deciding whether a 429 is
  // worth retrying has to happen off the text we already have rather than a
  // second read of the same response.
  let text = await res.text();

  if (res.status === 429) {
    // 429 is used for two unrelated things here. A rate limit is worth waiting
    // out; the monthly audio allowance is not — sleeping and retrying burns the
    // wait and fails again, having said nothing useful.
    if (/quota/i.test(text)) {
      throw new Error('Roblox says the audio upload allowance for this account is used up. '
        + 'Nothing more will upload until it resets. ID-verifying the account raises the allowance.');
    }
    await sleep(retryAfterMs(res));
    res = await send(_csrf);
    text = await res.text();
  }
  if (!res.ok) {
    const msg = (() => { try { const j = JSON.parse(text); return j.message || (j.errors && j.errors[0] && j.errors[0].message) || text; } catch { return text; } })();
    if (res.status === 401) throw new Error('Roblox rejected the cookie — it has expired. Paste a fresh one.');
    // Roblox's challenge system also answers 403, and no amount of token
    // refreshing will ever satisfy it from a server.
    if (res.status === 403 && (res.headers.get('rblx-challenge-id') || /challenge/i.test(msg))) {
      throw new Error('Roblox is asking for a challenge (captcha) on this account, which cannot be answered from here. '
        + 'An Open Cloud API key is not subject to this — switch to one.');
    }
    if (/quota/i.test(msg)) {
      throw new Error('Roblox says the audio upload allowance for this account is used up: ' + scrub(msg, cookie));
    }
    if (/moderated/i.test(msg)) {
      throw new Error(`Roblox rejected the NAME, not the audio: ${scrub(msg, cookie)} — rename it and try again.`);
    }
    throw new Error(`Roblox refused the upload (${res.status}): ${scrub(msg, cookie)}`);
  }
  const j = (() => { try { return JSON.parse(text); } catch { return null; } })();
  // This endpoint answers in PascalCase. The other spellings are belt and braces.
  const id = j && (j.Id || j.assetId || j.AssetId || j.id);
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
        moderation: out.moderation || null,
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
 * Follow up anything Roblox had not settled when we stopped waiting. Cheap, so
 * the panel calls it whenever it loads the list.
 *
 * Two kinds of unsettled: an operation that had not finished, and one that had
 * finished with the audio still in review. The second is easy to forget —
 * "uploaded" is a finished state as far as the upload goes, but a REVIEWING row
 * that is never looked at again shows "In review" forever even after Roblox has
 * approved it.
 */
async function refreshPending() {
  const stuck = await prisma.robloxUpload.findMany({
    where: {
      operationId: { not: null },
      OR: [
        { status: 'PENDING' },
        { status: 'DONE', moderation: 'REVIEWING' },
      ],
    },
    take: 25,
  });
  if (!stuck.length) return { checked: 0, resolved: 0 };

  let cred;
  try { cred = await useCredential(); } catch { return { checked: 0, resolved: 0 }; }
  if (cred.kind !== 'apikey') return { checked: 0, resolved: 0 };

  let resolved = 0;
  for (const row of stuck) {
    try {
      const op = await fetch(`${OPEN_CLOUD}/operations/${encodeURIComponent(row.operationId)}`, { headers: { 'x-api-key': cred.value } });
      if (!op.ok) continue;
      const j = await op.json().catch(() => null);
      if (!j || !j.done) continue;
      if (j.error) {
        await prisma.robloxUpload.update({ where: { id: row.id },
          data: { status: 'FAILED', error: scrub(j.error.message || 'Rejected by Roblox.', cred.value), finishedAt: new Date() } });
        continue;
      }
      const out = assetFromOperation(j);
      if (!out.assetId) continue;
      // Nothing changed for a row that is still in review — don't count it as
      // resolved, or "resolved" stops meaning anything.
      if (row.status === 'DONE' && out.moderation === row.moderation) continue;
      await prisma.robloxUpload.update({ where: { id: row.id },
        data: { assetId: out.assetId, status: 'DONE', moderation: out.moderation || null,
                error: null, finishedAt: row.finishedAt || new Date() } });
      resolved++;
    } catch { /* try again next load */ }
  }
  return { checked: stuck.length, resolved };
}

/**
 * The remaining allowance for whatever credential is stored. Wraps audioQuota so
 * a caller never has to hold the decrypted credential to ask — that stays in
 * here, which is the whole point.
 */
async function currentQuota() {
  try { return await audioQuota(await useCredential()); }
  catch { return null; }
}

async function listUploads({ take = 200 } = {}) {
  return prisma.robloxUpload.findMany({
    orderBy: { createdAt: 'desc' },
    take: Math.min(Number(take) || 200, 500),
    select: {
      id: true, displayName: true, fileName: true, size: true, assetId: true,
      status: true, moderation: true, error: true, via: true, creatorType: true, creatorId: true,
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
  SETTING_KEY, MAX_AUDIO_BYTES, MAX_BATCH, AUDIO_TYPES, MIME_TO_EXT,
  credentialStatus, setCredential, clearCredential, verifyCredential, audioQuota, currentQuota,
  checkAudio, cleanName, scrub, toBuffer, audioExt, audioContentType,
  assetFromOperation, forgetCsrf,
  uploadAudio, uploadBatch, refreshPending, listUploads, clearUploads,
};
