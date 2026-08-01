// client/public/js/emoji.js
// The site half of the MET emoji set.
//
// Discord gets the same artwork uploaded as guild emoji (server/lib/emoji.js);
// the site just points an <img> at the committed PNG, so a tick in a Discord
// embed and a tick on the dashboard are the same mark.
//
//   met.e('met_tick')                  → '<img class="met-emoji" …>'
//   met.e('met_tick', { size: 20 })    → the same at a fixed pixel size
//   met.url('met_tick')                → '/img/emoji/met_tick.png'
//
// Anything already drawn with a Tabler icon stays a Tabler icon — this is only
// for the places that used a stock unicode emoji.
//
// If a PNG is missing the <img> swaps itself for the unicode character it
// replaced (from the generated emoji-map.js), so nothing renders as a broken
// image box.
(function () {
  'use strict';

  var FALLBACK = window.MET_EMOJI_FALLBACK || {};

  function url(name) { return '/img/emoji/' + String(name).replace(/[^a-z0-9_]/gi, '') + '.png'; }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Returns an HTML string, because nearly every caller here builds markup with
  // template literals rather than DOM nodes.
  function e(name, opts) {
    opts = opts || {};
    var fb  = FALLBACK[name] || '';
    var cls = 'met-emoji' + (opts.className ? ' ' + opts.className : '');
    var style = opts.size ? ' style="width:' + (+opts.size) + 'px;height:' + (+opts.size) + 'px"' : '';
    // The onerror handler replaces the whole <img> with the unicode character,
    // so a name typo or a missing build degrades instead of breaking.
    return '<img class="' + esc(cls) + '"' + style
      + ' src="' + esc(url(name)) + '"'
      + ' alt="' + esc(opts.alt != null ? opts.alt : fb) + '"'
      + ' title="' + esc(opts.title || '') + '"'
      + ' draggable="false"'
      + ' onerror="this.outerHTML=' + esc(JSON.stringify(fb)) + '">';
  }

  // Real DOM node, for the handful of callers that build elements directly.
  function node(name, opts) {
    var wrap = document.createElement('span');
    wrap.innerHTML = e(name, opts);
    return wrap.firstChild;
  }

  window.met = window.met || {};
  window.met.e   = e;
  window.met.url = url;
  window.met.node = node;
  window.metEmoji = e;   // short alias, used inside template literals
})();
