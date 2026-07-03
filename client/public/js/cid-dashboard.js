// client/public/js/cid-dashboard.js — CID dashboard logic
let cidCases = [];
let cidCurrentCaseId = null;
let cidFilter = 'all';

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
  return { OPEN: 'Open', UNDER_REVIEW: 'Under Review', CLOSED: 'Closed' }[s] || s;
}
function statusBadgeClass(s) {
  return { OPEN: 'badge-pending', UNDER_REVIEW: 'badge-pending', CLOSED: 'badge-approved' }[s] || '';
}

async function loadCases() {
  try {
    cidCases = await api('/api/cid/cases');
    renderStats();
    renderDashboardTable();
    renderCasesTable();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderStats() {
  document.getElementById('stat-total').textContent = cidCases.length;
  document.getElementById('stat-open').textContent = cidCases.filter(c => c.status === 'OPEN').length;
  document.getElementById('stat-review').textContent = cidCases.filter(c => c.status === 'UNDER_REVIEW').length;
  document.getElementById('stat-closed').textContent = cidCases.filter(c => c.status === 'CLOSED').length;
}

function caseRow(c) {
  const lead = c.leadInvestigator ? c.leadInvestigator.displayName : '—';
  return `<tr onclick="openCaseDetail('${c.id}')" style="cursor:pointer;">
    <td class="mono">${c.caseRef}</td>
    <td>${escapeHtml(c.title)}</td>
    <td>${escapeHtml(lead)}</td>
    <td><span class="badge ${statusBadgeClass(c.status)}"><span class="badge-dot"></span>${statusLabel(c.status)}</span></td>
    <td>${formatDate(c.createdAt)}</td>
  </tr>`;
}

function renderDashboardTable() {
  const tbody = document.getElementById('dash-cases-tbody');
  const recent = cidCases.slice(0, 8);
  tbody.innerHTML = recent.length
    ? recent.map(caseRow).join('')
    : `<tr><td colspan="5" class="table-empty"><div class="table-empty-text">No cases yet</div></td></tr>`;
}

function renderCasesTable() {
  const tbody = document.getElementById('cases-tbody');
  const filtered = cidFilter === 'all' ? cidCases : cidCases.filter(c => c.status === cidFilter);
  tbody.innerHTML = filtered.length
    ? filtered.map(c => caseRow(c).replace('</tr>', `<td><button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();openCaseDetail('${c.id}')">View</button></td></tr>`))
    : `<tr><td colspan="6" class="table-empty"><div class="table-empty-text">No cases</div></td></tr>`;
}

document.getElementById('cases-filter-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.filter-tab');
  if (!btn) return;
  document.querySelectorAll('#cases-filter-tabs .filter-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  cidFilter = btn.dataset.filter;
  renderCasesTable();
});

function openNewCaseModal() {
  document.getElementById('nc-title').value = '';
  document.getElementById('nc-summary').value = '';
  openModal('modal-new-case');
}

async function submitNewCase() {
  const title = document.getElementById('nc-title').value.trim();
  const summary = document.getElementById('nc-summary').value.trim();
  if (!title || !summary) return showToast('Title and summary are required.', 'warning');
  try {
    await api('/api/cid/cases', { method: 'POST', body: JSON.stringify({ title, summary }) });
    closeModal('modal-new-case');
    showToast('Case opened.', 'success');
    loadCases();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function openCaseDetail(id) {
  cidCurrentCaseId = id;
  try {
    const c = await api(`/api/cid/cases/${id}`);
    document.getElementById('cd-title').textContent = `${c.caseRef} — ${c.title}`;
    document.getElementById('cd-status').value = c.status;
    const entries = (c.entries || []).map(e => `
      <div style="padding:8px 0;border-bottom:1px solid var(--border-dim);">
        <div style="font-size:11px;color:var(--text-muted);">
          ${e.kind === 'evidence' ? '📎 Evidence' : '📝 Note'} · ${escapeHtml(e.author ? e.author.displayName : 'Unknown')} · ${formatDateTime(e.createdAt)}
        </div>
        <div style="font-size:13px;margin-top:3px;">${escapeHtml(e.body)}</div>
      </div>`).join('') || '<div class="table-empty-text">No entries logged yet.</div>';
    document.getElementById('cd-body').innerHTML = `
      <div class="detail-field full" style="margin-bottom:1rem;">
        <div class="detail-field-label">Summary</div>
        <div class="detail-field-value">${escapeHtml(c.summary)}</div>
      </div>
      <div class="detail-field-label" style="margin-bottom:6px;">Evidence &amp; Notes Log</div>
      ${entries}`;
    openModal('modal-case-detail');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function submitEntry() {
  const kind = document.getElementById('cd-entry-kind').value;
  const body = document.getElementById('cd-entry-body').value.trim();
  if (!body) return showToast('Enter some detail first.', 'warning');
  try {
    await api(`/api/cid/cases/${cidCurrentCaseId}/entries`, { method: 'POST', body: JSON.stringify({ kind, body }) });
    document.getElementById('cd-entry-body').value = '';
    showToast('Logged.', 'success');
    openCaseDetail(cidCurrentCaseId);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function submitStatusChange() {
  const status = document.getElementById('cd-status').value;
  try {
    await api(`/api/cid/cases/${cidCurrentCaseId}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
    showToast('Status updated.', 'success');
    closeModal('modal-case-detail');
    loadCases();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

loadCases();
