// server/index.js
require('dotenv').config();
const express      = require('express');
const cookieParser = require('cookie-parser');
const path         = require('path');
const rateLimit    = require('express-rate-limit');

const authRoutes  = require('./routes/auth');
const caseRoutes  = require('./routes/cases');
const adminRoutes = require('./routes/admin');
const debugRoutes   = require('./routes/debug');
const ticketRoutes  = require('./routes/tickets');
const securityRoutes = require('./routes/security');
const quotaRoutes   = require('./routes/quota');
const aiReviewRoutes = require('./routes/aiReview');
const pushRoutes     = require('./routes/push');
const notificationRoutes = require('./routes/notifications');
const cidRoutes   = require('./routes/cid');
const sco19Routes = require('./routes/sco19');
const flpRoutes   = require('./routes/flp');
const hpcRoutes   = require('./routes/hpc');
const { requireAuth } = require('./middleware/auth');
const { requireDivision } = require('./middleware/division');
const { recordVisit } = require('./middleware/visit');
const { startBot, startRoleExpiryChecker } = require('./lib/bot');
const { initCsrf }    = require('./lib/roblox');

const app  = express();
const PORT = process.env.PORT || 3000;

// Behind Railway's proxy — trust X-Forwarded-For so client IPs resolve correctly
app.set('trust proxy', 1);

// Canonical domain redirect — keep the URL bar on the custom domain (e.g. metia.uk).
// Only redirects browser page navigations; API/asset/health requests pass through.
app.use((req, res, next) => {
  const canonical = process.env.CANONICAL_HOST; // e.g. "metia.uk"
  const host = req.headers.host;
  if (
    canonical && host && host !== canonical &&
    req.method === 'GET' &&
    (req.headers.accept || '').includes('text/html')
  ) {
    return res.redirect(308, `https://${canonical}${req.originalUrl}`);
  }
  next();
});

// ── Start Discord bot + Roblox CSRF warm-up ──────────────────────
startBot();
startRoleExpiryChecker();
require('./lib/accessControl').startAccessRevalidator();
require('./lib/quota').startQuotaWorker();
initCsrf().catch(err => console.error('Roblox initCsrf error:', err.message));

// ── Middleware ───────────────────────────────────────────────────
// Large limit so ticket-log proof images (base64 data URLs) fit in the body.
// Up to 10 images × 5 MB inflate to ~67 MB once base64-encoded.
app.use(express.json({ limit: process.env.BODY_LIMIT || '256mb' }));
app.use(express.urlencoded({ extended: true, limit: process.env.BODY_LIMIT || '256mb' }));
app.use(cookieParser());

// ── Site-private gate (developer-controlled) ─────────────────────
// When sitePrivate is on, nobody but a logged-in DEVELOPER can reach the
// site at all — not even the login page. /auth/* stays open so a developer
// can still sign in, and /api/site-config stays open so the curtain renders.
const jwtLib     = require('jsonwebtoken');
const dbPrisma   = require('./lib/db');
const siteConfig = require('./lib/siteConfig');
const PRIVATE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Service Unavailable</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0c12;color:#e6e9ef;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}.card{text-align:center;max-width:460px;padding:48px 36px}.icon{font-size:50px;margin-bottom:18px;opacity:.85}h1{font-size:22px;margin:0 0 12px;font-weight:700}p{color:#9aa3b2;line-height:1.65;margin:0 0 14px;font-size:14px}.sub{font-size:12px;color:#5d6675;margin-top:30px}a{color:#5d6675;font-size:12px;text-decoration:none;opacity:.55}a:hover{opacity:1}</style></head><body><div class="card"><div class="icon">🗄️</div><h1>This service has been discontinued</h1><p>This system is no longer in use and is no longer maintained. Thank you to everyone who used it.</p><p class="sub">If you reached this page by mistake, you may safely close this tab.</p><a href="/auth/discord">Staff access</a></div></body></html>`;

app.use(async (req, res, next) => {
  if (!siteConfig.isOn('sitePrivate')) return next();
  const p = req.path;
  if (p.startsWith('/auth') || p === '/api/site-config') return next();
  const token = req.cookies && req.cookies.iacms_token;
  if (token) {
    try {
      const payload = jwtLib.verify(token, process.env.JWT_SECRET);
      const u = await dbPrisma.user.findUnique({ where: { id: payload.userId }, select: { role: true } });
      if (u && u.role === 'DEVELOPER') return next();
    } catch (e) { /* fall through to curtain */ }
  }
  if (p.startsWith('/api')) return res.status(503).json({ error: 'The site is currently private.' });
  return res.status(503).type('html').send(PRIVATE_PAGE);
});

