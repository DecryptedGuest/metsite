/* ia-profiles.js — IA oversight "IA Profiles" tab.
   HICOMM / MET HICOMM search IA members and open a full record: Discord + Roblox
   identity, and every case investigated + ticket filed/reviewed, with statuses. */
(function () {
  const esc = window.escapeHtml || (s => String(s == null ? '' : s));
  const $ = id => document.getElementById(id);
  const fmtDate = d => { try { return window.formatDate ? window.formatDate(d) : new Date(d).toLocaleDateString(); } catch (e) { return ''; } };

  function statusBadge(s) {
    const v = String(s || '').toUpperCase();
    const cls = /APPROV|ACCEPT|RESOLV|CLOSED|COMPLETE/.test(v) ? 'badge-approved'
      : /DENY|DENIED|REJECT|DECLINE/.test(v) ? 'badge-denied'
      : /PENDING|REVIEW|OPEN|CLAIM/.test(v) ? 'badge-pending' : 'badge-amber';
    return `<span class="badge ${cls}"><span class="badge-dot"></span>${esc(v || '—')}</span>`;
  }
  function statusPills(byStatus) {
    const keys = Object.keys(byStatus || {});
    if (!keys.length) return '';
    return keys.map(k => `<span class="met-chip" style="font-size:11px;">${esc(k)}: <strong>${byStatus[k]}</strong></span>`).join(' ');
  }

  async function search() {
    const q = $('iap-search').value.trim();
    const box = $('iap-results');
    box.innerHTML = window.metSkeleton ? window.metSkeleton('feed', 6) : '<div class="table-loading"><div class="spinner"></div></div>';
    try {
      const rows = await api('/api/ia-profiles/search?q=' + encodeURIComponent(q));
      if (!rows.length) {
        box.innerHTML = window.metEmpty
          ? window.metEmpty({ icon: 'ti-users', title: 'No IA members found.', sub: 'Try a different name or Discord/Roblox handle.' })
          : '<div class="table-empty"><div class="table-empty-text">No IA members found.</div></div>';
        return;
      }
      box.innerHTML = `<div style="display:flex;flex-direction:column;gap:6px;">${rows.map(rowHtml).join('')}</div>`;
    } catch (e) {
      box.innerHTML = `<div class="table-empty"><div class="table-empty-text">${esc(e.message || 'Search failed')}</div></div>`;
    }
  }

  function rowHtml(u) {
    const av = u.discordAvatar
      ? `<img src="${esc(u.discordAvatar)}" style="width:34px;height:34px;border-radius:50%;object-fit:cover;">`
      : `<div class="user-avatar-fallback" style="width:34px;height:34px;">${esc((u.displayName || u.discordUsername || '?')[0].toUpperCase())}</div>`;
    return `<div class="iap-row" onclick="iapOpen('${esc(u.id)}')" style="display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--border,#2a3040);border-radius:9px;cursor:pointer;">
      ${av}
      <div style="min-width:0;flex:1;">
        <div style="font-weight:600;">${esc(u.displayName || u.discordUsername || 'Unknown')}</div>
        <div style="font-size:11px;color:var(--text-muted);">@${esc(u.discordUsername || '')}${u.robloxUsername ? ` · Roblox @${esc(u.robloxUsername)}` : ''}</div>
      </div>
      <span class="met-chip" style="border-color:var(--blue);color:var(--blue);">${esc(u.iaRank || u.role || '')}</span>
      <i class="ti ti-chevron-right" style="color:var(--text-muted);"></i>
    </div>`;
  }

  window.iapOpen = async function (id) {
    const box = $('iap-profile');
    box.innerHTML = '<div class="table-loading"><div class="spinner"></div></div>';
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    try {
      const p = await api('/api/ia-profiles/' + encodeURIComponent(id));
      box.innerHTML = profileHtml(p);
    } catch (e) {
      box.innerHTML = `<div class="panel glass"><div class="table-empty"><div class="table-empty-text">${esc(e.message || 'Failed to load')}</div></div></div>`;
    }
  };

  function idCardHtml(p) {
    const d = p.discord || {}, r = p.roblox || null;
    const dAv = d.avatar
      ? `<img src="${esc(d.avatar)}" alt="Discord" title="Discord avatar" style="width:56px;height:56px;border-radius:50%;object-fit:cover;border:2px solid #5865F2;background:#0b0f18;">`
      : `<div class="user-avatar-fallback" style="width:56px;height:56px;">${esc((d.username || '?')[0].toUpperCase())}</div>`;
    const rInner = r && r.headshot
      ? `<img src="${esc(r.headshot)}" alt="Roblox" title="Roblox avatar" style="width:56px;height:56px;border-radius:50%;object-fit:cover;border:2px solid #e2231a;background:#0b0f18;margin-left:-14px;">`
      : '';
    const rAv = rInner && r && r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener" style="display:inline-flex;">${rInner}</a>` : rInner;
    return `<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;">
      <div style="display:flex;align-items:center;"><img src="${esc(p.icon || '/img/divisions/ia.png')}" style="width:40px;height:40px;border-radius:9px;object-fit:cover;margin-right:8px;">${dAv}${rAv}</div>
      <div style="min-width:0;">
        <div style="font-size:18px;font-weight:800;">${esc(d.username || (r && r.username) || 'Unknown')}
          <span class="met-chip" style="border-color:var(--blue);color:var(--blue);margin-left:6px;">${esc(p.iaRank || p.role || '')}</span></div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">
          ${d.id ? `Discord ${esc(d.id)}` : ''}${d.username ? ` · @${esc(d.username)}` : ''}
          ${r ? ` · Roblox @${esc(r.username || '')} (${esc(r.id)})` : ' · Roblox not linked'}
        </div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">Joined ${esc(fmtDate(p.createdAt))} · Last seen ${esc(fmtDate(p.lastLogin))}</div>
      </div>
    </div>`;
  }

  function caseRowHtml(c) {
    return `<tr>
      <td><span class="case-ref">${esc(c.caseRef || '—')}</span>${c.origin === 'IA' ? ' <span class="met-chip" style="font-size:9px;">IA</span>' : ''}</td>
      <td>${esc(c.robloxUsername || c.suspectRobloxDisplayName || '—')}</td>
      <td>${esc(c.action || '—')}</td>
      <td>${statusBadge(c.status)}</td>
      <td class="date-cell">${esc(fmtDate(c.createdAt))}</td>
      <td>${c.caseLink ? `<a href="${esc(c.caseLink)}" target="_blank" rel="noopener" class="btn btn-ghost btn-sm" title="Open case in new tab" aria-label="Open case in new tab"><i class="ti ti-external-link"></i></a>` : ''}</td>
    </tr>`;
  }
  function ticketRowHtml(t) {
    return `<tr>
      <td><span class="case-ref">${esc(t.ticketRef || '—')}</span>${t.origin === 'IA' ? ' <span class="met-chip" style="font-size:9px;">IA</span>' : ''}</td>
      <td>${esc(t.ticketType || '—')}</td>
      <td>${esc(t.robloxUsername || '—')}</td>
      <td>${statusBadge(t.status)}</td>
      <td class="date-cell">${esc(fmtDate(t.createdAt))}</td>
      <td>${t.transcriptLink ? `<a href="${esc(t.transcriptLink)}" target="_blank" rel="noopener" class="btn btn-ghost btn-sm" title="Open ticket transcript in new tab" aria-label="Open ticket transcript in new tab"><i class="ti ti-external-link"></i></a>` : ''}</td>
    </tr>`;
  }

  function profileHtml(p) {
    const cases = p.cases || { total: 0, byStatus: {}, items: [] };
    const tickets = p.tickets || { total: 0, byStatus: {}, items: [] };
    const caseRows = cases.items.length ? cases.items.map(caseRowHtml).join('')
      : (window.metEmpty
          ? `<tr><td colspan="6">${window.metEmpty({ icon: 'ti-folder-off', title: 'No cases investigated.' })}</td></tr>`
          : '<tr><td colspan="6" class="table-empty-text" style="padding:12px;">No cases investigated.</td></tr>');
    const ticketRows = tickets.items.length ? tickets.items.map(ticketRowHtml).join('')
      : (window.metEmpty
          ? `<tr><td colspan="6">${window.metEmpty({ icon: 'ti-ticket', title: 'No ticket logs.' })}</td></tr>`
          : '<tr><td colspan="6" class="table-empty-text" style="padding:12px;">No ticket logs.</td></tr>');
    return `
      <div class="panel glass fade-up" style="margin-bottom:1.2rem;"><div style="padding:1.1rem 1.3rem;">${idCardHtml(p)}</div></div>
      <div class="panel glass fade-up" style="margin-bottom:1.2rem;">
        <div class="panel-header"><div class="panel-title"><i class="ti ti-folders"></i> Cases investigated · ${cases.total}</div></div>
        <div style="padding:6px 1.2rem;">${statusPills(cases.byStatus)}</div>
        <div class="table-wrap"><table class="data-table">
          <thead><tr><th>Ref</th><th>Suspect</th><th>Action</th><th>Status</th><th>Date</th><th></th></tr></thead>
          <tbody>${caseRows}</tbody>
        </table></div>
      </div>
      <div class="panel glass fade-up">
        <div class="panel-header"><div class="panel-title"><i class="ti ti-ticket"></i> Ticket logs · ${tickets.total}</div></div>
        <div style="padding:6px 1.2rem;">${statusPills(tickets.byStatus)}</div>
        <div class="table-wrap"><table class="data-table">
          <thead><tr><th>Ref</th><th>Type</th><th>Subject</th><th>Status</th><th>Date</th><th></th></tr></thead>
          <tbody>${ticketRows}</tbody>
        </table></div>
      </div>`;
  }

  function wire() {
    const btn = $('iap-search-btn'); if (btn) btn.addEventListener('click', search);
    const inp = $('iap-search'); if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); search(); } });
  }

  // Called by the dashboard router when the IA Profiles tab is opened.
  window.loadIaProfiles = function () {
    if (!window._iapWired) { wire(); window._iapWired = true; }
    if (!$('iap-results').innerHTML.trim()) search(); // initial: recent IA members
  };
})();
