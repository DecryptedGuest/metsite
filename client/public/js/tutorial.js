// client/public/js/tutorial.js
// Lightweight guided walkthrough: dims the page, spotlights an element and
// shows a short tooltip with Back / Next / Skip. Re-runnable any time from the
// topbar "Tour" button, and offered once on a first visit. Plain, human wording
// — no AI-speak. Self-contained; depends on nothing.
(function () {
  if (typeof document === 'undefined' || window.metTour) return;

  // ── Step sets, chosen by the current page ──────────────────────────
  const PROFILE = [
    { sel: '#p-greeting,#p-name', title: 'Your profile', body: "This is your officer profile — your rank, divisions and standing all live here." },
    { sel: '#p-activity-panel', title: 'Your activity', body: "A quick snapshot of your patrols, events and time on duty." },
    { sel: '#p-divisions', title: 'Divisions & rank', body: "Every division you're part of, with your current rank. Tap a card to open its dashboard." },
    { sel: '#p-appearance-panel', title: 'Make it yours', body: "Pick an accent colour, switch light/dark, or turn on compact mode. It's saved to this device." },
    { sel: '#p-passkeys-panel', title: 'Secure your account', body: "Add a passkey for fast, passwordless verification on sensitive actions." },
    { sel: '#met-switcher-btn', title: 'Switch division', body: "Jump to any division you have access to from here." },
    { center: true, title: 'One last thing', body: "Press Ctrl/⌘ + K anywhere to jump around fast, or “?” for keyboard shortcuts. That's it — enjoy." },
  ];
  const SUPPORT = [
    { sel: '#sup-panels', title: 'Get help', body: "Pick what you need — general support, a disciplinary appeal, or a complaint. Each option asks a few quick questions to get started." },
    { sel: '#sup-mytickets', title: 'Your tickets', body: "Your open and past tickets appear here — tap one to carry on the conversation." },
    { sel: '#sup-staff-wrap', title: 'Handling tickets', body: "Claim a ticket to work it, use quick replies to save time, and close it when it's resolved.", staffOnly: true },
    { center: true, title: "You're set", body: "Send a message any time and someone from the team will pick it up. You can reopen this tour from the topbar." },
  ];
  const DASH = [
    { sel: '.nav-item[data-page]', title: 'Get around', body: "Switch between sections here. The site remembers the tab you were on if you refresh." },
    { sel: '#met-user-name,.user-name,#met-user-avatar', title: 'Your account', body: "You're signed in here — quick settings and sign-out live nearby." },
    { sel: '#met-switcher,#met-switcher-btn', title: 'Switch division', body: "Hop to another division you have access to." },
    { center: true, title: 'Handy shortcut', body: "Press Ctrl/⌘ + K to jump to any page or officer instantly, or “?” for keyboard shortcuts." },
  ];
  const GENERIC = [
    { sel: '#met-switcher,#met-switcher-btn', title: 'Switch division', body: "Move between the divisions you have access to." },
    { center: true, title: 'Shortcuts', body: "Press Ctrl/⌘ + K to jump anywhere, or “?” for keyboard shortcuts." },
  ];

  function pageKey() {
    const p = location.pathname;
    if (/\/support/.test(p)) return 'support';
    if (p === '/profile' || p === '/dashboard' || p === '/') return 'profile';
    if (/\/(cid|sco19|flp|hpc|hicomm|ia|dev)\b/.test(p)) return 'dash';
    return 'generic';
  }
  function stepsFor(k) {
    const map = { support: SUPPORT, profile: PROFILE, dash: DASH, generic: GENERIC };
    return (map[k] || GENERIC).filter(s => s.center || (document.querySelector(s.sel) && document.querySelector(s.sel).offsetParent !== null));
  }
  const seenKey = () => 'iacms_tour_seen:' + pageKey();

  // ── Walkthrough runner ─────────────────────────────────────────────
  let overlay, spot, card, steps, i;
  function cleanup() {
    window.removeEventListener('resize', place);
    window.removeEventListener('scroll', place, true);
    [overlay, spot, card].forEach(function (e) { if (e) e.remove(); });
    overlay = spot = card = null;
  }
  function place() {
    if (!card) return;
    const step = steps[i];
    const el = step.center ? null : document.querySelector(step.sel);
    if (el) {
      const r = el.getBoundingClientRect();
      spot.style.display = 'block';
      spot.style.top = (r.top - 6) + 'px'; spot.style.left = (r.left - 6) + 'px';
      spot.style.width = (r.width + 12) + 'px'; spot.style.height = (r.height + 12) + 'px';
      // place the card below the target if there's room, else above, else centre
      const cw = Math.min(340, window.innerWidth - 24), ch = card.offsetHeight || 160;
      let top = r.bottom + 12, left = Math.min(Math.max(12, r.left), window.innerWidth - cw - 12);
      if (top + ch > window.innerHeight - 12) top = Math.max(12, r.top - ch - 12);
      card.style.width = cw + 'px'; card.style.top = top + 'px'; card.style.left = left + 'px';
      card.style.transform = 'none';
    } else {
      spot.style.display = 'none';
      card.style.width = Math.min(360, window.innerWidth - 24) + 'px';
      card.style.top = '50%'; card.style.left = '50%'; card.style.transform = 'translate(-50%,-50%)';
    }
  }
  function render() {
    const step = steps[i];
    const el = step.center ? null : document.querySelector(step.sel);
    if (el) try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
    card.innerHTML =
      '<div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted,#8b93a1);margin-bottom:6px;">Tour · ' + (i + 1) + ' of ' + steps.length + '</div>' +
      '<div style="font-size:16px;font-weight:700;margin-bottom:6px;color:var(--text-primary,#fff);">' + step.title + '</div>' +
      '<div style="font-size:13px;line-height:1.6;color:var(--text-secondary,#c8d0dc);">' + step.body + '</div>' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:14px;gap:8px;">' +
        '<button id="met-tour-skip" style="background:none;border:none;color:var(--text-muted,#8b93a1);font-size:12px;cursor:pointer;">Skip tour</button>' +
        '<div style="display:flex;gap:8px;">' +
          (i > 0 ? '<button id="met-tour-back" class="btn btn-ghost btn-sm">Back</button>' : '') +
          '<button id="met-tour-next" class="btn btn-primary btn-sm">' + (i === steps.length - 1 ? 'Done' : 'Next') + '</button>' +
        '</div></div>';
    card.querySelector('#met-tour-skip').onclick = finish;
    const back = card.querySelector('#met-tour-back'); if (back) back.onclick = function () { i--; render(); };
    card.querySelector('#met-tour-next').onclick = function () { if (i === steps.length - 1) finish(); else { i++; render(); } };
    // let the DOM paint so offsetHeight is right, then position
    requestAnimationFrame(function () { requestAnimationFrame(place); });
  }
  function finish() { try { localStorage.setItem(seenKey(), '1'); } catch (e) {} cleanup(); }

  function run(list) {
    cleanup();
    steps = list; i = 0;
    if (!steps || !steps.length) { if (window.showToast) showToast('Nothing to tour on this page.', 'info'); return; }
    overlay = document.createElement('div');
    overlay.id = 'met-tour-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:12500;background:rgba(6,9,15,.55);backdrop-filter:blur(1px);';
    overlay.addEventListener('click', function (e) { if (e.target === overlay) finish(); });
    spot = document.createElement('div');
    spot.style.cssText = 'position:fixed;z-index:12501;border-radius:12px;box-shadow:0 0 0 9999px rgba(6,9,15,.62);border:2px solid var(--blue,#4a8fff);pointer-events:none;transition:all .25s ease;display:none;';
    card = document.createElement('div');
    card.style.cssText = 'position:fixed;z-index:12502;background:var(--panel-solid,#151a24);border:1px solid var(--border,#2a2f3a);border-radius:14px;box-shadow:0 24px 70px rgba(0,0,0,.5);padding:16px 18px;';
    document.body.appendChild(overlay); document.body.appendChild(spot); document.body.appendChild(card);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    render();
  }

  // ── Public API ─────────────────────────────────────────────────────
  window.metTour = {
    start: function () { run(stepsFor(pageKey())); },
    offerIfFirstVisit: function () {
      // Only auto-offer on the main dashboard and the support page — the two
      // that warrant a walkthrough. The topbar "Tour" button covers the rest.
      const k = pageKey();
      if (k !== 'profile' && k !== 'support') return;
      let seen = false; try { seen = !!localStorage.getItem(seenKey()); } catch (e) {}
      if (seen) return;
      if (!stepsFor(k).length) return;
      // A small, dismissible prompt — not a forced overlay.
      const p = document.createElement('div');
      p.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:12400;max-width:300px;background:var(--panel-solid,#151a24);border:1px solid var(--border,#2a2f3a);border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.45);padding:14px 16px;';
      p.innerHTML =
        '<div style="font-size:14px;font-weight:700;margin-bottom:4px;">New here?</div>' +
        '<div style="font-size:12px;color:var(--text-secondary,#c8d0dc);line-height:1.5;margin-bottom:10px;">Take a 30-second tour and we\'ll show you around.</div>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
          '<button id="met-tour-later" class="btn btn-ghost btn-sm">No thanks</button>' +
          '<button id="met-tour-go" class="btn btn-primary btn-sm">Show me</button></div>';
      document.body.appendChild(p);
      const close = function (markSeen) { if (markSeen) { try { localStorage.setItem(seenKey(), '1'); } catch (e) {} } p.remove(); };
      p.querySelector('#met-tour-later').onclick = function () { close(true); };
      p.querySelector('#met-tour-go').onclick = function () { close(false); window.metTour.start(); };
    },
  };

  // Offer the tour on a first visit once the page has settled.
  function boot() { setTimeout(function () { window.metTour.offerIfFirstVisit(); }, 1200); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
