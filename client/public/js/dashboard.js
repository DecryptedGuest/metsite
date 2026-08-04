// client/public/js/dashboard.js

// ── Constants ─────────────────────────────────────────────────────
// The punishment list, loaded from the server (GET /api/cases/actions) so it is
// the SAME list the server assigns roles from.
//
// This used to be a hard-coded copy, and the copy drifted: it still had Written
// Warning and Suspension down as carrying no Discord role long after both were
// configured, so the case builder badged them "NO ROLE" and — because the
// duration picker is only offered for an action that has a role to take away
// again — gave a suspension no length. It also still listed two actions the
// server has since retired.
//
// What is written here is only what the checklist renders with before the fetch
// lands, or if the fetch fails. It is kept correct, but it is not the source of
// truth: loadActionDefs() replaces it in place with whatever the server says.
const ACTIONS_CLIENT = [
  { name: 'Written Warning',       hasRole: true,  exile: false, timed: false },
  { name: 'Zero Tolerance',        hasRole: true,  exile: false, timed: true  },
  { name: 'Suspension',            hasRole: true,  exile: false, timed: true  },
  { name: 'Activity Strike',       hasRole: true,  exile: false, timed: false },
  { name: 'Disciplinary Strike 1', hasRole: true,  exile: false, timed: false },
  { name: 'Disciplinary Strike 2', hasRole: true,  exile: false, timed: false },
  { name: 'Demotion',              hasRole: false, exile: false, timed: false },
  { name: 'Termination',           hasRole: false, exile: true,  timed: false },
  { name: 'Blacklist',             hasRole: true,  exile: true,  timed: false },
];

// Replace the fallback with the server's list. In place, because the array is
// a const that other modules (ui.js's embed preview) already hold a reference
// to. Best-effort: a failed fetch leaves the fallback, which is a stale list
// rather than an empty checklist.
let _actionDefsLoaded = false;
async function loadActionDefs(force) {
  if (_actionDefsLoaded && !force) return ACTIONS_CLIENT;
  try {
    const d = await api('/api/cases/actions');
    const list = Array.isArray(d) ? null : (d && d.actions);
    if (Array.isArray(list) && list.length) {
      ACTIONS_CLIENT.length = 0;
      list.forEach(a => ACTIONS_CLIENT.push({
        name: a.name, hasRole: !!a.hasRole, exile: !!a.exile, timed: !!a.timed,
      }));
      _actionDefsLoaded = true;
      renderActionChecklist();
    }
  } catch (e) { /* the fallback list stands */ }
  return ACTIONS_CLIENT;
}

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
let editingCaseRef      = '';    // its reference, offered to the document builder
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
  // The real punishment list, from the same config the server assigns roles
  // from. Not awaited: the checklist above has already drawn with the fallback,
  // and this re-renders it the moment the answer lands.
  loadActionDefs();
  // Developer division lands on the Dev Panel; IA lands on the dashboard.
  if (isDevContext() && currentUser && currentUser.role === 'DEVELOPER') navigateTo('admin');
  else loadDashboard();
  startNavBadgePolling();   // keep the pending case/ticket badges current
  maybeShowNotifyOptIn();   // offer to turn on ticket notifications (once)
  startSessionHeartbeat();
  handleNotificationLaunch(); // open a case/ticket if arriving from a notification
});

