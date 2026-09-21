// server/lib/quotaScreenshot.js
// Import a weekly quota leaderboard from a screenshot.
//
// The leaderboard is rendered by a bot this codebase does not own, so there is
// no API behind it and no database to read: the picture IS the record. Rather
// than have somebody retype thirty rows into the sheet, the picture is read
// once and turned into the same writeWeek payload the ordinary sync uses.
//
// ── Why it is preview-then-apply ──────────────────────────────────
// Reading an image is a guess, however good. So nothing is written until the
// plan has been looked at: every row comes back with what was read, who it
// matched, and what will be written, and the apply step takes the plan rather
// than re-reading the picture.
//
// ── Where the points land ─────────────────────────────────────────
// A leaderboard is a weekly TOTAL. It carries no day breakdown, and inventing
// one would be making data up. So the whole total goes in a single day column —
// the day the sync runs — and the other six are left alone rather than being
// zeroed, because a zero is a claim that somebody did nothing that day and the
// picture does not say that.
const quota = require('./quota');
const { nameFromNickname } = require('./iaSheetSync');

const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

// The targets, which the sheet and the leaderboard agree on.
const TARGETS = { 'Middle Command': 20, 'Low Command': 30, 'High Command': null };

const MODEL = process.env.QUOTA_OCR_MODEL || 'claude-opus-5';

const SYSTEM = `You read a screenshot of a Discord bot's "Weekly Quota Leaderboard" and return its rows as JSON.

The image has group headings ("Middle Ranks · 20 pts/week", "Low Ranks · 30 pts/week", "IA HICOMM") and under each a list of members. A member row shows a placing, a nickname like "IA-PINV | Opticx_onYT12", and on the right either "136/30 pts", or "Exempt", or "Exempt (LOA)".

Return ONLY a JSON object of this exact shape, with no prose and no code fence:

{
  "trackingSince": "<the date after 'Tracking since', ISO yyyy-mm-dd, or null>",
  "rows": [
    {
      "group": "<Middle Command | Low Command | High Command>",
      "nickname": "<the nickname exactly as printed, including the rank prefix and the | separator>",
      "points": <the number before the slash, or null when the row says Exempt>,
      "target": <the number after the slash, or null>,
      "status": "<counted | exempt | loa>"
    }
  ]
}

Rules:
- "Middle Ranks" is group "Middle Command", "Low Ranks" is "Low Command", "IA HICOMM" is "High Command".
- "Exempt (LOA)" is status "loa". A plain "Exempt" is status "exempt". Everything else is "counted".
- Copy each nickname CHARACTER FOR CHARACTER. These are usernames: do not correct spelling, do not change capitalisation, do not expand or tidy anything. "gfgdrfgdfge" is a real name.
- Include EVERY member row you can see, in the order they appear.
- If a value is genuinely unreadable use null rather than guessing.`;

/**
 * Read the leaderboard out of an image.
 *
 * @param {Buffer|string} image  raw bytes, or a base64 string
 * @param {string} mediaType     image/png, image/jpeg, image/webp, image/gif
 */
async function readLeaderboard(image, mediaType = 'image/png') {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return { ok: false, reason: 'ANTHROPIC_API_KEY is not set, so a screenshot cannot be read. '
      + 'Set it, or paste the leaderboard as text instead.' };
  }

  const data = Buffer.isBuffer(image) ? image.toString('base64') : String(image);
  // The API limit is 5MB per image, and base64 is 4/3 of the bytes.
  if (data.length > 5 * 1024 * 1024 * 1.34) {
    return { ok: false, reason: 'That image is over the 5MB limit · take the screenshot again at a smaller size.' };
  }

  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8000,
        system: SYSTEM,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
            { type: 'text', text: 'Read this leaderboard.' },
          ],
        }],
      }),
    });
  } catch (err) {
    return { ok: false, reason: `Could not reach the API: ${err.message}` };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, reason: `The API refused the request (HTTP ${res.status})`
      + (body ? `: ${body.slice(0, 300)}` : '') };
  }

  const payload = await res.json().catch(() => null);
  const text = payload && Array.isArray(payload.content)
    ? payload.content.map(c => c.text || '').join('').trim() : '';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { ok: false, reason: 'The reply held no JSON. Try a clearer screenshot.' };

  let parsed;
  try { parsed = JSON.parse(match[0]); }
  catch (err) { return { ok: false, reason: `The reply was not valid JSON: ${err.message}` }; }

  const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
  if (!rows.length) return { ok: false, reason: 'No member rows were found in that image.' };

  return { ok: true, trackingSince: parsed.trackingSince || null, rows };
}

