// client/public/js/security.js
// Best-effort screenshot/capture detection + out-of-focus privacy guard.
// NOTE: Browsers cannot see OS-level screenshots directly; this detects the
// keyboard shortcuts that trigger them and logs everything we can observe.
(function () {
  var GUARD_KEY = "iacms_blur_guard";
  var lastReport = 0;

  // Developers bypass all screenshot/capture restrictions (no capture logging,
  // no privacy-guard blur). currentUser is set by dashboard.js after /api/me.
  function isDeveloper() {
    try { return typeof currentUser !== "undefined" && currentUser && currentUser.role === "DEVELOPER"; }
    catch (e) { return false; }
  }

  // ── Inject privacy-guard overlay styles ──────────────────────────
  (function injectStyles() {
    var css =
      "#privacy-guard-overlay{position:fixed;inset:0;z-index:99999;display:none;" +
      "align-items:center;justify-content:center;background:rgba(8,10,16,0.82);" +
      "backdrop-filter:blur(22px);-webkit-backdrop-filter:blur(22px);}" +
      "#privacy-guard-overlay.active{display:flex;}" +
      "#privacy-guard-overlay .pg-inner{display:flex;flex-direction:column;align-items:center;" +
      "gap:10px;color:#f5c518;text-align:center;font-family:inherit;}" +
      "#privacy-guard-overlay .pg-title{font-size:20px;font-weight:700;letter-spacing:0.04em;color:#fff;}" +
      "#privacy-guard-overlay .pg-sub{font-size:13px;color:rgba(255,255,255,0.6);}";
    var s = document.createElement("style");
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  })();

  // ── Environment fingerprint ──────────────────────────────────────
  function parseUA() {
    var ua = navigator.userAgent || "";
    var os = "Unknown", browser = "Unknown", device = "Desktop";

    // OS
    if (/Windows NT 10/.test(ua)) os = "Windows 10/11";
    else if (/Windows NT 6\.3/.test(ua)) os = "Windows 8.1";
    else if (/Windows NT 6\.1/.test(ua)) os = "Windows 7";
    else if (/Windows/.test(ua)) os = "Windows";
    else if (/Mac OS X 10[._]15/.test(ua)) os = "macOS Catalina+";
    else if (/Mac OS X/.test(ua)) os = "macOS";
    else if (/Android/.test(ua)) { os = "Android"; device = "Mobile"; }
    else if (/(iPhone|iPad|iPod)/.test(ua)) { os = "iOS"; device = /iPad/.test(ua) ? "Tablet" : "Mobile"; }
    else if (/Linux/.test(ua)) os = "Linux";
    else if (/CrOS/.test(ua)) os = "ChromeOS";

    // Browser (order matters)
    if (/Edg\//.test(ua)) browser = "Edge";
    else if (/OPR\//.test(ua) || /Opera/.test(ua)) browser = "Opera";
    else if (/Brave/.test(ua)) browser = "Brave";
    else if (/Chrome\//.test(ua)) browser = "Chrome";
    else if (/Firefox\//.test(ua)) browser = "Firefox";
    else if (/Safari\//.test(ua)) browser = "Safari";

    // Refine with UA-CH if available
    if (navigator.userAgentData && Array.isArray(navigator.userAgentData.brands)) {
      var b = navigator.userAgentData.brands
        .map(function (x) { return x.brand; })
        .filter(function (n) { return !/Not.?A.?Brand/i.test(n); });
      if (b.length) browser = b.join(", ");
      if (navigator.userAgentData.platform) os = navigator.userAgentData.platform + (os !== "Unknown" ? " (" + os + ")" : "");
      if (navigator.userAgentData.mobile) device = "Mobile";
    }
    return { os: os, browser: browser, device: device };
  }

  function screenInfo() {
    var s = window.screen || {};
    return (s.width || "?") + "x" + (s.height || "?") +
      " @" + (window.devicePixelRatio || 1) + "x" +
      " | viewport " + window.innerWidth + "x" + window.innerHeight;
  }

  // ── Report a capture event to the backend ────────────────────────
  function reportCapture(method, details) {
    if (isDeveloper()) return; // developers are exempt
    var now = Date.now();
    if (now - lastReport < 800) return; // debounce double key events
    lastReport = now;

    var env = parseUA();
    var payload = {
      method: method,
      details: details || null,
      page: currentPageLabel(),
      os: env.os,
      browser: env.browser,
      device: env.device,
      userAgent: navigator.userAgent,
      screenInfo: screenInfo(),
      language: navigator.language || (navigator.languages && navigator.languages[0]) || null,
    };

    function send() {
      try {
        fetch("/api/security/capture", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          keepalive: true,
          body: JSON.stringify(payload),
        }).catch(function () {});
      } catch (e) {}
      // No user-facing notification — logged silently.
    }

    // Capture an image of exactly what they were looking at, then send.
    captureScreenshot().then(function (shot) {
      if (shot) payload.screenshot = shot;
      send();
    });
  }
  window.reportCapture = reportCapture;

  // Render exactly what's on screen (current viewport) to an image.
  // html2canvas can't render backdrop-filter blur, the decorative bg glows,
  // or scanlines — those come out black — so we neutralise them in the clone.
  function captureScreenshot() {
    return new Promise(function (resolve) {
      if (typeof html2canvas !== "function") { resolve(null); return; }
      try {
        html2canvas(document.documentElement, {
          useCORS: true,
          logging: false,
          backgroundColor: "#0a0c12",
          scale: Math.min(window.devicePixelRatio || 1, 1.5),
          // Capture only the visible viewport (what the user actually sees)
          width: window.innerWidth,
          height: window.innerHeight,
          x: window.pageXOffset,
          y: window.pageYOffset,
          scrollX: 0,
          scrollY: 0,
          windowWidth: window.innerWidth,
          windowHeight: window.innerHeight,
          ignoreElements: function (el) {
            return el.id === "privacy-guard-overlay" ||
                   el.classList && (el.classList.contains("bg-glow-1") ||
                                    el.classList.contains("bg-glow-2") ||
                                    el.classList.contains("bg-scanline") ||
                                    el.classList.contains("bg-grid"));
          },
          onclone: function (doc) {
            // Replace effects html2canvas renders as black with solid equivalents
            var style = doc.createElement("style");
            style.textContent =
              "*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;" +
              "filter:none!important;text-shadow:none!important;box-shadow:none!important;}" +
              "html,body,.bg-canvas{background:#0a0c12!important;}" +
              ".glass,.glass-bright,.panel,.modal,.modal-body,.stat-card,.sidebar,.app-layout,.main-content{background-color:#11151f!important;}" +
              ".bg-glow-1,.bg-glow-2,.bg-scanline,.bg-grid{display:none!important;}";
            doc.head.appendChild(style);
          },
        }).then(function (canvas) {
          try { resolve(canvas.toDataURL("image/jpeg", 0.72)); }
          catch (e) { resolve(null); }
        }).catch(function () { resolve(null); });
      } catch (e) { resolve(null); }
    });
  }

  // Friendly label for the in-app tab/page currently being viewed (SPA)
  function currentPageLabel() {
    var el = document.querySelector(".page.active");
    var id = el ? el.id.replace(/^page-/, "") : "";
    var map = {
      dashboard: "Dashboard", "my-cases": "My Cases", "all-cases": "All Cases",
      review: "Pending Cases", "ticket-review": "Pending Tickets", audit: "Audit Log",
      admin: "Dev Panel", group: "Group Panel", visits: "Visits", security: "Security",
      tickets: "My Tickets", "all-tickets": "All Tickets",
    };
    // If a modal is open, note it (e.g. viewing a case/ticket detail)
    var openModalEl = document.querySelector(".modal-overlay.open");
    var base = map[id] || id || location.pathname;
    if (openModalEl) {
      var titleEl = openModalEl.querySelector(".modal-title");
      var t = titleEl ? titleEl.textContent.trim() : "";
      if (t) return base + " · " + t;
    }
    return base;
  }

  // ── Capture shortcut detection ───────────────────────────────────
  function cover() { if (window.__forceCaptureGuard) window.__forceCaptureGuard(3000); }

  function onKey(e) {
    if (isDeveloper()) return; // developers are exempt
    var k = (e.key || "").toLowerCase();

    // PrintScreen (Windows / Linux) — usually only fires on keyup
    if (e.key === "PrintScreen" || k === "printscreen") {
      cover();
      reportCapture("PrintScreen key", "PrtSc" + (e.altKey ? " + Alt (active window)" : ""));
      return;
    }
    // Windows Snipping Tool: Win + Shift + S  (Meta = Windows key)
    if (e.metaKey && e.shiftKey && k === "s") {
      cover();
      reportCapture("Snipping Tool (Win+Shift+S)", "Windows region snip shortcut");
      return;
    }
    // macOS screenshots: Cmd + Shift + 3/4/5
    if (e.metaKey && e.shiftKey && (k === "3" || k === "4" || k === "5")) {
      cover();
      var what = k === "3" ? "full screen" : k === "4" ? "region" : "capture menu";
      reportCapture("macOS screenshot (Cmd+Shift+" + k + ")", "macOS " + what + " capture");
      return;
    }
    // Print dialog (often used to PDF/save the page)
    if ((e.ctrlKey || e.metaKey) && k === "p") {
      cover();
      reportCapture("Print dialog (Ctrl/Cmd+P)", "Opened browser print/save dialog");
      return;
    }
  }
  window.addEventListener("keyup", onKey, true);
  window.addEventListener("keydown", function (e) {
    // Win+Shift+S is grabbed fast by the OS — catch it on keydown too
    var k = (e.key || "").toLowerCase();
    if (e.metaKey && e.shiftKey && k === "s") onKey(e);
  }, true);

  // ── Out-of-focus / capture privacy guard ─────────────────────────
  var overlay = null;
  var stickyUntil = 0; // overlay stays up at least until this timestamp
  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.id = "privacy-guard-overlay";
    overlay.innerHTML =
      '<div class="pg-inner">' +
      '<i class="ti ti-eye-off" style="font-size:46px;"></i>' +
      '<div class="pg-title">Content hidden</div>' +
      '<div class="pg-sub">Return focus to this window to continue</div>' +
      "</div>";
    document.body.appendChild(overlay);
    return overlay;
  }
  function guardEnabled() { return !isDeveloper() && localStorage.getItem(GUARD_KEY) === "1"; }
  function showGuard() {
    if (!guardEnabled()) return;
    ensureOverlay().classList.add("active");
  }
  function hideGuard() {
    if (Date.now() < stickyUntil) return; // keep it up during a capture window
    if (overlay) overlay.classList.remove("active");
  }
  // Force the overlay up and keep it sticky for `ms` so it covers the entire
  // capture attempt (and any delayed re-snip) rather than flashing on/off.
  function forceGuard(ms) {
    if (!guardEnabled()) return;
    stickyUntil = Date.now() + (ms || 2500);
    ensureOverlay().classList.add("active");
    setTimeout(hideGuard, (ms || 2500) + 50);
  }
  window.__forceCaptureGuard = forceGuard;

  window.addEventListener("blur", showGuard);
  window.addEventListener("focus", hideGuard);
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) showGuard(); else hideGuard();
  });
  // Any interaction inside our window means the user is back/present — hide the
  // overlay even if a focus event didn't fire (e.g. after a native dialog),
  // unless we're inside a sticky capture window.
  ["pointerdown", "keydown"].forEach(function (ev) {
    document.addEventListener(ev, function () { if (Date.now() >= stickyUntil) hideGuard(); }, true);
  });

  // Toggle used by the Security panel checkbox
  window.toggleBlurGuard = function (enabled) {
    localStorage.setItem(GUARD_KEY, enabled ? "1" : "0");
    if (!enabled) hideGuard();
    if (typeof showToast === "function")
      showToast("Privacy guard " + (enabled ? "enabled" : "disabled") + ".", enabled ? "success" : "info");
  };

  // Reflect saved state into the checkbox once the DOM is ready
  document.addEventListener("DOMContentLoaded", function () {
    if (localStorage.getItem(GUARD_KEY) === null) localStorage.setItem(GUARD_KEY, "1"); // default ON
    var cb = document.getElementById("guard-blur-toggle");
    if (cb) cb.checked = localStorage.getItem(GUARD_KEY) === "1";
  });
})();
