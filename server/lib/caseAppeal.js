// server/lib/caseAppeal.js
// The mechanics of granting an appeal, in one place.
//
// Filing an appeal IS granting it: the case is overturned, its punishment roles
// are lifted in Discord, the officer and the submitter are told, and the posted
// administrative log is edited to show it. That was all written inside the
// website's POST /api/cases/:id/appeal route, which is fine until a second place
// needs to do exactly the same thing — the /check-record panel — at which point
// it has to be shared rather than copied, or the two drift.
//
// This is the doing. The DECIDING — who may appeal what — stays with each
// caller: the website uses iaRank.canAppealCase (Senior Investigator and above,
// High Command for a Termination or Blacklist), the panel uses its own gate
// (Internal Affairs and Deputy Commissioner and above). Both then call this with
// a case they have already confirmed is appealable.

const prisma = require('./db');
const { ACTION_CONFIG } = require('./actions');
const { caseHasHicommOnlyPunishment } = require('./iaRank');

/**
 * Grant an appeal on a case.
 *
 * @param {object}  o
 * @param {object}  o.existing   the case, WITH casePunishments included
 * @param {object}  o.actor      { userId, name, rankLabel } — who is granting it
 * @param {string}  o.reason
 * @returns {Promise<{ ok, status, error?, updated?, appeal?, lifted?, failed?, kept?, manual? }>}
 *   `status` is an HTTP-style code so a route can pass it straight through: 409
 *   when somebody else claimed the appeal a moment earlier.
 */
