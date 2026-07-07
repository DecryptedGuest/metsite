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
    let toRank = fieldAfter(content, /(?:new\s*rank|to\s*rank|promoted\s*to|demoted\s*to|now)\s*[:\-]?\s*(.+)/i);
    if (!toRank) { const m = content.match(/(?:promoted|demoted)\s+to\s+(.+)/i); if (m) toRank = m[1].trim(); }
    const reason = fieldAfter(content, /reason\s*[:\-]?\s*(.+)/i);
    const memberName = (mention && mention.display) || namedMember(content) || null;
    const byName = (message.member && message.member.displayName) || (message.author && (message.author.globalName || message.author.username)) || null;

    // Nothing useful parsed → skip (avoids capturing chatter in the channel).
    if (!memberName && !mention && !toRank) return null;

    return await prisma.rankHistory.create({
      data: {
        discordId: mention ? mention.id : null,
        memberName,
        group: (process.env.PROMOTIONS_GROUP || 'MET'),
        fromRank, toRank, reason, byName,
        source: 'DISCORD', messageId,
      },
    });
  } catch (e) {
    console.error('[Ingest] promotion failed:', e.message);
    return null;
  }
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
    const reason = fieldAfter(content, /reason\s*[:\-]?\s*(.+)/i) || content.slice(0, 500) || null;
    const byName = (message.member && message.member.displayName) || (message.author && (message.author.globalName || message.author.username)) || null;

    return await prisma.metPunishment.create({
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
  } catch (e) {
    console.error('[Ingest] infraction failed:', e.message);
    return null;
  }
}

module.exports = { ingestPromotion, ingestInfraction, firstMention, fieldAfter, infractionType };
