/* client/public/js/ia-events.js — Internal Affairs event logs.

   Filing an event pays every attendee immediately. There is no review step, so
   the form's job is to make the log obvious BEFORE it is submitted: what is
   typed is parsed live into a list of chips showing exactly who will be paid,
   what was ignored as a duplicate, and what it comes to. Nobody should discover
   who they paid by reading the quota sheet afterwards. */
(function () {
  var esc = window.escapeHtml || function (s) { return String(s == null ? '' : s); };
  var $ = function (id) { return document.getElementById(id); };

  var META  = { eventTypes: [], pointsEach: 2, xpEach: 2, maxAttendees: 60, maxProof: 10, maxProofMb: 6 };
  var cache = [];
  var scope = 'all';
  var query = '';

  // People picked from the suggestion list, keyed by the exact line text that
  // was written for them. A picked person carries their Discord id, which is
  // what both the quota award and the XP award are keyed on — a typed name is
  // only as reliable as its spelling. The line stays human-readable; the id
  // rides along here rather than being stuffed into the textarea.
  var picked = {};          // lowercased line text → { discordId, name }
  var suggestTimer = null;
  var suggestions = [];
  var sugIndex = -1;
  var sugToken = null;      // { start, end, text } — the line being typed

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

      // Somebody chosen from the picker: their id is already known, so the
      // spelling of the line stops mattering.
      var hit = picked[raw.toLowerCase()];
      if (hit) { discordId = hit.discordId; name = hit.name || ''; }

      var mention = /^<@!?(\d{15,21})>$/.exec(raw);
      if (!discordId && mention) { discordId = mention[1]; name = ''; }
      else if (!discordId && /^\d{15,21}$/.test(raw)) { discordId = raw; name = ''; }

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

  // ── The attendee picker ─────────────────────────────────────────
  // Typing in the roll box searches everybody who has signed in, the way a
  // Discord mention does. The line under the caret is the query; picking a
  // result rewrites that line and records the person's Discord id.

  // The line the caret is currently in.
  function tokenAt(ta) {
    var v = ta.value, c = ta.selectionStart;
    var start = v.lastIndexOf('\n', c - 1) + 1;
    var end = v.indexOf('\n', c);
    if (end < 0) end = v.length;
    return { start: start, end: end, text: v.slice(start, end).trim() };
  }

  function hideSuggest() {
    var box = $('ev-suggest');
    if (box) { box.style.display = 'none'; box.innerHTML = ''; }
    suggestions = []; sugIndex = -1; sugToken = null;
  }

  function drawSuggest() {
    var box = $('ev-suggest');
    if (!box) return;
    if (!suggestions.length) {
      box.innerHTML = '<div class="ev-sug-empty">Nobody matches that — you can still type the name in full.</div>';
      box.style.display = '';
      return;
    }
    box.innerHTML = suggestions.map(function (p, i) {
      var sub = [p.discordUsername && '@' + p.discordUsername, p.robloxUsername, p.role]
        .filter(Boolean).join(' · ');
      var av = p.avatar
        ? '<img class="ev-sug-av" src="' + esc(p.avatar) + '" alt="" onerror="this.style.display=\'none\'" />'
        : '<span class="ev-sug-av ev-sug-av-fallback"><i class="ti ti-user"></i></span>';
      return '<div class="ev-sug' + (i === sugIndex ? ' active' : '') + '" role="option"'
        + ' data-i="' + i + '">' + av
        + '<span class="ev-sug-main">'
        + '<span class="ev-sug-name">' + esc(p.name) + '</span>'
        + (sub ? '<span class="ev-sug-sub">' + esc(sub) + '</span>' : '')
        + '</span>'
        + (i === sugIndex ? '<span class="ev-sug-hint">Enter</span>' : '')
        + '</div>';
    }).join('');
    box.style.display = '';
  }

  // Put the chosen person on the line the caret was in, and remember their id.
  function choose(i) {
    var p = suggestions[i];
    var ta = $('ev-attendees');
    if (!p || !ta || !sugToken) return;
    var line = p.name;
    picked[line.toLowerCase()] = { discordId: p.discordId, name: p.name };
    var before = ta.value.slice(0, sugToken.start);
    var after  = ta.value.slice(sugToken.end);
    // A newline after them, so the next name can just be typed.
    var insert = line + (after.charAt(0) === '\n' ? '' : '\n');
    ta.value = before + insert + after;
    var caret = (before + insert).length;
    ta.focus();
    ta.setSelectionRange(caret, caret);
    hideSuggest();
    renderRoll();
  }

  async function runSearch(q) {
    try {
      var rows = await api('/api/ia-events/people?q=' + encodeURIComponent(q));
      // The answer to a query the user has already moved on from is noise.
      var ta = $('ev-attendees');
      if (!ta || tokenAt(ta).text !== q) return;
      // Don't offer somebody already on the roll.
      var already = {};
      parseRoll(ta.value).roll.forEach(function (a) { if (a.discordId) already[a.discordId] = 1; });
      suggestions = (rows || []).filter(function (p) { return !already[p.discordId]; });
      sugIndex = suggestions.length ? 0 : -1;
      sugToken = tokenAt(ta);
      drawSuggest();
    } catch (e) { hideSuggest(); }
  }

  function onRollInput() {
    var ta = $('ev-attendees');
    if (!ta) return;
    renderRoll();
    var tok = tokenAt(ta);
    clearTimeout(suggestTimer);
    // A line that is already a bare id or a mention needs no picker — it is
    // unambiguous as typed.
    if (tok.text.length < 2 || /^<@!?\d{15,21}>$/.test(tok.text)) { hideSuggest(); return; }
    suggestTimer = setTimeout(function () { runSearch(tok.text); }, 160);
  }

  function onRollKey(ev) {
    if (!suggestions.length && ev.key !== 'Escape') return;
    if (ev.key === 'ArrowDown') { ev.preventDefault(); sugIndex = (sugIndex + 1) % suggestions.length; drawSuggest(); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); sugIndex = (sugIndex - 1 + suggestions.length) % suggestions.length; drawSuggest(); }
    else if (ev.key === 'Enter' || ev.key === 'Tab') {
      if (sugIndex >= 0) { ev.preventDefault(); choose(sugIndex); }
    } else if (ev.key === 'Escape') { hideSuggest(); }
  }

  // ── Proof ───────────────────────────────────────────────────────
  // Screenshots, uploaded. A link to somebody else's host stops being evidence
  // the day that host expires.
  var shots = [];

  function drawShots() {
    var box = $('ev-proof-shots');
    if (!box) return;
    box.innerHTML = shots.map(function (src, i) {
      return '<div class="ev-shot"><img src="' + esc(src) + '" alt="proof ' + (i + 1) + '" />'
        + '<button type="button" class="ev-shot-x" title="Remove" data-shot="' + i + '">&#x2715;</button></div>';
    }).join('');
    var hint = $('ev-proof-hint');
    if (hint) {
      hint.textContent = shots.length
        ? shots.length + ' of ' + META.maxProof + ' attached'
        : 'PNG, JPG, GIF or WEBP · up to ' + META.maxProof + ' images, ' + META.maxProofMb + ' MB each';
    }
  }

  function addFiles(files) {
    var list = Array.prototype.slice.call(files || []);
    var rejected = 0;
    list.forEach(function (f) {
      if (!f || !/^image\//.test(f.type)) { rejected++; return; }
      if (shots.length >= META.maxProof) { rejected++; return; }
      if (f.size > META.maxProofMb * 1024 * 1024) { rejected++; return; }
      var r = new FileReader();
      r.onload = function () { shots.push(r.result); drawShots(); };
      r.readAsDataURL(f);
    });
    if (rejected && window.showToast) {
      showToast(rejected + ' file(s) skipped — images only, up to ' + META.maxProof
        + ' of them, ' + META.maxProofMb + ' MB each.', 'warning');
    }
  }

  function wireProof() {
    var drop = $('ev-drop'), input = $('ev-proof-input'), browse = $('ev-proof-browse');
    if (!drop || drop.dataset.wired) return;
    drop.dataset.wired = '1';
    if (browse) browse.addEventListener('click', function () { input.click(); });
    drop.addEventListener('click', function (ev) {
      if (ev.target === browse) return;
      input.click();
    });
    if (input) input.addEventListener('change', function () { addFiles(input.files); input.value = ''; });
    ['dragenter', 'dragover'].forEach(function (t) {
      drop.addEventListener(t, function (ev) { ev.preventDefault(); drop.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (t) {
      drop.addEventListener(t, function (ev) { ev.preventDefault(); drop.classList.remove('over'); });
    });
    drop.addEventListener('drop', function (ev) { addFiles(ev.dataTransfer && ev.dataTransfer.files); });
    // Pasting a screenshot straight in is how most of these arrive.
    var modal = $('modal-event');
    if (modal) modal.addEventListener('paste', function (ev) {
      var items = (ev.clipboardData && ev.clipboardData.files) || null;
      if (items && items.length) { ev.preventDefault(); addFiles(items); }
    });
    var shotBox = $('ev-proof-shots');
    if (shotBox) shotBox.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-shot]');
      if (!b) return;
      shots.splice(parseInt(b.dataset.shot, 10), 1);
      drawShots();
    });
  }

  // ── Duration ────────────────────────────────────────────────────
  // Never typed. A duration entered separately from the times is a duration
  // that eventually disagrees with them, and the one somebody reads back is
  // whichever the code happened to trust.
  function durationMins() {
    var a = $('ev-started'), b = $('ev-ended');
    if (!a || !b || !a.value || !b.value) return null;
    var ms = new Date(b.value).getTime() - new Date(a.value).getTime();
    if (!isFinite(ms)) return null;
    return Math.round(ms / 60000);
  }

  function updateDuration() {
    var box = $('ev-duration');
    if (!box) return;
    var mins = durationMins();
    if (mins == null) { box.value = ''; box.style.color = ''; return; }
    if (mins < 0)     { box.value = 'Ends before it starts'; box.style.color = 'var(--red)'; return; }
    if (mins > 1440)  { box.value = 'Longer than a day'; box.style.color = 'var(--red)'; return; }
    box.style.color = '';
    var h = Math.floor(mins / 60), m = mins % 60;
    box.value = mins === 0 ? 'Under a minute'
      : (h ? h + 'h' + (m ? ' ' + m + 'm' : '') : m + 'm');
  }

  function renderRoll() {
    var box = $('ev-roll');
    if (!box) return;
    var parsed = parseRoll($('ev-attendees') ? $('ev-attendees').value : '');
    if (!parsed.roll.length) {
      box.innerHTML = '<span class="ev-roll-empty">No attendees yet — nobody gets paid.</span>';
      return;
    }
    var chips = parsed.roll.map(function (a) {
      var label = a.name || ('ID ' + a.discordId);
      return '<span class="ev-chip' + (a.discordId ? ' ev-chip-id' : '') + '"'
        + ' title="' + esc(a.discordId ? 'Discord ' + a.discordId : 'Matched by name — an ID is more reliable') + '">'
        + '<i class="ti ti-' + (a.discordId ? 'user-check' : 'user') + '"></i>' + esc(label) + '</span>';
    }).join('');
    var total = parsed.roll.length * META.pointsEach;
    var totalXp = parsed.roll.length * META.xpEach;
    // Attending pays on both systems, so the roll says both totals rather than
    // leaving the XP to be discovered after the fact.
    var noId = parsed.roll.filter(function (a) { return !a.discordId; }).length;
    box.innerHTML = '<div class="ev-roll-head">'
      + '<strong>' + parsed.roll.length + '</strong> attendee' + (parsed.roll.length === 1 ? '' : 's')
      + ' · <strong>' + total + '</strong> quota point' + (total === 1 ? '' : 's')
      + (META.xpEach ? ' · <strong>' + totalXp + '</strong> MET XP' : '') + ' will be awarded'
      + (META.xpEach && noId ? ' · <span class="ev-roll-warn">' + noId
          + ' with no Discord ID — no MET XP</span>' : '')
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
    var paidXp = (e.attendeeCount || 0) * (e.xpEach || 0);
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
          : '<span class="badge badge-approved"><span class="badge-dot"></span>' + paid + ' pts'
            + (paidXp ? ' · ' + paidXp + ' MET XP' : '') + '</span>') + '</td>'
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
    if (note) {
      note.textContent = META.pointsEach + ' quota point' + (META.pointsEach === 1 ? '' : 's')
        + (META.xpEach ? ' and ' + META.xpEach + ' MET XP' : '');
    }

    // An event is logged after it happens, so the useful default is "it ended
    // just now and ran for about an hour". Both are editable; the duration
    // follows them.
    var local = function (ms) {
      return new Date(ms - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    };
    var started = $('ev-started'), ended = $('ev-ended');
    if (ended && !ended.value)   ended.value   = local(Date.now());
    if (started && !started.value) started.value = local(Date.now() - 3600000);
    updateDuration();
    ['ev-started', 'ev-ended'].forEach(function (id) {
      var el = $(id);
      if (el && !el.dataset.wired) { el.dataset.wired = '1'; el.addEventListener('input', updateDuration); }
    });
    wireProof();
    drawShots();
    hideSuggest();
    renderRoll();
    openModal('modal-event');
  }

  async function submit() {
    var btn = $('btn-submit-event');
    var parsed = parseRoll($('ev-attendees').value);
    if (!parsed.roll.length) { showToast('Add at least one attendee.', 'error'); return; }
    var mins = durationMins();
    if (mins == null)  { showToast('Say when the event started and ended.', 'error'); return; }
    if (mins < 0)      { showToast('The end time is before the start time.', 'error'); return; }
    if (mins > 1440)   { showToast('An event cannot run longer than a day.', 'error'); return; }

    var total = parsed.roll.length * META.pointsEach;
    var totalXp = parsed.roll.length * META.xpEach;
    var okd = await (typeof uiConfirm === 'function'
      ? uiConfirm('Submit this event log?\n\n' + parsed.roll.length + ' attendee(s) will each get '
        + META.pointsEach + ' quota point(s)'
        + (META.xpEach ? ' and ' + META.xpEach + ' MET XP' : '') + ' — '
        + total + ' point(s)' + (META.xpEach ? ' and ' + totalXp + ' MET XP' : '')
        + ' in total.')
      : Promise.resolve(confirm('Pay ' + parsed.roll.length + ' attendee(s) ' + total + ' points in total?')));
    if (!okd) return;

    var original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner"></div> Filing…';
    try {
      var body = {
        eventType:    $('ev-type').value,
        coHostName:   $('ev-cohost').value.trim(),
        startedAt:    $('ev-started').value ? new Date($('ev-started').value).toISOString() : null,
        durationMins: durationMins(),
        notes:        $('ev-notes').value.trim(),
        attendees:    parsed.roll.map(function (a) { return { discordId: a.discordId, name: a.name }; }),
        proof:        shots.slice(),
      };
      var out = await api('/api/ia-events', { method: 'POST', body: JSON.stringify(body) });
      closeModal('modal-event');
      showToast(out.event.eventRef + ' filed — ' + out.awarded + ' paid '
        + out.pointsEach + ' point(s)'
        + (out.xpEach ? ', ' + (out.xpAwarded || 0) + ' given ' + out.xpEach + ' MET XP' : '') + '.'
        + (out.xpSkipped ? ' ' + out.xpSkipped + ' had no Discord ID.' : ''), 'success');
      ['ev-cohost', 'ev-attendees', 'ev-notes'].forEach(function (id) {
        var el = $(id); if (el) el.value = '';
      });
      shots.length = 0;
      picked = {};
      hideSuggest();
      drawShots();
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
    var at = $('ev-attendees');
    if (at) {
      at.addEventListener('input', onRollInput);
      at.addEventListener('keydown', onRollKey);
      at.addEventListener('click', onRollInput);
      // Leaving the box closes the list, but not before a click on it lands.
      at.addEventListener('blur', function () { setTimeout(hideSuggest, 140); });
    }
    var sug = $('ev-suggest');
    if (sug) sug.addEventListener('mousedown', function (ev) {
      var row = ev.target.closest('[data-i]');
      if (!row) return;
      ev.preventDefault();          // keep the caret in the textarea
      choose(parseInt(row.dataset.i, 10));
    });
    wireProof();
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
