// client/public/js/panel-collapse.js
// A minimise button on every panel, site-wide.
//
// Some pages are very long — the quota tables, the activity lists, the group
// rosters — and scrolling past a section you are not working on to reach the
// one you are is the single most common complaint about a dense dashboard.
//
// This adds nothing to the markup: it walks every `.panel` that has a header
// and a body on page load (and again whenever new panels appear), and injects
// one button. Collapsing hides everything after the header. Nothing else about
// the panel changes, so a collapsed panel with a live table keeps its data —
// re-opening it is instant and does not re-fetch.
//
// What is collapsed is remembered per page in localStorage, keyed by the
// panel's own id or its title, so a section you always keep shut stays shut.
(function () {
  'use strict';

  var KEY = 'met_collapsed_panels';
  var state = {};
  try { state = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { state = {}; }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* private mode */ }
  }

  // A stable name for the panel. Its id when it has one (ids are authored and
  // don't move); otherwise the page path plus the header text, which is stable
  // enough and never collides across pages.
  function keyFor(panel, header) {
    if (panel.id) return panel.id;
    var t = header.querySelector('.panel-title');
    var label = (t ? t.textContent : '').replace(/\s+/g, ' ').trim();
    return location.pathname + '::' + label;
  }

  function bodyOf(panel, header) {
    var out = [];
    for (var el = header.nextElementSibling; el; el = el.nextElementSibling) out.push(el);
    return out;
  }

  function apply(panel, header, collapsed) {
    bodyOf(panel, header).forEach(function (el) {
      if (collapsed) {
        // Remember what it was, so a panel that was deliberately hidden stays
        // hidden when the panel is re-opened.
        if (el.dataset.pcPrev === undefined) el.dataset.pcPrev = el.style.display || '';
        el.style.display = 'none';
      } else if (el.dataset.pcPrev !== undefined) {
        el.style.display = el.dataset.pcPrev;
        delete el.dataset.pcPrev;
      }
    });
    panel.classList.toggle('panel-collapsed', !!collapsed);
  }

  function decorate(panel) {
    if (panel.dataset.pcReady) return;
    var header = panel.querySelector(':scope > .panel-header');
    if (!header) return;
    // Nothing to collapse.
    if (!header.nextElementSibling) return;
    panel.dataset.pcReady = '1';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'panel-collapse-btn';
    btn.setAttribute('aria-label', 'Minimise this section');
    btn.innerHTML = '<i class="ti ti-chevron-up"></i>';

    var key = keyFor(panel, header);
    var collapsed = !!state[key];
    if (collapsed) apply(panel, header, true);
    btn.setAttribute('aria-expanded', String(!collapsed));

    btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      collapsed = !collapsed;
      apply(panel, header, collapsed);
      btn.setAttribute('aria-expanded', String(!collapsed));
      btn.setAttribute('aria-label', collapsed ? 'Expand this section' : 'Minimise this section');
      if (collapsed) state[key] = 1; else delete state[key];
      save();
    });

    header.appendChild(btn);
  }

  function scan() {
    document.querySelectorAll('.panel').forEach(decorate);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan);
  else scan();

  // Panels are rendered by script on most pages, so watch for new ones. A
  // debounced rescan is far cheaper than decorating on every mutation.
  var timer;
  try {
    new MutationObserver(function () {
      clearTimeout(timer);
      timer = setTimeout(scan, 120);
    }).observe(document.body, { childList: true, subtree: true });
  } catch (e) { /* no observer — the initial scan still covers static pages */ }

  window.MetPanelCollapse = { scan: scan, collapseAll: function (v) {
    document.querySelectorAll('.panel').forEach(function (p) {
      var h = p.querySelector(':scope > .panel-header');
      if (!h) return;
      var b = h.querySelector('.panel-collapse-btn');
      var isOpen = !p.classList.contains('panel-collapsed');
      if (b && isOpen === !!v) b.click();
    });
  } };
})();
