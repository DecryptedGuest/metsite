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

// Rank-tier badge for a division membership. Prefers the LOW/MIDDLE/HIGH tier
// computed server-side from the division rank structure; falls back to the
// coarse LEAD/MEMBER access tier for older payloads.
function tierBadge(d) {
  const label = (d && (d.rankTierLabel || (d.rankTier && ({ LOW: 'Low Rank', MIDDLE: 'Middle Rank', HIGH: 'High Rank' }[d.rankTier])))) || null;
  const cls = { LOW: 'badge-pending', MIDDLE: 'badge-amber', HIGH: 'badge-approved' };
  if (label) {
    return `<span class="badge ${cls[d.rankTier] || 'badge-pending'}"><span class="badge-dot"></span>${label}</span>`;
  }
  // Legacy fallback (payload predates rankTier).
  return d && d.tier === 'LEAD'
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

  // The role chip shows the member's MET-group rank name; only if they have no
  // MET rank do we fall back to the internal site role label.
  const siteRoleLabel = { IA: 'Internal Affairs', HICOMM: 'IA High Command', SUPERVISOR: 'IA Supervisor', DEVELOPER: 'Developer' }[u.role] || u.role || '';
  const roleLabel = data.metRankName || siteRoleLabel;
  const metaChips = [];
  if (roleLabel) metaChips.push(`<span class="met-chip">${escHtml(roleLabel)}</span>`);
  // Quick-copy identity chips (handy for staff cross-referencing records).
  const idChip = (label, val, icon) =>
    `<button type="button" class="met-chip" title="Copy ${escHtml(label)}" onclick="copyText('${escHtml(String(val))}','${escHtml(label)}')" style="cursor:pointer;background:none;font:inherit;"><i class="ti ${icon}"></i> ${escHtml(label)}: ${escHtml(String(val))} <i class="ti ti-copy" style="opacity:.6;"></i></button>`;
  if (u.discordId) metaChips.push(idChip('Discord ID', u.discordId, 'ti-brand-discord'));
  if (u.robloxId)  metaChips.push(idChip('Roblox ID',  u.robloxId,  'ti-brand-roblox'));
  document.getElementById('p-meta').innerHTML = metaChips.join(' ');

  const avatarImg = document.getElementById('p-avatar');
  const avatarFallback = document.getElementById('p-avatar-fallback');
  if (u.discordAvatar) {
    avatarImg.src = u.discordAvatar; avatarImg.style.display = '';
    avatarFallback.style.display = 'none';
  } else {
    avatarFallback.textContent = (name || '?').slice(0, 1).toUpperCase();
  }

  if (!data.botLinked) document.getElementById('bot-notice').style.display = 'flex';

  // ── Mobile-app promo (desktop only) ──
  showAppPromo(data.mobileAppUrl);

  // ── Final exam (eligible cadets only) ──
  loadExamStatus();
  // ── Upcoming / live tryouts (British citizens) ──
  loadTryouts();
  // ── Active sign-ins / devices ──
  loadSessions();
  // ── Passkeys / 2FA ──
  loadPasskeys();

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
        ${tierBadge(d)}
      </a>`;
    }).join('')}</div>`;
  } else {
    divEl.innerHTML = `<div class="table-empty-text">You're not a member of any division yet.</div>`;
  }

  // ── Rank history — promotion/demotion timeline ──
  const rh = data.rankHistory || [];
  if (rh.length) {
    document.getElementById('p-rankhistory-panel').style.display = '';
    document.getElementById('p-rankhistory').innerHTML = `<div class="rank-timeline">${rh.map(r => {
      const change = r.fromRank && r.toRank ? `${escHtml(r.fromRank)} → <strong>${escHtml(r.toRank)}</strong>`
        : r.toRank ? `<strong>${escHtml(r.toRank)}</strong>` : '<span style="color:var(--text-muted);">Rank change</span>';
      return `<div style="display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--border-dim);">
        <div><div style="font-size:13px;">${change}${r.group ? ` <span style="font-size:10px;color:var(--text-muted);">(${escHtml(r.group)})</span>` : ''}</div>
        ${r.reason ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${escHtml(r.reason)}</div>` : ''}</div>
        <div style="text-align:right;white-space:nowrap;font-size:11px;color:var(--text-muted);">${formatDate(r.createdAt)}${r.byName ? `<br>by ${escHtml(r.byName)}` : ''}</div>
      </div>`;
    }).join('')}</div>`;
  }

  // ── Perms — only shown if the member holds a paid-permission role ──
  const perms = data.perms || [];
  const permsPanel = document.getElementById('p-perms-panel');
  if (perms.length) {
    if (permsPanel) permsPanel.style.display = '';
    document.getElementById('p-perms').innerHTML = perms.map(p => chip(p.label || p.key, p.color)).join('');
  } else if (permsPanel) {
    permsPanel.style.display = 'none';
  }

  // ── Punishment history ──
  const pun = document.getElementById('p-punishments');
  if (data.punishments && data.punishments.length) {
    pun.innerHTML = data.punishments.map(p => `<tr>
      <td>${chip(p.type, punishmentColor(p.type))}${p.caseRef ? ` <span style="color:var(--text-muted);font-size:10px;">${escHtml(p.caseRef)}</span>` : ''}</td>
      <td>${escHtml(p.reason || '—')}</td>
      <td>${escHtml(p.issuedBy || '—')}</td>
      <td>${p.active ? '<span class="badge badge-denied"><span class="badge-dot"></span>Active</span>' : '<span class="badge badge-approved"><span class="badge-dot"></span>Expired</span>'}</td>
      <td>${p.expiresAt ? formatDate(p.expiresAt) : (p.active ? '<span style="color:var(--text-muted);">Permanent</span>' : '—')}</td>
      <td>${formatDate(p.issuedAt)}</td>
    </tr>`).join('');
  } else {
    pun.innerHTML = `<tr><td colspan="6" class="table-empty"><div class="table-empty-text">No punishments on record.</div></td></tr>`;
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
    html = `<p style="font-size:13px;color:var(--text-secondary);margin:0 0 12px;">You're required to take the Metropolitan Police Final Examination.</p>
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

