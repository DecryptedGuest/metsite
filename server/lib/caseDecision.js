// server/lib/caseDecision.js
// Approving and denying a case, in one place.
//
// This used to live inline in routes/cases.js, which was fine while the website
// was the only thing that could decide a case. The /ia Discord dashboard decides
// them too, and a second copy of the approval side effects — the admin log, the
// punishment roles, the group exile, the Discord role strip, the demotion, the
// officer's DM, the quota award — would be a copy that drifts. When it drifted
// the symptom would be a case approved in Discord that never applied its
// punishment, which is the worst possible way to find out.
//
// So the route and the command both call the functions here, and the rules,
// the ordering and the idempotency guards are written once.
//
// `actor` is { id, role } where id is a dashboard User.id. It must be a real
// one: CaseAction.performedBy is a foreign key to User, so "who decided this"
// has nowhere to go without an account. Callers check that before getting here.

const prisma = require('./db');
const { ACTION_CONFIG } = require('./actions');
const { caseHasHicommOnlyPunishment } = require('./iaRank');
const { sendApprovalWebhook } = require('./webhook');
const { assignRole } = require('./bot');

// ── Avatar + identity helpers (moved here with the decision logic) ──

// A Roblox headshot URL for an id: the thumbnails API gives a direct CDN URL,
// but it can briefly return "Pending" with no URL — so fall back to Roblox's
// own headshot-thumbnail redirect, which Discord can still fetch.
async function robloxHeadshotUrl(robloxId, getRobloxAvatarHeadshot) {
  if (!robloxId) return null;
  try {
    const url = await getRobloxAvatarHeadshot(robloxId);
    if (url) return url;
  } catch (e) {}
  return `https://www.roblox.com/headshot-thumbnail/image?userId=${encodeURIComponent(robloxId)}&width=150&height=150&format=png`;
}

/**
 * Resolve Roblox headshot URLs for the admin-log embed:
 *   approverAvatar → the "Signed, …" author icon (the approving staff member)
 *   suspectAvatar  → the embed thumbnail (the officer the case is about)
 */
async function resolveCaseAvatars(approverUser, caseRow) {
  let approverAvatar = null, suspectAvatar = null;
  try {
    const { getRobloxIdFromDiscord, getRobloxIdFromUsername, getRobloxAvatarHeadshot } = require('./roblox');

    let arid = approverUser && approverUser.robloxId;
    if (!arid && approverUser && approverUser.discordId) {
      try { arid = await getRobloxIdFromDiscord(approverUser.discordId); } catch (e) {}
    }
    if (arid) approverAvatar = await robloxHeadshotUrl(arid, getRobloxAvatarHeadshot);

    let srid = caseRow && caseRow.robloxUserId;
    if (!srid && caseRow && caseRow.robloxUsername) {
      try { const u = await getRobloxIdFromUsername(caseRow.robloxUsername); srid = u && u.id; } catch (e) {}
    }
    if (srid) suspectAvatar = await robloxHeadshotUrl(srid, getRobloxAvatarHeadshot);
  } catch (e) { /* best-effort — embed still posts without avatars */ }
  return { approverAvatar, suspectAvatar };
}

/**
 * Resolve the officer's Discord ID for a case filed by Roblox username/ID only.
 * DB-first (zero RoVer cost), then RoVer's roblox-to-discord endpoint.
 */
async function resolveOfficerDiscordId(caseRow) {
  if (!caseRow) return null;
  if (caseRow.officerDiscordId) return caseRow.officerDiscordId;

  const { getRobloxIdFromUsername, getDiscordFromRoblox } = require('./roblox');
  let rid = caseRow.robloxUserId;
  if (!rid && caseRow.robloxUsername) {
    try { const u = await getRobloxIdFromUsername(caseRow.robloxUsername); rid = u && u.id; } catch (e) {}
  }
  if (!rid) return null;

  try {
    const u = await prisma.user.findFirst({ where: { robloxId: String(rid) }, select: { discordId: true } });
    if (u && u.discordId) return u.discordId;
  } catch (e) { /* fall through to RoVer */ }

  try {
    const matches = await getDiscordFromRoblox(rid);
    if (Array.isArray(matches) && matches.length && matches[0].discordId) return matches[0].discordId;
  } catch (e) { /* best-effort */ }

  return null;
}

