// Case creation, the approval pipeline, and the timed-punishment expiry worker.
const prisma = require('./db');
const { env } = require('./env');
const { ACTION_CONFIG, roleIdForAction } = require('./actions');
const { sendApprovalWebhook } = require('./webhook');
const { enqueueQuotaAward }   = require('./quota');
const roblox = require('./roblox');

/** Sequential, never random, never reused: "#1", "#2", … */
async function nextCaseRef() {
  const counter = await prisma.caseCounter.upsert({
    where: { id: 1 }, update: { count: { increment: 1 } }, create: { id: 1, count: 1 },
  });
  return `#${counter.count}`;
}

async function nextTicketRef() {
  const counter = await prisma.ticketCounter.upsert({
    where: { id: 1 }, update: { count: { increment: 1 } }, create: { id: 1, count: 1 },
  });
  return `TKT-${String(counter.count).padStart(4, '0')}`;
}

/**
 * Create a PENDING case. Roblox identity is resolved best-effort: if RoVer is
 * down or the subject is unlinked we still file, and exile/demotion are simply
 * skipped at approval time.
 */
async function createCase({ submitterDiscordId, subjectDiscordId, subjectRobloxUsername,
                            actions, reason, notes, evidence, durationDays }) {
  let robloxUserId = null, robloxUsername = null;

  try {
    if (subjectDiscordId) {
      robloxUserId = await roblox.getRobloxIdFromDiscord(subjectDiscordId);
      if (robloxUserId) robloxUsername = (await roblox.getRobloxUserInfo(robloxUserId))?.name || null;
    } else if (subjectRobloxUsername) {
      const u = await roblox.getRobloxIdFromUsername(subjectRobloxUsername);
      if (u) { robloxUserId = u.id; robloxUsername = u.name; }
    }
  } catch (err) {
    console.warn('[discipline] identity lookup at filing (non-blocking):', err.message);
  }
  if (!robloxUsername && subjectRobloxUsername) robloxUsername = subjectRobloxUsername;

  // Snapshot the role id, but approval re-reads the env so later-added roles still apply.
  const enriched = actions.map(a => ({
    action: a,
    roleId: roleIdForAction(a),
    durationDays: ACTION_CONFIG[a]?.timed ? (durationDays || null) : null,
  }));

  const caseRef = await nextCaseRef();
  const created = await prisma.case.create({
    data: {
      caseRef,
      submitterDiscordId,
      officerDiscordId: subjectDiscordId || null,
      robloxUserId, robloxUsername,
      action:  enriched.map(a => a.action).join(', '),
      actions: enriched,
      reason:  reason.trim(),
      notes:   notes?.trim() || 'N/A',
      caseLink: evidence?.trim() || null,
      status: 'PENDING',
    },
  });

  await prisma.caseAction.create({
    data: { caseId: created.id, actionType: 'CREATED', performedBy: submitterDiscordId, notes: 'Case submitted' },
  });
  return created;
}

/**
 * Approve a case. Order matters and mirrors the original system:
 * status → log webhook → roles + expiry → exile (once) → demotion → points.
 * Every external step is best-effort: one failing never aborts the rest.
 */
