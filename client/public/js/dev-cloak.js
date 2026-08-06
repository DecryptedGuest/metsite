// dev-cloak.js
// A hotkey that makes the developer tools vanish.
//
// The developer tab carries things nobody outside it should even know exist:
// visitor IP addresses, the security centre, the server-control panel, the
// emergency alert. All of that is on screen the moment a developer opens their
// dashboard — which is fine alone at a desk and not fine while screen-sharing,
// streaming, or with somebody stood behind you.
//
// So it starts HIDDEN, every single page load, and one hotkey brings it back.
//
//   Ctrl + Shift + Alt + D      show / hide, instantly
//
// The combination is deliberately awkward: three modifiers cannot be pressed by
// accident, and nothing in the browser or the app claims it. Override it by
// setting `metDevCloakKey` in localStorage to something like "ctrl+alt+k".
//
// ── What this is, and what it is not ──────────────────────────────
// This is a privacy screen, NOT a permission. It hides things from the person
// LOOKING AT THE SCREEN. It does not pretend to hide them from the person using
// the browser: anybody who opens developer tools can read the DOM, and the real
// gate has always been the server, which checks the DEVELOPER role on every one
// of these routes and would refuse them to anybody else regardless of what the
// page is showing. Treating this as a security boundary would be a mistake; it
// is there so a shoulder does not learn what a password would not have given up.
//
// It is deliberately NOT remembered between page loads. "Off by default" is only
// true if a reload turns it off again — otherwise the one time it matters is the
// time you forgot you had left it on.

