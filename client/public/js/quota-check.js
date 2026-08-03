// client/public/js/quota-check.js — HICOMM weekly quota review
var quotaMembersCache = [];

// Which database the sync/audit panels on THIS page are about.
//
// IA maintains its own; FLP High Command maintains the MET one. The panels are
// identical, so rather than a second copy of all this the page says which it
// is: the FLP dashboard sets window.MET_DB_BASE = '/api/flp' before loading.
function metDbUrl(path, params) {
  var base = window.MET_DB_BASE || '/api/quota';
  var url = base + '/met-database' + (path || '');
  var qs = [];
  // The IA route serves both databases and defaults to IA; the FLP route only
  // ever serves the MET one and takes no division.
  if (base === '/api/quota') qs.push('division=' + encodeURIComponent(window.MET_DB_DIVISION || 'IA'));
  if (params) Object.keys(params).forEach(function (k) {
    qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
  });
  return qs.length ? url + '?' + qs.join('&') : url;
}
// What to call it on screen, so a message never says "MET" on the IA page.
function metDbName() { return (window.MET_DB_BASE === '/api/flp' ? 'MET' : (window.MET_DB_DIVISION || 'IA')); }

document.addEventListener("DOMContentLoaded", function () {
  var sb = document.getElementById("btn-submit-quota-check");
  if (sb) sb.addEventListener("click", submitQuotaCheck);
  var af = document.getElementById("btn-quota-autofill");
  if (af) af.addEventListener("click", applyQuotaAuto);
  var rb = document.getElementById("btn-reset-quota");
  if (rb) rb.addEventListener("click", openQuotaResetModal);
  var rc = document.getElementById("btn-confirm-quota-reset");
  if (rc) rc.addEventListener("click", confirmQuotaReset);
  var ri = document.getElementById("quota-reset-confirm-input");
  if (ri) ri.addEventListener("input", function () {
    var btn = document.getElementById("btn-confirm-quota-reset");
    if (btn) btn.disabled = ri.value.trim().toUpperCase() !== "RESET";
  });

  // MET database sync
  var mc = document.getElementById("btn-metdb-check");
  if (mc) mc.addEventListener("click", checkMetDatabase);
  var ma = document.getElementById("btn-metdb-apply");
  if (ma) ma.addEventListener("click", applyMetDatabase);

  // MET database audit
  var ar = document.getElementById("btn-metaudit-run");
  if (ar) ar.addEventListener("click", runMetAudit);
  var af2 = document.getElementById("btn-metaudit-fill");
  if (af2) af2.addEventListener("click", function () { normaliseMetDb(false); });
  var arst = document.getElementById("btn-metaudit-reset");
  if (arst) arst.addEventListener("click", function () { normaliseMetDb(true); });

  // Adding the people the sheet is missing
  var mf = document.getElementById("btn-miss-find");
  if (mf) mf.addEventListener("click", findMissingMembers);
  var mad = document.getElementById("btn-miss-add");
  if (mad) mad.addEventListener("click", addMissingMembers);
  // One handler on the container rather than one per row, so a redraw does not
  // have to rewire anything.
  var mr = document.getElementById("miss-result");
  if (mr) mr.addEventListener("change", onMissChange);
  if (mr) mr.addEventListener("click", onMissClick);
});


// ── Adding the people the sheet is missing ─────────────────────────
// The sync only offers new joiners at the entry rank, so anybody who slipped
// through at a higher rank is invisible there. This lists everyone with no row,
// and adds exactly the ones that get ticked.
var missing = [];        // [{ username, rank, robloxId, discordId, probationary }]
var missPicked = {};     // username → true
var missWtbt = {};       // username → true, probationers only
var missHasWtbtCol = true;

function missRow(m) {
  var picked = !!missPicked[m.username];
  var wtbt = !!missWtbt[m.username];
  // The mark is only offered where it means something. A disabled tickbox with
  // a reason beats a live one that the server then refuses.
  var wtbtCell = m.probationary
    ? '<label class="miss-wtbt' + (missHasWtbtCol ? '' : ' off') + '">'
      + '<input type="checkbox" data-wtbt="' + escapeHtml(m.username) + '"' + (wtbt ? ' checked' : '')
      + (missHasWtbtCol ? '' : ' disabled') + ' /> '
      + '<span>' + (missHasWtbtCol ? 'Waiting to be trained' : 'No WTBT column on the sheet') + '</span></label>'
    : '<span class="miss-na" title="Only a Probationary Investigator can be waiting for training">—</span>';

  return '<tr class="' + (picked ? 'miss-on' : '') + '">'
    + '<td><input type="checkbox" data-pick="' + escapeHtml(m.username) + '"' + (picked ? ' checked' : '') + ' /></td>'
    + '<td><span class="mono" style="font-size:12.5px;">' + escapeHtml(m.username) + '</span></td>'
    + '<td><span style="font-size:12px;">' + escapeHtml(m.rank || '—') + '</span></td>'
    + '<td><span class="mono" style="font-size:11px;color:'
      + (m.discordId ? 'var(--text-secondary)' : 'var(--amber)') + ';">'
      + escapeHtml(m.discordId || 'not linked') + '</span></td>'
    + '<td>' + wtbtCell + '</td>'
    + '</tr>';
}

