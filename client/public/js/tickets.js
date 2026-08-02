// client/public/js/tickets.js
// Closed ticket logs, mirrored from the IA ticket-logs Discord channel.
//
// Nobody logs a ticket here — rows arrive automatically from the Discord
// ticket-log channel. A supervisor approves or denies each one on the site, and
// an approved log gives the investigator who closed it 2 quota points (an
// approved case is worth 4). "My Tickets" is every ticket YOU closed;
// "All Tickets" is every ticket the channel has logged.

// Ticket-type labels + badge colours, shared with the dashboard tables.
var TL = {
  GENERAL_SUPPORT: 'General Support',
  HICOMM:          'IA Complaint',
  OFFICER_REPORT:  'Officer Report',
  APPEAL:          'Appeal',
};
var TC = {
  GENERAL_SUPPORT: 'blue',
  HICOMM:          'red',
  OFFICER_REPORT:  'amber',
  APPEAL:          'purple',
};

var myTicketsCache  = [];
var allTicketsCache = [];
var myTicketType    = 'all';
var allTicketType   = 'all';
var myTicketQuery   = '';
var allTicketQuery  = '';
var myTicketStatus  = 'all';
var allTicketStatus = 'all';
// dashboard.js sets window.canReviewTickets once /api/me resolves the viewer's
// role. Supervisors and above sign tickets off; everyone else sees the status
// read-only. Read through window each time — this file loads first.
function canReview() { return !!window.canReviewTickets; }

function ticketTypeBadge(t) {
  var c = TC[t] || 'blue';
  var l = TL[t] || t || '—';
  return '<span class="badge badge-' + c + '"><span class="badge-dot"></span>' + escapeHtml(l) + '</span>';
}

// A ticket matches a search when any field a person would search by contains it.
function ticketMatches(t, q) {
  if (!q) return true;
  var hay = [
    t.ticketNo != null ? ('#' + String(t.ticketNo).padStart(4, '0')) : null,
    t.ticketNo != null ? String(t.ticketNo) : null,
    t.ticketRef, t.ticketName, t.reason, t.creatorUsername, t.creatorRobloxUsername, t.closerRaw,
    t.creatorDiscordId, t.closerUsername, t.closerDiscordId, TL[t.ticketType], t.ticketType,
  ].filter(Boolean).join(' ').toLowerCase();
  return hay.indexOf(q.toLowerCase()) >= 0;
}

function filterTickets(list, type, q, status) {
  return (list || [])
    .filter(function (t) { return type === 'all' || t.ticketType === type; })
    .filter(function (t) { return !status || status === 'all' || (t.status || 'PENDING') === status; })
    .filter(function (t) { return ticketMatches(t, q); });
}

// The supervisor sign-off cell: buttons while it's pending (and you may act),
// otherwise who decided it.
function ticketReviewCell(t) {
  var st = t.status || 'PENDING';
  if (st === 'PENDING' && canReview()) {
    return '<div class="row-actions" onclick="event.stopPropagation()">'
      + '<button class="row-btn row-btn-approve" title="Approve" onclick="reviewTicket(\'' + t.id + '\', \'approve\')"><i class="ti ti-check"></i></button>'
      + '<button class="row-btn row-btn-deny" title="Deny" onclick="reviewTicket(\'' + t.id + '\', \'deny\')"><i class="ti ti-x"></i></button>'
      + '</div>';
  }
  if (st === 'PENDING') return '<span class="text-muted" style="font-size:11px;">Awaiting review</span>';
  return '<span style="font-size:11px;">' + escapeHtml(t.reviewedByName || '—') + '</span>';
}

