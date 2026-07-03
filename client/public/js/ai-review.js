// client/public/js/ai-review.js
var aiOffenses = []; // cached findings so the "start case" button can index in

document.addEventListener('DOMContentLoaded', function () {
  var b = document.getElementById('btn-ai-analyze');
  if (b) b.addEventListener('click', analyzeAiEvidence);
});

function loadAiReview() { /* nothing to preload; reset handled per-action */ }

async function analyzeAiEvidence() {
  var desc  = (document.getElementById('ai-description') || {}).value;
  desc = desc ? desc.trim() : '';

  if (!desc) { showToast('Describe what the suspect did.', 'error'); return; }

  var payload = { description: desc };

  var btn = document.getElementById('btn-ai-analyze');
  var status = document.getElementById('ai-status');
  var results = document.getElementById('ai-results');
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner"></div> Analysing…'; }
  if (status) status.textContent = 'Reviewing…';
  if (results) results.innerHTML = '';

  try {
    var d = await api('/api/ai-review', { method: 'POST', body: JSON.stringify(payload) });
    renderAiResults(d);
  } catch (err) {
    if (results) results.innerHTML = '<div class="panel glass" style="padding:1rem 1.2rem;color:#f07070;font-size:13px;">'
      + '<i class="ti ti-alert-triangle"></i> ' + escapeHtml(err.message || 'AI review failed.') + '</div>';
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-sparkles"></i> Analyse Evidence'; }
    if (status) status.textContent = '';
  }
}

function aiClassBadge(cls) {
  var c = (cls || '').toLowerCase();
  var color = 'blue';
  if (/blacklist|terminat/.test(c)) color = 'red';
  else if (/severe/.test(c)) color = 'amber';
  else if (/minor|warning/.test(c)) color = 'approved';
  return '<span class="badge badge-' + color + '"><span class="badge-dot"></span>' + escapeHtml(cls || '—') + '</span>';
}

function aiConfidence(conf) {
  if (!conf) return '';
  var c = conf.toLowerCase();
  var col = c === 'high' ? 'var(--green)' : (c === 'low' ? 'var(--text-muted)' : 'var(--amber)');
  return '<span style="font-size:10px;color:' + col + ';font-weight:700;text-transform:uppercase;letter-spacing:0.06em;">' + escapeHtml(conf) + ' confidence</span>';
}

function renderAiResults(d) {
  var results = document.getElementById('ai-results');
  if (!results) return;
  var offs = (d && d.offenses) || [];
  aiOffenses = offs; // cache so the button can reference by index (avoids quoting bugs)

  var head = '<div class="panel glass fade-up" style="margin-bottom:1.4rem;">'
    + '<div class="panel-header"><div class="panel-title"><span class="panel-dot ' + (offs.length ? 'amber' : 'blue') + '"></span>'
    + 'AI Findings' + (d.usedVideo ? ' <span style="font-size:10px;color:var(--text-muted);">(from video)</span>' : '') + '</div></div>'
    + '<div style="padding:1rem 1.2rem;font-size:13px;color:var(--text-secondary);line-height:1.7;white-space:pre-wrap;">'
    + escapeHtml((d && d.summary) || 'No summary returned.') + '</div></div>';

  var body;
  if (!offs.length) {
    body = '<div class="panel glass" style="padding:1rem 1.2rem;font-size:13px;color:var(--text-muted);">No matching active offences were identified.</div>';
  } else {
    body = '<div class="panel glass fade-up stagger-1"><div class="panel-header"><div class="panel-title"><span class="panel-dot red"></span>Suggested Offences (' + offs.length + ')</div></div>'
      + '<div style="padding:0.6rem 1rem 1.1rem;display:flex;flex-direction:column;gap:10px;">'
      + offs.map(function (o, i) {
        return '<div style="border:1px solid var(--border-dim);border-radius:8px;padding:11px 13px;background:rgba(255,255,255,0.02);">'
          + '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:5px;">'
          + '<span class="case-ref" style="font-size:11px;">' + escapeHtml(o.code || '—') + '</span>'
          + '<strong style="font-size:13px;color:var(--text-primary);">' + escapeHtml(o.offense || '') + '</strong>'
          + aiClassBadge(o.class) + aiConfidence(o.confidence)
          + (o.inCatalog === false ? '<span style="font-size:10px;color:#f07070;">⚠ not in catalog</span>' : '')
          + '</div>'
          + (o.definition ? '<div style="font-size:11px;color:var(--text-muted);margin-bottom:5px;">' + escapeHtml(o.definition) + '</div>' : '')
          + (o.reason ? '<div style="font-size:12px;color:var(--text-secondary);line-height:1.6;"><strong>Why:</strong> ' + escapeHtml(o.reason) + '</div>' : '')
          + '<div style="margin-top:8px;"><button class="btn btn-ghost btn-sm" onclick="startCaseFromOffence(' + i + ')"><i class="ti ti-file-plus"></i> Start case with this</button></div>'
          + '</div>';
      }).join('')
      + '</div></div>';
  }
  results.innerHTML = head + body;
}

// Open the new-case modal pre-filled with this offence as the reason
function startCaseFromOffence(index) {
  var o = aiOffenses[index] || {};
  if (typeof openNewCaseModal === 'function') {
    openNewCaseModal();
    var r = document.getElementById('f-reason');
    if (r) r.value = (o.code ? o.code + ' — ' : '') + (o.offense || '');
  } else {
    showToast('Could not open the case form.', 'error');
  }
}
