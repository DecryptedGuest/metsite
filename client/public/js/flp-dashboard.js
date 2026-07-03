// client/public/js/flp-dashboard.js — FLP dashboard logic
let flpMyShifts = [];
let flpAllShifts = [];
let flpActiveShiftId = null;

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

function shiftActionButtons() {
  const label = flpActiveShiftId ? '<i class="ti ti-player-stop"></i> End Shift' : '<i class="ti ti-clock"></i> Start Shift';
  ['btn-shift-action', 'btn-shift-action-2'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.innerHTML = label;
  });
}

async function handleShiftAction() {
  if (flpActiveShiftId) {
    document.getElementById('es-incidents').value = 0;
    document.getElementById('es-arrests').value = 0;
    document.getElementById('es-notes').value = '';
    openModal('modal-end-shift');
  } else {
    try {
      await api('/api/flp/shifts', { method: 'POST' });
      showToast('Shift started.', 'success');
      await loadAll();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }
}
document.getElementById('btn-shift-action').addEventListener('click', handleShiftAction);
document.getElementById('btn-shift-action-2').addEventListener('click', handleShiftAction);

async function submitEndShift() {
  const incidentsCount = document.getElementById('es-incidents').value;
  const arrestsCount = document.getElementById('es-arrests').value;
  const notes = document.getElementById('es-notes').value.trim();
  try {
    await api(`/api/flp/shifts/${flpActiveShiftId}/end`, {
      method: 'PATCH',
      body: JSON.stringify({ incidentsCount, arrestsCount, notes }),
    });
    closeModal('modal-end-shift');
    showToast('Shift ended.', 'success');
    await loadAll();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function shiftTimeRange(s) {
  const start = formatDateTime(s.shiftStart);
  const end = s.shiftEnd ? formatDateTime(s.shiftEnd) : '<span style="color:var(--amber);">In progress</span>';
  return { start, end };
}

async function loadStats() {
  try {
    const stats = await api('/api/flp/stats');
    document.getElementById('stat-shifts').textContent = stats.totalShifts;
    document.getElementById('stat-incidents').textContent = stats.totalIncidents;
    document.getElementById('stat-arrests').textContent = stats.totalArrests;
    document.getElementById('stat-my-shifts').textContent = stats.myShifts;
  } catch (err) { /* non-fatal */ }
}

async function loadAll() {
  try {
    [flpMyShifts, flpAllShifts] = await Promise.all([
      api('/api/flp/shifts/my'),
      api('/api/flp/shifts'),
    ]);
    const active = flpMyShifts.find(s => !s.shiftEnd);
    flpActiveShiftId = active ? active.id : null;
    shiftActionButtons();

    document.getElementById('my-shifts-tbody').innerHTML = flpMyShifts.length
      ? flpMyShifts.map(s => {
          const { start, end } = shiftTimeRange(s);
          return `<tr><td>${start}</td><td>${end}</td><td>${s.incidentsCount}</td><td>${s.arrestsCount}</td><td>${escapeHtml(s.notes || '—')}</td></tr>`;
        }).join('')
      : `<tr><td colspan="5" class="table-empty"><div class="table-empty-text">No shifts logged yet</div></td></tr>`;

    const recent = flpAllShifts.slice(0, 8);
    document.getElementById('dash-tbody').innerHTML = recent.length
      ? recent.map(s => {
          const { start, end } = shiftTimeRange(s);
          return `<tr><td>${escapeHtml(s.officer ? s.officer.displayName : '—')}</td><td>${start}</td><td>${end}</td><td>${s.incidentsCount}</td><td>${s.arrestsCount}</td></tr>`;
        }).join('')
      : `<tr><td colspan="5" class="table-empty"><div class="table-empty-text">No shifts logged yet</div></td></tr>`;

    document.getElementById('all-shifts-tbody').innerHTML = flpAllShifts.length
      ? flpAllShifts.map(s => {
          const { start, end } = shiftTimeRange(s);
          return `<tr><td>${escapeHtml(s.officer ? s.officer.displayName : '—')}</td><td>${start}</td><td>${end}</td><td>${s.incidentsCount}</td><td>${s.arrestsCount}</td><td>${escapeHtml(s.notes || '—')}</td></tr>`;
        }).join('')
      : `<tr><td colspan="6" class="table-empty"><div class="table-empty-text">No shifts logged yet</div></td></tr>`;

    await loadStats();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

loadAll();
