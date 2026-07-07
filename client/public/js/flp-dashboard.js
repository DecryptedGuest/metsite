// client/public/js/flp-dashboard.js — FLP dashboard + group panel (AD+).
let flpCtx      = { canGroupAdmin: false, flpRank: 0, isDev: false };
let flpRoles    = [];   // group role list [{ id, name, rank }]
let flpMembers  = [];   // cached member list
let flpGal      = {};   // patrol-log id -> [image urls] for the in-site lightbox

function fesc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// The highest rank the viewer may assign/manage below (developers: unlimited).
function flpCeiling() { return flpCtx.isDev ? Infinity : Number(flpCtx.flpRank || 0); }

function flpNavigate(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item[data-page]').forEach(b => b.classList.remove('active'));
  const page = document.getElementById('page-' + pageId);
  if (page) page.classList.add('active');
  const btn = document.querySelector(`.nav-item[data-page="${pageId}"]`);
  if (btn) btn.classList.add('active');
  if (pageId === 'dashboard') loadFlpOverview();
  if (pageId === 'group') loadFlpGroup();
  if (pageId === 'patrols') loadPatrols();
  if (pageId === 'events') loadEvents();
  if (pageId === 'analytics') loadFlpAnalytics();
}

// ── Overview (KPIs + activity trend) ──
async function loadFlpOverview() {
  const kpis = document.getElementById('flp-kpis');
  const chart = document.getElementById('flp-activity-chart');
  if (!kpis) return;
  let d; try { d = await api('/api/flp/analytics?days=30'); }
  catch (e) { if (chart) chart.innerHTML = `<div class="table-empty-text">${fesc(e.message)}</div>`; return; }
  const act = d.activity || { series: [] };
  const tot = act.series.reduce((a, s) => ({ p: a.p + s.patrols, e: a.e + s.events, t: a.t + (s.tickets || 0) }), { p: 0, e: 0, t: 0 });
  const tile = (v, l, c) => `<div class="panel glass" style="padding:1rem 1.1rem;flex:1;min-width:140px;">
      <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-muted);">${l}</div>
      <div style="font-size:28px;font-weight:800;line-height:1.1;margin-top:4px;color:${c};">${v}</div></div>`;
  kpis.innerHTML = `<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:1rem;">
      ${tile(tot.p, 'Patrol logs', 'var(--green,#22c55e)')}
      ${tile(tot.e, 'Event logs', 'var(--amber,#e8842a)')}
      ${tile(tot.t, 'Support tickets', 'var(--blue,#3b82f6)')}
      ${tile(tot.p + tot.e, 'Total logs (30d)', 'var(--text-primary)')}
    </div>`;
  if (chart && window.MetCharts && act.series.length) {
    const labels = act.series.map(s => s.day.slice(5));
    chart.innerHTML = window.MetCharts.lineChart([
      { name: 'Patrols', color: '#22c55e', points: act.series.map(s => s.patrols) },
      { name: 'Events', color: '#e8842a', points: act.series.map(s => s.events) },
      { name: 'Tickets', color: '#3b82f6', points: act.series.map(s => s.tickets || 0) },
    ], labels, { height: 210 });
  } else if (chart) {
    chart.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:1rem;">No activity in this window yet.</div>';
  }
}

