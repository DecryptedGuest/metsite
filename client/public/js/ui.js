// client/public/js/ui.js

// ── Accent colour ────────────────────────────────────────────────
// A member-chosen accent overrides the site's default blue (--blue) everywhere.
// Applied on every page load (ui.js is loaded almost everywhere).
function applyAccent(hex) {
  const r = document.documentElement;
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) { r.style.removeProperty('--blue'); r.style.removeProperty('--blue-dim'); r.style.removeProperty('--blue-glow'); return; }
  const n = parseInt(hex.slice(1), 16), R = (n >> 16) & 255, G = (n >> 8) & 255, B = n & 255;
  r.style.setProperty('--blue', hex);
  r.style.setProperty('--blue-dim', `rgba(${R},${G},${B},0.18)`);
  r.style.setProperty('--blue-glow', `rgba(${R},${G},${B},0.25)`);
}
if (typeof window !== 'undefined') {
  window.applyAccent = applyAccent;
  try { const a = localStorage.getItem('iacms_accent'); if (a) applyAccent(a); } catch (e) {}
}

// ── Rank ordering (high → low) ───────────────────────────────────
// A rough MET-wide rank ladder for sorting quota / activity tables so members
// appear in rank order. Returns a weight (lower = higher rank); unknown ranks
// sort last. Matched most-senior-first so "Detective Chief Inspector" beats the
// bare "Inspector" entry. Used by the quota renderers.
// [pattern, weight] rather than a bare ordered list, because seniority order
// and match order are not the same thing. "Investigator" outranks "Junior
// Investigator" but the word *investigator* is inside both, so the specific
// patterns have to be TESTED first while carrying their own — later — weight.
// A plain ordered list gets that pair wrong every time.
//
// Weights are spaced by 10 so a rank can be slotted in without renumbering.
var MET_RANK_LADDER = [
  // Tested most-specific first.
  [/deputy\s*assistant\s*commissioner/i,        15],
  [/assistant\s*commissioner/i,                 12],
  [/deputy\s*commissioner/i,                    11],
  [/\bcommissioner\b/i,                         10],
  [/chief\s*of\s*(police|staff)/i,              10],
  [/deputy\s*director/i,                        22],
  [/assistant\s*director/i,                     24],
  [/\bdirector\b/i,                             20],
  [/deputy\s*(unit\s*)?commander/i,             32],
  [/assistant\s*commander/i,                    34],
  [/unit\s*commander/i,                         33],
  [/\bcommander\b/i,                            30],
  [/chief\s*superintendent/i,                   40],
  [/superintendent/i,                           42],
  [/chief\s*inspector/i,                        50],
  [/(^|[^a-z])inspector/i,                      52],
  // IA's own ladder. Without these every IA member scored the same "unknown"
  // weight and the tables fell back to whatever order the API returned.
  [/supervisor/i,                               60],
  [/senior\s*investigator/i,                    62],
  [/junior\s*investigator/i,                    66],
  [/probationary\s*investigator/i,              68],
  [/investigator/i,                             64],
  [/sergeant/i,                                 70],
  [/(^|[^a-z])constable/i,                      80],
  [/lead\s*instructor/i,                        61],
  [/senior\s*instructor/i,                      63],
  [/junior\s*instructor/i,                      67],
  [/instructor/i,                               65],
  [/database\s*manager/i,                       63],
  [/senior\s*operator/i,                        84],
  [/operator/i,                                 86],
  // Before the bare "officer" test — "Community Support Officer" contains it.
  [/community\s*support\s*officer|\bcso\b/i,    94],
  [/senior\s*officer/i,                         88],
  [/junior\s*officer/i,                         92],
  [/(^|[^a-z])officer/i,                        90],
  [/cadet|recruit|trainee|awaiting/i,           96],
];
function metRankWeight(rank) {
  var r = String(rank == null ? '' : rank);
  for (var i = 0; i < MET_RANK_LADDER.length; i++) {
    if (MET_RANK_LADDER[i][0].test(r)) return MET_RANK_LADDER[i][1];
  }
  return 999;
}
if (typeof window !== 'undefined') window.metRankWeight = metRankWeight;

// ── Clipboard helper ─────────────────────────────────────────────
// Copies text and shows a toast. Falls back to a hidden textarea +
// execCommand for browsers/contexts without the async Clipboard API.
function copyText(text, label) {
  const done = () => { if (window.showToast) showToast((label || 'Copied') + ' to clipboard', 'success'); };
  const fail = () => { if (window.showToast) showToast('Could not copy', 'error'); };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(String(text)).then(done).catch(fail);
      return;
    }
  } catch (e) { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = String(text);
    ta.style.cssText = 'position:fixed;top:-9999px;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    done();
  } catch (e) { fail(); }
}
if (typeof window !== 'undefined') window.copyText = copyText;

// ── Reduce motion / performance mode ─────────────────────────────
// Opt-in (or auto via the OS prefers-reduced-motion setting). Kills the
// animated background canvas, scanline and page-entry animations for
// members on low-power devices or who find the motion distracting.
function applyReduceMotion(on) {
  const r = document.documentElement;
  if (on) {
    r.setAttribute('data-reduce-motion', '1');
    if (!document.getElementById('iacms-reduce-motion-style')) {
      const s = document.createElement('style');
      s.id = 'iacms-reduce-motion-style';
      s.textContent =
        'html[data-reduce-motion="1"] *{animation-duration:.001s!important;animation-iteration-count:1!important;transition-duration:.001s!important;scroll-behavior:auto!important}' +
        'html[data-reduce-motion="1"] .bg-grid,html[data-reduce-motion="1"] .bg-glow-1,html[data-reduce-motion="1"] .bg-glow-2,html[data-reduce-motion="1"] .bg-scanline{animation:none!important;opacity:.35}' +
        'html[data-reduce-motion="1"] .bg-scanline{display:none}';
      (document.head || document.documentElement).appendChild(s);
    }
  } else {
    r.removeAttribute('data-reduce-motion');
  }
}
if (typeof window !== 'undefined') {
  window.applyReduceMotion = applyReduceMotion;
  try {
    const pref = localStorage.getItem('iacms_reduce_motion');
    // 'on'/'off' is an explicit member choice; when unset, follow the OS.
    const osReduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    applyReduceMotion(pref === 'on' || (pref !== 'off' && osReduce));
  } catch (e) {}
}

