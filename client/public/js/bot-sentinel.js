/* bot-sentinel.js — passive behavioural bot detection.
   Watches for input signatures that a human at a real mouse/touch device does
   NOT produce — cursor teleports (a jump with no movement trail), synthetic
   (untrusted) events, automation flags — and reports them to the server's
   Security Center. It is TELEMETRY ONLY: it never blocks, challenges, or slows
   a real user (important — guests and touch users must keep full access). The
   server decides what to do with the signals.

   "Teleport" ≠ "fast movement". A human flick across the screen still fires a
   dense trail of pointermove samples (small deltas); coalesced samples are
   recoverable via getCoalescedEvents(). A teleport is a single large jump with
   no intermediate samples at all — which is what automation produces when it
   sets the pointer straight onto a target. That distinction is the core test. */
(function () {
  try {
    var nav = window.navigator || {};
    var reported = {};
    var reportCount = 0;
    var MAX_REPORTS = 6;

    function send(type, detail) {
      if (reported[type] || reportCount >= MAX_REPORTS) return;
      reported[type] = true; reportCount++;
      var payload;
      try {
        payload = JSON.stringify({
          type: type, detail: detail || {},
          path: location.pathname, ua: (nav.userAgent || '').slice(0, 300),
          ts: Date.now(),
        });
      } catch (e) { return; }
      try {
        if (nav.sendBeacon) {
          nav.sendBeacon('/api/security/bot-signal', new Blob([payload], { type: 'application/json' }));
        } else {
          fetch('/api/security/bot-signal', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: payload, keepalive: true, credentials: 'same-origin',
          }).catch(function () {});
        }
      } catch (e) { /* never throw from a beacon */ }
    }

    // ── 1. Automation / headless flags (fire immediately) ──────────────
    try { if (nav.webdriver === true) send('webdriver', {}); } catch (e) {}
    var GLOBALS = ['_phantom', '__nightmare', 'callPhantom', 'domAutomation',
      'domAutomationController', '__selenium_unwrapped', '__webdriver_evaluate',
      '__driver_evaluate', '_Selenium_IDE_Recorder', '__playwright', '__puppeteer_evaluation_script__'];
    for (var i = 0; i < GLOBALS.length; i++) {
      try { if (window[GLOBALS[i]] !== undefined) { send('automation-global', { key: GLOBALS[i] }); break; } } catch (e) {}
    }
    try { if (/HeadlessChrome/i.test(nav.userAgent || '')) send('headless-ua', {}); } catch (e) {}
    // A real browser has a plugins list / languages; many headless setups don't.
    try {
      if (nav.userAgent && !/Mobile|Android|iPhone|iPad/i.test(nav.userAgent) &&
          Array.isArray(nav.languages) && nav.languages.length === 0) send('no-languages', {});
    } catch (e) {}

    // ── 2. Synthetic (untrusted) events ────────────────────────────────
    function onUntrusted(e) {
      try { if (e && e.isTrusted === false) send('untrusted-event', { type: e.type }); } catch (err) {}
    }
    ['click', 'pointerdown', 'mousedown', 'keydown'].forEach(function (t) {
      try { document.addEventListener(t, onUntrusted, true); } catch (e) {}
    });

    // ── 3. Cursor teleports ─────────────────────────────────────────────
    var lastPt = null;         // { x, y }
    var teleportHits = 0;
    var suppressUntil = 0;     // ignore jumps right after focus loss / re-entry
    var JUMP_PX = 320;         // a jump this big with no trail is suspicious
    var HITS_TO_FLAG = 3;      // require a few before reporting (avoid one-offs)

    function markReentry() { suppressUntil = Date.now() + 400; lastPt = null; }
    try {
      window.addEventListener('blur', markReentry, true);
      document.addEventListener('pointerleave', markReentry, true);
      document.addEventListener('mouseleave', markReentry, true);
      document.addEventListener('visibilitychange', function () { if (document.hidden) markReentry(); }, true);
    } catch (e) {}

    function onMove(e) {
      try {
        if (e.pointerType && e.pointerType !== 'mouse') return; // touch/pen legitimately "jump"
        var x = e.clientX, y = e.clientY;
        if (lastPt && Date.now() >= suppressUntil) {
          var dx = x - lastPt.x, dy = y - lastPt.y;
          var dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > JUMP_PX) {
            // How many real samples happened in this step? A human flick coalesces
            // into MANY; a teleport has exactly one.
            var coalesced = 1;
            try { if (e.getCoalescedEvents) coalesced = e.getCoalescedEvents().length || 1; } catch (er) {}
            if (coalesced <= 1) {
              teleportHits++;
              if (teleportHits >= HITS_TO_FLAG) send('cursor-teleport', { dist: Math.round(dist), hits: teleportHits });
            }
          }
        }
        lastPt = { x: x, y: y };
      } catch (err) {}
    }
    try { document.addEventListener('pointermove', onMove, true); } catch (e) {}
    // Fallback for browsers without Pointer Events.
    if (!('onpointermove' in window)) {
      try {
        document.addEventListener('mousemove', function (e) {
          onMove({ pointerType: 'mouse', clientX: e.clientX, clientY: e.clientY });
        }, true);
      } catch (e) {}
    }

    // ── 4. Interaction with no pointer trail (programmatic clicks) ──────
    var moveCount = 0;
    try { document.addEventListener('pointermove', function () { moveCount++; }, true); } catch (e) {}
    var clicks = 0;
    try {
      document.addEventListener('click', function (e) {
        if (e.pointerType === 'touch' || ('ontouchstart' in window)) return; // touch users don't move a pointer
        clicks++;
        if (clicks >= 3 && moveCount === 0) send('clicks-no-pointer', { clicks: clicks });
      }, true);
    } catch (e) {}
  } catch (e) { /* detection must never break the page */ }
})();
