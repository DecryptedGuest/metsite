// client/public/js/flp-quota-check.js — FLP High Command weekly quota review.
// Mirrors the IA "Quota Check" UI, but scoped: scope 'FLP' reviews the FLP
// sheet, scope 'MET' reviews the MET database sheet. Every request goes through
// /api/flp/quota/*?scope=FLP|MET (server selects the right division config).
// Reuses the shared ui.js helpers (api, showToast, uiConfirm).
var flpQuotaCache = { FLP: [], MET: [] };
// Which rank tab the review is filtered to ("ALL" = every rank). MET databases
// split members across per-rank tabs (Chief Inspector / Inspector / Sergeant /
// Constable) — the selector lets HICOMM switch between them.
var flpQuotaFilter = { FLP: "ALL", MET: "ALL" };
var FLP_MET_RANK_ORDER = ["Chief Inspector", "Inspector", "Sergeant", "Constable"];

function fqEsc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

async function flpQuotaLoad(scope) {
  var tbody = document.getElementById("flpq-" + scope + "-tbody");
  if (!tbody) return;
  tbody.innerHTML = "<tr><td colspan='7' class='table-loading'><div class='spinner'></div></td></tr>";
  try {
    var d = await api("/api/flp/quota/members?scope=" + scope);
    if (!d || !d.configured) {
      flpQuotaCache[scope] = [];
      var CFG = window.metEmpty
        ? window.metEmpty({ icon: "ti-alert-triangle", title: "Quota sheet not configured", sub: "Read access for " + scope + " needs the Google service account and the " + scope + " sheet id." })
        : "<span class='table-empty-text'>Quota sheet read access isn't configured for " + scope + " (needs the Google service account and the " + scope + " sheet id).</span>";
      tbody.innerHTML = "<tr><td colspan='7' class='table-empty'>" + CFG + "</td></tr>";
      return;
    }
    flpQuotaCache[scope] = d.members || [];
    flpQuotaRenderTabs(scope);
    flpQuotaRender(scope);
  } catch (e) {
    tbody.innerHTML = "<tr><td colspan='7' class='table-empty'><span class='table-empty-text'>Failed to load quota data.</span></td></tr>";
  }
}

// Distinct ranks present in the loaded members, ordered high→low for MET.
function flpQuotaRanks(scope) {
  var seen = {}, out = [];
  (flpQuotaCache[scope] || []).forEach(function (m) {
    var r = (m.rank || "").trim();
    if (r && !seen[r]) { seen[r] = 1; out.push(r); }
  });
  out.sort(function (a, b) {
    var ia = FLP_MET_RANK_ORDER.indexOf(a); if (ia === -1) ia = 99;
    var ib = FLP_MET_RANK_ORDER.indexOf(b); if (ib === -1) ib = 99;
    return ia - ib || a.localeCompare(b);
  });
  return out;
}

// Render the rank-tab <select> (only when there's more than one rank to switch
// between). Keeps the current selection.
function flpQuotaRenderTabs(scope) {
  var host = document.getElementById("flpq-" + scope + "-tabs");
  if (!host) return;
  var ranks = flpQuotaRanks(scope);
  if (ranks.length < 2) { host.innerHTML = ""; return; }
  var cur = flpQuotaFilter[scope] || "ALL";
  var opts = ["<option value='ALL'" + (cur === "ALL" ? " selected" : "") + ">All ranks</option>"];
  ranks.forEach(function (r) {
    opts.push("<option value='" + fqEsc(r) + "'" + (cur === r ? " selected" : "") + ">" + fqEsc(r) + "</option>");
  });
  host.innerHTML = "<select class='form-control' style='padding:4px 8px;height:auto;font-size:12px;' "
    + "title='Filter by rank tab' onchange=\"flpQuotaSetFilter('" + scope + "',this.value)\">" + opts.join("") + "</select>";
}

function flpQuotaSetFilter(scope, val) {
  flpQuotaFilter[scope] = val || "ALL";
  flpQuotaRender(scope);
}

