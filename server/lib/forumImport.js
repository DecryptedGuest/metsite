// server/lib/forumImport.js
// Shared bulk-import logic for transferring cases from a Discord forum channel.
// Enhanced: reads the Google Doc linked in each forum post to extract:
//   - Suspect Roblox username + display name
//   - Investigator (IA officer) Discord username + Roblox username/ID
//   - Punishments issued (from "Punishments Issued:" section)
// Used by both the dev-only /import-cases slash command and the CLI script.

const fetch  = require('node-fetch');
const prisma = require('./db');

// ── Title parsing ─────────────────────────────────────────────────
// Handles all observed variants, e.g.:
//   "Case - 1216- (HughesSiden16(1397202290552864893)"
//   "Case - 1215 qqverx (1499516919894638942)"
//   "Case #1218 Fenhedddd (993208141598695515)"
//   "Case - 1212 - Minigun543E (1461473563541377256)"
//   "CASE #1205 Mufti_Sheik (1167251064223961142)"
// Returns { username, discordId } or null if it can't be parsed (skip it).
function parseTitle(title) {
  if (!title) return null;
  const norm = String(title).replace(/[–—]/g, '-'); // normalise en/em dashes
  if (!/case/i.test(norm)) return null;

  // Discord ID = the last 15-21 digit run in the title
  const ids = norm.match(/\d{15,21}/g);
  if (!ids) return null;
  const discordId = ids[ids.length - 1];

  // Everything before the Discord ID, minus "Case", separators and the case number
  let before = norm.slice(0, norm.indexOf(discordId));
  before = before.replace(/^.*?case\s*[-#]?\s*\d{0,6}/i, '');
  let username = before.replace(/[()#\-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (username.includes(' ')) username = username.split(' ').filter(Boolean).pop();
  username = (username || '').replace(/[^A-Za-z0-9_]/g, '');
  if (!username || username.length < 3) return null;

  return { username, discordId };
}

// Map a thread's applied forum tags → case status
function statusFromTags(thread, tagNameById) {
  const names = (thread.appliedTags || []).map(id => (tagNameById.get(id) || '').toLowerCase());
  if (names.some(n => n.includes('denied')))                       return 'DENIED';
  if (names.some(n => n.includes('approved')))                     return 'APPROVED';
  if (names.some(n => n.includes('await') || n.includes('pending'))) return 'PENDING';
  return 'PENDING';
}

// Extract all Google Docs/Drive links from a string
const GDOC_RE = /https:\/\/docs\.google\.com\/document\/d\/([A-Za-z0-9_-]+)[^\s<>]*/gi;
const URL_RE  = /(https?:\/\/[^\s<>()]+)/i;

// ── Google Doc fetcher & parser ────────────────────────────────────
/**
 * Fetch a Google Doc as plain text using the public export endpoint.
 * The doc must be shared with "Anyone with the link can view".
 * Returns the raw text string, or null on failure.
 */
async function fetchGoogleDocText(docId) {
  const url = `https://docs.google.com/document/d/${docId}/export?format=txt`;
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IABot/1.0)' },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch (e) {
    return null;
  }
}

/**
 * Fetch a Google Doc as HTML. The HTML export preserves the strikethrough
 * formatting the IA team uses to mark the punishment(s) actually issued in the
 * "Punishment Issued" checklist — which the plain-text export loses.
 */
async function fetchGoogleDocHtml(docId) {
  const url = `https://docs.google.com/document/d/${docId}/export?format=html`;
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IABot/1.0)' },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch (e) {
    return null;
  }
}

/**
 * From the doc HTML, return the checklist items that are struck through — i.e.
 * the punishment(s) the IA officer actually selected. Returns an array of the
 * raw item texts (e.g. ["Zero Tolerance [3-5]", "Strike(s) [1-2]"]).
 *
 * Google Docs randomises CSS class names per export, so we first collect every
 * class whose rule contains `text-decoration:line-through`, then flag any list
 * item (or its spans) carrying one of those classes.
 */
