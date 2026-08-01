// client/public/js/flp.js
// Frontline Policing dashboard — patrol & event logs.
//
// Logs are filed in Discord and signed off by someone ticking or crossing the
// message there. This page is the read-out of that, plus a sign-off button for
// FLP leads which mirrors the same reaction back onto the message so the two
// halves never disagree.
(function () {
  let ME = null;
  let CAN_DECIDE = false;
  let ALL = [];
  const filters = { kind: 'all', status: 'all', q: '' };

  const $ = id => document.getElementById(id);

  // ── Page switching (this dashboard has two pages) ───────────────
  function showPage(name) {
    document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + name));
    document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === name));
    if (name === 'logs') loadAll();
  }

  // ── Load ────────────────────────────────────────────────────────
  async function loadMe() {
    try {
      ME = await api('/api/me');
      const divs = await fetch('/api/me/divisions', { credentials: 'include' }).then(r => r.ok ? r.json() : null);
      const flp  = divs && (divs.mine || []).find(d => d.division === 'FLP');
      CAN_DECIDE = ME.role === 'DEVELOPER' || (flp && flp.tier === 'LEAD');
      if (CAN_DECIDE) {
        const btn = $('btn-logs-sync');
        if (btn) btn.style.display = '';
      }
    } catch (e) { /* the page still renders read-only */ }
  }

  async function loadStats() {
    try {
      const s = await api('/api/logs/stats');
      const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
      set('stat-logs-pending', s.pendingAll);
      set('stat-logs-week', s.mineWeek);
      set('stat-logs-approved', (s.byStatus && s.byStatus.APPROVED) || 0);
      set('stat-logs-denied', (s.byStatus && s.byStatus.DENIED) || 0);

      const badge = $('nav-logs-pending');
      if (badge) {
        badge.textContent = s.pendingAll;
        badge.style.display = s.pendingAll ? '' : 'none';
      }
      // Say so plainly rather than showing a permanently empty page.
      if (!s.configured) {
        const tbody = $('my-logs-tbody');
        if (tbody) tbody.innerHTML = emptyRow(5, 'Patrol/event log channels are not configured yet.');
      }
    } catch (e) { /* tiles just stay as em-dashes */ }
  }

  async function loadMine() {
    const tbody = $('my-logs-tbody');
    if (!tbody) return;
    try {
      const logs = await api('/api/logs?take=15');
      tbody.innerHTML = ActivityLogs.myRows(logs, { clickable: true });
    } catch (e) {
      tbody.innerHTML = emptyRow(5, 'Failed to load your logs.');
    }
  }

  async function loadAll() {
    const tbody = $('all-logs-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="7" class="table-loading"><div class="spinner"></div></td></tr>';
    try {
      ALL = await api('/api/logs/all?take=500');
      renderAll();
    } catch (e) {
      // A non-FLP member (who can still see their own logs) lands here.
      tbody.innerHTML = emptyRow(7, e && e.message ? e.message : 'Failed to load logs.');
    }
  }

  function renderAll() {
    const tbody = $('all-logs-tbody');
    if (!tbody) return;
    const q = filters.q.trim().toLowerCase();
    const rows = ALL.filter(l => {
      if (filters.kind !== 'all' && l.kind !== filters.kind) return false;
      if (filters.status !== 'all' && l.status !== filters.status) return false;
      if (!q) return true;
      return [l.content, l.officerUsername, l.officerRobloxUsername, l.decidedByName]
        .some(v => (v || '').toLowerCase().includes(q));
    });
    tbody.innerHTML = ActivityLogs.allRows(rows, { canDecide: CAN_DECIDE });
  }

  // ── Detail modal ────────────────────────────────────────────────
  async function openLog(id) {
    try {
      const log = await api('/api/logs/' + encodeURIComponent(id));
      $('log-modal-title').textContent = (log.kind === 'EVENT' ? 'Event log' : 'Patrol log');
      $('log-modal-body').innerHTML = ActivityLogs.detailHtml(log);
      $('log-modal-footer').innerHTML = CAN_DECIDE
        ? `<button class="btn btn-ghost" onclick="closeModal('modal-log')">Close</button>
           <button class="btn btn-danger"  data-decide="DENIED"   data-log-id="${log.id}"><i class="ti ti-x"></i> Deny</button>
           <button class="btn btn-primary" data-decide="APPROVED" data-log-id="${log.id}"><i class="ti ti-check"></i> Approve</button>`
        : `<button class="btn btn-ghost" onclick="closeModal('modal-log')">Close</button>`;
      openModal('modal-log');
    } catch (e) {
      showToast(e && e.message ? e.message : 'Could not open that log.', 'error');
    }
  }

  async function decide(id, status) {
    try {
      await api('/api/logs/' + encodeURIComponent(id) + '/decide', {
        method: 'POST',
        body: JSON.stringify({ status }),
      });
      showToast(status === 'APPROVED' ? 'Log approved.' : 'Log denied.', 'success');
      closeModal('modal-log');
      await Promise.all([loadAll(), loadMine(), loadStats()]);
    } catch (e) {
      showToast(e && e.message ? e.message : 'Could not record that decision.', 'error');
    }
  }

  // ── Wiring ──────────────────────────────────────────────────────
  // One delegated click handler: rows open the detail, the tick/cross buttons
  // decide (and must not also open the row underneath them).
  document.addEventListener('click', (ev) => {
    const decideBtn = ev.target.closest('[data-decide]');
    if (decideBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      decide(decideBtn.dataset.logId, decideBtn.dataset.decide);
      return;
    }
    const row = ev.target.closest('[data-log-id]');
    if (row && row.dataset.logId) { openLog(row.dataset.logId); return; }

    const nav = ev.target.closest('.nav-item[data-page]');
    if (nav) showPage(nav.dataset.page);
  });

  function wireTabs(containerId, key) {
    const box = $(containerId);
    if (!box) return;
    box.addEventListener('click', (ev) => {
      const tab = ev.target.closest('.filter-tab');
      if (!tab) return;
      box.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      filters[key] = tab.dataset[key];
      renderAll();
    });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    wireTabs('logs-kind-tabs', 'kind');
    wireTabs('logs-status-tabs', 'status');

    const search = $('logs-search');
    if (search) search.addEventListener('input', () => { filters.q = search.value; renderAll(); });

    const viewAll = $('link-all-logs');
    if (viewAll) viewAll.addEventListener('click', (e) => { e.preventDefault(); showPage('logs'); });

    const sync = $('btn-logs-sync');
    if (sync) sync.addEventListener('click', async () => {
      sync.disabled = true;
      try {
        const s = await api('/api/logs/sync', { method: 'POST', body: JSON.stringify({}) });
        showToast(`Re-synced — ${s.created} new, ${s.updated} updated.`, 'success');
        await Promise.all([loadAll(), loadMine(), loadStats()]);
      } catch (e) {
        showToast(e && e.message ? e.message : 'Sync failed.', 'error');
      } finally { sync.disabled = false; }
    });

    await loadMe();
    await Promise.all([loadStats(), loadMine()]);
  });
})();
