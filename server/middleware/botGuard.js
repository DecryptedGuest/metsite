// server/middleware/botGuard.js
// Blocks self-identifying AI crawlers/agents and headless scrapers from
// fetching the site's HTML pages — the "tell an AI to grab / replicate this
// site" case. It is a real block for bots that announce themselves (which the
// major AI crawlers do) and for common automation stacks; it is NOT a defence
// against a headless browser wearing a normal Chrome user-agent (nothing served
// to a browser can be — the real protection is that the app sits behind login).
//
// Scope: only HTML page requests. API, auth, webhooks, static assets and
// service files are skipped so Roblox/Discord integrations, health checks and
// asset loads are never affected.

// Self-identifying AI crawlers, trainers and assistant fetchers.
const AI_BOTS = /(GPTBot|ChatGPT-User|OAI-SearchBot|OpenAI|anthropic-ai|Claude-Web|ClaudeBot|Claude-User|Claude-SearchBot|CCBot|Google-Extended|GoogleOther|Google-CloudVertexBot|PerplexityBot|Perplexity-User|Bytespider|Amazonbot|Applebot-Extended|cohere-ai|Diffbot|DuckAssistBot|ImagesiftBot|img2dataset|Omgili(bot)?|YouBot|Meta-External(Agent|Fetcher)|FacebookBot|Timpibot|iaskspider|PetalBot|DataForSeoBot|magpie-crawler|Webzio|AI2Bot(-Dolma)?|Kangaroo Bot|TikTokSpider|Awario|peer39_crawler|Scrapy|VelenPublicWebCrawler|FriendlyCrawler|SemanticScholarBot|ISSCyberRiskCrawler|Devin|OperatorBot|NovaAct|xAI|GrokBot)/i;

// Generic automation / scripting stacks used to mirror or scrape a site.
const AUTOMATION = /(HeadlessChrome|PhantomJS|Puppeteer|Playwright|Selenium|python-requests|python-httpx|aiohttp|node-fetch|axios\/|http\.rb|Guzzle|libwww-perl|WWW-Mechanize|scrapy|httrack|wget|SiteSucker|WebCopier|Teleport)/i;

// Paths that must never be bot-gated (integrations, assets, service files).
function isExempt(p) {
  if (p.startsWith('/api') || p.startsWith('/auth') || p.startsWith('/webhook')) return true;
  if (p === '/robots.txt' || p === '/sw.js' || p === '/manifest.json' || p === '/favicon.ico') return true;
  // static asset extensions
  return /\.(js|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|map|json|mp4|webm|mp3|wav|pdf)$/i.test(p);
}

const BLOCK_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="robots" content="noindex, noai, noimageai"><title>Not available to bots</title>' +
  '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
  'background:#0b0f1a;color:#e6e9ef;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;text-align:center;padding:24px}' +
  '.c{max-width:460px}.i{font-size:46px;margin-bottom:14px}h1{font-size:20px;margin:0 0 10px}p{color:#9aa3b2;line-height:1.6;font-size:14px}</style></head>' +
  '<body><div class="c"><div class="i"><img src="/img/emoji/met_bot.png" alt="" width="48" height="48"><img src="/img/emoji/met_denied.png" alt="" width="48" height="48"></div><h1>This site isn’t available to automated agents</h1>' +
  '<p>Access by AI crawlers, scrapers and automated agents is not permitted. The Metropolitan Police portal is for its members, in a normal browser, after signing in.</p></div></body></html>';

function botGuard(req, res, next) {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (isExempt(req.path)) return next();
    const ua = req.headers['user-agent'] || '';
    const isAiBot = AI_BOTS.test(ua);
    const isAutomation = AUTOMATION.test(ua);
    if (!isAiBot && !isAutomation) return next();

    // Log it to the dev Security Center (best-effort, non-blocking).
    try {
      require('../lib/audit').record({
        req, action: 'BOT_BLOCKED', category: 'SECURITY', targetType: 'request',
        summary: `Blocked ${isAiBot ? 'AI crawler' : 'automation'} on ${req.path} — UA: ${ua.slice(0, 120)}`,
      });
    } catch (e) { /* ignore */ }

    res.status(403);
    res.setHeader('X-Robots-Tag', 'noindex, noai, noimageai, noarchive');
    if ((req.headers.accept || '').includes('application/json')) {
      return res.json({ error: 'Automated access is not permitted.' });
    }
    return res.type('html').send(BLOCK_HTML);
  } catch (e) { return next(); }
}

module.exports = { botGuard, AI_BOTS, AUTOMATION };