function parseCheckedPunishments(html) {
  if (!html) return [];
  const strikeClasses = new Set();
  const ruleRe = /\.(c\d+)\{([^}]*)\}/g;
  let r;
  while ((r = ruleRe.exec(html))) {
    if (/text-decoration\s*:\s*line-through/i.test(r[2])) strikeClasses.add(r[1]);
  }
  if (!strikeClasses.size) return [];

  // Isolate the "Punishment Issued" <ul>…</ul>
  const pi = html.search(/Punishment[s]?\s+Issued/i);
  if (pi === -1) return [];
  const ulMatch = html.slice(pi, pi + 4000).match(/<ul[^>]*>([\s\S]*?)<\/ul>/i);
  if (!ulMatch) return [];

  const chosen = [];
  const liRe = /<li class="([^"]*)"[^>]*>([\s\S]*?)<\/li>/gi;
  let li;
  while ((li = liRe.exec(ulMatch[1]))) {
    const classes = new Set(li[1].split(/\s+/));
    let sp;
    const spRe = /<span class="([^"]*)"/gi;
    while ((sp = spRe.exec(li[2]))) sp[1].split(/\s+/).forEach(c => classes.add(c));
    const text = li[2].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
    if ([...classes].some(c => strikeClasses.has(c))) chosen.push(text);
  }
  return chosen;
}

// Strip "On behalf of the IA, we shall give a …" boilerplate from a decision,
// leaving the substantive part (e.g. "5d ZT and a strike").
function cleanDecision(s) {
  if (!s) return null;
  let d = s.trim();
  d = d.replace(/^on\s+(?:the\s+)?behalf\s+of\s+(?:the\s+)?ia\b[,.]?\s*/i, '');
  d = d.replace(/^we\s+(?:shall|should|will|would|have\s+decided\s+to|are\s+going\s+to|hereby)\s+/i, '');
  d = d.replace(/^(?:give|issue|apply|hand\s+out|provide|impose)\s+/i, '');
  d = d.replace(/^(?:the\s+suspect\s+)?(?:a|an|the)\s+/i, '');
  return d.trim() || null;
}

// Build canonical punishment objects from the checked checklist items, taking
// the duration (days) and strike count from the Final Decision text.
function buildPunishmentsFromChecklist(checkedTexts, finalDecision) {
  if (!checkedTexts || !checkedTexts.length) return [];
  const fd = (finalDecision || '').toLowerCase();
  const dM = fd.match(/(\d+)\s*(?:d\b|days?\b)/);
  const days = dM ? parseInt(dM[1], 10) : null;
  const sM = fd.match(/(\d+)\s*strikes?/);
  const strikeNum = sM ? parseInt(sM[1], 10) : 1;

  const out = [];
  const push = (action, durationDays = null) => {
    if (!out.find(o => o.action === action)) out.push({ action, roleId: null, durationDays });
  };
  for (const t of checkedTexts) {
    const x = t.toLowerCase();
    if (/zero\s*tolerance|\bzt\b/.test(x)) push('Zero Tolerance', days);
    else if (/written\s*warning/.test(x)) push('Written Warning');
    else if (/verbal\s*warning/.test(x)) push('Verbal Warning');
    else if (/activity\s*strike/.test(x)) push('Activity Strike');
    else if (/strike/.test(x))            push(`Disciplinary Strike ${strikeNum}`);
    else if (/suspension|suspend/.test(x)) push('Suspension', days);
    else if (/demot/.test(x))             push('Demotion');
    else if (/terminat/.test(x))          push('Termination');
    else if (/blacklist/.test(x))         push('Blacklist');
  }
  return out;
}

/**
 * Parse an Internal Affairs Case File document text.
 *
 * Expected sections (all optional — we degrade gracefully):
 *
 *   Suspect's Roblox Username:   SomeUser
 *   Suspect's Display Name:      Some Display
 *   Investigating Officer:       OfficerName
 *   Officer's Roblox Username:   OfficerRoblox
 *   Officer's Discord Username:  OfficerDiscord#0000
 *
 *   Punishments Issued:
 *   * Written Warning
 *   * Strike: 1
 *   * Zero Tolerance: 5 days
 *   * Termination
 *
 *   Final Decision: Written Warning
 *
 * Returns:
 * {
 *   suspectRobloxUsername:      string|null,
 *   suspectRobloxDisplayName:   string|null,
 *   investigatorDiscordUsername:string|null,
 *   investigatorRobloxUsername: string|null,
 *   punishments:                string[],   // list of punishment strings
 *   punishmentsSummary:         string|null,
 *   finalDecision:              string|null,
 * }
 */