function flpQuotaRender(scope) {
  var tbody = document.getElementById("flpq-" + scope + "-tbody");
  var countEl = document.getElementById("flpq-" + scope + "-count");
  var all = flpQuotaCache[scope] || [];
  if (!tbody) return;
  if (!all.length) {
    var EMPTY = window.metEmpty
      ? window.metEmpty({ icon: "ti-users", title: "No members found in the sheet." })
      : "<span class='table-empty-text'>No members found in the sheet.</span>";
    tbody.innerHTML = "<tr><td colspan='7' class='table-empty'>" + EMPTY + "</td></tr>";
    if (countEl) countEl.textContent = "";
    return;
  }
  // Filter to the selected rank tab, keeping each member's ORIGINAL cache index
  // (the row controls call back into the cache by index).
  var filter = flpQuotaFilter[scope] || "ALL";
  var rows = [];
  for (var idx = 0; idx < all.length; idx++) {
    if (filter !== "ALL" && (all[idx].rank || "").trim() !== filter) continue;
    rows.push(idx);
  }
  if (countEl) countEl.textContent = filter === "ALL"
    ? all.length + " members"
    : rows.length + " / " + all.length + " members";
  if (!rows.length) {
    tbody.innerHTML = "<tr><td colspan='7' class='table-empty'><span class='table-empty-text'>No members on this rank tab.</span></td></tr>";
    return;
  }

  tbody.innerHTML = rows.map(function (i) {
    var m = all[i];
    var q = m.quota || {};
    var exempt = !!q.exempt;
    var target = exempt ? "EX" : (q.target != null ? q.target : "—");
    if (!m._status) m._status = exempt ? "exempt" : (m.met === true ? "pass" : "fail");
    var status = m._status;
    var ptColor = (exempt || status === "exempt" || status === "loa") ? "var(--purple)" : (m.met ? "var(--green)" : "var(--amber)");

    var sel = "<select class='form-control' style='padding:4px 8px;height:auto;font-size:12px;' onchange=\"flpQuotaSetStatus('" + scope + "'," + i + ",this.value)\">"
      + "<option value='pass'"   + (status === "pass"   ? " selected" : "") + ">Pass</option>"
      + "<option value='fail'"   + (status === "fail"   ? " selected" : "") + ">Fail</option>"
      + "<option value='exempt'" + (status === "exempt" ? " selected" : "") + ">Exempt</option>"
      + "<option value='loa'"    + (status === "loa"    ? " selected" : "") + ">Leave of Absence</option>"
      + "</select>";
    var reason = "<input type='text' class='form-control' style='padding:4px 8px;height:auto;font-size:12px;"
      + (status === "fail" ? "" : "display:none;") + "' id='flpq-" + scope + "-reason-" + i + "' placeholder='Reason…' value='"
      + fqEsc(m._reason || "") + "' oninput=\"flpQuotaSetReason('" + scope + "'," + i + ",this.value)\" />";

    return "<tr>"
      + "<td><span style='font-weight:600;font-size:12px;'>" + fqEsc(m.username) + "</span></td>"
      + "<td><span style='font-size:12px;'>" + fqEsc(m.rank || "—") + "</span></td>"
      + "<td><span class='text-muted' style='font-size:11px;'>" + fqEsc(q.tier || "") + "</span></td>"
      + "<td><span style='font-weight:700;color:" + ptColor + ";'>" + (exempt ? "EX" : m.total) + "</span></td>"
      + "<td><span class='mono' style='font-size:12px;'>" + target + "</span></td>"
      + "<td>" + sel + "</td>"
      + "<td>" + reason + "</td>"
      + "</tr>";
  }).join("");
}

async function flpQuotaSetStatus(scope, i, val) {
  var m = (flpQuotaCache[scope] || [])[i];
  if (!m) return;

  // Exempt / Leave of Absence write a marker to the sheet immediately.
  if (val === "exempt" || val === "loa") {
    var isLoa = val === "loa";
    var label = isLoa ? "Leave of Absence" : "EXEMPT";
    var mark  = isLoa ? "LOA" : "EX";
    var okGo = await uiConfirm("Mark " + m.username + " as " + label + "? This writes \"" + mark + "\" to their day cells on the " + scope + " sheet, so they no longer need to meet a quota.");
    if (!okGo) { flpQuotaRender(scope); return; }
    try {
      await api("/api/flp/quota/" + (isLoa ? "loa" : "exempt") + "?scope=" + scope, { method: "POST", body: JSON.stringify({ username: m.username }) });
      if (!m.quota) m.quota = {};
      m.quota.exempt = true; m._status = val;
      showToast(m.username + " set to " + (isLoa ? "Leave of Absence" : "exempt") + ".", "success");
    } catch (err) {
      showToast(err.message || ("Failed to set " + (isLoa ? "LOA" : "exempt") + "."), "error");
      m._status = m.met === true ? "pass" : "fail";
    }
    flpQuotaRender(scope);
    return;
  }
  m._status = val;
  var rin = document.getElementById("flpq-" + scope + "-reason-" + i);
  if (rin) rin.style.display = val === "fail" ? "" : "none";
}

function flpQuotaSetReason(scope, i, val) {
  if ((flpQuotaCache[scope] || [])[i]) flpQuotaCache[scope][i]._reason = val;
}

function flpQuotaAuto(scope) {
  (flpQuotaCache[scope] || []).forEach(function (m) {
    m._status = (m.quota && m.quota.exempt) ? "exempt" : (m.met === true ? "pass" : "fail");
  });
  flpQuotaRender(scope);
  showToast("Decisions set from quota targets.", "info");
}

async function flpQuotaSubmit(scope) {
  var list = flpQuotaCache[scope] || [];
  if (!list.length) { showToast("Nothing to submit.", "error"); return; }
  var results = list.map(function (m) {
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
  try {
    await api("/api/flp/quota/check?scope=" + scope, { method: "POST", body: JSON.stringify({ results: results }) });
    showToast(scope + " quota review posted to Discord.", "success");
  } catch (err) {
    showToast(err.message || "Failed to post quota review.", "error");
  }
}

async function flpQuotaReset(scope) {
  if (!(await uiConfirm("Reset EVERYONE's " + scope + " quota points to 0? This is destructive and cannot be undone."))) return;
  try {
    var d = await api("/api/flp/quota/reset?scope=" + scope, { method: "POST" });
    showToast("All " + scope + " quota points reset to 0" + (d && d.cleared != null ? " (" + d.cleared + " cells)" : "") + ".", "success");
    flpQuotaLoad(scope);
  } catch (err) {
    showToast(err.message || "Failed to reset quota.", "error");
  }
}
