/* command-palette.js — site-wide ⌘K / Ctrl-K quick launcher.
   Jumps between divisions/pages and (for HICOMM/dev) searches officers.
   Self-contained; include on any dashboard after ui.js. */
(function () {
  const esc = window.escapeHtml || (s => String(s == null ? '' : s));
  let el, input, list, open = false, items = [], sel = 0, officerTimer = null;

  const NAV = [
    { label: 'My Profile', icon: 'ti-user', url: '/profile' },
    { label: 'Support Desk', icon: 'ti-lifebuoy', url: '/support' },
    { label: 'MET High Command', icon: 'ti-shield-star', url: '/hicomm/dashboard' },
    { label: 'HPC Dashboard', icon: 'ti-school', url: '/hpc/dashboard' },
    { label: 'CID Dashboard', icon: 'ti-fingerprint', url: '/cid/dashboard' },
    { label: 'SCO-19 Dashboard', icon: 'ti-target', url: '/sco19/dashboard' },
    { label: 'FLP Dashboard', icon: 'ti-shield', url: '/flp/dashboard' },
    { label: 'IA Dashboard', icon: 'ti-scale', url: '/ia/dashboard' },
    { label: 'Toggle theme', icon: 'ti-moon', action: () => {
        const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', cur); try { localStorage.setItem('iacms_theme', cur); } catch (e) {}
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
        <input id="cmdk-input" placeholder="Jump to… or search an officer" style="flex:1;background:none;border:none;outline:none;color:var(--text-primary,#fff);font-size:15px;" />
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

  function baseItems(q) {
    const nav = NAV.filter(n => !q || n.label.toLowerCase().includes(q.toLowerCase()));
    return nav;
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
  function openPalette() { build(); open = true; el.style.display = 'flex'; items = baseItems(''); sel = 0; render(); input.value = ''; setTimeout(() => input.focus(), 30); }
  function close() { open = false; if (el) el.style.display = 'none'; }

  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); open ? close() : openPalette(); }
  });
  window.openCommandPalette = openPalette;
})();
