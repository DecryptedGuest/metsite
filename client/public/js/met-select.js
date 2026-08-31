/* ==========================================================================
   met-select · a custom dropdown for every <select> on the site
   ==========================================================================
   The native control cannot be styled: the browser draws its popup itself,
   on a white ground, so light option text on this interface's dark surfaces
   disappeared entirely. This replaces the popup with one we draw.

   It ENHANCES rather than replaces. The real <select> stays in the DOM,
   visually hidden but present, and remains the single source of truth: its
   .value is what is read, its options are what is listed, and picking an
   option sets that value and dispatches real input and change events. So
   every `onchange="fn(this.value)"` attribute, every addEventListener, every
   `sel.value = x` and every form submission keeps working untouched.

   Options are filled in later by fetches all over this site, so the list is
   rebuilt from a MutationObserver rather than read once at load. */
(function () {
  'use strict';
  if (window.__metSelect) return;
  window.__metSelect = true;

  var openOne = null;                 // only one list is ever open
  var layer = null;                   // the fixed layer every list is drawn in

  function getLayer() {
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'msel-layer';
      document.body.appendChild(layer);
    }
    return layer;
  }

  function labelOf(sel) {
    var o = sel.options[sel.selectedIndex];
    return o ? (o.textContent || '').trim() : '';
  }

  function enhance(sel) {
    if (sel.__msel || sel.multiple || sel.size > 1) return;
    if (sel.closest && sel.closest('.msel')) return;
    sel.__msel = true;

    var wrap = document.createElement('div');
    wrap.className = 'msel';
    // Carry the select's own width so a `style="width:auto"` or a grid cell
    // still lays out exactly as it did.
    if (sel.style.width) wrap.style.width = sel.style.width;

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'msel-btn' + (sel.className ? ' ' + sel.className : '');
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    if (sel.id) btn.setAttribute('aria-labelledby', sel.id + '-msel-label');
    btn.innerHTML = '<span class="msel-val"></span><span class="msel-caret" aria-hidden="true"></span>';

    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    wrap.appendChild(btn);
    sel.classList.add('msel-native');
    sel.setAttribute('tabindex', '-1');
    sel.setAttribute('aria-hidden', 'true');

    var list = document.createElement('div');
    list.className = 'msel-list';
    list.setAttribute('role', 'listbox');

    var val = btn.querySelector('.msel-val');

    function syncLabel() {
      var t = labelOf(sel);
      val.textContent = t || '';
      val.classList.toggle('is-empty', !t);
      btn.disabled = sel.disabled;
      btn.classList.toggle('is-disabled', !!sel.disabled);
    }

    function buildList() {
      list.innerHTML = '';
      for (var i = 0; i < sel.options.length; i++) {
        var o = sel.options[i];
        var row = document.createElement('div');
        row.className = 'msel-opt';
        row.setAttribute('role', 'option');
        row.dataset.i = String(i);
        if (o.disabled) row.classList.add('is-disabled');
        if (i === sel.selectedIndex) { row.classList.add('is-on'); row.setAttribute('aria-selected', 'true'); }
        row.textContent = (o.textContent || '').trim();
        list.appendChild(row);
      }
    }

    function place() {
      var r = btn.getBoundingClientRect();
      var vh = window.innerHeight;
      list.style.minWidth = r.width + 'px';
      list.style.left = Math.max(8, Math.min(r.left, window.innerWidth - r.width - 8)) + 'px';
      // Flip above when there is not room below, so a control near the bottom
      // of a long page still shows its options.
      var below = vh - r.bottom - 10, above = r.top - 10;
      var h = Math.min(list.scrollHeight, 320);
      if (below < h && above > below) {
        list.style.top = ''; list.style.bottom = (vh - r.top + 6) + 'px';
        list.style.maxHeight = Math.min(above, 320) + 'px';
      } else {
        list.style.bottom = ''; list.style.top = (r.bottom + 6) + 'px';
        list.style.maxHeight = Math.min(below, 320) + 'px';
      }
    }

    function open() {
      if (sel.disabled) return;
      if (openOne && openOne !== close) openOne();
      buildList();
      getLayer().appendChild(list);
      list.classList.add('is-open');
      btn.setAttribute('aria-expanded', 'true');
      place();
      var on = list.querySelector('.msel-opt.is-on');
      if (on) on.scrollIntoView({ block: 'nearest' });
      openOne = close;
      document.addEventListener('mousedown', outside, true);
      window.addEventListener('scroll', place, true);
      window.addEventListener('resize', place);
    }

    function close() {
      list.classList.remove('is-open');
      if (list.parentNode) list.parentNode.removeChild(list);
      btn.setAttribute('aria-expanded', 'false');
      openOne = null;
      document.removeEventListener('mousedown', outside, true);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    }

    function outside(e) {
      if (!list.contains(e.target) && !btn.contains(e.target)) close();
    }

    function pick(i) {
      var o = sel.options[i];
      if (!o || o.disabled) return;
      if (sel.selectedIndex !== i) {
        sel.selectedIndex = i;
        // Real events on the real element, so inline onchange attributes and
        // every existing listener fire exactly as they did natively.
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
      syncLabel();
      close();
      btn.focus();
    }

    btn.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      list.classList.contains('is-open') ? close() : open();
    });
    list.addEventListener('click', function (e) {
      var row = e.target.closest('.msel-opt');
      if (row) pick(Number(row.dataset.i));
    });

    // Keyboard: the same keys the native control answers to.
    var typed = '', typedAt = 0;
    btn.addEventListener('keydown', function (e) {
      var isOpen = list.classList.contains('is-open');
      var k = e.key;
      if (k === 'Escape') { if (isOpen) { e.preventDefault(); close(); } return; }
      if (k === 'Enter' || k === ' ') {
        e.preventDefault();
        if (!isOpen) return open();
        var cur = list.querySelector('.msel-opt.is-cur') || list.querySelector('.msel-opt.is-on');
        if (cur) pick(Number(cur.dataset.i));
        return;
      }
      if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Home' || k === 'End') {
        e.preventDefault();
        if (!isOpen) return open();
        var rows = [].slice.call(list.querySelectorAll('.msel-opt:not(.is-disabled)'));
        if (!rows.length) return;
        var cur = list.querySelector('.msel-opt.is-cur') || list.querySelector('.msel-opt.is-on');
        var at = rows.indexOf(cur);
        var next = k === 'Home' ? 0
                 : k === 'End' ? rows.length - 1
                 : k === 'ArrowDown' ? Math.min(rows.length - 1, at + 1)
                 : Math.max(0, at <= 0 ? 0 : at - 1);
        rows.forEach(function (r) { r.classList.remove('is-cur'); });
        rows[next].classList.add('is-cur');
        rows[next].scrollIntoView({ block: 'nearest' });
        return;
      }
      if (k.length === 1 && /\S/.test(k)) {
        var now = Date.now();
        typed = (now - typedAt < 900) ? typed + k.toLowerCase() : k.toLowerCase();
        typedAt = now;
        for (var i = 0; i < sel.options.length; i++) {
          var o = sel.options[i];
          if (!o.disabled && (o.textContent || '').trim().toLowerCase().indexOf(typed) === 0) {
            if (isOpen) {
              var rows2 = [].slice.call(list.querySelectorAll('.msel-opt'));
              rows2.forEach(function (r) { r.classList.remove('is-cur'); });
              if (rows2[i]) { rows2[i].classList.add('is-cur'); rows2[i].scrollIntoView({ block: 'nearest' }); }
            } else pick(i);
            break;
          }
        }
      }
    });

    // Options arrive from a fetch on most of these, so watch for them.
    try {
      new MutationObserver(function () {
        syncLabel();
        if (list.classList.contains('is-open')) { buildList(); place(); }
      }).observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
    } catch (e) { /* the label simply will not follow a late fetch */ }

    // Other code sets sel.value directly; a property assignment fires no
    // event and no mutation, so wrap the setter on this instance to keep the
    // button honest.
    try {
      var proto = Object.getPrototypeOf(sel);
      var d = Object.getOwnPropertyDescriptor(proto, 'value')
           || Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
      if (d && d.set) {
        Object.defineProperty(sel, 'value', {
          configurable: true,
          get: function () { return d.get.call(this); },
          set: function (v) { d.set.call(this, v); syncLabel(); }
        });
      }
      var di = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
      if (di && di.set) {
        Object.defineProperty(sel, 'selectedIndex', {
          configurable: true,
          get: function () { return di.get.call(this); },
          set: function (v) { di.set.call(this, v); syncLabel(); }
        });
      }
    } catch (e) { /* fall back to the observer and change events */ }

    sel.addEventListener('change', syncLabel);
    syncLabel();
  }

  function scan(root) {
    (root || document).querySelectorAll('select:not(.msel-native)').forEach(enhance);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { scan(); });
  else scan();

  // Most of this site renders its controls from script after a fetch, so new
  // selects appear long after load. A debounced rescan is far cheaper than
  // enhancing on every mutation.
  var t;
  try {
    new MutationObserver(function () { clearTimeout(t); t = setTimeout(scan, 90); })
      .observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { /* the initial scan still covers static pages */ }

  window.MetSelect = { scan: scan };
})();
