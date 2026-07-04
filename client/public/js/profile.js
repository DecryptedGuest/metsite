// client/public/js/profile.js — officer profile page
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Normalise a Discord role/perm colour to a #rrggbb string. Accepts a decimal
// int (Discord's format), a hex string, or nothing (→ neutral).
function toHexColor(c) {
  if (c == null || c === 0 || c === '') return null;
  if (typeof c === 'number') return '#' + c.toString(16).padStart(6, '0');
  const s = String(c);
  return s.startsWith('#') ? s : '#' + s;
}

function chip(label, color) {
  const hex = toHexColor(color);
  const style = hex
    ? `style="border-color:${hex}66;color:${hex};background:${hex}14;"`
    : '';
  const dot = hex ? `<span class="chip-dot" style="background:${hex};"></span>` : '';
  return `<span class="met-chip" ${style}>${dot}${escHtml(label)}</span>`;
}

function tierBadge(tier) {
  return tier === 'LEAD'
    ? '<span class="badge badge-approved"><span class="badge-dot"></span>High Rank</span>'
    : '<span class="badge badge-pending"><span class="badge-dot"></span>Member</span>';
}

async function loadProfile() {
  let data;
  try {
    data = await api('/api/me/profile');
  } catch (err) {
    showToast(err.message, 'error');
    return;
  }

  // ── Identity header ──
  const u = data.user;
  const name = data.metNickname || u.displayName || u.discordUsername;
  document.getElementById('p-name').textContent = name;

  const sub = [];
  if (u.discordUsername) sub.push('@' + u.discordUsername);
  if (u.robloxUsername)  sub.push('Roblox: ' + u.robloxUsername);
  document.getElementById('p-sub').textContent = sub.join('  ·  ');

  const roleLabel = { IA: 'Internal Affairs', HICOMM: 'IA High Command', SUPERVISOR: 'IA Supervisor', DEVELOPER: 'Developer' }[u.role] || u.role || '';
  document.getElementById('p-meta').innerHTML = roleLabel ? `<span class="met-chip">${escHtml(roleLabel)}</span>` : '';

  const avatarImg = document.getElementById('p-avatar');
  const avatarFallback = document.getElementById('p-avatar-fallback');
  if (u.discordAvatar) {
    avatarImg.src = u.discordAvatar; avatarImg.style.display = '';
    avatarFallback.style.display = 'none';
  } else {
    avatarFallback.textContent = (name || '?').slice(0, 1).toUpperCase();
  }

  if (!data.botLinked) document.getElementById('bot-notice').style.display = 'flex';

  // ── Final exam (eligible cadets only) ──
  loadExamStatus();
  // ── Upcoming / live tryouts (British citizens) ──
  loadTryouts();

  // ── Standing / disciplinary flags ──
  const flags = data.flags || [];
  if (flags.length) {
    document.getElementById('p-flags-panel').style.display = '';
    document.getElementById('p-flags').innerHTML = flags.map(f => chip(f.label, f.color)).join('');
  }

  // ── Divisions & rank ── (coloured per the MET role scheme)
  const divEl = document.getElementById('p-divisions');
  if (data.divisions && data.divisions.length) {
    divEl.innerHTML = `<div class="profile-div-grid">${data.divisions.map(d => {
      const hex = toHexColor(d.color);
      const accent = hex ? `style="border-left:3px solid ${hex};"` : '';
      const abbr = hex
        ? `<div class="profile-div-abbr" style="background:${hex}22;color:${hex};">${escHtml(d.name)}</div>`
        : `<div class="profile-div-abbr">${escHtml(d.name)}</div>`;
      return `
      <a class="profile-div-card" href="/${d.slug}/dashboard" ${accent}>
        ${d.icon ? `<img class="profile-div-icon" src="${d.icon}" alt="${escHtml(d.name)}" onerror="this.style.display='none'" />` : abbr}
        <div class="profile-div-body">
          <div class="profile-div-name">${escHtml(d.fullName || d.name)}</div>
          <div class="profile-div-rank">${d.rankName ? escHtml(d.rankName) : ''}</div>
        </div>
        ${tierBadge(d.tier)}
      </a>`;
    }).join('')}</div>`;
  } else {
    divEl.innerHTML = `<div class="table-empty-text">You're not a member of any division yet.</div>`;
  }

  // ── MET server roles ── (division role chips first, then synced Discord roles)
  const rolesEl = document.getElementById('p-roles');
  const divChips = (data.divisions || []).map(d =>
    chip(`${d.name}${d.rankName ? ' · ' + d.rankName : ''}`, d.color));
  const roles = (data.roles || []).slice().sort((a, b) => (b.position || 0) - (a.position || 0));
  const roleChips = roles.map(r => chip(r.name, r.color));
  const allRoleChips = divChips.concat(roleChips);
  rolesEl.innerHTML = allRoleChips.length
    ? allRoleChips.join('')
    : `<span class="chip-empty">No MET-server roles synced yet.</span>`;

  // ── Perms ──
  const permsEl = document.getElementById('p-perms');
  const perms = data.perms || [];
  permsEl.innerHTML = perms.length
    ? perms.map(p => chip(p.label || p.key, p.color)).join('')
    : `<span class="chip-empty">No permissions synced yet.</span>`;

  // ── Punishment history ──
  const pun = document.getElementById('p-punishments');
  if (data.punishments && data.punishments.length) {
    pun.innerHTML = data.punishments.map(p => `<tr>
      <td>${chip(p.type, punishmentColor(p.type))}</td>
      <td>${escHtml(p.reason || '—')}</td>
      <td>${escHtml(p.issuedBy || '—')}</td>
      <td>${p.active ? '<span class="badge badge-denied"><span class="badge-dot"></span>Active</span>' : '<span class="badge badge-approved"><span class="badge-dot"></span>Expired</span>'}</td>
      <td>${formatDate(p.issuedAt)}</td>
    </tr>`).join('');
  } else {
    pun.innerHTML = `<tr><td colspan="5" class="table-empty"><div class="table-empty-text">No punishments on record. 🎉</div></td></tr>`;
  }
}

