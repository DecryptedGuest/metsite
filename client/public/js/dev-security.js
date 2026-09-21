/* dev-security.js — the Dev Security Center (/dev/security). Developer-only.
   Session command + kill, break-glass lockdown, global broadcast, security
   alert feed, and 2FA compliance. All calls go to /api/dev/security. */
(function () {
  const esc = window.escapeHtml || (s => String(s == null ? '' : s));
  const $ = id => document.getElementById(id);
  const fmt = d => { try { return window.formatDateTime ? window.formatDateTime(d) : new Date(d).toLocaleString(); } catch (e) { return '·'; } };

  function showPage(name) {
    document.querySelectorAll('.sidebar-nav .nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === name));
    document.querySelectorAll('.main-content .page').forEach(p => p.classList.toggle('active', p.id === 'page-' + name));
    if (name === 'sessions') secLoadSessions();
    if (name === 'presence') secLoadPresence();
    if (name === 'integrity') { /* on-demand via button */ }
    if (name === 'alerts') secLoadAlerts();
    if (name === 'lockdown') secLoadLockdown();
    if (name === 'approvals') secLoadApprovals();
    if (name === 'passkeys') secLoadCompliance();
    if (name === 'overview') secLoadOverview();
  }
  document.querySelectorAll('.sidebar-nav .nav-item').forEach(b => b.addEventListener('click', () => showPage(b.dataset.page)));

  function evLine(e) {
    // Attack-adjacent signals (failed logins, brute-force lockouts, QR phishing
    // mismatches, denied privileged access) are flagged distinctly.
    const suspicious = /FAIL|LOCKOUT|MISMATCH|DENIED|SUSPICIOUS|SSRF/.test(e.action);
    const sev = (suspicious || /LOCKDOWN|REVOKE|BLACKLIST|BAN|FORCE|KICK|DELETE/.test(e.action)) ? 'var(--red)' : /BROADCAST|RANK|APPROVE/.test(e.action) ? 'var(--amber)' : 'var(--text-secondary)';
    return `<div style="display:flex;gap:10px;padding:9px 0;border-bottom:1px solid var(--border,#2a2a2a);font-size:13px;${suspicious ? 'background:rgba(224,80,58,.06);' : ''}">
      <span style="color:${sev};font-weight:700;min-width:130px;">${suspicious ? '<i class="ti ti-alert-triangle"></i> ' : ''}${esc(e.action)}</span>
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
        ['Suspicious (24h)', alerts.suspicious24h || 0, (alerts.suspicious24h || 0) ? 'var(--red)' : 'var(--green)'],
        ['Security events (7d)', alerts.events.length, 'var(--amber)'],
        ['Multi-IP users', alerts.multiIp.length, alerts.multiIp.length ? 'var(--red)' : 'var(--green)'],
        ['2FA compliant', `${comp.compliant}/${comp.total}`, 'var(--green)'],
      ].map(([l, v, c]) => `<div class="sec-stat"><div class="v" style="color:${c};">${v}</div><div class="l">${l}</div></div>`).join('');
      $('sec-overview-feed').innerHTML = alerts.events.length ? alerts.events.slice(0, 20).map(evLine).join('') : (window.metEmpty ? window.metEmpty({ icon: 'ti-shield-check', title: 'No recent security events' }) : '<div class="table-empty-text" style="padding:16px;">No recent security events.</div>');
      const b = $('sec-alert-badge'); if (b) { const n = alerts.multiIp.length + (alerts.suspicious24h || 0); b.style.display = n ? 'inline-flex' : 'none'; b.textContent = n; }
    } catch (e) { $('sec-stats').innerHTML = `<div class="table-empty-text">${esc(e.message)}</div>`; }
  };

  // ── Sessions ──
  function renderSessionRows(rows, tb) {
    if (!rows.length) { const EMPTY = window.metEmpty ? window.metEmpty({ icon: 'ti-user-off', title: 'Nothing to show' }) : '<div class="table-empty-text">Nothing to show.</div>'; tb.innerHTML = '<tr><td colspan="6" class="table-empty">' + EMPTY + '</td></tr>'; return; }
    tb.innerHTML = rows.map(s => {
      const vpnBadge = s.ipVpn ? ' <span class="badge badge-denied" style="font-size:9px;"><span class="badge-dot"></span>VPN</span>' : '';
      const org = s.ipOrg ? `<div style="color:var(--text-muted);font-size:10px;">${esc(s.ipOrg)}</div>` : '';
      // When the session IP is a VPN, surface the account's most recent REAL ip.
      const realIp = (s.user && s.user.realIp && s.user.realIp !== s.ip)
        ? `<div style="color:var(--green);font-size:10px;" title="Most recent real (non-VPN) IP for this account">real: ${esc(s.user.realIp)}</div>` : '';
      const stateTag = s.revoked ? ' <span style="color:var(--text-muted);font-size:10px;">(revoked)</span>'
        : (s.expired ? ' <span style="color:var(--text-muted);font-size:10px;">(expired)</span>' : '');
      return `<tr>
        <td>${esc(s.user ? s.user.name : s.userId)}${s.current ? ' <span class="badge badge-approved" style="font-size:9px;">THIS DEVICE</span>' : ''}</td>
        <td>${esc(s.user ? s.user.role : '')}</td>
        <td style="font-family:monospace;font-size:12px;">${esc(s.ip || '·')}${vpnBadge}${org}${realIp}</td>
        <td style="font-size:12px;">${esc(s.device || (s.userAgent || '').slice(0, 40) || '·')}</td>
        <td style="font-size:12px;">${fmt(s.lastSeenAt)}${stateTag}</td>
        <td style="text-align:right;display:flex;gap:6px;justify-content:flex-end;">
          <button class="btn btn-ghost btn-sm" title="All logins for this account" onclick="secAccountLogins('${s.userId}','${jsAttr((s.user&&s.user.name)||'')}')"><i class="ti ti-history"></i></button>
          <button class="btn btn-ghost btn-sm" title="Force this officer to sign in again everywhere" onclick="secForceReauth('${s.userId}','${jsAttr((s.user&&s.user.name)||'')}')"><i class="ti ti-logout-2"></i></button>
          <button class="btn btn-danger btn-sm" ${s.current ? 'disabled title="This is your current session"' : (s.revoked || s.expired ? 'disabled' : '')} onclick="secKill('${s.id}')"><i class="ti ti-plug-off"></i> Kill</button>
        </td></tr>`;
    }).join('');
  }
  window.secLoadSessions = async function () {
    const tb = $('sec-sessions-tbody');
    tb.innerHTML = window.metSkeleton ? '<tr><td colspan="6">' + window.metSkeleton('rows', 6) + '</td></tr>' : '<tr><td colspan="6" class="table-loading"><div class="spinner"></div></td></tr>';
    try {
      const rows = await api('/api/dev/security/sessions');
      if (!rows.length) { const EMPTY = window.metEmpty ? window.metEmpty({ icon: 'ti-plug-off', title: 'No active sessions' }) : '<div class="table-empty-text">No active sessions.</div>'; tb.innerHTML = '<tr><td colspan="6" class="table-empty">' + EMPTY + '</td></tr>'; return; }
      renderSessionRows(rows, tb);
    } catch (e) { tb.innerHTML = `<tr><td colspan="6" class="table-empty"><div class="table-empty-text">${esc(e.message)}</div></td></tr>`; }
  };
  // Show every login for one account (including revoked/expired) in the sessions
  // table. Clearing the search box (or re-opening the tab) returns to all sessions.
  window.secAccountLogins = async function (userId, name) {
    const tb = $('sec-sessions-tbody');
    tb.innerHTML = '<tr><td colspan="6" class="table-loading"><div class="spinner"></div></td></tr>';
    try {
      const rows = await api('/api/dev/security/sessions?userId=' + encodeURIComponent(userId));
      showToast(`Showing all logins for ${name || 'this account'} (${rows.length})`, 'info');
      // Reuse the same renderer path by stashing rows and calling the shared render.
      renderSessionRows(rows, tb);
    } catch (e) { tb.innerHTML = `<tr><td colspan="6" class="table-empty"><div class="table-empty-text">${esc(e.message)}</div></td></tr>`; }
  };
  window.secKill = async function (id) {
    if (!(await uiConfirm('Kill this session? The device is signed out immediately.'))) return;
    try { await api('/api/dev/security/sessions/' + id + '/revoke', { method: 'POST' }); showToast('Session killed', 'success'); secLoadSessions(); }
    catch (e) { showToast(e.message, 'error'); }
  };
  window.secForceReauth = async function (userId, name) {
    if (!(await uiConfirm(`Force ${name || 'this officer'} to sign in again on every device?`))) return;
    try { const r = await api('/api/dev/security/users/' + userId + '/force-reauth', { method: 'POST' }); showToast(`Done · ${r.killed} session(s) killed`, 'success'); secLoadSessions(); }
    catch (e) { showToast(e.message, 'error'); }
  };

  // ── Alerts ──
  window.secLoadAlerts = async function () {
    $('sec-alerts-feed').innerHTML = window.metSkeleton ? window.metSkeleton('feed', 5) : '<div class="table-loading"><div class="spinner"></div></div>';
    try {
      const a = await api('/api/dev/security/alerts');
      $('sec-multi-ip').innerHTML = a.multiIp.length
        ? `<div class="panel glass fade-up" style="margin-bottom:14px;border-left:3px solid var(--red);"><div style="padding:12px 16px;font-size:13px;"><strong style="color:var(--red);"><i class="ti ti-map-pin-exclamation"></i> Multiple IPs in the last hour:</strong> ${a.multiIp.map(m => `${esc(m.name)} (${m.ips.length})`).join(' · ')}</div></div>`
        : '';
      $('sec-alerts-feed').innerHTML = a.events.length ? a.events.map(evLine).join('') : (window.metEmpty ? window.metEmpty({ icon: 'ti-shield-check', title: 'No security events', sub: 'None in the last 7 days.' }) : '<div class="table-empty-text" style="padding:16px;">No security events in the last 7 days.</div>');
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
      ? '<span style="color:var(--red);font-weight:700;"><i class="ti ti-lock"></i> LOCKDOWN ACTIVE · only developers can access the site.</span>'
      : '<span style="color:var(--green);"><i class="ti ti-lock-open"></i> Site is open (normal access).</span>';
    const btn = $('sec-lockdown-btn');
    btn.className = lockOn ? 'btn btn-ghost' : 'btn btn-danger';
    btn.innerHTML = lockOn ? '<i class="ti ti-lock-open"></i> Lift lockdown' : '<i class="ti ti-lock"></i> Engage lockdown';
  }
  window.secToggleLockdown = async function () {
    const next = !lockOn;
    if (next && !(await uiConfirm('Engage site lockdown? Everyone except developers will be locked out immediately.'))) return;
    try { const r = await api('/api/dev/security/lockdown', { method: 'POST', body: JSON.stringify({ on: next }) }); lockOn = r.on; renderLock(); showToast(lockOn ? 'Lockdown engaged' : 'Lockdown lifted', lockOn ? 'warning' : 'success'); }
    catch (e) { showToast(e.message, 'error'); }
  };

  // ── Passkey enforcement toggle ──
  let enforceOn = false, iHavePasskey = false;
  async function secLoadEnforce() {
    try { const r = await api('/api/dev/security/require-passkey'); enforceOn = r.on; iHavePasskey = r.youHavePasskey; renderEnforce(); } catch (e) {}
  }
  function renderEnforce() {
    const b = $('sec-enforce-btn'); if (!b) return;
    b.className = enforceOn ? 'btn btn-danger' : 'btn btn-ghost';
    b.innerHTML = enforceOn ? '<i class="ti ti-shield-lock"></i> Enforcing · turn off' : '<i class="ti ti-shield"></i> Enable enforcement';
  }
  window.secToggleEnforce = async function () {
    const next = !enforceOn;
    if (next && !iHavePasskey) return showToast('Add a passkey to your own account first (Profile → Passkeys & 2FA), or you would lock yourself out.', 'warning');
    if (next && !(await uiConfirm('Require all HICOMM/Supervisors/Developers to have a passkey for sensitive actions?'))) return;
    try { const r = await api('/api/dev/security/require-passkey', { method: 'POST', body: JSON.stringify({ on: next }) }); enforceOn = r.on; renderEnforce(); showToast(enforceOn ? 'Passkey enforcement enabled' : 'Enforcement disabled', 'success'); }
    catch (e) { showToast(e.message, 'error'); }
  };

  // ── Compliance ──
  window.secLoadCompliance = async function () {
    secLoadEnforce();
    $('sec-compliance').innerHTML = window.metSkeleton ? window.metSkeleton('rows', 5) : '<div class="table-loading"><div class="spinner"></div></div>';
    try {
      const c = await api('/api/dev/security/passkey-compliance');
      $('sec-compliance').innerHTML = `<div style="padding:6px 10px 14px;font-size:13px;color:var(--text-muted);">${c.compliant} of ${c.total} staff have a passkey enrolled.</div>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>Officer</th><th>Role</th><th>Passkeys</th><th>Status</th></tr></thead><tbody>
      ${c.rows.map(r => `<tr><td>${esc(r.name)}</td><td>${esc(r.role)}</td><td>${r.passkeys}</td>
        <td>${r.compliant ? '<span class="badge badge-approved"><span class="badge-dot"></span>Enrolled</span>' : '<span class="badge badge-denied"><span class="badge-dot"></span>No passkey</span>'}</td></tr>`).join('')}
      </tbody></table></div>`;
    } catch (e) { $('sec-compliance').innerHTML = `<div class="table-empty-text">${esc(e.message)}</div>`; }
  };

  // ── Live presence ──
  window.secLoadPresence = async function () {
    const box = $('sec-presence');
    box.innerHTML = window.metSkeleton ? window.metSkeleton('cards', 5) : '<div class="table-loading"><div class="spinner"></div></div>';
    try {
      const r = await api('/api/dev/security/presence');
      const b = $('sec-presence-badge'); if (b) { b.style.display = r.online.length ? 'inline-flex' : 'none'; b.textContent = r.online.length; }
      // Each card opens that person: seeing who is online is only half of it,
      // the other half is being able to do something about them without going
      // and finding them in three other panels first.
      box.innerHTML = r.online.length ? `<div style="display:flex;flex-wrap:wrap;gap:12px;">${r.online.map(u => `
        <div class="presence-card" onclick="secOpenMember('${esc(u.id)}')" title="Open ${esc(u.name)}">
          <div style="position:relative;">${u.avatar ? `<img src="${esc(u.avatar)}" style="width:36px;height:36px;border-radius:50%;">` : `<div style="width:36px;height:36px;border-radius:50%;background:#222;"></div>`}
            <span style="position:absolute;right:-1px;bottom:-1px;width:11px;height:11px;border-radius:50%;background:var(--green);border:2px solid var(--panel-solid,#151821);"></span></div>
          <div style="min-width:0;"><div style="font-size:13px;font-weight:600;">${esc(u.name)}</div><div style="font-size:11px;color:var(--text-muted);">${esc(u.role || '')} · ${esc(u.ip || '')}</div></div>
          <i class="ti ti-chevron-right" style="margin-left:auto;color:var(--text-muted);"></i>
        </div>`).join('')}</div>` : (window.metEmpty ? window.metEmpty({ icon: 'ti-users', title: 'Nobody is active right now' }) : '<div class="table-empty-text">Nobody is active right now.</div>');
    } catch (e) { box.innerHTML = `<div class="table-empty-text">${esc(e.message)}</div>`; }
  };

  // ── Audit integrity ──
  window.secVerifyAudit = async function () {
    const el = $('sec-verify-result');
    el.innerHTML = '<div class="spinner" style="display:inline-block;"></div> Verifying…';
    try {
      const r = await api('/api/dev/security/audit/verify');
      const clean = r.tampered.length === 0;
      el.innerHTML = `<div style="font-size:15px;font-weight:700;color:${clean ? 'var(--green)' : 'var(--red)'};margin-bottom:8px;">
        <i class="ti ${clean ? 'ti-shield-check' : 'ti-shield-x'}"></i> ${clean ? 'Intact · no tampering detected' : `${r.tampered.length} row(s) FAILED verification`}</div>
        <div style="font-size:12px;color:var(--text-muted);">${r.ok} of ${r.checked} rows verified${r.unhashed ? ` · ${r.unhashed} legacy (unhashed)` : ''}.</div>
        ${!clean ? `<div style="font-size:12px;color:var(--amber);margin-top:6px;line-height:1.6;">
          <i class="ti ti-info-circle"></i> A hashing bug (fixed) covered a field the database never stored, so
          every row written with one · an AI scan that returned no score, for instance · could never verify. Those
          rows were not edited, but there is no way left to tell them apart from ones that were: the field the
          original hash covered is gone.
          <br>Re-baselining accepts the current contents of older rows and starts the guarantee from now.
          It does not prove anything about them.
          <button class="btn btn-ghost btn-sm" style="margin-left:8px;" onclick="rebaselineAudit(this)">
            <i class="ti ti-flag"></i> Re-baseline older rows</button>
        </div>` : ''}
        ${clean ? '' : `<div style="margin-top:8px;font-size:12px;color:var(--red);">${r.tampered.slice(0, 8).map(t => esc(t.action + ' · ' + (t.summary || t.id))).join('<br>')}</div>`}`;
    } catch (e) { el.innerHTML = `<span style="color:var(--red);">${esc(e.message)}</span>`; }
  };

  // ── Four-eyes approvals ──
  window.secPropose = async function () {
    const action = $('ap-action').value, detail = $('ap-detail').value.trim(), reason = $('ap-reason').value.trim();
    let params = {};
    if (action === 'LOCKDOWN') params = { on: true };
    if (action === 'BROADCAST') { if (!detail) return showToast('Enter a broadcast message.', 'warning'); params = { title: 'Message from High Command', body: detail, banner: true }; }
    try {
      const r = await api('/api/dev/security/approvals', { method: 'POST', body: JSON.stringify({ action, params, reason }) });
      showToast(r && r.executed ? 'Executed (you are the only developer)' : 'Proposed · awaiting a second developer', 'success');
      $('ap-detail').value = ''; $('ap-reason').value = ''; secLoadApprovals();
    }
    catch (e) { showToast(e.message, 'error'); }
  };
  window.secLoadApprovals = async function () {
    const box = $('sec-approvals');
    box.innerHTML = window.metSkeleton ? window.metSkeleton('feed', 5) : '<div class="table-loading"><div class="spinner"></div></div>';
    try {
      const rows = await api('/api/dev/security/approvals');
      const b = $('sec-approvals-badge'); if (b) { b.style.display = rows.length ? 'inline-flex' : 'none'; b.textContent = rows.length; }
      box.innerHTML = rows.length ? rows.map(a => `
        <div style="display:flex;gap:12px;align-items:center;padding:12px 0;border-bottom:1px solid var(--border,#2a2a2a);">
          <div style="flex:1;"><div style="font-weight:700;font-size:14px;">${esc(a.action)}${a.params && a.params.body ? ' · ' + esc(a.params.body) : ''}</div>
            <div style="font-size:12px;color:var(--text-muted);">by ${esc(a.requestedByName || '')}${a.reason ? ' · ' + esc(a.reason) : ''} · ${fmt(a.createdAt)}</div></div>
          ${a.mine ? '<span class="badge badge-pending"><span class="badge-dot"></span>Your proposal · needs another dev</span>'
            : `<button class="btn btn-primary btn-sm" onclick="secApprove('${a.id}')"><i class="ti ti-check"></i> Approve</button>
               <button class="btn btn-ghost btn-sm" style="color:var(--red);" title="Reject" aria-label="Reject" onclick="secReject('${a.id}')"><i class="ti ti-x"></i></button>`}
        </div>`).join('') : (window.metEmpty ? window.metEmpty({ icon: 'ti-checklist', title: 'No pending approvals' }) : '<div class="table-empty-text">No pending approvals.</div>');
    } catch (e) { box.innerHTML = `<div class="table-empty-text">${esc(e.message)}</div>`; }
  };
  window.secApprove = async function (id) {
    if (!(await uiConfirm('Approve and execute this action now?'))) return;
    try { await api('/api/dev/security/approvals/' + id + '/approve', { method: 'POST' }); showToast('Approved & executed', 'success'); secLoadApprovals(); }
    catch (e) { showToast(e.message, 'error'); }
  };
  window.secReject = async function (id) {
    try { await api('/api/dev/security/approvals/' + id + '/reject', { method: 'POST' }); showToast('Rejected', 'success'); secLoadApprovals(); }
    catch (e) { showToast(e.message, 'error'); }
  };

  secLoadOverview();
})();


// Draw a line under the old rows. This does not vindicate them — it accepts
// them — so the confirmation says exactly that before anything is written.
async function rebaselineAudit(btn) {
  const okd = await (typeof uiConfirm === 'function'
    ? uiConfirm('Re-baseline the audit trail?\n\nThis accepts the CURRENT contents of every older row as correct '
      + 'and re-hashes them. It does not prove they were never edited · that information is gone. '
      + 'Tampering from this point on is still detected.')
    : Promise.resolve(confirm('Accept the current contents of older rows as the baseline?')));
  if (!okd) return;
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner"></div> Re-baselining…'; }
  try {
    const r = await api('/api/dev/security/audit/rebaseline', {
      method: 'POST', body: JSON.stringify({ acknowledge: true }),
    });
    showToast(`Re-baselined ${r.rebaselined} row(s). The trail is verifiable from now on.`, 'success');
    if (typeof verifyAudit === 'function') verifyAudit();
  } catch (err) {
    showToast(err.message || 'Re-baseline failed.', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-flag"></i> Re-baseline older rows'; }
  }
}

// ── Live-presence member card ─────────────────────────────────────
// Clicking somebody on Live Presence opens everything known about them and
// everything that can be done to them, in one place. Seeing who is online is
// only half the job — the other half was spread across four other panels.
//
// Every destructive action confirms by name first, and each one is already
// audited server-side, so this adds reach rather than a new way to do damage
// quietly.
(function () {
  var esc = window.escapeHtml || function (s) { return String(s == null ? '' : s); };
  var $ = function (id) { return document.getElementById(id); };
  var MEM = null;

  function when(d) {
    if (!d) return 'never';
    try { return window.formatDateTime ? formatDateTime(d) : new Date(d).toLocaleString(); }
    catch (e) { return String(d); }
  }
  function ago(d) {
    if (!d) return '';
    var s = Math.max(0, Math.floor((Date.now() - new Date(d)) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  function row(label, value, mono) {
    return '<div class="mem-kv"><span class="mem-k">' + esc(label) + '</span>'
      + '<span class="mem-v' + (mono ? ' mono' : '') + '">' + (value || '<span class="text-muted">·</span>') + '</span></div>';
  }

  function action(id, icon, label, tone) {
    return '<button class="mem-action' + (tone ? ' mem-action-' + tone : '') + '" data-mem-act="' + id + '">'
      + '<i class="ti ti-' + icon + '"></i><span>' + esc(label) + '</span></button>';
  }

  window.secOpenMember = async function (id) {
    var body = $('mem-body');
    if (!body) { showToast('The member panel is unavailable on this page.', 'error'); return; }
    body.innerHTML = '<div class="table-loading"><div class="spinner"></div></div>';
    var t = $('mem-title'); if (t) t.textContent = 'Member';
    openModal('modal-member');
    try {
      MEM = await api('/api/dev/security/member/' + encodeURIComponent(id));
      render();
    } catch (err) {
      body.innerHTML = '<div class="table-empty-text" style="padding:18px;">' + esc(err.message || 'Failed to load that member.') + '</div>';
    }
  };

  function render() {
    var u = MEM.user, body = $('mem-body');
    var t = $('mem-title'); if (t) t.textContent = u.displayName || u.discordUsername || 'Member';

    var live = MEM.sessions.filter(function (s) { return s.live; });
    var open = MEM.sessions.filter(function (s) { return !s.revoked && !s.expired; });

    var divisions = (u.divisions || []).length
      ? u.divisions.map(function (d) {
          return '<span class="badge badge-blue"><span class="badge-dot"></span>' + esc(d.division)
            + (d.rankName ? ' · ' + esc(d.rankName) : '') + (d.hicomm ? ' · HC' : '') + '</span>';
        }).join(' ')
      : null;

    var identity = '<div class="mem-head">'
      + (u.discordAvatar ? '<img src="' + esc(u.discordAvatar) + '" class="mem-avatar">' : '<div class="mem-avatar"></div>')
      + '<div style="min-width:0;">'
      +   '<div class="mem-name">' + esc(u.displayName || u.discordUsername || 'Unknown') + '</div>'
      +   '<div class="mem-sub">' + esc(u.role || '') + (u.discordUsername ? ' · @' + esc(u.discordUsername) : '') + '</div>'
      + '</div>'
      + (u.isBlacklisted ? '<span class="badge badge-denied" style="margin-left:auto;"><span class="badge-dot"></span>Blacklisted</span>' : '')
      + '</div>';

    var facts = '<div class="mem-grid">'
      + row('Discord ID', u.discordId ? esc(u.discordId) : null, true)
      + row('Roblox', u.robloxUsername
          ? '<a href="https://www.roblox.com/users/' + esc(u.robloxId) + '/profile" target="_blank" rel="noopener" style="color:var(--blue);">'
            + esc(u.robloxUsername) + '</a>' : null)
      + row('Divisions', divisions)
      + row('Passkeys', MEM.passkeys
          ? '<span class="badge badge-approved"><span class="badge-dot"></span>' + MEM.passkeys + ' enrolled</span>'
          : '<span class="badge badge-denied"><span class="badge-dot"></span>None</span>')
      + row('Live sessions', live.length + ' now · ' + open.length + ' open')
      + row('Last seen', esc(when(u.lastLogin)) + ' <span class="text-muted">' + esc(ago(u.lastLogin)) + '</span>')
      + row('Last real IP', u.lastRealIp ? esc(u.lastRealIp) : null, true)
      + row('Filed', MEM.counts.cases + ' case(s) · ' + MEM.counts.tickets + ' ticket(s)')
      + row('Account since', esc(when(u.createdAt)))
      + (u.isBlacklisted && u.blacklistReason ? row('Blacklist reason', esc(u.blacklistReason)) : '')
      + '</div>';

    // Everything that can be done to them, grouped by how much it hurts.
    var actions = '<div class="mem-actions">'
      + '<div class="mem-actions-head">Look up</div>'
      + '<div class="mem-action-row">'
      +   action('copy-discord', 'copy', 'Copy Discord ID')
      +   action('copy-id', 'hash', 'Copy account ID')
      +   (u.robloxId ? action('roblox', 'brand-appstore', 'Open Roblox profile') : '')
      +   action('records', 'id-badge-2', 'Look up in Records')
      +   action('audit', 'list-details', 'Their audit trail')
      + '</div>'

      + '<div class="mem-actions-head">Session</div>'
      + '<div class="mem-action-row">'
      +   action('refresh', 'refresh', 'Refresh this card')
      +   (open.length ? action('reauth', 'logout', 'Sign out everywhere (' + open.length + ')', 'warn') : '')
      + '</div>'

      + '<div class="mem-actions-head">Account</div>'
      + '<div class="mem-action-row">'
      +   action('notify', 'bell', 'Send them a notification')
      +   action('role', 'user-shield', 'Change site role', 'warn')
      +   (u.isBlacklisted
            ? action('unblacklist', 'lock-open', 'Lift the blacklist', 'warn')
            : action('blacklist', 'ban', 'Blacklist from the site', 'danger'))
      + '</div>'
      + '</div>';

    var sessions = MEM.sessions.length
      ? '<div class="mem-actions-head" style="margin-top:14px;">Sessions</div>'
        + '<div class="table-wrap"><table class="data-table"><thead><tr>'
        + '<th>Device</th><th>IP</th><th>Last seen</th><th>State</th><th></th></tr></thead><tbody>'
        + MEM.sessions.map(function (s) {
            return '<tr>'
              + '<td><span style="font-size:12px;">' + esc(s.device || 'Unknown') + '</span></td>'
              + '<td><span class="mono" style="font-size:11.5px;">' + esc(s.ip || '·')
                + (s.ipVpn ? ' <span class="badge badge-amber"><span class="badge-dot"></span>VPN</span>' : '') + '</span></td>'
              + '<td><span class="date-cell">' + esc(ago(s.lastSeenAt)) + '</span></td>'
              + '<td>' + (s.revoked ? '<span class="badge badge-muted"><span class="badge-dot"></span>Revoked</span>'
                        : s.expired ? '<span class="badge badge-muted"><span class="badge-dot"></span>Expired</span>'
                        : s.live    ? '<span class="badge badge-approved"><span class="badge-dot"></span>Live</span>'
                                    : '<span class="badge badge-pending"><span class="badge-dot"></span>Idle</span>') + '</td>'
              + '<td>' + (!s.revoked && !s.expired
                  ? '<button class="row-btn row-btn-deny" data-mem-kill="' + esc(s.id) + '" title="Kill this session"><i class="ti ti-plug-off"></i></button>'
                  : '') + '</td>'
              + '</tr>';
          }).join('')
        + '</tbody></table></div>'
      : '';

    var recent = MEM.recent.length
      ? '<div class="mem-actions-head" style="margin-top:14px;">Recent activity</div>'
        + '<ul class="mem-recent">' + MEM.recent.map(function (a) {
            return '<li><span class="mem-recent-when">' + esc(ago(a.createdAt)) + '</span>'
              + '<span class="mem-recent-what">' + esc(a.summary || (a.category + ' · ' + a.action)) + '</span></li>';
          }).join('') + '</ul>'
      : '';

    body.innerHTML = identity + facts + actions + sessions + recent;
  }

  // One delegated listener on the modal, bound once — the body is rebuilt on
  // every open, so per-element listeners would stack up.
  document.addEventListener('DOMContentLoaded', function () {
    var modal = $('modal-member');
    if (!modal || modal.dataset.wired === '1') return;
    modal.dataset.wired = '1';
    modal.addEventListener('click', function (e) {
      var kill = e.target.closest('[data-mem-kill]');
      if (kill) return killSession(kill.dataset.memKill);
      var act = e.target.closest('[data-mem-act]');
      if (act) return runAction(act.dataset.memAct);
    });
  });

  async function killSession(id) {
    var okd = await confirmIt('Kill this session?\n\nThey are signed out on that device immediately.');
    if (!okd) return;
    try {
      await api('/api/dev/security/sessions/' + encodeURIComponent(id) + '/revoke', { method: 'POST' });
      showToast('Session killed.', 'success');
      secOpenMember(MEM.user.id);
      if (typeof secLoadPresence === 'function') secLoadPresence();
    } catch (err) { showToast(err.message || 'Could not kill that session.', 'error'); }
  }

  function confirmIt(msg) {
    return typeof uiConfirm === 'function' ? uiConfirm(msg) : Promise.resolve(confirm(msg));
  }
  function askFor(msg, opts) {
    return typeof uiPrompt === 'function' ? uiPrompt(msg, opts) : Promise.resolve(prompt(msg));
  }

  async function runAction(id) {
    var u = MEM.user;
    var name = u.displayName || u.discordUsername || 'this member';

    if (id === 'refresh')       return secOpenMember(u.id);
    if (id === 'copy-discord')  return copyIt(u.discordId, 'Discord ID');
    if (id === 'copy-id')       return copyIt(u.id, 'Account ID');
    if (id === 'roblox')        return window.open('https://www.roblox.com/users/' + u.robloxId + '/profile', '_blank', 'noopener');
    if (id === 'records')       return window.open('/ia/dashboard#records=' + encodeURIComponent(u.robloxUsername || u.discordId || ''), '_blank', 'noopener');
    if (id === 'audit')         return window.open('/dev/security#audit=' + encodeURIComponent(u.id), '_blank', 'noopener');

    if (id === 'reauth') {
      if (!(await confirmIt('Sign ' + name + ' out everywhere?\n\nEvery open session is revoked and they have to sign in again.'))) return;
      try {
        var r = await api('/api/dev/security/users/' + encodeURIComponent(u.id) + '/force-reauth', { method: 'POST' });
        showToast('Signed out · ' + r.killed + ' session(s) killed.', 'success');
        secOpenMember(u.id);
        if (typeof secLoadPresence === 'function') secLoadPresence();
      } catch (err) { showToast(err.message || 'Could not sign them out.', 'error'); }
      return;
    }

    if (id === 'notify') {
      var msg = await askFor('What should ' + name + ' be told?', { multiline: true });
      if (!msg || !String(msg).trim()) return;
      try {
        await api('/api/notifications/send', {
          method: 'POST',
          body: JSON.stringify({ userIds: [u.id], title: 'Message from a developer', body: String(msg).trim() }),
        });
        showToast('Sent.', 'success');
      } catch (err) { showToast(err.message || 'Could not send that.', 'error'); }
      return;
    }

    if (id === 'role') {
      var role = await askFor('New site role for ' + name + '?\n\nNONE, IA, SUPERVISOR, HICOMM or DEVELOPER.',
        { value: u.role || 'NONE' });
      if (!role) return;
      role = String(role).trim().toUpperCase();
      if (['NONE', 'IA', 'SUPERVISOR', 'HICOMM', 'DEVELOPER'].indexOf(role) === -1) {
        showToast('That is not a role.', 'error'); return;
      }
      if (role === u.role) { showToast('That is already their role.', 'success'); return; }
      if (!(await confirmIt('Change ' + name + ' from ' + (u.role || 'NONE') + ' to ' + role + '?'))) return;
      try {
        await api('/api/admin/users/' + encodeURIComponent(u.id) + '/role',
          { method: 'PATCH', body: JSON.stringify({ role: role }) });
        showToast('Role changed to ' + role + '.', 'success');
        secOpenMember(u.id);
      } catch (err) { showToast(err.message || 'Could not change their role.', 'error'); }
      return;
    }

    if (id === 'blacklist') {
      var why = await askFor('Blacklist ' + name + ' from the site?\n\nThey lose access immediately. Say why:', { multiline: true });
      if (!why || !String(why).trim()) return;
      try {
        await api('/api/admin/users/' + encodeURIComponent(u.id) + '/blacklist',
          { method: 'POST', body: JSON.stringify({ reason: String(why).trim() }) });
        showToast('Blacklisted.', 'success');
        secOpenMember(u.id);
        if (typeof secLoadPresence === 'function') secLoadPresence();
      } catch (err) { showToast(err.message || 'Could not blacklist them.', 'error'); }
      return;
    }

    if (id === 'unblacklist') {
      if (!(await confirmIt('Lift the blacklist on ' + name + '?'))) return;
      try {
        await api('/api/admin/users/' + encodeURIComponent(u.id) + '/unblacklist', { method: 'POST' });
        showToast('Blacklist lifted.', 'success');
        secOpenMember(u.id);
      } catch (err) { showToast(err.message || 'Could not lift it.', 'error'); }
      return;
    }
  }

  function copyIt(value, what) {
    if (!value) { showToast('There is no ' + what + ' on this account.', 'error'); return; }
    if (typeof copyText === 'function') return copyText(value, what);
    try { navigator.clipboard.writeText(value); showToast(what + ' copied.', 'success'); }
    catch (e) { showToast('Could not copy it.', 'error'); }
  }
})();
