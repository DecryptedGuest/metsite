// client/public/js/quota-check.js — HICOMM weekly quota review
var quotaMembersCache = [];

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
});

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
  tbody.innerHTML = "<tr><td colspan='7' class='table-loading'><div class='spinner'></div></td></tr>";
  try {
    var d = await api("/api/quota/members");
    if (!d || !d.configured) {
      tbody.innerHTML = "<tr><td colspan='7' class='table-empty'><span class='table-empty-text'>Quota sheet read access isn't configured (needs the Google service account).</span></td></tr>";
      return;
    }
    quotaMembersCache = d.members || [];
    renderQuotaCheck();
    populateIotwSelector();
  } catch (e) {
    tbody.innerHTML = "<tr><td colspan='7' class='table-empty'><span class='table-empty-text'>Failed to load quota data.</span></td></tr>";
  }
}

function renderQuotaCheck() {
  var tbody   = document.getElementById("quota-check-tbody");
  var countEl = document.getElementById("quota-check-count");
  if (!tbody) return;
  if (!quotaMembersCache.length) {
    tbody.innerHTML = "<tr><td colspan='7' class='table-empty'><span class='table-empty-text'>No members found in the sheet.</span></td></tr>";
    if (countEl) countEl.textContent = "";
    return;
  }
  if (countEl) countEl.textContent = quotaMembersCache.length + " members";

  tbody.innerHTML = quotaMembersCache.map(function (m, i) {
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
      + "<option value='pass'"   + (status === "pass"   ? " selected" : "") + ">✅ Pass</option>"
      + "<option value='fail'"   + (status === "fail"   ? " selected" : "") + ">❌ Fail</option>"
      + "<option value='exempt'" + (status === "exempt" ? " selected" : "") + ">🟣 Exempt</option>"
      + "<option value='loa'"    + (status === "loa"    ? " selected" : "") + ">🟠 Leave of Absence</option>"
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
    var star = tops.indexOf(i) >= 0 ? " ⭐" : "";
    opts += "<option value='" + i + "'" + (i === defaultIdx ? " selected" : "") + ">"
      + escapeHtml(m.username) + (m.rank ? " · " + escapeHtml(m.rank) : "")
      + " — " + (Number(m.total) || 0) + " pts" + star + "</option>";
  });
  sel.innerHTML = opts;

  if (tie) {
    if (tops.length > 1) {
      tie.style.display = "";
      tie.textContent = "⚠ Tie for highest (" + max + " pts) between "
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
