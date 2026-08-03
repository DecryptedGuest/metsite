// client/public/js/roblox-audio.js — the dev panel's Roblox audio uploader.
// Developer-only; every route it calls is gated server-side as well, so hiding
// the nav item is presentation, not protection.
//
// The credential is write-only from here. Nothing on this page ever receives it
// back, so there is no state holding it and no field to accidentally re-render
// it into — after a save the textarea is cleared and stays that way.

let raKind  = 'apikey';
let raQueue = [];        // [{ file, name }]
let raCred  = null;

const RA_MAX_MB = 20;
const RA_EXTS = ['.mp3', '.ogg', '.wav', '.flac'];

// ── Credential ────────────────────────────────────────────────────

function raSetKind(kind) {
  raKind = kind === 'cookie' ? 'cookie' : 'apikey';
  document.querySelectorAll('#ra-kind .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.kind === raKind));
  const ak = document.getElementById('ra-help-apikey');
  const ck = document.getElementById('ra-help-cookie');
  if (ak) ak.style.display = raKind === 'apikey' ? '' : 'none';
  if (ck) ck.style.display = raKind === 'cookie' ? '' : 'none';
  const lbl = document.getElementById('ra-value-label');
  if (lbl) lbl.textContent = raKind === 'apikey' ? 'API key' : '.ROBLOSECURITY cookie';
  const val = document.getElementById('ra-value');
  if (val) val.placeholder = raKind === 'apikey' ? 'Paste the API key' : 'Paste the whole value, starting _|WARNING:';
  raCreatorChanged();
}

// A cookie already knows whose account it is; an Open Cloud key does not, so the
// user id is only required on that path.
function raCreatorChanged() {
  const type = (document.getElementById('ra-creator-type') || {}).value || 'user';
  const lbl  = document.getElementById('ra-creator-id-label');
  const hint = document.getElementById('ra-creator-hint');
  const inp  = document.getElementById('ra-creator-id');
  if (type === 'group') {
    if (lbl)  lbl.textContent = 'Group ID';
    if (hint) hint.textContent = 'The numeric ID from the group URL. The account must be allowed to upload for it.';
    if (inp)  inp.placeholder = 'e.g. 35243452';
  } else {
    if (lbl)  lbl.textContent = 'Roblox user ID';
    if (inp)  inp.placeholder = 'e.g. 1234567';
    if (hint) hint.textContent = raKind === 'apikey'
      ? 'Leave blank — testing the key fills this in from Roblox. Only needed if that cannot be read.'
      : 'Not needed for a cookie — it already knows the account.';
  }
}

async function loadRobloxAudio() {
  raSetKind(raKind);
  await raLoadCredential();
  await raLoadUploads();
  raWireDrop();
}

async function raLoadCredential() {
  const state = document.getElementById('ra-cred-state');
  const sum   = document.getElementById('ra-cred-summary');
  const clr   = document.getElementById('ra-clear-btn');
  try {
    raCred = await api('/api/dev/roblox/credential');
  } catch (e) {
    if (state) state.textContent = 'Unavailable';
    return;
  }

  if (raCred.sealingAvailable === false) {
    if (state) state.innerHTML = '<span style="color:var(--red);">Cannot store secrets</span>';
    if (sum) {
      sum.style.display = '';
      sum.innerHTML = `<div style="border-left:3px solid var(--red);background:rgba(239,68,68,0.07);border-radius:6px;padding:11px 14px;font-size:13px;">
        ${escapeHtml(raCred.error || 'JWT_SECRET must be set before a credential can be stored.')}</div>`;
    }
    ['ra-save-btn', 'ra-verify-btn'].forEach(id => { const b = document.getElementById(id); if (b) b.disabled = true; });
    return;
  }

  if (clr) clr.style.display = raCred.configured ? '' : 'none';

  if (!raCred.configured) {
    if (state) state.innerHTML = '<span style="color:var(--text-secondary);">Not set</span>';
    if (sum) sum.style.display = 'none';
    raRenderQuota(null);
    return;
  }

  raSetKind(raCred.kind);
  const ct = document.getElementById('ra-creator-type');
  if (ct) { ct.value = raCred.creatorType || 'user'; }
  const ci = document.getElementById('ra-creator-id');
  if (ci && raCred.creatorId) ci.value = raCred.creatorId;
  raCreatorChanged();

  raRenderQuota(raCred.quota);

  if (state) state.innerHTML = `<span style="color:var(--green);"><i class="ti ti-lock"></i> Stored (encrypted)</span>`;
  if (sum) {
    const acct = raCred.account
      ? `${escapeHtml(raCred.account.name || 'account')} <span class="mono" style="font-size:11px;color:var(--text-muted);">(${escapeHtml(raCred.account.id)})</span>`
      : '<span style="color:var(--text-secondary);">not named by Roblox</span>';
    const owner = raCred.creatorType === 'group'
      ? `group <span class="mono">${escapeHtml(raCred.creatorId || '?')}</span>`
      : (raCred.creatorId ? `user <span class="mono">${escapeHtml(raCred.creatorId)}</span>` : 'the signed-in account');
    sum.style.display = '';
    sum.innerHTML = `<div style="background:rgba(46,216,150,0.06);border-left:3px solid var(--green);border-radius:6px;padding:11px 14px;font-size:13px;line-height:1.7;">
      <strong>${raCred.kind === 'apikey' ? 'Open Cloud API key' : 'Account cookie'}</strong> in place &mdash; uploads go to ${owner}.<br>
      Account: ${acct}<br>
      <span style="color:var(--text-secondary);">Set by ${escapeHtml(raCred.setByName || 'unknown')} ${raCred.updatedAt ? formatDateTime(raCred.updatedAt) : ''}${raCred.verifiedAt ? ` · last tested ${formatDateTime(raCred.verifiedAt)}` : ' · never tested'}</span><br>
      <span style="color:var(--text-muted);font-size:12px;">The value itself cannot be read back. Paste a new one to replace it.</span>
    </div>`;
  }
}

async function raSaveCredential() {
  const val  = document.getElementById('ra-value');
  const btn  = document.getElementById('ra-save-btn');
  const out  = document.getElementById('ra-cred-result');
  const value = val ? val.value.trim() : '';
  if (!value) { if (out) out.innerHTML = raErr('Paste the credential first.'); return; }

  if (raKind === 'cookie') {
    const go = await uiConfirm(
      'A .ROBLOSECURITY cookie authenticates past two-factor — it is the whole account. It will be stored encrypted and never shown again. Continue?',
      { title: 'Store an account cookie?', confirmText: 'Store it', danger: true });
    if (!go) return;
  }

  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader-2"></i> Saving…'; }
  if (out) out.innerHTML = '';
  try {
    const r = await api('/api/dev/roblox/credential', {
      method: 'PUT',
      body: JSON.stringify({
        kind: raKind,
        value,
        creatorType: (document.getElementById('ra-creator-type') || {}).value || 'user',
        creatorId: ((document.getElementById('ra-creator-id') || {}).value || '').trim() || null,
      }),
    });
    // Out of the DOM the moment it is accepted — there is no reason for it to
    // sit in a field on a screen that might be shared.
    if (val) val.value = '';
    const v = r.verify || {};
    if (out) out.innerHTML = v.ok
      ? raOk(`Saved and working${v.account ? ` — Roblox says this is ${escapeHtml(v.account.name || v.account.id)}` : ''}.${v.note ? ' ' + escapeHtml(v.note) : ''}`)
      : raWarn(`Saved, but Roblox would not accept it: ${escapeHtml(v.error || 'unknown reason')}`);
    await raLoadCredential();
  } catch (e) {
    if (out) out.innerHTML = raErr(e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-lock"></i> Save credential'; }
  }
}

async function raVerifyCredential() {
  const btn = document.getElementById('ra-verify-btn');
  const out = document.getElementById('ra-cred-result');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader-2"></i> Testing…'; }
  try {
    const r = await api('/api/dev/roblox/credential/verify', { method: 'POST' });
    if (out) out.innerHTML = r.ok
      ? raOk(`Working${r.account ? ` — ${escapeHtml(r.account.name || r.account.id)}` : ''}${
          r.scopes && r.scopes.length ? `, allowed to ${escapeHtml(r.scopes.join(' and '))} assets` : ''}.${
          r.note ? ' ' + escapeHtml(r.note) : ''}`)
      : raErr(r.error || 'Roblox rejected it.');
    await raLoadCredential();
    if (r.ok && r.quota) raRenderQuota(r.quota);
  } catch (e) {
    if (out) out.innerHTML = raErr(e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-plug-connected"></i> Test it'; }
  }
}

async function raClearCredential() {
  const go = await uiConfirm('Remove the stored Roblox credential? Uploads will stop working until a new one is added.',
    { title: 'Remove credential?', confirmText: 'Remove', danger: true });
  if (!go) return;
  const out = document.getElementById('ra-cred-result');
  try {
    await api('/api/dev/roblox/credential', { method: 'DELETE' });
    if (out) out.innerHTML = raOk('Removed.');
    await raLoadCredential();
  } catch (e) { if (out) out.innerHTML = raErr(e.message); }
}

// The monthly allowance, which is what actually stops a batch. Through the API it
// is 10 a month unverified and 100 ID-verified, so a batch of 50 can be five
// times everything the account has — worth knowing BEFORE pressing upload rather
// than on the eleventh failure.
function raRenderQuota(q) {
  const el = document.getElementById('ra-quota');
  if (!el) return;
  if (!q || q.capacity == null) {
    el.style.display = 'none';
    return;
  }
  const left = q.remaining != null ? q.remaining : null;
  const none  = left === 0;
  // Proportional, not absolute. A flat "10 or fewer left" marked every state as
  // nearly-out on an unverified account, whose whole allowance is 10 — so the
  // warning was always on and therefore said nothing.
  const tight = left != null && left > 0
    && left <= Math.max(2, Math.ceil((q.capacity || 0) * 0.25));
  const col = none ? 'var(--red)' : (tight ? 'var(--amber)' : 'var(--green)');
  const resets = q.resetsAt ? ` Resets ${escapeHtml(formatDateTime(q.resetsAt))}.` : '';

  // Each state gets its own sentence. Appending "of 10" to "No uploads left"
  // read as "No uploads left this month. of 10." — and the hint about ID
  // verification was on the nearly-out branch only, so it went missing at zero,
  // which is exactly when it is worth reading.
  let headline, sub = '';
  if (none) {
    headline = `No uploads left of the ${q.capacity} this month.`;
    sub = 'ID-verifying the Roblox account raises the allowance.';
  } else if (left != null) {
    headline = `${left} upload${left === 1 ? '' : 's'} left this month, of ${q.capacity}.`;
    if (tight) sub = 'ID-verifying the Roblox account raises the allowance.';
  } else {
    headline = `Allowance: ${q.capacity} a month.`;
  }

  el.style.display = '';
  el.innerHTML = `<div style="border-left:3px solid ${col};background:rgba(127,127,127,0.06);border-radius:6px;padding:9px 13px;line-height:1.6;">
    <strong style="color:${col};">${escapeHtml(headline)}</strong>${resets}
    ${sub ? `<br><span style="color:var(--text-secondary);">${escapeHtml(sub)}</span>` : ''}
  </div>`;
}

// ── Picking files ─────────────────────────────────────────────────

let raDropWired = false;
function raWireDrop() {
  const zone = document.getElementById('ra-drop');
  if (!zone || raDropWired) return;
  raDropWired = true;
  const lift = (on) => {
    zone.style.borderColor = on ? 'var(--accent, #4a7dff)' : 'var(--border)';
    zone.style.background  = on ? 'rgba(74,125,255,0.06)' : '';
  };
  ['dragenter', 'dragover'].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); lift(true); }));
  ['dragleave', 'drop'].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); lift(false); }));
  zone.addEventListener('drop', e => {
    if (e.dataTransfer && e.dataTransfer.files) raFilesPicked(e.dataTransfer.files);
  });
}