// ── Compact density ──────────────────────────────────────────────
// Tightens panel/section padding site-wide for members who prefer to
// fit more on screen. Stored per-device; scoped to a data attribute so
// it's fully reversible with no effect when off.
function applyDensity(compact) {
  const r = document.documentElement;
  if (compact) {
    r.setAttribute('data-density', 'compact');
    if (!document.getElementById('iacms-density-style')) {
      const s = document.createElement('style');
      s.id = 'iacms-density-style';
      s.textContent =
        'html[data-density="compact"] .profile-section{padding:.7rem .9rem!important}' +
        'html[data-density="compact"] .panel-header{padding-top:.6rem!important;padding-bottom:.6rem!important}' +
        'html[data-density="compact"] .panel{margin-bottom:.8rem!important}' +
        'html[data-density="compact"] .stat-card,html[data-density="compact"] .stat-card-inner{padding:.6rem .8rem!important}' +
        'html[data-density="compact"] .profile-wrap>*{margin-bottom:.7rem!important}';
      (document.head || document.documentElement).appendChild(s);
    }
  } else {
    r.removeAttribute('data-density');
  }
}
if (typeof window !== 'undefined') {
  window.applyDensity = applyDensity;
  try { applyDensity(localStorage.getItem('iacms_density') === 'compact'); } catch (e) {}
}

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

  // Cap the visible stack so a burst of toasts can't fill the screen —
  // drop the oldest once we're over the limit.
  const MAX_TOASTS = 4;
  const existing = container.querySelectorAll('.toast');
  for (let i = 0; i <= existing.length - MAX_TOASTS; i++) {
    if (existing[i]) existing[i].remove();
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.title = 'Click to dismiss';
  // escapeHtml the message: it can carry attacker-influenced text (e.g. a
  // claimant's display name in an "already claimed by …" toast), and this is an
  // auto-firing innerHTML sink — an <img onerror> would otherwise execute.
  toast.innerHTML = `
    <span class="toast-icon">${icons[type] || icons.info}</span>
    <span>${escapeHtml(message)}</span>
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
    showToast('This is a test notification · it disappears in ' + v + 's.', 'info', Math.round(v * 1000));
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

// ── On-site confirm / prompt (replaces the browser's confirm()/prompt()) ──
// Returns a Promise: uiConfirm → boolean, uiPrompt → string|null. Styled with
// the site's modal chrome. Enter = confirm, Escape = cancel; clicking the
// backdrop cancels.
function _uiDialog(kind, message, opts) {
  opts = opts || {};
  return new Promise(function (resolve) {
    const title       = opts.title || (kind === 'prompt' ? 'Enter a value' : 'Please confirm');
    const confirmText = opts.confirmText || (kind === 'prompt' ? 'OK' : 'Confirm');
    const cancelText  = opts.cancelText || 'Cancel';
    const danger      = !!opts.danger;
    const icon        = opts.icon || (danger ? 'ti-alert-triangle' : (kind === 'prompt' ? 'ti-pencil' : 'ti-help-circle'));

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open';
    overlay.style.zIndex = '4000';
    const inputHtml = kind === 'prompt'
      ? `<${opts.multiline ? 'textarea rows="3"' : 'input type="text"'} class="form-control" id="_ui-prompt-input" placeholder="${escapeHtml(opts.placeholder || '')}" style="margin-top:12px;width:100%;">${opts.multiline ? escapeHtml(opts.value || '') + '</textarea>' : ''}`
      : '';
    const inputVal = (kind === 'prompt' && !opts.multiline && opts.value) ? ` value="${escapeHtml(opts.value)}"` : '';
    overlay.innerHTML =
      `<div class="modal glass-bright" style="max-width:440px;">
         <div class="modal-header">
           <div class="modal-title"><i class="ti ${icon}" style="font-size:18px;${danger ? 'color:var(--red);' : ''}"></i> ${escapeHtml(title)}</div>
         </div>
         <div class="modal-body">
           <div style="font-size:13px;color:var(--text-secondary);line-height:1.6;white-space:pre-line;">${escapeHtml(message || '')}</div>
           ${kind === 'prompt' && !opts.multiline ? `<input type="text" class="form-control" id="_ui-prompt-input" placeholder="${escapeHtml(opts.placeholder || '')}"${inputVal} style="margin-top:12px;width:100%;">` : (kind === 'prompt' ? inputHtml : '')}
         </div>
         <div class="modal-footer">
           <button class="btn btn-ghost" data-act="cancel">${escapeHtml(cancelText)}</button>
           <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">${escapeHtml(confirmText)}</button>
         </div>
       </div>`;
    document.body.appendChild(overlay);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const input = overlay.querySelector('#_ui-prompt-input');
    function done(val) {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      if (!document.querySelector('.modal-overlay.open')) document.body.style.overflow = prevOverflow || '';
      resolve(val);
    }
    const okVal   = () => kind === 'prompt' ? (input ? input.value : '') : true;
    const cancelV = () => kind === 'prompt' ? null : false;

    overlay.querySelector('[data-act="ok"]').addEventListener('click', () => done(okVal()));
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => done(cancelV()));
    let mdOv = null;
    overlay.addEventListener('mousedown', (e) => { mdOv = e.target === overlay ? overlay : null; });
    overlay.addEventListener('click', (e) => { if (e.target === overlay && mdOv === overlay) done(cancelV()); mdOv = null; });
    function onKey(e) {
      if (e.key === 'Escape') done(cancelV());
      else if (e.key === 'Enter' && !(opts.multiline && e.target === input)) { e.preventDefault(); done(okVal()); }
    }
    document.addEventListener('keydown', onKey);
    setTimeout(() => { (input || overlay.querySelector('[data-act="ok"]')).focus(); if (input) input.select && input.select(); }, 30);
  });
}
function uiConfirm(message, opts) { return _uiDialog('confirm', message, opts); }
function uiPrompt(message, opts)  { return _uiDialog('prompt', message, opts); }
window.uiConfirm = uiConfirm;
window.uiPrompt  = uiPrompt;

// ── Administrative Log / Notice embed preview ─────────────────────
function fmtPunishmentLines(punishments) {
  if (!Array.isArray(punishments) || !punishments.length) return '• ·';
  return punishments.map(p => {
    const cfg = (typeof ACTIONS_CLIENT !== 'undefined') ? ACTIONS_CLIENT.find(a => a.name === p.action) : null;
    // `timed`, to match the embed the server actually posts (webhook.js and
    // officerNotice.js both gate on it). Previewing "(Permanent)" against a
    // punishment the real message prints bare meant the reviewer approved one
    // wording and a different one went out.
    const timed = !!(cfg && cfg.timed);
    const dur = timed ? (p.durationDays ? ` (${p.durationDays}d)` : ' (Permanent)') : '';
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
  if (t) t.textContent = title || 'Administrative Log · Preview';
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

// Close modal on overlay click — but ONLY when the click both starts and ends on
// the backdrop itself. Without the mousedown guard, selecting/copying text inside
// the modal and releasing the mouse over the backdrop fires a `click` whose target
// is the overlay (the common ancestor of the drag), which would wrongly dismiss the
// panel mid-copy. Tracking where the press began fixes that.
let _mdOnOverlay = null;
document.addEventListener('mousedown', (e) => {
  _mdOnOverlay = (e.target.classList && e.target.classList.contains('modal-overlay')) ? e.target : null;
});
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal-overlay') && _mdOnOverlay === e.target) {
    stopMediaIn(e.target);
    e.target.classList.remove('open');
    document.body.style.overflow = '';
  }
  _mdOnOverlay = null;
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


// Read the CSRF token the server set as a readable cookie, so it can be echoed
// back on every state-changing request (double-submit-cookie protection).
function getCsrfToken() {
  const m = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken(), ...options.headers },
    ...options,
  });

  // Passkey step-up: the action needs a fresh passkey verification. Run the
  // ceremony, then retry the original request once — transparent to callers.
  if (res.status === 401 && !options.__steppedUp && window.MetPasskeys && window.MetPasskeys.supported()) {
    const body = await res.clone().json().catch(() => ({}));
    if (body.code === 'STEP_UP_REQUIRED') {
      try {
        await window.MetPasskeys.stepUp();
        return api(path, { ...options, __steppedUp: true });
      } catch (e) {
        throw new Error(e.message || 'Passkey verification is required for this action.');
      }
    }
  }

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
    // A failure has to arrive READABLE. `HTTP 502` on its own is unactionable —
    // it does not say whether the app refused, the proxy replaced the response,
    // or nothing answered at all. When the body is not the JSON we send, the
    // body itself is the evidence, so a snippet of it goes into the message
    // rather than being thrown away.
    const text = await res.text().catch(() => '');
    let data = null;
    try { data = JSON.parse(text); } catch (e) { /* not ours */ }
    if (data && data.error) throw new Error(data.error);

    // Strip tags so a proxy's HTML error page reads as a sentence instead of
    // markup, and cap it — this ends up in a toast.
    const plain = String(text || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const hint = res.status >= 502 && res.status <= 504
      ? ' The server did not answer · it may still be restarting, or the request took too long.'
      : '';
    throw new Error(`HTTP ${res.status}${plain ? ': ' + plain.slice(0, 300) : ''}${hint}`);
  }

  // 204 No Content
  if (res.status === 204) return null;

  return res.json();
}

// ── Format helpers ───────────────────────────────────────────────
function formatDate(dateStr) {
  if (!dateStr) return '·';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric'
  });
}

function formatDateTime(dateStr) {
  if (!dateStr) return '·';
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
  if (!stored) return '·';
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

// ── Shared in-site image lightbox ────────────────────────────────────
// metLightbox(urls, startIndex) — full-screen viewer with ←/→ arrows to step
// through a gallery, a "Copy link" button for the current image, and keyboard
// nav (←/→/Esc). metImgGallery(anchorEl) builds the gallery from the sibling
// <a class="met-evid"> images around the clicked one (so proof/evidence images
// in a ticket, case or log open in-site instead of a new tab).
(function () {
  let imgs = [], idx = 0;
  function build() {
    if (document.getElementById('met-lightbox')) return;
    const el = document.createElement('div');
    el.id = 'met-lightbox';
    el.style.cssText = 'display:none;position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.9);align-items:center;justify-content:center;';
    const base  = 'border:none;background:rgba(255,255,255,.12);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;';
    const arrow = 'position:absolute;top:50%;transform:translateY(-50%);width:46px;height:46px;border-radius:50%;font-size:26px;' + base;
    el.innerHTML =
      '<button id="met-lb-copy" title="Copy image link" style="position:absolute;top:18px;right:70px;height:40px;padding:0 14px;border-radius:20px;font-size:13px;gap:6px;' + base + '"><i class="ti ti-link"></i> Copy link</button>' +
      '<button id="met-lb-close" title="Close (Esc)" style="position:absolute;top:18px;right:22px;width:40px;height:40px;border-radius:50%;font-size:20px;' + base + '"><i class="ti ti-x"></i></button>' +
      '<button id="met-lb-prev" title="Previous (Left arrow)" style="' + arrow + 'left:20px;"><i class="ti ti-chevron-left"></i></button>' +
      '<img id="met-lb-img" alt="" style="max-width:88vw;max-height:86vh;border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,.5);" />' +
      '<button id="met-lb-next" title="Next (Right arrow)" style="' + arrow + 'right:20px;"><i class="ti ti-chevron-right"></i></button>' +
      '<div id="met-lb-count" style="position:absolute;bottom:20px;left:50%;transform:translateX(-50%);color:#fff;font-size:13px;background:rgba(0,0,0,.5);padding:4px 12px;border-radius:20px;"></div>';
    document.body.appendChild(el);
    el.addEventListener('click', e => { if (e.target === el) close(); });
    document.getElementById('met-lb-close').onclick = close;
    document.getElementById('met-lb-prev').onclick  = e => { e.stopPropagation(); step(-1); };
    document.getElementById('met-lb-next').onclick  = e => { e.stopPropagation(); step(1); };
    document.getElementById('met-lb-copy').onclick  = e => { e.stopPropagation(); copyLink(); };
    document.addEventListener('keydown', e => {
      const box = document.getElementById('met-lightbox');
      if (!box || box.style.display !== 'flex') return;
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
    });
  }
  function render() {
    document.getElementById('met-lb-img').src = imgs[idx];
    const multi = imgs.length > 1;
    document.getElementById('met-lb-count').textContent = multi ? (idx + 1) + ' / ' + imgs.length : '';
    document.getElementById('met-lb-prev').style.display = multi ? 'flex' : 'none';
    document.getElementById('met-lb-next').style.display = multi ? 'flex' : 'none';
  }
  function step(d) { if (!imgs.length) return; idx = (idx + d + imgs.length) % imgs.length; render(); }
  function close() { const el = document.getElementById('met-lightbox'); if (el) el.style.display = 'none'; }
  function copyLink() {
    const url = imgs[idx]; if (!url) return;
    const ok  = () => { if (typeof showToast === 'function') showToast('Link copied', 'success'); };
    const bad = () => { if (typeof showToast === 'function') showToast('Could not copy link', 'error'); };
    function fallback() {
      try {
        const ta = document.createElement('textarea');
        ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); ok();
      } catch (e) { bad(); }
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(ok, fallback);
      else fallback();
    } catch (e) { fallback(); }
  }
  window.metLightbox = function (images, start) {
    imgs = Array.isArray(images) ? images.filter(Boolean) : (images ? [images] : []);
    if (!imgs.length) return false;
    idx = Math.max(0, Math.min(start || 0, imgs.length - 1));
    build(); render();
    document.getElementById('met-lightbox').style.display = 'flex';
    return false;
  };
  // Open the clicked evidence image in the lightbox, with its sibling
  // <a class="met-evid"> images forming the ←/→ gallery. The gallery spans the
  // whole message / proof group the image lives in (a chat message's .sup-atts,
  // a proof grid, or the nearest message row) so all of a message's images
  // shuffle — not just immediate DOM siblings.
  const GALLERY_SCOPES = '.sup-atts, .proof-preview-grid, .met-gallery, .sup-msg, .sup-body, [data-mid]';
  window.metImgGallery = function (aEl) {
    try {
      const anchor = (aEl && aEl.closest) ? (aEl.closest('a.met-evid, .met-evid') || aEl) : aEl;
      const container = (anchor.closest && anchor.closest(GALLERY_SCOPES)) || anchor.parentElement || anchor;
      const anchors = [].slice.call(container.querySelectorAll('a.met-evid, .met-evid'))
        .filter(a => a.querySelector ? (a.querySelector('img') || a.tagName === 'A') : true);
      const urls = anchors.map(a => { const im = a.querySelector && a.querySelector('img'); return (im && im.src) || a.href; }).filter(Boolean);
      let i = anchors.indexOf(anchor);
      if (i < 0) i = 0;
      return window.metLightbox(urls.length ? urls : [anchor.href], Math.max(0, i));
    } catch (e) {
      try { const im = aEl.querySelector && aEl.querySelector('img'); return window.metLightbox((im && im.src) || aEl.href); } catch (_) { return false; }
    }
  };
  // ── Discord-style link embeds ─────────────────────────────────────
  // metEmbeds.scan(root, fetchUnfurl) finds http(s) links inside .sup-text
  // blocks and, using the page-supplied fetchUnfurl(url) -> Promise<embed|null>,
  // appends a Discord-like embed card under the message. Results are cached so
  // the 5s message-poll re-render doesn't refetch.
  window.metEmbeds = (function () {
    const cache = new Map();   // url -> embed | null
    const inflight = new Map();
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
    function host(d) { return d.siteName || d.host || ''; }
    function card(d) {
      if (!d) return '';
      const accent = d.color && /^#|^rgb/.test(d.color) ? d.color : 'var(--accent,#4a8fff)';
      const site = host(d) ? `<div class="met-emb-site">${d.icon ? `<img class="met-emb-fav" src="${esc(d.icon)}" alt="" onerror="this.remove()">` : ''}${esc(host(d))}</div>` : '';
      const title = d.title ? `<a class="met-emb-title" href="${esc(d.url)}" target="_blank" rel="noopener nofollow">${esc(d.title)}</a>` : '';
      const desc = d.description ? `<div class="met-emb-desc">${esc(d.description)}</div>` : '';
      // A pure image link → show the image only (Discord shows a bare image).
      if (d.type === 'image' && d.image) {
        return `<div class="met-embed met-embed-img"><a href="${esc(d.url)}" class="met-evid" onclick="return metImgGallery(this)"><img src="${esc(d.image)}" alt="" loading="lazy" onerror="this.closest('.met-embed').remove()"></a></div>`;
      }
      const isVideo = d.type === 'video';
      const big = (d.bigImage || isVideo) && d.image;
      const play = isVideo ? '<span class="met-emb-play"><i class="ti ti-player-play-filled"></i></span>' : '';
      const bigImg = big ? `<a class="met-emb-big" href="${esc(d.url)}" target="_blank" rel="noopener nofollow"><img src="${esc(d.image)}" alt="" loading="lazy" onerror="this.closest('.met-emb-big').remove()">${play}</a>` : '';
      const thumb = (!big && d.image) ? `<a class="met-emb-thumb" href="${esc(d.url)}" target="_blank" rel="noopener nofollow"><img src="${esc(d.image)}" alt="" loading="lazy" onerror="this.closest('.met-emb-thumb').remove()"></a>` : '';
      if (!site && !title && !desc && !d.image) return '';
      return `<div class="met-embed" style="--emb:${accent};">
        <div class="met-emb-main"><div class="met-emb-body">${site}${title}${desc}</div>${thumb}</div>${bigImg}</div>`;
    }
    async function resolve(url, fetchUnfurl) {
      if (cache.has(url)) return cache.get(url);
      if (inflight.has(url)) return inflight.get(url);
      const p = (async () => { let d = null; try { d = await fetchUnfurl(url); } catch (e) { d = null; } cache.set(url, d || null); inflight.delete(url); return d || null; })();
      inflight.set(url, p);
      return p;
    }
    function scan(root, fetchUnfurl) {
      if (!root || typeof fetchUnfurl !== 'function') return;
      const texts = [].slice.call(root.querySelectorAll('.sup-text')).filter(t => !t.__embScanned);
      texts.forEach(t => {
        t.__embScanned = true;
        const body = t.parentElement; if (!body) return;
        const seen = {};
        const urls = [].slice.call(t.querySelectorAll('a[href^="http"]'))
          .map(a => a.getAttribute('href'))
          .filter(u => u && !seen[u] && (seen[u] = 1))
          .slice(0, 4);
        if (!urls.length) return;
        let box = body.querySelector(':scope > .sup-embeds');
        if (!box) { box = document.createElement('div'); box.className = 'sup-embeds'; body.appendChild(box); }
        urls.forEach(u => {
          resolve(u, fetchUnfurl).then(d => {
            const html = card(d);
            if (html && box && box.isConnected) box.insertAdjacentHTML('beforeend', html);
          });
        });
      });
    }
    return { scan, card, _cache: cache };
  })();

  // Belt-and-braces: a delegated handler so an evidence image ALWAYS opens the
  // in-site lightbox and NEVER falls through to navigating to the raw media URL,
  // even if an inline onclick is missing or a script errored before binding it.
  document.addEventListener('click', function (e) {
    const a = e.target && e.target.closest && e.target.closest('a.met-evid, a.proof-thumb');
    if (!a) return;
    e.preventDefault();
    window.metImgGallery(a);
  }, false);
})();

function statusBadge(status) {
  const map = {
    PENDING:    '<span class="badge badge-pending"><span class="badge-dot"></span>Pending</span>',
    APPROVED:   '<span class="badge badge-approved"><span class="badge-dot"></span>Approved</span>',
    DENIED:     '<span class="badge badge-denied"><span class="badge-dot"></span>Denied</span>',
    OVERTURNED: '<span class="badge badge-purple"><span class="badge-dot"></span>Appealed</span>',
    // Ingested before the queue was reset — never anybody's decision, and
    // deliberately not styled like one.
    VOID:       '<span class="badge badge-muted"><span class="badge-dot"></span>Voided</span>',
  };
  return map[status] || `<span class="badge">${status}</span>`;
}

// Where a case came from. A direct action taken with /infract is a real
// record and counts the same, but it is NOT the conclusion of an
// investigation, and a record that doesn't say so is misleading about how the
// decision was reached. Returns '' for an ordinary case.
function originBadge(c) {
  const o = c && c.origin;
  if (o === 'DISCIPLINE') {
    return '<span class="badge badge-amber" title="Issued directly with the /infract command · no investigation, auto-approved by the officer who issued it.">'
         + '<span class="badge-dot"></span><i class="ti ti-gavel"></i> Direct action</span>';
  }
  if (o === 'IA') {
    return '<span class="badge badge-blue" title="Synced from the Internal Affairs database.">'
         + '<span class="badge-dot"></span><i class="ti ti-database"></i> IA sync</span>';
  }
  return '';
}

// Loud "Changes requested" indicator for a PENDING case a reviewer has bounced
// back to its submitter. Returns '' when it doesn't apply. Shared across every
// case list + the detail view so the state is impossible to miss.
function changesBadge(c) {
  if (!c || c.status !== 'PENDING') return '';
  if (c.reviewNote) {
    const by  = (c.reviewChanges && c.reviewChanges.by) ? ` by ${c.reviewChanges.by}` : '';
    const tip = `Changes requested${by}: ${c.reviewNote}`;
    return `<span class="badge badge-changes" title="${escapeHtml(tip)}">`
         + `<span class="badge-dot"></span><i class="ti ti-edit-circle"></i> Changes requested</span>`;
  }
  // The submitter has since acted on the request — surface that too, so a
  // reviewer can see at a glance which cases have been updated for them.
  if (caseWasUpdated(c)) {
    const rev = lastRevision(c);
    const what = rev ? rev.changes.map(x => x.label).join(', ') : '';
    return `<span class="badge badge-blue" title="${escapeHtml('Updated by the submitter: ' + what)}">`
         + `<span class="badge-dot"></span><i class="ti ti-refresh-dot"></i> Updated</span>`;
  }
  return '';
}

// True when a case has been sent back to its submitter and is awaiting changes.
function caseAwaitingChanges(c) {
  return !!(c && c.reviewNote && c.status === 'PENDING');
}

// The most recent recorded edit of a case, or null.
function lastRevision(c) {
  const revs = (c && Array.isArray(c.reviewRevisions)) ? c.reviewRevisions : [];
  return revs.length ? revs[revs.length - 1] : null;
}

// A pending case whose submitter has answered a "changes requested" note.
function caseWasUpdated(c) {
  if (!c || c.status !== 'PENDING' || c.reviewNote) return false;
  const rev = lastRevision(c);
  return !!(rev && rev.addressedNote);
}

// True when the case's punishments were lifted on appeal.
function caseIsAppealed(c) {
  return !!(c && (c.status === 'OVERTURNED' || c.appealedAt));
}

// Small purple chip naming who granted the appeal.
function appealBadge(c) {
  if (!caseIsAppealed(c)) return '';
  const by = c.appealedByName ? ` by ${c.appealedByName}` : '';
  return `<span class="badge badge-purple" title="${escapeHtml('Appeal granted' + by + (c.appealReason ? ': ' + c.appealReason : ''))}">`
       + `<span class="badge-dot"></span><i class="ti ti-gavel"></i> Appealed</span>`;
}

// ── Change diff rendering ────────────────────────────────────────
// Renders one recorded revision as an explicit before → after list, so it is
// obvious WHAT was updated rather than just that something was.
function renderRevision(rev, opts) {
  if (!rev || !Array.isArray(rev.changes) || !rev.changes.length) return '';
  opts = opts || {};
  const rows = rev.changes.map(ch => `
    <div class="diff-row">
      <div class="diff-label">${escapeHtml(ch.label)}</div>
      <div class="diff-values">
        <span class="diff-before">${ch.before ? escapeHtml(ch.before) : '<em>empty</em>'}</span>
        <i class="ti ti-arrow-right diff-arrow"></i>
        <span class="diff-after">${ch.after ? escapeHtml(ch.after) : '<em>empty</em>'}</span>
      </div>
    </div>`).join('');
  return `
    <div class="diff-block${opts.compact ? ' diff-compact' : ''}">
      <div class="diff-head">
        <span><i class="ti ti-git-compare"></i> ${escapeHtml(rev.by || 'The submitter')} updated this case</span>
        <span class="diff-when">${rev.at ? formatDateTime(rev.at) : ''}</span>
      </div>
      ${rev.addressedNote ? `<div class="diff-note">In response to: “${escapeHtml(rev.addressedNote)}”</div>` : ''}
      ${rows}
    </div>`;
}

// Every recorded revision, newest first.
function renderRevisionHistory(c) {
  const revs = (c && Array.isArray(c.reviewRevisions)) ? c.reviewRevisions.slice().reverse() : [];
  if (!revs.length) return '';
  return revs.map(r => renderRevision(r)).join('');
}

// Colour-coded punishment badges for the case ACTION column — mirrors the
// ticket TYPE badges so case logs read with the same "little indications".
//   Blacklist / Termination / Demotion → red
//   Strikes / Zero Tolerance           → amber
//   Warnings & everything else         → blue
function actionBadges(actionStr) {
  const names = String(actionStr == null ? '' : actionStr)
    .split(',').map(s => s.trim()).filter(Boolean);
  if (!names.length) return '<span class="text-muted">·</span>';
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
  if (!user) return '<span class="text-muted">·</span>';
  const initial = (user.discordUsername || '?')[0].toUpperCase();
  const avatarHtml = user.discordAvatar
    ? `<img class="inv-avatar" src="${user.discordAvatar}" alt="" />`
    : `<div class="inv-avatar-fallback">${initial}</div>`;
  return `<div class="investigator-cell">${avatarHtml}<span class="inv-name">${escapeHtml(user.discordUsername || '·')}</span></div>`;
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
  return (action || '').replace(/^\s*punishments?\s*:\s*/i, '').trim() || '·';
}

// Suspect/officer cell: Roblox username + headshot + profile link (Discord ID
// stays in the case detail only, not the row).
function officerCell(c) {
  if (!c.robloxUsername && !c.robloxUserId) {
    return '<span class="text-muted" style="font-size:11px;">·</span>';
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

// Escape text for interpolation into HTML — including into ATTRIBUTE values.
//
// The obvious `div.textContent = s; return div.innerHTML` trick escapes &, <
// and > but leaves quotes untouched, which is fine inside an element and unsafe
// inside `title="…"` / `href="…"` / `alt="…"`. This helper is used for both, so
// it escapes quotes as well: a reviewer's note containing a double quote would
// otherwise close the attribute and let the rest of the note become markup.
// The backtick is in the set too — IE-era attribute parsing treated it as a
// quote, and it costs nothing to keep out.
function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"'`]/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;',
  }[c]));
}
// Safe interpolation for a JS string literal inside an on* attribute, e.g.
// onclick="fn('${jsAttr(x)}')". HTML-entity escaping is NOT enough here — the
// browser HTML-decodes the attribute before the JS parser sees it, so a decoded
// quote would still break out of the string. So backslash-escape the JS
// specials and HTML-escape only the attribute-delimiter quote.
//
// The ampersand has to go FIRST, and it is not decoration: a value already
// containing the text "&#39;" survives every other rule here untouched, and then
// the HTML parser decodes it to a bare quote on the way to the JS parser — which
// is the exact break-out the backslash escaping was there to prevent. Escaping
// "&" to "&amp;" makes it decode back to the literal characters instead.
function jsAttr(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '&quot;')
    .replace(/</g, '\\x3C')
    .replace(/\r?\n/g, '\\n');
}
if (typeof window !== 'undefined') window.jsAttr = jsAttr;

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

