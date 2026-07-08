// client/public/js/login-alt.js — "Try another way" sign-in flows on the login page.
(function () {
  const panel = document.getElementById('alt-panel');
  const trigger = document.getElementById('try-another');
  if (!panel || !trigger) return;

  const csrf = () => (document.cookie.match(/csrf_token=([^;]+)/) || [])[1] || '';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  async function api(path, opts = {}) {
    const r = await fetch(path, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf(), ...(opts.headers || {}) },
      ...opts,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Something went wrong.');
    return data;
  }
  const toast = (m, t) => (window.showToast ? showToast(m, t) : null);

  // base64url helpers for the passkey ceremony (native WebAuthn).
  function b64urlToBuf(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : ''; const bin = atob(s + pad); const b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b.buffer; }
  function bufToB64url(buf) { const b = new Uint8Array(buf); let bin = ''; for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]); return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

  let qrTimer = null;
  function stopQr() { if (qrTimer) { clearInterval(qrTimer); qrTimer = null; } }

  // In-flight passkey ceremony. Aborting it lets the user leave/retry without the
  // browser throwing "a request is already pending" on the next attempt.
  let pkCtrl = null;
  function pkAbort() { if (pkCtrl) { try { pkCtrl.abort(); } catch (e) {} pkCtrl = null; } }

  function show(html) { stopQr(); pkAbort(); panel.innerHTML = html; panel.style.display = ''; }
  const backBtn = `<button class="alt-back" data-nav="menu"><i class="ti ti-arrow-left"></i> Back</button>`;

  function menu() {
    show(`
      <div class="alt-title"><i class="ti ti-key"></i> Other ways to sign in</div>
      <p class="alt-desc">Use one of these if you can't sign in with Discord or Roblox.</p>
      <div class="alt-methods">
        <button class="alt-method" data-nav="code"><i class="ti ti-message-2-code"></i><span><span class="am-t">Get a code in Discord</span><br><span class="am-s">We DM you a 6-digit sign-in code</span></span></button>
        <button class="alt-method" data-nav="qr"><i class="ti ti-qrcode"></i><span><span class="am-t">Scan a QR code</span><br><span class="am-s">Approve from a device you're already signed in on</span></span></button>
        <button class="alt-method" data-nav="passkey"><i class="ti ti-fingerprint"></i><span><span class="am-t">Use a passkey</span><br><span class="am-s">Face ID, Touch ID, Windows Hello or a security key</span></span></button>
      </div>`);
  }

  // ── 1. Discord DM code ──
  function codeStart() {
    show(`${backBtn}
      <div class="alt-title"><i class="ti ti-message-2-code"></i> Get a code in Discord</div>
      <p class="alt-desc">Enter your Discord username. We'll DM you a 6-digit code — you must share a server with the bot.</p>
      <div class="form-group"><input class="form-control" id="alt-discord" placeholder="your_discord_username" autocomplete="username" /></div>
      <button class="btn btn-primary btn-discord-full" id="alt-code-send"><i class="ti ti-send"></i> Send me a code</button>`);
    const send = document.getElementById('alt-code-send');
    send.addEventListener('click', async () => {
      const discord = document.getElementById('alt-discord').value.trim();
      if (!discord) return toast('Enter your Discord username.', 'warning');
      send.disabled = true; send.innerHTML = '<i class="ti ti-loader-2"></i> Sending…';
      try { const r = await api('/api/login/code/request', { method: 'POST', body: JSON.stringify({ discord }) }); codeEnter(r.id); }
      catch (e) { toast(e.message, 'error'); send.disabled = false; send.innerHTML = '<i class="ti ti-send"></i> Send me a code'; }
    });
  }
  function codeEnter(id) {
    show(`${backBtn}
      <div class="alt-title"><i class="ti ti-message-2-code"></i> Enter your code</div>
      <p class="alt-desc">Check your Discord DMs from the bot and enter the 6-digit code. It expires in 10 minutes.</p>
      <div class="form-group"><input class="form-control alt-code-input" id="alt-code" inputmode="numeric" maxlength="6" placeholder="000000" /></div>
      <button class="btn btn-primary btn-discord-full" id="alt-code-verify"><i class="ti ti-login"></i> Sign in</button>`);
    const input = document.getElementById('alt-code');
    input.focus();
    const verify = document.getElementById('alt-code-verify');
    const go = async () => {
      const code = input.value.trim();
      if (code.length !== 6) return toast('Enter the 6-digit code.', 'warning');
      verify.disabled = true; verify.innerHTML = '<i class="ti ti-loader-2"></i> Signing in…';
      try { await api('/api/login/code/verify', { method: 'POST', body: JSON.stringify({ id, code }) }); location.replace('/dashboard'); }
      catch (e) { toast(e.message, 'error'); verify.disabled = false; verify.innerHTML = '<i class="ti ti-login"></i> Sign in'; }
    };
    verify.addEventListener('click', go);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  }

  // ── 2. QR approval ──
  async function qrStart() {
    show(`${backBtn}
      <div class="alt-title"><i class="ti ti-qrcode"></i> Scan to sign in</div>
      <p class="alt-desc">On a phone or device you're <strong>already signed in on</strong>, scan this code and tap approve.</p>
      <div id="alt-qr-wrap" style="text-align:center;"><div class="spinner" style="margin:2rem auto;"></div></div>`);
    try {
      const r = await api('/api/login/qr/start', { method: 'POST' });
      const wrap = document.getElementById('alt-qr-wrap');
      if (!wrap) return;
      wrap.innerHTML = `<img class="alt-qr" src="${r.qr}" alt="Sign-in QR code" />
        ${r.matchCode ? `<div class="alt-desc" style="text-align:center;margin-top:6px;">When approving on your other device, confirm this code:</div>
          <div style="text-align:center;font-size:30px;font-weight:800;letter-spacing:.15em;color:var(--blue,#4a8fff);margin:2px 0 6px;">${esc(String(r.matchCode))}</div>` : ''}
        <div class="alt-desc" style="text-align:center;">Waiting for approval… this code expires in 3 minutes.</div>`;
      const started = Date.now();
      qrTimer = setInterval(async () => {
        if (Date.now() - started > r.expiresInMs) { stopQr(); wrap.innerHTML = `<div class="alt-desc" style="text-align:center;color:var(--amber,#e8842a);">This code expired.</div><button class="btn btn-ghost btn-discord-full" id="alt-qr-retry"><i class="ti ti-refresh"></i> New code</button>`; document.getElementById('alt-qr-retry').addEventListener('click', qrStart); return; }
        try {
          const s = await (await fetch('/api/login/qr/status?id=' + encodeURIComponent(r.id), { credentials: 'include' })).json();
          if (s.status === 'approved') { stopQr(); location.replace('/dashboard'); }
          else if (s.status === 'expired' || s.status === 'denied' || s.status === 'consumed') { stopQr(); wrap.innerHTML = `<div class="alt-desc" style="text-align:center;color:var(--amber,#e8842a);">${s.status === 'denied' ? 'Sign-in was declined.' : 'This code is no longer valid.'}</div><button class="btn btn-ghost btn-discord-full" id="alt-qr-retry"><i class="ti ti-refresh"></i> New code</button>`; document.getElementById('alt-qr-retry').addEventListener('click', qrStart); }
        } catch (e) { /* transient — keep polling */ }
      }, 2500);
    } catch (e) {
      const wrap = document.getElementById('alt-qr-wrap');
      if (wrap) wrap.innerHTML = `<div class="alt-desc" style="text-align:center;color:var(--red,#e0503a);">${esc(e.message)}</div>`;
    }
  }

  // ── 3. Passkey ──
  function pkStatus(msg, isErr) {
    const st = document.getElementById('alt-pk-status');
    if (st) { st.textContent = msg; st.style.color = isErr ? 'var(--red,#e0503a)' : ''; }
  }
  function passkey() {
    pkAbort(); // cancel any ceremony left pending from a previous visit to this view
    if (!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.get)) {
      show(`${backBtn}<div class="alt-title"><i class="ti ti-fingerprint"></i> Passkey</div><p class="alt-desc">This device or browser doesn't support passkeys. Try another method.</p>`);
      return;
    }
    show(`${backBtn}<div class="alt-title"><i class="ti ti-fingerprint"></i> Use a passkey</div>
      <p class="alt-desc" id="alt-pk-status">Follow your device's prompt to choose a saved passkey…</p>
      <button class="btn btn-primary btn-discord-full" id="alt-pk-go" style="margin-top:6px;"><i class="ti ti-fingerprint"></i> Use passkey</button>`);
    const goBtn = document.getElementById('alt-pk-go');
    goBtn.addEventListener('click', attempt);
    attempt(); // auto-start; the button re-runs it after a cancel/failure

    async function attempt() {
      pkAbort();
      const ctrl = new AbortController();
      pkCtrl = ctrl;
      goBtn.disabled = true; goBtn.innerHTML = '<i class="ti ti-loader-2"></i> Waiting for your device…';
      pkStatus("Follow your device's prompt to choose a saved passkey…", false);
      try {
        const options = await api('/api/login/passkey/options', { method: 'POST' });
        options.challenge = b64urlToBuf(options.challenge);
        if (Array.isArray(options.allowCredentials) && options.allowCredentials.length) {
          options.allowCredentials = options.allowCredentials.map(c => ({ ...c, id: b64urlToBuf(c.id) }));
        } else {
          delete options.allowCredentials; // discoverable: let the browser offer any saved passkey
        }
        const cred = await navigator.credentials.get({ publicKey: options, signal: ctrl.signal });
        if (ctrl.signal.aborted) return; // user navigated away mid-ceremony
        const response = {
          id: cred.id, rawId: bufToB64url(cred.rawId), type: cred.type,
          response: {
            authenticatorData: bufToB64url(cred.response.authenticatorData),
            clientDataJSON: bufToB64url(cred.response.clientDataJSON),
            signature: bufToB64url(cred.response.signature),
            userHandle: cred.response.userHandle ? bufToB64url(cred.response.userHandle) : null,
          },
          clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
        };
        pkStatus('Passkey accepted — signing you in…', false);
        await api('/api/login/passkey/verify', { method: 'POST', body: JSON.stringify({ response }) });
        pkCtrl = null;
        location.replace('/dashboard');
      } catch (e) {
        pkCtrl = null;
        // A deliberate abort (navigating away / retrying) isn't an error to show.
        if (e && e.name === 'AbortError') return;
        let msg;
        if (e && e.name === 'NotAllowedError') msg = 'No passkey was used — the prompt was dismissed or timed out. Tap "Use passkey" to try again. If you saved your passkey on a different site address, re-add one here.';
        else if (e && e.name === 'SecurityError') msg = "This site's address doesn't match the passkey. Make sure you're on the main domain and try again.";
        else if (e && e.name === 'InvalidStateError') msg = 'That passkey isn\'t registered to an account here. Sign in another way, then add a passkey from your profile.';
        else msg = e.message || 'Passkey sign-in failed.';
        pkStatus(msg, true);
        toast(msg, 'error');
        if (goBtn) { goBtn.disabled = false; goBtn.innerHTML = '<i class="ti ti-refresh"></i> Try again'; }
      }
    }
  }

  const NAV = { menu, code: codeStart, qr: qrStart, passkey };
  panel.addEventListener('click', (e) => { const b = e.target.closest('[data-nav]'); if (b) { e.preventDefault(); (NAV[b.dataset.nav] || menu)(); } });
  trigger.addEventListener('click', () => {
    if (panel.style.display === 'none') { menu(); trigger.textContent = 'Hide other ways'; }
    else { stopQr(); pkAbort(); panel.style.display = 'none'; trigger.textContent = 'Try another way'; }
  });
})();