// Canonical punishment names used across the app (mirrors ACTION_CONFIG).
// "Suspension" is recognised from docs even though it has no role mapping.
function normalizePunishments(decision) {
  if (!decision) return [];
  const d = decision.toLowerCase();

  // A duration mentioned anywhere in the decision, e.g. "5d", "5 day", "7 days".
  const durM = d.match(/(\d+)\s*(?:d\b|days?\b)/);
  const dur  = durM ? parseInt(durM[1], 10) : null;

  const out = [];
  const add = (action, timed = false) => {
    if (!out.find(o => o.action === action)) {
      out.push({ action, roleId: null, durationDays: timed ? dur : null });
    }
  };

  if (/blacklist/.test(d))                  add('Blacklist');
  if (/demot/.test(d))                      add('Demotion');
  if (/terminat/.test(d))                   add('Termination');
  if (/\bzt\b|zero\s*tolerance/.test(d))    add('Zero Tolerance', true);  // "ZT" abbreviation
  if (/written\s*warning/.test(d))          add('Written Warning');
  if (/verbal\s*warning/.test(d))           add('Verbal Warning');
  if (/suspension|suspend/.test(d))         add('Suspension', true);
  if (/activity\s*strike/.test(d))          add('Activity Strike');

  // Strikes with a count: "1 strike", "2 strikes", "strike (1)", "strike: 2",
  // "disciplinary strike 1". Capture the number where present; default 1.
  const m = d.match(/(\d+)\s*(?:disciplinary\s*)?strikes?|(?:disciplinary\s*)?strikes?\s*[\(\[:]?\s*(\d+)/);
  if (m) {
    const n = m[1] || m[2] || '1';
    add(`Disciplinary Strike ${n}`);
  } else if (/\bstrike\b/.test(d) && !/activity\s*strike/.test(d)) {
    add('Disciplinary Strike 1');
  }
  return out;
}

/**
 * Parse an Internal Affairs Case File doc.
 *
 * Real format (confirmed from production docs):
 *
 *   Suspect:
 *   User -Calebjayce7
 *   Rank -Inspector
 *   User ID:  1375225950274584656            ← Discord ID
 *
 *   Investigating Officer:
 *   User -MellisaKumi
 *   Rank -Probationary Investigation
 *   User ID:  1413694230261665823            ← Discord ID
 *
 *   Punishment Issued:                        ← a CHECKLIST of every option;
 *   * Zero Tolerance [3-5]                      plain-text export loses the
 *   * Written Warning                           checkbox state, so we IGNORE it.
 *   * Strike(s) [1] ...
 *
 *   Allegation(s): PL-M304,MC-S204
 *   Summary of case: …
 *   Final Decision:                           ← AUTHORITATIVE punishment
 *       1 strike.
 */
function parseDocText(text) {
  if (!text) return null;
  const norm = text.replace(/\r/g, '');

  const result = {
    suspectRobloxUsername:       null,
    suspectRobloxDisplayName:    null,
    suspectUserId:               null,   // Discord ID from the doc, if present
    suspectRank:                 null,
    investigatorRobloxUsername:  null,
    investigatorDiscordId:       null,
    investigatorDiscordUsername: null,   // resolved later by the importer
    investigatorRank:            null,
    finalDecision:               null,
    punishments:                 [],
    punishmentsSummary:          null,
    allegations:                 null,
    summary:                     null,
  };

  const find = re => { const m = norm.match(re); return m ? m.index : -1; };
  const next = (from, idxs) => idxs.filter(i => i > from).sort((a, b) => a - b)[0] ?? norm.length;

  const iSuspect  = find(/Suspect\s*:/i);
  const iOfficer  = find(/Investigating\s+Officer\s*:/i);
  const iPunish   = find(/Punishment[s]?\s+Issued\s*:/i);
  const iAlleg    = find(/Allegation\(?s?\)?\s*:/i);
  const iEvidence = find(/Evidence\s+Exhibits?\s*:/i);
  const iSummary  = find(/Summary\s+of\s+case\s*:/i);
  const iFinal    = find(/Final\s+Decision\s*:/i);
  const iApproval = find(/Date\s+of\s+Approval\s*:/i);

  // Pull "User -X", "Rank -X", "User ID: digits" out of a labelled block.
  function parseEntity(block) {
    if (!block) return {};
    const user = block.match(/User\s*[-–—:]\s*([^\n]+)/i);
    const rank = block.match(/Rank\s*[-–—:]\s*([^\n]+)/i);
    const uid  = block.match(/User\s*ID\s*[:\-–—]?\s*([0-9]{4,25})/i);
    const clean = s => s ? s.replace(/[*\t]/g, '').trim() : null;
    return { user: clean(user && user[1]), rank: clean(rank && rank[1]), uid: uid ? uid[1] : null };
  }

  if (iSuspect !== -1) {
    const e = parseEntity(norm.slice(iSuspect, next(iSuspect, [iOfficer, iPunish])));
    result.suspectRobloxUsername = e.user || null;
    result.suspectRank           = e.rank || null;
    result.suspectUserId         = e.uid  || null;
  }
  if (iOfficer !== -1) {
    const e = parseEntity(norm.slice(iOfficer, next(iOfficer, [iPunish, iAlleg, iEvidence, iSummary])));
    result.investigatorRobloxUsername = e.user || null;
    result.investigatorRank           = e.rank || null;
    result.investigatorDiscordId      = e.uid  || null;
  }
  if (iAlleg !== -1) {
    const seg = norm.slice(iAlleg, next(iAlleg, [iEvidence, iSummary, iFinal]))
      .replace(/Allegation\(?s?\)?\s*:/i, '').replace(/[\t]/g, '').trim();
    result.allegations = seg ? seg.split('\n')[0].trim() : null;
  }
  if (iSummary !== -1) {
    const seg = norm.slice(iSummary, next(iSummary, [iFinal, iApproval]))
      .replace(/Summary\s+of\s+case\s*:/i, '').replace(/[\t]/g, '').trim();
    result.summary = seg ? seg.slice(0, 1500) : null;
  }
  if (iFinal !== -1) {
    let seg = norm.slice(iFinal, next(iFinal, [iApproval])).replace(/Final\s+Decision\s*:/i, '');
    seg = seg.split('\n').map(l => l.replace(/^[\s*•\-–—\t]+/, '').trim()).filter(Boolean).join(' ').trim();
    result.finalDecision = seg || null;
  }

  // Punishments come from the Final Decision (authoritative), not the checklist.
  result.punishments        = normalizePunishments(result.finalDecision);
  result.punishmentsSummary = result.finalDecision
    ? result.finalDecision.slice(0, 200)
    : (result.punishments.length ? result.punishments.map(p => p.action).join(', ').slice(0, 200) : null);

  return result;
}

// ── Helpers ───────────────────────────────────────────────────────
// Wraps a promise with a timeout; throws on expiry.
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms);
    promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

// ── Fetch every thread in a forum channel (active + archived) ─────
// limit: if set, stop fetching once we have at least this many threads (for dry runs)
async function fetchAllThreads(channel, onProgress, limit = null) {
  const all = new Map();

  // Step 1: active threads
  console.log('[fetchAllThreads] fetching active threads…');
  onProgress('Fetching active threads…');
  try {
    const active = await withTimeout(channel.threads.fetchActive(), 30_000, 'fetchActive');
    active.threads.forEach(t => all.set(t.id, t));
    console.log(`[fetchAllThreads] active: ${all.size}`);
    onProgress(`Got ${all.size} active threads…`);
  } catch (e) {
    console.error('[fetchAllThreads] fetchActive error:', e.message);
    onProgress(`fetchActive error: ${e.message}`);
  }

  if (limit && all.size >= limit) {
    console.log(`[fetchAllThreads] limit ${limit} satisfied by active threads`);
    return [...all.values()].slice(0, limit);
  }

  // Step 2: archived threads
  console.log('[fetchAllThreads] fetching archived threads…');
  onProgress('Fetching archived threads…');
  let before, guard = 0;
  while (guard++ < 2000) {
    console.log(`[fetchAllThreads] archived page ${guard}, before=${before}, total so far=${all.size}`);
    onProgress(`Fetching archived page ${guard}… (${all.size} threads so far)`);
    let page;
    try {
      page = await withTimeout(
        channel.threads.fetchArchived({ type: 'public', limit: 100, before }),
        30_000,
        `fetchArchived page ${guard}`,
      );
    } catch (e) {
      console.error(`[fetchAllThreads] fetchArchived page ${guard} error:`, e.message);
      onProgress(`fetchArchived error on page ${guard}: ${e.message}`);
      break;
    }
    console.log(`[fetchAllThreads] page ${guard} returned ${page?.threads?.size ?? 'null'} threads, hasMore=${page?.hasMore}`);
    if (!page || page.threads.size === 0) break;
    page.threads.forEach(t => all.set(t.id, t));
    onProgress(`Got ${all.size} threads total…`);
    if (limit && all.size >= limit) {
      console.log(`[fetchAllThreads] limit ${limit} reached`);
      break;
    }
    const last = [...page.threads.values()].pop();
    before = last?.archivedTimestamp || last?.archivedAt;
    if (!page.hasMore || !before) break;
  }

  const result = limit ? [...all.values()].slice(0, limit) : [...all.values()];
  console.log(`[fetchAllThreads] done — returning ${result.length} threads`);
  return result;
}

// Resolve many Roblox usernames → ids (batches of 100)
async function resolveRobloxIds(usernames) {
  const map = new Map();
  const uniq = [...new Set(usernames.map(u => u.trim()).filter(Boolean))];
  for (let i = 0; i < uniq.length; i += 100) {
    const batch = uniq.slice(i, i + 100);
    try {
      const res = await fetch('https://users.roblox.com/v1/usernames/users', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ usernames: batch, excludeBannedUsers: false }),
      });
      if (res.ok) {
        const data = await res.json();
        for (const u of data.data || []) {
          map.set((u.requestedUsername || u.name || '').toLowerCase(), { id: String(u.id), name: u.name, displayName: u.displayName || null });
        }
      }
    } catch (e) { /* ignore batch errors */ }
    await new Promise(r => setTimeout(r, 350));
  }
  return map;
}