// ── Analytics tab (patrol/event/ticket activity) ──
async function loadFlpAnalytics() {
  const wrap = document.getElementById('flp-analytics');
  if (!wrap || !window.MetCharts) return;
  wrap.innerHTML = '<div class="table-loading"><div class="spinner"></div></div>';
  const days = (document.getElementById('flp-an-days') || {}).value || 30;
  let d; try { d = await api('/api/flp/analytics?days=' + days); } catch (e) { wrap.innerHTML = `<div class="table-empty"><div class="table-empty-text">${fesc(e.message)}</div></div>`; return; }
  const C = window.MetCharts, act = d.activity, labels = act.series.map(s => s.day.slice(5));
  const line = C.lineChart([
    { name: 'Patrols', color: '#14b8a6', points: act.series.map(s => s.patrols) },
    { name: 'Events', color: '#e8842a', points: act.series.map(s => s.events) },
  ], labels);
  const tot = act.series.reduce((a, s) => ({ p: a.p + s.patrols, e: a.e + s.events }), { p: 0, e: 0 });
  const card = (v, l, c) => `<div style="padding:14px 16px;border-radius:12px;border:1px solid var(--border,#2a2a2a);"><div style="font-size:26px;font-weight:800;color:${c};">${v}</div><div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;margin-top:4px;">${l}</div></div>`;
  wrap.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin-bottom:16px;" class="fade-up">
      ${card(tot.p, 'Patrols (' + d.days + 'd)', 'var(--green)')}${card(tot.e, 'Event Logs', 'var(--amber)')}
    </div>
    <div class="panel glass"><div class="panel-header"><div class="panel-title"><span class="panel-dot green"></span>Activity Trend</div></div><div style="padding:12px 16px;">${line}</div></div>`;
}
document.querySelectorAll('.nav-item[data-page]').forEach(btn => btn.addEventListener('click', () => flpNavigate(btn.dataset.page)));

async function initFlp() {
  loadFlpOverview();
  try { flpCtx = await api('/api/flp/context'); } catch (e) { flpCtx = { canGroupAdmin: false }; }
  if (flpCtx.canGroupAdmin) {
    document.querySelectorAll('.group-admin-only').forEach(el => el.style.display = '');
    loadFlpPendingBadge();
  }
  if (flpCtx.canReviewPatrols) { loadPatrolBadge(); loadEventBadge(); }
}

// ── Patrol logs ──────────────────────────────────────────────────────
let patrolFilter = 'PENDING';

async function loadPatrolBadge() {
  try {
    const rows = await api('/api/flp/patrols?status=PENDING');
    const b = document.getElementById('flp-patrol-badge');
    if (b && rows.length) { b.textContent = rows.length; b.style.display = ''; }
  } catch (e) { /* non-fatal */ }
}

const _patrolTabs = document.getElementById('flp-patrol-tabs');
if (_patrolTabs) _patrolTabs.addEventListener('click', (e) => {
  const btn = e.target.closest('.filter-tab'); if (!btn) return;
  _patrolTabs.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active'); patrolFilter = btn.dataset.filter; loadPatrols();
});

const PATROL_STATUS = {
  PENDING:  '<span class="badge badge-pending"><span class="badge-dot"></span>Pending</span>',
  APPROVED: '<span class="badge badge-approved"><span class="badge-dot"></span>Approved</span>',
  DENIED:   '<span class="badge badge-denied"><span class="badge-dot"></span>Denied</span>',
};

async function loadPatrols() {
  const wrap = document.getElementById('flp-patrols-wrap');
  try {
    const rows = await api('/api/flp/patrols?status=' + patrolFilter);
    if (!rows.length) { wrap.innerHTML = `<div class="panel glass"><div class="profile-section"><div class="table-empty-text">Nothing here.</div></div></div>`; return; }
    wrap.innerHTML = rows.map(renderPatrol).join('');
  } catch (err) {
    wrap.innerHTML = `<div class="error-banner"><i class="ti ti-alert-triangle"></i> ${fesc(err.message)}</div>`;
  }
}

function renderPatrol(p) {
  const isEvent = p.type === 'EVENT';
  const fn = isEvent ? 'reviewEvent' : 'reviewPatrol';
  flpGal[p.id] = p.images || [];   // register this log's images for the lightbox
  const imgs = (p.images || []).map((u, i) => `<img src="${fesc(u)}" onclick="flpLightbox('${p.id}', ${i})" style="width:120px;height:90px;object-fit:cover;border-radius:8px;border:1px solid var(--border-dim);cursor:zoom-in;" loading="lazy" />`).join('');
  const rows = [
    ['Submitted by', `${fesc(p.submitterDisplayName || p.submitterUsername || 'Unknown')} <span style="color:var(--text-muted);font-size:11px;">@${fesc(p.submitterUsername || '')} · ${fesc(p.submitterDiscordId)}</span>`],
    ['Division', fesc(p.division || 'N/A')],
    ['Date', `${fesc(p.dateLabel || '—')}${p.crossedMidnight ? ' <span style="color:var(--amber);font-size:11px;"><i class="ti ti-moon"></i> crossed midnight — started the night before</span>' : ''}`],
    ['Started', fesc(p.shiftStart || '—')],
    ['Ended', fesc(p.shiftEnd || '—')],
    ['Total time', fesc(p.totalLabel || '—')],
  ].map(([k, v]) => `<div style="display:flex;gap:12px;padding:5px 0;font-size:13px;"><span style="color:var(--text-muted);min-width:110px;">${k}</span><span>${v}</span></div>`).join('');
  const pointNote = (isEvent && p.status === 'APPROVED')
    ? `<div style="font-size:11px;color:${p.pointAwarded ? 'var(--green)' : 'var(--amber)'};margin-top:6px;">${p.pointAwarded ? '<i class="ti ti-check"></i> +1 point added to the MET database' : '<i class="ti ti-alert-triangle"></i> point not added — member not found on a rank tab / non-numeric cell'}</div>` : '';
  const devDel = flpCtx.isDev ? `<button class="btn btn-ghost btn-sm" style="color:var(--red);" title="Delete (dev)" onclick="flpDeleteLog('${p.id}','${isEvent ? 'EVENT' : 'PATROL'}')"><i class="ti ti-trash"></i> Delete</button>` : '';
  return `<div class="panel glass fade-up" style="margin-bottom:16px;">
    <div class="panel-header"><div class="panel-title"><span class="panel-dot ${isEvent ? 'amber' : 'blue'}"></span>${fesc(p.submitterDisplayName || p.submitterUsername || 'Log')}</div>${PATROL_STATUS[p.status] || ''}</div>
    <div class="profile-section">
      ${rows}
      ${imgs ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;">${imgs}</div>` : '<div style="font-size:12px;color:var(--text-muted);margin-top:8px;">No images attached.</div>'}
      ${p.status === 'PENDING' ? `<div style="display:flex;gap:8px;margin-top:14px;">
        <button class="btn btn-success btn-sm" onclick="${fn}('${p.id}','approve')"><i class="ti ti-check"></i> Approve</button>
        <button class="btn btn-danger btn-sm" onclick="${fn}('${p.id}','deny')"><i class="ti ti-x"></i> Deny</button>
        ${devDel}
      </div>` : `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px;"><div style="font-size:11px;color:var(--text-muted);">${p.reviewedByName ? 'Reviewed by ' + fesc(p.reviewedByName) : ''}</div>${devDel}</div>${pointNote}`}
    </div>
  </div>`;
}

// ── In-site image lightbox (patrol/event log galleries) ───────────────
let flpLbImgs = [], flpLbIdx = 0;
function flpLbBuild() {
  if (document.getElementById('flp-lightbox')) return;
  const el = document.createElement('div');
  el.id = 'flp-lightbox';
  el.style.cssText = 'display:none;position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.88);align-items:center;justify-content:center;';
  const arrow = 'position:absolute;top:50%;transform:translateY(-50%);width:46px;height:46px;border-radius:50%;border:none;background:rgba(255,255,255,.12);color:#fff;font-size:26px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;';
  el.innerHTML =
    `<button id="flp-lb-close" title="Close (Esc)" style="position:absolute;top:18px;right:22px;width:40px;height:40px;border-radius:50%;border:none;background:rgba(255,255,255,.12);color:#fff;font-size:20px;cursor:pointer;"><i class="ti ti-x"></i></button>
     <button id="flp-lb-prev" title="Previous (←)" style="${arrow}left:20px;"><i class="ti ti-chevron-left"></i></button>
     <img id="flp-lb-img" alt="" style="max-width:88vw;max-height:86vh;border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,.5);" />
     <button id="flp-lb-next" title="Next (→)" style="${arrow}right:20px;"><i class="ti ti-chevron-right"></i></button>
     <div id="flp-lb-count" style="position:absolute;bottom:20px;left:50%;transform:translateX(-50%);color:#fff;font-size:13px;background:rgba(0,0,0,.5);padding:4px 12px;border-radius:20px;"></div>`;
  document.body.appendChild(el);
  el.addEventListener('click', e => { if (e.target === el) flpLbClose(); });
  document.getElementById('flp-lb-close').onclick = flpLbClose;
  document.getElementById('flp-lb-prev').onclick  = e => { e.stopPropagation(); flpLbStep(-1); };
  document.getElementById('flp-lb-next').onclick  = e => { e.stopPropagation(); flpLbStep(1); };
  document.addEventListener('keydown', e => {
    if (document.getElementById('flp-lightbox').style.display !== 'flex') return;
    if (e.key === 'Escape') flpLbClose();
    else if (e.key === 'ArrowLeft') flpLbStep(-1);
    else if (e.key === 'ArrowRight') flpLbStep(1);
  });
}
function flpLbRender() {
  document.getElementById('flp-lb-img').src = flpLbImgs[flpLbIdx];
  document.getElementById('flp-lb-count').textContent = `${flpLbIdx + 1} / ${flpLbImgs.length}`;
  const multi = flpLbImgs.length > 1;
  document.getElementById('flp-lb-prev').style.display = multi ? 'flex' : 'none';
  document.getElementById('flp-lb-next').style.display = multi ? 'flex' : 'none';
}
function flpLbStep(d) { if (!flpLbImgs.length) return; flpLbIdx = (flpLbIdx + d + flpLbImgs.length) % flpLbImgs.length; flpLbRender(); }
function flpLbClose() { const el = document.getElementById('flp-lightbox'); if (el) el.style.display = 'none'; }
function flpLightbox(logId, idx) {
  flpLbImgs = flpGal[logId] || [];
  if (!flpLbImgs.length) return;
  flpLbIdx = Math.max(0, Math.min(idx || 0, flpLbImgs.length - 1));
  flpLbBuild(); flpLbRender();
  document.getElementById('flp-lightbox').style.display = 'flex';
}

async function reviewPatrol(id, action) {
  try {
    const r = await api(`/api/flp/patrols/${id}/${action}`, { method: 'POST' });
    showToast(action === 'approve' ? `Approved${r.reacted ? ' — reacted' : ''}` : `Denied${r.reacted ? ' — reacted' : ''}`, 'success');
    loadPatrols(); loadPatrolBadge();
  } catch (err) { showToast(err.message, 'error'); }
}

// Collapse/expand a group-panel section (Pending Join Requests / Members).
function flpToggleSection(bodyId, btn) {
  const body = document.getElementById(bodyId);
  if (!body) return;
  const hidden = body.style.display === 'none';
  body.style.display = hidden ? '' : 'none';
  const icon = btn && btn.querySelector('i');
  if (icon) icon.className = hidden ? 'ti ti-chevron-down' : 'ti ti-chevron-right';
}

// Developer-only: permanently delete a patrol/event log from the site.
async function flpDeleteLog(id, type) {
  if (!(await uiConfirm('Permanently delete this log? This cannot be undone.'))) return;
  try {
    await api('/api/dev/patrol-logs/' + id, { method: 'DELETE' });
    showToast('Log deleted', 'success');
    if (type === 'EVENT') { loadEvents(); loadEventBadge(); } else { loadPatrols(); loadPatrolBadge(); }
  } catch (err) { showToast(err.message, 'error'); }
}

// ── Event logs (same review flow; approve awards +1 on the MET database) ──
let eventFilter = 'PENDING';

async function loadEventBadge() {
  try {
    const rows = await api('/api/flp/patrols?type=EVENT&status=PENDING');
    const b = document.getElementById('flp-event-badge');
    if (b && rows.length) { b.textContent = rows.length; b.style.display = ''; }
  } catch (e) { /* non-fatal */ }
}

const _eventTabs = document.getElementById('flp-event-tabs');
if (_eventTabs) _eventTabs.addEventListener('click', (e) => {
  const btn = e.target.closest('.filter-tab'); if (!btn) return;
  _eventTabs.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active'); eventFilter = btn.dataset.filter; loadEvents();
});

async function loadEvents() {
  const wrap = document.getElementById('flp-events-wrap');
  try {
    const rows = await api('/api/flp/patrols?type=EVENT&status=' + eventFilter);
    if (!rows.length) { wrap.innerHTML = `<div class="panel glass"><div class="profile-section"><div class="table-empty-text">Nothing here.</div></div></div>`; return; }
    wrap.innerHTML = rows.map(renderPatrol).join('');
  } catch (err) {
    wrap.innerHTML = `<div class="error-banner"><i class="ti ti-alert-triangle"></i> ${fesc(err.message)}</div>`;
  }
}

async function reviewEvent(id, action) {
  try {
    const r = await api(`/api/flp/patrols/${id}/${action}`, { method: 'POST' });
    const pt = r.point && r.point.ok ? ` · +1 → ${fesc(r.point.tab || '')}` : (action === 'approve' && r.point && !r.point.ok ? ` · point skipped (${fesc(r.point.reason || '')})` : '');
    showToast((action === 'approve' ? 'Approved' : 'Denied') + pt, 'success');
    loadEvents(); loadEventBadge();
  } catch (err) { showToast(err.message, 'error'); }
}

async function loadFlpPendingBadge() {
  try {
    const data = await api('/api/flp/group/pending');
    const n = (data.requests || []).length;
    const b = document.getElementById('flp-pending-badge');
    if (b && n) { b.textContent = n; b.style.display = ''; }
  } catch (e) { /* non-fatal */ }
}

// ── Group panel ──────────────────────────────────────────────────────
async function loadFlpGroup() {
  try { flpRoles = await api('/api/flp/group/roles'); } catch (e) { flpRoles = []; }
  await Promise.all([loadFlpPending(), loadFlpMembers()]);
}

async function loadFlpPending() {
  const el = document.getElementById('flp-pending');
  try {
    let token = null, reqs = [], pages = 0;
    do {
      const data = await api('/api/flp/group/pending' + (token ? `?pageToken=${encodeURIComponent(token)}` : ''));
      reqs = reqs.concat(data.requests || []);
      token = data.nextPageToken || null;
    } while (token && ++pages < 50);
    document.getElementById('flp-pending-count').textContent = reqs.length ? `(${reqs.length})` : '';
    el.innerHTML = reqs.length ? reqs.map(r => `
      <div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--border-dim);">
        <div style="flex:1;"><strong>${fesc(r.username)}</strong> <span style="color:var(--text-muted);font-size:11px;">#${fesc(r.userId)}</span></div>
        <button class="btn btn-success btn-sm" onclick="flpJoinReq('${r.userId}','approve')"><i class="ti ti-check"></i> Approve</button>
        <button class="btn btn-danger btn-sm" onclick="flpJoinReq('${r.userId}','decline')"><i class="ti ti-x"></i> Decline</button>
      </div>`).join('') : `<div class="table-empty-text">No pending join requests.</div>`;
  } catch (err) {
    el.innerHTML = `<div class="error-banner"><i class="ti ti-alert-triangle"></i> ${fesc(err.message)}</div>`;
  }
}

async function flpJoinReq(userId, action) {
  try {
    await api(`/api/flp/group/pending/${userId}/${action}`, { method: 'POST' });
    showToast(action === 'approve' ? 'Approved.' : 'Declined.', 'success');
    loadFlpPending(); loadFlpPendingBadge();
  } catch (err) { showToast(err.message, 'error'); }
}

async function loadFlpMembers() {
  const tbody = document.getElementById('flp-members-tbody');
  try {
    let token = null, members = [], pages = 0;
    do {
      const data = await api('/api/flp/group/members' + (token ? `?pageToken=${encodeURIComponent(token)}` : ''));
      members = members.concat(data.members || []);
      token = data.nextPageToken || null;
    } while (token && ++pages < 100);
    flpMembers = members;
    renderFlpMembers();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" class="table-empty"><div class="table-empty-text">${fesc(err.message)}</div></td></tr>`;
  }
}

