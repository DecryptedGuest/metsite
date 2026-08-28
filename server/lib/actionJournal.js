// server/lib/actionJournal.js
// A record of what people did, kept in a shape that can be reversed.
//
// ── Why a journal rather than an "undo" per command ───────────────
//
// Undo bolted onto each command drifts: the reverse of "+4 points" is easy to
// write and easy to forget when the award path changes. So every reversible
// action is written here as { what, who, and the smallest thing needed to put
// it back }, and one undo path reads it.
//
// ── What "reversible" means here ──────────────────────────────────
//
// Only the part the bot owns. Reversing a quota adjustment means writing the
// opposite adjustment; it does NOT mean pretending the first one never
// happened, because the sheet is shared and somebody may have read it in
// between. Reversing a case approval removes the roles the bot granted — it
// cannot un-tell the officer they were punished. The journal says which of
// those it is, so nobody is surprised.
const prisma = require('./db');

// How far back /undo will look. Long enough to catch a mistake, short enough
// that nobody reverses last month's decision by muscle memory.
const WINDOW_HOURS = () => {
  const n = parseInt(process.env.UNDO_WINDOW_HOURS || '24', 10);
  return Number.isFinite(n) && n > 0 ? n : 24;
};

const KINDS = {
  QUOTA_ADJUST: {
    label: 'Quota adjustment',
    // Reversible cleanly: the opposite adjustment is a legitimate entry.
    reversal: 'writes the opposite adjustment',
  },
  CASE_APPROVE: {
    label: 'Case approval',
    reversal: 'sets the case back to pending and removes the roles it granted',
  },
  CASE_DENY: {
    label: 'Case denial',
    reversal: 'sets the case back to pending',
  },
  TICKET_REVIEW: {
    label: 'Ticket review',
    reversal: 'sets the ticket back to pending and cancels any unpaid award',
  },
};

/**
 * Record an action. Never throws: a journal write failing must not take down
 * the thing it was describing.
 */
async function record({ kind, actorId, actorName, targetType, targetId, summary, payload }) {
  if (!KINDS[kind]) return null;
  try {
    return await prisma.auditLog.create({
      data: {
        category: 'UNDOABLE',
        action: kind,
        actorId: actorId || null,
        actorName: actorName || null,
        targetType: targetType || null,
        targetId: targetId ? String(targetId) : null,
        summary: summary || KINDS[kind].label,
        metadata: payload || undefined,
      },
    });
  } catch (err) {
    console.warn('[Journal] could not record', kind, '·', err.message);
    return null;
  }
}