// Keep the sidebar "pending" badges up to date without having to open the
// relevant tab — refreshes on load, on a timer, and whenever the tab regains
// focus (so counts are current when you come back to an open tab).
async function refreshNavBadges() {
  try {
    const [caseStats, caseMineStats] = await Promise.all([
      api('/api/cases/stats').catch(() => null),            // scope depends on role (all-pending for elevated)
      api('/api/cases/stats?scope=mine').catch(() => null), // always the user's OWN pending
    ]);
    const setBadge = (id, n) => {
      const el = document.getElementById(id);
      if (el) { el.textContent = n; el.style.display = n > 0 ? '' : 'none'; }
    };
    if (caseStats)     setBadge('nav-badge-review', caseStats.pending || 0);
    // "My Cases" badges what's on the submitter's plate: cases sent back to them.
    if (caseMineStats) setBadge('nav-badge-my', caseMineStats.changesRequested || 0);

    // Events waiting on a supervisor. The Pending nav badge counts them
    // alongside cases, because "Pending" is one queue as far as anybody
    // glancing at the sidebar is concerned.
    if (window.canReviewCasework) {
      const [ev, pt] = await Promise.all([
        api('/api/ia-events/pending-count').catch(() => null),
        api('/api/ia-patrols/pending-count').catch(() => null),
      ]);
      if (ev) setBadge('pending-events-badge', ev.pending || 0);
      if (pt) setBadge('pending-patrols-badge', pt.pending || 0);
      // The sidebar badge is one number for one queue: cases, events and patrols
      // are all "waiting on a supervisor" as far as anybody glancing at it is
      // concerned. Counting only two of the three understates the backlog.
      const logs = (ev ? ev.pending || 0 : 0) + (pt ? pt.pending || 0 : 0);
      if (ev || pt) setBadge('readonly-pending-badge', logs);
      const nav = document.getElementById('nav-badge-review');
      if (nav && caseStats && (ev || pt)) {
        const total = (caseStats.pending || 0) + logs;
        nav.textContent = total;
        nav.style.display = total > 0 ? '' : 'none';
      }
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

    if (['HICOMM', 'SUPERVISOR', 'DEVELOPER'].includes(currentUser.role)) {
      document.querySelectorAll('.hicomm-only, .supervisor-only').forEach(el => el.style.display = '');
      // Supervisor and above sign ticket logs off (tickets.js reads this).
      window.canReviewTickets = true;
      // …and event logs, which is why the archive says it is not the place.
      window.canReviewCasework = true;
    }
    if (['HICOMM', 'DEVELOPER'].includes(currentUser.role)) {
      document.querySelectorAll('.hicomm-strict-only').forEach(el => el.style.display = '');
      // Withdrawing an event reverses everybody's points, so it is theirs.
      window.canVoidEvents = true;
    }
    // Developer-only, ANYWHERE — not just inside /dev. `.dev-only` is the
    // Developer division's own nav and pages, which are deliberately hidden on
    // the IA dashboard; this is for the handful of controls that sit among the
    // ordinary tools and must still never be pressable by anybody else. The
    // clear-backlog button is one: it approves thousands of rows in one press.
    if (currentUser.role === 'DEVELOPER') {
      document.querySelectorAll('.developer-only').forEach(el => el.style.display = '');
    }
    // The ticket re-sync shares the casework header with "Submit Case", so the
    // selector decides when it is on screen; this decides whether they may see it
    // at all. DEVELOPER only.
    //
    // `allowed` was being stamped on for EVERY signed-in user, and the selector
    // then sets display directly — which overrides the CSS class that was
    // supposed to be hiding it. So the class gated nothing and a supervisor could
    // see the button. The gate belongs on the flag, not on a class that something
    // else overwrites.
    const syncBtn = document.getElementById('btn-ticket-sync');
    if (syncBtn) {
      if (currentUser.role === 'DEVELOPER') syncBtn.dataset.allowed = '1';
      else delete syncBtn.dataset.allowed;
      syncBtn.style.display = 'none';
    }

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
  if (!currentUser || !['IA', 'HICOMM', 'SUPERVISOR', 'DEVELOPER'].includes(currentUser.role)) return;
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

// ── Casework selector ─────────────────────────────────────────────
// Cases or tickets, everyone's or mine. Defaults to everyone's, which is what
// people are usually looking for — your own work is a filter on the archive,
// not a different place.
let caseworkKind  = 'cases';
let caseworkScope = 'all';
window.caseworkScope = 'all';
let pendingKind   = 'cases';

const CASEWORK_COPY = {
  'cases:all':    ['All Cases',   'Every case Internal Affairs has filed'],
  'cases:mine':   ['My Cases',    'Cases you submitted'],
  'tickets:all':  ['All Tickets', 'Every closed ticket logged in Discord'],
  'tickets:mine': ['My Tickets',  'Tickets you closed'],
  'events:all':   ['Event Logs',  'Every event Internal Affairs has run'],
  'events:mine':  ['Event Logs',  'Events you hosted'],
  'patrols:all':  ['Patrol Logs', 'Every patrol Internal Affairs has filed'],
  'patrols:mine': ['Patrol Logs', 'Patrols you went out on'],
};

function applyCaseworkSelector() {
  document.querySelectorAll('#casework-kind .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.kind === caseworkKind));
  document.querySelectorAll('#casework-scope .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.scope === caseworkScope));

  const PANES = {
    'cases:all':    'cw-cases-all',   'cases:mine':   'cw-cases-mine',
    'tickets:all':  'cw-tickets-all', 'tickets:mine': 'cw-tickets-mine',
    // An event is hosted rather than filed against somebody, so one pane
    // serves both scopes — its own All/Mine filter does the narrowing.
    'events:all':   'cw-events',      'events:mine':  'cw-events',
    // Same for a patrol: it is filed BY somebody rather than against them, so
    // one pane serves both scopes and its own All/Mine filter narrows it.
    'patrols:all':  'cw-patrols',     'patrols:mine': 'cw-patrols',
  };
  const want = PANES[`${caseworkKind}:${caseworkScope}`];
  Object.values(PANES).forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = id === want ? '' : 'none';
  });

  const [title, sub] = CASEWORK_COPY[`${caseworkKind}:${caseworkScope}`] || ['Casework', ''];
  const t = document.getElementById('casework-title'); if (t) t.textContent = title;
  const p = document.getElementById('casework-sub');   if (p) p.textContent = sub;

  // "Submit Case" belongs to cases; the Discord re-sync to tickets; "Log an
  // event" to events, and only for somebody allowed to file one.
  const newBtn = document.querySelector('#page-casework .btn-new-case');
  if (newBtn) newBtn.style.display = caseworkKind === 'cases' ? '' : 'none';
  const sync = document.getElementById('btn-ticket-sync');
  if (sync && sync.dataset.allowed === '1') sync.style.display = caseworkKind === 'tickets' ? '' : 'none';
  const newEv = document.getElementById('btn-new-event');
  if (newEv) newEv.style.display = (caseworkKind === 'events' && window.canFileEvents) ? '' : 'none';
  const newPt = document.getElementById('btn-new-patrol');
  if (newPt) newPt.style.display = (caseworkKind === 'patrols' && window.canFilePatrols) ? '' : 'none';

  // The archive is read-only, and that is not obvious to somebody who can
  // decide things elsewhere.
  const note = document.getElementById('casework-readonly');
  if (note && window.canReviewCasework) note.style.display = '';
}

function setCaseworkKind(kind)  { caseworkKind = kind;  applyCaseworkSelector(); loadCasework(); }
function setCaseworkScope(scope){
  caseworkScope = scope;
  // The events list is in its own file and follows this selector too.
  window.caseworkScope = scope;
  applyCaseworkSelector();
  loadCasework();
}

// Only the pane on screen is loaded. Switching panes loads the other.
function loadCasework() {
  if (caseworkKind === 'events') return (typeof loadIaEvents === 'function') ? loadIaEvents() : null;
  if (caseworkKind === 'patrols') return (typeof loadIaPatrols === 'function') ? loadIaPatrols() : null;
  if (caseworkKind === 'cases')  return caseworkScope === 'all' ? loadAllCases() : loadMyCases();
  return caseworkScope === 'all' ? loadAllTickets() : loadTickets();
}

function applyPendingSelector() {
  document.querySelectorAll('#pending-kind .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.pkind === pendingKind));
  [['pend-cases', 'cases'], ['pend-tickets', 'tickets'], ['pend-events', 'events'],
   ['pend-patrols', 'patrols']].forEach(([id, kind]) => {
    const el = document.getElementById(id);
    if (el) el.style.display = pendingKind === kind ? '' : 'none';
  });
}

function setPendingKind(kind) { pendingKind = kind; applyPendingSelector(); loadPending(); }

function loadPending() {
  if (pendingKind === 'cases')  return loadReview();
  if (pendingKind === 'events') return (typeof loadPendingIaEvents === 'function') ? loadPendingIaEvents() : null;
  if (pendingKind === 'patrols') return (typeof loadPendingIaPatrols === 'function') ? loadPendingIaPatrols() : null;
  return typeof loadPendingTickets === 'function' ? loadPendingTickets() : null;
}

function setupCaseworkSelector() {
  document.querySelectorAll('#casework-kind .seg-btn').forEach(b =>
    b.addEventListener('click', () => setCaseworkKind(b.dataset.kind)));
  document.querySelectorAll('#casework-scope .seg-btn').forEach(b =>
    b.addEventListener('click', () => setCaseworkScope(b.dataset.scope)));
  document.querySelectorAll('#pending-kind .seg-btn').forEach(b =>
    b.addEventListener('click', () => setPendingKind(b.dataset.pkind)));
  const go = document.getElementById('btn-go-pending');
  if (go) go.addEventListener('click', () => navigateTo('pending'));
  applyCaseworkSelector();
  applyPendingSelector();
}

// The casework footer links to the document archive by name; that page has no
// nav item any more, so give it the same entry point everything else uses.
function showPage(id) { return navigateTo(id); }
window.showPage = showPage;

// ── Navigation ────────────────────────────────────────────────────
function setupNav() {
  setupCaseworkSelector();
  document.querySelectorAll('.nav-item[data-page]').forEach(btn =>
    btn.addEventListener('click', () => navigateTo(btn.dataset.page))
  );

  // The developer tools live in a collapsed group so they don't dominate the
  // sidebar for the people who can see them.
  const devToggle = document.getElementById('nav-dev-toggle');
  const devGroup  = document.getElementById('nav-dev-group');
  if (devToggle && devGroup) {
    const open = localStorage.getItem('iacms_nav_dev') === '1';
    devGroup.style.display = open ? '' : 'none';
    devToggle.classList.toggle('nav-open', open);
    devToggle.addEventListener('click', () => {
      const nowOpen = devGroup.style.display === 'none';
      devGroup.style.display = nowOpen ? '' : 'none';
      devToggle.classList.toggle('nav-open', nowOpen);
      localStorage.setItem('iacms_nav_dev', nowOpen ? '1' : '0');
    });
  }

  // The sidebar search chip opens the command palette (Ctrl/Cmd+K).
  const navSearch = document.getElementById('nav-search-btn');
  if (navSearch) navSearch.addEventListener('click', () => {
    if (typeof openCommandPalette === 'function') openCommandPalette();
    else navigateTo('all-cases');
  });
}

// Cases and tickets used to be four pages; the review queue was a fifth. They
// are now two pages with a selector. Every existing caller — notification deep
// links, the overview shortcuts, "review this case" — still names the old page,
// so those names are resolved here rather than rewritten in twenty places.
const MERGED_PAGES = {
  'my-cases':    { page: 'casework', kind: 'cases',   scope: 'mine' },
  'all-cases':   { page: 'casework', kind: 'cases',   scope: 'all'  },
  tickets:       { page: 'casework', kind: 'tickets', scope: 'mine' },
  'all-tickets': { page: 'casework', kind: 'tickets', scope: 'all'  },
  review:        { page: 'pending',  pkind: 'cases' },
};

function navigateTo(pageId) {
  const merged = MERGED_PAGES[pageId];
  if (merged) {
    pageId = merged.page;
    if (merged.kind)  caseworkKind  = merged.kind;
    if (merged.scope) caseworkScope = merged.scope;
    if (merged.pkind) pendingKind   = merged.pkind;
  }

  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const navBtn = document.querySelector(`.nav-item[data-page="${pageId}"]`);
  if (navBtn) navBtn.classList.add('active');
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const page = document.getElementById(`page-${pageId}`);
  if (page) page.classList.add('active');
  if (pageId === 'casework') applyCaseworkSelector();
  if (pageId === 'pending')  applyPendingSelector();

  const loaders = {
    dashboard:   loadDashboard,
    casework:    loadCasework,
    pending:     loadPending,
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
    records:         (typeof loadRecords === 'function' ? loadRecords : null),
    // Activity tracking is part of this page now — the same table, not a
    // second copy of it.
    'quota-check':   () => { if (typeof loadQuotaCheck === 'function') loadQuotaCheck(); },
    'ia-profiles':   (typeof loadIaProfiles === 'function' ? loadIaProfiles : null),
    'site-control':  loadSiteControl,
    'notif-settings': loadNotifSettings,
    'send-notif':    loadDevNotifSender,
    'emergency-alert': (typeof loadEmergencyAlert === 'function' ? loadEmergencyAlert : null),
    media:           (typeof loadMedia === 'function' ? loadMedia : null),
    'media-admin':   (typeof loadMediaAdmin === 'function' ? loadMediaAdmin : null),
    gamelogs:        loadDevGameLogs,
    cad:             (typeof loadCad === 'function' ? loadCad : null),
    'roblox-audio':  (typeof loadRobloxAudio === 'function' ? loadRobloxAudio : null),
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
  }).join('') : (window.metEmpty
    ? `<tr><td colspan="6">${window.metEmpty({ icon: 'ti-file-off', title: 'No game logs yet', sub: 'In-game activity will appear here.' })}</td></tr>`
    : '<tr><td colspan="6" class="table-empty"><div class="table-empty-text">No game logs yet.</div></td></tr>');
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
      if (x.ok === false) return `${lbl}: ${met.e('met_warn')} ${x.reason || 'failed'}`;
      return `${lbl}: +${x.synced != null ? x.synced : '?'}/${x.total != null ? x.total : '?'}${x.skipped ? ` (${x.skipped} skipped)` : ''}`;
    };
    if (out) out.innerHTML = failed
      ? `<span style="color:var(--amber,#e8842a);"><i class="ti ti-alert-triangle"></i> ${escapeHtml(fmt('Cases', r.cases))} · ${escapeHtml(fmt('Tickets', r.tickets))}</span>`
      : `<span style="color:var(--green);"><i class="ti ti-check"></i> Synced. ${escapeHtml(fmt('Cases', r.cases))} · ${escapeHtml(fmt('Tickets', r.tickets))}</span>`;
  } catch (e) {
    if (out) out.innerHTML = `<span style="color:var(--red);"><i class="ti ti-alert-triangle"></i> ${escapeHtml(e.message)}</span>`;
  } finally { if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-refresh"></i> Sync IA cases &amp; tickets'; } }
}

// ── Rebuilding the case archive from Discord ───────────────────────
//
// Two buttons, and the order between them is the whole design: the real import
// stays DISABLED until a dry run has been done. Reading a channel of unknown shape
// and writing a thousand cases from it, first try, with no idea what it parsed, is
// how somebody ends up with an archive full of nonsense and no way to tell which
// rows to trust.
const CLR_CHANNEL_KEY = 'met_caselog_channel';

function clrChannel() {
  const el = document.getElementById('clr-channel');
  return el ? String(el.value || '').replace(/\D/g, '') : '';
}

// Remember it: this is a nineteen-digit number nobody wants to find twice.
document.addEventListener('DOMContentLoaded', () => {
  const el = document.getElementById('clr-channel');
  if (!el) return;
  try { el.value = localStorage.getItem(CLR_CHANNEL_KEY) || ''; } catch (e) {}
  el.addEventListener('input', () => {
    try { localStorage.setItem(CLR_CHANNEL_KEY, clrChannel()); } catch (e) {}
    // Changing the channel invalidates the dry run that unlocked the import.
    const go = document.getElementById('clr-go-btn');
    if (go) { go.disabled = true; go.title = 'Do the dry run first'; }
  });
});

function clrRow(k, v, tone) {
  const colour = tone === 'good' ? 'var(--green)' : tone === 'warn' ? 'var(--amber)'
    : tone === 'bad' ? 'var(--red)' : 'var(--text-primary)';
  return `<div style="display:flex;gap:.6rem;padding:3px 0;font-size:12.5px;">
    <span style="color:var(--text-muted);min-width:190px;">${escapeHtml(k)}</span>
    <span style="color:${colour};font-weight:500;">${escapeHtml(String(v))}</span></div>`;
}

async function clrImport(dry) {
  const channelId = clrChannel();
  const out = document.getElementById('clr-result');
  if (!channelId) {
    if (out) out.innerHTML = `<span style="color:var(--amber);"><i class="ti ti-alert-triangle"></i> Put the channel id in first.</span>`;
    return;
  }
  if (!dry) {
    const yes = await uiConfirm(
      'This writes cases into the database from what it read in Discord.\n\n'
      + 'Cases you filed on the site are never overwritten, and running it again later is a refresh '
      + 'rather than a duplicate — but read the dry run above before you do this.',
      { title: 'Import the cases for real?', confirmText: 'Import them', cancelText: 'Not yet', icon: 'ti-database-import' });
    if (!yes) return;
  }

  const btn = document.getElementById(dry ? 'clr-dry-btn' : 'clr-go-btn');
  const label = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader-2"></i> Reading the channel…'; }
  if (out) {
    out.innerHTML = `<span style="color:var(--text-secondary);"><i class="ti ti-loader-2"></i> `
      + `Walking the channel back to its first message. On a long history this takes a few minutes.</span>`;
  }

  try {
    const r = await api('/api/dev/case-log-import', {
      method: 'POST', body: JSON.stringify({ channelId, dry }),
    });
    if (out) out.innerHTML = clrReport(r, dry);
    // Only a dry run that actually found something unlocks the real import.
    const go = document.getElementById('clr-go-btn');
    if (dry && go) {
      go.disabled = !(r.ok && r.parsed > 0);
      go.title = go.disabled ? 'The dry run found no cases in that channel' : '';
    }
  } catch (e) {
    if (out) out.innerHTML = `<span style="color:var(--red);"><i class="ti ti-alert-triangle"></i> ${escapeHtml(e.message)}</span>`;
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = label; }
  }
}

function clrReport(r, dry) {
  if (r.error) return `<span style="color:var(--red);"><i class="ti ti-alert-triangle"></i> ${escapeHtml(r.error)}</span>`;
  // The server says whether it wrote, and it is the one that knows. Trusting the
  // flag we sent instead would let the heading say "Imported" over a dry run.
  if (typeof r.dryRun === 'boolean') dry = r.dryRun;

  let h = `<div style="border:1px solid var(--border-dim);border-radius:var(--radius-md);padding:.9rem 1rem;">`;
  h += `<div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted);margin-bottom:.6rem;">`
     + (dry ? 'Dry run, nothing was written' : 'Imported') + `</div>`;

  h += clrRow('Messages read', r.scanned);
  // Whether it genuinely reached the beginning is the difference between "all the
  // cases" and "the recent ones".
  h += clrRow('Reached the start of the channel', r.reachedStart ? 'yes' : 'NO — it stopped early',
              r.reachedStart ? 'good' : 'warn');
  h += clrRow('Cases found', r.parsed, r.parsed ? 'good' : 'warn');
  h += clrRow('Distinct cases', r.uniqueCases);
  if (r.highestRef) h += clrRow('Highest reference', '#' + r.highestRef);
  if (r.oldest) h += clrRow('Oldest', new Date(r.oldest).toLocaleDateString());
  if (r.newest) h += clrRow('Newest', new Date(r.newest).toLocaleDateString());

  if (!dry) {
    h += clrRow('Created', r.created, r.created ? 'good' : null);
    h += clrRow('Updated', r.updated);
    h += clrRow('Already correct', r.unchanged);
    if (r.movedAside) {
      h += clrRow('Site cases moved to free a reference', r.movedAside, 'warn');
      h += `<div style="font-size:11.5px;color:var(--text-muted);margin:.2rem 0 .5rem;line-height:1.7;">`
        + (r.moves || []).map(m => `${escapeHtml(m.from)} → ${escapeHtml(m.to)}`).join(', ')
        + `. The Discord reference is the one people quote, so the case filed on the site moved instead. `
        + `It kept all of its own data.</div>`;
    }
    if (r.counter) h += clrRow('Case counter now at', r.counter.counter);
  }

  // The census. This is the part that answers "did it get everything".
  const formats = Object.entries(r.formats || {});
  if (formats.length) {
    h += `<div style="margin-top:.7rem;font-size:12px;color:var(--text-muted);letter-spacing:.05em;text-transform:uppercase;">Formats read</div>`;
    h += formats.sort((a, b) => b[1] - a[1])
      .map(([k, n]) => clrRow(k, n)).join('');
  }
  if (r.truncatedCases) {
    h += clrRow('Shortened by Discord when posted', r.truncatedCases, 'warn');
  }

  // And the part that answers "what did it MISS" — which is the only way to find a
  // format nobody has taught it yet.
  if ((r.unrecognised || []).length) {
    h += `<div style="margin-top:.8rem;padding:.7rem .85rem;border-radius:8px;background:rgba(245,183,48,.08);border:1px solid rgba(245,183,48,.3);">`
      + `<div style="font-size:12.5px;color:var(--amber);font-weight:600;margin-bottom:.4rem;">`
      + `${r.unrecognised.length} message${r.unrecognised.length === 1 ? '' : 's'} look like a case but could not be read</div>`
      + `<div style="font-size:11.5px;color:var(--text-secondary);line-height:1.7;margin-bottom:.5rem;">`
      + `These are old formats nothing here understands yet. Send them over and they can be added.</div>`
      + r.unrecognised.slice(0, 8).map(u =>
          `<div style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);padding:3px 0;border-top:1px solid var(--border-dim);">`
          + `${escapeHtml(new Date(u.at).toLocaleDateString())} · ${escapeHtml(u.text.slice(0, 180))}</div>`).join('')
      + `</div>`;
  } else if (r.scanned) {
    h += `<div style="margin-top:.7rem;font-size:12px;color:var(--green);">`
      + `<i class="ti ti-check"></i> Nothing case-like was left unread.</div>`;
  }

  if ((r.samples || []).length) {
    h += `<div style="margin-top:.8rem;font-size:12px;color:var(--text-muted);letter-spacing:.05em;text-transform:uppercase;">A few of them</div>`
      + r.samples.slice(0, 6).map(s =>
          `<div style="font-size:11.5px;color:var(--text-secondary);padding:3px 0;border-top:1px solid var(--border-dim);">`
          + `<span style="font-family:var(--font-mono);color:var(--blue);">${escapeHtml(s.caseRef)}</span> · `
          + `${escapeHtml(s.action)} · ${escapeHtml(s.reason)}</div>`).join('');
  }

  if ((r.errors || []).length) {
    h += `<div style="margin-top:.7rem;font-size:11.5px;color:var(--red);line-height:1.7;">`
      + r.errors.slice(0, 6).map(e => escapeHtml(e)).join('<br>') + `</div>`;
  }
  return h + `</div>`;
}

// Read-only. Run it before and after an import — it is how the archive is checked
// rather than assumed.
async function clrAudit() {
  const out = document.getElementById('clr-result');
  const btn = document.getElementById('clr-audit-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader-2"></i> Checking…'; }
  try {
    const a = await api('/api/dev/case-audit');
    let h = `<div style="border:1px solid var(--border-dim);border-radius:var(--radius-md);padding:.9rem 1rem;">`
      + `<div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted);margin-bottom:.6rem;">The archive as it stands</div>`;
    h += clrRow('Cases', a.total);
    h += clrRow('Where they came from', Object.entries(a.byOrigin || {}).map(([k, n]) => `${k} ${n}`).join(' · '));
    if (a.oldest) h += clrRow('Oldest', new Date(a.oldest).toLocaleDateString());
    if (a.newest) h += clrRow('Newest', new Date(a.newest).toLocaleDateString());
    h += clrRow('Highest reference', '#' + a.highestRef);
    h += clrRow('Counter', a.counter, a.counterBelowHighest ? 'bad' : 'good');
    if (a.counterBelowHighest) {
      h += `<div style="font-size:11.5px;color:var(--red);line-height:1.7;">The counter is BELOW the highest reference in use, so the next case filed would collide. Run an import, which raises it.</div>`;
    }
    h += clrRow('Duplicate references', a.duplicates.length, a.duplicates.length ? 'bad' : 'good');
    h += clrRow('Without a reference', a.unnumbered.length, a.unnumbered.length ? 'bad' : 'good');
    h += clrRow('Without a Discord log', a.withoutLogMessage);
    h += clrRow('Numbered out of sequence', a.outOfOrderCount, a.outOfOrderCount ? 'warn' : 'good');
    if (a.outOfOrderCount) {
      h += `<div style="font-size:11.5px;color:var(--text-muted);line-height:1.7;margin-top:.3rem;">`
        + `A reference lower than one that came before it. Normal where cases were filed out of order — `
        + `the reference is what people quote, so nothing is renumbered automatically.</div>`;
    }
    if (out) out.innerHTML = h + `</div>`;
  } catch (e) {
    if (out) out.innerHTML = `<span style="color:var(--red);"><i class="ti ti-alert-triangle"></i> ${escapeHtml(e.message)}</span>`;
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-list-check"></i> Check the archive'; }
  }
}

// ── Clans Labs XP import ──────────────────────────────────────────
//
// Same two-button shape as the case rebuild, and for the same reason: this writes
// a balance for a thousand accounts, and the dry run reports exactly the numbers
// the real one will. The real button stays locked until a dry run has been read.

async function cxpLook() {
  const out = document.getElementById('cxp-result');
  const btn = document.getElementById('cxp-look-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader-2"></i> Reading…'; }
  try {
    const r = await api('/api/dev/xp-import');
    let h = `<div style="border:1px solid var(--border-dim);border-radius:var(--radius-md);padding:.9rem 1rem;">`
      + `<div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted);margin-bottom:.6rem;">The file, unread by anything else</div>`;
    h += clrRow('Rows', r.rows);
    h += clrRow('Distinct accounts', r.accounts, r.accounts ? 'good' : 'warn');
    h += clrRow('Lines ignored', r.ignoredLines);
    h += clrRow('Capped at', r.cap + ' XP');
    if (r.pending) {
      h += clrRow('Held for accounts with no Discord id', r.pending.waiting,
                  r.pending.waiting ? 'warn' : 'good');
      h += clrRow('Already handed over', r.pending.claimed, r.pending.claimed ? 'good' : null);
    }
    // A run that is still going, or the last one's result.
    if (r.run) {
      h += clrRow('Last run', r.run.running
        ? (r.run.stage || 'running') + (r.run.total ? ` — ${r.run.done} of ${r.run.total}` : '')
        : new Date(r.run.finishedAt || r.run.startedAt).toLocaleString()
          + (r.run.dry ? ' (dry run)' : ''),
        r.run.error ? 'bad' : r.run.running ? 'warn' : 'good');
      if (r.run.error) h += clrRow('It failed with', r.run.error, 'bad');
    }
    if ((r.highest || []).length) {
      h += `<div style="margin-top:.8rem;font-size:12px;color:var(--text-muted);letter-spacing:.05em;text-transform:uppercase;">Top of the list</div>`
        + r.highest.map(function (s) {
            return `<div style="font-size:11.5px;color:var(--text-secondary);padding:3px 0;border-top:1px solid var(--border-dim);">`
              + `<span style="font-family:var(--font-mono);color:var(--blue);">${escapeHtml(s.username)}</span> · `
              + `${escapeHtml(String(s.xp))} → ${escapeHtml(String(Math.min(s.xp, r.cap)))}</div>`;
          }).join('');
    }
    if (out) out.innerHTML = h + `</div>`;
  } catch (e) {
    if (out) out.innerHTML = `<span style="color:var(--red);"><i class="ti ti-alert-triangle"></i> ${escapeHtml(e.message)}</span>`;
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-list-search"></i> What\'s in the file'; }
  }
}

async function cxpImport(dry) {
  const out = document.getElementById('cxp-result');
  if (!dry) {
    const yes = await uiConfirm(
      'This sets the XP of everyone on the leaderboard who can be matched to a Discord account, '
      + 'and holds the rest against their Roblox account.\n\n'
      + 'It only ever raises a balance, so nothing anybody earned here is lost — but read the dry run first.',
      { title: 'Sync the XP for real?', confirmText: 'Sync it', cancelText: 'Not yet', icon: 'ti-database-import' });
    if (!yes) return;
  }

  const btn = document.getElementById(dry ? 'cxp-dry-btn' : 'cxp-go-btn');
  const label = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader-2"></i> Running…'; }

  try {
    // The server starts it and answers straight away. It cannot answer with the
    // result: a thousand usernames is minutes of paced Roblox calls, and an edge
    // proxy would close the request long before then.
    await api('/api/dev/xp-import', { method: 'POST', body: JSON.stringify({ dry: dry }) });
    const r = await cxpPoll(out);
    if (!r) return;
    if (out) out.innerHTML = r.error
      ? `<span style="color:var(--red);"><i class="ti ti-alert-triangle"></i> ${escapeHtml(r.error)}</span>`
      : cxpReport(r.out || {});
    const go = document.getElementById('cxp-go-btn');
    if (dry && go && r.out) {
      go.disabled = !(r.out.ok && r.out.resolved > 0);
      go.title = go.disabled ? 'The dry run resolved nobody' : '';
    }
  } catch (e) {
    if (out) out.innerHTML = `<span style="color:var(--red);"><i class="ti ti-alert-triangle"></i> ${escapeHtml(e.message)}</span>`;
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = label; }
  }
}