function renderMissing(out) {
  var box = document.getElementById("miss-result");
  if (!box) return;
  if (!out || out.error) {
    box.innerHTML = '<div class="metdb-error"><i class="ti ti-alert-triangle"></i> '
      + escapeHtml((out && out.error) || "Could not work out who is missing.") + '</div>';
    return;
  }
  if (!missing.length) {
    box.innerHTML = '<div class="metdb-applied"><i class="ti ti-check"></i> Everybody in the '
      + escapeHtml(out.group || metDbName()) + ' group has a row. '
      + escapeHtml(String(out.groupSize || 0)) + ' in the group, '
      + escapeHtml(String(out.sheetRows || 0)) + ' on the sheet.</div>';
    return;
  }
  var probs = missing.filter(function (m) { return m.probationary; }).length;
  box.innerHTML = '<div class="miss-head">'
    + '<strong>' + missing.length + '</strong> in the group with no row'
    + (probs ? ' · <strong>' + probs + '</strong> probationary' : '')
    + ' · ' + (out.groupSize || 0) + ' in the group, ' + (out.sheetRows || 0) + ' on the sheet'
    + '<span class="spacer"></span>'
    + '<button type="button" class="btn btn-ghost btn-sm" data-miss-all="1">'
    + (missing.every(function (m) { return missPicked[m.username]; }) ? 'Select none' : 'Select all') + '</button>'
    + '</div>'
    + (missHasWtbtCol ? '' : '<div class="metdb-error" style="margin-bottom:.6rem;">'
        + '<i class="ti ti-alert-triangle"></i> The sheet has no <code>WTBT</code> column, so the mark cannot '
        + 'be written. Add a column headed <code>WTBT</code> and check again.</div>')
    + '<div class="table-wrap"><table class="data-table"><thead><tr>'
    + '<th style="width:34px;"></th><th>Roblox</th><th>Group rank</th><th>Discord ID</th><th>Training</th>'
    + '</tr></thead><tbody>' + missing.map(missRow).join("") + '</tbody></table></div>';
  refreshMissButton();
}

function refreshMissButton() {
  var n = Object.keys(missPicked).filter(function (k) { return missPicked[k]; }).length;
  var btn = document.getElementById("btn-miss-add");
  if (!btn) return;
  btn.disabled = !n;
  btn.title = n ? "" : "Pick at least one person first";
  btn.innerHTML = '<i class="ti ti-user-plus"></i> Add ' + (n ? n + " selected" : "selected");
}

function onMissChange(ev) {
  var t = ev.target;
  if (!t || t.type !== "checkbox") return;
  if (t.dataset.pick) {
    missPicked[t.dataset.pick] = t.checked;
    // Unticking somebody drops their mark too: leaving it set would send a WTBT
    // for a person who is no longer in the batch the next time they are ticked.
    if (!t.checked) delete missWtbt[t.dataset.pick];
    var tr = t.closest("tr");
    if (tr) tr.classList.toggle("miss-on", t.checked);
    refreshMissButton();
    return;
  }
  if (t.dataset.wtbt) {
    missWtbt[t.dataset.wtbt] = t.checked;
    // Marking somebody as waiting to be trained is only meaningful if they are
    // actually being added, so it ticks them as well.
    if (t.checked && !missPicked[t.dataset.wtbt]) {
      missPicked[t.dataset.wtbt] = true;
      var box = document.querySelector('[data-pick="' + t.dataset.wtbt.replace(/"/g, '\\"') + '"]');
      if (box) box.checked = true;
      var row = t.closest("tr");
      if (row) row.classList.add("miss-on");
      refreshMissButton();
    }
  }
}

function onMissClick(ev) {
  var all = ev.target.closest("[data-miss-all]");
  if (!all) return;
  var everyone = missing.every(function (m) { return missPicked[m.username]; });
  missing.forEach(function (m) {
    missPicked[m.username] = !everyone;
    if (everyone) delete missWtbt[m.username];
  });
  renderMissing({ groupSize: missLast.groupSize, sheetRows: missLast.sheetRows, group: missLast.group });
}

var missLast = {};

async function findMissingMembers() {
  var btn = document.getElementById("btn-miss-find");
  var box = document.getElementById("miss-result");
  if (box) box.innerHTML = '<div class="table-loading" style="padding:1.4rem;"><div class="spinner"></div></div>';
  if (btn) { btn.disabled = true; btn.innerHTML = "<div class='spinner'></div> Reading the group…"; }
  try {
    var out = await api(metDbUrl("/missing"));
    missing = out.missing || [];
    missLast = out;
    missHasWtbtCol = out.hasWtbtColumn !== false;
    // A fresh list means a fresh selection. Keeping ticks across a reload would
    // let somebody add a person who has since been given a row.
    missPicked = {};
    missWtbt = {};
    renderMissing(out);
  } catch (err) {
    missing = [];
    renderMissing({ error: err.message });
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-user-search"></i> Find who is missing'; }
  }
}

async function addMissingMembers() {
  var picks = missing.filter(function (m) { return missPicked[m.username]; });
  if (!picks.length) return;
  var marked = picks.filter(function (m) { return missWtbt[m.username]; });

  var yes = await (typeof uiConfirm === "function"
    ? uiConfirm("Each one gets a new line on the " + metDbName() + " database with their rank, their "
        + "Discord ID where it is known, and every day at 0.\n\n"
        + picks.map(function (m) {
            return m.username + " — " + (m.rank || "no rank")
              + (missWtbt[m.username] ? " · waiting to be trained" : "");
          }).join("\n")
        + "\n\nNothing is removed, and anybody who already has a row is skipped.",
        { title: "Add " + picks.length + (picks.length === 1 ? " person?" : " people?"),
          confirmText: "Add " + (picks.length === 1 ? "them" : "all " + picks.length),
          cancelText: "Not yet", icon: "ti-user-plus" })
    : Promise.resolve(true));
  if (!yes) return;

  var btn = document.getElementById("btn-miss-add");
  var was = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.innerHTML = "<div class='spinner'></div> Writing…"; }
  try {
    var out = await api(metDbUrl("/add-members"), {
      method: "POST",
      body: JSON.stringify({
        members: picks.map(function (m) {
          return { username: m.username, discordId: m.discordId || "", wtbt: !!missWtbt[m.username] };
        }),
      }),
    });
    // A refusal that arrives with a 200 rather than a 400 must not be read as a
    // success — "undefined members added" is worse than the actual reason.
    if (out.error) {
      showToast(out.error, "error");
      return;
    }
    var bits = [out.added + (out.added === 1 ? " member added" : " members added")];
    if (marked.length && out.added) bits.push(marked.length + " waiting to be trained");
    if ((out.alreadyThere || []).length) bits.push((out.alreadyThere || []).length + " already had a row");
    if ((out.skipped || []).length) bits.push((out.skipped || []).length + " no longer in the group");
    showToast(bits.join(" · ") + ".", out.added ? "success" : "warning");
    // Where each one landed. Somebody who asked for a row in the right section
    // wants to be told it went there, not just that it went somewhere.
    var withRow = (out.placed || []).filter(function (p) { return p.row; });
    if (withRow.length) {
      showToast(withRow.map(function (p) {
        return p.username + " → row " + p.row + (p.under ? " (under the other " + p.under + "s)" : "");
      }).join(", "), "success");
    }
    if ((out.errors || []).length) showToast(out.errors.join("; "), "warning");
    // Re-read rather than patching the list: the sheet has changed, and the next
    // decision should be made against what is actually on it now.
    await findMissingMembers();
  } catch (err) {
    showToast(err.message || "Could not add them.", "error");
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = was; refreshMissButton(); }
  }
}

