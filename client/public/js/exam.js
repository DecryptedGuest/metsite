// client/public/js/exam.js — cadet Final Examination + anti-cheat telemetry.
// Collects best-effort signals (paste, keystroke-vs-length, tab-switching,
// copy, right-click, devtools, timing) that the server turns into flags shown
// to markers. Best-effort by nature — a determined cheat can tamper — but it
// catches the common cases and makes AI/paste usage visible.

let paper = null;
const perQuestion = {};       // qid -> { keystrokes, pasteCount, pastedChars, activeMs, corrections, focusStart }
const detection = {
  startedAt: Date.now(),
  blurCount: 0, blurMs: 0, _blurStart: 0,
  copyCount: 0, cutCount: 0, contextMenuCount: 0,
  devtoolsOpened: false,
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function initExam() {
  let status;
  try { status = await api('/api/exam/my'); } catch (e) { return showState('⚠️', 'Something went wrong', e.message); }

  if (!status.eligible) {
    return showState('✅', 'No exam required', 'Your account doesn\'t have the Hendon Police College final-exam role, so there\'s nothing for you to sit here. If you believe this is a mistake, contact HPC staff.');
  }
  if (status.latest && status.latest.status === 'PASSED') {
    return showState('🎓', 'You passed', `You scored ${status.latest.score}/${status.latest.maxScore} (${status.latest.percentage}%). ${status.latest.markerNote ? 'Marker note: ' + esc(status.latest.markerNote) : ''}`);
  }
  if (status.latest && status.latest.status === 'PENDING') {
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
  try { paper = await api('/api/exam/paper'); } catch (e) { return showState('⚠️', 'Could not load the exam', e.message); }

  document.getElementById('exam-loading').style.display = 'none';
  document.getElementById('exam-form').style.display = 'block';
  document.getElementById('exam-title').textContent = paper.title;
  document.getElementById('exam-sub').textContent = paper.subtitle;
  document.getElementById('exam-rules').innerHTML = paper.rules.map(r => `<li>${esc(r)}</li>`).join('');


  const box = document.getElementById('exam-questions');
  box.innerHTML = paper.questions.map((q, i) => {
    perQuestion[q.id] = { keystrokes: 0, pasteCount: 0, pastedChars: 0, activeMs: 0, corrections: 0, focusStart: 0 };
    const req = q.required ? '<span class="req">*</span>' : '';
    const pts = `<span class="exam-q-points">${q.points} pts</span>`;
    let field;
    if (q.type === 'choice') {
      field = q.options.map(opt => `
        <label class="exam-choice"><input type="radio" name="${q.id}" value="${esc(opt)}" /> ${esc(opt)}</label>`).join('');
    } else if (q.type === 'paragraph' || q.type === 'agreement') {
      field = `<textarea class="form-control exam-input" data-qid="${q.id}" rows="3" placeholder="${q.minSentences ? q.minSentences + '+ sentences required' : 'Your answer…'}"></textarea>`;
    } else {
      field = `<input type="text" class="form-control exam-input" data-qid="${q.id}" placeholder="Your answer…" />`;
    }
    return `<div class="glass exam-q">
      <div class="exam-q-prompt">${pts}Q${i + 1}. ${esc(q.prompt)}${req}</div>
      ${field}
    </div>`;
  }).join('');

  wireDetection();
}

// ── Anti-cheat wiring ────────────────────────────────────────────────
function wireDetection() {
  document.querySelectorAll('.exam-input').forEach(el => {
    const qid = el.dataset.qid;
    const pq = perQuestion[qid];

    el.addEventListener('focus', () => { pq.focusStart = Date.now(); });
    el.addEventListener('blur', () => { if (pq.focusStart) { pq.activeMs += Date.now() - pq.focusStart; pq.focusStart = 0; } });

    el.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' || e.key === 'Delete') pq.corrections++;
      else if (e.key.length === 1) pq.keystrokes++;
    });

    // Detect paste (allowed, but recorded so markers see it).
    el.addEventListener('paste', (e) => {
      const text = (e.clipboardData || window.clipboardData).getData('text') || '';
      pq.pasteCount++;
      pq.pastedChars += text.length;
    });
  });

  // Global signals.
  window.addEventListener('blur', () => { detection.blurCount++; detection._blurStart = Date.now(); });
  window.addEventListener('focus', () => { if (detection._blurStart) { detection.blurMs += Date.now() - detection._blurStart; detection._blurStart = 0; } });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { detection.blurCount++; detection._blurStart = Date.now(); }
    else if (detection._blurStart) { detection.blurMs += Date.now() - detection._blurStart; detection._blurStart = 0; }
  });
  document.addEventListener('copy', () => { detection.copyCount++; });
  document.addEventListener('cut', () => { detection.cutCount++; });
  document.addEventListener('contextmenu', () => { detection.contextMenuCount++; });

  // Devtools heuristic — a large gap between outer/inner size usually means a
  // docked devtools panel. Low-confidence signal, surfaced as such.
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
  const answers = collectAnswers();
  const missing = paper.questions.filter(q => q.required && !answers[q.id]);
  if (missing.length) return showToast(`Please answer all required questions (${missing.length} remaining).`, 'warning');

  if (!confirm('Submit your final exam? You cannot change your answers after submitting.')) return;

  // Flush any in-progress focus timer.
  Object.values(perQuestion).forEach(pq => { if (pq.focusStart) { pq.activeMs += Date.now() - pq.focusStart; pq.focusStart = 0; } });
  detection.totalMs = Date.now() - detection.startedAt;
  detection.perQuestion = perQuestion;

  const btn = document.getElementById('exam-submit-btn');
  btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader"></i> Submitting…';
  try {
    await api('/api/exam/submit', { method: 'POST', body: JSON.stringify({ answers, detection }) });
    showState('📨', 'Exam submitted', 'Your final exam has been submitted to Hendon Police College for marking. You\'ll see your result here and on your dashboard once a marker reviews it.');
  } catch (err) {
    btn.disabled = false; btn.innerHTML = '<i class="ti ti-send"></i> Submit Final Exam';
    showToast(err.message, 'error');
  }
}

initExam();