// Watch a run to the end, showing what it is on. A bar that moves is the
// difference between "this is working" and "this has hung".
async function cxpPoll(out) {
  const started = Date.now();
  const LIMIT = 30 * 60 * 1000;   // a run that long has gone wrong
  while (Date.now() - started < LIMIT) {
    let s = null;
    try { s = await api('/api/dev/xp-import'); } catch (e) { /* a dropped poll is not a failure */ }
    const run = s && s.run;
    if (run) {
      if (!run.running) return run;
      if (out) {
        const pct = run.total ? Math.round((run.done / run.total) * 100) : 0;
        const mins = Math.floor((Date.now() - started) / 60000);
        out.innerHTML = `<div style="border:1px solid var(--border-dim);border-radius:var(--radius-md);padding:.9rem 1rem;">`
          + `<div style="font-size:13px;color:var(--text-secondary);margin-bottom:.5rem;">`
          + `<i class="ti ti-loader-2"></i> ${escapeHtml(run.stage || 'Working')}`
          + (run.total ? ` — ${run.done} of ${run.total}` : '') + `</div>`
          + `<div style="height:6px;border-radius:3px;background:var(--border-dim);overflow:hidden;">`
          + `<div style="height:100%;width:${pct}%;background:var(--blue);transition:width .4s;"></div></div>`
          + `<div style="font-size:11.5px;color:var(--text-muted);margin-top:.5rem;line-height:1.6;">`
          + `Roblox is asked in paced batches and rate-limits hard, so this takes a few minutes`
          + (mins ? ` (${mins} so far)` : '') + `. Leaving the page does not stop it.</div></div>`;
      }
    }
    await new Promise(function (r) { setTimeout(r, 3000); });
  }
  if (out) {
    out.innerHTML = `<span style="color:var(--amber);"><i class="ti ti-alert-triangle"></i> `
      + `Stopped watching after half an hour. The run may still be going — press `
      + `"What's in the file" to see where it got to.</span>`;
  }
  return null;
}

