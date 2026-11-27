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
  // Faint strap-line watermark on the fuller (sub-carrying) empty states.
  const strap = '';
return `<div class="table-empty met-empty">${icon}${title}${sub}${cta}${strap}</div>`;
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
  const KEY = { 'HIGH COMMAND': 'METHICOMM', DEVELOPER: 'DEV' };
  const divKey = KEY[currentDivision] || currentDivision;
  const entry = (mine || []).find(x => x.division === divKey);
  const rankName = entry ? (entry.rankName || entry.rankTierLabel || entry.tier || '') : '';
  const nick = d.metNickname || d.displayName || d.discordUsername || d.robloxUsername || 'Account';
  const avatar = d.discordAvatar || d.robloxAvatar || '';
  const initials = metInitials(nick);
  const profileAccount = sidebar.querySelector('.profile-sidebar-account');
  const identityCard = `
    <div class="met-sidebar-identity" style="display:flex;align-items:center;gap:10px;width:100%;max-width:100%;min-width:0;box-sizing:border-box;padding:10px 12px;">
      ${avatar
        ? `<img src="${metEsc(avatar)}" alt="" style="width:36px;height:36px;flex:0 0 36px;border-radius:50%;object-fit:cover;border:1px solid var(--border-dim);" />`
        : `<span aria-hidden="true" style="width:36px;height:36px;flex:0 0 36px;border-radius:50%;display:grid;place-items:center;background:var(--surface-2,rgba(127,140,155,.16));color:var(--text-primary);font-size:13px;font-weight:650;">${metEsc(initials)}</span>`}
      <span style="display:block;flex:1 1 0;width:0;max-width:100%;min-width:0;overflow:hidden;">
        <span style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-primary);font-size:12px;font-weight:650;" title="${metEsc(nick)}">${metEsc(nick)}</span>
        <span style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-muted);font-size:10px;margin-top:3px;">${metEsc(rankName || (d.robloxUsername ? '@' + d.robloxUsername : d.discordUsername || 'Signed in'))}</span>
      </span>
    </div>`;
  if (profileAccount) {
    if (!profileAccount.querySelector('.met-sidebar-identity')) {
      profileAccount.insertAdjacentHTML('afterbegin', identityCard);
    }
    const label = profileAccount.querySelector('.profile-sidebar-account-label');
    if (label) label.remove();
    return;
  }
  let foot = document.getElementById('met-sidebar-id');
  if (!foot) {
    foot = document.createElement('div');
    foot.id = 'met-sidebar-id';
    foot.className = 'sidebar-bottom sidebar-user';
    sidebar.appendChild(foot);
  }
  foot.innerHTML = '<div class="sidebar-divider"></div>' + identityCard;
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

// ── Back navigation: dashboard tabs are recorded as browser-history entries.
function metInjectHomeLink() {
  const nav = document.querySelector('.app-layout .sidebar .sidebar-nav');
  if (!nav || nav.querySelector('.met-back-link')) return;
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'nav-item met-back-link';
  back.setAttribute('aria-label', 'Go back to the previous page or tab');
  back.innerHTML = '<i class="ti ti-arrow-left nav-icon" aria-hidden="true"></i><span>Back</span>';
  back.addEventListener('click', () => {
    const ref = document.referrer;
    let sameSiteReferrer = false;
    try { sameSiteReferrer = !!ref && new URL(ref).origin === location.origin; } catch (e) {}
    const state = history.state || {};
    if (state.metDivisionTab && state.tabEntry) {
      history.back();
    } else if (sameSiteReferrer && history.length > 1) {
      history.back();
    } else {
      location.assign('/profile');
    }
  });
  nav.insertBefore(back, nav.firstChild);
}

function metInitSidebarHistory() {
  const nav = document.querySelector('.app-layout .sidebar .sidebar-nav');
  if (!nav || nav.dataset.historyReady === '1') return;
  nav.dataset.historyReady = '1';
  const marker = 'metDivisionTab';
  const active = nav.querySelector('.nav-item[data-page].active');
  const initialPage = active ? active.dataset.page : 'dashboard';
  history.replaceState({ ...(history.state || {}), [marker]: true, page: initialPage, tabEntry: false }, '', location.href);
  let restoring = false;
  nav.addEventListener('click', (event) => {
    const button = event.target.closest('.nav-item[data-page]');
    if (!button || restoring) return;
    if (history.state && history.state[marker] && history.state.page === button.dataset.page) return;
    history.pushState({ ...(history.state || {}), [marker]: true, page: button.dataset.page, tabEntry: true }, '', location.href);
  }, true);
  window.addEventListener('popstate', (event) => {
    const state = event.state;
    if (!state || !state[marker] || !state.page) return;
    const button = nav.querySelector('.nav-item[data-page="' + CSS.escape(state.page) + '"]');
    if (!button) return;
    restoring = true;
    button.click();
    restoring = false;
  });
}

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