// ── MET database audit ────────────────────────────────────────────
// Read-only. Says what is wrong with the sheet; the two buttons beside it fix
// the half that is safe to fix from here (day cells), and everything structural
// — wrong rank tab, missing person, someone who has left — is listed for a
// human to act on rather than done silently.
var metAudit = null;

function auditGroup(title, items, tone, render) {
  if (!items || !items.length) return "";
  return '<div class="metdb-col"><div class="metdb-col-head">' + title
    + ' <span class="metdb-count ' + (tone || "") + '">' + items.length + '</span></div>'
    + '<ul class="metdb-list">' + items.slice(0, 60).map(render).join("")
    + (items.length > 60 ? '<li><span class="metdb-why">…and ' + (items.length - 60) + ' more</span></li>' : "")
    + '</ul></div>';
}

function problemsOf(report, kind) {
  return (report.members || []).filter(function (m) {
    return (m.problems || []).some(function (p) { return p.kind === kind; });
  });
}

function renderMetAudit(report) {
  var box = document.getElementById("metaudit-result");
  if (!box) return;
  if (!report || report.error) {
    box.innerHTML = '<div class="metdb-error"><i class="ti ti-alert-triangle"></i> '
      + escapeHtml((report && report.error) || "Audit failed.") + '</div>';
    return;
  }
  var s = report.summary || {};
  var pill = function (n, label, tone) {
    return '<span>' + label + ': <strong class="' + (n ? (tone || "") : "") + '">' + n + '</strong></span>';
  };
  var summary = '<div class="metdb-summary">'
    + pill(s.members || 0, "on the sheet")
    + pill(s.clean || 0, "with nothing wrong", "good")
    + pill(s.wrongTab || 0, "wrong rank tab", "bad")
    + pill(s.missingFromSheet || 0, "in the group, not on a tab", "bad")
    + pill(s.notInGroup || 0, "left the group", "bad")
    + pill(s.duplicates || 0, "duplicate rows", "bad")
    + pill(s.blankDays || 0, "blank day cells", "bad")
    + pill(s.junkDays || 0, "unreadable day cells", "bad")
    + pill(s.missingDiscordId || 0, "no Discord ID", "bad")
    + pill(s.markers || 0, "EX/LOA (kept)")
    + '</div>'
    + (report.groupError
        ? '<div class="metdb-hint"><i class="ti ti-alert-triangle"></i> Couldn\'t read the ' + escapeHtml(report.groupName || metDbName()) + ' Roblox group, so the group cross-check was skipped: '
          + escapeHtml(report.groupError) + '</div>'
        : "");

  var where = function (m) { return escapeHtml(m.tab) + " row " + m.row; };
  var cols = '<div class="metdb-cols">'
    + auditGroup("Wrong rank tab", problemsOf(report, "WRONG_TAB"), "bad", function (m) {
        var p = (m.problems || []).find(function (x) { return x.kind === "WRONG_TAB"; }) || {};
        return '<li><span class="metdb-name">' + escapeHtml(m.username) + '</span>'
          + '<span class="metdb-why">' + where(m) + " — " + escapeHtml(p.detail || "") + '</span></li>';
      })
    + auditGroup("In the group, not on the sheet", report.missingFromSheet || [], "bad", function (g) {
        // Only the MET database is split by rank tab, so only it can say WHERE
        // the row belongs. On a single-roster database the rank is the answer.
        return '<li><span class="metdb-name">' + escapeHtml(g.username) + '</span>'
          + '<span class="metdb-why">' + escapeHtml(g.rank || "")
          + (g.shouldBe ? ' — add to "' + escapeHtml(g.shouldBe) + '"' : " — not on the sheet") + '</span></li>';
      })
    + auditGroup("On the sheet, not in the group", problemsOf(report, "NOT_IN_GROUP"), "bad", function (m) {
        return '<li><span class="metdb-name">' + escapeHtml(m.username) + '</span>'
          + '<span class="metdb-why">' + where(m) + '</span></li>';
      })
    + auditGroup("Duplicate rows", problemsOf(report, "DUPLICATE"), "bad", function (m) {
        var p = (m.problems || []).find(function (x) { return x.kind === "DUPLICATE"; }) || {};
        return '<li><span class="metdb-name">' + escapeHtml(m.username) + '</span>'
          + '<span class="metdb-why">' + escapeHtml(p.detail || "") + '</span></li>';
      })
    + auditGroup("No Discord ID", problemsOf(report, "MISSING_DISCORD_ID"), "bad", function (m) {
        return '<li><span class="metdb-name">' + escapeHtml(m.username) + '</span>'
          + '<span class="metdb-why">' + where(m) + '</span></li>';
      })
    + auditGroup("Rank the database doesn't track", problemsOf(report, "RANK_NOT_TRACKED"), "", function (m) {
        var p = (m.problems || []).find(function (x) { return x.kind === "RANK_NOT_TRACKED"; }) || {};
        return '<li><span class="metdb-name">' + escapeHtml(m.username) + '</span>'
          + '<span class="metdb-why">' + where(m) + " — " + escapeHtml(p.detail || "") + '</span></li>';
      })
    + '</div>';

  var footer = (s.blankDays || s.junkDays)
    ? '<div class="metdb-hint"><i class="ti ti-info-circle"></i> <strong>Fill blanks with 0</strong> will write '
      + ((s.blankDays || 0) + (s.junkDays || 0)) + ' cell(s). Nothing has been written yet.</div>'
    : '<div class="metdb-hint"><i class="ti ti-check"></i> No blank or unreadable day cells.</div>';

  box.innerHTML = summary + cols + footer;
}

