/* MET Support (/support) — METAdministration intake + Discord-style ticket chat.
   Rule-based intake (fixed questions per type), realtime via SSE, attachments
   via the ticket-scoped upload route. */
(function () {
  const esc = window.escapeHtml || (s => String(s == null ? '' : s));
  const fmtTime = d => { try { return window.formatDateTime ? window.formatDateTime(d) : new Date(d).toLocaleString(); } catch (e) { return ''; } };
  const BOT_NAME = 'MET Assistant';
  const BOT_AVATAR = '/img/divisions/met.png';   // MET crest (not the IA logo)
  let MY_AVATAR = null;
  // Render a small subset of markdown (**bold**) after escaping.
  const mdInline = s => esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  let pendingIdentity = null;

  let CFG = { types: [], isStaff: false, handleableTypes: [], me: { id: null, name: '' } };
  const typeByKey = {};
  let queueStatus = 'active';

  // Per-open-ticket state
  let cur = null;        // current ticket object
  let mode = 'chat';     // 'intake' | 'chat'
  let intakeQs = [];     // remaining intake questions
  let intakeAnswers = []; // collected [{id,prompt,answer,attachments}]
  let pending = [];      // pending attachments for the composer
  let es = null;         // EventSource

  const $ = id => document.getElementById(id);

  // ── Init ────────────────────────────────────────────────────────────
  async function init() {
    try {
      CFG = await api('/api/support/config');
      CFG.types.forEach(t => { typeByKey[t.key] = t; });
    } catch (e) { /* not logged in → api() already redirected */ return; }
    MY_AVATAR = CFG.me.avatar || null;
    $('sup-user-name').textContent = CFG.me.name || 'You';
    $('sup-user-fallback').textContent = (CFG.me.name || '?').slice(0, 1).toUpperCase();
    if (MY_AVATAR) { const a = $('sup-user-avatar'); if (a) { a.src = MY_AVATAR; a.style.display = ''; $('sup-user-fallback').style.display = 'none'; } }
    renderPanels();
    loadMine();
    if (CFG.isStaff && CFG.handleableTypes.length) {
      $('sup-staff-wrap').classList.remove('sup-hidden');
      wireQueueTabs();
      loadQueue();
    }
    wireComposer();
    // Deep link: /support?ticket=ID
    const id = new URLSearchParams(location.search).get('ticket');
    if (id) openTicket(id);
  }

  // ── Landing: panels ─────────────────────────────────────────────────
  function renderPanels() {
    $('sup-panels').innerHTML = CFG.types.map(t => `
      <div class="panel glass sup-panel ${t.restricted ? 'sup-restricted' : ''}">
        <h3><i class="ti ${esc(t.icon)}"></i> ${esc(t.label)}</h3>
        <p>${esc(t.blurb)}</p>
        ${t.restricted ? '<div class="sup-locknote"><i class="ti ti-lock"></i> Reviewed by IA HICOMM only</div>' : ''}
        <button class="btn btn-primary btn-sm" onclick="supOpenNew('${t.key}')"><i class="ti ti-plus"></i> ${esc(t.button)}</button>
      </div>`).join('');
  }

  function ticketRow(t, staff) {
    const who = staff ? esc(t.openerName) : esc(t.typeLabel);
    const claim = t.claimedByName ? ` · claimed by ${esc(t.claimedByName)}` : '';
    return `<div class="sup-row" style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border,#242424);cursor:pointer;" onclick="supOpenTicket('${t.id}')">
      <div style="flex:1;min-width:0;">
        <div style="font-weight:600;font-size:13px;">${esc(t.typeLabel)}</div>
        <div style="font-size:11px;color:var(--text-muted);">${who}${claim} · ${fmtTime(t.createdAt)}</div>
      </div>
      ${statusBadge(t.status)}
    </div>`;
  }
  function statusBadge(s) {
    const map = { INTAKE: ['badge-pending', 'Intake'], OPEN: ['badge-pending', 'Unclaimed'], CLAIMED: ['badge-approved', 'Claimed'], CLOSED: ['badge-denied', 'Closed'] };
    const [cls, label] = map[s] || ['badge-pending', s];
    return `<span class="badge ${cls}"><span class="badge-dot"></span>${label}</span>`;
  }

  async function loadMine() {
    try {
      const rows = await api('/api/support/tickets/mine');
      $('sup-mytickets').innerHTML = rows.length ? rows.map(t => ticketRow(t, false)).join('')
        : '<div class="table-empty"><div class="table-empty-text">You have no tickets yet. Open one above.</div></div>';
    } catch (e) { $('sup-mytickets').innerHTML = `<div class="table-empty"><div class="table-empty-text">${esc(e.message)}</div></div>`; }
  }

  function wireQueueTabs() {
    document.querySelectorAll('#sup-queue-tabs .filter-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('#sup-queue-tabs .filter-tab').forEach(t => t.classList.toggle('active', t === tab));
        queueStatus = tab.dataset.status; loadQueue();
      });
    });
  }
  async function loadQueue() {
    try {
      const q = queueStatus === 'active' ? '' : '?status=' + encodeURIComponent(queueStatus);
      const rows = await api('/api/support/tickets/queue' + q);
      $('sup-queue').innerHTML = rows.length ? rows.map(t => ticketRow(t, true)).join('')
        : '<div class="table-empty"><div class="table-empty-text">Nothing here.</div></div>';
    } catch (e) { $('sup-queue').innerHTML = `<div class="table-empty"><div class="table-empty-text">${esc(e.message)}</div></div>`; }
  }

  // ── Open / create a ticket ──────────────────────────────────────────
  window.supOpenNew = async function (type) {
    try {
      const r = await api('/api/support/tickets', { method: 'POST', body: JSON.stringify({ type }) });
      cur = r.ticket;
      enterTicketView();
      // Render the greeting, then start the guided intake.
      const t = await api('/api/support/tickets/' + cur.id);
      cur = t;
      renderTicketHeader(t);
      $('sup-log').innerHTML = (t.messages || []).map(renderMsg).join('');
      startIntake(r.questions);
    } catch (e) { showToast(e.message, 'error'); }
  };

  window.supOpenTicket = openTicket;
  async function openTicket(id) {
    try {
      const t = await api('/api/support/tickets/' + id);
      cur = t;
      enterTicketView();
      renderTicketHeader(t);
      renderLog(t);
      if (t.status === 'INTAKE' && t.isMine) {
        const qs = (typeByKey[t.type] || {}).questions || [];
        // Skip questions already answered (resume).
        const done = new Set((t.intake || []).map(i => i.id));
        startIntake(qs.filter(q => !done.has(q.id)));
      } else {
        mode = 'chat';
        setComposerEnabled(t);
        openStream(t.id);
      }
    } catch (e) { showToast(e.message, 'error'); }
  }

  function enterTicketView() {
    closeStream();
    pending = []; renderPending();
    $('sup-landing').classList.add('sup-hidden');
    $('sup-ticket').classList.remove('sup-hidden');
  }
  window.supBackToLanding = function () {
    closeStream();
    $('sup-ticket').classList.add('sup-hidden');
    $('sup-landing').classList.remove('sup-hidden');
    cur = null;
    loadMine(); if (CFG.isStaff) loadQueue();
  };

  function renderTicketHeader(t) {
    $('sup-t-title').textContent = t.typeLabel;
    $('sup-t-sub').textContent = `Opened by ${t.openerName} · ${fmtTime(t.createdAt)}` + (t.claimedByName ? ` · claimed by ${t.claimedByName}` : '');
    $('sup-t-status').outerHTML = `<span id="sup-t-status">${statusBadge(t.status)}</span>`;
    // Actions (staff)
    const acts = [];
    if (t.canManage && t.status === 'OPEN')   acts.push(`<button class="btn btn-primary btn-sm" onclick="supClaim()"><i class="ti ti-hand-stop"></i> Claim</button>`);
    if (t.canManage && t.status !== 'CLOSED') acts.push(`<button class="btn btn-ghost btn-sm" onclick="supClose()"><i class="ti ti-lock"></i> Close</button>`);
    $('sup-t-actions').innerHTML = acts.join('');
  }

  // Chronological: greeting first, then the intake Q/A (which happened between
  // greeting and the "ticket open" summary), then the rest of the thread.
  function renderLog(t) {
    const msgs = t.messages || [];
    const parts = [];
    if (msgs.length) parts.push(renderMsg(msgs[0])); // assistant greeting
    if (Array.isArray(t.intake) && t.intake.length) {
      for (const q of t.intake) {
        parts.push(renderMsg({ authorKind: 'BOT', authorName: BOT_NAME, body: q.prompt, createdAt: t.createdAt }));
        parts.push(renderMsg({ authorKind: 'OPENER', authorName: t.openerName, authorAvatar: t.openerAvatar, body: q.answer, attachments: q.attachments, identity: q.identity, createdAt: t.createdAt }));
      }
    }
    parts.push(...msgs.slice(1).map(renderMsg));
    $('sup-log').innerHTML = parts.join('');
    scrollLog();
  }

  function profileClick(m) {
    const kind = (m.authorKind || '').toLowerCase() === 'bot' ? 'bot' : 'user';
    return ` style="cursor:pointer;" onclick="supOpenProfile('${kind}','${esc(m.authorId || '')}')" title="View profile"`;
  }
  function avatarHtml(m) {
    const isBot = (m.authorKind || '').toLowerCase() === 'bot';
    const inner = isBot ? `<img src="${BOT_AVATAR}" alt="MET" />`
      : (m.authorAvatar ? `<img src="${esc(m.authorAvatar)}" alt="" />` : esc((m.authorName || '?').slice(0, 1).toUpperCase()));
    return `<div class="sup-av"${profileClick(m)}>${inner}</div>`;
  }
  function identityCardHtml(p) {
    if (!p) return '';
    const head = p.headshotUrl ? `<img src="${esc(p.headshotUrl)}" alt="" style="width:52px;height:52px;border-radius:9px;object-fit:cover;" />` : '';
    const discord = (p.discordUsername || p.discordId)
      ? `<div style="font-size:11px;color:var(--text-muted);">Discord: ${p.discordUsername ? '@' + esc(p.discordUsername) + ' ' : ''}${p.discordId ? `(ID ${esc(p.discordId)})` : ''}</div>`
      : '';
    const open = p.robloxId ? ` onclick="window.open('https://www.roblox.com/users/${esc(p.robloxId)}/profile','_blank','noopener')" style="cursor:pointer;"` : '';
    return `<div class="sup-idcard"${open} title="Open Roblox profile">${head}<div><div style="font-weight:700;">${esc(p.robloxDisplayName || p.robloxUsername || 'Unknown')}</div>
      <div style="font-size:12px;color:var(--text-muted);">@${esc(p.robloxUsername || '')} · Roblox ID ${esc(p.robloxId || '')}</div>
      ${discord}</div></div>`;
  }
  function renderMsg(m) {
    const kind = (m.authorKind || 'STAFF').toLowerCase();
    const atts = (m.attachments || []).map(a =>
      a.kind === 'video'
        ? `<video src="${esc(a.url)}" controls></video>`
        : `<a href="${esc(a.url)}" target="_blank" rel="noopener"><img src="${esc(a.url)}" alt="${esc(a.name || '')}" /></a>`
    ).join('');
    return `<div class="sup-msg ${kind}"${m.id ? ` data-mid="${esc(m.id)}"` : ''}>
      ${avatarHtml(m)}
      <div class="sup-body">
        <div class="sup-meta"><span class="sup-name"${profileClick(m)}>${esc(m.authorName || '')}</span><span class="sup-time">${fmtTime(m.createdAt)}</span></div>
        ${m.body ? `<div class="sup-text">${mdInline(m.body)}</div>` : ''}
        ${m.identity ? identityCardHtml(m.identity) : ''}
        ${atts ? `<div class="sup-atts">${atts}</div>` : ''}
      </div>
    </div>`;
  }

  function scrollLog() { const l = $('sup-log'); l.scrollTop = l.scrollHeight; }

  // ── Intake flow ─────────────────────────────────────────────────────
  function startIntake(questions) {
    mode = 'intake';
    intakeQs = (questions || []).slice();
    intakeAnswers = [];
    setComposerEnabled(cur);
    askNext();
  }
  function showQuestionHint(q) {
    if (q.kind === 'choice' && q.choices) {
      $('sup-hint').innerHTML = 'Choose or type: ' + q.choices.map(c => `<button class="btn btn-ghost btn-sm" style="margin:2px;" onclick="supPick('${esc(c)}')">${esc(c)}</button>`).join('');
    } else if (q.kind === 'evidence') {
      $('sup-hint').textContent = 'Attach files with the paperclip, and/or paste links. Then press Send.';
    } else if (q.kind === 'identity') {
      $('sup-hint').textContent = 'Enter a Discord username, Roblox username, or a Discord/Roblox ID.';
    } else {
      $('sup-hint').textContent = q.optional ? 'Optional — type an answer or press Send to skip.' : '';
    }
  }
  function askNext() {
    if (!intakeQs.length) return finishIntake();
    const q = intakeQs[0];
    setComposerBusy(true);
    appendBotTyping(q.prompt + (q.optional ? '  (optional — you can skip)' : ''), () => {
      setComposerBusy(false); showQuestionHint(q); $('sup-input').focus();
    });
  }
  window.supPick = function (val) { $('sup-input').value = val; };

  function recordAnswer(q, answer, attachments, identity) {
    intakeAnswers.push({ id: q.id, prompt: q.prompt, answer, attachments, identity: identity || null });
    appendBubble({ authorKind: 'OPENER', authorName: CFG.me.name, authorAvatar: MY_AVATAR, body: answer, attachments: (attachments || []).map(p => ({ ...p })), identity: identity || null, createdAt: new Date().toISOString() });
  }
  function submitIntakeStep() {
    const q = intakeQs[0];
    const answer = $('sup-input').value.trim();
    if (q.kind === 'identity' && answer) return resolveAndConfirm(q, answer);
    if (!q.optional && !answer && !pending.length) { showToast('Please answer this question.', 'warning'); return; }
    recordAnswer(q, answer, pending.slice(), null);
    intakeQs.shift();
    $('sup-input').value = ''; pending = []; renderPending(); $('sup-hint').textContent = '';
    askNext();
  }

  // Identity questions: resolve the input, then ask the opener to confirm.
  async function resolveAndConfirm(q, input) {
    appendBubble({ authorKind: 'OPENER', authorName: CFG.me.name, authorAvatar: MY_AVATAR, body: input, createdAt: new Date().toISOString() });
    $('sup-input').value = ''; $('sup-hint').textContent = '';
    setComposerBusy(true);
    appendBotTyping('Looking that up…', async () => {
      let r; try { r = await api('/api/support/resolve-identity', { method: 'POST', body: JSON.stringify({ input }) }); } catch (e) { r = { ok: false }; }
      if (!r || !r.ok || !r.person) {
        appendBotTyping("I couldn't find anyone matching that. Try their Discord username, Roblox username, or a Discord/Roblox ID.", () => { setComposerBusy(false); showQuestionHint(q); $('sup-input').focus(); });
        return;
      }
      pendingIdentity = { q, person: r.person };
      renderIdentityConfirm(r.person);
      setComposerBusy(false);
    });
  }
  function renderIdentityConfirm(p) {
    $('sup-log').insertAdjacentHTML('beforeend', `<div class="sup-msg bot"><div class="sup-av"><img src="${BOT_AVATAR}" alt="MET" /></div><div class="sup-body">
      <div class="sup-meta"><span class="sup-name">${BOT_NAME}</span></div>
      <div class="sup-text">Is this the right person?</div>
      ${identityCardHtml(p)}
      <div class="sup-confirm-btns" style="display:flex;gap:8px;margin-top:8px;"><button class="btn btn-primary btn-sm" onclick="supIdConfirm(event,true)"><i class="ti ti-check"></i> Yes, that's them</button><button class="btn btn-ghost btn-sm" onclick="supIdConfirm(event,false)"><i class="ti ti-x"></i> No</button></div>
    </div></div>`);
    scrollLog();
  }
  window.supIdConfirm = function (ev, yes) {
    if (!pendingIdentity) return;
    // Grey out both buttons and make the choice obvious — no double-clicks.
    try {
      const wrap = ev && ev.currentTarget ? ev.currentTarget.parentElement : null;
      if (wrap) {
        // Keep each button's original label — just disable both, fade the one
        // that wasn't chosen, and mark the chosen one as selected (with a tick).
        wrap.querySelectorAll('button').forEach(b => { b.disabled = true; b.classList.add('sup-btn-done'); });
        const chosen = ev.currentTarget;
        chosen.classList.remove('sup-btn-done');
        chosen.classList.add('sup-btn-chosen');
      }
    } catch (e) { /* non-fatal */ }
    const { q, person } = pendingIdentity; pendingIdentity = null;
    if (!yes) { appendBotTyping('No problem — enter the correct username or ID.', () => { showQuestionHint(q); $('sup-input').focus(); }); return; }
    const summary = `${person.robloxUsername || person.robloxDisplayName || ''} (Roblox ID ${person.robloxId}${person.discordUsername ? `, Discord @${person.discordUsername}` : ''})`;
    intakeAnswers.push({ id: q.id, prompt: q.prompt, answer: summary, attachments: [], identity: person });
    intakeQs.shift();
    askNext();
  };

  // ── Clickable profile cards ─────────────────────────────────────────
  window.supOpenProfile = async function (kind, authorId) {
    openModal('modal-sup-profile');
    const body = $('sup-prof-body'), title = $('sup-prof-title');
    if (kind === 'bot') {
      title.textContent = BOT_NAME;
      body.innerHTML = `<img src="/img/metadministrationbanner.png" alt="" style="width:100%;border-radius:10px;margin-bottom:14px;" />
        <div style="display:flex;gap:12px;align-items:center;"><img src="${BOT_AVATAR}" style="width:56px;height:56px;border-radius:50%;" />
          <div><div style="font-weight:700;font-size:16px;">${BOT_NAME}</div>
          <div style="font-size:12px;color:var(--text-muted);">Automated intake · Metropolitan Police Service</div></div></div>
        <p style="font-size:13px;color:var(--text-secondary);margin-top:12px;line-height:1.6;">I collect the details for your ticket and hand you to the right Internal Affairs team.</p>`;
      return;
    }
    if (!authorId) { body.innerHTML = '<div class="table-empty"><div class="table-empty-text">No profile available.</div></div>'; return; }
    body.innerHTML = '<div class="table-loading"><div class="spinner"></div></div>';
    try {
      const p = await api('/api/support/user-profile?userId=' + encodeURIComponent(authorId));
      title.textContent = p.name || 'Profile';
      const av = p.avatar ? `<img src="${esc(p.avatar)}" style="width:56px;height:56px;border-radius:50%;" />` : `<div class="sup-av" style="width:56px;height:56px;">${esc((p.name || '?').slice(0, 1).toUpperCase())}</div>`;
      const roblox = p.robloxUsername ? `<div style="font-size:12px;color:var(--text-muted);">Roblox: <a href="https://www.roblox.com/users/${esc(p.robloxId || '')}/profile" target="_blank" rel="noopener" style="color:var(--blue);">@${esc(p.robloxUsername)}</a>${p.robloxId ? ` (${esc(p.robloxId)})` : ''}</div>` : '';
      let iaBlock = '';
      if (p.role) {
        const divs = (p.divisions || []).map(d => `${esc(d.division)}${d.rankName ? ' · ' + esc(d.rankName) : (d.rank != null ? ' · rank ' + esc(d.rank) : '')}`).join('<br>') || '—';
        iaBlock = `<div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border,#333);">
          <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;">Internal Affairs</div>
          <div style="font-size:13px;margin-top:5px;"><strong>Site role:</strong> ${esc(p.role)}</div>
          <div style="font-size:13px;margin-top:5px;"><strong>Divisions:</strong><br>${divs}</div></div>`;
      }
      body.innerHTML = `<div style="display:flex;gap:12px;align-items:center;">${av}<div><div style="font-weight:700;font-size:16px;">${esc(p.name)}</div>
        <div style="font-size:12px;color:var(--text-muted);">Discord: @${esc(p.discordUsername)}${p.discordId ? ` (${esc(p.discordId)})` : ''}</div>${roblox}</div></div>${iaBlock}`;
    } catch (e) { body.innerHTML = `<div class="table-empty"><div class="table-empty-text">${esc(e.message)}</div></div>`; }
  };

  async function finishIntake() {
    try {
      const r = await api('/api/support/tickets/' + cur.id + '/submit-intake', { method: 'POST', body: JSON.stringify({ answers: intakeAnswers }) });
      cur = r.ticket; mode = 'chat';
      const full = await api('/api/support/tickets/' + cur.id);
      cur = full; renderTicketHeader(full); renderLog(full);
      setComposerEnabled(full); openStream(full.id);
      showToast('Ticket submitted', 'success');
    } catch (e) { showToast(e.message, 'error'); }
  }

  function appendBubble(m) { $('sup-log').insertAdjacentHTML('beforeend', renderMsg(m)); scrollLog(); }
  // A "typing…" bot bubble that reveals `text` after a short, length-scaled delay.
  function appendBotTyping(text, done, mid) {
    const id = 'typing-' + Math.random().toString(36).slice(2);
    const midAttr = mid ? ` data-mid="${esc(mid)}"` : '';
    $('sup-log').insertAdjacentHTML('beforeend', `<div class="sup-msg bot" id="${id}"${midAttr}><div class="sup-av"><img src="${BOT_AVATAR}" alt="MET" /></div><div class="sup-body"><div class="sup-meta"><span class="sup-name">${BOT_NAME}</span></div><div class="sup-text sup-typing"><span></span><span></span><span></span></div></div></div>`);
    scrollLog();
    const delay = Math.min(2000, 650 + (text || '').length * 14);
    setTimeout(() => {
      const el = document.getElementById(id);
      if (el) { const tx = el.querySelector('.sup-text'); if (tx) { tx.classList.remove('sup-typing'); tx.innerHTML = mdInline(text); } }
      scrollLog(); if (done) done();
    }, delay);
  }
  function setComposerBusy(b) {
    ['sup-send-btn', 'sup-input', 'sup-attach-btn'].forEach(idv => { const el = $(idv); if (el) el.disabled = b; });
  }

  // ── Composer ────────────────────────────────────────────────────────
  function wireComposer() {
    $('sup-attach-btn').addEventListener('click', () => $('sup-file').click());
    $('sup-file').addEventListener('change', onPickFiles);
    $('sup-send-btn').addEventListener('click', onSend);
    $('sup-input').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); }
    });
  }
  function setComposerEnabled(t) {
    const canOpener = t.isMine && t.status !== 'CLOSED';
    const canStaff = t.canManage && t.status !== 'CLOSED';
    const on = mode === 'intake' ? (t.isMine && t.status === 'INTAKE') : (canOpener || canStaff);
    $('sup-composer').style.display = on ? '' : 'none';
    if (mode !== 'intake' && !on && t.status === 'CLOSED') { /* closed: composer hidden */ }
  }

  async function onPickFiles(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!cur) return;
    for (const f of files) {
      try {
        const meta = await supUpload(cur.id, f);
        pending.push({ mediaId: meta.mediaId, kind: meta.kind, name: meta.name, url: meta.url });
      } catch (err) { showToast(err.message, 'error'); }
    }
    renderPending();
  }
  function renderPending() {
    $('sup-pending').innerHTML = pending.map((p, i) =>
      `<span class="met-chip chip">${esc(p.name || p.kind)} <a onclick="supRmAtt(${i})" style="cursor:pointer;"><i class="ti ti-x"></i></a></span>`).join('');
  }
  window.supRmAtt = function (i) { pending.splice(i, 1); renderPending(); };

  async function supUpload(ticketId, file) {
    const q = new URLSearchParams({ filename: file.name || 'upload', mimeType: file.type || 'application/octet-stream' });
    const res = await fetch(`/api/support/tickets/${ticketId}/upload?` + q.toString(), { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Upload failed'); }
    return res.json();
  }

  async function onSend() {
    if (mode === 'intake') return submitIntakeStep();
    const body = $('sup-input').value.trim();
    if (!body && !pending.length) return;
    try {
      const msg = await api('/api/support/tickets/' + cur.id + '/messages', { method: 'POST', body: JSON.stringify({ body, attachments: pending }) });
      // SSE will echo it to everyone (incl. us); to feel instant, append now and let SSE dedupe by id.
      if (!document.querySelector(`[data-mid="${msg.id}"]`)) appendBubble(msg);
      $('sup-input').value = ''; pending = []; renderPending();
    } catch (e) { showToast(e.message, 'error'); }
  }

  // ── Realtime (SSE) ──────────────────────────────────────────────────
  function openStream(ticketId) {
    closeStream();
    try {
      es = new EventSource('/api/support/tickets/' + ticketId + '/stream');
      es.addEventListener('message', ev => {
        try {
          const m = JSON.parse(ev.data);
          if (!m || !m.id || document.querySelector(`[data-mid="${m.id}"]`)) return;
          if ((m.authorKind || '').toLowerCase() === 'bot') appendBotTyping(m.body, null, m.id);
          else appendBubble(m);
        } catch (e) {}
      });
      es.addEventListener('update', async () => {
        // Status/claim changed — refresh header + composer.
        try { const t = await api('/api/support/tickets/' + ticketId); cur = t; renderTicketHeader(t); setComposerEnabled(t); } catch (e) {}
      });
      es.onerror = () => { /* browser auto-reconnects */ };
    } catch (e) { /* SSE unsupported → messages still load on refresh */ }
  }
  function closeStream() { if (es) { es.close(); es = null; } }

  // ── Staff actions ───────────────────────────────────────────────────
  window.supClaim = async function () {
    try { const r = await api('/api/support/tickets/' + cur.id + '/claim', { method: 'POST' }); cur = r.ticket; renderTicketHeader(r.ticket); setComposerEnabled(r.ticket); showToast('Claimed', 'success'); }
    catch (e) { showToast(e.message, 'error'); }
  };
  window.supClose = async function () {
    const reason = prompt('Closing note (optional):') || '';
    try { const r = await api('/api/support/tickets/' + cur.id + '/close', { method: 'POST', body: JSON.stringify({ reason }) }); cur = r.ticket; renderTicketHeader(r.ticket); setComposerEnabled(r.ticket); showToast('Ticket closed', 'success'); }
    catch (e) { showToast(e.message, 'error'); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
