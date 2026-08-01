// client/public/js/command-palette.js
// Global ⌘K / Ctrl-K command palette. Self-contained: injects its own styles +
// overlay, builds a command list from the signed-in user's divisions and role,
// and fuzzy-filters as you type. Plain fetch — no dependency on ui.js.
(function () {
  if (window.__metPaletteLoaded) return;
  window.__metPaletteLoaded = true;

  var DIV_LABEL = { CID: 'CID', SCO19: 'SCO-19', IA: 'Internal Affairs', FLP: 'FLP', HPC: 'HPC' };
  var commands = [];
  var built = false;
  var overlay, input, list, activeIndex = 0, filtered = [];

  function isMac() { return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent); }

  function injectStyles() {
    var css = '' +
      '.cmdk-overlay{position:fixed;inset:0;z-index:9999;display:none;align-items:flex-start;justify-content:center;background:rgba(4,6,12,.6);backdrop-filter:blur(4px);padding-top:12vh}' +
      '.cmdk-overlay.open{display:flex}' +
      '.cmdk-box{width:min(600px,92vw);background:var(--panel,#12151d);border:1px solid var(--border,#252a36);border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.5);overflow:hidden;animation:cmdk-in .12s ease}' +
      '@keyframes cmdk-in{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}' +
      '.cmdk-input{width:100%;box-sizing:border-box;border:0;outline:0;background:transparent;color:var(--text,#e6e9ef);font-size:16px;padding:18px 20px;border-bottom:1px solid var(--border-dim,#1c2029)}' +
      '.cmdk-input::placeholder{color:var(--text-muted,#7c8598)}' +
      '.cmdk-list{max-height:52vh;overflow-y:auto;padding:8px}' +
      '.cmdk-item{display:flex;align-items:center;gap:12px;padding:11px 14px;border-radius:9px;cursor:pointer;color:var(--text,#e6e9ef);font-size:14px}' +
      '.cmdk-item .ti{font-size:18px;color:var(--text-muted,#7c8598);width:20px;text-align:center}' +
      '.cmdk-item .cmdk-sub{margin-left:auto;font-size:11px;color:var(--text-muted,#7c8598)}' +
      '.cmdk-item.active,.cmdk-item:hover{background:var(--accent-dim,rgba(74,143,255,.14))}' +
      '.cmdk-item.active .ti{color:var(--accent,#4a8fff)}' +
      '.cmdk-empty{padding:26px;text-align:center;color:var(--text-muted,#7c8598);font-size:13px}' +
      '.cmdk-hint{display:flex;gap:14px;padding:9px 16px;border-top:1px solid var(--border-dim,#1c2029);font-size:11px;color:var(--text-muted,#7c8598)}' +
      '.cmdk-hint kbd{background:var(--border-dim,#1c2029);border-radius:4px;padding:1px 6px;font-family:inherit}';
    var s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
  }

  function buildDom() {
    injectStyles();
    overlay = document.createElement('div');
    overlay.className = 'cmdk-overlay';
    overlay.innerHTML =
      '<div class="cmdk-box" role="dialog" aria-modal="true">' +
        '<input class="cmdk-input" type="text" placeholder="Search pages and actions…" autocomplete="off" spellcheck="false" />' +
        '<div class="cmdk-list"></div>' +
        '<div class="cmdk-hint"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span></div>' +
      '</div>';
    document.body.appendChild(overlay);
    input = overlay.querySelector('.cmdk-input');
    list  = overlay.querySelector('.cmdk-list');

    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    input.addEventListener('input', function () { activeIndex = 0; render(); });
    input.addEventListener('keydown', onKey);
  }

  function navCmd(label, href, icon, sub) {
    return { label: label, icon: icon || 'ti-arrow-right', sub: sub || '', run: function () { window.location.href = href; } };
  }

  // A command that switches tab inside the IA dashboard instead of navigating.
  function pageCmd(label, page, icon, sub) {
    return { label: label, icon: icon || 'ti-arrow-right', sub: sub || 'Internal Affairs',
             run: function () { window.navigateTo(page); } };
  }

  async function buildCommands() {
    commands = [
      navCmd('My Dashboard', '/dashboard', 'ti-layout-dashboard'),
      navCmd('My Profile', '/profile', 'ti-user'),
    ];

    // When we're inside the IA dashboard, every tab and the primary actions
    // become palette commands — that's the fastest way around the site.
    if (typeof window.navigateTo === 'function') {
      commands.push(
        pageCmd('Overview',        'dashboard',   'ti-layout-dashboard'),
        pageCmd('My Cases',        'my-cases',    'ti-folder'),
        pageCmd('All Cases',       'all-cases',   'ti-database'),
        pageCmd('Review Queue',    'review',      'ti-clipboard-check'),
        pageCmd('Records lookup',  'records',     'ti-id-badge-2'),
        pageCmd('Case Documents',  'case-docs',   'ti-file-text'),
        pageCmd('My Tickets',      'tickets',     'ti-ticket'),
        pageCmd('All Tickets',     'all-tickets', 'ti-tags'),
        pageCmd('Media',           'media',       'ti-photo-video'),
        pageCmd('Quota & Database','quota-check', 'ti-checklist'),
        pageCmd('Audit Log',       'audit',       'ti-list-details'),
        { label: 'Submit a case', icon: 'ti-plus', sub: 'Action',
          run: function () { if (typeof window.openNewCaseModal === 'function') window.openNewCaseModal(); } },
        { label: 'New case document', icon: 'ti-file-plus', sub: 'Action',
          run: function () { if (window.CaseDoc) window.CaseDoc.openBuilder({}); } },
      );
    }

    try {
      var me = await fetch('/api/me', { credentials: 'include' }).then(function (r) { return r.ok ? r.json() : null; });
      var divs = await fetch('/api/me/divisions', { credentials: 'include' }).then(function (r) { return r.ok ? r.json() : null; });
      if (divs && divs.mine) {
        divs.mine.forEach(function (d) {
          commands.push(navCmd(DIV_LABEL[d.division] || d.name, '/' + d.slug + '/dashboard', 'ti-shield-half', 'Division'));
        });
      }
      // Role-gated shortcuts.
      if (me && ['HICOMM', 'SUPERVISOR', 'DEVELOPER'].indexOf(me.role) !== -1) {
        commands.push(navCmd('Internal Affairs — Cases', '/ia/dashboard', 'ti-folder', 'IA'));
      }
      if (me && me.role === 'DEVELOPER') {
        commands.push(navCmd('Admin — Users', '/ia/dashboard#admin', 'ti-settings', 'Developer'));
      }
    } catch (e) { /* build a minimal palette if the API is unreachable */ }

    commands.push({
      label: 'Sign out', icon: 'ti-logout', sub: '', run: function () {
        var f = document.createElement('form'); f.method = 'POST'; f.action = '/auth/logout';
        document.body.appendChild(f); f.submit();
      },
    });
    built = true;
  }

  function score(cmd, q) {
    var hay = (cmd.label + ' ' + cmd.sub).toLowerCase();
    if (!q) return 1;
    if (hay.indexOf(q) !== -1) return 2;
    // subsequence match
    var qi = 0;
    for (var i = 0; i < hay.length && qi < q.length; i++) if (hay[i] === q[qi]) qi++;
    return qi === q.length ? 1 : 0;
  }

  function render() {
    var q = input.value.trim().toLowerCase();
    filtered = commands
      .map(function (c) { return { c: c, s: score(c, q) }; })
      .filter(function (x) { return x.s > 0; })
      .sort(function (a, b) { return b.s - a.s; })
      .map(function (x) { return x.c; });

    if (!filtered.length) { list.innerHTML = '<div class="cmdk-empty">No matches.</div>'; return; }
    if (activeIndex >= filtered.length) activeIndex = filtered.length - 1;

    list.innerHTML = filtered.map(function (c, i) {
      return '<div class="cmdk-item' + (i === activeIndex ? ' active' : '') + '" data-i="' + i + '">' +
        '<i class="ti ' + c.icon + '"></i><span>' + escapeHtml(c.label) + '</span>' +
        (c.sub ? '<span class="cmdk-sub">' + escapeHtml(c.sub) + '</span>' : '') + '</div>';
    }).join('');

    Array.prototype.forEach.call(list.querySelectorAll('.cmdk-item'), function (el) {
      el.addEventListener('click', function () { runIndex(parseInt(el.getAttribute('data-i'), 10)); });
    });
  }

  function runIndex(i) {
    var c = filtered[i];
    if (c) { close(); c.run(); }
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); activeIndex = Math.min(activeIndex + 1, filtered.length - 1); render(); scrollActive(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); activeIndex = Math.max(activeIndex - 1, 0); render(); scrollActive(); }
    else if (e.key === 'Enter') { e.preventDefault(); runIndex(activeIndex); }
  }

  function scrollActive() {
    var el = list.querySelector('.cmdk-item.active');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }

  async function open() {
    if (!overlay) buildDom();
    if (!built) { input.value = ''; list.innerHTML = '<div class="cmdk-empty">Loading…</div>'; overlay.classList.add('open'); await buildCommands(); }
    overlay.classList.add('open');
    input.value = ''; activeIndex = 0; render();
    setTimeout(function () { input.focus(); }, 0);
  }

  function close() { if (overlay) overlay.classList.remove('open'); }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  document.addEventListener('keydown', function (e) {
    var mod = isMac() ? e.metaKey : e.ctrlKey;
    if (mod && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (overlay && overlay.classList.contains('open')) close(); else open();
    }
  });

  // Expose for an optional on-screen trigger button.
  window.openCommandPalette = open;
})();
