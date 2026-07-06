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
    // Line + area, with a draw-in animation (pathLength=1 → stroke-dashoffset).
    const paths = series.map((s, si) => {
      const d = s.points.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
      const area = `${d} L${x(s.points.length - 1).toFixed(1)},${pad.t + ih} L${x(0).toFixed(1)},${pad.t + ih} Z`;
      return `<path d="${area}" fill="${s.color}" style="opacity:0;animation:mcFade .7s ease ${0.15 * si + 0.25}s forwards;"/>`
        + `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" pathLength="1" style="stroke-dasharray:1;stroke-dashoffset:1;animation:mcDraw .9s ease ${0.15 * si}s forwards;"/>`;
    }).join('');
    // Point dots (fade in after the line draws).
    const dots = series.map(s => s.points.map((v, i) =>
      `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.4" fill="${s.color}" style="opacity:0;animation:mcFade .4s ease .7s forwards;"/>`).join('')).join('');
    // Invisible hover bands → tooltip showing every series value at that x.
    const bandW = n > 1 ? iw / (n - 1) : iw;
    const bands = labels.map((l, i) => {
      const payload = [esc(l)].concat(series.map(s => `${esc(s.name)}␟${s.color}␟${nfmt(s.points[i])}`)).join('␞');
      const bx = Math.max(pad.l, x(i) - bandW / 2);
      return `<rect x="${bx.toFixed(1)}" y="${pad.t}" width="${bandW.toFixed(1)}" height="${ih}" fill="transparent" data-p="${payload}" onmousemove="MetCharts._tip(event,this.getAttribute('data-p'))" onmouseleave="MetCharts._tipHide()"></rect>`;
    }).join('');
    const xticks = labels.map((l, i) => (i % Math.ceil(n / 6) === 0 || i === n - 1)
      ? `<text x="${x(i)}" y="${h - 6}" text-anchor="middle" font-size="9" fill="var(--text-muted,#888)">${esc(l)}</text>` : '').join('');
    const legend = series.length > 1 ? `<div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:6px;font-size:11px;">${series.map(s => `<span style="display:inline-flex;align-items:center;gap:5px;"><span style="width:10px;height:10px;border-radius:2px;background:${s.color};display:inline-block;"></span>${esc(s.name)}</span>`).join('')}</div>` : '';
    return `<div><style>@keyframes mcDraw{to{stroke-dashoffset:0}}@keyframes mcFade{to{opacity:1}}</style>`
      + `<svg viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="xMidYMid meet" style="display:block;">${grid}${paths}${dots}${bands}${xticks}</svg>${legend}</div>`;
  }

  // ── Interactive tooltip (shared) ──
  function _tipEl() {
    let el = document.getElementById('mc-tip');
    if (!el) {
      el = document.createElement('div');
      el.id = 'mc-tip';
      el.style.cssText = 'position:fixed;z-index:12000;pointer-events:none;background:var(--panel-solid,#151821);border:1px solid var(--border,#2a2a2a);border-radius:9px;padding:8px 11px;font-size:12px;box-shadow:0 10px 30px rgba(0,0,0,.45);display:none;white-space:nowrap;';
      document.body.appendChild(el);
    }
    return el;
  }
  function _tip(evt, payload) {
    const el = _tipEl();
    const parts = String(payload).split('␞');
    const label = parts.shift();
    el.innerHTML = `<div style="font-weight:700;margin-bottom:5px;">${label}</div>` + parts.map(p => {
      const seg = p.split('␟');
      return `<div style="display:flex;align-items:center;gap:7px;line-height:1.6;"><span style="width:9px;height:9px;border-radius:2px;background:${seg[1]};display:inline-block;"></span>${seg[0]}: <strong>${seg[2]}</strong></div>`;
    }).join('');
    el.style.display = 'block';
    const px = evt.clientX + 14, py = evt.clientY + 14;
    el.style.left = Math.min(px, window.innerWidth - el.offsetWidth - 12) + 'px';
    el.style.top = Math.min(py, window.innerHeight - el.offsetHeight - 12) + 'px';
  }
  function _tipHide() { const el = document.getElementById('mc-tip'); if (el) el.style.display = 'none'; }

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

  window.MetCharts = { lineChart, barList, funnel, gauge, nfmt, _tip, _tipHide };
})();