// Approve or deny a ticket log. Approving awards the closer 2 quota points.
async function reviewTicket(ticketId, action) {
  try {
    await api('/api/tickets/' + encodeURIComponent(ticketId) + '/review', {
      method: 'POST', body: JSON.stringify({ action: action }),
    });
    showToast(action === 'approve' ? 'Ticket approved.' : 'Ticket denied.', 'success');
    closeModal('modal-ticket-detail');
    allTicketsCache = [];   // force a refetch so the queue and the archive agree
    await Promise.all([loadTickets(), loadAllTickets()].map(function (p) { return p && p.catch ? p.catch(function () {}) : p; }));
    if (typeof renderPendingTicketsTable === 'function') renderPendingTicketsTable();
    if (typeof loadStats === 'function') loadStats();
  } catch (err) {
    showToast(err.message || 'Could not record that decision.', 'error');
  }
}

// The number people actually read. Tickety's own id is a random string, so it
// is kept on the row (and searchable) but never the thing shown in the table.
function ticketNumber(t) {
  if (t.ticketNo != null) return '#' + String(t.ticketNo).padStart(4, '0');
  return t.ticketRef || t.ticketName || '—';
}

// Who handled it. Every fallback the server resolved, then the raw name the log
// printed — an em dash here means nobody can action the row.
function ticketHandler(t) {
  return t.closerUsername || t.closerRaw || t.closerDiscordId || '—';
}

function ticketRowHtml(t, opts) {
  opts = opts || {};
  var creator = t.creatorRobloxUsername || t.creatorUsername || t.creatorDiscordId || '—';
  var closer  = ticketHandler(t);
  return '<tr onclick="openTicketDetail(\'' + t.id + '\')">'
    + '<td><span class="case-ref">' + escapeHtml(ticketNumber(t)) + '</span></td>'
    + (opts.showCloser ? '<td><span style="font-size:12px;">' + escapeHtml(closer) + '</span></td>' : '')
    + '<td><span style="font-size:12px;font-weight:500;">' + escapeHtml(creator) + '</span></td>'
    + '<td>' + ticketTypeBadge(t.ticketType) + '</td>'
    + '<td><span class="case-reason-cell">' + escapeHtml(t.reason || '—') + '</span></td>'
    + '<td>' + (t.transcriptUrl
        ? '<a href="' + escapeHtml(t.transcriptUrl) + '" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" class="row-btn"><i class="ti ti-file-text"></i> Transcript</a>'
        : '<span class="text-muted" style="font-size:11px;">—</span>') + '</td>'
    // The pending queue is all one status, so a Status column there would be
    // the same word on every row; the decision goes last, where the eye ends up.
    + (opts.review
        ? '<td><span class="date-cell">' + formatDateTime(t.closedAt) + '</span></td>'
          + '<td>' + ticketReviewCell(t) + '</td>'
        : '<td>' + statusBadge(t.status || 'PENDING') + '</td>'
          + '<td>' + ticketReviewCell(t) + '</td>'
          + '<td><span class="date-cell">' + formatDateTime(t.closedAt) + '</span></td>')
    + '</tr>';
}

