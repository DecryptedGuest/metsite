// server-control.js
// The developer "Server Control" panel. Pick any server the bot is in, then
// manage its channels, roles, members, emojis and messages, or send a message
// or DM. Every call goes through /api/dev/control (DEVELOPER-gated) via the
// shared api() helper; every error surfaces through showToast.
//
// The panel builds its own modals on the fly using the site's existing
// .modal-overlay / .modal markup, so it needs no dedicated HTML beyond a single
// #sc-root container in the section.

(function () {
  'use strict';

  const SC = { guildId: null, guild: null, tab: 'overview', channelsCache: null, rolesCache: null, permCatalogue: null };

  const esc = (s) => (window.escapeHtml ? window.escapeHtml(s) : String(s == null ? '' : s));
  const scApi = (path, opts) => api('/api/dev/control' + path, opts);
  const toast = (m, t) => (window.showToast ? window.showToast(m, t) : console.log(m));

  const TYPE_ICON = {
    text: 'ti-hash', voice: 'ti-volume', category: 'ti-folder', announcement: 'ti-speakerphone',
    stage: 'ti-microphone-2', forum: 'ti-messages', media: 'ti-photo', thread: 'ti-message-2',
  };

  // ── One-time styles, scoped to sc- classes ──────────────────────
  function ensureStyles() {
    if (document.getElementById('sc-styles')) return;
    const css = `
    .sc-guild-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;}
    .sc-guild-card{display:flex;align-items:center;gap:12px;padding:14px;border:1px solid var(--border,rgba(255,255,255,.1));border-radius:12px;background:var(--panel-2,rgba(255,255,255,.03));cursor:pointer;transition:.15s;text-align:left;width:100%;}
    .sc-guild-card:hover{border-color:#f5c518;transform:translateY(-2px);}
    .sc-guild-ic{width:44px;height:44px;border-radius:12px;object-fit:cover;flex:none;background:rgba(255,255,255,.06);display:flex;align-items:center;justify-content:center;font-weight:800;color:#f5c518;}
    .sc-guild-meta{min-width:0;}
    .sc-guild-name{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .sc-guild-sub{font-size:11px;color:var(--text-muted);}
    .sc-tabs{display:flex;gap:6px;flex-wrap:wrap;margin:14px 0;}
    .sc-tab{padding:8px 14px;border-radius:9px;border:1px solid var(--border,rgba(255,255,255,.1));background:transparent;color:var(--text-muted);cursor:pointer;font-weight:600;font-size:13px;}
    .sc-tab.active{background:#f5c518;color:#111;border-color:#f5c518;}
    .sc-stat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;}
    .sc-stat{border:1px solid var(--border,rgba(255,255,255,.1));border-radius:10px;padding:12px;background:var(--panel-2,rgba(255,255,255,.03));}
    .sc-stat .n{font-size:22px;font-weight:800;}
    .sc-stat .l{font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;}
    .sc-perm-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:6px;margin-top:8px;}
    .sc-perm{font-size:12px;display:flex;align-items:center;gap:6px;}
    .sc-cap-ok{color:#2ed896;} .sc-cap-no{color:#f04f5e;}
    .sc-swatch{display:inline-block;width:12px;height:12px;border-radius:3px;vertical-align:middle;margin-right:6px;}
    .sc-emoji-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:10px;}
    .sc-emoji{border:1px solid var(--border,rgba(255,255,255,.1));border-radius:10px;padding:10px;text-align:center;background:var(--panel-2,rgba(255,255,255,.03));}
    .sc-emoji img{width:40px;height:40px;object-fit:contain;}
    .sc-emoji .nm{font-size:10px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:4px;}
    .sc-form-row{margin-bottom:12px;} .sc-form-row label{display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--text-muted);}
    .sc-checks{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:4px;max-height:260px;overflow:auto;border:1px solid var(--border,rgba(255,255,255,.1));border-radius:8px;padding:8px;}
    .sc-checks label{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:500;color:var(--text);}
    .sc-msg{border-bottom:1px solid var(--border,rgba(255,255,255,.08));padding:8px 0;display:flex;gap:8px;justify-content:space-between;}
    .sc-msg .who{font-weight:700;font-size:12px;} .sc-msg .body{font-size:13px;white-space:pre-wrap;word-break:break-word;}
    .sc-msg .t{font-size:10px;color:var(--text-muted);}
    .sc-chip{display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:999px;border:1px solid var(--border,rgba(255,255,255,.14));font-size:12px;margin:3px;}
    .sc-chip button{background:none;border:none;color:#f04f5e;cursor:pointer;font-size:13px;line-height:1;}
    .sc-note{font-size:12px;color:var(--text-muted);margin:6px 0;}
    `;
    const st = document.createElement('style');
    st.id = 'sc-styles'; st.textContent = css;
    document.head.appendChild(st);
  }

  // ── A reusable modal built on the site's overlay markup ─────────
  function scModal({ title, icon, body, footer, wide }) {
    document.getElementById('sc-modal')?.remove();
    const ov = document.createElement('div');
    ov.className = 'modal-overlay'; ov.id = 'sc-modal';
    ov.innerHTML = `<div class="modal"${wide ? ' style="max-width:720px;"' : ''}>
      <div class="modal-header">
        <div class="modal-title"><i class="ti ${icon || 'ti-settings'}" style="font-size:18px;"></i> ${esc(title)}</div>
        <button class="modal-close" aria-label="Close" onclick="closeModal('sc-modal')"><i class="ti ti-x"></i></button>
      </div>
      <div class="modal-body">${body}</div>
      <div class="modal-footer">${footer || ''}</div>
    </div>`;
    document.body.appendChild(ov);
    if (window.openModal) window.openModal('sc-modal'); else ov.classList.add('open');
    return ov;
  }
  function closeScModal() { if (window.closeModal) window.closeModal('sc-modal'); const m = document.getElementById('sc-modal'); if (m) setTimeout(() => m.remove(), 250); }
  window.scCloseModal = closeScModal;

  // ── Entry point (called by the dashboard loader) ────────────────
  window.loadServerControl = function () {
    ensureStyles();
    const root = document.getElementById('sc-root');
    if (!root) return;
    if (!SC.guildId) renderPicker(root);
    else renderControl(root);
  };

  // ── Server picker ───────────────────────────────────────────────
  async function renderPicker(root) {
    root.innerHTML = `<div class="panel glass fade-up">
      <div class="panel-header">
        <div class="panel-title"><span class="panel-dot" style="background:#f5c518;box-shadow:0 0 7px #f5c518;"></span>Select a server</div>
        <button class="btn btn-ghost btn-sm" onclick="loadServerControl()"><i class="ti ti-refresh"></i> Refresh</button>
      </div>
      <div id="sc-guilds" class="sc-guild-grid"><div class="table-loading"><div class="spinner"></div></div></div>
    </div>`;
    try {
      const { guilds } = await scApi('/guilds');
      const box = document.getElementById('sc-guilds');
      if (!guilds || !guilds.length) { box.innerHTML = '<p class="sc-note">The bot is not in any servers.</p>'; return; }
      box.innerHTML = guilds.map(g => {
        const ic = g.icon
          ? `<img class="sc-guild-ic" src="${esc(g.icon)}" alt="">`
          : `<span class="sc-guild-ic">${esc((g.name || '?').slice(0, 1).toUpperCase())}</span>`;
        return `<button class="sc-guild-card" data-act="pick" data-id="${esc(g.id)}">
          ${ic}
          <span class="sc-guild-meta">
            <span class="sc-guild-name">${esc(g.name)}</span>
            <span class="sc-guild-sub">${g.memberCount != null ? g.memberCount + ' members' : ''}${g.primary ? ' · PRIMARY' : ''}</span>
          </span>
        </button>`;
      }).join('');
      box.onclick = (e) => {
        const b = e.target.closest('[data-act="pick"]'); if (!b) return;
        SC.guildId = b.dataset.id; SC.tab = 'overview'; SC.channelsCache = SC.rolesCache = null;
        renderControl(root);
      };
    } catch (e) { toast(e.message, 'error'); }
  }

  // ── Control shell ───────────────────────────────────────────────
  async function renderControl(root) {
    const tabs = ['overview', 'channels', 'roles', 'members', 'emojis', 'send'];
    root.innerHTML = `<div class="panel glass fade-up">
      <div class="panel-header">
        <div class="panel-title" style="display:flex;align-items:center;gap:10px;">
          <button class="btn btn-ghost btn-sm" data-act="back"><i class="ti ti-arrow-left"></i></button>
          <span id="sc-title">Loading…</span>
        </div>
        <span style="font-size:11px;background:rgba(245,197,24,0.12);color:#f5c518;border:1px solid rgba(245,197,24,0.3);border-radius:4px;padding:0.3rem 0.8rem;font-weight:700;letter-spacing:0.08em;">DEVELOPER ONLY</span>
      </div>
      <div id="sc-capbanner"></div>
      <div class="sc-tabs">${tabs.map(t => `<button class="sc-tab${t === SC.tab ? ' active' : ''}" data-tab="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
      <div id="sc-content"><div class="table-loading"><div class="spinner"></div></div></div>
    </div>`;
    root.querySelector('[data-act="back"]').onclick = () => { SC.guildId = null; renderPicker(root); };
    root.querySelectorAll('.sc-tab').forEach(b => b.onclick = () => { SC.tab = b.dataset.tab; renderControl(root); });

    // Header + capability banner from the overview (also caches the guild).
    try {
      SC.guild = await scApi('/guilds/' + SC.guildId + '/overview');
      document.getElementById('sc-title').textContent = SC.guild.name;
      const b = SC.guild.bot || {};
      if (!b.isAdmin) {
        const missing = [['manageChannels', 'channels'], ['manageRoles', 'roles'], ['ban', 'ban'], ['kick', 'kick'], ['timeout', 'timeout'], ['manageMessages', 'messages'], ['manageEmojis', 'emojis']]
          .filter(([k]) => !b[k]).map(([, l]) => l);
        if (missing.length) {
          document.getElementById('sc-capbanner').innerHTML =
            `<div class="sc-note" style="color:#f5b730;"><i class="ti ti-alert-triangle"></i> The bot is not an administrator here. It may not be able to manage: ${esc(missing.join(', '))}. Move its role higher or grant the permissions.</div>`;
        }
      }
    } catch (e) { document.getElementById('sc-title').textContent = 'Server ' + SC.guildId; toast(e.message, 'error'); }

    const content = document.getElementById('sc-content');
    const render = { overview: renderOverview, channels: renderChannels, roles: renderRoles, members: renderMembers, emojis: renderEmojis, send: renderSend }[SC.tab];
    if (render) render(content);
  }

  // ── Overview ────────────────────────────────────────────────────
  function renderOverview(box) {
    const g = SC.guild || {};
    const b = g.bot || {};
    const stat = (n, l) => `<div class="sc-stat"><div class="n">${esc(n)}</div><div class="l">${esc(l)}</div></div>`;
    const cap = (on, l) => `<div class="sc-perm"><i class="ti ${on ? 'ti-check sc-cap-ok' : 'ti-x sc-cap-no'}"></i> ${esc(l)}</div>`;
    const created = g.createdTimestamp ? new Date(g.createdTimestamp).toLocaleDateString() : '·';
    box.innerHTML = `
      <div class="sc-stat-grid" style="margin-bottom:14px;">
        ${stat(g.memberCount != null ? g.memberCount : '·', 'Members')}
        ${stat(g.channelCount != null ? g.channelCount : '·', 'Channels')}
        ${stat(g.roleCount != null ? g.roleCount : '·', 'Roles')}
        ${stat(g.emojiCount != null ? g.emojiCount : '·', 'Emojis')}
        ${stat('T' + (g.boostTier != null ? g.boostTier : 0), (g.boostCount || 0) + ' boosts')}
      </div>
      <div class="sc-note">Owner: <strong>${esc(g.owner ? (g.owner.displayName || g.owner.tag) : 'unknown')}</strong> · Created ${esc(created)} · ID <code>${esc(g.id)}</code>${g.vanity ? ' · /' + esc(g.vanity) : ''}</div>
      <div style="font-weight:700;margin-top:14px;">What the bot can do here</div>
      <div class="sc-perm-grid">
        ${cap(b.isAdmin, 'Administrator')}
        ${cap(b.manageChannels, 'Manage channels')}
        ${cap(b.manageRoles, 'Manage roles')}
        ${cap(b.kick, 'Kick members')}
        ${cap(b.ban, 'Ban members')}
        ${cap(b.timeout, 'Time out members')}
        ${cap(b.manageMessages, 'Manage messages')}
        ${cap(b.manageEmojis, 'Manage emojis')}
        ${cap(b.manageNicknames, 'Manage nicknames')}
      </div>`;
  }

  // ── Channels ────────────────────────────────────────────────────
  async function renderChannels(box) {
    box.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
      <div class="sc-note">Every channel in this server.</div>
      <button class="btn btn-primary btn-sm" data-act="new-channel"><i class="ti ti-plus"></i> New channel</button>
    </div>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>Channel</th><th>Type</th><th>Settings</th><th style="text-align:right;">Actions</th></tr></thead>
    <tbody id="sc-chan-body"><tr><td colspan="4" class="table-loading"><div class="spinner"></div></td></tr></tbody></table></div>`;
    box.querySelector('[data-act="new-channel"]').onclick = () => channelModal(null);
    try {
      const { channels } = await scApi('/guilds/' + SC.guildId + '/channels');
      SC.channelsCache = channels;
      const body = document.getElementById('sc-chan-body');
      if (!channels.length) { body.innerHTML = emptyRowSc(4, 'No channels.'); return; }
      body.innerHTML = channels.map(c => {
        const indent = c.type !== 'category' && c.parentId ? 'padding-left:22px;' : '';
        const settings = [c.nsfw ? 'NSFW' : '', c.slowmode ? c.slowmode + 's slow' : ''].filter(Boolean).join(' · ') || '·';
        const msgBtn = c.textLike ? `<button class="btn btn-ghost btn-sm" data-act="msgs" data-id="${c.id}" data-name="${esc(c.name)}"><i class="ti ti-messages"></i></button>` : '';
        return `<tr>
          <td style="${indent}"><i class="ti ${TYPE_ICON[c.type] || 'ti-hash'}"></i> ${esc(c.name)}</td>
          <td>${esc(c.type)}</td>
          <td>${esc(settings)}</td>
          <td style="text-align:right;white-space:nowrap;">
            ${msgBtn}
            <button class="btn btn-ghost btn-sm" data-act="edit" data-id="${c.id}"><i class="ti ti-edit"></i></button>
            <button class="btn btn-ghost btn-sm" data-act="del" data-id="${c.id}" data-name="${esc(c.name)}"><i class="ti ti-trash" style="color:#f04f5e;"></i></button>
          </td></tr>`;
      }).join('');
      body.onclick = onChannelAction;
    } catch (e) { toast(e.message, 'error'); }
  }

  async function onChannelAction(e) {
    const btn = e.target.closest('[data-act]'); if (!btn) return;
    const id = btn.dataset.id, act = btn.dataset.act;
    if (act === 'edit') { const c = (SC.channelsCache || []).find(x => x.id === id); channelModal(c); }
    else if (act === 'del') {
      if (!await uiConfirm(`Delete #${btn.dataset.name}? This cannot be undone.`, { danger: true, confirmText: 'Delete' })) return;
      try { await scApi(`/guilds/${SC.guildId}/channels/${id}`, { method: 'DELETE' }); toast('Channel deleted', 'success'); renderChannels(document.getElementById('sc-content')); }
      catch (err) { toast(err.message, 'error'); }
    } else if (act === 'msgs') { messagesModal(id, btn.dataset.name); }
  }

  function channelModal(c) {
    const cats = (SC.channelsCache || []).filter(x => x.type === 'category');
    const isEdit = !!c;
    const body = `
      <div class="sc-form-row"><label>Name</label><input class="form-control" id="sc-ch-name" value="${isEdit ? esc(c.name) : ''}" placeholder="general"></div>
      ${isEdit ? '' : `<div class="sc-form-row"><label>Type</label><select class="form-control" id="sc-ch-type">
        <option value="text">Text</option><option value="voice">Voice</option><option value="category">Category</option>
        <option value="announcement">Announcement</option><option value="stage">Stage</option><option value="forum">Forum</option></select></div>`}
      <div class="sc-form-row"><label>Category</label><select class="form-control" id="sc-ch-parent"><option value="">None</option>
        ${cats.map(x => `<option value="${x.id}"${isEdit && c.parentId === x.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>
      <div class="sc-form-row"><label>Topic</label><input class="form-control" id="sc-ch-topic" value="${isEdit && c.topic ? esc(c.topic) : ''}"></div>
      <div class="sc-form-row" style="display:flex;gap:16px;align-items:center;">
        <label style="display:flex;gap:6px;align-items:center;"><input type="checkbox" id="sc-ch-nsfw"${isEdit && c.nsfw ? ' checked' : ''}> NSFW</label>
        <span>Slowmode (s): <input class="form-control" id="sc-ch-slow" type="number" min="0" max="21600" value="${isEdit ? (c.slowmode || 0) : 0}" style="width:90px;"></span>
      </div>`;
    scModal({
      title: isEdit ? 'Edit channel' : 'New channel', icon: 'ti-hash', body,
      footer: `<button class="btn btn-ghost" onclick="scCloseModal()">Cancel</button><button class="btn btn-primary" id="sc-ch-save">${isEdit ? 'Save' : 'Create'}</button>`,
    });
    document.getElementById('sc-ch-save').onclick = async () => {
      const payload = {
        name: document.getElementById('sc-ch-name').value.trim(),
        parentId: document.getElementById('sc-ch-parent').value || undefined,
        topic: document.getElementById('sc-ch-topic').value,
        nsfw: document.getElementById('sc-ch-nsfw').checked,
        slowmode: parseInt(document.getElementById('sc-ch-slow').value, 10) || 0,
      };
      try {
        if (isEdit) await scApi(`/guilds/${SC.guildId}/channels/${c.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
        else { payload.type = document.getElementById('sc-ch-type').value; await scApi(`/guilds/${SC.guildId}/channels`, { method: 'POST', body: JSON.stringify(payload) }); }
        toast(isEdit ? 'Channel saved' : 'Channel created', 'success'); closeScModal(); renderChannels(document.getElementById('sc-content'));
      } catch (err) { toast(err.message, 'error'); }
    };
  }

  async function messagesModal(cid, name) {
    scModal({ title: '#' + name, icon: 'ti-messages', wide: true,
      body: `<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
        <button class="btn btn-danger btn-sm" id="sc-purge"><i class="ti ti-eraser"></i> Purge recent…</button>
        <span class="sc-note" id="sc-msg-note"></span></div>
        <div id="sc-msg-list"><div class="table-loading"><div class="spinner"></div></div></div>`,
      footer: `<button class="btn btn-ghost" onclick="scCloseModal()">Close</button>` });
    document.getElementById('sc-purge').onclick = async () => {
      const n = await uiPrompt('How many recent messages to remove? (1 to 100, under 14 days old)', { value: '10' });
      if (!n) return;
      try { const r = await scApi(`/guilds/${SC.guildId}/channels/${cid}/purge`, { method: 'POST', body: JSON.stringify({ count: parseInt(n, 10) }) }); toast(`Purged ${r.deleted}`, 'success'); loadMsgs(); }
      catch (err) { toast(err.message, 'error'); }
    };
    async function loadMsgs() {
      const list = document.getElementById('sc-msg-list');
      try {
        const r = await scApi(`/guilds/${SC.guildId}/channels/${cid}/messages?limit=25`);
        document.getElementById('sc-msg-note').textContent = r.contentReadable ? '' : 'Message text is hidden: the bot lacks the Message Content intent. You can still delete by author and time.';
        if (!r.messages.length) { list.innerHTML = '<p class="sc-note">No messages.</p>'; return; }
        list.innerHTML = r.messages.map(m => `<div class="sc-msg">
          <div style="min-width:0;">
            <div class="who">${esc(m.authorTag)}${m.authorBot ? ' <span class="sc-note">[bot]</span>' : ''} <span class="t">${new Date(m.createdTimestamp).toLocaleString()}</span></div>
            <div class="body">${esc(m.content) || '<span class="sc-note">(no text' + (m.embeds ? ', ' + m.embeds + ' embed(s)' : '') + (m.attachments.length ? ', ' + m.attachments.length + ' attachment(s)' : '') + ')</span>'}</div>
          </div>
          <button class="btn btn-ghost btn-sm" data-mid="${m.id}"><i class="ti ti-trash" style="color:#f04f5e;"></i></button>
        </div>`).join('');
        list.onclick = async (e) => {
          const b = e.target.closest('[data-mid]'); if (!b) return;
          if (!await uiConfirm('Delete this message?', { danger: true, confirmText: 'Delete' })) return;
          try { await scApi(`/guilds/${SC.guildId}/channels/${cid}/messages/${b.dataset.mid}`, { method: 'DELETE' }); toast('Deleted', 'success'); loadMsgs(); }
          catch (err) { toast(err.message, 'error'); }
        };
      } catch (err) { list.innerHTML = `<p class="sc-note" style="color:#f04f5e;">${esc(err.message)}</p>`; }
    }
    loadMsgs();
  }

  // ── Roles ───────────────────────────────────────────────────────
  async function renderRoles(box) {
    box.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
      <div class="sc-note">Roles, highest first. The @everyone role cannot be deleted.</div>
      <button class="btn btn-primary btn-sm" data-act="new-role"><i class="ti ti-plus"></i> New role</button>
    </div>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>Role</th><th>Perms</th><th>Flags</th><th style="text-align:right;">Actions</th></tr></thead>
    <tbody id="sc-role-body"><tr><td colspan="4" class="table-loading"><div class="spinner"></div></td></tr></tbody></table></div>`;
    box.querySelector('[data-act="new-role"]').onclick = () => roleModal(null);
    try {
      const { roles } = await scApi('/guilds/' + SC.guildId + '/roles');
      SC.rolesCache = roles;
      const body = document.getElementById('sc-role-body');
      body.innerHTML = roles.map(r => {
        const admin = r.permissions.includes('Administrator');
        const flags = [r.hoist ? 'hoisted' : '', r.mentionable ? 'mentionable' : '', r.managed ? 'managed' : '', admin ? 'ADMIN' : ''].filter(Boolean).join(' · ') || '·';
        const acts = r.isEveryone
          ? `<button class="btn btn-ghost btn-sm" data-act="edit" data-id="${r.id}"><i class="ti ti-edit"></i></button>`
          : `<button class="btn btn-ghost btn-sm" data-act="edit" data-id="${r.id}"><i class="ti ti-edit"></i></button>
             <button class="btn btn-ghost btn-sm" data-act="del" data-id="${r.id}" data-name="${esc(r.name)}"${r.managed ? ' disabled' : ''}><i class="ti ti-trash" style="color:#f04f5e;"></i></button>`;
        return `<tr>
          <td><span class="sc-swatch" style="background:${esc(r.color)};"></span>${esc(r.name)}${r.isEveryone ? ' <span class="sc-note">(everyone)</span>' : ''}</td>
          <td>${admin ? '<strong style="color:#f5b730;">All</strong>' : r.permissions.length}</td>
          <td>${esc(flags)}</td>
          <td style="text-align:right;white-space:nowrap;">${acts}</td></tr>`;
      }).join('');
      body.onclick = onRoleAction;
    } catch (e) { toast(e.message, 'error'); }
  }

  async function onRoleAction(e) {
    const btn = e.target.closest('[data-act]'); if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.act === 'edit') { const r = (SC.rolesCache || []).find(x => x.id === id); roleModal(r); }
    else if (btn.dataset.act === 'del') {
      if (!await uiConfirm(`Delete the role "${btn.dataset.name}"?`, { danger: true, confirmText: 'Delete' })) return;
      try { await scApi(`/guilds/${SC.guildId}/roles/${id}`, { method: 'DELETE' }); toast('Role deleted', 'success'); renderRoles(document.getElementById('sc-content')); }
      catch (err) { toast(err.message, 'error'); }
    }
  }

  async function roleModal(r) {
    const isEdit = !!r;
    if (!SC.permCatalogue) { try { SC.permCatalogue = (await scApi('/permissions')).permissions; } catch (e) { SC.permCatalogue = []; } }
    const have = new Set(isEdit ? r.permissions : []);
    const checks = SC.permCatalogue.map(p => `<label><input type="checkbox" value="${p}"${have.has(p) ? ' checked' : ''}> ${esc(p)}</label>`).join('');
    const body = `
      <div class="sc-form-row"><label>Name</label><input class="form-control" id="sc-r-name" value="${isEdit ? esc(r.name) : ''}"></div>
      <div class="sc-form-row" style="display:flex;gap:20px;align-items:center;">
        <span>Colour <input type="color" id="sc-r-color" value="${isEdit ? esc(r.color) : '#99aab5'}"></span>
        <label style="display:flex;gap:6px;align-items:center;"><input type="checkbox" id="sc-r-hoist"${isEdit && r.hoist ? ' checked' : ''}> Display separately</label>
        <label style="display:flex;gap:6px;align-items:center;"><input type="checkbox" id="sc-r-ment"${isEdit && r.mentionable ? ' checked' : ''}> Mentionable</label>
      </div>
      <div class="sc-form-row"><label>Permissions</label><div class="sc-checks" id="sc-r-perms">${checks}</div></div>`;
    scModal({ title: isEdit ? 'Edit role' : 'New role', icon: 'ti-shield', wide: true, body,
      footer: `<button class="btn btn-ghost" onclick="scCloseModal()">Cancel</button><button class="btn btn-primary" id="sc-r-save">${isEdit ? 'Save' : 'Create'}</button>` });
    document.getElementById('sc-r-save').onclick = async () => {
      const permissions = [...document.querySelectorAll('#sc-r-perms input:checked')].map(i => i.value);
      const payload = {
        name: document.getElementById('sc-r-name').value.trim(),
        color: document.getElementById('sc-r-color').value,
        hoist: document.getElementById('sc-r-hoist').checked,
        mentionable: document.getElementById('sc-r-ment').checked,
        permissions,
      };
      try {
        if (isEdit) await scApi(`/guilds/${SC.guildId}/roles/${r.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
        else await scApi(`/guilds/${SC.guildId}/roles`, { method: 'POST', body: JSON.stringify(payload) });
        toast('Saved', 'success'); closeScModal(); renderRoles(document.getElementById('sc-content'));
      } catch (err) { toast(err.message, 'error'); }
    };
  }

  // ── Members ─────────────────────────────────────────────────────
  function renderMembers(box) {
    box.innerHTML = `<div style="display:flex;gap:8px;margin-bottom:10px;">
      <input class="form-control" id="sc-mem-q" placeholder="Search members by name or ID…" style="flex:1;">
      <button class="btn btn-primary btn-sm" id="sc-mem-go"><i class="ti ti-search"></i> Search</button>
      <button class="btn btn-ghost btn-sm" id="sc-bans"><i class="ti ti-hammer"></i> Bans</button>
    </div>
    <div id="sc-mem-results"><p class="sc-note">Search for a member to manage them.</p></div>`;
    const go = () => memberSearch(document.getElementById('sc-mem-q').value);
    document.getElementById('sc-mem-go').onclick = go;
    document.getElementById('sc-mem-q').onkeydown = (e) => { if (e.key === 'Enter') go(); };
    document.getElementById('sc-bans').onclick = bansView;
  }

  async function memberSearch(q) {
    const box = document.getElementById('sc-mem-results');
    box.innerHTML = '<div class="table-loading"><div class="spinner"></div></div>';
    try {
      const { members } = await scApi(`/guilds/${SC.guildId}/members?search=${encodeURIComponent(q || '')}`);
      if (!members.length) { box.innerHTML = '<p class="sc-note">No members matched.</p>'; return; }
      box.innerHTML = `<div class="table-wrap"><table class="data-table"><thead><tr><th>Member</th><th>ID</th><th style="text-align:right;">Actions</th></tr></thead><tbody>${members.map(m => `
        <tr><td><i class="ti ti-user"></i> ${esc(m.displayName || m.username)}${m.timedOutUntil && m.timedOutUntil > Date.now() ? ' <span class="sc-note" style="color:#f5b730;">(timed out)</span>' : ''}</td>
        <td><code>${esc(m.id)}</code></td>
        <td style="text-align:right;white-space:nowrap;">
          <button class="btn btn-ghost btn-sm" data-act="roles" data-id="${m.id}"><i class="ti ti-shield"></i></button>
          <button class="btn btn-ghost btn-sm" data-act="nick" data-id="${m.id}"><i class="ti ti-signature"></i></button>
          <button class="btn btn-ghost btn-sm" data-act="timeout" data-id="${m.id}"><i class="ti ti-clock-pause"></i></button>
          <button class="btn btn-ghost btn-sm" data-act="kick" data-id="${m.id}"><i class="ti ti-door-exit"></i></button>
          <button class="btn btn-ghost btn-sm" data-act="ban" data-id="${m.id}"><i class="ti ti-hammer" style="color:#f04f5e;"></i></button>
        </td></tr>`).join('')}</tbody></table></div>`;
      box.onclick = onMemberAction;
    } catch (e) { box.innerHTML = `<p class="sc-note" style="color:#f04f5e;">${esc(e.message)}</p>`; }
  }

  async function onMemberAction(e) {
    const btn = e.target.closest('[data-act]'); if (!btn) return;
    const id = btn.dataset.id, act = btn.dataset.act;
    try {
      if (act === 'nick') {
        const nick = await uiPrompt('New nickname (leave blank to reset):', { value: '' });
        if (nick === null) return;
        await scApi(`/guilds/${SC.guildId}/members/${id}`, { method: 'PATCH', body: JSON.stringify({ nickname: nick }) });
        toast('Nickname updated', 'success');
      } else if (act === 'kick') {
        if (!await uiConfirm('Kick this member?', { danger: true, confirmText: 'Kick' })) return;
        const reason = await uiPrompt('Reason (optional):', { value: '' });
        await scApi(`/guilds/${SC.guildId}/members/${id}/kick`, { method: 'POST', body: JSON.stringify({ reason: reason || '' }) });
        toast('Member kicked', 'success');
      } else if (act === 'ban') {
        if (!await uiConfirm('Ban this member?', { danger: true, confirmText: 'Ban' })) return;
        const reason = await uiPrompt('Reason (optional):', { value: '' });
        await scApi(`/guilds/${SC.guildId}/members/${id}/ban`, { method: 'POST', body: JSON.stringify({ reason: reason || '' }) });
        toast('Member banned', 'success');
      } else if (act === 'timeout') {
        const mins = await uiPrompt('Timeout minutes (0 to clear, max 40320 = 28 days):', { value: '10' });
        if (mins === null) return;
        await scApi(`/guilds/${SC.guildId}/members/${id}/timeout`, { method: 'POST', body: JSON.stringify({ minutes: parseInt(mins, 10) || 0 }) });
        toast('Timeout updated', 'success');
      } else if (act === 'roles') {
        memberRolesModal(id);
      }
    } catch (err) { toast(err.message, 'error'); }
  }

  async function memberRolesModal(uid) {
    scModal({ title: 'Member roles', icon: 'ti-shield', wide: true, body: '<div id="sc-mr-body"><div class="table-loading"><div class="spinner"></div></div></div>',
      footer: `<button class="btn btn-ghost" onclick="scCloseModal()">Close</button>` });
    async function draw() {
      const box = document.getElementById('sc-mr-body');
      try {
        if (!SC.rolesCache) SC.rolesCache = (await scApi('/guilds/' + SC.guildId + '/roles')).roles;
        const m = await scApi(`/guilds/${SC.guildId}/members/${uid}`);
        const has = new Set(m.roles.map(r => r.id));
        const addable = SC.rolesCache.filter(r => !r.isEveryone && !r.managed && !has.has(r.id));
        box.innerHTML = `<div style="margin-bottom:8px;"><strong>${esc(m.displayName)}</strong> <code>${esc(m.id)}</code></div>
          <div style="margin-bottom:12px;">${m.roles.length ? m.roles.map(r => `<span class="sc-chip"><span class="sc-swatch" style="background:${esc(r.color)};"></span>${esc(r.name)} <button data-rm="${r.id}" title="Remove">&times;</button></span>`).join('') : '<span class="sc-note">No roles.</span>'}</div>
          <div style="display:flex;gap:8px;">
            <select class="form-control" id="sc-mr-add" style="flex:1;"><option value="">Add a role…</option>${addable.map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select>
            <button class="btn btn-primary btn-sm" id="sc-mr-addbtn">Add</button>
          </div>`;
        box.querySelectorAll('[data-rm]').forEach(b => b.onclick = async () => {
          try { await scApi(`/guilds/${SC.guildId}/members/${uid}/roles/${b.dataset.rm}`, { method: 'DELETE' }); toast('Role removed', 'success'); draw(); }
          catch (err) { toast(err.message, 'error'); }
        });
        document.getElementById('sc-mr-addbtn').onclick = async () => {
          const rid = document.getElementById('sc-mr-add').value; if (!rid) return;
          try { await scApi(`/guilds/${SC.guildId}/members/${uid}/roles/${rid}`, { method: 'PUT' }); toast('Role added', 'success'); draw(); }
          catch (err) { toast(err.message, 'error'); }
        };
      } catch (err) { box.innerHTML = `<p class="sc-note" style="color:#f04f5e;">${esc(err.message)}</p>`; }
    }
    draw();
  }

  async function bansView() {
    const box = document.getElementById('sc-mem-results');
    box.innerHTML = '<div class="table-loading"><div class="spinner"></div></div>';
    try {
      const { bans } = await scApi(`/guilds/${SC.guildId}/bans`);
      if (!bans.length) { box.innerHTML = '<p class="sc-note">No bans in this server.</p>'; return; }
      box.innerHTML = `<div class="table-wrap"><table class="data-table"><thead><tr><th>User</th><th>Reason</th><th style="text-align:right;">Actions</th></tr></thead><tbody>${bans.map(b => `
        <tr><td>${esc(b.username || b.id)} <code>${esc(b.id)}</code></td><td>${esc(b.reason || '·')}</td>
        <td style="text-align:right;"><button class="btn btn-ghost btn-sm" data-unban="${b.id}"><i class="ti ti-lock-open"></i> Unban</button></td></tr>`).join('')}</tbody></table></div>`;
      box.onclick = async (e) => {
        const btn = e.target.closest('[data-unban]'); if (!btn) return;
        if (!await uiConfirm('Unban this user?', { confirmText: 'Unban' })) return;
        try { await scApi(`/guilds/${SC.guildId}/members/${btn.dataset.unban}/ban`, { method: 'DELETE' }); toast('Unbanned', 'success'); bansView(); }
        catch (err) { toast(err.message, 'error'); }
      };
    } catch (e) { box.innerHTML = `<p class="sc-note" style="color:#f04f5e;">${esc(e.message)}</p>`; }
  }

  // ── Emojis ──────────────────────────────────────────────────────
  async function renderEmojis(box) {
    box.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
      <div class="sc-note">Custom emojis in this server.</div>
      <button class="btn btn-primary btn-sm" id="sc-emoji-add"><i class="ti ti-plus"></i> Add emoji</button>
    </div><div id="sc-emoji-grid" class="sc-emoji-grid"><div class="table-loading"><div class="spinner"></div></div></div>`;
    document.getElementById('sc-emoji-add').onclick = () => {
      scModal({ title: 'Add emoji', icon: 'ti-mood-smile',
        body: `<div class="sc-form-row"><label>Name (letters, numbers, underscore)</label><input class="form-control" id="sc-em-name" placeholder="my_emoji"></div>
               <div class="sc-form-row"><label>Image URL (PNG, JPG or GIF, under 256KB)</label><input class="form-control" id="sc-em-url" placeholder="https://…"></div>`,
        footer: `<button class="btn btn-ghost" onclick="scCloseModal()">Cancel</button><button class="btn btn-primary" id="sc-em-save">Add</button>` });
      document.getElementById('sc-em-save').onclick = async () => {
        try { await scApi(`/guilds/${SC.guildId}/emojis`, { method: 'POST', body: JSON.stringify({ name: document.getElementById('sc-em-name').value.trim(), imageUrl: document.getElementById('sc-em-url').value.trim() }) }); toast('Emoji added', 'success'); closeScModal(); renderEmojis(document.getElementById('sc-content')); }
        catch (err) { toast(err.message, 'error'); }
      };
    };
    try {
      const { emojis } = await scApi('/guilds/' + SC.guildId + '/emojis');
      const grid = document.getElementById('sc-emoji-grid');
      if (!emojis.length) { grid.innerHTML = '<p class="sc-note">No custom emojis.</p>'; return; }
      grid.innerHTML = emojis.map(em => `<div class="sc-emoji"><img src="${esc(em.url)}" alt="${esc(em.name)}"><div class="nm">:${esc(em.name)}:</div>
        <button class="btn btn-ghost btn-sm" data-del="${em.id}" data-name="${esc(em.name)}" style="margin-top:6px;"><i class="ti ti-trash" style="color:#f04f5e;"></i></button></div>`).join('');
      grid.onclick = async (e) => {
        const b = e.target.closest('[data-del]'); if (!b) return;
        if (!await uiConfirm(`Delete :${b.dataset.name}:?`, { danger: true, confirmText: 'Delete' })) return;
        try { await scApi(`/guilds/${SC.guildId}/emojis/${b.dataset.del}`, { method: 'DELETE' }); toast('Emoji deleted', 'success'); renderEmojis(document.getElementById('sc-content')); }
        catch (err) { toast(err.message, 'error'); }
      };
    } catch (e) { toast(e.message, 'error'); }
  }

  // ── Send ────────────────────────────────────────────────────────
  async function renderSend(box) {
    if (!SC.channelsCache) { try { SC.channelsCache = (await scApi('/guilds/' + SC.guildId + '/channels')).channels; } catch (e) { SC.channelsCache = []; } }
    const textChans = (SC.channelsCache || []).filter(c => c.textLike);
    box.innerHTML = `
      <div class="panel glass" style="margin-bottom:14px;">
        <div class="panel-header"><div class="panel-title"><span class="panel-dot" style="background:#4a8fff;"></span>Send to a channel</div></div>
        <div class="sc-form-row"><label>Channel</label><select class="form-control" id="sc-send-ch">${textChans.map(c => `<option value="${c.id}">#${esc(c.name)}</option>`).join('')}</select></div>
        <div class="sc-form-row"><label>Message text</label><textarea class="form-control" id="sc-send-text" rows="3" placeholder="Plain message (optional if you use an embed)"></textarea></div>
        <details style="margin-bottom:10px;"><summary style="cursor:pointer;font-weight:600;font-size:13px;">Embed (optional)</summary>
          <div style="margin-top:10px;">
            <div class="sc-form-row"><label>Title</label><input class="form-control" id="sc-emb-title"></div>
            <div class="sc-form-row"><label>Description</label><textarea class="form-control" id="sc-emb-desc" rows="3"></textarea></div>
            <div class="sc-form-row" style="display:flex;gap:16px;align-items:center;"><span>Colour <input type="color" id="sc-emb-color" value="#4a8fff"></span>
              <span style="flex:1;">Footer <input class="form-control" id="sc-emb-footer"></span></div>
            <div class="sc-form-row"><label>Image URL</label><input class="form-control" id="sc-emb-image"></div>
            <div class="sc-form-row"><label>Thumbnail URL</label><input class="form-control" id="sc-emb-thumb"></div>
          </div></details>
        <button class="btn btn-primary" id="sc-send-btn"><i class="ti ti-send"></i> Send message</button>
      </div>
      <div class="panel glass">
        <div class="panel-header"><div class="panel-title"><span class="panel-dot" style="background:#2ed896;"></span>Direct message a user</div></div>
        <div class="sc-form-row"><label>User ID</label><input class="form-control" id="sc-dm-id" placeholder="Discord user ID"></div>
        <div class="sc-form-row"><label>Message</label><textarea class="form-control" id="sc-dm-text" rows="3"></textarea></div>
        <button class="btn btn-primary" id="sc-dm-btn"><i class="ti ti-mail"></i> Send DM</button>
      </div>`;
    const embed = () => {
      const e = {
        title: document.getElementById('sc-emb-title').value.trim(),
        description: document.getElementById('sc-emb-desc').value.trim(),
        color: document.getElementById('sc-emb-color').value,
        footer: document.getElementById('sc-emb-footer').value.trim(),
        image: document.getElementById('sc-emb-image').value.trim(),
        thumbnail: document.getElementById('sc-emb-thumb').value.trim(),
      };
      return (e.title || e.description || e.footer || e.image || e.thumbnail) ? e : null;
    };
    document.getElementById('sc-send-btn').onclick = async () => {
      try {
        await scApi(`/guilds/${SC.guildId}/send`, { method: 'POST', body: JSON.stringify({
          channelId: document.getElementById('sc-send-ch').value,
          content: document.getElementById('sc-send-text').value,
          embed: embed(),
        }) });
        toast('Message sent', 'success');
        document.getElementById('sc-send-text').value = '';
      } catch (err) { toast(err.message, 'error'); }
    };
    document.getElementById('sc-dm-btn').onclick = async () => {
      try {
        await scApi('/dm', { method: 'POST', body: JSON.stringify({ userId: document.getElementById('sc-dm-id').value.trim(), content: document.getElementById('sc-dm-text').value }) });
        toast('DM sent', 'success');
        document.getElementById('sc-dm-text').value = '';
      } catch (err) { toast(err.message, 'error'); }
    };
  }

  function emptyRowSc(cols, msg) { return `<tr><td colspan="${cols}" style="text-align:center;color:var(--text-muted);padding:18px;">${esc(msg)}</td></tr>`; }
})();
