// client/public/js/met-topbar.js
// Shared chrome for every division dashboard: populates the topbar's user
// avatar/name, the current-division badge, and the "Switch division" menu.
// Depends on ui.js only for nothing extra — plain fetch, so it works even on
// pages that don't load ui.js.
const DIVISION_LABEL = { CID: 'CID', SCO19: 'SCO-19', IA: 'IA', FLP: 'FLP', HPC: 'HPC' };

function metInitials(name) {
  return (name || '?').trim().slice(0, 1).toUpperCase();
}

function metEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Loading skeletons — a calmer stand-in than a bare spinner. Returns HTML in the
// shape of the content being loaded. shape: 'rows' | 'feed' | 'cards' | 'kpi'.
window.metSkeleton = function (shape, count) {
  const n = count || (shape === 'kpi' ? 4 : 5);
  const rep = (fn) => Array.from({ length: n }, (_, i) => fn(i)).join('');
  if (shape === 'kpi')   return '<div class="sk-kpi">' + rep(() => '<div class="sk-card"></div>') + '</div>';
  if (shape === 'cards') return '<div class="sk-cards">' + rep(() => '<div class="sk-card"><div class="sk sk-line" style="width:55%"></div><div class="sk sk-line" style="width:88%"></div><div class="sk sk-line" style="width:38%"></div></div>') + '</div>';
  if (shape === 'feed')  return rep(() => '<div class="sk-row"><div class="sk sk-av"></div><div class="sk-body"><div class="sk sk-line" style="width:38%"></div><div class="sk sk-line" style="width:72%"></div></div></div>');
  return rep((i) => '<div class="sk-row"><div class="sk-body"><div class="sk sk-line" style="width:' + (45 + (i * 11) % 45) + '%"></div></div></div>');
};

// A friendly empty state: icon + title + optional sub + optional CTA. A link CTA
// (href) needs no wiring; an in-page action passes onclick instead.
window.metEmpty = function (o) {
  o = o || {};
  const icon = o.icon ? `<i class="ti ${o.icon} table-empty-icon"></i>` : '';
  const title = `<div class="table-empty-text">${metEsc(o.title || 'Nothing here yet')}</div>`;
  const sub = o.sub ? `<div class="met-empty-sub">${metEsc(o.sub)}</div>` : '';
  let cta = '';
  if (o.cta && (o.href || o.onclick)) {
    const inner = `${o.ctaIcon ? `<i class="ti ${o.ctaIcon}"></i> ` : ''}${metEsc(o.cta)}`;
    cta = o.href
      ? `<a class="btn btn-primary btn-sm met-empty-cta" href="${o.href}">${inner}</a>`
      : `<button class="btn btn-primary btn-sm met-empty-cta" onclick="${o.onclick}">${inner}</button>`;
  }
  return `<div class="table-empty met-empty">${icon}${title}${sub}${cta}</div>`;
};

// A small overlapping Discord + Roblox avatar stack. Discord first, Roblox
// tucked behind it to the right. Falls back to an initial when an avatar is
// missing. `size` is the pixel diameter of each circle.
function metAvatarStack(identity, size) {
  const d = identity || {};
  const s = size || 30;
  const st = `width:${s}px;height:${s}px;`;
  const disc = d.discordAvatar
    ? `<img class="idv-av idv-disc" src="${metEsc(d.discordAvatar)}" alt="Discord" title="Discord${d.discordUsername ? ': ' + metEsc(d.discordUsername) : ''}" style="${st}">`
    : `<span class="idv-av idv-disc idv-fallback" style="${st}" title="Discord">${metEsc(metInitials(d.displayName || d.discordUsername))}</span>`;
  const rob = d.robloxAvatar
    ? `<img class="idv-av idv-rob" src="${metEsc(d.robloxAvatar)}" alt="Roblox" title="Roblox${d.robloxUsername ? ': @' + metEsc(d.robloxUsername) : ''}" style="${st}">`
    : (d.robloxUsername ? `<span class="idv-av idv-rob idv-fallback" style="${st}" title="Roblox: @${metEsc(d.robloxUsername)}">${metEsc(metInitials(d.robloxUsername))}</span>` : '');
  return `<span class="idv-stack">${disc}${rob}</span>`;
}

