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

// Keep the IA forum post and its status tag in sync for decisions made
// from either Discord or the MET Dashboard.
async function syncCaseForumPost(kase, actor) {
  if (!kase || !kase.cardMessageId) return;
  try {
    const client = require('./bot').getClient();
    if (!client) return;
    const cards = require('./iaReviewCards');
    const { suspectAvatar } = await resolveCaseAvatars(null, kase);
    await cards.finaliseCard(
      client,
      cards.casesChannelId(),
      kase.cardMessageId,
      cards.caseCard(kase, { decidedBy: actor, subjectAvatar: suspectAvatar }),
    );
  } catch (err) {
    console.warn('[IA] case forum post sync failed:', err.message);
  }
}

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
function tierRefusal(actor, kase, verb) {
  if (!caseHasHicommOnlyPunishment(kase)) return null;
  const role = actor && actor.role;
  const rank = Number(actor && actor.iaRank);
  const minimum = parseInt(process.env.IA_ADIR_MIN_RANK || '30', 10);
  const rankName = String(actor && actor.iaRankName || '');
  const rankNameIsAdir = /assistant\s*director|deputy\s*director|\bdirector\b|administration|hicom|overseer|owner|holder/i.test(rankName);
  const isAdirPlus = ['HICOMM', 'DEVELOPER'].includes(role)
    || (Number.isFinite(rank) && rank >= (Number.isFinite(minimum) ? minimum : 30))
    || rankNameIsAdir;
  if (!isAdirPlus) {
    return `Only Assistant Director and above can ${verb} a case involving a Blacklist or Termination.`;
  }
  return null;
}


// ── Quota points for the reviewer ─────────────────────────────────
//
// Reviewing is work, and it is paid whichever way the decision goes: a case
// that is properly denied took the same reading as one that is approved, and
// paying only for approvals quietly rewards approving.
//
// One point, on the case id, so a re-decision cannot pay twice. Deliberately a
// DIFFERENT refType from the submitter's award on the same case — the outbox
// de-duplicates on (refType, refId), so sharing one would mean whichever landed
// first silently cancelled the other.
const REVIEW_POINTS = () => {
  const n = parseInt(process.env.IA_CASE_REVIEW_POINTS || '1', 10);
  return Number.isFinite(n) ? n : 1;
};

