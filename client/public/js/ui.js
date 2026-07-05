// client/public/js/ui.js

// ── Toast Notifications ──────────────────────────────────────────
// How long a toast stays on screen. User-configurable (Preferences), stored in
// localStorage as seconds; clamped to a sane 1–30s. Callers may still pass an
// explicit duration to override (e.g. a longer error), but most rely on this.
function toastDurationMs() {
  let s = parseFloat(localStorage.getItem('iacms_toast_secs'));
  if (!isFinite(s) || s <= 0) s = 3.5;
  s = Math.max(1, Math.min(30, s));
  return Math.round(s * 1000);
}

function showToast(message, type = 'info', duration) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  if (duration == null) duration = toastDurationMs();

  const icons = {
    success: '<i class="ti ti-circle-check"></i>',
    error:   '<i class="ti ti-alert-circle"></i>',
    info:    '<i class="ti ti-info-circle"></i>',
    warning: '<i class="ti ti-alert-triangle"></i>',
  };

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.title = 'Click to dismiss';
  toast.innerHTML = `
    <span class="toast-icon">${icons[type] || icons.info}</span>
    <span>${message}</span>
  `;

  container.appendChild(toast);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => toast.classList.add('show'));
  });

  let removed = false;
  const dismiss = () => {
    if (removed) return; removed = true;
    toast.classList.remove('show');
    toast.classList.add('hide');
    setTimeout(() => toast.remove(), 350);
  };
  toast.addEventListener('click', dismiss);          // click to dismiss early
  setTimeout(dismiss, duration);                      // auto-dismiss after the set time
}

// ── Preferences (notification duration) ──────────────────────────
function openPrefs() {
  let s = parseFloat(localStorage.getItem('iacms_toast_secs'));
  if (!isFinite(s) || s <= 0) s = 3.5;
  const r = document.getElementById('pref-toast-secs');
  const n = document.getElementById('pref-toast-secs-num');
  if (r) r.value = s;
  if (n) n.value = s;
  openModal('modal-prefs');
}

function savePrefs() {
  const n = document.getElementById('pref-toast-secs-num');
  let s = parseFloat(n && n.value);
  if (!isFinite(s)) s = 3.5;
  s = Math.max(1, Math.min(30, s));
  localStorage.setItem('iacms_toast_secs', String(s));
  closeModal('modal-prefs');
  showToast('Notifications will now stay for ' + s + 's.', 'success');
}

document.addEventListener('DOMContentLoaded', function () {
  const r = document.getElementById('pref-toast-secs');
  const n = document.getElementById('pref-toast-secs-num');
  if (r && n) {
    r.addEventListener('input', function () { n.value = r.value; });
    n.addEventListener('input', function () { r.value = n.value; });
  }
  const test = document.getElementById('pref-toast-test');
  if (test) test.addEventListener('click', function () {
    let v = parseFloat(n && n.value) || 3.5; v = Math.max(1, Math.min(30, v));
    showToast('This is a test notification — it disappears in ' + v + 's.', 'info', Math.round(v * 1000));
  });
  const save = document.getElementById('pref-save');
  if (save) save.addEventListener('click', savePrefs);
  const btn = document.getElementById('btn-prefs');
  if (btn) btn.addEventListener('click', openPrefs);
});

// ── Modal ────────────────────────────────────────────────────────
function openModal(id) {
  const overlay = document.getElementById(id);
  if (!overlay) return;
  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';
}

// Pause (and rewind) any playing video/audio inside an element so sound stops
// the moment a modal is closed.
function stopMediaIn(el) {
  if (!el) return;
  el.querySelectorAll('video, audio').forEach(function (m) {
    try { m.pause(); m.currentTime = 0; } catch (e) {}
  });
}

function closeModal(id) {
  const overlay = document.getElementById(id);
  if (!overlay) return;
  stopMediaIn(overlay);
  overlay.classList.remove('open');
  document.body.style.overflow = '';
}

// ── Administrative Log / Notice embed preview ─────────────────────
function fmtPunishmentLines(punishments) {
  if (!Array.isArray(punishments) || !punishments.length) return '• —';
  return punishments.map(p => {
    const cfg = (typeof ACTIONS_CLIENT !== 'undefined') ? ACTIONS_CLIENT.find(a => a.name === p.action) : null;
    const hasRole = !!(cfg && cfg.roleId);
    const dur = hasRole ? (p.durationDays ? ` (${p.durationDays}d)` : ' (Permanent)') : '';
    return '• ' + escapeHtml(p.action) + dur;
  }).join('<br>');
}

