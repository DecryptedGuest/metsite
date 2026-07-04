// client/public/js/flp-dashboard.js — FLP dashboard + group panel (AD+).
let flpCtx      = { canGroupAdmin: false, flpRank: 0, isDev: false };
let flpRoles    = [];   // group role list [{ id, name, rank }]
let flpMembers  = [];   // cached member list

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
  if (pageId === 'group') loadFlpGroup();
}
document.querySelectorAll('.nav-item[data-page]').forEach(btn => btn.addEventListener('click', () => flpNavigate(btn.dataset.page)));

async function initFlp() {
  try { flpCtx = await api('/api/flp/context'); } catch (e) { flpCtx = { canGroupAdmin: false }; }
  if (flpCtx.canGroupAdmin) {
    document.querySelectorAll('.group-admin-only').forEach(el => el.style.display = '');
    loadFlpPendingBadge();
  }
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
      </div>`).join('') : `<div class="table-empty-text">No pending join requests. 🎉</div>`;
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
  if (!confirm(`Kick ${username} from the FLP group?`)) return;
  try {
    await api(`/api/flp/group/members/${userId}`, { method: 'DELETE' });
    showToast(`${username} kicked.`, 'success');
    loadFlpMembers();
  } catch (err) { showToast(err.message, 'error'); }
}

initFlp();