async function awardReviewer(kase, actor, decision) {
  if (!actor || !actor.id) return;
  const points = REVIEW_POINTS();
  if (!points) return;
  try {
    // The award is keyed by Roblox username on the sheet, so the reviewer's
    // account has to supply one. actor carries a User.id; the rest comes from
    // the row.
    const user = await prisma.user.findUnique({
      where:  { id: actor.id },
      select: { discordId: true, robloxUsername: true },
    });
    const discordId = (user && user.discordId) || actor.discordId || null;
    if (!discordId && !(user && user.robloxUsername)) return;

    const { enqueueQuotaAward } = require('./quota');
    await enqueueQuotaAward({
      refType: 'case_review', refId: kase.id,
      discordId,
      robloxUsername: (user && user.robloxUsername) || null,
      points,
      label: `reviewed case ${kase.caseRef} (${decision.toLowerCase()})`,
    });
  } catch (err) {
    // Never let the reviewer's point undo the decision itself.
    console.warn('[IA] reviewer point not queued for', kase.caseRef, '·', err.message);
  }
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
async function approveCase({ caseId, actor, note, onProgress } = {}) {
  const progress = async (message) => { if (typeof onProgress === 'function') await onProgress(message).catch(() => {}); };
  const existing = await prisma.case.findUnique({
    where:   { id: caseId },
    include: { user: { select: { discordUsername: true, displayName: true, discordId: true, robloxId: true, robloxUsername: true } } },
  });

  if (!existing) return { ok: false, status: 404, error: 'Case not found' };
  if (existing.status !== 'PENDING') return { ok: false, status: 409, error: 'Case is not pending' };
  const refusal = tierRefusal(actor, existing, 'approve');
  if (refusal) return { ok: false, status: 403, error: refusal };

  await progress('Confirming case approval…');
  // Atomically claim the PENDING→APPROVED transition so two concurrent
  // approvals can't both run the side effects (double demotion / dupe rows).
  const claim = await prisma.case.updateMany({ where: { id: caseId, status: 'PENDING' }, data: { status: 'APPROVED' } });
  if (claim.count === 0) return { ok: false, status: 409, error: 'Case is not pending' };
  const updated = await prisma.case.findUnique({ where: { id: caseId } });
  await progress('Updating the IA forum post and status tag…');
  await syncCaseForumPost(updated, actor);

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

    await progress('Posting the disciplinary notice…');
    const logMessageId = await sendApprovalWebhook({
      caseRef: existing.caseRef, action: existing.action, actions,
      reason: existing.reason, notes: existing.notes,
      hrDiscordId: actor.discordId || null,
      userDiscordId: officerDiscordId,
      targetDiscordId: officerDiscordId,
      caseLink: existing.caseLink || null,
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
        await progress(`Applying ${a.action}…`);
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
        await progress(`Processing group action for ${a.action}…`);
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
      await progress('Removing MET Discord roles…');
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
      await progress('Applying Roblox group demotion…');
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

    // Tell the OFFICER their record changed — the same notice /infract sends.
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
  let quotaAwarded = false;
  if (existing.user && existing.user.discordId && !IMPORT_OWNERS.has(existing.user.discordId)) {
    await progress('Issuing +4 QP to the case submitter…');
    const { enqueueQuotaAward } = require('./quota');
    quotaAwarded = await enqueueQuotaAward({
      refType: 'case', refId: existing.id,
      discordId: existing.user.discordId,
      robloxUsername: existing.user.robloxUsername || existing.investigatorRobloxUsername || null,
      points: 4, label: `case ${existing.caseRef}`,
    }).catch(() => false);
  }
  if (quotaAwarded) {
    await progress('Applying the +4 QP award to the quota sheet…');
    await require('./quota').processQuotaAwards().catch(() => {});
    await progress('Refreshing the IA quota leaderboard…');
    try { await require('./iaQuotaBoard').refresh(require('./bot').getClient()); }
    catch (err) { console.warn('[IA] quota board refresh after case approval failed:', err.message); }
  }

  await progress('Recording the approval audit…');
  await require('./actionJournal').record({
    kind: 'CASE_APPROVE',
    actorId: actor.id, actorName: actor.displayName || actor.discordUsername,
    targetType: 'case', targetId: existing.id,
    summary: `Approved case ${existing.caseRef}`,
    payload: { caseRef: existing.caseRef, officerDiscordId: existing.officerDiscordId },
  });

  return { ok: true, status: 200, case: updated, quotaAwarded };
}

/**
 * Deny a case. No side effects beyond the status and the audit row — nothing was
 * applied, so there is nothing to undo.
 */
async function denyCase({ caseId, actor, note } = {}) {
  const existing = await prisma.case.findUnique({ where: { id: caseId } });
  if (!existing) return { ok: false, status: 404, error: 'Case not found' };
  if (existing.status !== 'PENDING') return { ok: false, status: 409, error: 'Case is not pending' };
  const refusal = tierRefusal(actor, existing, 'deny');
  if (refusal) return { ok: false, status: 403, error: refusal };

  const claim = await prisma.case.updateMany({ where: { id: caseId, status: 'PENDING' }, data: { status: 'DENIED' } });
  if (claim.count === 0) return { ok: false, status: 409, error: 'Case is not pending' };
  const updated = await prisma.case.findUnique({ where: { id: caseId } });
  await syncCaseForumPost(updated, actor);
  await prisma.caseAction.create({
    data: { caseId: existing.id, actionType: 'DENIED', performedBy: actor.id, notes: note || 'Denied by HICOMM/Developer' },
  });

  // The reviewer is paid for a denial exactly as for an approval. The SUBMITTER
  // is not: no award is queued anywhere in this function, which is the point.
  await awardReviewer(existing, actor, 'DENIED');

  await require('./actionJournal').record({
    kind: 'CASE_DENY',
    actorId: actor.id, actorName: actor.displayName || actor.discordUsername,
    targetType: 'case', targetId: existing.id,
    summary: `Denied case ${existing.caseRef}`,
    payload: { caseRef: existing.caseRef },
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
  // Closed tickets are approved automatically at ingest. Keep this guard for
  // old dashboard routes and stale Discord buttons so nobody can manually
  // approve or deny a ticket after the policy change.
  return {
    ok: false,
    status: 409,
    error: 'Ticket logs are automatically approved. Manual ticket review is disabled.',
  };
}

module.exports = {
  approveCase, denyCase, reviewTicket, tierRefusal,
  resolveCaseAvatars, resolveOfficerDiscordId, robloxHeadshotUrl,
};