function raFilesPicked(fileList) {
  const picked = Array.from(fileList || []);
  for (const f of picked) {
    // The same file picked twice, as opposed to two different files that happen to
    // share a name and a size — which does happen, and dropping one silently is
    // worse than uploading both.
    if (raQueue.some(q => q.file.name === f.name && q.file.size === f.size
                       && q.file.lastModified === f.lastModified)) continue;
    raQueue.push({ file: f, name: f.name.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim().slice(0, 50) });
  }
  const input = document.getElementById('ra-files');
  if (input) input.value = '';   // so choosing the same file again still fires
  raRenderQueue();
}

const RA_MIMES = ['audio/mpeg', 'audio/mp3', 'audio/ogg', 'application/ogg',
                  'audio/wav', 'audio/wave', 'audio/x-wav', 'audio/flac', 'audio/x-flac'];
function raQueueProblem(f) {
  const ext = (f.name.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
  // Extension first, the browser's type second — matching the server, which will
  // take a file whose type identifies it even when the name has no extension.
  if (!RA_EXTS.includes(ext) && !RA_MIMES.includes(String(f.type || '').toLowerCase())) {
    return 'Only ' + RA_EXTS.join(', ');
  }
  // Roblox's wording is "less than 20 MB", so exactly 20 MB is over.
  if (f.size >= RA_MAX_MB * 1024 * 1024) return `${(f.size / 1024 / 1024).toFixed(1)} MB — needs to be under ${RA_MAX_MB} MB`;
  if (!f.size) return 'Empty file';
  return null;
}

function raRenderQueue() {
  const wrap = document.getElementById('ra-queue');
  const btn  = document.getElementById('ra-upload-btn');
  const clr  = document.getElementById('ra-queue-clear');
  if (!wrap) return;

  if (!raQueue.length) {
    wrap.innerHTML = '';
    if (btn) btn.disabled = true;
    if (clr) clr.style.display = 'none';
    return;
  }
  if (clr) clr.style.display = '';

  const ok = raQueue.filter(q => !raQueueProblem(q.file)).length;
  if (btn) {
    btn.disabled = !ok;
    btn.innerHTML = `<i class="ti ti-upload"></i> Upload ${ok} to Roblox`;
  }

  wrap.innerHTML = `<div class="table-wrap"><table class="data-table"><thead><tr>
      <th style="width:40%;">Name on Roblox</th><th>File</th><th>Size</th><th></th>
    </tr></thead><tbody>${raQueue.map((q, i) => {
      const bad = raQueueProblem(q.file);
      return `<tr${bad ? ' style="opacity:.55;"' : ''}>
        <td>${bad ? '—' : `<input class="form-control" style="padding:5px 8px;font-size:12.5px;" maxlength="50"
              value="${escapeHtml(q.name)}" oninput="raQueue[${i}].name=this.value">`}</td>
        <td style="font-size:12px;">${escapeHtml(q.file.name)}</td>
        <td style="font-size:12px;white-space:nowrap;">${(q.file.size / 1024 / 1024).toFixed(2)} MB</td>
        <td style="white-space:nowrap;">${bad
          ? `<span style="color:var(--red);font-size:11.5px;"><i class="ti ti-alert-triangle"></i> ${escapeHtml(bad)}</span>`
          : ''} <button class="btn btn-sm btn-secondary" onclick="raDrop(${i})"><i class="ti ti-x"></i></button></td>
      </tr>`;
    }).join('')}</tbody></table></div>`;
}

function raDrop(i)      { raQueue.splice(i, 1); raRenderQueue(); }
function raClearQueue() { raQueue = []; raRenderQueue(); }

// ── Uploading ─────────────────────────────────────────────────────

function raReadAsBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('Could not read ' + file.name));
    fr.onload  = () => {
      const s = String(fr.result || '');
      resolve(s.slice(s.indexOf(',') + 1));
    };
    fr.readAsDataURL(file);
  });
}

