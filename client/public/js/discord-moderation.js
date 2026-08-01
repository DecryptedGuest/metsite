// client/public/js/discord-moderation.js — Dev Panel · Discord Moderation
// Ban / unban / kick / timeout MET server members, searchable by username or
// Discord ID, with a live banned-users list and an audit trail.

function escapeHtmlDM(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Member search ──────────────────────────────────────────────────
async function searchDiscordMembers() {
  const q = document.getElementById('dm-search').value.trim();
  const box = document.getElementById('dm-results');
  if (!q) { box.innerHTML = ''; return; }
  box.innerHTML = '<div class="table-loading"><div class="spinner"></div></div>';
  try {
    const members = await api('/api/admin/discord/members?search=' + encodeURIComponent(q));
    if (!members.length) {
      box.innerHTML = window.metEmpty
        ? window.metEmpty({ icon: 'ti-users', title: 'No matching member', sub: 'They may have left the server — paste their Discord ID above to Ban/Unban directly, then use the Banned Users list to unban.' })
        : '<div class="table-empty-text">No matching member found (they may have left the server — try Ban/Unban directly by pasting their Discord ID above, then use the Banned Users list to unban).</div>';
      return;
    }
    box.innerHTML = members.map(memberRowHtml).join('');
  } catch (err) {
    box.innerHTML = `<div class="table-empty-text">${escapeHtmlDM(err.message)}</div>`;
  }
}

function memberRowHtml(m) {
  const muted = m.timedOutUntil && new Date(m.timedOutUntil) > new Date();
  return `
    <div style="display:flex;align-items:center;gap:10px;padding:9px 12px;border:1px solid var(--border-dim);border-radius:8px;">
      <img src="${m.avatar}" style="width:32px;height:32px;border-radius:50%;flex-shrink:0;" alt="" />
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:600;">${escapeHtmlDM(m.displayName)} ${m.isBot ? '<span class="badge" style="font-size:9px;">BOT</span>' : ''}</div>
        <div style="font-size:11px;color:var(--text-muted);">@${escapeHtmlDM(m.username)} &middot; ${escapeHtmlDM(m.id)}${muted ? ' &middot; <span style="color:var(--amber);">Timed out until ' + formatDateTime(m.timedOutUntil) + '</span>' : ''}</div>
      </div>
      <div class="row-actions" style="flex-shrink:0;">
        <button class="btn btn-ghost btn-sm" onclick="openDmAction('KICK','${m.id}','${escapeHtmlDM(m.username)}')" title="Kick"><i class="ti ti-door-exit"></i></button>
        ${muted
          ? `<button class="btn btn-ghost btn-sm" onclick="doDmUntimeout('${m.id}','${escapeHtmlDM(m.username)}')" title="Remove timeout"><i class="ti ti-volume"></i></button>`
          : `<button class="btn btn-ghost btn-sm" onclick="openDmAction('TIMEOUT','${m.id}','${escapeHtmlDM(m.username)}')" title="Timeout (mute)"><i class="ti ti-volume-3"></i></button>`}
        <button class="btn btn-danger btn-sm" onclick="openDmAction('BAN','${m.id}','${escapeHtmlDM(m.username)}')" title="Ban"><i class="ti ti-gavel"></i></button>
      </div>
    </div>`;
}

// ── Banned users list ────────────────────────────────────────────────
async function loadDiscordBans() {
  const tbody = document.getElementById('dm-bans-tbody');
  const q = document.getElementById('dm-ban-search').value.trim();
  try {
    const bans = await api('/api/admin/discord/bans?search=' + encodeURIComponent(q));
    tbody.innerHTML = bans.length
      ? bans.map(b => `<tr>
          <td>@${escapeHtmlDM(b.username)}<div class="text-muted mono" style="font-size:10px;">${escapeHtmlDM(b.id)}</div></td>
          <td>${escapeHtmlDM(b.reason || '—')}</td>
          <td><button class="btn btn-success btn-sm" onclick="openDmAction('UNBAN','${b.id}','${escapeHtmlDM(b.username)}')"><i class="ti ti-check"></i> Unban</button></td>
        </tr>`).join('')
      : (window.metEmpty
          ? `<tr><td colspan="3">${window.metEmpty({ icon: 'ti-shield', title: 'No banned users' + (q ? ' match that search' : ''), sub: q ? '' : 'Members you ban from the MET server will be listed here.' })}</td></tr>`
          : `<tr><td colspan="3" class="table-empty"><div class="table-empty-text">No bans${q ? ' matching that search' : ''}.</div></td></tr>`);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="3" class="table-empty"><div class="table-empty-text">${escapeHtmlDM(err.message)}</div></td></tr>`;
  }
}

// ── Moderation log ────────────────────────────────────────────────────
const DM_ACTION_LABEL = { BAN: 'Ban', UNBAN: 'Unban', KICK: 'Kick', TIMEOUT: 'Timeout', UNTIMEOUT: 'Untimeout' };
async function loadDiscordModLog() {
  const tbody = document.getElementById('dm-log-tbody');
  try {
    const log = await api('/api/admin/discord/moderation-log');
    tbody.innerHTML = log.length
      ? log.map(l => `<tr>
          <td>${DM_ACTION_LABEL[l.action] || l.action}${l.durationMinutes ? ` (${l.durationMinutes}m)` : ''}</td>
          <td>${escapeHtmlDM(l.targetUsername || l.targetDiscordId)}</td>
          <td>${escapeHtmlDM(l.reason || '—')}</td>
          <td>${escapeHtmlDM(l.performedBy)}</td>
          <td>${formatDateTime(l.createdAt)}</td>
        </tr>`).join('')
      : (window.metEmpty
          ? `<tr><td colspan="5">${window.metEmpty({ icon: 'ti-clipboard-list', title: 'No moderation actions yet', sub: 'Bans, kicks and timeouts you carry out will be logged here.' })}</td></tr>`
          : `<tr><td colspan="5" class="table-empty"><div class="table-empty-text">No moderation actions yet.</div></td></tr>`);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="table-empty"><div class="table-empty-text">${escapeHtmlDM(err.message)}</div></td></tr>`;
  }
}

// ── Confirm modal (Ban / Kick / Timeout / Unban) ───────────────────
let dmPending = null; // { action, discordId, username }

function openDmAction(action, discordId, username) {
  dmPending = { action, discordId, username };
  const titles = { BAN: 'Ban User', UNBAN: 'Unban User', KICK: 'Kick User', TIMEOUT: 'Timeout (Mute) User' };
  const descs = {
    BAN:    `Ban <strong>@${escapeHtmlDM(username)}</strong> from the MET server. They can be unbanned later from the Banned Users list.`,
    UNBAN:  `Remove the ban on <strong>@${escapeHtmlDM(username)}</strong>, allowing them to rejoin the server.`,
    KICK:   `Kick <strong>@${escapeHtmlDM(username)}</strong> from the MET server. They can rejoin immediately unless also banned.`,
    TIMEOUT:`Timeout (mute) <strong>@${escapeHtmlDM(username)}</strong> — they won't be able to send messages or speak in voice until it expires.`,
  };
  document.getElementById('dm-action-title').innerHTML = `<i class="ti ti-gavel" style="font-size:18px;"></i> ${titles[action]}`;
  document.getElementById('dm-action-desc').innerHTML = descs[action];
  document.getElementById('dm-duration-group').style.display = action === 'TIMEOUT' ? '' : 'none';
  document.getElementById('dm-reason').value = '';
  const btn = document.getElementById('dm-action-confirm');
  btn.className = action === 'UNBAN' ? 'btn btn-success' : 'btn btn-danger';
  btn.onclick = confirmDmAction;
  openModal('modal-dm-action');
}

async function confirmDmAction() {
  if (!dmPending) return;
  const { action, discordId, username } = dmPending;
  const reason = document.getElementById('dm-reason').value.trim();
  const body = { discordId, username, reason };

  const endpoints = {
    BAN:     ['/api/admin/discord/ban', 'POST'],
    UNBAN:   ['/api/admin/discord/unban', 'POST'],
    KICK:    ['/api/admin/discord/kick', 'POST'],
    TIMEOUT: ['/api/admin/discord/timeout', 'POST'],
  };
  const [path, method] = endpoints[action];
  if (action === 'TIMEOUT') body.durationMinutes = Number(document.getElementById('dm-duration').value) || 60;

  try {
    await api(path, { method, body: JSON.stringify(body) });
    showToast(`${DM_ACTION_LABEL[action]} applied to @${username}.`, 'success');
    closeModal('modal-dm-action');
    dmPending = null;
    searchDiscordMembers();
    loadDiscordBans();
    loadDiscordModLog();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function doDmUntimeout(discordId, username) {
  try {
    await api(`/api/admin/discord/timeout/${discordId}`, { method: 'DELETE', body: JSON.stringify({ username }) });
    showToast(`Timeout removed for @${username}.`, 'success');
    searchDiscordMembers();
    loadDiscordModLog();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Load the panel's static lists the first time its nav tab is opened.
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.querySelector('.nav-item[data-page="discord-mod"]');
  if (btn) btn.addEventListener('click', () => { loadDiscordBans(); loadDiscordModLog(); }, { once: true });
});
