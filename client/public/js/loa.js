// client/public/js/loa.js — Leave of Absence request + review page.
(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (v) => { try { return new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); } catch (e) { return '—'; } };
  const badge = (s) => {
    const map = { PENDING: 'badge-pending', APPROVED: 'badge-approved', DENIED: 'badge-denied', CANCELLED: 'badge-denied' };
    return `<span class="badge ${map[s] || 'badge-pending'}"><span class="badge-dot"></span>${esc(s[0] + s.slice(1).toLowerCase())}</span>`;
  };
  let CTX = { scopes: ['MET'], scopeNames: {}, canReviewMet: false, reviewDivisions: [] };

  async function init() {
    try { CTX = await api('/api/loa/context'); } catch (e) { /* keep defaults */ }
    const sel = document.getElementById('loa-scope');
    sel.innerHTML = CTX.scopes.map(s => `<option value="${esc(s)}">${esc(s === 'MET' ? 'MET (whole service)' : (CTX.scopeNames[s] || s))}</option>`).join('');
    sel.onchange = updateHint; updateHint();
    loadMine();
    if (CTX.canReviewMet || (CTX.reviewDivisions && CTX.reviewDivisions.length)) {
      document.getElementById('loa-review-panel').style.display = '';
      loadLoaReview();
    }
  }

  function updateHint() {
    const s = document.getElementById('loa-scope').value;
    const hint = document.getElementById('loa-forward-hint');
    hint.textContent = s === 'MET' ? 'Forwarded to MET High Command.' : `Forwarded to ${CTX.scopeNames[s] || s} High Command.`;
  }

  window.submitLoa = async function () {
    const scope = document.getElementById('loa-scope').value;
    const startAt = document.getElementById('loa-start').value;
    const endAt = document.getElementById('loa-end').value;
    const reason = document.getElementById('loa-reason').value.trim();
    if (!startAt) return showToast('Pick a start date.', 'warning');
    if (!endAt) return showToast('Pick an end date.', 'warning');
    try {
      await api('/api/loa', { method: 'POST', body: JSON.stringify({ scope, division: scope === 'MET' ? null : scope, startAt, endAt, reason }) });
      showToast('LOA request submitted.', 'success');
      document.getElementById('loa-reason').value = '';
      loadMine();
    } catch (e) { showToast(e.message, 'error'); }
  };

  async function loadMine() {
    const tb = document.getElementById('loa-mine-tbody');
    let rows; try { rows = await api('/api/loa/mine'); } catch (e) { tb.innerHTML = `<tr><td colspan="5" class="table-empty-text">${esc(e.message)}</td></tr>`; return; }
    tb.innerHTML = rows.length ? rows.map(r => `<tr>
      <td>${esc(r.scope === 'MET' ? 'MET' : (CTX.scopeNames[r.division] || r.division || '—'))}</td>
      <td style="white-space:nowrap;">${fmt(r.startAt)} → ${fmt(r.endAt)}</td>
      <td style="max-width:280px;">${esc(r.reason || '—')}</td>
      <td>${badge(r.status)}</td>
      <td style="text-align:right;">${r.status === 'PENDING' ? `<button class="btn btn-ghost btn-sm" style="color:var(--red);" onclick="cancelLoa('${r.id}')"><i class="ti ti-x"></i> Cancel</button>` : ''}</td>
    </tr>`).join('') : '<tr><td colspan="5" class="table-empty"><div class="table-empty-text">No requests yet.</div></td></tr>';
  }

  window.cancelLoa = async function (id) {
    if (!(await uiConfirm('Withdraw this LOA request?'))) return;
    try { await api('/api/loa/' + id + '/cancel', { method: 'POST' }); showToast('Request withdrawn.', 'info'); loadMine(); }
    catch (e) { showToast(e.message, 'error'); }
  };

  window.loadLoaReview = async function () {
    const tb = document.getElementById('loa-review-tbody');
    let rows; try { rows = await api('/api/loa/review'); } catch (e) { tb.innerHTML = `<tr><td colspan="6" class="table-empty-text">${esc(e.message)}</td></tr>`; return; }
    tb.innerHTML = rows.length ? rows.map(r => `<tr>
      <td>${esc(r.userName || '—')}</td>
      <td>${esc(r.scope === 'MET' ? 'MET' : (CTX.scopeNames[r.division] || r.division || '—'))}</td>
      <td style="white-space:nowrap;">${fmt(r.startAt)} → ${fmt(r.endAt)}</td>
      <td style="max-width:240px;">${esc(r.reason || '—')}</td>
      <td>${badge(r.status)}</td>
      <td style="text-align:right;white-space:nowrap;">${r.status === 'PENDING' ? `
        <button class="btn btn-ghost btn-sm" style="color:var(--green);" onclick="decideLoa('${r.id}','approve')"><i class="ti ti-check"></i></button>
        <button class="btn btn-ghost btn-sm" style="color:var(--red);" onclick="decideLoa('${r.id}','deny')"><i class="ti ti-x"></i></button>` : (r.reviewerName ? `<span style="font-size:11px;color:var(--text-muted);">${esc(r.reviewerName)}</span>` : '')}</td>
    </tr>`).join('') : '<tr><td colspan="6" class="table-empty"><div class="table-empty-text">Nothing to review.</div></td></tr>';
  };

  window.decideLoa = async function (id, action) {
    let note = '';
    if (action === 'deny') { note = await uiPrompt('Reason for denial (optional):'); if (note === null) return; }
    try { await api('/api/loa/' + id + '/decision', { method: 'POST', body: JSON.stringify({ action, note }) }); showToast(`Request ${action === 'approve' ? 'approved' : 'denied'}.`, action === 'approve' ? 'success' : 'info'); loadLoaReview(); }
    catch (e) { showToast(e.message, 'error'); }
  };

  document.addEventListener('DOMContentLoaded', init);
})();
