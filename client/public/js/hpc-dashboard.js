// client/public/js/hpc-dashboard.js — HPC dashboard logic
let hpcRecords = [];
let hpcMyRecords = [];
let hpcIsInstructor = false;
let hpcCurrentRecordId = null;

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

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function statusLabel(s) {
  return { ENROLLED: 'Enrolled', IN_TRAINING: 'In Training', PASSED: 'Passed', FAILED: 'Failed', GRADUATED: 'Graduated' }[s] || s;
}
function statusBadgeClass(s) {
  return { ENROLLED: 'badge-pending', IN_TRAINING: 'badge-pending', PASSED: 'badge-approved', GRADUATED: 'badge-approved', FAILED: 'badge-denied' }[s] || '';
}

async function checkInstructor() {
  try {
    const data = await fetch('/api/me/divisions', { credentials: 'include' }).then(r => r.ok ? r.json() : null);
    const mine = (data && data.mine || []).find(d => d.division === 'HPC');
    hpcIsInstructor = !!mine && mine.tier === 'LEAD';
  } catch (e) { hpcIsInstructor = false; }
  document.querySelectorAll('.hpc-instructor-only').forEach(el => el.style.display = hpcIsInstructor ? '' : 'none');
}

async function loadAll() {
  try {
    [hpcRecords, hpcMyRecords] = await Promise.all([
      api('/api/hpc/records'),
      api('/api/hpc/records/my'),
    ]);
    renderStats();
    renderDashboardTable();
    renderMyTable();
    renderRosterTable();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderStats() {
  document.getElementById('stat-total').textContent = hpcRecords.length;
  document.getElementById('stat-training').textContent = hpcRecords.filter(r => ['ENROLLED', 'IN_TRAINING'].includes(r.status)).length;
  document.getElementById('stat-graduated').textContent = hpcRecords.filter(r => r.status === 'GRADUATED').length;
  document.getElementById('stat-failed').textContent = hpcRecords.filter(r => r.status === 'FAILED').length;
}

function renderDashboardTable() {
  const recent = hpcRecords.slice(0, 8);
  document.getElementById('dash-tbody').innerHTML = recent.length
    ? recent.map(r => `<tr>
        <td>${escapeHtml(r.cadet ? r.cadet.displayName : '—')}</td>
        <td>${escapeHtml(r.courseName)}</td>
        <td><span class="badge ${statusBadgeClass(r.status)}"><span class="badge-dot"></span>${statusLabel(r.status)}</span></td>
        <td>${formatDate(r.createdAt)}</td>
      </tr>`).join('')
    : `<tr><td colspan="4" class="table-empty"><div class="table-empty-text">No training records yet</div></td></tr>`;
}

function renderMyTable() {
  document.getElementById('my-training-tbody').innerHTML = hpcMyRecords.length
    ? hpcMyRecords.map(r => `<tr>
        <td>${escapeHtml(r.courseName)}</td>
        <td><span class="badge ${statusBadgeClass(r.status)}"><span class="badge-dot"></span>${statusLabel(r.status)}</span></td>
        <td>${escapeHtml(r.instructorNote || '—')}</td>
        <td>${formatDate(r.createdAt)}</td>
      </tr>`).join('')
    : `<tr><td colspan="4" class="table-empty"><div class="table-empty-text">You're not enrolled on any courses yet</div></td></tr>`;
}

function renderRosterTable() {
  document.getElementById('roster-tbody').innerHTML = hpcRecords.length
    ? hpcRecords.map(r => `<tr>
        <td>${escapeHtml(r.cadet ? r.cadet.displayName : '—')}</td>
        <td>${escapeHtml(r.courseName)}</td>
        <td><span class="badge ${statusBadgeClass(r.status)}"><span class="badge-dot"></span>${statusLabel(r.status)}</span></td>
        <td>${formatDate(r.createdAt)}</td>
        <td>${hpcIsInstructor ? `<button class="btn btn-ghost btn-sm" onclick="openStatusModal('${r.id}', '${r.status}')">Update</button>` : ''}</td>
      </tr>`).join('')
    : `<tr><td colspan="5" class="table-empty"><div class="table-empty-text">No cadets enrolled yet</div></td></tr>`;
}

function openEnrolModal() {
  document.getElementById('en-cadet-discord-id').value = '';
  document.getElementById('en-course').value = '';
  openModal('modal-enrol');
}

async function submitEnrol() {
  const cadetDiscordId = document.getElementById('en-cadet-discord-id').value.trim();
  const courseName = document.getElementById('en-course').value.trim();
  if (!cadetDiscordId || !courseName) return showToast('Both fields are required.', 'warning');
  try {
    await api('/api/hpc/records', { method: 'POST', body: JSON.stringify({ cadetDiscordId, courseName }) });
    closeModal('modal-enrol');
    showToast('Cadet enrolled.', 'success');
    loadAll();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function openStatusModal(id, currentStatus) {
  hpcCurrentRecordId = id;
  document.getElementById('us-status').value = currentStatus;
  document.getElementById('us-note').value = '';
  openModal('modal-status');
}

async function submitStatusUpdate() {
  const status = document.getElementById('us-status').value;
  const instructorNote = document.getElementById('us-note').value.trim();
  try {
    await api(`/api/hpc/records/${hpcCurrentRecordId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status, instructorNote }),
    });
    closeModal('modal-status');
    showToast('Training record updated.', 'success');
    loadAll();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

(async function init() {
  await checkInstructor();
  loadAll();
})();
