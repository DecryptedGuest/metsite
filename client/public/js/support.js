/* MET Support (/support) — METAdministration intake + Discord-style ticket chat.
   Rule-based intake (fixed questions per type), realtime via SSE, attachments
   via the ticket-scoped upload route. */
(function () {
  const esc = window.escapeHtml || (s => String(s == null ? '' : s));
  const fmtTime = d => { try { return window.formatDateTime ? window.formatDateTime(d) : new Date(d).toLocaleString(); } catch (e) { return ''; } };
  const BOT_NAME = 'MET Assistant';
  const BOT_AVATAR = '/img/divisions/met.png';   // MET crest (not the IA logo)
  let MY_AVATAR = null;
  // Full Discord-style formatting (bold/italic/underline/strike/spoiler/code/
  // quotes/links/mentions) via the shared renderer, with a safe fallback.
  const mdInline = s => window.mdRich
    ? window.mdRich(s)
    : esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  let pendingIdentity = null;
  let myPunishments = null;      // cached /my-punishments (for the appeal picker)
  let selectedPunishment = null; // the punishment the opener picked to appeal
  let pendingAppealId = null;    // deep-link ?appeal=<id> → auto-select in the picker

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
  let replyTo = null;    // { id, authorName, snippet } the composer is replying to
  let es = null;         // EventSource

  const $ = id => document.getElementById(id);

  // ── Init ──────────────────────────────────────────────────────
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
    const params = new URLSearchParams(location.search);
    const id = params.get('ticket');
    if (id) return openTicket(id);
    // Deep link: /support?appeal=<punishmentId|caseRef> → open a Disciplinary
    // Appeal and pre-select that punishment (used by the punishment DM link).
    if (params.has('appeal')) {
      pendingAppealId = params.get('appeal') || null;
      supOpenNew('DISCIPLINARY_APPEAL');
    }
  }

  // ── Landing: panels ────────────────────────────────────────────
  // Show the first three everyday options; tuck any extra (the restricted IA
  // Complaint) behind a "Show more" toggle so the landing page stays uncluttered.
  const PANELS_VISIBLE = 3;
  function panelCard(t, i) {
    const extra = i >= PANELS_VISIBLE ? ' sup-panel-extra sup-hidden' : '';
    const tkt = t.key ? ' tkt-' + esc(String(t.key).toLowerCase()) : '';
    return `
      <div class="panel glass sup-panel ${t.restricted ? 'sup-restricted' : ''}${extra}${tkt}">
        <h3><i class="ti ${esc(t.icon)}"></i> ${esc(t.label)}</h3>
        <p>${esc(t.blurb)}</p>
        ${t.restricted ? '<div class="sup-locknote"><i class="ti ti-lock"></i> Reviewed by IA HICOMM only</div>' : ''}
        <button class="btn btn-primary btn-sm" onclick="supOpenNew('${t.key}')"><i class="ti ti-plus"></i> ${esc(t.button)}</button>
      </div>`;
  }
  function renderPanels() {
    const types = CFG.types || [];
    $('sup-panels').innerHTML = types.map(panelCard).join('');
    // Add a Show more / less toggle under the grid when there are extra cards.
    const old = $('sup-panels-more-btn'); if (old) old.remove();
    if (types.length > PANELS_VISIBLE) {
      const bar = document.createElement('div');
      bar.id = 'sup-panels-more-btn';
      bar.style.cssText = 'grid-column:1/-1;display:flex;justify-content:center;margin-top:2px;';
      bar.innerHTML = `<button type="button" class="btn btn-ghost btn-sm" onclick="supTogglePanels()"><i class="ti ti-chevron-down"></i> Show more options</button>`;
      $('sup-panels').appendChild(bar);
    }
  }
  window.supTogglePanels = function () {
    const extras = document.querySelectorAll('#sup-panels .sup-panel-extra');
    if (!extras.length) return;
    const nowHidden = !extras[0].classList.contains('sup-hidden'); // state AFTER this toggle
    extras.forEach(el => el.classList.toggle('sup-hidden', nowHidden));
    const btn = $('sup-panels-more-btn');
    if (btn) btn.querySelector('button').innerHTML = nowHidden
      ? '<i class="ti ti-chevron-down"></i> Show more options'
      : '<i class="ti ti-chevron-up"></i> Show fewer options';
  };

  function ticketRow(t, staff) {
    const who = staff ? esc(t.openerName) : esc(t.typeLabel);
    const claim = t.claimedByName ? ` · claimed by ${esc(t.claimedByName)}` : '';
    const tkt = t.type ? ' tkt-row tkt-' + esc(String(t.type).toLowerCase()) : '';
    return `<div class="sup-row${tkt}" style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border,#242424);cursor:pointer;" onclick="supOpenTicket('${t.id}')">
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
    el.innerHTML = window.metSkeleton ? window.metSkeleton('rows', 4) : '<div class="table-loading"><div class="spinner"></div></div>';
    const seen = new Set(); const rows = [];
    try { (await api('/api/support/tickets/mine') || []).forEach(t => { if (!seen.has(t.id)) { seen.add(t.id); rows.push(t); } }); } catch (e) {}
    for (const st of stored()) {
      if (seen.has(st.id)) continue;
      try { const t = await api(tok('/api/support/tickets/' + st.id, st.id)); seen.add(t.id); rows.push(t); } catch (e) {}
    }
    rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const EMPTY_MINE = window.metEmpty
      ? window.metEmpty({ icon: 'ti-ticket', title: 'No tickets yet', sub: 'Pick an option above to get help.' })
      : '<div class="table-empty"><div class="table-empty-text">You have no tickets yet. Pick an option above to get help.</div></div>';
    el.innerHTML = rows.length ? rows.map(t => ticketRow(t, false)).join('') : EMPTY_MINE;
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
      const EMPTY_QUEUE = window.metEmpty
        ? window.metEmpty({ icon: 'ti-inbox', title: 'Queue empty', sub: 'Tickets waiting to be handled will appear here.' })
        : '<div class="table-empty"><div class="table-empty-text">Nothing here.</div></div>';
      $('sup-queue').innerHTML = rows.length ? rows.map(t => ticketRow(t, true)).join('') : EMPTY_QUEUE;
    } catch (e) { $('sup-queue').innerHTML = `<div class="table-empty"><div class="table-empty-text">${esc(e.message)}</div></div>`; }
  }

  // ── Open / create a ticket ───────────────────────────────────────
  window.supOpenNew = async function (type) {
    const cfg = typeByKey[type] || {};
    if (cfg.helpBot) return startHelpBot(cfg);   // General Support → help bot first
    helpMode = false;
    // Fresh ticket → drop any punishment picked for a previous appeal, so a
    // stale selection can't be attached to this (possibly different) ticket.
    selectedPunishment = null;
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
        restoreDraft(t.id);   // bring back any reply typed here earlier
        openStream(t.id);
      }
    } catch (e) { showToast(e.message, 'error'); }
  }

  function enterTicketView() {
    closeStream();
    pending = []; renderPending();
    // Clear the previous ticket's messages so a failed load of the new ticket
    // can't strand the user looking at another ticket's transcript.
    const log = $('sup-log'); if (log) log.innerHTML = '';
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
    // Reopen a closed ticket — the opener (follow-up) or handling staff.
    if (t.status === 'CLOSED' && (t.isMine || t.canManage)) acts.push(`<button class="btn btn-primary btn-sm" onclick="supReopen()"><i class="ti ti-rotate"></i> Reopen</button>`);
    // Download a transcript — anyone who can see the ticket.
    acts.push(`<a class="btn btn-ghost btn-sm" href="${tok('/api/support/tickets/' + t.id + '/transcript', t.id)}" target="_blank" rel="noopener"><i class="ti ti-download"></i> Transcript</a>`);
    $('sup-t-actions').innerHTML = acts.join('');
  }
  // Reopen a closed ticket (opener follow-up).
  window.supReopen = async function () {
    if (!cur) return;
    try {
      const r = await api(tok('/api/support/tickets/' + cur.id + '/reopen', cur.id), { method: 'POST', body: JSON.stringify({}) });
      cur = r.ticket; renderTicketHeader(cur); setComposerEnabled(cur); openStream(cur.id);
      showToast('Ticket reopened — an investigator will be with you shortly.', 'success');
      supSound('reopened');
    } catch (e) { showToast(e.message, 'error'); }
  };

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
    $('sup-log').innerHTML = statusTimelineHtml(t) + parts.join('');
    scrollLog(true); // full render only happens on ticket open → land at the bottom
    enrichLogMentions();
  }

  // A plain-language progress bar the OPENER sees at the top of their ticket, so
  // they can follow Submitted → Claimed → Decision without an investigator
  // explaining it. Staff don't need it (they have the workspace controls).
  function statusTimelineHtml(t) {
    if (!t || !t.isMine) return '';
    const claimedDone = t.status === 'CLAIMED' || t.status === 'CLOSED';
    const closedDone  = t.status === 'CLOSED';
    const steps = [
      { label: 'Submitted', done: true, at: t.createdAt },
      { label: claimedDone ? ('Claimed' + (t.claimedByName ? ' · ' + esc(t.claimedByName) : '')) : 'Awaiting an investigator', done: claimedDone, at: t.claimedAt },
      { label: closedDone ? 'Reviewed & closed' : 'Decision', done: closedDone, at: t.closedAt },
    ];
    const col = (s) => `<div style="display:flex;flex-direction:column;align-items:center;flex:1 1 0;min-width:0;text-align:center;">
      <div style="width:12px;height:12px;border-radius:50%;background:${s.done ? 'var(--green,#22c55e)' : 'var(--surface-2,#2a3140)'};box-shadow:0 0 0 2px ${s.done ? 'var(--green,#22c55e)' : 'var(--border,#3a4150)'};"></div>
      <div style="font-size:11px;margin-top:6px;color:${s.done ? 'var(--text-primary)' : 'var(--text-muted)'};line-height:1.3;">${s.label}</div>
      ${s.at ? `<div style="font-size:10px;color:var(--text-muted);margin-top:1px;">${fmtTime(s.at)}</div>` : ''}
    </div>`;
    const bar = (on) => `<div style="height:2px;flex:0 0 20px;margin-top:5px;background:${on ? 'var(--green,#22c55e)' : 'var(--border,#3a4150)'};"></div>`;
    return `<div class="sup-timeline" style="display:flex;align-items:flex-start;padding:12px 14px;margin-bottom:10px;border:1px solid var(--border,#2a3140);border-radius:12px;background:rgba(255,255,255,.02);">
      ${col(steps[0])}${bar(claimedDone)}${col(steps[1])}${bar(closedDone)}${col(steps[2])}
    </div>`;
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
  // Small circular platform logo badge for the corner of an avatar.
  function idLogoBadge(kind) {
    const wrap = 'position:absolute;right:-3px;bottom:-3px;width:17px;height:17px;border-radius:50%;display:flex;align-items:center;justify-content:center;border:2px solid var(--surface-1,#0b0f18);box-shadow:0 1px 2px rgba(0,0,0,.4);';
    if (kind === 'discord') {
      return `<span style="${wrap}background:#5865F2;"><svg viewBox="0 0 24 24" width="9" height="9" fill="#fff"><path d="M20.317 4.369A19.79 19.79 0 0 0 15.885 3c-.211.375-.454.88-.622 1.28a18.27 18.27 0 0 0-5.53 0A12.7 12.7 0 0 0 9.11 3 19.74 19.74 0 0 0 4.677 4.37C1.997 8.36 1.27 12.24 1.633 16.07a19.9 19.9 0 0 0 6.073 3.058c.492-.67.93-1.382 1.307-2.13-.72-.27-1.41-.605-2.06-.996.173-.127.342-.26.505-.397a14.2 14.2 0 0 0 12.084 0c.165.14.334.272.505.397-.65.39-1.342.727-2.063.996.377.748.814 1.46 1.306 2.13a19.85 19.85 0 0 0 6.075-3.058c.427-4.44-.729-8.29-3.056-11.702ZM8.02 13.74c-1.183 0-2.157-1.085-2.157-2.42s.955-2.42 2.157-2.42c1.21 0 2.176 1.095 2.157 2.42 0 1.335-.955 2.42-2.157 2.42Zm7.96 0c-1.183 0-2.157-1.085-2.157-2.42s.955-2.42 2.157-2.42c1.21 0 2.176 1.095 2.157 2.42 0 1.335-.947 2.42-2.157 2.42Z"/></svg></span>`;
    }
    return `<span style="${wrap}background:#000;"><svg viewBox="0 0 24 24" width="9" height="9" fill="#fff"><path d="M4.976 0 0 18.573 18.573 24 24 5.427 4.976 0ZM10.19 9.377l4.434 1.187-1.187 4.434-4.434-1.187 1.187-4.434Z"/></svg></span>`;
  }
  // A full, proper profile card for an identity — Discord + Roblox avatars, each
  // with its platform logo, name, handles and IDs. Whole card opens the Roblox
  // profile. Used both in the intake "is this the right person?" confirmation
  // and inline on report tickets.
  function identityCardHtml(p) {
    if (!p) return '';
    const dAv = p.discordAvatar
      ? `<span style="position:relative;display:inline-flex;"><img src="${esc(p.discordAvatar)}" alt="Discord avatar" style="width:50px;height:50px;border-radius:50%;object-fit:cover;border:2px solid #5865F2;background:#0b0f18;">${idLogoBadge('discord')}</span>`
      : '';
    const rAv = p.headshotUrl
      ? `<span style="position:relative;display:inline-flex;${dAv ? 'margin-left:-14px;' : ''}"><img src="${esc(p.headshotUrl)}" alt="Roblox avatar" style="width:50px;height:50px;border-radius:50%;object-fit:cover;border:2px solid #e2231a;background:#0b0f18;">${idLogoBadge('roblox')}</span>`
      : '';
    const avatars = (dAv || rAv) ? `<div style="display:flex;align-items:center;flex:0 0 auto;">${dAv}${rAv}</div>` : '';
    const robloxUrl = p.robloxUrl || (p.robloxId ? `https://www.roblox.com/users/${esc(p.robloxId)}/profile` : '');
    const robloxLine = (p.robloxUsername || p.robloxId)
      ? `<div style="font-size:12px;color:var(--text-muted);margin-top:2px;"><span style="color:#e2231a;font-weight:700;">Roblox</span> ${p.robloxUsername ? '@' + esc(p.robloxUsername) : ''}${p.robloxId ? ` · ID ${esc(p.robloxId)}` : ''}</div>`
      : '';
    const discordLine = (p.discordUsername || p.discordId)
      ? `<div style="font-size:12px;color:var(--text-muted);margin-top:2px;"><span style="color:#5865F2;font-weight:700;">Discord</span> ${p.discordUsername ? '@' + esc(p.discordUsername) : ''}${p.discordId ? ` · ID ${esc(p.discordId)}` : ''}</div>`
      : '';
    const foot = robloxUrl ? `<div style="font-size:11px;color:var(--blue);margin-top:7px;display:flex;align-items:center;gap:4px;"><i class="ti ti-external-link"></i> Open Roblox profile</div>` : '';
    const open = robloxUrl ? ` onclick="window.open('${esc(robloxUrl)}','_blank','noopener')" style="cursor:pointer;display:flex;gap:13px;align-items:center;padding:13px;border:1px solid var(--border,#2a3040);border-radius:13px;background:var(--surface-1,#0e1420);max-width:430px;"` : ` style="display:flex;gap:13px;align-items:center;padding:13px;border:1px solid var(--border,#2a3040);border-radius:13px;background:var(--surface-1,#0e1420);max-width:430px;"`;
    return `<div class="sup-idcard"${open} title="${robloxUrl ? 'Open Roblox profile' : ''}">
      ${avatars}
      <div style="min-width:0;flex:1;">
        <div style="font-weight:700;font-size:15px;">${esc(p.robloxDisplayName || p.robloxUsername || p.discordUsername || 'Unknown')}</div>
        ${robloxLine}
        ${discordLine}
        ${foot}
      </div>
    </div>`;
  }
  function renderMsg(m) {
    const panel = transitionPanel(m);
    if (panel) return `<div class="sup-msg-sys"${m.id ? ` data-mid="${esc(m.id)}"` : ''}>${panel}</div>`;
    const kind = (m.authorKind || 'STAFF').toLowerCase();
    const atts = (m.attachments || []).map(a => {
      // Guest openers have no session cookie — a bare media URL 403s. Append the
      // per-ticket token so their own evidence and staff-sent images load.
      // (tok() is a no-op for signed-in users, who authenticate via cookie.)
      const u = tok(a.url, cur && cur.id);
      return a.kind === 'video'
        ? `<video src="${esc(u)}" controls></video>`
        : `<a href="${esc(u)}" class="met-evid" onclick="return metImgGallery(this)"><img src="${esc(u)}" alt="${esc(a.name || '')}" /></a>`;
    }).join('');
    const canReply = !!m.id && (m.authorKind || '').toLowerCase() !== 'bot' && cur && cur.status !== 'CLOSED';
    // The opener may edit/delete their OWN messages (signed-in only — guests have
    // no account to authenticate the edit).
    const mine = !!(m.id && CFG.me && m.authorId && m.authorId === CFG.me.id && kind !== 'bot');
    const edited = m.editedAt ? '<span class="sup-edited" title="Edited">(edited)</span>' : '';
    const ownActs = mine ? `<button class="sup-msg-act" title="Edit" onclick="supEditMsg('${esc(m.id)}')"><i class="ti ti-pencil"></i></button><button class="sup-msg-act" title="Delete" onclick="supDeleteMsg('${esc(m.id)}')"><i class="ti ti-trash"></i></button>` : '';
    return `<div class="sup-msg ${kind}"${m.id ? ` data-mid="${esc(m.id)}"` : ''}>
      ${avatarHtml(m)}
      <div class="sup-body">
        ${replyRefHtml(m)}
        <div class="sup-meta"><span class="sup-name"${profileClick(m)}${nameUid(m)}>${esc(m.authorName || '')}</span><span class="sup-time">${fmtTime(m.createdAt)}</span>${edited}${canReply ? `<button class="sup-reply-btn" title="Reply" onclick="supReply('${esc(m.id)}')"><i class="ti ti-arrow-back-up"></i></button>` : ''}${ownActs}</div>
        ${m.body ? `<div class="sup-text">${mdInline(m.body)}</div>` : ''}
        ${m.identity ? identityCardHtml(m.identity) : ''}
        ${atts ? `<div class="sup-atts">${atts}</div>` : ''}
      </div>
    </div>`;
  }
  // data-uid on an author's name → coloured by their Discord role (gradient + role
  // icon) via enrichMentions. Staff/internal AND the opener, so the opener's own
  // name carries the same role styling as staff.
  function nameUid(m) {
    const k = (m.authorKind || '').toLowerCase();
    return (m.authorDiscordId && (k === 'staff' || k === 'internal' || k === 'opener')) ? ` data-uid="${esc(m.authorDiscordId)}"` : '';
  }
  // The little "replying to X" reference rendered above a message body.
  function replyRefHtml(m) {
    const r = m.replyTo;
    if (!r) return '';
    const who = r.authorName || (r.authorKind === 'BOT' ? BOT_NAME : 'message');
    const snip = r.snippet ? esc(r.snippet) : '<span style="opacity:.6;">(no text)</span>';
    return `<div class="sup-replyref" onclick="supJumpTo('${esc(r.id)}')" title="Jump to message">
      <i class="ti ti-arrow-back-up"></i><span class="sup-replyref-who">${esc(who)}</span><span class="sup-replyref-snip">${snip}</span></div>`;
  }
  window.supJumpTo = function (mid) {
    const el = document.querySelector(`[data-mid="${(mid || '').replace(/"/g, '')}"]`);
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('sup-flash'); setTimeout(() => el.classList.remove('sup-flash'), 1200); }
  };

  // Auto-scroll only when the user is pinned to the bottom — so scrolling UP to
  // read history isn't yanked back down by incoming messages / polling.
  let _supPinned = true;
  function nearBottom(l) { return !l || (l.scrollHeight - l.scrollTop - l.clientHeight) < 140; }
  function scrollLog(force) { const l = $('sup-log'); if (!l) return; if (force) _supPinned = true; if (_supPinned) { l.scrollTop = l.scrollHeight; hideJumpPill(); } }
  // "↓ New messages" pill — shown when a message arrives while the user has
  // scrolled up to read history; clicking it jumps back to the newest message.
  function jumpPillEl() {
    let p = document.getElementById('sup-jump-pill');
    if (!p) {
      const log = document.getElementById('sup-log'); if (!log || !log.parentNode) return null;
      p = document.createElement('button'); p.id = 'sup-jump-pill'; p.className = 'sup-jump-pill'; p.type = 'button';
      p.innerHTML = '<i class="ti ti-arrow-down"></i> New messages';
      p.style.display = 'none';
      p.addEventListener('click', () => { scrollLog(true); });
      if (getComputedStyle(log.parentNode).position === 'static') log.parentNode.style.position = 'relative';
      log.parentNode.appendChild(p);
    }
    return p;
  }
  function showJumpPill() { const p = jumpPillEl(); if (p) p.style.display = ''; }
  function hideJumpPill() { const p = document.getElementById('sup-jump-pill'); if (p) p.style.display = 'none'; }
  (function wireScrollPin() {
    const l = document.getElementById('sup-log');
    if (l) l.addEventListener('scroll', () => { _supPinned = nearBottom(l); if (_supPinned) hideJumpPill(); }, { passive: true });
  })();

  // ── Intake flow ────────────────────────────────────────────────
  function startIntake(questions) {
    mode = 'intake';
    intakeQs = (questions || []).slice();
    intakeAnswers = [];
    setComposerEnabled(cur);
    askNext();
  }
  function showQuestionHint(q) {
    if (q.kind === 'punishment') {
      renderPunishmentPicker(q);
    } else if (q.kind === 'choice' && q.choices) {
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

  // ── Disciplinary Appeal: pick from the member's own punishments ──────
  async function loadMyPunishments() {
    if (myPunishments) return myPunishments;
    try { const r = await api('/api/support/my-punishments'); myPunishments = (r && r.punishments) || []; }
    catch (e) { myPunishments = []; }
    return myPunishments;
  }
  function punMeta(p) {
    if (p.expired) return { label: 'expired', color: 'var(--text-muted, #8b93a1)' };
    if (p.permanent) return { label: 'no expiry', color: 'var(--text-muted, #8b93a1)' };
    if (p.daysLeft != null) return { label: p.daysLeft + ' day' + (p.daysLeft === 1 ? '' : 's') + ' left', color: p.daysLeft <= 3 ? 'var(--amber, #e8842a)' : 'var(--green, #22c55e)' };
    return { label: '', color: 'var(--text-muted)' };
  }
  async function renderPunishmentPicker(q) {
    const hint = $('sup-hint');
    hint.innerHTML = '<span style="color:var(--text-muted);">Loading your record…</span>';
    const list = await loadMyPunishments();
    // Build a proper dropdown of the member's own punishments (case-based +
    // any legacy MET punishments), plus a final "it's not listed" option that
    // lets them type out what they want to appeal instead.
    const opts = (list || []).map((p, i) => {
      const when = p.issuedAt ? new Date(p.issuedAt).toLocaleDateString() : 'unknown date';
      const m = punMeta(p);
      const bits = [p.type, p.caseRef ? '· ' + p.caseRef : '', '· ' + when, m.label ? '· ' + m.label : ''].filter(Boolean).join(' ');
      return `<option value="${i}">${esc(bits)}</option>`;
    }).join('');
    const notListed = `<option value="__none">It's not listed here…</option>`;
    const empty = (!list || !list.length);
    hint.innerHTML = `
      <div style="margin-bottom:6px;color:var(--text-muted);">${empty
        ? "We couldn't find any punishments on your record. Pick “It's not listed here…” and tell us what you'd like to appeal."
        : "Choose the punishment you're appealing:"}</div>
      <select id="sup-pun-select" class="sup-select" onchange="supPunSelect(this.value)"
        style="width:100%;padding:9px 10px;border-radius:8px;background:var(--surface-2,#141922);color:var(--text-primary,#e8edf5);border:1px solid var(--border,#2a3140);font-size:13px;">
        <option value="" disabled selected>Select a punishment…</option>
        ${opts}
        ${notListed}
      </select>`;
    const sel = document.getElementById('sup-pun-select');
    // Deep-linked from a punishment DM → pre-select the matching punishment
    // (still changeable). Match on the punishment id or its case reference.
    // Only auto-fire on an explicit deep link — never proactively (the picker
    // must wait for the member to actually choose an option).
    if (pendingAppealId && list && list.length) {
      const want = String(pendingAppealId); pendingAppealId = null;
      const idx = list.findIndex(p => String(p.id) === want || (p.caseRef && String(p.caseRef) === want));
      if (idx >= 0) { sel.value = String(idx); window.supPunSelect(String(idx)); }
    }
  }
  window.supPunSelect = function (val) {
    if (val === '__none' || val === '') {
      // Not listed → let them describe it in their own words.
      selectedPunishment = null;
      $('sup-input').value = '';
      $('sup-input').placeholder = 'Describe the punishment you want to appeal…';
      appendBubble({ authorKind: 'BOT', authorName: BOT_NAME,
        body: "No problem — tell me in your own words what you'd like to appeal.",
        createdAt: new Date().toISOString() });
      scrollLog();
      $('sup-input').focus();
      return;
    }
    const p = (myPunishments || [])[Number(val)]; if (!p) return;
    const m = punMeta(p);
    const when = p.issuedAt ? new Date(p.issuedAt).toLocaleDateString() : 'unknown date';
    selectedPunishment = p;
    $('sup-input').value = `${p.type}${p.caseRef ? ' (' + p.caseRef + ')' : ''} — issued ${when}${m.label ? ' · ' + m.label : ''}`;
    if (p.expired) {
      // An expired punishment shouldn't still count — offer to connect them
      // straight to an Internal Affairs investigator to have it removed, rather
      // than making them argue a full appeal. They can still appeal normally.
      $('sup-log').insertAdjacentHTML('beforeend', `<div class="sup-msg bot"><div class="sup-av"><img src="${BOT_AVATAR}" alt="MET" /></div><div class="sup-body">
        <div class="sup-meta"><span class="sup-name">${BOT_NAME}</span></div>
        <div class="sup-text">Heads up — that punishment has <strong>already expired</strong>, so it shouldn't be counting against you anymore. I can connect you straight to an Internal Affairs investigator to have it removed from your record.</div>
        <div style="display:flex;gap:8px;margin-top:9px;flex-wrap:wrap;"><button class="btn btn-primary btn-sm" onclick="supAppealExpiredRemove(event)"><i class="ti ti-headset"></i> Connect me to an investigator</button></div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:7px;">Or keep going below to appeal it the normal way.</div>
      </div></div>`);
      scrollLog();
    }
    $('sup-input').focus();
  };
  // Expired punishment → fast-track straight to IA: skip the justification and
  // evidence steps and submit a removal request so an investigator can clear it.
  window.supAppealExpiredRemove = function (ev) {
    if (!selectedPunishment) return;
    try { if (ev && ev.currentTarget) { ev.currentTarget.disabled = true; ev.currentTarget.classList.add('sup-btn-chosen'); } } catch (e) { /* non-fatal */ }
    const p = selectedPunishment;
    const when = p.issuedAt ? new Date(p.issuedAt).toLocaleDateString() : 'unknown date';
    const actionQ = intakeQs.find(x => x.kind === 'punishment') || intakeQs[0];
    intakeAnswers = [];
    if (actionQ) intakeAnswers.push({ id: actionQ.id, prompt: actionQ.prompt, answer: `${p.type}${p.caseRef ? ' (' + p.caseRef + ')' : ''} — issued ${when} · expired`, attachments: [], identity: null });
    intakeAnswers.push({ id: 'why', prompt: 'Why would you like to appeal this punishment?', answer: 'This punishment has already expired — requesting that an Internal Affairs investigator remove it from my record.', attachments: [], identity: null });
    intakeQs = [];
    appendBubble({ authorKind: 'OPENER', authorName: (CFG.me && CFG.me.name) || 'You', authorAvatar: MY_AVATAR, body: 'Please connect me to an investigator to remove this expired punishment.', createdAt: new Date().toISOString() });
    appendBotTyping('Connecting you to an Internal Affairs investigator to have it removed…', function () { finishIntake(); });
  };
  // Back-compat: older deep links / callers may still call supPickPunishment.
  window.supPickPunishment = function (i) { window.supPunSelect(String(i)); };

  function recordAnswer(q, answer, attachments, identity) {
    intakeAnswers.push({ id: q.id, prompt: q.prompt, answer, attachments, identity: identity || null });
    // The echoed bubble needs viewable URLs for its attachments.
    const display = (attachments || []).map(a => ({ ...a, url: `/api/support/tickets/${cur.id}/media/${a.mediaId}` }));
    appendBubble({ authorKind: 'OPENER', authorName: (CFG.me && CFG.me.name) || "You", authorAvatar: MY_AVATAR, body: answer, attachments: display, identity: identity || null, createdAt: new Date().toISOString() });
  }
  function submitIntakeStep() {
    const q = intakeQs[0];
    if (!q) return; // last answer is still finishing (async) — ignore stray Enter
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

  // ── Clickable profile cards ──────────────────────────────────────
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
    if (!authorId) { body.innerHTML = window.metEmpty ? window.metEmpty({ icon: 'ti-user-off', title: 'No profile available' }) : '<div class="table-empty"><div class="table-empty-text">No profile available.</div></div>'; return; }
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
      // For appeals, send the structured punishment the opener picked so IA
      // get a proper card (Roblox/Discord/case) — never shown to the opener.
      const appeal = selectedPunishment ? {
        id: selectedPunishment.id, type: selectedPunishment.type, caseRef: selectedPunishment.caseRef || null,
        source: selectedPunishment.source || null, reason: selectedPunishment.reason || null,
        issuedAt: selectedPunishment.issuedAt || null, expiresAt: selectedPunishment.expiresAt || null,
      } : null;
      const r = await api(tok('/api/support/tickets/' + cur.id + '/submit-intake', cur.id), { method: 'POST', body: JSON.stringify({ answers: intakeAnswers, appeal }) });
      cur = r.ticket; mode = 'chat';
      const full = await api(tok('/api/support/tickets/' + cur.id, cur.id));
      cur = full; renderTicketHeader(full); renderLog(full);
      setComposerEnabled(full); openStream(full.id);
      showToast('Ticket submitted', 'success');
    } catch (e) { showToast(e.message, 'error'); }
  }

  function appendBubble(m) { $('sup-log').insertAdjacentHTML('beforeend', renderMsg(m)); scrollLog(); enrichLogMentions(); if (!_supPinned) showJumpPill(); }
  // Replace a rendered message bubble in place (used by the 'edit' SSE event).
  function applyEdit(m) {
    if (!m || !m.id) return;
    const el = document.querySelector(`[data-mid="${(m.id || '').replace(/"/g, '')}"]`);
    if (!el) return;
    const wrap = document.createElement('div'); wrap.innerHTML = renderMsg(m);
    const fresh = wrap.firstElementChild;
    if (fresh) { el.replaceWith(fresh); enrichLogMentions(); }
  }
  // Edit your own message: prefill the composer-style prompt inline.
  window.supEditMsg = async function (mid) {
    const el = document.querySelector(`[data-mid="${(mid || '').replace(/"/g, '')}"] .sup-text`);
    const current = el ? el.textContent : '';
    const next = window.prompt('Edit your message:', current);
    if (next == null) return;
    const body = next.trim(); if (!body) return;
    try {
      const m = await api(tok('/api/support/tickets/' + cur.id + '/messages/' + mid, cur.id), { method: 'PATCH', body: JSON.stringify({ body }) });
      applyEdit(m);
    } catch (e) { showToast(e.message, 'error'); }
  };
  // Delete your own message.
  window.supDeleteMsg = async function (mid) {
    if (!window.confirm('Delete this message?')) return;
    try {
      await api(tok('/api/support/tickets/' + cur.id + '/messages/' + mid, cur.id), { method: 'DELETE' });
      const el = document.querySelector(`[data-mid="${(mid || '').replace(/"/g, '')}"]`); if (el) el.remove();
    } catch (e) { showToast(e.message, 'error'); }
  };
  // Resolve <@id> mentions in the log into MET nicknames + a profile card.
  function enrichLogMentions() {
    if (!window.enrichMentions || !cur) return;
    const root = $('sup-log'); if (!root) return;
    window.enrichMentions(root, {
      resolve: async (ids) => {
        try { const r = await api(tok('/api/support/tickets/' + cur.id + '/mention', cur.id), { method: 'POST', body: JSON.stringify({ ids }) }); return r.mentions || {}; }
        catch (e) { return {}; }
      },
    });
  }
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
    ['sup-send-btn', 'sup-attach-btn'].forEach(idv => { const el = $(idv); if (el) el.disabled = b; });
    // sup-input is a contenteditable div (rich composer) — toggle editability.
    const inp = $('sup-input');
    if (inp) { if (inp.getAttribute('contenteditable') != null) inp.setAttribute('contenteditable', b ? 'false' : 'true'); else inp.disabled = b; }
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
  // Server-provided FAQ entries (sanitized) — { key, label, body }.
  const kbEntry = k => (CFG.knowledge || []).find(e => e.key === k);
  function helpTopics() {
    const opts = [['join', 'How do I join the MET?'], ['tryout', 'When is the next tryout?'], ['reqs', 'What are the requirements?']];
    (CFG.knowledge || []).forEach(k => opts.push(['kb:' + k.key, k.label]));
    opts.push(['human', 'Talk to an investigator']);
    $('sup-log').insertAdjacentHTML('beforeend',
      `<div style="display:flex;flex-wrap:wrap;gap:8px;margin:4px 0 4px 44px;">` +
      opts.map(([k, l]) => `<button class="btn btn-ghost btn-sm" onclick="supHelp('${k}')">${esc(l)}</button>`).join('') + `</div>`);
    scrollLog();
  }
  window.supHelp = function (topic) {
    const labels = { join: 'How do I join the MET?', tryout: 'When is the next tryout?', reqs: 'What are the requirements?', human: 'Talk to an investigator' };
    let echo = labels[topic] || topic, kbBody = null;
    if (topic.indexOf('kb:') === 0) { const e = kbEntry(topic.slice(3)); echo = e ? e.label : topic; kbBody = e ? e.body : null; }
    appendBubble({ authorKind: 'OPENER', authorName: (CFG.me && CFG.me.name) || 'You', authorAvatar: MY_AVATAR, body: echo, createdAt: new Date().toISOString() });
    if (topic === 'human') return helpHandoff(lastHelpText);
    if (topic === 'join') return appendBotTyping(KB_JOIN, helpFollowup);
    if (topic === 'reqs') return appendBotTyping(KB_REQS, helpFollowup);
    if (topic === 'tryout') return helpTryouts();
    if (kbBody) return appendBotTyping(kbBody, helpFollowup);
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
    if (/appeal|strike|blacklist|terminat|demot|exile|punish|discipline|suspend|warning/.test(t)) { const e = kbEntry('appeals'); if (e) return appendBotTyping(e.body, helpFollowup); }
    appendBotTyping("I'm not sure I can answer that one. Want me to connect you to an Internal Affairs investigator?", () => {
      $('sup-log').insertAdjacentHTML('beforeend',
        `<div style="display:flex;gap:8px;margin:4px 0 4px 44px;">
          <button class="btn btn-primary btn-sm" onclick="supHelp('human')"><i class="ti ti-user"></i> Yes, connect me</button>
          <button class="btn btn-ghost btn-sm" onclick="supHelpTopics()">No, other questions</button></div>`);
      scrollLog();
    });
  }
  let _handoffTicket = null, _handoffBusy = false;
  async function helpHandoff(freeText) {
    if (_handoffBusy) return;
    _handoffBusy = true;
    appendBotTyping('Connecting you to an Internal Affairs investigator…', async () => {
      try {
        // Reuse an already-created handoff ticket on retry instead of spawning a
        // new orphan INTAKE ticket each time the escalation is clicked.
        if (!_handoffTicket) {
          const r = await api('/api/support/tickets', { method: 'POST', body: JSON.stringify({ type: 'GENERAL_SUPPORT' }) });
          if (r.token) remember(r.ticket.id, r.token);
          _handoffTicket = r.ticket;
        }
        cur = _handoffTicket; helpMode = false; mode = 'chat';
        const question = (freeText || '').trim() || 'Requested to speak with an investigator.';
        await api(tok('/api/support/tickets/' + cur.id + '/submit-intake', cur.id), { method: 'POST', body: JSON.stringify({ answers: [{ id: 'issue', answer: question }] }) });
        const full = await api(tok('/api/support/tickets/' + cur.id, cur.id));
        cur = full; _handoffTicket = null; renderTicketHeader(full); renderLog(full); setComposerEnabled(full); openStream(full.id);
      } catch (e) {
        // Don't strand the user pointing at an invisible INTAKE ticket — drop back
        // to help mode; the created ticket (if any) is reused on the next attempt.
        showToast(e.message, 'error'); helpMode = true; cur = null;
      } finally { _handoffBusy = false; }
    });
  }

  // ── System transition panels (transfer to IA, claimed, closed) ───────
  function sysPanelHtml(logo, icon, title, sub) {
    const media = logo ? `<img src="${logo}" style="width:34px;height:34px;border-radius:8px;object-fit:cover;" alt="">` : `<i class="ti ${icon}" style="font-size:22px;color:var(--blue);"></i>`;
    return `<div class="sup-sys">${media}<div><div style="font-weight:700;font-size:13px;">${esc(title)}</div>${sub ? `<div style="font-size:11px;color:var(--text-muted);">${esc(sub)}</div>` : ''}</div></div>`;
  }
  // The investigator (claimant) card — little Discord + Roblox avatar profiles,
  // name, IA rank and handles. Rendered inside the "Claimed" card so the opener
  // (and staff) can see exactly who is dealing with their ticket.
  function claimantRowHtml(c) {
    if (!c) return '';
    const dAv = c.discordAvatar
      ? `<img src="${esc(c.discordAvatar)}" alt="Discord" title="Discord avatar" style="width:34px;height:34px;border-radius:50%;object-fit:cover;border:2px solid #5865F2;background:#0b0f18;">`
      : '';
    const rInner = c.headshotUrl
      ? `<img src="${esc(c.headshotUrl)}" alt="Roblox" title="Roblox avatar" style="width:34px;height:34px;border-radius:50%;object-fit:cover;border:2px solid #e2231a;background:#0b0f18;${dAv ? 'margin-left:-10px;' : ''}">`
      : '';
    const rAv = rInner && c.robloxUrl
      ? `<a href="${esc(c.robloxUrl)}" target="_blank" rel="noopener" style="display:inline-flex;">${rInner}</a>`
      : rInner;
    const rank = c.rankName ? `<span style="font-size:11px;color:var(--blue);font-weight:600;margin-left:6px;">${esc(c.rankName)}</span>` : '';
    const handles = [
      c.robloxUsername ? `Roblox @${esc(c.robloxUsername)}` : '',
      c.discordUsername ? `Discord @${esc(c.discordUsername)}` : '',
    ].filter(Boolean).join(' · ');
    return `<div style="display:flex;align-items:center;gap:10px;margin-top:8px;">
      <div style="display:flex;align-items:center;">${dAv}${rAv}</div>
      <div style="min-width:0;">
        <div style="font-weight:700;font-size:13px;">${esc(c.name || 'Investigator')}${rank}</div>
        ${handles ? `<div style="font-size:11px;color:var(--text-muted);">${handles}</div>` : ''}
      </div>
    </div>`;
  }
  function claimedPanelHtml(sub) {
    const c = cur && cur.claimant;
    return `<div class="sup-sys" style="align-items:flex-start;max-width:520px;">
      <img src="/img/divisions/ia.png" style="width:34px;height:34px;border-radius:8px;object-fit:cover;" alt="">
      <div style="flex:1;min-width:0;">
        <div style="font-weight:700;font-size:13px;">Claimed by Internal Affairs</div>
        ${c ? claimantRowHtml(c) : (sub ? `<div style="font-size:11px;color:var(--text-muted);">${esc(sub)}</div>` : '')}
      </div>
    </div>`;
  }
  function transitionPanel(m) {
    if ((m.authorKind || '').toLowerCase() !== 'bot') return null;
    const b = m.body || '';
    if (/will be with you shortly/i.test(b)) return sysPanelHtml('/img/divisions/ia.png', null, 'Transferred to Internal Affairs', b);
    if (/claimed this ticket/i.test(b))       return claimedPanelHtml(b);
    if (/released this ticket/i.test(b))       return sysPanelHtml(null, 'ti-arrow-back-up', 'Back in the queue', b);
    if (/was closed/i.test(b))                 return sysPanelHtml(null, 'ti-lock', 'Ticket closed', b);
    return null;
  }

  // ── Composer ──────────────────────────────────────────────────
  function wireComposer() {
    $('sup-attach-btn').addEventListener('click', () => $('sup-file').click());
    $('sup-file').addEventListener('change', onPickFiles);
    $('sup-send-btn').addEventListener('click', onSend);
    $('sup-input').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); }
    });
    // Rich (WYSIWYG) composer — formatting renders live inside the box as you type,
    // with @-autocomplete of MET members.
    if (window.initRichComposer) window.initRichComposer($('sup-input'), {
      mentionSearch: async (q) => { if (!q) return []; try { const r = await api('/api/support/mention-search?q=' + encodeURIComponent(q)); return r.users || []; } catch (e) { return []; } },
    });
    $('sup-input').addEventListener('input', () => { sendTyping(); saveDraft(); });
  }

  // ── Per-ticket composer draft persistence ────────────────────────────
  // A reply typed on one ticket survives a reload / navigating away and back.
  function draftKey(id) { return 'supDraft:' + id; }
  function saveDraft() {
    try {
      if (!cur || !cur.id || mode !== 'chat') return;
      const v = $('sup-input').value;
      if (v && v.trim()) localStorage.setItem(draftKey(cur.id), v); else localStorage.removeItem(draftKey(cur.id));
    } catch (e) {}
  }
  function restoreDraft(id) { try { const v = localStorage.getItem(draftKey(id)); if (v != null && $('sup-input')) $('sup-input').value = v; } catch (e) {} }
  function clearDraft(id) { try { localStorage.removeItem(draftKey(id)); } catch (e) {} }

  // ── Typing indicator ─────────────────────────────────────────────
  let _lastTypingPing = 0;
  function sendTyping() {
    if (!cur || !cur.id || mode === 'intake') return;
    const now = Date.now();
    if (now - _lastTypingPing < 2000) return;   // throttle to ~every 2s
    _lastTypingPing = now;
    try { fetch(tok('/api/support/tickets/' + cur.id + '/typing', cur.id), { method: 'POST', credentials: 'same-origin' }).catch(() => {}); } catch (e) {}
  }
  const _typers = {};   // name -> timeout id
  function onTyping(d) {
    if (!d || !d.name || d.who === 'OPENER') return;   // opener only shows STAFF typing
    if (_typers[d.name]) clearTimeout(_typers[d.name]);
    _typers[d.name] = setTimeout(() => { delete _typers[d.name]; renderTypers(); }, 4500);
    renderTypers();
  }
  function renderTypers() {
    let el = document.getElementById('sup-typing');
    const names = Object.keys(_typers);
    if (!names.length) { if (el) { el.style.display = 'none'; el.innerHTML = ''; } return; }
    if (!el) {
      const composer = $('sup-composer'); if (!composer || !composer.parentNode) return;
      el = document.createElement('div'); el.id = 'sup-typing'; el.className = 'sup-typing';
      composer.parentNode.insertBefore(el, composer);
    }
    el.style.display = '';
    const label = names.length === 1 ? `${names[0]} is typing` : `${names.slice(0, 2).join(', ')}${names.length > 2 ? ' and others' : ''} are typing`;
    el.innerHTML = `<span class="sup-typing-dots"><span></span><span></span><span></span></span> ${esc(label)}…`;
  }
  function clearTypers() { Object.keys(_typers).forEach(k => clearTimeout(_typers[k])); Object.keys(_typers).forEach(k => delete _typers[k]); renderTypers(); }
  function setComposerEnabled(t) {
    const canOpener = t.isMine && t.status !== 'CLOSED';
    const canStaff = t.canManage && t.status !== 'CLOSED';
    let on = mode === 'intake' ? (t.isMine && t.status === 'INTAKE') : (canOpener || canStaff);
    // A ticket-blacklisted opener is locked out of their own ticket entirely
    // (staff who can manage are never locked).
    const locked = !!t.locked && !t.canManage;
    if (locked) on = false;
    $('sup-composer').style.display = on ? '' : 'none';
    showLockNotice(locked);
  }
  // A banner shown where the composer would be when the opener has been
  // ticket-blacklisted — makes the block obvious and immediate.
  function showLockNotice(locked) {
    let el = document.getElementById('sup-lock-notice');
    if (!locked) { if (el) el.remove(); return; }
    if (el) return;
    const composer = $('sup-composer');
    if (!composer || !composer.parentNode) return;
    el = document.createElement('div');
    el.id = 'sup-lock-notice';
    el.style.cssText = 'display:flex;align-items:center;gap:9px;padding:13px 15px;border-top:1px solid var(--border,#2a3040);background:var(--surface-1,#0e1420);color:var(--text-muted,#8b93a1);font-size:13px;';
    el.innerHTML = '<i class="ti ti-ban" style="color:var(--red,#e2231a);font-size:19px;flex:0 0 auto;"></i> You have been blocked from support by Internal Affairs — you can no longer send messages here or open new tickets.';
    composer.parentNode.insertBefore(el, composer.nextSibling);
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

  // ── Reply-to (Discord-style) ─────────────────────────────────────
  window.supReply = function (mid) {
    const el = document.querySelector(`[data-mid="${(mid || '').replace(/"/g, '')}"]`);
    if (!el) return;
    const who = (el.querySelector('.sup-name') || {}).textContent || 'message';
    const bodyEl = el.querySelector('.sup-text');
    const snippet = bodyEl ? bodyEl.textContent.replace(/\s+/g, ' ').trim().slice(0, 120) : '📎 Attachment';
    replyTo = { id: mid, authorName: who, snippet };
    renderReplyBar();
    const inp = $('sup-input'); if (inp) inp.focus();
  };
  window.supCancelReply = function () { replyTo = null; renderReplyBar(); };
  function renderReplyBar() {
    let bar = document.getElementById('sup-replybar');
    if (!replyTo) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'sup-replybar'; bar.className = 'sup-replybar';
      const pend = document.getElementById('sup-pending');
      if (pend && pend.parentNode) pend.parentNode.insertBefore(bar, pend);
      else $('sup-composer').insertBefore(bar, $('sup-composer').firstChild);
    }
    bar.innerHTML = `<i class="ti ti-arrow-back-up"></i><span class="sup-replybar-who">Replying to ${esc(replyTo.authorName)}</span>
      <span class="sup-replybar-snip">${esc(replyTo.snippet || '')}</span>
      <button class="sup-replybar-x" title="Cancel reply" onclick="supCancelReply()"><i class="ti ti-x"></i></button>`;
  }

  let _supSending = false;
  async function onSend() {
    if (mode === 'intake') return submitIntakeStep();
    if (helpMode) { const text = $('sup-input').value.trim(); if (!text) return; $('sup-input').value = ''; return helpFreeText(text); }
    if (_supSending) return;                    // guard against double-send (double Enter / click)
    if (!cur) return;
    if (anyUploading()) return showToast('Please wait for uploads to finish.', 'warning');
    const body = $('sup-input').value.trim();
    const atts = readyAttachments();
    if (!body && !atts.length) return;
    const replyToId = replyTo ? replyTo.id : null;
    const tid = cur.id;
    _supSending = true;
    const sendBtn = $('sup-send-btn'); if (sendBtn) sendBtn.disabled = true;
    try {
      const msg = await api(tok('/api/support/tickets/' + tid + '/messages', tid), { method: 'POST', body: JSON.stringify({ body, attachments: atts, replyToId }) });
      // SSE will echo it to everyone (incl. us); append now and let SSE dedupe by id.
      if (cur && cur.id === tid && !document.querySelector(`[data-mid="${msg.id}"]`)) { _supPinned = true; appendBubble(msg); } // own send → jump to bottom
      $('sup-input').value = ''; clearDraft(tid); clearPending(); replyTo = null; renderReplyBar();
      supSound('sent');
    } catch (e) {
      showToast(e.message, 'error');
      supSound('error');
      // If the send was refused because we've just been blocked, re-sync so the
      // composer locks itself immediately.
      if (/block|blacklist/i.test(e.message || '')) refreshTicket(cur.id);
    }
    finally { _supSending = false; const sb = $('sup-send-btn'); if (sb) sb.disabled = false; }
  }

  // A soft, quiet blip when a message arrives (distinct from the loud new-ticket
  // alert). Needs a prior user gesture to sound (browser autoplay rule) — the
  // opener is interacting with the ticket, so it's unlocked.
  // Incoming-message blip now goes through the shared sound engine (metSound),
  // so it stays consistent with the rest of the site and honours the mute/snooze.
  function msgBlip() { if (window.metSound) window.metSound('incoming'); }
  function supSound(name) { if (window.metSound) window.metSound(name); }

  // ── Realtime (SSE + polling fallback) ───────────────────────────────────
  let pollTimer = null;
  function openStream(ticketId) {
    closeStream();
    _supPinned = true;   // fresh ticket view starts pinned to the newest message
    try {
      es = new EventSource(tok('/api/support/tickets/' + ticketId + '/stream', ticketId));
      es.addEventListener('message', ev => {
        try {
          const m = JSON.parse(ev.data);
          if (!m || !m.id || document.querySelector(`[data-mid="${m.id}"]`)) return;
          // Only the ticket opener or its claimant hears the chime — not other
          // staff who merely have access to view/type (HICOMM, supervisor, …).
          if (cur && (cur.isMine || (CFG.me && cur.claimedById && cur.claimedById === CFG.me.id))) msgBlip();
          // System/transition bot messages (claimed, transferred, released, closed)
          // must render as their panel card — NOT a plain typing bubble — so the
          // investigator card etc. show. Only conversational bot lines type out.
          if ((m.authorKind || '').toLowerCase() === 'bot' && !transitionPanel(m)) appendBotTyping(m.body, null, m.id);
          else appendBubble(m);
          if ((m.authorKind || '').toLowerCase() === 'staff') clearTypers(); // they sent → stop "typing…"
        } catch (e) {}
      });
      es.addEventListener('update', ev => {
        // Grab the claimant card synchronously (before the 'claimed' message event
        // is processed) so the panel renders with the investigator's avatars.
        try { const d = JSON.parse(ev.data || '{}'); if (d && d.claimant && cur) cur.claimant = d.claimant; if (d && d.status === 'CLOSED') supSound('closed'); } catch (e) {}
        refreshTicket(ticketId);
      });
      // A message removed server-side (e.g. a claim-race message auto-deleted).
      es.addEventListener('delete', ev => {
        try { const d = JSON.parse(ev.data); if (d && d.id) { const el = document.querySelector(`[data-mid="${d.id}"]`); if (el) el.remove(); } } catch (e) {}
      });
      // A message edited by its author — swap the bubble in place.
      es.addEventListener('edit', ev => { try { applyEdit(JSON.parse(ev.data)); } catch (e) {} });
      es.addEventListener('typing', ev => { try { onTyping(JSON.parse(ev.data)); } catch (e) {} });
      es.onerror = () => { /* browser auto-reconnects */ };
    } catch (e) { /* SSE unsupported → the poll below still updates the chat */ }
    // Polling fallback — guarantees the opener's chat updates even if a proxy
    // buffers SSE. De-duped by message id, so it never doubles up with SSE.
    pollTimer = setInterval(() => refreshTicket(ticketId), 5000);
  }
  function closeStream() {
    if (es) { es.close(); es = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    clearTypers(); // don't let a "typing…" indicator from the old ticket linger
  }
  // Pull the ticket and append any messages we don't already show; sync status.
  async function refreshTicket(ticketId) {
    if (!cur || cur.id !== ticketId) return;
    let t;
    try { t = await api(tok('/api/support/tickets/' + ticketId, ticketId)); } catch (e) { return; }
    // Make the investigator card available before the "Claimed" bubble renders.
    if (t.claimant) cur.claimant = t.claimant;
    (t.messages || []).forEach(m => {
      if (m.id && !document.querySelector(`[data-mid="${m.id}"]`)) appendBubble(m);
    });
    if (t.status !== cur.status || (t.claimedByName || '') !== (cur.claimedByName || '') || !!t.locked !== !!cur.locked) {
      cur = t; renderTicketHeader(t); setComposerEnabled(t);
    }
  }

  // ── Staff actions ─────────────────────────────────────────────
  window.supClaim = async function () {
    try { const r = await api('/api/support/tickets/' + cur.id + '/claim', { method: 'POST' }); cur = r.ticket; renderTicketHeader(r.ticket); setComposerEnabled(r.ticket); showToast('Claimed', 'success'); }
    catch (e) { showToast(e.message, 'error'); }
  };
  window.supClose = async function () {
    // uiPrompt resolves null on Cancel / Escape / backdrop — a hard abort that
    // must NOT close the ticket. `null || ''` would swallow that, so guard first.
    const reason = await uiPrompt('Closing note (optional):', { title: 'Close ticket', confirmText: 'Close ticket', placeholder: 'Optional note for the record' });
    if (reason === null) return;
    try { const r = await api('/api/support/tickets/' + cur.id + '/close', { method: 'POST', body: JSON.stringify({ reason: reason || '' }) }); cur = r.ticket; renderTicketHeader(r.ticket); setComposerEnabled(r.ticket); showToast('Ticket closed', 'success'); }
    catch (e) { showToast(e.message, 'error'); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
