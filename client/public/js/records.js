// client/public/js/records.js
// Internal Affairs — Officer Record Lookup tab.

document.addEventListener("DOMContentLoaded", function () {
  var btn = document.getElementById("btn-rec-search");
  var inp = document.getElementById("rec-query");
  if (btn) btn.addEventListener("click", runRecordLookup);
  if (inp) inp.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); runRecordLookup(); }
  });
});

// Called by navigateTo when the Records tab opens.
function loadRecords() {
  var inp = document.getElementById("rec-query");
  if (inp) setTimeout(function () { inp.focus(); }, 50);
}

function recChip(label, state) {
  // state: "good" | "bad" | "muted"
  var bg = { good: "rgba(34,197,94,0.14)", bad: "rgba(239,68,68,0.14)", muted: "rgba(148,163,184,0.14)" }[state] || "rgba(148,163,184,0.14)";
  var bd = { good: "rgba(34,197,94,0.4)", bad: "rgba(239,68,68,0.4)", muted: "rgba(148,163,184,0.35)" }[state] || "rgba(148,163,184,0.35)";
  var fg = { good: "#4ade80", bad: "#f87171", muted: "var(--text-secondary)" }[state] || "var(--text-secondary)";
  return "<span style=\"display:inline-flex;align-items:center;gap:6px;padding:5px 11px;border-radius:999px;font-size:12px;font-weight:600;"
    + "background:" + bg + ";border:1px solid " + bd + ";color:" + fg + ";\">" + label + "</span>";
}

function recField(label, value, mono) {
  return "<div class=\"detail-field\"><span class=\"detail-field-label\">" + escapeHtml(label) + "</span>"
    + "<span class=\"detail-field-value" + (mono ? " mono" : "") + "\">" + (value || "<span style=\"color:var(--text-muted);\">—</span>") + "</span></div>";
}

// Reuse the shared status badge so Records reads identically to My/All Cases.
function recStatusBadge(s) {
  return (typeof statusBadge === "function")
    ? statusBadge(s)
    : "<span class=\"badge\">" + escapeHtml(s || "") + "</span>";
}

// Records case rows are the SAME cards as My Cases / All Cases: clicking one
// opens the full case detail modal (with the appeal control), and an inline
// Appeal button is offered wherever the viewer is allowed to use it.
function recCaseRows(list, emptyText) {
  // Six columns, because Records now carries the appeal control alongside the
  // same case card the other lists use.
  if (!list || !list.length) {
    var EMPTY = window.metEmpty
      ? window.metEmpty({ icon: "ti-folder-off", title: emptyText })
      : "<span class=\"table-empty-text\">" + emptyText + "</span>";
    return "<tr><td colspan=\"6\" class=\"table-empty\">" + EMPTY + "</td></tr>";
  }
  return list.map(function (c) {
    var act = c.actions && c.actions.length
      ? c.actions.map(function (a) { return escapeHtml(a.action); }).join(", ")
      : escapeHtml(c.action || "—");

    var appeal = "";
    if (typeof canAppealLocally === "function") {
      var verdict = canAppealLocally(c);
      if (verdict.show) {
        appeal = "<button class=\"row-btn btn-appeal\" " + (verdict.allowed ? "" : "disabled title=\"" + escapeHtml(verdict.reason) + "\" ")
          + "onclick=\"event.stopPropagation();openAppealModal('" + c.id + "')\"><i class=\"ti ti-gavel\"></i> Appeal</button>";
      }
    }
    var appealed = (typeof appealBadge === "function") ? appealBadge(c) : "";

    return "<tr class=\"rec-case-row\" onclick=\"openCaseDetail('" + c.id + "')\" title=\"Open this case\">"
      + "<td><span class=\"case-ref\">" + escapeHtml(c.caseRef) + "</span></td>"
      + "<td><span style=\"font-size:12px;\">" + act + "</span></td>"
      + "<td><span style=\"font-size:12px;color:var(--text-secondary);\">" + escapeHtml(c.reason || "—") + "</span></td>"
      + "<td>" + recStatusBadge(c.status) + " " + appealed + "</td>"
      + "<td><span class=\"date-cell\">" + formatDateTime(c.createdAt) + "</span></td>"
      + "<td onclick=\"event.stopPropagation();\">" + appeal + "</td>"
      + "</tr>";
  }).join("");
}

