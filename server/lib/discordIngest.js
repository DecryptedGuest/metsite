// server/lib/discordIngest.js
// Parse free-form promotion/demotion and infraction/strike messages from their
// Discord channels and persist them: promotions → RankHistory, infractions →
// MetPunishment (so they show in punishment history). Both are best-effort and
// idempotent on the Discord message id. Formats are tolerant of wording — real
// formats can be tuned later; the goal is to capture the events into the site.
const prisma = require('./db');

// In-process guard against duplicate messageCreate delivery (gateway RESUME can
// replay buffered events). The bot runs single-instance in the web process, so a
// bounded Set closes the check-then-create race that the DB alone can't (adding a
// UNIQUE index on met_punishments.caseRef could fail `db push` at boot if legacy
// rows collide, so we dedupe here instead). Returns true if already handled.
const _seen = new Set();
function alreadyHandled(messageId) {
  const id = String(messageId);
  if (_seen.has(id)) return true;
  _seen.add(id);
  if (_seen.size > 5000) { for (const k of _seen) { _seen.delete(k); if (_seen.size <= 4000) break; } }
  return false;
}

// First user mention in a message → { id, display } or null.
function firstMention(message) {
  try {
    const m = message.mentions && message.mentions.users && message.mentions.users.first();
    if (!m) return null;
    const gm = message.mentions.members && message.mentions.members.first();
    return { id: String(m.id), display: (gm && gm.displayName) || m.globalName || m.username || null };
  } catch (e) { return null; }
}

// Value after a labelled line, e.g. label 'reason' → text after "Reason:".
function fieldAfter(content, labelRe) {
  for (const line of String(content || '').split(/\r?\n/)) {
    const m = line.match(labelRe);
    if (m && m[1]) return m[1].replace(/<@!?\d+>/g, '').replace(/[.\s]+$/, '').trim() || null;
  }
  return null;
}

// A plain "User:/Member:/Officer:/Name:" line value (when there's no mention).
function namedMember(content) {
  return fieldAfter(content, /^\s*(?:user|member|officer|name|username|player)\s*[:\-]\s*(.+)$/i);
}

// ── Promotions / demotions → RankHistory ──
async function ingestPromotion(message) {
  try {
    const messageId = String(message.id);
    if (alreadyHandled(messageId)) return null;
    const existing = await prisma.rankHistory.findUnique({ where: { messageId } }).catch(() => null);
    if (existing) return existing;

    const content = message.content || '';
    const mention = firstMention(message);
    const fromRank = fieldAfter(content, /(?:old|previous|from|current)\s*rank\s*[:\-]?\s*(.+)/i);
    // Only explicit rank labels/phrasings — NOT a bare "now", which matched
    // ordinary congratulations ("you are now one of us") and manufactured a
    // bogus toRank plus a false promotion DM + corrupt RankHistory row.
    let toRank = fieldAfter(content, /(?:new\s*rank|to\s*rank|promoted\s*to|demoted\s*to)\s*[:\-]?\s*(.+)/i);
    if (!toRank) { const m = content.match(/(?:promoted|demoted)\s+to\s+(.+)/i); if (m) toRank = m[1].trim(); }
    const reason = fieldAfter(content, /reason\s*[:\-]?\s*(.+)/i);
    const memberName = (mention && mention.display) || namedMember(content) || null;
    const byName = (message.member && message.member.displayName) || (message.author && (message.author.globalName || message.author.username)) || null;

    // Require an actual promotion/demotion signal — a parsed rank or the
    // promote/demote keyword. A bare @-mention ("Congrats @Bob!") must NOT
    // create a RankHistory row or fire a "You have been promoted" DM.
    const hasRankSignal = !!(toRank || fromRank) || /\b(promot|demot)/i.test(content);
    if (!hasRankSignal) return null;

    const rec = await prisma.rankHistory.create({
      data: {
        discordId: mention ? mention.id : null,
        memberName,
        group: (process.env.PROMOTIONS_GROUP || 'MET'),
        fromRank, toRank, reason, byName,
        source: 'DISCORD', messageId,
      },
    });

    // DM the member: promotions are informational; demotions include an appeal
    // link (a demotion can be a disciplinary action). Live-only, best-effort.
    if (mention && mention.id && process.env.MEMBER_ACTION_DM !== 'off') {
      try {
        const base = (process.env.PUBLIC_BASE_URL || 'https://metia.uk').replace(/\/+$/, '');
        // Prefer rank ORDERING (canonical MET ladder) over the keyword: a real
        // downward move worded without "demot" (e.g. Sergeant → Constable) was
        // wrongly congratulated as a promotion with no appeal link. Falls back to
        // the keyword when a rank isn't on the ladder, so custom names don't regress.
        const MET_LADDER = ['recruit', 'trainee', 'cadet', 'student officer', 'probationary constable', 'constable', 'sergeant', 'inspector', 'chief inspector', 'superintendent', 'chief superintendent', 'commander', 'deputy assistant commissioner', 'assistant commissioner', 'deputy commissioner', 'commissioner'];
        const rankIdx = (name) => { const n = String(name || '').toLowerCase(); let best = -1, len = 0; for (let i = 0; i < MET_LADDER.length; i++) { if (n.includes(MET_LADDER[i]) && MET_LADDER[i].length > len) { best = i; len = MET_LADDER[i].length; } } return best; };
        let isDemotion = /demot/i.test(content);
        const _fi = rankIdx(fromRank), _ti = rankIdx(toRank);
        if (_fi >= 0 && _ti >= 0 && _fi !== _ti) isDemotion = _ti < _fi;
        const change = (fromRank && toRank) ? `**${fromRank} → ${toRank}**\n` : (toRank ? `New rank: **${toRank}**\n` : '');
        if (isDemotion) {
          require('./bot').dmMemberNotice(mention.id, {
            color: 0xe8842a,
            title: 'You have been demoted',
            description: `${change}${reason ? `**Reason:** ${String(reason).slice(0, 600)}\n` : ''}\nIf you believe this was a mistake, open your record below and file an appeal — an investigator will review it.`,
            appealUrl: `${base}/profile`,
            appealLabel: 'View my record',
          }).catch(() => {});
        } else {
          require('./bot').dmMemberNotice(mention.id, {
            color: 0x22c55e,
            title: 'You have been promoted',
            description: `Congratulations${toRank ? `, you've been promoted to **${toRank}**` : ' on your promotion'}!${reason ? `\n**Reason:** ${String(reason).slice(0, 600)}` : ''}`,
          }).catch(() => {});
        }
      } catch (e) { /* DM is best-effort */ }
    }
    return rec;
  } catch (e) {
    console.error('[Ingest] promotion failed:', e.message);
    return null;
  }
}