async function runMetAudit() {
  var btn = document.getElementById("btn-metaudit-run");
  var box = document.getElementById("metaudit-result");
  if (box) box.innerHTML = '<div class="table-loading" style="padding:1.4rem;"><div class="spinner"></div></div>';
  if (btn) { btn.disabled = true; btn.innerHTML = "<div class='spinner'></div> Auditing…"; }
  try {
    metAudit = await api(metDbUrl("/audit"));
    renderMetAudit(metAudit);
    var t = document.getElementById("metaudit-target");
    if (t && metAudit.target != null) t.textContent = metAudit.target;
    var fill = document.getElementById("btn-metaudit-fill");
    var reset = document.getElementById("btn-metaudit-reset");
    var s = metAudit.summary || {};
    if (fill)  fill.disabled  = !((s.blankDays || 0) + (s.junkDays || 0));
    if (reset) reset.disabled = !(s.members || 0);
  } catch (err) {
    metAudit = null;
    renderMetAudit({ error: err.message || "Audit failed." });
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = "<i class='ti ti-list-search'></i> Audit"; }
  }
}

async function normaliseMetDb(reset) {
  if (!metAudit) { showToast("Run the audit first.", "error"); return; }
  var s = metAudit.summary || {};
  if (reset) {
    // Zeroing a live database is not something to do by accident, and there is
    // no undo — so the confirmation says the number out loud.
    var ok = await (typeof uiConfirm === "function"
      ? uiConfirm("Reset EVERY day cell on the " + metDbName() + " database to 0? That clears "
          + (s.pointsToClear || 0) + " point(s) across " + (s.members || 0)
          + " member(s). EX and LOA cells are left alone. This cannot be undone.")
      : Promise.resolve(confirm("Reset every day cell to 0? This cannot be undone.")));
    if (!ok) return;
  }

  var btn = document.getElementById(reset ? "btn-metaudit-reset" : "btn-metaudit-fill");
  var label = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.innerHTML = "<div class='spinner'></div> Writing…"; }
  try {
    var result = await api(metDbUrl("/normalise"), {
      method: "POST",
      body: JSON.stringify({ reset: !!reset, fillBlanks: true, apply: true }),
    });
    showToast(reset
      ? metDbName() + " database reset — " + result.cleared + " cell(s) cleared, " + result.filled
        + " blank(s) filled, " + result.kept + " EX/LOA kept."
      : "Filled " + result.filled + " blank cell(s).", "success");
    await runMetAudit();
  } catch (err) {
    showToast(err.message || "Write failed.", "error");
  } finally {
    if (btn) { btn.innerHTML = label; }
  }
}