// Show the Roblox avatar alongside the existing Discord avatar in the topbar
// user cluster (turns the single avatar into a Discord+Roblox stack).
function metTopbarAvatars(identity) {
  const d = identity || {};
  const user = document.querySelector('.met-topbar-user');
  if (!user || !d.robloxAvatar) return;
  let rob = document.getElementById('met-user-roblox');
  if (!rob) {
    rob = document.createElement('img');
    rob.id = 'met-user-roblox';
    rob.className = 'met-user-avatar met-user-roblox';
    rob.alt = 'Roblox';
    const nameEl = document.getElementById('met-user-name');
    user.insertBefore(rob, nameEl || null);
  }
  rob.src = d.robloxAvatar;
  rob.title = 'Roblox' + (d.robloxUsername ? ': @' + d.robloxUsername : '');
  user.classList.add('has-dual');
}

// Build (once) the sidebar identity footer: dual avatars, MET server nickname
// and the rank in the division being viewed. Injected only on dashboards that
// don't already ship their own user-card footer (division dashboards).
function metSidebarIdentity(identity, currentDivision, mine) {
  const sidebar = document.querySelector('.sidebar');
  if (!sidebar || sidebar.querySelector('.user-card')) return;
  const d = identity || {};
  // The switcher/mine list keys HICOMM as METHICOMM and the dev tools as DEV.
  const KEY = { 'HIGH COMMAND': 'METHICOMM', DEVELOPER: 'DEV' };
  const divKey = KEY[currentDivision] || currentDivision;
  const entry = (mine || []).find(x => x.division === divKey);
  const rankName = entry ? (entry.rankName || entry.rankTierLabel || entry.tier || '') : '';
  const nick = d.metNickname || d.displayName || d.discordUsername || '—';
  let foot = document.getElementById('met-sidebar-id');
  if (!foot) {
    foot = document.createElement('div');
    foot.id = 'met-sidebar-id';
    foot.className = 'sidebar-bottom sidebar-user';
    sidebar.appendChild(foot);
  }
  foot.innerHTML = `
    <div class="sidebar-divider"></div>
    <div class="siu-card">
      ${metAvatarStack(d, 36)}
      <div class="siu-info">
        <div class="siu-name" title="${metEsc(nick)}">${metEsc(nick)}</div>
        <div class="siu-meta">
          ${rankName ? `<span class="siu-rank">${metEsc(rankName)}</span>` : ''}
          ${d.robloxUsername ? `<span class="siu-sub">@${metEsc(d.robloxUsername)}</span>` : ''}
        </div>
      </div>
    </div>`;
}

// ── Tab title + favicon, matched to the current division ─────────────
// Title: "MET Dashboard" (misc) or "MET Dashboard - CID" (a division). Favicon:
// the division's icon (else the MET icon), rounded on a canvas so it looks neat
// in the browser tab. Falls back to the raw image if canvas is unavailable.
const CHROME_ICON = { CID: 'cid', SCO19: 'sco19', HPC: 'hpc', FLP: 'flp', IA: 'ia', DEVELOPER: 'dev', 'HIGH COMMAND': 'met', SECURITY: 'met' };
const CHROME_TITLE = { CID: 'CID', SCO19: 'SCO-19', HPC: 'HPC', FLP: 'FLP', IA: 'Internal Affairs', DEVELOPER: 'Developer', 'HIGH COMMAND': 'High Command', SECURITY: 'Security' };

function metApplyFavicon(href, isData) {
  let link = document.querySelector('link[rel="icon"]');
  if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
  if (isData) link.type = 'image/png';
  link.href = href;
}

function metRoundedFavicon(src) {
  try {
    const img = new Image();
    img.onload = function () {
      try {
        const S = 64, r = 14;
        const c = document.createElement('canvas'); c.width = S; c.height = S;
        const ctx = c.getContext('2d');
        ctx.beginPath();
        ctx.moveTo(r, 0); ctx.arcTo(S, 0, S, S, r); ctx.arcTo(S, S, 0, S, r);
        ctx.arcTo(0, S, 0, 0, r); ctx.arcTo(0, 0, S, 0, r); ctx.closePath();
        ctx.clip();
        ctx.drawImage(img, 0, 0, S, S);
        metApplyFavicon(c.toDataURL('image/png'), true);
      } catch (e) { metApplyFavicon(src, false); } // canvas tainted/unsupported → raw
    };
    img.onerror = function () { metApplyFavicon(src, false); };
    img.src = src;
  } catch (e) { metApplyFavicon(src, false); }
}

