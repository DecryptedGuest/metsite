// client/public/js/exam.js — cadet Final Examination + anti-cheat telemetry.
// Collects best-effort signals (paste, keystroke-vs-length, tab-switching,
// copy, right-click, devtools, timing) that the server turns into flags shown
// to markers. Best-effort by nature — a determined cheat can tamper — but it
// catches the common cases and makes AI/paste usage visible.
//
// Also: an identity-confirmation gate (look up Roblox + Discord → "Is this
// you?" → confirm locks those fields), and auto-saved progress (survives
// refresh / leaving the page) that only resets via the Restart button.

let paper = null;
let ME = null;                 // signed-in user (for the per-account draft key)
let identity = { confirmed: false, roblox: '', discord: '', details: null };
let pendingLookup = null;      // the looked-up Roblox details awaiting "yes it's me"
let agreementStatement = null; // the Q15 agreement text (with a (USERNAME) placeholder)
let globalsWired = false;      // attach document-level detection listeners only once
const perQuestion = {};       // qid -> { keystrokes, pasteCount, pastedChars, activeMs, corrections, focusStart }
const detection = {
  startedAt: Date.now(),
  blurCount: 0, blurMs: 0, _blurStart: 0,
  copyCount: 0, cutCount: 0, contextMenuCount: 0,
  devtoolsOpened: false,
};
const ID_QIDS = ['roblox_username', 'discord_username'];

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Draft persistence (localStorage, per account) ─────────────────────
function draftKey() { return 'exam_draft_v1:' + ((ME && (ME.discordId || ME.id)) || 'anon'); }
function loadDraft() { try { const s = localStorage.getItem(draftKey()); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
function clearDraft() { try { localStorage.removeItem(draftKey()); } catch (e) {} }
let _saveT = null;
function saveDraft() {
  try {
    localStorage.setItem(draftKey(), JSON.stringify({ answers: collectAnswers(), identity, savedAt: Date.now() }));
    const note = document.getElementById('exam-save-note');
    if (note) note.textContent = 'Progress saved automatically';
  } catch (e) {}
}
function scheduleSave() { clearTimeout(_saveT); _saveT = setTimeout(saveDraft, 400); }

async function initExam() {
  try { ME = await api('/api/me'); } catch (e) { ME = null; }

  let status;
  try { status = await api('/api/exam/my'); } catch (e) { return showState('<i class="ti ti-alert-triangle"></i>', 'Something went wrong', e.message); }

  if (!status.eligible) {
    return showState('<i class="ti ti-circle-check"></i>', 'No exam required', 'Your account doesn\'t have the Hendon Police College final-exam role, so there\'s no exam for you to take here. If you believe this is a mistake, contact HPC staff.');
  }
  if (status.latest && status.latest.status === 'PASSED') {
    clearDraft();
    // Celebratory branded moment — once per passed exam.
    try {
      const seen = 'metExamCelebrated_' + (status.latest.id || 'x');
      if (window.metBrandMoment && !localStorage.getItem(seen)) {
        localStorage.setItem(seen, '1');
        setTimeout(() => metBrandMoment({
          icon: 'ti-trophy', variant: 'celebrate',
          title: 'Congratulations', tagline: 'You passed your final examination', autoMs: 2800,
        }), 350);
      }
    } catch (e) { /* cosmetic */ }
    return showState('<i class="ti ti-school"></i>', 'You passed', `You scored ${status.latest.score}/${status.latest.maxScore} (${status.latest.percentage}%). ${status.latest.markerNote ? 'Marker note: ' + esc(status.latest.markerNote) : ''}`);
  }
  if (status.latest && status.latest.status === 'PENDING') {
    clearDraft();
    return showState('⏳', 'Awaiting marking', 'Your exam has been submitted and is waiting to be marked by Hendon Police College. You\'ll see your result here and on your dashboard once it\'s done. Please don\'t beg for it to be marked.');
  }
  // FAILED (retake allowed) or never taken → render the form.
  await renderForm(status.latest);
}

function showState(icon, title, body) {
  document.getElementById('exam-loading').style.display = 'none';
  document.getElementById('exam-form').style.display = 'none';
  const el = document.getElementById('exam-state');
  el.style.display = 'block';
  el.innerHTML = `<div class="big">${icon}</div><h2>${esc(title)}</h2><p>${body}</p>
    <div style="margin-top:1.4rem;"><a href="/profile" class="btn btn-ghost btn-sm"><i class="ti ti-arrow-left"></i> Back to My Dashboard</a></div>`;
}

async function renderForm(prevFailed) {
  try { paper = await api('/api/exam/paper'); } catch (e) { return showState('<i class="ti ti-alert-triangle"></i>', 'Could not load the exam', e.message); }

  document.getElementById('exam-loading').style.display = 'none';
  document.getElementById('exam-form').style.display = 'block';
  document.getElementById('exam-title').textContent = paper.title;
  document.getElementById('exam-sub').textContent = paper.subtitle;
  document.getElementById('exam-rules').innerHTML = paper.rules.map(r => `<li>${esc(r)}</li>`).join('');

  const draft = loadDraft();
  identity = (draft && draft.identity) || { confirmed: false, roblox: '', discord: '', details: null };

  // Init telemetry buckets for EVERY question (incl. the identity fields).
  paper.questions.forEach(q => {
    perQuestion[q.id] = { keystrokes: 0, pasteCount: 0, pastedChars: 0, activeMs: 0, corrections: 0, focusStart: 0,
      gapN: 0, gapSum: 0, gapSqSum: 0, lastKeyT: 0 };
  });

  // Identity card (roblox_username + discord_username handled here, not inline).
  renderIdentityCard(draft);

  // Capture the agreement statement (for the Copy button).
  const agQ = paper.questions.find(q => q.type === 'agreement');
  agreementStatement = agQ ? (agQ.statement || agQ.prompt) : null;

  // The remaining questions.
  const box = document.getElementById('exam-questions');
  box.innerHTML = paper.questions.filter(q => !ID_QIDS.includes(q.id)).map((q, idx) => {
    const req = q.required ? '<span class="req">*</span>' : '';
    const pts = `<span class="exam-q-points">${q.points} pts</span>`;
    let field;
    if (q.type === 'choice') {
      field = q.options.map(opt => `
        <label class="exam-choice"><input type="radio" name="${q.id}" value="${esc(opt)}" /> ${esc(opt)}</label>`).join('');
    } else if (q.type === 'agreement') {
      // Copying the statement is necessary here, so it's exempt from the copy
      // flag. The Copy button fills (USERNAME) with the cadet's Roblox name.
      field = `<div id="agreement-block">
        <div id="agreement-statement" style="font-size:13px;color:var(--text-secondary);background:rgba(255,255,255,0.03);border:1px solid var(--border-dim);border-radius:6px;padding:10px 12px;line-height:1.6;">${esc(agreementStatement || '')}</div>
        <button type="button" class="btn btn-ghost btn-sm" style="margin-top:8px;" onclick="copyAgreement()"><i class="ti ti-copy"></i> Copy statement (with your username)</button>
        <textarea class="form-control exam-input" data-qid="${q.id}" rows="3" style="margin-top:8px;" placeholder="Paste the statement here…"></textarea>
      </div>`;
    } else if (q.type === 'paragraph') {
      field = `<textarea class="form-control exam-input" data-qid="${q.id}" rows="3" placeholder="${q.minSentences ? q.minSentences + '+ sentences required' : 'Your answer…'}"></textarea>`;
    } else {
      field = `<input type="text" class="form-control exam-input" data-qid="${q.id}" placeholder="Your answer…" />`;
    }
    return `<div class="glass exam-q">
      <div class="exam-q-prompt">${pts}Q${idx + 1}. ${esc(q.prompt)}${req}</div>
      ${field}
    </div>`;
  }).join('');

  // Restore any drafted answers into the (non-identity) inputs.
  if (draft && draft.answers) restoreAnswers(draft.answers);

  wireDetection();
  wireAutosave();

  // Re-apply a previously-confirmed & locked identity.
  if (identity.confirmed) applyConfirmedIdentity();

  if (draft && draft.savedAt) {
    const note = document.getElementById('exam-save-note');
    if (note) note.textContent = 'Progress restored from your last session';
  }
}

// ── Identity confirmation ─────────────────────────────────────────────
function renderIdentityCard(draft) {
  const c = document.getElementById('exam-identity');
  const rVal = (draft && draft.answers && draft.answers.roblox_username) || (identity && identity.roblox) || '';
  const dVal = (draft && draft.answers && draft.answers.discord_username) || (identity && identity.discord) || '';
  c.innerHTML = `<div class="glass exam-q" id="identity-card">
    <div class="exam-q-prompt"><i class="ti ti-user-check"></i> Confirm your identity <span class="req">*</span></div>
    <p style="font-size:12px;color:var(--text-muted);margin:0 0 10px;line-height:1.6;">Enter your Roblox and Discord username, then look it up to confirm it's really you. Once confirmed, these lock and can't be changed (use Restart to start over).</p>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <div><label style="font-size:11px;color:var(--text-muted);">Roblox username</label>
        <input type="text" class="form-control exam-input" data-qid="roblox_username" id="id-roblox" value="${esc(rVal)}" placeholder="Roblox username" autocomplete="off" /></div>
      <div><label style="font-size:11px;color:var(--text-muted);">Discord username</label>
        <input type="text" class="form-control exam-input" data-qid="discord_username" id="id-discord" value="${esc(dVal)}" placeholder="Discord username" autocomplete="off" /></div>
    </div>
    <div style="margin-top:10px;"><button class="btn btn-ghost btn-sm" id="id-lookup-btn" onclick="lookupIdentity()"><i class="ti ti-search"></i> Look up &amp; confirm</button></div>
    <div id="id-result" style="margin-top:10px;"></div>
  </div>`;
}

window.lookupIdentity = async function () {
  const roblox = document.getElementById('id-roblox').value.trim();
  const discord = document.getElementById('id-discord').value.trim();
  if (!roblox || !discord) return showToast('Enter both your Roblox and Discord username first.', 'warning');
  const res = document.getElementById('id-result');
  res.innerHTML = '<div class="spinner" style="display:inline-block;"></div> Looking up…';
  let data;
  try { data = await api('/api/exam/lookup?roblox=' + encodeURIComponent(roblox) + '&discord=' + encodeURIComponent(discord)); }
  catch (e) { res.innerHTML = `<span style="color:var(--red);font-size:12px;">${esc(e.message)}</span>`; return; }

  const rb = data.roblox || {};
  if (!rb.found) {
    res.innerHTML = `<div style="color:var(--red);font-size:12px;"><i class="ti ti-alert-triangle"></i> No Roblox user "<strong>${esc(roblox)}</strong>" found. Check the spelling and try again.</div>`;
    return;
  }
  pendingLookup = { robloxUsername: rb.username, robloxId: rb.id, robloxDisplay: rb.displayName, avatar: rb.avatar };
  const dc = (data.discord && data.discord.found) ? data.discord
    : (data.me ? { username: data.me.discordUsername, displayName: data.me.displayName, avatar: data.me.avatar } : null);

  res.innerHTML = `<div style="border:1px solid var(--border-bright,#3a3a3a);border-radius:10px;padding:12px;">
    <div style="font-weight:700;font-size:13px;margin-bottom:10px;"><i class="ti ti-help-circle"></i> Is this you?</div>
    <div style="display:flex;gap:18px;flex-wrap:wrap;">
      <div style="display:flex;align-items:center;gap:10px;">
        ${rb.avatar ? `<img src="${esc(rb.avatar)}" style="width:46px;height:46px;border-radius:8px;background:#222;">` : ''}
        <div><div style="font-size:10px;color:var(--text-muted);letter-spacing:0.05em;">ROBLOX</div>
          <div style="font-weight:600;">${esc(rb.displayName || rb.username)}</div>
          <div style="font-size:11px;color:var(--text-muted);">@${esc(rb.username)}</div></div>
      </div>
      ${dc ? `<div style="display:flex;align-items:center;gap:10px;">
        ${dc.avatar ? `<img src="${esc(dc.avatar)}" style="width:46px;height:46px;border-radius:50%;background:#222;">` : ''}
        <div><div style="font-size:10px;color:var(--text-muted);letter-spacing:0.05em;">DISCORD</div>
          <div style="font-weight:600;">${esc(dc.displayName || dc.username || discord)}</div>
          <div style="font-size:11px;color:var(--text-muted);">${dc.username ? '@' + esc(dc.username) : ''}</div></div>
      </div>` : ''}
    </div>
    <div style="display:flex;gap:8px;margin-top:14px;">
      <button class="btn btn-primary btn-sm" onclick="confirmIdentity()"><i class="ti ti-check"></i> Yes, this is me</button>
      <button class="btn btn-ghost btn-sm" onclick="document.getElementById('id-result').innerHTML='';"><i class="ti ti-x"></i> No, edit</button>
    </div>
  </div>`;
};

window.confirmIdentity = function () {
  if (!pendingLookup) return;
  identity = {
    confirmed: true,
    roblox: pendingLookup.robloxUsername || document.getElementById('id-roblox').value.trim(),
    discord: document.getElementById('id-discord').value.trim(),
    details: pendingLookup,
  };
  applyConfirmedIdentity();
  saveDraft();
  showToast('Identity confirmed and locked.', 'success');
};

function applyConfirmedIdentity() {
  const r = document.getElementById('id-roblox'), d = document.getElementById('id-discord');
  if (r) { if (identity.roblox) r.value = identity.roblox; r.readOnly = true; r.style.opacity = '0.7'; r.style.cursor = 'not-allowed'; }
  if (d) { if (identity.discord) d.value = identity.discord; d.readOnly = true; d.style.opacity = '0.7'; d.style.cursor = 'not-allowed'; }
  const btn = document.getElementById('id-lookup-btn'); if (btn) btn.style.display = 'none';
  const disp = identity.details && identity.details.robloxDisplay ? ' — ' + esc(identity.details.robloxDisplay) : '';
  const rr = document.getElementById('id-result');
  if (rr) rr.innerHTML = `<div style="color:var(--green);font-size:12px;display:flex;align-items:center;gap:6px;"><i class="ti ti-lock"></i> Identity confirmed and locked${disp}. Use <strong>Restart</strong> to change it.</div>`;
}

// ── Restart ───────────────────────────────────────────────────────────
window.restartExam = async function () {
  if (!(await uiConfirm('Restart the exam?\n\nThis clears ALL your saved answers and your confirmed identity. This cannot be undone.', { title: 'Restart the exam?', confirmText: 'Restart', danger: true }))) return;
  clearDraft();
  identity = { confirmed: false, roblox: '', discord: '', details: null };
  pendingLookup = null;
  renderForm(null);
  showToast('Progress reset — start fresh.', 'info');
};

function restoreAnswers(answers) {
  paper.questions.forEach(q => {
    if (ID_QIDS.includes(q.id)) return; // identity handled by its own card
    const val = answers[q.id];
    if (val == null) return;
    if (q.type === 'choice') {
      document.querySelectorAll(`input[name="${q.id}"]`).forEach(r => { if (r.value === val) r.checked = true; });
    } else {
      const el = document.querySelector(`.exam-input[data-qid="${q.id}"]`);
      if (el) el.value = val;
    }
  });
}

function wireAutosave() {
  const form = document.getElementById('exam-form');
  form.addEventListener('input', scheduleSave);
  form.addEventListener('change', scheduleSave); // radios
}

// Copy the agreement statement with (USERNAME) → the cadet's Roblox username and
// no surrounding quotation marks, ready to paste into the Q15 box.
window.copyAgreement = async function () {
  const uname = (identity && identity.roblox)
    || (document.getElementById('id-roblox') && document.getElementById('id-roblox').value.trim()) || '';
  if (!uname) return showToast('Confirm your Roblox username first (the identity card at the top).', 'warning');
  const text = String(agreementStatement || '').replace(/\(USERNAME\)/gi, uname).replace(/[“”"]/g, '').trim();
  try {
    await navigator.clipboard.writeText(text);
    showToast('Agreement copied — paste it into the box below.', 'success');
  } catch (e) {
    // Clipboard blocked → drop it straight into the answer box instead.
    const ta = document.querySelector('.exam-input[data-qid="agreement"]');
    if (ta) { ta.value = text; scheduleSave(); }
    showToast('Filled the agreement box for you.', 'success');
  }
};

// True when the current selection / focus is inside the Q15 agreement block —
// copying there is necessary, so it must not count toward the copy flag.
function isInAgreement() {
  const block = document.getElementById('agreement-block');
  if (!block) return false;
  const active = document.activeElement;
  if (active && block.contains(active)) return true;
  const sel = window.getSelection && window.getSelection();
  if (sel && sel.anchorNode) {
    const node = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentNode;
    if (node && block.contains(node)) return true;
  }
  return false;
}

// ── Anti-cheat wiring ────────────────────────────────────────────────
function wireDetection() {
  document.querySelectorAll('.exam-input').forEach(el => {
    const qid = el.dataset.qid;
    const pq = perQuestion[qid];
    if (!pq) return;

    el.addEventListener('focus', () => { pq.focusStart = Date.now(); });
    el.addEventListener('blur', () => { if (pq.focusStart) { pq.activeMs += Date.now() - pq.focusStart; pq.focusStart = 0; } });

    el.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' || e.key === 'Delete') pq.corrections++;
      else if (e.key.length === 1) {
        pq.keystrokes++;
        const now = Date.now();
        if (pq.lastKeyT) {
          const gap = now - pq.lastKeyT;
          if (gap > 0 && gap < 3000) { pq.gapN++; pq.gapSum += gap; pq.gapSqSum += gap * gap; }
        }
        pq.lastKeyT = now;
      }
    });

    el.addEventListener('paste', (e) => {
      const text = (e.clipboardData || window.clipboardData).getData('text') || '';
      pq.pasteCount++;
      pq.pastedChars += text.length;
    });
  });

  // Global signals — attach exactly once (renderForm can run again on Restart).
  if (globalsWired) return;
  globalsWired = true;

  window.addEventListener('blur', () => { detection.blurCount++; detection._blurStart = Date.now(); });
  window.addEventListener('focus', () => { if (detection._blurStart) { detection.blurMs += Date.now() - detection._blurStart; detection._blurStart = 0; } });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { detection.blurCount++; detection._blurStart = Date.now(); }
    else if (detection._blurStart) { detection.blurMs += Date.now() - detection._blurStart; detection._blurStart = 0; }
  });
  // Copying the Q15 agreement is necessary → ignore it; count everything else.
  document.addEventListener('copy', () => { if (!isInAgreement()) detection.copyCount++; });
  document.addEventListener('cut', () => { if (!isInAgreement()) detection.cutCount++; });
  document.addEventListener('contextmenu', () => { detection.contextMenuCount++; });

  setInterval(() => {
    const gap = Math.max(window.outerWidth - window.innerWidth, window.outerHeight - window.innerHeight);
    if (gap > 170) detection.devtoolsOpened = true;
  }, 1500);
}

