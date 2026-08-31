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
        : r === 'denied' ? 'Notifications are blocked · allow them in your browser’s site settings.'
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
  // ── Emergency alert ───────────────────────────────────────────────────
  // Styled after a UK Government Emergency Alert as it appears on a phone: a
  // red band, a white card, black text set large, and a single acknowledge
  // button. The point of that design is that it is unmistakable and cannot be
  // confused with an ordinary notification, which is exactly what this is for.
  //
  // The tone is synthesised, not a recording: it is the standard cell-broadcast
  // attention signal, 853 Hz and 960 Hz sounded TOGETHER, which is what gives
  // that pair its harsh beating quality rather than a musical chord. It is
  // gated on and off about twice a second for the pulse. DELIBERATELY ignores
  // the snooze and the mute.
  var _sirenStop = null;

  // The Common Audio Attention Signal, to the letter of the specification the
  // UK's alerts share with Wireless Emergency Alerts in the US and EU-Alert.
  // 47 CFR 10.520:
  //
  //   "For devices that have polyphonic capabilities, the audio attention
  //    signal must consist of the fundamental frequencies of 853 Hz and
  //    960 Hz transmitted simultaneously."
  //
  //   "The audio attention signal must have a temporal pattern of one long
  //    tone of two (2) seconds, followed by two short tones of one (1) second
  //    each, with a half (0.5) second interval between each tone. The entire
  //    sequence must be repeated twice with a half (0.5) second interval
  //    between each repetition."
  //
  // Which lays out as 2 + 0.5 + 1 + 0.5 + 1 = 5s per sequence, two sequences
  // half a second apart, so 10.5s in total. That is the check that this is
  // right: it lands exactly on the "about ten seconds" every UK source gives
  // for how long a real alert sounds.
  //
  // The pair is chosen to be unpleasant, not audible: 853 and 960 are close
  // enough to beat against each other at about 107 Hz, and that roughness is
  // the whole point. Sine waves, because the beating does the work and square
  // waves would only pile harmonics on top of it.
  var WEA_TONES = [853, 960];
  var WEA_SEQUENCE = [                 // [start, duration] within one sequence
    [0.0, 2.0],                        // one long tone of two seconds
    [2.5, 1.0],                        // half-second interval, then a short tone
    [4.0, 1.0]                         // half-second interval, then a short tone
  ];
  var WEA_SEQ_LEN = 5.0;               // 4.0 + 1.0
  var WEA_REPEATS = 2;                 // the sequence, repeated
  var WEA_GAP     = 0.5;               // between repetitions
  var WEA_TOTAL   = WEA_REPEATS * WEA_SEQ_LEN + (WEA_REPEATS - 1) * WEA_GAP;   // 10.5s

  function emergencySiren() {
    var ctx = ensureAudio(); if (!ctx) return;
    stopSiren();
    var t0 = ctx.currentTime + 0.02;
    try {
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, ctx.currentTime);

      // Gate the gain to the pattern. A 6ms edge on each side, because a tone
      // switched on instantly clicks, and the click is louder than the tone.
      var EDGE = 0.006, LEVEL = 0.5;
      for (var r = 0; r < WEA_REPEATS; r++) {
        var base = t0 + r * (WEA_SEQ_LEN + WEA_GAP);
        for (var i = 0; i < WEA_SEQUENCE.length; i++) {
          var on = base + WEA_SEQUENCE[i][0], off = on + WEA_SEQUENCE[i][1];
          g.gain.setValueAtTime(0.0001, on);
          g.gain.exponentialRampToValueAtTime(LEVEL, on + EDGE);
          g.gain.setValueAtTime(LEVEL, off - EDGE);
          g.gain.exponentialRampToValueAtTime(0.0001, off);
        }
      }

      // Both fundamentals, sounded together, running continuously underneath:
      // the gate above is what shapes them into the pattern.
      var end = t0 + WEA_TOTAL + 0.05;
      var oscs = WEA_TONES.map(function (f) {
        var o = ctx.createOscillator();
        o.type = 'sine'; o.frequency.value = f;
        o.connect(g); o.start(t0 - 0.01); o.stop(end);
        return o;
      });
      g.connect(ctx.destination);

      _sirenStop = function () {
        try {
          var n = ctx.currentTime;
          g.gain.cancelScheduledValues(n);
          g.gain.setValueAtTime(Math.max(g.gain.value, 0.0001), n);
          g.gain.exponentialRampToValueAtTime(0.0001, n + 0.06);
          oscs.forEach(function (o) { try { o.stop(n + 0.08); } catch (e) {} });
        } catch (e) {}
        _sirenStop = null;
      };
    } catch (e) {}
  }
  function stopSiren() { if (_sirenStop) _sirenStop(); }

  function ensureEmergencyCss() {
    if (document.getElementById('met-emergency-css')) return;
    var st = document.createElement('style'); st.id = 'met-emergency-css';
    st.textContent =
      '@keyframes meIn{from{opacity:0;transform:translateY(14px) scale(.98)}to{opacity:1;transform:none}}'
      + '@keyframes meBg{from{opacity:0}to{opacity:1}}'
      + '@keyframes meFlash{0%,100%{background:#d4351c}50%{background:#aa2b16}}'
      + '.met-emerg{position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;'
      + 'padding:20px;background:rgba(4,5,7,.86);backdrop-filter:blur(8px);animation:meBg .16s ease both;}'
      + '.met-emerg .me-card{max-width:460px;width:100%;background:#fff;border-radius:14px;overflow:hidden;'
      + 'box-shadow:0 30px 90px rgba(0,0,0,.7);animation:meIn .24s cubic-bezier(.2,.7,.3,1) both;'
      + "font-family:'Inter',-apple-system,'Segoe UI',Roboto,Arial,sans-serif;}"
      + '.met-emerg .me-band{display:flex;align-items:center;gap:10px;padding:13px 20px;background:#d4351c;'
      + 'animation:meFlash 1.1s steps(1,end) infinite;}'
      + '.met-emerg .me-band svg{width:20px;height:20px;flex:0 0 20px;}'
      + '.met-emerg .me-band span{color:#fff;font-size:14px;font-weight:700;letter-spacing:.01em;}'
      + '.met-emerg .me-body{padding:24px 22px 20px;}'
      + '.met-emerg .me-head{font-size:23px;line-height:1.25;font-weight:700;color:#0b0c0c;margin:0 0 12px;letter-spacing:-.01em;}'
      + '.met-emerg .me-msg{font-size:16px;line-height:1.55;color:#0b0c0c;white-space:pre-wrap;word-wrap:break-word;margin:0;}'
      + '.met-emerg .me-from{margin-top:18px;padding-top:16px;border-top:1px solid #b1b4b6;font-size:14px;color:#505a5f;line-height:1.5;}'
      + '.met-emerg .me-check{margin-top:10px;font-size:13px;line-height:1.5;color:#505a5f;}'
      + '.met-emerg .me-time{margin-top:10px;font-size:13px;color:#505a5f;}'
      + '.met-emerg .me-actions{padding:0 22px 22px;}'
      + '.met-emerg .me-dismiss{width:100%;padding:14px;border:0;border-radius:6px;background:#00703c;color:#fff;'
      + 'font-family:inherit;font-weight:700;font-size:16px;cursor:pointer;box-shadow:0 2px 0 #002d18;}'
      + '.met-emerg .me-dismiss:hover{background:#005a30;}'
      + '.met-emerg .me-dismiss:active{transform:translateY(2px);box-shadow:none;}'
      // GOV.UK's own focus style: a yellow block with a black underline. The
      // site's blue ring is invisible discipline on a white card like this one.
      + '.met-emerg .me-dismiss:focus-visible{outline:3px solid #ffdd00;outline-offset:0;'
      + 'box-shadow:0 4px 0 #0b0c0c;background:#00703c;}'
      + '@media (prefers-reduced-motion:reduce){.met-emerg .me-band{animation:none!important}}';
    document.head.appendChild(st);
  }

  function showEmergencyAlert(d) {
    if (!d || !d.message) return;
    ensureEmergencyCss();
    var old = document.getElementById('met-emergency'); if (old) { try { old.remove(); } catch (e) {} }
    var ov = document.createElement('div'); ov.id = 'met-emergency'; ov.className = 'met-emerg';
    // Real alerts are titled by severity: an Emergency alert is the top level,
    // a Severe alert the one below it. Both are red; the label is the
    // difference, and it is the label people are told to look for.
    var LEVELS = { emergency: 'Emergency alert', severe: 'Severe alert', test: 'Test alert' };
    var band = LEVELS[String(d.level || 'emergency').toLowerCase()] || LEVELS.emergency;
    var when = new Date(d.at || Date.now()).toLocaleString('en-GB',
      { weekday: 'long', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'long' });
    ov.innerHTML =
      '<div class="me-card" role="alertdialog" aria-label="Emergency alert">'
      +   '<div class="me-band">'
      +     '<svg viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M12 2 1 21h22L12 2zm0 5 7.5 12.9h-15L12 7zm-1 4v5h2v-5h-2zm0 6v2h2v-2h-2z"/></svg>'
      +     '<span>' + esc(band) + '</span>'
      +   '</div>'
      +   '<div class="me-body">'
      +     '<h2 class="me-head">' + esc(d.title || 'Severe alert') + '</h2>'
      +     '<p class="me-msg">' + esc(d.message) + '</p>'
      +     '<div class="me-from">This is a message from the Metropolitan Police Service.</div>'
      +     '<div class="me-check">Other than acknowledging this alert, you do not need to take any '
      +       'action on this site. You can check whether an alert is genuine with High Command.</div>'
      +     '<div class="me-time">' + esc(when) + '</div>'
      +   '</div>'
      +   '<div class="me-actions"><button class="me-dismiss" type="button">OK</button></div>'
      + '</div>';
    document.body.appendChild(ov);
    var btn = ov.querySelector('.me-dismiss');
    btn.addEventListener('click', function () { stopSiren(); try { ov.remove(); } catch (e) {} });
    try { btn.focus(); } catch (e) {}
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

    // Dev-issued emergency alert — full-screen takeover + loud klaxon.
    es.addEventListener('emergency_alert', function (ev) { showEmergencyAlert(parse(ev)); });

    es.addEventListener('notification', function (ev) {
      var d = parse(ev);
      if (d.message) { toast(d.message, d.kind || 'info'); window.metSound(d.kind === 'error' ? 'error' : 'incoming'); }
    });

    // An LOA request was decided — soft feedback so the member notices.

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
