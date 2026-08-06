// client/public/js/ia-application.js
// The Internal Affairs application, one section at a time.
//
// Everything on screen is rendered from the paper the server sends. There are no
// questions written into this file, so adding a section to
// server/lib/iaApplication.js is the whole change — a form that duplicates its own
// questions is a form that disagrees with itself the first time one is edited.
//
// ── What this file is careful about ───────────────────────────────
//
// Losing somebody's writing. Six sections at 50-100 words each is most of an
// hour, so the draft saves to the server AND to localStorage, and the tab warns
// before closing with unsaved changes.
//
// Refusing at the end for something that could have been said at the start. The
// word counters are live, the section cannot be left until it is right, and the
// under-15 stop happens on section one rather than after everything is written.
//
// Lying about the count. countWords and countSentences are ported from the
// server's own module, character for character. If they disagreed, somebody would
// see "82 words" beside a refusal saying they wrote 79.

(function () {
  'use strict';

  var paper = null;      // the six sections, from the server
  var captured = null;   // what the site already knows about us
  var meta = null;       // may I apply, do I have a draft
  var answers = {};      // questionId → answer
  var page = 1;          // which section is on screen
  var errors = null;     // the last refusal, so the offending questions glow
  var dirty = false;
  var lastSavedAt = null;
  var serverUpdatedAt = null;
  var autofilled = false;

  var DRAFT_KEY = 'met_ia_app_draft';

  // ── Telemetry ───────────────────────────────────────────────────
  // Collected for a marker to READ, never scored. Per-question wall clock and
  // keystroke counts are what make a pasted answer visible as evidence: 900
  // characters that arrived in one event and took four seconds is a fact, and it
  // is a fact a person should weigh rather than a percentage a machine invented.
  var tel = { startedAt: new Date().toISOString(), sittings: 1, perQuestion: {}, pastes: [], awaySeconds: 0 };
  var awaySince = null;

  function perQ(id) {
    if (!tel.perQuestion[id]) tel.perQuestion[id] = { ms: 0, keystrokes: 0, chars: 0, firstAt: null };
    return tel.perQuestion[id];
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { awaySince = Date.now(); return; }
    if (awaySince) { tel.awaySeconds += Math.round((Date.now() - awaySince) / 1000); awaySince = null; }
  });

  window.addEventListener('beforeunload', function (e) {
    if (!dirty) return;
    e.preventDefault();
    e.returnValue = '';
    return '';
  });

  // ── Counting, ported from the server ────────────────────────────
  function countWords(text) {
    var s = String(text == null ? '' : text).trim();
    if (!s) return 0;
    return s.split(/\s+/).filter(Boolean).length;
  }

  function countSentences(text) {
    var s = String(text == null ? '' : text).trim();
    if (!s) return 0;
    var cleaned = s
      .replace(/(\d)[.,](\d)/g, '$1$2')
      .replace(/\b(?:e\.g|i\.e|etc|mr|mrs|ms|dr|vs|approx|no)\./gi, ' ')
      .replace(/[.!?]{2,}/g, '.');
    var parts = cleaned.split(/[.!?]+(?:\s|$)/).map(function (x) { return x.trim(); }).filter(Boolean);
    return parts.filter(function (p) { return countWords(p) >= 2; }).length;
  }

  // The declaration sentence, with their own name in it. The server builds the
  // same string from the same template, so what is shown is what is checked.
  function expectedFor(q) {
    if (q.expect) return q.expect;
    if (!q.expectTemplate) return null;
    var name = (captured && (captured.roblox.username || captured.discord.username)) || '';
    return q.expectTemplate.replace(/\{username\}/g, name || '{username}');
  }

  var esc = window.escapeHtml || function (s) { return String(s == null ? '' : s); };

  function sections() { return (paper && paper.sections) || []; }
  function sectionFor(p) { return sections().filter(function (s) { return s.page === p; })[0] || null; }
  function pageNumbers() { return sections().map(function (s) { return s.page; }); }
  function lastPage() { return Math.max.apply(null, pageNumbers()); }

  // ── Validation, the same rules the server applies ───────────────
  function problemsOn(p) {
    var s = sectionFor(p);
    if (!s) return { missing: [], tooShort: [], tooLong: [], wrong: [] };
    var missing = [], tooShort = [], tooLong = [], wrong = [];
    s.questions.forEach(function (q) {
      // Captured fields are the server's to fill in, so never the applicant's
      // problem — but they must have actually arrived before we let them past.
      if (q.captured) return;
      var raw = answers[q.id];
      var has = q.type === 'agreement' ? raw === true
              : (raw != null && String(raw).trim() !== '');
      if (!has) { if (q.required) missing.push(q.id); return; }

      if (q.type === 'choice' && q.options && q.options.indexOf(String(raw)) < 0) {
        wrong.push({ id: q.id, why: 'That is not one of the options.' });
        return;
      }
      if (q.type === 'typed') {
        var want = expectedFor(q);
        var norm = function (v) { return String(v).replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim().toLowerCase(); };
        if (!want || norm(raw) !== norm(want)) {
          wrong.push({ id: q.id, why: 'That does not match the line exactly.' });
          return;
        }
      }
      if (q.type === 'paragraph') {
        var w = countWords(raw), sen = countSentences(raw);
        if (q.minSentences && sen < q.minSentences) { tooShort.push({ id: q.id, need: q.minSentences, got: sen, unit: 'sentences' }); return; }
        if (q.minWords && w < q.minWords) { tooShort.push({ id: q.id, need: q.minWords, got: w, unit: 'words' }); return; }
        if (q.maxWords && w > q.maxWords) { tooLong.push({ id: q.id, limit: q.maxWords, got: w, unit: 'words' }); return; }
      }
    });
    return { missing: missing, tooShort: tooShort, tooLong: tooLong, wrong: wrong };
  }

  function pageOk(p) {
    var x = problemsOn(p);
    return !x.missing.length && !x.tooShort.length && !x.tooLong.length && !x.wrong.length;
  }

  // ── Rendering ───────────────────────────────────────────────────

  function stepsHtml() {
    var pages = pageNumbers().sort(function (a, b) { return a - b; });
    var s = sectionFor(page);
    return '<div class="iaa-steps">'
      + pages.map(function (p) {
          var cls = p === page ? 'here' : (p < page ? 'done' : '');
          return '<div class="iaa-step ' + cls + '"></div>';
        }).join('')
      + '</div>'
      + '<div class="iaa-stepwhere">'
      +   '<strong>' + esc(s ? s.title : '') + '</strong>'
      +   '<span>Section ' + page + ' of ' + pages.length + '</span>'
      + '</div>';
  }

  function counterHtml(q) {
    // A typed declaration gets a live match indicator, for the same reason a
    // paragraph gets a live word count: being told at the end that a sentence you
    // copied out does not match, with no way to see WHEN it started matching, is
    // the form withholding the only feedback that matters.
    if (q.type === 'typed') {
      var want = expectedFor(q);
      var got = answers[q.id];
      if (!want) return '';
      var norm = function (v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim().toLowerCase(); };
      if (!got) {
        return '<div class="iaa-count" data-count-for="' + esc(q.id) + '"><span></span><span></span></div>';
      }
      var same = norm(got) === norm(want);
      return '<div class="iaa-count ' + (same ? 'ok' : 'under') + '" data-count-for="' + esc(q.id) + '">'
        + '<span>' + (same ? '<i class="ti ti-check"></i> Matches' : '<i class="ti ti-dots"></i> Not an exact match yet')
        + '</span><span></span></div>';
    }
    if (q.type !== 'paragraph' || (!q.minWords && !q.minSentences && !q.maxWords)) return '';
    var raw = answers[q.id] || '';
    var n, unit, cls, need;
    if (q.minSentences) {
      n = countSentences(raw); unit = n === 1 ? 'sentence' : 'sentences'; need = q.minSentences;
      cls = n >= need ? 'ok' : 'under';
    } else {
      n = countWords(raw); unit = n === 1 ? 'word' : 'words'; need = q.minWords || 0;
      cls = q.maxWords && n > q.maxWords ? 'over' : (n >= need ? 'ok' : 'under');
    }
    var target = q.maxWords
      ? need + '–' + q.maxWords + ' words'
      : (need ? 'at least ' + need + ' ' + (q.minSentences ? 'sentences' : 'words') : '');
    var mark = cls === 'ok' ? '<i class="ti ti-check"></i> ' : (cls === 'over' ? '<i class="ti ti-alert-triangle"></i> ' : '');
    return '<div class="iaa-count ' + cls + '" data-count-for="' + esc(q.id) + '">'
      + '<span>' + mark + '<span class="n">' + n + '</span> ' + unit + '</span>'
      + '<span>' + esc(target) + '</span></div>';
  }

  function questionHtml(q) {
    var bad = errors && (
      (errors.missing || []).indexOf(q.id) >= 0
      || (errors.tooShort || []).some(function (t) { return t.id === q.id; })
      || (errors.tooLong || []).some(function (t) { return t.id === q.id; })
      || (errors.wrong || []).some(function (t) { return t.id === q.id; }));

    var val = answers[q.id];
    var h = '<div class="iaa-q' + (bad ? ' bad' : '') + '" id="q-' + esc(q.id) + '">';

    // A captured field is shown as a fact, not as a box. It appears on the
    // identity card above instead.
    if (q.captured) return '';

    h += '<div class="iaa-prompt">' + esc(q.prompt || '')
       + (q.required ? '<span class="req" title="Required">*</span>' : '') + '</div>';
    if (q.help) h += '<div class="iaa-help">' + esc(q.help) + '</div>';

    if (q.type === 'choice') {
      (q.options || []).forEach(function (opt) {
        var on = String(val) === String(opt);
        h += '<label class="iaa-choice' + (on ? ' picked' : '') + '">'
           + '<input type="radio" name="' + esc(q.id) + '" value="' + esc(opt) + '"' + (on ? ' checked' : '')
           + ' data-q="' + esc(q.id) + '" />'
           + '<span>' + esc(opt) + '</span></label>';
      });
    } else if (q.type === 'agreement') {
      h += '<label class="iaa-choice' + (val === true ? ' picked' : '') + '">'
         + '<input type="checkbox" data-q="' + esc(q.id) + '"' + (val === true ? ' checked' : '') + ' />'
         + '<span>' + esc(q.statement || '') + '</span></label>';
    } else if (q.type === 'typed') {
      h += '<div class="iaa-note" style="border-left-color:var(--amber);margin-bottom:.6rem;">'
         + esc(expectedFor(q) || '') + '</div>'
         + '<textarea class="form-control" data-q="' + esc(q.id) + '" rows="3" '
         + 'placeholder="Type the line above">' + esc(val || '') + '</textarea>'
         + counterHtml(q);
    } else if (q.type === 'paragraph') {
      h += '<textarea class="form-control" data-q="' + esc(q.id) + '" '
         + 'maxlength="' + (q.maxChars || 5000) + '">' + esc(val || '') + '</textarea>'
         + counterHtml(q);
    } else {
      h += '<input type="text" class="form-control" data-q="' + esc(q.id) + '" '
         + 'value="' + esc(val || '') + '" maxlength="' + (q.maxChars || 500) + '" />';
    }
    return h + '</div>';
  }

  // ── The identity card and the autofill button ────────────────────
  //
  // The button is the thing the brief asked for. It does not invent anything: it
  // copies what the site already knows into the four captured fields, and it asks
  // for agreement first — because the moment somebody presses it they are
  // asserting that the details are theirs and that the rest of the application
  // will be their own work. That is a claim, so it should be made deliberately
  // rather than as a side effect of a convenience button.
  function identityHtml() {
    if (!captured) return '';
    var d = captured.discord, r = captured.roblox;
    var row = function (k, v, mono, locked) {
      return '<div class="iaa-idrow"><span class="k">' + esc(k) + '</span>'
        + '<span class="v' + (mono ? ' mono' : '') + '">' + esc(v || '·') + '</span>'
        + (locked ? ' <span class="iaa-locked"><i class="ti ti-lock"></i> from your account</span>' : '')
        + '</div>';
    };
    var tz = answers.timezone || detectTimezone();
    return '<div class="iaa-idcard">'
      + (r.avatar
          ? '<img src="' + esc(r.avatar) + '" alt="" onerror="this.remove()" />'
          : '')
      + '<div class="iaa-idrows">'
      +   row('Discord', d.username, true, true)
      +   row('Roblox', r.username, true, true)
      +   row('Timezone', tz, false, false)
      +   row('Device', captured.device, false, true)
      + '</div></div>'
      + '<div class="iaa-autofill">'
      +   '<div class="t">' + (autofilled
            ? '<strong>Filled in.</strong> Check the details above are yours, and change the timezone if it is wrong.'
            : '<strong>Fill in my details for me.</strong> Your Discord name, Roblox name, timezone and device '
              + 'are all things we already know, so you do not have to type them.')
      +   '</div>'
      +   '<button class="btn ' + (autofilled ? 'btn-ghost' : 'btn-primary') + ' btn-sm" id="iaa-autofill">'
      +     '<i class="ti ti-' + (autofilled ? 'refresh' : 'wand') + '"></i> '
      +     (autofilled ? 'Fill in again' : 'Autofill my details')
      +   '</button>'
      + '</div>';
  }

  function detectTimezone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; }
  }

  function errorsHtml() {
    if (!errors) return '';
    var byId = {};
    sections().forEach(function (s) { s.questions.forEach(function (q) { byId[q.id] = q; }); });
    var lines = [];
    (errors.missing || []).forEach(function (id) {
      lines.push('<a data-goto="' + esc(id) + '">' + esc((byId[id] && byId[id].prompt) || id) + '</a> · not answered yet.');
    });
    (errors.tooShort || []).forEach(function (t) {
      lines.push('<a data-goto="' + esc(t.id) + '">' + esc((byId[t.id] && byId[t.id].prompt) || t.id) + '</a> · '
        + t.got + ' ' + t.unit + ', and it needs at least ' + t.need + '.');
    });
    (errors.tooLong || []).forEach(function (t) {
      lines.push('<a data-goto="' + esc(t.id) + '">' + esc((byId[t.id] && byId[t.id].prompt) || t.id) + '</a> · '
        + t.got + ' ' + t.unit + ', and the limit is ' + t.limit + '.');
    });
    (errors.wrong || []).forEach(function (t) {
      lines.push('<a data-goto="' + esc(t.id) + '">' + esc((byId[t.id] && byId[t.id].prompt) || t.id) + '</a> · ' + esc(t.why));
    });
    if (!lines.length) return '';
    return '<div class="iaa-err"><h4>Not quite finished</h4><ul>'
      + lines.map(function (l) { return '<li>' + l + '</li>'; }).join('') + '</ul></div>';
  }

  function render() {
    var host = document.getElementById('iaa-body');
    if (!host) return;

    if (meta && !meta.canApply) return renderBlocked(host);

    var s = sectionFor(page);
    if (!s) { host.innerHTML = '<div class="iaa-state"><p>That section does not exist.</p></div>'; return; }

    var h = stepsHtml();

    if (page === 1) {
      (s.notices || []).forEach(function (n) {
        var icon = n.tone === 'danger' ? 'ti-alert-octagon' : n.tone === 'warning' ? 'ti-alert-triangle' : 'ti-info-circle';
        h += '<div class="iaa-notice ' + esc(n.tone) + '"><i class="ti ' + icon + '"></i><span>' + esc(n.text) + '</span></div>';
      });
      if (s.guidelines && s.guidelines.length) {
        h += '<div class="panel glass iaa-guidelines"><h3>For the best chance of being accepted</h3><ul>'
          + s.guidelines.map(function (g) { return '<li>' + esc(g) + '</li>'; }).join('')
          + '</ul></div>';
      }
    }

    h += '<div class="panel glass iaa-section">';
    h += '<div class="iaa-shead">' + esc(s.heading || s.title) + '</div>';
    if (s.blurb) h += '<div class="iaa-blurb">' + esc(s.blurb) + '</div>';
    if (page === 1) h += identityHtml();
    if (s.note) h += '<div class="iaa-note">' + esc(s.note) + '</div>';
    h += errorsHtml();
    h += s.questions.map(questionHtml).join('');
    h += '</div>';

    var isLast = page === lastPage();
    h += '<div class="iaa-nav">'
      + (page > 1 ? '<button class="btn btn-ghost" id="iaa-back"><i class="ti ti-arrow-left"></i> Back</button>' : '')
      + '<span class="spacer"></span>'
      + '<span class="iaa-saved' + (lastSavedAt ? ' on' : '') + '" id="iaa-saved">'
      +   (lastSavedAt ? '<i class="ti ti-cloud-check"></i> Saved' : (dirty ? '<i class="ti ti-cloud"></i> Not saved yet' : ''))
      + '</span>'
      + '<button class="btn btn-ghost" id="iaa-save"><i class="ti ti-device-floppy"></i> Save and finish later</button>'
      + (isLast
          ? '<button class="btn btn-primary" id="iaa-submit"><i class="ti ti-send"></i> Submit application</button>'
          : '<button class="btn btn-primary" id="iaa-next">Next <i class="ti ti-arrow-right"></i></button>')
      + '</div>';

    host.innerHTML = h;
    wire();
  }

  function renderBlocked(host) {
    var pending = meta.pending;
    // Closed is its own state, not a refusal. "You cannot apply right now" reads
    // as though something is wrong with the person; recruitment being shut is a
    // fact about Internal Affairs, and the useful thing to say is to come back.
    if (meta.closed) {
      host.innerHTML = '<div class="panel glass iaa-state">'
        + '<div class="big">🔒</div>'
        + '<h2>Applications are closed</h2>'
        + '<p>Internal Affairs is not taking applications at the moment.</p>'
        + (meta.closedNote
            ? '<p class="iaa-closed-note">' + esc(meta.closedNote) + '</p>'
            : '<p style="color:var(--text-muted);font-size:12.5px;">'
              + 'They open again when the next intake starts. Keep an eye on the MET server.</p>')
        + (meta.hasDraft
            ? '<p style="color:var(--text-muted);font-size:12.5px;">'
              + 'Anything you had already written is saved and will be here when they reopen.</p>'
            : '')
        + '</div>';
      return;
    }
    host.innerHTML = '<div class="panel glass iaa-state">'
      + '<div class="big">' + (pending ? '⏳' : '🚫') + '</div>'
      + '<h2>' + (pending ? 'Already with Internal Affairs' : 'You cannot apply right now') + '</h2>'
      + '<p>' + esc(meta.why || '') + '</p>'
      + (pending && pending.submittedAt
          ? '<p style="color:var(--text-muted);font-size:12.5px;">Sent ' + esc(new Date(pending.submittedAt).toLocaleString()) + '.</p>'
          : '')
      + '</div>';
  }

  function renderStopped(stop) {
    var host = document.getElementById('iaa-body');
    dirty = false;
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
    host.innerHTML = '<div class="panel glass iaa-state">'
      + '<div class="big">🕒</div>'
      + '<h2>' + esc(stop.title) + '</h2>'
      + '<p>' + esc(stop.body) + '</p>'
      + '</div>';
  }

  function renderSent(out) {
    var host = document.getElementById('iaa-body');
    dirty = false;
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
    host.innerHTML = '<div class="panel glass iaa-state">'
      + '<div class="big">✅</div>'
      + '<h2>Application sent</h2>'
      + '<p>Your application is <strong>' + esc(out.appRef) + '</strong>. It is with Internal Affairs now.</p>'
      + '<p>A Deputy Director or above reads every one by hand, so give it time. '
      + 'You will be told either way, and you cannot send another until you hear back.</p>'
      + '</div>';
  }

  // ── Wiring ──────────────────────────────────────────────────────
  function wire() {
    var host = document.getElementById('iaa-body');

    host.querySelectorAll('[data-q]').forEach(function (el) {
      var id = el.dataset.q;
      if (el.type === 'radio') {
        el.addEventListener('change', function () {
          if (!el.checked) return;
          answers[id] = el.value;
          dirty = true;
          // The age stop is checked the moment an age is chosen, not at submit.
          // checkStop() asks the SERVER, so the band that stops an application is
          // named in exactly one place — hard-coding it here meant changing the
          // minimum age silently stopped stopping anybody.
          if (id === 'age_band') return checkStop();
          render();
        });
        return;
      }
      if (el.type === 'checkbox') {
        el.addEventListener('change', function () { answers[id] = el.checked; dirty = true; render(); });
        return;
      }
      // Text and textarea: update the counter live, but do NOT re-render on every
      // keystroke — that would move the caret and lose the selection.
      el.addEventListener('input', function () {
        answers[id] = el.value;
        dirty = true;
        var p = perQ(id);
        p.chars = el.value.length;
        if (!p.firstAt) p.firstAt = Date.now();
        p.ms = Date.now() - p.firstAt;
        updateCounter(id);
        clearErrorFor(id);
        markSaved(false);
      });
      el.addEventListener('keydown', function () { perQ(id).keystrokes++; });
      el.addEventListener('paste', function (ev) {
        var text = '';
        try { text = (ev.clipboardData || window.clipboardData).getData('text') || ''; } catch (e) {}
        // The length and a short sample, because "900 characters pasted" is
        // evidence and the marker should be able to see what it was.
        tel.pastes.push({ q: id, at: new Date().toISOString(), chars: text.length, sample: text.slice(0, 120) });
      });
    });

    var byId = function (x) { return document.getElementById(x); };
    if (byId('iaa-back'))   byId('iaa-back').addEventListener('click', function () { goTo(page - 1); });
    if (byId('iaa-next'))   byId('iaa-next').addEventListener('click', onNext);
    if (byId('iaa-save'))   byId('iaa-save').addEventListener('click', function () { save(true); });
    if (byId('iaa-submit')) byId('iaa-submit').addEventListener('click', onSubmit);
    if (byId('iaa-autofill')) byId('iaa-autofill').addEventListener('click', onAutofill);

    host.querySelectorAll('[data-goto]').forEach(function (a) {
      a.addEventListener('click', function () {
        var id = a.dataset.goto;
        var target = null;
        sections().forEach(function (s) {
          s.questions.forEach(function (q) { if (q.id === id) target = s.page; });
        });
        if (target && target !== page) { page = target; render(); }
        var el = document.getElementById('q-' + id);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          var f = el.querySelector('textarea, input');
          if (f) f.focus();
        }
      });
    });
  }

  function updateCounter(id) {
    var q = null;
    sections().forEach(function (s) { s.questions.forEach(function (x) { if (x.id === id) q = x; }); });
    if (!q) return;
    var slot = document.querySelector('[data-count-for="' + id + '"]');
    if (!slot) return;
    var tmp = document.createElement('div');
    tmp.innerHTML = counterHtml(q);
    var fresh = tmp.firstElementChild;
    if (fresh) slot.replaceWith(fresh);
  }

  // A refusal that stays on screen after it has been fixed is the form arguing
  // with something that is no longer true. Drop the line and the red outline the
  // moment the answer validates — without a full re-render, which would move the
  // caret out from under whoever is still typing.
  function clearErrorFor(id) {
    if (!errors) return;
    var still = problemsOn(page);
    var bad = still.missing.indexOf(id) >= 0
      || still.tooShort.some(function (t) { return t.id === id; })
      || still.tooLong.some(function (t) { return t.id === id; })
      || still.wrong.some(function (t) { return t.id === id; });
    if (bad) return;

    errors.missing  = (errors.missing || []).filter(function (x) { return x !== id; });
    errors.tooShort = (errors.tooShort || []).filter(function (t) { return t.id !== id; });
    errors.tooLong  = (errors.tooLong || []).filter(function (t) { return t.id !== id; });
    errors.wrong    = (errors.wrong || []).filter(function (t) { return t.id !== id; });

    var qEl = document.getElementById('q-' + id);
    if (qEl) qEl.classList.remove('bad');
    var line = document.querySelector('.iaa-err [data-goto="' + id + '"]');
    if (line && line.closest('li')) line.closest('li').remove();
    var box = document.querySelector('.iaa-err');
    if (box && !box.querySelectorAll('li').length) box.remove();
    if (!errors.missing.length && !errors.tooShort.length && !errors.tooLong.length && !errors.wrong.length) {
      errors = null;
    }
  }

  function markSaved(on) {
    var el = document.getElementById('iaa-saved');
    if (!el) return;
    el.className = 'iaa-saved' + (on ? ' on' : '');
    el.innerHTML = on ? '<i class="ti ti-cloud-check"></i> Saved' : '<i class="ti ti-cloud"></i> Not saved';
  }

  // ── The autofill button ─────────────────────────────────────────
  async function onAutofill() {
    var d = captured.discord, r = captured.roblox;
    var tz = detectTimezone();
    // What they are agreeing to, spelled out. A confirmation that does not say
    // what is being confirmed is a click-through, and the point of this one is
    // that pressing it is an assertion about their own identity.
    var msg = 'These are the details we will put on your application:\n\n'
            + 'Discord: ' + (d.username || 'unknown') + '\n'
            + 'Roblox: ' + (r.username || 'not linked') + '\n'
            + 'Timezone: ' + (tz || 'could not detect') + '\n'
            + 'Device: ' + (captured.device || 'unknown') + '\n\n'
            + 'By continuing you confirm that these are YOUR accounts, that you are applying as '
            + 'yourself and not on anybody else’s behalf, and that everything you write from '
            + 'here on will be your own work with no Artificial Intelligence used.\n\n'
            + 'Using AI on this application, or sharing its questions, means a blacklist from MET.';

    var yes = await uiConfirm(msg, {
      title: 'Confirm your details',
      confirmText: 'Yes, these are mine',
      cancelText: 'Cancel',
      icon: 'ti-user-check',
    });
    if (!yes) return;

    answers.discord_username = d.username || '';
    answers.roblox_username  = r.username || '';
    if (tz) answers.timezone = tz;
    if (captured.device) answers.device = captured.device;
    autofilled = true;
    dirty = true;
    render();
    showToast('Filled in. Check the timezone is right.', 'success');
    save(false);
  }

  function goTo(p) {
    if (pageNumbers().indexOf(p) < 0) return;
    page = p;
    errors = null;
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function onNext() {
    if (!pageOk(page)) {
      errors = problemsOn(page);
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      showToast('There is something to finish on this section.', 'info');
      return;
    }
    errors = null;
    await save(false);
    goTo(page + 1);
  }

  async function checkStop() {
    // The server owns this decision, and it also throws the draft away — so ask
    // it rather than deciding here and leaving a row behind.
    try {
      var out = await api('/api/ia-application/draft', {
        method: 'PUT',
        body: JSON.stringify({ answers: answers, telemetry: tel, knownUpdatedAt: serverUpdatedAt }),
      });
      if (out && out.stopped) return renderStopped(out.stopped);
    } catch (e) { /* fall through and let them carry on; submit will catch it */ }
    render();
  }

  async function save(loud) {
    // Local first, always, and synchronously. If the request fails, the tab
    // crashes or the connection drops, the writing is still on this machine.
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ answers: answers, page: page, at: Date.now() })); } catch (e) {}
    try {
      var out = await api('/api/ia-application/draft', {
        method: 'PUT',
        body: JSON.stringify({ answers: answers, telemetry: tel, knownUpdatedAt: serverUpdatedAt }),
      });
      if (out && out.stopped) { renderStopped(out.stopped); return false; }
      serverUpdatedAt = out.updatedAt || serverUpdatedAt;
      lastSavedAt = Date.now();
      dirty = false;
      markSaved(true);
      if (loud) showToast('Saved. You can close this and come back to it.', 'success');
      return true;
    } catch (err) {
      // A conflict is the one worth interrupting for: two tabs, and somebody is
      // about to lose an hour.
      if (/saved somewhere else/i.test(err.message || '')) {
        showToast(err.message, 'error', 9000);
      } else if (loud) {
        showToast(err.message || 'Could not save to the server. Your writing is still on this device.', 'error');
      }
      return false;
    }
  }

  async function onSubmit() {
    // Every section, not just this one — the last page is the first place we can
    // check the lot.
    var all = { missing: [], tooShort: [], tooLong: [], wrong: [] };
    var firstBad = null;
    pageNumbers().sort(function (a, b) { return a - b; }).forEach(function (p) {
      var x = problemsOn(p);
      ['missing', 'tooShort', 'tooLong', 'wrong'].forEach(function (k) {
        if (x[k].length && firstBad === null) firstBad = p;
        all[k] = all[k].concat(x[k]);
      });
    });
    if (firstBad !== null) {
      errors = all;
      page = firstBad;
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      showToast('Some of it is not finished · the missing bits are listed at the top.', 'error');
      return;
    }

    var yes = await uiConfirm(
      'Once this is sent you cannot change it, and you cannot send another until Internal Affairs '
      + 'has read this one.\n\nGo back and read your answers through if you have not already.',
      { title: 'Send this application?', confirmText: 'Send it', cancelText: 'Not yet', icon: 'ti-send' });
    if (!yes) return;

    var btn = document.getElementById('iaa-submit');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader-2"></i> Sending…'; }
    try {
      var out = await api('/api/ia-application/submit', {
        method: 'POST',
        body: JSON.stringify({ answers: answers, telemetry: tel }),
      });
      if (out && out.stopped) return renderStopped(out.stopped);
      renderSent(out);
    } catch (err) {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-send"></i> Submit application'; }
      showToast(err.message || 'Could not send the application.', 'error');
    }
  }

  // ── Boot ────────────────────────────────────────────────────────
  (async function init() {
    try {
      var out = await Promise.all([
        api('/api/ia-application/meta'),
        api('/api/ia-application/paper'),
        api('/api/ia-application/captured'),
        api('/api/ia-application/mine').catch(function () { return null; }),
      ]);
      meta = out[0]; paper = out[1]; captured = out[2];
      var mine = out[3];

      if (mine && mine.answers) { answers = mine.answers; serverUpdatedAt = mine.updatedAt; }

      // A local draft that is NEWER than the server's is the one to trust — it is
      // what somebody wrote when the save request failed.
      try {
        var local = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
        if (local && local.answers) {
          var serverAt = serverUpdatedAt ? new Date(serverUpdatedAt).getTime() : 0;
          if (!serverAt || local.at > serverAt + 1000) {
            answers = Object.assign({}, answers, local.answers);
            if (local.page) page = local.page;
            showToast('Picked up unsaved writing from this device.', 'info');
          }
        }
      } catch (e) {}

      if (answers.discord_username || answers.roblox_username) autofilled = true;
      var sub = document.getElementById('iaa-sub');
      if (sub && meta && meta.pages && !meta.pages.complete) {
        sub.textContent = 'Sections ' + meta.pages.missing.join(', ') + ' are not written yet';
      }

      render();
    } catch (err) {
      var host = document.getElementById('iaa-body');
      host.innerHTML = '<div class="panel glass iaa-state"><div class="big">⚠</div>'
        + '<h2>Could not load the application</h2><p>' + esc(err.message || '') + '</p></div>';
    }
  })();
})();
