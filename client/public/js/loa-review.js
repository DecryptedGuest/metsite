/* client/public/js/loa-review.js — embeddable LOA review panel for a division.
   HICOMM of a division see the LOA requests sent for THAT division and can
   approve/deny them. Hits /api/loa/review?division=<DIV> (server already scopes
   to divisions the viewer may review). Renders into tbody id "loa-<DIV>-tbody"
   with a count in "loa-<DIV>-count". */
(function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmt(v) { try { return new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); } catch (e) { return '—'; } }
  function badge(s) {
    var map = { PENDING: 'badge-pending', APPROVED: 'badge-approved', DENIED: 'badge-denied', CANCELLED: 'badge-denied' };
    return "<span class='badge " + (map[s] || 'badge-pending') + "'><span class='badge-dot'></span>" + esc(s[0] + s.slice(1).toLowerCase()) + '</span>';
  }

  async function load(div) {
    var tbody = document.getElementById('loa-' + div + '-tbody');
    if (!tbody) return;
    tbody.innerHTML = "<tr><td colspan='5' class='table-loading'><div class='spinner'></div></td></tr>";
    try {
      var rows = await api('/api/loa/review?division=' + encodeURIComponent(div));
      var countEl = document.getElementById('loa-' + div + '-count');
      var pending = rows.filter(function (r) { return r.status === 'PENDING'; }).length;
      if (countEl) countEl.textContent = rows.length ? (pending + ' pending') : '';
      if (!rows.length) {
        var empty = window.metEmpty
          ? window.metEmpty({ icon: 'ti-calendar-off', title: 'No LOA requests', sub: 'Requests sent for ' + div + ' appear here.' })
          : "<span class='table-empty-text'>No LOA requests.</span>";
        tbody.innerHTML = "<tr><td colspan='5' class='table-empty'>" + empty + '</td></tr>';
        return;
      }
      tbody.innerHTML = rows.map(function (r) {
        var acts = r.status === 'PENDING'
          ? "<button class='btn btn-success btn-sm' onclick=\"LoaReview.decide('" + div + "','" + esc(r.id) + "','approve')\"><i class='ti ti-check'></i> Approve</button> "
            + "<button class='btn btn-danger btn-sm' onclick=\"LoaReview.decide('" + div + "','" + esc(r.id) + "','deny')\"><i class='ti ti-x'></i> Deny</button>"
          : (r.reviewerName ? "<span class='text-muted' style='font-size:11px;'>by " + esc(r.reviewerName) + '</span>' : '');
        return '<tr>'
          + "<td><span style='font-weight:600;font-size:12px;'>" + esc(r.userName || 'A member') + '</span></td>'
          + "<td><span style='font-size:12px;'>" + fmt(r.startAt) + ' → ' + fmt(r.endAt) + '</span></td>'
          + "<td><span class='text-muted' style='font-size:11px;'>" + (r.reason ? esc(r.reason) : '—') + '</span></td>'
          + '<td>' + badge(r.status) + '</td>'
          + "<td style='white-space:nowrap;'>" + acts + '</td>'
          + '</tr>';
      }).join('');
    } catch (e) {
      tbody.innerHTML = "<tr><td colspan='5' class='table-empty'><span class='table-empty-text'>Failed to load LOA requests.</span></td></tr>";
    }
  }

  window.LoaReview = {
    load: load,
    async decide(div, id, action) {
      var note = '';
      if (action === 'deny') { note = (await uiPrompt('Reason for denying this LOA (optional):')) || ''; }
      try {
        await api('/api/loa/' + id + '/decision', { method: 'POST', body: JSON.stringify({ action: action, note: note }) });
        showToast('LOA ' + (action === 'approve' ? 'approved' : 'denied') + '.', 'success');
        load(div);
      } catch (err) { showToast(err.message || 'Failed to record decision.', 'error'); }
    },
  };
})();