/** Which day column the total lands in, as writeWeek names it. */
function dayKeyFor(now = new Date()) {
  const tz = process.env.QUOTA_TIMEZONE || 'Europe/London';
  const local = new Date(now.toLocaleString('en-US', { timeZone: tz }));
  return DAYS[local.getDay()];
}

/**
 * Turn read rows into a writeWeek payload, without writing anything.
 *
 * Every row is reported, including the ones that cannot be used, because a
 * silent drop is how somebody's points go missing.
 */
function planFromRows(rows, { now = new Date() } = {}) {
  const dayKey = dayKeyFor(now);
  const out = { ok: true, dayKey, rows: [], skipped: [], counts: { counted: 0, exempt: 0, loa: 0 } };

  for (const raw of (rows || [])) {
    const nickname = String((raw && raw.nickname) || '').trim();
    const username = nameFromNickname(nickname);
    if (!username) {
      out.skipped.push({ nickname, why: 'no username could be read from that row' });
      continue;
    }

    const status = String((raw && raw.status) || 'counted').toLowerCase();
    const group  = String((raw && raw.group) || '').trim();
    const rank   = nickname.includes('|') ? nickname.split('|')[0].trim() : null;

    // Exempt and LOA are statements about the WEEK, not scores. They go in as
    // the sheet's own markers so the ordinary sync keeps honouring them.
    const days = {};
    if (status === 'loa')          days[dayKey] = 'LOA';
    else if (status === 'exempt')  days[dayKey] = 'EX';
    else {
      const pts = Number(raw && raw.points);
      if (!Number.isFinite(pts)) {
        out.skipped.push({ nickname, why: 'no readable points' });
        continue;
      }
      days[dayKey] = pts;
    }

    // The target the leaderboard printed, checked against what this codebase
    // believes. A disagreement is worth showing rather than silently picking one.
    //
    // Coerced only when there is something to coerce: Number(null) is 0, and a
    // High Command row (no target at all) came out claiming a target of zero,
    // which reads as "must score nothing" rather than "exempt".
    const hasRead = raw && raw.target != null && raw.target !== '';
    const readTarget = hasRead ? Number(raw.target) : NaN;
    const ourTarget  = TARGETS[group] !== undefined ? TARGETS[group] : null;
    const targetNote = (Number.isFinite(readTarget) && ourTarget != null && readTarget !== ourTarget)
      ? `the image says ${readTarget}, this system says ${ourTarget}` : null;

    if (status === 'loa') out.counts.loa++;
    else if (status === 'exempt') out.counts.exempt++;
    else out.counts.counted++;

    out.rows.push({
      username, nickname, rank, group, status,
      points: status === 'counted' ? Number(raw.points) : null,
      target: ourTarget != null ? ourTarget : (Number.isFinite(readTarget) ? readTarget : null),
      targetNote,
      days,
    });
  }

  if (!out.rows.length) { out.ok = false; out.reason = 'Nothing in that image could be used.'; }
  return out;
}

/**
 * Write a plan to the sheet.
 *
 * Takes the PLAN, never the image: what gets written is exactly what was shown
 * in the preview, so an apply cannot differ from what was approved.
 */
async function applyPlan(plan, { borders = true } = {}) {
  const out = { ok: true, updated: 0, missing: [], errors: [] };
  if (!plan || !plan.ok || !Array.isArray(plan.rows) || !plan.rows.length) {
    return { ok: false, reason: 'There is no plan to apply.' };
  }
  if (!quota.hasQuotaWebhook || !quota.hasQuotaWebhook()) {
    return { ok: false, reason: 'The quota webhook is not configured, so the sheet cannot be written.' };
  }

  try {
    const res = await quota.callQuotaWebhook({
      action: 'writeWeek', borders,
      rows: plan.rows.map(r => ({
        username: r.username, rank: r.rank, days: r.days,
        total: r.points == null ? 0 : r.points,
      })),
    });
    if (res && res.ok) {
      out.updated = res.updated || 0;
      out.missing = res.missing || [];
    } else {
      out.ok = false;
      out.errors.push(`writing points failed: ${(res && res.error) || 'no response'}`);
    }
  } catch (err) {
    out.ok = false;
    out.errors.push(`writing points failed: ${err.message}`);
  }
  return out;
}

module.exports = { readLeaderboard, planFromRows, applyPlan, dayKeyFor, TARGETS, DAYS };