// ── The tier gate ─────────────────────────────────────────────────
// A Supervisor may not decide a case carrying a Termination or a Blacklist;
// those are High Command (Deputy Director) and above. Checked here as well as
// in the caller so no surface can skip it.
function tierRefusal(actorRole, kase, verb) {
  if (actorRole === 'SUPERVISOR' && caseHasHicommOnlyPunishment(kase)) {
    return `Only HICOMM can ${verb} a case involving a Blacklist or Termination.`;
  }
  return null;
}

/**
 * Approve a case and run every side effect.
 *
 * @param {object} o
 * @param {string} o.caseId
 * @param {{id:string, role:string}} o.actor
 * @param {string} [o.note] what to write on the CaseAction
 * @returns {Promise<{ok:boolean, status:number, error?:string, case?:object}>}
 */
async function approveCase({ caseId, actor, note } = {}) {
  const existing = await prisma.case.findUnique({
    where:   { id: caseId },
    include: { user: { select: { discordUsername: true, displayName: true, discordId: true, robloxId: true, robloxUsername: true } } },
  });

  if (!existing) return { ok: false, status: 404, error: 'Case not found' };
  if (existing.status !== 'PENDING') return { ok: false, status: 409, error: 'Case is not pending' };
  const refusal = tierRefusal(actor && actor.role, existing, 'approve');
  if (refusal) return { ok: false, status: 403, error: refusal };

  // Atomically claim the PENDING→APPROVED transition so two concurrent
  // approvals can't both run the side effects (double demotion / dupe rows).
  const claim = await prisma.case.updateMany({ where: { id: caseId, status: 'PENDING' }, data: { status: 'APPROVED' } });
  if (claim.count === 0) return { ok: false, status: 409, error: 'Case is not pending' };
  const updated = await prisma.case.findUnique({ where: { id: caseId } });

  // Already actioned before? A synced case can be approved, reverted to PENDING
  // by a stale IA sync, then re-approved — the admin log was already posted and
  // roles/demotion already applied. Skip the side effects; only the status fix
  // above and the (idempotent) quota award below still run.
  const alreadyActioned = (await prisma.caseAction.count({
    where: { caseId: existing.id, actionType: 'APPROVED' },
  }).catch(() => 0)) > 0;

  await prisma.caseAction.create({
    data: {
      caseId: existing.id, actionType: 'APPROVED', performedBy: actor.id,
      notes: alreadyActioned
        ? 'Re-approved (already actioned · side effects skipped)'
        : (note || 'Approved by HICOMM/Developer'),
    },
  });

  if (!alreadyActioned) {
    const { suspectAvatar } = await resolveCaseAvatars(null, existing);

    // If the case was filed by Roblox only, convert to the officer's Discord ID
    // so the log can mention them and roles/expiry can be applied. Persist it.
    const officerDiscordId = existing.officerDiscordId || await resolveOfficerDiscordId(existing);
    if (officerDiscordId && officerDiscordId !== existing.officerDiscordId) {
      existing.officerDiscordId = officerDiscordId;
      await prisma.case.update({ where: { id: existing.id }, data: { officerDiscordId } }).catch(() => {});
    }

    const actions = Array.isArray(existing.actions) && existing.actions.length
      ? existing.actions
      : [{ action: existing.action, roleId: ACTION_CONFIG[existing.action]?.roleId || null, durationDays: null }];

    const logMessageId = await sendApprovalWebhook({
      caseRef: existing.caseRef, action: existing.action, actions,
      reason: existing.reason, notes: existing.notes,
      officerDiscordId,
      officerName: existing.robloxUsername || existing.suspectRobloxDisplayName || null,
      officerRobloxId: existing.robloxUserId || null,
      suspectAvatar, timestamp: new Date(),
    });
    if (logMessageId) {
      await prisma.case.update({ where: { id: existing.id }, data: { logMessageId } }).catch(() => {});
    }

    // Punishment roles + expiry records (requires a Discord ID). The role comes
    // from the current env-driven config so a case filed before a role existed
    // still gets it, falling back to whatever was snapshotted on the action.
    if (existing.officerDiscordId) {
      for (const a of actions) {
        const roleId = ACTION_CONFIG[a.action]?.roleId || a.roleId || null;
        if (!roleId) continue;
        await assignRole(existing.officerDiscordId, roleId);
        const expiresAt = a.durationDays ? new Date(Date.now() + a.durationDays * 86400000) : null;
        await prisma.casePunishment.create({
          data: { caseId: existing.id, action: a.action, roleId, durationDays: a.durationDays || null, expiresAt },
        });
      }
    }

    // Exile for exile-flagged actions: the MET umbrella group AND every division.
    if (existing.robloxUserId) {
      let exiledOnce = false;
      for (const a of actions) {
        if (!ACTION_CONFIG[a.action]?.exile) continue;
        if (exiledOnce) continue; // one pass per case covers every group
        const { exileEverywhere } = require('./exile');
        const res = await exileEverywhere(existing.robloxUserId);
        exiledOnce = res.ok;
        await prisma.caseAction.create({
          data: {
            caseId: existing.id, actionType: 'APPROVED', performedBy: actor.id,
            notes: res.ok
              ? `Group exile executed for "${a.action}" (user ${existing.robloxUserId}) · ${res.summary}`
              : `Group exile FAILED for "${a.action}" (user ${existing.robloxUserId}) · ${res.summary}`,
          },
        }).catch(() => {});
      }
    }

    // Strip their MET Discord roles when the case terminates or blacklists them.
    if (existing.officerDiscordId && actions.some(a => ACTION_CONFIG[a.action]?.exile)) {
      const stripRes = await require('./exile')
        .stripDiscordRolesForExile(existing.officerDiscordId, actions.map(a => a.action))
        .catch(err => ({ summary: 'role strip failed: ' + err.message }));
      if (stripRes) {
        await prisma.caseAction.create({
          data: {
            caseId: existing.id, actionType: 'APPROVED', performedBy: actor.id,
            notes: `MET Discord roles stripped (user ${existing.officerDiscordId}) · ${stripRes.summary}`,
          },
        }).catch(() => {});
      }
    }

    // Demotion → drop the suspect one rank in the Roblox group.
    if (existing.robloxUserId && actions.some(a => a.action === 'Demotion')) {
      const { demoteByOneRank } = require('./roblox');
      const result = await demoteByOneRank(existing.robloxUserId);
      await prisma.caseAction.create({
        data: {
          caseId: existing.id, actionType: 'APPROVED', performedBy: actor.id,
          notes: result.ok
            ? `Group demotion: ${result.from} → ${result.to} (user ${existing.robloxUserId})`
            : `Group demotion failed: ${result.reason} (user ${existing.robloxUserId})`,
        },
      }).catch(() => {});
    }

    // Tell the OFFICER their record changed — the same notice /discipline sends.
    if (existing.officerDiscordId) {
      const timed = actions.find(a => ACTION_CONFIG[a.action]?.timed && a.durationDays);
      require('./officerNotice').notifyPunished({
        discordId: existing.officerDiscordId,
        caseRef:   existing.caseRef,
        caseId:    existing.id,
        actions,
        action:    existing.action,
        reason:    existing.reason,
        notes:     existing.notes,
        caseLink:  existing.caseLink || null,
        expiresAt: timed ? new Date(Date.now() + timed.durationDays * 86400000) : null,
        direct:    existing.origin === 'DISCIPLINE',
        avatar:         suspectAvatar || null,
        robloxUsername: existing.robloxUsername || null,
        robloxId:       existing.robloxUserId || null,
      }).catch(() => {});
    }
  }

  // Quota points for the IA member who submitted the case — queued durably and
  // idempotent per case id, so a re-approval never doubles or drops them. Only
  // the placeholder-owned bulk imports are excluded.
  const IMPORT_OWNERS = new Set(['SYSTEM_LEGACY_IMPORT', 'ia-archive-import']);
  if (existing.user && existing.user.discordId && !IMPORT_OWNERS.has(existing.user.discordId)) {
    const { enqueueQuotaAward } = require('./quota');
    enqueueQuotaAward({
      refType: 'case', refId: existing.id,
      discordId: existing.user.discordId,
      robloxUsername: existing.user.robloxUsername || existing.investigatorRobloxUsername || null,
      points: 4, label: `case ${existing.caseRef}`,
    }).catch(() => {});
  }

  return { ok: true, status: 200, case: updated };
}

