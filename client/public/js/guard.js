// client/public/js/guard.js
// Deterrents against casually grabbing the page source. These only raise the
// bar — determined users can still read client code via devtools/Network.
(function () {
  // Developers are exempt from every deterrent below. The flag flips true once
  // /api/me confirms the role; until then the deterrents apply (a brief moment).
  var IS_DEV = false;
  var devtoolsHide = function () {};

  // Block the right-click context menu (incl. "View page source" / "Inspect")
  document.addEventListener("contextmenu", function (e) { if (IS_DEV) return; e.preventDefault(); }, { capture: true });

  // Block common view-source / save / devtools keyboard shortcuts
  document.addEventListener("keydown", function (e) {
    if (IS_DEV) return;
    var k = (e.key || "").toLowerCase();
    var ctrl = e.ctrlKey || e.metaKey;

    // F12 — devtools
    if (k === "f12") { e.preventDefault(); return false; }
    // Ctrl/Cmd+U — view source
    if (ctrl && k === "u") { e.preventDefault(); return false; }
    // Ctrl/Cmd+S — save page
    if (ctrl && k === "s") { e.preventDefault(); return false; }
    // Ctrl/Cmd+Shift+I / J / C — devtools / console / inspector
    if (ctrl && e.shiftKey && (k === "i" || k === "j" || k === "c")) { e.preventDefault(); return false; }
  }, { capture: true });

  // ── DevTools-open detector ───────────────────────────────────────
  // Heuristic: a large gap between outer and inner window size usually means
  // docked devtools is open. Bypassable, but blanks the page as a deterrent.
  (function () {
    // Skip entirely on touch / mobile devices: there's no dockable devtools to
    // detect, and the on-screen keyboard shrinks innerHeight — which this
    // outer-vs-inner heuristic would wrongly read as "devtools open" (e.g. when
    // typing into the Request Changes box).
    var isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '')
                || (navigator.maxTouchPoints || 0) > 0;
    if (isMobile) return;

    // Record the baseline gap at load (devtools assumed closed). Browser chrome
    // (tabs/bookmarks/address bar) is part of this baseline, so we only react to
    // a LARGE increase beyond it — this avoids false-positives that would wrongly
    // blank the page.
    var GROWTH = 200;
    var baseW = null, baseH = null; // captured lazily once the window is valid
    var hits = 0;                   // consecutive positive checks (debounce)
    var overlay = null;

    function windowUsable() {
      // After sleep/restore/minimize the window can report 0-size or be
      // unfocused/hidden — measurements then are bogus, so we skip detection.
      return !document.hidden &&
             document.hasFocus() &&
             window.innerWidth > 0 && window.innerHeight > 0 &&
             window.outerWidth > 0 && window.outerHeight > 0;
    }
    function rebaseline() { baseW = null; baseH = null; hits = 0; }

    function ensureOverlay() {
      if (overlay) return overlay;
      overlay = document.createElement("div");
      overlay.id = "devtools-block-overlay";
      overlay.style.cssText =
        "position:fixed;inset:0;z-index:2147483647;display:none;" +
        "align-items:center;justify-content:center;flex-direction:column;gap:12px;" +
        "background:#06080d;color:#f5c518;text-align:center;font-family:sans-serif;";
      overlay.innerHTML =
        '<div style="font-size:42px;">&#9888;</div>' +
        '<div style="font-size:20px;font-weight:700;color:#fff;">Developer tools detected</div>' +
        '<div style="font-size:13px;color:rgba(255,255,255,0.6);max-width:340px;">' +
        "For security reasons this page is hidden while developer tools are open. " +
        "Close them to continue.</div>";
      document.body.appendChild(overlay);
      return overlay;
    }

    function hide() { hits = 0; if (overlay) overlay.style.display = "none"; }
    devtoolsHide = hide; // let the developer check tear the overlay down

    function check() {
      // Developers may use devtools freely
      if (IS_DEV) { hide(); return; }
      // Never flag while the window isn't in a normal, focused, on-screen state
      if (!windowUsable()) { hide(); return; }

      var wGap = window.outerWidth  - window.innerWidth;
      var hGap = window.outerHeight - window.innerHeight;

      // Establish the baseline the first valid time (and adapt downward)
      if (baseW === null) { baseW = wGap; baseH = hGap; hide(); return; }
      if (wGap < baseW) baseW = wGap;
      if (hGap < baseH) baseH = hGap;

      var open = (wGap - baseW > GROWTH) || (hGap - baseH > GROWTH);
      // Require two consecutive positive readings to avoid transient spikes
      if (open) { hits++; } else { hide(); return; }
      if (hits >= 2) ensureOverlay().style.display = "flex";
    }

    // Re-baseline whenever the window returns from the background / restore /
    // bfcache — the chrome size or DPI may have changed, which previously caused
    // a false "devtools open" until a manual refresh.
    window.addEventListener("focus",  function () { rebaseline(); setTimeout(check, 350); });
    window.addEventListener("pageshow", function () { rebaseline(); setTimeout(check, 350); });
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) { hide(); } else { rebaseline(); setTimeout(check, 350); }
    });
    window.addEventListener("resize", check);
    setInterval(check, 1500);
    if (document.body) check(); else document.addEventListener("DOMContentLoaded", check);
  })();

  // ── Developer exemption ──────────────────────────────────────────
  // Ask the server who we are; if a DEVELOPER, drop all deterrents so they can
  // use inspect / devtools / right-click freely. Fails closed (stays on) for
  // everyone else and on any error / unauthenticated page.
  try {
    fetch("/api/me", { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (u) {
        if (u && u.role === "DEVELOPER") {
          IS_DEV = true;
          devtoolsHide();
        }
      })
      .catch(function () {});
  } catch (e) {}
})();
