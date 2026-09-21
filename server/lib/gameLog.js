// server/lib/gameLog.js
// Helpers for the in-game log feed. The training game sends Adonis command logs
// as the raw command line (action="kick", message=":kick TestCadet spamming")
// without a separate target field, so we derive the target from the command:
// the first argument after the command name. Adonis self-reference keywords
// (e.g. "me") resolve to the command executor and are labelled as such.

// Adonis commands whose first argument is text, not a player — no target here.
const NON_TARGET_CMDS = new Set([
  'm', 'message', 'h', 'hint', 'n', 'notify', 'ntf', 'ss', 'systemmessage',
  'announce', 'sm', 'servermessage', 'gm', 'globalmessage', 'bc', 'broadcast',
  'music', 'sound', 'volume', 'pitch', 'time', 'settime', 'clear', 'cleargame',
  'shutdown', 'countdown', 'timer',
]);

// Adonis "player set" keywords that resolve relative to whoever ran the command.
// Only "me" (the executor) is given a friendly label; others pass through as-is.
function specialTargetLabel(tok) {
  return String(tok).toLowerCase() === 'me' ? '[command executor for "me"]' : null;
}

// The bare command name from the action field (preferred) or the message.
function commandName(action, message) {
  const a = String(action || '').trim().replace(/^[:!;.]+/, '');
  if (a) return a.toLowerCase();
  const m = String(message || '').trim().match(/^[:!;.]?\s*([A-Za-z0-9]+)/);
  return m ? m[1].toLowerCase() : '';
}

// Derive the display target for a game-log row. Returns the game-supplied target
// when present; otherwise, for Adonis command logs, the first argument after the
// command (with "me" shown as the executor). Null when there's no target.
function deriveTarget(row) {
  if (row && row.target) return row.target;
  if (!row || row.source !== 'ADONIS') return (row && row.target) || null;
  const msg = String(row.message || '').trim();
  if (!msg) return null;
  const cmd = commandName(row.action, msg);
  if (!cmd || NON_TARGET_CMDS.has(cmd)) return null;
  // Drop the leading ":cmd " (or "cmd ") so what's left starts with the args.
  const rest = msg.replace(/^[:!;.]?\s*[A-Za-z0-9]+\s+/, '');
  if (rest === msg) return null; // command had no arguments
  const tok = rest.split(/\s+/)[0];
  if (!tok) return null;
  return specialTargetLabel(tok) || tok;
}

// ── Reading the log ───────────────────────────────────────────────
// Nothing ever deletes a GameLog row: the record is all-time by design. What was
// capped was the READING of it — one request for the newest 150 with no way to
// reach anything older, so the page looked like the log stopped there. These are
// shared by the MET High Command feed and the developer panel, which had two
// copies of the same query and the same cap.
const prisma = require('./db');

const SOURCES = ['ADONIS', 'JOIN', 'LEAVE', 'CHAT'];
const PAGE_MAX = 500;
const PAGE_DEFAULT = 200;

function whereFor(query = {}) {
  const where = {};
  const src = String(query.source || '').toUpperCase();
  if (SOURCES.includes(src)) where.source = src;
  const q = String(query.q || '').trim();
  if (q) where.OR = [
    { actor:   { contains: q, mode: 'insensitive' } },
    { target:  { contains: q, mode: 'insensitive' } },
    { message: { contains: q, mode: 'insensitive' } },
    { action:  { contains: q, mode: 'insensitive' } },
  ];
  return where;
}

function shape(r) {
  return {
    id: r.id, source: r.source, actor: r.actor, actorId: r.actorId,
    target: deriveTarget(r), action: r.action, message: r.message, place: r.place,
    createdAt: r.createdAt,
  };
}

/**
 * One page, newest first, plus how many there are in total.
 *
 * The `before` cursor narrows the PAGE and never the count — "1,240 in total"
 * has to mean the whole log, or scrolling would appear to shrink it.
 */
async function page(query = {}) {
  const where = whereFor(query);
  const take = Math.max(1, Math.min(PAGE_MAX, parseInt(query.limit, 10) || PAGE_DEFAULT));

  const paged = { ...where };
  if (query.before) {
    const t = new Date(query.before);
    if (!isNaN(t)) paged.createdAt = { lt: t };
  }

  // One more than asked for, so "is there another page" is answered by reading
  // rather than guessed at from a full one.
  const [rows, total] = await Promise.all([
    prisma.gameLog.findMany({ where: paged, orderBy: { createdAt: 'desc' }, take: take + 1 }),
    prisma.gameLog.count({ where }).catch(() => null),
  ]);
  const hasMore = rows.length > take;
  if (hasMore) rows.pop();

  return {
    rows: rows.map(shape),
    total,
    hasMore,
    nextBefore: rows.length ? rows[rows.length - 1].createdAt : null,
  };
}

// A leading =, +, - or @ is a formula to a spreadsheet, and these are strings a
// player typed into a game. Prefixed so a chat line cannot execute.
function csvCell(v) {
  const s = v == null ? '' : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

/**
 * The whole log, as a file, streamed in batches.
 * Every row that matches — there is deliberately no cap, which is the point.
 */
async function writeCsv(res, query = {}) {
  const where = whereFor(query);
  res.write('Time,Source,Actor,Actor ID,Target,Action,Message,Place\n');
  let cursor = null;
  for (;;) {
    const batch = await prisma.gameLog.findMany({
      where, orderBy: { createdAt: 'desc' }, take: 1000,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (!batch.length) break;
    for (const r of batch) {
      const row = shape(r);
      res.write([
        new Date(row.createdAt).toISOString(), row.source, row.actor, row.actorId,
        row.target, row.action, row.message, row.place,
      ].map(csvCell).join(',') + '\n');
    }
    cursor = batch[batch.length - 1].id;
    if (batch.length < 1000) break;
  }
}

function csvFilename() {
  return `met-game-logs-${new Date().toISOString().slice(0, 10)}.csv`;
}

module.exports = {
  deriveTarget, commandName, NON_TARGET_CMDS,
  whereFor, shape, page, writeCsv, csvFilename, SOURCES, PAGE_MAX,
};