function cxpReport(r) {
  if (r.error) return `<span style="color:var(--red);"><i class="ti ti-alert-triangle"></i> ${escapeHtml(r.error)}</span>`;
  // The server is the one that knows whether it wrote.
  const dry = typeof r.dryRun === 'boolean' ? r.dryRun : true;

  let h = `<div style="border:1px solid var(--border-dim);border-radius:var(--radius-md);padding:.9rem 1rem;">`;
  h += `<div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted);margin-bottom:.6rem;">`
     + (dry ? 'Dry run, nothing was written' : 'Synced') + `</div>`;

  h += clrRow('Accounts on the leaderboard', r.accounts);
  h += clrRow('Resolved on Roblox', r.resolved, r.resolved ? 'good' : 'warn');
  // Kept apart from "not a Roblox account" on purpose: one means the row is junk,
  // the other means we never got to ask.
  if (r.unasked) h += clrRow('Rate-limited by Roblox, not looked at', r.unasked, 'warn');
  h += clrRow('Not a Roblox account', r.unknown, r.unknown ? 'warn' : 'good');
  h += clrRow('Over ' + r.cap + ', so capped', r.capped);
  h += clrRow(dry ? 'Would be set now' : 'Set now', r.set, r.set ? 'good' : null);
  if (!dry) {
    h += clrRow('Of those, actually raised', r.raised);
    h += clrRow('Already at least that high', r.unchanged);
  }
  h += clrRow(dry ? 'Would wait for a Discord account' : 'Waiting for a Discord account', r.pending);
  if (r.roverLookups) h += clrRow('RoVer lookups', r.roverLookups);
  if (r.failed) h += clrRow('Failed', r.failed, 'bad');

  if (r.unasked) {
    h += `<div style="margin-top:.8rem;padding:.7rem .85rem;border-radius:8px;background:rgba(245,183,48,.08);border:1px solid rgba(245,183,48,.3);">`
      + `<div style="font-size:12.5px;color:var(--amber);font-weight:600;margin-bottom:.4rem;">`
      + `${r.unasked} name${r.unasked === 1 ? '' : 's'} were rate-limited, so the run is not finished</div>`
      + `<div style="font-size:11.5px;color:var(--text-secondary);line-height:1.7;">`
      + `Roblox stopped answering. Those names were <strong>not</strong> looked at and nothing was `
      + `stored or ruled out for them. Run it again in a few minutes — everything already imported is `
      + `left exactly as it is.</div></div>`;
  } else if (!dry && r.resolved) {
    h += `<div style="margin-top:.7rem;font-size:12px;color:var(--green);">`
      + `<i class="ti ti-check"></i> The whole list was looked at.</div>`;
  }

  if ((r.unknownNames || []).length) {
    h += `<div style="margin-top:.8rem;padding:.7rem .85rem;border-radius:8px;background:rgba(245,183,48,.08);border:1px solid rgba(245,183,48,.3);">`
      + `<div style="font-size:12.5px;color:var(--amber);font-weight:600;margin-bottom:.4rem;">`
      + `${r.unknown} name${r.unknown === 1 ? '' : 's'} could not be resolved</div>`
      + `<div style="font-size:11.5px;color:var(--text-secondary);line-height:1.7;margin-bottom:.5rem;">`
      + `Mostly usernames the leaderboard cut short. Nothing was stored for them — a shortened name `
      + `belongs to a different account, or to nobody.</div>`
      + `<div style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);line-height:1.8;">`
      + r.unknownNames.map(function (n) { return escapeHtml(n); }).join(', ')
      + (r.unknown > r.unknownNames.length ? ', and ' + (r.unknown - r.unknownNames.length) + ' more' : '')
      + `</div></div>`;
  }

  if ((r.samples || []).length) {
    h += `<div style="margin-top:.8rem;font-size:12px;color:var(--text-muted);letter-spacing:.05em;text-transform:uppercase;">A few of them</div>`
      + r.samples.map(function (s) {
          return `<div style="font-size:11.5px;color:var(--text-secondary);padding:3px 0;border-top:1px solid var(--border-dim);">`
            + `<span style="font-family:var(--font-mono);color:var(--blue);">${escapeHtml(s.username)}</span> · `
            + `${escapeHtml(String(s.from))} → ${escapeHtml(String(s.xp))} XP · `
            + (s.to === 'discord' ? 'on their record' : 'held for later') + `</div>`;
        }).join('');
  }

  if ((r.notes || []).length) {
    h += `<div style="margin-top:.7rem;font-size:11.5px;color:var(--text-muted);line-height:1.7;">`
      + r.notes.map(function (n) { return escapeHtml(n); }).join('<br>') + `</div>`;
  }
  return h + `</div>`;
}

// The long tail: rows still waiting for a Discord id. Worth a press after a wave
// of people join.
async function cxpSweep() {
  const out = document.getElementById('cxp-result');
  const btn = document.getElementById('cxp-sweep-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader-2"></i> Retrying…'; }
  try {
    const r = await api('/api/dev/xp-claim-sweep', { method: 'POST', body: JSON.stringify({}) });
    let h = `<div style="border:1px solid var(--border-dim);border-radius:var(--radius-md);padding:.9rem 1rem;">`
      + `<div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted);margin-bottom:.6rem;">Retried the waiting rows</div>`;
    h += clrRow('Looked at', r.looked);
    h += clrRow('Usernames resolved for the first time', r.resolvedIds);
    h += clrRow('Handed over', r.claimed, r.claimed ? 'good' : null);
    h += clrRow('Of those, actually raised', r.raised);
    h += clrRow('Still waiting', r.stillWaiting);
    if (r.failed) h += clrRow('Failed', r.failed, 'bad');
    if (r.pending) h += clrRow('Left in the holding table', r.pending.waiting);
    if ((r.notes || []).length) {
      h += `<div style="margin-top:.7rem;font-size:11.5px;color:var(--text-muted);line-height:1.7;">`
        + r.notes.map(function (n) { return escapeHtml(n); }).join('<br>') + `</div>`;
    }
    if (out) out.innerHTML = h + `</div>`;
  } catch (e) {
    if (out) out.innerHTML = `<span style="color:var(--red);"><i class="ti ti-alert-triangle"></i> ${escapeHtml(e.message)}</span>`;
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-refresh"></i> Retry the waiting ones'; }
  }
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

  // Ticket logs are read-only records — a deep link just opens the log.
  if (ticketId) openTicketDetail(ticketId);
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
// Deep links must point at the IA dashboard: "/dashboard" is the MET profile
// page, which knows nothing about ?case= / ?ticket=.
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
  editingCaseRef = '';
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
  // Importing from the case link IS the normal way to file a case — the case
  // file is written elsewhere and pasted in, and the import reads the suspect,
  // the punishments and the exhibits straight out of it. Entering it by hand is
  // still a click away for the cases that need it.
  if (typeof setCaseMode === 'function') setCaseMode('import');
  renderActionChecklist();
}

