// client/public/js/activity-logs.js
// Shared rendering for patrol & event logs — used by the FLP dashboard (all
// logs, with sign-off) and by the officer's own MET dashboard (their logs).
//
// A log's status comes from someone ticking or crossing the message in
// Discord. That's worth saying on screen, because "who signed this off" is
// often someone the officer never spoke to — so every row names the decider and
// says where the decision came from.
window.ActivityLogs = (function () {

  const KIND_LABEL = { PATROL: 'Patrol', EVENT: 'Event' };
  const KIND_ICON  = { PATROL: 'ti-shield-checkered', EVENT: 'ti-calendar-event' };

  function esc(s) { return typeof escapeHtml === 'function' ? escapeHtml(s) : String(s == null ? '' : s); }
  function when(d) { return typeof formatDate === 'function' ? formatDate(d) : (d || '—'); }
  function whenFull(d) { return typeof formatDateTime === 'function' ? formatDateTime(d) : (d || '—'); }

  function kindBadge(kind) {
    const label = KIND_LABEL[kind] || kind || '—';
    const icon  = KIND_ICON[kind] || 'ti-clipboard-text';
    return `<span class="badge"><i class="ti ${icon}"></i> ${esc(label)}</span>`;
  }

  function statusCell(log) {
    // ui.js already renders PENDING / APPROVED / DENIED, and the tally is worth
    // showing next to it: two people ticking is different from one.
    const badge = typeof statusBadge === 'function'
      ? statusBadge(log.status)
      : `<span class="badge">${esc(log.status)}</span>`;
    const bits = [];
    if (log.tickCount)  bits.push(`✅ ${log.tickCount}`);
    if (log.crossCount) bits.push(`❌ ${log.crossCount}`);
    const tally = bits.length ? `<span class="log-muted" style="margin-left:6px;font-size:11px;">${bits.join(' · ')}</span>` : '';
    return badge + tally;
  }

  // Who signed it off, and how we know. "in Discord" is the normal case.
  function decidedCell(log) {
    if (log.status === 'PENDING' || !log.decidedByName && !log.decidedByDiscordId) {
      return '<span class="log-muted">—</span>';
    }
    const name = log.decidedByName || log.decidedByDiscordId;
    const src  = log.decisionSource === 'SITE' ? 'on the site' : 'in Discord';
    return `${esc(name)} <span class="log-muted" style="font-size:11px;">${src}</span>`;
  }

  function officerCellFor(log) {
    const name = log.officerRobloxUsername || log.officerUsername || log.officerDiscordId || 'Unknown';
    const sub  = log.officerRobloxUsername && log.officerUsername && log.officerRobloxUsername !== log.officerUsername
      ? `<div class="log-muted" style="font-size:11px;">${esc(log.officerUsername)}</div>` : '';
    return `<div>${esc(name)}</div>${sub}`;
  }

  function excerpt(log, max = 90) {
    const text = (log.content || '').replace(/\s+/g, ' ').trim();
    if (!text) {
      const n = (log.attachments || []).length;
      return n ? `<span class="log-muted">${n} attachment${n === 1 ? '' : 's'}</span>` : '<span class="log-muted">No text</span>';
    }
    return esc(text.length > max ? text.slice(0, max - 1) + '…' : text);
  }

  function empty(colspan, message) {
    return typeof emptyRow === 'function'
      ? emptyRow(colspan, message)
      : `<tr><td colspan="${colspan}" class="table-empty"><span class="table-empty-text">${esc(message)}</span></td></tr>`;
  }

  // "My logs" — 5 columns: Type, Log, Status, Signed off by, Logged.
  // `opts.clickable` is opt-in: only pages that actually wire up a detail view
  // mark the rows as clickable, so a row never looks interactive and do nothing.
  function myRows(logs, opts = {}) {
    if (!logs || !logs.length) return empty(5, 'No patrol or event logs yet.');
    return logs.map(l => `<tr${opts.clickable ? ` class="clickable-row" data-log-id="${esc(l.id)}"` : ''}>
      <td>${kindBadge(l.kind)}</td>
      <td>${excerpt(l)}</td>
      <td>${statusCell(l)}</td>
      <td>${decidedCell(l)}</td>
      <td>${when(l.loggedAt)}</td>
    </tr>`).join('');
  }

  // "All logs" — adds Officer and an action column.
  function allRows(logs, opts = {}) {
    if (!logs || !logs.length) return empty(7, 'No patrol or event logs found.');
    return logs.map(l => `<tr class="clickable-row" data-log-id="${esc(l.id)}">
      <td>${kindBadge(l.kind)}</td>
      <td>${officerCellFor(l)}</td>
      <td>${excerpt(l, 70)}</td>
      <td>${statusCell(l)}</td>
      <td>${decidedCell(l)}</td>
      <td>${when(l.loggedAt)}</td>
      <td class="row-actions">${opts.canDecide ? decideButtons(l) : ''}</td>
    </tr>`).join('');
  }

  // Sign-off buttons. Shown for any status, not just PENDING: a supervisor
  // correcting a mistaken tick is exactly the case this has to support.
  function decideButtons(log) {
    return `
      <button class="row-btn row-btn-approve" data-decide="APPROVED" data-log-id="${esc(log.id)}" title="Approve"><i class="ti ti-check"></i></button>
      <button class="row-btn row-btn-deny" data-decide="DENIED" data-log-id="${esc(log.id)}" title="Deny"><i class="ti ti-x"></i></button>`;
  }

  function field(label, valueHtml, full) {
    return `<div class="detail-field${full ? ' full' : ''}">
      <div class="detail-field-label">${esc(label)}</div>
      <div class="detail-field-value">${valueHtml}</div>
    </div>`;
  }

  function attachmentsHtml(log) {
    const items = log.attachments || [];
    if (!items.length) return '';
    const links = items.map(a => {
      const url = String(a && a.url || '');
      // Only ever link http(s). The URL came from Discord, but this is the one
      // place it becomes a live link, so it gets checked here.
      if (!/^https?:\/\//i.test(url)) return '';
      return `<a class="log-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(a.name || url)}</a>`;
    }).filter(Boolean);
    return links.length ? field('Attachments', links.join('<br />'), true) : '';
  }

  function detailHtml(log) {
    return `
      <div class="detail-grid">
        ${field('Type',    esc(KIND_LABEL[log.kind] || log.kind))}
        ${field('Officer', esc(log.officerRobloxUsername || log.officerUsername || log.officerDiscordId || 'Unknown'))}
        ${field('Logged',  esc(whenFull(log.loggedAt)))}
        ${field('Status',  statusCell(log))}
        ${field('Signed off by', decidedCell(log))}
        ${field('Decided', esc(log.decidedAt ? whenFull(log.decidedAt) : '—'))}
        <div class="detail-divider"></div>
        ${field('Log', `<span style="white-space:pre-wrap;">${esc(log.content || '—')}</span>`, true)}
        ${attachmentsHtml(log)}
      </div>`;
  }

  return { kindBadge, statusCell, decidedCell, excerpt, myRows, allRows, detailHtml, decideButtons };
})();
