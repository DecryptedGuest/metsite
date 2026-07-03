// client/public/js/hpc-dashboard.js — HPC: final-exam marking + quota
let hpcCtx = { canMark: false, canQuota: false };
let hpcPaper = null;
let hpcCurrent = null; // submission being marked
let hpcFilter = 'PENDING';

function navigateTo(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item[data-page]').forEach(b => b.classList.remove('active'));
  const page = document.getElementById('page-' + pageId);
  if (page) page.classList.add('active');
  const btn = document.querySelector(`.nav-item[data-page="${pageId}"]`);
  if (btn) btn.classList.add('active');
  if (pageId === 'mark') loadSubmissions();
}
document.querySelectorAll('.nav-item[data-page]').forEach(btn => btn.addEventListener('click', () => navigateTo(btn.dataset.page)));

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const SEV_COLOR = { high: 'var(--red)', medium: 'var(--amber)', low: 'var(--text-muted)' };

async function initHpc() {
  try { hpcCtx = await api('/api/hpc/context'); } catch (e) { hpcCtx = { canMark: false, canQuota: false }; }
  if (hpcCtx.canMark) document.querySelectorAll('.marker-only').forEach(el => el.style.display = '');
  if (hpcCtx.canQuota) document.querySelectorAll('.quota-only').forEach(el => el.style.display = '');
  if (!hpcCtx.canMark && !hpcCtx.canQuota) document.getElementById('hpc-nonmarker-note').style.display = 'block';
  if (hpcCtx.canMark) { try { hpcPaper = (await api('/api/hpc/exam/paper')); } catch (e) {} loadStats(); }
}

async function loadStats() {
  try {
    const [pending, passed, failed] = await Promise.all([
      api('/api/hpc/exam/submissions?status=PENDING'),
      api('/api/hpc/exam/submissions?status=PASSED'),
      api('/api/hpc/exam/submissions?status=FAILED'),
    ]);
    document.getElementById('stat-pending').textContent = pending.length;
    document.getElementById('stat-passed').textContent = passed.length;
    document.getElementById('stat-failed').textContent = failed.length;
    const badge = document.getElementById('hpc-pending-badge');
    if (pending.length) { badge.textContent = pending.length; badge.style.display = ''; }
  } catch (e) { /* non-fatal */ }
}

document.getElementById('hpc-filter-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.filter-tab');
  if (!btn) return;
  document.querySelectorAll('#hpc-filter-tabs .filter-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  hpcFilter = btn.dataset.filter;
  loadSubmissions();
});