const RA_MAX_BATCH = 50;
// Base64 is about 4/3 the size of the bytes, and it all has to become one JSON
// string. Past a point that string cannot be built at all — the browser throws
// "Invalid string length" — so the total is checked BEFORE spending time reading
// fifty files only to lose the batch at the last step.
const RA_MAX_TOTAL_MB = 60;

async function raUpload() {
  const all = raQueue.filter(q => !raQueueProblem(q.file));
  if (!all.length) return;
  const out0 = document.getElementById('ra-upload-result');
  if (all.length > RA_MAX_BATCH) {
    if (out0) out0.innerHTML = raErr(`${all.length} at once is too many — ${RA_MAX_BATCH} per batch. `
      + 'Remove some and upload the rest afterwards.');
    return;
  }
  const totalMb = all.reduce((n, q) => n + q.file.size, 0) / 1024 / 1024;
  if (totalMb > RA_MAX_TOTAL_MB) {
    if (out0) out0.innerHTML = raErr(`${totalMb.toFixed(0)} MB in one go is too much — `
      + `keep a batch under ${RA_MAX_TOTAL_MB} MB in total. Upload it in two halves.`);
    return;
  }
  const send = all;
  if (!raCred || !raCred.configured) {
    const out = document.getElementById('ra-upload-result');
    if (out) out.innerHTML = raErr('Add a Roblox credential first.');
    return;
  }

  const btn = document.getElementById('ra-upload-btn');
  const out = document.getElementById('ra-upload-result');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader-2"></i> Reading files…'; }
  if (out) out.innerHTML = '';

  try {
    const files = [];
    for (const q of send) {
      files.push({ fileName: q.file.name, mimeType: q.file.type || 'audio/mpeg',
                   displayName: q.name, data: await raReadAsBase64(q.file) });
    }
    if (btn) btn.innerHTML = `<i class="ti ti-loader-2"></i> Uploading ${files.length}…`;
    if (out) out.innerHTML = '<span style="color:var(--text-secondary);">Two at a time, and it slows itself down if Roblox starts '
      + 'throttling — a big batch can take a few minutes. Leave this open.</span>';

    const r = await api('/api/dev/roblox/audio', { method: 'POST', body: JSON.stringify({ files }) });

    const bits = [];
    if (r.uploaded) bits.push(`${r.uploaded} uploaded`);
    if (r.pending)  bits.push(`${r.pending} still processing`);
    // Rate-limited is not the same as failed. It means "ask again", and counting
    // it as a failure tells the user to go looking for a problem that isn't there.
    const limited = r.rateLimited || 0;
    const brokenCount = Math.max(0, (r.failed || 0) - limited);
    if (limited)      bits.push(`${limited} rate-limited`);
    if (brokenCount)  bits.push(`${brokenCount} failed`);
    if (r.rejected && r.rejected.length) bits.push(`${r.rejected.length} not sent`);

    const detail = [
      ...(r.rows || []).filter(x => x.status === 'FAILED').map(x => `${x.fileName}: ${x.error}`),
      ...(r.rejected || []).map(x => `${x.fileName}: ${x.error}`),
    ];
    if (out) {
      const list = detail.length
        ? `<ul style="margin:0.5rem 0 0 1.1rem;padding:0;color:var(--text-secondary);font-size:12.5px;">${
            detail.map(d => `<li>${escapeHtml(d)}</li>`).join('')}</ul>` : '';
      // Roblox lets a burst through and then throttles, so the tail of a big
      // batch getting rate-limited is normal and expected — the files are still
      // queued, and pressing Upload again is the whole fix.
      const retryLine = limited
        ? `<div style="margin-top:0.5rem;">${limited === 1 ? 'That one is' : 'Those are'} still queued above — `
          + `Roblox throttles after a run of uploads. Wait a minute, then press Upload again.</div>`
        : '';
      out.innerHTML = (r.failed || (r.rejected || []).length)
        ? (limited && !brokenCount && !(r.rejected || []).length
            ? raOk(bits.join(' · ')) + retryLine + list
            : raWarn(bits.join(' · ')) + retryLine + list)
        : raOk(bits.join(' · ') + ' — the IDs are in the table below.');
    }

    // Only the ones that went are cleared; a failure stays put so it can be
    // retried without picking the file again.
    //
    // Matched on POSITION in what was sent, not on file name — two files can
    // share a name, and matching by name cleared both when only one went.
    const wentAt = new Set((r.rows || []).filter(x => x.status !== 'FAILED')
                                         .map(x => x.at).filter(n => typeof n === 'number'));
    const wentFiles = new Set(send.filter((_, i) => wentAt.has(i)).map(q => q.file));
    raQueue = raQueue.filter(q => !wentFiles.has(q.file));
    raRenderQueue();
    await raLoadUploads();
  } catch (e) {
    // A long batch can outlive the connection — a proxy timing out does not stop
    // the server, so the uploads may well have happened. The ledger is the record,
    // so it is reloaded before anything is called a failure.
    if (out) out.innerHTML = raErr(e.message);
    try {
      const before = raUploads.length;
      await raLoadUploads();
      if (raUploads.length > before && out) {
        out.innerHTML = raWarn('The connection dropped before Roblox finished answering, but '
          + `${raUploads.length - before} upload${raUploads.length - before === 1 ? '' : 's'} did land — `
          + 'they are in the table below. Anything missing is still queued above.');
      }
    } catch (_) { /* the original error already says what happened */ }
  } finally {
    if (btn) { btn.disabled = false; raRenderQueue(); }
  }
}