function buildAdminLogEmbedHTML({ officerMention, punishments, reason, notes, caseRef, signedBy }) {
  return `
    <div style="border-left:4px solid #5865F2;background:rgba(120,140,255,0.05);border-radius:6px;padding:14px 16px;font-size:13px;line-height:1.6;">
      <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-secondary);margin-bottom:8px;">
        <img src="https://metia.uk/media/880b6a85-064d-4c5a-a36f-c3d1fc8e7569" onerror="this.style.display='none'" style="width:18px;height:18px;border-radius:50%;object-fit:cover;" />
        Signed, Internal Affairs High Command
      </div>
      <div style="font-weight:700;color:#fff;margin-bottom:10px;font-size:14px;">Staff Consequences &amp; Discipline</div>
      <div style="margin-bottom:7px;"><strong>• Staff Member:</strong> ${escapeHtml(officerMention || 'Unknown Officer')}</div>
      <div style="margin-bottom:7px;"><strong>• Punishment(s):</strong><br>${fmtPunishmentLines(punishments)}</div>
      <div style="margin-bottom:7px;"><strong>• Reason:</strong> ${escapeHtml(reason || 'N/A')}</div>
      <div style="margin-bottom:7px;"><strong>• Notes:</strong> ${escapeHtml(notes || 'N/A')}</div>
      <div style="margin-top:10px;font-size:11px;color:var(--text-muted);">Infraction ID | ${escapeHtml(String(caseRef || 'pending'))}</div>
    </div>`;
}

// Show the preview modal. buttons = [{ label(html), class, onClick }]
function showEmbedPreview({ title, note, embedData, buttons }) {
  const t = document.getElementById('embed-preview-title');
  if (t) t.textContent = title || 'Administrative Log — Preview';
  const n = document.getElementById('embed-preview-note');
  if (n) n.textContent = note || '';
  const body = document.getElementById('embed-preview-body');
  if (body) body.innerHTML = buildAdminLogEmbedHTML(embedData);
  const foot = document.getElementById('embed-preview-footer');
  if (foot) {
    foot.innerHTML = '';
    (buttons || []).forEach(b => {
      const btn = document.createElement('button');
      btn.className = b.class || 'btn btn-ghost';
      btn.innerHTML = b.label;
      btn.onclick = b.onClick;
      foot.appendChild(btn);
    });
  }
  openModal('modal-embed-preview');
}

// Close modal on overlay click
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal-overlay')) {
    stopMediaIn(e.target);
    e.target.classList.remove('open');
    document.body.style.overflow = '';
  }
});

// Close modal on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.open').forEach(m => {
      stopMediaIn(m);
      m.classList.remove('open');
    });
    document.body.style.overflow = '';
  }
});

// ── API Helper ───────────────────────────────────────────────────
// A stable per-browser id, persisted in localStorage. Sent on every request so
// the support desk can ticket-blacklist a guest's browser (alongside their IP).
function browserFp() {
  try {
    let v = localStorage.getItem('met_fp');
    if (!v) {
      v = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : (Math.random().toString(36).slice(2) + Date.now().toString(36));
      localStorage.setItem('met_fp', v);
    }
    return v;
  } catch (e) { return ''; }
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', 'x-support-fp': browserFp(), ...options.headers },
    ...options,
  });

  // A lost/expired session (401) sends the user back to login. A 403 is a
  // PERMISSION response, not a lost session — only a blacklist 403 should bounce
  // them out. Any other 403 (viewing or acting on a resource they can't, e.g. a
  // Supervisor approving a Termination case, or an officer opening someone
  // else's ticket) is surfaced as a normal error so the page stays put.
  if (res.status === 401) {
    window.location.href = '/login?error=access_revoked';
    return null;
  }
  if (res.status === 403) {
    const data = await res.json().catch(() => ({}));
    if (/blacklist/i.test(data.error || '')) {
      window.location.href = '/denied?reason=blacklisted';
      return null;
    }
    throw new Error(data.error || 'You don’t have access to that.');
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }

  // 204 No Content
  if (res.status === 204) return null;

  return res.json();
}

// ── Format helpers ───────────────────────────────────────────────
function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric'
  });
}

