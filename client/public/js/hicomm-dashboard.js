/* MET HICOMM oversight dashboard — Command Center, Analytics, Integrity,
   Officer 360° and the Audit Trail. All data from /api/hicomm/*. */
(function () {
  const esc = window.escapeHtml || (s => String(s == null ? '' : s));
  const C = window.MetCharts;
  const $ = id => document.getElementById(id);
  const fmtWhen = d => { try { return window.formatDateTime ? window.formatDateTime(d) : new Date(d).toLocaleString(); } catch (e) { return ''; } };
  const ago = d => {
    const s = Math.max(0, (Date.now() - new Date(d).getTime()) / 1000);
    if (s < 60) return 'just now'; if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago'; return Math.round(s / 86400) + 'd ago';
  };
  let ccTimer = null;

  // ── Nav ──
  function showPage(name) {
    document.querySelectorAll('.sidebar-nav .nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === name));
    document.querySelectorAll('.main-content .page').forEach(p => p.classList.toggle('active', p.id === 'page-' + name));
    if (name === 'command') startCC(); else stopCC();
    if (name === 'analytics') hcLoadAnalytics();
    if (name === 'integrity') hcLoadIntegrity();
    if (name === 'audit') hcLoadAudit();
  }
  function wireNav() {
    document.querySelectorAll('.sidebar-nav .nav-item').forEach(b => b.addEventListener('click', () => showPage(b.dataset.page)));
  }

  // ── Command Center ──
  function startCC() { stopCC(); hcLoadOverview(); ccTimer = setInterval(hcLoadOverview, 8000); }
  function stopCC() { if (ccTimer) { clearInterval(ccTimer); ccTimer = null; } }

  const COUNTERS = [
    ['liveTryouts', 'Live Tryouts', 'var(--green)'],
    ['openTickets', 'Open Tickets', 'var(--blue)'],
    ['pendingLogs', 'Logs to Review', 'var(--amber)'],
    ['pendingCases', 'Pending Cases', 'var(--red)'],
    ['pendingPatrols', 'Patrols Pending', 'var(--text-primary)'],
    ['tryoutsToday', 'Tryouts / 24h', 'var(--blue)'],
    ['ticketsToday', 'Tickets / 24h', 'var(--blue)'],
    ['newUsersToday', 'New Officers / 24h', 'var(--green)'],
  ];
  window.hcLoadOverview = async function () {
    let d; try { d = await api('/api/hicomm/overview'); } catch (e) { return; }
    $('hc-counters').innerHTML = COUNTERS.map(([k, l, c]) =>
      `<div class="cc-stat"><div class="v" style="color:${c};">${(d.counters[k] ?? 0)}</div><div class="l">${l}</div></div>`).join('');
    // live tryouts
    $('hc-live').innerHTML = d.live.length ? d.live.map(t => {
      const lock = ['UNLOCKED', 'UNSLOCKED'].includes(String(t.lockState || '').toUpperCase());
      return `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid var(--border,#2a2a2a);">
        <div><div style="font-weight:700;">${esc(t.hostName || 'Tryout')} <span class="badge badge-approved" style="font-size:9px;">${esc(t.division)}</span></div>
        <div style="font-size:11px;color:var(--text-muted);">${t.coHostName ? 'co: ' + esc(t.coHostName) + ' · ' : ''}${t.attendees} attending</div></div>
        <span class="badge ${lock ? 'badge-approved' : 'badge-denied'}"><span class="badge-dot"></span>${lock ? 'Unlocked' : 'Locked'}</span></div>`;
    }).join('') : '<div class="table-empty"><div class="table-empty-text">No tryouts are live right now.</div></div>';
    // audit feed
    $('hc-audit-feed').innerHTML = d.audit.length ? d.audit.map(auditRow).join('') : '<div class="table-empty"><div class="table-empty-text">No recorded actions yet.</div></div>';
  };

  const CAT_ICON = { GROUP: ['ti-users-group', '#3b82f6'], SUPPORT: ['ti-lifebuoy', '#8b93a1'], TRYOUT: ['ti-clipboard-check', '#22c55e'], CASE: ['ti-gavel', '#e0503a'], TICKET: ['ti-ticket', '#8b5cf6'], ACCESS: ['ti-key', '#e8842a'], DEV: ['ti-code', '#f5c518'] };
  function auditRow(a) {
    const [ic, col] = CAT_ICON[a.category] || ['ti-point', '#888'];
    return `<div class="tl-item">
      <div class="tl-dot" style="background:${col}22;color:${col};"><i class="ti ${ic}"></i></div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;">${esc(a.summary || (a.category + '/' + a.action))}</div>
        <div style="font-size:11px;color:var(--text-muted);">${esc(a.actorName || 'System')}${a.division ? ' · ' + esc(a.division) : ''} · ${ago(a.createdAt)}</div>
      </div></div>`;
  }

  // ── Analytics ──
  window.hcLoadAnalytics = async function () {
    const div = $('hc-an-div').value, days = $('hc-an-days').value;
    const wrap = $('hc-analytics');
    wrap.innerHTML = '<div class="table-loading"><div class="spinner"></div></div>';
    let d; try { d = await api(`/api/hicomm/analytics?division=${encodeURIComponent(div)}&days=${days}`); } catch (e) { wrap.innerHTML = `<div class="table-empty"><div class="table-empty-text">${esc(e.message)}</div></div>`; return; }
    renderAnalytics(wrap, d);
  };
  function renderAnalytics(wrap, d) {
    const t = d.tryouts, labels = t.series.map(s => s.day.slice(5));
    const passLine = C.lineChart([
      { name: 'Attendees', color: '#3b82f6', points: t.series.map(s => s.attendees) },
      { name: 'Passed', color: '#22c55e', points: t.series.map(s => s.passed) },
      { name: 'Failed', color: '#e0503a', points: t.series.map(s => s.failed) },
    ], labels);
    const act = d.activity, alabels = act.series.map(s => s.day.slice(5));
    const actLine = C.lineChart([
      { name: 'Patrols', color: '#14b8a6', points: act.series.map(s => s.patrols) },
      { name: 'Events', color: '#e8842a', points: act.series.map(s => s.events) },
      { name: 'Tickets', color: '#8b5cf6', points: act.series.map(s => s.tickets) },
    ], alabels);
    const board = C.barList(t.leaderboard.map(h => ({ label: h.hostName || 'Host', sub: `${h.tryouts} tryouts · ${h.passRate}% pass`, value: h.attendees, color: '#3b82f6' })));
    wrap.innerHTML = `
      <div class="cc-grid fade-up" style="margin-bottom:16px;">
        <div class="cc-stat"><div class="v">${t.totals.tryouts}</div><div class="l">Tryouts (${d.days}d)</div></div>
        <div class="cc-stat"><div class="v">${t.totals.attendees}</div><div class="l">Candidates</div></div>
        <div class="cc-stat"><div class="v" style="color:var(--green);">${t.totals.passed}</div><div class="l">Passed</div></div>
        <div class="cc-stat"><div class="v" style="color:var(--red);">${t.totals.failed}</div><div class="l">Failed</div></div>
        <div class="cc-stat"><div class="v" style="color:var(--amber);">${t.totals.passRate}%</div><div class="l">Pass Rate</div></div>
      </div>
      <div style="display:grid;grid-template-columns:1.4fr 1fr;gap:16px;">
        <div class="panel glass"><div class="panel-header"><div class="panel-title"><span class="panel-dot blue"></span>Tryout Performance</div></div><div style="padding:12px 16px;">${passLine}</div></div>
        <div class="panel glass"><div class="panel-header"><div class="panel-title"><span class="panel-dot green"></span>Recruitment Funnel</div></div><div style="padding:20px 16px;">${C.funnel(d.funnel.stages)}<div style="text-align:center;margin-top:14px;">${C.gauge(d.funnel.conversion, 'conversion', '#22c55e')}</div></div></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1.2fr;gap:16px;margin-top:16px;">
        <div class="panel glass"><div class="panel-header"><div class="panel-title"><span class="panel-dot amber"></span>Host Leaderboard</div></div><div style="padding:16px;">${t.leaderboard.length ? board : '<div class="table-empty-text">No tryouts yet.</div>'}</div></div>
        <div class="panel glass"><div class="panel-header"><div class="panel-title"><span class="panel-dot"></span>Portal Activity</div></div><div style="padding:12px 16px;">${actLine}</div></div>
      </div>`;
  }

  // ── Integrity ──
  window.hcLoadIntegrity = async function () {
    const div = $('hc-int-div').value;
    const wrap = $('hc-integrity');
    wrap.innerHTML = '<div class="table-loading"><div class="spinner"></div></div>';
    let d; try { d = await api('/api/hicomm/integrity?division=' + encodeURIComponent(div)); } catch (e) { wrap.innerHTML = `<div class="table-empty-text">${esc(e.message)}</div>`; return; }
    const badge = $('hc-integrity-badge');
    const high = d.flags.filter(f => f.severity === 'high').length;
    if (badge) { badge.style.display = d.flags.length ? 'inline-flex' : 'none'; badge.textContent = d.flags.length; }
    const col = { high: 'var(--red)', medium: 'var(--amber)', low: 'var(--text-muted)' };
    wrap.innerHTML = d.flags.length ? `
      <div style="margin-bottom:14px;font-size:13px;color:var(--text-secondary);">Scanned <strong>${d.scanned}</strong> recent tryout logs · <strong style="color:var(--red);">${high}</strong> high-severity flags.</div>
      ${d.flags.map(f => `<div class="flag-card" style="border-left-color:${col[f.severity]};">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div><span class="badge ${f.severity === 'high' ? 'badge-denied' : f.severity === 'medium' ? 'badge-amber' : 'badge-pending'}" style="text-transform:capitalize;">${f.severity}</span>
          <strong style="margin-left:8px;">${esc(f.kind.replace(/-/g, ' '))}</strong> ${f.division ? `<span class="badge badge-approved" style="font-size:9px;">${esc(f.division)}</span>` : ''}</div>
          ${f.logId ? `<a class="btn btn-ghost btn-sm" href="/${(f.division || 'hpc').toLowerCase() === 'sco19' ? 'sco19' : (f.division || 'hpc').toLowerCase()}/dashboard?tryoutLog=${f.logId}" target="_blank"><i class="ti ti-external-link"></i> Log</a>` : ''}
        </div>
        <div style="font-size:13px;margin-top:6px;">${esc(f.detail)}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:3px;">Host: ${esc(f.host || '—')}</div>
      </div>`).join('')}`
      : '<div class="table-empty"><div class="table-empty-text"><i class="ti ti-shield-check" style="font-size:26px;color:var(--green);"></i><br>No integrity issues detected.</div></div>';
  };

  // ── Officer 360 ──
  let offTimer = null;
  window.hcOfficerSearch = function () {
    clearTimeout(offTimer);
    offTimer = setTimeout(async () => {
      const q = $('hc-off-search').value.trim();
      if (q.length < 2) { $('hc-off-results').innerHTML = ''; return; }
      let rows; try { rows = await api('/api/hicomm/officer/search?q=' + encodeURIComponent(q)); } catch (e) { return; }
      $('hc-off-results').innerHTML = rows.map(u => `
        <div onclick="hcOfficer('${u.id}')" style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;cursor:pointer;border:1px solid var(--border,#2a2a2a);margin-bottom:6px;">
          ${u.avatar ? `<img src="${esc(u.avatar)}" style="width:32px;height:32px;border-radius:50%;">` : `<div style="width:32px;height:32px;border-radius:50%;background:#333;display:flex;align-items:center;justify-content:center;">${esc((u.name || '?').slice(0, 1).toUpperCase())}</div>`}
          <div><div style="font-weight:600;">${esc(u.name)}</div><div style="font-size:11px;color:var(--text-muted);">@${esc(u.discordUsername || '')}${u.robloxUsername ? ' · ' + esc(u.robloxUsername) : ''} · ${esc(u.role || '')}</div></div>
        </div>`).join('') || '<div class="table-empty-text">No officers found.</div>';
    }, 250);
  };
  window.hcOfficer = async function (id) {
    const wrap = $('hc-off-detail');
    wrap.innerHTML = '<div class="panel glass"><div class="table-loading"><div class="spinner"></div></div></div>';
    let d; try { d = await api(`/api/hicomm/officer/${id}/timeline`); } catch (e) { wrap.innerHTML = `<div class="panel glass"><div class="table-empty-text">${esc(e.message)}</div></div>`; return; }
    const o = d.officer;
    const chip = (n, l, c) => `<div class="cc-stat" style="text-align:center;"><div class="v" style="color:${c};font-size:22px;">${n}</div><div class="l">${l}</div></div>`;
    wrap.innerHTML = `
      <div class="panel glass fade-up" style="margin-bottom:16px;"><div style="padding:18px;display:flex;gap:16px;align-items:center;">
        ${o.avatar ? `<img src="${esc(o.avatar)}" style="width:64px;height:64px;border-radius:50%;">` : ''}
        <div style="flex:1;"><div style="font-size:20px;font-weight:800;">${esc(o.name)}</div>
        <div style="font-size:12px;color:var(--text-muted);">@${esc(o.discordUsername || '')}${o.robloxUsername ? ' · Roblox: ' + esc(o.robloxUsername) : ''} · ${esc(o.role || '')}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Joined ${fmtWhen(o.joinedAt)}${o.lastLogin ? ' · last seen ' + ago(o.lastLogin) : ''}</div></div>
      </div></div>
      <div class="cc-grid fade-up" style="margin-bottom:16px;">
        ${chip(d.counts.hosted, 'Tryouts Hosted', 'var(--blue)')}${chip(d.counts.patrols, 'Patrol Logs', 'var(--green)')}
        ${chip(d.counts.cases, 'IA Cases', 'var(--red)')}${chip(d.counts.punishments, 'Punishments', 'var(--amber)')}${chip(d.counts.tickets, 'Tickets', 'var(--text-primary)')}
      </div>
      <div class="panel glass fade-up"><div class="panel-header"><div class="panel-title"><span class="panel-dot"></span>Full Timeline</div></div>
        <div style="padding:8px 18px;max-height:520px;overflow:auto;">${d.events.length ? d.events.map(e => `
          <div class="tl-item"><div class="tl-dot" style="background:${e.color}22;color:${e.color};"><i class="ti ${e.icon}"></i></div>
          <div style="flex:1;"><div style="font-size:13px;font-weight:600;">${esc(e.title)} ${e.status ? `<span class="badge badge-pending" style="font-size:9px;">${esc(e.status)}</span>` : ''}</div>
          ${e.detail ? `<div style="font-size:12px;color:var(--text-secondary);">${esc(e.detail)}</div>` : ''}
          <div style="font-size:11px;color:var(--text-muted);">${fmtWhen(e.at)}</div></div></div>`).join('') : '<div class="table-empty-text">No recorded history.</div>'}</div>
      </div>`;
  };

  // ── Audit trail ──
  let auditT = null;
  window.hcAuditDebounced = function () { clearTimeout(auditT); auditT = setTimeout(hcLoadAudit, 250); };
  window.hcLoadAudit = async function () {
    const cat = $('hc-audit-cat').value, q = $('hc-audit-q').value.trim();
    const tb = $('hc-audit-tbody');
    tb.innerHTML = '<tr><td colspan="5" class="table-loading"><div class="spinner"></div></td></tr>';
    let rows; try { rows = await api(`/api/hicomm/audit?category=${encodeURIComponent(cat)}&q=${encodeURIComponent(q)}`); } catch (e) { tb.innerHTML = `<tr><td colspan="5" class="table-empty-text">${esc(e.message)}</td></tr>`; return; }
    tb.innerHTML = rows.length ? rows.map(a => {
      const [ic, col] = CAT_ICON[a.category] || ['ti-point', '#888'];
      return `<tr><td style="white-space:nowrap;font-size:12px;color:var(--text-muted);">${ago(a.createdAt)}</td>
        <td><span style="color:${col};"><i class="ti ${ic}"></i> ${esc(a.category)}</span></td>
        <td><span class="mono" style="font-size:11px;">${esc(a.action)}</span></td>
        <td>${esc(a.actorName || 'System')}</td><td>${esc(a.summary || '')}</td></tr>`;
    }).join('') : '<tr><td colspan="5" class="table-empty"><div class="table-empty-text">No matching actions.</div></td></tr>';
  };

  // ── Init ──
  async function init() {
    wireNav();
    try {
      const c = await api('/api/hicomm/context');
      const parts = [];
      if (c.metRank) parts.push(`${c.metRank.name} (rank ${c.metRank.rank})`);
      if (c.minRank != null) parts.push(`HICOMM ≥ ${c.minRank}`);
      $('hc-rank').textContent = parts.join(' · ');
    } catch (e) {}
    hcLoadIntegrity();  // warm the badge
    startCC();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