function setSiteChrome(division) {
  const label = CHROME_TITLE[division] || '';
  document.title = 'MET Dashboard' + (label ? ' - ' + label : '');
  const key = CHROME_ICON[division] || 'met';
  const ext = key === 'dev' ? 'svg' : 'png';
  metRoundedFavicon('/img/divisions/' + key + '.' + ext);
}
if (typeof window !== 'undefined') window.setSiteChrome = setSiteChrome;

// Load the tour engine on any page with the topbar (offers the tour once on a
// first visit; the topbar "Tour" button re-runs it any time).
if (typeof document !== 'undefined' && !window.metTour && !document.getElementById('met-tour-engine')) {
  var _tourScript = document.createElement('script');
  _tourScript.id = 'met-tour-engine'; _tourScript.src = '/js/tutorial.js'; _tourScript.defer = true;
  document.head.appendChild(_tourScript);
}

// ── Breadcrumb: "Division › Section" in the topbar ─────────────────────────
// The Section tracks the active sidebar nav item live (dashboards toggle the
// .active class on nav-items when switching pages), via a MutationObserver.
function metInjectBreadcrumb(currentDivision) {
  const titleEl = document.querySelector('.met-topbar-left .met-topbar-title');
  if (!titleEl || document.getElementById('met-breadcrumb')) return;
  const badge = document.getElementById('met-division-badge');
  const div = (badge && badge.textContent) || DIVISION_LABEL[currentDivision] || currentDivision || '';
  const bc = document.createElement('nav');
  bc.id = 'met-breadcrumb'; bc.className = 'met-breadcrumb'; bc.setAttribute('aria-label', 'Breadcrumb');
  bc.innerHTML = `<span class="bc-div">${metEsc(div)}</span><i class="ti ti-chevron-right bc-sep"></i><span class="bc-section" id="met-bc-section"></span>`;
  titleEl.insertAdjacentElement('afterend', bc);
  const sectionEl = document.getElementById('met-bc-section');
  const syncSection = () => {
    const a = document.querySelector('.sidebar-nav .nav-item.active span:not(.nav-badge):not(.nav-tag)');
    const s = a ? a.textContent.trim() : '';
    sectionEl.textContent = s;
    bc.classList.toggle('has-section', !!s);
  };
  syncSection();
  const nav = document.querySelector('.sidebar-nav');
  if (nav && window.MutationObserver) {
    const mo = new MutationObserver(syncSection);
    mo.observe(nav, { subtree: true, attributes: true, attributeFilter: ['class'] });
  }
}

