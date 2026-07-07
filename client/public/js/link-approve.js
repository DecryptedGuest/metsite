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

  document.getElementById('ap-yes').addEventListener('click', async () => {
    try {
      const r = await fetch('/api/login/qr/approve', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
        body: JSON.stringify({ id }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Could not approve.');
      done('ti-circle-check', 'Approved', 'You can return to your other device — it will be signed in automatically.', 'var(--green,#22c55e)');
    } catch (e) {
      if (window.showToast) showToast(e.message, 'error');
      done('ti-alert-triangle', 'Could not approve', e.message + ' The request may have expired — scan the QR again.', 'var(--red,#e0503a)');
    }
  });

  document.getElementById('ap-no').addEventListener('click', () => {
    done('ti-shield-check', 'Ignored', 'No problem — nothing was approved and nobody was signed in. You can close this page.', 'var(--text-muted,#888)');
  });
})();