window.openNewCaseModal = openNewCaseModal;
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
//   build  — write the case document here on the site (the normal path)
//   import — pull the details out of an existing (Google) doc link
//   manual — type everything in, paste your own link
function setCaseMode(mode) {
  document.querySelectorAll('#case-mode-tabs .filter-tab').forEach(t => {
    if (t.disabled) return;
    t.classList.toggle('active', !!mode && t.dataset.casemode === mode);
  });
  const imp    = document.getElementById('case-manual-import');
  const fields = document.getElementById('case-fields');
  const link   = document.getElementById('case-link-group');
  if (!mode) { // pick a method first — hide the panel and all fields
    if (imp)    imp.style.display    = 'none';
    if (fields) fields.style.display = 'none';
    return;
  }
  if (imp)    imp.style.display    = mode === 'import' ? '' : 'none';
  if (fields) fields.style.display = '';
  // The case link is where the case file lives, either way.
  if (link)   link.style.display   = '';
  // Import mode greys the manual fields until a doc import fills them; the other
  // modes leave them immediately editable.
  setCaseFieldsEnabled(mode !== 'import');
}
function setCaseFieldsEnabled(enabled) {
  const box = document.getElementById('case-fields'); if (!box) return;
  box.style.opacity      = enabled ? '' : '0.5';
  box.style.pointerEvents = enabled ? '' : 'none';
  box.querySelectorAll('input, textarea, select, button').forEach(el => { el.disabled = !enabled; });
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
  editingCaseRef = c.caseRef || '';
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
    if (!cb) return; // an action this checklist does not offer — surfaced in notes
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
      // Every exhibit the case file lists, so the case panel can show them as
      // named links instead of making somebody open the document to find them.
      evidence:                    Array.isArray(d.evidence) ? d.evidence : [],
    };

    if (resEl) {
      resEl.style.display = '';
      resEl.style.color   = 'var(--green)';
      resEl.innerHTML = '<i class="ti ti-check"></i> Imported <strong>' + escapeHtml(sus.robloxUsername || sus.discordUsername || sus.discordId || 'suspect') + '</strong>'
        + (sus.groupRole ? ' · ' + escapeHtml(sus.groupRole) : '')
        + (d.punishments?.length ? ' · ' + d.punishments.map(p => escapeHtml(p.action)).join(', ') : '')
        + (d.evidence?.length ? ' · ' + d.evidence.length + ' exhibit' + (d.evidence.length === 1 ? '' : 's') : '')
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
    const hasRole     = !!a.hasRole;
    const isBlacklist = a.name === 'Blacklist';

    let badge = '';
    if (isExile)     badge = `<span class="ac-badge ac-exile"><i class="ti ti-bolt"></i> ${isBlacklist ? 'EXILE + ROLE' : 'EXILE'}</span>`;
    else if (hasRole) badge = `<span class="ac-badge ac-role">AUTO-ROLE</span>`;
    else              badge = `<span class="ac-badge ac-norole">NO ROLE</span>`;

    const onRecordBadge = onRecord
      ? `<span class="ac-badge ac-onrecord"><i class="ti ti-alert-triangle"></i> on record</span>` : '';
    const suggestedBadge = isSuggested
      ? `<span class="ac-badge ac-suggested"><i class="ti ti-star"></i> Recommended</span>` : '';

    // Duration only shown when the checkbox is checked; hidden otherwise — and
    // only offered at all for a punishment that actually carries one. Gating
    // this on "has a role" let a Blacklist be given fourteen days.
    const durationSelect = a.timed ? `
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

// ── Filters + search ──────────────────────────────────────────────
// Every case list has the same pair of controls: a status filter and a search
// box. This wires them all the same way so they behave identically.
function setupFilterTabs() {
  const tabs = (selector, attr, apply) => {
    document.querySelectorAll(`${selector} .filter-tab`).forEach(tab =>
      tab.addEventListener('click', () => {
        document.querySelectorAll(`${selector} .filter-tab`).forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        apply(tab.dataset[attr]);
      })
    );
  };
  tabs('#dash-filter-tabs',   'filter',   v => { dashFilter    = v; renderDashTable(); });
  tabs('#all-filter-tabs',    'filter',   v => { allPageFilter = v; renderAllCasesTable(); });
  tabs('#my-filter-tabs',     'myfilter', v => { myFilter      = v; renderMyCasesTable(); });
  tabs('#review-filter-tabs', 'rfilter',  v => { reviewFilter  = v; renderReviewTable(); });

  const search = (id, apply) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => apply(el.value.trim()));
    // Escape clears the box — the fastest way back to the full list.
    el.addEventListener('keydown', e => {
      if (e.key === 'Escape') { el.value = ''; apply(''); }
    });
  };
  search('dash-search',      q => { dashQuery   = q; renderDashTable(); });
  search('my-cases-search',  q => { myQuery     = q; renderMyCasesTable(); });
  search('all-cases-search', q => { allQuery    = q; renderAllCasesTable(); });
  search('review-search',    q => { reviewQuery = q; renderReviewTable(); });
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
  if (!caseLink) { showToast('A case link is required.', 'error'); return; }

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
    editingCaseId = null; editingCaseRef = ''; editingCaseApproved = false; caseDraftActive = false;
    showToast(repost ? 'Case updated — log updated.' : 'Case updated.', 'success');
    await loadDashboard(); loadAllCases(); loadReview();
  } catch (err) {
    showToast(err.message || 'Failed to save changes.', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-device-floppy"></i> Save Changes'; }
  }
}

// ── Dashboard ─────────────────────────────────────────────────────
async function loadDashboard() {
  if (typeof DivQuota !== 'undefined') DivQuota.loadMyQuota('IA', 'dq-IA-mine');
  await Promise.all([loadStats(), loadDashCases(), loadDashTickets(), loadQuotaHero()]);
  renderAttention();
}

// ── Weekly quota hero ─────────────────────────────────────────────
// The weekly target depends on rank (30 Low Command / 20 Middle Command,
// High Command and LOA exempt). It's the number people actually care about, so
// it gets the top of the page rather than a panel halfway down.
async function loadQuotaHero() {
  const hero = document.getElementById('quota-hero');
  if (!hero) return;
  try {
    const d = await api('/api/me/points');
    if (!d || !d.configured || !d.found) { hero.style.display = 'none'; return; }
    hero.style.display = '';

    const q      = d.quota || {};
    // No target for an unrecognised rank — show the raw total rather than
    // inventing a number to measure them against.
    const target = q.target != null ? q.target : null;
    const total  = d.total || 0;
    const met    = q.exempt || (target != null && total >= target);
    const pct    = q.exempt || target == null ? 100 : Math.min(100, Math.round((total / Math.max(1, target)) * 100));

    document.getElementById('quota-hero-points').textContent = q.exempt ? 'EX' : total;
    document.getElementById('quota-hero-target').textContent = (q.exempt || target == null) ? '' : ` / ${target} pts`;
    document.getElementById('quota-hero-sub').innerHTML = q.exempt
      ? `${escapeHtml(d.rank || 'High Command')} — exempt from the weekly quota.`
      : `${escapeHtml(d.rank || 'Internal Affairs')}${q.tier ? ' · ' + escapeHtml(q.tier) : ''}`
        + (target == null ? ''
            : met
              ? ' · <strong style="color:var(--green);">Quota met</strong>'
              : ` · <strong style="color:var(--amber);">${Math.max(0, target - total)} points to go</strong>`);

    const fill = document.getElementById('quota-hero-fill');
    fill.style.width = pct + '%';
    fill.style.background = met ? 'var(--green)' : 'var(--amber)';
    hero.classList.toggle('quota-met', met);

    const order = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    document.getElementById('quota-hero-days').innerHTML = order.map(day => {
      const v = d.days[day];
      const has = typeof v === 'number' ? v > 0 : !!v;
      return `<div class="quota-day${has ? ' quota-day-on' : ''}">
        <span class="quota-day-name">${day}</span>
        <span class="quota-day-val">${escapeHtml(String(v))}</span>
      </div>`;
    }).join('');
  } catch (err) { hero.style.display = 'none'; }
}

// ── "Needs your attention" ────────────────────────────────────────
// One place that answers "what do I actually have to do?" — cases sent back to
// you, and (for reviewers) the queue waiting on a decision.
let attentionState = { changes: [], pending: 0 };

function renderAttention() {
  const panel = document.getElementById('attention-panel');
  const box   = document.getElementById('attention-items');
  if (!panel || !box) return;

  const items = [];
  attentionState.changes.forEach(c => {
    items.push(`<button class="attention-item" onclick="openDetail('${c.id}')">
      <i class="ti ti-edit-circle" style="color:var(--amber);"></i>
      <span><strong>${escapeHtml(c.caseRef)}</strong> needs changes — ${escapeHtml((c.reviewNote || '').slice(0, 90))}</span>
      <i class="ti ti-chevron-right"></i>
    </button>`);
  });
  if (attentionState.pending > 0 && ['HICOMM', 'SUPERVISOR', 'DEVELOPER'].includes(currentUser?.role)) {
    items.push(`<button class="attention-item" onclick="navigateTo('review')">
      <i class="ti ti-clipboard-check" style="color:var(--blue);"></i>
      <span><strong>${attentionState.pending}</strong> case${attentionState.pending === 1 ? '' : 's'} waiting on a decision</span>
      <i class="ti ti-chevron-right"></i>
    </button>`);
  }

  if (!items.length) { panel.style.display = 'none'; return; }
  panel.style.display = '';
  box.innerHTML = items.join('');
}

async function loadStats() {
  try {
    const [stats, mine, tickets] = await Promise.all([
      api('/api/cases/stats'),
      api('/api/cases/stats?scope=mine'),
      api('/api/tickets/stats').catch(() => null),
    ]);
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };

    // The overview cards are the signed-in investigator's OWN figures. They
    // used to show the whole of Internal Affairs, so "Total Cases" was the
    // department's total sitting under somebody's personal dashboard — which
    // reads as theirs and is not.
    const own = mine || stats;
    if (own) {
      set('stat-total',      own.total);
      set('stat-pending',    own.pending);
      set('stat-approved',   own.approved);
      set('stat-denied',     own.denied);
      set('stat-overturned', own.overturned || 0);
    }

    // The BADGES stay department-wide: they are the review queue, which is
    // everybody's, and a supervisor needs to see all of it.
    if (stats) {
      for (const id of ['nav-badge-review', 'pending-cases-badge']) {
        const badge = document.getElementById(id);
        if (badge) { badge.textContent = stats.pending; badge.style.display = stats.pending > 0 ? '' : 'none'; }
      }
      attentionState.pending = stats.pending || 0;
    }
    if (mine) {
      const myBadge = document.getElementById('nav-badge-my');
      if (myBadge) {
        myBadge.textContent = mine.changesRequested || 0;
        myBadge.style.display = (mine.changesRequested || 0) > 0 ? '' : 'none';
      }
    }
    if (tickets) {
      set('stat-tickets-week', tickets.mineWeek || 0);
      // How many ticket logs are still waiting on a supervisor — shown on the
      // All Tickets "Pending" tab and the nav, so the sign-off queue is visible
      // without having to go looking for it.
      const waiting = tickets.pending || 0;
      for (const id of ['all-tickets-pending-badge', 'nav-badge-tickets', 'casework-ticket-badge', 'pending-tickets-badge']) {
        const b = document.getElementById(id);
        if (b) { b.textContent = waiting; b.style.display = waiting > 0 ? '' : 'none'; }
      }
    }
  } catch (err) { console.error('Stats error:', err); }
}

// ── Case search + filter helpers ──────────────────────────────────
// One matcher shared by every case list, so search behaves identically on the
// dashboard, My Cases, All Cases and the review queue.
function caseMatches(c, q) {
  if (!q) return true;
  const hay = [
    c.caseRef, c.action, c.reason, c.notes, c.robloxUsername, c.robloxUserId,
    c.officerDiscordId, c.suspectRobloxDisplayName, c.investigatorRobloxUsername,
    c.investigatorDiscordUsername, c.punishmentsSummary, c.appealedByName, c.reviewNote,
    c.user && (c.user.displayName || c.user.discordUsername),
  ].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q.toLowerCase());
}

function filterCases(list, status, q) {
  return (list || [])
    .filter(c => status === 'all' || c.status === status)
    .filter(c => caseMatches(c, q));
}

let dashQuery = '', myQuery = '', myFilter = 'all', allQuery = '', reviewQuery = '', reviewFilter = 'all';

async function loadDashCases() {
  const tbody = document.getElementById('dash-cases-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="6" class="table-loading"><div class="spinner"></div></td></tr>';
  try {
    const cases = await api('/api/cases/my');
    allCasesCache = cases || [];
    attentionState.changes = allCasesCache.filter(caseAwaitingChanges);
    renderDashTable();
    renderAttention();
  } catch {
    tbody.innerHTML = `<tr><td colspan="6" class="table-empty"><span class="table-empty-text">Failed to load cases.</span></td></tr>`;
  }
}

function renderDashTable() {
  const tbody = document.getElementById('dash-cases-tbody');
  if (!tbody) return;
  const isElevated = ['HICOMM', 'SUPERVISOR', 'DEVELOPER'].includes(currentUser?.role);
  const filtered   = filterCases(allCasesCache, dashFilter, dashQuery).slice(0, 25);
  if (!filtered.length) { tbody.innerHTML = emptyRow(isElevated ? 6 : 5, dashQuery ? 'No cases match that search.' : 'No cases yet — press “Submit Case” to file one.'); return; }
  tbody.innerHTML = filtered.map(c => `
    <tr onclick="openDetail('${c.id}')" class="${caseRowClass(c)}">
      <td><span class="case-ref">${escapeHtml(c.caseRef)}</span></td>
      <td>${actionBadges(cleanAction(c.action))}</td>
      <td><span class="case-reason-cell">${escapeHtml(c.reason)}</span></td>
      <td>${statusBadge(c.status)} ${originBadge(c)} ${changesBadge(c)}</td>
      <td><span class="date-cell">${formatDate(c.createdAt)}</span></td>
      ${isElevated ? `<td onclick="event.stopPropagation();">${c.status === 'PENDING' ? rowActions(c) : ''}</td>` : ''}
    </tr>`).join('');
}

// Row highlight: amber for "needs your changes", blue for "submitter updated it".
function caseRowClass(c) {
  if (caseAwaitingChanges(c)) return 'row-changes';
  if (caseWasUpdated(c))      return 'row-updated';
  return '';
}

// ── Tickets I closed (dashboard preview) ──────────────────────────
let dashTicketsCache = [];

async function loadDashTickets() {
  const tbody = document.getElementById('dash-tickets-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="5" class="table-loading"><div class="spinner"></div></td></tr>';
  try {
    dashTicketsCache = (await api('/api/tickets?take=8')) || [];
    renderDashTickets();
  } catch {
    tbody.innerHTML = '<tr><td colspan="5" class="table-empty"><span class="table-empty-text">Failed to load ticket logs.</span></td></tr>';
  }
}

function renderDashTickets() {
  const tbody = document.getElementById('dash-tickets-tbody');
  if (!tbody) return;
  const rows = dashTicketsCache.slice(0, 8);
  if (!rows.length) {
    tbody.innerHTML = emptyRow(5, 'No tickets closed by you yet — they appear here automatically.');
    return;
  }
  const TLmap = (typeof TL !== 'undefined') ? TL : {};
  const TCmap = (typeof TC !== 'undefined') ? TC : {};
  tbody.innerHTML = rows.map(t => {
    const c = TCmap[t.ticketType] || 'blue';
    const l = TLmap[t.ticketType] || t.ticketType;
    return `<tr onclick="openTicketDetail('${t.id}')">
      <td><span class="case-ref">${escapeHtml(t.ticketRef || t.ticketName || '—')}</span></td>
      <td><span style="font-size:12px;font-weight:500;">${escapeHtml(t.creatorRobloxUsername || t.creatorUsername || '—')}</span></td>
      <td><span class="badge badge-${c}"><span class="badge-dot"></span>${escapeHtml(l)}</span></td>
      <td><span class="case-reason-cell">${escapeHtml(t.reason || '—')}</span></td>
      <td><span class="date-cell">${formatDate(t.closedAt)}</span></td>
    </tr>`;
  }).join('');
}

// ── My Cases ──────────────────────────────────────────────────────
async function loadMyCases() {
  const tbody = document.getElementById('my-cases-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="6" class="table-loading"><div class="spinner"></div></td></tr>';
  try {
    allCasesCache = (await api('/api/cases/my')) || [];
    renderMyCasesTable();
  } catch { tbody.innerHTML = emptyRow(6, 'Failed to load cases.'); }
}

function renderMyCasesTable() {
  const tbody = document.getElementById('my-cases-tbody');
  if (!tbody) return;
  const rows = filterCases(allCasesCache, myFilter, myQuery);
  const count = document.getElementById('my-cases-count');
  if (count) count.textContent = `${rows.length} of ${allCasesCache.length} shown`;
  if (!rows.length) {
    tbody.innerHTML = emptyRow(6, allCasesCache.length ? 'No cases match that search.' : 'No cases submitted yet.');
    return;
  }
  tbody.innerHTML = rows.map(c => `
    <tr onclick="openDetail('${c.id}')" class="${caseRowClass(c)}">
      <td><span class="case-ref">${escapeHtml(c.caseRef)}</span></td>
      <td>${officerCell(c)}</td>
      <td>${actionBadges(cleanAction(c.action))}</td>
      <td><span class="case-reason-cell">${escapeHtml(c.reason)}</span></td>
      <td>${statusBadge(c.status)} ${originBadge(c)} ${changesBadge(c)}</td>
      <td><span class="date-cell">${formatDate(c.createdAt)}</span></td>
    </tr>`).join('');
}

// ── Review Queue ──────────────────────────────────────────────────
async function loadReview() {
  const tbody = document.getElementById('review-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="8" class="table-loading"><div class="spinner"></div></td></tr>';
  try {
    allCasesCache = (await api('/api/cases/all?status=PENDING')) || [];
    renderReviewTable();
  } catch { tbody.innerHTML = emptyRow(8, 'Failed to load cases.'); }
}

function renderReviewTable() {
  const tbody = document.getElementById('review-tbody');
  const label = document.getElementById('pending-count-label');
  if (!tbody) return;

  let rows = allCasesCache.filter(c => caseMatches(c, reviewQuery));
  if (reviewFilter === 'changes')      rows = rows.filter(caseAwaitingChanges);
  else if (reviewFilter === 'updated') rows = rows.filter(caseWasUpdated);
  else if (reviewFilter === 'new')     rows = rows.filter(c => !caseAwaitingChanges(c) && !caseWasUpdated(c));

  if (label) label.textContent = `${rows.length} of ${allCasesCache.length} awaiting decision`;
  if (!rows.length) {
    tbody.innerHTML = emptyRow(8, allCasesCache.length ? 'Nothing matches that filter.' : 'No pending cases — all caught up.');
    return;
  }
  tbody.innerHTML = rows.map(c => {
    const rev = lastRevision(c);
    return `
      <tr onclick="openDetail('${c.id}')" style="cursor:pointer;" class="${caseRowClass(c)}">
        <td><span class="case-ref">${escapeHtml(c.caseRef)}</span>${
          originBadge(c) ? '<br>' + originBadge(c) : ''}${changesBadge(c) ? '<br>' + changesBadge(c) : ''}</td>
        <td>${caseInvestigatorCell(c)}</td>
        <td>${officerCell(c)}</td>
        <td>${actionBadges(cleanAction(c.action))}</td>
        <td><span class="case-reason-cell">${escapeHtml(c.reason)}</span>${
          caseWasUpdated(c) && rev
            ? `<div class="row-diff-hint" title="${escapeHtml(rev.changes.map(x => x.label + ': ' + x.before + ' → ' + x.after).join(' · '))}">
                 <i class="ti ti-git-compare"></i> ${escapeHtml(rev.changes.map(x => x.label).join(', '))} updated
               </div>` : ''}</td>
        <td><span class="case-notes-cell">${escapeHtml(c.notes)}</span></td>
        <td><span class="date-cell">${formatDateTime(c.createdAt)}</span></td>
        <td onclick="event.stopPropagation();">${rowActions(c)}</td>
      </tr>`;
  }).join('');
}

// ── All Cases ─────────────────────────────────────────────────────
async function loadAllCases() {
  const tbody = document.getElementById('all-cases-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="7" class="table-loading"><div class="spinner"></div></td></tr>';
  try {
    allCasesCache = (await api('/api/cases/all')) || [];
    renderAllCasesTable();
  } catch { tbody.innerHTML = emptyRow(7, 'Failed to load cases.'); }
}

function renderAllCasesTable() {
  const tbody = document.getElementById('all-cases-tbody');
  if (!tbody) return;
  const isElevated = ['HICOMM', 'SUPERVISOR', 'DEVELOPER'].includes(currentUser?.role);
  const cols = isElevated ? 8 : 7;
  const rows = filterCases(allCasesCache, allPageFilter, allQuery);
  const count = document.getElementById('all-cases-count');
  if (count) count.textContent = `${rows.length} of ${allCasesCache.length} shown`;
  if (!rows.length) {
    tbody.innerHTML = emptyRow(cols, allCasesCache.length ? 'No cases match that search.' : 'No cases found.');
    return;
  }
  tbody.innerHTML = rows.map(c => `
    <tr onclick="openDetail('${c.id}')" class="${caseRowClass(c)}">
      <td><span class="case-ref">${escapeHtml(c.caseRef)}</span></td>
      <td>${caseInvestigatorCell(c)}</td>
      <td>${officerCell(c)}</td>
      <td>${actionBadges(cleanAction(c.action))}</td>
      <td><span class="case-reason-cell">${escapeHtml(c.reason)}</span></td>
      <td>${statusBadge(c.status)} ${originBadge(c)} ${changesBadge(c)}</td>
      <td><span class="date-cell">${formatDate(c.createdAt)}</span></td>
      ${isElevated ? `<td onclick="event.stopPropagation();">${c.status === 'PENDING'
          ? reviewElsewhereChip(`goReviewCase('${c.id}')`)
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
    if (!actions?.length) {
      tbody.innerHTML = window.metEmpty
        ? `<tr><td colspan="5">${window.metEmpty({ icon: 'ti-list-details', title: 'No audit entries yet', sub: 'Case actions will be recorded here.' })}</td></tr>`
        : emptyRow(5, 'No audit entries yet.');
      return;
    }
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
    if (!grants?.length) {
      tbody.innerHTML = window.metEmpty
        ? `<tr><td colspan="5">${window.metEmpty({ icon: 'ti-users', title: 'No authorised users yet', sub: 'Grant access using the form above.' })}</td></tr>`
        : emptyRow(5, 'No authorised users yet.');
      return;
    }
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

// The MET umbrella group's rank ladder (for the MET-rank override dropdown),
// fetched once and cached for the session.
let _metRolesCache = null;
async function metRolesOnce() {
  if (_metRolesCache) return _metRolesCache;
  try { _metRolesCache = await api('/api/admin/met-roles'); } catch (e) { _metRolesCache = []; }
  return _metRolesCache || [];
}
// ── Custom site-UI dropdowns for the admin user row ──────────────────
// Two developer controls, styled to the site (not native <select>s):
//   1. Panels — a multi-select of every divisional panel (+ each division's
//      HICOMM, IA Supervisor, and MET High Command). Additive: the panels a
//      user already has via group rank are shown "(default)" and locked on;
//      ticking extras GRANTS that access site-wide.
//   2. MET rank — a single-select of every MET rank; their natural (group)
//      rank is marked "(default)" and pre-selected when no override is set.

// The panel catalogue (order + labels). token → { label, div, lead }
const PANEL_CATALOG = [
  { token: 'MET',            label: 'MET High Command',    group: 'MET' },
  { token: 'CID',            label: 'CID',                 group: 'CID' },
  { token: 'CID:LEAD',       label: 'CID High Command',    group: 'CID' },
  { token: 'SCO19',          label: 'SCO-19',              group: 'SCO19' },
  { token: 'SCO19:LEAD',     label: 'SCO-19 High Command', group: 'SCO19' },
  { token: 'IA',             label: 'Internal Affairs',    group: 'IA' },
  { token: 'IA:SUPERVISOR',  label: 'IA Supervisor',       group: 'IA' },
  { token: 'IA:LEAD',        label: 'IA High Command',     group: 'IA' },
  { token: 'FLP',            label: 'Frontline Policing',  group: 'FLP' },
  { token: 'FLP:LEAD',       label: 'FLP High Command',    group: 'FLP' },
  { token: 'HPC',            label: 'Hendon Police College',group: 'HPC' },
  { token: 'HPC:LEAD',       label: 'HPC High Command',    group: 'HPC' },
];
const PANEL_COLORS = { MET: '#4a8fff', CID: '#e8842a', SCO19: '#4b5563', IA: '#c2701f', FLP: '#5cc0ff', HPC: '#e8eef7' };

// Which tokens a user holds NATURALLY (from group rank) — from their cached
// divisions, excluding developer-granted entries.
function naturalPanelTokens(u) {
  const set = new Set();
  const divs = Array.isArray(u.divisions) ? u.divisions.filter(d => d && !d.granted) : [];
  if (divs.some(d => d.metHicomm)) set.add('MET');
  for (const d of divs) {
    if (!d.division) continue;
    if (d.division === 'MET') { set.add('MET'); continue; }
    set.add(d.division);                              // member-level
    if (d.tier === 'LEAD') set.add(d.division + ':LEAD'); // + HICOMM tier
  }
  return set;
}
function grantedPanelTokens(u) {
  return new Set(Array.isArray(u.panelGrant) ? u.panelGrant.map(String) : []);
}

function panelsDropdownTrigger(u) {
  const nat = naturalPanelTokens(u), grant = grantedPanelTokens(u);
  const active = PANEL_CATALOG.filter(p => nat.has(p.token) || grant.has(p.token));
  const chips = active.length
    ? active.slice(0, 4).map(p => `<span class="met-cd-chip" style="--c:${PANEL_COLORS[p.group] || '#8b93a1'}">${escapeHtml(p.label)}</span>`).join('')
      + (active.length > 4 ? `<span class="met-cd-chip more">+${active.length - 4}</span>` : '')
    : '<span style="color:var(--text-muted);font-size:11px;">No panels</span>';
  return `<button type="button" class="met-cd-trigger" title="Panel access" onclick="openPanelsDropdown('${u.id}',event)">
    <span class="met-cd-chips">${chips}</span><i class="ti ti-chevron-down met-cd-caret"></i></button>`;
}
function metRankDropdownTrigger(u, metRoles) {
  const override = u.metRankOverride && u.metRankOverride.name;
  const natural  = u.metRankNatural && u.metRankNatural.name;
  const label = override || natural || 'No MET rank';
  const tag = override ? '<span class="met-cd-tag over">override</span>' : (natural ? '<span class="met-cd-tag def">default</span>' : '');
  return `<button type="button" class="met-cd-trigger" title="Site-only MET rank" onclick="openMetRankDropdown('${u.id}',event)">
    <span class="met-cd-rank">${escapeHtml(label)}</span>${tag}<i class="ti ti-chevron-down met-cd-caret"></i></button>`;
}

// ── Shared popover host (body-appended so the table never clips it) ──
let _metCdOutside = null;
function closeMetCd() {
  const p = document.getElementById('met-cd-pop'); if (p) p.remove();
  if (_metCdOutside) { document.removeEventListener('mousedown', _metCdOutside, true); document.removeEventListener('keydown', _metCdEsc, true); _metCdOutside = null; }
}
function _metCdEsc(e) { if (e.key === 'Escape') closeMetCd(); }
function openMetCd(anchorEl, innerHtml, onMount) {
  closeMetCd();
  const pop = document.createElement('div');
  pop.id = 'met-cd-pop'; pop.className = 'met-cd-pop glass';
  pop.innerHTML = innerHtml;
  document.body.appendChild(pop);
  const r = anchorEl.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  let left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6); // flip up
  pop.style.left = left + 'px'; pop.style.top = top + 'px';
  _metCdOutside = (e) => { if (!pop.contains(e.target)) closeMetCd(); };
  setTimeout(() => { document.addEventListener('mousedown', _metCdOutside, true); document.addEventListener('keydown', _metCdEsc, true); }, 0);
  if (onMount) onMount(pop);
}

// ── Panels multi-select popover ─────────────────────────────────────
window.openPanelsDropdown = function (userId, ev) {
  if (ev) ev.stopPropagation();
  const u = (window._adminUsers || {})[userId]; if (!u) return;
  const anchor = ev && ev.currentTarget ? ev.currentTarget : ev.target.closest('.met-cd-trigger');
  const nat = naturalPanelTokens(u), grant = grantedPanelTokens(u);
  let rowsHtml = '';
  let lastGroup = null;
  for (const p of PANEL_CATALOG) {
    if (p.group !== lastGroup) { lastGroup = p.group; }
    const isDefault = nat.has(p.token);
    const checked = isDefault || grant.has(p.token);
    const c = PANEL_COLORS[p.group] || '#8b93a1';
    rowsHtml += `<label class="met-cd-opt ${isDefault ? 'is-default' : ''}">
      <input type="checkbox" data-token="${p.token}" ${checked ? 'checked' : ''} ${isDefault ? 'disabled' : ''}>
      <span class="met-cd-dot" style="background:${c}"></span>
      <span class="met-cd-lbl">${escapeHtml(p.label)}</span>
      ${isDefault ? '<span class="met-cd-def">(default)</span>' : ''}
    </label>`;
  }
  const html = `<div class="met-cd-head">Panel access<span class="met-cd-sub">${escapeHtml(u.displayName || u.discordUsername)}</span></div>
    <div class="met-cd-note">Defaults come from their ranks and stay on. Tick extras to grant access.</div>
    <div class="met-cd-list">${rowsHtml}</div>
    <div class="met-cd-foot">
      <button type="button" class="btn btn-secondary btn-sm" onclick="closeMetCd()">Cancel</button>
      <button type="button" class="btn btn-primary btn-sm" onclick="savePanelGrants('${u.id}')"><i class="ti ti-check"></i> Save</button>
    </div>`;
  openMetCd(anchor, html);
};
window.savePanelGrants = async function (userId) {
  const pop = document.getElementById('met-cd-pop'); if (!pop) return;
  // Save only the NON-default ticked tokens (defaults are effective anyway).
  const grants = [].slice.call(pop.querySelectorAll('input[type="checkbox"][data-token]'))
    .filter(cb => cb.checked && !cb.disabled).map(cb => cb.getAttribute('data-token'));
  try {
    const r = await api(`/api/admin/users/${userId}/panels`, { method: 'PATCH', body: JSON.stringify({ grants }) });
    const u = (window._adminUsers || {})[userId]; if (u) u.panelGrant = r.panelGrant || null;
    // Refresh just this row's trigger.
    const btn = document.querySelector(`.met-cd-trigger[onclick*="openPanelsDropdown('${userId}'"]`);
    if (btn && u) btn.outerHTML = panelsDropdownTrigger(u);
    closeMetCd();
    showToast(grants.length ? 'Panel access granted (applies on their next request)' : 'Extra panel grants cleared', 'success');
  } catch (e) { showToast(e.message || 'Failed to save panels', 'error'); }
};

// ── MET rank single-select popover ──────────────────────────────────
window.openMetRankDropdown = async function (userId, ev) {
  if (ev) ev.stopPropagation();
  const u = (window._adminUsers || {})[userId]; if (!u) return;
  const anchor = ev && ev.currentTarget ? ev.currentTarget : ev.target.closest('.met-cd-trigger');
  const metRoles = await metRolesOnce();
  const curRank = u.metRankOverride ? Number(u.metRankOverride.rank) : null;
  const natRank = u.metRankNatural ? Number(u.metRankNatural.rank) : null;
  const selRank = curRank != null ? curRank : natRank;   // default-select the natural rank
  let opts = `<label class="met-cd-opt"><input type="radio" name="metrank" value="" ${selRank == null ? 'checked' : ''}><span class="met-cd-lbl" style="color:var(--text-muted);">— No MET rank —</span></label>`;
  opts += (metRoles || []).map(r => {
    const isDef = natRank != null && Number(r.rank) === natRank;
    return `<label class="met-cd-opt ${isDef ? 'is-default' : ''}"><input type="radio" name="metrank" value="${r.rank}" ${Number(r.rank) === selRank ? 'checked' : ''}>
      <span class="met-cd-lbl">${escapeHtml(r.name)}</span>${isDef ? '<span class="met-cd-def">(default)</span>' : ''}</label>`;
  }).join('');
  const html = `<div class="met-cd-head">MET rank<span class="met-cd-sub">${escapeHtml(u.displayName || u.discordUsername)}</span></div>
    <div class="met-cd-note">Site-only. Deputy Commissioner+ grants MET High Command everywhere. Picking their (default) clears the override.</div>
    <div class="met-cd-list">${opts}</div>
    <div class="met-cd-foot">
      <button type="button" class="btn btn-secondary btn-sm" onclick="closeMetCd()">Cancel</button>
      <button type="button" class="btn btn-primary btn-sm" onclick="saveMetRank('${u.id}')"><i class="ti ti-check"></i> Save</button>
    </div>`;
  openMetCd(anchor, html);
};
window.saveMetRank = async function (userId) {
  const pop = document.getElementById('met-cd-pop'); if (!pop) return;
  const u = (window._adminUsers || {})[userId]; if (!u) return;
  const picked = pop.querySelector('input[name="metrank"]:checked');
  const rankVal = picked ? picked.value : '';
  const natRank = u.metRankNatural ? Number(u.metRankNatural.rank) : null;
  let body;
  if (!rankVal || (natRank != null && Number(rankVal) === natRank)) {
    body = { clear: true };                              // none, or their natural rank → clear override
  } else {
    const roles = _metRolesCache || [];
    const role = roles.find(r => String(r.rank) === String(rankVal));
    if (!role) return;
    body = { name: role.name, rank: role.rank };
  }
  try {
    const r = await api(`/api/admin/users/${userId}/met-rank`, { method: 'PATCH', body: JSON.stringify(body) });
    u.metRankOverride = r.metRankOverride || null;
    const btn = document.querySelector(`.met-cd-trigger[onclick*="openMetRankDropdown('${userId}'"]`);
    if (btn) btn.outerHTML = metRankDropdownTrigger(u);
    closeMetCd();
    showToast(body.clear ? 'MET rank set to their default' : 'MET rank override set (applies on their next request)', 'success');
  } catch (e) { showToast(e.message || 'Failed to set MET rank', 'error'); }
};

// Dedupe IA→MET migration duplicate case/ticket logs. preview=false → apply.
async function dedupeMigration(apply) {
  const box = document.getElementById('dedupe-results');
  if (apply && !confirm('Delete the duplicate case/ticket logs? The canonical (native) record is kept. This cannot be undone.')) return;
  if (box) box.innerHTML = '<div class="table-loading" style="padding:8px;"><div class="spinner"></div></div>';
  try {
    const r = await api('/api/admin/dedupe-migration-logs', { method: 'POST', body: JSON.stringify({ apply, scope: 'all' }) });
    const line = (name, s) => `<div style="margin-top:6px;"><strong>${name}:</strong> ${s.count} duplicate(s)${apply ? ` — deleted ${s.deleted}` : ''}` +
      (s.report && s.report.length ? `<ul style="margin:4px 0 0 16px;color:var(--text-muted);">${s.report.slice(0, 40).map(g =>
        `<li>keep <code>${escapeHtml(g.keep)}</code> (${escapeHtml(g.keepOrigin)}) — remove ${g.remove.map(x => `<code>${escapeHtml(x.ref)}</code>`).join(', ')}</li>`).join('')}</ul>` : '') + '</div>';
    if (box) box.innerHTML = `<div style="border:1px solid var(--border,#2a3040);border-radius:8px;padding:10px;">
      ${apply ? '<div style="color:var(--green,#28c76f);font-weight:600;">Cleanup applied.</div>' : '<div style="color:var(--amber);font-weight:600;">Preview only — nothing deleted.</div>'}
      ${line('Tickets', r.tickets)}${line('Cases', r.cases)}
      ${(r.tickets.count + r.cases.count) === 0 ? `<div style="margin-top:6px;color:var(--text-muted);">No migration duplicates found. ${met.e('met_celebrate')}</div>` : ''}
    </div>`;
    if (apply) showToast(`Removed ${r.tickets.deleted + r.cases.deleted} duplicate log(s)`, 'success');
  } catch (e) {
    if (box) box.innerHTML = `<div style="color:var(--red,#e2231a);">${escapeHtml(e.message || 'Failed')}</div>`;
  }
}

async function loadAdminUsers() {
  const tbody = document.getElementById('admin-users-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="10" class="table-loading"><div class="spinner"></div></td></tr>';
  try {
    const [users, metRoles] = await Promise.all([api('/api/admin/users'), metRolesOnce()]);
    if (!users?.length) {
      tbody.innerHTML = window.metEmpty
        ? `<tr><td colspan="10">${window.metEmpty({ icon: 'ti-users', title: 'No users found', sub: 'No accounts match yet.' })}</td></tr>`
        : emptyRow(10, 'No users found.');
      return;
    }
    // Stash each user so the custom panel/MET-rank dropdowns can read their
    // divisions, grants and natural rank when opened.
    window._adminUsers = {};
    users.forEach(u => { window._adminUsers[u.id] = u; });
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
        <td><div style="display:flex;flex-direction:column;gap:6px;min-width:210px;">
          ${panelsDropdownTrigger(u)}
          ${metRankDropdownTrigger(u, metRoles)}
        </div></td>
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
  } catch { tbody.innerHTML = emptyRow(10, 'Failed to load users.'); }
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
    if (!visits?.length) {
      tbody.innerHTML = window.metEmpty
        ? `<tr><td colspan="5">${window.metEmpty({ icon: 'ti-world-search', title: 'No visits recorded yet', sub: 'Visitor activity will appear here.' })}</td></tr>`
        : emptyRow(5, 'No visits recorded yet.');
      return;
    }

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
    if (!logs?.length) {
      tbody.innerHTML = window.metEmpty
        ? `<tr><td colspan="8">${window.metEmpty({ icon: 'ti-shield', title: 'No capture events recorded', sub: 'Screenshot attempts will be logged here.' })}</td></tr>`
        : emptyRow(8, 'No capture events recorded.');
      return;
    }

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

  set('ns-enabled',      active);
  set('ns-newCase',      s.prefs.newCase);
  set('ns-caseUpdated',  s.prefs.caseUpdated);
  set('ns-caseAppealed', s.prefs.caseAppealed);
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
  const prefs = {
    newCase:      document.getElementById('ns-newCase')?.checked      || false,
    caseUpdated:  document.getElementById('ns-caseUpdated')?.checked  || false,
    caseAppealed: document.getElementById('ns-caseAppealed')?.checked || false,
    announcements: true, // developer announcements are always on
  };
  try {
    // Send ONLY prefs. The account-wide `enabled` flag is owned by the master
    // toggle's own onchange handler; re-sending it from here would push the
    // per-device checkbox state (which is false on any device that hasn't granted
    // browser permission) and silently disable notifications account-wide.
    await api('/api/notifications/settings', { method: 'PATCH', body: JSON.stringify({ prefs }) });
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

// ── Emergency alert (dev) ───────────────────────────────────────────────
let eaOnline = { users: [], divisions: [] };
async function loadEmergencyAlert() {
  try { eaOnline = await api('/api/dev/online'); } catch { eaOnline = { users: [], divisions: ['IA', 'HPC', 'CID', 'FLP', 'SCO19', 'MET'] }; }
  renderEmergencyTarget();
}
function eaTarget() { const el = document.querySelector('input[name="ea-target"]:checked'); return el ? el.value : 'everyone'; }
function renderEmergencyTarget() {
  const t = eaTarget();
  const divBox = document.getElementById('ea-divisions');
  const userBox = document.getElementById('ea-users');
  const note = document.getElementById('ea-online-note');
  if (!divBox || !userBox) return;
  divBox.style.display = t === 'divisions' ? 'flex' : 'none';
  userBox.style.display = t === 'users' ? 'flex' : 'none';
  const divisions = eaOnline.divisions || ['IA', 'HPC', 'CID', 'FLP', 'SCO19', 'MET'];
  divBox.innerHTML = divisions.map(d =>
    `<label class="ea-div-chip"><input type="checkbox" class="ea-div" value="${escapeHtml(d)}"> ${escapeHtml(d)}</label>`).join('');
  const users = eaOnline.users || [];
  userBox.innerHTML = users.length
    ? users.map(u => `<label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13px;padding:6px 8px;border-radius:6px;border:1px solid var(--border-dim);">
        <input type="checkbox" class="ea-user" value="${escapeHtml(u.id)}" style="accent-color:var(--red,#e2231a);">
        <span style="flex:1;">${escapeHtml(u.name)} <span style="color:var(--text-muted);font-size:11px;">· ${escapeHtml((u.divisions || []).join(', ') || u.role || '')}</span></span>
      </label>`).join('')
    : '<p style="color:var(--text-secondary);">Nobody is on the site right now.</p>';
  if (note) note.textContent = `${users.length} ${users.length === 1 ? 'person is' : 'people are'} on the site right now.`;
}
async function sendEmergencyAlert() {
  const message = (document.getElementById('ea-message')?.value || '').trim();
  if (!message) { showToast('Enter an alert message.', 'error'); return; }
  const target = eaTarget();
  const payload = { target, message };
  if (target === 'divisions') {
    payload.divisions = Array.from(document.querySelectorAll('.ea-div')).filter(c => c.checked).map(c => c.value);
    if (!payload.divisions.length) { showToast('Pick at least one division.', 'error'); return; }
  } else if (target === 'users') {
    payload.userIds = Array.from(document.querySelectorAll('.ea-user')).filter(c => c.checked).map(c => c.value);
    if (!payload.userIds.length) { showToast('Select at least one person.', 'error'); return; }
  }
  const who = target === 'everyone' ? 'everyone on the site' : (target === 'divisions' ? payload.divisions.join(', ') : `${payload.userIds.length} person(s)`);
  if (!(await uiConfirm(`Send a full-screen EMERGENCY ALERT to ${who} right now?`))) return;
  try {
    const r = await api('/api/dev/emergency-alert', { method: 'POST', body: JSON.stringify(payload) });
    showToast(`Emergency alert sent to ${r.recipients} recipient(s).`, 'success');
    const m = document.getElementById('ea-message'); if (m) m.value = '';
  } catch (e) { showToast(e.message || 'Failed to send.', 'error'); }
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
  container.innerHTML = window.metSkeleton ? window.metSkeleton('feed', 4) : '<div class="table-loading"><div class="spinner"></div></div>';
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
    container.innerHTML = window.metEmpty
      ? window.metEmpty({ icon: 'ti-inbox', title: 'No pending join requests', sub: 'New group join requests will appear here.' })
      : `<p style="padding:1rem 1.2rem;font-size:13px;color:var(--text-muted);">No pending join requests.</p>`;
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

  if (!list.length) {
    tbody.innerHTML = window.metEmpty
      ? `<tr><td colspan="4">${window.metEmpty({ icon: 'ti-users', title: 'No members found', sub: 'Try a different search or rank filter.' })}</td></tr>`
      : emptyRow(4, 'No members found.');
    return;
  }

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

// ── Appeals ───────────────────────────────────────────────────────
// Mirrors server/lib/iaRank.js so the button can be hidden (or explained)
// instead of being offered and then rejected. The server is the authority.
function canAppealLocally(c) {
  if (!c) return { show: false, allowed: false, reason: '' };
  if (c.status === 'OVERTURNED' || c.appealedAt)
    return { show: false, allowed: false, reason: 'This case has already been appealed.' };
  if (c.status !== 'APPROVED')
    return { show: false, allowed: false, reason: 'Only an approved case can be appealed.' };
  if (!currentUser?.isSiPlus)
    return { show: false, allowed: false, reason: 'Appeals can only be filed by Senior Investigator and above.' };
  if (caseHasHicommOnlyPunishment(c) && !currentUser?.isHicomm)
    return { show: true, allowed: false, reason: 'Only High Command can appeal a Termination or Blacklist.' };
  return { show: true, allowed: true, reason: '' };
}

// Find a case in whichever cache is loaded, fetching it if we have to.
async function getCase(caseId) {
  const hit = (allCasesCache || []).find(x => x.id === caseId);
  if (hit) return hit;
  try {
    const c = await api('/api/cases/' + caseId);
    if (c) allCasesCache.push(c);
    return c;
  } catch (e) { return null; }
}

// Open the appeal dialog. Works from any case card on the site (My Cases, All
// Cases, the review queue and the Records lookup).
async function openAppealModal(caseId) {
  const c = await getCase(caseId);
  if (!c) { showToast('That case could not be loaded.', 'error'); return; }

  const refEl  = document.getElementById('appeal-ref');
  const warnEl = document.getElementById('appeal-warning');
  const punEl  = document.getElementById('appeal-punishments');
  const noteEl = document.getElementById('appeal-reason');
  const btn    = document.getElementById('btn-confirm-appeal');
  if (!btn || !noteEl) return;

  if (refEl) refEl.textContent = c.caseRef || '';
  noteEl.value = '';

  // Ask the server whether this user may appeal THIS case — it knows the rank.
  let verdict = null;
  try { verdict = await api('/api/cases/' + caseId + '/appeal'); } catch (e) { /* fall back to local */ }
  const local = canAppealLocally(c);
  const allowed = verdict ? verdict.canAppeal : local.allowed;
  const reason  = verdict ? verdict.reason    : local.reason;

  if (warnEl) {
    if (!allowed) {
      warnEl.style.display = '';
      warnEl.innerHTML = `<i class="ti ti-lock"></i> ${escapeHtml(reason || 'You cannot appeal this case.')}`;
    } else if (verdict && verdict.hicommOnly) {
      warnEl.style.display = '';
      warnEl.innerHTML = `<i class="ti ti-alert-triangle"></i> This case carries a <strong>Termination or Blacklist</strong>. `
        + `You are appealing it as <strong>${escapeHtml(verdict.rankLabel || 'High Command')}</strong>.`;
    } else {
      warnEl.style.display = 'none';
    }
  }

  const actions = (Array.isArray(c.actions) && c.actions.length)
    ? c.actions
    : [{ action: c.action, durationDays: null }];
  if (punEl) {
    punEl.innerHTML = `<div class="appeal-lift">
      <div class="appeal-lift-label">Punishments that will be lifted</div>
      <div class="appeal-lift-list">${actions.map(a =>
        `<span class="badge badge-red"><span class="badge-dot"></span>${escapeHtml(a.action)}${a.durationDays ? ` (${a.durationDays}d)` : ''}</span>`
      ).join('')}</div>
    </div>`;
  }

  btn.disabled = !allowed;
  btn.onclick = async () => {
    const text = noteEl.value.trim();
    if (!text) { showToast('A reason for the appeal is required.', 'error'); return; }
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner"></div> Granting…';
    try {
      const res = await api('/api/cases/' + caseId + '/appeal', {
        method: 'POST', body: JSON.stringify({ reason: text }),
      });
      closeModal('modal-appeal');
      closeModal('modal-detail');
      const failed = (res.failed || []).length;
      const manual = res.manual || [];
      showToast(
        `Appeal granted — ${res.lifted?.length || 0} punishment role(s) lifted.`
        + (failed ? ` ${failed} role(s) couldn't be removed in Discord and will be retried automatically.` : ''),
        failed ? 'warning' : 'success');
      // Anything the bot physically cannot undo has to be said out loud, or
      // people will assume the appeal reversed everything.
      if (manual.length) {
        showToast('Still to do by hand: ' + manual.join('; '), 'warning', 12000);
      }
      await refreshCaseViews();
    } catch (err) {
      showToast(err.message || 'Failed to file the appeal.', 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="ti ti-gavel"></i> Grant appeal';
    }
  };

  openModal('modal-appeal');
}
window.openAppealModal = openAppealModal;

