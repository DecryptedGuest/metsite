// client/public/js/media.js — IA media library + developer media dashboard
var mediaCache = [];
var mediaFilter = 'all';
var mediaPickedFile = null; // { dataBase64, mimeType, filename, kind }

document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('#media-filter-tabs .filter-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      document.querySelectorAll('#media-filter-tabs .filter-tab').forEach(function (t) { t.classList.remove('active'); });
      tab.classList.add('active');
      mediaFilter = tab.dataset.mfilter;
      renderMediaGrid();
    });
  });
});

function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}
function visLabel(v) {
  return { PUBLIC: 'Public', IA: 'Internal Affairs+', STAFF: 'Staff only', DEVELOPER: 'Developer' }[v] || v;
}

// ── Library (all IA) ──────────────────────────────────────────────
async function loadMedia() {
  var grid = document.getElementById('media-grid');
  if (grid) grid.innerHTML = window.metSkeleton ? '<div style="grid-column:1/-1;">' + window.metSkeleton('cards', 8) + '</div>' : '<div class="table-loading"><div class="spinner"></div></div>';
  try {
    mediaCache = await api('/api/media') || [];
    renderMediaGrid();
  } catch (e) {
    if (grid) grid.innerHTML = '<p style="color:var(--red);">Failed to load media.</p>';
  }
}

function renderMediaGrid() {
  var grid = document.getElementById('media-grid');
  if (!grid) return;
  var list = mediaCache.filter(function (m) {
    if (mediaFilter === 'image') return m.kind === 'image';
    if (mediaFilter === 'video') return m.kind === 'video';
    if (mediaFilter === 'mine')  return m.uploaderId === (currentUser && currentUser.id);
    return true;
  });
  if (!list.length) {
    grid.innerHTML = window.metEmpty
      ? '<div style="grid-column:1/-1;">' + window.metEmpty({ icon: 'ti-photo', title: 'No media yet', sub: 'Upload an image or video to add it to the library.', cta: 'Upload media', ctaIcon: 'ti-upload', onclick: 'openMediaUpload()' }) + '</div>'
      : '<p style="grid-column:1/-1;color:var(--text-muted);font-size:13px;">No media yet. Click Upload to add an image or video.</p>';
    return;
  }

  grid.innerHTML = list.map(function (m) {
    var thumb = m.kind === 'image'
      ? '<img src="' + m.url + '" loading="lazy" style="width:100%;height:130px;object-fit:cover;display:block;background:#000;">'
      : '<div style="position:relative;width:100%;height:130px;background:#000;">'
        + '<video src="' + m.url + '#t=0.1" muted preload="metadata" playsinline style="width:100%;height:130px;object-fit:cover;display:block;"></video>'
        + '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;"><i class="ti ti-player-play-filled" style="font-size:32px;color:rgba(255,255,255,0.9);text-shadow:0 2px 8px rgba(0,0,0,0.7);"></i></div>'
        + '</div>';
    return '<div class="glass" style="border:1px solid var(--border-dim);border-radius:10px;overflow:hidden;cursor:pointer;" onclick="openMediaView(\'' + m.id + '\')">'
      + thumb
      + '<div style="padding:8px 10px;">'
      + '<div style="font-size:12px;font-weight:600;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(m.title || m.filename) + '</div>'
      + '<div style="font-size:10px;color:var(--text-muted);margin-top:2px;">' + visLabel(m.visibility) + ' · ' + escapeHtml(m.uploader || '—') + '</div>'
      + '</div></div>';
  }).join('');
}