// ── Global fetch hardening ───────────────────────────────────────────
// Ensure EVERY same-origin state-changing request carries the CSRF token +
// browser fingerprint, even raw fetch() calls that don't go through api()
// (file uploads, push subscribe, etc.). api() already sets them; this is the
// backstop so nothing is silently rejected by the CSRF gate.
(function () {
  if (window.__metFetchWrapped || typeof window.fetch !== 'function') return;
  window.__metFetchWrapped = true;
  const _fetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    try {
      init = init || {};
      const method = String(init.method || (input && typeof input === 'object' && input.method) || 'GET').toUpperCase();
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const sameOrigin = url.startsWith('/') || (location && url.startsWith(location.origin));
      if (sameOrigin && method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
        const h = new Headers(init.headers || (input && typeof input === 'object' ? input.headers : undefined) || {});
        if (!h.has('X-CSRF-Token')) { const t = getCsrfToken(); if (t) h.set('X-CSRF-Token', t); }
        init = Object.assign({}, init, { headers: h });
      }
    } catch (e) { /* never break fetch */ }
    return _fetch(input, init);
  };
})();

// ── Back-to-top button ───────────────────────────────────────────
// Appears on long pages once the member scrolls down; smooth-scrolls
// to the top. Self-contained, site-wide (ui.js loads almost everywhere).
(function () {
  if (typeof document === 'undefined') return;
  function init() {
    if (document.getElementById('back-to-top')) return;
    var b = document.createElement('button');
    b.id = 'back-to-top';
    b.type = 'button';
    b.setAttribute('aria-label', 'Back to top');
    b.setAttribute('title', 'Back to top');
    b.innerHTML = '<i class="ti ti-arrow-up"></i>';
    b.style.cssText =
      'position:fixed;right:18px;bottom:18px;z-index:9400;width:42px;height:42px;' +
      'border-radius:50%;border:1px solid var(--border,rgba(255,255,255,.14));' +
      'background:var(--panel-solid,#151821);color:var(--text-primary,#fff);' +
      'font-size:18px;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.4);' +
      'display:flex;align-items:center;justify-content:center;opacity:0;' +
      'pointer-events:none;transition:opacity .2s ease,transform .2s ease;transform:translateY(8px);';
    // The page may scroll on `window` OR on a `.main-content` pane (dashboards).
    // Pick whichever is actually scrolled so the arrow always jumps to the top.
    function scroller() {
      var mc = document.querySelector('.main-content');
      if (mc && mc.scrollHeight > mc.clientHeight + 40) return mc;
      return window;
    }
    function scrollY(s) { return s === window ? (window.pageYOffset || document.documentElement.scrollTop || 0) : (s.scrollTop || 0); }
    b.addEventListener('click', function () {
      var reduce = document.documentElement.getAttribute('data-reduce-motion') === '1';
      var s = scroller();
      try { s.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' }); }
      catch (e) { if (s === window) window.scrollTo(0, 0); else s.scrollTop = 0; }
    });
    document.body.appendChild(b);
    var shown = false;
    function onScroll() {
      var next = scrollY(scroller()) > 400;
      if (next === shown) return;
      shown = next;
      b.style.opacity = next ? '1' : '0';
      b.style.pointerEvents = next ? 'auto' : 'none';
      b.style.transform = next ? 'translateY(0)' : 'translateY(8px)';
    }
    // Listen on both window and any .main-content pane (whichever scrolls).
    window.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('scroll', function (e) {
      if (e.target && e.target.classList && e.target.classList.contains('main-content')) onScroll();
    }, { passive: true, capture: true });
    onScroll();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

// ── Keyboard-shortcut help overlay ───────────────────────────────
// Press "?" (Shift+/) anywhere outside a text field to see the shortcut
// cheatsheet. Esc or click-away closes it. Site-wide via ui.js.
(function () {
  if (typeof document === 'undefined') return;
  var SHORTCUTS = [
    { keys: ['⌘/Ctrl', 'K'], desc: 'Open command palette (jump anywhere)' },
    { keys: ['?'],           desc: 'Show this shortcut help' },
    { keys: ['Esc'],         desc: 'Close dialogs / palette' },
    { keys: ['↑', '↓'],      desc: 'Move selection in the command palette' },
    { keys: ['Enter'],       desc: 'Run the selected command' },
  ];
  var overlay = null;
  function keyCap(k) {
    return '<span style="display:inline-block;min-width:20px;text-align:center;padding:2px 7px;border:1px solid var(--border,rgba(255,255,255,.16));border-radius:6px;font-size:12px;font-family:var(--font-mono,monospace);background:var(--hover,rgba(255,255,255,.05));">' + k + '</span>';
  }
  function open() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.id = 'kbd-help';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:11500;background:rgba(0,0,0,.55);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;';
    var rows = SHORTCUTS.map(function (s) {
      return '<div style="display:flex;align-items:center;justify-content:space-between;gap:16px;padding:9px 0;border-bottom:1px solid var(--border,rgba(255,255,255,.07));">' +
        '<span style="font-size:13px;color:var(--text-secondary,#c8c8c8);">' + s.desc + '</span>' +
        '<span style="display:flex;gap:5px;flex-shrink:0;">' + s.keys.map(keyCap).join('') + '</span></div>';
    }).join('');
    overlay.innerHTML = '<div style="width:min(440px,92vw);background:var(--panel-solid,#151821);border:1px solid var(--border,#2a2a2a);border-radius:14px;box-shadow:0 24px 70px rgba(0,0,0,.55);padding:20px 22px;">' +
      '<div style="display:flex;align-items:center;gap:9px;margin-bottom:8px;"><i class="ti ti-keyboard" style="font-size:19px;color:var(--blue,#4a8fff);"></i><span style="font-size:15px;font-weight:600;">Keyboard shortcuts</span></div>' +
      rows + '<div style="margin-top:14px;text-align:right;"><button id="kbd-help-close" class="btn btn-ghost btn-sm">Close</button></div></div>';
    document.body.appendChild(overlay);
    var _mdKbd = null;
    overlay.addEventListener('mousedown', function (e) { _mdKbd = e.target === overlay ? overlay : null; });
    overlay.addEventListener('click', function (e) { if (e.target === overlay && _mdKbd === overlay) close(); _mdKbd = null; });
    var c = document.getElementById('kbd-help-close');
    if (c) c.addEventListener('click', close);
  }
  function close() { if (overlay) { overlay.remove(); overlay = null; } }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && overlay) { close(); return; }
    if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey) return;
    var t = e.target;
    var tag = t && t.tagName ? t.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || (t && t.isContentEditable)) return;
    e.preventDefault();
    overlay ? close() : open();
  });
})();