// ── Mobile nav drawer for TOPBAR-ONLY pages (member Dashboard, LOA, Exam,
// App) — pages with a real .app-layout sidebar are handled by
// metInjectNavToggle above and are skipped here. Gives phones a proper slide-out
// menu (My Dashboard, the divisions you can enter, LOA, Exam, App,
// Sign out) instead of only the cramped topbar dropdowns. ──
const DIV_ICON = { CID: 'ti-search', SCO19: 'ti-target-arrow', IA: 'ti-scale', FLP: 'ti-shield', HPC: 'ti-school', DEV: 'ti-code', METHICOMM: 'ti-star' };
function metInjectMobileNav(mine, currentDivision) {
  const topbar = document.querySelector('.met-topbar');
  const left = document.querySelector('.met-topbar-left');
  // Skip pages that already have a sidebar drawer (division/dev dashboards).
  if (!topbar || !left) return;
  if (document.querySelector('.app-layout .sidebar')) return;
  if (document.getElementById('met-mnav')) return;

  const here = (location.pathname.replace(/\/$/, '') || '/');
  const item = (href, icon, label, cur) =>
    `<a href="${href}" class="met-mnav-item${cur ? ' current' : ''}"><i class="ti ${icon}"></i><span>${metEsc(label)}</span></a>`;

  const divLinks = (mine || []).map(d => {
    const slug = d.slug || String(d.division || '').toLowerCase();
    const icon = DIV_ICON[d.division] || 'ti-shield-half';
    const tag = d.rankName || d.tier || '';
    return `<a href="/${slug}/dashboard" class="met-mnav-item"><i class="ti ${icon}"></i><span>${metEsc(d.name || d.division)}</span>${tag ? `<span class="met-mnav-tag">${metEsc(tag)}</span>` : ''}</a>`;
  }).join('');

  const drawer = document.createElement('nav');
  drawer.id = 'met-mnav'; drawer.className = 'met-mnav';
  drawer.setAttribute('aria-label', 'Menu');
  drawer.innerHTML =
    '<div class="met-mnav-head"><div class="met-splash-crest met-mnav-crest"><span class="met-splash-crest-txt">MET</span>'
      + '<img src="/img/divisions/met.png" alt="" onerror="this.remove()"></div>'
      + '<div class="met-mnav-title">Metropolitan Police<span>Navigation</span></div>'
      + '<button class="met-mnav-x" type="button" aria-label="Close"><i class="ti ti-x"></i></button></div>'
    + '<div class="met-mnav-list">'
      + '<div class="met-mnav-label">Home</div>'
      + item('/dashboard', 'ti-home', 'My Dashboard', here === '/dashboard' || here === '/profile')
      + (divLinks ? '<div class="met-mnav-label">Divisions you can access</div>' + divLinks : '')
      + '<div class="met-mnav-label">You</div>'
      + item('/app', 'ti-device-mobile', 'Mobile App', here === '/app')
    + '</div>'
    + '<form class="met-mnav-foot" action="/auth/logout" method="POST">'
      + '<button type="submit" class="met-mnav-signout"><i class="ti ti-logout"></i> Sign out</button></form>';

  const scrim = document.createElement('div');
  scrim.className = 'met-mnav-scrim';

  const hb = document.createElement('button');
  hb.id = 'met-mnav-toggle'; hb.className = 'met-nav-toggle btn btn-icon btn-ghost';
  hb.type = 'button'; hb.setAttribute('aria-label', 'Open menu'); hb.setAttribute('aria-expanded', 'false');
  hb.innerHTML = '<i class="ti ti-menu-2"></i>';
  left.insertBefore(hb, left.firstChild);

  document.body.appendChild(drawer);
  document.body.appendChild(scrim);

  const open  = () => { drawer.classList.add('open'); scrim.classList.add('open'); document.body.classList.add('nav-locked'); hb.setAttribute('aria-expanded', 'true'); };
  const close = () => { drawer.classList.remove('open'); scrim.classList.remove('open'); document.body.classList.remove('nav-locked'); hb.setAttribute('aria-expanded', 'false'); };
  hb.addEventListener('click', (e) => { e.stopPropagation(); drawer.classList.contains('open') ? close() : open(); });
  scrim.addEventListener('click', close);
  drawer.querySelector('.met-mnav-x').addEventListener('click', close);
  drawer.addEventListener('click', (e) => { if (e.target.closest('.met-mnav-item')) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}

function metInjectBackToTop() { /* consolidated into ui.js */ }

async function initMetTopbar(currentDivision) {
  setSiteChrome(currentDivision);
  const badge = document.getElementById('met-division-badge');
  // Leave the badge's markup as-is on pages with no specific division (e.g. the
  // profile page sets its own label in HTML).
  if (badge && currentDivision) badge.textContent = DIVISION_LABEL[currentDivision] || currentDivision;

  let hasIADivision = false; // IA-division access
  let myDivisions = [];      // the divisions this user can enter (for the mobile nav drawer)
  try {
    const me = await fetch('/api/me', { credentials: 'include' }).then(r => r.ok ? r.json() : null);
    if (me) {
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
    myDivisions = (data && Array.isArray(data.mine)) ? data.mine : [];
    // The current division page gets a first-position sidebar switcher only
    // when the account has at least one OTHER division available.
    const sidebarDivisionLink = document.querySelector('.sidebar-nav a[href="/profile#divisions"]');
    if (sidebarDivisionLink && currentDivision) {
      const others = myDivisions.filter(d => String(d.division) !== String(currentDivision));
      if (!others.length) sidebarDivisionLink.remove();
      else {
        const label = sidebarDivisionLink.querySelector('span');
        if (label) label.textContent = 'Switch Divisions';
        const nav = sidebarDivisionLink.closest('.sidebar-nav');
        if (nav) nav.insertBefore(sidebarDivisionLink, nav.firstChild);
      }
    }
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
        // A dot in the division's own accent, so the menu reads as a colour key
        // for the themes you land in. Anything but a plain hex is ignored.
        const accent = /^#[0-9a-f]{6}$/i.test(d.accent || '') ? d.accent : null;
        const dot = accent
          ? `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${accent};margin-right:7px;vertical-align:middle;"></span>`
          : '';
        a.innerHTML = `<span>${dot}${d.name}</span><span class="rank-tag">${tag}</span>`;
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
    el.title = (el.title ? el.title + ' · ' : '') + "You're here";
  }

  const right = document.querySelector('.met-topbar-right');

  // Breadcrumb (Division › Section), mobile nav drawer + back-to-top — injected
  // centrally so every dashboard gets them without per-view markup.
  try { metInjectHomeLink(); } catch (e) {}
  try { metInitSidebarHistory(); } catch (e) {}
  try { metInjectBreadcrumb(currentDivision); } catch (e) {}
  try { metInjectNavToggle(); } catch (e) {}
  try { metInjectMobileNav(myDivisions, currentDivision); } catch (e) {}
  try { metInjectBackToTop(); } catch (e) {}
  try { metInjectFooterStrap(); } catch (e) {}

  // Decluttered topbar: instead of a flat row of ~7 loose buttons, the right side
  // reads as a few obvious GROUPS — [Search] · [Menu ▾] (navigation + personal
  // pages + help, all folded in) · [Switch Division ▾] · profile · Sign out.
  // My Dashboard / Tour now live inside Menu.
  try {
    if (right && !document.getElementById('met-pages')) {
      const switcherEl = document.getElementById('met-switcher');

      const GROUPS = [
        // "My Dashboard" is a dedicated top-level button now (added below), so it's
        // not repeated here.
        { label: 'You', items: [
          { href: '/app', icon: 'ti-device-mobile', label: 'Mobile App' },
        ] },
      ];
      const isHere = (it) => (it.match || [it.href]).some(h => h === HERE);
      const menuHtml =
        GROUPS.map(g =>
          `<div class="met-menu-label">${g.label}</div>` +
          g.items.map(it => `<a href="${it.href}" class="met-switcher-item${isHere(it) ? ' current' : ''}"><span><i class="ti ${it.icon}"></i> ${it.label}</span></a>`).join('')
        ).join('') +
        '<div class="met-menu-label">Help</div>' +
        '<a class="met-switcher-item" data-act="tour"><span><i class="ti ti-help-circle"></i> Take a tour</span></a>';

      // Menu dropdown — reuses the switcher's markup + CSS.
      const wrap = document.createElement('div');
      wrap.className = 'met-switcher';
      wrap.id = 'met-pages';
      wrap.innerHTML =
        '<button class="btn btn-ghost btn-sm" id="met-pages-btn" title="Menu · dashboard, your pages & tour"><i class="ti ti-menu-2"></i> Menu</button>' +
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

// ── MET brand moments (explicitly invoked only; no automatic slogan splash). ──
function metBrandMoment(opts) {
  opts = opts || {};
  try {
    if (document.getElementById('met-moment-active')) return;
    var el = document.createElement('div');
    el.className = 'met-splash' + (opts.variant ? ' met-moment-' + opts.variant : '');
    el.id = 'met-moment-active';
    var head = '';
    if (opts.icon) head = '<div class="met-moment-icon"' + (opts.iconColor ? ' style="--mc:' + metEsc(opts.iconColor) + ';"' : '') + '><i class="ti ' + metEsc(opts.icon) + '"></i></div>';
    // Crest as a branded box with a shield fallback BEHIND the image: on mobile
    // first-load the logo may not have downloaded before the splash dismisses, so
    // a bare <img> would show raw alt text. The box is always branded (blue), the
    // shield shows until/unless the image paints, and alt is empty so no stray
    // "MET" text ever appears.
    else if (opts.crest !== false) head = '<div class="met-splash-crest">'
      + '<span class="met-splash-crest-txt" aria-hidden="true">MET</span>'
      + '<img src="' + metEsc(opts.crest || '/img/divisions/met.png') + '" alt="" decoding="async" fetchpriority="high" onerror="this.remove()" />'
      + '</div>';
    var body = '';
    if (Array.isArray(opts.strap) && opts.strap.length) {
      body = '<div class="met-strap" data-animate>' + opts.strap.map(function (s) { return '<span class="seg">' + metEsc(s) + '</span>'; }).join('') + '</div><div class="met-strap-underline"></div>';
    } else if (opts.title) {
      body = '<div class="met-moment-title">' + metEsc(opts.title) + '</div><div class="met-strap-underline"></div>';
    }
    var tag = opts.tagline ? '<div class="met-splash-tag">' + metEsc(opts.tagline) + '</div>' : '';
    el.innerHTML = head + body + tag + '<button class="met-splash-skip" type="button" aria-label="Dismiss">Skip</button>';
    (document.body || document.documentElement).appendChild(el);
    var done = false;
    function dismiss() {
      if (done) return; done = true;
      el.classList.add('hide');
      setTimeout(function () { if (el && el.parentNode) el.parentNode.removeChild(el); }, 620);
    }
    var skip = el.querySelector('.met-splash-skip');
    if (skip) skip.addEventListener('click', function (e) { e.stopPropagation(); dismiss(); });
    el.addEventListener('click', dismiss);
    setTimeout(dismiss, opts.autoMs || 2100);
  } catch (e) { /* cosmetic only */ }
}

function metPlaySplash() { /* automatic branding splash intentionally disabled */ }

// Cycle a line of text through several taglines with a soft fade.
function metRotateTagline(elOrId, phrases, interval) {
  var el = typeof elOrId === 'string' ? document.getElementById(elOrId) : elOrId;
  if (!el || !Array.isArray(phrases) || !phrases.length) return;
  el.classList.add('met-rotator');
  var i = 0;
  function set(txt) { el.innerHTML = '<span class="rot">' + metEsc(txt) + '</span>'; }
  set(phrases[0]);
  if (phrases.length < 2) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  setInterval(function () {
    el.classList.add('out');
    setTimeout(function () { i = (i + 1) % phrases.length; el.classList.remove('out'); set(phrases[i]); }, 300);
  }, interval || 4200);
}

// A quiet strap-line footer at the bottom of a dashboard's main content.
function metInjectFooterStrap() { /* footer strap intentionally removed */ }

if (typeof window !== 'undefined') {
  window.metBrandMoment = metBrandMoment;
  window.metPlaySplash = metPlaySplash;
  window.metRotateTagline = metRotateTagline;
  window.metInjectFooterStrap = metInjectFooterStrap;
}
