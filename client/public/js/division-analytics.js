// client/public/js/division-analytics.js
// Shared analytics renderer for the division dashboards (CID / SCO-19 / others).
// Fetches a division's /analytics endpoint and renders KPI tiles, a trend line
// chart, a host leaderboard, a recruitment funnel and integrity flags using the
// dependency-free MetCharts helpers. One call packs a whole Analytics page.
(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf = (n) => (window.MetCharts ? MetCharts.nfmt(n) : String(n || 0));

  function tile(label, value, sub, color) {
    return `<div class="stat-card" style="flex:1;min-width:150px;text-align:left;${color ? '--cc:' + color + ';' : ''}">
      <div class="stat-value" style="font-size:28px;color:${color || 'var(--text-primary)'};">${esc(value)}</div>
      <div class="stat-label">${esc(label)}</div>
      ${sub ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${esc(sub)}</div>` : ''}
    </div>`;
  }

  function kpiRow(t) {
    const tot = t.totals || {};
    const range = t.allTime ? 'all time' : `last ${t.days} days`;
    return `<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:1rem;">
      ${tile('Tryouts run', nf(tot.tryouts), range, 'var(--blue,#3b82f6)')}
      ${tile('Candidates', nf(tot.attendees), 'attended', 'var(--text-primary)')}
      ${tile('Passed', nf(tot.passed), `${nf(tot.failed)} failed`, 'var(--green,#22c55e)')}
      ${tile('Pass rate', (tot.passRate || 0) + '%', 'of attendees', tot.passRate >= 50 ? 'var(--green,#22c55e)' : 'var(--amber,#e8842a)')}
    </div>`;
  }

  function severityColor(s) { return s === 'high' ? '#ef4444' : s === 'medium' ? '#e8842a' : '#8b93a1'; }

  function fullHtml(data) {
    const t = data.tryouts || { totals: {}, series: [], leaderboard: [], days: data.days };
    const series = t.series || [];
    const labels = series.map(d => (d.day || '').slice(5)); // MM-DD
    const lineSeries = [
      { name: 'Attendees', color: '#3b82f6', points: series.map(d => d.attendees || 0) },
      { name: 'Passed', color: '#22c55e', points: series.map(d => d.passed || 0) },
      { name: 'Tryouts', color: '#8b5cf6', points: series.map(d => d.tryouts || 0) },
    ];
    const noChart = window.metEmpty ? window.metEmpty({ icon: 'ti-calendar-off', title: 'No tryout data in this window yet.', sub: 'Logged tryout sessions will chart here.' }) : '<div style="color:var(--text-muted);font-size:13px;padding:1rem;">No tryout data in this window yet.</div>';
    const chart = window.MetCharts && series.length ? MetCharts.lineChart(lineSeries, labels, { height: 210 }) : noChart;
    const leaders = (t.leaderboard || []).map(h => ({ label: h.hostName || 'Unknown', value: h.tryouts, sub: `${nf(h.attendees)} cand · ${h.passRate}% pass`, color: 'var(--blue,#3b82f6)' }));
    const noLeaders = window.metEmpty ? window.metEmpty({ icon: 'ti-users', title: 'No hosts yet.' }) : '<div style="color:var(--text-muted);font-size:13px;">No hosts yet.</div>';
    const leaderHtml = window.MetCharts && leaders.length ? MetCharts.barList(leaders) : noLeaders;
    const stages = (data.funnel && data.funnel.stages) || [];
    const noFunnel = window.metEmpty ? window.metEmpty({ icon: 'ti-users-group', title: 'No funnel data.' }) : '<div style="color:var(--text-muted);font-size:13px;">No funnel data.</div>';
    const funnelHtml = window.MetCharts && stages.length ? MetCharts.funnel(stages.map(s => ({ label: s.label, value: s.value }))) : noFunnel;
    const gaugeHtml = window.MetCharts ? MetCharts.gauge(t.totals ? t.totals.passRate : 0, 'pass rate', (t.totals && t.totals.passRate >= 50) ? '#22c55e' : '#e8842a') : '';
    const flags = (data.integrity && data.integrity.flags) || [];
    const flagsHtml = flags.length ? `<div class="panel glass" style="margin-top:1rem;">
      <div class="panel-header"><div class="panel-title"><span class="panel-dot amber"></span>Integrity Flags <span style="font-size:10px;color:var(--text-muted);">(${flags.length})</span></div></div>
      <div style="padding:0.4rem 1rem 1rem;">${flags.slice(0, 12).map(f => `<div style="display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--border-dim);">
        <span style="width:8px;height:8px;border-radius:50%;background:${severityColor(f.severity)};flex-shrink:0;"></span>
        <span style="font-size:12px;">${esc(f.kind)} — <span style="color:var(--text-muted);">${esc(f.host || '')}</span></span>
        <span style="margin-left:auto;font-size:10px;text-transform:uppercase;color:${severityColor(f.severity)};">${esc(f.severity)}</span>
      </div>`).join('')}</div></div>` : '';

    return `${kpiRow(t)}
      <div class="panel glass" style="margin-bottom:1rem;">
        <div class="panel-header"><div class="panel-title"><span class="panel-dot blue"></span>Trend · ${t.allTime ? 'all time' : 'last ' + t.days + ' days'}</div>
          <div class="da-days" style="display:flex;gap:4px;">
            ${[7, 30, 90].map(d => `<button class="btn btn-ghost btn-sm da-day-btn${(!t.allTime && d === t.days) ? ' active' : ''}" data-days="${d}">${d}d</button>`).join('')}
            <button class="btn btn-ghost btn-sm da-day-btn${t.allTime ? ' active' : ''}" data-days="all">All</button>
          </div>
        </div>
        <div style="padding:0.5rem 1rem 1rem;">${chart}</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;align-items:start;">
        <div class="panel glass"><div class="panel-header"><div class="panel-title"><span class="panel-dot green"></span>Host Leaderboard</div></div><div style="padding:0.8rem 1.1rem 1.1rem;">${leaderHtml}</div></div>
        <div class="panel glass"><div class="panel-header"><div class="panel-title"><span class="panel-dot amber"></span>Recruitment Funnel</div></div>
          <div style="padding:0.8rem 1.1rem 1.1rem;display:flex;gap:1rem;align-items:center;flex-wrap:wrap;">
            <div style="flex:1;min-width:220px;">${funnelHtml}</div>${gaugeHtml}
          </div></div>
      </div>
      ${flagsHtml}`;
  }

  // Render the full analytics page into a mount element. opts: { apiPath, mountId, days }
  async function render(opts) {
    const mount = document.getElementById(opts.mountId);
    if (!mount) return;
    const days = opts.days || 30;
    mount.innerHTML = '<div class="table-loading"><div class="spinner"></div></div>';
    let data;
    try { data = await api(`${opts.apiPath}?days=${days}`); }
    catch (e) { mount.innerHTML = `<div style="color:var(--red);padding:1rem;">${esc(e.message)}</div>`; return; }
    mount.innerHTML = fullHtml(data);
    // Wire the day-range toggle (re-render in place). "all" → all time.
    mount.querySelectorAll('.da-day-btn').forEach(b => b.addEventListener('click', () => {
      const dv = b.dataset.days;
      render({ ...opts, days: dv === 'all' ? 'all' : parseInt(dv, 10) });
    }));
  }

  // Lightweight KPI-only strip for an overview page. opts: { apiPath, mountId, days }
  async function kpis(opts) {
    const mount = document.getElementById(opts.mountId);
    if (!mount) return;
    try {
      const data = await api(`${opts.apiPath}?days=${opts.days || 30}`);
      mount.innerHTML = kpiRow(data.tryouts || { totals: {}, days: opts.days || 30 });
    } catch (e) { mount.innerHTML = ''; }
  }

  window.DivisionAnalytics = { render, kpis };
})();