async function loadExamStatus() {
  let s;
  try { s = await api('/api/exam/my'); } catch (e) { return; }
  if (!s.eligible) return; // not a cadet — hide the panel entirely
  document.getElementById('p-exam-panel').style.display = '';
  const el = document.getElementById('p-exam');

  const latest = s.latest;
  let html;
  if (!latest) {
    html = `<p style="font-size:13px;color:var(--text-secondary);margin:0 0 12px;">You're required to sit the Metropolitan Police Final Examination.</p>
      <a href="/exam" class="btn btn-primary btn-sm"><i class="ti ti-writing"></i> Take Final Exam</a>`;
  } else if (latest.status === 'PENDING') {
    html = `<div style="display:flex;align-items:center;gap:10px;"><span class="badge badge-pending"><span class="badge-dot"></span>Awaiting marking</span>
      <span style="font-size:12px;color:var(--text-muted);">Submitted ${formatDateTime(latest.createdAt)}</span></div>
      <p style="font-size:12px;color:var(--text-secondary);margin:10px 0 0;">Your exam is with Hendon Police College. You'll see your result here once it's marked.</p>`;
  } else {
    const passed = latest.status === 'PASSED';
    html = `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <span class="badge ${passed ? 'badge-approved' : 'badge-denied'}"><span class="badge-dot"></span>${passed ? 'Passed' : 'Failed'}</span>
        <span style="font-size:14px;font-weight:700;">${latest.score}/${latest.maxScore} · ${latest.percentage}%</span>
        <span style="font-size:12px;color:var(--text-muted);">marked by ${escHtml(latest.markedByName || 'HPC')} · ${formatDate(latest.markedAt)}</span>
      </div>
      ${latest.markerNote ? `<p style="font-size:13px;color:var(--text-secondary);margin:10px 0 0;"><strong>Note:</strong> ${escHtml(latest.markerNote)}</p>` : ''}
      ${!passed && s.canRetake ? `<div style="margin-top:12px;"><a href="/exam" class="btn btn-primary btn-sm"><i class="ti ti-refresh"></i> Retake Exam</a></div>` : ''}`;
  }
  el.innerHTML = html;
}

async function loadTryouts() {
  let data;
  try { data = await api('/api/tryouts/upcoming'); } catch (e) { return; }
  if (!data.eligible) return;
  const hasAny = (data.live && data.live.length) || (data.upcoming && data.upcoming.length);
  if (!hasAny) return; // nothing to show — keep the panel hidden
  document.getElementById('p-tryouts-panel').style.display = '';
  const el = document.getElementById('p-tryouts');

  const liveHtml = (data.live || []).map(t => `
    <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border-dim);">
      <span class="badge badge-approved"><span class="badge-dot"></span>Live now</span>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:600;">Hosted by ${escHtml(t.hostName)}${t.coHostName ? ' · Co-host ' + escHtml(t.coHostName) : ''}</div>
        <div style="font-size:11px;color:var(--text-muted);">${t.lockState === 'UNSLOCKED' ? 'UNSLOCKED' : 'SLOCKED'}</div>
      </div>
      ${t.joinLink ? `<a href="${escHtml(t.joinLink)}" target="_blank" rel="noopener" class="btn btn-primary btn-sm"><i class="ti ti-brand-roblox"></i> Join</a>` : '<span style="font-size:11px;color:var(--text-muted);">Link pending</span>'}
    </div>`).join('');

  const upHtml = (data.upcoming || []).map(t => `
    <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border-dim);">
      <span class="badge badge-pending"><span class="badge-dot"></span>Upcoming</span>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:600;">${formatDateTime(t.scheduledAt)}</div>
        <div style="font-size:11px;color:var(--text-muted);">Hosted by ${escHtml(t.hostName)}</div>
      </div>
    </div>`).join('');

  el.innerHTML = (liveHtml + upHtml) || '<div class="table-empty-text">No tryouts right now.</div>';
}

function punishmentColor(type) {
  const t = String(type || '').toUpperCase();
  if (/BAN|BLACKLIST/.test(t)) return '#f04f5e';
  if (/SUSPEN|STRIKE|DEMOT/.test(t)) return '#f5b730';
  if (/WARN/.test(t)) return '#4a8fff';
  return null;
}

loadProfile();
