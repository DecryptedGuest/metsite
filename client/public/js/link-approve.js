// client/public/js/link-approve.js — QR sign-in approval (runs on the logged-in device).
(function () {
  const id = new URLSearchParams(location.search).get('id');
  const card = document.getElementById('ap-card');
  const csrf = () => (document.cookie.match(/csrf_token=([^;]+)/) || [])[1] || '';

  function done(icon, title, sub, color) {
    card.innerHTML = `<div class="ap-icon" style="color:${color}"><i class="ti ${icon}"></i></div>
      <h1 class="ap-title">${title}</h1><p class="ap-sub">${sub}</p>
      <div class="ap-btns"><a href="/dashboard" class="btn btn-ghost"><i class="ti ti-layout-dashboard"></i> Go to dashboard</a></div>`;
  }

  if (!id) { done('ti-alert-triangle', 'Invalid link', 'This approval link is missing its code. Scan the QR again from your other device.', 'var(--amber,#e8842a)'); return; }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Show what device/where is requesting, so an unfamiliar one is obvious.
  (async () => {
    const box = document.getElementById('ap-context');
    try {
      const r = await fetch('/api/login/qr/context?id=' + encodeURIComponent(id), { credentials: 'include' });
      const d = await r.json();
      if (!r.ok) { box.innerHTML = `<span style="color:var(--amber,#e8842a);">${esc(d.error || 'This request is no longer valid.')}</span>`; return; }
      let when = ''; try { when = new Date(d.startedAt).toLocaleTimeString(); } catch (e) {}
      box.innerHTML =
        `<div><i class="ti ti-device-desktop"></i> <strong>Device:</strong> ${esc(d.device || 'unknown')}</div>` +
        (d.ip ? `<div><i class="ti ti-map-pin"></i> <strong>IP:</strong> ${esc(d.ip)}</div>` : '') +
        (when ? `<div><i class="ti ti-clock"></i> <strong>Started:</strong> ${esc(when)}</div>` : '');
      const m = document.getElementById('ap-match');
      if (d.matchCode && m) m.style.display = '';
    } catch (e) { box.textContent = 'Could not load device details — approve only if you are certain.'; }
  })();

  document.getElementById('ap-yes').addEventListener('click', async () => {
    const matchCode = (document.getElementById('ap-code') && document.getElementById('ap-code').value || '').trim();
    try {
      const r = await fetch('/api/login/qr/approve', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
        body: JSON.stringify({ id, matchCode }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Could not approve.');
      done('ti-circle-check', 'Approved', 'You can return to your other device — it will be signed in automatically.', 'var(--green,#22c55e)');
    } catch (e) {
      if (window.showToast) showToast(e.message, 'error');
      done('ti-alert-triangle', 'Could not approve', esc(e.message) + ' If you didn\'t start this sign-in, you can safely close this page.', 'var(--red,#e0503a)');
    }
  });

  document.getElementById('ap-no').addEventListener('click', () => {
    done('ti-shield-check', 'Ignored', 'No problem — nothing was approved and nobody was signed in. You can close this page.', 'var(--text-muted,#888)');
  });
})();