/**
 * Deny a case. No side effects beyond the status and the audit row — nothing was
 * applied, so there is nothing to undo.
 */
async function denyCase({ caseId, actor, note } = {}) {
  const existing = await prisma.case.findUnique({ where: { id: caseId } });
  if (!existing) return { ok: false, status: 404, error: 'Case not found' };
  if (existing.status !== 'PENDING') return { ok: false, status: 409, error: 'Case is not pending' };
  const refusal = tierRefusal(actor && actor.role, existing, 'deny');
  if (refusal) return { ok: false, status: 403, error: refusal };

  const claim = await prisma.case.updateMany({ where: { id: caseId, status: 'PENDING' }, data: { status: 'DENIED' } });
  if (claim.count === 0) return { ok: false, status: 409, error: 'Case is not pending' };
  const updated = await prisma.case.findUnique({ where: { id: caseId } });
  await prisma.caseAction.create({
    data: { caseId: existing.id, actionType: 'DENIED', performedBy: actor.id, notes: note || 'Denied by HICOMM/Developer' },
  });
  return { ok: true, status: 200, case: updated };
}

/**
 * Approve or deny a closed-ticket log.
 *
 * No punishment tier applies — a ticket carries no punishment — so this is
 * Supervisor and above, full stop. Approving awards the closer their quota
 * points, queued on the ticket id so a retry or a re-approval cannot double
 * them; denying leaves any existing award alone rather than clawing it back.
 *
 * @param {object} o
 * @param {string} o.ticketId
 * @param {{id:string, role:string, displayName?:string, discordUsername?:string}} o.actor
 * @param {'approve'|'deny'} o.action
 */
