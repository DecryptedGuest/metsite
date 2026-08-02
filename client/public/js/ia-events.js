/* client/public/js/ia-events.js — Internal Affairs event logs.

   Filing an event pays every name on the roll immediately. There is no review
   step, so the form's job is to make the roll obvious BEFORE it is submitted:
   the pasted text is parsed live into a list of chips showing exactly who will
   be paid, what was ignored as a duplicate, and what it comes to in points.
   Nobody should discover who they paid by reading the quota sheet afterwards. */
(function () {
  var esc = window.escapeHtml || function (s) { return String(s == null ? '' : s); };
  var $ = function (id) { return document.getElementById(id); };

  var META  = { eventTypes: [], pointsEach: 2, maxAttendees: 60 };
  var cache = [];
  var scope = 'all';
  var query = '';

  // ── Parsing the roll ────────────────────────────────────────────
  // The same rules as the server, so what the form promises is what happens.
  // A line can be a mention, a bare snowflake, a plain name, or a Discord
  // nickname like "CSUP | someone" — people paste whatever is in front of them.
  function parseRoll(text) {
    var lines = String(text || '').split(/[\n,]+/);
    var out = [], seen = {}, dupes = 0;
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i].trim();
      if (!raw) continue;

      var discordId = null, name = raw;
      var mention = /^<@!?(\d{15,21})>$/.exec(raw);
      if (mention) { discordId = mention[1]; name = ''; }
      else if (/^\d{15,21}$/.test(raw)) { discordId = raw; name = ''; }

      if (name.indexOf('|') !== -1) {
        var tail = name.split('|').pop().trim();
        if (tail) name = tail;
      }
      name = name.replace(/^@/, '').trim();
      if (!discordId && !name) continue;

      var key = discordId ? 'd:' + discordId : 'n:' + name.toLowerCase();
      if (seen[key]) { dupes++; continue; }
      seen[key] = 1;
      out.push({ discordId: discordId, name: name || null, key: key });
      if (out.length >= META.maxAttendees) break;
    }
    return { roll: out, dupes: dupes, over: lines.filter(function (l) { return l.trim(); }).length > META.maxAttendees };
  }

  function renderRoll() {
    var box = $('ev-roll');
    if (!box) return;
    var parsed = parseRoll($('ev-attendees') ? $('ev-attendees').value : '');
    if (!parsed.roll.length) {
      box.innerHTML = '<span class="ev-roll-empty">Nobody on the roll yet — nobody gets paid.</span>';
      return;
    }
    var chips = parsed.roll.map(function (a) {
      var label = a.name || ('ID ' + a.discordId);
      return '<span class="ev-chip' + (a.discordId ? ' ev-chip-id' : '') + '"'
        + ' title="' + esc(a.discordId ? 'Discord ' + a.discordId : 'Matched by name — an ID is more reliable') + '">'
        + '<i class="ti ti-' + (a.discordId ? 'user-check' : 'user') + '"></i>' + esc(label) + '</span>';
    }).join('');
    var total = parsed.roll.length * META.pointsEach;
    box.innerHTML = '<div class="ev-roll-head">'
      + '<strong>' + parsed.roll.length + '</strong> attendee' + (parsed.roll.length === 1 ? '' : 's')
      + ' · <strong>' + total + '</strong> point' + (total === 1 ? '' : 's') + ' will be awarded'
      + (parsed.dupes ? ' · <span class="ev-roll-note">' + parsed.dupes + ' duplicate' + (parsed.dupes === 1 ? '' : 's') + ' ignored</span>' : '')
      + (parsed.over ? ' · <span class="ev-roll-warn">only the first ' + META.maxAttendees + ' are counted</span>' : '')
      + '</div><div class="ev-chips">' + chips + '</div>';
  }

  // ── The list ────────────────────────────────────────────────────
  function matches(e, q) {
    if (!q) return true;
    var names = (Array.isArray(e.attendees) ? e.attendees : [])
      .map(function (a) { return a && (a.name || a.discordId); }).filter(Boolean).join(' ');
    return [e.eventRef, e.eventType, e.title, e.hostName, e.coHostName, names]
      .filter(Boolean).join(' ').toLowerCase().indexOf(q.toLowerCase()) >= 0;
  }

  function rowHtml(e) {
    var when = window.formatDateTime ? formatDateTime(e.startedAt) : new Date(e.startedAt).toLocaleString();
    var paid = (e.attendeeCount || 0) * (e.pointsEach || 0);
    return '<tr class="' + (e.voidedAt ? 'ev-void' : '') + '">'
      + '<td><span class="case-ref">' + esc(e.eventRef) + '</span></td>'
      + '<td><span style="font-size:12.5px;">' + esc(e.eventType)
        + (e.title ? '<br><span class="text-muted" style="font-size:11px;">' + esc(e.title) + '</span>' : '')
        + '</span></td>'
      + '<td><span style="font-size:12px;">' + esc(e.hostName || '—')
        + (e.coHostName ? ' <span class="text-muted">+ ' + esc(e.coHostName) + '</span>' : '') + '</span></td>'
      + '<td><span style="font-size:12px;">' + (e.attendeeCount || 0) + '</span></td>'
      + '<td>' + (e.voidedAt
          ? '<span class="badge badge-muted"><span class="badge-dot"></span>Withdrawn</span>'
          : '<span class="badge badge-approved"><span class="badge-dot"></span>' + paid + ' paid</span>') + '</td>'
      + '<td><span class="date-cell">' + esc(when) + '</span></td>'
      + '<td>' + (window.canVoidEvents && !e.voidedAt
          ? '<button class="row-btn row-btn-deny" onclick="iaEventVoid(\'' + esc(e.id) + '\')" title="Withdraw and reverse the points">'
            + '<i class="ti ti-arrow-back-up"></i></button>'
          : '') + '</td>'
      + '</tr>';
  }

  function render() {
    var tbody = $('ev-tbody');
    if (!tbody) return;
    var rows = cache.filter(function (e) { return matches(e, query); });
    var count = $('ev-count');
    if (count) count.textContent = rows.length + ' of ' + cache.length + ' shown';
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="table-empty-text" style="padding:14px;">'
        + (cache.length ? 'No events match that search.'
                        : 'No events logged yet — press “Log an event” after you run one.')
        + '</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(rowHtml).join('');
  }

  async function load() {
    var tbody = $('ev-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="7" class="table-loading"><div class="spinner"></div></td></tr>';
    try {
      cache = (await api('/api/ia-events' + (scope === 'mine' ? '?scope=mine' : ''))) || [];
      render();
    } catch (err) {
      tbody.innerHTML = '<tr><td colspan="7" class="table-empty-text" style="padding:14px;">'
        + esc(err.message || 'Failed to load the event log.') + '</td></tr>';
    }
  }

  // ── Filing one ──────────────────────────────────────────────────
  function openForm() {
    var sel = $('ev-type');
    if (sel && !sel.options.length) {
      sel.innerHTML = META.eventTypes.map(function (t) {
        return '<option value="' + esc(t) + '">' + esc(t) + '</option>';
      }).join('');
    }
    var note = $('ev-points-note');
    if (note) note.textContent = META.pointsEach + ' point' + (META.pointsEach === 1 ? '' : 's');

    // Default the start to now, rounded down to the minute — an event is
    // logged after it happens, so "now" is nearly always right.
    var started = $('ev-started');
    if (started && !started.value) {
      var d = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
      started.value = d.toISOString().slice(0, 16);
    }
    renderRoll();
    openModal('modal-event');
  }

  async function submit() {
    var btn = $('btn-submit-event');
    var parsed = parseRoll($('ev-attendees').value);
    if (!parsed.roll.length) { showToast('Add at least one attendee — the roll is what gets paid.', 'error'); return; }

    var total = parsed.roll.length * META.pointsEach;
    var okd = await (typeof uiConfirm === 'function'
      ? uiConfirm('File this event?\n\n' + parsed.roll.length + ' attendee(s) will each be awarded '
        + META.pointsEach + ' quota point(s) — ' + total + ' in total — immediately. '
        + 'There is no approval step; withdrawing it afterwards is High Command\'s.')
      : Promise.resolve(confirm('Pay ' + parsed.roll.length + ' attendee(s) ' + total + ' points in total?')));
    if (!okd) return;

    var original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner"></div> Filing…';
    try {
      var body = {
        eventType:    $('ev-type').value,
        title:        $('ev-title').value.trim(),
        coHostName:   $('ev-cohost').value.trim(),
        startedAt:    $('ev-started').value ? new Date($('ev-started').value).toISOString() : null,
        durationMins: $('ev-duration').value === '' ? null : parseInt($('ev-duration').value, 10),
        notes:        $('ev-notes').value.trim(),
        attendees:    parsed.roll.map(function (a) { return { discordId: a.discordId, name: a.name }; }),
        proof:        $('ev-proof').value.split(/\s+/).map(function (s) { return s.trim(); }).filter(Boolean),
      };
      var out = await api('/api/ia-events', { method: 'POST', body: JSON.stringify(body) });
      closeModal('modal-event');
      showToast(out.event.eventRef + ' filed — ' + out.awarded + ' attendee(s) paid '
        + out.pointsEach + ' point(s) each.'
        + (out.selfRemoved ? ' You were taken off your own roll.' : ''), 'success');
      ['ev-title', 'ev-cohost', 'ev-duration', 'ev-attendees', 'ev-proof', 'ev-notes'].forEach(function (id) {
        var el = $(id); if (el) el.value = '';
      });
      renderRoll();
      load();
      if (typeof loadStats === 'function') loadStats();
    } catch (err) {
      showToast(err.message || 'Failed to file the event.', 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = original;
    }
  }

  window.iaEventVoid = async function (id) {
    var why = await (typeof uiPrompt === 'function'
      ? uiPrompt('Withdraw this event?\n\nEvery attendee\'s points are reversed. Say why:')
      : Promise.resolve(prompt('Why is this event being withdrawn?')));
    if (why === null || why === false) return;
    try {
      var out = await api('/api/ia-events/' + encodeURIComponent(id) + '/void',
        { method: 'POST', body: JSON.stringify({ reason: why }) });
      showToast('Withdrawn — ' + out.reversed + ' award(s) reversed.', 'success');
      load();
    } catch (err) {
      showToast(err.message || 'Could not withdraw that event.', 'error');
    }
  };

  function wire() {
    var nb = $('btn-new-event'); if (nb) nb.addEventListener('click', openForm);
    var sb = $('btn-submit-event'); if (sb) sb.addEventListener('click', submit);
    var at = $('ev-attendees'); if (at) at.addEventListener('input', renderRoll);
    var q  = $('ev-search'); if (q) q.addEventListener('input', function () { query = q.value.trim(); render(); });
    var tabs = $('ev-scope-tabs');
    if (tabs) tabs.addEventListener('click', function (e) {
      var b = e.target.closest('.filter-tab');
      if (!b) return;
      tabs.querySelectorAll('.filter-tab').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
      scope = b.dataset.evscope || 'all';
      load();
    });
  }

  // Called by the dashboard router when the Event Logs tab is opened.
  window.loadIaEvents = async function () {
    if (!window._ievWired) { wire(); window._ievWired = true; }
    if (!META.eventTypes.length) {
      try { META = Object.assign(META, await api('/api/ia-events/meta')); } catch (e) { /* defaults */ }
    }
    load();
  };
})();
