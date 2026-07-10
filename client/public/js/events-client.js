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
  // ── Do-Not-Disturb / snooze ──────────────────────────────────────────
  // A per-staffer mute (persisted) that silences the chime and the "ready to
  // claim" popups for a while. Directed mention popups still appear (silently).
  function snoozedUntil() { try { return parseInt(localStorage.getItem('metAlertsSnooze') || '0', 10) || 0; } catch (e) { return 0; } }
  function isSnoozed() { return Date.now() < snoozedUntil(); }
  window.metSnoozeAlerts = function (mins) {
    try { localStorage.setItem('metAlertsSnooze', String(Date.now() + Math.max(1, mins || 30) * 60000)); } catch (e) {}
    if (typeof window.showToast === 'function') window.showToast('Ticket alerts muted for ' + (mins || 30) + ' min.', 'info');
  };
  window.metClearSnooze = function () { try { localStorage.removeItem('metAlertsSnooze'); } catch (e) {} };
  window.metAlertsSnoozedUntil = snoozedUntil;

  // ── Sound engine (procedural WebAudio, no assets) ─────────────────────
  // One shared voice table so every event across the site sounds like one
  // system, respects the snooze, and honours a persistent Off/Subtle/Full mode.
  //   rising = arrived / good · falling = closed / negative · single soft = neutral
  //   repeated rising triads = URGENT (a new claimable ticket — the only alarm).
  function soundMode() { try { return localStorage.getItem('metSoundMode') || 'full'; } catch (e) { return 'full'; } }
  window.metSoundMode = soundMode;
  window.metSetSoundMode = function (m) {
    if (['off', 'subtle', 'full'].indexOf(m) < 0) m = 'full';
    try { localStorage.setItem('metSoundMode', m); } catch (e) {}
    if (m !== 'off') { window.metSound('claim_you'); } // little confirmation preview
  };

  // A "voice" is a list of tones: { f:Hz, at:sec-offset, dur:sec, type, gain, detune }.
  var VOICES = {
    // The one loud alarm — a new ticket ready to claim. Two urgent rising triads.
    ticket_new: [880, 1175, 1568].concat([880, 1175, 1568]).map(function (f, i) {
      var base = i < 3 ? 0 : 0.62, k = i % 3;
      return { f: f, at: base + k * 0.13, dur: 0.26, type: 'triangle', gain: 0.7 };
    }),
    // Directed @mention — softer two-note "attention" (988 → 1319).
    mention:   [{ f: 988, at: 0, dur: 0.14, type: 'triangle', gain: 0.34 }, { f: 1319, at: 0.12, dur: 0.16, type: 'triangle', gain: 0.34 }],
    // Incoming message in an open ticket — gentle two-tone rise (523 → 659).
    incoming:  [{ f: 523, at: 0, dur: 0.1, type: 'sine', gain: 0.13 }, { f: 659, at: 0.07, dur: 0.14, type: 'sine', gain: 0.13 }],
    // Your own message sent — short soft downward click (440 → 330).
    sent:      [{ f: 440, at: 0, dur: 0.05, type: 'sine', gain: 0.1 }, { f: 330, at: 0.04, dur: 0.06, type: 'sine', gain: 0.1 }],
    // You claimed a ticket — confirming up-third (587 → 784).
    claim_you: [{ f: 587, at: 0, dur: 0.1, type: 'triangle', gain: 0.3 }, { f: 784, at: 0.09, dur: 0.16, type: 'triangle', gain: 0.3 }],
    // A popup auto-dismissed (claimed by someone else) — tiny neutral tick.
    tick:      [{ f: 880, at: 0, dur: 0.06, type: 'sine', gain: 0.12 }],
    // Ticket closed / resolved — soft falling two-note (659 → 440).
    closed:    [{ f: 659, at: 0, dur: 0.12, type: 'sine', gain: 0.25 }, { f: 440, at: 0.1, dur: 0.18, type: 'sine', gain: 0.25 }],
    // Ticket reopened — rising two-note (440 → 659), the inverse of close.
    reopened:  [{ f: 440, at: 0, dur: 0.12, type: 'sine', gain: 0.25 }, { f: 659, at: 0.1, dur: 0.18, type: 'sine', gain: 0.25 }],
    // Blocked / rate-limited / error — low muted detuned buzz (220 Hz).
    error:     [{ f: 220, at: 0, dur: 0.16, type: 'sawtooth', gain: 0.2 }, { f: 220, at: 0, dur: 0.16, type: 'sawtooth', gain: 0.2, detune: 14 }],
    // Exam PASS — bright rising major arpeggio (523-659-784).
    exam_pass: [{ f: 523, at: 0, dur: 0.14, type: 'triangle', gain: 0.35 }, { f: 659, at: 0.12, dur: 0.14, type: 'triangle', gain: 0.35 }, { f: 784, at: 0.24, dur: 0.22, type: 'triangle', gain: 0.35 }],
    // Exam FAIL — gentle falling minor two-note (523 → 415).
    exam_fail: [{ f: 523, at: 0, dur: 0.14, type: 'sine', gain: 0.25 }, { f: 415, at: 0.13, dur: 0.2, type: 'sine', gain: 0.25 }],
    // Tryout going LIVE — distinct two-note call to action (698 → 880).
    tryout_live: [{ f: 698, at: 0, dur: 0.14, type: 'triangle', gain: 0.3 }, { f: 880, at: 0.13, dur: 0.2, type: 'triangle', gain: 0.3 }],
    // Escalation to HICOMM — single low urgent pulse (330 Hz ×2).
    escalate:  [{ f: 330, at: 0, dur: 0.16, type: 'square', gain: 0.32 }, { f: 330, at: 0.2, dur: 0.16, type: 'square', gain: 0.32 }],
  };

  window.metSound = function (name) {
    var mode = soundMode();
    if (mode === 'off' || isSnoozed()) return;   // muted, or Do-Not-Disturb
    var voice = VOICES[name]; if (!voice) return;
    var ctx = ensureAudio(); if (!ctx) return;
    var mult = mode === 'subtle' ? 0.4 : 1, now = ctx.currentTime;
    voice.forEach(function (s) {
      try {
        var o = ctx.createOscillator(), g = ctx.createGain();
        o.type = s.type || 'sine'; o.frequency.value = s.f; if (s.detune) o.detune.value = s.detune;
        var at = now + (s.at || 0), dur = s.dur || 0.18, peak = Math.max(0.0001, (s.gain || 0.2) * mult);
        g.gain.setValueAtTime(0.0001, at);
        g.gain.exponentialRampToValueAtTime(peak, at + 0.015);
        g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
        o.connect(g); g.connect(ctx.destination);
        o.start(at); o.stop(at + dur + 0.03);
      } catch (e) {}
    });
  };
  // Back-compat: the loud new-ticket alarm.
  function chime() { window.metSound('ticket_new'); }

  // ── Native desktop notifications ──────────────────────────────────────
  // Real OS notifications for ticket events, on top of the in-page popup + sound.
  // Fired only when the tab is BACKGROUNDED (a focused tab already shows the
  // popup), when permission is granted and the staffer hasn't turned them off.
  function desktopMuted() { try { return localStorage.getItem('metDesktopOff') === '1'; } catch (e) { return false; } }
  function desktopNotify(title, body, url) {
    try {
      if (!('Notification' in window) || Notification.permission !== 'granted' || desktopMuted()) return;
      if (!document.hidden) return; // focused → the on-screen popup covers it
      var n = new Notification(title, { body: body || '', tag: 'met-ticket-' + (url || ''), icon: '/img/divisions/met.png', badge: '/img/divisions/met.png', renotify: true });
      n.onclick = function () { try { window.focus(); } catch (e) {} if (url) location.href = url; try { n.close(); } catch (e) {} };
    } catch (e) {}
  }
  window.metDesktopNotify = desktopNotify;
  // Easy enable/disable for staff (used by the prompt + the settings toggle).
  window.metEnableNotifications = async function () {
    try { localStorage.removeItem('metDesktopOff'); } catch (e) {}
    if (window.pushClient && window.pushClient.requestPushPermission) {
      var r = await window.pushClient.requestPushPermission();
      if (typeof window.showToast === 'function') window.showToast(
        r === 'granted' ? 'Desktop notifications enabled.'
        : r === 'denied' ? 'Notifications are blocked — allow them in your browser’s site settings.'
        : 'Notifications aren’t available on this device.',
        r === 'granted' ? 'success' : 'info');
      return r;
    }
    if ('Notification' in window) return await Notification.requestPermission();
    return 'unsupported';
  };
  window.metDisableNotifications = function () {
    try { localStorage.setItem('metDesktopOff', '1'); } catch (e) {}
    if (window.pushClient && window.pushClient.removePushSubscription) window.pushClient.removePushSubscription();
    if (typeof window.showToast === 'function') window.showToast('Desktop notifications turned off.', 'info');
  };
  window.metNotifState = function () {
    return {
      supported: ('Notification' in window),
      permission: ('Notification' in window) ? Notification.permission : 'unsupported',
      muted: desktopMuted(),
    };
  };

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
        + '.met-alert .ma-btn:hover,.met-alert .ma-go:hover{filter:brightness(1.1);} .met-alert .ma-btn:active,.met-alert .ma-go:active{transform:translateY(1px);}'
        + '.met-alert .ma-mute{margin-top:8px;width:100%;background:none;border:none;color:var(--text-muted,#8b93a1);font-size:11px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:5px;padding:4px;} .met-alert .ma-mute:hover{color:var(--text-secondary,#aeb6c2);}';
      document.head.appendChild(st);
    }
    return _popupWrap;
  }
  var _ticketCards = {}; // ticketId -> card element (so it can be auto-dismissed)
  function showTicketAlert(d) {
    if (!d || !d.ticketId || _seen[d.ticketId]) return;   // de-dupe repeat events
    if (isSnoozed()) return;                                // staffer muted alerts
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
      + '</div>'
      + '<button class="ma-mute" title="Mute ticket alerts for 30 minutes"><i class="ti ti-bell-off"></i> Mute 30m</button>';
    var remove = function () { try { card.remove(); } catch (e) {} delete _ticketCards[d.ticketId]; };
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
    card.querySelector('.ma-mute').addEventListener('click', function () { window.metSnoozeAlerts(30); dismissAllTicketAlerts(); });
    wrap.appendChild(card);
    _ticketCards[d.ticketId] = card;
    chime();
    desktopNotify('New ticket · Internal Affairs',
      (d.typeLabel || 'Support ticket') + (d.openerName ? ' — ' + d.openerName : '') + (d.preview ? '\n' + d.preview : ''),
      viewUrl);
    setTimeout(remove, 60000); // stays a full minute; the web push is the durable copy
  }
  window.metShowTicketAlert = showTicketAlert;

  // Dismiss the "ready to claim" popup for one ticket (it was claimed/closed by
  // someone else) — or all of them (when muting).
  function dismissTicketAlert(ticketId) {
    var c = _ticketCards[ticketId];
    if (c) { try { c.remove(); } catch (e) {} delete _ticketCards[ticketId]; window.metSound('tick'); }
    delete _seen[ticketId]; // allow a genuine re-open to alert again later
  }
  function dismissAllTicketAlerts() { Object.keys(_ticketCards).forEach(dismissTicketAlert); }

  // ── "You were mentioned in a ticket" popup ────────────────────────────
  // Fired when someone @-mentions you in a ticket you can see. Chime + a card
  // with a single "Go to ticket" action (opens on the desk in place if we can).
  function showMentionAlert(d) {
    if (!d || !d.ticketId) return;
    var wrap = ensureWrap();
    var card = document.createElement('div');
    card.className = 'met-alert';
    card.innerHTML =
      '<div class="ma-top"><i class="ti ti-at"></i> You were mentioned'
        + '<button class="ma-x" title="Dismiss">&times;</button></div>'
      + '<div class="ma-title">' + esc(d.typeLabel || 'Support ticket') + '</div>'
      + '<div class="ma-sub">' + esc(d.by || 'Someone') + ' mentioned you</div>'
      + (d.preview ? '<div class="ma-prev">' + esc(d.preview) + '</div>' : '')
      + '<div class="ma-actions">'
      +   '<button class="ma-go" style="flex:1"><i class="ti ti-arrow-right"></i> Go to ticket</button>'
      + '</div>';
    var remove = function () { try { card.remove(); } catch (e) {} };
    card.querySelector('.ma-x').addEventListener('click', remove);
    card.querySelector('.ma-go').addEventListener('click', function () {
      // Staff desk deep-links open in place; the opener side reloads to the ticket.
      if (/\/ia\//.test(d.url || '') && typeof window.sdOpen === 'function') { window.sdOpen(d.ticketId); remove(); }
      else if (typeof window.supOpenTicket === 'function' && !/\/ia\//.test(d.url || '')) { window.supOpenTicket(d.ticketId); remove(); }
      else window.location.href = d.url || ('/ia/dashboard?supportTicket=' + encodeURIComponent(d.ticketId));
    });
    wrap.appendChild(card);
    window.metSound('mention'); // softer, distinct from the loud new-ticket alarm
    desktopNotify('You were mentioned · ' + (d.typeLabel || 'ticket'),
      (d.by || 'Someone') + ': ' + (d.preview || 'mentioned you'), d.url);
    setTimeout(remove, 60000);
  }
  window.metShowMentionAlert = showMentionAlert;

  // ── Emergency alert (full-screen takeover) ────────────────────────────
  // A harsh, LOUD two-tone alarm modelled on a UK radio "panic button" / broadcast
  // emergency warble — a rapidly alternating hi-lo square-wave tone that reads as
  // "this is a real emergency." DELIBERATELY ignores the snooze/mute.
  function emergencySiren() {
    var ctx = ensureAudio(); if (!ctx) return;
    var now = ctx.currentTime;
    var dur = 3.6, step = 0.26;      // ~3.6s of alternating tone, ~0.26s per tone
    // Two slightly-detuned square oscillators through one gain → a grating,
    // penetrating alarm rather than a clean beep.
    function voice(detune) {
      var o = ctx.createOscillator(); o.type = 'square'; o.detune.value = detune;
      var t = now, hi = true;
      while (t < now + dur) { o.frequency.setValueAtTime(hi ? 1000 : 760, t); hi = !hi; t += step; }
      return o;
    }
    try {
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(0.5, now + 0.02);   // snap to loud immediately
      g.gain.setValueAtTime(0.5, now + dur - 0.12);
      g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      var lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200; // tame the very top edge
      var o1 = voice(0), o2 = voice(9);
      o1.connect(lp); o2.connect(lp); lp.connect(g); g.connect(ctx.destination);
      o1.start(now); o2.start(now); o1.stop(now + dur); o2.stop(now + dur);
    } catch (e) {}
  }
  function ensureEmergencyCss() {
    if (document.getElementById('met-emergency-css')) return;
    var st = document.createElement('style'); st.id = 'met-emergency-css';
    st.textContent =
      '@keyframes mePulse{0%,100%{box-shadow:0 0 0 0 rgba(226,35,26,.5),0 24px 80px rgba(0,0,0,.7)}50%{box-shadow:0 0 0 14px rgba(226,35,26,0),0 24px 80px rgba(0,0,0,.7)}}'
      + '@keyframes meIn{from{opacity:0;transform:scale(.94)}to{opacity:1;transform:none}}'
      + '@keyframes meBg{from{opacity:0}to{opacity:1}}'
      + '@keyframes meThrob{0%,100%{transform:scale(1);filter:drop-shadow(0 0 10px rgba(255,68,56,.45))}50%{transform:scale(1.12);filter:drop-shadow(0 0 22px rgba(255,68,56,.75))}}'
      + '.met-emerg{position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;padding:24px;'
      + 'background:radial-gradient(circle at 50% 40%,rgba(120,10,10,.86),rgba(6,8,12,.94));backdrop-filter:blur(6px);animation:meBg .18s ease both;}'
      + '.met-emerg .me-card{max-width:560px;width:100%;text-align:center;background:#14171d;border:2px solid #e2231a;border-radius:20px;padding:34px 30px 28px;animation:meIn .22s ease both,mePulse 1.6s ease-in-out infinite;}'
      + '.met-emerg .me-icon{font-size:66px;color:#ff4438;line-height:1;animation:meThrob 1.4s ease-in-out infinite;}'
      + '.met-emerg .me-title{margin-top:10px;font-size:13px;letter-spacing:.28em;text-transform:uppercase;font-weight:800;color:#ff6a5e;}'
      + '.met-emerg .me-msg{margin-top:16px;font-size:20px;line-height:1.5;font-weight:600;color:#f4f6fa;white-space:pre-wrap;word-wrap:break-word;}'
      + '.met-emerg .me-by{margin-top:14px;font-size:12px;color:#9aa3b2;}'
      + '.met-emerg .me-dismiss{margin-top:24px;padding:12px 26px;border:none;border-radius:11px;background:#e2231a;color:#fff;font-weight:800;font-size:14px;cursor:pointer;letter-spacing:.02em;}'
      + '.met-emerg .me-dismiss:hover{filter:brightness(1.1);}';
    document.head.appendChild(st);
  }
  function showEmergencyAlert(d) {
    if (!d || !d.message) return;
    ensureEmergencyCss();
    var old = document.getElementById('met-emergency'); if (old) { try { old.remove(); } catch (e) {} }
    var ov = document.createElement('div'); ov.id = 'met-emergency'; ov.className = 'met-emerg';
    ov.innerHTML =
      '<div class="me-card" role="alertdialog" aria-label="Emergency Alert">'
      +   '<div class="me-icon"><i class="ti ti-alert-triangle"></i></div>'
      +   '<div class="me-title">Emergency Alert</div>'
      +   '<div class="me-msg">' + esc(d.message) + '</div>'
      +   '<button class="me-dismiss" type="button"><i class="ti ti-check"></i> Dismiss</button>'
      + '</div>';
    document.body.appendChild(ov);
    ov.querySelector('.me-dismiss').addEventListener('click', function () { try { ov.remove(); } catch (e) {} });
    emergencySiren();
  }
  window.metShowEmergencyAlert = showEmergencyAlert;

  function connect() {
    var es;
    try { es = new EventSource('/api/events', { withCredentials: true }); }
    catch (e) { return; }

    es.addEventListener('exam_marked', function (ev) {
      var d = parse(ev);
      toast(d.message || 'Your exam has been marked.', d.status === 'PASSED' ? 'success' : 'info');
      window.metSound(d.status === 'PASSED' ? 'exam_pass' : 'exam_fail');
      call('loadExamStatus');   // profile page — refresh the exam panel if present
    });

    es.addEventListener('tryout_live', function (ev) {
      var d = parse(ev);
      toast(d.message || 'A MET tryout is now live!', 'info');
      window.metSound('tryout_live');
      call('loadTryouts');      // profile page — refresh the tryouts panel if present
    });

    // A support ticket just became ready to claim — staff only (the server
    // targets eligible handlers). Chime + on-screen popup with a claim button.
    es.addEventListener('support_open', function (ev) {
      showTicketAlert(parse(ev));
      call('refreshQueue');     // support desk — refresh the queue if open
      call('loadSupportBadge'); // topbar unclaimed counter, if present
    });

    // You were @-mentioned in a ticket you can see — sound + popup.
    es.addEventListener('ticket_mention', function (ev) {
      showMentionAlert(parse(ev));
    });

    // A ticket was claimed/closed by someone else — dismiss its stale "claim" popup.
    es.addEventListener('ticket_taken', function (ev) {
      var d = parse(ev); if (d && d.ticketId) dismissTicketAlert(d.ticketId);
    });

    // Dev-issued emergency alert — full-screen takeover + loud klaxon.
    es.addEventListener('emergency_alert', function (ev) { showEmergencyAlert(parse(ev)); });

    es.addEventListener('notification', function (ev) {
      var d = parse(ev);
      if (d.message) { toast(d.message, d.kind || 'info'); window.metSound(d.kind === 'error' ? 'error' : 'incoming'); }
    });

    // An LOA request was decided — soft feedback so the member notices.
    es.addEventListener('loa_decided', function (ev) {
      var d = parse(ev);
      if (d.message) toast(d.message, d.status === 'APPROVED' ? 'success' : 'info');
      window.metSound(d.status === 'APPROVED' ? 'reopened' : 'closed');
      call('loadLoaStatus');
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