// ── MET database sync ─────────────────────────────────────────────
// "Check" is a dry run: it shows exactly who would be removed (no longer in the
// MET group) and who would be added (newly joined constables) before anything
// is written. "Apply" performs the same plan for real.
var metDbPlan = null;

function metdbList(title, items, colour, render) {
  if (!items.length) {
    return '<div class="metdb-col"><div class="metdb-col-head">' + title
      + ' <span class="metdb-count">0</span></div>'
      + '<div class="metdb-empty">Nothing to do.</div></div>';
  }
  return '<div class="metdb-col"><div class="metdb-col-head">' + title
    + ' <span class="metdb-count ' + colour + '">' + items.length + '</span></div>'
    + '<ul class="metdb-list">' + items.map(render).join("") + '</ul></div>';
}

function renderMetDbPlan(plan, applied) {
  var box = document.getElementById("metdb-result");
  if (!box) return;

  if (plan.error) {
    box.innerHTML = '<div class="metdb-error"><i class="ti ti-alert-triangle"></i> ' + escapeHtml(plan.error) + '</div>';
    return;
  }

  var summary = '<div class="metdb-summary">'
    + '<span><strong>' + (plan.sheetRows || 0) + '</strong> on the sheet</span>'
    + '<span><strong>' + (plan.groupSize || 0) + '</strong> in the ' + escapeHtml(metDbName()) + ' group</span>'
    + '<span><strong>' + (plan.keep || 0) + '</strong> matched</span>'
    + (plan.joinRanks && plan.joinRanks.length
        ? '<span>new joiners: <strong>' + escapeHtml(plan.joinRanks.join(", ")) + '</strong></span>' : '')
    + ((plan.renamed && plan.renamed.length)
        ? '<span><strong>' + plan.renamed.length + '</strong> renamed (kept)</span>' : '')
    + '</div>'
    + ((plan.renamed && plan.renamed.length)
        ? '<div class="metdb-hint"><i class="ti ti-info-circle"></i> Matched by Discord ID after a Roblox rename: '
          + plan.renamed.map(function (r) { return escapeHtml(r.was) + ' → ' + escapeHtml(r.now); }).join(", ")
          + '</div>' : '');

  var cols = '<div class="metdb-cols">'
    + metdbList("Remove", plan.remove || [], "bad", function (r) {
        return '<li><span class="metdb-name">' + escapeHtml(r.username) + '</span>'
          + '<span class="metdb-why">' + escapeHtml(r.why || ("not in the " + metDbName() + " group")) + '</span></li>';
      })
    + metdbList("Add", plan.add || [], "good", function (a) {
        return '<li><span class="metdb-name">' + escapeHtml(a.username) + '</span>'
          + '<span class="metdb-why">' + escapeHtml(a.rank || "") + '</span></li>';
      })
    + '</div>';

  var footer = applied
    ? '<div class="metdb-applied"><i class="ti ti-check"></i> Applied — removed '
      + (plan.removed || 0) + ', added ' + (plan.added || 0)
      + (plan.errors && plan.errors.length ? ' (' + escapeHtml(plan.errors.join("; ")) + ')' : '') + '</div>'
    : ((plan.remove || []).length || (plan.add || []).length
        ? '<div class="metdb-hint"><i class="ti ti-info-circle"></i> Nothing has been written yet. Press <strong>Apply changes</strong> to make it so.</div>'
        : '<div class="metdb-hint"><i class="ti ti-check"></i> The database already matches the ' + escapeHtml(metDbName()) + ' group.</div>');

  box.innerHTML = summary + cols + footer;
}

async function checkMetDatabase() {
  var btn = document.getElementById("btn-metdb-check");
  var apply = document.getElementById("btn-metdb-apply");
  var box = document.getElementById("metdb-result");
  if (box) box.innerHTML = '<div class="table-loading" style="padding:1.4rem;"><div class="spinner"></div></div>';
  if (btn) { btn.disabled = true; btn.innerHTML = "<div class='spinner'></div> Checking…"; }
  try {
    metDbPlan = await api(metDbUrl(""));
    renderMetDbPlan(metDbPlan, false);
    if (apply) apply.disabled = !((metDbPlan.remove || []).length || (metDbPlan.add || []).length);
  } catch (err) {
    metDbPlan = null;
    if (box) box.innerHTML = '<div class="metdb-error"><i class="ti ti-alert-triangle"></i> ' + escapeHtml(err.message || "Check failed.") + '</div>';
    if (apply) apply.disabled = true;
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = "<i class='ti ti-search'></i> Check"; }
  }
}

async function applyMetDatabase() {
  if (!metDbPlan) { showToast("Run a check first.", "error"); return; }
  var total = (metDbPlan.remove || []).length + (metDbPlan.add || []).length;
  if (!confirm("This will remove " + (metDbPlan.remove || []).length + " member(s) from the database sheet and add "
      + (metDbPlan.add || []).length + " new joiner(s). " + total + " row(s) change. Continue?")) return;
  // A removed member's whole row is cleared, so this is not reversible from here.

  var btn = document.getElementById("btn-metdb-apply");
  if (btn) { btn.disabled = true; btn.innerHTML = "<div class='spinner'></div> Applying…"; }
  try {
    var result = await api(metDbUrl("/sync"), {
      method: "POST", body: JSON.stringify({ token: metDbPlan.token || null }),
    });
    renderMetDbPlan(result, true);
    showToast(metDbName() + " database synced — removed " + (result.removed || 0) + ", added " + (result.added || 0) + ".", "success");
    metDbPlan = null;
    if (typeof loadQuotaCheck === "function") loadQuotaCheck();
  } catch (err) {
    showToast(err.message || "Sync failed.", "error");
  } finally {
    if (btn) { btn.innerHTML = "<i class='ti ti-refresh'></i> Apply changes"; btn.disabled = true; }
  }
}

