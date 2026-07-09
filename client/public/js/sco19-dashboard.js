/* SCO-19 dashboard — overview only.
   SCO-19 has no tryout programme, so this is a lightweight division hub: it
   shows the signed-in member's SCO-19 standing (read from their Roblox group
   rank via /api/me/divisions) and a short about panel. No tryout / live / log
   functionality exists here by design. */
(function () {
  const esc = window.escapeHtml || (s => String(s == null ? '' : s));

  // Simple sidebar page switching (single page today, kept for consistency).
  document.querySelectorAll('.nav-item[data-page]').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = btn.getAttribute('data-page');
      document.querySelectorAll('.nav-item[data-page]').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + name));
    });
  });

  function kpi(value, label, sub) {
    return `<div class="stat-card" style="text-align:left;">
      <div class="stat-value">${esc(value)}</div>
      <div class="stat-label">${esc(label)}</div>
      ${sub ? `<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">${esc(sub)}</div>` : ''}
    </div>`;
  }

  async function loadOverview() {
    const wrap = document.getElementById('sco19-kpis');
    if (!wrap) return;
    try {
      const data = await fetch('/api/me/divisions', { credentials: 'include' }).then(r => r.ok ? r.json() : null);
      const mine = (data && data.mine) || [];
      const sco = mine.find(d => d.division === 'SCO19');
      const tier = sco ? (sco.tier === 'LEAD' ? 'Command' : 'Officer') : '—';
      wrap.className = 'stat-grid fade-up';
      wrap.innerHTML = [
        kpi(sco ? (sco.rankName || ('Rank ' + sco.rank)) : 'Not a member', 'Your SCO-19 rank'),
        kpi(tier, 'Access tier', tier === 'Command' ? 'Assistant Commander and above' : 'Authorised firearms officer'),
        kpi('Specialist Firearms', 'Division'),
      ].join('');
    } catch (e) {
      wrap.innerHTML = '<div class="table-empty"><div class="table-empty-text">Couldn\'t load your SCO-19 standing.</div></div>';
    }
  }

  loadOverview();
})();