// ── The ledger ────────────────────────────────────────────────────

let raUploads = [];

const RA_STATUS = {
  DONE:      ['green',  'ti-check',         'Uploaded'],
  PENDING:   ['amber',  'ti-clock',         'Processing'],
  UPLOADING: ['blue',   'ti-loader-2',      'Uploading'],
  FAILED:    ['red',    'ti-alert-triangle', 'Failed'],
};

// Roblox finishing the upload is not Roblox approving it. An ID for something
// still under review, or already rejected, will not play.
const RA_MODERATION = {
  APPROVED:  ['green',  'ti-shield-check',   'Approved'],
  REVIEWING: ['amber',  'ti-shield-search',  'In review'],
  REJECTED:  ['red',    'ti-shield-x',       'Rejected'],
};

async function raLoadUploads() {
  const tb = document.getElementById('ra-uploads-tbody');
  if (!tb) return;
  tb.innerHTML = '<tr><td colspan="7" class="table-loading"><div class="spinner"></div></td></tr>';
  try {
    const r = await api('/api/dev/roblox/uploads');
    raUploads = r.uploads || [];
  } catch (e) {
    tb.innerHTML = `<tr><td colspan="7" class="table-empty-text">${escapeHtml(e.message)}</td></tr>`;
    return;
  }
  if (!raUploads.length) {
    tb.innerHTML = '<tr><td colspan="7" class="table-empty-text">Nothing uploaded yet.</td></tr>';
    return;
  }
  tb.innerHTML = raUploads.map(u => {
    const [col, ic, label] = RA_STATUS[u.status] || ['text-muted', 'ti-point', u.status];
    return `<tr>
      <td>${escapeHtml(u.displayName)}</td>
      <td style="font-size:12px;color:var(--text-secondary);">${escapeHtml(u.fileName)}</td>
      <td>${u.assetId
        ? `<span class="mono" style="font-size:12.5px;">${escapeHtml(u.assetId)}</span>`
        : '<span style="color:var(--text-muted);">—</span>'}</td>
      <td style="white-space:nowrap;"><span style="color:var(--${col});font-size:12.5px;"><i class="ti ${ic}"></i> ${escapeHtml(label)}</span>${
        u.error ? `<div style="font-size:11px;color:var(--text-muted);max-width:280px;">${escapeHtml(u.error)}</div>` : ''}</td>
      <td style="white-space:nowrap;">${(() => {
        const m = RA_MODERATION[u.moderation];
        if (!m) return u.assetId ? '<span style="color:var(--text-muted);font-size:12px;">Not reported</span>' : '<span style="color:var(--text-muted);">—</span>';
        return `<span style="color:var(--${m[0]});font-size:12.5px;" title="${m[1] === 'ti-shield-search' ? 'Uploaded, but not usable until Roblox approves it' : ''}"><i class="ti ${m[1]}"></i> ${escapeHtml(m[2])}</span>`;
      })()}</td>
      <td style="font-size:12px;color:var(--text-muted);white-space:nowrap;">${escapeHtml(formatDateTime(u.createdAt))}</td>
      <td style="white-space:nowrap;">${u.assetId ? `
        <button class="btn btn-sm btn-secondary" title="Copy the ID" onclick="raCopy('${jsAttr(u.assetId)}')"><i class="ti ti-copy"></i></button>
        <a class="btn btn-sm btn-secondary" title="Open on Roblox" target="_blank" rel="noopener"
           href="https://create.roblox.com/store/asset/${encodeURIComponent(u.assetId)}"><i class="ti ti-external-link"></i></a>` : ''}</td>
    </tr>`;
  }).join('');
}