function formatDateTime(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

// ── Timezone helpers ─────────────────────────────────────────────
// Produce a label like "BST +1" or "EST -5" (abbreviation + whole-hour
// offset). Falls back to "UTC+5:30"-style when a zone has no named
// abbreviation. Pass an IANA name (e.g. "Europe/London") to label that
// zone, or omit to label the viewer's local zone.
function tzOffsetMinutes(ianaTz, date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: ianaTz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = dtf.formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {});
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUTC - date.getTime()) / 60000);
}

function formatTzLabel(ianaTz) {
  try {
    const d = new Date();
    const opts = { timeZoneName: 'short' };
    if (ianaTz) opts.timeZone = ianaTz;
    const parts = new Intl.DateTimeFormat([], opts).formatToParts(d);
    const tzp = parts.find(p => p.type === 'timeZoneName');
    const abbr = tzp ? tzp.value : '';

    const offMin = ianaTz ? tzOffsetMinutes(ianaTz, d) : -d.getTimezoneOffset();
    const sign = offMin >= 0 ? '+' : '-';
    const abs  = Math.abs(offMin);
    const h    = Math.floor(abs / 60);
    const m    = abs % 60;
    const off  = sign + h + (m ? ':' + String(m).padStart(2, '0') : '');

    // Named abbreviation (BST, EST…) → "BST +1"; bare GMT/UTC → "UTC+1"
    if (abbr && !/^(GMT|UTC)/i.test(abbr)) return abbr + ' ' + off;
    return 'UTC' + off;
  } catch (e) {
    return ianaTz || '';
  }
}

// For display: convert a stored IANA name to the "BST +1" label; leave
// values that are already labels (or anything non-IANA) untouched.
function displayTz(stored) {
  if (!stored) return '—';
  // IANA names look like "Region/City"; already-formatted labels don't.
  if (/^[A-Za-z]+\/[A-Za-z_\/+-]+$/.test(stored)) return formatTzLabel(stored);
  return stored;
}

// Open an image in a new tab. Browsers block navigating to a base64 data: URL,
// so convert it to a Blob URL first (which is allowed). Returns false so it can
// be used directly in an <a onclick="return openImageNewTab(this.href)">.
function openImageNewTab(src) {
  try {
    if (src && src.indexOf('data:') === 0) {
      const comma = src.indexOf(',');
      const meta  = src.slice(5, comma); // e.g. "image/jpeg;base64"
      const mime  = (meta.split(';')[0]) || 'image/png';
      const isB64 = /;base64/i.test(meta);
      const dataPart = src.slice(comma + 1);
      let blob;
      if (isB64) {
        const bin = atob(dataPart);
        const u8  = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        blob = new Blob([u8], { type: mime });
      } else {
        blob = new Blob([decodeURIComponent(dataPart)], { type: mime });
      }
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return false;
    }
    window.open(src, '_blank');
  } catch (e) {
    try { window.open(src, '_blank'); } catch (e2) {}
  }
  return false;
}

function statusBadge(status) {
  const map = {
    PENDING:  '<span class="badge badge-pending"><span class="badge-dot"></span>Pending</span>',
    APPROVED: '<span class="badge badge-approved"><span class="badge-dot"></span>Approved</span>',
    DENIED:   '<span class="badge badge-denied"><span class="badge-dot"></span>Denied</span>',
  };
  return map[status] || `<span class="badge">${status}</span>`;
}

// Loud "Changes requested" indicator for a PENDING case a reviewer has bounced
// back to its submitter. Returns '' when it doesn't apply. Shared across every
// case list + the detail view so the state is impossible to miss.
function changesBadge(c) {
  if (!c || !c.reviewNote || c.status !== 'PENDING') return '';
  const by  = (c.reviewChanges && c.reviewChanges.by) ? ` by ${c.reviewChanges.by}` : '';
  const tip = `Changes requested${by}: ${c.reviewNote}`;
  return `<span class="badge badge-changes" title="${escapeHtml(tip)}">`
       + `<span class="badge-dot"></span><i class="ti ti-edit-circle"></i> Changes requested</span>`;
}

// True when a case has been sent back to its submitter and is awaiting changes.
function caseAwaitingChanges(c) {
  return !!(c && c.reviewNote && c.status === 'PENDING');
}

