// client/public/js/dashboard.js

// ── Constants ─────────────────────────────────────────────────────
// Note: roleIds here are advisory only — the server resolves the real role from
// its env-driven config at approval time. Timed actions (Zero Tolerance,
// Suspension) show a duration select and auto-expire.
const ACTIONS_CLIENT = [
  { name: 'Verbal Warning',        roleId: null,                  exile: false },
  { name: 'Written Warning',       roleId: null,                  exile: false },
  { name: 'Zero Tolerance',        roleId: '1452275521470726235', exile: false, timed: true },
  { name: 'Suspension',            roleId: null,                  exile: false, timed: true },
  { name: 'Activity Strike',       roleId: '1219011548714893343', exile: false },
  { name: 'Disciplinary Strike 1', roleId: '1191048287361433738', exile: false },
  { name: 'Disciplinary Strike 2', roleId: '1191048287361433739', exile: false },
  { name: 'Disciplinary Strike 3', roleId: '1513101097978564739', exile: false },
  { name: 'Demotion',              roleId: null,                  exile: false },
  { name: 'Termination',           roleId: null,                  exile: true  },
  { name: 'Blacklist',             roleId: '1195557302250524764', exile: true  },
];

const DURATION_OPTIONS = [
  { label: '1 Day',     days: 1    },
  { label: '3 Days',    days: 3    },
  { label: '7 Days',    days: 7    },
  { label: '14 Days',   days: 14   },
  { label: '30 Days',   days: 30   },
  { label: 'Permanent', days: null },
];

function actionSlug(name) { return name.replace(/\s+/g, '-').toLowerCase(); }

// ── State ─────────────────────────────────────────────────────────
let currentUser         = null;
let allCasesCache       = [];
let dashFilter          = 'all';
let allPageFilter       = 'all';
let blacklistTargetId   = null;
let officerProfile      = null;
let importedCaseExtra   = null;  // identity fields autofilled from a parsed case doc
let editingCaseId       = null;  // when set, the submit modal is editing this case
let editingCaseApproved = false; // whether the case being edited is APPROVED
let groupRolesCache     = null;
let groupMembersNextToken = null;
let securityCache       = [];
let groupMembersCache   = [];
let pendingCache        = [];
// Bot account's rank — members at this rank or above cannot be managed by the bot
const BOT_RANK_NAME     = 'Deputy Assistant Commissioner';
// The managing bot account (METAdministration). Its live rank in each group is
// the real ceiling: Roblox rejects managing anyone at the bot's rank or above.
const MET_ADMIN_USER_ID = '11077193582';

// ── Init ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadCurrentUser();
  setupNav();
  setupNewCaseButtons();
  setupSubmitCase();
  setupDocImport();
  setupCaseModeTabs();
  setupFilterTabs();
  setupOfficerLookup();
  renderActionChecklist();
  // Developer division lands on the Dev Panel; IA lands on the dashboard.
  if (isDevContext() && currentUser && currentUser.role === 'DEVELOPER') navigateTo('admin');
  else loadDashboard();
  startNavBadgePolling();   // keep the pending case/ticket badges current
  showClassifiedNotice();
  startSessionHeartbeat();
  handleNotificationLaunch(); // open a case/ticket if arriving from a notification
});

// Keep the sidebar "pending" badges (cases + tickets) up to date without having
// to open the relevant tab — refreshes on load, on a timer, and whenever the
// tab regains focus (so counts are current when you come back to an open tab).
async function refreshNavBadges() {
  try {
    const [caseStats, caseMineStats, ticketStats] = await Promise.all([
      api('/api/cases/stats').catch(() => null),           // scope depends on role (all-pending for elevated)
      api('/api/cases/stats?scope=mine').catch(() => null), // always the user's OWN pending
      api('/api/tickets/stats').catch(() => null),
    ]);
    const setBadge = (id, n) => {
      const el = document.getElementById(id);
      if (el) { el.textContent = n; el.style.display = n > 0 ? '' : 'none'; }
    };
    if (caseStats)     setBadge('nav-badge-review', caseStats.pending || 0);      // Pending Cases (review)
    if (caseMineStats) setBadge('nav-badge-my',     caseMineStats.pending || 0);  // My Cases (own pending)
    if (ticketStats) {
      setBadge('nav-badge-tickets',       ticketStats.pending || 0);
      setBadge('nav-badge-ticket-review', ticketStats.pendingAll != null ? ticketStats.pendingAll : 0);
    }
  } catch (e) { /* non-blocking */ }
}

let _navBadgeTimer = null;
function startNavBadgePolling() {
  refreshNavBadges();
  if (_navBadgeTimer) clearInterval(_navBadgeTimer);
  _navBadgeTimer = setInterval(refreshNavBadges, 45 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshNavBadges(); });
  window.addEventListener('focus', refreshNavBadges);
}

// ── Pending-ticket nav badge (loaded on startup) ──────────────────
async function loadTicketNavBadge() {
  try {
    const stats = await api('/api/tickets/stats');
    if (!stats) return;
    // My Tickets badge = the user's OWN pending submissions
    const badge = document.getElementById('nav-badge-tickets');
    if (badge) {
      badge.textContent   = stats.pending;
      badge.style.display = stats.pending > 0 ? '' : 'none';
    }
    // Pending Tickets (review) badge = EVERY pending ticket (HICOMM/Supervisor)
    const reviewBadge = document.getElementById('nav-badge-ticket-review');
    if (reviewBadge) {
      const allPending = stats.pendingAll != null ? stats.pendingAll : 0;
      reviewBadge.textContent   = allPending;
      reviewBadge.style.display = allPending > 0 ? '' : 'none';
    }
  } catch (err) { /* non-blocking */ }
}

// ── Session heartbeat — picks up blacklist/revoke within ~20s ─────
function startSessionHeartbeat() {
  setInterval(() => {
    // api() auto-redirects to login/denied on 401/403, so a plain ping suffices
    fetch('/api/me', { credentials: 'same-origin' }).then(r => {
      if (r.status === 401 || r.status === 403) {
        r.json().catch(() => ({})).then(d => {
          if (/blacklist/i.test((d && d.error) || '')) window.location.href = '/denied?reason=blacklisted';
          else window.location.href = '/login?error=access_revoked';
        });
      }
    }).catch(() => {});
  }, 20000);
}

// ── Classified information notice (shown once per session) ────────
function showClassifiedNotice() {
  let alreadyAcked = false;
  try { alreadyAcked = sessionStorage.getItem('iacms_classified_ack') === '1'; } catch (e) {}
  if (alreadyAcked) {
    // Rules already acknowledged this session — go straight to the opt-in check.
    maybeShowNotifyOptIn();
    return;
  }
  const btn = document.getElementById('btn-ack-classified');
  if (btn) {
    btn.onclick = () => {
      try { sessionStorage.setItem('iacms_classified_ack', '1'); } catch (e) {}
      closeModal('modal-classified');
      maybeShowNotifyOptIn(); // ask about notifications once the rules are accepted
    };
  }
  openModal('modal-classified');
}

// ── Load current user ─────────────────────────────────────────────
async function loadCurrentUser() {
  try {
    currentUser = await api('/api/me');
    if (!currentUser) return;

    const img      = document.getElementById('user-avatar');
    const fallback = document.getElementById('user-avatar-fallback');
    if (currentUser.discordAvatar) {
      img.src = currentUser.discordAvatar; img.style.display = 'block';
      if (fallback) fallback.style.display = 'none';
    } else {
      if (fallback) fallback.textContent = (currentUser.displayName || currentUser.discordUsername || '?')[0].toUpperCase();
    }

    const nameEl = document.getElementById('user-name');
    if (nameEl) nameEl.textContent = currentUser.displayName || currentUser.discordUsername || 'Unknown';

    const roleEl = document.getElementById('user-role-badge');
    if (roleEl) {
      const labels  = { DEVELOPER: 'Developer', HICOMM: 'HICOMM', SUPERVISOR: 'Supervisor', IA: 'Internal Affairs' };
      const classes = { DEVELOPER: 'dev', HICOMM: 'hicomm', SUPERVISOR: 'hicomm', IA: 'ia' };
      roleEl.textContent = labels[currentUser.role] || currentUser.role;
      roleEl.className   = `user-role-badge ${classes[currentUser.role] || 'ia'}`;
    }

    if (['HICOMM', 'SUPERVISOR', 'DEVELOPER'].includes(currentUser.role))
      document.querySelectorAll('.hicomm-only, .supervisor-only').forEach(el => el.style.display = '');
    if (['HICOMM', 'DEVELOPER'].includes(currentUser.role))
      document.querySelectorAll('.hicomm-strict-only').forEach(el => el.style.display = '');

    // Developer tools now live in their OWN "Developer" division (/dev/dashboard),
    // not mixed into the Internal Affairs section. The dev nav is therefore only
    // revealed in that context — never on the IA dashboard, even for developers.
    if (isDevContext() && currentUser.role === 'DEVELOPER') applyDevContext();

    // Register the service worker for elevated roles (no permission prompt yet)
    if (window.pushClient) window.pushClient.initForStaff(currentUser.role).catch(() => {});
  } catch (err) { console.error('Failed to load user:', err); }
}

// ── One-time notification opt-in prompt (after rules acknowledged) ──
async function maybeShowNotifyOptIn() {
  if (!currentUser || !['HICOMM', 'SUPERVISOR', 'DEVELOPER'].includes(currentUser.role)) return;
  if (!window.pushClient || !window.pushClient.supported()) return;
  let state;
  try { state = await api('/api/notifications/me'); } catch { return; }
  if (state.asked) return; // only ever ask once

  const ack = async () => { try { await api('/api/notifications/ack', { method: 'POST' }); } catch {} };

  const yesBtn = document.getElementById('btn-notify-yes');
  const noBtn  = document.getElementById('btn-notify-no');
  if (yesBtn) yesBtn.onclick = async () => {
    closeModal('modal-notify-optin');
    await ack();
    openModal('modal-notify-allow');
    const result = await window.pushClient.requestPushPermission();
    closeModal('modal-notify-allow');
    if (result === 'granted') {
      await api('/api/notifications/settings', { method: 'PATCH', body: JSON.stringify({ enabled: true }) }).catch(() => {});
      showToast('Notifications enabled.', 'success');
    } else if (result === 'denied') {
      showToast('Notifications were blocked. You can enable them later in Notifications settings.', 'info');
    }
  };
  if (noBtn) noBtn.onclick = async () => {
    closeModal('modal-notify-optin');
    await ack();
  };
  openModal('modal-notify-optin');
}

// ── Developer division context ─────────────────────────────────────
// The IA dashboard view is reused for the Developer division at /dev/dashboard.
// In that context we show ONLY the developer tools and hide the IA nav, so the
// two are cleanly separated (dev tools are no longer part of the IA section).
function isDevContext() { return location.pathname.startsWith('/dev'); }

function applyDevContext() {
  // Reveal the developer nav + pages.
  document.querySelectorAll('.dev-only').forEach(el => el.style.display = '');
  // Hide every non-developer nav entry (Overview / Cases / Tickets / Tools /
  // Review / Oversight) — the Developer division shows dev tools only.
  document.querySelectorAll('.sidebar-nav .nav-item, .sidebar-nav .nav-section-label').forEach(el => {
    if (!el.classList.contains('dev-only')) el.style.display = 'none';
  });
  // Rebrand the sidebar + tab for the Developer division.
  const bn = document.querySelector('.brand-name'); if (bn) bn.textContent = 'MET · DEV';
  const bs = document.querySelector('.brand-sub');  if (bs) bs.textContent = 'Developer Tools';
  document.title = 'MET · Developer';
}

// ── Navigation ────────────────────────────────────────────────────
function setupNav() {
  document.querySelectorAll('.nav-item[data-page]').forEach(btn =>
    btn.addEventListener('click', () => navigateTo(btn.dataset.page))
  );
}

function navigateTo(pageId) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const navBtn = document.querySelector(`.nav-item[data-page="${pageId}"]`);
  if (navBtn) navBtn.classList.add('active');
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const page = document.getElementById(`page-${pageId}`);
  if (page) page.classList.add('active');

  const loaders = {
    dashboard:   loadDashboard,
    'my-cases':  loadMyCases,
    review:      loadReview,
    'all-cases': loadAllCases,
    audit:       loadAudit,
    admin:           loadAdmin,
    group:           loadGroupPanel,
    visits:          loadVisits,
    security:        loadSecurity,
    tickets:         loadTickets,
    'all-tickets':   loadAllTickets,
    'ticket-review': loadTicketReview,
    'support-tickets': (typeof loadSupportTickets === 'function' ? loadSupportTickets : null),
    records:         (typeof loadRecords === 'function' ? loadRecords : null),
    'quota-check':   (typeof loadQuotaCheck === 'function' ? loadQuotaCheck : null),
    'ai-review':     (typeof loadAiReview === 'function' ? loadAiReview : null),
    'site-control':  loadSiteControl,
    'notif-settings': loadNotifSettings,
    'send-notif':    loadDevNotifSender,
    media:           (typeof loadMedia === 'function' ? loadMedia : null),
    'media-admin':   (typeof loadMediaAdmin === 'function' ? loadMediaAdmin : null),
    gamelogs:        loadDevGameLogs,
  };
  if (loaders[pageId]) return loaders[pageId]();
}

// ── Game Logs (in-game Adonis / join / leave / chat feed) ──────────
const DEV_GL_ICON = { ADONIS: ['ti-shield-bolt', '#f59e0b'], JOIN: ['ti-login', '#2ed896'], LEAVE: ['ti-logout', '#8b93a1'], CHAT: ['ti-message', '#3b82f6'] };
async function loadDevGameLogs() {
  const srcEl = document.getElementById('dev-gl-source');
  const qEl   = document.getElementById('dev-gl-q');
  const tb    = document.getElementById('dev-gl-tbody');
  if (!tb) return;
  const src = srcEl ? srcEl.value : '';
  const q   = qEl ? qEl.value.trim() : '';
  tb.innerHTML = '<tr><td colspan="6" class="table-loading"><div class="spinner"></div></td></tr>';
  let rows;
  try { rows = await api(`/api/dev/game-logs?source=${encodeURIComponent(src)}&q=${encodeURIComponent(q)}`); }
  catch (e) { tb.innerHTML = `<tr><td colspan="6" class="table-empty-text">${escapeHtml(e.message)}</td></tr>`; return; }
  tb.innerHTML = rows.length ? rows.map(g => {
    const [ic, col] = DEV_GL_ICON[g.source] || ['ti-point', '#888'];
    return `<tr><td style="white-space:nowrap;font-size:12px;color:var(--text-muted);">${escapeHtml(formatDateTime(g.createdAt))}</td>
      <td><span style="color:${col};"><i class="ti ${ic}"></i> ${escapeHtml(g.source)}</span></td>
      <td>${escapeHtml(g.actor || '—')}</td>
      <td>${g.action ? `<span class="mono" style="font-size:11px;">${escapeHtml(g.action)}</span>` : '—'}</td>
      <td>${escapeHtml(g.target || '—')}</td>
      <td style="max-width:360px;">${escapeHtml(g.message || '')}</td></tr>`;
  }).join('') : '<tr><td colspan="6" class="table-empty"><div class="table-empty-text">No game logs yet.</div></td></tr>';
}
let _devGlT = null;
document.addEventListener('input', (e) => { if (e.target && e.target.id === 'dev-gl-q') { clearTimeout(_devGlT); _devGlT = setTimeout(loadDevGameLogs, 250); } });