async function approveCase(caseId, approverDiscordId, bot) {
  const existing = await prisma.case.findUnique({ where: { id: caseId } });
  if (!existing) return { ok: false, error: 'Case not found.' };
  if (existing.status !== 'PENDING') return { ok: false, error: 'Case is not pending' };

  const updated = await prisma.case.update({
    where: { id: caseId },
    data:  { status: 'APPROVED', reviewedBy: approverDiscordId, reviewedAt: new Date() },
  });
  await prisma.caseAction.create({
    data: { caseId, actionType: 'APPROVED', performedBy: approverDiscordId, notes: 'Approved by HICOMM/Developer' },
  });

  const suspectAvatar = existing.robloxUserId
    ? await roblox.getRobloxAvatarHeadshot(existing.robloxUserId)
    : null;

  // A case filed Roblox-only can still reach a Discord member — resolve and persist.
  let officerDiscordId = existing.officerDiscordId;
  if (!officerDiscordId && existing.robloxUserId) {
    const link = await prisma.robloxLink.findFirst({ where: { robloxUserId: existing.robloxUserId } }).catch(() => null);
    if (link?.discordId) {
      officerDiscordId = link.discordId;
      await prisma.case.update({ where: { id: caseId }, data: { officerDiscordId } }).catch(() => {});
    }
  }

  const actions = Array.isArray(existing.actions) && existing.actions.length
    ? existing.actions
    : [{ action: existing.action, roleId: roleIdForAction(existing.action), durationDays: null }];

  const logMessageId = await sendApprovalWebhook({
    caseRef: existing.caseRef, action: existing.action, actions,
    reason: existing.reason, notes: existing.notes,
    officerDiscordId,
    officerName: existing.robloxUsername || null,
    officerRobloxId: existing.robloxUserId || null,
    suspectAvatar, timestamp: new Date(),
  });
  if (logMessageId) {
    await prisma.case.update({ where: { id: caseId }, data: { logMessageId } }).catch(() => {});
  }

  // Roles + expiry rows. Resolve from the env first so a role added after
  // filing still applies; fall back to whatever was snapshotted on the case.
  if (officerDiscordId && bot) {
    for (const a of actions) {
      const roleId = ACTION_CONFIG[a.action]?.roleId || a.roleId || null;
      if (!roleId) continue;
      await bot.assignRole(officerDiscordId, roleId);
      await prisma.casePunishment.create({
        data: {
          caseId, action: a.action, roleId,
          durationDays: a.durationDays || null,
          expiresAt: a.durationDays ? new Date(Date.now() + a.durationDays * 86400000) : null,
        },
      }).catch(e => console.error('[discipline] punishment row failed:', e.message));
    }
  }

  // Exile — once per case, however many exile-flagged punishments it carries.
  if (existing.robloxUserId && actions.some(a => ACTION_CONFIG[a.action]?.exile)) {
    const first = actions.find(a => ACTION_CONFIG[a.action]?.exile);
    const exiled = await roblox.exileFromGroup(existing.robloxUserId);
    await prisma.caseAction.create({
      data: {
        caseId, actionType: 'APPROVED', performedBy: approverDiscordId,
        notes: exiled
          ? `Roblox group exile executed for "${first.action}" (user ${existing.robloxUserId})`
          : `Roblox group exile failed for "${first.action}" (user ${existing.robloxUserId})`,
      },
    }).catch(() => {});
  }

  if (existing.robloxUserId && actions.some(a => a.action === 'Demotion')) {
    const result = await roblox.demoteByOneRank(existing.robloxUserId);
    await prisma.caseAction.create({
      data: {
        caseId, actionType: 'APPROVED', performedBy: approverDiscordId,
        notes: result.ok
          ? `Group demotion: ${result.from} → ${result.to} (user ${existing.robloxUserId})`
          : `Group demotion failed: ${result.reason} (user ${existing.robloxUserId})`,
      },
    }).catch(() => {});
  }

  // +4 to whoever filed it — never the subject.
  const filerRoblox = (await prisma.robloxLink.findUnique({
    where: { discordId: existing.submitterDiscordId },
  }).catch(() => null))?.robloxUsername || null;

  await enqueueQuotaAward({
    refType: 'case', refId: existing.id,
    discordId: existing.submitterDiscordId, robloxUsername: filerRoblox,
    points: 4, label: `case ${existing.caseRef}`,
  });

  return { ok: true, case: updated };
}

async function denyCase(caseId, approverDiscordId, note) {
  const existing = await prisma.case.findUnique({ where: { id: caseId } });
  if (!existing) return { ok: false, error: 'Case not found.' };
  if (existing.status !== 'PENDING') return { ok: false, error: 'Case is not pending' };

  const updated = await prisma.case.update({
    where: { id: caseId },
    data:  { status: 'DENIED', reviewedBy: approverDiscordId, reviewedAt: new Date() },
  });
  await prisma.caseAction.create({
    data: { caseId, actionType: 'DENIED', performedBy: approverDiscordId, notes: note || 'Denied' },
  });
  return { ok: true, case: updated };
}

// ── Expiry worker ─────────────────────────────────────────────────
// Runs at boot then every 5 minutes. A failed removal deliberately leaves
// roleRemoved false so the next tick retries — forever, until it lands.
async function checkExpiredPunishments(bot) {
  try {
    const expired = await prisma.casePunishment.findMany({
      where: { expiresAt: { lte: new Date() }, roleRemoved: false, roleId: { not: null } },
      include: { case: true },
    });
    for (const p of expired) {
      const target = p.case?.officerDiscordId;
      if (!target || !p.roleId) continue;
      const removed = await bot.removeRole(target, p.roleId);
      if (removed) {
        await prisma.casePunishment.update({ where: { id: p.id }, data: { roleRemoved: true } });
        console.log(`Expired role ${p.roleId} removed from ${target} (${p.case.caseRef})`);
      }
    }
  } catch (err) {
    console.error('[discipline] expiry check failed:', err.message);
  }
}

function startExpiryWorker(bot) {
  checkExpiredPunishments(bot);
  setInterval(() => checkExpiredPunishments(bot), 5 * 60 * 1000);
}

module.exports = {
  nextCaseRef, nextTicketRef, createCase, approveCase, denyCase,
  checkExpiredPunishments, startExpiryWorker,
};