// ── Connectivity indicator ───────────────────────────────────────
// Shows a small banner when the browser goes offline and a toast when it
// comes back — helpful on mobile where connections drop mid-action.
(function () {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return;
  function banner(show) {
    var b = document.getElementById('net-offline-banner');
    if (show) {
      if (b) return;
      b = document.createElement('div');
      b.id = 'net-offline-banner';
      b.innerHTML = '<i class="ti ti-wifi-off"></i> You\'re offline · changes may not save until you reconnect.';
      b.style.cssText =
        'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:11800;' +
        'display:flex;align-items:center;gap:8px;padding:9px 16px;border-radius:999px;' +
        'font-size:13px;font-weight:600;color:#fff;background:#b4441f;' +
        'box-shadow:0 6px 22px rgba(0,0,0,.45);white-space:nowrap;';
      document.body.appendChild(b);
    } else if (b) {
      b.remove();
    }
  }
  window.addEventListener('offline', function () { banner(true); });
  window.addEventListener('online', function () {
    banner(false);
    if (window.showToast) showToast('Back online', 'success');
  });
  // Reflect the state at load (e.g. page opened while already offline).
  if (navigator.onLine === false) banner(true);
})();

// ── External-link hardening ──────────────────────────────────────
// Any target="_blank" link without rel="noopener" lets the opened page
// reach back via window.opener (tabnabbing). Harden static links on load
// and any links injected later via innerHTML.
(function () {
  if (typeof document === 'undefined') return;
  function harden(root) {
    var links = (root || document).querySelectorAll ? (root || document).querySelectorAll('a[target="_blank"]') : [];
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      var rel = (a.getAttribute('rel') || '');
      if (!/\bnoopener\b/.test(rel)) a.setAttribute('rel', (rel + ' noopener noreferrer').trim());
    }
  }
  function start() {
    harden(document);
    try {
      var mo = new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var added = muts[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            var n = added[j];
            if (n.nodeType !== 1) continue;
            if (n.tagName === 'A') harden(n.parentNode || document);
            else harden(n);
          }
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
    } catch (e) { /* observer unsupported → static sweep still applied */ }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

// ── Remember the active dashboard tab + section (this tab-session only) ──
// Dashboards switch ".page" sections via ".nav-item[data-page]" buttons and
// filter them with "[data-filter]" controls. We remember the active page and
// its filter so a REFRESH restores exactly where you were (the division itself
// is preserved by the URL). Stored in sessionStorage, so closing the browser
// tab wipes it → a fresh open defaults back to the dashboard/overview.
// Generic: works for any dashboard using these patterns, no per-dashboard code.
(function () {
  if (typeof document === 'undefined') return;
  function key() { return 'iacms_nav:' + location.pathname; }
  function esc(v) { return (window.CSS && CSS.escape) ? CSS.escape(String(v)) : String(v); }
  function load() { try { return JSON.parse(sessionStorage.getItem(key()) || '{}') || {}; } catch (e) { return {}; } }
  function save(s) { try { sessionStorage.setItem(key(), JSON.stringify(s)); } catch (e) {} }
  function activePage() {
    var a = document.querySelector('.nav-item[data-page].active');
    return a ? a.getAttribute('data-page') : null;
  }

  // Record clicks in the capture phase so it runs regardless of the dashboard's
  // own handlers — the active page, and the filter chosen within each page.
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('.nav-item[data-page],[data-filter]') : null;
    if (!el) return;
    var s = load();
    if (el.matches('.nav-item[data-page]')) {
      s.page = el.getAttribute('data-page');
    } else {
      s.filters = s.filters || {};
      s.filters[activePage() || s.page || '_'] = el.getAttribute('data-filter');
    }
    save(s);
  }, true);

  function restoreFilter(s) {
    var f = s.filters && s.filters[s.page];
    if (!f) return;
    var tries = 0;
    (function tryF() {
      var scope = document.getElementById('page-' + s.page) || document;
      var fb = scope.querySelector('[data-filter="' + esc(f) + '"]');
      if (fb && fb.offsetParent !== null) {
        if (!fb.classList.contains('active')) fb.click();
        return;
      }
      if (++tries < 10) setTimeout(tryF, 150);
    })();
  }

  function restore() {
    // Respect explicit deep links (e.g. #officer:123) — don't override them.
    if (location.hash && location.hash.length > 1) return;
    // Respect notification / query deep links (?page=…&case=…&ticket=…).
    try {
      var qp = new URLSearchParams(location.search || '');
      if (qp.get('page') || qp.get('case') || qp.get('ticket') || qp.get('officer')) return;
    } catch (err) { /* ignore */ }
    if (!document.querySelector('.nav-item[data-page]')) return; // not a tabbed dashboard
    var s = load();
    if (!s || !s.page) return; // fresh tab session → leave the default (dashboard)
    var tries = 0;
    (function attempt() {
      var btn = document.querySelector('.nav-item[data-page="' + esc(s.page) + '"]');
      // Only restore a tab that exists, is visible (not perms-hidden) and isn't already active.
      if (btn && btn.offsetParent !== null) {
        if (!btn.classList.contains('active')) btn.click();
        restoreFilter(s); // then re-apply the section/filter within that tab
        return;
      }
      if (++tries < 12) setTimeout(attempt, 180); // wait out async perms reveal (~2s max)
    })();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', restore);
  else restore();
})();

// ── Icon-font resilience ─────────────────────────────────────────
// The Tabler icon webfont normally loads from a CDN. On networks where the
// CDN is blocked/slow the glyphs vanish (empty squares) and the UI looks
// "broken" / empty. If the font isn't available shortly after load, pull in a
// self-hosted copy from /vendor/tabler/ so icons still render. Harmless if the
// local files aren't present (nothing to load); a no-op when the CDN worked.
(function () {
  if (typeof document === 'undefined' || !document.fonts || !document.fonts.check) return;
  function ensureIcons() {
    try {
      if (document.fonts.check('16px "tabler-icons"')) return; // CDN font is present
      if (document.getElementById('tabler-local')) return;
      var l = document.createElement('link');
      l.id = 'tabler-local'; l.rel = 'stylesheet';
      l.href = '/vendor/tabler/tabler-icons.min.css';
      document.head.appendChild(l);
    } catch (e) { /* ignore */ }
  }
  // Give the CDN a moment, then check (and re-check once more).
  document.fonts.ready.then(function () { setTimeout(ensureIcons, 800); setTimeout(ensureIcons, 2500); })
    .catch(function () { setTimeout(ensureIcons, 800); });
})();

// ── Links people can read ─────────────────────────────────────────
// A raw URL in a panel is a wall of characters nobody reads and everybody has
// to squint at — "https://docs.google.com/document/d/1aBcD…/edit?usp=sharing"
// tells you nothing that "Open the case file" does not. These render a link as
// a named chip instead, with the host underneath so it is still obvious where
// it goes before you click it.

// Only ever render a link the browser can safely follow.
function safeLinkHref(url) {
  const v = String(url == null ? '' : url).trim();
  if (!/^https?:\/\//i.test(v)) return null;
  try { const u = new URL(v); return /^https?:$/.test(u.protocol) ? u.href : null; }
  catch (e) { return null; }
}

function linkHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

function linkChip(url, label, icon) {
  const href = safeLinkHref(url);
  if (!href) return '<span class="text-muted" style="font-size:12px;">Not a link that can be opened.</span>';
  const host = linkHost(href);
  return '<a class="link-chip" href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer"'
    + ' title="' + escapeHtml(href) + '">'
    + '<i class="ti ti-' + (icon || 'external-link') + '"></i>'
    + '<span class="link-chip-label">' + escapeHtml(label || 'Open') + '</span>'
    + (host ? '<span class="link-chip-host">' + escapeHtml(host) + '</span>' : '')
    + '</a>';
}

// The exhibits captured off the case file, as a row of named chips.
function evidenceBlock(list) {
  const items = Array.isArray(list) ? list.filter(e => e && (e.url || e.note)) : [];
  if (!items.length) return '';
  const chips = items.map((e, i) => {
    const label = e.label || ('Exhibit ' + String.fromCharCode(65 + i));
    if (!safeLinkHref(e.url)) {
      return '<span class="link-chip link-chip-dead" title="No usable link">'
        + '<i class="ti ti-paperclip-off"></i>'
        + '<span class="link-chip-label">' + escapeHtml(label) + '</span>'
        + (e.note ? '<span class="link-chip-host">' + escapeHtml(String(e.note).slice(0, 60)) + '</span>' : '')
        + '</span>';
    }
    return linkChip(e.url, label, 'paperclip');
  }).join('');
  return '<div class="detail-field full">'
    + '<span class="detail-field-label">Evidence · ' + items.length + '</span>'
    + '<span class="detail-field-value"><div class="link-chips">' + chips + '</div></span>'
    + '</div>';
}

if (typeof window !== 'undefined') {
  window.safeLinkHref = safeLinkHref;
  window.linkChip     = linkChip;
  window.evidenceBlock = evidenceBlock;
}