// Does this message actually look like a disciplinary infraction (vs. casual
// chatter that happens to @-mention a member)? A labelled type line, or any
// recognised punishment keyword, qualifies.
function looksLikeInfraction(content) {
  const c = String(content || '');
  if (/(?:infraction|punishment|type|action|strike)\s*[:\-]/i.test(c)) return true;
  if (/\b(ban(?:ned)?|suspen\w*|demot\w*|strike[sd]?|warn\w*|blacklist\w*|terminat\w*|exile[sd]?)\b/i.test(c)) return true;
  return false;
}

// Detect the punishment type from the message (keyword or labelled line).
function infractionType(content) {
  const labelled = fieldAfter(content, /(?:infraction|punishment|type|action|strike)\s*[:\-]?\s*(.+)/i);
  const hay = `${labelled || ''} ${content}`.toLowerCase();
  if (/\bban\b/.test(hay))        return 'BAN';
  if (/suspen/.test(hay))         return 'SUSPENSION';
  if (/demot/.test(hay))          return 'DEMOTION';
  if (/strike/.test(hay))         return 'STRIKE';
  if (/warn/.test(hay))           return 'WARNING';
  return labelled ? labelled.toUpperCase().slice(0, 40) : 'INFRACTION';
}

// ── Infractions / strikes → MetPunishment (punishment history) ──
// Idempotency uses caseRef = 'discord:<messageId>' (MetPunishment has no
// messageId column). Requires a mention — MetPunishment.discordId is required.
async function ingestInfraction(message) {
  try {
    const messageId = String(message.id);
    if (alreadyHandled(messageId)) return null;
    const caseRef = `discord:${messageId}`;
    const existing = await prisma.metPunishment.findFirst({ where: { caseRef } }).catch(() => null);
    if (existing) return existing;

    const mention = firstMention(message);
    if (!mention) return null; // can't attribute without a member reference

    const content = message.content || '';
    // Only ingest messages that actually look like an infraction. Without this,
    // any casual reply that @-mentions someone (e.g. "@Bob check your DMs")
    // created a fake active punishment and DM'd them an alarming disciplinary
    // notice. Require a labelled type line or a recognised punishment keyword.
    if (!looksLikeInfraction(content)) return null;

    const reason = fieldAfter(content, /reason\s*[:\-]?\s*(.+)/i) || content.slice(0, 500) || null;
    const byName = (message.member && message.member.displayName) || (message.author && (message.author.globalName || message.author.username)) || null;

    const created = await prisma.metPunishment.create({
      data: {
        discordId: mention.id,
        type: infractionType(content),
        reason,
        issuedById: message.author ? String(message.author.id) : null,
        issuedBy: byName,
        caseRef,
        active: true,
      },
    });

    // New punishment → DM the member the reason + a direct appeal link that
    // pre-selects this punishment. Only fires here (live ingest), never on
    // backfill, and only on genuinely new rows (dupes return above). Best-effort.
    if (process.env.MEMBER_ACTION_DM !== 'off') {
      try {
        const base = (process.env.PUBLIC_BASE_URL || 'https://metia.uk').replace(/\/+$/, '');
        require('./bot').dmMemberNotice(mention.id, {
          color: 0xf04f5e,
          title: 'You have received a disciplinary action',
          description: `**Type:** ${created.type}\n${reason ? `**Reason:** ${String(reason).slice(0, 600)}\n` : ''}\nIf you believe this was a mistake — or want to see the evidence and full details — open your record below and file an appeal.`,
          appealUrl: `${base}/profile`,
          appealLabel: 'View my record',
        }).catch(() => {});
      } catch (e) { /* DM is best-effort */ }
    }
    return created;
  } catch (e) {
    console.error('[Ingest] infraction failed:', e.message);
    return null;
  }
}

module.exports = { ingestPromotion, ingestInfraction, firstMention, fieldAfter, infractionType };