function openMediaView(id) {
  var m = mediaCache.find(function (x) { return x.id === id; }) || (mediaAdminCache || []).find(function (x) { return x.id === id; });
  if (!m) return;
  var shareUrl = location.origin + (m.pageUrl || ('/m/' + m.id)); // branded viewer page
  var title = document.getElementById('media-view-title');
  var body  = document.getElementById('media-view-body');
  var meta  = document.getElementById('media-view-meta');
  if (title) title.innerHTML = '<i class="ti ti-' + (m.kind === 'video' ? 'video' : 'photo') + '" style="font-size:18px;"></i> ' + escapeHtml(m.title || m.filename);
  if (body) {
    body.innerHTML = m.kind === 'image'
      ? '<img src="' + m.url + '" style="max-width:100%;max-height:60vh;border-radius:8px;">'
      : '<video src="' + m.url + '" controls style="max-width:100%;max-height:60vh;border-radius:8px;"></video>';
  }
  if (meta) meta.textContent = visLabel(m.visibility) + ' · ' + fmtBytes(m.size) + ' · ' + (m.views || 0) + ' views · by ' + (m.uploader || '—');

  var copy = document.getElementById('media-view-copy');
  if (copy) copy.onclick = function () { copyToClipboard(shareUrl); };
  var open = document.getElementById('media-view-open');
  if (open) open.href = m.pageUrl || ('/m/' + m.id);
  var del = document.getElementById('media-view-delete');
  if (del) {
    var canDelete = (currentUser && (currentUser.role === 'DEVELOPER' || m.uploaderId === currentUser.id));
    del.style.display = canDelete ? '' : 'none';
    del.onclick = function () { deleteMedia(m.id, true); };
  }
  openModal('modal-media-view');
}

function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () { showToast('Link copied.', 'success'); },
      function () { showToast(text, 'info'); });
  } else {
    var ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); showToast('Link copied.', 'success'); } catch (e) { showToast(text, 'info'); }
    ta.remove();
  }
}

// ── Upload ────────────────────────────────────────────────────────
function openMediaUpload() {
  mediaPickedFile = null;
  var nm = document.getElementById('media-file-name'); if (nm) nm.textContent = 'Click to choose an image or video';
  var pv = document.getElementById('media-upload-preview'); if (pv) { pv.style.display = 'none'; pv.innerHTML = ''; }
  var t = document.getElementById('media-title'); if (t) t.value = '';
  var v = document.getElementById('media-visibility'); if (v) v.value = 'PUBLIC';
  openModal('modal-media-upload');
}

function onMediaFilePick(files) {
  var f = files && files[0];
  if (!f) return;
  var isImg = /^image\//.test(f.type), isVid = /^video\//.test(f.type);
  if (!isImg && !isVid) { showToast('Only images and videos are allowed.', 'error'); return; }

  var nm = document.getElementById('media-file-name');
  if (nm) nm.textContent = f.name + ' (' + fmtBytes(f.size) + ')';

  // Keep the raw File for upload (sent as binary — no base64) and preview it via
  // an object URL, so we never build a multi-MB data string for large videos.
  mediaPickedFile = { file: f, mimeType: f.type, filename: f.name, kind: isVid ? 'video' : 'image' };
  // For videos, grab real dimensions + a poster frame in the background so the
  // shared link unfurls into a proper embed with a thumbnail.
  if (isVid) mediaPickedFile.metaPromise = captureVideoPoster(f);
  var url = URL.createObjectURL(f);
  var pv = document.getElementById('media-upload-preview');
  if (pv) {
    pv.style.display = '';
    pv.innerHTML = isImg
      ? '<img src="' + url + '" style="max-width:100%;max-height:200px;border-radius:8px;">'
      : '<video src="' + url + '" controls style="max-width:100%;max-height:200px;border-radius:8px;"></video>';
  }
}

// Load the video off-screen, read its dimensions, and grab a JPEG frame a second
// in as the poster. All best-effort: any failure resolves with nulls so upload
// still works. Times out after 8s.
function captureVideoPoster(file) {
  return new Promise(function (resolve) {
    var settled = false;
    var url;
    function finish(r) { if (settled) return; settled = true; try { URL.revokeObjectURL(url); } catch (e) {} resolve(r); }
    try {
      url = URL.createObjectURL(file);
      var v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'metadata'; v.src = url;
      v.onloadeddata = function () {
        var w = v.videoWidth || null, h = v.videoHeight || null;
        var t = Math.min(1, (v.duration || 2) / 2) || 0.1;
        v.onseeked = function () {
          try {
            var c = document.createElement('canvas'); c.width = w; c.height = h;
            c.getContext('2d').drawImage(v, 0, 0, w, h);
            c.toBlob(function (b) { finish({ width: w, height: h, poster: b }); }, 'image/jpeg', 0.8);
          } catch (e) { finish({ width: w, height: h, poster: null }); }
        };
        try { v.currentTime = t; } catch (e) { finish({ width: w, height: h, poster: null }); }
      };
      v.onerror = function () { finish({ width: null, height: null, poster: null }); };
      setTimeout(function () { finish({ width: (v && v.videoWidth) || null, height: (v && v.videoHeight) || null, poster: null }); }, 8000);
    } catch (e) { finish({ width: null, height: null, poster: null }); }
  });
}

