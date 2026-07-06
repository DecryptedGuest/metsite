/* dev-security.js — the Dev Security Center (/dev/security). Developer-only.
   Session command + kill, break-glass lockdown, global broadcast, security
   alert feed, and 2FA compliance. All calls go to /api/dev/security. */
(function () {
  const esc = window.escapeHtml || (s => String(s == null ? '' : s));
  const $ = id => document.getElementById(id);
  const fmt = d => { try { return window.formatDateTime ? window.formatDateTime(d) : new Date(d).toLocaleString(); } catch (e) { return '—'; } };

  function showPage(name) {
    document.querySelectorAll('.sidebar-nav .nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === name));
    document.querySelectorAll('.main-content .page').forEach(p => p.classList.toggle('active', p.id === 'page-' + name));
    if (name === 'sessions') secLoadSessions();
    if (name === 'alerts') secLoadAlerts();
    if (name === 'lockdown') secLoadLockdown();
    if (name === 'passkeys') secLoadCompliance();
    if (name === 'overview') secLoadOverview();
  }
  document.querySelectorAll('.sidebar-nav .nav-item').forEach(b => b.addEventListener('click', () => showPage(b.dataset.page)));

  function evLine(e) {
    const sev = /LOCKDOWN|REVOKE|BLACKLIST|BAN|FORCE|KICK|DELETE/.test(e.action) ? 'var(--red)' : /BROADCAST|RANK|APPROVE/.test(e.action) ? 'var(--amber)' : 'var(--text-secondary)';
    return `<div style="display:flex;gap:10px;padding:9px 0;border-bottom:1px solid var(--border,#2a2a2a);font-size:13px;">
      <span style="color:${sev};font-weight:700;min-width:130px;">${esc(e.action)}</span>
      <span style="flex:1;">${esc(e.summary || (e.category + '/' + e.action))}<div style="font-size:11px;color:var(--text-muted);">${esc(e.actorName || 'System')}${e.ip ? ' · ' + esc(e.ip) : ''} · ${fmt(e.createdAt)}</div></span></div>`;
  }

  // ── Overview ──
  window.secLoadOverview = async function () {
    try {
      const [sessions, alerts, comp] = await Promise.all([
        api('/api/dev/security/sessions'), api('/api/dev/security/alerts'), api('/api/dev/security/passkey-compliance'),
      ]);
      $('sec-stats').innerHTML = [
        ['Active sessions', sessions.length, 'var(--blue)'],
        ['Security events (7d)', alerts.events.length, 'var(--amber)'],
        ['Multi-IP users', alerts.multiIp.length, alerts.multiIp.length ? 'var(--red)' : 'var(--green)'],
        ['2FA compliant', `${comp.compliant}/${comp.total}`, 'var(--green)'],
      ].map(([l, v, c]) => `<div class="sec-stat"><div class="v" style="color:${c};">${v}</div><div class="l">${l}</div></div>`).join('');
      $('sec-overview-feed').innerHTML = alerts.events.length ? alerts.events.slice(0, 20).map(evLine).join('') : '<div class="table-empty-text" style="padding:16px;">No recent security events.</div>';
      const b = $('sec-alert-badge'); if (b) { const n = alerts.multiIp.length; b.style.display = n ? 'inline-flex' : 'none'; b.textContent = n; }
    } catch (e) { $('sec-stats').innerHTML = `<div class="table-empty-text">${esc(e.message)}</div>`; }
  };

  // ── Sessions ──
  window.secLoadSessions = async function () {
    const tb = $('sec-sessions-tbody');
    tb.innerHTML = '<tr><td colspan="6" class="table-loading"><div class="spinner"></div></td></tr>';
    try {
      const rows = await api('/api/dev/security/sessions');
      if (!rows.length) { tb.innerHTML = '<tr><td colspan="6" class="table-empty"><div class="table-empty-text">No active sessions.</div></td></tr>'; return; }
      tb.innerHTML = rows.map(s => `<tr>
        <td>${esc(s.user ? s.user.name : s.userId)}${s.current ? ' <span class="badge badge-approved" style="font-size:9px;">THIS DEVICE</span>' : ''}</td>
        <td>${esc(s.user ? s.user.role : '')}</td>
        <td style="font-family:monospace;font-size:12px;">${esc(s.ip || '—')}</td>
        <td style="font-size:12px;">${esc(s.device || (s.userAgent || '').slice(0, 40) || '—')}</td>
        <td style="font-size:12px;">${fmt(s.lastSeenAt)}</td>
        <td style="text-align:right;display:flex;gap:6px;justify-content:flex-end;">
          <button class="btn btn-ghost btn-sm" title="Force this officer to sign in again everywhere" onclick="secForceReauth('${s.userId}','${esc((s.user&&s.user.name)||'')}')"><i class="ti ti-logout-2"></i></button>
          <button class="btn btn-danger btn-sm" ${s.current ? 'disabled title="This is your current session"' : ''} onclick="secKill('${s.id}')"><i class="ti ti-plug-off"></i> Kill</button>
        </td></tr>`).join('');
    } catch (e) { tb.innerHTML = `<tr><td colspan="6" class="table-empty"><div class="table-empty-text">${esc(e.message)}</div></td></tr>`; }
  };
  window.secKill = async function (id) {
    if (!confirm('Kill this session? The device is signed out immediately.')) return;
    try { await api('/api/dev/security/sessions/' + id + '/revoke', { method: 'POST' }); showToast('Session killed', 'success'); secLoadSessions(); }
    catch (e) { showToast(e.message, 'error'); }
  };
  window.secForceReauth = async function (userId, name) {
    if (!confirm(`Force ${name || 'this officer'} to sign in again on every device?`)) return;
    try { const r = await api('/api/dev/security/users/' + userId + '/force-reauth', { method: 'POST' }); showToast(`Done — ${r.killed} session(s) killed`, 'success'); secLoadSessions(); }
    catch (e) { showToast(e.message, 'error'); }
  };

  // ── Alerts ──
  window.secLoadAlerts = async function () {
    $('sec-alerts-feed').innerHTML = '<div class="table-loading"><div class="spinner"></div></div>';
    try {
      const a = await api('/api/dev/security/alerts');
      $('sec-multi-ip').innerHTML = a.multiIp.length
        ? `<div class="panel glass fade-up" style="margin-bottom:14px;border-left:3px solid var(--red);"><div style="padding:12px 16px;font-size:13px;"><strong style="color:var(--red);"><i class="ti ti-map-pin-exclamation"></i> Multiple IPs in the last hour:</strong> ${a.multiIp.map(m => `${esc(m.name)} (${m.ips.length})`).join(' · ')}</div></div>`
        : '';
      $('sec-alerts-feed').innerHTML = a.events.length ? a.events.map(evLine).join('') : '<div class="table-empty-text" style="padding:16px;">No security events in the last 7 days.</div>';
    } catch (e) { $('sec-alerts-feed').innerHTML = `<div class="table-empty-text">${esc(e.message)}</div>`; }
  };

  // ── Broadcast ──
  window.secBroadcast = async function () {
    const title = $('bc-title').value.trim(), body = $('bc-body').value.trim(), url = $('bc-url').value.trim();
    if (!body) return showToast('Enter a message.', 'warning');
    try { const r = await api('/api/dev/security/broadcast', { method: 'POST', body: JSON.stringify({ title, body, url, banner: $('bc-banner').checked }) });
      showToast(`Broadcast sent to ${r.pushed} device(s)`, 'success'); $('bc-body').value = ''; }
    catch (e) { showToast(e.message, 'error'); }
  };
  window.secClearBanner = async function () {
    try { await api('/api/dev/security/broadcast/clear-banner', { method: 'POST' }); showToast('Banner cleared', 'success'); }
    catch (e) { showToast(e.message, 'error'); }
  };

  // ── Lockdown ──
  let lockOn = false;
  window.secLoadLockdown = async function () {
    try { const r = await api('/api/dev/security/lockdown'); lockOn = r.on; renderLock(); } catch (e) {}
  };
  function renderLock() {
    $('sec-lockdown-state').innerHTML = lockOn
      ? '<span style="color:var(--red);font-weight:700;"><i class="ti ti-lock"></i> LOCKDOWN ACTIVE — only developers can access the site.</span>'
      : '<span style="color:var(--green);"><i class="ti ti-lock-open"></i> Site is open (normal access).</span>';
    const btn = $('sec-lockdown-btn');
    btn.className = lockOn ? 'btn btn-ghost' : 'btn btn-danger';
    btn.innerHTML = lockOn ? '<i class="ti ti-lock-open"></i> Lift lockdown' : '<i class="ti ti-lock"></i> Engage lockdown';
  }
  window.secToggleLockdown = async function () {
    const next = !lockOn;
    if (next && !confirm('Engage site lockdown? Everyone except developers will be locked out immediately.')) return;
    try { const r = await api('/api/dev/security/lockdown', { method: 'POST', body: JSON.stringify({ on: next }) }); lockOn = r.on; renderLock(); showToast(lockOn ? 'Lockdown engaged' : 'Lockdown lifted', lockOn ? 'warning' : 'success'); }
    catch (e) { showToast(e.message, 'error'); }
  };

  // ── Compliance ──
  window.secLoadCompliance = async function () {
    $('sec-compliance').innerHTML = '<div class="table-loading"><div class="spinner"></div></div>';
    try {
      const c = await api('/api/dev/security/passkey-compliance');
      $('sec-compliance').innerHTML = `<div style="padding:6px 10px 14px;font-size:13px;color:var(--text-muted);">${c.compliant} of ${c.total} staff have a passkey enrolled.</div>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>Officer</th><th>Role</th><th>Passkeys</th><th>Status</th></tr></thead><tbody>
      ${c.rows.map(r => `<tr><td>${esc(r.name)}</td><td>${esc(r.role)}</td><td>${r.passkeys}</td>
        <td>${r.compliant ? '<span class="badge badge-approved"><span class="badge-dot"></span>Enrolled</span>' : '<span class="badge badge-denied"><span class="badge-dot"></span>No passkey</span>'}</td></tr>`).join('')}
      </tbody></table></div>`;
    } catch (e) { $('sec-compliance').innerHTML = `<div class="table-empty-text">${esc(e.message)}</div>`; }
  };

  secLoadOverview();
})();