/** What this person could still undo, newest first. */
async function recent(actorId, { limit = 10 } = {}) {
  const since = new Date(Date.now() - WINDOW_HOURS() * 3600 * 1000);
  try {
    return await prisma.auditLog.findMany({
      where: {
        category: 'UNDOABLE',
        actorId,
        createdAt: { gte: since },
        // An entry that has already been reversed is history, not an option.
        NOT: { summary: { contains: '[undone]' } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  } catch (err) {
    console.warn('[Journal] could not read history:', err.message);
    return [];
  }
}

async function markUndone(entryId, byName) {
  try {
    const row = await prisma.auditLog.findUnique({ where: { id: entryId } });
    if (!row) return;
    await prisma.auditLog.update({
      where: { id: entryId },
      data: { summary: `${row.summary} [undone by ${byName || 'unknown'}]` },
    });
  } catch (err) {
    console.warn('[Journal] could not mark undone:', err.message);
  }
}

/**
 * Reverse one entry.
 *
 * Each branch does the smallest correct thing and says plainly what it could
 * not reach — a DM already delivered, a sheet somebody has since read. Undo
 * that silently overstates itself is worse than no undo.
 */
async function undo(entry, actor) {
  const meta = entry.metadata || {};
  const notes = [];

  if (entry.action === 'QUOTA_ADJUST') {
    const { enqueueQuotaAward } = require('./quota');
    const points = -Number(meta.points || 0);
    if (!points) return { ok: false, error: 'That entry has no point value to reverse.' };
    await enqueueQuotaAward({
      refType: 'manual',
      refId: `undo:${entry.id}`,
      discordId: meta.discordId || null,
      robloxUsername: meta.robloxUsername || null,
      points,
      label: `reversal of ${entry.summary}`.slice(0, 180),
    });
    notes.push(`${points > 0 ? '+' : ''}${points} queued for the sheet`);
    return { ok: true, notes };
  }

  if (entry.action === 'CASE_APPROVE' || entry.action === 'CASE_DENY') {
    const kase = await prisma.case.findUnique({ where: { id: entry.targetId } });
    if (!kase) return { ok: false, error: 'That case no longer exists.' };
    if (kase.status === 'PENDING') return { ok: false, error: 'That case is already pending.' };

    await prisma.case.update({
      where: { id: kase.id },
      data: { status: 'PENDING', reviewedBy: null, reviewedAt: null },
    });
    notes.push('case set back to pending');

    if (entry.action === 'CASE_APPROVE') {
      // Take back only what the bot granted, and only what is still in force.
      const punishments = await prisma.casePunishment.findMany({ where: { caseId: kase.id } });
      let removed = 0;
      if (kase.officerDiscordId && punishments.length) {
        const { removeRole } = require('./bot');
        for (const p of punishments) {
          if (!p.roleId || p.roleRemoved) continue;
          if (await removeRole(kase.officerDiscordId, p.roleId)) removed++;
        }
      }
      await prisma.casePunishment.deleteMany({ where: { caseId: kase.id } });
      notes.push(`${removed} role(s) removed`);

      // Points already written to the sheet are reversed, not erased.
      const award = await prisma.quotaAward.findFirst({
        where: { refType: 'case', refId: kase.id },
      }).catch(() => null);
      if (award) {
        if (award.status === 'PENDING') {
          await prisma.quotaAward.update({ where: { id: award.id }, data: { status: 'FAILED', lastError: 'undone before it was written' } });
          notes.push('unwritten points cancelled');
        } else {
          const { enqueueQuotaAward } = require('./quota');
          await enqueueQuotaAward({
            refType: 'manual', refId: `undo:${entry.id}`,
            discordId: award.discordId, robloxUsername: award.robloxUsername,
            points: -award.points, label: `reversal of case ${kase.caseRef}`,
          });
          notes.push(`-${award.points} queued to reverse the award`);
        }
      }
      // Things that cannot be taken back, said out loud.
      if (kase.logMessageId) notes.push('the administrative log stays posted — edit or delete it by hand');
      notes.push('any DM already delivered cannot be recalled');
    }
    return { ok: true, notes };
  }

  if (entry.action === 'TICKET_REVIEW') {
    const t = await prisma.ticketLog.findUnique({ where: { id: entry.targetId } });
    if (!t) return { ok: false, error: 'That ticket no longer exists.' };
    await prisma.ticketLog.update({
      where: { id: t.id },
      data: { status: 'PENDING', reviewedById: null, reviewedByName: null, reviewedAt: null },
    });
    notes.push('ticket set back to pending');

    const award = await prisma.quotaAward.findFirst({ where: { refType: 'ticket', refId: t.id } }).catch(() => null);
    if (award && award.status === 'PENDING') {
      await prisma.quotaAward.update({ where: { id: award.id }, data: { status: 'FAILED', lastError: 'undone before it was written' } });
      notes.push('unwritten points cancelled');
    } else if (award) {
      const { enqueueQuotaAward } = require('./quota');
      await enqueueQuotaAward({
        refType: 'manual', refId: `undo:${entry.id}`,
        discordId: award.discordId, robloxUsername: award.robloxUsername,
        points: -award.points, label: `reversal of ticket ${t.ticketNo || t.id}`,
      });
      notes.push(`-${award.points} queued to reverse the award`);
    }
    return { ok: true, notes };
  }

  return { ok: false, error: `Nothing knows how to reverse "${entry.action}".` };
}

module.exports = { record, recent, undo, markUndone, KINDS, WINDOW_HOURS };