function recCaseTable(list, emptyText) {
  return "<div class=\"table-wrap\"><table class=\"data-table\">"
    + "<thead><tr><th>Case Ref</th><th>Action</th><th>Reason</th><th>Status</th><th>Date</th><th></th></tr></thead>"
    + "<tbody>" + recCaseRows(list, emptyText) + "</tbody>"
    + "</table></div>";
}

async function runRecordLookup() {
  var typeEl = document.getElementById("rec-type");
  var qEl    = document.getElementById("rec-query");
  var out    = document.getElementById("rec-results");
  if (!out) return;
  var q = (qEl && qEl.value || "").trim();
  if (!q) { showToast("Enter a value to search.", "error"); return; }

  var btn = document.getElementById("btn-rec-search");
  if (btn) { btn.disabled = true; btn.innerHTML = "<i class=\"ti ti-loader\"></i> Searching…"; }
  out.innerHTML = "<div class=\"panel glass\" style=\"margin-top:1.1rem;\"><div class=\"table-loading\" style=\"padding:2rem;\"><div class=\"spinner\"></div></div></div>";

  try {
    var d = await api("/api/cases/records-lookup?type=" + encodeURIComponent(typeEl ? typeEl.value : "auto") + "&q=" + encodeURIComponent(q));
    renderRecord(d);
  } catch (err) {
    out.innerHTML = "<div class=\"panel glass\" style=\"margin-top:1.1rem;padding:1.4rem;\"><span style=\"color:var(--red);\">"
      + escapeHtml(err.message || "Lookup failed.") + "</span></div>";
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = "<i class=\"ti ti-search\"></i> Search"; }
  }
}