async function appealCase({ existing, actor, reason }) {
  if (!existing) return { ok: false, status: 404, error: 'Case not found' };
  const cleanReason = String(reason || '').trim();
  if (!cleanReason)            return { ok: false, status: 400, error: 'A reason for the appeal is required.' };
  if (cleanReason.length > 2000) return { ok: false, status: 400, error: 'Appeal reason is too long (max 2000 characters).' };

  const actions = Array.isArray(existing.actions) && existing.actions.length
    ? existing.actions
    : [{ action: existing.action, roleId: ACTION_CONFIG[existing.action]?.roleId || null, durationDays: null }];

  const appealedByName = actor.name || 'Internal Affairs';
  const rankLabel = actor.rankLabel || 'Internal Affairs';
  const now = new Date();

  // Claim it with a conditional update — only the request that finds the case
  // still APPROVED and un-appealed wins, so two people pressing Appeal at the
  // same moment cannot both lift the roles and write two appeal records.
  const claim = await prisma.case.updateMany({
    where: { id: existing.id, status: 'APPROVED', appealedAt: null },
    data: {
      status:       'OVERTURNED',
      appealedAt:   now,
      appealedById: actor.userId || null,
      appealedByName,
      appealReason: cleanReason,
    },
  });
  if (claim.count === 0) {
    return { ok: false, status: 409, error: 'This case has just been appealed by someone else.' };
  }
  const updated = await prisma.case.findUnique({ where: { id: existing.id } });

  const appeal = await prisma.caseAppeal.create({
    data: {
      caseId:         existing.id,
      appealedById:   actor.userId || null,
      appealedByName,
      appealedByRank: rankLabel,
      reason:         cleanReason,
      liftedActions:  actions.map(a => ({ action: a.action, durationDays: a.durationDays ?? null })),
      hicommOnly:     caseHasHicommOnlyPunishment(existing),
    },
  }).catch(() => null);

  await prisma.caseAction.create({
    data: {
      caseId: existing.id, actionType: 'APPEALED', performedBy: actor.userId || null,
      notes:  `Appeal granted by ${appealedByName} (${rankLabel}): ${cleanReason}`,
    },
  }).catch(() => {});

  // ── Lift the Discord punishment roles this case applied ──
  // A row is only marked roleRemoved when Discord CONFIRMS it. A failed lift is
  // made due-now so the expiry checker retries it, rather than being marked done
  // and stranding the role on the officer forever.
  const lifted = [], failed = [], kept = [];
  if (existing.officerDiscordId) {
    const { removeRole } = require('./bot');

    // A role can be owed by more than one live case; lifting it for this appeal
    // would silently lift the other case's still-standing punishment. Any role
    // another live case still relies on is left in place and reported.
    const heldElsewhere = await prisma.casePunishment.findMany({
      where: {
        roleRemoved: false,
        caseId: { not: existing.id },
        case: { officerDiscordId: existing.officerDiscordId, status: { in: ['APPROVED', 'PENDING'] } },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { roleId: true, case: { select: { caseRef: true } } },
    }).catch(() => []);
    const stillNeeded = new Map();
    heldElsewhere.forEach(p => { if (p.roleId) stillNeeded.set(p.roleId, (p.case && p.case.caseRef) || 'another case'); });

    const lift = async (roleId, label) => {
      if (!roleId) return;
      if (stillNeeded.has(roleId)) { kept.push(`${label} (still held by ${stillNeeded.get(roleId)})`); return 'kept'; }
      return (await removeRole(existing.officerDiscordId, roleId)) ? 'ok' : 'fail';
    };

    for (const p of (existing.casePunishments || [])) {
      if (!p.roleId || p.roleRemoved) continue;
      const result = await lift(p.roleId, p.action);
      if (result === 'ok') {
        lifted.push(p.action);
        await prisma.casePunishment.update({ where: { id: p.id }, data: { roleRemoved: true } }).catch(() => {});
      } else if (result === 'kept') {
        await prisma.casePunishment.update({ where: { id: p.id }, data: { roleRemoved: true } }).catch(() => {});
      } else {
        failed.push(p.action);
        await prisma.casePunishment.update({ where: { id: p.id }, data: { expiresAt: new Date() } }).catch(() => {});
      }
    }

    // Cases approved before punishments were recorded (or with a role added to
    // the config later) still need their current role removed.
    for (const a of actions) {
      const roleId = ACTION_CONFIG[a.action]?.roleId || a.roleId || null;
      if (!roleId) continue;
      if ((existing.casePunishments || []).some(p => p.roleId === roleId)) continue;
      const result = await lift(roleId, a.action);
      if (result === 'ok') lifted.push(a.action);
      else if (result === 'fail') failed.push(a.action);
    }
  }

  // Some punishments the bot can't undo: a group exile can't be reversed, a
  // demotion has no recorded "before" rank. Name them so the grantor knows what
  // is left to do by hand.
  const manual = [];
  let exileAppealed = false;
  for (const a of actions) {
    // A blacklist appeal does not imply putting them back in the group, so it
    // gets no "re-invite" note. A Termination might, so that one keeps it.
    if (ACTION_CONFIG[a.action]?.exile && a.action !== 'Blacklist') {
      manual.push(`${a.action}: re-invite to the Roblox group by hand`);
    }
    if (ACTION_CONFIG[a.action]?.exile) exileAppealed = true;
    if (a.action === 'Demotion') manual.push('Demotion: restore the Roblox group rank by hand');
  }
  // A termination or blacklist stripped their MET Discord roles (rank, division,
  // permissions). The appeal cannot know which they held, so restoring them is a
  // by-hand step and is named as one.
  if (exileAppealed) manual.push('Their MET Discord roles were removed by the discipline · add their rank and division roles back by hand');

  if (lifted.length || failed.length || kept.length || manual.length) {
    await prisma.caseAction.create({
      data: {
        caseId: existing.id, actionType: 'APPEALED', performedBy: actor.userId || null,
        notes: `Punishment roles lifted: ${lifted.join(', ') || 'none'}`
             + (failed.length ? ` · could not remove (queued for retry): ${failed.join(', ')}` : '')
             + (kept.length   ? ` · left in place: ${kept.join(', ')}` : '')
             + (manual.length ? ` · needs doing by hand: ${manual.join('; ')}` : ''),
      },
    }).catch(() => {});
  }

  // Update the posted administrative log so the notice shows the appeal.
  if (existing.logMessageId) {
    try {
      const { editApprovalWebhook } = require('./webhook');
      let suspectAvatar = null;
      try { if (existing.robloxUserId) suspectAvatar = await require('./roblox').getRobloxAvatarHeadshot(existing.robloxUserId); } catch (e) {}
      await editApprovalWebhook(existing.logMessageId, {
        caseRef: existing.caseRef, action: existing.action, actions,
        reason:  existing.reason, notes: existing.notes,
        officerDiscordId: existing.officerDiscordId,
        officerName:      existing.robloxUsername || existing.suspectRobloxDisplayName || null,
        officerRobloxId:  existing.robloxUserId || null,
        suspectAvatar, timestamp: now,
        appealed: { by: appealedByName, rank: rankLabel, reason: cleanReason, at: now },
      });
    } catch (e) { console.warn('[caseAppeal] log edit failed:', e.message); }
  }

  // Tell the OFFICER — the person the appeal was about, and the one nobody else
  // would tell.
  if (existing.officerDiscordId) {
    require('./officerNotice').notifyAppealed({
      discordId: existing.officerDiscordId,
      caseRef:   existing.caseRef,
      caseId:    existing.id,
      actions,
      action:    existing.action,
      by:        appealedByName,
      rank:      rankLabel,
      reason:    cleanReason,
      manual,
      robloxUsername: existing.robloxUsername || null,
    }).catch(() => {});
  }

  // And the original submitter.
  if (existing.userId && existing.userId !== actor.userId) {
    require('./push').sendCustomNotification({
      userIds: [existing.userId],
      title:   `Case appealed · ${existing.caseRef}`,
      body:    `${appealedByName} granted an appeal. Punishments have been lifted.`,
      url:     `/ia/dashboard?case=${existing.id}`,
      prefKey: 'caseAppealed',
    }).catch(() => {});
  }

  return { ok: true, status: 200, updated, appeal, lifted, failed, kept, manual };
}

module.exports = { appealCase };
