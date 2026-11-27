// client/public/js/hpc-dashboard.js — HPC: final-exam marking + quota
let hpcCtx = { canMark: false, canQuota: false };

function navigateTo(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item[data-page]').forEach(b => b.classList.remove('active'));
  const page = document.getElementById('page-' + pageId);
  if (page) page.classList.add('active');
  const btn = document.querySelector(`.nav-item[data-page="${pageId}"]`);
  if (btn) btn.classList.add('active');
  if (pageId === 'analytics') loadHpcAnalytics();
  if (pageId === 'tryouts') loadTryouts();
  if (pageId === 'tryout-logs') loadMyTryoutLogs();
  if (pageId === 'review-logs') loadReviewLogs();
  // Live page polls while open; stop polling when navigating away.
  if (pageId === 'live') startLivePolling(); else stopLivePolling();
}
document.querySelectorAll('.nav-item[data-page]').forEach(btn => btn.addEventListener('click', () => navigateTo(btn.dataset.page)));

// ── Analytics tab (tryout performance + recruitment funnel) ──
async function loadHpcAnalytics() {
  const wrap = document.getElementById('hpc-analytics');
  if (!wrap || !window.MetCharts) return;
  wrap.innerHTML = '<div class="table-loading"><div class="spinner"></div></div>';
  const days = (document.getElementById('hpc-an-days') || {}).value || 30;
  let d; try { d = await api('/api/hpc/analytics?days=' + days); } catch (e) { wrap.innerHTML = `<div class="table-empty"><div class="table-empty-text">${esc(e.message)}</div></div>`; return; }
  const C = window.MetCharts, t = d.tryouts, labels = t.series.map(s => s.day.slice(5));
  const line = C.lineChart([
    { name: 'Attendees', color: '#3b82f6', points: t.series.map(s => s.attendees) },
    { name: 'Passed', color: '#22c55e', points: t.series.map(s => s.passed) },
    { name: 'Failed', color: '#e0503a', points: t.series.map(s => s.failed) },
  ], labels);
  const board = C.barList(t.leaderboard.map(h => ({ label: h.hostName || 'Host', sub: `${h.tryouts} tryouts · ${h.passRate}% pass`, value: h.attendees, color: '#3b82f6' })));
  wrap.innerHTML = `
    <div class="cc-grid fade-up" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin-bottom:16px;">
      ${statCard(t.totals.tryouts, 'Tryouts (' + (d.allTime ? 'all time' : d.days + 'd') + ')')}${statCard(t.totals.attendees, 'Candidates')}
      ${statCard(t.totals.passed, 'Passed', 'var(--green)')}${statCard(t.totals.failed, 'Failed', 'var(--red)')}${statCard(t.totals.passRate + '%', 'Pass Rate', 'var(--amber)')}
    </div>
    <div style="display:grid;grid-template-columns:1.4fr 1fr;gap:16px;">
      <div class="panel glass"><div class="panel-header"><div class="panel-title"><span class="panel-dot blue"></span>Tryout Performance</div></div><div style="padding:12px 16px;">${line}</div></div>
      <div class="panel glass"><div class="panel-header"><div class="panel-title"><span class="panel-dot green"></span>Recruitment Funnel</div></div><div style="padding:20px 16px;">${C.funnel(d.funnel.stages)}<div style="text-align:center;margin-top:14px;">${C.gauge(d.funnel.conversion, 'conversion', '#22c55e')}</div></div></div>
    </div>
    <div class="panel glass" style="margin-top:16px;"><div class="panel-header"><div class="panel-title"><span class="panel-dot amber"></span>Host Leaderboard</div></div><div style="padding:16px;">${t.leaderboard.length ? board : (window.metEmpty ? window.metEmpty({ icon: 'ti-trophy', title: 'No tryouts in this period', sub: 'The host leaderboard will build up over time.' }) : '<div class="table-empty-text">No tryouts in this period.</div>')}</div></div>`;
}
function statCard(v, l, c) { return `<div style="padding:14px 16px;border-radius:12px;border:1px solid var(--border,#2a2a2a);"><div style="font-size:26px;font-weight:800;${c ? 'color:' + c + ';' : ''}">${v}</div><div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;margin-top:4px;">${l}</div></div>`; }

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
async function initHpc() {
  try { hpcCtx = await api('/api/hpc/context'); } catch (e) { hpcCtx = { canMark: false, canQuota: false, canApprove: false }; }
  if (hpcCtx.canQuota) document.querySelectorAll('.quota-only').forEach(el => el.style.display = '');
  if (hpcCtx.canApprove) { document.querySelectorAll('.approve-only').forEach(el => el.style.display = ''); loadReviewBadge(); }
  // Keep the "Live" tab appearing/disappearing with active tryouts even when
  // the host is on another page (light poll; the live page itself polls faster).
  loadLive();
  if (!window._hpcLiveNavTimer) window._hpcLiveNavTimer = setInterval(loadLive, 15000);

  // Deep-link from the in-game "review your tryout" link: /hpc/dashboard?tryoutLog=<id>
  const params = new URLSearchParams(location.search);
  const tlogId = params.get('tryoutLog');
  if (tlogId) { navigateTo('tryout-logs'); openTryoutLog(tlogId); }
  else if (params.get('view') === 'applications') navigateTo('applications');
}

