// client/public/js/events-client.js
// Subscribes to the server's live event stream (SSE) for instant in-page
// updates. Degrades silently where SSE isn't available (e.g. serverless);
// Web Push still delivers these events out-of-page.
(function () {
  if (window.__metEventsLoaded || typeof window.EventSource === 'undefined') return;
  window.__metEventsLoaded = true;

  function toast(msg, kind) {
    if (typeof window.showToast === 'function') window.showToast(msg, kind || 'info');
  }
  function call(fn) { try { if (typeof window[fn] === 'function') window[fn](); } catch (e) {} }

  // ── Alert chime (WebAudio, no asset) — a loud, urgent rising alarm ────
  var _actx = null, _primed = false;
  function ensureAudio() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      if (!_actx) _actx = new AC();
      if (_actx.state === 'suspended') _actx.resume().catch(function () {});
      // Prime with a one-sample silent buffer on the first gesture so the context
      // stays unlocked (esp. iOS/Safari) for later background chimes.
      if (!_primed && _actx.state === 'running') {
        try {
          var b = _actx.createBuffer(1, 1, 22050), s = _actx.createBufferSource();
          s.buffer = b; s.connect(_actx.destination); s.start(0); _primed = true;
        } catch (e) {}
      }
      return _actx;
    } catch (e) { return null; }
  }
  // Unlock the audio context on the first user gesture, so the alert can still
  // sound later even when this tab is in the background (browsers only allow
  // audio once the context has been resumed under a user gesture). We listen to
  // a broad set of gestures and re-arm when the tab regains focus, so once the
  // investigator has interacted with the dashboard at all, alerts always chime.
  ['pointerdown', 'mousedown', 'click', 'keydown', 'touchstart'].forEach(function (ev) {
    window.addEventListener(ev, ensureAudio, { passive: true });
  });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) ensureAudio(); });
  function chime() {
    var ctx = ensureAudio(); if (!ctx) return;
    var now = ctx.currentTime;
    function beep(freq, at) {
      try {
        var o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'triangle'; o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, now + at);
        g.gain.exponentialRampToValueAtTime(0.7, now + at + 0.02); // loud
        g.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.26);
        o.connect(g); g.connect(ctx.destination);
        o.start(now + at); o.stop(now + at + 0.28);
      } catch (e) {}
    }
    // Two urgent rising triads (attention-grabbing).
    [0, 0.62].forEach(function (base) { beep(880, base); beep(1175, base + 0.13); beep(1568, base + 0.26); });
  }

  // ── On-screen "new ticket, ready to claim" popup with a big claim CTA ──
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  var _popupWrap = null, _seen = {};
  function ensureWrap() {
    if (_popupWrap) return _popupWrap;
    _popupWrap = document.createElement('div');
    _popupWrap.id = 'met-ticket-alerts';
    _popupWrap.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483000;display:flex;flex-direction:column;gap:10px;max-width:360px;';
    document.body.appendChild(_popupWrap);
    if (!document.getElementById('met-ticket-alert-css')) {
      var st = document.createElement('style'); st.id = 'met-ticket-alert-css';
      st.textContent = '@keyframes metAlertIn{from{opacity:0;transform:translateY(-8px) scale(.98)}to{opacity:1;transform:none}}'
        + '.met-alert{animation:metAlertIn .22s ease both;background:var(--surface-1,#111722);border:1px solid var(--blue,#4a8fff);border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.5),0 0 0 1px rgba(74,143,255,.25);padding:14px 14px 12px;color:var(--text-primary,#e8edf5);}'
        + '.met-alert .ma-top{display:flex;align-items:center;gap:8px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--blue,#4a8fff);font-weight:700;margin-bottom:8px;}'
        + '.met-alert .ma-x{margin-left:auto;cursor:pointer;color:var(--text-muted,#8b93a1);background:none;border:none;font-size:16px;line-height:1;padding:2px;}'
        + '.met-alert .ma-title{font-weight:700;font-size:14px;}'
        + '.met-alert .ma-sub{font-size:12px;color:var(--text-muted,#8b93a1);margin-top:2px;}'
        + '.met-alert .ma-prev{font-size:12px;color:var(--text-secondary,#aeb6c2);margin-top:8px;max-height:54px;overflow:hidden;line-height:1.45;}'
        + '.met-alert .ma-actions{display:flex;gap:8px;margin-top:12px;}'
        + '.met-alert .ma-btn,.met-alert .ma-go{display:flex;align-items:center;justify-content:center;gap:6px;flex:1;padding:11px 12px;border-radius:10px;font-weight:700;font-size:13px;cursor:pointer;transition:filter .15s ease,transform .05s ease;border:1px solid transparent;}'
        + '.met-alert .ma-btn{background:var(--blue,#4a8fff);color:#fff;border:none;}'
        + '.met-alert .ma-go{background:transparent;color:var(--text-primary,#e8edf5);border:1px solid var(--border,#3a4150);}'
        + '.met-alert .ma-btn:hover,.met-alert .ma-go:hover{filter:brightness(1.1);} .met-alert .ma-btn:active,.met-alert .ma-go:active{transform:translateY(1px);}';
      document.head.appendChild(st);
    }
    return _popupWrap;
  }
  function showTicketAlert(d) {
    if (!d || !d.ticketId || _seen[d.ticketId]) return;   // de-dupe repeat events
    _seen[d.ticketId] = true;
    var wrap = ensureWrap();
    var card = document.createElement('div');
    card.className = 'met-alert';
    var idEnc = encodeURIComponent(d.ticketId);
    var viewUrl  = '/ia/dashboard?supportTicket=' + idEnc;
    var claimUrl = '/ia/dashboard?supportTicket=' + idEnc + '&claim=1';
    card.innerHTML =
      '<div class="ma-top"><i class="ti ti-bell-ringing"></i> New ticket &middot; Internal Affairs'
        + '<button class="ma-x" title="Dismiss">&times;</button></div>'
      + '<div class="ma-title">' + esc(d.typeLabel || 'Support ticket') + '</div>'
      + '<div class="ma-sub">Opened by ' + esc(d.openerName || 'a member') + ' &middot; ready to claim</div>'
      + (d.preview ? '<div class="ma-prev">' + esc(d.preview) + '</div>' : '')
      + '<div class="ma-actions">'
      +   '<button class="ma-btn"><i class="ti ti-hand-stop"></i> Claim ticket</button>'
      +   '<button class="ma-go"><i class="ti ti-arrow-right"></i> Go to ticket</button>'
      + '</div>';
    var remove = function () { try { card.remove(); } catch (e) {} };
    card.querySelector('.ma-x').addEventListener('click', remove);
    // Claim ticket → open + auto-claim in place on the desk; else deep-link + claim.
    card.querySelector('.ma-btn').addEventListener('click', function () {
      if (typeof window.sdOpenAndClaim === 'function') { window.sdOpenAndClaim(d.ticketId); remove(); }
      else window.location.href = claimUrl;
    });
    // Go to ticket → just open it (no auto-claim).
    card.querySelector('.ma-go').addEventListener('click', function () {
      if (typeof window.sdOpen === 'function') { window.sdOpen(d.ticketId); remove(); }
      else window.location.href = viewUrl;
    });
    wrap.appendChild(card);
    chime();
    setTimeout(remove, 60000); // stays a full minute; the web push is the durable copy
  }
  window.metShowTicketAlert = showTicketAlert;

  function connect() {
    var es;
    try { es = new EventSource('/api/events', { withCredentials: true }); }
    catch (e) { return; }

    es.addEventListener('exam_marked', function (ev) {
      var d = parse(ev);
      toast(d.message || 'Your exam has been marked.', d.status === 'PASSED' ? 'success' : 'info');
      call('loadExamStatus');   // profile page — refresh the exam panel if present
    });

    es.addEventListener('tryout_live', function (ev) {
      var d = parse(ev);
      toast(d.message || 'A MET tryout is now live!', 'info');
      call('loadTryouts');      // profile page — refresh the tryouts panel if present
    });

    // A support ticket just became ready to claim — staff only (the server
    // targets eligible handlers). Chime + on-screen popup with a claim button.
    es.addEventListener('support_open', function (ev) {
      showTicketAlert(parse(ev));
      call('refreshQueue');     // support desk — refresh the queue if open
      call('loadSupportBadge'); // topbar unclaimed counter, if present
    });

    es.addEventListener('notification', function (ev) {
      var d = parse(ev);
      if (d.message) toast(d.message, d.kind || 'info');
    });

    // Browser auto-reconnects on error; nothing to do. If the server is gone the
    // stream just stays closed — page still works.
    es.onerror = function () { /* let EventSource handle backoff */ };
  }

  function parse(ev) { try { return JSON.parse(ev.data || '{}'); } catch (e) { return {}; } }

  // Only connect for signed-in pages (those load ui.js / topbar). Delay slightly
  // so it never competes with first paint.
  if (document.readyState === 'complete') setTimeout(connect, 400);
  else window.addEventListener('load', function () { setTimeout(connect, 400); });
})();
