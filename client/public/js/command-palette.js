/* command-palette.js — site-wide ⌘K / Ctrl-K quick launcher.
   Jumps between divisions/pages and (for HICOMM/dev) searches officers.
   Self-contained; include on any dashboard after ui.js. */
(function () {
  const esc = window.escapeHtml || (s => String(s == null ? '' : s));
  let el, input, list, open = false, items = [], sel = 0, officerTimer = null;

  const NAV = [
    { label: 'My Profile', icon: 'ti-user', url: '/profile' },
    { label: 'Install on phone / Get the app', icon: 'ti-device-mobile', url: '/app' },
    { label: 'MET High Command', icon: 'ti-shield-star', url: '/hicomm/dashboard' },
    { label: 'HPC Dashboard', icon: 'ti-school', url: '/hpc/dashboard' },
    { label: 'CID Dashboard', icon: 'ti-fingerprint', url: '/cid/dashboard' },
    { label: 'SCO-19 Dashboard', icon: 'ti-target', url: '/sco19/dashboard' },
    { label: 'FLP Dashboard', icon: 'ti-shield', url: '/flp/dashboard' },
    { label: 'IA Dashboard', icon: 'ti-scale', url: '/ia/dashboard' },
    { label: 'Dev Panel', icon: 'ti-code', url: '/dev/dashboard' },
    { label: 'Dev · Security Center', icon: 'ti-shield-lock', url: '/dev/security' },
    { label: 'Toggle theme', icon: 'ti-moon', action: () => {
        const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', cur); try { localStorage.setItem('iacms_theme', cur); } catch (e) {}
      } },
    { label: 'Toggle reduce motion', icon: 'ti-accessible', action: () => {
        let pref = ''; try { pref = localStorage.getItem('iacms_reduce_motion') || ''; } catch (e) {}
        const osReduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const next = !(pref === 'on' || (pref !== 'off' && osReduce));
        try { localStorage.setItem('iacms_reduce_motion', next ? 'on' : 'off'); } catch (e) {}
        if (window.applyReduceMotion) window.applyReduceMotion(next);
        if (window.showToast) showToast(next ? 'Reduced motion on' : 'Reduced motion off', 'info');
      } },
    { label: 'Toggle compact layout', icon: 'ti-layout-rows', action: () => {
        var on = false; try { on = localStorage.getItem('iacms_density') === 'compact'; } catch (e) {}
        var next = !on;
        try { localStorage.setItem('iacms_density', next ? 'compact' : 'cosy'); } catch (e) {}
        if (window.applyDensity) window.applyDensity(next);
        if (window.showToast) showToast(next ? 'Compact layout on' : 'Comfortable layout', 'info');
      } },
    { label: 'Copy link to this page', icon: 'ti-link', action: () => {
        if (window.copyText) window.copyText(location.href, 'Page link');
      } },
    // IA actions. pageItems() already turns every sidebar tab into a command,
    // so only the things with no sidebar entry need listing here. Each is a
    // no-op on pages where the handler doesn't exist.
    { label: 'Submit a case', icon: 'ti-plus', action: () => {
        if (typeof window.openNewCaseModal === 'function') window.openNewCaseModal();
        else window.location.href = '/ia/dashboard';
      } },
    { label: 'New case document', icon: 'ti-file-plus', action: () => {
        if (window.CaseDoc) window.CaseDoc.openBuilder({});
        else window.location.href = '/ia/dashboard';
      } },
    { label: 'Sign out', icon: 'ti-logout', action: () => {
        const f = document.createElement('form'); f.method = 'POST'; f.action = '/auth/logout';
        document.body.appendChild(f); f.submit();
      } },
  ];

  function build() {
    if (el) return;
    el = document.createElement('div');
    el.id = 'cmdk';
    el.style.cssText = 'display:none;position:fixed;inset:0;z-index:11000;background:rgba(0,0,0,.55);backdrop-filter:blur(3px);align-items:flex-start;justify-content:center;';
    el.innerHTML = `<div style="margin-top:12vh;width:min(560px,92vw);background:var(--panel-solid,#151821);border:1px solid var(--border,#2a2a2a);border-radius:14px;box-shadow:0 24px 70px rgba(0,0,0,.55);overflow:hidden;">
      <div style="display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--border,#2a2a2a);">
        <i class="ti ti-search" style="font-size:18px;color:var(--text-muted);"></i>
        <input id="cmdk-input" placeholder="Jump to a page, division, or search an officer…" style="flex:1;background:none;border:none;outline:none;color:var(--text-primary,#fff);font-size:15px;" />
        <span style="font-size:10px;color:var(--text-muted);border:1px solid var(--border);border-radius:5px;padding:2px 6px;">ESC</span>
      </div>
      <div id="cmdk-list" style="max-height:52vh;overflow:auto;padding:6px;"></div></div>`;
    document.body.appendChild(el);
    input = el.querySelector('#cmdk-input');
    list = el.querySelector('#cmdk-list');
    el.addEventListener('click', e => { if (e.target === el) close(); });
    input.addEventListener('input', onType);
    input.addEventListener('keydown', onKey);
  }

  function render() {
    list.innerHTML = items.map((it, i) => `
      <div class="cmdk-row" data-i="${i}" style="display:flex;align-items:center;gap:11px;padding:10px 12px;border-radius:9px;cursor:pointer;${i === sel ? 'background:var(--hover,rgba(255,255,255,.06));' : ''}">
        ${it.avatar ? `<img src="${esc(it.avatar)}" style="width:26px;height:26px;border-radius:50%;">` : `<i class="ti ${it.icon || 'ti-arrow-right'}" style="font-size:17px;width:26px;text-align:center;color:var(--text-secondary);"></i>`}
        <div style="flex:1;min-width:0;"><div style="font-size:14px;">${esc(it.label)}</div>${it.sub ? `<div style="font-size:11px;color:var(--text-muted);">${esc(it.sub)}</div>` : ''}</div>
      </div>`).join('') || '<div style="padding:18px;text-align:center;color:var(--text-muted);font-size:13px;">No matches</div>';
    list.querySelectorAll('.cmdk-row').forEach(r => r.addEventListener('click', () => run(items[+r.dataset.i])));
  }

  // ── Recently visited pages (MRU) ──
  function getRecents() {
    try { return JSON.parse(localStorage.getItem('iacms_recent_pages') || '[]'); } catch (e) { return []; }
  }
  function recordVisit() {
    try {
      const url = location.pathname + location.hash;
      if (!location.pathname || location.pathname === '/' || location.pathname === '/login') return;
      let label = (document.title || '').replace(/^MET\s*[·»|-]\s*/i, '').trim() || location.pathname;
      let list = getRecents().filter(r => r.url !== url);
      list.unshift({ label, url, icon: 'ti-history' });
      list = list.slice(0, 5);
      localStorage.setItem('iacms_recent_pages', JSON.stringify(list));
    } catch (e) { /* ignore */ }
  }

  // Fuzzy subsequence scorer: higher = better, -1 = no match. A contiguous
  // substring beats a scattered subsequence; word-start hits score higher.
  function fuzzyScore(q, text) {
    if (!q) return 0;
    q = q.toLowerCase(); text = String(text || '').toLowerCase();
    const idx = text.indexOf(q);
    if (idx >= 0) return 1000 - idx - text.length * 0.1;   // contiguous wins big
    let ti = 0, score = 0, run = 0, prev = -2;
    for (let qi = 0; qi < q.length; qi++) {
      let found = -1;
      for (; ti < text.length; ti++) { if (text[ti] === q[qi]) { found = ti; break; } }
      if (found < 0) return -1;
      run = (found === prev + 1) ? run + 1 : 0;
      const boundary = found === 0 || /[\s\-_/·]/.test(text[found - 1] || '');
      score += 10 + run * 5 + (boundary ? 8 : 0);
      prev = found; ti = found + 1;
    }
    return score;
  }

  // The current dashboard's own sidebar pages — so the palette can jump between
  // sections of the page you're on (uses each dashboard's own nav handler).
  function pageItems() {
    const badge = document.getElementById('met-division-badge');
    const div = (badge && badge.textContent.trim()) || '';
    return [].slice.call(document.querySelectorAll('.sidebar-nav .nav-item[data-page]'))
      .filter(b => b.offsetParent !== null)   // skip hidden (role-gated) items
      .map(b => {
        const span = b.querySelector('span:not(.nav-badge):not(.nav-tag)');
        const iconEl = b.querySelector('.nav-icon');
        const icon = iconEl ? ([].slice.call(iconEl.classList).find(c => /^ti-/.test(c)) || 'ti-arrow-right') : 'ti-arrow-right';
        return { label: (span ? span.textContent : b.textContent).trim(), sub: (div ? div + ' · ' : '') + 'Page',
                 icon, page: b.dataset.page, pathname: location.pathname };
      });
  }

  function baseItems(q) {
    // With no query, surface recent pages first (skipping the page we're on),
    // then the destination/action list. Pages are only merged in when searching,
    // so the empty view stays short.
    if (!q) {
      const here = location.pathname + location.hash;
      const recents = getRecents()
        .filter(r => r.url !== here)
        .map(r => ({ label: r.label, sub: 'Recent', icon: 'ti-history', url: r.url }));
      const recentUrls = new Set(recents.map(r => r.url));
      return recents.concat(NAV.filter(n => !n.url || !recentUrls.has(n.url)));
    }
    // Fuzzy-rank NAV + the current dashboard's pages together.
    return NAV.concat(pageItems())
      .map(it => ({ it, s: fuzzyScore(q, it.label) }))
      .filter(x => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map(x => x.it);
  }
  function onType() {
    const q = input.value.trim();
    items = baseItems(q); sel = 0; render();
    // Officer search (works if the HICOMM API is reachable; silently ignored otherwise).
    if (q.length >= 2) {
      clearTimeout(officerTimer);
      officerTimer = setTimeout(async () => {
        try {
          const rows = await fetch('/api/hicomm/officer/search?q=' + encodeURIComponent(q), { headers: { 'x-support-fp': '' } }).then(r => r.ok ? r.json() : []);
          if (input.value.trim() !== q) return;
          const off = rows.map(u => ({ label: u.name, sub: `@${u.discordUsername || ''} · ${u.role || ''} — open 360°`, avatar: u.avatar, url: `/hicomm/dashboard#officer:${u.id}`, officerId: u.id }));
          items = baseItems(q).concat(off); render();
        } catch (e) { /* not HICOMM → nav only */ }
      }, 220);
    }
  }
  function onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, items.length - 1); render(); scroll(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); render(); scroll(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (items[sel]) run(items[sel]); }
    else if (e.key === 'Escape') close();
  }
  function scroll() { const r = list.querySelector(`[data-i="${sel}"]`); if (r) r.scrollIntoView({ block: 'nearest' }); }
  function run(it) {
    if (!it) return;
    close();
    if (it.action) return it.action();
    // A page within a dashboard: switch in place if we're already on it (reusing
    // the dashboard's own nav handler), otherwise deep-link via ?page=.
    if (it.page) {
      if (it.pathname === location.pathname) {
        const btn = document.querySelector('.sidebar-nav .nav-item[data-page="' + it.page + '"]');
        if (btn) { btn.click(); btn.scrollIntoView({ block: 'nearest' }); return; }
      }
      location.href = it.pathname + '?page=' + encodeURIComponent(it.page);
      return;
    }
    if (it.officerId && /\/hicomm\/dashboard/.test(location.pathname)) {
      // Already on HICOMM → open the officer inline.
      if (typeof window.hcOfficer === 'function') {
        document.querySelector('.nav-item[data-page="officer"]').click();
        setTimeout(() => window.hcOfficer(it.officerId), 60);
        return;
      }
    }
    if (it.url) location.href = it.url;
  }

  // Deep-link bootstrap: /<dash>?page=<key> activates that sidebar page on load
  // (used by cross-dashboard palette jumps). Clicks the nav item so the
  // dashboard's own switch logic runs; harmless if the dashboard already handles it.
  function pageBootstrap() {
    try {
      const p = new URLSearchParams(location.search).get('page');
      if (!p) return;
      const btn = document.querySelector('.sidebar-nav .nav-item[data-page="' + p + '"]');
      if (btn && !btn.classList.contains('active')) { btn.click(); btn.scrollIntoView({ block: 'nearest' }); }
    } catch (e) { /* ignore */ }
  }
  if (document.readyState === 'complete') setTimeout(pageBootstrap, 150);
  else window.addEventListener('load', () => setTimeout(pageBootstrap, 150));

  // Keyboard: "g" then 1-9 jumps to the Nth sidebar page (Linear/Discord style).
  let gArmed = false, gTimer = null;
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (typing || open || e.metaKey || e.ctrlKey || e.altKey) { gArmed = false; return; }
    if (e.key === 'g' || e.key === 'G') { gArmed = true; clearTimeout(gTimer); gTimer = setTimeout(() => { gArmed = false; }, 900); return; }
    if (gArmed && /^[1-9]$/.test(e.key)) {
      gArmed = false;
      const pages = document.querySelectorAll('.sidebar-nav .nav-item[data-page]');
      const btn = pages[parseInt(e.key, 10) - 1];
      if (btn) { e.preventDefault(); btn.click(); btn.scrollIntoView({ block: 'nearest' }); }
      return;
    }
    gArmed = false;
  });
  function openPalette() { build(); open = true; el.style.display = 'flex'; items = baseItems(''); sel = 0; render(); input.value = ''; setTimeout(() => input.focus(), 30); }
  function close() { open = false; if (el) el.style.display = 'none'; }

  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); open ? close() : openPalette(); }
  });
  window.openCommandPalette = openPalette;

  // Remember this page so it can appear under "Recent" next time.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', recordVisit);
  else recordVisit();
})();
