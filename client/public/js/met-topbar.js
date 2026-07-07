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
    const menu = document.getElementById('met-switcher-menu');
    if (data && menu) {
      menu.innerHTML = '';
      const dashLink = document.createElement('a');
      dashLink.href = '/dashboard';
      dashLink.className = 'met-switcher-item';
      dashLink.innerHTML = '<span><i class="ti ti-layout-dashboard"></i> My dashboard</span>';
      menu.appendChild(dashLink);

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

  // Inject a discoverable ⌘K / Ctrl-K command-palette trigger into the topbar.
  try {
    const right = document.querySelector('.met-topbar-right');
    if (right && !document.getElementById('met-cmdk-btn') && typeof window.openCommandPalette === 'function') {
      const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
      const btn = document.createElement('button');
      btn.id = 'met-cmdk-btn';
      btn.className = 'btn btn-ghost btn-sm';
      btn.title = 'Search (' + (isMac ? '⌘K' : 'Ctrl + K') + ')';
      btn.innerHTML = `<i class="ti ti-search"></i> <span style="margin:0 2px;">Search</span> <span class="cmdk-kbd" style="opacity:.6;font-size:11px;">${isMac ? '⌘K' : 'Ctrl + K'}</span>`;
      btn.addEventListener('click', function () { window.openCommandPalette(); });
      right.insertBefore(btn, right.firstChild);
    }
  } catch (e) { /* cosmetic */ }

  const switcher = document.getElementById('met-switcher');
  const switcherBtn = document.getElementById('met-switcher-btn');
  if (switcher && switcherBtn) {
    switcherBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      switcher.classList.toggle('open');
    });
    document.addEventListener('click', () => switcher.classList.remove('open'));
  }
}