// ── Developer Imports tab ──────────────────────────────────────────
async function runPatrolBackfill() {
  const btn = document.getElementById('imp-patrol-btn');
  const out = document.getElementById('imp-patrol-result');
  if (!(await uiConfirm('Import every patrol & event log from the channels? Runs in the background and adds any missing logs as approved.'))) return;
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader-2"></i> Starting…'; }
  if (out) out.innerHTML = '';
  try {
    const r = await api('/api/dev/patrol-backfill', { method: 'POST' });
    if (out) out.innerHTML = `<span style="color:var(--green);"><i class="ti ti-check"></i> ${escapeHtml(r.message || 'Import started.')}</span>`;
  } catch (e) {
    if (out) out.innerHTML = `<span style="color:var(--red);"><i class="ti ti-alert-triangle"></i> ${escapeHtml(e.message)}</span>`;
  } finally { if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-download"></i> Import patrol &amp; event logs'; } }
}

async function runIaSync() {
  const btn = document.getElementById('imp-ia-btn');
  const out = document.getElementById('imp-ia-result');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader-2"></i> Syncing…'; }
  if (out) out.innerHTML = '';
  try {
    const r = await api('/api/dev/ia-sync', { method: 'POST' });
    // Surface a sub-sync failure (e.g. IA_DATABASE_URL wrong, or an IA schema/
    // column mismatch) instead of a meaningless "+?/?" — that's what makes a
    // silent failure look like "nothing happened".
    const failed = (r.cases && r.cases.ok === false) || (r.tickets && r.tickets.ok === false);
    const fmt = (lbl, x) => {
      if (!x) return `${lbl}: —`;
      if (x.ok === false) return `${lbl}: ⚠ ${x.reason || 'failed'}`;
      return `${lbl}: +${x.synced != null ? x.synced : '?'}/${x.total != null ? x.total : '?'}${x.skipped ? ` (${x.skipped} skipped)` : ''}`;
    };
    if (out) out.innerHTML = failed
      ? `<span style="color:var(--amber,#e8842a);"><i class="ti ti-alert-triangle"></i> ${escapeHtml(fmt('Cases', r.cases))} · ${escapeHtml(fmt('Tickets', r.tickets))}</span>`
      : `<span style="color:var(--green);"><i class="ti ti-check"></i> Synced. ${escapeHtml(fmt('Cases', r.cases))} · ${escapeHtml(fmt('Tickets', r.tickets))}</span>`;
  } catch (e) {
    if (out) out.innerHTML = `<span style="color:var(--red);"><i class="ti ti-alert-triangle"></i> ${escapeHtml(e.message)}</span>`;
  } finally { if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-refresh"></i> Sync IA cases &amp; tickets'; } }
}

// ── Open a case/ticket from a clicked notification ─────────────────
// Navigates to the right page, waits for its list to load, then opens the
// item — or tells the user it's no longer pending if it has been reviewed.
async function handleNotificationTarget(page, caseId, ticketId) {
  if (!page) return;
  try { await navigateTo(page); } catch (e) {}

  if (caseId) {
    // loadReview populates allCasesCache with the currently-pending cases.
    const c = (allCasesCache || []).find(x => x.id === caseId);
    if (c && c.status === 'PENDING') openDetail(caseId);
    else showToast('This case is no longer pending — it has already been reviewed.', 'info');
  }

  if (ticketId) {
    let t = null;
    try { t = await api('/api/tickets/' + ticketId); } catch (e) {}
    if (t && t.status === 'PENDING') openTicketDetail(ticketId);
    else showToast('This ticket log is no longer pending — it has already been reviewed.', 'info');
  }
}

// On a fresh load triggered by a notification click, the SW opens
// /dashboard?page=review&case=<id>. Handle it once init has finished, then
// clean the URL so a manual refresh doesn't re-trigger the modal.
async function handleNotificationLaunch() {
  const p = new URLSearchParams(window.location.search);
  const page = p.get('page');
  const caseId = p.get('case');
  const ticketId = p.get('ticket');
  if (page) {
    // Notification deep-link (page-scoped, status-aware).
    await handleNotificationTarget(page, caseId, ticketId);
  } else if (caseId) {
    // Shared "Copy link" deep-link — open the case detail regardless of status.
    await openCaseDeepLink(caseId);
  } else if (ticketId) {
    await openTicketDeepLink(ticketId);
  } else {
    return;
  }
  try { history.replaceState({}, '', '/ia/dashboard'); } catch (e) {}
}
window.handleNotificationTarget = handleNotificationTarget;

// From All Cases, jump to the Pending Cases tab and open the case detail so
// elevated staff can approve/deny it there.
async function goReviewCase(caseId) {
  try { await navigateTo('review'); } catch (e) {}
  let c = (allCasesCache || []).find(x => x.id === caseId);
  if (!c) { try { c = await api('/api/cases/' + caseId); if (c) allCasesCache.push(c); } catch (e) {} }
  if (c && c.status === 'PENDING') openDetail(caseId);
  else showToast('This case is no longer pending.', 'info');
}

// Open a case detail from a shared link, fetching it if it's not already loaded.
async function openCaseDeepLink(caseId) {
  const elevated = ['HICOMM', 'SUPERVISOR', 'DEVELOPER'].includes(currentUser?.role);
  try { await navigateTo(elevated ? 'all-cases' : 'my-cases'); } catch (e) {}
  let c = (allCasesCache || []).find(x => x.id === caseId);
  if (!c) {
    try { c = await api('/api/cases/' + caseId); if (c) allCasesCache.push(c); }
    catch (e) { showToast("That case couldn't be found or you don't have access.", 'info'); return; }
  }
  if (c) openDetail(caseId);
}

// Open a ticket detail from a shared link (openTicketDetail fetches it fresh).
async function openTicketDeepLink(ticketId) {
  const elevated = ['HICOMM', 'SUPERVISOR', 'DEVELOPER'].includes(currentUser?.role);
  try { await navigateTo(elevated ? 'all-tickets' : 'tickets'); } catch (e) {}
  if (typeof openTicketDetail === 'function') openTicketDetail(ticketId);
}

// Copy a shareable deep-link to a case/ticket detail.
function copyCaseLink(caseId) { copyDeepLink('/ia/dashboard?case=' + caseId); }
function copyTicketLink(ticketId) { copyDeepLink('/ia/dashboard?ticket=' + ticketId); }
function copyDeepLink(path) {
  const url = location.origin + path;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(
      function () { showToast('Link copied.', 'success'); },
      function () { uiPrompt('Copy this link:', { title: 'Copy link', value: url, confirmText: 'Done' }); });
  } else {
    uiPrompt('Copy this link:', { title: 'Copy link', value: url, confirmText: 'Done' });
  }
}

// ── New case modal ────────────────────────────────────────────────
function setupNewCaseButtons() {
  document.getElementById('btn-new-case-dash')?.addEventListener('click', openNewCaseModal);
  document.querySelectorAll('.btn-new-case').forEach(btn => btn.addEventListener('click', openNewCaseModal));
}

// Draft persistence: a new-case draft is kept in the DOM while the modal is
// closed, so reopening resumes it. It clears on submit and on page refresh
// (the flag + DOM both reset on reload).
let caseDraftActive = false;

function resetCaseForm() {
  officerProfile = null;
  importedCaseExtra = null;
  editingCaseId = null;
  editingCaseApproved = false;
  const resultEl = document.getElementById('officer-lookup-result');
  if (resultEl) resultEl.style.display = 'none';
  const impRes = document.getElementById('import-doc-result');
  if (impRes) impRes.style.display = 'none';
  const idEl = document.getElementById('f-officer-id');
  if (idEl) idEl.value = '';
  ['f-reason', 'f-notes', 'f-case-link', 'f-import-url'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  // Restore submit-mode chrome (in case we were last editing)
  const title = document.querySelector('#modal-submit .modal-title');
  if (title) title.innerHTML = '<i class="ti ti-file-plus" style="font-size:18px;"></i> Submit New Case';
  const sbtn = document.getElementById('btn-submit-case');
  if (sbtn) sbtn.innerHTML = '<i class="ti ti-send"></i> Submit Case';
  const importBox = document.getElementById('f-import-url')?.closest('.form-group');
  if (importBox) importBox.style.display = '';
  // Fresh case: no method picked yet — show only the selector until they choose.
  if (typeof setCaseMode === 'function') setCaseMode('');
  aiEvidence = [];
  if (typeof renderEvidenceList === 'function') renderEvidenceList();
  ['ai-email', 'ai-penal'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const aiRes = document.getElementById('ai-doc-result'); if (aiRes) aiRes.style.display = 'none';
  renderActionChecklist();
}

function openNewCaseModal() {
  // Start fresh only if there's no draft in progress (or we were editing).
  if (!caseDraftActive || editingCaseId) { resetCaseForm(); caseDraftActive = true; }
  showNextCaseRef();
  openModal('modal-submit');
}

// ── Case creation mode (Manual vs AI document) ────────────────────
function setupCaseModeTabs() {
  document.querySelectorAll('#case-mode-tabs .filter-tab').forEach(tab =>
    tab.addEventListener('click', () => setCaseMode(tab.dataset.casemode)));
}
// mode '' / null → nothing picked yet: show only the selector chips.
function setCaseMode(mode) {
  document.querySelectorAll('#case-mode-tabs .filter-tab').forEach(t => {
    if (t.disabled) return;
    t.classList.toggle('active', !!mode && t.dataset.casemode === mode);
  });
  const imp    = document.getElementById('case-manual-import');
  const ai     = document.getElementById('case-ai-section');
  const fields = document.getElementById('case-fields');
  const link   = document.getElementById('case-link-group');
  if (!mode) { // pick a method first — hide the import panel and all fields
    if (imp)    imp.style.display    = 'none';
    if (ai)     ai.style.display     = 'none';
    if (fields) fields.style.display = 'none';
    return;
  }
  // Import panel only in import mode; AI section only in (the disabled) ai mode.
  if (imp)    imp.style.display    = mode === 'import' ? '' : 'none';
  if (ai)     ai.style.display     = mode === 'ai' ? '' : 'none';
  if (fields) fields.style.display = '';
  // In AI mode the case link is generated automatically — hide the manual field.
  if (link)   link.style.display   = mode === 'ai' ? 'none' : '';
  // Import mode greys the manual fields until a doc import fills them; manual mode
  // leaves them immediately editable.
  setCaseFieldsEnabled(mode !== 'import');
}
function setCaseFieldsEnabled(enabled) {
  const box = document.getElementById('case-fields'); if (!box) return;
  box.style.opacity      = enabled ? '' : '0.5';
  box.style.pointerEvents = enabled ? '' : 'none';
  box.querySelectorAll('input, textarea, select, button').forEach(el => { el.disabled = !enabled; });
}

// Evidence collected for the AI document
let aiEvidence = [];
function renderEvidenceList() {
  const box = document.getElementById('ai-evidence-list');
  if (!box) return;
  box.innerHTML = aiEvidence.map((e, i) => {
    const label = String.fromCharCode(65 + i);
    if (e.kind === 'link') {
      return `<div style="display:flex;gap:6px;align-items:center;">
        <span style="font-size:11px;color:var(--text-muted);width:14px;">${label}</span>
        <input type="text" class="form-control" style="flex:1;font-size:12px;padding:5px 8px;" placeholder="https://medal.tv/… or any link" value="${escapeHtml(e.url || '')}" oninput="aiEvidence[${i}].url=this.value" />
        <button class="btn btn-ghost btn-sm" type="button" onclick="removeEvidence(${i})"><i class="ti ti-x"></i></button>
      </div>`;
    }
    return `<div style="display:flex;gap:6px;align-items:center;">
      <span style="font-size:11px;color:var(--text-muted);width:14px;">${label}</span>
      <span style="flex:1;font-size:12px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"><i class="ti ti-paperclip"></i> ${escapeHtml(e.name || e.filename)}</span>
      <button class="btn btn-ghost btn-sm" type="button" onclick="removeEvidence(${i})"><i class="ti ti-x"></i></button>
    </div>`;
  }).join('') || '<div style="font-size:11px;color:var(--text-muted);">No evidence added yet.</div>';
}
function addEvidenceLinkRow() { aiEvidence.push({ kind: 'link', url: '' }); renderEvidenceList(); }
function removeEvidence(i) { aiEvidence.splice(i, 1); renderEvidenceList(); }
function addEvidenceFiles(files) {
  Array.prototype.forEach.call(files || [], f => {
    const r = new FileReader();
    r.onload = e => { aiEvidence.push({ kind: 'file', dataBase64: e.target.result, mimeType: f.type, filename: f.name, name: f.name }); renderEvidenceList(); };
    r.readAsDataURL(f);
  });
  const inp = document.getElementById('ai-evidence-file'); if (inp) inp.value = '';
}

async function generateAiDocument() {
  const v = id => (document.getElementById(id) || {}).value || '';
  const email = v('ai-email').trim();
  const penalCodes = v('ai-penal').split(',').map(s => s.trim()).filter(Boolean);
  // Suspect details come from the officer lookup (same source as Records).
  const suspectName = (officerProfile && (officerProfile.robloxUsername || officerProfile.username)) || '';
  const suspectRank = (officerProfile && officerProfile.groupRole) || '';
  const suspectId   = (officerProfile && (officerProfile.discordId || officerProfile.robloxId)) || '';
  const punishment  = getSelectedActions().map(a => a.action).join(', ');

  if (!officerProfile || !suspectName) { showToast('Look up the officer (suspect) first.', 'error'); return; }
  if (!email)            { showToast('Enter your email address.', 'error'); return; }
  if (!penalCodes.length){ showToast('Enter at least one penal code.', 'error'); return; }
  if (!punishment)       { showToast('Select at least one punishment.', 'error'); return; }

  const evidence = aiEvidence
    .map(e => e.kind === 'link' ? { url: e.url } : { dataBase64: e.dataBase64, mimeType: e.mimeType, filename: e.filename })
    .filter(e => (e.url && e.url.trim()) || e.dataBase64);

  const btn = document.getElementById('btn-ai-generate');
  const resEl = document.getElementById('ai-doc-result');
  if (btn) { btn.disabled = true; btn.innerHTML = "<div class='spinner'></div> Generating…"; }
  try {
    const d = await api('/api/cases/ai-document', { method: 'POST', body: JSON.stringify({
      email, penalCodes, punishment,
      suspect: { user: suspectName, rank: suspectRank, userId: suspectId },
      evidence,
    }) });
    const linkEl = document.getElementById('f-case-link'); if (linkEl) linkEl.value = d.url || '';
    const reasonEl = document.getElementById('f-reason');
    if (reasonEl && Array.isArray(d.allegations))
      reasonEl.value = d.allegations.map(a => a.code + (a.offense ? ' (' + a.offense + ')' : '')).join(', ');
    if (resEl) {
      resEl.style.display = '';
      resEl.innerHTML = "<i class='ti ti-circle-check'></i> Document created &amp; shared with you. <a href='" + escapeHtml(d.url) + "' target='_blank' rel='noopener' style='color:var(--blue);'>Open document</a> — review it, then Submit Case below.";
    }
    showToast('Case document generated.', 'success');
  } catch (err) {
    if (resEl) { resEl.style.display = ''; resEl.innerHTML = "<span style='color:var(--red);'>" + escapeHtml(err.message || 'Failed to generate document.') + "</span>"; }
    showToast(err.message || 'Failed to generate document.', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = "<i class='ti ti-sparkles'></i> Generate Case Document"; }
  }
}

// Show the (estimated) case ID the next submission will receive.
async function showNextCaseRef() {
  const box = document.getElementById('next-case-ref-notice');
  const val = document.getElementById('next-case-ref-val');
  if (!box || !val) return;
  try {
    const d = await api('/api/cases/next-ref');
    if (d && d.nextRef) { val.textContent = d.nextRef; box.style.display = ''; }
    else box.style.display = 'none';
  } catch { box.style.display = 'none'; }
}

// Open the submit modal in edit mode for an existing case (HICOMM / Developer)
function openEditCase(caseId) {
  const c = allCasesCache.find(x => x.id === caseId);
  if (!c) return;
  closeModal('modal-detail');
  officerProfile = null;
  importedCaseExtra = null;
  editingCaseId = c.id;
  editingCaseApproved = c.status === 'APPROVED';
  caseDraftActive = false; // editing isn't a resumable new-case draft

  // Editing works on the manual form (fields editable, import panel hidden).
  if (typeof setCaseMode === 'function') setCaseMode('manual');

  document.getElementById('f-officer-id').value = c.officerDiscordId || c.robloxUserId || '';
  document.getElementById('f-reason').value     = c.reason || '';
  document.getElementById('f-notes').value      = (c.notes && c.notes !== 'N/A') ? c.notes : '';
  document.getElementById('f-case-link').value  = c.caseLink || '';
  const impRes = document.getElementById('import-doc-result'); if (impRes) impRes.style.display = 'none';
  const lookRes = document.getElementById('officer-lookup-result'); if (lookRes) lookRes.style.display = 'none';
  const refNotice = document.getElementById('next-case-ref-notice'); if (refNotice) refNotice.style.display = 'none';

  renderActionChecklist();
  applyDocPunishments(Array.isArray(c.actions) && c.actions.length ? c.actions : [{ action: c.action }], true);

  const title = document.querySelector('#modal-submit .modal-title');
  if (title) title.innerHTML = '<i class="ti ti-edit" style="font-size:18px;"></i> Edit Case ' + escapeHtml(c.caseRef);
  const sbtn = document.getElementById('btn-submit-case');
  // Only approved cases re-post (update the original log); otherwise edit only
  if (sbtn) sbtn.innerHTML = editingCaseApproved
    ? '<i class="ti ti-device-floppy"></i> Save & Update Log'
    : '<i class="ti ti-device-floppy"></i> Save Changes';
  // Hide the doc-import box while editing
  const importBox = document.getElementById('f-import-url')?.closest('.form-group');
  if (importBox) importBox.style.display = 'none';
  openModal('modal-submit');

  // If a reviewer requested changes, offer the submitter a one-click apply.
  if (c.reviewNote && c.status === 'PENDING') promptApplyChanges(c);
}

// ── Import a case from a Google Doc link ──────────────────────────
function setupDocImport() {
  document.getElementById('btn-import-doc')?.addEventListener('click', importCaseFromDoc);
  document.getElementById('f-import-url')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); importCaseFromDoc(); }
  });
}

