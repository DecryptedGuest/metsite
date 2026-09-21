// server/routes/media.js — IA media library (images/videos) API.
const express = require('express');
const prisma  = require('../lib/db');
const { requireDeveloper } = require('../middleware/auth');

const router = express.Router();

const VISIBILITIES = ['PUBLIC', 'IA', 'STAFF', 'DEVELOPER'];

// Metadata-only projection for LIST views. Crucially this omits the `data` blob
// column — without an explicit select, Prisma pulls every file's full binary
// content into memory just to build the list, which makes the library crawl (or
// fail) once any large file is stored. The raw bytes are only ever read by the
// per-file /media/:id endpoint.
const LIST_SELECT = {
  id: true, title: true, filename: true, mimeType: true, size: true,
  kind: true, visibility: true, views: true, createdAt: true, uploaderId: true,
  uploader: { select: { displayName: true, discordUsername: true } },
};

// Regular IA members may only publish at these levels; STAFF/DEVELOPER-only is
// reserved for developers to set from the admin dashboard.
const IA_ALLOWED_VIS = ['PUBLIC', 'IA'];

function publicShape(m) {
  return {
    id: m.id, title: m.title, filename: m.filename, mimeType: m.mimeType,
    size: m.size, kind: m.kind, visibility: m.visibility, views: m.views,
    createdAt: m.createdAt,
    uploader: m.uploader ? (m.uploader.displayName || m.uploader.discordUsername) : null,
    uploaderId: m.uploaderId,
    url: `/media/${m.id}`,    // raw file (used for inline players/embeds)
    pageUrl: `/m/${m.id}`,    // branded viewer page (the shareable link)
  };
}

// What visibility levels can this user browse in their library view?
function visibleLevelsFor(role) {
  if (role === 'DEVELOPER') return VISIBILITIES;
  if (['HICOMM', 'SUPERVISOR'].includes(role)) return ['PUBLIC', 'IA', 'STAFF'];
  return ['PUBLIC', 'IA']; // plain IA
}

// ── POST /api/media — upload (any authenticated IA member) ────────
// Preferred path: the file is sent as a RAW BINARY body (Content-Type = the
// file's type) with metadata in the query string. This avoids the ~33% base64
// bloat and a multi-megabyte JSON.parse that made large uploads hang. The old
// base64-in-JSON body is still accepted as a fallback for cached clients.
const rawUpload = express.raw({ type: () => true, limit: process.env.BODY_LIMIT || '256mb' });
router.post('/', rawUpload, async (req, res) => {
  let title, filename, mimeType, visibility, buf, width, height;

  if (Buffer.isBuffer(req.body) && req.body.length) {
    // Raw binary upload
    const q = req.query || {};
    title      = q.title;
    filename   = q.filename;
    mimeType   = q.mimeType || req.headers['content-type'] || '';
    visibility = q.visibility;
    width      = parseInt(q.width, 10)  || null;
    height     = parseInt(q.height, 10) || null;
    buf        = req.body;
  } else if (req.body && typeof req.body === 'object' && req.body.dataBase64) {
    // Legacy base64-in-JSON upload
    ({ title, filename, mimeType, visibility } = req.body);
    const b64 = String(req.body.dataBase64).replace(/^data:[^,]*,/, '');
    try { buf = Buffer.from(b64, 'base64'); } catch { return res.status(400).json({ error: 'Invalid file encoding.' }); }
  }

  if (!buf || !buf.length || !mimeType || !filename)
    return res.status(400).json({ error: 'Missing file data.' });

  // SVG is an "image/" type but can carry scripts — never accept it as an image.
  const isImage = /^image\//.test(mimeType) && !/svg/i.test(mimeType);
  const isVideo = /^video\//.test(mimeType);
  if (!isImage && !isVideo)
    return res.status(400).json({ error: 'Only raster image and video files are allowed.' });

  let vis = (visibility || 'IA').toUpperCase();
  if (!IA_ALLOWED_VIS.includes(vis)) vis = 'IA';

  try {
    const m = await prisma.media.create({
      data: {
        title:      (title || '').toString().trim() || null,
        filename:   String(filename).slice(0, 200),
        mimeType,
        size:       buf.length,
        data:       buf,
        kind:       isVideo ? 'video' : 'image',
        visibility: vis,
        uploaderId: req.user.id,
        width, height,
      },
      include: { uploader: { select: { displayName: true, discordUsername: true } } },
    });
    res.status(201).json(publicShape(m));
  } catch (e) {
    console.error('[Media] upload error:', e.message);
    res.status(500).json({ error: 'Upload failed.' });
  }
});

