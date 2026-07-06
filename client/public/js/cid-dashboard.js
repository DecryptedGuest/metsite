/* CID dashboard — parallel to the HPC tryout dashboard, scoped to /api/cid.
   Handles: schedule/list/cancel tryouts, the Live tab (watch + drive running
   tryouts via the site command queue), My Tryout Logs (review + post), and the
   Director's Office review queue (approve/deny). */
(function () {
  const esc = window.escapeHtml || (s => String(s == null ? '' : s));
  let CTX = { canApprove: false, isDev: false };
  let liveTimer = null;
  let logFilter = 'PENDING';
  let cidTryoutsById = {};   // id -> tryout summary, for the clickable detail view

  // ── Nav / page switching ──────────────────────────────────────────
  function showPage(name) {
    document.querySelectorAll('.sidebar-nav .nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === name));
    document.querySelectorAll('.main-content .page').forEach(p => p.classList.toggle('active', p.id === 'page-' + name));
    if (name === 'live') startLive(); else stopLive();
    if (name === 'tryouts')      cidLoadTryouts();
    if (name === 'tryout-logs')  cidLoadMyLogs();
    if (name === 'review-logs')  cidLoadReviewLogs();
  }
  function wireNav() {
    document.querySelectorAll('.sidebar-nav .nav-item').forEach(btn => {
      btn.addEventListener('click', () => showPage(btn.dataset.page));
    });
    document.querySelectorAll('#cid-logfilter-tabs .filter-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('#cid-logfilter-tabs .filter-tab').forEach(t => t.classList.toggle('active', t === tab));
        logFilter = tab.dataset.filter; cidLoadReviewLogs();
      });
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────
  function fmtWhen(d) { try { return window.formatDateTime ? window.formatDateTime(d) : new Date(d).toLocaleString(); } catch (e) { return '—'; } }
  function tryoutStatusBadge(t) {
    const map = {
      SCHEDULED: ['badge-pending', 'Scheduled'],
      LIVE:      ['badge-approved', '<i class="ti ti-broadcast"></i> Live'],
      COMPLETED: ['badge-approved', 'Completed'],
      CANCELLED: ['badge-denied', 'Cancelled'],
    };
    const [cls, label] = map[t.status] || ['badge-pending', esc(t.status)];
    return `<span class="badge ${cls}"><span class="badge-dot"></span>${label}</span>`;
  }
  function logStatusBadge(s) {
    const map = { DRAFT: ['badge-pending', 'Draft'], PENDING: ['badge-pending', 'Pending'], APPROVED: ['badge-approved', 'Approved'], DENIED: ['badge-denied', 'Denied'] };
    const [cls, label] = map[s] || ['badge-pending', esc(s)];
    return `<span class="badge ${cls}"><span class="badge-dot"></span>${label}</span>`;
  }

  // ── Tryouts list ───────────────────────────────────────────────────
  window.cidLoadTryouts = async function () {
    const tb = document.getElementById('cid-tryouts-tbody');
    tb.innerHTML = '<tr><td colspan="6" class="table-loading"><div class="spinner"></div></td></tr>';
    try {
      const rows = await api('/api/cid/tryouts');
      cidTryoutsById = {}; rows.forEach(t => { cidTryoutsById[t.id] = t; });
      if (!rows.length) { tb.innerHTML = '<tr><td colspan="6" class="table-empty"><div class="table-empty-text">No tryouts yet. Schedule one to get started.</div></td></tr>'; return; }
      tb.innerHTML = rows.map(t => {
        const linkUrl = t.privateServerLink || t.joinUrl;
        const link = linkUrl ? `<a href="${esc(linkUrl)}" target="_blank" rel="noopener" onclick="event.stopPropagation();" style="color:var(--blue);">Link</a>` : '<span style="color:var(--text-muted);">TBA</span>';
        const canEnd = (t.isMine || CTX.isDev) && !['COMPLETED', 'CANCELLED'].includes(t.status);
        const stop = 'onclick="event.stopPropagation();';
        const btns = [];
        if (canEnd && t.status === 'LIVE') btns.push(`<button class="btn btn-ghost btn-sm" ${stop}cidCompleteTryout('${t.id}')"><i class="ti ti-check"></i> End</button>`);
        if (canEnd) btns.push(`<button class="btn btn-ghost btn-sm" ${stop}cidCancelTryout('${t.id}')"><i class="ti ti-x"></i> Cancel</button>`);
        if (CTX.isDev) btns.push(`<button class="btn btn-ghost btn-sm" style="color:var(--red);" title="Delete (dev)" ${stop}cidDeleteTryout('${t.id}')"><i class="ti ti-trash"></i></button>`);
        const actions = btns.length ? `<div style="display:flex;gap:6px;justify-content:flex-end;">${btns.join('')}</div>` : '';
        return `<tr style="cursor:pointer;" onclick="cidOpenTryout('${t.id}')"><td>${fmtWhen(t.scheduledAt)}</td><td>${esc(t.hostName || '—')}</td><td>${esc(t.coHostName || 'N/A')}</td><td>${tryoutStatusBadge(t)}</td><td>${link}</td><td>${actions}</td></tr>`;
      }).join('');
    } catch (e) { tb.innerHTML = `<tr><td colspan="6" class="table-empty"><div class="table-empty-text">${esc(e.message)}</div></td></tr>`; }
  };

  window.cidOpenSchedule = function () {
    const el = document.getElementById('cid-tryout-when'); if (el) el.value = '';
    const n = document.getElementById('cid-tryout-notes'); if (n) n.value = '';
    openModal('modal-cid-tryout');
  };
  window.cidSubmitSchedule = async function () {
    const when = document.getElementById('cid-tryout-when').value;
    const lock = document.getElementById('cid-tryout-lock').value;
    const notes = document.getElementById('cid-tryout-notes').value;
    if (!when) return showToast('Pick a date & time.', 'warning');
    try {
      await api('/api/cid/tryouts', { method: 'POST', body: JSON.stringify({ scheduledAt: new Date(when).toISOString(), lockState: lock, notes }) });
      closeModal('modal-cid-tryout'); showToast('Tryout scheduled', 'success'); cidLoadTryouts();
    } catch (e) { showToast(e.message, 'error'); }
  };
  window.cidCancelTryout = async function (id) {
    if (!confirm('Cancel this tryout? Its announcement will be removed.')) return;
    try { await api('/api/cid/tryouts/' + id + '/cancel', { method: 'POST' }); showToast('Tryout cancelled', 'success'); cidLoadTryouts(); }
    catch (e) { showToast(e.message, 'error'); }
  };
  window.cidCompleteTryout = async function (id) {
    try { await api('/api/cid/tryouts/' + id + '/complete', { method: 'POST' }); showToast('Tryout ended', 'success'); cidLoadTryouts(); }
    catch (e) { showToast(e.message, 'error'); }
  };
  window.cidDeleteTryout = async function (id) {
    if (!confirm('Permanently delete this tryout? This cannot be undone.')) return;
    try { await api('/api/dev/tryouts/' + id, { method: 'DELETE' }); showToast('Tryout deleted', 'success'); closeModal('modal-cid-log'); cidLoadTryouts(); }
    catch (e) { showToast(e.message, 'error'); }
  };

  // Clickable tryout detail — reuses the log modal shell for a consistent look.
  window.cidOpenTryout = function (id) {
    const t = cidTryoutsById[id];
    if (!t) return;
    openModal('modal-cid-log');
    document.getElementById('cid-tlog-title').textContent = 'Tryout — ' + (t.hostName || '');
    const linkUrl = t.privateServerLink || t.joinUrl;
    const link = linkUrl ? `<a href="${esc(linkUrl)}" target="_blank" rel="noopener" style="color:var(--blue);">${esc(linkUrl)}</a>` : '<span style="color:var(--text-muted);">TBA</span>';
    const row = (label, val) => `<div style="display:flex;gap:10px;padding:7px 0;border-bottom:1px solid var(--border,#2a2a2a);"><div style="min-width:130px;color:var(--text-muted);font-size:12px;">${label}</div><div style="font-size:13px;">${val}</div></div>`;
    document.getElementById('cid-tlog-body').innerHTML =
      row('Status', tryoutStatusBadge(t)) +
      row('Host', esc(t.hostName || '—')) +
      row('Co-Host', esc(t.coHostName || 'N/A')) +
      row('Scheduled', fmtWhen(t.scheduledAt)) +
      row('Server lock', esc(t.lockState || '—')) +
      row('Game link', link) +
      row('Announcement', t.announcementSent ? 'Posted' : 'Not posted') +
      (t.notes ? row('Notes', esc(t.notes)) : '') +
      row('Created', fmtWhen(t.createdAt));
    const canEnd = (t.isMine || CTX.isDev) && !['COMPLETED', 'CANCELLED'].includes(t.status);
    const btns = [`<button class="btn btn-ghost" onclick="closeModal('modal-cid-log')">Close</button>`];
    if (canEnd && t.status === 'LIVE') btns.push(`<button class="btn btn-ghost" onclick="cidCompleteTryout('${t.id}');closeModal('modal-cid-log');"><i class="ti ti-check"></i> End</button>`);
    if (canEnd) btns.push(`<button class="btn btn-danger" onclick="cidCancelTryout('${t.id}');closeModal('modal-cid-log');"><i class="ti ti-x"></i> Cancel</button>`);
    if (CTX.isDev) btns.push(`<button class="btn btn-ghost" style="color:var(--red);" onclick="cidDeleteTryout('${t.id}')"><i class="ti ti-trash"></i> Delete</button>`);
    document.getElementById('cid-tlog-footer').innerHTML = btns.join('');
  };

  // ── Live tab ───────────────────────────────────────────────────────
  function startLive() { stopLive(); pollLive(); liveTimer = setInterval(pollLive, 4000); }
  function stopLive()  { if (liveTimer) { clearInterval(liveTimer); liveTimer = null; } }

  async function pollLive() {
    const wrap = document.getElementById('cid-live-wrap');
    const statusEl = document.getElementById('cid-live-status');
    const badge = document.getElementById('cid-live-badge');
    try {
      const live = await api('/api/cid/tryouts/live');
      if (badge) { badge.style.display = live.length ? 'inline-flex' : 'none'; badge.textContent = live.length; }
      if (statusEl) statusEl.innerHTML = `<span class="badge-dot"></span>${live.length ? live.length + ' live' : 'No live tryouts'}`;
      if (!live.length) { wrap.innerHTML = '<div class="panel glass"><div class="table-empty"><div class="table-empty-text">No tryouts are live right now.</div></div></div>'; return; }
      wrap.innerHTML = live.map(renderLiveCard).join('');
    } catch (e) {
      if (statusEl) statusEl.innerHTML = `<span class="badge-dot"></span>${esc(e.message)}`;
    }
  }

  function renderLiveCard(t) {
    const snap = t.snapshot || {};
    const att = Array.isArray(snap.attendees) ? snap.attendees : [];
    const lock = String(t.lockState || '').toUpperCase();
    const lockBadge = ['UNLOCKED', 'UNSLOCKED'].includes(lock)
      ? '<span class="badge badge-approved"><span class="badge-dot"></span><i class="ti ti-lock-open"></i> Unlocked</span>'
      : '<span class="badge badge-denied"><span class="badge-dot"></span><i class="ti ti-lock"></i> Locked</span>';
    const rows = att.length ? att.map(a => attendeeRow(t, a)).join('') : '<tr><td colspan="4" class="table-empty"><div class="table-empty-text">No attendees reported yet.</div></td></tr>';
    const manageNote = t.canManage ? '' : '<span style="font-size:11px;color:var(--text-muted);margin-left:8px;">View only — host/co-host can manage.</span>';
    return `<div class="panel glass fade-up" style="margin-bottom:1rem;">
      <div class="panel-header">
        <div class="panel-title"><span class="panel-dot green"></span>${esc(t.hostName || 'Tryout')} ${t.coHostName ? '· co: ' + esc(t.coHostName) : ''}</div>
        <div style="display:flex;gap:8px;align-items:center;">${lockBadge}
          <span class="met-chip"><i class="ti ti-users"></i> ${snap.totalAttendees != null ? snap.totalAttendees : att.length}</span>
          <span class="met-chip" style="color:var(--green);border-color:var(--green);">${snap.passedCount || 0} passed</span>
          <span class="met-chip" style="color:var(--red);border-color:var(--red);">${snap.failedCount || 0} failed</span>${manageNote}</div>
      </div>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Attendee</th><th>Result</th><th>Strikes</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>
    </div>`;
  }

  function attendeeRow(t, a) {
    const uname = esc(a.username || 'Unknown');
    const rid = a.robloxId ? `data-rid="${esc(a.robloxId)}"` : '';
    const resColor = a.result === 'PASS' ? 'var(--green)' : (a.result === 'FAIL' ? 'var(--red)' : 'var(--text-muted)');
    const quiz = a.quiz ? `<span class="met-chip" title="Written quiz" style="margin-left:6px;"><i class="ti ti-writing"></i> ${a.quiz.score != null ? esc(a.quiz.score) + (a.quiz.outOf != null ? '/' + esc(a.quiz.outOf) : '') : esc(a.quiz.verdict || 'quiz')}</span>` : '';
    const copy = (a.quiz && a.quiz.copyFlag) ? `<span class="met-chip" title="Possible answer copying${a.quiz.copyWith ? ' — matched ' + esc(a.quiz.copyWith) : ''}" style="margin-left:6px;color:var(--red);border-color:var(--red);"><i class="ti ti-alert-triangle"></i> copy?</span>` : '';
    const flag = a.flagged ? `<span class="met-chip" title="Movement watch flag" style="margin-left:6px;color:var(--amber);border-color:var(--amber);"><i class="ti ti-flag"></i></span>` : '';
    const pts  = (a.pts != null) ? `<span class="met-chip" style="margin-left:6px;font-size:10px;" title="Points">${esc(String(a.pts))} pts</span>` : '';
    const status = a.kicked ? '<span style="color:var(--red);">Kicked</span>' : (a.leftAt ? '<span style="color:var(--text-muted);">Left</span>' : '');
    const btns = t.canManage ? `<div style="display:flex;gap:4px;justify-content:flex-end;flex-wrap:wrap;">
        ${cmdBtn(t.id, a, 'PASS',  'ti-check',  'Pass')}
        ${cmdBtn(t.id, a, 'FAIL',  'ti-x',      'Fail')}
        ${cmdBtn(t.id, a, 'STRIKE','ti-alert-triangle','Strike')}
        ${cmdBtn(t.id, a, 'KICK',  'ti-user-x', 'Kick')}
      </div>` : '';
    return `<tr ${rid}><td>${uname} ${status} ${quiz}${copy}${flag}${pts}</td><td style="color:${resColor};font-weight:600;">${esc(a.result || 'PENDING')}</td><td>${a.strikes || 0}</td><td>${btns}</td></tr>`;
  }
  function cmdBtn(tid, a, action, icon, label) {
    const rid = a.robloxId ? String(a.robloxId) : '';
    const un = esc(a.username || '');
    return `<button class="btn btn-ghost btn-sm" title="${label}" onclick="cidCmd('${tid}','${action}','${rid}','${un}')"><i class="ti ${icon}"></i></button>`;
  }
  window.cidCmd = async function (tid, action, rid, uname) {
    try {
      await api('/api/cid/tryouts/' + tid + '/command', { method: 'POST', body: JSON.stringify({ action, targetRobloxId: rid || null, targetUsername: uname || null }) });
      showToast(action.charAt(0) + action.slice(1).toLowerCase() + ' queued', 'success');
      pollLive();
    } catch (e) { showToast(e.message, 'error'); }
  };

  // ── My tryout logs ─────────────────────────────────────────────────
  window.cidLoadMyLogs = async function () {
    const tb = document.getElementById('cid-mylogs-tbody');
    tb.innerHTML = '<tr><td colspan="7" class="table-loading"><div class="spinner"></div></td></tr>';
    try {
      const logs = await api('/api/cid/tryout-logs/mine');
      if (!logs.length) { tb.innerHTML = '<tr><td colspan="7" class="table-empty"><div class="table-empty-text">No tryout logs yet. Conclude a tryout in-game and it appears here.</div></td></tr>'; return; }
      tb.innerHTML = logs.map(l => logRow(l, false)).join('');
    } catch (e) { tb.innerHTML = `<tr><td colspan="7" class="table-empty"><div class="table-empty-text">${esc(e.message)}</div></td></tr>`; }
  };

  // ── Review logs (Director's Office) ────────────────────────────────
  window.cidLoadReviewLogs = async function () {
    const tb = document.getElementById('cid-reviewlogs-tbody');
    if (!tb) return;
    tb.innerHTML = '<tr><td colspan="7" class="table-loading"><div class="spinner"></div></td></tr>';
    try {
      const logs = await api('/api/cid/tryout-logs/pending?status=' + encodeURIComponent(logFilter));
      if (!logs.length) { tb.innerHTML = '<tr><td colspan="7" class="table-empty"><div class="table-empty-text">Nothing here.</div></td></tr>'; return; }
      tb.innerHTML = logs.map(l => logRow(l, true)).join('');
      const badge = document.getElementById('cid-review-badge');
      if (badge && logFilter === 'PENDING') { badge.style.display = logs.length ? 'inline-flex' : 'none'; badge.textContent = logs.length; }
    } catch (e) { tb.innerHTML = `<tr><td colspan="7" class="table-empty"><div class="table-empty-text">${esc(e.message)}</div></td></tr>`; }
  };

  function logRow(l, review) {
    const first = review ? esc(l.hostName || '—') : fmtWhen(l.concludedAt || l.createdAt);
    const del = CTX.isDev ? `<button class="btn btn-ghost btn-sm" style="color:var(--red);" title="Delete (dev)" onclick="event.stopPropagation();cidDeleteLog('${l.id}',${review})"><i class="ti ti-trash"></i></button>` : '';
    return `<tr style="cursor:pointer;" onclick="cidOpenLog('${l.id}',${review})"><td>${first}</td><td>${l.totalAttendees || 0}</td><td>${l.passedCount || 0}</td><td>${l.failedCount || 0}</td><td>${l.strikeCount || 0}</td><td>${logStatusBadge(l.status)}</td>
      <td style="text-align:right;"><div style="display:flex;gap:6px;justify-content:flex-end;"><button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();cidOpenLog('${l.id}',${review})"><i class="ti ti-eye"></i> View</button>${del}</div></td></tr>`;
  }
  window.cidDeleteLog = async function (id, review) {
    if (!confirm('Permanently delete this tryout log? This cannot be undone.')) return;
    try { await api('/api/dev/tryout-logs/' + id, { method: 'DELETE' }); showToast('Log deleted', 'success'); closeModal('modal-cid-log'); review ? cidLoadReviewLogs() : cidLoadMyLogs(); }
    catch (e) { showToast(e.message, 'error'); }
  };

  // ── Log detail modal ───────────────────────────────────────────────
  window.cidOpenLog = async function (id, review) {
    openModal('modal-cid-log');
    const body = document.getElementById('cid-tlog-body');
    const footer = document.getElementById('cid-tlog-footer');
    body.innerHTML = '<div class="table-loading"><div class="spinner"></div></div>'; footer.innerHTML = '';
    try {
      const l = await api('/api/cid/tryout-logs/' + id);
      document.getElementById('cid-tlog-title').textContent = 'Tryout Log — ' + (l.hostName || '');
      const att = Array.isArray(l.attendees) ? l.attendees : [];
      const rows = att.length ? att.map(a => {
        const quiz = a.quiz ? `<span class="met-chip" style="margin-left:6px;"><i class="ti ti-writing"></i> ${a.quiz.score != null ? esc(a.quiz.score) + (a.quiz.outOf != null ? '/' + esc(a.quiz.outOf) : '') : esc(a.quiz.verdict || 'quiz')}</span>` : '';
        const copy = (a.quiz && a.quiz.copyFlag) ? `<span class="met-chip" title="Possible answer copying${a.quiz.copyWith ? ' — matched ' + esc(a.quiz.copyWith) : ''}" style="margin-left:6px;color:var(--red);border-color:var(--red);"><i class="ti ti-alert-triangle"></i> copy?</span>` : '';
        const flag = a.flagged ? `<span class="met-chip" title="Movement watch flag" style="margin-left:6px;color:var(--amber);border-color:var(--amber);"><i class="ti ti-flag"></i></span>` : '';
        const rc = a.result === 'PASS' ? 'var(--green)' : (a.result === 'FAIL' ? 'var(--red)' : 'var(--text-muted)');
        const st = a.kicked ? 'Kicked' : (a.leftAt ? 'Left' : '');
        return `<tr><td>${esc(a.username || 'Unknown')} ${quiz}${copy}${flag}</td><td style="color:${rc};font-weight:600;">${esc(a.result || 'PENDING')}</td><td>${a.strikes || 0}</td><td style="color:var(--text-muted);">${st}</td></tr>`;
      }).join('') : '<tr><td colspan="4" class="table-empty"><div class="table-empty-text">No attendees.</div></td></tr>';
      const counts = `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
        <span class="met-chip"><i class="ti ti-users"></i> ${l.totalAttendees || 0} attended</span>
        <span class="met-chip" style="color:var(--green);border-color:var(--green);">${l.passedCount || 0} passed</span>
        <span class="met-chip" style="color:var(--red);border-color:var(--red);">${l.failedCount || 0} failed</span>
        <span class="met-chip" style="color:var(--amber);border-color:var(--amber);">${l.strikeCount || 0} strikes</span></div>`;
      const notesField = (!review && l.status === 'DRAFT')
        ? `<div class="form-group" style="margin-top:12px;"><label class="form-label">Notes for the reviewer</label><textarea class="form-control" id="cid-log-notes" rows="2">${esc(l.notes || '')}</textarea></div>`
        : (l.notes ? `<div style="margin-top:12px;font-size:13px;"><strong>Host notes:</strong> ${esc(l.notes)}</div>` : '');
      const reviewNote = l.reviewNote ? `<div style="margin-top:8px;font-size:13px;color:var(--text-secondary);"><strong>Reviewer:</strong> ${esc(l.reviewNote)} ${l.reviewedByName ? '— ' + esc(l.reviewedByName) : ''}</div>` : '';
      body.innerHTML = counts + `<div class="table-wrap"><table class="data-table"><thead><tr><th>Attendee</th><th>Result</th><th>Strikes</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>` + notesField + reviewNote;

      const devDel = CTX.isDev ? `<button class="btn btn-ghost" style="color:var(--red);" onclick="cidDeleteLog('${l.id}',${review})"><i class="ti ti-trash"></i> Delete</button>` : '';
      if (!review && l.status === 'DRAFT') {
        footer.innerHTML = `<button class="btn btn-ghost" onclick="closeModal('modal-cid-log')">Close</button>${devDel}<button class="btn btn-primary" onclick="cidSubmitLog('${l.id}')"><i class="ti ti-send"></i> Post for review</button>`;
      } else if (review && l.status === 'PENDING' && CTX.canApprove) {
        footer.innerHTML = `<input type="text" class="form-control" id="cid-log-review-note" placeholder="Optional note / reason" style="flex:1;margin-right:8px;" />
          ${devDel}<button class="btn btn-danger" onclick="cidReviewLog('${l.id}','deny')"><i class="ti ti-x"></i> Deny</button>
          <button class="btn btn-primary" onclick="cidReviewLog('${l.id}','approve')"><i class="ti ti-check"></i> Approve</button>`;
      } else {
        footer.innerHTML = `<button class="btn btn-ghost" onclick="closeModal('modal-cid-log')">Close</button>${devDel}`;
      }
    } catch (e) { body.innerHTML = `<div class="table-empty"><div class="table-empty-text">${esc(e.message)}</div></div>`; }
  };

  window.cidSubmitLog = async function (id) {
    const notesEl = document.getElementById('cid-log-notes');
    const notes = notesEl ? notesEl.value : undefined;
    try {
      await api('/api/cid/tryout-logs/' + id + '/submit', { method: 'POST', body: JSON.stringify({ notes }) });
      closeModal('modal-cid-log'); showToast('Posted for review', 'success'); cidLoadMyLogs();
    } catch (e) { showToast(e.message, 'error'); }
  };
  window.cidReviewLog = async function (id, action) {
    const noteEl = document.getElementById('cid-log-review-note');
    const note = noteEl ? noteEl.value : '';
    if (action === 'deny' && !note.trim()) return showToast('Add a reason to deny.', 'warning');
    try {
      await api('/api/cid/tryout-logs/' + id + '/' + action, { method: 'POST', body: JSON.stringify({ note }) });
      closeModal('modal-cid-log'); showToast(action === 'approve' ? 'Approved' : 'Denied', 'success'); cidLoadReviewLogs();
    } catch (e) { showToast(e.message, 'error'); }
  };

  // ── Init ───────────────────────────────────────────────────────────
  async function init() {
    wireNav();
    try {
      CTX = await api('/api/cid/context');
      if (CTX.canApprove) {
        document.querySelectorAll('.approve-only').forEach(el => { el.style.display = ''; });
        cidLoadReviewLogs();
      }
    } catch (e) { /* context fails → basic access only */ }
    cidLoadTryouts();
    const q = new URLSearchParams(location.search).get('tryoutLog');
    if (q) { showPage('tryout-logs'); cidOpenLog(q, false); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