// Check exactly the doc's punishments in the checklist (clears others first).
// Classify the penal code in the Reason field (autofilled from the doc's
// Allegations). The class is encoded in the code prefix:
//   MC-S… → Severe Violation, PL-M… → Minor Violation,
//   ZF-B… → Blacklist,        TA-D… → Termination
function penalCodeClass(reason) {
  const s = String(reason || '').toUpperCase();
  if (/\bMC-?S\s*\d/.test(s)) return 'severe';     // severe takes priority if mixed
  if (/\bPL-?M\s*\d/.test(s)) return 'minor';
  if (/\bZF-?B\s*\d/.test(s)) return 'blacklist';
  if (/\bTA-?D\s*\d/.test(s)) return 'termination';
  return null;
}

// Default duration (in days; null = Permanent; undefined = leave unchanged) for
// a punishment, based on the penal-code class in the current Reason field.
function actionDefaultDuration(name) {
  const cls = penalCodeClass((document.getElementById('f-reason') || {}).value);
  switch (name) {
    case 'Written Warning':
    case 'Activity Strike':
      return null;            // permanent
    case 'Zero Tolerance':
      return 3;               // 3 days
    case 'Suspension':
      return 7;               // 7 days
    case 'Disciplinary Strike 1':
    case 'Disciplinary Strike 2':
    case 'Disciplinary Strike 3':
      if (cls === 'severe') return 21; // 3 weeks
      if (cls === 'minor')  return 14; // 2 weeks
      return null;            // class unknown → keep current default (permanent)
    default:
      return undefined;       // Verbal Warning (no duration), Blacklist, etc.
  }
}

// Set a duration <select>, adding the option if it isn't already present.
//   days = number → that many days; null = Permanent; undefined = leave as-is.
function setDurationSelect(slug, days) {
  if (days === undefined) return;
  const dur = document.getElementById('action-dur-' + slug);
  if (!dur) return;
  const val = (days === null) ? '' : String(days);
  if (val !== '' && !Array.from(dur.options).some(o => o.value === val)) {
    dur.add(new Option(days + ' Days', val));
  }
  dur.value = val;
}

// Apply a set of punishments to the checklist.
//   preserveDurations = true  → use each punishment's own durationDays (editing
//                               an existing case — keep what was saved)
//   preserveDurations = false → default durations from the penal-code class
function applyDocPunishments(punishments, preserveDurations) {
  ACTIONS_CLIENT.forEach(a => {
    const cb = document.getElementById('action-check-' + actionSlug(a.name));
    if (cb) { cb.checked = false; onActionCheckChange(cb); }
  });
  (punishments || []).forEach(p => {
    const slug = actionSlug(p.action);
    const cb   = document.getElementById('action-check-' + slug);
    if (!cb) return; // not a checklist action (e.g. Suspension) — surfaced in notes
    cb.checked = true;
    const durEl = document.getElementById('action-dur-' + slug);
    if (durEl) durEl.style.display = '';
    if (preserveDurations && p.durationDays !== undefined) {
      setDurationSelect(slug, p.durationDays); // keep the saved value (incl. null = permanent)
    } else {
      setDurationSelect(slug, actionDefaultDuration(p.action)); // standardise by penal code
    }
  });
}

async function importCaseFromDoc() {
  const urlEl = document.getElementById('f-import-url');
  const resEl = document.getElementById('import-doc-result');
  const url   = urlEl?.value.trim();
  if (!url) { showToast('Paste a Google Doc link first.', 'error'); return; }

  const btn = document.getElementById('btn-import-doc');
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner"></div>'; }

  try {
    const d   = await api('/api/cases/parse-doc', { method: 'POST', body: JSON.stringify({ url }) });
    const sus = d.suspect || {};
    const inv = d.investigator || {};

    // Suspect identity → officer field, then run the standard lookup so the
    // checklist shows on-record / suggested badges before we override them.
    const officerVal = sus.discordId || sus.robloxId || '';
    const idEl = document.getElementById('f-officer-id');
    if (idEl) idEl.value = officerVal;
    if (officerVal) { await lookupOfficer(); } else { renderActionChecklist(); }

    // Reason autofills from the doc's Allegations section (editable); notes stay
    // blank (→ N/A) for the IA member to fill in. Set it BEFORE applying the
    // punishments so their default durations can read the penal-code class.
    const reasonEl = document.getElementById('f-reason');
    if (reasonEl) reasonEl.value = d.allegations || reasonEl.value || '';

    // Punishments from the doc's checkboxes — durations standardised by penal code.
    applyDocPunishments(d.punishments || []);
    const notesEl = document.getElementById('f-notes');
    if (notesEl) notesEl.value = '';
    const linkEl = document.getElementById('f-case-link');
    if (linkEl) linkEl.value = d.caseLink || url;

    // Stash identity fields to include in the submit POST
    importedCaseExtra = {
      robloxUserId:                sus.robloxId || null,
      robloxUsername:              sus.robloxUsername || null,
      suspectRobloxDisplayName:    sus.robloxDisplayName || null,
      investigatorRobloxId:        inv.robloxId || null,
      investigatorRobloxUsername:  inv.robloxUsername || null,
      investigatorDiscordUsername: inv.discordUsername || null,
      punishmentsSummary:          d.finalDecisionClean || null,
    };

    if (resEl) {
      resEl.style.display = '';
      resEl.style.color   = 'var(--green)';
      resEl.innerHTML = '<i class="ti ti-check"></i> Imported <strong>' + escapeHtml(sus.robloxUsername || sus.discordUsername || sus.discordId || 'suspect') + '</strong>'
        + (sus.groupRole ? ' · ' + escapeHtml(sus.groupRole) : '')
        + (d.punishments?.length ? ' · ' + d.punishments.map(p => escapeHtml(p.action)).join(', ') : '')
        + ' — review before submitting.';
    }
    // Unlock the (previously greyed) manual fields now that they're populated.
    if (typeof setCaseFieldsEnabled === 'function') setCaseFieldsEnabled(true);
    showToast('Doc imported — review the autofilled fields.', 'success');
  } catch (err) {
    if (resEl) { resEl.style.display = ''; resEl.style.color = 'var(--red)'; resEl.textContent = err.message || 'Failed to import.'; }
    showToast(err.message || 'Failed to import doc.', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-download"></i> Import'; }
  }
}

// ── Action checklist ──────────────────────────────────────────────
function renderActionChecklist(precheck = null) {
  const container = document.getElementById('action-checklist');
  if (!container) return;

  const approvedActions  = officerProfile?.approvedActions  || [];
  const suggestedAction  = precheck || officerProfile?.suggestedAction || null;

  container.innerHTML = ACTIONS_CLIENT.map(a => {
    const slug        = actionSlug(a.name);
    const onRecord    = approvedActions.includes(a.name);
    const isSuggested = a.name === suggestedAction;
    const isExile     = a.exile;
    const hasRole     = !!a.roleId;
    const isBlacklist = a.name === 'Blacklist';

    let badge = '';
    if (isExile)     badge = `<span class="ac-badge ac-exile"><i class="ti ti-bolt"></i> ${isBlacklist ? 'EXILE + ROLE' : 'EXILE'}</span>`;
    else if (hasRole) badge = `<span class="ac-badge ac-role">AUTO-ROLE</span>`;
    else              badge = `<span class="ac-badge ac-norole">NO ROLE</span>`;

    const onRecordBadge = onRecord
      ? `<span class="ac-badge ac-onrecord"><i class="ti ti-alert-triangle"></i> on record</span>` : '';
    const suggestedBadge = isSuggested
      ? `<span class="ac-badge ac-suggested"><i class="ti ti-star"></i> Recommended</span>` : '';

    // Duration only shown when the checkbox is checked; hidden otherwise
    const durationSelect = hasRole ? `
      <select class="ac-duration" id="action-dur-${slug}" style="${isSuggested ? '' : 'display:none'}">
        ${DURATION_OPTIONS.map(d =>
          `<option value="${d.days ?? ''}" ${d.days === null ? 'selected' : ''}>${d.label}</option>`
        ).join('')}
      </select>` : '';

    return `
      <label class="ac-row${isSuggested ? ' ac-row-suggested' : ''}${onRecord ? ' ac-row-onrecord' : ''}"
             for="action-check-${slug}">
        <input type="checkbox" class="ac-check" id="action-check-${slug}"
               data-action="${escapeHtml(a.name)}" data-has-role="${hasRole}"
               ${isSuggested ? 'checked' : ''}
               onchange="onActionCheckChange(this)">
        <span class="ac-name">${escapeHtml(a.name)}</span>
        <span class="ac-badges">${badge}${onRecordBadge}${suggestedBadge}</span>
        ${durationSelect}
      </label>`;
  }).join('');
}

function onActionCheckChange(checkbox) {
  const slug    = actionSlug(checkbox.dataset.action);
  const durEl   = document.getElementById(`action-dur-${slug}`);
  if (durEl) durEl.style.display = checkbox.checked ? '' : 'none';
  // On manual check, default the duration from the penal-code class in Reason.
  if (checkbox.checked) setDurationSelect(slug, actionDefaultDuration(checkbox.dataset.action));
}

function getSelectedActions() {
  const result = [];
  ACTIONS_CLIENT.forEach(a => {
    const slug     = actionSlug(a.name);
    const checkbox = document.getElementById(`action-check-${slug}`);
    if (checkbox?.checked) {
      const durEl      = document.getElementById(`action-dur-${slug}`);
      const durationDays = durEl?.value ? parseInt(durEl.value) : null;
      result.push({ action: a.name, durationDays });
    }
  });
  return result;
}

// ── Officer lookup ────────────────────────────────────────────────
function setupOfficerLookup() {
  document.getElementById('btn-lookup-officer')?.addEventListener('click', lookupOfficer);
  document.getElementById('f-officer-id')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); lookupOfficer(); }
  });
}

async function lookupOfficer() {
  const idInput  = document.getElementById('f-officer-id');
  const resultEl = document.getElementById('officer-lookup-result');
  if (!idInput || !resultEl) return;

  const id = idInput.value.trim();
  if (!id) { showToast('Enter a Discord or Roblox user ID first.', 'error'); return; }

  resultEl.style.display = 'none';
  officerProfile = null;
  renderActionChecklist();

  const btn = document.getElementById('btn-lookup-officer');
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner"></div>'; }

  try {
    const data = await api(`/api/cases/officer-profile/${encodeURIComponent(id)}`);

    if (!data.linked) {
      let title   = 'Not Linked';
      let detail  = 'This officer has not linked their Roblox account via RoVer.';
      let icon    = 'unlink';

      if (data.reason === 'not_found') {
        title  = 'User Not Found';
        detail = 'No Roblox account found for that user ID.';
        icon   = 'user-off';
      } else if (data.reason === 'rover_error') {
        icon  = 'alert-triangle';
        if (data.isRateLimit) {
          title  = 'RoVer Rate Limited';
          detail = 'Too many lookups. Wait a minute, then try again — or enter the officer\'s Roblox user ID directly instead.';
        } else {
          title  = 'RoVer Lookup Failed';
          detail = `RoVer API error: ${escapeHtml(data.error || 'unknown')}. Check ROVER_API_KEY.`;
        }
      }

      resultEl.innerHTML = `
        <div class="officer-card officer-card-error">
          <div class="officer-card-icon"><i class="ti ti-${icon}"></i></div>
          <div class="officer-card-body">
            <span class="officer-card-name">${title}</span>
            <span class="officer-card-detail">${detail}</span>
          </div>
        </div>`;
      resultEl.style.display = 'block';
      return;
    }

    officerProfile = data;

    const groupStatus = data.inGroup
      ? `<span class="officer-status-ok"><i class="ti ti-check"></i> In group${data.groupRole ? ` · ${escapeHtml(data.groupRole)}` : ''}</span>`
      : `<span class="officer-status-warn"><i class="ti ti-alert-triangle"></i> Not currently in the MET group</span>`;

    const onRecord = data.approvedActions?.length
      ? `<span class="officer-strike-info">On record: ${data.approvedActions.map(s => `<strong>${escapeHtml(s)}</strong>`).join(', ')}</span>`
      : '';

    const suggestedNote = data.suggestedAction
      ? `<span class="officer-suggested-note"><i class="ti ti-alert-triangle"></i> ${escapeHtml(data.warning)} — <strong>${escapeHtml(data.suggestedAction)}</strong> pre-selected</span>`
      : '';

    resultEl.innerHTML = `
      <div class="officer-card officer-card-found">
        <div class="officer-card-icon"><i class="ti ti-brand-roblox"></i></div>
        <div class="officer-card-body">
          <span class="officer-card-name">${escapeHtml(data.robloxUsername || 'Unknown')}</span>
          ${data.displayName && data.displayName !== data.robloxUsername
            ? `<span class="officer-card-display">${escapeHtml(data.displayName)}</span>` : ''}
          ${groupStatus}
          ${onRecord}
          ${suggestedNote}
        </div>
      </div>`;
    resultEl.style.display = 'block';

    renderActionChecklist();
  } catch {
    resultEl.innerHTML = `<div class="officer-card officer-card-error"><div class="officer-card-body"><span class="officer-card-detail">Lookup failed — check Discord ID.</span></div></div>`;
    resultEl.style.display = 'block';
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-search"></i> Lookup'; }
  }
}

// ── Filter tabs ───────────────────────────────────────────────────
function setupFilterTabs() {
  document.querySelectorAll('#dash-filter-tabs .filter-tab').forEach(tab =>
    tab.addEventListener('click', () => {
      document.querySelectorAll('#dash-filter-tabs .filter-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active'); dashFilter = tab.dataset.filter; renderDashTable();
    })
  );
  document.querySelectorAll('#all-filter-tabs .filter-tab').forEach(tab =>
    tab.addEventListener('click', () => {
      document.querySelectorAll('#all-filter-tabs .filter-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active'); allPageFilter = tab.dataset.filter; renderAllCasesTable();
    })
  );
  document.querySelectorAll('#dash-ticket-filter-tabs .filter-tab').forEach(tab =>
    tab.addEventListener('click', () => {
      document.querySelectorAll('#dash-ticket-filter-tabs .filter-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active'); dashTicketFilter = tab.dataset.tfilter; renderDashTickets();
    })
  );
}

