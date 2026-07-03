// client/public/js/sco19-dashboard.js — SCO-19 dashboard logic
let sco19Deployments = [];
let sco19Filter = 'all';
let sco19IsLead = false;

function navigateTo(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item[data-page]').forEach(b => b.classList.remove('active'));
  const page = document.getElementById('page-' + pageId);
  if (page) page.classList.add('active');
  const btn = document.querySelector(`.nav-item[data-page="${pageId}"]`);
  if (btn) btn.classList.add('active');
}
document.querySelectorAll('.nav-item[data-page]').forEach(btn => {
  btn.addEventListener('click', () => navigateTo(btn.dataset.page));
});

function statusLabel(s) {
  return { PENDING_REVIEW: 'Pending', SIGNED_OFF: 'Signed Off', REJECTED: 'Rejected' }[s] || s;
}
function statusBadgeClass(s) {
  return { PENDING_REVIEW: 'badge-pending', SIGNED_OFF: 'badge-approved', REJECTED: 'badge-denied' }[s] || '';
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function checkLead() {
  try {
    const data = await fetch('/api/me/divisions', { credentials: 'include' }).then(r => r.ok ? r.json() : null);
    const mine = (data && data.mine || []).find(d => d.division === 'SCO19');
    sco19IsLead = !!mine && mine.rank === 'LEAD';
  } catch (e) { sco19IsLead = false; }
}

async function loadDeployments() {
  try {
    sco19Deployments = await api('/api/sco19/deployments');
    renderStats();
    renderDashboardTable();
    renderDeploymentsTable();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderStats() {
  document.getElementById('stat-total').textContent = sco19Deployments.length;
  document.getElementById('stat-pending').textContent = sco19Deployments.filter(d => d.status === 'PENDING_REVIEW').length;
  document.getElementById('stat-signed').textContent = sco19Deployments.filter(d => d.status === 'SIGNED_OFF').length;
  document.getElementById('stat-rejected').textContent = sco19Deployments.filter(d => d.status === 'REJECTED').length;
}

function dashRow(d) {
  return `<tr>
    <td class="mono">${d.deploymentRef}</td>
    <td>${escapeHtml(d.callsign)}</td>
    <td>${escapeHtml(d.incidentType)}</td>
    <td>${escapeHtml(d.officer ? d.officer.displayName : '—')}</td>
    <td><span class="badge ${statusBadgeClass(d.status)}"><span class="badge-dot"></span>${statusLabel(d.status)}</span></td>
    <td>${formatDate(d.createdAt)}</td>
  </tr>`;
}

function renderDashboardTable() {
  const tbody = document.getElementById('dash-tbody');
  const recent = sco19Deployments.slice(0, 8);
  tbody.innerHTML = recent.length ? recent.map(dashRow).join('')
    : `<tr><td colspan="6" class="table-empty"><div class="table-empty-text">No deployments logged yet</div></td></tr>`;
}

function fullRow(d) {
  const canSignOff = sco19IsLead && d.status === 'PENDING_REVIEW';
  return `<tr>
    <td class="mono">${d.deploymentRef}</td>
    <td>${escapeHtml(d.callsign)}</td>
    <td>${escapeHtml(d.incidentType)}</td>
    <td>${escapeHtml(d.authorisation)}</td>
    <td>${escapeHtml(d.officer ? d.officer.displayName : '—')}</td>
    <td><span class="badge ${statusBadgeClass(d.status)}"><span class="badge-dot"></span>${statusLabel(d.status)}</span></td>
    <td>${canSignOff ? `
      <div class="row-actions">
        <button class="row-btn row-btn-approve" onclick="signOff('${d.id}', true)"><i class="ti ti-check"></i></button>
        <button class="row-btn row-btn-deny" onclick="signOff('${d.id}', false)"><i class="ti ti-x"></i></button>
      </div>` : ''}</td>
  </tr>`;
}

function renderDeploymentsTable() {
  const tbody = document.getElementById('deployments-tbody');
  const filtered = sco19Filter === 'all' ? sco19Deployments : sco19Deployments.filter(d => d.status === sco19Filter);
  tbody.innerHTML = filtered.length ? filtered.map(fullRow).join('')
    : `<tr><td colspan="7" class="table-empty"><div class="table-empty-text">No deployments</div></td></tr>`;
}

document.getElementById('filter-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.filter-tab');
  if (!btn) return;
  document.querySelectorAll('#filter-tabs .filter-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  sco19Filter = btn.dataset.filter;
  renderDeploymentsTable();
});

function openNewDeploymentModal() {
  ['nd-callsign', 'nd-incident', 'nd-auth', 'nd-summary'].forEach(id => document.getElementById(id).value = '');
  openModal('modal-new-deployment');
}

async function submitNewDeployment() {
  const callsign = document.getElementById('nd-callsign').value.trim();
  const incidentType = document.getElementById('nd-incident').value.trim();
  const authorisation = document.getElementById('nd-auth').value.trim();
  const summary = document.getElementById('nd-summary').value.trim();
  if (!callsign || !incidentType || !authorisation || !summary) {
    return showToast('All fields are required.', 'warning');
  }
  try {
    await api('/api/sco19/deployments', { method: 'POST', body: JSON.stringify({ callsign, incidentType, authorisation, summary }) });
    closeModal('modal-new-deployment');
    showToast('Deployment logged.', 'success');
    loadDeployments();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function signOff(id, approve) {
  try {
    await api(`/api/sco19/deployments/${id}/sign-off`, { method: 'PATCH', body: JSON.stringify({ approve }) });
    showToast(approve ? 'Deployment signed off.' : 'Deployment rejected.', 'success');
    loadDeployments();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

(async function init() {
  await checkLead();
  loadDeployments();
})();
