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
      // "My queue" ordering: float the tickets I'm handling to the top, keeping
      // the server's escalated/priority/newest order within each group.
      const myId = (window.currentUser && window.currentUser.id) || null;
      if (myId) rows.sort((a, b) => (b.claimedById === myId ? 1 : 0) - (a.claimedById === myId ? 1 : 0));
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
    // Make the Support Desk tab the active page behind the workspace, so "Go to
    // ticket" / "Claim ticket" from the alert always land on the desk (not
    // whatever page happened to be open). Only navigate if not already there.
    try {
      const deskPage = document.getElementById('page-support-tickets');
      if (deskPage && !deskPage.classList.contains('active') && typeof window.navigateTo === 'function') window.navigateTo('support-tickets');
    } catch (e) { /* non-fatal */ }
    openModal('modal-sd-ticket');
    $('sd-log').innerHTML = '<div class="table-loading"><div class="spinner"></div></div>';
    $('sd-toolbar').innerHTML = ''; sdPending = []; renderPending();
    // Reset the (shared) composer so a draft / greeting from the previously-open
    // ticket never carries into this one — the cause of a claim's format landing
    // in the wrong ticket.
    const _inp = $('sd-input'); if (_inp) _inp.value = '';
    sdReplyTo = null; renderSdReplyBar();
    const _ic = $('sd-internal'); if (_ic) _ic.checked = false;
    sdClearTypers(); _sdPinned = true;   // fresh ticket → start pinned to newest
    try {
      const t = await api('/api/support/tickets/' + id);
      curT = t; renderWorkspace(t); openStream(id);
    } catch (e) { $('sd-log').innerHTML = `<div class="table-empty"><div class="table-empty-text">${esc(e.message)}</div></div>`; }
  };

  // Open a ticket and immediately claim it (used by the pop-up alert's big
  // "Claim & open" button). Only claims if it's actually claimable by you.
  window.sdOpenAndClaim = async function (id) {
    await window.sdOpen(id);
    if (!curT || curT.id !== id) return;
    const caps = curT.caps || {};
    if (caps.canClaim) {
      // sdAct shows its own "Done" (success) or "Already claimed by X" (race)
      // toast and returns false on failure — so we never add a "claimed" message
      // on top of an "already claimed" one.
      await window.sdAct('claim');
      return;
    }
    // Couldn't claim because it's ALREADY claimed → say exactly that, nothing else.
    if (curT.status === 'CLAIMED') {
      const who = (curT.claimant && curT.claimant.name) || curT.claimedByName || 'another investigator';
      if (typeof window.showToast === 'function') window.showToast('This ticket is already claimed by ' + who + '.', 'info');
    }
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

  // Investigator (claimant) card — little Discord + Roblox avatar profiles,
  // name, IA rank and handles, so everyone sees who owns this ticket.
  function claimantCardHtml(c) {
    if (!c) return '';
    const dAv = c.discordAvatar
      ? `<img src="${esc(c.discordAvatar)}" alt="Discord" title="Discord avatar" style="width:40px;height:40px;border-radius:50%;object-fit:cover;border:2px solid #5865F2;background:#0b0f18;">`
      : '';
    const rInner = c.headshotUrl
      ? `<img src="${esc(c.headshotUrl)}" alt="Roblox" title="Roblox avatar" style="width:40px;height:40px;border-radius:50%;object-fit:cover;border:2px solid #e2231a;background:#0b0f18;${dAv ? 'margin-left:-12px;' : ''}">`
      : '';
    const rAv = rInner && c.robloxUrl ? `<a href="${esc(c.robloxUrl)}" target="_blank" rel="noopener" style="display:inline-flex;">${rInner}</a>` : rInner;
    const rank = c.rankName ? `<span style="font-size:11px;color:var(--blue);font-weight:600;margin-left:6px;">${esc(c.rankName)}</span>` : '';
    const handles = [
      c.robloxUsername ? `Roblox @${esc(c.robloxUsername)}` : '',
      c.discordUsername ? `Discord @${esc(c.discordUsername)}` : '',
    ].filter(Boolean).join(' · ');
    const btn = c.id ? `<button class="btn btn-ghost btn-sm" style="margin-left:auto;" onclick="sdProfile('${esc(c.id)}','${esc(c.robloxUsername || c.name || '')}')"><i class="ti ti-user-circle"></i> Profile</button>` : '';
    return `<div class="glass" style="border:1px solid var(--blue,#4a8fff)33;border-radius:12px;padding:12px 14px;margin-bottom:12px;">
      <div style="display:flex;align-items:center;gap:8px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--blue,#4a8fff);margin-bottom:10px;"><i class="ti ti-shield-check"></i> Handling investigator</div>
      <div style="display:flex;align-items:center;gap:12px;">
        <div style="display:flex;align-items:center;">${dAv}${rAv}</div>
        <div style="min-width:0;">
          <div style="font-weight:700;font-size:14px;">${esc(c.name || 'Investigator')}${rank}</div>
          ${handles ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${handles}</div>` : ''}
        </div>
        ${btn}
      </div>
    </div>`;
  }

  function renderWorkspace(t) {
    $('sd-title').textContent = `${t.typeLabel} · ${t.openerName}`;
    renderToolbar(t);
    renderLog(t);
    // Prepend the IA-only appeal card above the conversation (staff-only data).
    if (t.appeal) { const log = $('sd-log'); if (log) log.insertAdjacentHTML('afterbegin', appealCardHtml(t.appeal)); }
    // The investigator (claimant) card renders inline at the "claimed" message
    // (see sdTransitionPanel), matching the member view — no separate top card.
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

  // Renders the SAME .sup-* chat markup the member support page uses, so a
  // claimed ticket looks identical in the Support Desk and on /support.
  // (Styling lives in the shared /css/support-chat.css.)
  function mdInlineSd(s) { return window.mdRich ? window.mdRich(s) : esc(s || '').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>'); }
  function replyRefSd(m) {
    const r = m.replyTo; if (!r) return '';
    const who = r.authorName || (r.authorKind === 'BOT' ? 'MET Assistant' : 'message');
    const snip = r.snippet ? esc(r.snippet) : '<span style="opacity:.6;">(no text)</span>';
    return `<div class="sup-replyref" onclick="sdJumpTo('${esc(r.id)}')" title="Jump to message"><i class="ti ti-arrow-back-up"></i><span class="sup-replyref-who">${esc(who)}</span><span class="sup-replyref-snip">${snip}</span></div>`;
  }
  window.sdJumpTo = function (mid) {
    const el = document.querySelector(`[data-mid="${(mid || '').replace(/"/g, '')}"]`);
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('sup-flash'); setTimeout(() => el.classList.remove('sup-flash'), 1200); }
  };
  function avatarHtml(m) {
    const isBot = (m.authorKind || '').toLowerCase() === 'bot';
    const inner = isBot ? `<img src="${MET}" alt="MET">`
      : (m.authorAvatar ? `<img src="${esc(m.authorAvatar)}" alt="">` : esc((m.authorName || '?').slice(0, 1).toUpperCase()));
    const click = m.authorId ? ` onclick="sdProfile('${esc(m.authorId)}','${esc(m.authorName || '')}')" title="View profile"` : '';
    return `<div class="sup-av"${click}>${inner}</div>`;
  }
  // A system/transition bot line (claimed / transferred / released) rendered as
  // its card — mirrors the member view so a claimed ticket shows the investigator
  // card inline instead of a plain "has claimed this ticket" line.
  function sysCardSd(logo, title, sub) {
    const media = logo ? `<img src="${esc(logo)}" style="width:34px;height:34px;border-radius:8px;object-fit:cover;" alt="">` : `<i class="ti ti-arrow-back-up" style="font-size:22px;color:var(--blue);"></i>`;
    return `<div class="sup-sys">${media}<div><div style="font-weight:700;font-size:13px;">${esc(title)}</div>${sub ? `<div style="font-size:11px;color:var(--text-muted);">${esc(sub)}</div>` : ''}</div></div>`;
  }
  function sdTransitionPanel(m) {
    if ((m.authorKind || '').toLowerCase() !== 'bot') return null;
    const b = m.body || '';
    if (/claimed this ticket/i.test(b)) return (curT && curT.claimant) ? claimantCardHtml(curT.claimant) : sysCardSd('/img/divisions/ia.png', 'Claimed by Internal Affairs', b);
    if (/will be with you shortly/i.test(b)) return sysCardSd('/img/divisions/ia.png', 'Transferred to Internal Affairs', b);
    if (/released this ticket/i.test(b)) return sysCardSd(null, 'Back in the queue', b);
    return null;
  }
  function msgHtml(m) {
    const panel = sdTransitionPanel(m);
    if (panel) return `<div class="sup-msg-sys"${m.id ? ` data-mid="${esc(m.id)}"` : ''}>${panel}</div>`;
    const kind = (m.authorKind || 'staff').toLowerCase();
    const internal = kind === 'internal';
    const atts = (m.attachments || []).map(a => a.kind === 'video'
      ? `<video src="${esc(a.url)}" controls></video>`
      : `<a href="${esc(a.url)}" target="_blank" rel="noopener"><img src="${esc(a.url)}" alt="${esc(a.name || '')}"></a>`).join('');
    const nameClick = m.authorId ? ` onclick="sdProfile('${esc(m.authorId)}','${esc(m.authorName || '')}')" title="View profile"` : '';
    const canReply = !!m.id && (m.authorKind || '').toLowerCase() !== 'bot' && curT && curT.status !== 'CLOSED';
    return `<div class="sup-msg ${kind}"${m.id ? ` data-mid="${esc(m.id)}"` : ''}>
      ${avatarHtml(m)}
      <div class="sup-body">
        ${replyRefSd(m)}
        <div class="sup-meta"><span class="sup-name"${nameClick}${sdNameUid(m)}>${esc(m.authorName || '')}</span>${internal ? '<span class="sup-note-tag">· internal note</span>' : ''}<span class="sup-time">${window.formatDateTime ? window.formatDateTime(m.createdAt) : ''}</span>${canReply ? `<button class="sup-reply-btn" title="Reply" onclick="sdReply('${esc(m.id)}')"><i class="ti ti-arrow-back-up"></i></button>` : ''}</div>
        ${m.body ? `<div class="sup-text">${mdInlineSd(m.body)}</div>` : ''}
        ${m.identity ? idCard(m.identity) : ''}
        ${atts ? `<div class="sup-atts">${atts}</div>` : ''}
      </div></div>`;
  }
  // data-uid on a STAFF author's name → coloured by their Discord role.
  function sdNameUid(m) {
    const k = (m.authorKind || '').toLowerCase();
    return (m.authorDiscordId && (k === 'staff' || k === 'internal')) ? ` data-uid="${esc(m.authorDiscordId)}"` : '';
  }
  function idCard(p) {
    const head = p.headshotUrl ? `<img src="${esc(p.headshotUrl)}" style="width:52px;height:52px;border-radius:9px;object-fit:cover;">` : '';
    const open = p.robloxId ? ` onclick="window.open('https://www.roblox.com/users/${esc(p.robloxId)}/profile','_blank','noopener')" title="Open Roblox profile"` : '';
    return `<div class="sup-idcard"${open}>
      ${head}<div><div style="font-weight:700;">${esc(p.robloxDisplayName || p.robloxUsername || 'Unknown')}</div>
      <div style="font-size:12px;color:var(--text-muted);">@${esc(p.robloxUsername || '')} · Roblox ID ${esc(p.robloxId || '')}${p.discordId ? ` · Discord ${esc(p.discordId)}` : ''}</div></div></div>`;
  }
  // Auto-scroll only when pinned to the bottom, so scrolling up to read history
  // isn't yanked back down by the 5s poll / incoming messages / updates.
  let _sdPinned = true;
  function sdNearBottom(l) { return !l || (l.scrollHeight - l.scrollTop - l.clientHeight) < 140; }
  function sdScroll(force) { const l = $('sd-log'); if (!l) return; if (force) _sdPinned = true; if (_sdPinned) l.scrollTop = l.scrollHeight; }
  // Resolve <@id> mentions in the log into MET nicknames + a profile card.
  function sdEnrichMentions() {
    if (!window.enrichMentions || !curT) return;
    const root = $('sd-log'); if (!root) return;
    window.enrichMentions(root, {
      resolve: async (ids) => {
        try { const r = await api('/api/support/tickets/' + curT.id + '/mention', { method: 'POST', body: JSON.stringify({ ids }) }); return r.mentions || {}; }
        catch (e) { return {}; }
      },
    });
  }
  (function () { const l = document.getElementById('sd-log'); if (l) l.addEventListener('scroll', () => { _sdPinned = sdNearBottom(l); }, { passive: true }); })();

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
    sdScroll(); sdEnrichMentions();
  }

  // ── Actions ─────────────────────────────────────────────────────────
  async function reloadTicket() { try { const t = await api('/api/support/tickets/' + curT.id); curT = t; renderWorkspace(t); } catch (e) {} }
  window.sdAct = async function (action) {
    const map = { claim: 'claim', release: 'release', deescalate: 'escalate' };
    const tid = curT && curT.id;   // the ticket this action targets
    try {
      const body = action === 'deescalate' ? JSON.stringify({ off: true }) : undefined;
      const r = await api('/api/support/tickets/' + tid + '/' + map[action], { method: 'POST', body });
      showToast('Done', 'success'); await reloadTicket(); refreshQueue();
      // On claim, prefill the composer with the investigator's greeting (they
      // review/edit and send it themselves). Only if we're STILL on that ticket
      // and its composer is empty — never paste it into a different ticket.
      if (action === 'claim' && r && r.greeting && curT && curT.id === tid) {
        const inp = $('sd-input');
        if (inp && !inp.value.trim()) { inp.value = r.greeting; inp.focus(); }
      }
      return true;
    } catch (e) { showToast(e.message, 'error'); return false; }
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
  // Expand saved-reply variables against the open ticket: {opener} = the
  // member's name, {rank} = the handling investigator's IA rank, {caseRef} =
  // the appealed punishment's case reference (blank if not an appeal).
  function expandCannedVars(text) {
    const t = curT || {};
    const opener  = t.openerName || 'there';
    const rank    = (t.claimant && t.claimant.rankName) || (SDC && SDC.me && SDC.me.rankName) || 'Investigator';
    const caseRef = (t.appeal && t.appeal.punishment && t.appeal.punishment.caseRef) || '';
    return String(text)
      .replace(/\{opener\}/gi, opener)
      .replace(/\{rank\}/gi, rank)
      .replace(/\{caseRef\}/gi, caseRef);
  }
  window.sdCanned = function () {
    sdCannedTitle('<i class="ti ti-message-2-bolt"></i> Quick Replies');
    const hint = '<div style="font-size:11px;color:var(--text-muted);margin:0 0 10px;">Variables expand when inserted: <code>{opener}</code>, <code>{rank}</code>, <code>{caseRef}</code>.</div>';
    $('sd-canned-body').innerHTML = hint + CANNED.map(c => `<button class="btn btn-ghost btn-sm" style="display:block;width:100%;text-align:left;margin-bottom:6px;white-space:normal;height:auto;padding:8px 10px;" onclick="sdUseCanned(${JSON.stringify(c).replace(/"/g, '&quot;')})">${esc(expandCannedVars(c))}</button>`).join('');
    openModal('modal-sd-canned');
  };
  window.sdUseCanned = function (text) { $('sd-input').value = expandCannedVars(text); closeModal('modal-sd-canned'); $('sd-input').focus(); };

  // ── Support desk settings — edit claim greetings + quick replies ──────
  const GREETING_LABELS = {
    GENERAL_SUPPORT: 'Website Support', DISCIPLINARY_APPEAL: 'Disciplinary Action Appeal',
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
  function sdAvatarBlock(url, label, iconColor, iconClass) {
    const img = url
      ? `<img src="${esc(url)}" alt="" style="width:64px;height:64px;border-radius:14px;object-fit:cover;background:#111;">`
      : `<div style="width:64px;height:64px;border-radius:14px;background:#1a1f2b;display:flex;align-items:center;justify-content:center;color:#5d6675;font-size:24px;"><i class="ti ti-user"></i></div>`;
    return `<div style="display:flex;flex-direction:column;align-items:center;gap:6px;">
      ${img}
      <span style="font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:${iconColor};display:flex;align-items:center;gap:4px;"><i class="ti ${iconClass}"></i>${esc(label)}</span></div>`;
  }
  window.sdProfile = async function (id, name) {
    sdCannedTitle('<i class="ti ti-user"></i> Profile');
    $('sd-canned-body').innerHTML = '<div class="table-loading"><div class="spinner"></div></div>';
    openModal('modal-sd-canned');
    try {
      // The id may be a site user id (uuid) or a Discord snowflake (all digits).
      const key = /^\d{16,20}$/.test(String(id)) ? 'discordId' : 'userId';
      const p = await api(`/api/support/user-profile?${key}=` + encodeURIComponent(id));

      const roleBadge = p.role && p.role !== 'NONE'
        ? `<span class="badge badge-approved" style="margin-left:8px;"><span class="badge-dot"></span>${esc(p.role)}</span>` : '';
      const since = p.createdAt ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">Member since ${esc(new Date(p.createdAt).toLocaleDateString())}</div>` : '';

      // Copyable identity rows, each with a branded "open profile" button.
      const idRow = (labelIcon, labelColor, label, handle, rid, link) => {
        const copyVal = rid || handle || '';
        return `<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--border-dim,rgba(255,255,255,.06));">
          <i class="ti ${labelIcon}" style="font-size:18px;color:${labelColor};width:20px;text-align:center;"></i>
          <div style="flex:1;min-width:0;">
            <div style="font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:var(--text-muted);">${esc(label)}</div>
            <div style="font-size:13px;">${handle ? '@' + esc(handle) : '<span style="color:var(--text-muted);">Not linked</span>'}${rid ? ` <span style="color:var(--text-muted);font-size:11px;">(${esc(rid)})</span>` : ''}</div>
          </div>
          ${link ? `<a href="${esc(link)}" target="_blank" rel="noopener" class="btn btn-ghost btn-sm" title="Open ${esc(label)} profile" style="color:${labelColor};"><i class="ti ${labelIcon}"></i> Open profile</a>` : ''}
          ${copyVal ? `<button class="btn btn-ghost btn-sm" title="Copy" onclick="window.copyText && copyText('${esc(String(copyVal))}','${esc(label)}')"><i class="ti ti-copy"></i></button>` : ''}
        </div>`;
      };

      let divs = '';
      if (p.role !== undefined) {
        const list = (p.divisions || []);
        divs = `<div style="margin-top:14px;">
          <div style="font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted);margin-bottom:8px;">Divisions & rank</div>
          ${list.length ? `<div style="display:flex;flex-wrap:wrap;gap:6px;">${list.map(d => `<span class="met-chip">${esc(d.division)}${d.rankName ? ' · ' + esc(d.rankName) : ''}</span>`).join('')}</div>`
            : '<div style="font-size:12px;color:var(--text-muted);">No divisions.</div>'}
        </div>`;
      }

      $('sd-canned-body').innerHTML = `
        <div style="display:flex;gap:18px;align-items:center;justify-content:center;padding:6px 0 14px;">
          ${sdAvatarBlock(p.avatar, 'Discord', '#5865F2', 'ti-brand-discord')}
          ${sdAvatarBlock(p.headshot, 'Roblox', '#e2231a', 'ti-brand-roblox')}
        </div>
        <div style="text-align:center;margin-bottom:6px;">
          <div style="font-weight:800;font-size:18px;">${esc(p.name)}${roleBadge}</div>
          ${since}
        </div>
        <div style="margin-top:10px;">
          ${idRow('ti-brand-discord', '#5865F2', 'Discord', p.discordUsername, p.discordId, p.discordId ? 'https://discord.com/users/' + encodeURIComponent(p.discordId) : null)}
          ${idRow('ti-brand-roblox', '#e2231a', 'Roblox', p.robloxUsername, p.robloxId, p.robloxId ? 'https://www.roblox.com/users/' + encodeURIComponent(p.robloxId) + '/profile' : null)}
        </div>
        ${divs}`;
    } catch (e) { $('sd-canned-body').innerHTML = `<div class="table-empty"><div class="table-empty-text">${esc(e.message)}</div></div>`; }
  };

  // ── Composer + uploads ──────────────────────────────────────────────
  function wireComposer() {
    $('sd-attach').addEventListener('click', () => $('sd-file').click());
    $('sd-file').addEventListener('change', onPick);
    $('sd-send').addEventListener('click', onSend);
    $('sd-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); } });
    // Rich (WYSIWYG) composer — formatting renders live inside the box as you type,
    // with @-autocomplete of MET members.
    if (window.initRichComposer) window.initRichComposer($('sd-input'), {
      mentionSearch: async (q) => { if (!q) return []; try { const r = await api('/api/support/mention-search?q=' + encodeURIComponent(q)); return r.users || []; } catch (e) { return []; } },
    });
    $('sd-input').addEventListener('input', sdSendTyping);
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
  // ── Reply-to (Discord-style) ─────────────────────────────────────
  let sdReplyTo = null;
  window.sdReply = function (mid) {
    const el = document.querySelector(`[data-mid="${(mid || '').replace(/"/g, '')}"]`);
    if (!el) return;
    const who = (el.querySelector('.sup-name') || {}).textContent || 'message';
    const bodyEl = el.querySelector('.sup-text');
    const snippet = bodyEl ? bodyEl.textContent.replace(/\s+/g, ' ').trim().slice(0, 120) : '📎 Attachment';
    sdReplyTo = { id: mid, authorName: who, snippet };
    renderSdReplyBar();
    const inp = $('sd-input'); if (inp) inp.focus();
  };
  window.sdCancelReply = function () { sdReplyTo = null; renderSdReplyBar(); };
  function renderSdReplyBar() {
    let bar = document.getElementById('sd-replybar');
    if (!sdReplyTo) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'sd-replybar'; bar.className = 'sup-replybar';
      const pend = document.getElementById('sd-pending');
      if (pend && pend.parentNode) pend.parentNode.insertBefore(bar, pend);
    }
    bar.innerHTML = `<i class="ti ti-arrow-back-up"></i><span class="sup-replybar-who">Replying to ${esc(sdReplyTo.authorName)}</span>
      <span class="sup-replybar-snip">${esc(sdReplyTo.snippet || '')}</span>
      <button class="sup-replybar-x" title="Cancel reply" onclick="sdCancelReply()"><i class="ti ti-x"></i></button>`;
  }

  async function onSend() {
    if (sdPending.some(p => p.status === 'loading')) return showToast('Wait for uploads to finish.', 'warning');
    const body = $('sd-input').value.trim();
    const internal = $('sd-internal').checked;
    const atts = sdPending.filter(p => p.status === 'done').map(p => ({ mediaId: p.mediaId, kind: p.kind, name: p.name }));
    if (!body && !atts.length) return;
    const replyToId = sdReplyTo ? sdReplyTo.id : null;
    try {
      const msg = await api('/api/support/tickets/' + curT.id + '/messages', { method: 'POST', body: JSON.stringify({ body, attachments: atts, internal, replyToId }) });
      if (!document.querySelector(`[data-mid="${msg.id}"]`)) { $('sd-log').insertAdjacentHTML('beforeend', msgHtml(msg)); sdScroll(true); sdEnrichMentions(); }
      $('sd-input').value = ''; sdPending.forEach(p => { if (p.previewUrl) try { URL.revokeObjectURL(p.previewUrl); } catch (e) {} }); sdPending = []; renderPending();
      sdReplyTo = null; renderSdReplyBar();
      window.supFmtPreviewClear('sd-fmt-preview');
    } catch (e) { showToast(e.message, 'error'); }
  }

  // ── Typing indicator ─────────────────────────────────────────────
  let _sdLastTyping = 0;
  function sdSendTyping() {
    if (!curT || !curT.id) return;
    const ic = $('sd-internal'); if (ic && ic.checked) return;   // don't leak internal-note typing
    const now = Date.now();
    if (now - _sdLastTyping < 2000) return;
    _sdLastTyping = now;
    try { fetch('/api/support/tickets/' + curT.id + '/typing', { method: 'POST', credentials: 'same-origin' }).catch(() => {}); } catch (e) {}
  }
  const _sdTypers = {};
  function sdOnTyping(d) {
    if (!d || !d.name) return;
    if (d.userId && SDC && SDC.me && d.userId === SDC.me.id) return;   // ignore my own
    if (_sdTypers[d.name]) clearTimeout(_sdTypers[d.name]);
    _sdTypers[d.name] = setTimeout(() => { delete _sdTypers[d.name]; sdRenderTypers(); }, 4500);
    sdRenderTypers();
  }
  function sdRenderTypers() {
    let el = document.getElementById('sd-typing');
    const names = Object.keys(_sdTypers);
    if (!names.length) { if (el) { el.style.display = 'none'; el.innerHTML = ''; } return; }
    if (!el) {
      const composer = $('sd-composer'); if (!composer || !composer.parentNode) return;
      el = document.createElement('div'); el.id = 'sd-typing'; el.className = 'sup-typing';
      composer.parentNode.insertBefore(el, composer);
    }
    el.style.display = '';
    const label = names.length === 1 ? `${names[0]} is typing` : `${names.slice(0, 2).join(', ')}${names.length > 2 ? ' and others' : ''} are typing`;
    el.innerHTML = `<span class="sup-typing-dots"><span></span><span></span><span></span></span> ${esc(label)}…`;
  }
  function sdClearTypers() { Object.keys(_sdTypers).forEach(k => clearTimeout(_sdTypers[k])); Object.keys(_sdTypers).forEach(k => delete _sdTypers[k]); sdRenderTypers(); }

  // ── Realtime (SSE + polling fallback) ────────────────────────────────
  let sdPoll = null;
  // Soft, quiet blip when a message arrives in the open ticket (browser autoplay
  // rule needs a prior gesture — staff are clicking around the desk, so it's on).
  let _msgActx = null;
  function msgBlip() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
      if (!_msgActx) _msgActx = new AC();
      if (_msgActx.state === 'suspended') _msgActx.resume().catch(() => {});
      const ctx = _msgActx, now = ctx.currentTime;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = 620;
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(0.13, now + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
      o.connect(g); g.connect(ctx.destination); o.start(now); o.stop(now + 0.2);
    } catch (e) { /* audio unavailable */ }
  }

  function openStream(id) {
    closeStream();
    try {
      sdES = new EventSource('/api/support/tickets/' + id + '/stream');
      sdES.addEventListener('message', ev => {
        try { const m = JSON.parse(ev.data); if (!m || !m.id || document.querySelector(`[data-mid="${m.id}"]`)) return; msgBlip(); $('sd-log').insertAdjacentHTML('beforeend', msgHtml(m)); sdScroll(); sdEnrichMentions(); if (m.authorName) { if (_sdTypers[m.authorName]) { clearTimeout(_sdTypers[m.authorName]); delete _sdTypers[m.authorName]; sdRenderTypers(); } } } catch (e) {}
      });
      sdES.addEventListener('typing', ev => { try { sdOnTyping(JSON.parse(ev.data)); } catch (e) {} });
      sdES.addEventListener('update', () => { reloadTicket(); refreshQueue(); });
      // A message removed server-side (e.g. a claim-race message auto-deleted).
      sdES.addEventListener('delete', ev => {
        try { const d = JSON.parse(ev.data); if (d && d.id) { const el = document.querySelector(`[data-mid="${d.id}"]`); if (el) el.remove(); } } catch (e) {}
      });
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
    sdScroll(); sdEnrichMentions();
    if (t.status !== curT.status) { curT = t; renderToolbar(t); }
  }

  // Close the stream when the modal closes.
  document.addEventListener('click', e => {
    if (e.target && (e.target.closest && e.target.closest('#modal-sd-ticket .modal-close'))) closeStream();
  });

  // Deep link from the pop-up alert / a shared link:
  // /ia/dashboard?supportTicket=<id>[&claim=1] — open (and optionally claim) it
  // in the desk, over whichever dashboard page is active.
  (function deepLink() {
    let done = false;
    async function run() {
      if (done) return; done = true;
      const p = new URLSearchParams(location.search);
      const tid = p.get('supportTicket');
      if (!tid) return;
      try { if (typeof window.loadSupportTickets === 'function') await window.loadSupportTickets(); } catch (e) {}
      if (p.get('claim') === '1') window.sdOpenAndClaim(tid); else window.sdOpen(tid);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
    else run();
  })();
})();
