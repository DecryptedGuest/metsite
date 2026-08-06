/* client/public/js/division-quota.js — shared division quota + activity UI.
   Two modes over the same data (/api/divquota/<division>/members):
     • 'activity' — read-only, every member's weekly activity (any division member)
     • 'review'   — HICOMM: pass/fail/exempt/LOA decisions, submit to Discord, reset
   Element ids are namespaced by division + mode so several can coexist on a page:
     dq-<DIV>-<act|rev>-tbody / -count / -tabs. */
(function () {
  var cache  = {};   // key "DIV:mode" -> members[]
  var filter = {};   // key "DIV:mode" -> selected rank ("ALL" default)
  // Sensible high→low ordering where we know it; unknown ranks fall to the end.
  var RANK_ORDER = [
    'Chief Inspector', 'Inspector', 'Sergeant', 'Constable',
    'Commander', 'Assistant Commander', 'Senior Operator', 'Operator', 'Officer',
  ];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function key(div, mode) { return div + ':' + mode; }
  function el(div, mode, part) { return document.getElementById('dq-' + div + '-' + (mode === 'review' ? 'rev' : 'act') + '-' + part); }

  function ranksOf(div, mode) {
    var seen = {}, out = [];
    (cache[key(div, mode)] || []).forEach(function (m) {
      var r = (m.rank || '').trim();
      if (r && !seen[r]) { seen[r] = 1; out.push(r); }
    });
    out.sort(function (a, b) {
      var ia = RANK_ORDER.indexOf(a); if (ia === -1) ia = 99;
      var ib = RANK_ORDER.indexOf(b); if (ib === -1) ib = 99;
      return ia - ib || a.localeCompare(b);
    });
    return out;
  }

  function renderTabs(div, mode) {
    var host = el(div, mode, 'tabs');
    if (!host) return;
    var ranks = ranksOf(div, mode);
    if (ranks.length < 2) { host.innerHTML = ''; return; }
    var cur = filter[key(div, mode)] || 'ALL';
    var opts = ["<option value='ALL'" + (cur === 'ALL' ? ' selected' : '') + '>All ranks</option>'];
    ranks.forEach(function (r) {
      opts.push("<option value='" + esc(r) + "'" + (cur === r ? ' selected' : '') + '>' + esc(r) + '</option>');
    });
    host.innerHTML = "<select class='form-control' style='padding:4px 8px;height:auto;font-size:12px;' title='Filter by rank tab' "
      + 'onchange="DivQuota.setFilter(\'' + div + "','" + mode + "',this.value)\">" + opts.join('') + '</select>';
  }

  function statusChip(m) {
    var q = m.quota || {};
    // "MET" on its own reads as the police service, not as a quota that was
    // met — say which.
    if (q.exempt) return "<span class='badge badge-approved' style='background:color-mix(in srgb,var(--purple,#9b6dff) 20%,transparent);color:var(--purple,#9b6dff);'><span class='badge-dot'></span>Quota exempt</span>";
    if (m.met === true)  return "<span class='badge badge-approved'><span class='badge-dot'></span>Quota met</span>";
    if (m.met === false) return "<span class='badge badge-pending'><span class='badge-dot'></span>Quota not met</span>";
    return "<span class='text-muted' style='font-size:12px;'>·</span>";
  }

  function rowsFor(div, mode) {
    var all = cache[key(div, mode)] || [];
    var f = filter[key(div, mode)] || 'ALL';
    var idxs = [];
    for (var i = 0; i < all.length; i++) {
      if (f !== 'ALL' && (all[i].rank || '').trim() !== f) continue;
      idxs.push(i);
    }
    // Show members in rank order (high → low); stable within a rank.
    var w = window.metRankWeight || function () { return 0; };
    idxs.sort(function (a, b) { return (w(all[a].rank) - w(all[b].rank)) || (a - b); });
    return idxs;
  }

  function render(div, mode) {
    var tbody = el(div, mode, 'tbody');
    if (!tbody) return;
    var all = cache[key(div, mode)] || [];
    var countEl = el(div, mode, 'count');
    var cols = mode === 'review' ? 7 : 6;
    if (!all.length) {
      var empty = window.metEmpty
        ? window.metEmpty({ icon: 'ti-users', title: 'No members found in the sheet.' })
        : "<span class='table-empty-text'>No members found in the sheet.</span>";
      tbody.innerHTML = "<tr><td colspan='" + cols + "' class='table-empty'>" + empty + '</td></tr>';
      if (countEl) countEl.textContent = '';
      return;
    }
    var idxs = rowsFor(div, mode);
    var f = filter[key(div, mode)] || 'ALL';
    if (countEl) countEl.textContent = f === 'ALL' ? (all.length + ' members') : (idxs.length + ' / ' + all.length + ' members');
    if (!idxs.length) {
      tbody.innerHTML = "<tr><td colspan='" + cols + "' class='table-empty'><span class='table-empty-text'>No members on this rank tab.</span></td></tr>";
      return;
    }
    tbody.innerHTML = idxs.map(function (i) {
      var m = all[i], q = m.quota || {};
      var exempt = !!q.exempt;
      var target = exempt ? 'EX' : (q.target != null ? q.target : '·');
      var ptColor = exempt ? 'var(--purple,#9b6dff)' : (m.met ? 'var(--green,#22c55e)' : 'var(--amber,#e8842a)');
      var base = "<td><span style='font-weight:600;font-size:12px;'>" + esc(m.username) + '</span></td>'
        + "<td><span style='font-size:12px;'>" + esc(m.rank || '·') + '</span></td>'
        + "<td><span class='text-muted' style='font-size:11px;'>" + esc(q.tier || '') + '</span></td>'
        + "<td><span style='font-weight:700;color:" + ptColor + ";'>" + (exempt ? 'EX' : m.total) + '</span></td>'
        + "<td><span class='mono' style='font-size:12px;'>" + target + '</span></td>';
      if (mode !== 'review') return '<tr>' + base + '<td>' + statusChip(m) + '</td></tr>';
      if (!m._status) m._status = exempt ? 'exempt' : (m.met === true ? 'pass' : 'fail');
      var s = m._status;
      var sel = "<select class='form-control' style='padding:4px 8px;height:auto;font-size:12px;' onchange=\"DivQuota.setStatus('" + div + "'," + i + ",this.value)\">"
        + "<option value='pass'"   + (s === 'pass'   ? ' selected' : '') + '>Pass</option>'
        + "<option value='fail'"   + (s === 'fail'   ? ' selected' : '') + '>Fail</option>'
        + "<option value='exempt'" + (s === 'exempt' ? ' selected' : '') + '>Exempt</option>'
        + "<option value='loa'"    + (s === 'loa'    ? ' selected' : '') + '>Leave of Absence</option></select>';
      var reason = "<input type='text' class='form-control' style='padding:4px 8px;height:auto;font-size:12px;" + (s === 'fail' ? '' : 'display:none;')
        + "' id='dq-" + div + "-reason-" + i + "' placeholder='Reason…' value='" + esc(m._reason || '')
        + "' oninput=\"DivQuota.setReason('" + div + "'," + i + ",this.value)\" />";
      return '<tr>' + base + '<td>' + sel + '</td><td>' + reason + '</td></tr>';
    }).join('');
  }

  async function load(div, mode) {
    var tbody = el(div, mode, 'tbody');
    if (!tbody) return;
    var cols = mode === 'review' ? 7 : 6;
    tbody.innerHTML = "<tr><td colspan='" + cols + "' class='table-loading'><div class='spinner'></div></td></tr>";
    try {
      var d = await api('/api/divquota/' + div + '/members');
      if (!d || !d.configured) {
        cache[key(div, mode)] = [];
        var cfg = window.metEmpty
          ? window.metEmpty({ icon: 'ti-alert-triangle', title: 'Quota sheet not configured', sub: 'Read access needs the ' + div + ' sheet id and its webhook or service account.' })
          : "<span class='table-empty-text'>Quota sheet read access isn't configured for " + div + '.</span>';
        tbody.innerHTML = "<tr><td colspan='" + cols + "' class='table-empty'>" + cfg + '</td></tr>';
        return;
      }
      cache[key(div, mode)] = d.members || [];
      renderTabs(div, mode);
      render(div, mode);
    } catch (e) {
      tbody.innerHTML = "<tr><td colspan='" + cols + "' class='table-empty'><span class='table-empty-text'>Failed to load quota data.</span></td></tr>";
    }
  }

  // A clear banner that COVERS the points/target when a member is exempt or on
  // Leave of Absence — so they never see a misleading "0 / target".
  function dqExemptBanner(kind, rank) {
    var loa = kind === 'LOA';
    var bought = kind === 'PURCHASED';
    var color = loa ? 'var(--blue,#4a8fff)' : 'var(--purple,#9b6dff)';
    var icon = loa ? 'ti-calendar-off' : 'ti-shield-check';
    var label = loa ? 'Leave of Absence' : bought ? 'Quota Exempt' : 'Exempt';
    var sub = loa ? "You're on leave · there's no weekly quota to meet."
      : bought ? 'You bought Quota Exempt, so the weekly quota does not apply to you.'
      : "You're exempt from the weekly quota.";
    return "<div class='profile-section'><div style='display:flex;align-items:center;gap:15px;padding:18px 16px;border-radius:12px;"
      + "background:color-mix(in srgb," + color + " 12%,transparent);border:1px solid color-mix(in srgb," + color + " 42%,transparent);'>"
      + "<div style='font-size:32px;color:" + color + ";line-height:1;flex:0 0 auto;'><i class='ti " + icon + "'></i></div>"
      + "<div style='min-width:0;'><div style='font-size:19px;font-weight:800;color:" + color + ";text-transform:uppercase;letter-spacing:.04em;'>" + label + "</div>"
      + "<div style='font-size:12px;color:var(--text-muted);margin-top:3px;'><strong style='color:var(--text);'>" + esc(rank) + "</strong> · " + sub + "</div></div></div></div>";
  }
  // The Mon–Sun activity breakdown grid.
  function dqDayGrid(days) {
    if (!days) return '';
    var order = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    return "<div style='display:flex;gap:8px;flex-wrap:wrap;margin-top:16px;'>" + order.map(function (day) {
      var v = days[day]; if (v == null) v = 0;
      return "<div style='flex:1;min-width:58px;text-align:center;background:rgba(255,255,255,0.03);border:1px solid var(--border-dim);border-radius:7px;padding:8px 4px;'>"
        + "<div style='font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;'>" + day + "</div>"
        + "<div style='font-size:18px;font-weight:700;margin-top:2px;'>" + esc(String(v)) + "</div></div>";
    }).join('') + "</div>";
  }

  // The signed-in member's own weekly quota card: points + progression bar + the
  // Mon–Sun day breakdown; or a clear Exempt / Leave of Absence banner instead.
  // Renders into `hostId`; hides it when the member isn't on the sheet.
  async function loadMyQuota(div, hostId) {
    var host = document.getElementById(hostId);
    if (!host) return;
    var d;
    try { d = await api('/api/divquota/' + div + '/me'); }
    catch (e) { host.style.display = 'none'; return; }
    if (!d || !d.configured || !d.found) { host.style.display = 'none'; return; }
    host.style.display = '';
    var rank = esc(d.rank || 'Member');
    if (d.exempt) {
      var hc = (d.exemptKind === 'LOA') ? 'var(--blue,#4a8fff)' : 'var(--purple,#9b6dff)';
      host.innerHTML =
        "<div class='panel-header'><div class='panel-title'><span class='panel-dot' style='background:" + hc + ";'></span>My Weekly Quota</div>"
        + "<span class='text-muted mono' style='font-size:11px;'>" + rank + "</span></div>"
        + dqExemptBanner(d.exemptKind || 'EXEMPT', d.rank || 'Member');
      return;
    }
    var hasTarget = d.target != null;
    var met = d.met === true;
    var col = met ? 'var(--green,#22c55e)' : 'var(--amber,#e8842a)';
    var pct = hasTarget && d.target > 0 ? Math.min(100, Math.round((d.total / d.target) * 100)) : (met ? 100 : 0);
    var bar = hasTarget
      ? "<div style='flex:1;min-width:180px;'>"
        + "<div style='height:10px;border-radius:6px;background:var(--hover,rgba(255,255,255,.08));overflow:hidden;'>"
        + "<div style='height:100%;width:" + pct + "%;background:" + col + ";border-radius:6px;transition:width .4s;'></div></div>"
        + "<div style='font-size:11px;color:var(--text-muted);margin-top:6px;'>" + (met
            ? "Quota met · nice work."
            : (d.remaining + " more point" + (d.remaining === 1 ? '' : 's') + " to go this week."))
        + "</div></div>"
      : "<div style='font-size:13px;color:var(--text-muted);flex:1;min-width:160px;'>No target set for your rank · points are still tracked.</div>";
    host.innerHTML =
      "<div class='panel-header'><div class='panel-title'><span class='panel-dot' style='background:var(--dc,#4a8fff);'></span>My Weekly Quota</div>"
      + "<span class='text-muted mono' style='font-size:11px;'>" + rank + "</span></div>"
      + "<div class='profile-section'>"
      + "<div style='display:flex;gap:18px;align-items:center;flex-wrap:wrap;'>"
      + statCell(d.total, 'Points this week', col)
      + statCell(hasTarget ? d.target : '·', 'Target')
      + bar
      + "</div>"
      + dqDayGrid(d.days)
      + "</div>";
    // Quota-met flourish — once per division, re-armed when the week resets.
    try {
      if (window.metBrandMoment) {
        var qflag = 'metQuotaMet_' + div;
        if (hasTarget && met) {
          if (!localStorage.getItem(qflag)) {
            localStorage.setItem(qflag, '1');
            setTimeout(function () { metBrandMoment({ icon: 'ti-checklist', variant: 'celebrate', title: 'Quota Met', tagline: div + ' weekly quota complete', autoMs: 2600 }); }, 2600);
          }
        } else if (hasTarget && !met) {
          localStorage.removeItem(qflag);
        }
      }
    } catch (e) { /* cosmetic */ }
  }
  function statCell(num, lbl, color) {
    return "<div style='text-align:center;min-width:74px;'>"
      + "<div style='font-size:26px;font-weight:800;line-height:1;" + (color ? 'color:' + color + ';' : '') + "'>" + num + "</div>"
      + "<div style='font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;margin-top:5px;'>" + lbl + "</div></div>";
  }

  window.DivQuota = {
    loadActivity: function (div) { return load(div, 'activity'); },
    loadReview:   function (div) { return load(div, 'review'); },
    loadMyQuota:  loadMyQuota,
    setFilter: function (div, mode, val) { filter[key(div, mode)] = val || 'ALL'; render(div, mode); },
    setReason: function (div, i, val) { var m = (cache[key(div, 'review')] || [])[i]; if (m) m._reason = val; },
    async setStatus(div, i, val) {
      var list = cache[key(div, 'review')] || [], m = list[i];
      if (!m) return;
      if (val === 'exempt' || val === 'loa') {
        var isLoa = val === 'loa';
        var ok = await uiConfirm('Mark ' + m.username + ' as ' + (isLoa ? 'Leave of Absence' : 'EXEMPT') + '? This writes "' + (isLoa ? 'LOA' : 'EX') + '" to their day cells on the ' + div + ' sheet.');
        if (!ok) { render(div, 'review'); return; }
        try {
          await api('/api/divquota/' + div + '/' + (isLoa ? 'loa' : 'exempt'), { method: 'POST', body: JSON.stringify({ username: m.username }) });
          if (!m.quota) m.quota = {}; m.quota.exempt = true; m._status = val;
          showToast(m.username + ' set to ' + (isLoa ? 'Leave of Absence' : 'exempt') + '.', 'success');
        } catch (err) { showToast(err.message || 'Failed.', 'error'); m._status = m.met === true ? 'pass' : 'fail'; }
        render(div, 'review');
        return;
      }
      m._status = val;
      var rin = document.getElementById('dq-' + div + '-reason-' + i);
      if (rin) rin.style.display = val === 'fail' ? '' : 'none';
    },
    auto: function (div) {
      (cache[key(div, 'review')] || []).forEach(function (m) {
        m._status = (m.quota && m.quota.exempt) ? 'exempt' : (m.met === true ? 'pass' : 'fail');
      });
      render(div, 'review');
      showToast('Decisions set from quota targets.', 'info');
    },
    async submit(div) {
      var list = cache[key(div, 'review')] || [];
      if (!list.length) { showToast('Nothing to submit.', 'error'); return; }
      var results = list.map(function (m) {
        var exempt = (m._status === 'exempt') || (m._status === 'loa') || !!(m.quota && m.quota.exempt);
        return {
          username: m.username, rank: m.rank, exempt: exempt,
          total: exempt ? null : m.total,
          target: exempt ? null : (m.quota ? m.quota.target : null),
          status: exempt ? 'exempt' : (m._status === 'fail' ? 'fail' : (m._status === 'pass' ? 'pass' : (m.met === true ? 'pass' : 'fail'))),
          reason: m._status === 'fail' ? (m._reason || '') : '',
        };
      });
      try {
        await api('/api/divquota/' + div + '/check', { method: 'POST', body: JSON.stringify({ results: results }) });
        showToast(div + ' quota review posted to Discord.', 'success');
      } catch (err) { showToast(err.message || 'Failed to post quota review.', 'error'); }
    },
    async reset(div) {
      if (!(await uiConfirm("Reset EVERYONE's " + div + ' quota points to 0? This is destructive and cannot be undone.'))) return;
      try {
        var d = await api('/api/divquota/' + div + '/reset', { method: 'POST' });
        showToast('All ' + div + ' quota points reset to 0' + (d && d.cleared != null ? ' (' + d.cleared + ' cells)' : '') + '.', 'success');
        load(div, 'review');
      } catch (err) { showToast(err.message || 'Failed to reset quota.', 'error'); }
    },
  };
})();
