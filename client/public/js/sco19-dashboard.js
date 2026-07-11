/* SCO-19 dashboard — overview only.
   SCO-19 has no tryout programme, so this is a lightweight division hub: it
   shows the signed-in member's SCO-19 standing (read from their Roblox group
   rank via /api/me/divisions) and a short about panel. No tryout / live / log
   functionality exists here by design. */
(function () {
  const esc = window.escapeHtml || (s => String(s == null ? '' : s));

  const DIV = 'SCO19';
  const loaded = {};   // lazy-load each tab's data once

  function showPage(name) {
    document.querySelectorAll('.nav-item[data-page]').forEach(b => b.classList.toggle('active', b.getAttribute('data-page') === name));
    document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + name));
    if (name === 'activity' && !loaded.activity) { loaded.activity = 1; if (window.DivQuota) DivQuota.loadActivity(DIV); }
    if (name === 'quota'    && !loaded.quota)    { loaded.quota = 1;    if (window.DivQuota) DivQuota.loadReview(DIV); }
    if (name === 'loa'      && !loaded.loa)      { loaded.loa = 1;      if (window.LoaReview) LoaReview.load(DIV); }
  }

  document.querySelectorAll('.nav-item[data-page]').forEach(btn => {
    btn.addEventListener('click', () => showPage(btn.getAttribute('data-page')));
  });

  // Reveal the High Command tabs (Quota Review + LOA) only for SCO-19 leads.
  async function gateHicomm() {
    try {
      const d = await api('/api/divquota/' + DIV + '/access');
      if (d && d.canReview) {
        document.querySelectorAll('.hicomm-only').forEach(el => { el.style.display = ''; });
        // Surface a pending-LOA badge on the LOA nav item.
        try {
          const rows = await api('/api/loa/review?division=' + DIV);
          const pending = (rows || []).filter(r => r.status === 'PENDING').length;
          const badge = document.getElementById('sco19-loa-badge');
          if (badge && pending) { badge.textContent = pending; badge.style.display = ''; }
        } catch (e) {}
      }
    } catch (e) { /* not a lead / not configured → tabs stay hidden */ }
  }
  gateHicomm();

  // A KPI tile matching the other division dashboards (flex row, not a broken grid).
  function kpi(value, label, sub, icon) {
    return `<div class="stat-card" style="flex:1;min-width:170px;text-align:left;">
      ${icon ? `<div style="font-size:20px;color:var(--dc,var(--blue,#4a8fff));margin-bottom:8px;"><i class="ti ${icon}"></i></div>` : ''}
      <div class="stat-value" style="font-size:24px;line-height:1.15;">${esc(value)}</div>
      <div class="stat-label">${esc(label)}</div>
      ${sub ? `<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">${esc(sub)}</div>` : ''}
    </div>`;
  }

  // Jump to a tab from the overview's quick actions.
  window.sco19Go = function (name) {
    const btn = document.querySelector('.nav-item[data-page="' + name + '"]');
    if (btn) btn.click();
  };

  async function loadOverview() {
    const wrap = document.getElementById('sco19-kpis');
    if (!wrap) return;
    let sco = null;
    try {
      const data = await fetch('/api/me/divisions', { credentials: 'include' }).then(r => r.ok ? r.json() : null);
      const mine = (data && data.mine) || [];
      sco = mine.find(d => d.division === 'SCO19');
    } catch (e) { /* fall through to placeholders */ }
    const tier = sco ? (sco.tier === 'LEAD' ? 'Command' : 'Officer') : '—';
    const rankName = sco ? (sco.rankName || (sco.rank ? 'Rank ' + sco.rank : '—')) : 'Not a member';
    wrap.innerHTML =
      '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:1rem;">' + [
        kpi(rankName, 'Your SCO-19 rank', '', 'ti-shield-half-filled'),
        kpi(tier, 'Access tier', tier === 'Command' ? 'Assistant Commander and above' : 'Authorised firearms officer', 'ti-target-arrow'),
        kpi('Specialist Firearms Command', 'Division', 'Authorised firearms unit', 'ti-building-fortress'),
      ].join('') + '</div>';
  }

  loadOverview();
  if (window.DivQuota) DivQuota.loadMyQuota(DIV, 'dq-' + DIV + '-mine');
})();