function openQuotaResetModal() {
  var ri = document.getElementById("quota-reset-confirm-input");
  if (ri) ri.value = "";
  var btn = document.getElementById("btn-confirm-quota-reset");
  if (btn) btn.disabled = true;
  openModal("modal-quota-reset");
}

async function confirmQuotaReset() {
  var btn = document.getElementById("btn-confirm-quota-reset");
  if (btn) { btn.disabled = true; btn.innerHTML = "<div class='spinner'></div> Resetting…"; }
  try {
    var d = await api("/api/quota/reset", { method: "POST" });
    closeModal("modal-quota-reset");
    showToast("All quota points reset to 0" + (d && d.cleared != null ? " (" + d.cleared + " cells)" : "") + ".", "success");
    loadQuotaCheck();
  } catch (err) {
    showToast(err.message || "Failed to reset quota.", "error");
  } finally {
    if (btn) { btn.innerHTML = "<i class='ti ti-trash'></i> Reset everyone to 0"; }
  }
}

async function loadQuotaCheck() {
  var tbody = document.getElementById("quota-check-tbody");
  if (!tbody) return;
  tbody.innerHTML = "<tr><td colspan='8' class='table-loading'><div class='spinner'></div></td></tr>";
  try {
    var d = await api("/api/quota/members");
    if (!d || !d.configured) {
      var CFG = window.metEmpty
        ? window.metEmpty({ icon: "ti-alert-triangle", title: "Quota sheet not configured", sub: "Read access needs the Google service account." })
        : "<span class='table-empty-text'>Quota sheet read access isn't configured (needs the Google service account).</span>";
      tbody.innerHTML = "<tr><td colspan='8' class='table-empty'>" + CFG + "</td></tr>";
      return;
    }
    quotaMembersCache = d.members || [];
    renderQuotaCheck();
    populateIotwSelector();
  } catch (e) {
    tbody.innerHTML = "<tr><td colspan='8' class='table-empty'><span class='table-empty-text'>Failed to load quota data.</span></td></tr>";
  }
}

// Which rank the table is filtered to ("ALL" = everyone).
var quotaRankFilter = "ALL";

function setQuotaRankFilter(v) { quotaRankFilter = v || "ALL"; renderQuotaCheck(); }

// The rank picker, built from the ranks actually present on the sheet.
function renderQuotaFilter() {
  var host = document.getElementById("quota-check-filter");
  if (!host) return;
  var ranks = [];
  quotaMembersCache.forEach(function (m) {
    var r = (m.rank || "").trim();
    if (r && ranks.indexOf(r) < 0) ranks.push(r);
  });
  var w = window.metRankWeight || function () { return 0; };
  ranks.sort(function (a, b) { return w(a) - w(b); });
  if (ranks.length < 2) { host.innerHTML = ""; return; }
  var opts = ["<option value='ALL'" + (quotaRankFilter === "ALL" ? " selected" : "") + ">All ranks</option>"];
  ranks.forEach(function (r) {
    opts.push("<option value='" + escapeHtml(r) + "'" + (quotaRankFilter === r ? " selected" : "") + ">" + escapeHtml(r) + "</option>");
  });
  host.innerHTML = "<select class='form-control' style='padding:4px 8px;height:auto;font-size:12px;' "
    + "title='Filter by rank' onchange='setQuotaRankFilter(this.value)'>" + opts.join("") + "</select>";
}

// Whether the quota was met, as a chip. Same wording as every other division's
// table: "MET" on its own reads as the police service, so it says which.
function quotaStatusChip(m) {
  var q = m.quota || {};
  if (q.exempt) return "<span class='badge badge-approved' style='background:color-mix(in srgb,var(--purple,#9b6dff) 20%,transparent);color:var(--purple,#9b6dff);'><span class='badge-dot'></span>Quota exempt</span>";
  if (m.met === true)  return "<span class='badge badge-approved'><span class='badge-dot'></span>Quota met</span>";
  if (m.met === false) return "<span class='badge badge-pending'><span class='badge-dot'></span>Quota not met</span>";
  return "<span class='text-muted' style='font-size:12px;'>—</span>";
}

