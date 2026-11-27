async function loadMyDivisions() {
  const host = document.getElementById('p-division-list');
  if (!host) return;
  try {
    const data = await api('/api/me/divisions');
    const allowedDivisions = {
      IA: 'Internal Affairs',
      HPC: 'Hendon Police College',
      DEV: 'Developer',
      METHICOMM: 'MET High Command'
    };
    const mine = (Array.isArray(data.mine) ? data.mine : [])
      .filter(d => Object.prototype.hasOwnProperty.call(allowedDivisions, String(d.division || '').toUpperCase()));
    if (!mine.length) {
      host.innerHTML = '<div class="table-empty-text">No divisions are currently assigned to your account.</div>';
      return;
    }
    host.innerHTML = '<div class="profile-division-grid">' + mine.map(d => {
      const key = String(d.division || '').toUpperCase();
      const name = escHtml(allowedDivisions[key]);
      const rank = escHtml(d.rankName || d.tier || 'Member');
      const icon = d.icon ? '<img src="' + escHtml(d.icon) + '" alt="" class="profile-division-icon" onerror="this.style.display=\'none\'">' : '<span class="profile-division-icon-fallback"><i class="ti ti-building-community"></i></span>';
      const slug = String(d.slug || '').split('/').filter(Boolean).join('/');
      const href = slug ? '/' + encodeURIComponent(slug) + '/dashboard' : '';
      return '<a class="profile-division-choice" href="' + (href || '#') + '"' + (href ? '' : ' aria-disabled="true"') + '>' +
        icon + '<span class="profile-division-copy"><strong>' + name + '</strong><small>' + rank + '</small></span>' +
        '<i class="ti ti-arrow-up-right profile-division-arrow"></i></a>';
    }).join('') + '</div>';
  } catch (e) {
    host.innerHTML = '<div class="profile-load-error">Could not load your divisions. Refresh to try again.</div>';
  }
}

loadMyDivisions();
