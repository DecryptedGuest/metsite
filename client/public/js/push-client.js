// push-client.js — Web Push subscription management.
// Registers the service worker for click-to-open, but only requests browser
// permission when the user explicitly opts in (via the prompt or settings tab).
(function () {
  function supported() {
    return ('serviceWorker' in navigator) && ('PushManager' in window) && ('Notification' in window);
  }

  // CSRF token (double-submit cookie) for state-changing requests.
  function csrf() {
    return (document.cookie.match(/csrf_token=([^;]+)/) || [])[1] || '';
  }

  function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    var base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var raw     = atob(base64);
    var output  = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
    return output;
  }

  // Register the SW (safe to call repeatedly). Does NOT request permission.
  async function registerSW() {
    if (!supported()) return null;
    try { return await navigator.serviceWorker.register('/sw.js'); }
    catch (e) { console.warn('[Push] SW register failed:', e); return null; }
  }

  // Subscribe this browser and persist the subscription server-side.
  async function doSubscribe() {
    var r   = await fetch('/api/push/vapid-public-key');
    var obj = await r.json();
    if (!obj.key) throw new Error('Push not configured on server');
    var reg = await navigator.serviceWorker.ready;
    var sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly:      true,
        applicationServerKey: urlBase64ToUint8Array(obj.key),
      });
    }
    await fetch('/api/push/subscribe', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
      body:    JSON.stringify(sub.toJSON()),
    });
  }

  // Public: request permission + subscribe. Returns 'granted' | 'denied' | 'unsupported' | 'error'.
  async function requestPushPermission() {
    if (!supported()) return 'unsupported';
    try {
      await registerSW();
      if (Notification.permission === 'denied') return 'denied';
      var perm = Notification.permission === 'granted'
        ? 'granted'
        : await Notification.requestPermission();
      if (perm !== 'granted') return 'denied';
      await doSubscribe();
      return 'granted';
    } catch (e) {
      console.warn('[Push] requestPushPermission failed:', e);
      return 'error';
    }
  }

  // Public: remove this browser's subscription.
  async function removePushSubscription() {
    if (!supported()) return;
    try {
      var reg = await navigator.serviceWorker.ready;
      var sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch('/api/push/unsubscribe', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
          body:    JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
    } catch (e) { console.warn('[Push] unsubscribe failed:', e); }
  }

  function permissionState() {
    return ('Notification' in window) ? Notification.permission : 'unsupported';
  }

  // For elevated roles: register the SW on load so push delivery + click-to-open
  // work for already-subscribed users. No permission prompt here.
  async function initForStaff(role) {
    if (!['IA', 'HICOMM', 'SUPERVISOR', 'DEVELOPER'].includes(role)) return;
    await registerSW();
    // Refresh an existing subscription server-side (in case the row was pruned)
    try {
      if (supported() && Notification.permission === 'granted') {
        var reg = await navigator.serviceWorker.ready;
        var sub = await reg.pushManager.getSubscription();
        if (sub) {
          await fetch('/api/push/subscribe', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
            body: JSON.stringify(sub.toJSON()),
          });
        }
      }
    } catch (e) {}
  }

  // ── Navigate to the right page/modal when a notification is clicked ──
  // (fires when a notification is clicked while a tab is already open). Fresh
  // loads are handled by dashboard.js's handleNotificationLaunch() once init
  // has finished, so we don't add our own early DOMContentLoaded handler here.
  function handlePushNav(url, msg) {
    try {
      var params   = new URLSearchParams((url.split('?')[1] || ''));
      var page     = params.get('page');
      if (!page) return;
      if (typeof handleNotificationTarget === 'function') {
        handleNotificationTarget(page, params.get('case'), params.get('ticket'));
      }
    } catch (_) {}
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', function (e) {
      if (e.data && e.data.type === 'PUSH_NAV' && e.data.url) handlePushNav(e.data.url, e.data);
    });
  }

  // Exports
  window.pushClient = {
    requestPushPermission: requestPushPermission,
    removePushSubscription: removePushSubscription,
    permissionState: permissionState,
    initForStaff: initForStaff,
    supported: supported,
  };
})();