function renderQuotaCheck() {
  var tbody   = document.getElementById("quota-check-tbody");
  var countEl = document.getElementById("quota-check-count");
  if (!tbody) return;
  if (!quotaMembersCache.length) {
    var EMPTY = window.metEmpty
      ? window.metEmpty({ icon: "ti-users", title: "No members found in the sheet." })
      : "<span class='table-empty-text'>No members found in the sheet.</span>";
    tbody.innerHTML = "<tr><td colspan='8' class='table-empty'>" + EMPTY + "</td></tr>";
    if (countEl) countEl.textContent = "";
    renderQuotaFilter();
    return;
  }
  renderQuotaFilter();

  // Rank order, highest first — and the index kept, because the decision
  // dropdowns write back into quotaMembersCache by position.
  var w = window.metRankWeight || function () { return 0; };
  var idxs = [];
  for (var n = 0; n < quotaMembersCache.length; n++) {
    if (quotaRankFilter !== "ALL" && (quotaMembersCache[n].rank || "").trim() !== quotaRankFilter) continue;
    idxs.push(n);
  }
  idxs.sort(function (a, b) { return (w(quotaMembersCache[a].rank) - w(quotaMembersCache[b].rank)) || (a - b); });

  if (countEl) {
    countEl.textContent = idxs.length === quotaMembersCache.length
      ? quotaMembersCache.length + " members"
      : idxs.length + " of " + quotaMembersCache.length + " members";
  }
  if (!idxs.length) {
    tbody.innerHTML = "<tr><td colspan='8' class='table-empty'><span class='table-empty-text'>No members at that rank.</span></td></tr>";
    return;
  }

  tbody.innerHTML = idxs.map(function (i) {
    var m = quotaMembersCache[i];
    var q       = m.quota || {};
    var exempt  = !!q.exempt;
    var reduced = (!exempt && q.reducedBy && q.target != null);
    var original = reduced ? (q.target + q.reducedBy) : null;
    var target  = exempt ? "EX" : (q.target != null ? q.target : "—");
    // Make it clear the original target was reduced (Investigator of the Week).
    var reducedNote = reduced
      ? " <span style='color:var(--amber);font-size:10px;' title='Investigator of the Week — original target " + original + ", reduced by " + q.reducedBy + "'>(was " + original + ", IOTW −" + q.reducedBy + ")</span>"
      : "";
    // Pass ONLY when the quota was actually met; everything else fails (or exempt).
    if (!m._status) m._status = exempt ? "exempt" : (m.met === true ? "pass" : "fail");
    var status  = m._status;
    var ptColor = (exempt || status === "exempt" || status === "loa") ? "var(--purple)" : (m.met ? "var(--green)" : "var(--amber)");

    var sel = "<select class='form-control' style='padding:4px 8px;height:auto;font-size:12px;' onchange='setQuotaStatus(" + i + ",this.value)'>"
      + "<option value='pass'"   + (status === "pass"   ? " selected" : "") + ">Pass</option>"
      + "<option value='fail'"   + (status === "fail"   ? " selected" : "") + ">Fail</option>"
      + "<option value='exempt'" + (status === "exempt" ? " selected" : "") + ">Exempt</option>"
      + "<option value='loa'"    + (status === "loa"    ? " selected" : "") + ">Leave of Absence</option>"
      + "</select>";
    var reason = "<input type='text' class='form-control' style='padding:4px 8px;height:auto;font-size:12px;"
      + (status === "fail" ? "" : "display:none;") + "' id='quota-reason-" + i + "' placeholder='Reason…' value='"
      + escapeHtml(m._reason || "") + "' oninput='setQuotaReason(" + i + ",this.value)' />";

    return "<tr>"
      + "<td><span style='font-weight:600;font-size:12px;'>" + escapeHtml(m.username) + "</span></td>"
      + "<td><span style='font-size:12px;'>" + escapeHtml(m.rank || "—") + "</span></td>"
      + "<td><span class='text-muted' style='font-size:11px;'>" + escapeHtml(q.tier || "") + "</span></td>"
      + "<td><span style='font-weight:700;color:" + ptColor + ";'>" + (exempt ? "EX" : m.total) + "</span></td>"
      + "<td><span class='mono' style='font-size:12px;'>" + target + reducedNote + "</span></td>"
      + "<td>" + quotaStatusChip(m) + "</td>"
      + "<td>" + sel + "</td>"
      + "<td>" + reason + "</td>"
      + "</tr>";
  }).join("");
}

// Build the Investigator of the Week dropdown, defaulting to the highest-point
// (non-exempt) member and noting any tie.
function populateIotwSelector() {
  var sel = document.getElementById("iotw-select");
  var tie = document.getElementById("iotw-tie-note");
  if (!sel) return;

  var max = 0;
  quotaMembersCache.forEach(function (m) {
    if (m.quota && m.quota.exempt) return;
    var t = Number(m.total) || 0;
    if (t > max) max = t;
  });
  var tops = [];
  quotaMembersCache.forEach(function (m, i) {
    if (m.quota && m.quota.exempt) return;
    if ((Number(m.total) || 0) === max && max > 0) tops.push(i);
  });
  var defaultIdx = tops.length ? tops[0] : "";

  var opts = "<option value=''>— No Investigator of the Week —</option>";
  quotaMembersCache.forEach(function (m, i) {
    var star = tops.indexOf(i) >= 0 ? " ★" : "";
    opts += "<option value='" + i + "'" + (i === defaultIdx ? " selected" : "") + ">"
      + escapeHtml(m.username) + (m.rank ? " · " + escapeHtml(m.rank) : "")
      + " — " + (Number(m.total) || 0) + " pts" + star + "</option>";
  });
  sel.innerHTML = opts;

  if (tie) {
    if (tops.length > 1) {
      tie.style.display = "";
      tie.textContent = "Tie for highest (" + max + " pts) between "
        + tops.map(function (i) { return quotaMembersCache[i].username; }).join(", ") + " — pick one.";
    } else {
      tie.style.display = "none";
    }
  }
}