async function submitMediaUpload() {
  if (!mediaPickedFile || !mediaPickedFile.file) { showToast('Choose a file first.', 'error'); return; }
  var btn = document.getElementById('btn-media-upload-submit');
  var title      = (document.getElementById('media-title') || {}).value || '';
  var visibility = (document.getElementById('media-visibility') || {}).value || 'IA';
  // Wait for the background video-poster capture (if any) so we can send dims.
  var meta = {};
  if (mediaPickedFile.metaPromise) { try { meta = await mediaPickedFile.metaPromise || {}; } catch (e) {} }
  var qs = '?filename=' + encodeURIComponent(mediaPickedFile.filename)
         + '&mimeType=' + encodeURIComponent(mediaPickedFile.mimeType || '')
         + '&visibility=' + encodeURIComponent(visibility)
         + '&title=' + encodeURIComponent(title)
         + (meta.width ? '&width=' + meta.width + '&height=' + meta.height : '');
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner"></div> Uploading…'; }
  try {
    // Raw binary upload — send the File directly (no base64, no giant JSON).
    var res = await fetch('/api/media' + qs, {
      method:  'POST',
      headers: { 'Content-Type': mediaPickedFile.mimeType || 'application/octet-stream' },
      body:    mediaPickedFile.file,
      credentials: 'same-origin',
    });
    if (res.status === 401 || res.status === 403) { window.location.href = '/login?error=access_revoked'; return; }
    if (!res.ok) {
      var e = await res.json().catch(function () { return {}; });
      throw new Error(e.error || ('Upload failed (HTTP ' + res.status + ')'));
    }
    var created = await res.json().catch(function () { return null; });
    // Attach the poster frame (best-effort — never blocks the success path).
    if (created && created.id && meta.poster) {
      try {
        await fetch('/api/media/' + created.id + '/poster', {
          method: 'POST', headers: { 'Content-Type': 'image/jpeg', 'X-CSRF-Token': (document.cookie.match(/csrf_token=([^;]+)/) || [])[1] || '' }, body: meta.poster, credentials: 'same-origin',
        });
      } catch (e) {}
    }
    closeModal('modal-media-upload');
    showToast('Uploaded.', 'success');
    loadMedia();
  } catch (err) {
    showToast(err.message || 'Upload failed.', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-upload"></i> Upload'; }
  }
}

async function deleteMedia(id, fromViewer) {
  if (!(await uiConfirm('Delete this media permanently? The link will stop working.'))) return;
  try {
    await api('/api/media/' + id, { method: 'DELETE' });
    showToast('Deleted.', 'success');
    if (fromViewer) closeModal('modal-media-view');
    loadMedia();
    if (typeof loadMediaAdmin === 'function' && document.getElementById('page-media-admin').classList.contains('active')) loadMediaAdmin();
  } catch (err) { showToast(err.message || 'Delete failed.', 'error'); }
}

// ── Developer dashboard ───────────────────────────────────────────
var mediaAdminCache = [];

async function loadMediaAdmin() {
  var tbody = document.getElementById('media-admin-tbody');
  if (tbody) tbody.innerHTML = window.metSkeleton ? '<tr><td colspan="9">' + window.metSkeleton('rows', 6) + '</td></tr>' : '<tr><td colspan="9" class="table-loading"><div class="spinner"></div></td></tr>';
  try {
    mediaAdminCache = await api('/api/media/all') || [];
  } catch (e) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="9" class="table-empty"><span class="table-empty-text">Failed to load.</span></td></tr>';
    return;
  }
  // stats
  var totalSize = mediaAdminCache.reduce(function (a, m) { return a + (m.size || 0); }, 0);
  var totalViews = mediaAdminCache.reduce(function (a, m) { return a + (m.views || 0); }, 0);
  var set = function (id, v) { var el = document.getElementById(id); if (el) el.textContent = v; };
  set('media-stat-count', mediaAdminCache.length);
  set('media-stat-size', fmtBytes(totalSize));
  set('media-stat-views', totalViews);

  loadMediaStorage();

  if (!mediaAdminCache.length) {
    if (tbody) tbody.innerHTML = window.metEmpty
      ? '<tr><td colspan="9">' + window.metEmpty({ icon: 'ti-photo', title: 'No media uploaded yet', sub: 'Uploaded images and videos will appear here.' }) + '</td></tr>'
      : '<tr><td colspan="9" class="table-empty"><span class="table-empty-text">No media uploaded yet.</span></td></tr>';
    return;
  }

  var visOpts = function (cur) {
    return ['PUBLIC', 'IA', 'STAFF', 'DEVELOPER'].map(function (v) {
      return '<option value="' + v + '"' + (v === cur ? ' selected' : '') + '>' + visLabel(v) + '</option>';
    }).join('');
  };

  if (tbody) tbody.innerHTML = mediaAdminCache.map(function (m) {
    var thumb = m.kind === 'image'
      ? '<img src="' + m.url + '" style="width:48px;height:36px;object-fit:cover;border-radius:4px;cursor:pointer;background:#000;" onclick="openMediaView(\'' + m.id + '\')">'
      : '<div onclick="openMediaView(\'' + m.id + '\')" style="position:relative;width:48px;height:36px;border-radius:4px;cursor:pointer;background:#000;overflow:hidden;">'
        + '<video src="' + m.url + '#t=0.1" muted preload="metadata" playsinline style="width:48px;height:36px;object-fit:cover;display:block;"></video>'
        + '<i class="ti ti-player-play-filled" style="position:absolute;inset:0;margin:auto;width:16px;height:16px;font-size:16px;color:rgba(255,255,255,0.9);"></i>'
        + '</div>';
    return '<tr>'
      + '<td>' + thumb + '</td>'
      + '<td><div style="font-size:12px;font-weight:600;max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(m.title || '—') + '</div><div style="font-size:10px;color:var(--text-muted);">' + escapeHtml(m.filename) + '</div></td>'
      + '<td style="font-size:12px;">' + escapeHtml(m.uploader || '—') + '</td>'
      + '<td><span class="badge badge-' + (m.kind === 'video' ? 'amber' : 'blue') + '"><span class="badge-dot"></span>' + m.kind + '</span></td>'
      + '<td style="font-size:12px;">' + fmtBytes(m.size) + '</td>'
      + '<td style="font-size:12px;">' + (m.views || 0) + '</td>'
      + '<td><select class="role-select" onchange="setMediaVisibility(\'' + m.id + '\',this.value)">' + visOpts(m.visibility) + '</select></td>'
      + '<td><span class="date-cell">' + formatDate(m.createdAt) + '</span></td>'
      + '<td><div class="admin-actions">'
      + '<button class="row-btn btn-sm" title="Copy share link" aria-label="Copy share link" onclick="copyToClipboard(location.origin+\'' + (m.pageUrl || ('/m/' + m.id)) + '\')"><i class="ti ti-link"></i></button>'
      + '<button class="row-btn row-btn-deny btn-sm" title="Delete media" aria-label="Delete media" onclick="deleteMedia(\'' + m.id + '\')"><i class="ti ti-trash"></i></button>'
      + '</div></td>'
      + '</tr>';
  }).join('');
}

