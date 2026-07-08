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
  if (pageId === 'results') loadResults();
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
    <div class="panel glass" style="margin-top:16px;"><div class="panel-header"><div class="panel-title"><span class="panel-dot amber"></span>Host Leaderboard</div></div><div style="padding:16px;">${t.leaderboard.length ? board : '<div class="table-empty-text">No tryouts in this period.</div>'}</div></div>`;
}
function statCard(v, l, c) { return `<div style="padding:14px 16px;border-radius:12px;border:1px solid var(--border,#2a2a2a);"><div style="font-size:26px;font-weight:800;${c ? 'color:' + c + ';' : ''}">${v}</div><div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;margin-top:4px;">${l}</div></div>`; }

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const SEV_COLOR = { high: 'var(--red)', medium: 'var(--amber)', low: 'var(--text-muted)' };

// Turn any internal question id in flag text (e.g. "revolver") into the
// marker-facing question number (Q9), using the loaded paper's question order.
// Handles both the quoted form ("revolver") and a bare id. Safe no-op when the
// text already uses question numbers.
function qNumberize(text) {
  if (!text || !hpcPaper || !Array.isArray(hpcPaper.questions)) return text || '';
  let out = String(text);
  hpcPaper.questions.forEach((q, i) => {
    const label = 'Q' + (i + 1);
    out = out.split('"' + q.id + '"').join(label);
    out = out.replace(new RegExp('\\b' + q.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g'), label);
  });
  return out;
}

async function initHpc() {
  try { hpcCtx = await api('/api/hpc/context'); } catch (e) { hpcCtx = { canMark: false, canQuota: false, canApprove: false }; }
  if (hpcCtx.canMark) document.querySelectorAll('.marker-only').forEach(el => el.style.display = '');
  if (hpcCtx.canQuota) document.querySelectorAll('.quota-only').forEach(el => el.style.display = '');
  if (hpcCtx.canApprove) { document.querySelectorAll('.approve-only').forEach(el => el.style.display = ''); loadReviewBadge(); }
  if (!hpcCtx.canMark && !hpcCtx.canQuota) document.getElementById('hpc-nonmarker-note').style.display = 'block';
  if (hpcCtx.canMark) { try { hpcPaper = (await api('/api/hpc/exam/paper')); } catch (e) {} loadStats(); }

  // Deep-link from the in-game "review your tryout" link: /hpc/dashboard?tryoutLog=<id>
  const tlogId = new URLSearchParams(location.search).get('tryoutLog');
  if (tlogId) { navigateTo('tryout-logs'); openTryoutLog(tlogId); }
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
    ? `<span style="color:var(--red);font-weight:700;"><i class="ti ti-alert-triangle"></i> ${s.highFlags} high</span>${s.flagCount > s.highFlags ? ` · ${s.flagCount - s.highFlags} more` : ''}`
    : (s.flagCount ? `<span style="color:var(--amber);">${s.flagCount} flag${s.flagCount > 1 ? 's' : ''}</span>` : '<span style="color:var(--green);">Clean</span>');
  const mark = s.status === 'PENDING' ? '' : `${s.score}/${s.maxScore} · ${s.percentage}%`;
  return `<tr>
    <td>${esc(s.discordUsername || s.discordId)}</td>
    <td>${esc(s.robloxUsername || '—')}</td>
    <td>${det}</td>
    <td>${statusBadge(s.status)}${mark ? ` <span class="text-muted" style="font-size:11px;">${mark}</span>` : ''}</td>
    <td>${formatDate(s.createdAt)}</td>
    <td>${s.status === 'PENDING'
      ? `<button class="btn btn-primary btn-sm" onclick="openMark('${s.id}')"><i class="ti ti-checkbox"></i> Mark exam</button>`
      : `<button class="btn btn-ghost btn-sm" onclick="openMark('${s.id}')"><i class="ti ti-eye"></i> Review</button>`}</td>
  </tr>`;
}

async function openMark(id) {
  try {
    const { paper, submission } = await api('/api/hpc/exam/submissions/' + id);
    hpcPaper = paper; hpcCurrent = submission;
    document.getElementById('mark-title').textContent = `${submission.discordUsername || submission.discordId}${submission.robloxUsername ? ' · ' + submission.robloxUsername : ''}`;

    // Flags panel. Rewrite any internal question ids (e.g. "revolver") in the
    // stored flag text to the marker-friendly question number (Q9) — covers old
    // submissions whose flags were saved before ids were switched to numbers.
    const flags = submission.flags || [];
    document.getElementById('mark-flags').innerHTML = flags.length ? `
      <div style="border:1px solid rgba(200,40,60,0.3);background:rgba(180,20,40,0.06);border-radius:8px;padding:0.9rem 1.1rem;margin-bottom:1rem;">
        <div style="font-size:12px;font-weight:700;color:var(--red);letter-spacing:0.05em;text-transform:uppercase;margin-bottom:8px;"><i class="ti ti-alert-triangle"></i> Cheating / AI detection (${flags.length})</div>
        ${flags.map(f => `<div style="font-size:12px;color:var(--text-secondary);padding:3px 0;"><span style="color:${SEV_COLOR[f.severity] || 'var(--text-muted)'};font-weight:600;">● ${esc(qNumberize(f.label))}</span>${f.detail ? ' — ' + esc(qNumberize(f.detail)) : ''}</div>`).join('')}
      </div>`
      : `<div style="font-size:12px;color:var(--green);margin-bottom:1rem;"><i class="ti ti-shield-check"></i> No cheating/AI signals detected.</div>`;

    // AI-detector scan panel.
    renderAiScan(submission.aiScan);

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

function aiColor(p) {
  if (p == null) return 'var(--text-muted)';
  if (p >= 60) return 'var(--red)';
  if (p >= 30) return 'var(--amber)';
  return 'var(--green)';
}

// Escape the answer, then wrap every AI-flagged sentence in a highlight mark.
function highlightAi(text, sentences) {
  let html = esc(text || '');
  (sentences || []).forEach(s => {
    const t = String(s || '').trim();
    if (t.length < 8) return;
    const needle = esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
      html = html.replace(new RegExp(needle, 'i'),
        m => `<mark style="background:rgba(224,80,58,0.28);color:inherit;border-radius:2px;padding:0 1px;">${m}</mark>`);
    } catch (e) { /* skip bad regex */ }
  });
  return html;
}

// Render the AI-detector panel inside the mark modal. `scan` may be null (never
// run), a { configured:false } notice, or a full multi-provider result.
window.renderAiScan = function (scan) {
  const el = document.getElementById('mark-aiscan');
  if (!el) return;
  const btn = `<button class="btn btn-ghost btn-sm" id="ai-scan-btn" onclick="runAiScan()"><i class="ti ti-robot"></i> ${scan ? 'Re-scan for AI' : 'Scan for AI'}</button>`;

  if (!scan) {
    el.innerHTML = `<div style="display:flex;align-items:center;gap:10px;margin-bottom:1rem;">${btn}
      <span style="font-size:12px;color:var(--text-muted);">Run the written answers through the configured AI detectors.</span></div>`;
    return;
  }
  if (scan.configured === false) {
    el.innerHTML = `<div style="border:1px solid var(--border-dim);border-radius:8px;padding:0.9rem 1.1rem;margin-bottom:1rem;">
      <div style="display:flex;align-items:center;gap:10px;">${btn}<span style="font-size:12px;color:var(--amber);">${esc(scan.message || 'No AI detectors configured.')}</span></div></div>`;
    return;
  }
  const providerChips = (scan.providers || []).map(p => `<span class="met-chip" style="font-size:10px;">${esc(p)}</span>`).join(' ');
  const answers = (hpcCurrent && hpcCurrent.answers) || {};
  const perAnswer = (scan.perAnswer || []).map(a => {
    const provs = (a.providers || []).map(pr => `<span style="font-size:10px;color:${aiColor(pr.aiProbability)};" ${pr.error ? `title="${esc(pr.error)}"` : ''}>${esc(pr.name)}: ${pr.aiProbability == null ? '—' : pr.aiProbability + '%'}</span>`).join(' · ');
    const prompt = a.prompt || '';
    const answerText = answers[a.qid] || '';
    const highlighted = highlightAi(answerText, a.aiSentences);
    const frac = (a.aiFraction != null && a.aiFraction > 0)
      ? ` · <span style="color:${aiColor(a.aiFraction)};">${a.aiFraction}% of text flagged</span>` : '';
    return `<div style="padding:7px 0;border-bottom:1px solid var(--border-dim);">
      <div style="font-size:11px;color:var(--text-muted);">${esc(prompt.slice(0, 80))}${prompt.length > 80 ? '…' : ''}</div>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:3px 0;"><span style="font-weight:700;color:${aiColor(a.overall)};">${a.overall == null ? '—' : a.overall + '% AI'}</span>${frac}<span style="font-size:10px;color:var(--text-muted);">${provs}</span></div>
      <div style="font-size:12px;color:var(--text-secondary);background:rgba(255,255,255,0.03);border-radius:6px;padding:6px 9px;white-space:pre-wrap;line-height:1.5;">${highlighted || '<em>(blank)</em>'}</div>
    </div>`;
  }).join('') || '<div style="font-size:12px;color:var(--text-muted);">No answers were long enough to scan reliably.</div>';

  el.innerHTML = `<div style="border:1px solid var(--border-dim);border-radius:8px;padding:0.9rem 1.1rem;margin-bottom:1rem;">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px;">
      <div style="font-size:12px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;"><i class="ti ti-robot"></i> AI detection — per answer</div>${btn}</div>
    <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;">${(scan.providers || []).length} detector(s): ${providerChips}</div>
    ${scan.message ? `<div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">${esc(scan.message)}</div>` : ''}
    <div>${perAnswer}</div>
    ${scan.scannedByName ? `<div style="font-size:10px;color:var(--text-muted);margin-top:6px;">Scanned by ${esc(scan.scannedByName)}${scan.at ? ' · ' + formatDateTime(scan.at) : ''}</div>` : ''}
  </div>`;
};

window.runAiScan = async function () {
  if (!hpcCurrent) return;
  const btn = document.getElementById('ai-scan-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader"></i> Scanning…'; }
  try {
    const scan = await api('/api/hpc/exam/submissions/' + hpcCurrent.id + '/ai-scan', { method: 'POST' });
    hpcCurrent.aiScan = scan;
    renderAiScan(scan);
    if (scan.configured === false) showToast(scan.message || 'No AI detectors configured.', 'warning');
    else showToast('AI scan complete', 'success');
  } catch (e) {
    showToast(e.message, 'error');
    renderAiScan(hpcCurrent.aiScan || null);
  }
};

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
  if (!(await uiConfirm('Submit this result? It will be posted to the results channel and shown to the cadet.'))) return;
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

// ── All final exams (read-only) ──────────────────────────────────────
async function loadResults() {
  const tbody = document.getElementById('hpc-results-tbody');
  try {
    const rows = await api('/api/hpc/exam/results');
    tbody.innerHTML = rows.length ? rows.map(r => `<tr class="row-clickable" onclick="openExamResult('${r.id}')" title="Click for details">
        <td>${esc(r.discordUsername || r.discordId)}</td>
        <td>${esc(r.robloxUsername || '—')}</td>
        <td>${r.status === 'PENDING' ? '—' : `${r.score}/${r.maxScore}`}</td>
        <td>${r.percentage != null ? r.percentage + '%' : '—'}</td>
        <td>${statusBadge(r.status)}</td>
        <td>${esc(r.markedByName || '—')}</td>
        <td>${formatDate(r.createdAt)} <i class="ti ti-chevron-right" style="color:var(--text-muted);font-size:13px;vertical-align:middle;"></i></td>
      </tr>`).join('')
      : `<tr><td colspan="7" class="table-empty"><div class="table-empty-text">No exams submitted yet.</div></td></tr>`;
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="table-empty"><div class="table-empty-text">${esc(err.message)}</div></td></tr>`;
  }
}

// Read-only exam detail (any HPC member clicks a Final Exam row).
async function openExamResult(id) {
  openModal('modal-exam-detail');
  document.getElementById('exd-body').innerHTML = '<div class="table-loading"><div class="spinner"></div></div>';
  document.getElementById('exd-footer').innerHTML = '';
  let r;
  try { r = await api('/api/hpc/exam/results/' + id); }
  catch (err) { document.getElementById('exd-body').innerHTML = `<div class="error-banner"><i class="ti ti-alert-triangle"></i> ${esc(err.message)}</div>`; return; }

  document.getElementById('exd-title').textContent = `Final Exam · ${r.discordUsername || r.robloxUsername || 'Cadet'}`;
  const marked = r.status !== 'PENDING';
  const rowsHtml = [
    ['Cadet', esc(r.discordUsername || r.discordId || '—')],
    ['Roblox', esc(r.robloxUsername || '—')],
    ['Status', statusBadge(r.status)],
    ['Mark', marked ? `${r.score}/${r.maxScore}` : '—'],
    ['Percentage', r.percentage != null ? r.percentage + '%' : '—'],
    ['Marked by', esc(r.markedByName || '—')],
    ['Marked', r.markedAt ? formatDateTime(r.markedAt) : '—'],
    ['Submitted', formatDateTime(r.createdAt)],
  ].map(([k, v]) => `<div style="display:flex;justify-content:space-between;gap:14px;padding:8px 0;border-bottom:1px solid var(--border-dim);">
      <span style="font-size:12px;color:var(--text-muted);">${k}</span><span style="font-size:13px;">${v}</span></div>`).join('');

  document.getElementById('exd-body').innerHTML = rowsHtml +
    (r.markerNote ? `<div style="margin-top:12px;"><div style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">Marker feedback</div>
       <div style="font-size:13px;color:var(--text-secondary);line-height:1.5;">${esc(r.markerNote)}</div></div>` : '');

  // Developers can void the exam; markers get a shortcut into the full paper.
  document.getElementById('exd-footer').innerHTML =
    `<button class="btn btn-ghost" onclick="closeModal('modal-exam-detail')">Close</button>` +
    (hpcCtx.isDev ? `<button class="btn btn-danger" onclick="voidExam('${r.id}','${esc(r.discordUsername || r.robloxUsername || 'cadet')}')"><i class="ti ti-trash"></i> Delete / void</button>` : '') +
    (r.canMark ? `<button class="btn btn-primary" onclick="closeModal('modal-exam-detail');openMark('${r.id}')"><i class="ti ti-file-search"></i> Open full paper</button>` : '');
}

// Developer-only: permanently void an exam so the cadet can retake it fresh.
async function voidExam(id, who) {
  if (!(await uiConfirm(`Void ${who}'s final exam? This deletes it entirely — they'll be treated as if they never took it and can take it again. This can't be undone.`))) return;
  try {
    await api('/api/hpc/exam/submissions/' + id, { method: 'DELETE' });
    showToast('Exam voided — the cadet can retake it.', 'success');
    closeModal('modal-exam-detail');
    loadResults();
    if (typeof loadStats === 'function') loadStats();
    if (document.getElementById('page-mark')?.classList.contains('active')) loadSubmissions();
  } catch (err) { showToast(err.message, 'error'); }
}

// ── Tryouts ──────────────────────────────────────────────────────────
const TRYOUT_STATUS = {
  SCHEDULED: ['badge-pending', 'Scheduled'], LIVE: ['badge-approved', '<i class="ti ti-broadcast"></i> Live'],
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
        <td>${esc(t.coHostName || '—')}</td>
        <td><span class="badge ${s[0]}"><span class="badge-dot"></span>${s[1]}</span></td>
        <td>${t.privateServerLink ? `<a href="${esc(t.privateServerLink)}" target="_blank" rel="noopener" onclick="event.stopPropagation();" class="btn btn-ghost btn-sm">Open</a>` : '—'}</td>
        <td>${btns.length ? `<div style="display:flex;gap:6px;justify-content:flex-end;">${btns.join('')}</div>` : ''}</td>
      </tr>`;
    }).join('')
      : `<tr><td colspan="6" class="table-empty"><div class="table-empty-text">No tryouts scheduled. Click “Schedule Tryout”.</div></td></tr>`;
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
    r('Host', esc(t.hostName || '—')) +
    r('Co-Host', esc(t.coHostName || '—')) +
    r('Scheduled', formatDateTime(t.scheduledAt)) +
    r('Server lock', esc(t.lockState || '—')) +
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
    if (b && pend.length) { b.textContent = pend.length; b.style.display = ''; }
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
    </tr>`).join('') : `<tr><td colspan="7" class="table-empty"><div class="table-empty-text">No tryout logs yet. Conclude a tryout in-game and it'll appear here to post.</div></td></tr>`;
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
    </tr>`).join('') : `<tr><td colspan="7" class="table-empty"><div class="table-empty-text">Nothing here.</div></td></tr>`;
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
    ? ` <span class="met-chip" title="Possible answer copying${a.quiz.copyWith ? ' — matched ' + esc(a.quiz.copyWith) : ''}" style="color:var(--red);border-color:var(--red);"><i class="ti ti-alert-triangle"></i> copy?</span>`
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
    <td>${a.note ? esc(a.note) : ''}${quizChip(a)}${copyChip(a)}${(!a.note && !a.quiz) ? '—' : ''}</td>
  </tr>`).join('') || `<tr><td colspan="4" class="table-empty-text">No attendees recorded.</td></tr>`;

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
    ? `<div class="${l.status === 'APPROVED' ? 'badge badge-approved' : 'badge badge-denied'}" style="margin-bottom:12px;"><span class="badge-dot"></span>${l.status} by ${esc(l.reviewedByName || 'HICOMM')}${l.reviewNote ? ' — ' + esc(l.reviewNote) : ''}${l.pointAwarded ? ' · +1 point awarded' : ''}</div>`
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
    await api(`/api/hpc/tryout-logs/${id}/submit`, { method: 'POST', body: JSON.stringify({
      notes: (document.getElementById('tlog-notes') || {}).value || '',
      attendees: collectAttendeeEdits(),
    }) });
    showToast('Tryout log posted for approval.', 'success');
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
      else showToast('Approved — point NOT awarded: ' + (r.pointDetail || 'check the HPC sheet config.'), r.pointReason === 'host_not_on_sheet' ? 'warning' : 'error');
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

  const badge = document.getElementById('hpc-live-badge');
  if (badge) { if (live.length) { badge.textContent = live.length; badge.style.display = ''; } else badge.style.display = 'none'; }
  if (status) status.outerHTML = `<span class="badge ${live.length ? 'badge-approved' : 'badge-pending'}" id="hpc-live-status"><span class="badge-dot"></span>${live.length ? 'Live · ' + live.length : 'No live tryouts'}</span>`;

  if (!live.length) {
    wrap.innerHTML = `<div class="panel glass"><div class="profile-section"><div class="table-empty-text">No tryouts are running right now. This page updates automatically when one goes live.</div></div></div>`;
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
        <td>${a.result === 'PASS' ? '<span style="color:var(--green);">Passed</span>' : a.result === 'FAIL' ? '<span style="color:var(--red);">Failed</span>' : '—'}</td>
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
        ${s.at ? `<div style="font-size:11px;color:var(--text-muted);margin-top:8px;">Last update ${formatDateTime(s.at)}</div>` : '<div style="font-size:11px;color:var(--text-muted);margin-top:8px;">No live snapshot yet — the in-game panel sends these while the tryout runs.</div>'}
      </div>
    </div>`;
  }).join('');
}

// Host/co-host: queue a management action for a live tryout (applied in-game).
async function tryoutCmd(tryoutId, action, targetRobloxId, targetUsername) {
  if (action === 'KICK' && !(await uiConfirm(`Kick ${targetUsername || 'this attendee'} from the tryout?`))) return;
  try {
    await api(`/api/hpc/tryouts/${tryoutId}/command`, { method: 'POST', body: JSON.stringify({ action, targetRobloxId, targetUsername }) });
    showToast(`${action[0] + action.slice(1).toLowerCase()} queued — applies on the next in-game sync.`, 'success');
  } catch (err) { showToast(err.message, 'error'); }
}

initHpc();