async function loadSubmissions() {
  const tbody = document.getElementById('hpc-subs-tbody');
  tbody.innerHTML = '<tr><td colspan="6" class="table-loading"><div class="spinner"></div></td></tr>';
  try {
    const q = hpcFilter === 'all' ? '' : '?status=' + hpcFilter;
    const subs = await api('/api/hpc/exam/submissions' + q);
    tbody.innerHTML = subs.length ? subs.map(subRow).join('')
      : `<tr><td colspan="6" class="table-empty"><div class="table-empty-text">No submissions here.</div></td></tr>`;
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="table-empty"><div class="table-empty-text">${esc(err.message)}</div></td></tr>`;
  }
}

function statusBadge(s) {
  const m = { PENDING: ['badge-pending', 'Awaiting'], PASSED: ['badge-approved', 'Passed'], FAILED: ['badge-denied', 'Failed'] }[s] || ['', s];
  return `<span class="badge ${m[0]}"><span class="badge-dot"></span>${m[1]}</span>`;
}

function subRow(s) {
  const det = s.highFlags
    ? `<span style="color:var(--red);font-weight:700;">⚠ ${s.highFlags} high</span>${s.flagCount > s.highFlags ? ` · ${s.flagCount - s.highFlags} more` : ''}`
    : (s.flagCount ? `<span style="color:var(--amber);">${s.flagCount} flag${s.flagCount > 1 ? 's' : ''}</span>` : '<span style="color:var(--green);">Clean</span>');
  const mark = s.status === 'PENDING' ? '' : `${s.score}/${s.maxScore} · ${s.percentage}%`;
  return `<tr>
    <td>${esc(s.discordUsername || s.discordId)}</td>
    <td>${esc(s.robloxUsername || '—')}</td>
    <td>${det}</td>
    <td>${statusBadge(s.status)}${mark ? ` <span class="text-muted" style="font-size:11px;">${mark}</span>` : ''}</td>
    <td>${formatDate(s.createdAt)}</td>
    <td><button class="btn btn-ghost btn-sm" onclick="openMark('${s.id}')">${s.status === 'PENDING' ? 'Mark' : 'Review'}</button></td>
  </tr>`;
}

async function openMark(id) {
  try {
    const { paper, submission } = await api('/api/hpc/exam/submissions/' + id);
    hpcPaper = paper; hpcCurrent = submission;
    document.getElementById('mark-title').textContent = `${submission.discordUsername || submission.discordId}${submission.robloxUsername ? ' · ' + submission.robloxUsername : ''}`;

    // Flags panel.
    const flags = submission.flags || [];
    document.getElementById('mark-flags').innerHTML = flags.length ? `
      <div style="border:1px solid rgba(200,40,60,0.3);background:rgba(180,20,40,0.06);border-radius:8px;padding:0.9rem 1.1rem;margin-bottom:1rem;">
        <div style="font-size:12px;font-weight:700;color:var(--red);letter-spacing:0.05em;text-transform:uppercase;margin-bottom:8px;"><i class="ti ti-alert-triangle"></i> Cheating / AI detection (${flags.length})</div>
        ${flags.map(f => `<div style="font-size:12px;color:var(--text-secondary);padding:3px 0;"><span style="color:${SEV_COLOR[f.severity] || 'var(--text-muted)'};font-weight:600;">● ${esc(f.label)}</span>${f.detail ? ' — ' + esc(f.detail) : ''}</div>`).join('')}
      </div>`
      : `<div style="font-size:12px;color:var(--green);margin-bottom:1rem;"><i class="ti ti-shield-check"></i> No cheating/AI signals detected.</div>`;

    // Per-question answer + score input.
    const marked = submission.status !== 'PENDING';
    document.getElementById('mark-questions').innerHTML = paper.questions.map((q, i) => {
      const ans = (submission.answers && submission.answers[q.id]) || '';
      const cur = submission.scores && submission.scores[q.id] != null ? submission.scores[q.id] : '';
      return `<div style="padding:0.7rem 0;border-bottom:1px solid var(--border-dim);">
        <div style="font-size:12px;font-weight:600;margin-bottom:4px;">Q${i + 1}. ${esc(q.prompt)}</div>
        <div style="font-size:13px;color:var(--text-secondary);background:rgba(255,255,255,0.03);border-radius:6px;padding:7px 10px;white-space:pre-wrap;">${esc(ans) || '<em>(blank)</em>'}</div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:6px;">
          <label style="font-size:11px;color:var(--text-muted);">Points (0–${q.points}):</label>
          <input type="number" class="form-control hpc-score" data-qid="${q.id}" min="0" max="${q.points}" step="1" value="${cur}" ${marked ? 'disabled' : ''} oninput="recalcMark()" style="width:80px;height:30px;font-size:13px;" />
        </div>
      </div>`;
    }).join('');

    document.getElementById('mark-note').value = submission.markerNote || '';
    document.getElementById('mark-note').disabled = marked;
    const btn = document.getElementById('mark-submit-btn');
    btn.style.display = marked ? 'none' : '';
    recalcMark();
    openModal('modal-mark');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function recalcMark() {
  let total = 0;
  document.querySelectorAll('.hpc-score').forEach(el => { total += Math.max(0, Math.min(Number(el.max), Number(el.value) || 0)); });
  const max = hpcPaper.total;
  const pct = Math.round((total / max) * 100);
  const pass = pct >= hpcPaper.passPercent;
  document.getElementById('mark-total').innerHTML = `${total} / ${max} · <span style="color:${pass ? 'var(--green)' : 'var(--red)'};">${pct}% ${pass ? 'PASS' : 'FAIL'}</span>`;
}

async function submitMark() {
  const scores = {};
  document.querySelectorAll('.hpc-score').forEach(el => { scores[el.dataset.qid] = Math.max(0, Math.min(Number(el.max), Number(el.value) || 0)); });
  const note = document.getElementById('mark-note').value.trim();
  if (!confirm('Submit this result? It will be posted to the results channel and shown to the cadet.')) return;
  const btn = document.getElementById('mark-submit-btn');
  btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader"></i> Submitting…';
  try {
    const r = await api('/api/hpc/exam/submissions/' + hpcCurrent.id + '/mark', { method: 'POST', body: JSON.stringify({ scores, note }) });
    showToast(`Result: ${r.status} (${r.score}/${r.maxScore}, ${r.percentage}%)${r.posted ? ' · posted to Discord' : ' · Discord post skipped (no webhook set)'}`, 'success');
    closeModal('modal-mark');
    loadSubmissions(); loadStats();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false; btn.innerHTML = '<i class="ti ti-send"></i> Submit Result';
  }
}

initHpc();
