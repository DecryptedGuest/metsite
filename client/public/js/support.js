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
  const mdInline = s => esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, txt, url) => `<a href="${url}" target="_blank" rel="noopener" style="color:var(--blue);">${txt}</a>`);
  let pendingIdentity = null;

  let CFG = { types: [], isStaff: false, handleableTypes: [], me: null };
  const typeByKey = {};
  let queueStatus = 'active';

  // ── Anonymous access: per-ticket tokens kept in localStorage ──────────
  const LS = 'met_support_tickets';
  function stored() { try { return JSON.parse(localStorage.getItem(LS)) || []; } catch (e) { return []; } }
  function saveStored(l) { try { localStorage.setItem(LS, JSON.stringify(l.slice(0, 50))); } catch (e) {} }
  function remember(id, token) { const l = stored().filter(x => x.id !== id); l.unshift({ id, token, at: Date.now() }); saveStored(l); }
  function tokenFor(id) { const x = stored().find(x => x.id === id); return x ? x.token : null; }
  function tok(path, id) { const t = tokenFor(id); return t ? path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(t) : path; }

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
    } catch (e) { return; }
    const me = CFG.me;               // null when browsing as a guest
    MY_AVATAR = me && me.avatar || null;
    $('sup-user-name').textContent = me ? me.name : 'Guest';
    $('sup-user-fallback').textContent = (me ? me.name : 'G').slice(0, 1).toUpperCase();
    if (MY_AVATAR) { const a = $('sup-user-avatar'); if (a) { a.src = MY_AVATAR; a.style.display = ''; $('sup-user-fallback').style.display = 'none'; } }
    // Guests: swap the sign-out button for a subtle "Log in (optional)" link.
    if (!me) {
      const lo = document.querySelector('.met-topbar-right form'); if (lo) lo.style.display = 'none';
      const right = document.querySelector('.met-topbar-right');
      if (right && !document.getElementById('sup-login-link')) {
        const a = document.createElement('a'); a.id = 'sup-login-link'; a.href = '/login'; a.className = 'btn btn-ghost btn-sm';
        a.innerHTML = '<i class="ti ti-login"></i> Log in';
        right.appendChild(a);
      }
    }
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
    const el = $('sup-mytickets');
    el.innerHTML = '<div class="table-loading"><div class="spinner"></div></div>';
    const seen = new Set(); const rows = [];
    try { (await api('/api/support/tickets/mine') || []).forEach(t => { if (!seen.has(t.id)) { seen.add(t.id); rows.push(t); } }); } catch (e) {}
    for (const st of stored()) {
      if (seen.has(st.id)) continue;
      try { const t = await api(tok('/api/support/tickets/' + st.id, st.id)); seen.add(t.id); rows.push(t); } catch (e) {}
    }
    rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    el.innerHTML = rows.length ? rows.map(t => ticketRow(t, false)).join('')
      : '<div class="table-empty"><div class="table-empty-text">You have no tickets yet. Pick an option above to get help.</div></div>';
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
    const cfg = typeByKey[type] || {};
    if (cfg.helpBot) return startHelpBot(cfg);   // General Support → help bot first
    helpMode = false;
    try {
      const r = await api('/api/support/tickets', { method: 'POST', body: JSON.stringify({ type }) });
      if (r.token) remember(r.ticket.id, r.token);
      cur = r.ticket;
      enterTicketView();
      const t = await api(tok('/api/support/tickets/' + cur.id, cur.id));
      cur = t;
      renderTicketHeader(t);
      $('sup-log').innerHTML = (t.messages || []).map(renderMsg).join('');
      startIntake(r.questions);
    } catch (e) { showToast(e.message, 'error'); }
  };

  window.supOpenTicket = openTicket;
  async function openTicket(id) {
    helpMode = false;
    try {
      const t = await api(tok('/api/support/tickets/' + id, id));
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
    helpMode = false;
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
    const panel = transitionPanel(m);
    if (panel) return `<div class="sup-msg-sys"${m.id ? ` data-mid="${esc(m.id)}"` : ''}>${panel}</div>`;
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
    // The echoed bubble needs viewable URLs for its attachments.
    const display = (attachments || []).map(a => ({ ...a, url: `/api/support/tickets/${cur.id}/media/${a.mediaId}` }));
    appendBubble({ authorKind: 'OPENER', authorName: (CFG.me && CFG.me.name) || "You", authorAvatar: MY_AVATAR, body: answer, attachments: display, identity: identity || null, createdAt: new Date().toISOString() });
  }
  function submitIntakeStep() {
    const q = intakeQs[0];
    const answer = $('sup-input').value.trim();
    if (q.kind === 'identity' && answer) return resolveAndConfirm(q, answer);
    if (anyUploading()) return showToast('Please wait for uploads to finish.', 'warning');
    const atts = readyAttachments();
    if (!q.optional && !answer && !atts.length) { showToast('Please answer this question.', 'warning'); return; }
    recordAnswer(q, answer, atts, null);
    intakeQs.shift();
    $('sup-input').value = ''; clearPending(); $('sup-hint').textContent = '';
    askNext();
  }

  // Identity questions: resolve the input, then ask the opener to confirm.
  async function resolveAndConfirm(q, input) {
    appendBubble({ authorKind: 'OPENER', authorName: (CFG.me && CFG.me.name) || "You", authorAvatar: MY_AVATAR, body: input, createdAt: new Date().toISOString() });
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
      const r = await api(tok('/api/support/tickets/' + cur.id + '/submit-intake', cur.id), { method: 'POST', body: JSON.stringify({ answers: intakeAnswers }) });
      cur = r.ticket; mode = 'chat';
      const full = await api(tok('/api/support/tickets/' + cur.id, cur.id));
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

  // ── General Support help bot (rule-based knowledge; hands off to IA) ──
  const CH = 'https://discord.com/channels/1191048287315304470/1458854944793694360';
  const KB_JOIN = `**How to join the MET**
Your career starts at Hendon Police College. Pass a tryout and the final exam and you'll become a **Community Support Officer**, then train up to **Constable** and can later join divisions (CID, SCO-19, MI5, and more).

**You MUST join BOTH Roblox groups first:**
• [Hendon Police College](https://www.roblox.com/communities/14201396/Hendon-Police-College-SLR)
• [Metropolitan Police](https://www.roblox.com/communities/17275620/Metropolitan-Police-SLR)

Tryouts are announced in [#public-tryouts](${CH}) — react to the notifications message there to get pinged when one is hosted.`;
  const KB_REQS = `**Tryout requirements**
• Roblox account **100+ days old**
• **Not** in any gang (unless you have gang perms)
• Member of **both** Roblox groups: [Hendon Police College](https://www.roblox.com/communities/14201396/Hendon-Police-College-SLR) + [Metropolitan Police](https://www.roblox.com/communities/17275620/Metropolitan-Police-SLR)
• Verified, blocky avatar, in uniform, 16+

Come along when a tryout is announced in [#public-tryouts](${CH}).`;
  let helpMode = false, lastHelpText = '';

  window.startHelpBot = function () {
    helpMode = true; cur = null; mode = 'chat'; closeStream();
    enterTicketView();
    $('sup-t-title').textContent = 'General Support';
    $('sup-t-sub').textContent = 'Ask me anything — joining, tryouts, and more.';
    const st = $('sup-t-status'); if (st) st.outerHTML = '<span id="sup-t-status"></span>';
    $('sup-t-actions').innerHTML = '';
    $('sup-log').innerHTML = '';
    appendBubble({ authorKind: 'BOT', authorName: BOT_NAME, body: "Hi! I'm the MET support assistant. What do you need help with?", createdAt: new Date().toISOString() });
    helpTopics();
    $('sup-composer').style.display = '';
    $('sup-hint').textContent = 'Tap an option above, or type your question.';
    $('sup-input').focus();
  };
  window.supHelpTopics = helpTopics;
  function helpTopics() {
    const opts = [['join', 'How do I join the MET?'], ['tryout', 'When is the next tryout?'], ['reqs', 'What are the requirements?'], ['human', 'Talk to an investigator']];
    $('sup-log').insertAdjacentHTML('beforeend',
      `<div style="display:flex;flex-wrap:wrap;gap:8px;margin:4px 0 4px 44px;">` +
      opts.map(([k, l]) => `<button class="btn btn-ghost btn-sm" onclick="supHelp('${k}')">${esc(l)}</button>`).join('') + `</div>`);
    scrollLog();
  }
  window.supHelp = function (topic) {
    const labels = { join: 'How do I join the MET?', tryout: 'When is the next tryout?', reqs: 'What are the requirements?', human: 'Talk to an investigator' };
    appendBubble({ authorKind: 'OPENER', authorName: (CFG.me && CFG.me.name) || 'You', authorAvatar: MY_AVATAR, body: labels[topic] || topic, createdAt: new Date().toISOString() });
    if (topic === 'human') return helpHandoff(lastHelpText);
    if (topic === 'join') return appendBotTyping(KB_JOIN, helpFollowup);
    if (topic === 'reqs') return appendBotTyping(KB_REQS, helpFollowup);
    if (topic === 'tryout') return helpTryouts();
  };
  function helpFollowup() {
    $('sup-log').insertAdjacentHTML('beforeend',
      `<div style="display:flex;flex-wrap:wrap;gap:8px;margin:4px 0 4px 44px;">
        <button class="btn btn-ghost btn-sm" onclick="supHelpTopics()">Other questions</button>
        <button class="btn btn-ghost btn-sm" onclick="supHelp('human')"><i class="ti ti-user"></i> Talk to an investigator</button>
      </div>`);
    scrollLog();
  }
  async function helpTryouts() {
    let list = [];
    try { list = await api('/api/support/tryouts'); } catch (e) {}
    let body;
    if (list && list.length) {
      const lines = list.map(t => `• ${t.status === 'LIVE' ? '**LIVE now**' : new Date(t.scheduledAt).toLocaleString()}${t.hostName ? ' — host ' + t.hostName : ''}`).join('\n');
      body = `**Upcoming MET tryouts:**\n${lines}\n\nThey're hosted in [#public-tryouts](${CH}) — react to the notifications message to get pinged when one starts.`;
    } else {
      body = `There are no scheduled tryouts right now. Keep an eye on [#public-tryouts](${CH}) and react to the notifications message there — you'll be pinged the moment one is hosted.`;
    }
    appendBotTyping(body, helpFollowup);
  }
  function helpFreeText(text) {
    lastHelpText = text;
    appendBubble({ authorKind: 'OPENER', authorName: (CFG.me && CFG.me.name) || 'You', authorAvatar: MY_AVATAR, body: text, createdAt: new Date().toISOString() });
    const t = text.toLowerCase();
    if (/join|how do i (get|become)|sign ?up|recruit/.test(t)) return appendBotTyping(KB_JOIN, helpFollowup);
    if (/require|how old|days old|gang|group/.test(t)) return appendBotTyping(KB_REQS, helpFollowup);
    if (/tryout|try out|when.*(tryout|test)|next test/.test(t)) return helpTryouts();
    appendBotTyping("I'm not sure I can answer that one. Want me to connect you to an Internal Affairs investigator?", () => {
      $('sup-log').insertAdjacentHTML('beforeend',
        `<div style="display:flex;gap:8px;margin:4px 0 4px 44px;">
          <button class="btn btn-primary btn-sm" onclick="supHelp('human')"><i class="ti ti-user"></i> Yes, connect me</button>
          <button class="btn btn-ghost btn-sm" onclick="supHelpTopics()">No, other questions</button></div>`);
      scrollLog();
    });
  }
  async function helpHandoff(freeText) {
    appendBotTyping('Connecting you to an Internal Affairs investigator…', async () => {
      try {
        const r = await api('/api/support/tickets', { method: 'POST', body: JSON.stringify({ type: 'GENERAL_SUPPORT' }) });
        if (r.token) remember(r.ticket.id, r.token);
        cur = r.ticket; helpMode = false; mode = 'chat';
        const question = (freeText || '').trim() || 'Requested to speak with an investigator.';
        await api(tok('/api/support/tickets/' + cur.id + '/submit-intake', cur.id), { method: 'POST', body: JSON.stringify({ answers: [{ id: 'issue', answer: question }] }) });
        const full = await api(tok('/api/support/tickets/' + cur.id, cur.id));
        cur = full; renderTicketHeader(full); renderLog(full); setComposerEnabled(full); openStream(full.id);
      } catch (e) { showToast(e.message, 'error'); helpMode = true; }
    });
  }

  // ── System transition panels (transfer to IA, claimed, closed) ───────
  function sysPanelHtml(logo, icon, title, sub) {
    const media = logo ? `<img src="${logo}" style="width:34px;height:34px;border-radius:8px;object-fit:cover;" alt="">` : `<i class="ti ${icon}" style="font-size:22px;color:var(--blue);"></i>`;
    return `<div class="sup-sys">${media}<div><div style="font-weight:700;font-size:13px;">${esc(title)}</div>${sub ? `<div style="font-size:11px;color:var(--text-muted);">${esc(sub)}</div>` : ''}</div></div>`;
  }
  function transitionPanel(m) {
    if ((m.authorKind || '').toLowerCase() !== 'bot') return null;
    const b = m.body || '';
    if (/will be with you shortly/i.test(b)) return sysPanelHtml('/img/divisions/ia.png', null, 'Transferred to Internal Affairs', b);
    if (/claimed this ticket/i.test(b))       return sysPanelHtml('/img/divisions/ia.png', null, 'Claimed by Internal Affairs', b);
    if (/released this ticket/i.test(b))       return sysPanelHtml(null, 'ti-arrow-back-up', 'Back in the queue', b);
    if (/was closed/i.test(b))                 return sysPanelHtml(null, 'ti-lock', 'Ticket closed', b);
    return null;
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

  let attSeq = 0;
  function fmtSize(n) { n = n || 0; if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(0) + ' KB'; return (n / 1048576).toFixed(1) + ' MB'; }

  // Pick files → show each as a preview tile that spins while it uploads, then
  // flips to "ready" once the server has it.
  function onPickFiles(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!cur) return;
    for (const f of files) {
      const isImg = /^image\//.test(f.type);
      const item = { uid: ++attSeq, name: f.name || 'upload', kind: isImg ? 'image' : 'video', size: f.size || 0, status: 'loading', previewUrl: isImg ? URL.createObjectURL(f) : null, mediaId: null, url: null };
      pending.push(item);
      renderPending();
      supUpload(cur.id, f).then(meta => {
        item.mediaId = meta.mediaId; item.url = meta.url; item.kind = meta.kind; item.status = 'done';
        renderPending();
      }).catch(err => {
        item.status = 'error'; renderPending(); showToast(err.message, 'error');
      });
    }
  }
  function renderPending() {
    const el = $('sup-pending');
    if (!pending.length) { el.innerHTML = ''; return; }
    el.innerHTML = pending.map(p => {
      const thumb = p.previewUrl
        ? `<img src="${esc(p.previewUrl)}" alt="" />`
        : `<i class="ti ti-${p.kind === 'video' ? 'video' : 'file'}"></i>`;
      const status = p.status === 'loading' ? 'Uploading…' : (p.status === 'error' ? 'Upload failed' : fmtSize(p.size));
      const spin = p.status === 'loading' ? '<div class="sup-att-spin"><div class="spinner"></div></div>' : '';
      return `<div class="sup-att-tile ${p.status}">
        <div class="sup-att-thumb">${thumb}${spin}</div>
        <div class="sup-att-info"><div class="sup-att-name" title="${esc(p.name)}">${esc(p.name)}</div><div class="sup-att-status">${esc(status)}</div></div>
        <button class="sup-att-rm" onclick="supRmAtt(${p.uid})" title="Remove"><i class="ti ti-x"></i></button>
      </div>`;
    }).join('');
  }
  window.supRmAtt = function (uid) {
    const i = pending.findIndex(p => p.uid === uid);
    if (i < 0) return;
    if (pending[i].previewUrl) { try { URL.revokeObjectURL(pending[i].previewUrl); } catch (e) {} }
    pending.splice(i, 1); renderPending();
  };
  // Only fully-uploaded files go on a message/answer.
  function readyAttachments() { return pending.filter(p => p.status === 'done').map(p => ({ mediaId: p.mediaId, kind: p.kind, name: p.name })); }
  function anyUploading() { return pending.some(p => p.status === 'loading'); }
  function clearPending() { pending.forEach(p => { if (p.previewUrl) { try { URL.revokeObjectURL(p.previewUrl); } catch (e) {} } }); pending = []; renderPending(); }

  async function supUpload(ticketId, file) {
    const q = new URLSearchParams({ filename: file.name || 'upload', mimeType: file.type || 'application/octet-stream' });
    const res = await fetch(tok(`/api/support/tickets/${ticketId}/upload?` + q.toString(), ticketId), { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Upload failed'); }
    return res.json();
  }

  async function onSend() {
    if (mode === 'intake') return submitIntakeStep();
    if (helpMode) { const text = $('sup-input').value.trim(); if (!text) return; $('sup-input').value = ''; return helpFreeText(text); }
    if (anyUploading()) return showToast('Please wait for uploads to finish.', 'warning');
    const body = $('sup-input').value.trim();
    const atts = readyAttachments();
    if (!body && !atts.length) return;
    try {
      const msg = await api(tok('/api/support/tickets/' + cur.id + '/messages', cur.id), { method: 'POST', body: JSON.stringify({ body, attachments: atts }) });
      // SSE will echo it to everyone (incl. us); append now and let SSE dedupe by id.
      if (!document.querySelector(`[data-mid="${msg.id}"]`)) appendBubble(msg);
      $('sup-input').value = ''; clearPending();
    } catch (e) { showToast(e.message, 'error'); }
  }

  // ── Realtime (SSE + polling fallback) ────────────────────────────────
  let pollTimer = null;
  function openStream(ticketId) {
    closeStream();
    try {
      es = new EventSource(tok('/api/support/tickets/' + ticketId + '/stream', ticketId));
      es.addEventListener('message', ev => {
        try {
          const m = JSON.parse(ev.data);
          if (!m || !m.id || document.querySelector(`[data-mid="${m.id}"]`)) return;
          if ((m.authorKind || '').toLowerCase() === 'bot') appendBotTyping(m.body, null, m.id);
          else appendBubble(m);
        } catch (e) {}
      });
      es.addEventListener('update', () => refreshTicket(ticketId));
      es.onerror = () => { /* browser auto-reconnects */ };
    } catch (e) { /* SSE unsupported → the poll below still updates the chat */ }
    // Polling fallback — guarantees the opener's chat updates even if a proxy
    // buffers SSE. De-duped by message id, so it never doubles up with SSE.
    pollTimer = setInterval(() => refreshTicket(ticketId), 5000);
  }
  function closeStream() {
    if (es) { es.close(); es = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }
  // Pull the ticket and append any messages we don't already show; sync status.
  async function refreshTicket(ticketId) {
    if (!cur || cur.id !== ticketId) return;
    let t;
    try { t = await api(tok('/api/support/tickets/' + ticketId, ticketId)); } catch (e) { return; }
    (t.messages || []).forEach(m => {
      if (m.id && !document.querySelector(`[data-mid="${m.id}"]`)) appendBubble(m);
    });
    if (t.status !== cur.status || (t.claimedByName || '') !== (cur.claimedByName || '')) {
      cur = t; renderTicketHeader(t); setComposerEnabled(t);
    }
  }

  // ── Staff actions ───────────────────────────────────────────────────
  window.supClaim = async function () {
    try { const r = await api('/api/support/tickets/' + cur.id + '/claim', { method: 'POST' }); cur = r.ticket; renderTicketHeader(r.ticket); setComposerEnabled(r.ticket); showToast('Claimed', 'success'); }
    catch (e) { showToast(e.message, 'error'); }
  };
  window.supClose = async function () {
    const reason = (await uiPrompt('Closing note (optional):', { title: 'Close ticket', confirmText: 'Close ticket', placeholder: 'Optional note for the record' })) || '';
    try { const r = await api('/api/support/tickets/' + cur.id + '/close', { method: 'POST', body: JSON.stringify({ reason }) }); cur = r.ticket; renderTicketHeader(r.ticket); setComposerEnabled(r.ticket); showToast('Ticket closed', 'success'); }
    catch (e) { showToast(e.message, 'error'); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