// ── Submit Case ───────────────────────────────────────────────────
function setupSubmitCase() {
  document.getElementById('btn-submit-case')?.addEventListener('click', submitCase);
}

function submitCase() {
  const actions       = getSelectedActions();
  const reason        = document.getElementById('f-reason')?.value.trim();
  const notes         = document.getElementById('f-notes')?.value.trim();
  const officerInput  = document.getElementById('f-officer-id')?.value.trim();
  const caseLink      = document.getElementById('f-case-link')?.value.trim();

  if (!officerInput) { showToast('Officer Discord/Roblox ID or username is required.', 'error'); return; }
  if (!actions.length) { showToast('Select at least one punishment.', 'error'); return; }
  if (!reason)         { showToast('Reason is required.', 'error'); return; }
  if (!caseLink)       { showToast('Case link is required.', 'error'); return; }

  // Edit mode: save changes + re-post (no submit preview)
  if (editingCaseId) { return doEditCase({ actions, reason, notes, caseLink }); }

  const officerMention = (importedCaseExtra && importedCaseExtra.robloxUsername)
    || (officerProfile && officerProfile.robloxUsername) || officerInput;

  // Preview the Administrative Log before submitting
  closeModal('modal-submit');
  showEmbedPreview({
    title: 'Confirm Submission',
    note: 'Once approved by Internal Affairs High Command, this Notice is posted automatically to #administrative-logs. Review it before submitting.',
    embedData: { officerMention, punishments: actions, reason, notes, caseRef: null, signedBy: null },
    buttons: [
      { label: '<i class="ti ti-arrow-left"></i> Back to editing', class: 'btn btn-ghost',
        onClick: () => { closeModal('modal-embed-preview'); openModal('modal-submit'); } },
      { label: '<i class="ti ti-check"></i> Agree &amp; Submit', class: 'btn btn-primary',
        onClick: () => doSubmitCase({ actions, reason, notes, officerInput, caseLink }) },
    ],
  });
}

async function doSubmitCase(payload) {
  closeModal('modal-embed-preview');
  try {
    const newCase = await api('/api/cases', {
      method: 'POST',
      body:   JSON.stringify({ ...payload, ...(importedCaseExtra || {}) }),
    });
    resetCaseForm();
    caseDraftActive = false; // draft consumed
    showToast(`Case ${newCase.caseRef} submitted.`, 'success');
    await loadDashboard();
    if (typeof loadMyCases === 'function') loadMyCases();           // show it in My Cases instantly
    if (typeof refreshNavBadges === 'function') refreshNavBadges(); // update the My Cases pending badge now
  } catch (err) {
    showToast(err.message || 'Failed to submit case.', 'error');
  }
}