// ── My Tickets ────────────────────────────────────────────────────
async function loadTickets() {
  var tbody = document.getElementById('tickets-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="8" class="table-loading"><div class="spinner"></div></td></tr>';
  try {
    // The search goes to the server too, so it isn't limited to the rows the
    // page happens to have loaded.
    myTicketsCache = (await api('/api/tickets' + (myTicketQuery ? '?q=' + encodeURIComponent(myTicketQuery) : ''))) || [];
    renderTicketsTable();
  } catch (err) {
    tbody.innerHTML = emptyRow(8, 'Failed to load ticket logs.');
  }
}

function renderTicketsTable() {
  var tbody = document.getElementById('tickets-tbody');
  if (!tbody) return;
  var rows = filterTickets(myTicketsCache, myTicketType, myTicketQuery, myTicketStatus);
  var label = document.getElementById('tickets-count-label');
  if (label) label.textContent = rows.length + ' of ' + myTicketsCache.length + ' shown';
  if (!rows.length) {
    tbody.innerHTML = emptyRow(8, myTicketsCache.length
      ? 'No ticket logs match that search.'
      : 'No tickets closed by you yet. Close a ticket in Discord and it appears here automatically.');
    return;
  }
  tbody.innerHTML = rows.map(function (t) { return ticketRowHtml(t); }).join('');
}

// ── All Tickets ───────────────────────────────────────────────────
async function loadAllTickets() {
  var tbody = document.getElementById('all-tickets-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="9" class="table-loading"><div class="spinner"></div></td></tr>';
  try {
    allTicketsCache = (await api('/api/tickets/all' + (allTicketQuery ? '?q=' + encodeURIComponent(allTicketQuery) : ''))) || [];
    renderAllTicketsTable();
  } catch (err) {
    tbody.innerHTML = emptyRow(9, 'Failed to load ticket logs.');
  }
}

// ── Pending tickets ───────────────────────────────────────────────
// The supervisor queue. Same rows as the archive, filtered to what still needs
// a decision, with the decision column always present — a queue whose whole
// purpose is deciding things shouldn't make you hunt for the buttons.
var pendingTicketQuery = '';
var pendingTicketType = 'all';

async function loadPendingTickets() {
  var tbody = document.getElementById('pending-tickets-tbody');
  if (!tbody) return;
  if (!allTicketsCache.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="table-loading"><div class="spinner"></div></td></tr>';
    try { allTicketsCache = (await api('/api/tickets/all')) || []; }
    catch (err) { tbody.innerHTML = emptyRow(8, err.message || 'Failed to load tickets.'); return; }
  }
  renderPendingTicketsTable();
}

function renderPendingTicketsTable() {
  var tbody = document.getElementById('pending-tickets-tbody');
  if (!tbody) return;
  // Everything still awaiting a decision, before the type filter and the
  // search — that's the denominator "X of Y" is measured against, the same way
  // the pending cases queue reads.
  var waiting = filterTickets(allTicketsCache, 'all', '', 'PENDING');
  var rows = filterTickets(allTicketsCache, pendingTicketType, pendingTicketQuery, 'PENDING');

  var label = document.getElementById('pending-tickets-count');
  if (label) label.textContent = rows.length + ' of ' + waiting.length + ' awaiting decision';
  // The nav badge counts the whole queue, not the filtered view — a filter is
  // how you're looking at it, not how much there is.
  var badge = document.getElementById('pending-tickets-badge');
  if (badge) { badge.textContent = waiting.length; badge.style.display = waiting.length ? '' : 'none'; }

  if (!rows.length) {
    tbody.innerHTML = emptyRow(8, (pendingTicketQuery || pendingTicketType !== 'all')
      ? 'No pending tickets match that filter.'
      : 'Nothing waiting — every ticket log has been signed off.');
    return;
  }
  tbody.innerHTML = rows.map(function (t) { return ticketRowHtml(t, { showCloser: true, review: true }); }).join('');
}

function renderAllTicketsTable() {
  var tbody = document.getElementById('all-tickets-tbody');
  if (!tbody) return;
  var rows = filterTickets(allTicketsCache, allTicketType, allTicketQuery, allTicketStatus);
  var label = document.getElementById('all-tickets-count-label');
  if (label) label.textContent = rows.length + ' of ' + allTicketsCache.length + ' shown';
  if (!rows.length) {
    tbody.innerHTML = emptyRow(9, allTicketsCache.length
      ? 'No ticket logs match that search.'
      : 'No ticket logs ingested yet. They arrive automatically as tickets are closed in Discord.');
    return;
  }
  tbody.innerHTML = rows.map(function (t) { return ticketRowHtml(t, { showCloser: true }); }).join('');
}

// ── Detail ────────────────────────────────────────────────────────
async function openTicketDetail(ticketId) {
  var body = document.getElementById('tdetail-body');
  var ref  = document.getElementById('tdetail-ref');
  if (!body) return;
  body.innerHTML = '<div class="table-loading" style="padding:2rem;"><div class="spinner"></div></div>';
  openModal('modal-ticket-detail');

  var t;
  try {
    t = await api('/api/tickets/' + ticketId);
  } catch (err) {
    body.innerHTML = '<div style="padding:1rem;color:var(--red);">' + escapeHtml(err.message || 'Failed to load ticket.') + '</div>';
    return;
  }

  if (ref) ref.textContent = ticketNumber(t);

  var field = function (label, value, mono) {
    return '<div class="detail-field"><span class="detail-field-label">' + escapeHtml(label) + '</span>'
      + '<span class="detail-field-value' + (mono ? ' mono' : '') + '">'
      + (value || '<span style="color:var(--text-muted);">—</span>') + '</span></div>';
  };

  var targetHtml = '';
  if (t.target) {
    targetHtml = '<div class="detail-divider"></div>'
      + '<div class="detail-field full"><span class="detail-field-label">Ticket opened by</span>'
      + '<span class="detail-field-value" style="display:flex;align-items:center;gap:9px;flex-wrap:wrap;">'
      + (t.target.avatar ? '<img src="' + escapeHtml(t.target.avatar) + '" alt="" style="width:30px;height:30px;border-radius:50%;" />' : '')
      + '<a href="' + escapeHtml(t.target.profileUrl) + '" target="_blank" rel="noopener noreferrer" style="color:var(--blue);">'
      + escapeHtml(t.target.username) + '</a>'
      + (t.target.groupRole ? '<span class="badge badge-blue"><span class="badge-dot"></span>' + escapeHtml(t.target.groupRole) + '</span>' : '')
      + '</span></div>';
  }

  body.innerHTML = '<div class="detail-grid">'
    + field('Ticket', escapeHtml(t.ticketName || t.ticketRef || '—'), true)
    + field('Type', ticketTypeBadge(t.ticketType))
    + field('Closed by', escapeHtml(t.closerUsername || t.closerDiscordId || '—'))
    + field('Closed at', formatDateTime(t.closedAt))
    + field('Status', statusBadge(t.status || 'PENDING'))
    + field('Reviewed by', escapeHtml(t.reviewedByName || '—')
        + (t.reviewedAt ? ' <span class="text-muted" style="font-size:11px;">' + formatDateTime(t.reviewedAt) + '</span>' : ''))
    + '<div class="detail-field full"><span class="detail-field-label">Close reason</span>'
    +   '<span class="detail-field-value">' + escapeHtml(t.reason || 'No reason given.') + '</span></div>'
    + field('Opened by (Discord)', escapeHtml(t.creatorUsername || '—'), true)
    + field('Creator ID', escapeHtml(t.creatorDiscordId || '—'), true)
    + (t.transcriptUrl
        ? '<div class="detail-field full"><span class="detail-field-label">Transcript</span>'
          + '<span class="detail-field-value"><a href="' + escapeHtml(t.transcriptUrl) + '" target="_blank" rel="noopener noreferrer" style="color:var(--blue);word-break:break-all;">'
          + escapeHtml(t.transcriptUrl) + '</a></span></div>'
        : '')
    + targetHtml
    + '</div>'
    + '<div style="margin-top:1rem;padding:9px 12px;border-radius:8px;background:var(--blue-dim);border:1px solid var(--border-dim);font-size:11.5px;color:var(--text-secondary);">'
    +   '<i class="ti ti-info-circle"></i> Ticket logs are mirrored from Discord automatically — nobody logs one by hand. Approving one awards the investigator who closed it <strong>2 quota points</strong>.'
    + '</div>'
    + ((t.status || 'PENDING') === 'PENDING' && canReview()
        ? '<div style="margin-top:0.9rem;display:flex;gap:8px;justify-content:flex-end;">'
          + '<button class="btn btn-danger" onclick="reviewTicket(\'' + t.id + '\', \'deny\')"><i class="ti ti-x"></i> Deny</button>'
          + '<button class="btn btn-primary" onclick="reviewTicket(\'' + t.id + '\', \'approve\')"><i class="ti ti-check"></i> Approve</button>'
          + '</div>'
        : '');
}

// Deep-link support (shared "Copy link" URLs).
async function goReviewTicket(ticketId) { openTicketDetail(ticketId); }

// ── Wiring ────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function () {
  // Type filter tabs
  document.querySelectorAll('#ticket-filter-tabs .filter-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      document.querySelectorAll('#ticket-filter-tabs .filter-tab').forEach(function (t) { t.classList.remove('active'); });
      tab.classList.add('active');
      myTicketType = tab.dataset.tfilter;
      renderTicketsTable();
    });
  });
  document.querySelectorAll('#all-ticket-filter-tabs .filter-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      document.querySelectorAll('#all-ticket-filter-tabs .filter-tab').forEach(function (t) { t.classList.remove('active'); });
      tab.classList.add('active');
      allTicketType = tab.dataset.atfilter;
      renderAllTicketsTable();
    });
  });

  // Status tabs — this is what makes the sign-off queue workable: "Pending"
  // shows only the logs still waiting on a supervisor.
  document.querySelectorAll('#ticket-status-tabs .filter-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      document.querySelectorAll('#ticket-status-tabs .filter-tab').forEach(function (t) { t.classList.remove('active'); });
      tab.classList.add('active');
      myTicketStatus = tab.dataset.tstatus;
      renderTicketsTable();
    });
  });
  document.querySelectorAll('#all-ticket-status-tabs .filter-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      document.querySelectorAll('#all-ticket-status-tabs .filter-tab').forEach(function (t) { t.classList.remove('active'); });
      tab.classList.add('active');
      allTicketStatus = tab.dataset.atstatus;
      renderAllTicketsTable();
    });
  });

  // Search
  // Filter what's on screen instantly, then re-query the server shortly after so
  // matches beyond the loaded rows show up too.
  var mineTimer = null, allTimer = null;
  var mine = document.getElementById('tickets-search');
  if (mine) mine.addEventListener('input', function () {
    myTicketQuery = mine.value.trim();
    renderTicketsTable();
    clearTimeout(mineTimer);
    mineTimer = setTimeout(loadTickets, 350);
  });
  var all = document.getElementById('all-tickets-search');
  if (all) all.addEventListener('input', function () {
    allTicketQuery = all.value.trim();
    renderAllTicketsTable();
    clearTimeout(allTimer);
    allTimer = setTimeout(loadAllTickets, 350);
  });

  var pq = document.getElementById('pending-tickets-search');
  var pqTimer;
  if (pq) pq.addEventListener('input', function () {
    pendingTicketQuery = pq.value.trim();
    clearTimeout(pqTimer);
    pqTimer = setTimeout(renderPendingTicketsTable, 200);
  });

  var ptabs = document.getElementById('pending-tickets-filter-tabs');
  if (ptabs) ptabs.addEventListener('click', function (ev) {
    var b = ev.target.closest('.filter-tab');
    if (!b) return;
    ptabs.querySelectorAll('.filter-tab').forEach(function (x) { x.classList.remove('active'); });
    b.classList.add('active');
    pendingTicketType = b.dataset.tfilter || 'all';
    renderPendingTicketsTable();
  });

  // Manual re-sync (HICOMM / Developer)
  var sync = document.getElementById('btn-ticket-sync');
  if (sync) sync.addEventListener('click', async function () {
    sync.disabled = true;
    var original = sync.innerHTML;
    sync.innerHTML = '<div class="spinner"></div> Syncing…';
    try {
      var s = await api('/api/tickets/sync', { method: 'POST', body: JSON.stringify({ full: true }) });
      showToast('Synced — ' + s.created + ' new, ' + s.updated + ' refreshed (scanned ' + s.scanned + ').', 'success');
      loadAllTickets(); loadTickets();
      if (typeof renderPendingTicketsTable === 'function') renderPendingTicketsTable();
    } catch (err) {
      showToast(err.message || 'Sync failed.', 'error');
    } finally {
      sync.disabled = false; sync.innerHTML = original;
    }
  });
});