// Storage usage bar (used vs configured max).
async function loadMediaStorage() {
  var label = document.getElementById('media-storage-label');
  var bar   = document.getElementById('media-storage-bar');
  var sub   = document.getElementById('media-storage-sub');
  let d;
  try { d = await api('/api/media/storage'); } catch (e) { return; }
  if (!d) return;
  var used = d.usedBytes || 0, limit = d.limitBytes || 0;
  var pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  if (label) label.textContent = fmtBytes(used) + ' of ' + fmtBytes(limit) + ' (' + pct.toFixed(1) + '%)';
  if (bar) {
    bar.style.width = pct + '%';
    bar.style.background = pct >= 90 ? 'var(--red)' : (pct >= 70 ? 'var(--amber)' : 'var(--blue)');
  }
  if (sub) {
    sub.textContent = (d.count || 0) + ' file' + ((d.count === 1) ? '' : 's')
      + (d.dbBytes != null ? ' · whole database: ' + fmtBytes(d.dbBytes) : '');
  }
}

async function setMediaVisibility(id, visibility) {
  try {
    await api('/api/media/' + id, { method: 'PATCH', body: JSON.stringify({ visibility: visibility }) });
    showToast('Visibility updated.', 'success');
    var m = mediaAdminCache.find(function (x) { return x.id === id; }); if (m) m.visibility = visibility;
  } catch (err) { showToast(err.message || 'Failed to update.', 'error'); loadMediaAdmin(); }
}