async function doEditCase({ actions, reason, notes, caseLink }) {
  const id = editingCaseId;
  const repost = editingCaseApproved; // only approved cases update the live log
  const btn = document.getElementById('btn-submit-case');
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner"></div> Saving…'; }
  try {
    await api(`/api/cases/${id}`, {
      method: 'PATCH',
      body:   JSON.stringify({ actions, reason, notes, caseLink, repost }),
    });
    closeModal('modal-submit');
    editingCaseId = null; editingCaseApproved = false; caseDraftActive = false;
    showToast(repost ? 'Case updated — log updated.' : 'Case updated.', 'success');
    await loadDashboard(); loadAllCases(); loadReview();
  } catch (err) {
    showToast(err.message || 'Failed to save changes.', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-device-floppy"></i> Save Changes'; }
  }
}

// ── Dashboard ─────────────────────────────────────────────────────
async function loadDashboard() { await Promise.all([loadStats(), loadDashCases(), loadDashTickets(), loadPoints()]); }

// My Activity Points — read from the linked IA Database Google Sheet
async function loadPoints() {
  const panel = document.getElementById('points-panel');
  const body  = document.getElementById('points-body');
  const totalEl = document.getElementById('points-total');
  if (!panel || !body) return;
  try {
    const d = await api('/api/me/points');
    if (!d || !d.configured || !d.found) { panel.style.display = 'none'; return; }
    panel.style.display = '';

    const q = d.quota || {};
    // Header summary (top-right)
    if (totalEl) {
      if (q.exempt) {
        totalEl.innerHTML = `<span style="color:var(--purple);font-weight:700;">EXEMPT</span> · ${escapeHtml(d.rank || 'High Command')}`;
      } else if (q.target != null) {
        const met = d.total >= q.target;
        totalEl.innerHTML = `${d.total} / ${q.target} pts`
          + (met
              ? ` · <span style="color:var(--green);font-weight:700;">Quota met <i class="ti ti-check"></i></span>`
              : ` · <span style="color:var(--amber);font-weight:700;">${d.remaining} to go</span>`);
      } else {
        totalEl.textContent = `Total this week: ${d.total}`;
      }
    }

    // Progress bar + breakdown
    let progressHtml = '';
    if (q.exempt) {
      progressHtml = `<div style="font-size:12px;color:var(--text-secondary);margin-bottom:10px;">
        ${escapeHtml(d.rank || '')} — exempt from the weekly quota (EX).</div>`;
    } else if (q.target != null) {
      const pct = Math.min(100, Math.round((d.total / q.target) * 100));
      const met = d.total >= q.target;
      progressHtml = `
        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted);margin-bottom:5px;">
          <span>${escapeHtml(d.rank || '')}${q.tier ? ' · ' + escapeHtml(q.tier) : ''} — ${q.target} pts/week</span>
          <span>${d.total}/${q.target}${met ? '' : ` · ${d.remaining} left`}</span>
        </div>
        <div style="height:8px;background:rgba(255,255,255,0.06);border-radius:5px;overflow:hidden;margin-bottom:12px;">
          <div style="height:100%;width:${pct}%;background:${met ? 'var(--green)' : 'var(--amber)'};border-radius:5px;transition:width .3s;"></div>
        </div>`;
    }

    const order = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const daysHtml = `<div style="display:flex;gap:8px;flex-wrap:wrap;">${
      order.map(day => {
        const v = d.days[day];
        return `<div style="flex:1;min-width:64px;text-align:center;background:rgba(255,255,255,0.03);border:1px solid var(--border-dim);border-radius:6px;padding:8px 4px;">
          <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;">${day}</div>
          <div style="font-size:18px;font-weight:700;color:var(--text-primary);margin-top:2px;">${escapeHtml(String(v))}</div>
        </div>`;
      }).join('')
    }</div>`;

    body.innerHTML = progressHtml + daysHtml;
  } catch (err) { panel.style.display = 'none'; }
}

async function loadStats() {
  try {
    const [stats, mine, myTickets] = await Promise.all([
      api('/api/cases/stats'),
      api('/api/cases/stats?scope=mine'),
      api('/api/tickets/stats?scope=mine'),
    ]);
    if (stats) {
      document.getElementById('stat-total').textContent    = stats.total;
      document.getElementById('stat-pending').textContent  = stats.pending;
      document.getElementById('stat-approved').textContent = stats.approved;
      document.getElementById('stat-denied').textContent   = stats.denied;
      const badge = document.getElementById('nav-badge-review');
      if (badge) { badge.textContent = stats.pending; badge.style.display = stats.pending > 0 ? '' : 'none'; }
    }
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    if (mine) {
      set('stat-my-total',    mine.total);
      set('stat-my-pending',  mine.pending);
      set('stat-my-approved', mine.approved);
      set('stat-my-denied',   mine.denied);
    }
    if (myTickets) {
      set('stat-my-ticket-total',    myTickets.total);
      set('stat-my-ticket-pending',  myTickets.pending);
      set('stat-my-ticket-approved', myTickets.approved);
      set('stat-my-ticket-denied',   myTickets.denied);
    }
  } catch (err) { console.error('Stats error:', err); }
}

async function loadDashCases() {
  const tbody = document.getElementById('dash-cases-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="6" class="table-loading"><div class="spinner"></div></td></tr>';
  try {
    const cases = await api('/api/cases/my');
    allCasesCache = cases || [];
    renderDashTable();
  } catch {
    tbody.innerHTML = `<tr><td colspan="6" class="table-empty"><span class="table-empty-text">Failed to load cases.</span></td></tr>`;
  }
}

function renderDashTable() {
  const tbody = document.getElementById('dash-cases-tbody');
  if (!tbody) return;
  const isElevated = ['HICOMM', 'SUPERVISOR', 'DEVELOPER'].includes(currentUser?.role);
  const filtered   = dashFilter === 'all' ? allCasesCache : allCasesCache.filter(c => c.status === dashFilter);
  if (!filtered.length) { tbody.innerHTML = emptyRow(isElevated ? 6 : 5, 'No cases found'); return; }
  tbody.innerHTML = filtered.map(c => `
    <tr onclick="openDetail('${c.id}')" class="${caseAwaitingChanges(c) ? 'row-changes' : ''}">
      <td><span class="case-ref">${escapeHtml(c.caseRef)}</span></td>
      <td>${actionBadges(cleanAction(c.action))}</td>
      <td><span class="case-reason-cell">${escapeHtml(c.reason)}</span></td>
      <td>${statusBadge(c.status)} ${changesBadge(c)}</td>
      <td><span class="date-cell">${formatDate(c.createdAt)}</span></td>
      ${isElevated ? `<td onclick="event.stopPropagation();">${c.status === 'PENDING' ? rowActions(c) : ''}</td>` : ''}
    </tr>`).join('');
}

// ── Recent Ticket Logs (the user's own) ───────────────────────────
let dashTicketFilter  = 'all';
let dashTicketsCache  = [];

async function loadDashTickets() {
  const tbody = document.getElementById('dash-tickets-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="5" class="table-loading"><div class="spinner"></div></td></tr>';
  try {
    const tickets = await api('/api/tickets');
    dashTicketsCache = tickets || [];
    renderDashTickets();
  } catch {
    tbody.innerHTML = '<tr><td colspan="5" class="table-empty"><span class="table-empty-text">Failed to load tickets.</span></td></tr>';
  }
}

function renderDashTickets() {
  const tbody = document.getElementById('dash-tickets-tbody');
  if (!tbody) return;
  const filtered = dashTicketFilter === 'all' ? dashTicketsCache : dashTicketsCache.filter(t => t.status === dashTicketFilter);
  if (!filtered.length) { tbody.innerHTML = emptyRow(5, 'No ticket logs found'); return; }
  const TLmap = (typeof TL !== 'undefined') ? TL : {};
  const TCmap = (typeof TC !== 'undefined') ? TC : {};
  tbody.innerHTML = filtered.map(t => {
    const c = TCmap[t.ticketType] || 'blue';
    const l = TLmap[t.ticketType] || t.ticketType;
    return `<tr onclick="openTicketDetail('${t.id}')">
      <td><span class="case-ref">${escapeHtml(t.ticketRef)}</span></td>
      <td><span style="font-size:12px;font-weight:500;">${escapeHtml(t.robloxUsername || '—')}</span></td>
      <td><span class="badge badge-${c}"><span class="badge-dot"></span>${escapeHtml(l)}</span></td>
      <td>${statusBadge(t.status)}</td>
      <td><span class="date-cell">${formatDate(t.createdAt)}</span></td>
    </tr>`;
  }).join('');
}

// ── My Cases ──────────────────────────────────────────────────────
async function loadMyCases() {
  const tbody = document.getElementById('my-cases-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="6" class="table-loading"><div class="spinner"></div></td></tr>';
  try {
    const cases = await api('/api/cases/my');
    allCasesCache = cases || [];
    if (!cases?.length) { tbody.innerHTML = emptyRow(6, 'No cases submitted yet.'); return; }
    tbody.innerHTML = cases.map(c => `
      <tr onclick="openDetail('${c.id}')" class="${caseAwaitingChanges(c) ? 'row-changes' : ''}">
        <td><span class="case-ref">${escapeHtml(c.caseRef)}</span></td>
        <td>${actionBadges(cleanAction(c.action))}</td>
        <td><span class="case-reason-cell">${escapeHtml(c.reason)}</span></td>
        <td><span class="case-notes-cell">${escapeHtml(c.notes)}</span></td>
        <td>${statusBadge(c.status)} ${changesBadge(c)}</td>
        <td><span class="date-cell">${formatDate(c.createdAt)}</span></td>
      </tr>`).join('');
  } catch { tbody.innerHTML = emptyRow(6, 'Failed to load cases.'); }
}

// ── Review Queue ──────────────────────────────────────────────────
async function loadReview() {
  const tbody = document.getElementById('review-tbody');
  const label = document.getElementById('pending-count-label');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="8" class="table-loading"><div class="spinner"></div></td></tr>';
  try {
    const cases = await api('/api/cases/all?status=PENDING');
    allCasesCache = cases || [];
    if (label) label.textContent = `${cases?.length || 0} awaiting decision`;
    if (!cases?.length) { tbody.innerHTML = emptyRow(8, 'No pending cases — all caught up.'); return; }
    tbody.innerHTML = cases.map(c => `
      <tr onclick="openDetail('${c.id}')" style="cursor:pointer;" class="${caseAwaitingChanges(c) ? 'row-changes' : ''}">
        <td><span class="case-ref">${escapeHtml(c.caseRef)}</span>${caseAwaitingChanges(c) ? '<br>' + changesBadge(c) : ''}</td>
        <td>${caseInvestigatorCell(c)}</td>
        <td>${officerCell(c)}</td>
        <td>${actionBadges(cleanAction(c.action))}</td>
        <td><span class="case-reason-cell">${escapeHtml(c.reason)}</span></td>
        <td><span class="case-notes-cell">${escapeHtml(c.notes)}</span></td>
        <td><span class="date-cell">${formatDateTime(c.createdAt)}</span></td>
        <td onclick="event.stopPropagation();">${rowActions(c)}</td>
      </tr>`).join('');
  } catch { tbody.innerHTML = emptyRow(8, 'Failed to load cases.'); }
}

// ── All Cases ─────────────────────────────────────────────────────
async function loadAllCases() {
  const tbody = document.getElementById('all-cases-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="7" class="table-loading"><div class="spinner"></div></td></tr>';
  try {
    const cases = await api('/api/cases/all');
    allCasesCache = cases || [];
    renderAllCasesTable();
  } catch { tbody.innerHTML = emptyRow(7, 'Failed to load cases.'); }
}

function renderAllCasesTable() {
  const tbody = document.getElementById('all-cases-tbody');
  if (!tbody) return;
  const isElevated = ['HICOMM', 'SUPERVISOR', 'DEVELOPER'].includes(currentUser?.role);
  const cols = isElevated ? 8 : 7;
  const filtered = allPageFilter === 'all' ? allCasesCache : allCasesCache.filter(c => c.status === allPageFilter);
  if (!filtered.length) { tbody.innerHTML = emptyRow(cols, 'No cases found.'); return; }
  tbody.innerHTML = filtered.map(c => `
    <tr onclick="openDetail('${c.id}')" class="${caseAwaitingChanges(c) ? 'row-changes' : ''}">
      <td><span class="case-ref">${escapeHtml(c.caseRef)}</span></td>
      <td>${caseInvestigatorCell(c)}</td>
      <td>${officerCell(c)}</td>
      <td>${actionBadges(cleanAction(c.action))}</td>
      <td><span class="case-reason-cell">${escapeHtml(c.reason)}</span></td>
      <td>${statusBadge(c.status)} ${changesBadge(c)}</td>
      <td><span class="date-cell">${formatDate(c.createdAt)}</span></td>
      ${isElevated ? `<td onclick="event.stopPropagation();">${c.status === 'PENDING'
          ? `<button class="row-btn row-btn-approve btn-sm" onclick="goReviewCase('${c.id}')"><i class="ti ti-clipboard-check"></i> Review</button>`
          : ''}</td>` : ''}
    </tr>`).join('');
}

// ── Audit Log ─────────────────────────────────────────────────────
async function loadAudit() {
  const tbody = document.getElementById('audit-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="5" class="table-loading"><div class="spinner"></div></td></tr>';
  try {
    const actions = await api('/api/cases/audit');
    if (!actions?.length) { tbody.innerHTML = emptyRow(5, 'No audit entries yet.'); return; }
    const actionBadges = {
      CREATED:       '<span class="badge badge-ia"><span class="badge-dot"></span>Created</span>',
      APPROVED:      '<span class="badge badge-approved"><span class="badge-dot"></span>Approved</span>',
      DENIED:        '<span class="badge badge-denied"><span class="badge-dot"></span>Denied</span>',
      DELETED:       '<span class="badge badge-denied"><span class="badge-dot"></span>Deleted</span>',
      BLACKLISTED:   '<span class="badge badge-denied"><span class="badge-dot"></span>Blacklisted</span>',
      UNBLACKLISTED: '<span class="badge badge-approved"><span class="badge-dot"></span>Unblacklisted</span>',
    };
    tbody.innerHTML = actions.map(a => `
      <tr>
        <td><span class="date-cell">${formatDateTime(a.timestamp)}</span></td>
        <td>${actionBadges[a.actionType] || `<span class="badge">${a.actionType}</span>`}</td>
        <td><span class="case-ref">${escapeHtml(a.case?.caseRef || '—')}</span></td>
        <td><span style="font-size:12px;color:var(--text-secondary);">${escapeHtml(a.user?.displayName || a.user?.discordUsername || '—')}</span></td>
        <td><span style="font-size:11px;color:var(--text-muted);">${escapeHtml(a.notes || '—')}</span></td>
      </tr>`).join('');
  } catch { tbody.innerHTML = emptyRow(5, 'Failed to load audit log.'); }
}

// ── Admin Panel ───────────────────────────────────────────────────
async function loadAdmin() { await Promise.all([loadAdminStats(), loadAdminUsers(), loadAccessGrants(), loadAdminSettings()]); }

// ── Authorised Access Grants ──────────────────────────────────────
async function loadAccessGrants() {
  const tbody = document.getElementById('access-grants-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="5" class="table-loading"><div class="spinner"></div></td></tr>';
  try {
    const grants = await api('/api/admin/access-grants');
    if (!grants?.length) { tbody.innerHTML = emptyRow(5, 'No authorised users yet.'); return; }
    const roleLabel = { IA: 'Internal Affairs', HICOMM: 'HICOMM', SUPERVISOR: 'Supervisor', DEVELOPER: 'Developer' };
    tbody.innerHTML = grants.map(g => `
      <tr>
        <td><span class="case-ref" style="font-size:10px;">${escapeHtml(g.discordId)}</span></td>
        <td><span class="badge badge-${g.role === 'DEVELOPER' ? 'amber' : (g.role === 'HICOMM' || g.role === 'SUPERVISOR') ? 'blue' : 'approved'}"><span class="badge-dot"></span>${roleLabel[g.role] || g.role}</span></td>
        <td><span style="font-size:11px;color:var(--text-secondary);">${escapeHtml(g.note || '—')}</span></td>
        <td><span class="date-cell">${formatDate(g.createdAt)}</span></td>
        <td><div class="admin-actions">
          <button class="row-btn row-btn-deny btn-sm" onclick="revokeAccessGrant('${g.id}')"><i class="ti ti-user-x"></i> Revoke</button>
        </div></td>
      </tr>`).join('');
  } catch { tbody.innerHTML = emptyRow(5, 'Failed to load access grants.'); }
}

async function addAccessGrant() {
  const discordId = document.getElementById('grant-discord-id')?.value.trim();
  const role      = document.getElementById('grant-role')?.value;
  const note      = document.getElementById('grant-note')?.value.trim();
  if (!/^\d{17,20}$/.test(discordId || '')) { showToast('Enter a valid Discord user ID (17-20 digits).', 'error'); return; }
  try {
    await api('/api/admin/access-grants', { method: 'POST', body: JSON.stringify({ discordId, role, note }) });
    showToast('Access authorised.', 'success');
    document.getElementById('grant-discord-id').value = '';
    document.getElementById('grant-note').value = '';
    loadAccessGrants();
  } catch (err) { showToast(err.message || 'Failed to authorise access.', 'error'); }
}

async function revokeAccessGrant(id) {
  if (!(await uiConfirm('Revoke this user\'s authorised access? They will be logged out immediately and can only return if they hold the required Discord roles.'))) return;
  try {
    await api(`/api/admin/access-grants/${id}`, { method: 'DELETE' });
    showToast('Access revoked.', 'info');
    loadAccessGrants();
  } catch (err) { showToast(err.message || 'Failed to revoke access.', 'error'); }
}

async function loadAdminStats() {
  try {
    const stats = await api('/api/admin/stats');
    document.getElementById('admin-stat-users').textContent       = stats.totalUsers;
    document.getElementById('admin-stat-cases').textContent       = stats.totalCases;
    document.getElementById('admin-stat-blacklisted').textContent = stats.blacklisted;
    document.getElementById('admin-stat-actions').textContent     = stats.totalActions;
  } catch {}
}

async function loadAdminUsers() {
  const tbody = document.getElementById('admin-users-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="10" class="table-loading"><div class="spinner"></div></td></tr>';
  try {
    const users = await api('/api/admin/users');
    if (!users?.length) { tbody.innerHTML = emptyRow(10, 'No users found.'); return; }
    const roleOptions = r => ['NONE','IA','SUPERVISOR','HICOMM','DEVELOPER'].map(v =>
      `<option value="${v}" ${r === v ? 'selected' : ''}>${v}</option>`).join('');
    tbody.innerHTML = users.map(u => `
      <tr class="${u.isBlacklisted ? 'blacklisted-row' : ''}">
        <td>
          <div style="display:flex;align-items:center;gap:8px;">
            ${u.discordAvatar ? `<img src="${escapeHtml(u.discordAvatar)}" style="width:24px;height:24px;border-radius:50%;border:1px solid var(--border-dim);">` : `<div class="user-avatar-fallback" style="width:24px;height:24px;font-size:10px;">${(u.displayName||u.discordUsername||'?')[0].toUpperCase()}</div>`}
            <div>
              <div style="font-size:12px;font-weight:500;color:var(--text-primary);">${escapeHtml(u.displayName||u.discordUsername)}</div>
              <div style="font-size:10px;color:var(--text-muted);">@${escapeHtml(u.discordUsername)}</div>
            </div>
          </div>
        </td>
        <td><span class="case-ref" style="font-size:10px;">${escapeHtml(u.discordId)}</span></td>
        <td>${u.robloxUsername || u.robloxId
            ? `<div style="display:flex;flex-direction:column;gap:1px;">
                 <span style="font-size:11px;color:var(--text-primary);">${escapeHtml(u.robloxUsername || '—')}</span>
                 ${u.robloxId ? `<span style="font-size:10px;color:var(--text-muted);">ID: ${escapeHtml(u.robloxId)}</span>` : ''}
               </div>`
            : '<span style="font-size:11px;color:var(--text-muted);">Not linked</span>'}</td>
        <td><span class="case-ref" style="font-size:10px;">${u.lastIp ? escapeHtml(u.lastIp) : '<span style="color:var(--text-muted);">—</span>'}</span></td>
        <td><select class="role-select" onchange="changeUserRole('${u.id}',this.value)">${roleOptions(u.role)}</select></td>
        <td style="font-size:12px;color:var(--text-secondary);">${u._count?.cases ?? 0}</td>
        <td>${u.isBlacklisted ? '<span class="badge badge-denied"><span class="badge-dot"></span>Blacklisted</span>' : '<span class="badge badge-approved"><span class="badge-dot"></span>Active</span>'}</td>
        <td>${u.notifyEnabled && u.hasPush
            ? '<span class="badge badge-approved" title="Notifications enabled with an active device"><span class="badge-dot"></span><i class="ti ti-bell"></i> On</span>'
            : (u.notifyEnabled
                ? '<span class="badge badge-amber" title="Enabled but no active device subscribed"><i class="ti ti-bell"></i> No device</span>'
                : '<span style="font-size:11px;color:var(--text-muted);"><i class="ti ti-bell-off"></i> Off</span>')}</td>
        <td><span class="date-cell">${formatDate(u.lastLogin)}</span></td>
        <td><div class="admin-actions">
          ${u.isBlacklisted
            ? `<button class="row-btn row-btn-approve btn-sm" onclick="unblacklistUser('${u.id}')"><i class="ti ti-lock-open"></i> Unban</button>`
            : `<button class="row-btn row-btn-deny btn-sm" onclick="openBlacklistModal('${u.id}')"><i class="ti ti-ban"></i> Blacklist</button>`}
        </div></td>
      </tr>`).join('');
  } catch { tbody.innerHTML = emptyRow(9, 'Failed to load users.'); }
}

// ── Website Visits (Developer) ────────────────────────────────────
async function loadVisits() {
  const tbody = document.getElementById('visits-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="5" class="table-loading"><div class="spinner"></div></td></tr>';
  try {
    const visits = await api('/api/admin/visits');
    const badge  = document.getElementById('visits-count-badge');
    if (badge) badge.textContent = `${visits?.length || 0} recent visit(s)`;
    if (!visits?.length) { tbody.innerHTML = emptyRow(5, 'No visits recorded yet.'); return; }

    tbody.innerHTML = visits.map(v => {
      const discord = v.discordUsername || v.discordId
        ? `<div style="display:flex;flex-direction:column;gap:1px;">
             <span style="font-size:11px;color:var(--text-primary);">${escapeHtml(v.discordUsername || '—')}</span>
             ${v.discordId ? `<span style="font-size:10px;color:var(--text-muted);">ID: ${escapeHtml(v.discordId)}</span>` : ''}
           </div>`
        : '<span style="font-size:11px;color:var(--text-muted);">Anonymous</span>';

      const roblox = v.robloxUsername || v.robloxId
        ? `<div style="display:flex;flex-direction:column;gap:1px;">
             <span style="font-size:11px;color:var(--text-primary);">${escapeHtml(v.robloxUsername || '—')}</span>
             ${v.robloxId ? `<span style="font-size:10px;color:var(--text-muted);">ID: ${escapeHtml(v.robloxId)}</span>` : ''}
           </div>`
        : '<span style="font-size:11px;color:var(--text-muted);">Not linked</span>';

      return `<tr>
        <td><span class="date-cell">${formatDateTime(v.createdAt)}</span></td>
        <td>${discord}</td>
        <td>${roblox}</td>
        <td><span class="case-ref" style="font-size:10px;">${v.ip ? escapeHtml(v.ip) : '<span style="color:var(--text-muted);">—</span>'}</span></td>
        <td><span style="font-size:11px;color:var(--text-secondary);">${escapeHtml(v.path || '—')}</span></td>
      </tr>`;
    }).join('');
  } catch (err) {
    tbody.innerHTML = emptyRow(5, 'Failed to load visits.');
  }
}

// ── Security / Capture Logs (Developer) ───────────────────────────
async function loadSecurity() {
  const tbody = document.getElementById('security-tbody');
  if (!tbody) return;
  // Sync the guard toggle with saved state
  const cb = document.getElementById('guard-blur-toggle');
  if (cb) cb.checked = localStorage.getItem('iacms_blur_guard') === '1';

  tbody.innerHTML = '<tr><td colspan="8" class="table-loading"><div class="spinner"></div></td></tr>';
  try {
    const logs  = await api('/api/admin/security');
    securityCache = logs || [];
    const badge = document.getElementById('security-count-badge');
    if (badge) badge.textContent = `${logs?.length || 0} event(s)`;
    if (!logs?.length) { tbody.innerHTML = emptyRow(8, 'No capture events recorded.'); return; }

    tbody.innerHTML = logs.map(v => {
      const user = v.discordUsername || v.discordId || v.robloxUsername
        ? `<div style="display:flex;flex-direction:column;gap:1px;">
             <span style="font-size:11px;color:var(--text-primary);">${escapeHtml(v.discordUsername || '—')}</span>
             ${v.robloxUsername ? `<span style="font-size:10px;color:var(--text-muted);">Roblox: ${escapeHtml(v.robloxUsername)}</span>` : ''}
             ${v.discordId ? `<span style="font-size:10px;color:var(--text-muted);">ID: ${escapeHtml(v.discordId)}</span>` : ''}
           </div>`
        : '<span style="font-size:11px;color:var(--text-muted);">Unknown</span>';
      return `<tr onclick="openSecurityDetail('${v.id}')" style="cursor:pointer;">
        <td><span class="date-cell">${formatDateTime(v.createdAt)}</span>${v.screenshot ? ' <i class="ti ti-photo" title="Screenshot attached" style="color:var(--amber);"></i>' : ''}</td>
        <td><span class="badge badge-denied" style="font-size:10px;"><span class="badge-dot"></span>${escapeHtml(v.method)}</span>${v.details ? `<div style="font-size:10px;color:var(--text-muted);margin-top:3px;">${escapeHtml(v.details)}</div>` : ''}</td>
        <td>${user}</td>
        <td><span class="case-ref" style="font-size:10px;">${v.ip ? escapeHtml(v.ip) : '—'}</span></td>
        <td><span style="font-size:11px;color:var(--text-secondary);">${escapeHtml(v.os || '—')}</span></td>
        <td><span style="font-size:11px;color:var(--text-secondary);">${escapeHtml(v.browser || '—')}</span></td>
        <td><span style="font-size:10px;color:var(--text-muted);">${escapeHtml(v.screenInfo || '—')}</span></td>
        <td><span style="font-size:11px;color:var(--text-secondary);">${escapeHtml(v.page || '—')}</span></td>
      </tr>`;
    }).join('');
  } catch (err) {
    tbody.innerHTML = emptyRow(8, 'Failed to load security logs.');
  }
}

function openSecurityDetail(id) {
  const v = securityCache.find(x => x.id === id);
  if (!v) return;
  const row = (label, val) => val
    ? `<div class="detail-field"><span class="detail-field-label">${label}</span><span class="detail-field-value" style="font-size:12px;word-break:break-word;">${escapeHtml(String(val))}</span></div>`
    : '';
  const shot = v.screenshot
    ? `<div class="detail-divider"></div>
       <div class="detail-field full"><span class="detail-field-label">Captured Screen</span>
       <a href="${v.screenshot}" onclick="return openImageNewTab(this.href)" style="display:block;margin-top:6px;cursor:pointer;">
         <img src="${v.screenshot}" style="width:100%;border:1px solid var(--border-dim);border-radius:6px;" />
       </a>
       <span style="font-size:10px;color:var(--text-muted);">Click image to open full size in a new tab.</span></div>`
    : `<div class="detail-divider"></div><div class="detail-field full"><span class="detail-field-label">Captured Screen</span><span style="font-size:12px;color:var(--text-muted);">No screenshot captured for this event.</span></div>`;

  document.getElementById('secdetail-body').innerHTML = `
    <div class="detail-grid">
      ${row('Time', formatDateTime(v.createdAt))}
      ${row('Method', v.method)}
      ${row('Details', v.details)}
      ${row('Page Viewed', v.page)}
      ${row('Discord', v.discordUsername ? `${v.discordUsername} (${v.discordId || '—'})` : v.discordId)}
      ${row('Roblox', v.robloxUsername ? `${v.robloxUsername} (${v.robloxId || '—'})` : v.robloxId)}
      ${row('IP Address', v.ip)}
      ${row('Operating System', v.os)}
      ${row('Browser', v.browser)}
      ${row('Device', v.device)}
      ${row('Screen / Viewport', v.screenInfo)}
      ${row('Language', v.language)}
      <div class="detail-field full"><span class="detail-field-label">User Agent</span><span class="detail-field-value" style="font-size:11px;word-break:break-all;color:var(--text-muted);">${escapeHtml(v.userAgent || '—')}</span></div>
      ${shot}
    </div>`;
  openModal('modal-security-detail');
}

async function loadAdminSettings() {
  try {
    const s = await api('/api/admin/settings');
    if (s.systemName)      document.getElementById('setting-systemName').value      = s.systemName;
    if (s.webhookUrl)      document.getElementById('setting-webhookUrl').value       = s.webhookUrl;
    if (s.maintenanceMode) document.getElementById('setting-maintenanceMode').checked = s.maintenanceMode === 'true';
  } catch {}
}

async function changeUserRole(userId, role) {
  try {
    await api(`/api/admin/users/${userId}/role`, { method: 'PATCH', body: JSON.stringify({ role }) });
    showToast(`Role updated to ${role}.`, 'success');
  } catch (err) { showToast(err.message || 'Failed to update role.', 'error'); loadAdminUsers(); }
}

function openBlacklistModal(userId) {
  blacklistTargetId = userId;
  document.getElementById('f-blacklist-reason').value = '';
  openModal('modal-blacklist');
  document.getElementById('btn-confirm-blacklist').onclick = async () => {
    const reason = document.getElementById('f-blacklist-reason').value.trim();
    try {
      await api(`/api/admin/users/${blacklistTargetId}/blacklist`, { method: 'POST', body: JSON.stringify({ reason }) });
      closeModal('modal-blacklist');
      showToast('User blacklisted.', 'success');
      loadAdminUsers(); loadAdminStats();
    } catch (err) { showToast(err.message || 'Failed to blacklist user.', 'error'); }
  };
}

async function unblacklistUser(userId) {
  try {
    await api(`/api/admin/users/${userId}/unblacklist`, { method: 'POST' });
    showToast('User access restored.', 'success');
    loadAdminUsers(); loadAdminStats();
  } catch (err) { showToast(err.message || 'Failed to unblacklist.', 'error'); }
}

async function saveSettings() {
  const systemName      = document.getElementById('setting-systemName').value.trim();
  const webhookUrl      = document.getElementById('setting-webhookUrl').value.trim();
  const maintenanceMode = document.getElementById('setting-maintenanceMode').checked;
  try {
    await api('/api/admin/settings', { method: 'PATCH', body: JSON.stringify({ systemName, webhookUrl, maintenanceMode: String(maintenanceMode) }) });
    showToast('Settings saved.', 'success');
  } catch (err) { showToast(err.message || 'Failed to save settings.', 'error'); }
}

// ── Site Control (developer site-wide toggles) ────────────────────
async function loadSiteControl() {
  try {
    const s = await api('/api/admin/settings');
    const chk = (id) => { const el = document.getElementById(id); if (el) el.checked = (s[id.replace('sc-','')] === 'true'); };
    const txt = (id, key, def) => { const el = document.getElementById(id); if (el) el.value = s[key] || def || ''; };
    ['sc-loginLockdown','sc-sitePrivate','sc-snow','sc-confetti',
     'sc-matrixRain','sc-partyMode','sc-fireworks','sc-halloween','sc-rainbowCursor','sc-auroraTheme'].forEach(chk);
    txt('sc-bannerText',      'bannerText',      '');
    txt('sc-bannerColor',     'bannerColor',     '#3c6eff');
    txt('sc-spotlightUser',   'spotlightUser',   '');
    txt('sc-countdownLabel',  'countdownLabel',  '');
    // datetime-local wants "YYYY-MM-DDTHH:MM"
    const ct = document.getElementById('sc-countdownTarget');
    if (ct && s.countdownTarget) {
      try { ct.value = new Date(s.countdownTarget).toISOString().slice(0,16); } catch(e) {}
    }
  } catch {}
}

async function saveSiteControl() {
  const v  = (id) => document.getElementById(id)?.value  || '';
  const cb = (id) => String(document.getElementById(id)?.checked || false);
  // countdownTarget: store as ISO string
  let cdTarget = '';
  const cdEl = document.getElementById('sc-countdownTarget');
  if (cdEl && cdEl.value) { try { cdTarget = new Date(cdEl.value).toISOString(); } catch(e) {} }
  const body = {
    loginLockdown:   cb('sc-loginLockdown'),
    sitePrivate:     cb('sc-sitePrivate'),
    snow:            cb('sc-snow'),
    confetti:        cb('sc-confetti'),
    matrixRain:      cb('sc-matrixRain'),
    partyMode:       cb('sc-partyMode'),
    fireworks:       cb('sc-fireworks'),
    halloween:       cb('sc-halloween'),
    rainbowCursor:   cb('sc-rainbowCursor'),
    auroraTheme:     cb('sc-auroraTheme'),
    bannerText:      v('sc-bannerText').trim(),
    bannerColor:     v('sc-bannerColor'),
    spotlightUser:   v('sc-spotlightUser').trim(),
    countdownLabel:  v('sc-countdownLabel').trim(),
    countdownTarget: cdTarget,
  };
  try {
    await api('/api/admin/settings', { method: 'PATCH', body: JSON.stringify(body) });
    showToast('Site control updated.', 'success');
    // Apply the theme switch immediately for this dev (others get it on next load).
    document.documentElement.setAttribute('data-ui', body.auroraTheme === 'true' ? 'aurora' : '');
    if (typeof applySiteEffects === 'function') applySiteEffects();
  } catch (err) { showToast(err.message || 'Failed to update site control.', 'error'); }
}

// ── Notification settings (HICOMM / SUPERVISOR / DEVELOPER) ────────
let notifState = null;

function notifPermGranted() {
  return !!(window.pushClient && window.pushClient.permissionState() === 'granted');
}

// The granular options only exist when notifications are on AND this browser
// has actually granted permission. Otherwise they vanish entirely.
function setNotifPrefsVisible(on) {
  const panel = document.getElementById('ns-prefs-panel');
  if (panel) panel.style.display = on ? '' : 'none';
}

async function loadNotifSettings() {
  try {
    notifState = await api('/api/notifications/me');
  } catch { return; }
  const s = notifState;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };

  // "Active" only if enabled in settings AND permission granted on this device.
  const active = s.enabled && notifPermGranted();

  set('ns-enabled',   active);
  set('ns-newCase',   s.prefs.newCase);
  set('ns-newTicket', s.prefs.newTicket);
  set('ns-ticketDM',  s.prefs.ticketDM !== false);
  document.querySelectorAll('.ns-tt').forEach(cb => { cb.checked = (s.prefs.ticketTypes || []).includes(cb.value); });
  setNotifPrefsVisible(active);

  // Warn if the browser has blocked notifications
  const warn = document.getElementById('ns-perm-warning');
  if (warn) warn.style.display = (window.pushClient && window.pushClient.permissionState() === 'denied') ? 'block' : 'none';

  // The master toggle drives the permission flow + shows/hides the prefs panel
  const enabledEl = document.getElementById('ns-enabled');
  if (enabledEl) enabledEl.onchange = async () => {
    if (enabledEl.checked) {
      // Must obtain real browser permission before anything turns on.
      const result = window.pushClient ? await window.pushClient.requestPushPermission() : 'unsupported';
      if (result !== 'granted') {
        enabledEl.checked = false;
        setNotifPrefsVisible(false);
        if (result === 'denied' && warn) warn.style.display = 'block';
        showToast('Notifications are blocked in your browser. Allow them to enable.', 'error');
        // Persist the off state so delivery stays stopped.
        await api('/api/notifications/settings', { method: 'PATCH', body: JSON.stringify({ enabled: false }) }).catch(() => {});
        return;
      }
      if (warn) warn.style.display = 'none';
      setNotifPrefsVisible(true);
      // Turn delivery on immediately.
      await api('/api/notifications/settings', { method: 'PATCH', body: JSON.stringify({ enabled: true }) }).catch(() => {});
    } else {
      // Turn everything off: stop delivery now and drop this device's subscription.
      setNotifPrefsVisible(false);
      await api('/api/notifications/settings', { method: 'PATCH', body: JSON.stringify({ enabled: false }) }).catch(() => {});
      if (window.pushClient) window.pushClient.removePushSubscription();
    }
  };
}

async function saveNotifSettings() {
  const enabled = document.getElementById('ns-enabled')?.checked || false;
  const prefs = {
    newCase:       document.getElementById('ns-newCase')?.checked   || false,
    newTicket:     document.getElementById('ns-newTicket')?.checked || false,
    ticketDM:      document.getElementById('ns-ticketDM') ? !!document.getElementById('ns-ticketDM').checked : true,
    announcements: true, // developer announcements are always on
    ticketTypes:   Array.from(document.querySelectorAll('.ns-tt')).filter(cb => cb.checked).map(cb => cb.value),
  };
  try {
    await api('/api/notifications/settings', { method: 'PATCH', body: JSON.stringify({ enabled, prefs }) });
    showToast('Notification settings saved.', 'success');
  } catch (err) { showToast(err.message || 'Failed to save settings.', 'error'); }
}

// ── Developer: send custom notification ───────────────────────────
let devRecipients = [];

async function loadDevNotifSender() {
  const box = document.getElementById('dn-recipients');
  try {
    devRecipients = await api('/api/notifications/recipients');
  } catch { if (box) box.innerHTML = '<p style="color:var(--red);">Failed to load recipients.</p>'; return; }
  renderDevRecipients();
}

function renderDevRecipients() {
  const box = document.getElementById('dn-recipients');
  if (!box) return;
  const roleLabel = { IA: 'IA', HICOMM: 'HICOMM', SUPERVISOR: 'Supervisor', DEVELOPER: 'Developer' };

  // Notification status per user:
  //   On        → enabled + a reachable device
  //   No device → enabled but no active subscription
  //   Off       → notifications disabled
  const statusHtml = (u) => {
    if (u.notifyEnabled && u.hasPush)
      return '<span style="color:var(--green);font-size:11px;font-weight:600;white-space:nowrap;"><i class="ti ti-bell"></i> On</span>';
    if (u.notifyEnabled)
      return '<span style="color:var(--amber);font-size:11px;font-weight:600;white-space:nowrap;" title="Enabled but no active device"><i class="ti ti-bell"></i> No device</span>';
    return '<span style="color:var(--text-muted);font-size:11px;white-space:nowrap;"><i class="ti ti-bell-off"></i> Off</span>';
  };

  const onCount = devRecipients.filter(u => u.notifyEnabled && u.hasPush).length;
  const header = `<div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">${onCount} of ${devRecipients.length} reachable</div>`;

  box.innerHTML = header + (devRecipients.map(u => `
    <label style="display:flex;align-items:center;gap:10px;cursor:${u.hasPush ? 'pointer' : 'not-allowed'};font-size:13px;padding:6px 8px;border-radius:6px;border:1px solid var(--border-dim);${u.hasPush ? '' : 'opacity:.6;'}">
      <input type="checkbox" class="dn-recip" value="${escapeHtml(u.id)}" style="accent-color:var(--blue);" ${u.hasPush ? '' : 'disabled'} />
      <span style="flex:1;">${escapeHtml(u.name)} <span style="color:var(--text-muted);font-size:11px;">· ${roleLabel[u.role] || u.role}</span></span>
      ${statusHtml(u)}
    </label>`).join('') || '<p style="color:var(--text-secondary);">No staff found.</p>');
}

function toggleDevRecipientList() {
  const all = document.getElementById('dn-all')?.checked;
  const box = document.getElementById('dn-recipients');
  if (box) { box.style.opacity = all ? '.4' : '1'; box.style.pointerEvents = all ? 'none' : 'auto'; }
}

async function sendDevNotification() {
  const title = document.getElementById('dn-title')?.value.trim();
  const body  = document.getElementById('dn-body')?.value.trim();
  const url   = document.getElementById('dn-url')?.value.trim();
  const all   = document.getElementById('dn-all')?.checked || false;
  if (!title || !body) { showToast('Title and message are required.', 'error'); return; }
  const userIds = all ? [] : Array.from(document.querySelectorAll('.dn-recip')).filter(cb => cb.checked).map(cb => cb.value);
  if (!all && userIds.length === 0) { showToast('Select at least one recipient or choose "everyone".', 'error'); return; }
  try {
    const r = await api('/api/notifications/send', { method: 'POST', body: JSON.stringify({ title, body, url, all, userIds }) });
    showToast(`Notification sent to ${r.sent} device${r.sent === 1 ? '' : 's'}.`, 'success');
    document.getElementById('dn-title').value = '';
    document.getElementById('dn-body').value = '';
    document.getElementById('dn-url').value = '';
  } catch (err) { showToast(err.message || 'Failed to send notification.', 'error'); }
}

async function deleteCase(caseId) {
  if (!(await uiConfirm('Permanently delete this case? This cannot be undone.'))) return;
  try {
    await api(`/api/admin/cases/${caseId}`, { method: 'DELETE' });
    closeModal('modal-detail');
    showToast('Case deleted.', 'success');
    allCasesCache = allCasesCache.filter(c => c.id !== caseId);
    renderDashTable(); renderAllCasesTable(); loadStats(); loadAdminStats();
  } catch (err) { showToast(err.message || 'Failed to delete case.', 'error'); }
}

// ── Group Management Panel ────────────────────────────────────────

function groupError(msg) {
  return `<div style="padding:0.9rem 1.1rem;font-size:12px;color:#f07070;display:flex;align-items:flex-start;gap:8px;">
    <i class="ti ti-alert-triangle" style="flex-shrink:0;margin-top:1px;"></i>
    <span>${escapeHtml(msg)}</span>
  </div>`;
}

// Which division's Roblox group the panel is currently managing ('' = the
// default ROBLOX_GROUP_ID). The dev panel can switch between every division.
let currentGroupDivision = '';

// Build a query string carrying the selected division (+ any extra params).
function gq(params) {
  const p = new URLSearchParams(params || {});
  if (currentGroupDivision) p.set('division', currentGroupDivision);
  const s = p.toString();
  return s ? '?' + s : '';
}

// Populate the division switcher from the registry (future divisions auto-appear).
async function loadGroupDivisions() {
  const sel = document.getElementById('group-division-select');
  if (!sel) return;
  try {
    const divs = await api('/api/admin/group/divisions');
    sel.innerHTML = `<option value="">Default (ROBLOX_GROUP_ID)</option>` +
      divs.map(d => `<option value="${d.key}">${d.name}${d.fullName && d.fullName !== d.name ? ' — ' + d.fullName : ''}</option>`).join('');
    sel.value = currentGroupDivision;
  } catch (e) { /* switcher optional */ }
}

// Switch the group the panel manages, then reload it.
function changeGroupDivision(key) {
  currentGroupDivision = key || '';
  groupRolesCache = null;
  groupMembersNextToken = null;
  loadGroupPanel();
}

async function loadGroupPanel() {
  loadGroupDivisions();
  // Always reload roles fresh so rank dropdowns are populated
  try {
    groupRolesCache = await api('/api/admin/group/roles' + gq());
    const badge = document.getElementById('group-env-badge');
    if (badge) badge.textContent = `${groupRolesCache.length} role(s) loaded`;
  } catch (err) {
    groupRolesCache = [];
    const badge = document.getElementById('group-env-badge');
    if (badge) badge.textContent = `Roles failed: ${err.message}`;
    console.error('[Group panel] roles error:', err.message);
    // Auto-show debug output so developer can see what's wrong
    runGroupDebug();
  }
  await Promise.all([loadPendingRequests(), loadGroupMembers()]);
}

async function refreshGroupPanel() {
  groupRolesCache       = null;
  groupMembersNextToken = null;
  const debug = document.getElementById('group-debug-output');
  if (debug) debug.style.display = 'none';
  loadGroupPanel();
}

async function runGroupDebug() {
  const output = document.getElementById('group-debug-output');
  const pre    = document.getElementById('group-debug-pre');
  if (!output || !pre) return;
  output.style.display = 'block';
  pre.textContent = 'Fetching raw Roblox API responses…';
  try {
    const data = await api('/api/admin/group/debug');
    pre.textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    pre.textContent = `Error calling debug endpoint: ${err.message}`;
  }
}

// Collapse / expand a group panel section
function toggleGroupSection(bodyId, btn) {
  const body = document.getElementById(bodyId);
  if (!body) return;
  const hidden = body.style.display === 'none';
  body.style.display = hidden ? '' : 'none';
  const icon = btn && btn.querySelector('i');
  if (icon) icon.className = hidden ? 'ti ti-chevron-down' : 'ti ti-chevron-right';
}

// roleId(string) -> role object  /  bot rank threshold (>= this = not editable)
function groupRolesById() {
  const map = {};
  (groupRolesCache || []).forEach(r => { map[String(r.id)] = r; });
  return map;
}
function botRankThreshold() {
  const r = (groupRolesCache || []).find(x => (x.name || '').trim().toLowerCase() === BOT_RANK_NAME.toLowerCase());
  return r ? r.rank : Infinity; // can't find the bot rank → don't grey anyone out
}

// ── Pending join requests (cached + searchable) ───────────────────
async function loadPendingRequests() {
  const container = document.getElementById('pending-requests-container');
  if (!container) return;
  container.innerHTML = '<div class="table-loading"><div class="spinner"></div></div>';
  try {
    pendingCache = [];
    let token = null, pages = 0;
    do {
      const url  = '/api/admin/group/pending' + gq(token ? { pageToken: token } : {});
      const data = await api(url);
      pendingCache = pendingCache.concat(data?.requests || []);
      token = data?.nextPageToken || null;
      pages++;
    } while (token && pages < 1000); // ~100k requests; high bound just guards against a runaway loop
    renderPendingRequests();
  } catch (err) {
    console.error('[loadPendingRequests]', err.message);
    container.innerHTML = groupError(`Failed to load join requests: ${err.message}`);
  }
}

function renderPendingRequests() {
  const container = document.getElementById('pending-requests-container');
  if (!container) return;
  const q = (document.getElementById('pending-search')?.value || '').trim().toLowerCase();
  let list = pendingCache.slice();
  if (q) list = list.filter(r =>
    (r.username || '').toLowerCase().includes(q) ||
    (r.displayName || '').toLowerCase().includes(q) ||
    String(r.userId).includes(q));

  const countEl = document.getElementById('pending-count');
  if (countEl) countEl.textContent = `(${list.length})`;

  if (!list.length) {
    container.innerHTML = `<p style="padding:1rem 1.2rem;font-size:13px;color:var(--text-muted);">No pending join requests.</p>`;
    return;
  }

  container.innerHTML = `<div class="join-request-list">${list.map(r => `
    <div class="join-request-row">
      <div class="join-request-info">
        <span class="join-request-name">${escapeHtml(r.username)}</span>
        ${r.displayName && r.displayName !== r.username
          ? `<span class="join-request-display">${escapeHtml(r.displayName)}</span>` : ''}
        <span style="font-size:10px;color:var(--text-muted);">ID: ${escapeHtml(r.userId)}</span>
        ${r.requestedAt ? `<span class="join-request-time">${formatDateTime(r.requestedAt)}</span>` : ''}
      </div>
      <div class="join-request-actions">
        <button class="row-btn row-btn-approve"
          onclick="resolveRequest('${escapeHtml(r.userId)}','approve','${escapeHtml(r.username)}')">
          <i class="ti ti-check"></i> Accept
        </button>
        <button class="row-btn row-btn-deny"
          onclick="resolveRequest('${escapeHtml(r.userId)}','decline','${escapeHtml(r.username)}')">
          <i class="ti ti-x"></i> Decline
        </button>
      </div>
    </div>`).join('')}</div>`;
}

async function resolveRequest(userId, action, username) {
  try {
    await api(`/api/admin/group/pending/${userId}/${action}` + gq(), { method: 'POST' });
    showToast(`${username} ${action === 'approve' ? 'accepted' : 'declined'}.`,
              action === 'approve' ? 'success' : 'info');
    loadPendingRequests();
  } catch (err) {
    showToast(err.message || `Failed to ${action}.`, 'error');
  }
}

// ── Group members (cached, sorted high→low, filter + search) ──────
async function loadGroupMembers() {
  const tbody = document.getElementById('group-members-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="4" class="table-loading"><div class="spinner"></div></td></tr>';
  try {
    groupMembersCache = [];
    let token = null, pages = 0;
    do {
      const url    = '/api/admin/group/members' + gq(token ? { pageToken: token } : {});
      const result = await api(url);
      groupMembersCache = groupMembersCache.concat(result?.members || []);
      token = result?.nextPageToken || null;
      pages++;
      renderGroupMembers(); // progressive render as pages arrive
    } while (token && pages < 30);
    populateRankFilter();
    renderGroupMembers();
  } catch (err) {
    console.error('[loadGroupMembers]', err.message);
    tbody.innerHTML = `<tr><td colspan="4">${groupError(`Failed to load members: ${err.message}`)}</td></tr>`;
  }
}

// Rank name of the bot's own rank (members at this rank or above are locked).
// Derived from the live member list / roles so it works even if the role list
// failed to load.
function botRankValue() {
  // Prefer the bot account's OWN live rank in this group (the true ceiling).
  const bot = groupMembersCache.find(x => String(x.userId) === MET_ADMIN_USER_ID);
  if (bot && bot.roleRank != null) return bot.roleRank;
  // Fall back to the named rank (roles list, then members).
  const r = (groupRolesCache || []).find(x => (x.name || '').trim().toLowerCase() === BOT_RANK_NAME.toLowerCase());
  if (r) return r.rank;
  const m = groupMembersCache.find(x => (x.roleName || '').trim().toLowerCase() === BOT_RANK_NAME.toLowerCase());
  return m ? m.roleRank : Infinity;
}

function populateRankFilter() {
  const sel = document.getElementById('members-rank-filter');
  if (!sel) return;
  const prev = sel.value;
  // Build the rank list from the members themselves (name + rank), so the filter
  // always reflects the actual ranks present, sorted highest → lowest.
  const seen = new Map(); // name -> rank
  groupMembersCache.forEach(m => { if (m.roleName && !seen.has(m.roleName)) seen.set(m.roleName, m.roleRank ?? -1); });
  (groupRolesCache || []).forEach(r => { if (r.name && !seen.has(r.name)) seen.set(r.name, r.rank ?? -1); });
  const ranks = [...seen.entries()].sort((a, b) => b[1] - a[1]);
  sel.innerHTML = '<option value="">All ranks</option>' +
    ranks.map(([name]) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
  if (prev) sel.value = prev;
}

function renderGroupMembers() {
  const tbody = document.getElementById('group-members-tbody');
  if (!tbody) return;

  const roles     = groupRolesCache || [];
  const threshold = botRankValue();
  const q         = (document.getElementById('members-search')?.value || '').trim().toLowerCase();
  const rankFilter= document.getElementById('members-rank-filter')?.value || '';

  // Use each member's own role name + rank straight from the Roblox API
  let list = groupMembersCache.map(m => ({
    ...m,
    _rank:     (m.roleRank != null ? m.roleRank : -1),
    _roleName: m.roleName || m.roleId || '—',
  }));
  list.sort((a, b) => b._rank - a._rank); // highest rank first

  if (rankFilter) list = list.filter(m => m._roleName === rankFilter);
  if (q) list = list.filter(m =>
    (m.username || '').toLowerCase().includes(q) ||
    (m.displayName || '').toLowerCase().includes(q) ||
    String(m.userId).includes(q));

  const countEl = document.getElementById('members-count');
  if (countEl) countEl.textContent = `(${list.length}${list.length !== groupMembersCache.length ? ' / ' + groupMembersCache.length : ''})`;

  if (!list.length) { tbody.innerHTML = emptyRow(4, 'No members found.'); return; }

  // Only ranks strictly below the bot's rank can be assigned
  const assignable = roles.filter(r => r.rank < threshold).sort((a, b) => b.rank - a.rank);
  const roleOptions = (currentRoleId) =>
    assignable.map(r => `<option value="${escapeHtml(String(r.id))}" ${String(r.id) === String(currentRoleId) ? 'selected' : ''}>${escapeHtml(r.name)}</option>`).join('')
    || '<option value="">No assignable ranks</option>';

  tbody.innerHTML = list.map(m => {
    const locked = m._rank >= threshold; // bot can't manage its own rank or above
    return `
      <tr style="${locked ? 'opacity:0.4;' : ''}">
        <td>
          <div style="display:flex;flex-direction:column;gap:2px;">
            <span style="font-size:12px;font-weight:500;color:var(--text-primary);">${escapeHtml(m.username)}</span>
            ${m.displayName && m.displayName !== m.username
              ? `<span style="font-size:10px;color:var(--text-muted);">${escapeHtml(m.displayName)}</span>` : ''}
            <span style="font-size:10px;color:var(--text-muted);">ID: ${escapeHtml(m.userId)}</span>
          </div>
        </td>
        <td>
          <span style="font-size:12px;color:var(--text-secondary);">${escapeHtml(m._roleName)}</span>
          ${locked ? '<span style="font-size:9px;color:var(--text-muted);display:block;"><i class="ti ti-lock"></i> above bot rank</span>' : ''}
        </td>
        <td>
          ${locked
            ? '<span style="font-size:11px;color:var(--text-muted);">—</span>'
            : `<select class="role-select" id="rank-sel-${escapeHtml(m.userId)}">${roleOptions(m.roleId)}</select>`}
        </td>
        <td>
          ${locked
            ? '<span style="font-size:11px;color:var(--text-muted);">Cannot edit</span>'
            : `<div class="admin-actions">
                <button class="row-btn row-btn-approve btn-sm"
                  onclick="changeGroupRankUI('${escapeHtml(m.userId)}','${escapeHtml(m.username)}')">
                  <i class="ti ti-arrow-up"></i> Rank
                </button>
                <button class="row-btn row-btn-deny btn-sm"
                  onclick="kickGroupMember('${escapeHtml(m.userId)}','${escapeHtml(m.username)}')">
                  <i class="ti ti-door-exit"></i> Kick
                </button>
              </div>`}
        </td>
      </tr>`;
  }).join('');
}

async function changeGroupRankUI(userId, username) {
  const sel    = document.getElementById(`rank-sel-${userId}`);
  const roleId = sel?.value;
  if (!roleId) { showToast('Select a rank first.', 'error'); return; }
  try {
    await api(`/api/admin/group/members/${userId}/rank` + gq(), {
      method: 'PATCH',
      body:   JSON.stringify({ roleId }),
    });
    const roleName = (groupRolesCache || []).find(r => String(r.id) === String(roleId))?.name || roleId;
    showToast(`${username} ranked to ${roleName}.`, 'success');
    loadGroupMembers();
  } catch (err) {
    showToast(err.message || 'Failed to change rank.', 'error');
  }
}

async function kickGroupMember(userId, username) {
  if (!(await uiConfirm(`Kick ${username} from the Roblox group?`))) return;
  try {
    await api(`/api/admin/group/members/${userId}` + gq(), { method: 'DELETE' });
    showToast(`${username} kicked from group.`, 'success');
    loadGroupMembers();
  } catch (err) {
    showToast(err.message || 'Failed to kick.', 'error');
  }
}

// ── Case approve / deny ───────────────────────────────────────────
// Punishments only HICOMM (not Supervisors) may approve/deny.
const HICOMM_ONLY_ACTIONS = ['Blacklist', 'Termination'];
function caseHasHicommOnlyPunishment(c) {
  const names = [];
  if (Array.isArray(c.actions)) c.actions.forEach(a => { if (a && a.action) names.push(a.action); });
  if (c.action) String(c.action).split(',').forEach(s => names.push(s.trim()));
  return names.some(n => HICOMM_ONLY_ACTIONS.includes(n));
}
function supervisorBlockedFromCase(c) {
  return currentUser?.role === 'SUPERVISOR' && caseHasHicommOnlyPunishment(c);
}

function rowActions(c) {
  if (supervisorBlockedFromCase(c)) {
    return '<span style="font-size:11px;color:var(--amber);white-space:nowrap;"><i class="ti ti-lock"></i> HICOMM only</span>';
  }
  // Already bounced back to the submitter — make that obvious, but still let a
  // reviewer approve/deny directly if they choose to.
  const awaiting = caseAwaitingChanges(c)
    ? `<div class="row-changes-chip" title="${escapeHtml(c.reviewNote)}"><i class="ti ti-clock-edit"></i> Awaiting submitter</div>`
    : '';
  return `${awaiting}<div class="row-actions">
    <button class="row-btn row-btn-approve" onclick="decideCase('${c.id}','approve')"><i class="ti ti-check"></i> Approve</button>
    <button class="row-btn row-btn-deny"    onclick="decideCase('${c.id}','deny')"><i class="ti ti-x"></i> Deny</button>
  </div>`;
}

function decideCase(caseId, decision) {
  // Approval shows the Administrative Log preview + confirm first
  if (decision === 'approve') {
    const c = allCasesCache.find(x => x.id === caseId);
    const actions = (c && Array.isArray(c.actions) && c.actions.length)
      ? c.actions : [{ action: c ? c.action : '', durationDays: null }];
    showEmbedPreview({
      title: 'Confirm Approval',
      note: 'Approving posts this Notice to #administrative-logs and applies the punishments. Confirm the details:',
      embedData: {
        officerMention: (c && (c.robloxUsername || c.officerDiscordId)) || 'Unknown Officer',
        punishments: actions, reason: c && c.reason, notes: c && c.notes,
        caseRef: c && c.caseRef, signedBy: currentUser?.displayName || currentUser?.discordUsername,
      },
      buttons: [
        { label: 'Go back', class: 'btn btn-ghost', onClick: () => closeModal('modal-embed-preview') },
        { label: '<i class="ti ti-x"></i> Deny instead', class: 'btn btn-danger',
          onClick: () => { closeModal('modal-embed-preview'); doDecide(caseId, 'deny'); } },
        { label: '<i class="ti ti-check"></i> Confirm Approve', class: 'btn btn-success',
          onClick: () => { closeModal('modal-embed-preview'); doDecide(caseId, 'approve'); } },
      ],
    });
    return;
  }
  return doDecide(caseId, decision);
}

async function doDecide(caseId, decision) {
  try {
    await api(`/api/cases/${caseId}/${decision}`, { method: 'PATCH' });
    const verb = decision === 'approve' ? 'approved' : 'denied';
    showToast(`Case ${verb}.${decision === 'approve' ? ' Log posted & roles assigned.' : ''}`, decision === 'approve' ? 'success' : 'info');
    if (decision === 'approve' && typeof fireConfetti === 'function') fireConfetti();
    await loadStats();
    await loadDashCases();
    loadReview();
    loadAllCases();
  } catch (err) { showToast(err.message || `Failed to ${decision} case.`, 'error'); }
}

// Extract canonical punishments from a free-text "request changes" note.
// Returns [{ action, durationDays }]. A bare "strike" (no number) is ignored so
// we never auto-apply something inaccurate. Notes with no punishment at all are
// fine — they just return [] (the reviewer may only be asking for doc edits).
// Recognises abbreviations ("zt" = Zero Tolerance) and a duration ("5 day zt").
function parseRequestedActions(text) {
  const t = ' ' + (text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ') + ' ';
  const rules = [
    ['Disciplinary Strike 1', [/\bdisciplinary strike\s*1\b/, /\bstrike\s*1\b/, /\bds\s*1\b/, /\b1st strike\b/, /\bfirst strike\b/]],
    ['Disciplinary Strike 2', [/\bdisciplinary strike\s*2\b/, /\bstrike\s*2\b/, /\bds\s*2\b/, /\b2nd strike\b/, /\bsecond strike\b/]],
    ['Activity Strike',       [/\bactivity strike\b/]],
    ['Verbal Warning',        [/\bverbal warning\b/, /\bverbal\b/]],
    ['Written Warning',       [/\bwritten warning\b/, /\bwritten\b/]],
    ['Zero Tolerance',        [/\bzero tolerance\b/, /\bzt\b/, /\bz t\b/]],
    ['Demotion',              [/\bdemotion\b/, /\bdemote[d]?\b/]],
    ['Termination',           [/\btermination\b/, /\bterminate[d]?\b/, /\bfired\b/]],
    ['Blacklist',             [/\bblacklist(ed)?\b/]],
  ];
  // A duration mentioned anywhere ("5 day", "5 days", "5d") attaches to the
  // punishments that carry one (Zero Tolerance).
  const durM = t.match(/\b(\d{1,3})\s*(?:d|day|days)\b/);
  const dur  = durM ? parseInt(durM[1], 10) : null;
  const TIMED = { 'Zero Tolerance': true };
  const found = [];
  for (const [name, pats] of rules) {
    if (pats.some(p => p.test(t))) found.push({ action: name, durationDays: (dur && TIMED[name]) ? dur : null });
  }
  return found;
}

// Normalise a stored reviewChanges action (old = plain string, new = object).
function reqActionObj(a)   { return (a && typeof a === 'object') ? a : { action: String(a), durationDays: null }; }
function reqActionLabel(a) { const o = reqActionObj(a); return o.action + (o.durationDays ? ` (${o.durationDays}d)` : ''); }

// Bounce a pending case back to its submitter with a note (in-site modal).
function requestCaseChanges(caseId) {
  const noteEl     = document.getElementById('rc-note');
  const detectedEl = document.getElementById('rc-detected');
  const sendBtn    = document.getElementById('btn-send-request-changes');
  if (!noteEl || !sendBtn) return;
  noteEl.value = '';
  if (detectedEl) detectedEl.style.display = 'none';

  // Live preview of any punishment the note mentions
  noteEl.oninput = () => {
    const detected = parseRequestedActions(noteEl.value);
    if (!detectedEl) return;
    if (detected.length) {
      detectedEl.style.display = '';
      detectedEl.innerHTML = '<i class="ti ti-wand"></i> Detected punishment change — the submitter will get a one-click apply for: <strong>'
        + detected.map(d => escapeHtml(reqActionLabel(d))).join(', ') + '</strong>';
    } else { detectedEl.style.display = 'none'; }
  };

  sendBtn.onclick = async () => {
    const note = noteEl.value.trim();
    if (!note) { showToast('A note is required to request changes.', 'error'); return; }
    try {
      await api(`/api/cases/${caseId}/request-changes`, {
        method: 'PATCH',
        body:   JSON.stringify({ note, actions: parseRequestedActions(note) }),
      });
      closeModal('modal-request-changes');
      closeModal('modal-detail');
      showToast('Changes requested — the submitter has been notified.', 'success');
      loadReview(); loadAllCases();
    } catch (err) { showToast(err.message || 'Failed to request changes.', 'error'); }
  };

  openModal('modal-request-changes');
}

// Submitter: offer to auto-apply the reviewer's requested punishment change.
function promptApplyChanges(c) {
  const actions = (c.reviewChanges && Array.isArray(c.reviewChanges.actions)) ? c.reviewChanges.actions : [];
  const noteEl  = document.getElementById('ac-note');
  const suggest = document.getElementById('ac-suggest');
  const listEl  = document.getElementById('ac-list');
  const applyBtn = document.getElementById('btn-apply-changes');
  const manualBtn = document.getElementById('btn-edit-manually');
  if (!noteEl || !applyBtn) return;

  noteEl.textContent = c.reviewNote || 'Please review and update this case.';

  if (actions.length && listEl && suggest) {
    suggest.style.display = '';
    listEl.innerHTML = actions.map(a => `<span class="badge badge-amber"><span class="badge-dot"></span>${escapeHtml(reqActionLabel(a))}</span>`).join('');
    applyBtn.style.display = '';
    applyBtn.onclick = () => {
      // Pass durations through (preserveDurations) so "5 day zt" applies as 5d.
      applyDocPunishments(actions.map(a => { const o = reqActionObj(a); return { action: o.action, durationDays: o.durationDays }; }), true);
      closeModal('modal-apply-changes');
      showToast('Requested punishment applied — review the details and save.', 'success');
    };
  } else {
    // Nothing reliably parsed — just show the note, no auto-apply.
    if (suggest) suggest.style.display = 'none';
    applyBtn.style.display = 'none';
  }

  if (manualBtn) manualBtn.onclick = () => closeModal('modal-apply-changes');
  openModal('modal-apply-changes');
}

// ── Case Detail Modal ─────────────────────────────────────────────
function openDetail(caseId) {
  const c = allCasesCache.find(x => x.id === caseId);
  if (!c) return;

  document.getElementById('detail-ref').textContent = c.caseRef;

  const decisionAction = c.caseActions?.find(a => a.actionType === 'APPROVED' || a.actionType === 'DENIED');
  const exileActions   = c.caseActions?.filter(a => a.notes?.startsWith('Roblox group exile')) || [];
  const isElevated     = ['HICOMM', 'SUPERVISOR', 'DEVELOPER'].includes(currentUser?.role);
  const isDev          = currentUser?.role === 'DEVELOPER';
  const isOwner        = c.userId === currentUser?.id;
  const awaiting       = caseAwaitingChanges(c);
  const reviewer       = (c.reviewChanges && c.reviewChanges.by) ? c.reviewChanges.by : null;
  const reviewedAt     = (c.reviewChanges && c.reviewChanges.at) ? c.reviewChanges.at : null;

  // Build punishment list
  let punishmentHtml = '';
  if (Array.isArray(c.actions) && c.actions.length) {
    punishmentHtml = c.actions.map(a => {
      const dur = a.durationDays ? `${a.durationDays}d` : 'Permanent';
      const durLabel = a.roleId ? ` <span style="color:var(--text-muted);font-size:10px;">(${dur})</span>` : '';
      return `<div style="font-size:12px;">• ${escapeHtml(a.action)}${durLabel}</div>`;
    }).join('');
  } else {
    punishmentHtml = `<div style="font-size:12px;">• ${escapeHtml(c.action)}</div>`;
  }

  const robloxSection = c.robloxUsername ? `
    <div class="detail-divider"></div>
    <div class="detail-field">
      <span class="detail-field-label">Roblox Username</span>
      <span class="detail-field-value mono">${escapeHtml(c.robloxUsername)}${c.suspectRobloxDisplayName ? ` <span style="color:var(--text-muted);font-weight:400;">(${escapeHtml(c.suspectRobloxDisplayName)})</span>` : ''}</span>
    </div>
    ${exileActions.map(ea => `
    <div class="detail-field full">
      <span class="detail-field-label">Group Exile</span>
      <span class="detail-field-value" style="font-size:12px;color:${ea.notes.includes('failed') ? 'var(--status-denied)' : 'var(--status-approved)'};">
        ${ea.notes.includes('failed') ? '<i class="ti ti-alert-triangle"></i> ' : '<i class="ti ti-check"></i> '}${escapeHtml(ea.notes)}
      </span>
    </div>`).join('')}
  ` : '';

  // Investigator (parsed from the case doc on import) — useful for legacy cases
  // where "Submitted By" is the import bot rather than the real investigator.
  const hasInvestigator = c.investigatorDiscordUsername || c.investigatorRobloxUsername || c.investigatorRobloxId;
  const investigatorSection = hasInvestigator ? `
    <div class="detail-divider"></div>
    ${c.investigatorRobloxUsername ? `
    <div class="detail-field">
      <span class="detail-field-label">Investigator (Roblox)</span>
      <span class="detail-field-value mono">${escapeHtml(c.investigatorRobloxUsername)}${c.investigatorRobloxId ? ` <span style="color:var(--text-muted);font-weight:400;">· ${escapeHtml(c.investigatorRobloxId)}</span>` : ''}</span>
    </div>` : ''}
    ${c.investigatorDiscordUsername ? `
    <div class="detail-field">
      <span class="detail-field-label">Investigator (Discord)</span>
      <span class="detail-field-value mono">${escapeHtml(c.investigatorDiscordUsername)}</span>
    </div>` : ''}
  ` : '';

  document.getElementById('detail-body').innerHTML = `
    ${awaiting ? `
    <div style="margin-bottom:1rem;padding:13px 15px;border-radius:10px;background:rgba(245,197,24,.12);border:1px solid rgba(245,197,24,.4);box-shadow:0 0 18px rgba(240,170,20,.12);">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--amber);"><i class="ti ti-edit-circle"></i> Changes requested — awaiting update</div>
        ${reviewer ? `<div style="font-size:11px;color:var(--text-muted);white-space:nowrap;">by <strong style="color:var(--text-secondary);">${escapeHtml(reviewer)}</strong>${reviewedAt ? ' · ' + formatDateTime(reviewedAt) : ''}</div>` : ''}
      </div>
      <div style="font-size:13px;color:var(--text-primary);line-height:1.5;">${escapeHtml(c.reviewNote)}</div>
      ${(c.reviewChanges && Array.isArray(c.reviewChanges.actions) && c.reviewChanges.actions.length)
        ? `<div style="margin-top:8px;font-size:12px;color:var(--text-secondary);"><i class="ti ti-wand"></i> Suggested punishment: ${c.reviewChanges.actions.map(a => escapeHtml(reqActionLabel(a))).join(', ')}</div>` : ''}
      <div style="margin-top:8px;font-size:12px;color:var(--text-secondary);line-height:1.5;">
        ${isOwner
          ? '<i class="ti ti-arrow-back-up"></i> Edit this case to address the note — it will return to the review queue automatically.'
          : '<i class="ti ti-clock"></i> Sent back to the submitter. It stays pending until they update it.'}
      </div>
    </div>` : ''}
    <div class="detail-grid">
      <div class="detail-field">
        <span class="detail-field-label">Case Reference</span>
        <span class="detail-field-value mono">${escapeHtml(c.caseRef)}</span>
      </div>
      <div class="detail-field">
        <span class="detail-field-label">Status</span>
        <span class="detail-field-value">${statusBadge(c.status)}</span>
      </div>
      ${c.officerDiscordId ? `
      <div class="detail-field full">
        <span class="detail-field-label">Officer Discord ID</span>
        <span class="detail-field-value mono" style="font-size:12px;">${escapeHtml(c.officerDiscordId)}</span>
      </div>` : ''}
      <div class="detail-field full">
        <span class="detail-field-label">Punishment(s)</span>
        <span class="detail-field-value">${punishmentHtml}</span>
      </div>
      <div class="detail-field full">
        <span class="detail-field-label">Reason</span>
        <span class="detail-field-value">${escapeHtml(c.reason)}</span>
      </div>
      <div class="detail-field full">
        <span class="detail-field-label">Notes</span>
        <span class="detail-field-value" style="color:var(--text-secondary);">${escapeHtml(c.notes)}</span>
      </div>
      ${c.caseLink ? `
      <div class="detail-field full">
        <span class="detail-field-label">Case Link</span>
        <span class="detail-field-value"><a href="${escapeHtml(c.caseLink)}" target="_blank" rel="noopener noreferrer" style="color:var(--blue);word-break:break-all;">${escapeHtml(c.caseLink)}</a></span>
      </div>` : ''}
      ${robloxSection}
      ${investigatorSection}
      <div class="detail-divider"></div>
      <div class="detail-field">
        <span class="detail-field-label">${(c.investigatorRobloxUsername || c.investigatorDiscordUsername) ? 'Investigator' : 'Submitted By'}</span>
        <span class="detail-field-value">${escapeHtml(c.investigatorRobloxUsername || c.investigatorDiscordUsername || c.user?.displayName || c.user?.discordUsername || '—')}</span>
      </div>
      <div class="detail-field">
        <span class="detail-field-label">Submitted At</span>
        <span class="detail-field-value" style="font-size:12px;">${formatDateTime(c.createdAt)}</span>
      </div>
      ${decisionAction ? `
        <div class="detail-field">
          <span class="detail-field-label">${c.status === 'APPROVED' ? 'Approved' : 'Denied'} By</span>
          <span class="detail-field-value">${escapeHtml(decisionAction.user?.displayName || decisionAction.user?.discordUsername || '—')}</span>
        </div>
        <div class="detail-field">
          <span class="detail-field-label">Decision At</span>
          <span class="detail-field-value" style="font-size:12px;">${formatDateTime(decisionAction.timestamp)}</span>
        </div>` : ''}
    </div>`;

  const footer = document.getElementById('detail-footer');
  footer.innerHTML = '';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn btn-ghost'; closeBtn.textContent = 'Close';
  closeBtn.onclick   = () => closeModal('modal-detail');
  footer.appendChild(closeBtn);

  // Copy a shareable link to this case (available to everyone).
  const linkBtn = document.createElement('button');
  linkBtn.className = 'btn btn-ghost'; linkBtn.innerHTML = '<i class="ti ti-link"></i> Copy link';
  linkBtn.onclick = () => copyCaseLink(c.id);
  footer.appendChild(linkBtn);

  if (isDev) {
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-danger'; delBtn.innerHTML = '<i class="ti ti-trash"></i> Delete';
    delBtn.style.marginRight = 'auto'; delBtn.onclick = () => deleteCase(c.id);
    footer.insertBefore(delBtn, footer.firstChild);
  }

  // HICOMM / Developer can edit a case and re-post the administrative log.
  // The submitter can also edit their OWN case while it's still pending — e.g.
  // to action a "changes requested" note from a reviewer.
  const isOwnerPending = c.userId === currentUser?.id && c.status === 'PENDING';
  if (isElevated || isOwnerPending) {
    const editBtn = document.createElement('button');
    // For the submitter of a bounced-back case, make the primary action loud and
    // unambiguous: this is how they resolve the requested changes.
    if (isOwnerPending && awaiting) {
      editBtn.className = 'btn btn-warning';
      editBtn.innerHTML = '<i class="ti ti-arrow-back-up"></i> Resolve requested changes';
    } else {
      editBtn.className = 'btn btn-ghost';
      editBtn.innerHTML = '<i class="ti ti-edit"></i> Edit';
    }
    editBtn.onclick = () => openEditCase(c.id);
    footer.appendChild(editBtn);
  }

  if (isElevated && c.status === 'PENDING' && supervisorBlockedFromCase(c)) {
    const note = document.createElement('span');
    note.style.cssText = 'font-size:12px;color:var(--amber);align-self:center;margin-left:auto;';
    note.innerHTML = '<i class="ti ti-lock"></i> Only HICOMM can approve or deny Blacklist / Termination cases.';
    footer.appendChild(note);
  } else if (isElevated && c.status === 'PENDING') {
    // Request Changes — bounce the case back to the submitter with a note
    const reqBtn = document.createElement('button');
    reqBtn.className = 'btn btn-ghost'; reqBtn.style.color = 'var(--amber)';
    reqBtn.innerHTML = '<i class="ti ti-edit-circle"></i> Request Changes';
    reqBtn.onclick = () => requestCaseChanges(c.id);
    footer.appendChild(reqBtn);

    const approveBtn = document.createElement('button');
    approveBtn.className = 'btn btn-success'; approveBtn.innerHTML = '<i class="ti ti-check"></i> Approve';
    approveBtn.onclick   = async () => { closeModal('modal-detail'); await decideCase(c.id, 'approve'); };

    const denyBtn = document.createElement('button');
    denyBtn.className = 'btn btn-danger'; denyBtn.innerHTML = '<i class="ti ti-x"></i> Deny';
    denyBtn.onclick   = async () => { closeModal('modal-detail'); await decideCase(c.id, 'deny'); };

    footer.appendChild(denyBtn);
    footer.appendChild(approveBtn);
  }

  openModal('modal-detail');
}