// Rank <select> options: only ranks strictly below the viewer's ceiling.
function rankOptions(currentRoleId) {
  const ceil = flpCeiling();
  return (flpRoles || [])
    .filter(r => r.rank > 0 && r.rank < ceil)
    .map(r => `<option value="${r.id}" ${String(r.id) === String(currentRoleId) ? 'selected' : ''}>${fesc(r.name)}</option>`).join('');
}

function renderFlpMembers() {
  const tbody = document.getElementById('flp-members-tbody');
  const q = (document.getElementById('flp-member-search')?.value || '').toLowerCase().trim();
  const list = q ? flpMembers.filter(m => (m.username || '').toLowerCase().includes(q) || String(m.userId).includes(q)) : flpMembers;
  if (!list.length) { tbody.innerHTML = `<tr><td colspan="4" class="table-empty"><div class="table-empty-text">No members.</div></td></tr>`; return; }
  const ceil = flpCeiling();
  tbody.innerHTML = list.slice(0, 300).map(m => {
    const canManage = Number(m.roleRank) < ceil; // can't touch peers/superiors
    const opts = rankOptions(m.roleId);
    return `<tr>
      <td>${fesc(m.username)} <span style="color:var(--text-muted);font-size:11px;">#${fesc(m.userId)}</span></td>
      <td>${fesc(m.roleName || '—')}</td>
      <td>${canManage && opts ? `<select class="form-control" id="flp-rank-${fesc(m.userId)}" style="width:auto;padding:4px 8px;font-size:12px;">${opts}</select>
             <button class="btn btn-ghost btn-sm" onclick="flpSetRank('${m.userId}','${fesc(m.username)}')">Set</button>`
           : `<span style="color:var(--text-muted);font-size:11px;">—</span>`}</td>
      <td>${canManage ? `<button class="btn btn-danger btn-sm" onclick="flpKick('${m.userId}','${fesc(m.username)}')"><i class="ti ti-user-off"></i> Kick</button>` : ''}</td>
    </tr>`;
  }).join('');
}

async function flpSetRank(userId, username) {
  const roleId = document.getElementById(`flp-rank-${userId}`)?.value;
  if (!roleId) return showToast('Pick a rank first.', 'warning');
  try {
    await api(`/api/flp/group/members/${userId}/rank`, { method: 'PATCH', body: JSON.stringify({ roleId }) });
    const name = (flpRoles.find(r => String(r.id) === String(roleId)) || {}).name || roleId;
    showToast(`${username} → ${name}.`, 'success');
    loadFlpMembers();
  } catch (err) { showToast(err.message, 'error'); }
}

async function flpKick(userId, username) {
  if (!(await uiConfirm(`Kick ${username} from the FLP group?`))) return;
  try {
    await api(`/api/flp/group/members/${userId}`, { method: 'DELETE' });
    showToast(`${username} kicked.`, 'success');
    loadFlpMembers();
  } catch (err) { showToast(err.message, 'error'); }
}

initFlp();
