/* Support Desk — IA staff-side handling of /support tickets, embedded in the IA
   dashboard. Queue + a full ticket workspace: claim/release/reassign/close,
   priority, escalate-to-HICOMM, internal (staff-only) notes, quick replies,
   live chat with attachments, and opener profiles. HICOMM get extra powers. */
(function () {
  const esc = window.escapeHtml || (s => String(s == null ? '' : s));
  const MET = '/img/divisions/met.png';
  let SDC = null;                 // /config
  let sdFilter = 'active', sdType = '';
  let curT = null;               // current open ticket
  let sdPending = [];            // composer attachments
  let sdES = null;              // EventSource
  let sdSeq = 0;

  const $ = id => document.getElementById(id);
  // Quick replies — default set; replaced by the staffer's saved list on load.
  let CANNED = [
    'Thanks for reaching out — an investigator is reviewing your report now.',
    'Could you provide any evidence (screenshots or clips) to support this?',
    'Can you confirm the date/time and which server this happened on?',
    'We\'ve reviewed your case. After investigation, no further action will be taken at this time.',
    'This has been escalated to Internal Affairs High Command for review.',
    'Your appeal has been reviewed — after consideration, the original decision stands.',
    'Your appeal has been upheld and the action has been reversed. Apologies for the inconvenience.',
  ];
  const PRIO = { URGENT: ['#e0503a', 'Urgent Priority'], HIGH: ['#e8842a', 'High Priority'], NORMAL: ['#6b7280', 'Normal Priority'], LOW: ['#4b5563', 'Low Priority'] };

  function age(d) {
    const s = Math.max(0, (Date.now() - new Date(d).getTime()) / 1000);
    if (s < 3600) return Math.round(s / 60) + 'm';
    if (s < 86400) return Math.round(s / 3600) + 'h';
    return Math.round(s / 86400) + 'd';
  }
  function priorityBadge(p) {
    const [c, label] = PRIO[p] || PRIO.NORMAL;
    return `<span class="badge" style="background:${c};color:#fff;"><span class="badge-dot"></span>${label}</span>`;
  }
  function statusBadge(s) {
    const map = { INTAKE: ['badge-pending', 'Intake'], OPEN: ['badge-pending', 'Unclaimed'], CLAIMED: ['badge-approved', 'Claimed'], CLOSED: ['badge-denied', 'Closed'] };
    const [cls, label] = map[s] || ['badge-pending', s];
    return `<span class="badge ${cls}"><span class="badge-dot"></span>${label}</span>`;
  }

  // ── Queue ───────────────────────────────────────────────────────────
  window.loadSupportTickets = async function () {
    if (!SDC) {
      try { SDC = await api('/api/support/config'); } catch (e) { SDC = { handleableTypes: [], isHicomm: false, priorities: ['LOW', 'NORMAL', 'HIGH', 'URGENT'], me: {} }; }
      // Seed quick replies from the staffer's saved settings (falls back to defaults).
      if (SDC.me && Array.isArray(SDC.me.quickReplies) && SDC.me.quickReplies.length) CANNED = SDC.me.quickReplies.slice();
      // type filter options
      const sel = $('sd-type-filter');
      if (sel && sel.options.length <= 1) {
        (SDC.types || []).filter(t => (SDC.handleableTypes || []).includes(t.key)).forEach(t => {
          const o = document.createElement('option'); o.value = t.key; o.textContent = t.label; sel.appendChild(o);
        });
        sel.addEventListener('change', () => { sdType = sel.value; refreshQueue(); });
      }
      document.querySelectorAll('#sd-filter-tabs .filter-tab').forEach(tab => tab.addEventListener('click', () => {
        document.querySelectorAll('#sd-filter-tabs .filter-tab').forEach(t => t.classList.toggle('active', t === tab));
        sdFilter = tab.dataset.sdfilter; refreshQueue();
      }));
      wireComposer();
    }
    refreshQueue();
  };

  async function refreshQueue() {
    const tb = $('sd-tbody');
    if (!tb) return;
    tb.innerHTML = '<tr><td colspan="7" class="table-loading"><div class="spinner"></div></td></tr>';
    const q = new URLSearchParams();
    if (sdFilter === 'CLOSED') q.set('status', 'CLOSED');
    else if (sdFilter === 'unclaimed') q.set('unclaimed', '1');
    else if (sdFilter === 'mine') q.set('mine', '1');
    else if (sdFilter === 'escalated') q.set('escalated', '1');
    if (sdType) q.set('type', sdType);
    try {
      const rows = await api('/api/support/tickets/queue?' + q.toString());
      if (!rows.length) { tb.innerHTML = '<tr><td colspan="7" class="table-empty"><div class="table-empty-text">No tickets here.</div></td></tr>'; }
      else tb.innerHTML = rows.map(rowHtml).join('');
      // Nav badge: count of unclaimed active tickets.
      const badge = document.getElementById('nav-badge-support');
      if (badge) {
        const openCount = rows.filter(r => r.status === 'OPEN').length;
        badge.style.display = openCount ? 'inline-flex' : 'none'; badge.textContent = openCount;
      }
    } catch (e) { tb.innerHTML = `<tr><td colspan="7" class="table-empty"><div class="table-empty-text">${esc(e.message)}</div></td></tr>`; }
  }

  function rowHtml(t) {
    const esc2 = esc;
    const flag = t.escalated ? '<i class="ti ti-flag-filled" style="color:var(--red);margin-left:4px;" title="Escalated"></i>' : '';
    return `<tr style="cursor:pointer;" onclick="sdOpen('${t.id}')">
      <td>${priorityBadge(t.priority)}</td>
      <td>${esc2(t.typeLabel)}${flag}</td>
      <td><span style="cursor:pointer;text-decoration:underline dotted;" onclick="event.stopPropagation();sdProfile('${t.openerId}','${esc2(t.openerName)}')">${esc2(t.openerName)}</span></td>
      <td>${statusBadge(t.status)}</td>
      <td>${t.claimedByName ? esc2(t.claimedByName) : '<span style="color:var(--text-muted);">—</span>'}</td>
      <td>${age(t.createdAt)}</td>
      <td style="text-align:right;"><button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();sdOpen('${t.id}')"><i class="ti ti-arrow-right"></i> Open</button></td>
    </tr>`;
  }

  // ── Ticket workspace ────────────────────────────────────────────────
  window.sdOpen = async function (id) {
    openModal('modal-sd-ticket');
    $('sd-log').innerHTML = '<div class="table-loading"><div class="spinner"></div></div>';
    $('sd-toolbar').innerHTML = ''; sdPending = []; renderPending();
    try {
      const t = await api('/api/support/tickets/' + id);
      curT = t; renderWorkspace(t); openStream(id);
    } catch (e) { $('sd-log').innerHTML = `<div class="table-empty"><div class="table-empty-text">${esc(e.message)}</div></div>`; }
  };

  // IA-only card for a Disciplinary Appeal: the opener's Roblox + Discord
  // identity, the punishment being appealed, and jump-to buttons. The server
  // only sends `t.appeal` to handlers, so the opener never sees this.
  function appealCardHtml(a) {
    if (!a) return '';
    const p = a.punishment || {}, o = a.opener || {};
    const pfp = o.headshotUrl
      ? `<img src="${esc(o.headshotUrl)}" alt="" style="width:56px;height:56px;border-radius:12px;object-fit:cover;background:#111;flex-shrink:0;">`
      : `<div style="width:56px;height:56px;border-radius:12px;background:#1a1f2b;display:flex;align-items:center;justify-content:center;color:#8b93a1;flex-shrink:0;"><i class="ti ti-user"></i></div>`;
    const rows = [];
    if (o.robloxUsername || o.robloxId) rows.push(`<div><span style="color:var(--text-muted);">Roblox:</span> ${esc(o.robloxUsername || '—')}${o.robloxId ? ` <span style="color:var(--text-muted);">(${esc(o.robloxId)})</span>` : ''}</div>`);
    if (o.discordUsername || o.discordId) rows.push(`<div><span style="color:var(--text-muted);">Discord:</span> ${esc(o.discordUsername || '—')}${o.discordId ? ` <span style="color:var(--text-muted);">(${esc(o.discordId)})</span>` : ''}</div>`);
    const punLine = `<div style="margin-top:6px;"><span style="color:var(--text-muted);">Appealing:</span> <strong>${esc(p.type || 'Punishment')}</strong>${p.caseRef ? ` <span style="color:var(--text-muted);font-size:11px;">${esc(p.caseRef)}</span>` : ''}</div>`;
    const reason = p.reason ? `<div style="margin-top:4px;color:var(--text-secondary);font-size:12px;">${esc(p.reason)}</div>` : '';
    const btns = [];
    if (o.robloxUrl)  btns.push(`<a href="${esc(o.robloxUrl)}" target="_blank" rel="noopener" class="btn btn-ghost btn-sm"><i class="ti ti-brand-roblox"></i> Roblox profile</a>`);
    if (a.caseUrl)    btns.push(`<a href="${esc(a.caseUrl)}" class="btn btn-ghost btn-sm"><i class="ti ti-folder-open"></i> Open case</a>`);
    if (o.discordId)  btns.push(`<button class="btn btn-ghost btn-sm" onclick="sdProfile('${esc(o.discordId)}','${esc(o.robloxUsername || o.discordUsername || '')}')"><i class="ti ti-user-circle"></i> Full profile</button>`);
    return `<div class="glass" style="border:1px solid var(--amber,#e8842a)33;border-radius:12px;padding:12px 14px;margin-bottom:12px;">
      <div style="display:flex;align-items:center;gap:8px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--amber,#e8842a);margin-bottom:10px;"><i class="ti ti-shield-lock"></i> IA · appeal details — not visible to the opener</div>
      <div style="display:flex;gap:12px;">
        ${pfp}
        <div style="flex:1;min-width:0;font-size:13px;line-height:1.6;">${rows.join('')}${punLine}${reason}</div>
      </div>
      ${btns.length ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">${btns.join('')}</div>` : ''}
    </div>`;
  }

  function renderWorkspace(t) {
    $('sd-title').textContent = `${t.typeLabel} · ${t.openerName}`;
    renderToolbar(t);
    renderLog(t);
    // Prepend the IA-only appeal card above the conversation (staff-only data).
    if (t.appeal) { const log = $('sd-log'); if (log) log.insertAdjacentHTML('afterbegin', appealCardHtml(t.appeal)); }
    const composer = $('sd-composer');
    if (composer) composer.style.display = (t.caps && (t.caps.canReply || t.caps.canInternalNote)) ? '' : 'none';
  }

  function renderToolbar(t) {
    const c = t.caps || {};
    const b = [];
    b.push(`${priorityBadge(t.priority)} ${statusBadge(t.status)}${t.escalated ? ' <span class="badge badge-denied"><span class="badge-dot"></span>Escalated</span>' : ''}`);
    // Claim → for the claimant (or HICOMM) it becomes "Unclaim"; for everyone
    // else, once claimed, it's greyed out and disabled.
    if (t.status === 'CLAIMED') {
      if (c.canRelease) b.push(`<button class="btn btn-ghost btn-sm" onclick="sdAct('release')"><i class="ti ti-hand-off"></i> Unclaim</button>`);
      else b.push(`<button class="btn btn-sm" disabled style="opacity:.45;cursor:not-allowed;" title="Claimed by ${esc(t.claimedByName || '')}"><i class="ti ti-hand-stop"></i> Claimed</button>`);
    } else if (c.canClaim) {
      b.push(`<button class="btn btn-primary btn-sm" onclick="sdAct('claim')"><i class="ti ti-hand-stop"></i> Claim</button>`);
    }
    if (c.canPriority) {
      const opts = (SDC.priorities || ['LOW', 'NORMAL', 'HIGH', 'URGENT']).map(p => `<option value="${p}"${p === t.priority ? ' selected' : ''}>${(PRIO[p] || [, p])[1]}</option>`).join('');
      b.push(`<select class="form-control" style="width:auto;font-size:12px;padding:4px 8px;" onchange="sdSetPriority(this.value)" title="Priority">${opts}</select>`);
    }
    if (c.canEscalate)   b.push(`<button class="btn btn-ghost btn-sm" onclick="sdEscalate()" title="Flag up to IA HICOMM"><i class="ti ti-flag"></i> Escalate</button>`);
    if (c.canDeEscalate) b.push(`<button class="btn btn-ghost btn-sm" onclick="sdAct('deescalate')"><i class="ti ti-flag-off"></i> Clear flag</button>`);
    b.push(`<button class="btn btn-ghost btn-sm" onclick="sdProfile('${t.openerId}','${esc(t.openerName)}')"><i class="ti ti-user"></i> Opener Profile</button>`);
    b.push(`<button class="btn btn-ghost btn-sm" onclick="sdCanned()"><i class="ti ti-message-2-bolt"></i> Quick replies</button>`);
    b.push(`<button class="btn btn-ghost btn-sm" onclick="sdSettings()" title="Support desk settings — edit your claim greetings and quick replies"><i class="ti ti-settings"></i></button>`);
    if (c.canClose)  b.push(`<button class="btn btn-danger btn-sm" onclick="sdClose()"><i class="ti ti-lock"></i> Close</button>`);
    // Guest ticket-blacklist: block/allow this guest opener's IP + browser.
    if (t.openerBlacklisted && (c.isHicomm || c.canBlacklist)) {
      b.push(`<button class="btn btn-ghost btn-sm" style="color:var(--green);" onclick="sdBlacklist(true)" title="Lift the ticket blacklist on this guest"><i class="ti ti-shield-check"></i> Blacklisted — lift</button>`);
    } else if (c.canBlacklist) {
      b.push(`<button class="btn btn-ghost btn-sm" style="color:var(--red);" onclick="sdBlacklist(false)" title="Blacklist this guest's IP/browser from opening tickets"><i class="ti ti-ban"></i> Blacklist guest</button>`);
    }
    if (c.canDelete) b.push(`<button class="btn btn-ghost btn-sm" style="color:var(--red);" onclick="sdDelete()"><i class="ti ti-trash"></i></button>`);
    $('sd-toolbar').innerHTML = b.join(' ');
  }

  function avatarHtml(m) {
    const isBot = (m.authorKind || '').toLowerCase() === 'bot';
    const inner = isBot ? `<img src="${MET}" alt="" style="width:100%;height:100%;object-fit:cover;">`
      : (m.authorAvatar ? `<img src="${esc(m.authorAvatar)}" alt="" style="width:100%;height:100%;object-fit:cover;">` : esc((m.authorName || '?').slice(0, 1).toUpperCase()));
    const click = m.authorId ? ` style="cursor:pointer;" onclick="sdProfile('${esc(m.authorId)}','${esc(m.authorName || '')}')"` : '';
    return `<div${click} style="width:32px;height:32px;border-radius:50%;overflow:hidden;flex:0 0 32px;background:#222;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;">${inner}</div>`;
  }
  function msgHtml(m) {
    const kind = (m.authorKind || 'staff').toLowerCase();
    const internal = kind === 'internal';
    const atts = (m.attachments || []).map(a => a.kind === 'video'
      ? `<video src="${esc(a.url)}" controls style="max-width:220px;max-height:160px;border-radius:8px;"></video>`
      : `<a href="${esc(a.url)}" target="_blank" rel="noopener"><img src="${esc(a.url)}" style="max-width:220px;max-height:160px;border-radius:8px;border:1px solid var(--border,#333);"></a>`).join('');
    const nameColor = kind === 'bot' ? 'var(--blue)' : (internal ? 'var(--amber)' : (kind === 'opener' ? 'var(--text-primary)' : 'var(--green)'));
    return `<div class="sd-msg"${m.id ? ` data-mid="${esc(m.id)}"` : ''} style="display:flex;gap:10px;${internal ? 'background:rgba(232,132,42,.07);border-left:2px solid var(--amber);padding:6px 8px;border-radius:8px;' : ''}">
      ${avatarHtml(m)}
      <div style="flex:1;min-width:0;">
        <div style="font-size:12px;"><span style="font-weight:700;color:${nameColor};">${esc(m.authorName || '')}</span>${internal ? ' <span style="font-size:10px;color:var(--amber);">· internal note</span>' : ''} <span style="color:var(--text-muted);font-size:11px;">${window.formatDateTime ? window.formatDateTime(m.createdAt) : ''}</span></div>
        ${m.body ? `<div style="font-size:14px;line-height:1.5;white-space:pre-wrap;word-break:break-word;">${esc(m.body).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')}</div>` : ''}
        ${m.identity ? idCard(m.identity) : ''}
        ${atts ? `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px;">${atts}</div>` : ''}
      </div></div>`;
  }
  function idCard(p) {
    const head = p.headshotUrl ? `<img src="${esc(p.headshotUrl)}" style="width:44px;height:44px;border-radius:8px;object-fit:cover;">` : '';
    return `<div onclick="window.open('https://www.roblox.com/users/${esc(p.robloxId || '')}/profile','_blank','noopener')" style="cursor:pointer;display:flex;gap:10px;align-items:center;margin-top:6px;padding:8px 10px;border:1px solid var(--border,#333);border-radius:9px;max-width:320px;">
      ${head}<div><div style="font-weight:700;">${esc(p.robloxDisplayName || p.robloxUsername || 'Unknown')}</div>
      <div style="font-size:11px;color:var(--text-muted);">@${esc(p.robloxUsername || '')} · Roblox ${esc(p.robloxId || '')}${p.discordId ? ` · Discord ${esc(p.discordId)}` : ''}</div></div></div>`;
  }
  function renderLog(t) {
    const msgs = t.messages || [];
    const parts = [];
    if (msgs.length) parts.push(msgHtml(msgs[0]));
    (t.intake || []).forEach(q => {
      parts.push(msgHtml({ authorKind: 'bot', authorName: 'MET Assistant', body: q.prompt, createdAt: t.createdAt }));
      parts.push(msgHtml({ authorKind: 'opener', authorName: t.openerName, authorAvatar: t.openerAvatar, body: q.answer, identity: q.identity, attachments: q.attachments, createdAt: t.createdAt }));
    });
    parts.push(...msgs.slice(1).map(msgHtml));
    $('sd-log').innerHTML = parts.join('');
    const l = $('sd-log'); l.scrollTop = l.scrollHeight;
  }

  // ── Actions ─────────────────────────────────────────────────────────
  async function reloadTicket() { try { const t = await api('/api/support/tickets/' + curT.id); curT = t; renderWorkspace(t); } catch (e) {} }
  window.sdAct = async function (action) {
    const map = { claim: 'claim', release: 'release', deescalate: 'escalate' };
    try {
      const body = action === 'deescalate' ? JSON.stringify({ off: true }) : undefined;
      const r = await api('/api/support/tickets/' + curT.id + '/' + map[action], { method: 'POST', body });
      showToast('Done', 'success'); await reloadTicket(); refreshQueue();
      // On claim, prefill the composer with the investigator's greeting (they
      // review/edit and send it themselves). Don't clobber an in-progress draft.
      if (action === 'claim' && r && r.greeting) {
        const inp = $('sd-input');
        if (inp && !inp.value.trim()) { inp.value = r.greeting; inp.focus(); }
      }
    } catch (e) { showToast(e.message, 'error'); }
  };
  window.sdSetPriority = async function (p) {
    try { await api('/api/support/tickets/' + curT.id + '/priority', { method: 'POST', body: JSON.stringify({ priority: p }) }); showToast('Priority set', 'success'); await reloadTicket(); refreshQueue(); }
    catch (e) { showToast(e.message, 'error'); }
  };
  // Reason prompts use the shared awaited dialog (uiPrompt → string, or null on
  // Cancel / Escape / backdrop). A null result is a hard abort, so "Cancel" can
  // never fall through to the action.
  window.sdEscalate = async function () {
    const note = await uiPrompt('Escalate this ticket up to IA High Command. Add a note (optional).',
      { title: 'Escalate to IA HICOMM', confirmText: 'Escalate', placeholder: 'Reason (optional)…', multiline: true });
    if (note === null) return;
    try { await api('/api/support/tickets/' + curT.id + '/escalate', { method: 'POST', body: JSON.stringify({ note }) }); showToast('Escalated', 'success'); await reloadTicket(); refreshQueue(); }
    catch (e) { showToast(e.message, 'error'); }
  };
  window.sdClose = async function () {
    const reason = await uiPrompt('Close this ticket. Add a close reason (optional) — an IA ticket log is auto-filed for HICOMM.',
      { title: 'Close ticket', confirmText: 'Close ticket', cancelText: 'Cancel', placeholder: 'Close reason (optional)…', multiline: true, danger: true });
    if (reason === null) return; // Cancel / Escape / backdrop → do NOT close
    try { await api('/api/support/tickets/' + curT.id + '/close', { method: 'POST', body: JSON.stringify({ reason }) }); showToast('Closed', 'success'); await reloadTicket(); refreshQueue(); }
    catch (e) { showToast(e.message, 'error'); }
  };
  window.sdBlacklist = async function (off) {
    if (off) {
      if (!(await uiConfirm('Lift the ticket blacklist on this guest? They will be able to open support tickets again.'))) return;
      api('/api/support/tickets/' + curT.id + '/blacklist', { method: 'POST', body: JSON.stringify({ off: true }) })
        .then(() => { showToast('Blacklist lifted', 'success'); reloadTicket(); })
        .catch(e => showToast(e.message, 'error'));
      return;
    }
    const reason = await uiPrompt("Blacklist this guest — blocks their IP and browser from opening new support tickets. Reason (optional).",
      { title: 'Blacklist guest', confirmText: 'Blacklist', placeholder: 'Reason (optional)…', multiline: true, danger: true });
    if (reason === null) return;
    try { await api('/api/support/tickets/' + curT.id + '/blacklist', { method: 'POST', body: JSON.stringify({ reason }) }); showToast('Guest blacklisted', 'success'); await reloadTicket(); }
    catch (e) { showToast(e.message, 'error'); }
  };
  window.sdDelete = async function () {
    if (!(await uiConfirm('Permanently delete this ticket and its messages? This cannot be undone.'))) return;
    try { await api('/api/support/tickets/' + curT.id, { method: 'DELETE' }); showToast('Deleted', 'success'); closeModal('modal-sd-ticket'); refreshQueue(); }
    catch (e) { showToast(e.message, 'error'); }
  };
  window.sdCanned = function () {
    sdCannedTitle('<i class="ti ti-message-2-bolt"></i> Quick Replies');
    $('sd-canned-body').innerHTML = CANNED.map(c => `<button class="btn btn-ghost btn-sm" style="display:block;width:100%;text-align:left;margin-bottom:6px;white-space:normal;height:auto;padding:8px 10px;" onclick="sdUseCanned(${JSON.stringify(c).replace(/"/g, '&quot;')})">${esc(c)}</button>`).join('');
    openModal('modal-sd-canned');
  };
  window.sdUseCanned = function (text) { $('sd-input').value = text; closeModal('modal-sd-canned'); $('sd-input').focus(); };

  // ── Support desk settings — edit claim greetings + quick replies ──────
  const GREETING_LABELS = {
    GENERAL_SUPPORT: 'General Support', DISCIPLINARY_APPEAL: 'Disciplinary Action Appeal',
    OFFICER_COMPLAINT: 'Officer Complaint', IA_COMPLAINT: 'Internal Affairs Complaint',
  };
  window.sdSettings = function () {
    const g = (SDC && SDC.me && SDC.me.greetings) || {};
    const greetFields = Object.keys(GREETING_LABELS).map(k => `
      <label style="display:block;font-size:12px;font-weight:600;margin:10px 0 4px;">${esc(GREETING_LABELS[k])}</label>
      <textarea class="form-control" id="sd-set-greet-${k}" rows="3" style="font-size:13px;">${esc(g[k] || '')}</textarea>`).join('');
    const isPinv = !!(SDC && SDC.me && SDC.me.isProbationary);
    const placeholderRows = [
      ['{rank}', 'Your IA rank name (e.g. Investigator)'],
      ['{username}', 'Your Roblox username'],
    ];
    if (isPinv) placeholderRows.push(['{supervision}', 'Inserts “working under the supervision of IA High Command”. Added automatically for you as a Probationary Investigator — you only need this if you want to control where it appears.']);
    const placeholderList = placeholderRows.map(([code, desc]) =>
      `<div style="display:flex;gap:10px;align-items:baseline;padding:5px 0;border-bottom:1px solid var(--border-dim,rgba(255,255,255,.06));">
        <code style="background:var(--hover,rgba(255,255,255,.06));padding:2px 7px;border-radius:6px;font-size:12px;white-space:nowrap;">${esc(code)}</code>
        <span style="font-size:12px;color:var(--text-secondary);line-height:1.5;">${esc(desc)}</span></div>`).join('');
    $('sd-settings-body').innerHTML = `
      <div style="font-size:13px;font-weight:700;margin-bottom:6px;"><i class="ti ti-message-plus"></i> Claim greetings</div>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">Auto-pasted into your reply box when you claim a ticket.</div>
      <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted);margin-bottom:4px;">Available placeholders</div>
      <div style="margin-bottom:12px;">${placeholderList}</div>
      ${greetFields}
      <div style="font-size:13px;font-weight:700;margin:16px 0 6px;"><i class="ti ti-message-2-bolt"></i> Quick replies</div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">One per line. These appear in the Quick replies picker.</div>
      <textarea class="form-control" id="sd-set-canned" rows="8" style="font-size:13px;">${esc(CANNED.join('\n'))}</textarea>`;
    openModal('modal-sd-settings');
  };
  window.sdSaveSettings = async function () {
    const greetings = {};
    Object.keys(GREETING_LABELS).forEach(k => { const el = $('sd-set-greet-' + k); if (el) greetings[k] = el.value; });
    const quickReplies = ($('sd-set-canned').value || '').split('\n').map(s => s.trim()).filter(Boolean);
    try {
      await api('/api/support/settings', { method: 'PATCH', body: JSON.stringify({ greetings, quickReplies }) });
      CANNED = quickReplies.length ? quickReplies.slice() : CANNED;
      if (SDC && SDC.me) { SDC.me.greetings = { ...(SDC.me.greetings || {}), ...greetings }; SDC.me.quickReplies = quickReplies; }
      showToast('Settings saved', 'success');
      closeModal('modal-sd-settings');
    } catch (e) { showToast(e.message, 'error'); }
  };

  function sdCannedTitle(html) { const el = document.querySelector('#modal-sd-canned .modal-title'); if (el) el.innerHTML = html; }
  window.sdProfile = async function (userId, name) {
    // Reuse the canned-modal container, but title it as a profile (not "Quick Replies").
    sdCannedTitle('<i class="ti ti-user"></i> Profile');
    $('sd-canned-body').innerHTML = '<div class="table-loading"><div class="spinner"></div></div>';
    openModal('modal-sd-canned');
    try {
      const p = await api('/api/support/user-profile?userId=' + encodeURIComponent(userId));
      const av = p.avatar ? `<img src="${esc(p.avatar)}" style="width:52px;height:52px;border-radius:50%;">` : '';
      const roblox = p.robloxUsername ? `<div style="font-size:12px;color:var(--text-muted);">Roblox: <a href="https://www.roblox.com/users/${esc(p.robloxId || '')}/profile" target="_blank" rel="noopener" style="color:var(--blue);">@${esc(p.robloxUsername)}${p.robloxId ? ` (${esc(p.robloxId)})` : ''}</a></div>` : '';
      let ia = '';
      if (p.role) {
        const divs = (p.divisions || []).map(d => `${esc(d.division)}${d.rankName ? ' · ' + esc(d.rankName) : ''}`).join('<br>') || '—';
        ia = `<div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border,#333);font-size:13px;"><strong>Site role:</strong> ${esc(p.role)}<br><strong>Divisions:</strong><br>${divs}</div>`;
      }
      $('sd-canned-body').innerHTML = `<div style="display:flex;gap:12px;align-items:center;">${av}<div><div style="font-weight:700;font-size:16px;">${esc(p.name)}</div>
        <div style="font-size:12px;color:var(--text-muted);">Discord: @${esc(p.discordUsername)} (${esc(p.discordId)})</div>${roblox}</div></div>${ia}`;
    } catch (e) { $('sd-canned-body').innerHTML = `<div class="table-empty"><div class="table-empty-text">${esc(e.message)}</div></div>`; }
  };

  // ── Composer + uploads ──────────────────────────────────────────────
  function wireComposer() {
    $('sd-attach').addEventListener('click', () => $('sd-file').click());
    $('sd-file').addEventListener('change', onPick);
    $('sd-send').addEventListener('click', onSend);
    $('sd-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); } });
  }
  function renderPending() {
    $('sd-pending').innerHTML = sdPending.map(p => {
      const thumb = p.previewUrl ? `<img src="${esc(p.previewUrl)}" style="width:38px;height:38px;object-fit:cover;border-radius:7px;">` : `<i class="ti ti-file"></i>`;
      const spin = p.status === 'loading' ? '<div style="position:absolute;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;"><div class="spinner" style="width:16px;height:16px;"></div></div>' : '';
      return `<div style="display:flex;align-items:center;gap:6px;border:1px solid var(--border,#333);border-radius:8px;padding:4px 6px;"><div style="position:relative;width:38px;height:38px;border-radius:7px;overflow:hidden;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.05);">${thumb}${spin}</div><span style="font-size:11px;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(p.name)}</span><a onclick="sdRm(${p.uid})" style="cursor:pointer;color:var(--text-muted);"><i class="ti ti-x"></i></a></div>`;
    }).join('');
  }
  window.sdRm = function (uid) { const i = sdPending.findIndex(p => p.uid === uid); if (i >= 0) { if (sdPending[i].previewUrl) try { URL.revokeObjectURL(sdPending[i].previewUrl); } catch (e) {} sdPending.splice(i, 1); renderPending(); } };
  function onPick(e) {
    const files = Array.from(e.target.files || []); e.target.value = '';
    for (const f of files) {
      const isImg = /^image\//.test(f.type);
      const item = { uid: ++sdSeq, name: f.name || 'upload', kind: isImg ? 'image' : 'video', status: 'loading', previewUrl: isImg ? URL.createObjectURL(f) : null };
      sdPending.push(item); renderPending();
      const q = new URLSearchParams({ filename: f.name || 'upload', mimeType: f.type || 'application/octet-stream' });
      fetch(`/api/support/tickets/${curT.id}/upload?` + q, { method: 'POST', headers: { 'Content-Type': f.type || 'application/octet-stream' }, body: f })
        .then(r => r.ok ? r.json() : r.json().then(d => Promise.reject(new Error(d.error || 'Upload failed'))))
        .then(meta => { item.mediaId = meta.mediaId; item.kind = meta.kind; item.status = 'done'; renderPending(); })
        .catch(err => { item.status = 'error'; renderPending(); showToast(err.message, 'error'); });
    }
  }
  async function onSend() {
    if (sdPending.some(p => p.status === 'loading')) return showToast('Wait for uploads to finish.', 'warning');
    const body = $('sd-input').value.trim();
    const internal = $('sd-internal').checked;
    const atts = sdPending.filter(p => p.status === 'done').map(p => ({ mediaId: p.mediaId, kind: p.kind, name: p.name }));
    if (!body && !atts.length) return;
    try {
      const msg = await api('/api/support/tickets/' + curT.id + '/messages', { method: 'POST', body: JSON.stringify({ body, attachments: atts, internal }) });
      if (!document.querySelector(`[data-mid="${msg.id}"]`)) { $('sd-log').insertAdjacentHTML('beforeend', msgHtml(msg)); const l = $('sd-log'); l.scrollTop = l.scrollHeight; }
      $('sd-input').value = ''; sdPending.forEach(p => { if (p.previewUrl) try { URL.revokeObjectURL(p.previewUrl); } catch (e) {} }); sdPending = []; renderPending();
    } catch (e) { showToast(e.message, 'error'); }
  }

  // ── Realtime (SSE + polling fallback) ────────────────────────────────
  let sdPoll = null;
  function openStream(id) {
    closeStream();
    try {
      sdES = new EventSource('/api/support/tickets/' + id + '/stream');
      sdES.addEventListener('message', ev => {
        try { const m = JSON.parse(ev.data); if (!m || !m.id || document.querySelector(`[data-mid="${m.id}"]`)) return; $('sd-log').insertAdjacentHTML('beforeend', msgHtml(m)); const l = $('sd-log'); l.scrollTop = l.scrollHeight; } catch (e) {}
      });
      sdES.addEventListener('update', () => { reloadTicket(); refreshQueue(); });
    } catch (e) {}
    // Polling fallback — append any new messages even if SSE is buffered.
    sdPoll = setInterval(() => sdRefresh(id), 5000);
  }
  function closeStream() {
    if (sdES) { sdES.close(); sdES = null; }
    if (sdPoll) { clearInterval(sdPoll); sdPoll = null; }
  }
  async function sdRefresh(id) {
    if (!curT || curT.id !== id) return;
    let t; try { t = await api('/api/support/tickets/' + id); } catch (e) { return; }
    (t.messages || []).forEach(m => {
      if (m.id && !document.querySelector(`[data-mid="${m.id}"]`)) { $('sd-log').insertAdjacentHTML('beforeend', msgHtml(m)); }
    });
    const l = $('sd-log'); if (l) l.scrollTop = l.scrollHeight;
    if (t.status !== curT.status) { curT = t; renderToolbar(t); }
  }

  // Close the stream when the modal closes.
  document.addEventListener('click', e => {
    if (e.target && (e.target.closest && e.target.closest('#modal-sd-ticket .modal-close'))) closeStream();
  });
})();