function collectAnswers() {
  const answers = {};
  paper.questions.forEach(q => {
    if (q.type === 'choice') {
      const sel = document.querySelector(`input[name="${q.id}"]:checked`);
      answers[q.id] = sel ? sel.value : '';
    } else {
      const el = document.querySelector(`.exam-input[data-qid="${q.id}"]`);
      answers[q.id] = el ? el.value.trim() : '';
    }
  });
  return answers;
}

async function submitExam() {
  if (!identity.confirmed) return showToast('Confirm your identity first — look it up and press "Yes, this is me".', 'warning');

  const answers = collectAnswers();
  const missing = paper.questions.filter(q => q.required && !answers[q.id]);
  if (missing.length) return showToast(`Please answer all required questions (${missing.length} remaining).`, 'warning');

  if (!(await uiConfirm('Submit your final exam? You cannot change your answers after submitting. Make sure you have requested to join the Metropolitan Police group so you can be accepted when you pass.'))) return;

  // Flush any in-progress focus timer + finalise keystroke-cadence variance.
  Object.values(perQuestion).forEach(pq => {
    if (pq.focusStart) { pq.activeMs += Date.now() - pq.focusStart; pq.focusStart = 0; }
    if (pq.gapN >= 5) {
      const mean = pq.gapSum / pq.gapN;
      const varc = Math.max(0, (pq.gapSqSum / pq.gapN) - mean * mean);
      pq.cadenceCv = mean > 0 ? Math.sqrt(varc) / mean : null;
    }
    delete pq.gapN; delete pq.gapSum; delete pq.gapSqSum; delete pq.lastKeyT;
  });
  detection.totalMs = Date.now() - detection.startedAt;
  detection.perQuestion = perQuestion;
  detection.identityConfirmed = true;

  const btn = document.getElementById('exam-submit-btn');
  btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader"></i> Submitting…';
  try {
    await api('/api/exam/submit', { method: 'POST', body: JSON.stringify({ answers, detection }) });
    clearDraft();
    showState('<i class="ti ti-send"></i>', 'Exam submitted', 'Your final exam has been submitted to Hendon Police College for marking. You\'ll see your result here and on your dashboard once a marker reviews it.');
  } catch (err) {
    btn.disabled = false; btn.innerHTML = '<i class="ti ti-send"></i> Submit Final Exam';
    showToast(err.message, 'error');
  }
}

initExam();