// Resolve a Discord user ID → username via the bot (cached). Returns null on miss.
async function resolveDiscordUsername(client, discordId, cache) {
  if (!discordId || !/^\d{17,20}$/.test(discordId)) return null;
  if (cache.has(discordId)) return cache.get(discordId);
  let username = null;
  const guildId = process.env.DISCORD_GUILD_ID;
  try {
    if (guildId) {
      const guild  = await client.guilds.fetch(guildId);
      const member = await guild.members.fetch(discordId);
      username = member.user.username;
    }
  } catch { /* not in guild */ }
  if (!username) {
    try { const u = await client.users.fetch(discordId); username = u?.username || null; } catch {}
  }
  cache.set(discordId, username);
  return username;
}

/**
 * Import all cases from a forum channel.
 * @param {Client} client    discord.js client (must be in the channel's guild)
 * @param {string} channelId forum channel id
 * @param {object} opts      { dry?: boolean, onProgress?: (msg)=>void }
 * Returns a summary object.
 */
async function importForumCases(client, channelId, opts = {}) {
  const { dry = false, onProgress = () => {} } = opts;

  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.threads) throw new Error('That channel is not a forum channel.');

  // Tag id → name (for status)
  const tagNameById = new Map((channel.availableTags || []).map(t => [t.id, t.name]));

  onProgress(dry ? 'Dry run — fetching up to 15 cases…' : 'Fetching all forum posts…');
  const threads = await fetchAllThreads(channel, onProgress, dry ? 15 : null);
  onProgress(`Found ${threads.length} posts. Parsing…`);

  // Parse + read starter-message link
  // In dry mode we only process the first 15 valid cases (fast preview).
  // In live mode we process everything.
  const DRY_LIMIT = 15;
  const parsed = [];
  let skipped = 0;
  for (const t of threads) {
    // Stop early in dry mode once we have enough valid cases
    if (dry && parsed.length >= DRY_LIMIT) break;

    const info = parseTitle(t.name || '');
    if (!info) { skipped++; continue; }

    let caseLink  = null;
    let docId     = null;

    try {
      const starter = await withTimeout(t.fetchStarterMessage(), 15_000, 'fetchStarterMessage').catch(() => null);
      const text = starter
        ? `${starter.content || ''} ${(starter.embeds || []).map(e => e.url || '').join(' ')}`
        : '';

      // Extract the first Google Doc link from the message
      GDOC_RE.lastIndex = 0;
      const gdocMatch = GDOC_RE.exec(text);
      if (gdocMatch) {
        caseLink = gdocMatch[0].split('?')[0]; // clean URL without query params
        docId    = gdocMatch[1];
      } else {
        // Fall back to any URL
        const um = URL_RE.exec(text);
        caseLink = um ? um[1] : null;
      }
    } catch (e) { /* deleted starter message */ }

    parsed.push({
      username:  info.username,
      discordId: info.discordId,
      caseLink,
      docId,
      status:    statusFromTags(t, tagNameById),
      createdAt: t.createdAt || (t.createdTimestamp ? new Date(t.createdTimestamp) : new Date()),
      // doc-parsed fields, filled in below
      docInfo: null,
    });
  }

  // Oldest → newest
  parsed.sort((a, b) => a.createdAt - b.createdAt);

  // ── Fetch & parse Google Docs ──────────────────────────────────────
  // We do this even for dry runs so the preview is accurate.
  const docsWithId = parsed.filter(p => p.docId);
  onProgress(`Fetching ${docsWithId.length} Google Docs for punishment & investigator data…`);

  let docsFetched = 0;
  for (const p of docsWithId) {
    const [text, html] = await Promise.all([
      fetchGoogleDocText(p.docId),
      fetchGoogleDocHtml(p.docId),
    ]);
    p.docInfo = parseDocText(text);
    if (p.docInfo) {
      // Punishment(s): prefer the struck-through checklist items (authoritative),
      // with duration/strike-count taken from the Final Decision. Fall back to
      // parsing the Final Decision text only if nothing is checked.
      const checked = parseCheckedPunishments(html);
      const fromChecklist = buildPunishmentsFromChecklist(checked, p.docInfo.finalDecision);
      if (fromChecklist.length) p.docInfo.punishments = fromChecklist;
      p.docInfo.checkedPunishments = checked;

      // Strip the "On behalf of the IA…" boilerplate for display.
      p.docInfo.finalDecisionClean = cleanDecision(p.docInfo.finalDecision);
      p.docInfo.punishmentsSummary =
        (p.docInfo.punishments.length ? p.docInfo.punishments.map(x => x.action + (x.durationDays ? ` (${x.durationDays}d)` : '')).join(', ') : null)
        || p.docInfo.finalDecisionClean
        || p.docInfo.punishmentsSummary;
    }
    docsFetched++;
    // Light rate-limiting: ~4 docs/sec
    if (docsFetched % 10 === 0) {
      onProgress(`…${docsFetched}/${docsWithId.length} docs read`);
      await new Promise(r => setTimeout(r, 250));
    }
  }

  const byStatus = { PENDING: 0, APPROVED: 0, DENIED: 0 };
  parsed.forEach(p => { byStatus[p.status]++; });

  if (dry) {
    return {
      dry: true, parsed: parsed.length, skipped, created: 0, byStatus,
      preview: parsed.slice(0, 15).map((p, i) => ({
        caseRef:      `#${i + 1}`,
        username:     p.docInfo?.suspectRobloxUsername || p.username,
        discordId:    p.discordId,
        status:       p.status,
        caseLink:     p.caseLink || null,
        investigator: p.docInfo?.investigatorRobloxUsername || p.docInfo?.investigatorDiscordId || null,
        punishments:  p.docInfo?.punishmentsSummary
                        || (p.docInfo?.punishments?.length ? p.docInfo.punishments.map(x => x.action).join(', ') : null),
      })),
    };
  }

  onProgress(`Resolving Roblox usernames…`);

  // Collect all usernames to resolve: suspects + investigators from docs
  const usernamesFromDocs  = docsWithId.map(p => p.docInfo?.suspectRobloxUsername).filter(Boolean);
  const investigatorNames  = docsWithId.map(p => p.docInfo?.investigatorRobloxUsername).filter(Boolean);
  const allUsernames       = [...parsed.map(p => p.username), ...usernamesFromDocs, ...investigatorNames];
  const robloxMap          = await resolveRobloxIds(allUsernames);

  // Importer (submitter) user, clearly labelled
  const importer = await prisma.user.upsert({
    where:  { discordId: 'SYSTEM_LEGACY_IMPORT' },
    update: {},
    create: { discordId: 'SYSTEM_LEGACY_IMPORT', discordUsername: 'Legacy Import', displayName: 'Legacy Import', role: 'IA' },
  });

  // Full refresh: clear any previous legacy import so re-runs are idempotent
  const prior = await prisma.case.findMany({ where: { userId: importer.id }, select: { id: true } });
  if (prior.length) {
    const ids = prior.map(c => c.id);
    await prisma.caseAction.deleteMany({ where: { caseId: { in: ids } } });
    await prisma.casePunishment.deleteMany({ where: { caseId: { in: ids } } });
    await prisma.case.deleteMany({ where: { id: { in: ids } } });
    onProgress(`Cleared ${prior.length} previously-imported cases (refresh).`);
  }

  const discordCache = new Map(); // discordId → username (avoid refetching)
  let created = 0;
  for (let i = 0; i < parsed.length; i++) {
    const p      = parsed[i];
    const caseRef = `#${i + 1}`;
    const doc    = p.docInfo;

    // Prefer doc-sourced Roblox username for the suspect; fall back to title username
    const suspectUsernameForLookup = (doc?.suspectRobloxUsername || p.username).toLowerCase();
    const roblox = robloxMap.get(suspectUsernameForLookup)
                || robloxMap.get(p.username.toLowerCase());

    // Investigator Roblox info
    let investigatorRobloxId       = null;
    let investigatorRobloxUsername = null;
    if (doc?.investigatorRobloxUsername) {
      const ir = robloxMap.get(doc.investigatorRobloxUsername.toLowerCase());
      if (ir) {
        investigatorRobloxId       = ir.id;
        investigatorRobloxUsername = ir.name;
      } else {
        investigatorRobloxUsername = doc.investigatorRobloxUsername;
      }
    }

    // Investigator Discord username — resolve the doc's Discord ID via the bot.
    const investigatorDiscordUsername =
      (await resolveDiscordUsername(client, doc?.investigatorDiscordId, discordCache))
      || doc?.investigatorDiscordUsername || null;

    // The suspect's Discord ID: prefer the title's, fall back to the doc's.
    const suspectDiscordId = p.discordId || (/^\d{17,20}$/.test(doc?.suspectUserId || '') ? doc.suspectUserId : null);

    // Notes are left for the IA member to fill in (default N/A); the investigator,
    // allegation and summary live in their own fields, not crammed into notes.
    const notes = 'N/A';

    try {
      await prisma.case.create({
        data: {
          caseRef,
          userId:                     importer.id,
          officerDiscordId:           suspectDiscordId,
          robloxUserId:               roblox?.id  || null,
          robloxUsername:             roblox?.name || doc?.suspectRobloxUsername || p.username,
          suspectRobloxDisplayName:   roblox?.displayName || doc?.suspectRobloxDisplayName || null,
          investigatorRobloxId,
          investigatorRobloxUsername,
          investigatorDiscordUsername,
          punishmentsSummary:          doc?.punishmentsSummary || null,
          action:                      doc?.punishmentsSummary
                                         ? `Punishments: ${doc.punishmentsSummary}`
                                         : 'Legacy Case (imported)',
          actions:                     doc?.punishments?.length
                                         ? doc.punishments
                                         : null,
          reason:                      doc?.allegations
                                         ? doc.allegations.slice(0, 200)
                                         : 'N/A',
          notes,
          caseLink:                    p.caseLink || null,
          status:                      p.status,
          createdAt:                   p.createdAt,
        },
      });
      created++;
      if (created % 100 === 0) onProgress(`…${created}/${parsed.length} imported`);
    } catch (e) {
      // Most likely a caseRef clash with a non-import case — skip
    }
  }

  // Keep the auto-counter ahead of the imported range
  await prisma.caseCounter.upsert({
    where: { id: 1 }, update: { count: parsed.length }, create: { id: 1, count: parsed.length },
  }).catch(() => {});

  return { dry: false, parsed: parsed.length, skipped, created, byStatus };
}

module.exports = {
  importForumCases, parseTitle, parseDocText, fetchGoogleDocText,
  fetchGoogleDocHtml, parseCheckedPunishments, buildPunishmentsFromChecklist, cleanDecision,
};
