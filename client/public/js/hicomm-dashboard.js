/* MET HICOMM oversight dashboard — Command Center, Analytics, Integrity,
   Officer 360° and the Audit Trail. All data from /api/hicomm/*. */
(function () {
  const esc = window.escapeHtml || (s => String(s == null ? '' : s));
  const C = window.MetCharts;
  const $ = id => document.getElementById(id);
  const fmtWhen = d => { try { return window.formatDateTime ? window.formatDateTime(d) : new Date(d).toLocaleString(); } catch (e) { return ''; } };
  const ago = d => {
    const s = Math.max(0, (Date.now() - new Date(d).getTime()) / 1000);
    if (s < 60) return 'just now'; if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago'; return Math.round(s / 86400) + 'd ago';
  };
  let ccTimer = null;

  // ── Nav ──
  function showPage(name) {
    document.querySelectorAll('.sidebar-nav .nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === name));
    document.querySelectorAll('.main-content .page').forEach(p => p.classList.toggle('active', p.id === 'page-' + name));
    if (name === 'command') startCC(); else stopCC();
    if (name === 'analytics') hcLoadAnalytics();
    if (name === 'integrity') hcLoadIntegrity();
    if (name === 'audit') hcLoadAudit();
    if (name === 'gamelogs') hcLoadGameLogs();
    if (name === 'group' && typeof loadGroupPanel === 'function') loadGroupPanel();
  }
  function wireNav() {
    document.querySelectorAll('.sidebar-nav .nav-item').forEach(b => b.addEventListener('click', () => showPage(b.dataset.page)));
  }

  // ── Command Center ──
  function startCC() { stopCC(); hcLoadOverview(); ccTimer = setInterval(hcLoadOverview, 8000); }
  function stopCC() { if (ccTimer) { clearInterval(ccTimer); ccTimer = null; } }

  const COUNTERS = [
    ['liveTryouts', 'Live Tryouts', 'var(--green)'],
    ['openTickets', 'Open Tickets', 'var(--blue)'],
    ['pendingLogs', 'Logs to Review', 'var(--amber)'],
    ['pendingCases', 'Pending Cases', 'var(--red)'],
    ['pendingPatrols', 'Patrols Pending', 'var(--text-primary)'],
    ['tryoutsToday', 'Tryouts / 24h', 'var(--blue)'],
    ['ticketsToday', 'Tickets / 24h', 'var(--blue)'],
    ['newUsersToday', 'New Officers / 24h', 'var(--green)'],
  ];
  window.hcLoadOverview = async function () {
    let d; try { d = await api('/api/hicomm/overview'); } catch (e) { return; }
    $('hc-counters').innerHTML = COUNTERS.map(([k, l, c]) =>
      `<div class="cc-stat"><div class="v" style="color:${c};">${(d.counters[k] ?? 0)}</div><div class="l">${l}</div></div>`).join('');
    // live tryouts
    $('hc-live').innerHTML = d.live.length ? d.live.map(t => {
      const lock = ['UNLOCKED', 'UNSLOCKED'].includes(String(t.lockState || '').toUpperCase());
      return `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid var(--border,#2a2a2a);">
        <div><div style="font-weight:700;">${esc(t.hostName || 'Tryout')} <span class="badge badge-approved" style="font-size:9px;">${esc(t.division)}</span></div>
        <div style="font-size:11px;color:var(--text-muted);">${t.coHostName ? 'co: ' + esc(t.coHostName) + ' · ' : ''}${t.attendees} attending</div></div>
        <span class="badge ${lock ? 'badge-approved' : 'badge-denied'}"><span class="badge-dot"></span>${lock ? 'Unlocked' : 'Locked'}</span></div>`;
    }).join('') : '<div class="table-empty"><div class="table-empty-text">No tryouts are live right now.</div></div>';
    // audit feed
    $('hc-audit-feed').innerHTML = d.audit.length ? d.audit.map(auditRow).join('') : '<div class="table-empty"><div class="table-empty-text">No recorded actions yet.</div></div>';
  };

  const CAT_ICON = { GROUP: ['ti-users-group', '#3b82f6'], SUPPORT: ['ti-lifebuoy', '#8b93a1'], TRYOUT: ['ti-clipboard-check', '#22c55e'], CASE: ['ti-gavel', '#e0503a'], TICKET: ['ti-ticket', '#8b5cf6'], ACCESS: ['ti-key', '#e8842a'], SECURITY: ['ti-shield-lock', '#ef4444'], DEV: ['ti-code', '#f5c518'] };
  function auditRow(a) {
    const [ic, col] = CAT_ICON[a.category] || ['ti-point', '#888'];
    return `<div class="tl-item">
      <div class="tl-dot" style="background:${col}22;color:${col};"><i class="ti ${ic}"></i></div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;">${esc(a.summary || (a.category + '/' + a.action))}</div>
        <div style="font-size:11px;color:var(--text-muted);">${esc(a.actorName || 'System')}${a.division ? ' · ' + esc(a.division) : ''} · ${ago(a.createdAt)}</div>
      </div></div>`;
  }

  // ── Analytics ──
  window.hcLoadAnalytics = async function () {
    const div = $('hc-an-div').value, days = $('hc-an-days').value;
    const wrap = $('hc-analytics');
    wrap.innerHTML = '<div class="table-loading"><div class="spinner"></div></div>';
    let d; try { d = await api(`/api/hicomm/analytics?division=${encodeURIComponent(div)}&days=${days}`); } catch (e) { wrap.innerHTML = `<div class="table-empty"><div class="table-empty-text">${esc(e.message)}</div></div>`; return; }
    renderAnalytics(wrap, d);
  };
  function renderAnalytics(wrap, d) {
    const t = d.tryouts, labels = t.series.map(s => s.day.slice(5));
    const passLine = C.lineChart([
      { name: 'Attendees', color: '#3b82f6', points: t.series.map(s => s.attendees) },
      { name: 'Passed', color: '#22c55e', points: t.series.map(s => s.passed) },
      { name: 'Failed', color: '#e0503a', points: t.series.map(s => s.failed) },
    ], labels);
    const act = d.activity, alabels = act.series.map(s => s.day.slice(5));
    const actLine = C.lineChart([
      { name: 'Patrols', color: '#14b8a6', points: act.series.map(s => s.patrols) },
      { name: 'Events', color: '#e8842a', points: act.series.map(s => s.events) },
      { name: 'Tickets', color: '#8b5cf6', points: act.series.map(s => s.tickets) },
    ], alabels);
    const board = C.barList(t.leaderboard.map(h => ({ label: h.hostName || 'Host', sub: `${h.tryouts} tryouts · ${h.passRate}% pass`, value: h.attendees, color: '#3b82f6' })));
    wrap.innerHTML = `
      <div class="cc-grid fade-up" style="margin-bottom:16px;">
        <div class="cc-stat"><div class="v">${t.totals.tryouts}</div><div class="l">Tryouts (${d.allTime ? 'all time' : d.days + 'd'})</div></div>
        <div class="cc-stat"><div class="v">${t.totals.attendees}</div><div class="l">Candidates</div></div>
        <div class="cc-stat"><div class="v" style="color:var(--green);">${t.totals.passed}</div><div class="l">Passed</div></div>
        <div class="cc-stat"><div class="v" style="color:var(--red);">${t.totals.failed}</div><div class="l">Failed</div></div>
        <div class="cc-stat"><div class="v" style="color:var(--amber);">${t.totals.passRate}%</div><div class="l">Pass Rate</div></div>
      </div>
      <div style="display:grid;grid-template-columns:1.4fr 1fr;gap:16px;">
        <div class="panel glass"><div class="panel-header"><div class="panel-title"><span class="panel-dot blue"></span>Tryout Performance</div></div><div style="padding:12px 16px;">${passLine}</div></div>
        <div class="panel glass"><div class="panel-header"><div class="panel-title"><span class="panel-dot green"></span>Recruitment Funnel</div></div><div style="padding:20px 16px;">${C.funnel(d.funnel.stages)}<div style="text-align:center;margin-top:14px;">${C.gauge(d.funnel.conversion, 'conversion', '#22c55e')}</div></div></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1.2fr;gap:16px;margin-top:16px;">
        <div class="panel glass"><div class="panel-header"><div class="panel-title"><span class="panel-dot amber"></span>Host Leaderboard</div></div><div style="padding:16px;">${t.leaderboard.length ? board : '<div class="table-empty-text">No tryouts yet.</div>'}</div></div>
        <div class="panel glass"><div class="panel-header"><div class="panel-title"><span class="panel-dot"></span>MET Activity</div></div><div style="padding:12px 16px;">${actLine}</div></div>
      </div>`;
  }

  // ── Integrity ──
  window.hcLoadIntegrity = async function () {
    const div = $('hc-int-div').value;
    const wrap = $('hc-integrity');
    wrap.innerHTML = '<div class="table-loading"><div class="spinner"></div></div>';
    let d; try { d = await api('/api/hicomm/integrity?division=' + encodeURIComponent(div)); } catch (e) { wrap.innerHTML = `<div class="table-empty-text">${esc(e.message)}</div>`; return; }
    const badge = $('hc-integrity-badge');
    const high = d.flags.filter(f => f.severity === 'high').length;
    if (badge) { badge.style.display = d.flags.length ? 'inline-flex' : 'none'; badge.textContent = d.flags.length; }
    const col = { high: 'var(--red)', medium: 'var(--amber)', low: 'var(--text-muted)' };
    wrap.innerHTML = d.flags.length ? `
      <div style="margin-bottom:14px;font-size:13px;color:var(--text-secondary);">Scanned <strong>${d.scanned}</strong> recent tryout logs · <strong style="color:var(--red);">${high}</strong> high-severity flags.</div>
      ${d.flags.map(f => `<div class="flag-card" style="border-left-color:${col[f.severity]};">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div><span class="badge ${f.severity === 'high' ? 'badge-denied' : f.severity === 'medium' ? 'badge-amber' : 'badge-pending'}" style="text-transform:capitalize;">${f.severity}</span>
          <strong style="margin-left:8px;">${esc(f.kind.replace(/-/g, ' '))}</strong> ${f.division ? `<span class="badge badge-approved" style="font-size:9px;">${esc(f.division)}</span>` : ''}</div>
          ${f.logId ? `<a class="btn btn-ghost btn-sm" href="/${(f.division || 'hpc').toLowerCase() === 'sco19' ? 'sco19' : (f.division || 'hpc').toLowerCase()}/dashboard?tryoutLog=${f.logId}" target="_blank"><i class="ti ti-external-link"></i> Log</a>` : ''}
        </div>
        <div style="font-size:13px;margin-top:6px;">${esc(f.detail)}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:3px;">Host: ${esc(f.host || '—')}</div>
      </div>`).join('')}`
      : '<div class="table-empty"><div class="table-empty-text"><i class="ti ti-shield-check" style="font-size:26px;color:var(--green);"></i><br>No integrity issues detected.</div></div>';
  };

  // ── Officer 360 ──
  let offTimer = null;
  window.hcOfficerSearch = function () {
    clearTimeout(offTimer);
    offTimer = setTimeout(async () => {
      const q = $('hc-off-search').value.trim();
      if (q.length < 2) { $('hc-off-results').innerHTML = ''; return; }
      let rows; try { rows = await api('/api/hicomm/officer/search?q=' + encodeURIComponent(q)); } catch (e) { return; }
      const avatarBox = (u) => u.avatar
        ? `<img src="${esc(u.avatar)}" style="width:32px;height:32px;border-radius:50%;">`
        : `<div style="width:32px;height:32px;border-radius:50%;background:#333;display:flex;align-items:center;justify-content:center;">${esc((u.name || '?').slice(0, 1).toUpperCase())}</div>`;
      $('hc-off-results').innerHTML = rows.map(u => {
        // Found in the MET Discord server but not a site user → open a live profile.
        if (u.discordOnly) return `
        <div onclick="hcOpenSubject('discord','${esc(u.discordId)}')" style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;cursor:pointer;border:1px solid var(--border,#2a2a2a);margin-bottom:6px;">
          ${avatarBox(u)}
          <div><div style="font-weight:600;">${esc(u.name)} <span style="font-size:10px;color:var(--blue);">MET server</span></div>
          <div style="font-size:11px;color:var(--text-muted);">${u.robloxUsername ? 'Roblox: ' + esc(u.robloxUsername) + ' · ' : ''}${u.roleCount || 0} roles · not a site user</div></div>
        </div>`;
        // Resolved on Roblox only → open a live Roblox/groups profile.
        if (u.noAccount) return `
        <div onclick="hcOpenSubject('roblox','${esc(u.robloxId)}')" style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;cursor:pointer;border:1px dashed var(--border,#2a2a2a);margin-bottom:6px;">
          <div style="width:32px;height:32px;border-radius:50%;background:#333;display:flex;align-items:center;justify-content:center;"><i class="ti ti-brand-roblox"></i></div>
          <div><div style="font-weight:600;">${esc(u.name)} <span style="font-size:10px;color:var(--amber);">Roblox only</span></div>
          <div style="font-size:11px;color:var(--text-muted);">@${esc(u.robloxUsername || '')} · not a site user — view groups &amp; MET rank</div></div>
        </div>`;
        return `
        <div onclick="hcOfficer('${u.id}')" style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;cursor:pointer;border:1px solid var(--border,#2a2a2a);margin-bottom:6px;">
          ${avatarBox(u)}
          <div><div style="font-weight:600;">${esc(u.name)}</div><div style="font-size:11px;color:var(--text-muted);">@${esc(u.discordUsername || '')}${u.robloxUsername ? ' · ' + esc(u.robloxUsername) : ''} · ${esc(u.role || '')}</div></div>
        </div>`;
      }).join('') || '<div class="table-empty-text">No officers found.</div>';
    }, 120);
  };
  // Dual profile avatar block (Discord + Roblox) — mirrors the ticket profile card.
  function hcAvatarBlock(url, label, color, icon) {
    const img = url
      ? `<img src="${esc(url)}" alt="" style="width:60px;height:60px;border-radius:14px;object-fit:cover;background:#111;border:2px solid ${color};">`
      : `<div style="width:60px;height:60px;border-radius:14px;background:#1a1f2b;display:flex;align-items:center;justify-content:center;color:#5d6675;font-size:22px;border:2px solid ${color}55;"><i class="ti ${icon}"></i></div>`;
    return `<div style="display:flex;flex-direction:column;align-items:center;gap:5px;">${img}
      <span style="font-size:9px;letter-spacing:.05em;text-transform:uppercase;color:${color};display:flex;align-items:center;gap:3px;"><i class="ti ${icon}"></i>${esc(label)}</span></div>`;
  }
  // Copyable ID chip with an "open profile" link (Discord/Roblox).
  function hcIdChip(label, val, icon, link) {
    const copy = `<button type="button" class="met-chip" title="Copy ${esc(label)}" onclick="window.copyText&&copyText('${esc(String(val))}','${esc(label)}')" style="cursor:pointer;background:none;font:inherit;"><i class="ti ${icon}"></i> ${esc(label)}: ${esc(String(val))} <i class="ti ti-copy" style="opacity:.6;"></i></button>`;
    const open = link ? `<a class="met-chip" href="${esc(link)}" target="_blank" rel="noopener" title="Open profile" style="text-decoration:none;"><i class="ti ti-external-link"></i></a>` : '';
    return copy + open;
  }
  window.hcOfficer = async function (id) {
    const wrap = $('hc-off-detail');
    wrap.innerHTML = '<div class="panel glass"><div class="table-loading"><div class="spinner"></div></div></div>';
    let d; try { d = await api(`/api/hicomm/officer/${id}/timeline`); } catch (e) { wrap.innerHTML = `<div class="panel glass"><div class="table-empty-text">${esc(e.message)}</div></div>`; return; }
    const o = d.officer;
    const chip = (n, l, c) => `<div class="cc-stat" style="text-align:center;"><div class="v" style="color:${c};font-size:22px;">${n}</div><div class="l">${l}</div></div>`;
    wrap.innerHTML = `
      <div class="panel glass fade-up hc-officer-hero" style="margin-bottom:16px;"><div style="padding:20px;display:flex;gap:18px;align-items:center;flex-wrap:wrap;">
        <div style="display:flex;gap:12px;">
          ${hcAvatarBlock(o.avatar, 'Discord', '#5865F2', 'ti-brand-discord')}
          ${hcAvatarBlock(o.robloxHeadshot, 'Roblox', '#e2231a', 'ti-brand-roblox')}
        </div>
        <div style="flex:1;min-width:220px;">
          <div style="font-size:22px;font-weight:800;">${esc(o.name)}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">@${esc(o.discordUsername || '')}${o.robloxUsername ? ' · Roblox: ' + esc(o.robloxUsername) : ''}</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;">
            ${o.role ? `<span class="met-chip" style="border-color:var(--blue);color:var(--blue);">${esc(o.role)}</span>` : ''}
            ${o.discordId ? hcIdChip('Discord ID', o.discordId, 'ti-brand-discord', 'https://discord.com/users/' + encodeURIComponent(o.discordId)) : ''}
            ${o.robloxId ? hcIdChip('Roblox ID', o.robloxId, 'ti-brand-roblox', 'https://www.roblox.com/users/' + encodeURIComponent(o.robloxId) + '/profile') : ''}
          </div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:8px;">Joined ${fmtWhen(o.joinedAt)}${o.lastLogin ? ' · last seen ' + ago(o.lastLogin) : ''}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          <button class="btn btn-ghost btn-sm" onclick="hcViewAs('${o.id}')"><i class="ti ti-eye-search"></i> View access</button>
          <button class="btn btn-ghost btn-sm" style="color:var(--amber);" onclick="hcForceReauth('${o.id}','${jsAttr(o.name)}')"><i class="ti ti-logout-2"></i> Force re-auth</button>
        </div>
      </div></div>
      <div id="hc-viewas"></div>
      <div id="hc-met-profile"></div>
      <div class="cc-grid fade-up" style="margin-bottom:16px;">
        ${chip(d.counts.hosted, 'Tryouts Hosted', 'var(--blue)')}${chip(d.counts.patrols, 'Patrol Logs', 'var(--green)')}
        ${chip(d.counts.cases, 'IA Cases', 'var(--red)')}${chip(d.counts.punishments, 'Punishments', 'var(--amber)')}${chip(d.counts.tickets, 'Tickets', 'var(--text-primary)')}
      </div>
      <div class="panel glass fade-up"><div class="panel-header"><div class="panel-title"><span class="panel-dot"></span>Full Timeline</div></div>
        <div style="padding:8px 18px;max-height:520px;overflow:auto;">${d.events.length ? d.events.map(e => {
          const clickable = e.refId && e.kind;
          const openAttr = clickable ? `onclick="hcOpenEntity('${e.kind}','${e.refId}')" style="cursor:pointer;" title="Open ${esc(e.kind)}"` : '';
          const chevron = clickable ? '<i class="ti ti-chevron-right" style="color:var(--text-muted);align-self:center;"></i>' : '';
          return `
          <div class="tl-item" ${openAttr}><div class="tl-dot" style="background:${e.color}22;color:${e.color};"><i class="ti ${e.icon}"></i></div>
          <div style="flex:1;"><div style="font-size:13px;font-weight:600;">${esc(e.title)} ${e.status ? `<span class="badge badge-pending" style="font-size:9px;">${esc(e.status)}</span>` : ''}</div>
          ${e.detail ? `<div style="font-size:12px;color:var(--text-secondary);">${esc(e.detail)}</div>` : ''}
          <div style="font-size:11px;color:var(--text-muted);">${fmtWhen(e.at)}</div></div>${chevron}</div>`;
        }).join('') : '<div class="table-empty-text">No recorded history.</div>'}</div>
      </div>`;

    // Lazily enrich with live MET Discord roles + Roblox groups (never blocks the
    // timeline; the bot / Roblox calls can be a touch slow).
    api(`/api/hicomm/officer/${id}/met`).then(p => {
      const box = $('hc-met-profile');
      if (box) box.innerHTML = renderMetProfile(p);
    }).catch(() => {});
  };

  // Render the MET Discord roles + Roblox groups + MET rank card (shared by the
  // site-user 360 and the live subject lookup).
  function renderMetProfile(p) {
    if (!p) return '';
    const d = p.discord, groups = p.robloxGroups || [];
    const roleChips = (d && d.roles && d.roles.length)
      ? (window.renderDiscordRoles ? window.renderDiscordRoles(d.roles)
          : d.roles.map(r => `<span class="met-chip" style="${r.color ? 'border-color:' + esc(r.color) + ';color:' + esc(r.color) + ';' : ''}">${esc(r.name)}</span>`).join(' '))
      : '<span style="color:var(--text-muted);font-size:12px;">No MET server roles found.</span>';
    const metRank = p.metRank ? `<span class="met-chip" style="border-color:var(--blue);color:var(--blue);">MET ${esc(p.metRank.name)}</span>` : '';
    const groupRows = groups.length
      ? groups.map(g => `<tr><td>${esc(g.group.name)}</td><td style="color:var(--text-secondary);">${esc(g.role.name)}</td><td style="text-align:right;color:var(--text-muted);">${esc(String(g.role.rank))}</td></tr>`).join('')
      : '<tr><td colspan="3" class="table-empty-text" style="padding:10px;">No Roblox groups found (or Roblox not linked).</td></tr>';
    const dnote = d && d.inServer
      ? `In MET server${d.joinedAt ? ' · joined ' + fmtWhen(d.joinedAt) : ''}${d.timedOutUntil ? ' · <span style="color:var(--amber);">timed out</span>' : ''}`
      : 'Not in the MET Discord server.';
    return `<div class="panel glass fade-up" style="margin-bottom:16px;">
      <div class="panel-header"><div class="panel-title"><span class="panel-dot blue"></span>MET details (live)</div>
        <span style="font-size:11px;color:var(--text-muted);">${dnote}</span></div>
      <div style="padding:14px 18px;">
        <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;margin-bottom:6px;">MET Discord roles</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;">${metRank} ${roleChips}</div>
        <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;margin:16px 0 6px;">Roblox groups &amp; ranks</div>
        <div class="table-wrap"><table class="data-table"><thead><tr><th>Group</th><th>Rank</th><th style="text-align:right;">#</th></tr></thead><tbody>${groupRows}</tbody></table></div>
      </div></div>`;
  }

  // Open a live profile for someone who ISN'T a site user (found via the MET
  // Discord server or resolved on Roblox). Shows their MET roles + Roblox groups,
  // and offers to open the full 360 if a site account turns out to exist.
  window.hcOpenSubject = async function (kind, id) {
    const wrap = $('hc-off-detail');
    wrap.innerHTML = '<div class="panel glass"><div class="table-loading"><div class="spinner"></div></div></div>';
    const qs = kind === 'discord' ? 'discordId=' + encodeURIComponent(id) : 'robloxId=' + encodeURIComponent(id);
    let p; try { p = await api('/api/hicomm/subject?' + qs); } catch (e) { wrap.innerHTML = `<div class="panel glass"><div class="table-empty-text">${esc(e.message)}</div></div>`; return; }
    const s = p.subject || {};
    const openFull = s.siteUserId
      ? `<button class="btn btn-primary btn-sm" onclick="hcOfficer('${s.siteUserId}')"><i class="ti ti-history"></i> Open full 360</button>`
      : '<span style="font-size:11px;color:var(--text-muted);">No dashboard account — no site history.</span>';
    wrap.innerHTML = `
      <div class="panel glass fade-up" style="margin-bottom:16px;"><div style="padding:18px;display:flex;gap:16px;align-items:center;">
        ${s.avatar ? `<img src="${esc(s.avatar)}" style="width:64px;height:64px;border-radius:50%;">` : `<div style="width:64px;height:64px;border-radius:50%;background:#333;display:flex;align-items:center;justify-content:center;font-size:24px;">${esc((s.name || '?').slice(0,1).toUpperCase())}</div>`}
        <div style="flex:1;"><div style="font-size:20px;font-weight:800;">${esc(s.name)}</div>
        <div style="font-size:12px;color:var(--text-muted);">${s.robloxUsername ? 'Roblox: ' + esc(s.robloxUsername) : ''}${s.discordId ? ' · Discord id ' + esc(s.discordId) : ''}</div>
        <div style="font-size:11px;color:var(--amber);margin-top:4px;">Live lookup — pulled from the MET server + Roblox, not the site.</div></div>
        <div>${openFull}</div>
      </div></div>
      ${renderMetProfile(p)}`;
  };

  // Open the actual record behind a timeline point (ticket + its conversation,
  // IA case, tryout/patrol log, punishment, or audit entry).
  window.hcOpenEntity = async function (kind, id) {
    openModal('modal-hc-entity');
    const body = $('hc-entity-body'), footer = $('hc-entity-footer'), titleEl = $('hc-entity-title');
    titleEl.textContent = 'Detail';
    body.innerHTML = '<div class="table-loading"><div class="spinner"></div></div>'; footer.innerHTML = '';
    let d; try { d = await api(`/api/hicomm/entity/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`); }
    catch (e) { body.innerHTML = `<div class="table-empty"><div class="table-empty-text">${esc(e.message)}</div></div>`; return; }
    titleEl.textContent = d.title || 'Detail';

    const fmtVal = (v) => {
      if (v == null || v === '') return '—';
      if (v instanceof Object) return esc(JSON.stringify(v));
      // ISO-ish date → friendly
      if (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v)) return esc(fmtWhen(v));
      return esc(String(v));
    };
    const rows = (d.fields || []).map(([k, v]) =>
      `<div style="display:flex;gap:10px;padding:7px 0;border-bottom:1px solid var(--border,#2a2a2a);"><div style="min-width:130px;color:var(--text-muted);font-size:12px;">${esc(k)}</div><div style="font-size:13px;flex:1;">${fmtVal(v)}</div></div>`).join('');

    let extra = '';
    if (d.status) extra += `<div style="margin-bottom:12px;"><span class="badge badge-pending"><span class="badge-dot"></span>${esc(d.status)}</span></div>`;
    // Ticket intake answers
    if (Array.isArray(d.intake) && d.intake.length) {
      extra += `<div style="margin-top:14px;font-weight:600;font-size:12px;color:var(--text-muted);text-transform:uppercase;">Intake</div>` +
        d.intake.map(q => `<div style="margin-top:8px;font-size:13px;"><div style="color:var(--text-secondary);">${esc(q.prompt || '')}</div><div>${esc(q.answer || '—')}</div></div>`).join('');
    }
    // Conversation / case actions
    if (Array.isArray(d.messages) && d.messages.length) {
      extra += `<div style="margin-top:16px;font-weight:600;font-size:12px;color:var(--text-muted);text-transform:uppercase;">${kind === 'ticket' ? 'Conversation' : 'Activity'}</div>` +
        `<div style="margin-top:8px;display:flex;flex-direction:column;gap:8px;max-height:260px;overflow:auto;">` +
        d.messages.map(m => `<div style="border:1px solid var(--border,#2a2a2a);border-radius:8px;padding:8px 10px;">
          <div style="font-size:11px;color:var(--text-muted);">${esc(m.author || '—')}${m.kind ? ' · ' + esc(m.kind) : ''} · ${esc(fmtWhen(m.at))}</div>
          <div style="font-size:13px;margin-top:3px;white-space:pre-wrap;">${esc(m.body || '')}</div></div>`).join('') + `</div>`;
    }
    // Tryout attendees
    if (Array.isArray(d.attendees) && d.attendees.length) {
      extra += `<div class="table-wrap" style="margin-top:14px;"><table class="data-table"><thead><tr><th>Attendee</th><th>Result</th><th>Strikes</th></tr></thead><tbody>` +
        d.attendees.map(a => `<tr><td>${esc(a.username || 'Unknown')}</td><td>${esc(a.result || 'PENDING')}</td><td>${a.strikes || 0}</td></tr>`).join('') + `</tbody></table></div>`;
    }
    // Patrol raw content + images
    if (d.raw) extra += `<div style="margin-top:14px;font-size:12px;white-space:pre-wrap;background:var(--surface,#161616);border-radius:8px;padding:10px;">${esc(d.raw)}</div>`;
    if (Array.isArray(d.images) && d.images.length) {
      extra += `<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;">` +
        d.images.map(src => `<a href="${esc(src)}" target="_blank" rel="noopener"><img src="${esc(src)}" style="max-width:120px;max-height:120px;border-radius:8px;"></a>`).join('') + `</div>`;
    }
    // Audit metadata
    if (d.metadata) extra += `<div style="margin-top:14px;font-size:12px;color:var(--text-muted);">Metadata</div><pre style="font-size:11px;background:var(--surface,#161616);border-radius:8px;padding:10px;overflow:auto;">${esc(JSON.stringify(d.metadata, null, 2))}</pre>`;

    body.innerHTML = extra + `<div>${rows}</div>`;
    const link = d.link ? `<a class="btn btn-primary" href="${esc(d.link)}" target="_blank" rel="noopener"><i class="ti ti-external-link"></i> Open full record</a>` : '';
    footer.innerHTML = `<button class="btn btn-ghost" onclick="closeModal('modal-hc-entity')">Close</button>${link}`;
  };

  window.hcForceReauth = async function (id, name) {
    if (!(await uiConfirm(`Force ${name || 'this officer'} to sign in again on every device?`))) return;
    try { const r = await api(`/api/hicomm/officer/${id}/force-reauth`, { method: 'POST' }); showToast(`Done — ${r.killed} session(s) killed`, 'success'); }
    catch (e) { showToast(e.message, 'error'); }
  };
  window.hcViewAs = async function (id) {
    const box = $('hc-viewas');
    box.innerHTML = '<div class="panel glass" style="margin-bottom:16px;"><div class="table-loading"><div class="spinner"></div></div></div>';
    let p; try { p = await api(`/api/hicomm/officer/${id}/access-preview`); } catch (e) { box.innerHTML = `<div class="panel glass" style="margin-bottom:16px;"><div class="table-empty-text" style="padding:14px;">${esc(e.message)}</div></div>`; return; }
    const divs = (p.divisions || []).map(d => `${esc(d.division)}${d.rankName ? ' · ' + esc(d.rankName) : ''}${d.tier === 'LEAD' ? ' (lead)' : ''}`).join('<br>') || '—';
    const standing = p.standing.blacklisted ? '<span class="badge badge-denied"><span class="badge-dot"></span>Blacklisted</span>' : (p.standing.mustReauth ? '<span class="badge badge-pending"><span class="badge-dot"></span>Must re-auth</span>' : '<span class="badge badge-approved"><span class="badge-dot"></span>Good standing</span>');
    box.innerHTML = `<div class="panel glass fade-up" style="margin-bottom:16px;border-left:3px solid var(--blue);"><div class="panel-header"><div class="panel-title"><span class="panel-dot blue"></span>Viewing as ${esc(p.officer.name)} — read only</div>
      <button class="btn btn-ghost btn-sm" onclick="document.getElementById('hc-viewas').innerHTML=''"><i class="ti ti-x"></i></button></div>
      <div style="padding:14px 18px;display:grid;grid-template-columns:1fr 1fr;gap:14px;font-size:13px;">
        <div><div style="color:var(--text-muted);font-size:11px;text-transform:uppercase;">Site role</div>${esc(p.role)}${p.metHicomm ? ' · MET HICOMM' : ''}</div>
        <div><div style="color:var(--text-muted);font-size:11px;text-transform:uppercase;">Standing</div>${standing}</div>
        <div><div style="color:var(--text-muted);font-size:11px;text-transform:uppercase;">Divisions &amp; rank</div>${divs}</div>
        <div><div style="color:var(--text-muted);font-size:11px;text-transform:uppercase;">Can access</div>${p.pages.map(x => `<div>• ${esc(x)}</div>`).join('')}</div>
      </div></div>`;
  };

  // ── Audit trail ──
  let auditT = null;
  window.hcAuditDebounced = function () { clearTimeout(auditT); auditT = setTimeout(hcLoadAudit, 250); };
  window.hcLoadAudit = async function () {
    const cat = $('hc-audit-cat').value, q = $('hc-audit-q').value.trim();
    const tb = $('hc-audit-tbody');
    tb.innerHTML = '<tr><td colspan="5" class="table-loading"><div class="spinner"></div></td></tr>';
    let rows; try { rows = await api(`/api/hicomm/audit?category=${encodeURIComponent(cat)}&q=${encodeURIComponent(q)}`); } catch (e) { tb.innerHTML = `<tr><td colspan="5" class="table-empty-text">${esc(e.message)}</td></tr>`; return; }
    tb.innerHTML = rows.length ? rows.map(a => {
      const [ic, col] = CAT_ICON[a.category] || ['ti-point', '#888'];
      return `<tr><td style="white-space:nowrap;font-size:12px;color:var(--text-muted);">${ago(a.createdAt)}</td>
        <td><span style="color:${col};"><i class="ti ${ic}"></i> ${esc(a.category)}</span></td>
        <td><span class="mono" style="font-size:11px;">${esc(a.action)}</span></td>
        <td>${esc(a.actorName || 'System')}</td><td>${esc(a.summary || '')}</td></tr>`;
    }).join('') : '<tr><td colspan="5" class="table-empty"><div class="table-empty-text">No matching actions.</div></td></tr>';
  };

  // ── Game logs ──
  const GL_ICON = { ADONIS: ['ti-shield-bolt', '#f59e0b'], JOIN: ['ti-login', '#2ed896'], LEAVE: ['ti-logout', '#8b93a1'], CHAT: ['ti-message', '#3b82f6'] };
  window.hcLoadGameLogs = async function () {
    const src = $('hc-gl-source') ? $('hc-gl-source').value : '';
    const q = $('hc-gl-q') ? $('hc-gl-q').value.trim() : '';
    const tb = $('hc-gl-tbody');
    if (!tb) return;
    tb.innerHTML = '<tr><td colspan="6" class="table-loading"><div class="spinner"></div></td></tr>';
    let rows; try { rows = await api(`/api/hicomm/game-logs?source=${encodeURIComponent(src)}&q=${encodeURIComponent(q)}`); } catch (e) { tb.innerHTML = `<tr><td colspan="6" class="table-empty-text">${esc(e.message)}</td></tr>`; return; }
    tb.innerHTML = rows.length ? rows.map(g => {
      const [ic, col] = GL_ICON[g.source] || ['ti-point', '#888'];
      return `<tr><td style="white-space:nowrap;font-size:12px;color:var(--text-muted);">${ago(g.createdAt)}</td>
        <td><span style="color:${col};"><i class="ti ${ic}"></i> ${esc(g.source)}</span></td>
        <td>${esc(g.actor || '—')}</td>
        <td>${g.action ? `<span class="mono" style="font-size:11px;">${esc(g.action)}</span>` : '—'}</td>
        <td>${esc(g.target || '—')}</td>
        <td style="max-width:360px;">${esc(g.message || '')}</td></tr>`;
    }).join('') : '<tr><td colspan="6" class="table-empty"><div class="table-empty-text">No game logs yet.</div></td></tr>';
  };
  let glT = null;
  document.addEventListener('input', (e) => { if (e.target && e.target.id === 'hc-gl-q') { clearTimeout(glT); glT = setTimeout(hcLoadGameLogs, 250); } });

  // ── Init ──
  async function init() {
    wireNav();
    try {
      const c = await api('/api/hicomm/context');
      const parts = [];
      if (c.metRank) parts.push(`MET ${c.metRank.name}`);
      if (c.minRank != null) parts.push(`HICOMM ≥ ${c.minRank}`);
      $('hc-rank').textContent = parts.join(' · ');
    } catch (e) {}
    hcLoadIntegrity();  // warm the badge
    startCC();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
