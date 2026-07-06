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