// ── POST /api/media/:id/poster — attach a video poster frame ──────
// Sent right after a video upload (raw JPEG binary). Used as the OG embed
// thumbnail so links unfurl with a real preview. Uploader or developer only.
router.post('/:id/poster', rawUpload, async (req, res) => {
  try {
    const buf = Buffer.isBuffer(req.body) ? req.body : null;
    if (!buf || !buf.length)  return res.status(400).json({ error: 'Missing poster data.' });
    if (buf.length > 4 * 1024 * 1024) return res.status(413).json({ error: 'Poster too large.' });
    const mime = (req.query.mimeType || req.headers['content-type'] || 'image/jpeg').toString();
    if (!/^image\//.test(mime)) return res.status(400).json({ error: 'Poster must be an image.' });

    const m = await prisma.media.findUnique({ where: { id: req.params.id }, select: { uploaderId: true } });
    if (!m) return res.status(404).json({ error: 'Not found.' });
    if (req.user.role !== 'DEVELOPER' && m.uploaderId !== req.user.id)
      return res.status(403).json({ error: 'Not allowed.' });

    await prisma.media.update({ where: { id: req.params.id }, data: { poster: buf, posterMime: mime } });
    res.json({ ok: true });
  } catch (e) {
    console.error('[Media] poster error:', e.message);
    res.status(500).json({ error: 'Poster upload failed.' });
  }
});

// ── GET /api/media — library the current user can browse ──────────
router.get('/', async (req, res) => {
  try {
    const levels = visibleLevelsFor(req.user.role);
    const rows = await prisma.media.findMany({
      where:   { visibility: { in: levels } },
      orderBy: { createdAt: 'desc' },
      select:  LIST_SELECT,
    });
    res.json(rows.map(publicShape));
  } catch (e) {
    res.status(500).json({ error: 'Failed to load media.' });
  }
});

// ── GET /api/media/all — developer dashboard (everything) ─────────
router.get('/all', requireDeveloper, async (req, res) => {
  try {
    const rows = await prisma.media.findMany({
      orderBy: { createdAt: 'desc' },
      select:  LIST_SELECT,
    });
    res.json(rows.map(publicShape));
  } catch (e) {
    res.status(500).json({ error: 'Failed to load media.' });
  }
});

// ── GET /api/media/storage — used vs. max media storage (dev only) ─
router.get('/storage', requireDeveloper, async (req, res) => {
  try {
    const agg = await prisma.media.aggregate({ _sum: { size: true }, _count: true });
    const usedBytes  = agg._sum.size || 0;
    const count      = agg._count || 0;
    const limitBytes = (parseInt(process.env.MEDIA_STORAGE_LIMIT_MB || '1024', 10) || 1024) * 1024 * 1024;
    let dbBytes = null;
    try {
      const rows = await prisma.$queryRaw`SELECT pg_database_size(current_database()) AS size`;
      if (rows && rows[0] && rows[0].size != null) dbBytes = Number(rows[0].size);
    } catch (e) { /* pg_database_size unavailable — non-fatal */ }
    res.json({ usedBytes, count, limitBytes, dbBytes });
  } catch (e) {
    res.status(500).json({ error: 'Failed to read storage usage.' });
  }
});

// ── PATCH /api/media/:id — edit title/visibility ──────────────────
// Developers can edit anything; uploaders can edit their own title only.
router.patch('/:id', async (req, res) => {
  try {
    const m = await prisma.media.findUnique({ where: { id: req.params.id } });
    if (!m) return res.status(404).json({ error: 'Not found.' });
    const isDev   = req.user.role === 'DEVELOPER';
    const isOwner = m.uploaderId === req.user.id;
    if (!isDev && !isOwner) return res.status(403).json({ error: 'Not allowed.' });

    const data = {};
    if (req.body.title !== undefined) data.title = (req.body.title || '').toString().trim() || null;
    if (req.body.visibility !== undefined) {
      const vis = String(req.body.visibility).toUpperCase();
      const cur = String(m.visibility || '').toUpperCase();
      if (!VISIBILITIES.includes(vis)) return res.status(400).json({ error: 'Invalid visibility.' });
      // Only developers can set the STAFF/DEVELOPER-restricted levels — AND only
      // developers can change an item that's currently at a restricted level, so
      // an uploader can't downgrade a dev-restricted item back to PUBLIC/IA.
      if (!isDev && !IA_ALLOWED_VIS.includes(vis)) return res.status(403).json({ error: 'Only developers can set that visibility.' });
      if (!isDev && !IA_ALLOWED_VIS.includes(cur)) return res.status(403).json({ error: 'Only developers can change the visibility of a restricted item.' });
      data.visibility = vis;
    }
    const updated = await prisma.media.update({
      where: { id: m.id }, data,
      include: { uploader: { select: { displayName: true, discordUsername: true } } },
    });
    res.json(publicShape(updated));
  } catch (e) {
    res.status(500).json({ error: 'Update failed.' });
  }
});

// ── DELETE /api/media/:id — uploader or developer ─────────────────
router.delete('/:id', async (req, res) => {
  try {
    const m = await prisma.media.findUnique({ where: { id: req.params.id }, select: { uploaderId: true } });
    if (!m) return res.status(404).json({ error: 'Not found.' });
    if (req.user.role !== 'DEVELOPER' && m.uploaderId !== req.user.id)
      return res.status(403).json({ error: 'Not allowed.' });
    await prisma.media.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Delete failed.' });
  }
});

module.exports = router;