// Reload whichever case list is currently on screen.
async function refreshCaseViews() {
  const active = document.querySelector('.page.active');
  const id = active ? active.id : '';
  if (id === 'page-dashboard')  return loadDashboard();
  if (id === 'page-my-cases')   return loadMyCases();
  if (id === 'page-all-cases')  return loadAllCases();
  if (id === 'page-review')     return loadReview();
  if (id === 'page-records' && typeof runRecordLookup === 'function') return runRecordLookup();
  return loadDashboard();
}
window.refreshCaseViews = refreshCaseViews;

// ── Where a decision may be made ──────────────────────────────────
//
// One place: the Pending tab. Everywhere else — the dashboard, All Cases, My
// Cases, the ticket archive — is the RECORD, and an Approve button sitting in the
// middle of a record is how a case gets signed off by somebody who only opened
// the page to look something up. It is also how the same case gets decided twice
// from two different tables.
//
// So the controls do not exist outside Pending. What appears instead is the way
// to get to Pending, which is more use than a greyed-out button.
function onPendingPage() {
  const p = document.getElementById('page-pending');
  return !!p && p.classList.contains('active');
}
window.onPendingPage = onPendingPage;

// The stand-in for a decision button, outside Pending.
function reviewElsewhereChip(onclick) {
  return `<button class="row-btn row-btn-review-elsewhere btn-sm" onclick="${onclick}"
            title="Decisions are made on the Pending tab. This takes you there and opens it.">
            <i class="ti ti-clipboard-check"></i> Review in Pending
          </button>`;
}

