// client/public/js/met-topbar.js
// Shared chrome for every division dashboard: populates the topbar's user
// avatar/name, the current-division badge, and the "Switch division" menu.
// Depends on ui.js only for nothing extra — plain fetch, so it works even on
// pages that don't load ui.js.
const DIVISION_LABEL = { CID: 'CID', SCO19: 'SCO-19', IA: 'IA', FLP: 'FLP', HPC: 'HPC' };

function metInitials(name) {
  return (name || '?').trim().slice(0, 1).toUpperCase();
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

async function initMetTopbar(currentDivision) {
  setSiteChrome(currentDivision);
  const badge = document.getElementById('met-division-badge');
  // Leave the badge's markup as-is on pages with no specific division (e.g. the
  // profile page sets its own label in HTML).
  if (badge && currentDivision) badge.textContent = DIVISION_LABEL[currentDivision] || currentDivision;

  let examEligible = false; // holds the final-exam role → show the Final Exam menu entry
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
    const menu = document.getElementById('met-switcher-menu');
    if (data && menu) {
      menu.innerHTML = '';
      (data.mine || []).forEach(d => {
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

  // Inject the consistent main buttons (My Dashboard, Menu, Search) into the
  // topbar-right on every page that has one — same set everywhere.
  try {
    if (right && !document.getElementById('met-pages')) {
      const PAGES = [
        { href: '/support',   icon: 'ti-lifebuoy',       label: 'Support' },
        { href: '/loa',       icon: 'ti-calendar-off',   label: 'Leave of Absence' },
        // Final Exam only appears for cadets who hold the final-exam role.
        ...(examEligible ? [{ href: '/exam', icon: 'ti-writing', label: 'Final Exam' }] : []),
        { href: '/app',       icon: 'ti-device-mobile',  label: 'Mobile App' },
      ];
      const switcherEl = document.getElementById('met-switcher');

      // Menu dropdown (top-level pages) — reuses the switcher's markup + CSS.
      const wrap = document.createElement('div');
      wrap.className = 'met-switcher';
      wrap.id = 'met-pages';
      wrap.innerHTML =
        '<button class="btn btn-ghost btn-sm" id="met-pages-btn"><i class="ti ti-menu-2"></i> Menu</button>' +
        '<div class="met-switcher-menu">' +
        PAGES.map(p => `<a href="${p.href}" class="met-switcher-item${HERE === p.href ? ' current' : ''}"><span><i class="ti ${p.icon}"></i> ${p.label}</span></a>`).join('') +
        '</div>';
      if (switcherEl) right.insertBefore(wrap, switcherEl); else right.appendChild(wrap);
      const pBtn = wrap.querySelector('#met-pages-btn');
      pBtn.addEventListener('click', (e) => { e.stopPropagation(); closeOtherDropdowns(wrap); wrap.classList.toggle('open'); });
      document.addEventListener('click', () => wrap.classList.remove('open'));
      if (PAGES.some(p => p.href === HERE)) markHere(pBtn);

      // Search (⌘K / Ctrl-K) — only if the command palette is on this page.
      if (typeof window.openCommandPalette === 'function' && !document.getElementById('met-cmdk-btn')) {
        const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
        const sBtn = document.createElement('button');
        sBtn.id = 'met-cmdk-btn';
        sBtn.className = 'btn btn-ghost btn-sm';
        sBtn.title = 'Search (' + (isMac ? '⌘K' : 'Ctrl + K') + ')';
        sBtn.innerHTML = `<i class="ti ti-search"></i> <span style="margin:0 2px;">Search</span> <span class="cmdk-kbd" style="opacity:.6;font-size:11px;">${isMac ? '⌘K' : 'Ctrl + K'}</span>`;
        sBtn.addEventListener('click', function () { window.openCommandPalette(); });
        right.insertBefore(sBtn, right.firstChild);
      }

      // My Dashboard — a persistent main button (leftmost), highlighted when here.
      const dashBtn = document.createElement('a');
      dashBtn.id = 'met-dash-btn';
      dashBtn.href = '/dashboard';
      dashBtn.className = 'btn btn-ghost btn-sm';
      dashBtn.innerHTML = '<i class="ti ti-layout-dashboard"></i> My Dashboard';
      right.insertBefore(dashBtn, right.firstChild);
      if (HERE === '/dashboard' || HERE === '/profile') markHere(dashBtn);
    }
  } catch (e) { /* cosmetic */ }

  // Wire the division switcher (markup-based) + highlight it on a division page.
  const switcher = document.getElementById('met-switcher');
  const switcherBtn = document.getElementById('met-switcher-btn');
  if (switcher && switcherBtn) {
    if (currentDivision) markHere(switcherBtn);
    switcherBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeOtherDropdowns(switcher);
      switcher.classList.toggle('open');
    });
    document.addEventListener('click', () => switcher.classList.remove('open'));
  }
}

// Close every topbar dropdown except the one passed in, so only one of the
// Menu / Switch Division selectors is open at a time.
function closeOtherDropdowns(except) {
  document.querySelectorAll('.met-switcher.open').forEach(s => { if (s !== except) s.classList.remove('open'); });
}