async function setQuotaStatus(i, val) {
  var m = quotaMembersCache[i];
  if (!m) return;

  // Exempt / Leave of Absence both write a marker to the sheet immediately.
  if (val === "exempt" || val === "loa") {
    var isLoa = val === "loa";
    var label = isLoa ? "Leave of Absence" : "EXEMPT";
    var mark  = isLoa ? "LOA" : "EX";
    // In-page confirm (not window.confirm) so the privacy guard isn't triggered.
    var okGo = await quotaConfirm("Mark " + m.username + " as " + label + "? This writes \"" + mark + "\" to their day cells on the sheet, so they no longer need to meet a quota.");
    if (!okGo) { renderQuotaCheck(); return; } // revert the dropdown
    try {
      await api(isLoa ? "/api/quota/loa" : "/api/quota/exempt", { method: "POST", body: JSON.stringify({ username: m.username }) });
      if (!m.quota) m.quota = {};
      m.quota.exempt = true; m._status = val;
      showToast(m.username + " set to " + (isLoa ? "Leave of Absence" : "exempt") + ".", "success");
    } catch (err) {
      showToast(err.message || ("Failed to set " + (isLoa ? "LOA" : "exempt") + "."), "error");
      m._status = m.met === true ? "pass" : "fail";
    }
    renderQuotaCheck();
    return;
  }
  m._status = val;
  var rin = document.getElementById("quota-reason-" + i);
  if (rin) rin.style.display = val === "fail" ? "" : "none";
}

// Lightweight in-page confirm (returns a Promise<boolean>). Avoids window.confirm,
// which blurs the window and trips the privacy-guard "Content hidden" overlay.
function quotaConfirm(message) {
  return new Promise(function (resolve) {
    var ov = document.createElement("div");
    ov.style.cssText = "position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);";
    ov.innerHTML = "<div class='glass-bright' style='max-width:420px;width:90%;padding:1.4rem;border-radius:12px;'>"
      + "<div style='font-size:13px;line-height:1.6;color:var(--text-secondary);margin-bottom:1.2rem;'>" + escapeHtml(message) + "</div>"
      + "<div style='display:flex;gap:8px;justify-content:flex-end;'>"
      + "<button class='btn btn-ghost' id='qc-no'>Cancel</button>"
      + "<button class='btn btn-primary' id='qc-yes'>Confirm</button>"
      + "</div></div>";
    document.body.appendChild(ov);
    var done = function (v) { ov.remove(); resolve(v); };
    ov.querySelector("#qc-yes").onclick = function () { done(true); };
    ov.querySelector("#qc-no").onclick  = function () { done(false); };
    ov.onclick = function (e) { if (e.target === ov) done(false); };
  });
}
function setQuotaReason(i, val) { if (quotaMembersCache[i]) quotaMembersCache[i]._reason = val; }

function applyQuotaAuto() {
  quotaMembersCache.forEach(function (m) {
    m._status = (m.quota && m.quota.exempt) ? "exempt" : (m.met === true ? "pass" : "fail");
  });
  renderQuotaCheck();
  showToast("Decisions set from quota targets.", "info");
}

async function submitQuotaCheck() {
  if (!quotaMembersCache.length) { showToast("Nothing to submit.", "error"); return; }
  var results = quotaMembersCache.map(function (m) {
    // LOA is treated as a form of exemption for the weekly review.
    var exempt = (m._status === "exempt") || (m._status === "loa") || !!(m.quota && m.quota.exempt);
    return {
      username: m.username,
      rank:     m.rank,
      exempt:   exempt,
      total:    exempt ? null : m.total,
      target:   exempt ? null : (m.quota ? m.quota.target : null),
      status:   exempt ? "exempt" : (m._status === "fail" ? "fail" : (m._status === "pass" ? "pass" : (m.met === true ? "pass" : "fail"))),
      reason:   m._status === "fail" ? (m._reason || "") : "",
    };
  });
  // Investigator of the Week selection
  var iotwSel = document.getElementById("iotw-select");
  var iotwUsername = "", iotwDiscordId = "";
  if (iotwSel && iotwSel.value !== "" && quotaMembersCache[iotwSel.value]) {
    var iw = quotaMembersCache[iotwSel.value];
    iotwUsername  = iw.username;
    iotwDiscordId = iw.discordId || "";
  }

  var btn = document.getElementById("btn-submit-quota-check");
  if (btn) { btn.disabled = true; btn.innerHTML = "<div class='spinner'></div> Posting…"; }
  try {
    var resp = await api("/api/quota/check", { method: "POST", body: JSON.stringify({ results, iotwUsername: iotwUsername, iotwDiscordId: iotwDiscordId }) });
    var iotwMsg = "";
    if (iotwUsername) {
      iotwMsg = (resp && resp.iotw && resp.iotw.ok)
        ? " " + iotwUsername + " is now Investigator of the Week."
        : " (Couldn't update the IOTW role — check the bot's access to that server.)";
    }
    showToast("Quota review posted to Discord." + iotwMsg, "success");
  } catch (err) {
    showToast(err.message || "Failed to post quota review.", "error");
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = "<i class='ti ti-send'></i> Submit &amp; Post Results"; }
  }
}