async function reviewTicket({ ticketId, actor, action } = {}) {
  const verb = String(action || '').toLowerCase();
  if (!['approve', 'deny'].includes(verb)) {
    return { ok: false, status: 400, error: "action must be 'approve' or 'deny'." };
  }
  const status = verb === 'approve' ? 'APPROVED' : 'DENIED';

  const ticket = await prisma.ticketLog.findUnique({ where: { id: ticketId } });
  if (!ticket) return { ok: false, status: 404, error: 'Ticket log not found.' };

  const updated = await prisma.ticketLog.update({
    where: { id: ticket.id },
    data: {
      status,
      reviewedById:   actor.id,
      reviewedByName: actor.displayName || actor.discordUsername || 'Internal Affairs',
      reviewedAt:     new Date(),
    },
  });

  if (status === 'APPROVED' && (ticket.closerDiscordId || ticket.closerUserId)) {
    const { enqueueQuotaAward, TICKET_POINTS } = require('./quota');
    let closer = null;
    if (ticket.closerUserId) {
      closer = await prisma.user.findUnique({
        where:  { id: ticket.closerUserId },
        select: { discordId: true, robloxUsername: true },
      }).catch(() => null);
    }
    const discordId = (closer && closer.discordId) || ticket.closerDiscordId || null;
    if (discordId) {
      enqueueQuotaAward({
        refType: 'ticket', refId: ticket.id,
        discordId,
        // Only the matched site account's Roblox name — NEVER
        // creatorRobloxUsername, which is the person who OPENED the ticket.
        robloxUsername: (closer && closer.robloxUsername) || null,
        points: TICKET_POINTS(),
        label: `ticket ${ticket.ticketRef || ticket.ticketName || ticket.id}`,
      }).catch(() => {});
    }
  }

  return { ok: true, status: 200, ticket: updated, decision: status };
}

module.exports = {
  approveCase, denyCase, reviewTicket, tierRefusal,
  resolveCaseAvatars, resolveOfficerDiscordId, robloxHeadshotUrl,
};