function rowActions(c) {
  // Not on Pending: offer the route there, not the decision.
  if (!onPendingPage()) return reviewElsewhereChip(`goReviewCase('${c.id}')`);
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
    ['Written Warning',       [/\bwritten warning\b/, /\bwritten\b/, /\bwarning\b/]],
    ['Zero Tolerance',        [/\bzero tolerance\b/, /\bzt\b/, /\bz t\b/]],
    // Suspension was missing entirely, so a reviewer asking for one in a change
    // request had it silently detected as nothing.
    ['Suspension',            [/\bsuspension\b/, /\bsuspend(ed)?\b/, /\bsusp\b/]],
    ['Demotion',              [/\bdemotion\b/, /\bdemote[d]?\b/]],
    ['Termination',           [/\btermination\b/, /\bterminate[d]?\b/, /\bfired\b/]],
    ['Blacklist',             [/\bblacklist(ed)?\b/]],
  ];
  // A duration ("5 day", "5 days", "5d") belongs to the punishment it was
  // written next to. "5 day ZT and strike 1" is one five-day ZT and one strike,
  // not two five-day punishments — applying a single duration to everything
  // timed handed out lengths nobody asked for.
  //
  // Which punishments carry a length comes from the server's list, not a second
  // hand-written one — Suspension is timed and was missing from the copy that
  // used to live here, so "7 day suspension" lost its 7.
  const DUR_RE = /\b(\d{1,3})\s*(?:d|day|days)\b/g;
  const durations = [];
  for (let m; (m = DUR_RE.exec(t)); ) durations.push({ days: parseInt(m[1], 10), at: m.index, end: m.index + m[0].length });
  const isTimed = (name) => {
    const cfg = ACTIONS_CLIENT.find(a => a.name === name);
    return !!(cfg && cfg.timed);
  };
  // Only offer what can actually be filed today. A retired action (Verbal
  // Warning, Disciplinary Strike 3) is not on the server's list, so detecting
  // one would hand the submitter a punishment the server then refuses.
  const filable = new Set(ACTIONS_CLIENT.map(a => a.name));
  const found = [];
  for (const [name, pats] of rules) {
    if (!filable.has(name)) continue;
    let at = -1;
    for (const p of pats) { const m = t.match(p); if (m && m.index !== undefined) { at = m.index; break; } }
    if (at < 0) continue;
    found.push({ action: name, durationDays: null, _at: at });
  }
  // Each length goes to the nearest timed punishment named after it, and each
  // is spent once. A length written after everything ("suspend them, 7 days")
  // still finds the suspension, because nothing nearer claimed it.
  const timedFound = found.filter(f => isTimed(f.action));
  for (const d of durations) {
    let best = null, bestGap = Infinity;
    for (const f of timedFound) {
      if (f.durationDays != null) continue;
      const gap = f._at >= d.end ? f._at - d.end : (d.at - f._at) + 1000;  // after it wins over before it
      if (gap < bestGap) { bestGap = gap; best = f; }
    }
    if (best) best.durationDays = d.days;
  }
  return found.map(({ action, durationDays }) => ({ action, durationDays }));
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
// Open a case detail from anywhere on the site — including the Records lookup,
// where the case isn't in any list cache yet.
async function openCaseDetail(caseId) {
  const c = await getCase(caseId);
  if (!c) { showToast("That case couldn't be loaded.", 'error'); return; }
  openDetail(caseId);
}
window.openCaseDetail = openCaseDetail;