(function () {
  'use strict';

  // Everything the developer tab owns. Nav items and inline controls carry the
  // classes; the pages are listed by id because a section has no marker of its
  // own and the ids are the stable thing about them.
  var DEV_SELECTORS = [
    '.dev-only',
    '.developer-only',
    '#page-admin', '#page-group', '#page-discord-mod', '#page-server-control',
    '#page-visits', '#page-security', '#page-site-control', '#page-send-notif',
    '#page-emergency-alert', '#page-media-admin', '#page-imports',
    '#page-roblox-audio', '#page-gamelogs', '#page-cad'
  ];

  var STYLE_ID = 'dev-cloak-style';
  var CLOAK_CLASS = 'dev-cloaked';
  var root = document.documentElement;

  // The security centre is a page of nothing but developer tools, so there is no
  // "hide the dev parts" — the whole thing goes.
  function isWholePageDev() {
    return /^\/dev\/security/.test(location.pathname);
  }
  function isDevContext() { return /^\/dev(\/|$)/.test(location.pathname); }

  // ── The stylesheet ──────────────────────────────────────────────
  // Injected the moment this file runs, and the class is on <html> before the
  // body exists, so nothing dev-related is ever painted and then removed. A
  // flash of the thing you are hiding defeats the point of hiding it.
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css =
      'html.' + CLOAK_CLASS + ' ' + DEV_SELECTORS.join(',html.' + CLOAK_CLASS + ' ')
        + '{display:none !important;}'
      // The standalone security page has no non-dev half to fall back to.
      + 'html.' + CLOAK_CLASS + '.dev-cloak-whole body>*{display:none !important;}';
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }

  root.classList.add(CLOAK_CLASS);              // hidden by default, always
  if (isWholePageDev()) root.classList.add('dev-cloak-whole');
  ensureStyle();

  var cloaked = true;

  // ── Restoring the ordinary dashboard underneath ─────────────────
  // On /dev/dashboard the dev context hides the Internal Affairs nav and rebrands
  // the sidebar, so simply hiding the dev nav on top of that would leave an empty
  // sidebar and a page that plainly had something removed from it. Snapshot what
  // the nav looked like BEFORE the dev context rewrote it, and put that back —
  // the result is an ordinary IA dashboard, which is exactly what it should look
  // like to somebody who is not supposed to know there is anything else.
  var navSnapshot = null;
  var brandSnapshot = null;

  function snapshot() {
    navSnapshot = [];
    document.querySelectorAll('.sidebar-nav .nav-item, .sidebar-nav .nav-section-label')
      .forEach(function (el) { navSnapshot.push([el, el.style.display]); });
    var bn = document.querySelector('.brand-name');
    var bs = document.querySelector('.brand-sub');
    brandSnapshot = {
      name: bn ? bn.textContent : null,
      sub:  bs ? bs.textContent : null,
      title: document.title,
    };
  }

  function restoreOrdinary() {
    if (navSnapshot) {
      navSnapshot.forEach(function (pair) { pair[0].style.display = pair[1]; });
    }
    if (brandSnapshot) {
      var bn = document.querySelector('.brand-name');
      var bs = document.querySelector('.brand-sub');
      if (bn && brandSnapshot.name != null) bn.textContent = brandSnapshot.name;
      if (bs && brandSnapshot.sub  != null) bs.textContent = brandSnapshot.sub;
      if (brandSnapshot.title) document.title = brandSnapshot.title;
    }
  }

  // Which pages belong to the developer tab, read off the nav rather than a
  // second hard-coded list that would drift the first time one is added.
  function devPageIds() {
    var ids = [];
    document.querySelectorAll('.nav-item.dev-only[data-page]').forEach(function (b) {
      ids.push(b.dataset.page);
    });
    return ids;
  }

  // Hiding the section a developer is CURRENTLY READING leaves an empty page and
  // an obvious hole, so move them somewhere ordinary first.
  function leaveDevPage() {
    var active = document.querySelector('.page.active');
    if (!active) return;
    var id = active.id ? active.id.replace(/^page-/, '') : '';
    if (!id) return;
    if (devPageIds().indexOf(id) === -1) return;
    if (typeof window.navigateTo === 'function') {
      try { window.navigateTo('dashboard'); } catch (e) { /* the CSS still hides it */ }
    }
  }

  // ── The toggle ──────────────────────────────────────────────────
  function setCloaked(on) {
    cloaked = !!on;
    if (cloaked) {
      root.classList.add(CLOAK_CLASS);
      leaveDevPage();
      if (isDevContext()) restoreOrdinary();
    } else {
      root.classList.remove(CLOAK_CLASS);
      // Put the developer context back exactly as the app builds it.
      if (isDevContext() && typeof window.applyDevContext === 'function') {
        try { window.applyDevContext(); } catch (e) { /* the CSS has already revealed it */ }
      }
    }
  }

  // ── The hotkey ──────────────────────────────────────────────────
  // Parsed from a string so it can be changed without a deploy.
  function parseCombo(s) {
    var parts = String(s || '').toLowerCase().split('+').map(function (x) { return x.trim(); }).filter(Boolean);
    var combo = { ctrl: false, shift: false, alt: false, meta: false, key: null };
    parts.forEach(function (p) {
      if (p === 'ctrl' || p === 'control') combo.ctrl = true;
      else if (p === 'shift') combo.shift = true;
      else if (p === 'alt' || p === 'option') combo.alt = true;
      else if (p === 'meta' || p === 'cmd' || p === 'command') combo.meta = true;
      else combo.key = p;
    });
    return combo.key ? combo : null;
  }

  function currentCombo() {
    var custom = null;
    try { custom = localStorage.getItem('metDevCloakKey'); } catch (e) { custom = null; }
    return parseCombo(custom) || parseCombo('ctrl+shift+alt+d');
  }

  function matches(ev, combo) {
    if (!combo) return false;
    // `code` rather than `key`: Alt rewrites `key` into a symbol on some layouts
    // (Alt+D can arrive as "∂"), and the physical key is what was pressed.
    var k = String(ev.key || '').toLowerCase();
    var code = String(ev.code || '').toLowerCase().replace(/^key/, '').replace(/^digit/, '');
    if (k !== combo.key && code !== combo.key) return false;
    return ev.ctrlKey === combo.ctrl && ev.shiftKey === combo.shift
        && ev.altKey === combo.alt && ev.metaKey === combo.meta;
  }

  window.addEventListener('keydown', function (ev) {
    if (!matches(ev, currentCombo())) return;
    ev.preventDefault();
    ev.stopPropagation();
    setCloaked(!cloaked);
  }, true);   // capture, so nothing downstream can swallow it

  // ── Wiring ──────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', function () {
    // dashboard.js has run by now (its script tag is above this event), so its
    // applyDevContext exists. Wrap it: it is called asynchronously once /api/me
    // resolves, and it would otherwise un-hide the dev nav behind the cloak's
    // back. Snapshotting inside the wrapper is what makes "restore the ordinary
    // dashboard" possible at all — it is the only moment the pre-dev nav state
    // is still on screen.
    var orig = window.applyDevContext;
    if (typeof orig === 'function') {
      window.applyDevContext = function () {
        snapshot();
        var out = orig.apply(this, arguments);
        if (cloaked) restoreOrdinary();
        return out;
      };
    } else {
      snapshot();
    }
  });

  // Deliberately small surface: enough to drive it from the console or a test,
  // nothing that announces itself in the UI.
  window.devCloak = {
    isCloaked: function () { return cloaked; },
    hide:   function () { setCloaked(true); },
    show:   function () { setCloaked(false); },
    toggle: function () { setCloaked(!cloaked); },
    combo:  currentCombo,
    // Tests only.
    __matches: matches, __parseCombo: parseCombo, __devPageIds: devPageIds,
  };
})();