// Colour-coded punishment badges for the case ACTION column — mirrors the
// ticket TYPE badges so case logs read with the same "little indications".
//   Blacklist / Termination / Demotion → red
//   Strikes / Zero Tolerance           → amber
//   Warnings & everything else         → blue
function actionBadges(actionStr) {
  const names = String(actionStr == null ? '' : actionStr)
    .split(',').map(s => s.trim()).filter(Boolean);
  if (!names.length) return '<span class="text-muted">—</span>';
  const badges = names.map(n => {
    const lc = n.toLowerCase();
    let color = 'blue';
    if (/blacklist|terminat|demotion/.test(lc))   color = 'red';
    else if (/strike|zero\s*tolerance/.test(lc))  color = 'amber';
    return `<span class="badge badge-${color}"><span class="badge-dot"></span>${escapeHtml(n)}</span>`;
  }).join('');
  // Wrap so multiple punishments stack instead of widening the table column.
  return `<span style="display:inline-flex;flex-wrap:wrap;gap:3px;max-width:190px;vertical-align:middle;">${badges}</span>`;
}

function investigatorCell(user) {
  if (!user) return '<span class="text-muted">—</span>';
  const initial = (user.discordUsername || '?')[0].toUpperCase();
  const avatarHtml = user.discordAvatar
    ? `<img class="inv-avatar" src="${user.discordAvatar}" alt="" />`
    : `<div class="inv-avatar-fallback">${initial}</div>`;
  return `<div class="investigator-cell">${avatarHtml}<span class="inv-name">${escapeHtml(user.discordUsername || '—')}</span></div>`;
}

// Investigator for a case row — imported cases carry the real investigator name
// on the case (investigatorRoblox/DiscordUsername); otherwise the submitter account.
function caseInvestigatorCell(c) {
  const inv = c.investigatorRobloxUsername || c.investigatorDiscordUsername;
  if (inv) {
    const initial = (inv || '?')[0].toUpperCase();
    return `<div class="investigator-cell"><div class="inv-avatar-fallback">${escapeHtml(initial)}</div>` +
      `<span class="inv-name">${escapeHtml(inv)}</span></div>`;
  }
  return investigatorCell(c.user);
}

// Strip a leading "Punishment(s):" label from a case action string
function cleanAction(action) {
  return (action || '').replace(/^\s*punishments?\s*:\s*/i, '').trim() || '—';
}

// Suspect/officer cell: Roblox username + headshot + profile link (Discord ID
// stays in the case detail only, not the row).
function officerCell(c) {
  if (!c.robloxUsername && !c.robloxUserId) {
    return '<span class="text-muted" style="font-size:11px;">—</span>';
  }
  const uname = c.robloxUsername || ('ID ' + c.robloxUserId);
  const avatar = c.robloxUserId
    ? `<img src="https://www.roblox.com/headshot-thumbnail/image?userId=${encodeURIComponent(c.robloxUserId)}&width=48&height=48&format=png" ` +
      `onerror="this.style.display='none'" alt="" style="width:22px;height:22px;border-radius:50%;background:var(--bg-elevated);flex-shrink:0;object-fit:cover;" />`
    : '';
  const name = c.robloxUserId
    ? `<a href="https://www.roblox.com/users/${encodeURIComponent(c.robloxUserId)}/profile" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" style="font-size:12px;color:var(--text-primary);text-decoration:none;">${escapeHtml(uname)}</a>`
    : `<span style="font-size:12px;">${escapeHtml(uname)}</span>`;
  return `<div style="display:flex;align-items:center;gap:7px;">${avatar}${name}</div>`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function emptyRow(colspan, message = 'No cases found') {
  return `<tr>
    <td colspan="${colspan}" class="table-empty">
      <span class="table-empty-icon"><i class="ti ti-folder-off" style="font-size:2rem;"></i></span>
      <span class="table-empty-text">${message}</span>
    </td>
  </tr>`;
}

// ── Theme Management ─────────────────────────────────────────────
// Persists to localStorage so the user's choice survives page loads.
const THEME_KEY = 'iacms_theme';

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const icon = document.getElementById('theme-icon');
  if (icon) {
    icon.className = theme === 'light' ? 'ti ti-moon' : 'ti ti-sun';
  }
  const btn = document.getElementById('btn-theme-toggle');
  if (btn) btn.title = theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme';
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next    = current === 'dark' ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
}

// Apply saved theme immediately (before paint to avoid flash)
(function initTheme() {
  const saved = localStorage.getItem(THEME_KEY) || 'dark';
  applyTheme(saved);
})();

// Wire up the toggle button once the DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('btn-theme-toggle');
  if (btn) btn.addEventListener('click', toggleTheme);

  // Re-apply so the icon matches (DOMContentLoaded runs after the inline script)
  const saved = localStorage.getItem(THEME_KEY) || 'dark';
  applyTheme(saved);
});