// Show the "get the mobile app" promo only on desktop/PC (not phones/tablets),
// and only if the user hasn't dismissed it.
function isDesktop() {
  const ua = navigator.userAgent || '';
  const mobileUA = /Android|iPhone|iPad|iPod|Mobile|Tablet|Silk|Kindle|Opera Mini/i.test(ua);
  const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  return !mobileUA && !coarse && window.innerWidth >= 900;
}
function showAppPromo(url) {
  if (!isDesktop()) return;
  if (localStorage.getItem('met_app_promo_dismissed') === '1') return;
  const el = document.getElementById('app-promo');
  if (!el) return;
  const link = document.getElementById('app-promo-link');
  // Always give a way to get it: an external store URL if set, else the on-site
  // "open on your phone" handoff page (/app). Rendered as a little arrow.
  if (url) { link.href = url; }
  else { link.href = '/app'; link.removeAttribute('target'); }
  link.classList.add('btn-primary'); link.classList.remove('btn-ghost');
  link.style.pointerEvents = '';
  link.setAttribute('aria-label', 'Get the mobile app');
  link.innerHTML = '<i class="ti ti-arrow-right"></i>';
  el.style.display = 'flex';
}
function dismissAppPromo() {
  localStorage.setItem('met_app_promo_dismissed', '1');
  const el = document.getElementById('app-promo');
  if (el) el.style.display = 'none';
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
        <div style="font-size:11px;color:var(--text-muted);">${['UNLOCKED', 'UNSLOCKED'].includes(String(t.lockState).toUpperCase()) ? '<i class="ti ti-lock-open"></i> Server unlocked' : '<i class="ti ti-lock"></i> Server locked'}</div>
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

// ── Active sessions / device management ──────────────────────────
// Pick a device-appropriate icon from the user-agent-derived device string.
function deviceIcon(device) {
  const d = String(device || '').toLowerCase();
  if (/iphone|android|mobile|phone/.test(d)) return 'ti-device-mobile';
  if (/ipad|tablet/.test(d)) return 'ti-device-tablet';
  if (/mac|windows|linux|desktop|pc/.test(d)) return 'ti-device-desktop';
  return 'ti-device-laptop';
}

// "just now" / "5 min ago" / "3 hours ago" / "2 days ago", else a date.
function relativeTime(ts) {
  const t = new Date(ts).getTime();
  if (isNaN(t)) return '';
  const diff = Date.now() - t;
  if (diff < 0) return 'just now';
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return min + (min === 1 ? ' min ago' : ' mins ago');
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + (hr === 1 ? ' hour ago' : ' hours ago');
  const day = Math.floor(hr / 24);
  if (day < 30) return day + (day === 1 ? ' day ago' : ' days ago');
  return formatDateTime(ts);
}

async function loadSessions() {
  let data;
  try { data = await api('/api/me/sessions'); } catch (e) { return; }
  const el = document.getElementById('p-sessions');
  const sessions = data.sessions || [];
  if (!sessions.length) {
    el.innerHTML = '<div class="table-empty-text">No active sessions.</div>';
    return;
  }
  document.getElementById('p-sessions-signout-others').style.display =
    sessions.filter(s => !s.current).length ? '' : 'none';

  el.innerHTML = sessions.map(s => `
    <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border-dim);">
      <i class="ti ${deviceIcon(s.device)}" style="font-size:20px;color:${s.current ? 'var(--green,#22c55e)' : 'var(--text-muted)'};"></i>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:600;">
          ${escHtml(s.device)}
          ${s.current ? '<span class="badge badge-approved" style="margin-left:8px;"><span class="badge-dot"></span>This device</span>' : ''}
        </div>
        <div style="font-size:11px;color:var(--text-muted);" title="Signed in ${escHtml(formatDateTime(s.createdAt))} · Last active ${escHtml(formatDateTime(s.lastSeenAt))}">
          Active ${escHtml(relativeTime(s.lastSeenAt))}  ·  signed in ${escHtml(relativeTime(s.createdAt))}
        </div>
      </div>
      ${s.current
        ? ''
        : `<button class="btn btn-ghost btn-sm" onclick="revokeSession('${s.id}')"><i class="ti ti-x"></i> Sign out</button>`}
    </div>`).join('');
}

async function revokeSession(id) {
  try {
    const r = await api('/api/me/sessions/' + encodeURIComponent(id) + '/revoke', { method: 'POST' });
    if (r && r.wasCurrent) { window.location.href = '/login'; return; }
    showToast('Session signed out.', 'success');
    loadSessions();
  } catch (e) { showToast(e.message || 'Could not sign out that session.', 'error'); }
}

async function revokeOtherSessions() {
  try {
    const r = await api('/api/me/sessions/revoke-others', { method: 'POST' });
    showToast(`Signed out ${r.count} other session${r.count === 1 ? '' : 's'}.`, 'success');
    loadSessions();
  } catch (e) { showToast(e.message || 'Could not sign out other sessions.', 'error'); }
}

// ── Passkeys / 2FA ───────────────────────────────────────────────
async function loadPasskeys() {
  const panel = document.getElementById('p-passkeys-panel');
  const el = document.getElementById('p-passkeys');
  if (!el) return;
  // Hide the whole panel on browsers with no WebAuthn support.
  if (!(window.MetPasskeys && window.MetPasskeys.supported())) {
    if (panel) panel.style.display = 'none';
    return;
  }
  let data;
  try { data = await api('/api/webauthn/passkeys'); } catch (e) { el.innerHTML = '<div class="table-empty-text">Could not load passkeys.</div>'; return; }
  const list = data.passkeys || [];
  if (!list.length) {
    el.innerHTML = '<div class="table-empty-text">No passkeys yet. Add one to enable step-up verification.</div>';
    return;
  }
  el.innerHTML = list.map(p => `
    <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border-dim);">
      <i class="ti ti-fingerprint" style="font-size:20px;color:var(--text-muted);"></i>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:600;">${escHtml(p.name || 'Passkey')}${p.backedUp ? ' <span class="badge badge-approved" style="margin-left:6px;"><span class="badge-dot"></span>Synced</span>' : ''}</div>
        <div style="font-size:11px;color:var(--text-muted);">Added ${formatDate(p.createdAt)}${p.lastUsedAt ? '  ·  Last used ' + formatDate(p.lastUsedAt) : ''}</div>
      </div>
      <button class="btn btn-ghost btn-sm" onclick="deletePasskey('${p.id}')"><i class="ti ti-trash"></i></button>
    </div>`).join('');
}

async function addPasskey() {
  const btn = document.getElementById('p-passkey-add');
  const name = await uiPrompt('Name this passkey (e.g. "MacBook Touch ID"):', { title: 'Add a passkey', value: 'My passkey', confirmText: 'Add', placeholder: 'Passkey name' });
  if (name === null) return;
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner"></div> Waiting…'; }
  try {
    await window.MetPasskeys.registerPasskey(name.trim() || 'Passkey');
    showToast('Passkey added.', 'success');
    loadPasskeys();
  } catch (e) {
    showToast(e.message || 'Could not add passkey.', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-fingerprint"></i> Add passkey'; }
  }
}

async function deletePasskey(id) {
  if (!(await uiConfirm('Remove this passkey? You won’t be able to use it for verification anymore.'))) return;
  try {
    await api('/api/webauthn/passkeys/' + encodeURIComponent(id), { method: 'DELETE' });
    showToast('Passkey removed.', 'success');
    loadPasskeys();
  } catch (e) { showToast(e.message || 'Could not remove passkey.', 'error'); }
}

// Run a passkey step-up if the last action returned STEP_UP_REQUIRED. Returns
// true if verification succeeded. Callers retry the action afterwards.
async function ensureStepUp() {
  if (!(window.MetPasskeys && window.MetPasskeys.supported())) return false;
  try {
    await window.MetPasskeys.stepUp();
    return true;
  } catch (e) {
    showToast(e.message || 'Passkey verification failed.', 'error');
    return false;
  }
}

function punishmentColor(type) {
  const t = String(type || '').toUpperCase();
  if (/BAN|BLACKLIST/.test(t)) return '#f04f5e';
  if (/SUSPEN|STRIKE|DEMOT/.test(t)) return '#f5b730';
  if (/WARN/.test(t)) return '#4a8fff';
  return null;
}

// ── My Activity + achievements ──────────────────────────────────────
async function loadActivity() {
  let s; try { s = await api('/api/me/stats'); } catch (e) { return; }
  const panel = document.getElementById('p-activity-panel');
  if (!panel) return;
  const hours = Math.round((s.totalMinutes || 0) / 6) / 10; // 1dp
  const days = s.memberSince ? Math.floor((Date.now() - new Date(s.memberSince).getTime()) / 86400000) : 0;
  const tile = (v, l, c) => `<div style="padding:12px 14px;border-radius:12px;border:1px solid var(--border,#2a2a2a);">
      <div style="font-size:24px;font-weight:800;color:${c};line-height:1.1;">${v}</div>
      <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;margin-top:3px;">${l}</div></div>`;
  document.getElementById('p-activity-stats').innerHTML =
    tile(s.patrols || 0, 'Patrols', 'var(--green,#22c55e)') +
    tile(s.events || 0, 'Events', 'var(--amber,#e8842a)') +
    tile(hours, 'Hours on patrol', 'var(--blue,#4a8fff)') +
    tile(s.tryoutsHosted || 0, 'Tryouts hosted', 'var(--text-primary)') +
    tile(s.rankChanges || 0, 'Rank changes', 'var(--text-primary)');

  // Achievements, computed from the stats — earned ones lit, the rest greyed.
  // `cur`/`goal` on tiered achievements drive a "34 / 50" progress hint while locked.
  const ACH = [
    { key: 'first',   icon: 'ti-shoe',          name: 'First Steps',       desc: 'Log your first patrol',          cur: s.patrols || 0,       goal: 1,  unit: 'patrols' },
    { key: 'reg',     icon: 'ti-walk',          name: 'Patrol Regular',    desc: '10 approved patrols',            cur: s.patrols || 0,       goal: 10, unit: 'patrols' },
    { key: 'vet',     icon: 'ti-medal',         name: 'Patrol Veteran',    desc: '50 approved patrols',            cur: s.patrols || 0,       goal: 50, unit: 'patrols' },
    { key: 'host',    icon: 'ti-calendar-star', name: 'Event Host',        desc: 'Run an event',                   cur: s.events || 0,        goal: 1,  unit: 'events' },
    { key: 'trainer', icon: 'ti-school',        name: 'Trainer',           desc: 'Host a tryout',                  cur: s.tryoutsHosted || 0, goal: 1,  unit: 'tryouts' },
    { key: 'grad',    icon: 'ti-certificate',   name: 'Graduate',          desc: 'Pass the final exam',            earned: !!s.examPassed },
    { key: 'time',    icon: 'ti-clock-hour-4',  name: 'Time Served',       desc: '10+ hours on patrol',            cur: hours,                goal: 10, unit: 'hours' },
    { key: 'climb',   icon: 'ti-trending-up',   name: 'Climbing the Ranks', desc: 'Earn a promotion',              cur: s.rankChanges || 0,   goal: 1,  unit: 'promotions' },
    { key: 'loyal',   icon: 'ti-shield-star',   name: 'Loyal Officer',     desc: '90 days with the MET',           cur: days,                 goal: 90, unit: 'days' },
  ].map(a => (a.earned === undefined ? { ...a, earned: (a.cur || 0) >= a.goal } : a));
  const earnedCount = ACH.filter(a => a.earned).length;
  document.getElementById('p-achievements').innerHTML =
    `<div style="width:100%;font-size:12px;color:var(--text-muted);margin-bottom:4px;">${earnedCount} of ${ACH.length} unlocked</div>` +
    ACH.map(a => {
      const showProgress = !a.earned && a.goal > 1 && (a.cur || 0) > 0;
      const pct = showProgress ? Math.min(100, Math.round(((a.cur || 0) / a.goal) * 100)) : 0;
      const hint = showProgress
        ? `<div style="font-size:10px;color:var(--text-muted);margin-top:3px;">${a.cur} / ${a.goal} ${escHtml(a.unit)}</div>
           <div style="height:3px;border-radius:3px;background:var(--border,#2a2a2a);margin-top:3px;overflow:hidden;"><div style="height:100%;width:${pct}%;background:var(--blue,#4a8fff);opacity:.7;"></div></div>`
        : `<div style="font-size:11px;color:var(--text-muted);">${escHtml(a.desc)}</div>`;
      return `<div title="${escHtml(a.desc)}" style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:10px;border:1px solid var(--border,#2a2a2a);min-width:150px;${a.earned ? 'background:rgba(74,143,255,.08);' : 'opacity:.55;'}">
        <i class="ti ${a.icon}" style="font-size:20px;color:${a.earned ? 'var(--blue,#4a8fff)' : 'var(--text-muted)'};"></i>
        <div style="flex:1;min-width:0;"><div style="font-size:13px;font-weight:700;">${escHtml(a.name)}</div>
        ${hint}</div>
      </div>`;
    }).join('');
  panel.style.display = '';
}

// ── Appearance: accent colour + theme ───────────────────────────────
const ACCENTS = [
  { name: 'MET Blue (default)', hex: '' },
  { name: 'Azure',   hex: '#4a8fff' }, { name: 'Emerald', hex: '#22c55e' },
  { name: 'Amber',   hex: '#e8842a' }, { name: 'Rose',    hex: '#f04f6e' },
  { name: 'Violet',  hex: '#8b5cf6' }, { name: 'Teal',    hex: '#14b8a6' },
  { name: 'Gold',    hex: '#f5b730' }, { name: 'Crimson', hex: '#e0503a' },
];
function renderAccents() {
  const wrap = document.getElementById('p-accent-swatches');
  if (!wrap) return;
  let cur = ''; try { cur = localStorage.getItem('iacms_accent') || ''; } catch (e) {}
  wrap.innerHTML = ACCENTS.map(a => {
    const active = (a.hex || '') === cur;
    const bg = a.hex || 'var(--blue,#4a8fff)';
    return `<button title="${escHtml(a.name)}" onclick="setAccent('${a.hex}')" style="width:34px;height:34px;border-radius:50%;cursor:pointer;background:${bg};border:2px solid ${active ? 'var(--text-primary)' : 'transparent'};box-shadow:${active ? '0 0 0 2px var(--bg,#0a0a0a)' : 'none'};position:relative;">${active ? '<i class="ti ti-check" style="color:#fff;font-size:16px;"></i>' : ''}</button>`;
  }).join('');
}
window.setAccent = function (hex) {
  try { if (hex) localStorage.setItem('iacms_accent', hex); else localStorage.removeItem('iacms_accent'); } catch (e) {}
  if (window.applyAccent) window.applyAccent(hex);
  renderAccents();
  if (window.showToast) showToast('Accent updated.', 'success');
};
window.toggleTheme = function () {
  let t = 'dark'; try { t = localStorage.getItem('iacms_theme') || 'dark'; } catch (e) {}
  const next = t === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('iacms_theme', next); } catch (e) {}
  document.documentElement.setAttribute('data-theme', next);
  if (window.showToast) showToast(next === 'dark' ? 'Dark mode' : 'Light mode', 'info');
};

function reduceMotionOn() {
  let pref = ''; try { pref = localStorage.getItem('iacms_reduce_motion') || ''; } catch (e) {}
  if (pref === 'on') return true;
  if (pref === 'off') return false;
  try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; }
}
function renderReduceMotionBtn() {
  const btn = document.getElementById('p-reduce-motion-btn');
  if (!btn) return;
  const on = reduceMotionOn();
  btn.classList.toggle('btn-primary', on);
  btn.classList.toggle('btn-ghost', !on);
  btn.innerHTML = `<i class="ti ti-accessible"></i> Reduce motion${on ? ' · on' : ''}`;
}
window.toggleReduceMotion = function () {
  const next = !reduceMotionOn();
  try { localStorage.setItem('iacms_reduce_motion', next ? 'on' : 'off'); } catch (e) {}
  if (window.applyReduceMotion) window.applyReduceMotion(next);
  renderReduceMotionBtn();
  if (window.showToast) showToast(next ? 'Reduced motion on' : 'Reduced motion off', 'info');
};

function densityOn() { try { return localStorage.getItem('iacms_density') === 'compact'; } catch (e) { return false; } }
function renderDensityBtn() {
  const btn = document.getElementById('p-density-btn');
  if (!btn) return;
  const on = densityOn();
  btn.classList.toggle('btn-primary', on);
  btn.classList.toggle('btn-ghost', !on);
  btn.innerHTML = `<i class="ti ti-layout-rows"></i> Compact${on ? ' · on' : ''}`;
}
window.toggleDensity = function () {
  const next = !densityOn();
  try { localStorage.setItem('iacms_density', next ? 'compact' : 'cosy'); } catch (e) {}
  if (window.applyDensity) window.applyDensity(next);
  renderDensityBtn();
  if (window.showToast) showToast(next ? 'Compact layout on' : 'Comfortable layout', 'info');
};

loadProfile();
loadActivity();
renderAccents();
renderReduceMotionBtn();
renderDensityBtn();