// Public site config (banner / effects / private flags) — no auth.
app.get('/api/site-config', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(siteConfig.publicConfig());
});

// Serve minified JS (deterrent against reading client code via view-source).
// Falls through to express.static on any problem so assets always load.
const { getMinifiedJs, getMinifiedHtml } = require('./lib/assets');
const PUBLIC_DIR = path.join(__dirname, '../client/public');
app.get(/^\/js\/.+\.js$/, async (req, res, next) => {
  try {
    const filePath = path.normalize(path.join(PUBLIC_DIR, req.path));
    if (!filePath.startsWith(PUBLIC_DIR)) return next(); // path-traversal guard
    const code = await getMinifiedJs(filePath);
    if (code == null) return next();
    res.set('Cache-Control', 'no-store');
    res.type('application/javascript').send(code);
  } catch (e) { next(); }
});

app.use(express.static(path.join(__dirname, '../client/public')));

app.use('/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 50 }));
app.use('/api',  rateLimit({ windowMs: 1  * 60 * 1000, max: 120 }));

// ── Routes ───────────────────────────────────────────────────────
// Shared across the whole portal.
app.use('/auth',        authRoutes);

// IA — unchanged route logic, gated to users with IA division access.
const ia = requireDivision('IA');
app.use('/api/cases',   requireAuth, ia, caseRoutes);
app.use('/api/admin',   requireAuth, ia, adminRoutes);
app.use('/api/tickets', requireAuth, ia, ticketRoutes);
app.use('/api/security', requireAuth, ia, securityRoutes);
app.use('/api/quota',   requireAuth, ia, quotaRoutes);
app.use('/api/ai-review', requireAuth, ia, aiReviewRoutes);
app.use('/api/push',     requireAuth, ia, pushRoutes);
app.use('/api/notifications', requireAuth, ia, notificationRoutes);
app.use('/api/media',    requireAuth, ia, require('./routes/media'));
app.use('/auth/debug',  debugRoutes); // TEMPORARY

// New divisions — own routes, own scope, gated to their own division.
app.use('/api/cid',   requireAuth, requireDivision('CID'),   cidRoutes);
app.use('/api/sco19', requireAuth, requireDivision('SCO19'), sco19Routes);
app.use('/api/flp',   requireAuth, requireDivision('FLP'),   flpRoutes);
app.use('/api/hpc',   requireAuth, requireDivision('HPC'),   hpcRoutes);

// Visibility check for hosted media. Returns { allowed, user }.
async function checkMediaAccess(req, m) {
  if (m.visibility === 'PUBLIC') return { allowed: true, user: null };
  let user = null;
  const token = req.cookies && req.cookies.iacms_token;
  if (token) {
    try {
      const payload = jwtLib.verify(token, process.env.JWT_SECRET);
      user = await dbPrisma.user.findUnique({ where: { id: payload.userId }, select: { role: true, isBlacklisted: true } });
      if (user && user.isBlacklisted) user = null;
    } catch (e) { user = null; }
  }
  const role = user && user.role;
  const allowed =
    (m.visibility === 'IA'        && !!role) ||
    (m.visibility === 'STAFF'     && ['HICOMM', 'SUPERVISOR', 'DEVELOPER'].includes(role)) ||
    (m.visibility === 'DEVELOPER' && role === 'DEVELOPER');
  return { allowed, user };
}

function absoluteBase(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  return `${proto}://${req.get('host')}`;
}
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}

// ── Branded media viewer page (the shareable link, à la streamable) ──
// Shows the image/video in the site's UI; the raw file lives at /media/:id.
function mediaAudienceLabel(v) {
  return {
    IA:        'Internal Affairs members',
    STAFF:     'Internal Affairs HICOMM members',
    DEVELOPER: 'Site Developers',
  }[v] || 'authorised staff';
}

