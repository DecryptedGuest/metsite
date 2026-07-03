// client/public/js/met-topbar.js
// Shared chrome for every division dashboard: populates the topbar's user
// avatar/name, the current-division badge, and the "Switch division" menu.
// Depends on ui.js only for nothing extra — plain fetch, so it works even on
// pages that don't load ui.js.
const DIVISION_LABEL = { CID: 'CID', SCO19: 'SCO-19', IA: 'IA', FLP: 'FLP', HPC: 'HPC' };

function metInitials(name) {
  return (name || '?').trim().slice(0, 1).toUpperCase();
}

async function initMetTopbar(currentDivision) {
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
      const hubLink = document.createElement('a');
      hubLink.href = '/';
      hubLink.className = 'met-switcher-item';
      hubLink.innerHTML = '<span><i class="ti ti-layout-grid"></i> All divisions</span>';
      menu.appendChild(hubLink);

      const profileLink = document.createElement('a');
      profileLink.href = '/profile';
      profileLink.className = 'met-switcher-item';
      profileLink.innerHTML = '<span><i class="ti ti-user"></i> My profile</span>';
      menu.appendChild(profileLink);

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
