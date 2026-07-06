/* charts.js — tiny dependency-free inline-SVG charts, theme-aware via CSS vars.
   Shared by the MET HICOMM command center and the division analytics tabs. */
(function () {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const nfmt = n => { n = +n || 0; return n >= 1000 ? (n / 1000).toFixed(n % 1000 ? 1 : 0) + 'k' : String(n); };

  // Multi-series smooth line chart. series: [{ name, color, points:[y..] }], labels:[x..]
  function lineChart(series, labels, opts = {}) {
    const w = opts.width || 640, h = opts.height || 200, pad = { l: 34, r: 12, t: 12, b: 22 };
    const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
    const all = series.flatMap(s => s.points);
    const max = Math.max(1, ...all), n = labels.length || 1;
    const x = i => pad.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
    const y = v => pad.t + ih - (v / max) * ih;
    const grid = [0, 0.25, 0.5, 0.75, 1].map(f => {
      const gy = pad.t + ih - f * ih;
      return `<line x1="${pad.l}" y1="${gy}" x2="${w - pad.r}" y2="${gy}" stroke="var(--border,#2a2a2a)" stroke-width="1" opacity="0.5"/>`
        + `<text x="${pad.l - 6}" y="${gy + 3}" text-anchor="end" font-size="9" fill="var(--text-muted,#888)">${nfmt(Math.round(max * f))}</text>`;
    }).join('');
    const paths = series.map(s => {
      const d = s.points.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
      const area = `${d} L${x(s.points.length - 1).toFixed(1)},${pad.t + ih} L${x(0).toFixed(1)},${pad.t + ih} Z`;
      return `<path d="${area}" fill="${s.color}" opacity="0.08"/><path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    }).join('');
    const xticks = labels.map((l, i) => (i % Math.ceil(n / 6) === 0 || i === n - 1)
      ? `<text x="${x(i)}" y="${h - 6}" text-anchor="middle" font-size="9" fill="var(--text-muted,#888)">${esc(l)}</text>` : '').join('');
    const legend = series.length > 1 ? `<div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:6px;font-size:11px;">${series.map(s => `<span style="display:inline-flex;align-items:center;gap:5px;"><span style="width:10px;height:10px;border-radius:2px;background:${s.color};display:inline-block;"></span>${esc(s.name)}</span>`).join('')}</div>` : '';
    return `<div><svg viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="xMidYMid meet" style="display:block;">${grid}${paths}${xticks}</svg>${legend}</div>`;
  }

  // Horizontal bar list. rows: [{ label, value, sub?, color? }]
  function barList(rows, opts = {}) {
    const max = Math.max(1, ...rows.map(r => r.value));
    return `<div style="display:flex;flex-direction:column;gap:8px;">${rows.map(r => `
      <div>
        <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px;"><span>${esc(r.label)}${r.sub ? ` <span style="color:var(--text-muted);font-size:10px;">${esc(r.sub)}</span>` : ''}</span><span style="font-weight:700;">${nfmt(r.value)}</span></div>
        <div style="height:7px;border-radius:5px;background:var(--border,#2a2a2a);overflow:hidden;"><div style="height:100%;width:${(r.value / max) * 100}%;background:${r.color || 'var(--blue,#3b82f6)'};border-radius:5px;"></div></div>
      </div>`).join('')}</div>`;
  }

  // Funnel: stages:[{ label, value }]
  function funnel(stages, opts = {}) {
    const max = Math.max(1, ...stages.map(s => s.value));
    const colors = ['#3b82f6', '#8b5cf6', '#22c55e', '#e8842a'];
    return `<div style="display:flex;flex-direction:column;gap:6px;">${stages.map((s, i) => {
      const pct = (s.value / max) * 100;
      const conv = i > 0 && stages[i - 1].value ? Math.round((s.value / stages[i - 1].value) * 100) : null;
      return `<div style="display:flex;align-items:center;gap:10px;">
        <div style="flex:1;height:34px;background:var(--border,#2a2a2a);border-radius:7px;overflow:hidden;position:relative;">
          <div style="height:100%;width:${Math.max(pct, 8)}%;background:${colors[i % colors.length]};display:flex;align-items:center;padding:0 10px;color:#fff;font-size:12px;font-weight:700;">${esc(s.label)}</div>
          <span style="position:absolute;right:10px;top:50%;transform:translateY(-50%);font-size:12px;font-weight:700;">${nfmt(s.value)}</span>
        </div>
        ${conv != null ? `<span style="width:44px;font-size:11px;color:var(--text-muted);text-align:right;">${conv}%</span>` : '<span style="width:44px;"></span>'}
      </div>`;
    }).join('')}</div>`;
  }

  // Donut/gauge for a single percentage.
  function gauge(pct, label, color) {
    pct = Math.max(0, Math.min(100, +pct || 0));
    const r = 46, c = 2 * Math.PI * r, off = c * (1 - pct / 100);
    return `<div style="display:flex;flex-direction:column;align-items:center;">
      <svg viewBox="0 0 120 120" width="120" height="120">
        <circle cx="60" cy="60" r="${r}" fill="none" stroke="var(--border,#2a2a2a)" stroke-width="10"/>
        <circle cx="60" cy="60" r="${r}" fill="none" stroke="${color || 'var(--green,#22c55e)'}" stroke-width="10" stroke-linecap="round"
          stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 60 60)"/>
        <text x="60" y="58" text-anchor="middle" font-size="26" font-weight="700" fill="var(--text-primary,#fff)">${Math.round(pct)}%</text>
        <text x="60" y="76" text-anchor="middle" font-size="10" fill="var(--text-muted,#888)">${esc(label || '')}</text>
      </svg></div>`;
  }

  window.MetCharts = { lineChart, barList, funnel, gauge, nfmt };
})();