function renderRecord(d) {
  var out = document.getElementById("rec-results");
  if (!out) return;

  if (!d || !d.found) {
    var noteHtml = (d && d.notes && d.notes.length)
      ? "<ul style=\"margin:.6rem 0 0;padding-left:1.1rem;color:var(--text-secondary);font-size:12px;\">"
        + d.notes.map(function (n) { return "<li>" + escapeHtml(n) + "</li>"; }).join("") + "</ul>"
      : "";
    var EMPTY = window.metEmpty
      ? window.metEmpty({ icon: "ti-user-off", title: "No matching user found.", sub: "Check the spelling, or try a Roblox/Discord username or ID." })
      : "<div style=\"font-weight:600;color:var(--text-primary);\">No matching user found.</div>";
    out.innerHTML = "<div class=\"panel glass\" style=\"margin-top:1.1rem;padding:1.4rem;\">"
      + EMPTY + noteHtml + "</div>";
    return;
  }

  var id = d.identity || {};
  var grp = d.group || {};

  // ── Identity + status panel ──────────────────────────────────────
  var name = id.robloxUsername || id.discordUsername || id.robloxId || id.discordId || "Unknown";
  var groupChip = grp.inGroup === true
    ? recChip("<i class=\"ti ti-users-group\"></i> In MET Group" + (grp.groupRole ? " · " + escapeHtml(grp.groupRole) + (grp.groupRank != null ? " (" + grp.groupRank + ")" : "") : ""), "good")
    : grp.inGroup === false ? recChip("<i class=\"ti ti-user-off\"></i> Not in MET Group", "bad")
    : recChip("<i class=\"ti ti-help\"></i> Group unknown", "muted");
  var discChip = d.discord && d.discord.inDiscord === true
    ? recChip("<i class=\"ti ti-brand-discord\"></i> In Discord", "good")
    : d.discord && d.discord.inDiscord === false ? recChip("<i class=\"ti ti-brand-discord\"></i> Not in Discord", "bad")
    : recChip("<i class=\"ti ti-brand-discord\"></i> Discord unknown", "muted");

  var html = "<div class=\"panel glass fade-up\" style=\"margin-top:1.1rem;\">"
    + "<div class=\"panel-header\"><div class=\"panel-title\"><span class=\"panel-dot blue\"></span>"
    + escapeHtml(name) + (id.robloxDisplayName && id.robloxDisplayName !== id.robloxUsername ? " <span style=\"color:var(--text-muted);font-weight:400;font-size:12px;\">(" + escapeHtml(id.robloxDisplayName) + ")</span>" : "")
    + "</div></div>"
    + "<div style=\"padding:1.1rem 1.2rem;\">"
    + "<div style=\"display:flex;gap:8px;flex-wrap:wrap;margin-bottom:1rem;\">" + groupChip + discChip + "</div>"
    + "<div class=\"detail-grid\">"
    + recField("Roblox Username", id.robloxUsername ? escapeHtml(id.robloxUsername) : null, true)
    + recField("Roblox User ID", id.robloxId ? escapeHtml(id.robloxId) : null, true)
    + recField("Discord Username", id.discordUsername ? escapeHtml(id.discordUsername) : null, true)
    + recField("Discord ID", id.discordId ? escapeHtml(id.discordId) : null, true)
    + "</div></div></div>";

  // ── Active punishment roles ──────────────────────────────────────
  var roles = d.punishmentRoles || [];
  html += "<div class=\"panel glass fade-up\" style=\"margin-top:1.1rem;\">"
    + "<div class=\"panel-header\"><div class=\"panel-title\"><span class=\"panel-dot red\"></span>Active Punishment Roles</div>"
    + "<span class=\"text-muted mono\" style=\"font-size:11px;\">live Discord roles</span></div>"
    + "<div style=\"padding:1.1rem 1.2rem;display:flex;gap:8px;flex-wrap:wrap;\">"
    + (roles.length
        ? roles.map(function (r) { return recChip("<i class=\"ti ti-alert-triangle\"></i> " + escapeHtml(r.action), "bad"); }).join("")
        : "<span style=\"color:var(--text-muted);font-size:13px;\">No active punishment roles held"
          + (d.discord && d.discord.inDiscord === false ? " (user not in Discord)." : ".") + "</span>")
    + "</div></div>";

  // ── Punishment record (approved only) ────────────────────────────
  var rec = d.punishmentRecord || [];
  var cn  = d.counts || {};
  html += "<div class=\"panel glass fade-up\" style=\"margin-top:1.1rem;\">"
    + "<div class=\"panel-header\"><div class=\"panel-title\"><span class=\"panel-dot amber\"></span>Punishment Record</div>"
    + "<span class=\"text-muted mono\" style=\"font-size:11px;\">approved cases only</span></div>"
    + "<div style=\"padding:1.1rem 1.2rem;display:flex;gap:8px;flex-wrap:wrap;\">"
    + (rec.length
        ? rec.map(function (a) { return recChip(escapeHtml(a), "muted"); }).join("")
        : "<span style=\"color:var(--text-muted);font-size:13px;\">No approved punishments on record.</span>")
    + "</div>"
    + recCaseTable(d.approvedCases, "No approved cases against this user.")
    + "</div>";

  // ── Appealed (overturned — lifted, no longer on record) ──────────
  var overturned = d.overturnedCases || [];
  if (overturned.length) {
    html += "<div class=\"panel glass fade-up\" style=\"margin-top:1.1rem;\">"
      + "<div class=\"panel-header\"><div class=\"panel-title\"><span class=\"panel-dot purple\"></span>Appealed Cases</div>"
      + "<span class=\"text-muted mono\" style=\"font-size:11px;\">overturned · punishments lifted</span></div>"
      + recCaseTable(overturned, "No appealed cases.")
      + "</div>";
  }

  // ── Pending / Denied (logged but NOT counted) ────────────────────
  html += "<div class=\"panel glass fade-up\" style=\"margin-top:1.1rem;margin-bottom:1.5rem;\">"
    + "<div class=\"panel-header\"><div class=\"panel-title\"><span class=\"panel-dot\"></span>Pending &amp; Denied Cases</div>"
    + "<span class=\"text-muted mono\" style=\"font-size:11px;\">logged only · not counted toward record</span></div>"
    + recCaseTable(d.otherCases, "No pending or denied cases.")
    + "</div>";

  // ── Notes / warnings ─────────────────────────────────────────────
  if (d.notes && d.notes.length) {
    html += "<div class=\"panel glass\" style=\"margin-bottom:1.5rem;padding:1rem 1.2rem;\">"
      + "<span style=\"color:var(--amber);font-size:12px;font-weight:600;\"><i class=\"ti ti-info-circle\"></i> Lookup notes</span>"
      + "<ul style=\"margin:.5rem 0 0;padding-left:1.1rem;color:var(--text-secondary);font-size:12px;\">"
      + d.notes.map(function (n) { return "<li>" + escapeHtml(n) + "</li>"; }).join("") + "</ul></div>";
  }

  out.innerHTML = html;
}