async function raClearUploads() {
  const go = await uiConfirm('Clear this list? The audio stays on Roblox — but the asset IDs are only recorded here, so copy anything you still need first.',
    { title: 'Clear the list?', confirmText: 'Clear', danger: true });
  if (!go) return;
  try {
    await api('/api/dev/roblox/uploads', { method: 'DELETE' });
    await raLoadUploads();
  } catch (e) { showToast(e.message, 'error'); }
}

function raCopy(text) {
  navigator.clipboard.writeText(String(text))
    .then(() => showToast('Copied.', 'success'))
    .catch(() => showToast('Could not copy.', 'error'));
}

// Three shapes, because an asset id on its own is rarely what you paste. `lua`
// gives a table keyed by name, ready to drop into a script.
function raCopyAll(shape) {
  const done = raUploads.filter(u => u.assetId);
  if (!done.length) { showToast('No asset IDs yet.', 'info'); return; }

  let text;
  if (shape === 'lua') {
    const key = (s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) ? s : `["${String(s).replace(/"/g, '\\"')}"]`;
    text = 'local Audio = {\n' + done.map(u =>
      `\t${key(u.displayName)} = "rbxassetid://${u.assetId}",`).join('\n') + '\n}\n';
  } else if (shape === 'csv') {
    const cell = (s) => `"${String(s == null ? '' : s).replace(/"/g, '""')}"`;
    text = 'name,assetId,file\n' + done.map(u => [cell(u.displayName), u.assetId, cell(u.fileName)].join(',')).join('\n');
  } else {
    text = done.map(u => u.assetId).join('\n');
  }
  navigator.clipboard.writeText(text)
    .then(() => showToast(`Copied ${done.length} ID${done.length === 1 ? '' : 's'}.`, 'success'))
    .catch(() => showToast('Could not copy.', 'error'));
}

// ── Result lines ──────────────────────────────────────────────────
const raOk   = (m) => `<span style="color:var(--green);"><i class="ti ti-check"></i> ${m}</span>`;
const raWarn = (m) => `<span style="color:var(--amber);"><i class="ti ti-alert-triangle"></i> ${m}</span>`;
const raErr  = (m) => `<span style="color:var(--red);"><i class="ti ti-alert-triangle"></i> ${escapeHtml(String(m))}</span>`;
