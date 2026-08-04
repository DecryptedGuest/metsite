// client/public/js/group-panel.js
// Self-contained Roblox Group Panel used by the MET High Command dashboard.
// Talks to the same /api/admin/group/* endpoints the developer panel uses
// (now shared with MET HICOMM server-side). Depends only on api()/showToast()/
// uiConfirm() from ui.js — it does NOT reuse dashboard.js, so the developer
// dashboard is unaffected. Exposes the handful of window.* handlers the
// #page-group markup calls, plus window.loadGroupPanel() as the entry point.
(function () {
  const BOT_RANK_NAME = 'Deputy Assistant Commissioner'; // fallback if the bot account isn't in the member list
  const MET_ADMIN_USER_ID = '11077193582'; // METAdministration — its live rank is the real ceiling

  let currentDivision = '';
  let rolesCache = null;
  let pendingCache = [];
  let membersCache = [];

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (v) => { try { return new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } };
  const gq = (params) => {
    const p = new URLSearchParams(params || {});
    if (currentDivision) p.set('division', currentDivision);
    const s = p.toString();
    return s ? '?' + s : '';
  };
  const errBox = (msg) => `<p style="padding:1rem 1.2rem;font-size:13px;color:var(--red);">${esc(msg)}</p>`;

  function botRankThreshold() {
    // The bot account's OWN live rank in this group is the true ceiling — Roblox
    // rejects managing anyone at the bot's rank or above.
    const bot = membersCache.find(x => String(x.userId) === MET_ADMIN_USER_ID);
    if (bot && bot.roleRank != null) return bot.roleRank;
    const r = (rolesCache || []).find(x => (x.name || '').trim().toLowerCase() === BOT_RANK_NAME.toLowerCase());
    if (r) return r.rank;
    const m = membersCache.find(x => (x.roleName || '').trim().toLowerCase() === BOT_RANK_NAME.toLowerCase());
    // Unknown ceiling (e.g. a non-MET division group managed by a different bot
    // account we can't identify here) → FAIL CLOSED: lock every row and offer no
    // assignable ranks, rather than defaulting to Infinity and showing edit
    // controls that Roblox then rejects with a 403.
    return m ? m.roleRank : -Infinity;
  }

  async function loadDivisions() {
    const sel = document.getElementById('group-division-select');
    if (!sel) return;
    try {
      const divs = await api('/api/admin/group/divisions');
      // No "Default group" entry. It resolved to the MET umbrella group, which
      // is already in this list by name — two options doing the same thing, one
      // of them labelled after an environment variable.
      sel.innerHTML = divs
        .map(d => `<option value="${esc(d.key)}">${esc(d.name)}${d.fullName && d.fullName !== d.name ? ' — ' + esc(d.fullName) : ''}</option>`)
        .join('');
      // Land on MET when nothing is chosen — the group "Default" used to mean.
      if (!currentDivision) currentDivision = divs.some(d => d.key === 'MET') ? 'MET' : (divs[0] ? divs[0].key : '');
      sel.value = currentDivision;
    } catch (e) { /* switcher optional */ }
  }

  window.changeGroupDivision = function (key) {
    currentDivision = key || '';
    rolesCache = null;
    loadGroupPanel();
  };

  window.loadGroupPanel = async function loadGroupPanel() {
    // Awaited: every request below carries ?division=, and on the very first load
    // that key only exists once the switcher has been filled in.
    await loadDivisions();
    try {
      rolesCache = await api('/api/admin/group/roles' + gq());
      const badge = document.getElementById('group-env-badge');
      if (badge) badge.textContent = `${rolesCache.length} role(s) loaded`;
    } catch (err) {
      rolesCache = [];
      const badge = document.getElementById('group-env-badge');
      if (badge) badge.textContent = `Roles failed: ${err.message}`;
    }
    await Promise.all([loadPendingRequests(), loadGroupMembers()]);
  };

  window.refreshGroupPanel = function () {
    rolesCache = null;
    const dbg = document.getElementById('group-debug-output');
    if (dbg) dbg.style.display = 'none';
    loadGroupPanel();
  };

  window.runGroupDebug = async function () {
    const output = document.getElementById('group-debug-output');
    const pre = document.getElementById('group-debug-pre');
    if (!output || !pre) return;
    output.style.display = 'block';
    pre.textContent = 'Fetching raw Roblox API responses…';
    try { pre.textContent = JSON.stringify(await api('/api/admin/group/debug'), null, 2); }
    catch (err) { pre.textContent = `Error: ${err.message}`; }
  };

  window.toggleGroupSection = function (bodyId, btn) {
    const body = document.getElementById(bodyId);
    if (!body) return;
    const hidden = body.style.display === 'none';
    body.style.display = hidden ? '' : 'none';
    const icon = btn && btn.querySelector('i');
    if (icon) icon.className = hidden ? 'ti ti-chevron-down' : 'ti ti-chevron-right';
  };

  // ── Pending join requests ──
  async function loadPendingRequests() {
    const container = document.getElementById('pending-requests-container');
    if (!container) return;
    container.innerHTML = window.metSkeleton ? window.metSkeleton('rows', 4) : '<div class="table-loading"><div class="spinner"></div></div>';
    try {
      pendingCache = [];
      let token = null, pages = 0;
      do {
        const data = await api('/api/admin/group/pending' + gq(token ? { pageToken: token } : {}));
        pendingCache = pendingCache.concat((data && data.requests) || []);
        token = (data && data.nextPageToken) || null;
      } while (token && ++pages < 1000);
      renderPendingRequests();
    } catch (err) { container.innerHTML = errBox(`Failed to load join requests: ${err.message}`); }
  }
  window.loadPendingRequests = loadPendingRequests;

  window.renderPendingRequests = function renderPendingRequests() {
    const container = document.getElementById('pending-requests-container');
    if (!container) return;
    const q = (document.getElementById('pending-search')?.value || '').trim().toLowerCase();
    let list = pendingCache.slice();
    if (q) list = list.filter(r => (r.username || '').toLowerCase().includes(q) || (r.displayName || '').toLowerCase().includes(q) || String(r.userId).includes(q));
    const countEl = document.getElementById('pending-count');
    if (countEl) countEl.textContent = `(${list.length})`;
    if (!list.length) { container.innerHTML = window.metEmpty ? window.metEmpty({ icon: 'ti-inbox', title: 'No pending join requests', sub: 'New requests to join the group will appear here.' }) : `<p style="padding:1rem 1.2rem;font-size:13px;color:var(--text-muted);">No pending join requests.</p>`; return; }
    container.innerHTML = `<div class="join-request-list">${list.map(r => `
      <div class="join-request-row">
        <div class="join-request-info">
          <span class="join-request-name">${esc(r.username)}</span>
          ${r.displayName && r.displayName !== r.username ? `<span class="join-request-display">${esc(r.displayName)}</span>` : ''}
          <span style="font-size:10px;color:var(--text-muted);">ID: ${esc(r.userId)}</span>
          ${r.requestedAt ? `<span class="join-request-time">${fmtDate(r.requestedAt)}</span>` : ''}
        </div>
        <div class="join-request-actions">
          <button class="row-btn row-btn-approve" onclick="resolveRequest('${esc(r.userId)}','approve','${esc(r.username)}')"><i class="ti ti-check"></i> Accept</button>
          <button class="row-btn row-btn-deny" onclick="resolveRequest('${esc(r.userId)}','decline','${esc(r.username)}')"><i class="ti ti-x"></i> Decline</button>
        </div>
      </div>`).join('')}</div>`;
  };

  window.resolveRequest = async function (userId, action, username) {
    try {
      await api(`/api/admin/group/pending/${userId}/${action}` + gq(), { method: 'POST' });
      showToast(`${username} ${action === 'approve' ? 'accepted' : 'declined'}.`, action === 'approve' ? 'success' : 'info');
      loadPendingRequests();
    } catch (err) { showToast(err.message || `Failed to ${action}.`, 'error'); }
  };

  // ── Members ──
  async function loadGroupMembers() {
    const tbody = document.getElementById('group-members-tbody');
    if (!tbody) return;
    tbody.innerHTML = window.metSkeleton ? `<tr><td colspan="4">${window.metSkeleton('rows', 6)}</td></tr>` : '<tr><td colspan="4" class="table-loading"><div class="spinner"></div></td></tr>';
    try {
      membersCache = [];
      let token = null, pages = 0;
      do {
        const result = await api('/api/admin/group/members' + gq(token ? { pageToken: token } : {}));
        membersCache = membersCache.concat((result && result.members) || []);
        token = (result && result.nextPageToken) || null;
        renderGroupMembers();
      } while (token && ++pages < 1000); // was 30 (=3000 members) — truncated large groups, hiding recent joiners
      populateRankFilter();
      renderGroupMembers();
    } catch (err) { tbody.innerHTML = `<tr><td colspan="4">${errBox(`Failed to load members: ${err.message}`)}</td></tr>`; }
  }
  window.loadGroupMembers = loadGroupMembers;

  function populateRankFilter() {
    const sel = document.getElementById('members-rank-filter');
    if (!sel) return;
    const prev = sel.value;
    const seen = new Map();
    membersCache.forEach(m => { if (m.roleName && !seen.has(m.roleName)) seen.set(m.roleName, m.roleRank ?? -1); });
    (rolesCache || []).forEach(r => { if (r.name && !seen.has(r.name)) seen.set(r.name, r.rank ?? -1); });
    const ranks = [...seen.entries()].sort((a, b) => b[1] - a[1]);
    sel.innerHTML = '<option value="">All ranks</option>' + ranks.map(([name]) => `<option value="${esc(name)}">${esc(name)}</option>`).join('');
    if (prev) sel.value = prev;
  }

  window.renderGroupMembers = function renderGroupMembers() {
    const tbody = document.getElementById('group-members-tbody');
    if (!tbody) return;
    const roles = rolesCache || [];
    const threshold = botRankThreshold();
    const q = (document.getElementById('members-search')?.value || '').trim().toLowerCase();
    const rankFilter = document.getElementById('members-rank-filter')?.value || '';
    let list = membersCache.map(m => ({ ...m, _rank: (m.roleRank != null ? m.roleRank : -1), _roleName: m.roleName || m.roleId || '—' }));
    list.sort((a, b) => b._rank - a._rank);
    if (rankFilter) list = list.filter(m => m._roleName === rankFilter);
    if (q) list = list.filter(m => (m.username || '').toLowerCase().includes(q) || (m.displayName || '').toLowerCase().includes(q) || String(m.userId).includes(q));
    const countEl = document.getElementById('members-count');
    if (countEl) countEl.textContent = `(${list.length}${list.length !== membersCache.length ? ' / ' + membersCache.length : ''})`;
    if (!list.length) { tbody.innerHTML = window.metEmpty ? `<tr><td colspan="4">${window.metEmpty({ icon: 'ti-users', title: 'No members found', sub: 'Try clearing the search or rank filter.' })}</td></tr>` : `<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:1.2rem;">No members found.</td></tr>`; return; }
    const assignable = roles.filter(r => r.rank < threshold).sort((a, b) => b.rank - a.rank);
    const roleOptions = (cur) => assignable.map(r => `<option value="${esc(String(r.id))}" ${String(r.id) === String(cur) ? 'selected' : ''}>${esc(r.name)}</option>`).join('') || '<option value="">No assignable ranks</option>';
    tbody.innerHTML = list.map(m => {
      const locked = m._rank >= threshold;
      return `
        <tr style="${locked ? 'opacity:0.4;' : ''}">
          <td><div style="display:flex;flex-direction:column;gap:2px;">
            <span style="font-size:12px;font-weight:500;color:var(--text-primary);">${esc(m.username)}</span>
            ${m.displayName && m.displayName !== m.username ? `<span style="font-size:10px;color:var(--text-muted);">${esc(m.displayName)}</span>` : ''}
            <span style="font-size:10px;color:var(--text-muted);">ID: ${esc(m.userId)}</span>
          </div></td>
          <td><span style="font-size:12px;color:var(--text-secondary);">${esc(m._roleName)}</span>
            ${locked ? '<span style="font-size:9px;color:var(--text-muted);display:block;"><i class="ti ti-lock"></i> above bot rank</span>' : ''}</td>
          <td>${locked ? '<span style="font-size:11px;color:var(--text-muted);">—</span>' : `<select class="role-select" id="rank-sel-${esc(m.userId)}">${roleOptions(m.roleId)}</select>`}</td>
          <td>${locked ? '<span style="font-size:11px;color:var(--text-muted);">Cannot edit</span>' : `<div class="admin-actions">
            <button class="row-btn row-btn-approve btn-sm" onclick="changeGroupRankUI('${esc(m.userId)}','${esc(m.username)}')"><i class="ti ti-arrow-up"></i> Rank</button>
            <button class="row-btn row-btn-deny btn-sm" onclick="kickGroupMember('${esc(m.userId)}','${esc(m.username)}')"><i class="ti ti-door-exit"></i> Kick</button>
          </div>`}</td>
        </tr>`;
    }).join('');
  };

  window.changeGroupRankUI = async function (userId, username) {
    const sel = document.getElementById(`rank-sel-${userId}`);
    const roleId = sel && sel.value;
    if (!roleId) { showToast('Select a rank first.', 'error'); return; }
    try {
      await api(`/api/admin/group/members/${userId}/rank` + gq(), { method: 'PATCH', body: JSON.stringify({ roleId }) });
      const roleName = (rolesCache || []).find(r => String(r.id) === String(roleId))?.name || roleId;
      showToast(`${username} ranked to ${roleName}.`, 'success');
      loadGroupMembers();
    } catch (err) { showToast(err.message || 'Failed to change rank.', 'error'); }
  };

  window.kickGroupMember = async function (userId, username) {
    if (!(await uiConfirm(`Kick ${username} from the Roblox group?`))) return;
    try {
      await api(`/api/admin/group/members/${userId}` + gq(), { method: 'DELETE' });
      showToast(`${username} kicked from group.`, 'success');
      loadGroupMembers();
    } catch (err) { showToast(err.message || 'Failed to kick.', 'error'); }
  };
})();