// ── Tryouts ──────────────────────────────────────────────────────────
const TRYOUT_STATUS = {
  SCHEDULED: ['badge-pending', 'Scheduled'], LIVE: ['badge-approved', '<i class="ti ti-broadcast"></i> Running'],
  COMPLETED: ['badge', 'Completed'], CANCELLED: ['badge-denied', 'Cancelled'],
};
let hpcTryoutsById = {};   // id -> tryout, for the clickable detail view
async function loadTryouts() {
  const tbody = document.getElementById('hpc-tryouts-tbody');
  try {
    const rows = await api('/api/hpc/tryouts');
    hpcTryoutsById = {}; rows.forEach(t => { hpcTryoutsById[t.id] = t; });
    tbody.innerHTML = rows.length ? rows.map(t => {
      const s = TRYOUT_STATUS[t.status] || ['badge', t.status];
      const canManage = t.isMine && ['SCHEDULED', 'LIVE'].includes(t.status);
      const stop = 'onclick="event.stopPropagation();';
      const btns = [];
      if (canManage && t.status === 'LIVE') btns.push(`<button class="btn btn-ghost btn-sm" ${stop}completeTryout('${t.id}')">End</button>`);
      if (canManage) btns.push(`<button class="btn btn-danger btn-sm" ${stop}cancelTryout('${t.id}')">Cancel</button>`);
      if (hpcCtx.isDev) btns.push(`<button class="btn btn-ghost btn-sm" style="color:var(--red);" title="Delete (dev)" ${stop}hpcDeleteTryout('${t.id}')"><i class="ti ti-trash"></i></button>`);
      return `<tr class="row-clickable" style="cursor:pointer;" onclick="openHpcTryout('${t.id}')">
        <td>${formatDateTime(t.scheduledAt)}</td>
        <td>${esc(t.hostName)}</td>
        <td>${esc(t.coHostName || '·')}</td>
        <td><span class="badge ${s[0]}"><span class="badge-dot"></span>${s[1]}</span></td>
        <td>${t.privateServerLink ? `<a href="${esc(t.privateServerLink)}" target="_blank" rel="noopener" onclick="event.stopPropagation();" class="btn btn-ghost btn-sm">Open</a>` : '·'}</td>
        <td>${btns.length ? `<div style="display:flex;gap:6px;justify-content:flex-end;">${btns.join('')}</div>` : ''}</td>
      </tr>`;
    }).join('')
      : (window.metEmpty ? `<tr><td colspan="6">${window.metEmpty({ icon: 'ti-calendar-off', title: 'No tryouts scheduled', sub: 'Schedule a college entrance tryout to get started.', cta: 'Schedule Tryout', ctaIcon: 'ti-calendar-plus', onclick: 'openScheduleTryout()' })}</td></tr>` : `<tr><td colspan="6" class="table-empty"><div class="table-empty-text">No tryouts scheduled. Click “Schedule Tryout”.</div></td></tr>`);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="table-empty"><div class="table-empty-text">${esc(err.message)}</div></td></tr>`;
  }
}

// Clickable tryout detail — reuses the tryout-log modal shell.
window.openHpcTryout = function (id) {
  const t = hpcTryoutsById[id];
  if (!t) return;
  openModal('modal-tryout-log');
  document.getElementById('tlog-title').textContent = 'Tryout · ' + (t.hostName || '');
  const s = TRYOUT_STATUS[t.status] || ['badge', t.status];
  const linkUrl = t.privateServerLink || t.joinUrl;
  const link = linkUrl ? `<a href="${esc(linkUrl)}" target="_blank" rel="noopener" style="color:var(--blue);">${esc(linkUrl)}</a>` : '<span style="color:var(--text-muted);">TBA</span>';
  const r = (label, val) => `<div style="display:flex;gap:10px;padding:7px 0;border-bottom:1px solid var(--border,#2a2a2a);"><div style="min-width:130px;color:var(--text-muted);font-size:12px;">${label}</div><div style="font-size:13px;">${val}</div></div>`;
  document.getElementById('tlog-body').innerHTML =
    r('Status', `<span class="badge ${s[0]}"><span class="badge-dot"></span>${s[1]}</span>`) +
    r('Host', esc(t.hostName || '·')) +
    r('Co-Host', esc(t.coHostName || '·')) +
    r('Scheduled', formatDateTime(t.scheduledAt)) +
    r('Server lock', esc(t.lockState || '·')) +
    r('Game link', link) +
    r('Announcement', t.announcementSent ? 'Posted' : 'Not posted') +
    (t.notes ? r('Notes', esc(t.notes)) : '') +
    r('Created', formatDateTime(t.createdAt));
  const canManage = t.isMine && ['SCHEDULED', 'LIVE'].includes(t.status);
  const btns = [`<button class="btn btn-ghost" onclick="closeModal('modal-tryout-log')">Close</button>`];
  if (canManage && t.status === 'LIVE') btns.push(`<button class="btn btn-ghost" onclick="completeTryout('${t.id}');closeModal('modal-tryout-log');">End</button>`);
  if (canManage) btns.push(`<button class="btn btn-danger" onclick="cancelTryout('${t.id}');closeModal('modal-tryout-log');">Cancel</button>`);
  if (hpcCtx.isDev) btns.push(`<button class="btn btn-ghost" style="color:var(--red);" onclick="hpcDeleteTryout('${t.id}')"><i class="ti ti-trash"></i> Delete</button>`);
  document.getElementById('tlog-footer').innerHTML = btns.join('');
};
window.hpcDeleteTryout = async function (id) {
  if (!(await uiConfirm('Permanently delete this tryout? This cannot be undone.'))) return;
  try { await api('/api/dev/tryouts/' + id, { method: 'DELETE' }); showToast('Tryout deleted', 'success'); closeModal('modal-tryout-log'); loadTryouts(); }
  catch (e) { showToast(e.message, 'error'); }
};
window.hpcDeleteTryoutLog = async function (id) {
  if (!(await uiConfirm('Permanently delete this tryout log? This cannot be undone.'))) return;
  try { await api('/api/dev/tryout-logs/' + id, { method: 'DELETE' }); showToast('Log deleted', 'success'); closeModal('modal-tryout-log'); loadMyTryoutLogs(); loadReviewLogs(); }
  catch (e) { showToast(e.message, 'error'); }
};

function openScheduleTryout() {
  // Default the date to today; leave the time unset (host still picks it).
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  document.getElementById('tryout-date').value = today;
  document.getElementById('tryout-time').value = '';
  document.getElementById('tryout-lock').value = 'UNLOCKED';
  document.getElementById('tryout-notes').value = '';
  openModal('modal-tryout');
}

async function submitTryout() {
  const date = document.getElementById('tryout-date').value;
  const time = document.getElementById('tryout-time').value;
  if (!date) return showToast('Pick a date.', 'warning');
  if (!time) return showToast('Pick a time.', 'warning');
  const scheduledAt = new Date(`${date}T${time}`).toISOString();
  try {
    await api('/api/hpc/tryouts', { method: 'POST', body: JSON.stringify({
      scheduledAt,
      lockState: document.getElementById('tryout-lock').value,
      notes: document.getElementById('tryout-notes').value.trim(),
    }) });
    closeModal('modal-tryout');
    showToast('Tryout scheduled. The bot will DM you at the scheduled time.', 'success');
    loadTryouts();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function cancelTryout(id) {
  if (!(await uiConfirm('Cancel this tryout?'))) return;
  try { await api(`/api/hpc/tryouts/${id}/cancel`, { method: 'POST' }); showToast('Tryout cancelled.', 'success'); loadTryouts(); }
  catch (err) { showToast(err.message, 'error'); }
}
async function completeTryout(id) {
  if (!(await uiConfirm('Mark this tryout as finished?'))) return;
  try { await api(`/api/hpc/tryouts/${id}/complete`, { method: 'POST' }); showToast('Tryout ended.', 'success'); loadTryouts(); }
  catch (err) { showToast(err.message, 'error'); }
}

// ── Tryout logs ────────────────────────────────────────────────────
let tlogCurrent = null;       // the log open in the modal
let reviewFilter = 'PENDING';

const TLOG_STATUS = {
  DRAFT:    '<span class="badge badge-pending"><span class="badge-dot"></span>Draft</span>',
  PENDING:  '<span class="badge badge-pending"><span class="badge-dot"></span>Awaiting</span>',
  APPROVED: '<span class="badge badge-approved"><span class="badge-dot"></span>Approved</span>',
  DENIED:   '<span class="badge badge-denied"><span class="badge-dot"></span>Denied</span>',
};

async function loadReviewBadge() {
  try {
    const pend = await api('/api/hpc/tryout-logs/pending?status=PENDING');
    const b = document.getElementById('hpc-review-badge');
    if (b) { b.textContent = pend.length; b.style.display = pend.length ? '' : 'none'; }
  } catch (e) { /* non-fatal */ }
}

async function loadMyTryoutLogs() {
  const tbody = document.getElementById('hpc-mylogs-tbody');
  try {
    const logs = await api('/api/hpc/tryout-logs/mine');
    tbody.innerHTML = logs.length ? logs.map(l => `<tr class="row-clickable" style="cursor:pointer;" onclick="openTryoutLog('${l.id}')">
      <td>${l.concludedAt ? formatDateTime(l.concludedAt) : formatDateTime(l.createdAt)}</td>
      <td>${l.totalAttendees}</td><td>${l.passedCount}</td><td>${l.failedCount}</td><td>${l.strikeCount}</td>
      <td>${TLOG_STATUS[l.status] || esc(l.status)}</td>
      <td><div style="display:flex;gap:6px;justify-content:flex-end;"><button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();openTryoutLog('${l.id}')">${l.status === 'DRAFT' ? '<i class="ti ti-edit"></i> Review &amp; Post' : '<i class="ti ti-eye"></i> View'}</button>${hpcCtx.isDev ? `<button class="btn btn-ghost btn-sm" style="color:var(--red);" title="Delete (dev)" onclick="event.stopPropagation();hpcDeleteTryoutLog('${l.id}')"><i class="ti ti-trash"></i></button>` : ''}</div></td>
    </tr>`).join('') : (window.metEmpty ? `<tr><td colspan="7">${window.metEmpty({ icon: 'ti-clipboard-off', title: 'No tryout logs yet', sub: "Conclude a tryout in-game and it'll appear here to post." })}</td></tr>` : `<tr><td colspan="7" class="table-empty"><div class="table-empty-text">No tryout logs yet. Conclude a tryout in-game and it'll appear here to post.</div></td></tr>`);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="table-empty"><div class="table-empty-text">${esc(err.message)}</div></td></tr>`;
  }
}