function openDetail(caseId) {
  const c = allCasesCache.find(x => x.id === caseId);
  if (!c) { openCaseDetail(caseId); return; }

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
    ${caseIsAppealed(c) ? `
    <div class="appeal-banner">
      <div class="appeal-banner-head">
        <span><i class="ti ti-gavel"></i> Appeal granted — punishments lifted</span>
        <span class="appeal-banner-when">${c.appealedAt ? formatDateTime(c.appealedAt) : ''}</span>
      </div>
      <div class="appeal-banner-by">by <strong>${escapeHtml(c.appealedByName || 'Internal Affairs')}</strong>${
        (c.appeals && c.appeals[0] && c.appeals[0].appealedByRank) ? ' · ' + escapeHtml(c.appeals[0].appealedByRank) : ''}</div>
      ${c.appealReason ? `<div class="appeal-banner-reason">${escapeHtml(c.appealReason)}</div>` : ''}
      <div class="appeal-banner-note">This case no longer counts toward the officer's record.</div>
    </div>` : ''}
    ${renderRevisionHistory(c)}
    <div class="detail-grid">
      <div class="detail-field">
        <span class="detail-field-label">Case Reference</span>
        <span class="detail-field-value mono">${escapeHtml(c.caseRef)}</span>
      </div>
      <div class="detail-field">
        <span class="detail-field-label">Status</span>
        <span class="detail-field-value">${statusBadge(c.status)} ${originBadge(c)}</span>
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
        <span class="detail-field-label">Case File</span>
        <span class="detail-field-value">${linkChip(c.caseLink, 'Open the case file', 'file-text')}</span>
      </div>` : ''}
      ${evidenceBlock(c.evidence)}
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

  // Appeal — Senior Investigator and above, High Command only for
  // Terminations/Blacklists. The server enforces the same rule.
  const appealCheck = canAppealLocally(c);
  if (appealCheck.show) {
    const appealBtn = document.createElement('button');
    appealBtn.className = 'btn btn-ghost btn-appeal';
    appealBtn.innerHTML = '<i class="ti ti-gavel"></i> Appeal';
    appealBtn.disabled = !appealCheck.allowed;
    if (!appealCheck.allowed) appealBtn.title = appealCheck.reason;
    appealBtn.onclick = () => openAppealModal(c.id);
    footer.appendChild(appealBtn);
  }

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
  } else if (isElevated && c.status === 'PENDING' && !onPendingPage()) {
    // Opened from the record rather than from the queue. The decision belongs on
    // the Pending tab, so this offers the way there instead of the three buttons.
    const go = document.createElement('button');
    go.className = 'btn btn-ghost';
    go.innerHTML = '<i class="ti ti-clipboard-check"></i> Review in Pending';
    go.title = 'Approve, deny and request-changes all live on the Pending tab.';
    go.onclick = async () => { closeModal('modal-detail'); await goReviewCase(c.id); };
    const why = document.createElement('span');
    why.style.cssText = 'font-size:12px;color:var(--text-secondary);align-self:center;margin-right:auto;';
    why.textContent = 'This is the record, so nothing is decided here.';
    footer.appendChild(why);
    footer.appendChild(go);
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

