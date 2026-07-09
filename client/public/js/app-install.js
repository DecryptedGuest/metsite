/* app-install.js — the /app "get the app" page.
   Three states:
     • installed (standalone)  → "you're all set" + notification opt-in
     • phone via handoff (?welcome=1) → "signed in" + Add-to-Home-Screen steps
     • desktop (logged in)     → QR to hand off to a phone + opt-in on this device
   Notifications are strictly opt-in (button → pushClient.requestPushPermission). */
(function () {
  const $ = id => document.getElementById(id);
  const body = () => $('app-body');
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const ua = navigator.userAgent || '';
  // iPadOS 13+ reports as desktop Safari — treat a touch Mac as iOS too.
  const isIOS = /iphone|ipad|ipod/i.test(ua) || (/Macintosh/i.test(ua) && 'ontouchend' in document);
  const isAndroid = /android/i.test(ua);
  const isMobile = isIOS || isAndroid;
  // Which browser? The exact Add-to-Home-Screen path differs per browser.
  function iosBrowser() {
    if (/CriOS/i.test(ua)) return 'chrome';
    if (/FxiOS/i.test(ua)) return 'firefox';
    if (/EdgiOS/i.test(ua)) return 'edge';
    return 'safari';
  }
  function androidBrowser() {
    if (/SamsungBrowser/i.test(ua)) return 'samsung';
    if (/EdgA/i.test(ua)) return 'edge';
    if (/OPR|Opera/i.test(ua)) return 'opera';
    if (/Firefox/i.test(ua)) return 'firefox';
    return 'chrome';
  }
  const params = new URLSearchParams(location.search);
  let deferredPrompt = null;

  // Register the SW so the app is installable + push can be delivered (no prompt).
  if ('serviceWorker' in navigator) { navigator.serviceWorker.register('/sw.js').catch(() => {}); }
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredPrompt = e; renderInstallCTA(); });

  function notifButton() {
    const perm = (window.pushClient && pushClient.permissionState()) || 'default';
    if (perm === 'granted') return `<div class="muted" style="margin-top:14px;color:var(--green);"><i class="ti ti-bell-check"></i> Notifications are on for this device.</div>`;
    if (perm === 'denied') return `<div class="muted" style="margin-top:14px;"><i class="ti ti-bell-off"></i> Notifications are blocked in your device settings. Enable them for this site to get alerts.</div>`;
    return `<button class="btn btn-primary big-btn" id="notif-btn"><i class="ti ti-bell"></i> Enable notifications</button>
      <div class="muted" style="margin-top:8px;">We'll only notify you about things that need you — tryouts going live, tickets assigned to you, logs to review. You choose; nothing is sent unless you turn this on.</div>`;
  }
  function wireNotif() {
    const b = $('notif-btn'); if (!b) return;
    b.addEventListener('click', async () => {
      b.disabled = true; b.innerHTML = '<i class="ti ti-loader"></i> Requesting…';
      const r = await pushClient.requestPushPermission();
      if (r === 'granted') showToast('Notifications enabled', 'success');
      else if (r === 'denied') showToast('Permission denied — enable it in your browser settings.', 'warning');
      else if (r === 'unsupported') showToast('This device doesn\'t support notifications.', 'warning');
      else showToast('Could not enable notifications.', 'error');
      render();
    });
  }

  function renderInstallCTA() {
    // Android/Chrome native install prompt, if offered.
    const el = $('android-install');
    if (el && deferredPrompt) el.style.display = '';
  }

  function stepRows(rows) {
    return '<div style="text-align:left;margin-top:10px;">' + rows.map((r, i) =>
      `<div class="step"${i === rows.length - 1 ? ' style="border:none;"' : ''}><div class="n">${i + 1}</div><div>${r}</div></div>`
    ).join('') + '</div>';
  }
  function stepsIOS() {
    const b = iosBrowser();
    // iOS only lets you add a real home-screen app from Safari's share sheet.
    if (b !== 'safari') {
      const name = b === 'chrome' ? 'Chrome' : b === 'firefox' ? 'Firefox' : 'this browser';
      return `<div class="muted" style="margin-top:10px;padding:10px 12px;border:1px solid var(--amber,#e8842a);border-radius:10px;color:var(--amber,#e8842a);"><i class="ti ti-alert-triangle"></i> You're in ${name}. On iPhone/iPad only <strong>Safari</strong> can add the app to your home screen.</div>`
        + stepRows([
          'Copy this page\'s address, then open it in <strong>Safari</strong>.',
          'In Safari, tap the <strong>Share</strong> button <i class="ti ti-share"></i>.',
          'Choose <strong>Add to Home Screen</strong> <i class="ti ti-square-plus"></i>, then tap <strong>Add</strong>.',
        ]);
    }
    return stepRows([
      'Tap the <strong>Share</strong> button <i class="ti ti-share"></i> at the bottom of Safari (or the top on iPad).',
      'Scroll down and choose <strong>Add to Home Screen</strong> <i class="ti ti-square-plus"></i>.',
      'Tap <strong>Add</strong> — the MET Dashboard appears on your home screen.',
    ]);
  }
  function stepsAndroid() {
    const b = androidBrowser();
    const installBtn = `<button class="btn btn-primary big-btn" id="android-install" style="display:none;"><i class="ti ti-download"></i> Install app</button>`;
    if (b === 'samsung') {
      return installBtn + stepRows([
        'Tap the <strong>≡</strong> menu at the bottom of Samsung Internet.',
        'Choose <strong>Add page to</strong> → <strong>Home screen</strong>.',
        'Tap <strong>Add</strong> — the MET Dashboard appears on your home screen.',
      ]);
    }
    if (b === 'firefox') {
      return installBtn + stepRows([
        'Tap the <strong>⋮</strong> menu in Firefox.',
        'Choose <strong>Install</strong> (or <strong>Add to Home screen</strong>).',
        'Confirm — the MET Dashboard appears on your home screen.',
      ]);
    }
    if (b === 'edge') {
      return installBtn + stepRows([
        'Tap the <strong>⋯</strong> menu at the bottom of Edge.',
        'Choose <strong>Add to phone</strong> (or <strong>Apps → Install</strong>).',
        'Confirm — the MET Dashboard appears on your home screen.',
      ]);
    }
    // Chrome / Opera / other Chromium.
    return installBtn + stepRows([
      'If you see the blue <strong>Install app</strong> button above, just tap it.',
      'Otherwise tap the <strong>⋮</strong> menu (top-right) in your browser.',
      'Choose <strong>Install app</strong> / <strong>Add to Home screen</strong>, then confirm.',
    ]);
  }

  async function loadQR() {
    try {
      const r = await api('/api/app/link', { method: 'POST' });
      return r;
    } catch (e) { return null; }
  }

  async function render() {
    // 1) Already installed → done + notifications.
    if (isStandalone) {
      $('app-sub').textContent = 'You\'re all set.';
      body().innerHTML = `<div class="muted"><i class="ti ti-circle-check" style="color:var(--green);font-size:34px;"></i><br>The MET Dashboard is installed and you're signed in.</div>${notifButton()}
        <a href="/profile" class="btn btn-primary big-btn" style="margin-top:16px;"><i class="ti ti-home"></i> Open dashboard</a>`;
      wireNotif();
      return;
    }
    // 2) Phone that just handed off the session.
    if (params.get('welcome') === '1') {
      $('app-sub').innerHTML = '<i class="ti ti-circle-check" style="color:var(--green);"></i> Signed in on this device.';
      body().innerHTML = `<div class="muted">Now add the dashboard to your home screen so it opens like an app and you stay signed in.</div>
        ${isIOS ? stepsIOS() : stepsAndroid()}
        <div style="margin-top:16px;border-top:1px solid var(--border,#2a2a2a);padding-top:14px;">${notifButton()}</div>`;
      wireNotif(); renderInstallCTA();
      const ai = $('android-install');
      if (ai) ai.addEventListener('click', async () => { if (deferredPrompt) { deferredPrompt.prompt(); deferredPrompt = null; } });
      return;
    }
    // 3) Any phone/tablet browser (already signed in here) → show the exact
    //    Add-to-Home-Screen steps for THIS device + browser. No QR handoff —
    //    they're already on the phone.
    if (isMobile) {
      $('app-sub').textContent = 'Add the MET Dashboard to your home screen.';
      body().innerHTML = `<div class="muted">Install it so it opens like an app and keeps you signed in — follow the steps for your ${isIOS ? 'iPhone/iPad' : 'device'}.</div>
        ${isIOS ? stepsIOS() : stepsAndroid()}
        ${(isIOS && iosBrowser() !== 'safari') ? `<button class="btn btn-ghost big-btn" id="copy-here" style="margin-top:12px;"><i class="ti ti-copy"></i> Copy this page's link</button>` : ''}
        <div style="margin-top:16px;border-top:1px solid var(--border,#2a2a2a);padding-top:14px;">${notifButton()}</div>`;
      wireNotif(); renderInstallCTA();
      const ai = $('android-install');
      if (ai) ai.addEventListener('click', async () => { if (deferredPrompt) { deferredPrompt.prompt(); deferredPrompt = null; } });
      const ch = $('copy-here');
      if (ch) ch.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(location.href); showToast('Link copied — paste it into Safari', 'success'); }
        catch (e) { window.prompt('Copy this link and open it in Safari:', location.href); }
      });
      return;
    }
    // 4) Desktop (or any browser) that's logged in → show the handoff QR.
    $('app-sub').textContent = 'Get the dashboard on your phone — already signed in.';
    body().innerHTML = '<div class="table-loading"><div class="spinner"></div></div>';
    const link = await loadQR();
    if (!link) { body().innerHTML = `<div class="muted">Couldn't create an install link. <a href="/app" style="color:var(--blue);">Try again</a>.</div>`; return; }
    body().innerHTML = `
      <div class="qr-box"><img src="${link.qr}" alt="Install QR" /></div>
      <div class="muted">Point your phone camera at this code — it opens the MET Dashboard <strong>already logged in</strong>. Then add it to your home screen.</div>
      <div class="muted" style="margin-top:6px;font-size:11px;">Single-use · expires in 5 minutes.</div>

      <div style="margin-top:16px;border-top:1px solid var(--border,#2a2a2a);padding-top:14px;text-align:left;">
        <div class="muted" style="text-align:center;margin-bottom:10px;">No camera? Get the same link another way:</div>
        <button class="btn btn-primary big-btn" id="dm-btn"><i class="ti ti-brand-discord"></i> Send the link to my Discord</button>
        <button class="btn btn-ghost big-btn" id="copy-btn"><i class="ti ti-copy"></i> Copy link</button>
        <div class="muted" style="margin-top:8px;font-size:11px;text-align:center;">Open the copied link on your phone's browser to sign in there.</div>
        <button class="btn btn-ghost btn-sm" id="qr-refresh" style="margin-top:10px;display:block;margin-left:auto;margin-right:auto;"><i class="ti ti-refresh"></i> New link</button>
      </div>
      <div style="margin-top:16px;border-top:1px solid var(--border,#2a2a2a);padding-top:14px;">${notifButton()}</div>`;
    wireNotif();
    const rb = $('qr-refresh'); if (rb) rb.addEventListener('click', render);
    const cb = $('copy-btn');
    if (cb) cb.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(link.url); showToast('Link copied — open it on your phone', 'success'); }
      catch (e) { window.prompt('Copy this link and open it on your phone:', link.url); }
    });
    const db = $('dm-btn');
    if (db) db.addEventListener('click', async () => {
      db.disabled = true; db.innerHTML = '<i class="ti ti-loader"></i> Sending…';
      try { await api('/api/app/link/dm', { method: 'POST' }); showToast('Sent! Check your Discord DMs and tap the link on your phone.', 'success'); db.innerHTML = '<i class="ti ti-check"></i> Sent to Discord'; }
      catch (e) { showToast(e.message, 'error'); db.disabled = false; db.innerHTML = '<i class="ti ti-brand-discord"></i> Send the link to my Discord'; }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render); else render();
})();
