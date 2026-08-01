// client/public/js/case-doc.js
// The built-in case document — the replacement for the Internal Affairs Google
// Doc. Same sections, same inputs, same order as the doc everyone already
// knows; rendered in the site's UI, with a full formatting toolbar and
// one-click autofill for every field that can be resolved automatically
// (User → Roblox username, Rank → MET group rank, User ID → Discord id).
//
// Two entry points:
//   CaseDoc.openBuilder({ docId, officerInput, onAttach })  — the editor
//   CaseDoc.renderView(container, doc)                      — the read-only doc
//
// The editor is used inside the dashboard (from Submit Case and the Documents
// tab) and on the standalone /case-doc/:id page.

(function (global) {
  'use strict';

  // Punishments listed on the doc's checklist, in the doc's order.
  var PUNISHMENTS = [
    'Verbal Warning', 'Written Warning', 'Zero Tolerance', 'Suspension',
    'Activity Strike', 'Disciplinary Strike 1', 'Disciplinary Strike 2',
    'Disciplinary Strike 3', 'Demotion', 'Termination', 'Blacklist',
  ];

  var FONTS = [
    ['Default',        ''],
    ['Arial',          'Arial, Helvetica, sans-serif'],
    ['Times New Roman','"Times New Roman", Times, serif'],
    ['Georgia',        'Georgia, serif'],
    ['Courier New',    '"Courier New", Courier, monospace'],
    ['Verdana',        'Verdana, Geneva, sans-serif'],
    ['Trebuchet MS',   '"Trebuchet MS", sans-serif'],
  ];
  var SIZES  = ['10', '11', '12', '13', '14', '16', '18', '20', '24', '28', '32'];
  var COLORS = ['#d8eaff', '#ffffff', '#000000', '#4a8fff', '#2ed896', '#f5b730', '#f04f5e', '#9d7dff', '#8fa3bf'];

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function todayParts() {
    var d = new Date();
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return {
      date: pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + String(d.getFullYear()).slice(-2),
      time: pad(d.getHours()) + ':' + pad(d.getMinutes()),
    };
  }

  function blankData() {
    var t = todayParts();
    return {
      header: { force: 'Metropolitan Police Service', unit: 'Internal Affairs', title: 'Disciplinary Action Report' },
      reportDate: t.date, reportTime: t.time, caseRef: '',
      suspect:      { user: '', rank: '', userId: '' },
      investigator: { user: '', rank: '', userId: '' },
      allegations: [],
      evidence: [],
      punishments: PUNISHMENTS.map(function (n) { return { name: n, issued: false, durationDays: null }; }),
      summaryHtml: '', allegationsHtml: '', finalDecisionHtml: '', notesHtml: '',
      signature: { name: '', rank: '' },
    };
  }

  // Merge a stored document onto the blank shape so an older/partial document
  // still opens with every section present.
  function hydrate(data) {
    var base = blankData();
    if (!data) return base;
    var out = Object.assign({}, base, data);
    out.header       = Object.assign({}, base.header, data.header || {});
    out.suspect      = Object.assign({}, base.suspect, data.suspect || {});
    out.investigator = Object.assign({}, base.investigator, data.investigator || {});
    out.signature    = Object.assign({}, base.signature, data.signature || {});
    out.allegations  = Array.isArray(data.allegations) ? data.allegations : [];
    out.evidence     = Array.isArray(data.evidence) ? data.evidence : [];
    out.punishments  = PUNISHMENTS.map(function (n) {
      var found = (Array.isArray(data.punishments) ? data.punishments : []).find(function (p) { return p && p.name === n; });
      return { name: n, issued: !!(found && found.issued), durationDays: found ? (found.durationDays || null) : null };
    });
    return out;
  }

  function exhibitLabel(i) { return 'Exhibit ' + String.fromCharCode(65 + i); }

  // ── Read-only rendering ─────────────────────────────────────────
  // Used by /case-doc/:id and by the editor's live preview. Rich-text fields
  // are already sanitised server-side on save.
  function renderDocumentHtml(doc) {
    var d = hydrate(doc && doc.data);
    var issued = d.punishments.filter(function (p) { return p.issued; });

    var identity = function (title, p) {
      return '<div class="cd-block">'
        + '<div class="cd-h2">' + esc(title) + '</div>'
        + '<div class="cd-kv"><span class="cd-k">User:</span><span class="cd-v">' + esc(p.user || '—') + '</span></div>'
        + '<div class="cd-kv"><span class="cd-k">Rank:</span><span class="cd-v">' + esc(p.rank || '—') + '</span></div>'
        + '<div class="cd-kv"><span class="cd-k">User ID:</span><span class="cd-v mono">' + esc(p.userId || '—') + '</span></div>'
        + '</div>';
    };

    var allegationsHtml = d.allegations.length
      ? '<ul class="cd-list">' + d.allegations.map(function (a) {
          return '<li><strong>' + esc(a.code) + '</strong>' + (a.offense ? ' — ' + esc(a.offense) : '')
               + (a.class ? ' <span class="cd-muted">(' + esc(a.class) + ')</span>' : '') + '</li>';
        }).join('') + '</ul>'
      : '';
    if (d.allegationsHtml) allegationsHtml += '<div class="cd-rich">' + d.allegationsHtml + '</div>';
    if (!allegationsHtml) allegationsHtml = '<div class="cd-empty">No allegations recorded.</div>';

    var evidenceHtml = d.evidence.length
      ? '<ul class="cd-list">' + d.evidence.map(function (e, i) {
          var label = esc(e.label || exhibitLabel(i));
          var link  = e.url
            ? '<a href="' + esc(e.url) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>'
            : label;
          return '<li>' + link + (e.note ? ' — ' + esc(e.note) : '') + '</li>';
        }).join('') + '</ul>'
      : '<div class="cd-empty">No exhibits attached.</div>';

    // The checklist keeps the doc's convention: every option is listed and the
    // ones actually issued are struck through.
    var checklistHtml = '<ul class="cd-check">' + d.punishments.map(function (p) {
      return '<li class="' + (p.issued ? 'cd-issued' : '') + '">'
        + '<span class="cd-box">' + (p.issued ? '✓' : '') + '</span>'
        + '<span class="cd-punish">' + esc(p.name) + (p.issued && p.durationDays ? ' (' + p.durationDays + ' days)' : '') + '</span>'
        + '</li>';
    }).join('') + '</ul>';

    return ''
      + '<article class="cd-sheet">'
      +   '<header class="cd-head">'
      +     '<div class="cd-force">' + esc(d.header.force) + '</div>'
      +     '<div class="cd-unit">' + esc(d.header.unit) + '</div>'
      +     '<h1 class="cd-title">' + esc(d.header.title) + '</h1>'
      +     '<div class="cd-meta">'
      +       '<span><strong>Date:</strong> ' + esc(d.reportDate || '—') + '</span>'
      +       '<span><strong>Time:</strong> ' + esc(d.reportTime || '—') + '</span>'
      +       (d.caseRef ? '<span><strong>Case:</strong> ' + esc(d.caseRef) + '</span>' : '')
      +     '</div>'
      +   '</header>'
      +   identity('Suspect Information', d.suspect)
      +   identity('Investigator Information', d.investigator)
      +   '<div class="cd-block"><div class="cd-h2">Allegations</div>' + allegationsHtml + '</div>'
      +   '<div class="cd-block"><div class="cd-h2">Evidence</div>' + evidenceHtml + '</div>'
      +   '<div class="cd-block"><div class="cd-h2">Summary of Case</div>'
      +     (d.summaryHtml ? '<div class="cd-rich">' + d.summaryHtml + '</div>' : '<div class="cd-empty">No summary written.</div>')
      +   '</div>'
      +   '<div class="cd-block"><div class="cd-h2">Punishment Issued</div>' + checklistHtml + '</div>'
      +   '<div class="cd-block"><div class="cd-h2">Final Decision</div>'
      +     (d.finalDecisionHtml
              ? '<div class="cd-rich">' + d.finalDecisionHtml + '</div>'
              : (issued.length
                  ? '<div class="cd-rich">On behalf of Internal Affairs, ' + esc(d.suspect.rank || '') + ' ' + esc(d.suspect.user || 'the suspect')
                    + ' will receive ' + esc(issued.map(function (p) { return p.name; }).join(', ')) + '.</div>'
                  : '<div class="cd-empty">No decision recorded.</div>'))
      +   '</div>'
      +   (d.notesHtml ? '<div class="cd-block"><div class="cd-h2">Notes</div><div class="cd-rich">' + d.notesHtml + '</div></div>' : '')
      +   '<footer class="cd-sign">'
      +     '<div class="cd-sign-line">Signed,</div>'
      +     '<div class="cd-sign-name">' + esc(d.signature.name || d.investigator.user || 'Internal Affairs') + '</div>'
      +     '<div class="cd-sign-rank">' + esc(d.signature.rank || d.investigator.rank || 'Internal Affairs') + '</div>'
      +   '</footer>'
      + '</article>';
  }

  // ── Editor ──────────────────────────────────────────────────────
  var state = {
    doc: null,          // the saved server row (null until first save)
    data: blankData(),
    dirty: false,
    saving: false,
    onAttach: null,     // called with the saved doc when "Use in this case" is hit
    onSaved: null,      // called with the saved doc after every successful save
    activeRich: null,   // the contenteditable the toolbar acts on
  };

  function toolbarHtml() {
    var fontOpts = FONTS.map(function (f) { return '<option value="' + esc(f[1]) + '">' + esc(f[0]) + '</option>'; }).join('');
    var sizeOpts = SIZES.map(function (s) { return '<option value="' + s + '">' + s + '</option>'; }).join('');
    var swatch = function (c, cmd) {
      return '<button type="button" class="cd-swatch" style="background:' + c + '" data-cmd="' + cmd + '" data-value="' + c + '" title="' + c + '"></button>';
    };
    var btn = function (cmd, icon, title, value) {
      return '<button type="button" class="cd-tb-btn" data-cmd="' + cmd + '"'
        + (value ? ' data-value="' + esc(value) + '"' : '') + ' title="' + esc(title) + '">'
        + '<i class="ti ti-' + icon + '"></i></button>';
    };
    return ''
      + '<div class="cd-toolbar" id="cd-toolbar">'
      +   '<div class="cd-tb-group">'
      +     btn('undo', 'arrow-back-up', 'Undo (Ctrl+Z)')
      +     btn('redo', 'arrow-forward-up', 'Redo (Ctrl+Y)')
      +   '</div>'
      +   '<div class="cd-tb-group">'
      +     '<select class="cd-tb-select" id="cd-block" title="Paragraph style">'
      +       '<option value="p">Normal text</option>'
      +       '<option value="h1">Heading 1</option>'
      +       '<option value="h2">Heading 2</option>'
      +       '<option value="h3">Heading 3</option>'
      +       '<option value="blockquote">Quote</option>'
      +       '<option value="pre">Code block</option>'
      +     '</select>'
      +     '<select class="cd-tb-select" id="cd-font" title="Font">' + fontOpts + '</select>'
      +     '<select class="cd-tb-select cd-tb-size" id="cd-size" title="Font size">' + sizeOpts + '</select>'
      +   '</div>'
      +   '<div class="cd-tb-group">'
      +     btn('bold', 'bold', 'Bold (Ctrl+B)')
      +     btn('italic', 'italic', 'Italic (Ctrl+I)')
      +     btn('underline', 'underline', 'Underline (Ctrl+U)')
      +     btn('strikeThrough', 'strikethrough', 'Strikethrough')
      +     btn('superscript', 'superscript', 'Superscript')
      +     btn('subscript', 'subscript', 'Subscript')
      +   '</div>'
      +   '<div class="cd-tb-group cd-tb-colors">'
      +     '<span class="cd-tb-label">Text</span>'
      +     COLORS.map(function (c) { return swatch(c, 'foreColor'); }).join('')
      +     '<span class="cd-tb-label">Highlight</span>'
      +     ['transparent', '#f5b73055', '#2ed89655', '#f04f5e55', '#4a8fff55'].map(function (c) { return swatch(c, 'hiliteColor'); }).join('')
      +   '</div>'
      +   '<div class="cd-tb-group">'
      +     btn('justifyLeft', 'align-left', 'Align left')
      +     btn('justifyCenter', 'align-center', 'Align centre')
      +     btn('justifyRight', 'align-right', 'Align right')
      +     btn('justifyFull', 'align-justified', 'Justify')
      +   '</div>'
      +   '<div class="cd-tb-group">'
      +     btn('insertUnorderedList', 'list', 'Bulleted list')
      +     btn('insertOrderedList', 'list-numbers', 'Numbered list')
      +     btn('outdent', 'indent-decrease', 'Decrease indent')
      +     btn('indent', 'indent-increase', 'Increase indent')
      +   '</div>'
      +   '<div class="cd-tb-group">'
      +     btn('createLink', 'link', 'Insert link')
      +     btn('unlink', 'link-off', 'Remove link')
      +     btn('insertImage', 'photo', 'Insert image by URL')
      +     btn('insertHorizontalRule', 'separator-horizontal', 'Horizontal line')
      +     btn('removeFormat', 'clear-formatting', 'Clear formatting')
      +   '</div>'
      + '</div>';
  }

  function fieldRow(label, id, value, placeholder, hint) {
    return '<div class="cd-field">'
      + '<label class="cd-label" for="' + id + '">' + esc(label) + (hint ? ' <span class="cd-hint">' + esc(hint) + '</span>' : '') + '</label>'
      + '<input type="text" class="form-control cd-input" id="' + id + '" value="' + esc(value || '') + '" placeholder="' + esc(placeholder || '') + '" autocomplete="off" />'
      + '</div>';
  }

  function identityFieldset(kind, title, p, autofillLabel) {
    return '<section class="cd-section">'
      + '<div class="cd-section-head">'
      +   '<h3>' + esc(title) + '</h3>'
      +   '<button type="button" class="btn btn-ghost btn-sm" data-autofill="' + kind + '"><i class="ti ti-wand"></i> ' + esc(autofillLabel) + '</button>'
      + '</div>'
      + '<div class="cd-grid-3">'
      +   fieldRow('User', 'cd-' + kind + '-user', p.user, 'Roblox username', 'Roblox username')
      +   fieldRow('Rank', 'cd-' + kind + '-rank', p.rank, 'MET rank', 'MET group rank')
      +   fieldRow('User ID', 'cd-' + kind + '-userid', p.userId, 'Discord user ID', 'Discord user ID')
      + '</div>'
      + '<div class="cd-autofill-note" id="cd-' + kind + '-note"></div>'
      + '</section>';
  }

  function richField(id, label, html, placeholder) {
    return '<section class="cd-section">'
      + '<div class="cd-section-head"><h3>' + esc(label) + '</h3></div>'
      + '<div class="cd-rich-edit" id="' + id + '" contenteditable="true" data-placeholder="' + esc(placeholder || '') + '">' + (html || '') + '</div>'
      + '</section>';
  }

  function editorHtml() {
    var d = state.data;
    return ''
      + toolbarHtml()
      + '<div class="cd-editor-body">'
      + '<section class="cd-section cd-section-head-block">'
      +   '<div class="cd-grid-3">'
      +     fieldRow('Force', 'cd-h-force', d.header.force, 'Metropolitan Police Service')
      +     fieldRow('Unit', 'cd-h-unit', d.header.unit, 'Internal Affairs')
      +     fieldRow('Document title', 'cd-h-title', d.header.title, 'Disciplinary Action Report')
      +   '</div>'
      +   '<div class="cd-grid-3">'
      +     fieldRow('Date', 'cd-date', d.reportDate, 'DD/MM/YY')
      +     fieldRow('Time', 'cd-time', d.reportTime, 'HH:MM')
      +     fieldRow('Case reference', 'cd-caseref', d.caseRef, '#000')
      +   '</div>'
      + '</section>'
      + identityFieldset('suspect', 'Suspect Information', d.suspect, 'Autofill from the officer field')
      + identityFieldset('investigator', 'Investigator Information', d.investigator, 'Autofill me')
      + '<section class="cd-section">'
      +   '<div class="cd-section-head">'
      +     '<h3>Allegations</h3>'
      +     '<div class="cd-section-actions">'
      +       '<input type="text" class="form-control cd-input cd-inline-input" id="cd-penal-input" placeholder="PL-M304, TA-D402…" />'
      +       '<button type="button" class="btn btn-ghost btn-sm" id="cd-penal-add"><i class="ti ti-plus"></i> Resolve codes</button>'
      +     '</div>'
      +   '</div>'
      +   '<div id="cd-allegations"></div>'
      +   '<div class="cd-rich-edit cd-rich-small" id="cd-allegations-rich" contenteditable="true" data-placeholder="Any extra detail on the allegations…">' + (d.allegationsHtml || '') + '</div>'
      + '</section>'
      + '<section class="cd-section">'
      +   '<div class="cd-section-head">'
      +     '<h3>Evidence</h3>'
      +     '<button type="button" class="btn btn-ghost btn-sm" id="cd-evidence-add"><i class="ti ti-plus"></i> Add exhibit</button>'
      +   '</div>'
      +   '<div id="cd-evidence"></div>'
      + '</section>'
      + richField('cd-summary', 'Summary of Case', d.summaryHtml, 'As shown in Exhibit A, the suspect…')
      + '<section class="cd-section">'
      +   '<div class="cd-section-head"><h3>Punishment Issued</h3><span class="cd-hint">tick the punishment(s) actually issued</span></div>'
      +   '<div id="cd-punishments" class="cd-punish-grid"></div>'
      + '</section>'
      + richField('cd-decision', 'Final Decision', d.finalDecisionHtml, 'On behalf of Internal Affairs…')
      + richField('cd-notes', 'Notes', d.notesHtml, 'Anything else worth recording (optional)')
      + '<section class="cd-section">'
      +   '<div class="cd-section-head"><h3>Signature</h3></div>'
      +   '<div class="cd-grid-2">'
      +     fieldRow('Signed by', 'cd-sign-name', d.signature.name, 'Investigator name')
      +     fieldRow('Rank', 'cd-sign-rank', d.signature.rank, 'Investigator rank')
      +   '</div>'
      + '</section>'
      + '</div>';
  }

  // ── Repeating sections ──────────────────────────────────────────
  function renderAllegations() {
    var box = document.getElementById('cd-allegations');
    if (!box) return;
    if (!state.data.allegations.length) {
      box.innerHTML = '<div class="cd-empty-row">No penal codes added yet — type them above and hit “Resolve codes”.</div>';
      return;
    }
    box.innerHTML = state.data.allegations.map(function (a, i) {
      return '<div class="cd-row">'
        + '<input type="text" class="form-control cd-input cd-code" value="' + esc(a.code) + '" data-alleg="' + i + '" data-k="code" placeholder="Code" />'
        + '<input type="text" class="form-control cd-input" value="' + esc(a.offense) + '" data-alleg="' + i + '" data-k="offense" placeholder="Offence" />'
        + '<button type="button" class="btn btn-ghost btn-sm cd-row-del" data-del-alleg="' + i + '" title="Remove"><i class="ti ti-x"></i></button>'
        + '</div>';
    }).join('');
  }

  function renderEvidence() {
    var box = document.getElementById('cd-evidence');
    if (!box) return;
    if (!state.data.evidence.length) {
      box.innerHTML = '<div class="cd-empty-row">No exhibits yet. Add links to clips, screenshots or hosted media.</div>';
      return;
    }
    box.innerHTML = state.data.evidence.map(function (e, i) {
      return '<div class="cd-row">'
        + '<input type="text" class="form-control cd-input cd-code" value="' + esc(e.label || exhibitLabel(i)) + '" data-ev="' + i + '" data-k="label" placeholder="Label" />'
        + '<input type="text" class="form-control cd-input" value="' + esc(e.url) + '" data-ev="' + i + '" data-k="url" placeholder="https://…" />'
        + '<input type="text" class="form-control cd-input" value="' + esc(e.note || '') + '" data-ev="' + i + '" data-k="note" placeholder="Note (optional)" />'
        + '<button type="button" class="btn btn-ghost btn-sm cd-row-del" data-del-ev="' + i + '" title="Remove"><i class="ti ti-x"></i></button>'
        + '</div>';
    }).join('');
  }

  var TIMED = { 'Zero Tolerance': true, 'Suspension': true };
  function renderPunishments() {
    var box = document.getElementById('cd-punishments');
    if (!box) return;
    box.innerHTML = state.data.punishments.map(function (p, i) {
      var dur = TIMED[p.name]
        ? '<input type="number" min="1" max="365" class="form-control cd-input cd-dur" value="' + (p.durationDays || '') + '" data-pun-dur="' + i + '" placeholder="days" />'
        : '';
      return '<label class="cd-punish-item' + (p.issued ? ' cd-punish-on' : '') + '">'
        + '<input type="checkbox" data-pun="' + i + '"' + (p.issued ? ' checked' : '') + ' />'
        + '<span class="cd-punish-name">' + esc(p.name) + '</span>' + dur
        + '</label>';
    }).join('');
  }

  // ── Data binding ────────────────────────────────────────────────
  function val(id) { var el = document.getElementById(id); return el ? el.value : ''; }
  function rich(id) { var el = document.getElementById(id); return el ? el.innerHTML : ''; }

  function collect() {
    var d = state.data;
    d.header = { force: val('cd-h-force'), unit: val('cd-h-unit'), title: val('cd-h-title') };
    d.reportDate = val('cd-date');
    d.reportTime = val('cd-time');
    d.caseRef    = val('cd-caseref');
    d.suspect      = { user: val('cd-suspect-user'), rank: val('cd-suspect-rank'), userId: val('cd-suspect-userid') };
    d.investigator = { user: val('cd-investigator-user'), rank: val('cd-investigator-rank'), userId: val('cd-investigator-userid') };
    d.summaryHtml       = rich('cd-summary');
    d.allegationsHtml   = rich('cd-allegations-rich');
    d.finalDecisionHtml = rich('cd-decision');
    d.notesHtml         = rich('cd-notes');
    d.signature = { name: val('cd-sign-name'), rank: val('cd-sign-rank') };
    return d;
  }

  function markDirty() {
    state.dirty = true;
    var el = document.getElementById('cd-status');
    if (el) { el.textContent = 'Unsaved changes'; el.className = 'cd-status cd-status-dirty'; }
  }

  function setStatus(text, kind) {
    var el = document.getElementById('cd-status');
    if (el) { el.textContent = text; el.className = 'cd-status' + (kind ? ' cd-status-' + kind : ''); }
  }

  // ── Toolbar wiring ──────────────────────────────────────────────
  function execCmd(cmd, value) {
    if (state.activeRich) state.activeRich.focus();
    try {
      if (cmd === 'createLink') {
        var url = prompt('Link URL:', 'https://');
        if (!url) return;
        document.execCommand('createLink', false, url);
      } else if (cmd === 'insertImage') {
        var src = prompt('Image URL:', 'https://');
        if (!src) return;
        document.execCommand('insertImage', false, src);
      } else if (cmd === 'hiliteColor') {
        if (!document.execCommand('hiliteColor', false, value)) document.execCommand('backColor', false, value);
      } else {
        document.execCommand(cmd, false, value || null);
      }
    } catch (e) { /* execCommand is best-effort across browsers */ }
    markDirty();
  }

  function wireToolbar(root) {
    root.querySelectorAll('.cd-tb-btn, .cd-swatch').forEach(function (b) {
      // mousedown keeps the selection inside the contenteditable.
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      b.addEventListener('click', function () { execCmd(b.dataset.cmd, b.dataset.value); });
    });
    var block = root.querySelector('#cd-block');
    if (block) block.addEventListener('change', function () {
      execCmd('formatBlock', '<' + block.value + '>');
      block.value = 'p';
    });
    var font = root.querySelector('#cd-font');
    if (font) font.addEventListener('change', function () {
      if (font.value) execCmd('fontName', font.value);
    });
    var size = root.querySelector('#cd-size');
    if (size) size.addEventListener('change', function () {
      // execCommand's fontSize only accepts 1–7, so apply a real px size to the
      // selection by wrapping it — that's what gives true Docs-style sizing.
      applyFontSize(size.value + 'px');
    });
  }

  function applyFontSize(px) {
    if (state.activeRich) state.activeRich.focus();
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return;
    document.execCommand('fontSize', false, '7');
    var host = state.activeRich || document;
    host.querySelectorAll('font[size="7"]').forEach(function (f) {
      var span = document.createElement('span');
      span.style.fontSize = px;
      span.innerHTML = f.innerHTML;
      f.parentNode.replaceChild(span, f);
    });
    markDirty();
  }

  function wireRichFields(root) {
    root.querySelectorAll('.cd-rich-edit').forEach(function (el) {
      el.addEventListener('focus', function () { state.activeRich = el; });
      el.addEventListener('input', markDirty);
      // Paste as plain-ish text: keep the words, drop the foreign styling that
      // makes pasted Google Docs content look broken.
      el.addEventListener('paste', function (e) {
        var html = e.clipboardData && e.clipboardData.getData('text/html');
        if (!html) return;                       // plain text pastes normally
        e.preventDefault();
        var text = e.clipboardData.getData('text/plain');
        document.execCommand('insertText', false, text);
      });
    });
  }

  // ── Autofill ────────────────────────────────────────────────────
  async function autofill(kind, targetOverride) {
    var noteEl = document.getElementById('cd-' + kind + '-note');
    var target = '';
    if (kind === 'suspect') {
      target = targetOverride
        || (document.getElementById('f-officer-id') || {}).value
        || val('cd-suspect-userid')
        || val('cd-suspect-user');
      target = (target || '').trim();
      if (!target) {
        if (noteEl) noteEl.innerHTML = '<span class="cd-warn">Enter the suspect\'s username or ID first (or fill in the officer field on the case form).</span>';
        return;
      }
    }
    if (noteEl) noteEl.innerHTML = '<span class="cd-muted">Resolving…</span>';
    try {
      var d = await api('/api/case-docs/autofill' + (target ? '?target=' + encodeURIComponent(target) : ''));
      var block = kind === 'suspect' ? d.suspect : d.investigator;
      if (!block) {
        if (noteEl) noteEl.innerHTML = '<span class="cd-warn">Nothing matched that identifier.</span>';
        return;
      }
      var set = function (id, v) { var el = document.getElementById(id); if (el && v) el.value = v; };
      set('cd-' + kind + '-user',   block.user);
      set('cd-' + kind + '-rank',   block.rank);
      set('cd-' + kind + '-userid', block.userId);
      if (kind === 'investigator') {
        set('cd-sign-name', block.user);
        set('cd-sign-rank', block.rank);
      }
      markDirty();
      var notes = (d.notes || []).map(function (n) { return esc(n); }).join(' ');
      if (noteEl) noteEl.innerHTML = '<span class="cd-ok"><i class="ti ti-check"></i> Filled in.</span>' + (notes ? ' <span class="cd-muted">' + notes + '</span>' : '');
    } catch (err) {
      if (noteEl) noteEl.innerHTML = '<span class="cd-warn">' + esc(err.message || 'Autofill failed.') + '</span>';
    }
  }

  async function resolvePenalCodes() {
    var input = document.getElementById('cd-penal-input');
    var raw = (input && input.value || '').trim();
    if (!raw) { showToast('Enter one or more penal codes.', 'error'); return; }
    try {
      var d = await api('/api/case-docs/penal-codes?codes=' + encodeURIComponent(raw));
      (d.allegations || []).forEach(function (a) {
        if (state.data.allegations.some(function (x) { return x.code === a.code; })) return;
        state.data.allegations.push({ code: a.code, offense: a.offense || '', class: a.class || '' });
      });
      if (input) input.value = '';
      renderAllegations();
      markDirty();
      var missing = (d.allegations || []).filter(function (a) { return !a.found; });
      if (missing.length) showToast('Added, but ' + missing.map(function (m) { return m.code; }).join(', ') + ' is not in the penal code list — fill the offence in manually.', 'warning');
    } catch (err) {
      showToast(err.message || 'Could not resolve those codes.', 'error');
    }
  }

  // ── Persistence ─────────────────────────────────────────────────
  async function save(opts) {
    if (state.saving) return null;
    opts = opts || {};
    state.saving = true;
    setStatus('Saving…');
    try {
      collect();
      var body = { data: state.data, title: buildTitle() };
      if (opts.status) body.status = opts.status;
      var saved = state.doc && state.doc.id
        ? await api('/api/case-docs/' + state.doc.id, { method: 'PATCH', body: JSON.stringify(body) })
        : await api('/api/case-docs', { method: 'POST', body: JSON.stringify(body) });
      state.doc = saved;
      state.data = hydrate(saved.data);
      state.dirty = false;
      setStatus('Saved · ' + (saved.docRef || ''), 'ok');
      refreshHeader();
      if (state.onSaved) { try { state.onSaved(saved); } catch (e) {} }
      return saved;
    } catch (err) {
      setStatus(err.message || 'Save failed', 'bad');
      showToast(err.message || 'Failed to save the document.', 'error');
      return null;
    } finally {
      state.saving = false;
    }
  }

  function buildTitle() {
    var s = state.data.suspect.user || 'Suspect';
    return 'IA Case — ' + s + (state.data.reportDate ? ' — ' + state.data.reportDate : '');
  }

  function refreshHeader() {
    var refEl = document.getElementById('cd-docref');
    if (refEl) refEl.textContent = state.doc ? state.doc.docRef : 'Unsaved draft';
    var linkEl = document.getElementById('cd-openlink');
    if (linkEl) {
      if (state.doc) { linkEl.style.display = ''; linkEl.href = '/case-doc/' + state.doc.id; }
      else linkEl.style.display = 'none';
    }
  }

  // ── Preview ─────────────────────────────────────────────────────
  function togglePreview() {
    var wrap = document.getElementById('cd-preview-wrap');
    var edit = document.getElementById('cd-edit-wrap');
    var btn  = document.getElementById('cd-preview-btn');
    if (!wrap || !edit) return;
    var showing = wrap.style.display !== 'none';
    if (showing) {
      wrap.style.display = 'none'; edit.style.display = '';
      if (btn) btn.innerHTML = '<i class="ti ti-eye"></i> Preview';
    } else {
      collect();
      wrap.innerHTML = renderDocumentHtml({ data: state.data });
      wrap.style.display = ''; edit.style.display = 'none';
      if (btn) btn.innerHTML = '<i class="ti ti-pencil"></i> Back to editing';
    }
  }

  // ── Mount ───────────────────────────────────────────────────────
  function wireEditor(root) {
    wireToolbar(root);
    wireRichFields(root);
    renderAllegations();
    renderEvidence();
    renderPunishments();

    root.addEventListener('input', function (e) {
      var t = e.target;
      if (t.matches('.cd-input')) markDirty();
      if (t.dataset && t.dataset.alleg != null) {
        state.data.allegations[+t.dataset.alleg][t.dataset.k] = t.value;
      }
      if (t.dataset && t.dataset.ev != null) {
        state.data.evidence[+t.dataset.ev][t.dataset.k] = t.value;
      }
      if (t.dataset && t.dataset.punDur != null) {
        state.data.punishments[+t.dataset.punDur].durationDays = parseInt(t.value, 10) || null;
      }
    });

    root.addEventListener('change', function (e) {
      var t = e.target;
      if (t.dataset && t.dataset.pun != null) {
        state.data.punishments[+t.dataset.pun].issued = t.checked;
        renderPunishments();
        markDirty();
      }
    });

    root.addEventListener('click', function (e) {
      var el = e.target.closest('[data-autofill]');
      if (el) { autofill(el.dataset.autofill); return; }
      var delA = e.target.closest('[data-del-alleg]');
      if (delA) { state.data.allegations.splice(+delA.dataset.delAlleg, 1); renderAllegations(); markDirty(); return; }
      var delE = e.target.closest('[data-del-ev]');
      if (delE) { state.data.evidence.splice(+delE.dataset.delEv, 1); renderEvidence(); markDirty(); return; }
      if (e.target.closest('#cd-evidence-add')) {
        state.data.evidence.push({ label: exhibitLabel(state.data.evidence.length), url: '', note: '' });
        renderEvidence(); markDirty(); return;
      }
      if (e.target.closest('#cd-penal-add')) { resolvePenalCodes(); return; }
    });

    var penal = root.querySelector('#cd-penal-input');
    if (penal) penal.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); resolvePenalCodes(); }
    });
  }

  // Open the builder as a full-screen overlay inside the dashboard.
  //   opts.docId        — edit an existing document
  //   opts.officerInput — identifier used by the suspect autofill
  //   opts.prefill      — { punishments:[names], reason }
  //   opts.onAttach     — called with the saved doc when "Use in this case" is hit
  async function openBuilder(opts) {
    opts = opts || {};
    state.onAttach = opts.onAttach || null;
    state.onSaved  = opts.onSaved  || null;
    state.doc  = null;
    state.data = blankData();
    state.dirty = false;

    var overlay = document.getElementById('modal-case-doc');
    if (!overlay) { showToast('The document builder is unavailable on this page.', 'error'); return; }
    var body = document.getElementById('cd-edit-wrap');
    var preview = document.getElementById('cd-preview-wrap');
    if (preview) { preview.style.display = 'none'; preview.innerHTML = ''; }

    if (opts.docId) {
      try {
        var loaded = await api('/api/case-docs/' + opts.docId);
        state.doc  = loaded;
        state.data = hydrate(loaded.data);
      } catch (err) { showToast(err.message || 'Could not open that document.', 'error'); }
    }

    // Pre-tick the punishments already selected on the case form.
    if (opts.prefill && Array.isArray(opts.prefill.punishments)) {
      state.data.punishments.forEach(function (p) {
        var hit = opts.prefill.punishments.find(function (x) { return x.action === p.name || x === p.name; });
        if (hit) { p.issued = true; if (hit.durationDays) p.durationDays = hit.durationDays; }
      });
    }

    body.innerHTML = editorHtml();
    body.style.display = '';
    wireEditor(body);
    refreshHeader();
    setStatus(state.doc ? 'Saved · ' + state.doc.docRef : 'New document');

    // "Use in this case" only makes sense when the builder was opened FROM a
    // case form; elsewhere (the Documents tab, the standalone page) it's Save.
    var attach = document.getElementById('cd-attach-btn');
    if (attach) attach.style.display = state.onAttach ? '' : 'none';

    // Autofill the investigator block immediately — it's always the signed-in
    // officer, so there's no reason to make them press anything.
    if (!state.doc) autofill('investigator');
    if (!state.doc && opts.officerInput) autofill('suspect', opts.officerInput);

    openModal('modal-case-doc');
  }

  async function attachToCase() {
    var saved = await save({ status: 'FINAL' });
    if (!saved) return;
    if (state.onAttach) state.onAttach(saved);
    closeModal('modal-case-doc');
    showToast('Document attached to the case.', 'success');
  }

  function wireShell() {
    var s = document.getElementById('cd-save-btn');
    if (s) s.addEventListener('click', function () { save(); });
    var p = document.getElementById('cd-preview-btn');
    if (p) p.addEventListener('click', togglePreview);
    var a = document.getElementById('cd-attach-btn');
    if (a) a.addEventListener('click', attachToCase);
    var pr = document.getElementById('cd-print-btn');
    if (pr) pr.addEventListener('click', function () {
      collect();
      var w = window.open('', '_blank');
      if (!w) return;
      w.document.write('<html><head><title>' + esc(buildTitle()) + '</title>'
        + '<link rel="stylesheet" href="/css/main.css"><link rel="stylesheet" href="/css/case-doc.css">'
        + '</head><body class="cd-print">' + renderDocumentHtml({ data: state.data }) + '</body></html>');
      w.document.close();
      setTimeout(function () { w.print(); }, 300);
    });
  }

  document.addEventListener('DOMContentLoaded', wireShell);

  global.CaseDoc = {
    openBuilder: openBuilder,
    renderDocumentHtml: renderDocumentHtml,
    hydrate: hydrate,
    blankData: blankData,
    PUNISHMENTS: PUNISHMENTS,
    save: save,
    get current() { return state.doc; },
  };
})(window);