app.get('/m/:id', async (req, res) => {
  try {
    // Never cache the embed page — so a visibility change is reflected the next
    // time the link is fetched/unfurled instead of serving a stale embed.
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    // Metadata only — the raw bytes are served by /media/:id, so don't drag the
    // (possibly huge) data blob into memory just to render the viewer page.
    const m = await dbPrisma.media.findUnique({
      where:  { id: req.params.id },
      select: { id: true, title: true, filename: true, kind: true, mimeType: true,
                visibility: true, width: true, height: true, posterMime: true, createdAt: true, views: true },
    });
    if (!m) { res.status(404); return sendPage(res, path.join(views, 'login.html')); }

    const { allowed } = await checkMediaAccess(req, m);
    const isPublic = m.visibility === 'PUBLIC';
    const base    = absoluteBase(req);
    const raw     = `${base}/media/${m.id}`;
    const pageUrl = `${base}/m/${m.id}`;
    const title   = m.title || m.filename || 'Media';
    const isVideo  = m.kind === 'video';
    const audience = mediaAudienceLabel(m.visibility);

    // Embed the real media only when PUBLIC. Otherwise the unfurl is a plain
    // notice that names who can view it — never the video/image itself.
    // Video embeds need a thumbnail (og:image) AND explicit dimensions or Discord
    // won't render a player. Use the stored poster frame + real dimensions when we
    // have them; otherwise fall back to the logo and a 16:9 default so the link
    // still unfurls into a playable embed.
    const vw = m.width  || 1280;
    const vh = m.height || 720;
    const poster = m.posterMime ? `${base}/media/${m.id}/poster` : `${base}/img/logo.png`;

    let og;
    if (isPublic) {
      og = isVideo
        ? `<meta property="og:type" content="video.other">
   <meta property="og:title" content="${escHtml(title)}">
   <meta property="og:image" content="${escHtml(poster)}">
   <meta property="og:image:width" content="${vw}">
   <meta property="og:image:height" content="${vh}">
   <meta property="og:video" content="${escHtml(raw)}">
   <meta property="og:video:url" content="${escHtml(raw)}">
   <meta property="og:video:secure_url" content="${escHtml(raw)}">
   <meta property="og:video:type" content="${escHtml(m.mimeType)}">
   <meta property="og:video:width" content="${vw}">
   <meta property="og:video:height" content="${vh}">
   <meta name="twitter:card" content="player">
   <meta name="twitter:player:stream" content="${escHtml(raw)}">
   <meta name="twitter:player:stream:content_type" content="${escHtml(m.mimeType)}">
   <meta name="twitter:player:width" content="${vw}">
   <meta name="twitter:player:height" content="${vh}">
   <meta name="twitter:image" content="${escHtml(poster)}">`
        : `<meta property="og:type" content="website">
   <meta property="og:title" content="${escHtml(title)}">
   <meta property="og:image" content="${escHtml(raw)}">
   ${m.width ? `<meta property="og:image:width" content="${vw}"><meta property="og:image:height" content="${vh}">` : ''}
   <meta name="twitter:card" content="summary_large_image">
   <meta name="twitter:image" content="${escHtml(raw)}">`;
    } else {
      og = `<meta property="og:type" content="website">
   <meta property="og:title" content="🔒 Restricted ${escHtml(isVideo ? 'video' : 'image')} — ${escHtml(title)}">
   <meta property="og:description" content="This ${escHtml(isVideo ? 'video' : 'image')} is restricted to ${escHtml(audience)}. Sign in on metia.uk to view.">
   <meta property="og:image" content="${escHtml(base + '/img/logo.png')}">
   <meta name="twitter:card" content="summary">`;
    }

    // Body: media for authorised viewers; a restriction notice otherwise.
    const body = allowed
      ? `<div class="stage">${isVideo
            ? `<video src="${escHtml('/media/' + m.id)}" controls autoplay playsinline class="media"></video>`
            : `<img src="${escHtml('/media/' + m.id)}" alt="${escHtml(title)}" class="media">`}</div>
<div class="meta">${m.views || 0} views · uploaded ${new Date(m.createdAt).toLocaleDateString()}</div>`
      : `<div class="stage"><div class="restricted">
     <div class="lock">🔒</div>
     <div class="rt">This ${escHtml(isVideo ? 'video' : 'image')} is restricted</div>
     <div class="rs">Only ${escHtml(audience)} can view it. Sign in to continue.</div>
     <a class="rb" href="/ia/login">Sign in</a>
   </div></div>`;

    const subtitle = isPublic ? '' : ' · ' + escHtml(m.visibility);

    res.type('html').send(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)} · MET Internal Affairs</title>
<meta property="og:site_name" content="MET · Internal Affairs">
<meta property="og:url" content="${escHtml(pageUrl)}">
<meta name="theme-color" content="#3c6eff">
${og}
<style>
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{background:#06080d;color:#e6e9ef;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;flex-direction:column}
.bar{display:flex;align-items:center;gap:12px;padding:12px 18px;border-bottom:1px solid rgba(255,255,255,.07);flex-shrink:0}
.bar img{width:30px;height:30px;border-radius:7px}
.bar .t{font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
.bar .t small{display:block;color:#7d869a;font-weight:400;font-size:11px;margin-top:1px}
.bar a,.bar button{font:inherit;font-size:12px;color:#cdd5e4;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:7px;padding:7px 12px;cursor:pointer;text-decoration:none;white-space:nowrap}
.bar a:hover,.bar button:hover{background:rgba(255,255,255,.12)}
.stage{flex:1;display:flex;align-items:center;justify-content:center;padding:18px;min-height:0}
.media{max-width:100%;max-height:100%;border-radius:10px;box-shadow:0 10px 50px rgba(0,0,0,.6);background:#000}
.meta{padding:8px 18px 16px;color:#7d869a;font-size:12px;text-align:center;flex-shrink:0}
.restricted{text-align:center;max-width:380px}
.restricted .lock{font-size:46px;margin-bottom:14px}
.restricted .rt{font-size:18px;font-weight:700;margin-bottom:8px}
.restricted .rs{color:#9aa3b2;font-size:13px;line-height:1.6;margin-bottom:20px}
.restricted .rb{display:inline-block;background:#3c6eff;color:#fff;border:none;border-radius:8px;padding:9px 20px;font-size:13px;text-decoration:none}
</style></head>
<body>
<div class="bar">
  <img src="/img/logo.png" alt="">
  <div class="t">${escHtml(title)}<small>MET · Internal Affairs${subtitle}</small></div>
  ${allowed ? '<button id="copy">Copy link</button><a href="/media/' + escHtml(m.id) + '" target="_blank" rel="noopener">Open file</a>' : ''}
  <a href="/ia/dashboard">Dashboard</a>
</div>
${body}
<script>
var c=document.getElementById('copy');
if(c)c.addEventListener('click',function(){
  var u=location.href;
  (navigator.clipboard&&navigator.clipboard.writeText?navigator.clipboard.writeText(u):Promise.reject())
   .then(function(){c.textContent='Copied!';setTimeout(function(){c.textContent='Copy link';},1500);})
   .catch(function(){prompt('Copy this link:',u);});
});
</script>
</body></html>`);
  } catch (e) {
    res.status(500).type('text').send('Error');
  }
});

// ── Serve a video's poster frame (the OG embed thumbnail) ─────────
// Visibility-aware like the file itself. Cheap: only the poster column.
app.get('/media/:id/poster', async (req, res) => {
  try {
    const m = await dbPrisma.media.findUnique({
      where:  { id: req.params.id },
      select: { poster: true, posterMime: true, visibility: true },
    });
    if (!m || !m.poster) return res.status(404).type('text').send('No poster');
    const { allowed } = await checkMediaAccess(req, m);
    if (!allowed) return res.status(403).type('text').send('Restricted');
    const buf = Buffer.isBuffer(m.poster) ? m.poster : Buffer.from(m.poster);
    res.set('Content-Type', m.posterMime || 'image/jpeg');
    res.set('Cache-Control', m.visibility === 'PUBLIC' ? 'public, max-age=3600' : 'private, no-cache');
    res.set('Content-Length', String(buf.length));
    res.end(buf);
  } catch (e) {
    res.status(500).type('text').send('Error');
  }
});

// ── Serve hosted media file (visibility-aware, with range support) ─
// PUBLIC media needs no login; IA/STAFF/DEVELOPER media checks the JWT cookie.
app.get('/media/:id', async (req, res) => {
  try {
    const m = await dbPrisma.media.findUnique({ where: { id: req.params.id } });
    if (!m) return res.status(404).type('text').send('Not found');

    const { allowed, user } = await checkMediaAccess(req, m);
    if (!allowed) {
      if (!user) return res.redirect('/ia/login');
      return res.status(403).type('text').send('You do not have access to this media.');
    }

    const buf = Buffer.isBuffer(m.data) ? m.data : Buffer.from(m.data);
    const total = buf.length;
    res.set('Content-Type', m.mimeType);
    res.set('Accept-Ranges', 'bytes');
    // Modest cache only — so changing a file from PUBLIC to private actually
    // stops it being served from a CDN/browser cache within minutes.
    res.set('Cache-Control', m.visibility === 'PUBLIC' ? 'public, max-age=600' : 'private, no-cache');

    const range = req.headers.range;
    if (range && /^bytes=/.test(range)) {
      var parts = range.replace(/bytes=/, '').split('-');
      var start = parseInt(parts[0], 10) || 0;
      var end   = parts[1] ? parseInt(parts[1], 10) : total - 1;
      if (isNaN(end) || end >= total) end = total - 1;
      if (start > end || start >= total) { res.set('Content-Range', `bytes */${total}`); return res.status(416).end(); }
      res.status(206);
      res.set('Content-Range', `bytes ${start}-${end}/${total}`);
      res.set('Content-Length', String(end - start + 1));
      return res.end(buf.subarray(start, end + 1));
    }

    // Count a view on full (non-range) loads only
    dbPrisma.media.update({ where: { id: m.id }, data: { views: { increment: 1 } } }).catch(() => {});
    res.set('Content-Length', String(total));
    res.end(buf);
  } catch (e) {
    res.status(500).type('text').send('Error');
  }
});

// ── Current user ─────────────────────────────────────────────────
app.get('/api/me', requireAuth, async (req, res) => {
  // Re-check the user's IA rank on load (throttled) so a member who has been
  // demoted/removed loses access before the page finishes loading. If they no
  // longer qualify, 401 so the client bounces them to login.
  try {
    const last  = req.user.lastRoleCheck ? new Date(req.user.lastRoleCheck).getTime() : 0;
    const stale = (Date.now() - last) > 30 * 60 * 1000; // re-check at most every 30 min
    if (stale && req.user.role !== 'DEVELOPER') {
      const { revalidateUser } = require('./lib/accessControl');
      const { getMemberRecord } = require('./lib/bot');
      const status = await revalidateUser(req.user, getMemberRecord);
      if (status === 'revoked') {
        res.clearCookie('iacms_token');
        return res.status(401).json({ error: 'Your access has changed. Please sign in again.' });
      }
      const fresh = await dbPrisma.user.findUnique({ where: { id: req.user.id } });
      if (fresh) req.user = fresh;
    }
  } catch (e) { /* never block /api/me on a revalidation hiccup */ }

  res.json({
    id:              req.user.id,
    discordId:       req.user.discordId,
    discordUsername: req.user.discordUsername,
    displayName:     req.user.displayName,
    discordAvatar:   req.user.discordAvatar,
    role:            req.user.role,
    isBlacklisted:   req.user.isBlacklisted,
    notifyAsked:     req.user.notifyAsked,
    notifyEnabled:   req.user.notifyEnabled,
    divisions:       Array.isArray(req.user.divisions) ? req.user.divisions : [],
  });
});

// ── Divisions the current user can access — powers the hub dashboard and the
// "Switch division" control in the shared nav on every dashboard. Each entry
// carries the division's group icon (from the holder account) + the user's
// Roblox rank name/tier in that division. ───
const { meta: divisionMeta, allMeta: allDivisionMeta, getDivisionConfig } = require('./lib/divisions');
app.get('/api/me/divisions', requireAuth, async (req, res) => {
  const { ALL } = require('./lib/divisions');
  let mine;
  if (req.user.role === 'DEVELOPER') {
    mine = ALL.map(division => ({ division, tier: 'LEAD', rankName: 'Developer' }));
  } else {
    mine = (Array.isArray(req.user.divisions) ? req.user.divisions : []).slice();
    // IA access is governed by the site role, not the cache — surface it here
    // even if this user's cached divisions predate the multi-division rollout.
    if (['IA', 'SUPERVISOR', 'HICOMM'].includes(req.user.role) && !mine.some(d => d.division === 'IA')) {
      mine.push({ division: 'IA', tier: ['HICOMM', 'SUPERVISOR'].includes(req.user.role) ? 'LEAD' : 'MEMBER', rankName: req.user.role });
    }
  }

  // Group icons (best-effort; empty when Roblox is unreachable / ids unset).
  let cfg = {};
  try { cfg = await getDivisionConfig(); } catch (e) { cfg = {}; }
  const icon = (d) => (cfg[d] && cfg[d].icon) || null;

  res.json({
    all:  allDivisionMeta().map(m => ({ ...m, icon: icon(m.division) })),
    mine: mine.map(d => ({ ...d, ...divisionMeta(d.division), icon: icon(d.division) })),
  });
});

// ── Current user's quota points (from the IA Database sheet) ─────
app.get('/api/me/points', requireAuth, async (req, res) => {
  try {
    const { getMemberPoints } = require('./lib/quota');
    const result = await getMemberPoints({
      discordId:      req.user.discordId,
      robloxUsername: req.user.robloxUsername,
    });
    if (result == null) return res.json({ configured: false });
    res.json({ configured: true, ...result });
  } catch (err) {
    res.json({ configured: false, error: err.message });
  }
});

// ── Page routes ──────────────────────────────────────────────────
const views = path.join(__dirname, '../client/views');

// Send HTML with comments stripped; fall back to the raw file on any error.
function sendPage(res, file) {
  try {
    let html = getMinifiedHtml(file);
    // Site-wide UI theme (dev toggle). Injected server-side so it applies for
    // everyone on first paint with no flash of the wrong theme.
    if (require('./lib/siteConfig').isOn('auroraTheme')) {
      html = html.replace('<html', '<html data-ui="aurora"');
    }
    res.type('html').send(html);
  } catch (e) { res.sendFile(file); }
}

// ── Hub — MET Police Service portal landing page ──────────────────
// Public: shows a "Sign in" CTA when logged out, and the 5 division cards
// (per-user access resolved client-side via /api/me + /api/me/divisions)
// once authenticated. requireAuth's `res.redirect('/login')` lands here too.
app.get('/',      recordVisit, (req, res) => sendPage(res, path.join(views, 'index.html')));
app.get('/login',                (req, res) => res.redirect('/' + req.url.replace(/^\/login/, '')));
app.get('/denied', recordVisit, (req, res) => sendPage(res, path.join(views, 'portal-denied.html')));

// ── IA — Internal Affairs (unchanged views, re-homed under /ia) ───
app.get('/ia',           recordVisit, (req, res) => sendPage(res, path.join(views, 'login.html')));
app.get('/ia/login',     recordVisit, (req, res) => sendPage(res, path.join(views, 'login.html')));
app.get('/ia/denied',    recordVisit, (req, res) => sendPage(res, path.join(views, 'denied.html')));
app.get('/ia/dashboard', recordVisit, requireAuth, requireDivision('IA'), (req, res) => sendPage(res, path.join(views, 'dashboard.html')));
app.get('/ia/admin',     recordVisit, requireAuth, requireDivision('IA'), (req, res) => sendPage(res, path.join(views, 'dashboard.html')));
app.get('/ia/tickets',   recordVisit, requireAuth, requireDivision('IA'), (req, res) => sendPage(res, path.join(views, 'dashboard.html')));

// ── New divisions — own dashboard view each, gated by their own division ──
function mountDivisionPages(slug, division) {
  app.get(`/${slug}`,           recordVisit, (req, res) => res.redirect('/'));
  app.get(`/${slug}/denied`,    recordVisit, (req, res) => sendPage(res, path.join(views, 'portal-denied.html')));
  app.get(`/${slug}/dashboard`, recordVisit, requireAuth, requireDivision(division),
    (req, res) => sendPage(res, path.join(views, `${slug}-dashboard.html`)));
}
mountDivisionPages('cid',   'CID');
mountDivisionPages('sco19', 'SCO19');
mountDivisionPages('flp',   'FLP');
mountDivisionPages('hpc',   'HPC');

// ── 404 / Error ──────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404);
  // Never return the HTML hub page for asset/api requests — doing so makes a
  // momentarily-missing /css or /img request resolve to HTML, which browsers
  // (and Cloudflare) can cache, leaving the page unstyled. Send a real 404.
  if (req.path.startsWith('/api/') || /\.[a-z0-9]{2,5}$/i.test(req.path)) {
    return res.type('text').send('Not found');
  }
  sendPage(res, path.join(views, 'index.html'));
});
app.use((err, req, res, next) => {
  console.error('[Server] Unhandled error:', err.stack || err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// Keep the process alive on background errors (a stray rejection from RoVer /
// Discord / Sheets calls should never take the whole site down).
process.on('unhandledRejection', (reason) => {
  console.error('[Server] Unhandled promise rejection:', (reason && reason.stack) || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught exception:', (err && err.stack) || err);
});

app.listen(PORT, () => {
  console.log(`\n🛡  IACMS running on http://localhost:${PORT}`);
  console.log(`   NODE_ENV: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   DEVELOPER_DISCORD_ID: ${process.env.DEVELOPER_DISCORD_ID || 'NOT SET'}`);
  console.log(`   DB: ${process.env.DATABASE_URL ? 'SET' : 'NOT SET'}\n`);
});