async function loadReviewLogs() {
  const tbody = document.getElementById('hpc-reviewlogs-tbody');
  try {
    const logs = await api('/api/hpc/tryout-logs/pending?status=' + reviewFilter);
    tbody.innerHTML = logs.length ? logs.map(l => `<tr class="row-clickable" style="cursor:pointer;" onclick="openTryoutLog('${l.id}')">
      <td>${esc(l.hostName)}</td>
      <td>${l.totalAttendees}</td><td>${l.passedCount}</td><td>${l.failedCount}</td><td>${l.strikeCount}</td>
      <td>${TLOG_STATUS[l.status] || esc(l.status)}</td>
      <td><div style="display:flex;gap:6px;justify-content:flex-end;"><button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();openTryoutLog('${l.id}')"><i class="ti ti-clipboard-check"></i> Open</button>${hpcCtx.isDev ? `<button class="btn btn-ghost btn-sm" style="color:var(--red);" title="Delete (dev)" onclick="event.stopPropagation();hpcDeleteTryoutLog('${l.id}')"><i class="ti ti-trash"></i></button>` : ''}</div></td>
    </tr>`).join('') : (window.metEmpty ? `<tr><td colspan="7">${window.metEmpty({ icon: 'ti-clipboard-check', title: 'Nothing to review', sub: 'Tryout logs matching this filter will appear here.' })}</td></tr>` : `<tr><td colspan="7" class="table-empty"><div class="table-empty-text">Nothing here.</div></td></tr>`);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="table-empty"><div class="table-empty-text">${esc(err.message)}</div></td></tr>`;
  }
}

const _logFilterTabs = document.getElementById('hpc-logfilter-tabs');
if (_logFilterTabs) _logFilterTabs.addEventListener('click', (e) => {
  const btn = e.target.closest('.filter-tab');
  if (!btn) return;
  _logFilterTabs.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  reviewFilter = btn.dataset.filter;
  loadReviewLogs();
});

async function openTryoutLog(id) {
  openModal('modal-tryout-log');
  document.getElementById('tlog-body').innerHTML = '<div class="table-loading"><div class="spinner"></div></div>';
  document.getElementById('tlog-footer').innerHTML = '';
  try {
    tlogCurrent = await api('/api/hpc/tryout-logs/' + id);
    renderTryoutLog(tlogCurrent);
  } catch (err) {
    document.getElementById('tlog-body').innerHTML = `<div class="error-banner"><i class="ti ti-alert-triangle"></i> ${esc(err.message)}</div>`;
  }
}

function renderTryoutLog(l) {
  // Host editing is only offered on DRAFTs; the server enforces ownership.
  const editable   = l.status === 'DRAFT';
  const canApprove = hpcCtx.canApprove && l.status === 'PENDING';
  document.getElementById('tlog-title').textContent = `Tryout Log · ${l.hostName}`;

  const resultSelect = (a, i) => editable
    ? `<select class="form-control" data-idx="${i}" data-field="result" style="padding:4px 8px;font-size:12px;">
         ${['PENDING', 'PASS', 'FAIL'].map(r => `<option value="${r}" ${a.result === r ? 'selected' : ''}>${r}</option>`).join('')}
       </select>`
    : `<span class="met-chip" style="${a.result === 'PASS' ? 'color:var(--green);border-color:var(--green);' : a.result === 'FAIL' ? 'color:var(--red);border-color:var(--red);' : ''}">${a.result}</span>`;

  const strikesCell = (a, i) => editable
    ? `<input type="number" min="0" max="9" value="${a.strikes || 0}" data-idx="${i}" data-field="strikes" class="form-control" style="width:56px;padding:4px 8px;font-size:12px;" />`
    : String(a.strikes || 0);

  const copyChip = (a) => (a.quiz && a.quiz.copyFlag)
    ? ` <span class="met-chip" title="Possible answer copying${a.quiz.copyWith ? ' · matched ' + esc(a.quiz.copyWith) : ''}" style="color:var(--red);border-color:var(--red);"><i class="ti ti-alert-triangle"></i> copy?</span>`
    : '';
  const flagChip = (a) => a.flagged
    ? ` <span class="met-chip" title="Movement watch flag" style="color:var(--amber);border-color:var(--amber);"><i class="ti ti-flag"></i> flagged</span>`
    : '';
  const quizChip = (a) => {
    if (!a.quiz) return '';
    const v = (a.quiz.verdict || '').toUpperCase();
    const col = v === 'PASS' ? 'var(--green)' : v === 'FAIL' ? 'var(--red)' : 'var(--text-secondary)';
    const score = (a.quiz.score != null && a.quiz.outOf != null) ? `${a.quiz.score}/${a.quiz.outOf}` : (a.quiz.score != null ? a.quiz.score : '');
    return ` <span class="met-chip" title="Written quiz" style="color:${col};border-color:${col};"><i class="ti ti-writing"></i> ${esc(String(score))}${v ? ' · ' + esc(v) : ''}</span>`;
  };
  const rows = (l.attendees || []).map((a, i) => `<tr>
    <td>${esc(a.username)}${a.kicked ? ' <span class="badge badge-denied" style="font-size:9px;">KICKED</span>' : (a.leftAt ? ' <span class="badge badge-pending" style="font-size:9px;">LEFT</span>' : '')}${flagChip(a)}</td>
    <td>${resultSelect(a, i)}</td>
    <td>${strikesCell(a, i)}</td>
    <td>${a.note ? esc(a.note) : ''}${quizChip(a)}${copyChip(a)}${(!a.note && !a.quiz) ? '·' : ''}</td>
  </tr>`).join('') || (window.metEmpty ? `<tr><td colspan="4">${window.metEmpty({ icon: 'ti-users', title: 'No attendees recorded', sub: 'Attendees reported by the in-game panel will appear here.' })}</td></tr>` : `<tr><td colspan="4" class="table-empty-text">No attendees recorded.</td></tr>`);

  const summary = `<div class="chip-row" style="margin-bottom:14px;">
      <span class="met-chip"><i class="ti ti-users"></i> ${l.totalAttendees} attended</span>
      <span class="met-chip" style="color:var(--green);border-color:var(--green);"><i class="ti ti-circle-check"></i> ${l.passedCount} passed</span>
      <span class="met-chip" style="color:var(--red);border-color:var(--red);"><i class="ti ti-circle-x"></i> ${l.failedCount} failed</span>
      <span class="met-chip" style="color:var(--amber);border-color:var(--amber);"><i class="ti ti-alert-triangle"></i> ${l.strikeCount} strikes</span>
      <span class="met-chip"><i class="ti ti-door-exit"></i> ${l.leftCount} left</span>
      <span class="met-chip"><i class="ti ti-user-x"></i> ${l.kickedCount} kicked</span>
      ${l.coHostName ? `<span class="met-chip">Co-host: ${esc(l.coHostName)}</span>` : ''}
    </div>`;

  const notesField = editable
    ? `<div class="form-group"><label class="form-label">Host notes (optional)</label>
         <textarea class="form-control" id="tlog-notes" rows="2" placeholder="Anything HICOMM should know…">${esc(l.notes || '')}</textarea></div>`
    : (l.notes ? `<p style="font-size:12px;color:var(--text-secondary);"><strong>Host notes:</strong> ${esc(l.notes)}</p>` : '');

  const reviewBanner = (l.status === 'APPROVED' || l.status === 'DENIED')
    ? `<div class="${l.status === 'APPROVED' ? 'badge badge-approved' : 'badge badge-denied'}" style="margin-bottom:12px;"><span class="badge-dot"></span>${l.status} by ${esc(l.reviewedByName || 'HICOMM')}${l.reviewNote ? ' · ' + esc(l.reviewNote) : ''}${l.pointAwarded ? ' · +1 point awarded' : ''}</div>`
    : '';

  document.getElementById('tlog-body').innerHTML = `${reviewBanner}${summary}
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>Attendee</th><th>Result</th><th>Strikes</th><th>Note</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    ${notesField}
    ${canApprove ? `<div class="form-group" style="margin-top:12px;"><label class="form-label">Review note (optional)</label>
       <input type="text" class="form-control" id="tlog-review-note" placeholder="Reason / note" /></div>` : ''}`;

  let footer = `<button class="btn btn-ghost" onclick="closeModal('modal-tryout-log')">Close</button>`;
  if (hpcCtx.isDev) footer += `<button class="btn btn-ghost" style="color:var(--red);" onclick="hpcDeleteTryoutLog('${l.id}')"><i class="ti ti-trash"></i> Delete</button>`;
  if (editable)   footer += `<button class="btn btn-primary" onclick="submitTryoutLog('${l.id}')"><i class="ti ti-send"></i> Post for Approval</button>`;
  if (canApprove) footer += `<button class="btn btn-danger" onclick="reviewTryoutLog('${l.id}','deny')"><i class="ti ti-x"></i> Deny</button>
                             <button class="btn btn-success" onclick="reviewTryoutLog('${l.id}','approve')"><i class="ti ti-check"></i> Approve (+1)</button>`;
  document.getElementById('tlog-footer').innerHTML = footer;
}

// Collect host edits (result + strikes per attendee) from the modal.
function collectAttendeeEdits() {
  const attendees = (tlogCurrent.attendees || []).map(a => ({ ...a }));
  document.querySelectorAll('#tlog-body [data-idx]').forEach(el => {
    const i = Number(el.dataset.idx), f = el.dataset.field;
    if (!attendees[i]) return;
    if (f === 'strikes') attendees[i].strikes = Math.max(0, parseInt(el.value, 10) || 0);
    else attendees[i][f] = el.value;
  });
  return attendees;
}

async function submitTryoutLog(id) {
  if (!(await uiConfirm('Post this tryout log for HICOMM approval? You won\'t be able to edit it after.'))) return;
  try {
    const r = await api(`/api/hpc/tryout-logs/${id}/submit`, { method: 'POST', body: JSON.stringify({
      notes: (document.getElementById('tlog-notes') || {}).value || '',
      attendees: collectAttendeeEdits(),
    }) });
    // The server tells us two things worth passing on: whether the Discord post
    // actually went out, and whether any names were refused because the panel
    // never saw them. Saying "posted for approval" regardless hid both.
    showToast('Tryout log posted for approval.'
      + (r && r.posted === false ? ' The Discord post did not go out, but it is in the review queue.' : ''), 'success');
    if (r && r.warning) showToast(r.warning, 'warning');
    closeModal('modal-tryout-log');
    loadMyTryoutLogs();
  } catch (err) { showToast(err.message, 'error'); }
}

async function reviewTryoutLog(id, action) {
  const note = (document.getElementById('tlog-review-note') || {}).value || '';
  if (action === 'deny' && !note.trim()) return showToast('Add a reason to deny.', 'warning');
  try {
    const r = await api(`/api/hpc/tryout-logs/${id}/${action}`, { method: 'POST', body: JSON.stringify({ note }) });
    if (action === 'approve') {
      if (r.pointAwarded) showToast('Approved · +1 point awarded', 'success');
      else showToast('Approved · point NOT awarded: ' + (r.pointDetail || 'check the HPC sheet config.'), r.pointReason === 'host_not_on_sheet' ? 'warning' : 'error');
    } else showToast('Tryout log denied.', 'success');
    closeModal('modal-tryout-log');
    loadReviewLogs(); loadReviewBadge();
  } catch (err) { showToast(err.message, 'error'); }
}

// ── Live tryout mirror (read-only, polling) ────────────────────────
let _liveTimer = null;

function startLivePolling() {
  loadLive();
  if (_liveTimer) clearInterval(_liveTimer);
  _liveTimer = setInterval(loadLive, 5000);
}
function stopLivePolling() { if (_liveTimer) { clearInterval(_liveTimer); _liveTimer = null; } }
// Pause polling when the tab is hidden; resume when it's shown again.
document.addEventListener('visibilitychange', () => {
  const onLive = document.getElementById('page-live')?.classList.contains('active');
  if (document.hidden) stopLivePolling(); else if (onLive) startLivePolling();
});

function liveStat(n, label, cls) {
  return `<div class="stat-card ${cls || ''}" style="text-align:left;"><div class="stat-value">${n}</div><div class="stat-label">${label}</div></div>`;
}

async function loadLive() {
  const wrap = document.getElementById('hpc-live-wrap');
  const status = document.getElementById('hpc-live-status');
  let live;
  try { live = await api('/api/hpc/tryouts/live'); }
  catch (e) { if (status) status.innerHTML = '<span class="badge-dot"></span>Error'; return; }
  // "Tryout Live" branded moment when one newly appears (baseline set on first poll).
  try {
    if (window.metBrandMoment) {
      if (window._hpcLiveSeen == null) { window._hpcLiveSeen = new Set(live.map(t => t.id)); }
      else {
        for (const t of live) {
          if (!window._hpcLiveSeen.has(t.id)) {
            window._hpcLiveSeen.add(t.id);
            metBrandMoment({ icon: 'ti-broadcast', variant: 'celebrate', title: 'Tryout Live', tagline: 'Hendon Police College · ' + (t.hostName ? 'Hosted by ' + t.hostName : 'Tryout in progress'), autoMs: 2600 });
            break;
          }
        }
      }
    }
  } catch (e) { /* cosmetic */ }

  const badge = document.getElementById('hpc-live-badge');
  if (badge) { if (live.length) { badge.textContent = live.length; badge.style.display = ''; } else badge.style.display = 'none'; }
  // Only surface the "Live" nav tab while a tryout is actually running.
  const liveNav = document.querySelector('.nav-item[data-page="live"]');
  if (liveNav) liveNav.style.display = live.length ? '' : 'none';
  if (status) status.outerHTML = `<span class="badge ${live.length ? 'badge-approved' : 'badge-pending'}" id="hpc-live-status"><span class="badge-dot"></span>${live.length ? 'Live · ' + live.length : 'No live tryouts'}</span>`;

  if (!live.length) {
    const EMPTY = window.metEmpty ? window.metEmpty({ icon: 'ti-broadcast', title: 'No live tryouts', sub: '' }) : '<div class="table-empty-text">No tryouts are running right now.</div>';
    wrap.innerHTML = `<div class="panel glass"><div class="profile-section">${EMPTY}</div></div>`;
    return;
  }

  wrap.innerHTML = live.map(t => {
    const s = t.snapshot || {};
    const at = s.attendees || [];
    const lock = ['UNLOCKED', 'UNSLOCKED'].includes(String(t.lockState).toUpperCase());
    const manage = !!t.canManage;
    const act = (a, action, label, cls) => `<button class="btn ${cls} btn-sm" style="padding:3px 8px;font-size:11px;" onclick="tryoutCmd('${t.id}','${action}','${a.robloxId || ''}','${esc(a.username || '')}')">${label}</button>`;
    const liveFlag = (a) => a.flagged ? ' <span class="badge badge-pending" style="font-size:9px;color:var(--amber);" title="Movement watch flag"><i class="ti ti-flag"></i> FLAG</span>' : '';
    const liveCopy = (a) => (a.quiz && a.quiz.copyFlag) ? ' <span class="badge badge-denied" style="font-size:9px;" title="Possible answer copying"><i class="ti ti-alert-triangle"></i> COPY?</span>' : '';
    const livePts  = (a) => (a.pts != null) ? ` <span class="met-chip" style="font-size:10px;" title="Points">${esc(String(a.pts))} pts</span>` : '';
    const rows = at.length ? at.map(a => `<tr>
        <td>${a.robloxId ? `<img src="https://www.roblox.com/headshot-thumbnail/image?userId=${encodeURIComponent(a.robloxId)}&width=48&height=48&format=png" alt="" style="width:26px;height:26px;border-radius:6px;vertical-align:middle;margin-right:8px;background:#0b1c3a;" onerror="this.style.display='none'"/>` : ''}${esc(a.username || 'Unknown')}${a.kicked ? ' <span class="badge badge-denied" style="font-size:9px;">KICKED</span>' : (a.leftAt ? ' <span class="badge badge-pending" style="font-size:9px;">LEFT</span>' : '')}${liveFlag(a)}${liveCopy(a)}${livePts(a)}</td>
        <td>${a.result === 'PASS' ? '<span style="color:var(--green);">Passed</span>' : a.result === 'FAIL' ? '<span style="color:var(--red);">Failed</span>' : '·'}</td>
        <td>${a.strikes || 0}</td>
        ${manage ? `<td><div style="display:flex;gap:4px;flex-wrap:wrap;">${act(a, 'STRIKE', 'Strike', 'btn-ghost')}${act(a, 'PASS', 'Pass', 'btn-success')}${act(a, 'FAIL', 'Fail', 'btn-danger')}${act(a, 'KICK', 'Kick', 'btn-ghost')}</div></td>` : ''}
      </tr>`).join('') : `<tr><td colspan="${manage ? 4 : 3}" class="table-empty-text">Waiting for the panel to report attendees…</td></tr>`;
    return `<div class="panel glass fade-up" style="margin-bottom:16px;">
      <div class="panel-header">
        <div class="panel-title"><span class="panel-dot green"></span>${esc(t.hostName)}${t.coHostName ? ' &amp; ' + esc(t.coHostName) : ''}${manage ? ' <span class="badge badge-approved" style="font-size:9px;">You host</span>' : ''}</div>
        <span class="badge ${lock ? 'badge-approved' : 'badge-denied'}"><span class="badge-dot"></span>${lock ? '<i class="ti ti-lock-open"></i> Unlocked' : '<i class="ti ti-lock"></i> Locked'}</span>
      </div>
      <div class="profile-section">
        <div class="stat-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(90px,1fr));gap:10px;margin-bottom:14px;">
          ${liveStat(s.totalAttendees ?? at.length, 'Attending', 'blue')}
          ${liveStat(s.passedCount ?? 0, 'Passed', 'green')}
          ${liveStat(s.failedCount ?? 0, 'Failed', 'red')}
          ${liveStat(s.strikeCount ?? 0, 'Strikes', 'amber')}
          ${liveStat(s.leftCount ?? 0, 'Left', 'purple')}
          ${liveStat(s.kickedCount ?? 0, 'Kicked', '')}
        </div>
        <div class="table-wrap"><table class="data-table">
          <thead><tr><th>Attendee</th><th>Result</th><th>Strikes</th>${manage ? '<th>Manage</th>' : ''}</tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
        ${manage ? '<div style="font-size:11px;color:var(--text-muted);margin-top:8px;">Actions are sent to the in-game panel and apply on its next sync.</div>' : ''}
        ${s.at ? `<div style="font-size:11px;color:var(--text-muted);margin-top:8px;">Last update ${formatDateTime(s.at)}</div>` : '<div style="font-size:11px;color:var(--text-muted);margin-top:8px;">Nothing to show yet.</div>'}
      </div>
    </div>`;
  }).join('');
}

// Host/co-host: queue a management action for a live tryout (applied in-game).
async function tryoutCmd(tryoutId, action, targetRobloxId, targetUsername) {
  if (action === 'KICK' && !(await uiConfirm(`Kick ${targetUsername || 'this attendee'} from the tryout?`))) return;
  try {
    await api(`/api/hpc/tryouts/${tryoutId}/command`, { method: 'POST', body: JSON.stringify({ action, targetRobloxId, targetUsername }) });
    showToast(`${action[0] + action.slice(1).toLowerCase()} queued · applies on the next in-game sync.`, 'success');
  } catch (err) { showToast(err.message, 'error'); }
}

initHpc();
