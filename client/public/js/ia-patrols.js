/* client/public/js/ia-patrols.js — Internal Affairs patrol logs.

   The event log's shape, minus the roll. A patrol is one officer's shift: the
   people listed on it are recorded so a reviewer can see who was out, and paid
   nothing, because on a joint patrol both officers file their own log.

   The form's job is to make the shift obvious before it is submitted. The length
   is worked out from the two times and shown, and so is what it will be worth —
   because a patrol's XP comes from the clock in completed blocks, which means
   twenty-nine minutes is worth nothing and somebody should learn that from the
   form rather than from a supervisor. */
(function () {
  var esc = window.escapeHtml || function (s) { return String(s == null ? '' : s); };
  var $ = function (id) { return document.getElementById(id); };

  var META  = { pointsEach: 2, minMinutes: 15, maxMinutes: 960, maxPartners: 20,
                maxProof: 10, maxProofMb: 6, xpPerMinutes: 30 };
  var cache = [];
  var scope = 'all';
  var query = '';

  // People chosen from the picker, keyed by the exact line written for them, so
  // the spelling of the line stops mattering once an id is attached.
  var picked = {};
  var suggestTimer = null;
  var suggestions = [];
  var sugIndex = -1;
  var sugToken = null;

  // ── Parsing the partner list ────────────────────────────────────
  // The same rules as the server, so what the form shows is what gets stored.
  function parsePartners(text) {
    var lines = String(text || '').split(/[\n,]+/);
    var out = [], seen = {}, dupes = 0;
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i].trim();
      if (!raw) continue;

      var discordId = null, name = raw;
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
      if (out.length >= META.maxPartners) break;
    }
    return { list: out, dupes: dupes,
             over: lines.filter(function (l) { return l.trim(); }).length > META.maxPartners };
  }

  // ── The picker ──────────────────────────────────────────────────
  // Shares the event route's people search: one search, one behaviour, rather
  // than two that drift apart.
  function tokenAt(ta) {
    var v = ta.value, c = ta.selectionStart;
    var start = v.lastIndexOf('\n', c - 1) + 1;
    var end = v.indexOf('\n', c);
    if (end < 0) end = v.length;
    return { start: start, end: end, text: v.slice(start, end).trim() };
  }

  function hideSuggest() {
    var box = $('pt-suggest');
    if (box) { box.style.display = 'none'; box.innerHTML = ''; }
    suggestions = []; sugIndex = -1; sugToken = null;
  }

  function drawSuggest() {
    var box = $('pt-suggest');
    if (!box) return;
    if (!suggestions.length) {
      box.innerHTML = '<div class="ev-sug-empty">Nobody matches that · you can still type the name in full.</div>';
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

  function choose(i) {
    var p = suggestions[i];
    var ta = $('pt-partners');
    if (!p || !ta || !sugToken) return;
    var line = p.name;
    picked[line.toLowerCase()] = { discordId: p.discordId, name: p.name };
    var before = ta.value.slice(0, sugToken.start);
    var after  = ta.value.slice(sugToken.end);
    var insert = line + (after.charAt(0) === '\n' ? '' : '\n');
    ta.value = before + insert + after;
    var caret = (before + insert).length;
    ta.focus();
    ta.setSelectionRange(caret, caret);
    hideSuggest();
    renderPartners();
  }

  async function runSearch(q) {
    try {
      var rows = await api('/api/ia-events/people?q=' + encodeURIComponent(q));
      var ta = $('pt-partners');
      if (!ta || tokenAt(ta).text !== q) return;   // the user has moved on
      var already = {};
      parsePartners(ta.value).list.forEach(function (a) { if (a.discordId) already[a.discordId] = 1; });
      suggestions = (rows || []).filter(function (p) { return !already[p.discordId]; });
      sugIndex = suggestions.length ? 0 : -1;
      sugToken = tokenAt(ta);
      drawSuggest();
    } catch (e) { hideSuggest(); }
  }

  function onPartnerInput() {
    var ta = $('pt-partners');
    if (!ta) return;
    renderPartners();
    var tok = tokenAt(ta);
    clearTimeout(suggestTimer);
    if (tok.text.length < 2 || /^<@!?\d{15,21}>$/.test(tok.text)) { hideSuggest(); return; }
    suggestTimer = setTimeout(function () { runSearch(tok.text); }, 160);
  }

  function onPartnerKey(ev) {
    if (!suggestions.length && ev.key !== 'Escape') return;
    if (ev.key === 'ArrowDown') { ev.preventDefault(); sugIndex = (sugIndex + 1) % suggestions.length; drawSuggest(); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); sugIndex = (sugIndex - 1 + suggestions.length) % suggestions.length; drawSuggest(); }
    else if (ev.key === 'Enter' || ev.key === 'Tab') {
      if (sugIndex >= 0) { ev.preventDefault(); choose(sugIndex); }
    } else if (ev.key === 'Escape') { hideSuggest(); }
  }

  // ── Proof ───────────────────────────────────────────────────────
  var shots = [];

  function drawShots() {
    var box = $('pt-proof-shots');
    if (!box) return;
    box.innerHTML = shots.map(function (src, i) {
      return '<div class="ev-shot"><img src="' + esc(src) + '" alt="proof ' + (i + 1) + '" />'
        + '<button type="button" class="ev-shot-x" title="Remove" data-shot="' + i + '">&#x2715;</button></div>';
    }).join('');
    var hint = $('pt-proof-hint');
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
      showToast(rejected + ' file(s) skipped · images only, up to ' + META.maxProof
        + ' of them, ' + META.maxProofMb + ' MB each.', 'warning');
    }
  }

  function wireProof() {
    var drop = $('pt-drop'), input = $('pt-proof-input'), browse = $('pt-proof-browse');
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
    var modal = $('modal-patrol');
    if (modal) modal.addEventListener('paste', function (ev) {
      var items = (ev.clipboardData && ev.clipboardData.files) || null;
      if (items && items.length) { ev.preventDefault(); addFiles(items); }
    });
    var shotBox = $('pt-proof-shots');
    if (shotBox) shotBox.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-shot]');
      if (!b) return;
      shots.splice(parseInt(b.dataset.shot, 10), 1);
      drawShots();
    });
  }

  // ── The clock ───────────────────────────────────────────────────
  // Never typed, and crossing midnight is the normal case for a night shift
  // rather than an error: 22:30 to 01:00 is two and a half hours. The server
  // does exactly this, so the number on screen is the number that gets stored.
  function span() {
    var a = $('pt-started'), b = $('pt-ended');
    if (!a || !b || !a.value || !b.value) return null;
    var t0 = new Date(a.value).getTime(), t1 = new Date(b.value).getTime();
    if (!isFinite(t0) || !isFinite(t1)) return null;
    var crossed = false;
    if (t1 <= t0) { t1 += 86400000; crossed = true; }
    return { minutes: Math.round((t1 - t0) / 60000), crossedMidnight: crossed };
  }

  function humanMins(mins) {
    var h = Math.floor(mins / 60), m = mins % 60;
    return h ? (h + 'h' + (m ? ' ' + m + 'm' : '')) : (m + 'm');
  }

  // What this shift earns, by the standing rule: one XP per completed block.
  function xpFor(mins) {
    var block = META.xpPerMinutes || 30;
    return mins > 0 ? Math.floor(mins / block) : 0;
  }

  function updateClock() {
    var box = $('pt-duration'), worth = $('pt-worth');
    if (!box) return;
    var s = span();
    if (!s) {
      box.value = ''; box.style.color = '';
      if (worth) worth.style.display = 'none';
      return;
    }
    box.value = humanMins(s.minutes) + (s.crossedMidnight ? ' (overnight)' : '');
    var tooLong = s.minutes > META.maxMinutes;
    var tooShort = s.minutes < META.minMinutes;
    box.style.color = (tooLong || tooShort) ? 'var(--amber)' : '';

    if (!worth) return;
    worth.style.display = '';
    if (tooShort) {
      worth.innerHTML = '<span class="ev-roll-warn"><i class="ti ti-alert-triangle"></i> '
        + 'A patrol has to be at least ' + META.minMinutes + ' minutes. This one is '
        + s.minutes + '.</span>';
      return;
    }
    if (tooLong) {
      worth.innerHTML = '<span class="ev-roll-warn"><i class="ti ti-alert-triangle"></i> '
        + 'That comes to ' + humanMins(s.minutes) + ', which is longer than a shift. Check the times.</span>';
      return;
    }
    var xp = xpFor(s.minutes);
    var block = META.xpPerMinutes || 30;
    // A part-finished block is the useful thing to say: it turns "why did I get
    // 4" into "you were 12 minutes short of 5". On an exact boundary there is
    // nothing to report — the next block is a whole block away, and saying so
    // right after somebody lands on 5 exactly reads as though they missed out.
    var left = s.minutes % block;
    var hint = 'One XP per ' + block + ' completed minutes.';
    if (left) {
      hint += ' ' + (block - left) + ' more minute' + (block - left === 1 ? '' : 's')
            + ' would have made it ' + (xp + 1) + '.';
    }
    worth.innerHTML = '<div class="ev-roll-head">Worth <strong>' + META.pointsEach + '</strong> quota point'
      + (META.pointsEach === 1 ? '' : 's')
      + ' and <strong>' + xp + '</strong> MET XP once approved'
      + (s.crossedMidnight ? ' <span class="ev-roll-note">counted as an overnight shift</span>' : '')
      + '</div>'
      + '<div class="ev-roll-note" style="font-size:11px;">' + hint + '</div>';
  }

  function renderPartners() {
    var box = $('pt-roll');
    if (!box) return;
    var parsed = parsePartners($('pt-partners') ? $('pt-partners').value : '');
    if (!parsed.list.length) {
      box.innerHTML = '<span class="ev-roll-empty">Nobody else listed · a solo patrol is fine.</span>';
      return;
    }
    var chips = parsed.list.map(function (a) {
      var label = a.name || ('ID ' + a.discordId);
      return '<span class="ev-chip' + (a.discordId ? ' ev-chip-id' : '') + '"'
        + ' title="' + esc(a.discordId ? 'Discord ' + a.discordId : 'Matched by name · an ID is more reliable') + '">'
        + '<i class="ti ti-' + (a.discordId ? 'user-check' : 'user') + '"></i>' + esc(label) + '</span>';
    }).join('');
    box.innerHTML = '<div class="ev-roll-head">'
      + '<strong>' + parsed.list.length + '</strong> other officer'
      + (parsed.list.length === 1 ? '' : 's')
      + ' <span class="ev-roll-note">recorded, not paid · they file their own log</span>'
      + (parsed.dupes ? ' · <span class="ev-roll-note">' + parsed.dupes + ' duplicate'
          + (parsed.dupes === 1 ? '' : 's') + ' ignored</span>' : '')
      + (parsed.over ? ' · <span class="ev-roll-warn">only the first ' + META.maxPartners
          + ' are kept</span>' : '')
      + '</div><div class="ev-chips">' + chips + '</div>';
  }

  // ── The list ────────────────────────────────────────────────────
  function matches(p, q) {
    if (!q) return true;
    var names = (Array.isArray(p.partners) ? p.partners : [])
      .map(function (a) { return a && (a.name || a.discordId); }).filter(Boolean).join(' ');
    return [p.patrolRef, p.officerName, p.area, p.notes, names]
      .filter(Boolean).join(' ').toLowerCase().indexOf(q.toLowerCase()) >= 0;
  }

  function statusBadge(p) {
    if (p.voidedAt) return '<span class="badge badge-muted"><span class="badge-dot"></span>Withdrawn</span>';
    if (p.status === 'DENIED')  return '<span class="badge badge-denied"><span class="badge-dot"></span>Denied</span>';
    if (p.status === 'PENDING') return '<span class="badge badge-pending"><span class="badge-dot"></span>Awaiting review</span>';
    return '<span class="badge badge-approved"><span class="badge-dot"></span>'
      + (p.pointsEach || 0) + ' pts' + (p.xpEach ? ' · ' + p.xpEach + ' MET XP' : '') + '</span>';
  }

  // "2 Aug, 19:00 → 21:30". The shift is the thing being judged, so it reads as
  // a span rather than as two separate cells.
  function shiftCell(p) {
    var a = new Date(p.startedAt), b = new Date(p.endedAt);
    if (isNaN(a) || isNaN(b)) return '·';
    // 24-hour, explicitly. The rest of the dashboard shows "03 Aug 2026, 19:15",
    // and a table with 19:15 in one column and 07:15 PM in the next is a table
    // somebody has to stop and convert.
    var t = function (d) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    };
    var day = a.toLocaleDateString([], { day: 'numeric', month: 'short' });
    return esc(day + ', ' + t(a) + ' → ' + t(b));
  }

  function partnerCell(p) {
    var n = p.partnerCount || 0;
    if (!n) return '<span class="text-muted" style="font-size:12px;">solo</span>';
    var names = (Array.isArray(p.partners) ? p.partners : [])
      .map(function (a) { return a && (a.name || a.discordId); }).filter(Boolean).join(', ');
    return '<span style="font-size:12px;" title="' + esc(names) + '">' + n + '</span>';
  }

  function rowHtml(p) {
    var when = window.formatDateTime ? formatDateTime(p.createdAt) : new Date(p.createdAt).toLocaleString();
    return '<tr class="' + (p.voidedAt ? 'ev-void' : '') + '">'
      + '<td><span class="case-ref">' + esc(p.patrolRef) + '</span></td>'
      + '<td><span style="font-size:12px;">' + esc(p.officerName || '·') + '</span></td>'
      + '<td><span style="font-size:12px;">' + shiftCell(p)
        + (p.area ? '<br><span class="text-muted" style="font-size:11px;">' + esc(p.area) + '</span>' : '')
        + '</span></td>'
      + '<td><span style="font-size:12px;">' + humanMins(p.totalMinutes || 0) + '</span></td>'
      + '<td>' + partnerCell(p) + '</td>'
      + '<td>' + statusBadge(p) + '</td>'
      + '<td><span class="date-cell">' + esc(when) + '</span></td>'
      + '<td>' + (window.canVoidPatrols && !p.voidedAt && p.status === 'APPROVED'
          ? '<button class="row-btn row-btn-deny" onclick="iaPatrolVoid(\'' + esc(p.id) + '\')" title="Withdraw and reverse the points">'
            + '<i class="ti ti-arrow-back-up"></i></button>'
          : '') + '</td>'
      + '</tr>';
  }

  function render() {
    var tbody = $('pt-tbody');
    if (!tbody) return;
    var rows = cache.filter(function (p) { return matches(p, query); });
    var count = $('pt-count');
    if (count) count.textContent = rows.length + ' of ' + cache.length + ' shown';
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="table-empty-text" style="padding:14px;">'
        + (cache.length ? 'No patrols match that search.'
                        : 'No patrols logged yet, press “Log a patrol” after a shift.')
        + '</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(rowHtml).join('');
  }

  async function load() {
    var tbody = $('pt-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="8" class="table-loading"><div class="spinner"></div></td></tr>';
    try {
      var mine = scope === 'mine' || window.caseworkScope === 'mine';
      cache = (await api('/api/ia-patrols' + (mine ? '?scope=mine' : ''))) || [];
      render();
    } catch (err) {
      tbody.innerHTML = '<tr><td colspan="8" class="table-empty-text" style="padding:14px;">'
        + esc(err.message || 'Failed to load the patrol log.') + '</td></tr>';
    }
  }

  // ── Filing one ──────────────────────────────────────────────────
  function openForm() {
    var note = $('pt-points-note');
    if (note) {
      note.textContent = 'one XP per ' + (META.xpPerMinutes || 30) + ' completed minutes';
    }
    // A patrol is logged after it happens, so the useful default is "it ended
    // just now and ran for about an hour". Both are editable.
    var local = function (ms) {
      return new Date(ms - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    };
    var started = $('pt-started'), ended = $('pt-ended');
    if (ended && !ended.value)   ended.value   = local(Date.now());
    if (started && !started.value) started.value = local(Date.now() - 3600000);
    updateClock();
    ['pt-started', 'pt-ended'].forEach(function (id) {
      var el = $(id);
      if (el && !el.dataset.wired) { el.dataset.wired = '1'; el.addEventListener('input', updateClock); }
    });
    wireProof();
    drawShots();
    hideSuggest();
    renderPartners();
    openModal('modal-patrol');
  }

  async function submit() {
    var btn = $('btn-submit-patrol');
    var s = span();
    if (!s) { showToast('Say when the patrol started and ended.', 'error'); return; }
    if (s.minutes < META.minMinutes) {
      showToast('A patrol has to be at least ' + META.minMinutes + ' minutes.', 'error'); return;
    }
    if (s.minutes > META.maxMinutes) {
      showToast('That is longer than a shift · check the times.', 'error'); return;
    }

    var parsed = parsePartners($('pt-partners') ? $('pt-partners').value : '');
    var xp = xpFor(s.minutes);
    var okd = await (typeof uiConfirm === 'function'
      ? uiConfirm('Submit this patrol log?\n\n' + humanMins(s.minutes)
        + (s.crossedMidnight ? ' overnight' : '')
        + '. It goes to a supervisor, and once approved you get '
        + META.pointsEach + ' quota point(s) and ' + xp + ' MET XP.'
        + (parsed.list.length ? '\n\nThe ' + parsed.list.length + ' officer(s) listed with you are '
            + 'recorded but not paid, they file their own log.' : ''),
        { title: 'File this patrol?', confirmText: 'File it', cancelText: 'Not yet', icon: 'ti-car' })
      : Promise.resolve(true));
    if (!okd) return;

    var original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner"></div> Filing…';
    try {
      var body = {
        startedAt: $('pt-started').value ? new Date($('pt-started').value).toISOString() : null,
        endedAt:   $('pt-ended').value ? new Date($('pt-ended').value).toISOString() : null,
        area:      $('pt-area') ? $('pt-area').value.trim() : '',
        notes:     $('pt-notes') ? $('pt-notes').value.trim() : '',
        partners:  parsed.list.map(function (a) { return { discordId: a.discordId, name: a.name }; }),
        proof:     shots.slice(),
      };
      var out = await api('/api/ia-patrols', { method: 'POST', body: JSON.stringify(body) });
      closeModal('modal-patrol');
      showToast(out.patrol.patrolRef + ' filed · waiting on a supervisor.', 'success');
      ['pt-area', 'pt-partners', 'pt-notes'].forEach(function (id) {
        var el = $(id); if (el) el.value = '';
      });
      // The times are cleared too, so the next patrol gets fresh defaults rather
      // than silently re-filing the same shift.
      ['pt-started', 'pt-ended'].forEach(function (id) { var el = $(id); if (el) el.value = ''; });
      shots.length = 0;
      picked = {};
      hideSuggest();
      drawShots();
      renderPartners();
      updateClock();
      load();
    } catch (err) {
      showToast(err.message || 'Failed to file the patrol.', 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = original;
    }
  }

  // ── The review queue (supervisor and above) ─────────────────────
  // Its own cache: the archive and the queue are two different lists, and
  // sharing one would let a decision reshuffle whatever the archive was showing.
  var queue = [];
  var queueQuery = '';

  function queueRow(p) {
    var when = window.formatDateTime ? formatDateTime(p.createdAt) : new Date(p.createdAt).toLocaleString();
    return '<tr>'
      + '<td><span class="case-ref">' + esc(p.patrolRef) + '</span></td>'
      + '<td><span style="font-size:12px;">' + esc(p.officerName || '·') + '</span></td>'
      + '<td><span style="font-size:12px;">' + shiftCell(p)
        + (p.area ? '<br><span class="text-muted" style="font-size:11px;">' + esc(p.area) + '</span>' : '')
        + '</span></td>'
      + '<td><span style="font-size:12px;">' + humanMins(p.totalMinutes || 0) + '</span></td>'
      + '<td>' + partnerCell(p) + '</td>'
      + '<td><span style="font-size:12px;">' + (p.pointsEach || 0) + ' pts'
        + (p.xpEach ? ' · ' + p.xpEach + ' MET XP' : '')
        + '<br><span class="text-muted" style="font-size:10.5px;">the officer only</span></span></td>'
      + '<td><span class="date-cell">' + esc(when) + '</span></td>'
      + '<td>'
        + '<button class="row-btn row-btn-approve" onclick="iaPatrolReview(\'' + esc(p.id) + '\',\'approve\')" title="Approve and pay"><i class="ti ti-check"></i></button> '
        + '<button class="row-btn row-btn-deny" onclick="iaPatrolReview(\'' + esc(p.id) + '\',\'deny\')" title="Deny · nothing is paid"><i class="ti ti-x"></i></button>'
        + '</td>'
      + '</tr>';
  }

  function renderQueue() {
    var tbody = $('pending-patrols-tbody');
    if (!tbody) return;
    var rows = queue.filter(function (p) { return matches(p, queueQuery); });
    var count = $('pending-patrols-count');
    if (count) count.textContent = rows.length + ' waiting';
    var badge = $('pending-patrols-badge');
    if (badge) { badge.textContent = queue.length; badge.style.display = queue.length ? '' : 'none'; }
    if (!rows.length) {
      var EMPTY = window.metEmpty
        ? window.metEmpty({ icon: 'ti-car', title: 'Nothing waiting', sub: 'Every patrol log has been decided.' })
        : '<span class="table-empty-text">Nothing waiting.</span>';
      tbody.innerHTML = '<tr><td colspan="8" class="table-empty">' + EMPTY + '</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(queueRow).join('');
  }

  var metaLoaded = false;
  async function ensureMeta() {
    if (metaLoaded) return META;
    try { META = Object.assign(META, await api('/api/ia-patrols/meta')); metaLoaded = true; }
    catch (e) { /* defaults stand */ }
    window.canFilePatrols = !!META.canFile;
    window.canVoidPatrols = !!META.canVoid;
    return META;
  }

  window.loadPendingIaPatrols = async function () {
    var tbody = $('pending-patrols-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="8" class="table-loading"><div class="spinner"></div></td></tr>';
    try {
      await ensureMeta();
      queue = (await api('/api/ia-patrols?status=PENDING')) || [];
      renderQueue();
    } catch (err) {
      tbody.innerHTML = '<tr><td colspan="8" class="table-empty"><span class="table-empty-text">'
        + esc(err.message || 'Failed to load the queue.') + '</span></td></tr>';
    }
  };

  window.iaPatrolReview = async function (id, action) {
    var p = queue.find(function (x) { return x.id === id; }) || {};
    var okGo = await (typeof uiConfirm === 'function'
      ? uiConfirm(action === 'approve'
          ? 'Approve ' + (p.patrolRef || 'this patrol') + '?\n\n'
            + esc(p.officerName || 'The officer') + ' gets ' + (p.pointsEach || 0)
            + ' quota point(s)' + (p.xpEach ? ' and ' + p.xpEach + ' MET XP' : '')
            + '. Anybody listed with them is not paid, they file their own log.'
          : 'Deny ' + (p.patrolRef || 'this patrol') + '?\n\nNothing is paid.')
      : Promise.resolve(true));
    if (!okGo) return;
    var note = null;
    if (action === 'deny' && typeof uiPrompt === 'function') {
      note = await uiPrompt('Why is it being denied? (optional)');
      if (note === false) return;
    }
    try {
      var out = await api('/api/ia-patrols/' + encodeURIComponent(id) + '/review',
        { method: 'POST', body: JSON.stringify({ action: action, note: note || null }) });
      showToast(action === 'approve'
        ? (out.patrol.patrolRef + ' approved · ' + out.pointsEach + ' point(s)'
           + (out.xpEach ? ' and ' + out.xpEach + ' MET XP' : '') + ' paid.')
        : (out.patrol.patrolRef + ' denied.'), 'success');
      queue = queue.filter(function (x) { return x.id !== id; });
      renderQueue();
      if (typeof refreshNavBadges === 'function') refreshNavBadges();
    } catch (err) {
      showToast(err.message || 'Could not record that decision.', 'error');
      window.loadPendingIaPatrols();
    }
  };

  window.iaPatrolVoid = async function (id) {
    var why = await (typeof uiPrompt === 'function'
      ? uiPrompt('Withdraw this patrol?\n\nThe points and XP it paid are reversed. Say why:')
      : Promise.resolve(prompt('Why is this patrol being withdrawn?')));
    if (why === null || why === false) return;
    try {
      var out = await api('/api/ia-patrols/' + encodeURIComponent(id) + '/void',
        { method: 'POST', body: JSON.stringify({ reason: why }) });
      showToast('Withdrawn · ' + out.reversed + ' award(s) reversed.', 'success');
      load();
    } catch (err) {
      showToast(err.message || 'Could not withdraw that patrol.', 'error');
    }
  };

  function wire() {
    var nb = $('btn-new-patrol'); if (nb) nb.addEventListener('click', openForm);
    var sb = $('btn-submit-patrol'); if (sb) sb.addEventListener('click', submit);
    var at = $('pt-partners');
    if (at) {
      at.addEventListener('input', onPartnerInput);
      at.addEventListener('keydown', onPartnerKey);
      at.addEventListener('click', onPartnerInput);
      at.addEventListener('blur', function () { setTimeout(hideSuggest, 140); });
    }
    var sug = $('pt-suggest');
    if (sug) sug.addEventListener('mousedown', function (ev) {
      var row = ev.target.closest('[data-i]');
      if (!row) return;
      ev.preventDefault();          // keep the caret in the textarea
      choose(parseInt(row.dataset.i, 10));
    });
    wireProof();
    var q = $('pt-search');
    if (q) q.addEventListener('input', function () { query = q.value.trim(); render(); });
    var pq = $('pending-patrols-search');
    if (pq) pq.addEventListener('input', function () { queueQuery = pq.value.trim(); renderQueue(); });
    var tabs = $('pt-scope-tabs');
    if (tabs) tabs.addEventListener('click', function (e) {
      var b = e.target.closest('.filter-tab');
      if (!b) return;
      tabs.querySelectorAll('.filter-tab').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
      scope = b.dataset.ptscope || 'all';
      load();
    });
  }

  // Called by the casework selector when the Patrols segment is opened, and by
  // the pending selector for the queue.
  window.loadIaPatrols = async function () {
    if (!window._iptWired) { wire(); window._iptWired = true; }
    await ensureMeta();
    if (typeof applyCaseworkSelector === 'function') applyCaseworkSelector();
    load();
  };
})();