// ── Mobile nav drawer: a hamburger in the topbar turns the sidebar into an
// off-canvas drawer under 640px (see dashboard.css). Injected centrally. ──
function metInjectNavToggle() {
  const left = document.querySelector('.met-topbar-left');
  const layout = document.querySelector('.app-layout');
  if (!left || !layout) return;
  if (!document.getElementById('met-nav-toggle')) {
    const h = document.createElement('button');
    h.id = 'met-nav-toggle'; h.className = 'met-nav-toggle btn btn-icon btn-ghost';
    h.setAttribute('aria-label', 'Open menu'); h.setAttribute('aria-expanded', 'false');
    h.innerHTML = '<i class="ti ti-menu-2"></i>';
    left.insertBefore(h, left.firstChild);
    const closeNav = () => { layout.classList.remove('nav-open'); document.body.classList.remove('nav-locked'); h.setAttribute('aria-expanded', 'false'); };
    const openNav  = () => { layout.classList.add('nav-open'); document.body.classList.add('nav-locked'); h.setAttribute('aria-expanded', 'true'); };
    h.addEventListener('click', (e) => { e.stopPropagation(); layout.classList.contains('nav-open') ? closeNav() : openNav(); });
    if (!layout.querySelector('.sidebar-scrim')) {
      const s = document.createElement('div'); s.className = 'sidebar-scrim';
      layout.appendChild(s); s.addEventListener('click', closeNav);
    }
    // Close after picking a page, and on Escape.
    const sidebar = document.querySelector('.sidebar');
    if (sidebar) sidebar.addEventListener('click', (e) => { if (e.target.closest('.nav-item')) closeNav(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeNav(); });
  }
}

// ── Live support chat launcher: a floating button in the bottom-left corner that
// opens a small card offering to start a support chat. Redundant on /support, so
// it's skipped there. ──
function metInjectSupportChat() {
  if (/^\/support/.test(location.pathname)) return;   // already on the chat
  if (!document.querySelector('.met-topbar')) return; // portal-chrome pages only
  if (document.getElementById('met-chat-fab')) return;

  const fab = document.createElement('button');
  fab.id = 'met-chat-fab'; fab.type = 'button'; fab.className = 'met-chat-fab';
  fab.setAttribute('aria-label', 'Live support chat'); fab.setAttribute('aria-expanded', 'false');
  fab.title = 'Live support chat · drag to move';
  fab.innerHTML = '<i class="ti ti-message-chatbot"></i>';
  document.body.appendChild(fab);

  const pop = document.createElement('div');
  pop.id = 'met-chat-pop'; pop.className = 'met-chat-pop'; pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', 'MET Support');
  pop.innerHTML =
    '<div class="met-chat-head">' +
      '<span class="met-chat-title"><i class="ti ti-headset"></i> MET Support</span>' +
      '<button class="met-chat-x" type="button" aria-label="Close" title="Close"><i class="ti ti-x"></i></button>' +
    '</div>' +
    '<div class="met-chat-body">Need a hand? Open a support ticket and chat with our team in real time — you’ll get live replies and can attach screenshots.</div>' +
    '<a class="btn btn-primary btn-sm met-chat-cta" href="/support"><i class="ti ti-message-2"></i> Start a support chat</a>' +
    '<a class="met-chat-alt" href="/support">View my tickets</a>';
  document.body.appendChild(pop);

  const close = () => { pop.classList.remove('open'); fab.classList.remove('active'); fab.setAttribute('aria-expanded', 'false'); };

  // ── Draggable + snap: free-drag, then snap to the nearest edge/corner anchor
  // (4 corners + 4 edge midpoints), remembered per browser. ──
  const SNAP_M = 18; // margin from the viewport edges
  function applyPos(left, top) {
    const w = fab.offsetWidth || 62, h = fab.offsetHeight || 62;
    left = Math.max(6, Math.min(left, window.innerWidth - w - 6));
    top  = Math.max(6, Math.min(top, window.innerHeight - h - 6));
    fab.style.left = left + 'px'; fab.style.top = top + 'px';
    fab.style.right = 'auto'; fab.style.bottom = 'auto';
  }
  function anchorPoints() {
    const w = fab.offsetWidth || 62, h = fab.offsetHeight || 62;
    const maxL = Math.max(SNAP_M, window.innerWidth - w - SNAP_M);
    const maxT = Math.max(SNAP_M, window.innerHeight - h - SNAP_M);
    const midL = Math.round((window.innerWidth - w) / 2);
    const midT = Math.round((window.innerHeight - h) / 2);
    return [
      { k: 'tl', left: SNAP_M, top: SNAP_M }, { k: 'tc', left: midL, top: SNAP_M }, { k: 'tr', left: maxL, top: SNAP_M },
      { k: 'rm', left: maxL, top: midT }, { k: 'lm', left: SNAP_M, top: midT },
      { k: 'bl', left: SNAP_M, top: maxT }, { k: 'bc', left: midL, top: maxT }, { k: 'br', left: maxL, top: maxT },
    ];
  }
  function applyAnchor(key, animate) {
    const pts = anchorPoints();
    const p = pts.find(a => a.k === key) || pts.find(a => a.k === 'br');
    if (animate) { fab.style.transition = 'left .24s cubic-bezier(.2,.7,.3,1), top .24s cubic-bezier(.2,.7,.3,1)'; setTimeout(() => { fab.style.transition = ''; }, 280); }
    applyPos(p.left, p.top);
    savedAnchor = p.k;
  }
  function nearestAnchor() {
    const r = fab.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2, w = r.width, h = r.height;
    let best = 'br', bd = Infinity;
    for (const p of anchorPoints()) {
      const d = Math.pow(p.left + w / 2 - cx, 2) + Math.pow(p.top + h / 2 - cy, 2);
      if (d < bd) { bd = d; best = p.k; }
    }
    return best;
  }
  let savedAnchor = 'br';
  try { const k = localStorage.getItem('met_chat_anchor'); if (k) savedAnchor = k; } catch (e) {}
  // Position on the saved anchor once the FAB has a measured size.
  requestAnimationFrame(() => applyAnchor(savedAnchor, false));
  window.addEventListener('resize', () => applyAnchor(savedAnchor, false));

  // Anchor the popup next to the FAB's current spot (above if there's room,
  // else below; aligned to whichever side of the screen the FAB sits on).
  function positionPop() {
    const r = fab.getBoundingClientRect();
    const pw = pop.offsetWidth || 300, ph = pop.offsetHeight || 190, gap = 12;
    let top = r.top - ph - gap;
    if (top < 8) top = Math.min(r.bottom + gap, window.innerHeight - ph - 8);
    let left = (r.left + r.width / 2 > window.innerWidth / 2) ? (r.right - pw) : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
    top  = Math.max(8, Math.min(top, window.innerHeight - ph - 8));
    pop.style.left = left + 'px'; pop.style.top = top + 'px'; pop.style.right = 'auto'; pop.style.bottom = 'auto';
  }
  const openPop = () => { positionPop(); pop.classList.add('open'); fab.classList.add('active'); fab.setAttribute('aria-expanded', 'true'); };

  let dragging = false, moved = false, ox = 0, oy = 0, sx = 0, sy = 0;
  fab.addEventListener('pointerdown', (e) => {
    if (e.button && e.button !== 0) return;
    dragging = true; moved = false;
    const r = fab.getBoundingClientRect();
    ox = e.clientX - r.left; oy = e.clientY - r.top; sx = e.clientX; sy = e.clientY;
    try { fab.setPointerCapture(e.pointerId); } catch (x) {}
  });
  fab.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    if (!moved && (Math.abs(e.clientX - sx) > 4 || Math.abs(e.clientY - sy) > 4)) {
      moved = true; fab.classList.add('dragging'); close();
    }
    if (moved) applyPos(e.clientX - ox, e.clientY - oy);
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false; fab.classList.remove('dragging');
    try { fab.releasePointerCapture(e.pointerId); } catch (x) {}
    if (moved) {
      const key = nearestAnchor();
      applyAnchor(key, true);   // smooth snap to the nearest edge/corner
      try { localStorage.setItem('met_chat_anchor', key); } catch (x) {}
    }
  };
  fab.addEventListener('pointerup', endDrag);
  fab.addEventListener('pointercancel', endDrag);
  // A tap (no drag) toggles the popup; a click that ended a drag is ignored.
  fab.addEventListener('click', (e) => {
    e.stopPropagation();
    if (moved) { moved = false; return; }
    pop.classList.contains('open') ? close() : openPop();
  });

  pop.querySelector('.met-chat-x').addEventListener('click', close);
  document.addEventListener('click', (e) => { if (pop.classList.contains('open') && !pop.contains(e.target) && !fab.contains(e.target)) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}

// ── Back-to-top: appears on the scrolling content once you're down the page. ──
function metInjectBackToTop() {
  const main = document.querySelector('.main-content');
  if (!main || document.getElementById('met-to-top')) return;
  const btn = document.createElement('button');
  btn.id = 'met-to-top'; btn.className = 'met-to-top'; btn.type = 'button';
  btn.setAttribute('aria-label', 'Back to top'); btn.title = 'Back to top';
  btn.innerHTML = '<i class="ti ti-arrow-up"></i>';
  document.body.appendChild(btn);
  // Whichever element actually scrolls (main-content usually; body as a fallback).
  const scroller = main.scrollHeight > main.clientHeight + 40 ? main : (document.scrollingElement || document.documentElement);
  const onScroll = () => { btn.classList.toggle('show', (scroller.scrollTop || 0) > 400); };
  scroller.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('scroll', onScroll, { passive: true });
  btn.addEventListener('click', () => { try { scroller.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { scroller.scrollTop = 0; } });
  onScroll();
}

async function initMetTopbar(currentDivision) {
  setSiteChrome(currentDivision);
  const badge = document.getElementById('met-division-badge');
  // Leave the badge's markup as-is on pages with no specific division (e.g. the
  // profile page sets its own label in HTML).
  if (badge && currentDivision) badge.textContent = DIVISION_LABEL[currentDivision] || currentDivision;

  let examEligible = false;  // holds the final-exam role → show the Final Exam menu entry
  let hasIADivision = false; // IA-division access → show the Support Desk pill
  try {
    const me = await fetch('/api/me', { credentials: 'include' }).then(r => r.ok ? r.json() : null);
    if (me) {
      examEligible = !!me.examEligible;
      const nameEl = document.getElementById('met-user-name');
      if (nameEl) nameEl.textContent = me.displayName || me.discordUsername;

      const avatarImg = document.getElementById('met-user-avatar');
      const avatarFallback = document.getElementById('met-user-avatar-fallback');
      if (me.discordAvatar && avatarImg) {
        avatarImg.src = me.discordAvatar;
        avatarImg.style.display = '';
        if (avatarFallback) avatarFallback.style.display = 'none';
      } else if (avatarFallback) {
        avatarFallback.textContent = metInitials(me.displayName || me.discordUsername);
      }
    }
  } catch (e) { /* topbar is cosmetic — never block the page on it */ }

  try {
    const data = await fetch('/api/me/divisions', { credentials: 'include' }).then(r => r.ok ? r.json() : null);
    hasIADivision = !!(data && Array.isArray(data.mine) && data.mine.some(d => d.division === 'IA'));
    if (data && data.identity) {
      try { metTopbarAvatars(data.identity); } catch (e) {}
      try { metSidebarIdentity(data.identity, currentDivision, data.mine || []); } catch (e) {}
    }
    const menu = document.getElementById('met-switcher-menu');
    if (data && menu) {
      const mine = data.mine || [];
      // A header makes it obvious this list is the divisions THIS user can enter.
      menu.innerHTML = mine.length
        ? '<div class="met-menu-label">Divisions you can access</div>'
        : '<div class="met-menu-empty">No other divisions yet</div>';
      mine.forEach(d => {
        const a = document.createElement('a');
        const isCurrent = d.division === currentDivision;
        a.href = `/${d.slug}/dashboard`;
        a.className = 'met-switcher-item' + (isCurrent ? ' current' : '');
        const tag = isCurrent ? 'current' : (d.rankName || d.tier || '');
        a.innerHTML = `<span>${d.name}</span><span class="rank-tag">${tag}</span>`;
        menu.appendChild(a);
      });
    }
  } catch (e) { /* non-fatal */ }

  // "You're here" highlight for the current page's topbar control.
  const HERE = location.pathname.replace(/\/$/, '') || '/';
  function markHere(el) {
    if (!el) return;
    el.style.background = 'rgba(74,143,255,0.14)';
    el.style.color = 'var(--blue,#4a8fff)';
    el.title = (el.title ? el.title + ' — ' : '') + "You're here";
  }

  const right = document.querySelector('.met-topbar-right');

  // Breadcrumb (Division › Section), mobile nav drawer + back-to-top — injected
  // centrally so every dashboard gets them without per-view markup.
  try { metInjectBreadcrumb(currentDivision); } catch (e) {}
  try { metInjectNavToggle(); } catch (e) {}
  try { metInjectBackToTop(); } catch (e) {}
  try { metInjectSupportChat(); } catch (e) {}

  // Decluttered topbar: instead of a flat row of ~7 loose buttons, the right side
  // reads as a few obvious GROUPS — [Search] · [Menu ▾] (navigation + personal
  // pages + help, all folded in) · [Switch Division ▾] · (IA) Support Desk pill ·
  // profile · Sign out. My Dashboard / Support / Tour now live inside Menu.
  try {
    if (right && !document.getElementById('met-pages')) {
      const switcherEl = document.getElementById('met-switcher');

      const GROUPS = [
        // "My Dashboard" is a dedicated top-level button now (added below), so it's
        // not repeated here.
        { label: 'Navigate', items: [
          { href: '/support',   icon: 'ti-lifebuoy',         label: 'Support' },
        ] },
        { label: 'You', items: [
          { href: '/loa', icon: 'ti-calendar-off', label: 'Leave of Absence' },
          // Final Exam only appears for cadets who hold the final-exam role.
          ...(examEligible ? [{ href: '/exam', icon: 'ti-writing', label: 'Final Exam' }] : []),
          { href: '/app', icon: 'ti-device-mobile', label: 'Mobile App' },
        ] },
      ];
      const isHere = (it) => (it.match || [it.href]).some(h => h === HERE);
      const onSupport = /^\/support/.test(location.pathname);
      const menuHtml =
        GROUPS.map(g =>
          `<div class="met-menu-label">${g.label}</div>` +
          g.items.map(it => `<a href="${it.href}" class="met-switcher-item${isHere(it) ? ' current' : ''}"><span><i class="ti ${it.icon}"></i> ${it.label}</span></a>`).join('')
        ).join('') +
        '<div class="met-menu-label">Help</div>' +
        `<a class="met-switcher-item" data-act="tour"><span><i class="ti ti-help-circle"></i> ${onSupport ? 'How support works' : 'Take a tour'}</span></a>`;

      // Menu dropdown — reuses the switcher's markup + CSS.
      const wrap = document.createElement('div');
      wrap.className = 'met-switcher';
      wrap.id = 'met-pages';
      wrap.innerHTML =
        '<button class="btn btn-ghost btn-sm" id="met-pages-btn" title="Menu — dashboard, support, your pages & tour"><i class="ti ti-menu-2"></i> Menu</button>' +
        '<div class="met-switcher-menu met-menu-wide">' + menuHtml + '</div>';
      if (switcherEl) right.insertBefore(wrap, switcherEl); else right.appendChild(wrap);
      const pBtn = wrap.querySelector('#met-pages-btn');
      pBtn.addEventListener('click', (e) => { e.stopPropagation(); closeOtherDropdowns(wrap); wrap.classList.toggle('open'); });
      document.addEventListener('click', () => wrap.classList.remove('open'));
      // Tour is an action (not a link) inside the menu — lazy-load the engine.
      const tourItem = wrap.querySelector('[data-act="tour"]');
      if (tourItem) tourItem.addEventListener('click', (e) => {
        e.preventDefault(); wrap.classList.remove('open');
        if (window.metTour) return window.metTour.start();
        const s = document.createElement('script'); s.src = '/js/tutorial.js';
        s.onload = function () { if (window.metTour) window.metTour.start(); };
        document.head.appendChild(s);
      });
      const allHrefs = GROUPS.reduce((a, g) => a.concat(g.items.reduce((b, it) => b.concat(it.match || [it.href]), [])), []);
      if (allHrefs.indexOf(HERE) >= 0) markHere(pBtn);

      // Live unclaimed-ticket counter — a topbar pill that only appears for IA
      // staff (the queue endpoint 403s for everyone else) and PULSES when the
      // count goes up (a new ticket landed). Refreshed on 'support_open' SSE
      // events (events-client.js calls loadSupportBadge) and every 60s.
      window.loadSupportBadge = async function () {
        // Support Desk is IA-division only — never for other divisions or signed-out.
        if (!hasIADivision) { const ex = document.getElementById('met-support-pill'); if (ex) ex.remove(); return; }
        let rows;
        try { rows = await fetch('/api/support/tickets/queue?unclaimed=1', { credentials: 'include' }).then(r => r.ok ? r.json() : null); }
        catch (e) { return; }
        if (!Array.isArray(rows)) return; // non-staff / not signed in
        const n = rows.length;
        let pill = document.getElementById('met-support-pill');
        if (!pill) {
          pill = document.createElement('a');
          pill.id = 'met-support-pill';
          pill.href = '/ia/dashboard?page=support-tickets';
          pill.className = 'btn btn-ghost btn-sm';
          pill.title = 'Support Desk (Internal Affairs) · unclaimed tickets';
          pill.innerHTML = '<i class="ti ti-headset"></i> Support Desk (IA) <span id="met-support-badge" style="min-width:18px;height:18px;margin-left:4px;padding:0 5px;border-radius:9px;background:var(--red,#e0503a);color:#fff;font-size:11px;font-weight:700;display:none;align-items:center;justify-content:center;">0</span>';
          right.insertBefore(pill, right.firstChild);
        }
        const badge = document.getElementById('met-support-badge');
        const prev = parseInt(badge.getAttribute('data-n'), 10) || 0;
        badge.setAttribute('data-n', n);
        badge.textContent = n;
        badge.style.display = n ? 'inline-flex' : 'none';
        if (n > prev && badge.animate) badge.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.45)' }, { transform: 'scale(1)' }], { duration: 520 });
      };
      window.loadSupportBadge();
      setInterval(() => window.loadSupportBadge(), 60000);

      // Search (⌘K / Ctrl-K) — the leftmost control in the group. Always shown;
      // if the command palette isn't loaded on this page yet, it's fetched on
      // demand so search works everywhere.
      if (!document.getElementById('met-cmdk-btn')) {
        const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
        const sBtn = document.createElement('button');
        sBtn.id = 'met-cmdk-btn';
        sBtn.className = 'btn btn-ghost btn-sm';
        sBtn.title = 'Search (' + (isMac ? '⌘K' : 'Ctrl + K') + ')';
        sBtn.innerHTML = `<i class="ti ti-search"></i> <span style="margin:0 2px;">Search</span> <span class="cmdk-kbd" style="opacity:.6;font-size:11px;">${isMac ? '⌘K' : 'Ctrl + K'}</span>`;
        sBtn.addEventListener('click', function () {
          if (typeof window.openCommandPalette === 'function') return window.openCommandPalette();
          const s = document.createElement('script'); s.src = '/js/command-palette.js';
          s.onload = function () { if (typeof window.openCommandPalette === 'function') window.openCommandPalette(); };
          document.head.appendChild(s);
        });
        right.insertBefore(sBtn, right.firstChild);
      }

      // Dashboard "home" button — a persistent, obvious way back to your own
      // dashboard from anywhere. Kept as the leftmost top-level control (not buried
      // in the Menu) and highlighted when you're already on it.
      if (!document.getElementById('met-dash-btn')) {
        const dBtn = document.createElement('a');
        dBtn.id = 'met-dash-btn';
        dBtn.href = '/dashboard';
        dBtn.className = 'btn btn-ghost btn-sm';
        dBtn.title = 'Go to your dashboard';
        dBtn.innerHTML = '<i class="ti ti-home"></i> Dashboard';
        right.insertBefore(dBtn, right.firstChild);
        if (HERE === '/dashboard' || HERE === '/profile') markHere(dBtn);
      }
    }
  } catch (e) { /* cosmetic */ }

  // Wire the division switcher (markup-based) + highlight it on a division page.
  const switcher = document.getElementById('met-switcher');
  const switcherBtn = document.getElementById('met-switcher-btn');
  if (switcher && switcherBtn) {
    // Make it obvious this jumps between the divisions the user belongs to.
    switcherBtn.innerHTML = '<i class="ti ti-arrows-left-right"></i> My Divisions <i class="ti ti-chevron-down" style="font-size:13px;opacity:.6;"></i>';
    switcherBtn.title = 'Switch to another division you have access to';
    if (currentDivision) markHere(switcherBtn);
    switcherBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeOtherDropdowns(switcher);
      switcher.classList.toggle('open');
    });
    document.addEventListener('click', () => switcher.classList.remove('open'));
  }

  // On long sidebars, make sure the active nav item is visible on load.
  try { const a = document.querySelector('.sidebar-nav .nav-item.active'); if (a) a.scrollIntoView({ block: 'nearest' }); } catch (e) {}
}

// Close every topbar dropdown except the one passed in, so only one of the
// Menu / Switch Division selectors is open at a time.
function closeOtherDropdowns(except) {
  document.querySelectorAll('.met-switcher.open').forEach(s => { if (s !== except) s.classList.remove('open'); });
}
