// server/routes/cases.js
const express  = require('express');
const prisma   = require('../lib/db');
const { notifyStaff, sendCustomNotification } = require('../lib/push');
const { requireHICOMM, requireHICOMMStrict } = require('../middleware/auth');
const { sendApprovalWebhook, editApprovalWebhook } = require('../lib/webhook');
const { assignRole, getMemberRecord, findMemberByUsername,
        getRobloxNameFromNick, findMemberByRobloxNick } = require('../lib/bot');
const { getOfficerProfile, getOfficerProfileByRobloxId, exileFromGroup,
        getRobloxIdFromUsername, getRobloxUserInfo, getGroupMembership,
        getDiscordFromRoblox } = require('../lib/roblox');
const { ACTION_CONFIG, ACTION_NAMES, ALL_ACTION_NAMES } = require('../lib/actions');
const { parseDocText, fetchGoogleDocText, fetchGoogleDocHtml,
        parseCheckedPunishments, buildPunishmentsFromChecklist, cleanDecision } = require('../lib/forumImport');
const { HICOMM_ONLY_ACTIONS, caseHasHicommOnlyPunishment,
        canAppealCase, iaRankLabel } = require('../lib/iaRank');

const router = express.Router();

// Approving and denying a case, plus the avatar/identity helpers that go with
// them, live in lib/caseDecision so the /ia Discord dashboard runs the SAME
// logic rather than a copy of it that drifts.
const { approveCase, denyCase, resolveCaseAvatars, resolveOfficerDiscordId } = require('../lib/caseDecision');

// Case-number allocation lives in lib/caseRef.js so /discipline draws from the
// same sequence — two allocators would eventually collide on the unique index.
const { highestCaseNumber, generateCaseRef } = require('../lib/caseRef');

// ── GET /api/cases/actions ───────────────────────────────────
// The punishment list the case builder is built from — names AND what each one
// does, because the browser was keeping its own copy of that and the copy went
// stale. It had Written Warning and Suspension down as carrying no Discord role
// long after both were configured, so the checklist showed them as "NO ROLE"
// and gave Suspension no duration picker.
//
// `hasRole` rather than the id itself: the UI only ever asks whether there is
// one. `retired` actions are excluded — nothing new is ever filed against one.
router.get('/actions', (req, res) => res.json({
  actions: ACTION_NAMES.map(name => ({
    name,
    hasRole: !!ACTION_CONFIG[name].roleId,
    exile:   !!ACTION_CONFIG[name].exile,
    timed:   !!ACTION_CONFIG[name].timed,
  })),
  // The old shape, so anything still expecting a bare list of names keeps
  // working.
  names: ACTION_NAMES,
}));

// ── GET /api/cases/next-ref ───────────────────────────────────────
// The case ref the next submission will most likely get. An estimate — the
// real ref is assigned atomically at submit, so a concurrent submission could
// claim it first.
router.get('/next-ref', async (req, res) => {
  try {
    const next = (await highestCaseNumber()) + 1;
    res.json({ next, nextRef: `#${next}` });
  } catch (e) {
    res.json({ next: null, nextRef: null });
  }
});

// ── POST /api/cases/parse-doc ────────────────────────────────
// Parse a Google Doc case file and return autofill data for the case form:
// suspect (Roblox + Discord + MET group), investigator (Roblox + Discord),
// punishments (from the struck-through checkboxes), reason, notes, link.
router.post('/parse-doc', async (req, res) => {
  const url = (req.body?.url || '').toString().trim();
  if (!url) return res.status(400).json({ error: 'Provide a Google Doc link.' });

  const m = url.match(/document\/d\/([A-Za-z0-9_-]+)/);
  const docId = m ? m[1] : (/^[A-Za-z0-9_-]{20,}$/.test(url) ? url : null);
  if (!docId) return res.status(400).json({ error: 'That does not look like a Google Doc link.' });

  try {
    const [text, html] = await Promise.all([fetchGoogleDocText(docId), fetchGoogleDocHtml(docId)]);
    if (!text && !html) {
      return res.status(400).json({ error: 'Could not read that doc · make sure it is shared as "Anyone with the link can view".' });
    }

    const doc   = parseDocText(text) || {};
    const built = buildPunishmentsFromChecklist(parseCheckedPunishments(html), doc.finalDecision);
    const punishments = built.length ? built : (doc.punishments || []);
    const finalDecisionClean = cleanDecision(doc.finalDecision);

    // ── Suspect ────────────────────────────────────────
    const suspect = {
      robloxUsername:    doc.suspectRobloxUsername || null,
      robloxId:          null,
      robloxDisplayName: doc.suspectRobloxDisplayName || null,
      discordId:         null,
      discordUsername:   null,
      inGroup:           null,
      groupRole:         null,
      groupRank:         null,
      rank:              doc.suspectRank || null,
    };
    if (doc.suspectUserId && /^\d{17,20}$/.test(doc.suspectUserId)) suspect.discordId = doc.suspectUserId;
    else if (doc.suspectUserId && /^\d{1,16}$/.test(doc.suspectUserId)) suspect.robloxId = doc.suspectUserId;

    if (suspect.robloxUsername && !suspect.robloxId) {
      const r = await getRobloxIdFromUsername(suspect.robloxUsername);
      if (r) { suspect.robloxId = r.id; suspect.robloxUsername = r.username; suspect.robloxDisplayName = suspect.robloxDisplayName || r.displayName; }
    }
    // If we only have the suspect's Discord ID, resolve their Roblox via RoVer.
    if (suspect.discordId && !suspect.robloxId) {
      try {
        const prof = await getOfficerProfile(suspect.discordId);
        if (prof) {
          suspect.robloxId = prof.robloxId;
          suspect.robloxUsername    = suspect.robloxUsername    || prof.username;
          suspect.robloxDisplayName = suspect.robloxDisplayName || prof.displayName;
          suspect.inGroup = prof.inGroup; suspect.groupRole = prof.groupRole;
        }
      } catch { /* not linked — fine */ }
      // Fallback: parse the Discord nickname ("RANK | RobloxUsername").
      if (!suspect.robloxId) {
        const nickName = await getRobloxNameFromNick(suspect.discordId);
        if (nickName) {
          const r = await getRobloxIdFromUsername(nickName);
          if (r) { suspect.robloxId = r.id; suspect.robloxUsername = suspect.robloxUsername || r.username; suspect.robloxDisplayName = suspect.robloxDisplayName || r.displayName; }
        }
      }
    }
    if (suspect.robloxId && suspect.inGroup === null) {
      const mem = await getGroupMembership(suspect.robloxId);
      suspect.inGroup = !!mem; suspect.groupRole = mem?.role?.name || null; suspect.groupRank = mem?.role?.rank ?? null;
      if (!suspect.robloxDisplayName) { const info = await getRobloxUserInfo(suspect.robloxId); if (info) suspect.robloxDisplayName = info.displayName; }
    }
    if (suspect.discordId) {
      const rec = await getMemberRecord(suspect.discordId);
      suspect.discordUsername = rec?.username || null;
    }

    // ── Investigator ────────────────────────────────────
    const investigator = {
      robloxUsername:  doc.investigatorRobloxUsername || null,
      robloxId:        null,
      discordId:       doc.investigatorDiscordId || null,
      discordUsername: null,
      rank:            doc.investigatorRank || null,
    };
    if (investigator.robloxUsername) {
      const r = await getRobloxIdFromUsername(investigator.robloxUsername);
      if (r) { investigator.robloxId = r.id; investigator.robloxUsername = r.username; }
    }
    if (investigator.discordId && /^\d{17,20}$/.test(investigator.discordId)) {
      const rec = await getMemberRecord(investigator.discordId);
      investigator.discordUsername = rec?.username || null;
    }

    // Every exhibit the case file lists, captured once here rather than by
    // re-fetching somebody else's Google Doc every time a panel opens. The doc
    // HTML keeps the href behind "Exhibit A", which is how they are usually
    // written, so it is read in preference to the plain text.
    let evidence = [];
    try {
      const { fromText, sortExhibits } = require('../lib/caseEvidence');
      evidence = sortExhibits(fromText(html || text || '', 'case file')).slice(0, 60);
    } catch (e) { /* the case still imports without them */ }

    return res.json({
      docId,
      caseLink:          url.split('?')[0],
      suspect,
      investigator,
      punishments,
      evidence,
      finalDecision:     doc.finalDecision || null,
      finalDecisionClean,
      allegations:       doc.allegations || null,
      summary:           doc.summary || null,
    });
  } catch (err) {
    console.error('parse-doc error:', err);
    return res.status(500).json({ error: 'Failed to parse doc: ' + err.message });
  }
});

// ── GET /api/cases/records-lookup ────────────────────────────
// Internal Affairs records lookup. Resolves a target by any of:
//   type = robloxId | robloxUsername | discordId | discordUsername | auto
// Returns identity, MET group + rank, Discord presence, active punishment
// roles, and cases split into approved (counts) vs pending/denied (logged).
router.get('/records-lookup', async (req, res) => {
  const q    = (req.query.q || '').toString().trim();
  const type = (req.query.type || 'auto').toString();
  if (!q) return res.status(400).json({ error: 'Enter a value to search.' });

  let discordId = null, robloxId = null, robloxUsername = null;
  let robloxDisplayName = null;
  let discord = { inDiscord: null, roleIds: [], displayName: null, username: null };
  const notes = [];

  try {
    // ── Step 1: resolve the primary identifier ──────────────────
    const looksDiscordId = /^\d{17,20}$/.test(q);
    const looksRobloxId  = /^\d{1,16}$/.test(q);

    if (type === 'discordId' || (type === 'auto' && looksDiscordId)) {
      discordId = q;
    } else if (type === 'robloxId' || (type === 'auto' && looksRobloxId)) {
      robloxId = q;
    } else if (type === 'discordUsername') {
      const m = await findMemberByUsername(q);
      if (m) { discordId = m.id; discord = { inDiscord: true, roleIds: m.roleIds, displayName: m.displayName, username: m.username }; }
      else notes.push('No Discord member matched that username.');
    } else { // robloxUsername, or auto with letters
      const r = await getRobloxIdFromUsername(q);
      if (r) { robloxId = r.id; robloxUsername = r.username; robloxDisplayName = r.displayName; }
      else if (type === 'auto') {
        const m = await findMemberByUsername(q);
        if (m) { discordId = m.id; discord = { inDiscord: true, roleIds: m.roleIds, displayName: m.displayName, username: m.username }; }
        else notes.push('No Roblox or Discord user matched that name.');
      } else {
        notes.push('No Roblox user found with that username.');
      }
    }

    // ── Step 2: cross-resolve Discord → Roblox where possible ───────
    if (discordId && !robloxId) {
      try {
        const profile = await getOfficerProfile(discordId); // RoVer
        if (profile) {
          robloxId          = profile.robloxId;
          robloxUsername    = profile.username       || robloxUsername;
          robloxDisplayName = profile.displayName    || robloxDisplayName;
        } else {
          notes.push('Discord user is not RoVer-linked to a Roblox account.');
        }
      } catch (err) {
        notes.push('RoVer lookup failed: ' + err.message);
      }
      // Fallback: parse the Discord server nickname ("RANK | RobloxUsername").
      if (!robloxId) {
        const nickName = await getRobloxNameFromNick(discordId);
        if (nickName) {
          const r = await getRobloxIdFromUsername(nickName);
          if (r) {
            robloxId          = r.id;
            robloxUsername    = r.username       || robloxUsername;
            robloxDisplayName = r.displayName    || robloxDisplayName;
            notes.push('Roblox resolved from Discord nickname (RoVer fallback).');
          }
        }
      }
    }

    // ── Step 2b: cross-resolve Roblox → Discord via RoVer ──────────
    if (robloxId && !discordId) {
      try {
        const matches = await getDiscordFromRoblox(robloxId);
        if (matches.length) {
          const primary = matches[0];
          discordId = primary.discordId;
          discord = {
            inDiscord:   true,
            roleIds:     primary.roleIds || [],
            displayName: primary.displayName,
            username:    primary.username,
          };
          if (matches.length > 1) {
            notes.push(`This Roblox account is RoVer-linked to ${matches.length} Discord users; showing ${primary.username || primary.discordId}.`);
          }
        } else {
          notes.push('No Discord member in the server is RoVer-linked to this Roblox account.');
        }
      } catch (err) {
        notes.push('RoVer reverse lookup failed: ' + err.message);
      }
      // Fallback: scan server nicknames for "RANK | RobloxUsername".
      if (!discordId) {
        const uname = robloxUsername || (await getRobloxUserInfo(robloxId))?.username;
        if (uname) {
          const m = await findMemberByRobloxNick(uname);
          if (m) {
            discordId = m.id;
            discord = { inDiscord: true, roleIds: m.roleIds, displayName: m.displayName, username: m.username };
            notes.push('Discord resolved from server nickname (RoVer fallback).');
          }
        }
      }
    }

    // ── Step 3: enrich Roblox identity + group membership ──────────
    let group = { inGroup: null, groupRole: null, groupRank: null };
    if (robloxId) {
      const [info, membership] = await Promise.all([
        (!robloxUsername || !robloxDisplayName) ? getRobloxUserInfo(robloxId) : Promise.resolve(null),
        getGroupMembership(robloxId),
      ]);
      if (info) {
        robloxUsername    = robloxUsername    || info.username;
        robloxDisplayName = robloxDisplayName || info.displayName;
      }
      group = {
        inGroup:   !!membership,
        groupRole: membership?.role?.name ?? null,
        groupRank: membership?.role?.rank ?? null,
      };
    }

    // ── Step 4: Discord presence + roles ──────────────────────
    if (discordId && discord.inDiscord === null) {
      discord = await getMemberRecord(discordId);
    }

    // ── Step 5: active punishment roles held in Discord ────────────
    const heldRoleSet = new Set(discord.roleIds || []);
    const punishmentRoles = Object.entries(ACTION_CONFIG)
      .filter(([, cfg]) => cfg.roleId && heldRoleSet.has(cfg.roleId))
      .map(([name, cfg]) => ({ action: name, roleId: cfg.roleId }));

    // ── Step 6: cases filed against this target ─────────────────
    const orClauses = [];
    if (discordId)      orClauses.push({ officerDiscordId: discordId });
    if (robloxId)       orClauses.push({ robloxUserId: robloxId });
    if (robloxUsername) orClauses.push({ robloxUsername: { equals: robloxUsername, mode: 'insensitive' } });

    let cases = [];
    if (orClauses.length) {
      cases = await prisma.case.findMany({
        where:   { OR: orClauses },
        include: { casePunishments: true, user: { select: { displayName: true, discordUsername: true } } },
        orderBy: { createdAt: 'desc' },
      });
    }

    const serialize = c => ({
      id:        c.id,
      caseRef:   c.caseRef,
      // NATIVE | IA | DISCIPLINE. The records tab shows a badge for anything
      // that wasn't an actual investigation.
      origin:    c.origin || 'NATIVE',
      action:    c.action,
      actions:   Array.isArray(c.actions) ? c.actions : null,
      reason:    c.reason,
      notes:     c.notes,
      status:    c.status,
      createdAt: c.createdAt,
      caseLink:  c.caseLink || null,
      evidence:  Array.isArray(c.evidence) ? c.evidence : null,
      appealedAt:     c.appealedAt || null,
      appealedByName: c.appealedByName || null,
      appealReason:   c.appealReason || null,
      investigator: c.user ? (c.user.displayName || c.user.discordUsername) : null,
      punishments: (c.casePunishments || []).map(p => ({
        action: p.action, durationDays: p.durationDays, expiresAt: p.expiresAt,
        roleRemoved: p.roleRemoved, active: !p.roleRemoved && (!p.expiresAt || new Date(p.expiresAt) > new Date()),
      })),
    });

    // APPROVED cases count toward the record; PENDING/DENIED are logged only,
    // and OVERTURNED (successfully appealed) cases are listed separately so it
    // is obvious they were lifted rather than never issued.
    const approvedCases   = cases.filter(c => c.status === 'APPROVED').map(serialize);
    const overturnedCases = cases.filter(c => c.status === 'OVERTURNED').map(serialize);
    const otherCases      = cases.filter(c => c.status !== 'APPROVED' && c.status !== 'OVERTURNED').map(serialize);

    // Punishment record = distinct approved actions (excludes pending/denied).
    // Only real punishment names — never import placeholders like
    // "Legacy Case (imported)" or "Punishments: …".
    const recordSet = new Set();
    for (const c of approvedCases) {
      if (Array.isArray(c.actions) && c.actions.length) {
        c.actions.forEach(a => { if (a && ALL_ACTION_NAMES.includes(a.action)) recordSet.add(a.action); });
      } else if (c.action && ALL_ACTION_NAMES.includes(c.action)) {
        recordSet.add(c.action);
      }
    }

    return res.json({
      found: !!(discordId || robloxId),
      identity: {
        discordId,
        discordUsername:   discord.username,
        discordDisplayName: discord.displayName,
        robloxId,
        robloxUsername,
        robloxDisplayName,
      },
      discord: { inDiscord: discord.inDiscord },
      group,
      punishmentRoles,
      punishmentRecord: [...recordSet],
      approvedCases,
      overturnedCases,
      otherCases,
      counts: {
        total:      cases.length,
        approved:   approvedCases.length,
        overturned: overturnedCases.length,
        pending:    otherCases.filter(c => c.status === 'PENDING').length,
        denied:     otherCases.filter(c => c.status === 'DENIED').length,
      },
      notes,
    });
  } catch (err) {
    console.error('records-lookup error:', err);
    return res.status(500).json({ error: 'Lookup failed: ' + err.message });
  }
});

// ── GET /api/cases/lookup-member/:discordId ──────────────────────
router.get('/lookup-member/:discordId', async (req, res) => {
  const { discordId } = req.params;
  if (!/^\d{17,20}$/.test(discordId)) return res.status(400).json({ error: 'Invalid Discord ID format' });
  const { getMemberDisplayName } = require('../lib/bot');
  const member = await getMemberDisplayName(discordId);
  res.json({ displayName: member || null });
});

// ── GET /api/cases/officer-profile/:id ──────────────────────────
// Accepts a Discord ID, Roblox ID, Discord username, or Roblox username.
router.get('/officer-profile/:id', async (req, res) => {
  let id = (req.params.id || '').trim();

  // Discord IDs are 17-20 digit snowflakes; Roblox user IDs are shorter
  let isDiscordId = /^\d{17,20}$/.test(id);
  let isRobloxId  = /^\d{1,16}$/.test(id);

  // Username input (contains non-digits) → resolve to an ID first.
  if (!isDiscordId && !isRobloxId) {
    const uname = id.replace(/^@/, '');
    if (!/^[A-Za-z0-9_.]{2,32}$/.test(uname)) {
      return res.status(400).json({ error: 'Enter a Discord/Roblox ID or username.' });
    }
    const r = await getRobloxIdFromUsername(uname);           // try Roblox username
    if (r) { id = r.id; isRobloxId = true; }
    else {
      const m = await findMemberByUsername(uname);            // try Discord username
      if (m) { id = m.id; isDiscordId = true; }
      else return res.json({ linked: false, reason: 'not_found' });
    }
  }

  let profile;
  let inputDiscordId  = isDiscordId ? id : null;
  let inputRobloxId   = isRobloxId  ? id : null;

  if (isDiscordId) {
    let roverError = null;
    try {
      profile = await getOfficerProfile(id);
    } catch (err) {
      console.error('officer-profile RoVer error:', err.message);
      roverError = err;
    }
    // Fallback: parse the Discord nickname ("RANK | RobloxUsername").
    if (!profile) {
      const nickName = await getRobloxNameFromNick(id);
      if (nickName) {
        const r = await getRobloxIdFromUsername(nickName);
        if (r) profile = await getOfficerProfileByRobloxId(r.id);
      }
    }
    // Still nothing and RoVer errored → surface the error to the client.
    if (!profile && roverError) {
      const isRateLimit = roverError.message.toLowerCase().includes('rate_limit');
      return res.json({ linked: false, reason: 'rover_error', error: roverError.message, isRateLimit });
    }
  } else {
    profile = await getOfficerProfileByRobloxId(id);
  }

  // For Discord ID path: null means not linked. For Roblox path: null means user not found.
  if (!profile) {
    return res.json({ linked: false, reason: isDiscordId ? 'not_linked' : 'not_found' });
  }

  // Build OR clauses for case history lookup
  const orClauses = [];
  if (inputDiscordId)    orClauses.push({ officerDiscordId: inputDiscordId });
  if (profile.robloxId)  orClauses.push({ robloxUserId: profile.robloxId });
  if (profile.username)  orClauses.push({ robloxUsername: profile.username });

  const approvedCases = await prisma.case.findMany({
    where:   { OR: orClauses, status: 'APPROVED' },
    select:  { action: true, actions: true, caseRef: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  // Collect all action names that have been approved
  const approvedActionSet = new Set();
  for (const c of approvedCases) {
    if (Array.isArray(c.actions)) {
      c.actions.forEach(a => approvedActionSet.add(a.action));
    } else if (c.action) {
      approvedActionSet.add(c.action);
    }
  }
  const approvedActions = [...approvedActionSet];

  // Suggest next progression step
  let suggestedAction = null;
  let warning         = null;
  if (approvedActions.includes('Disciplinary Strike 2')) {
    suggestedAction = 'Termination';
    warning         = 'Existing Disciplinary Strike 2 on record';
  } else if (approvedActions.includes('Disciplinary Strike 1')) {
    suggestedAction = 'Disciplinary Strike 2';
    warning         = 'Existing Disciplinary Strike 1 on record';
  } else if (approvedActions.includes('Activity Strike')) {
    suggestedAction = 'Disciplinary Strike 1';
    warning         = 'Existing Activity Strike on record';
  } else if (approvedActions.includes('Written Warning')) {
    suggestedAction = 'Disciplinary Strike 1';
    warning         = 'Existing Written Warning on record';
  }

  res.json({
    linked:         !!profile,
    discordId:      inputDiscordId || profile?.discordId || null,
    robloxId:       profile?.robloxId    || null,
    robloxUsername: profile?.username    || null,
    displayName:    profile?.displayName || null,
    inGroup:        profile?.inGroup     ?? null,
    groupRole:      profile?.groupRole   || null,
    approvedActions,
    suggestedAction,
    warning,
    history: approvedCases.map(c => ({ caseRef: c.caseRef, action: c.action, createdAt: c.createdAt })),
  });
});

// ── GET /api/cases/stats ───────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const isElevated = ['HICOMM','SUPERVISOR','DEVELOPER'].includes(req.user.role);
    // scope=mine → always the current user's own cases, regardless of role
    const where      = (req.query.scope === 'mine' || !isElevated) ? { userId: req.user.id } : {};
    const [total, pending, approved, denied, overturned, changes] = await Promise.all([
      prisma.case.count({ where }),
      prisma.case.count({ where: { ...where, status: 'PENDING'  } }),
      prisma.case.count({ where: { ...where, status: 'APPROVED' } }),
      prisma.case.count({ where: { ...where, status: 'DENIED'   } }),
      prisma.case.count({ where: { ...where, status: 'OVERTURNED' } }),
      prisma.case.count({ where: { ...where, status: 'PENDING', reviewNote: { not: null } } }),
    ]);
    res.json({ total, pending, approved, denied, overturned, changesRequested: changes });
  } catch { res.status(500).json({ error: 'Failed to fetch stats' }); }
});

// ── Case search ───────────────────────────────────────────────────
// Turn a free-text query into a Prisma OR clause across every field an
// investigator would plausibly search by. Empty query → null (no filter).
function caseSearchClause(q) {
  const s = (q || '').toString().trim();
  if (!s) return null;
  const like = { contains: s, mode: 'insensitive' };
  // "#412" and "412" should both find case #412.
  const bare = s.replace(/^#/, '');
  return {
    OR: [
      { caseRef:                     like },
      { caseRef:                     { contains: bare, mode: 'insensitive' } },
      { action:                      like },
      { reason:                      like },
      { notes:                       like },
      { robloxUsername:              like },
      { robloxUserId:                like },
      { officerDiscordId:            like },
      { suspectRobloxDisplayName:    like },
      { investigatorRobloxUsername:  like },
      { investigatorDiscordUsername: like },
      { punishmentsSummary:          like },
      { appealedByName:              like },
      { reviewNote:                  like },
      { user: { is: { discordUsername: like } } },
      { user: { is: { displayName:     like } } },
    ],
  };
}

// ── GET /api/cases/my ─────────────────────────────────────────────
router.get('/my', async (req, res) => {
  try {
    // "My Cases" is always only the cases the current user submitted, regardless
    // of role. Everything lives in "All Cases".
    const search = caseSearchClause(req.query.q);
    const where  = search ? { AND: [{ userId: req.user.id }, search] } : { userId: req.user.id };
    const cases = await prisma.case.findMany({
      where,
      include: {
        user: { select: { discordUsername: true, displayName: true, discordAvatar: true, role: true } },
        appeals: { orderBy: { createdAt: 'desc' } },
        caseActions: {
          include: { user: { select: { discordUsername: true, displayName: true } } },
          orderBy:  { timestamp: 'desc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(cases);
  } catch (err) {
    console.error('GET /cases/my error:', err);
    res.status(500).json({ error: 'Failed to fetch cases' });
  }
});

// ── GET /api/cases/all ───────────────────────────────────
// Readable by any authenticated user (IA + HICOMM). HICOMM-only actions
// (approve/deny/delete) remain gated on their own endpoints.
router.get('/all', async (req, res) => {
  try {
    const { status } = req.query;
    const search  = caseSearchClause(req.query.q);
    const filters = [];
    if (status && ['PENDING', 'APPROVED', 'DENIED', 'OVERTURNED'].includes(status)) filters.push({ status });
    if (search) filters.push(search);
    const cases = await prisma.case.findMany({
      where: filters.length ? { AND: filters } : {},
      include: {
        user: { select: { discordUsername: true, displayName: true, discordAvatar: true, discordId: true } },
        appeals: { orderBy: { createdAt: 'desc' } },
        caseActions: {
          include: { user: { select: { discordUsername: true, displayName: true } } },
          orderBy:  { timestamp: 'desc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(cases);
  } catch (err) {
    console.error('GET /cases/all error:', err);
    res.status(500).json({ error: 'Failed to fetch cases' });
  }
});

// ── POST /api/cases ──────────────────────────────────────
// Body: { actions: [{ action, durationDays }], reason, notes, officerInput }
// officerInput can be a Discord ID (17-20 digits) or Roblox ID (≤16 digits)
router.post('/', async (req, res) => {
  const { actions: rawActions, reason, notes, officerInput } = req.body;
  let   caseLink   = req.body.caseLink;

  // Exhibits the importer read off the case file. Stored so the case panel can
  // show them without re-fetching somebody else's document every time.
  const evidence = Array.isArray(req.body.evidence)
    ? req.body.evidence.slice(0, 60).map(e => ({
        label: e && e.label ? String(e.label).slice(0, 40) : null,
        url:   e && e.url && /^https?:\/\//i.test(String(e.url)) ? String(e.url).slice(0, 800) : null,
        note:  e && e.note ? String(e.note).slice(0, 300) : null,
        source: 'case file',
      })).filter(e => e.url || e.note)
    : [];

  if (!Array.isArray(rawActions) || !rawActions.length) {
    return res.status(400).json({ error: 'At least one action is required.' });
  }
  if (!reason?.trim()) {
    return res.status(400).json({ error: 'Reason is required.' });
  }
  if (!officerInput?.trim()) {
    return res.status(400).json({ error: 'Officer Discord or Roblox ID is required.' });
  }

  // Every case is backed by its case file — the linked document.
  if (!caseLink?.trim()) {
    return res.status(400).json({ error: 'A case link is required.' });
  }

  let rawId      = officerInput.trim();
  let isDiscord  = /^\d{17,20}$/.test(rawId);
  let isRoblox   = /^\d{1,16}$/.test(rawId);

  // Username input → resolve to an ID first (Roblox username, then Discord username).
  if (!isDiscord && !isRoblox) {
    const uname = rawId.replace(/^@/, '');
    if (!/^[A-Za-z0-9_.]{2,32}$/.test(uname)) {
      return res.status(400).json({ error: 'Enter a Discord/Roblox ID or username for the officer.' });
    }
    const r = await getRobloxIdFromUsername(uname);
    if (r) { rawId = r.id; isRoblox = true; }
    else {
      const m = await findMemberByUsername(uname);
      if (m) { rawId = m.id; isDiscord = true; }
      else return res.status(400).json({ error: 'Could not find a Discord or Roblox user matching that input.' });
    }
  }

  for (const a of rawActions) {
    if (!ACTION_NAMES.includes(a.action)) {
      return res.status(400).json({ error: `Invalid action: ${a.action}` });
    }
  }

  // Resolve Roblox identity at submission time (non-blocking)
  let officerDiscordId = isDiscord ? rawId : null;
  let robloxUserId     = null;
  let robloxUsername   = null;

  try {
    if (isDiscord) {
      const profile = await getOfficerProfile(rawId);
      if (profile) { robloxUserId = profile.robloxId; robloxUsername = profile.username; }
    } else {
      const profile = await getOfficerProfileByRobloxId(rawId);
      if (profile) { robloxUserId = rawId; robloxUsername = profile.username; }
    }
  } catch (err) {
    console.warn('Officer profile lookup at case creation (non-blocking):', err.message);
    // Proceed without Roblox identity — exile will be skipped on approve
  }

  // Fall back to client-supplied identity (e.g. from doc import) if RoVer
  // resolution didn't yield a Roblox account.
  if (!robloxUserId && req.body.robloxUserId)     robloxUserId   = String(req.body.robloxUserId);
  if (!robloxUsername && req.body.robloxUsername) robloxUsername = String(req.body.robloxUsername);

  // Build display-friendly action string and enrich actions with roleId
  const enrichedActions = rawActions.map(a => ({
    ...a,
    roleId: ACTION_CONFIG[a.action]?.roleId || null,
  }));
  const actionDisplay = enrichedActions.map(a => a.action).join(', ');

  try {
    // caseRef is @unique. Two officers submitting at once — or an IA import
    // grabbing the same #N between generateCaseRef() and create() — would clash
    // on the unique constraint. Retry with a fresh ref on P2002 instead of
    // 500-ing and discarding the officer's fully-filled case.
    let caseRef, newCase;
    for (let attempt = 0; ; attempt++) {
     caseRef = await generateCaseRef();
     try {
      newCase = await prisma.case.create({
      data: {
        caseRef,
        userId:           req.user.id,
        officerDiscordId,
        robloxUserId,
        robloxUsername,
        action:           actionDisplay,
        actions:          enrichedActions,
        reason:           reason.trim(),
        notes:            notes?.trim() || 'N/A',
        caseLink:         caseLink?.trim() || null,
        evidence:         evidence.length ? evidence : undefined,
        suspectRobloxDisplayName:    req.body.suspectRobloxDisplayName    || null,
        investigatorRobloxId:        req.body.investigatorRobloxId        || null,
        investigatorRobloxUsername:  req.body.investigatorRobloxUsername  || null,
        investigatorDiscordUsername: req.body.investigatorDiscordUsername || null,
        punishmentsSummary:          req.body.punishmentsSummary          || null,
        status:           'PENDING',
      },
      include: { user: { select: { discordUsername: true, displayName: true } } },
      });
      break;
     } catch (err) {
      if (err && err.code === 'P2002' && attempt < 5) continue; // ref clash → new ref
      throw err;
     }
    }

    await prisma.caseAction.create({
      data: { caseId: newCase.id, actionType: 'CREATED', performedBy: req.user.id, notes: 'Case submitted' },
    });

    // Fire-and-forget — don't delay the response
    notifyStaff({
      category: 'case',
      title: `New Case · ${caseRef}`,
      body:  `${robloxUsername || 'Unknown'} · ${actionDisplay}`,
      url:   `/ia/dashboard?page=review&case=${newCase.id}`,
    });

    res.status(201).json(newCase);
  } catch (err) {
    console.error('POST /cases error:', err);
    res.status(500).json({ error: 'Failed to create case' });
  }
});

// ── PATCH /api/cases/:id/approve ──────────────────────────────
router.patch('/:id/approve', requireHICOMM, async (req, res) => {
  try {
    const out = await approveCase({ caseId: req.params.id, actor: req.user });
    if (!out.ok) return res.status(out.status).json({ error: out.error });
    res.json(out.case);
  } catch (err) {
    console.error('PATCH /approve error:', err);
    res.status(500).json({ error: 'Failed to approve case' });
  }
});

// ── PATCH /api/cases/:id/deny ────────────────────────────────
router.patch('/:id/deny', requireHICOMM, async (req, res) => {
  try {
    const out = await denyCase({ caseId: req.params.id, actor: req.user });
    if (!out.ok) return res.status(out.status).json({ error: out.error });
    res.json(out.case);
  } catch (err) {
    console.error('PATCH /deny error:', err);
    res.status(500).json({ error: 'Failed to deny case' });
  }
});

// ── Change tracking ───────────────────────────────────────────────
// A snapshot of every field a submitter can edit. Taken when a reviewer
// requests changes, and diffed against the live row on the next edit so the
// case detail can show EXACTLY what was updated, not just that something was.
function caseSnapshot(c) {
  return {
    action:   c.action || '',
    actions:  Array.isArray(c.actions) ? c.actions.map(a => ({ action: a.action, durationDays: a.durationDays ?? null })) : [],
    reason:   c.reason || '',
    notes:    c.notes  || '',
    caseLink: c.caseLink || '',
  };
}

// Human-readable rendering of a punishment list, used for the diff.
function actionsLabel(list) {
  if (!Array.isArray(list) || !list.length) return '';
  return list.map(a => a.action + (a.durationDays ? ` (${a.durationDays}d)` : '')).join(', ');
}

// Field-by-field diff between two snapshots. Returns
// [{ field, label, before, after }] — only fields that actually changed.
function diffSnapshots(before, after) {
  if (!before) return [];
  const FIELDS = [
    { field: 'actions',  label: 'Punishments', render: v => actionsLabel(v) },
    { field: 'reason',   label: 'Reason',      render: v => (v || '') },
    { field: 'notes',    label: 'Notes',       render: v => (v || '') },
    { field: 'caseLink', label: 'Case link',   render: v => (v || '') },
  ];
  const out = [];
  for (const f of FIELDS) {
    const b = f.render(before[f.field]);
    const a = f.render(after[f.field]);
    if (String(b).trim() !== String(a).trim()) out.push({ field: f.field, label: f.label, before: b, after: a });
  }
  return out;
}

// ── PATCH /api/cases/:id — edit a case (HICOMM / Developer) ────────
// Body: { actions, reason, notes, caseLink, repost }
// Updates the case; if `repost` and the case is APPROVED, re-posts the
// Administrative Log to the webhook with the new details.
router.patch('/:id', async (req, res) => {
  const { actions: rawActions, reason, notes, caseLink, repost } = req.body;
  try {
    const existing = await prisma.case.findUnique({
      where:   { id: req.params.id },
      include: {
        casePunishments: true,
        user: { select: { discordUsername: true, displayName: true, discordId: true, robloxId: true, robloxUsername: true } },
      },
    });
    if (!existing) return res.status(404).json({ error: 'Case not found' });

    // Elevated staff can edit any case; the submitter may edit their OWN case
    // while it's still pending (e.g. to action a "changes requested" note).
    const isElevated = ['HICOMM', 'SUPERVISOR', 'DEVELOPER'].includes(req.user.role);
    const isOwnerPending = existing.userId === req.user.id && existing.status === 'PENDING';
    if (!isElevated && !isOwnerPending) {
      return res.status(403).json({ error: 'You can only edit your own pending case.' });
    }
    // Same separation-of-duties gate as approve/deny: a SUPERVISOR can neither
    // edit a case that already carries a Blacklist/Termination nor inject one.
    if (req.user.role === 'SUPERVISOR' &&
        (caseHasHicommOnlyPunishment(existing) ||
         (Array.isArray(rawActions) && rawActions.some(a => a && HICOMM_ONLY_ACTIONS.includes(a.action))))) {
      return res.status(403).json({ error: 'Only HICOMM can edit a case involving a Blacklist or Termination.' });
    }

    // Blacklists and Terminations are High Command's alone — the same rule that
    // guards approve, deny and appeal has to guard editing too. Without it a
    // Supervisor could edit the Termination off a case and then appeal it as
    // though it had never carried one, laundering their way past the gate.
    if (req.user.role === 'SUPERVISOR') {
      if (caseHasHicommOnlyPunishment(existing))
        return res.status(403).json({ error: 'Only HICOMM can edit a case involving a Blacklist or Termination.' });
      if (Array.isArray(rawActions) && caseHasHicommOnlyPunishment({ actions: rawActions }))
        return res.status(403).json({ error: 'Only HICOMM can add a Blacklist or Termination to a case.' });
    }
    // Likewise, the submitter's own edit window is for a PENDING case. Once a
    // case is decided, only elevated staff may touch it.
    if (!isElevated && Array.isArray(rawActions) && caseHasHicommOnlyPunishment({ actions: rawActions })) {
      return res.status(403).json({ error: 'Only HICOMM can add a Blacklist or Termination to a case.' });
    }

    const data = {};
    // Editing always clears any outstanding "changes requested" note + parsed changes.
    const hadRequest = !!existing.reviewNote;
    if (existing.reviewNote)     data.reviewNote     = null;
    if (existing.reviewChanges)  data.reviewChanges  = null;
    if (existing.reviewSnapshot) data.reviewSnapshot = null;
    if (Array.isArray(rawActions) && rawActions.length) {
      for (const a of rawActions) {
        if (!ACTION_NAMES.includes(a.action)) return res.status(400).json({ error: `Invalid action: ${a.action}` });
      }
      const enriched = rawActions.map(a => ({ ...a, roleId: ACTION_CONFIG[a.action]?.roleId || null }));
      data.actions = enriched;
      data.action  = enriched.map(a => a.action).join(', ');
    }
    if (reason !== undefined)   data.reason   = String(reason).trim() || existing.reason;
    if (notes  !== undefined)   data.notes    = String(notes).trim()  || 'N/A';
    if (caseLink !== undefined) data.caseLink = String(caseLink).trim() || existing.caseLink;

    // Diff this edit against the snapshot taken when changes were requested (or
    // against the pre-edit row when none was), and append it to the case's
    // revision history so reviewers can see exactly what moved.
    const beforeSnap = existing.reviewSnapshot || caseSnapshot(existing);
    const afterSnap  = caseSnapshot({ ...existing, ...data });
    const changed    = diffSnapshots(beforeSnap, afterSnap);
    if (changed.length) {
      const history = Array.isArray(existing.reviewRevisions) ? existing.reviewRevisions.slice(-19) : [];
      history.push({
        at:            new Date().toISOString(),
        by:            req.user.displayName || req.user.discordUsername || null,
        byId:          req.user.discordId || null,
        // Whether this edit was made in response to a reviewer's request.
        addressedNote: hadRequest ? (existing.reviewNote || null) : null,
        changes:       changed,
      });
      data.reviewRevisions = history;
    }

    const updated = await prisma.case.update({ where: { id: req.params.id }, data });

    await prisma.caseAction.create({
      data: {
        caseId: existing.id,
        actionType: hadRequest ? 'CHANGES_APPLIED' : 'CREATED',
        performedBy: req.user.id,
        notes: changed.length
          ? `Case edited by ${req.user.displayName || req.user.discordUsername} · ${changed.map(c => c.label).join(', ')} updated`
          : `Case edited by ${req.user.displayName || req.user.discordUsername}`,
      },
    }).catch(() => {});

    // Tell the reviewer who asked for the changes that they've landed.
    if (hadRequest && existing.reviewChanges && existing.reviewChanges.byUserId) {
      sendCustomNotification({
        userIds: [existing.reviewChanges.byUserId],
        title:   `Changes applied · ${existing.caseRef}`,
        body:    changed.length ? changed.map(c => c.label).join(', ') + ' updated' : 'The submitter updated this case.',
        url:     `/ia/dashboard?page=review&case=${existing.id}`,
        prefKey: 'caseUpdated',
      }).catch(() => {});
    }

    // Update the administrative log — only for APPROVED cases. Edit the original
    // message in place if we have its id, otherwise post a fresh one.
    if (repost && updated.status === 'APPROVED') {
      const actions = Array.isArray(updated.actions) && updated.actions.length
        ? updated.actions
        : [{ action: updated.action, roleId: ACTION_CONFIG[updated.action]?.roleId || null, durationDays: null }];
      const { suspectAvatar } = await resolveCaseAvatars(null, updated);
      const officerDiscordId = updated.officerDiscordId || await resolveOfficerDiscordId(updated);
      if (officerDiscordId && officerDiscordId !== updated.officerDiscordId) {
        await prisma.case.update({ where: { id: updated.id }, data: { officerDiscordId } }).catch(() => {});
      }
      const payload = {
        caseRef: updated.caseRef, action: updated.action, actions,
        reason: updated.reason, notes: updated.notes,
        officerDiscordId,
        officerName: updated.robloxUsername || updated.suspectRobloxDisplayName || null,
        officerRobloxId: updated.robloxUserId || null,
        suspectAvatar,
        timestamp: new Date(), edited: true,
      };
      if (updated.logMessageId) {
        const ok = await editApprovalWebhook(updated.logMessageId, payload);
        if (!ok) { // fall back to a fresh post if the original can't be edited
          const newId = await sendApprovalWebhook(payload);
          if (newId) await prisma.case.update({ where: { id: updated.id }, data: { logMessageId: newId } }).catch(() => {});
        }
      } else {
        const newId = await sendApprovalWebhook(payload);
        if (newId) await prisma.case.update({ where: { id: updated.id }, data: { logMessageId: newId } }).catch(() => {});
      }
    }

    res.json(updated);
  } catch (err) {
    console.error('PATCH /cases/:id edit error:', err);
    res.status(500).json({ error: 'Failed to edit case' });
  }
});

// ── PATCH /api/cases/:id/request-changes ───────────────────────
// Send a pending case back to its submitter with a note (e.g. "change the
// punishment to Strike 1") instead of denying it. Case stays PENDING.
router.patch('/:id/request-changes', requireHICOMM, async (req, res) => {
  const note = (req.body && req.body.note ? String(req.body.note) : '').trim();
  if (!note) return res.status(400).json({ error: 'A note explaining the requested changes is required.' });

  // Only keep parsed actions the client confidently detected AND that are valid.
  // Accepts both the new {action, durationDays} objects and legacy plain strings.
  const rawActions = req.body && Array.isArray(req.body.actions) ? req.body.actions : [];
  const validActions = rawActions
    .map(a => (a && typeof a === 'object')
      ? { action: String(a.action || ''), durationDays: (a.durationDays != null ? parseInt(a.durationDays, 10) || null : null) }
      : { action: String(a), durationDays: null })
    .filter(a => ALL_ACTION_NAMES.includes(a.action));
  // Always record who requested the changes and when, so every viewer sees it.
  const reviewChanges = {
    actions:  validActions,
    by:       req.user.displayName || req.user.discordUsername || null,
    byId:     req.user.discordId || null,
    byUserId: req.user.id,
    at:       new Date().toISOString(),
  };

  try {
    const existing = await prisma.case.findUnique({
      where:   { id: req.params.id },
      include: { user: { select: { id: true, discordUsername: true, displayName: true } } },
    });
    if (!existing) return res.status(404).json({ error: 'Case not found' });
    if (existing.status !== 'PENDING') return res.status(409).json({ error: 'Case is not pending' });

    const updated = await prisma.case.update({
      where: { id: existing.id },
      // Snapshot the case as it stands right now, so the next edit can be
      // diffed against it and the reviewer can see exactly what changed.
      data:  { reviewNote: note, reviewChanges, reviewSnapshot: caseSnapshot(existing) },
    });

    await prisma.caseAction.create({
      data: { caseId: existing.id, actionType: 'CHANGES_REQUESTED', performedBy: req.user.id,
              notes: `Changes requested by ${req.user.displayName || req.user.discordUsername}: ${note}` },
    }).catch(() => {});

    // Notify the submitter (reaches them if they have notifications enabled).
    if (existing.user && existing.userId) {
      sendCustomNotification({
        userIds: [existing.userId],
        title:   `Changes requested · ${existing.caseRef}`,
        body:    note,
        url:     `/ia/dashboard?page=my-cases&case=${existing.id}`,
      }).catch(() => {});
    }

    res.json(updated);
  } catch (err) {
    console.error('PATCH /cases/:id/request-changes error:', err);
    res.status(500).json({ error: 'Failed to request changes' });
  }
});

// ── Appeals ───────────────────────────────────────────────────────
// An appeal is auto-granted: filing it IS the decision. Senior Investigator
// and above may appeal an ordinary case; only High Command may appeal a
// Termination or a Blacklist. Granting an appeal:
//   * moves the case to OVERTURNED (so it stops counting on the officer's
//     record without pretending it was never approved),
//   * removes every punishment role the case applied in Discord,
//   * marks the CasePunishment rows as lifted, and
//   * edits the administrative log so the posted notice reflects the appeal.

// GET /api/cases/:id/appeal — whether the current user may appeal this case.
router.get('/:id/appeal', async (req, res) => {
  try {
    // casePunishments must be loaded here for the same reason the POST loads
    // them: the High-Command-only gate reads the punishments actually applied,
    // not just the (editable) action columns. Without them this endpoint would
    // say "yes" to an appeal the POST then refuses.
    const c = await prisma.case.findUnique({
      where:   { id: req.params.id },
      include: { casePunishments: true, appeals: { orderBy: { createdAt: 'desc' } } },
    });
    if (!c) return res.status(404).json({ error: 'Case not found' });
    const verdict = canAppealCase(req.user, c);
    res.json({
      canAppeal:  verdict.allowed,
      reason:     verdict.reason,
      hicommOnly: caseHasHicommOnlyPunishment(c),
      rankLabel:  iaRankLabel(req.user),
      appeals:    c.appeals || [],
    });
  } catch (err) {
    console.error('GET /cases/:id/appeal error:', err);
    res.status(500).json({ error: 'Failed to check appeal eligibility' });
  }
});

// POST /api/cases/:id/appeal — file (and thereby grant) an appeal.
router.post('/:id/appeal', async (req, res) => {
  const reason = (req.body && req.body.reason ? String(req.body.reason) : '').trim();
  if (!reason)            return res.status(400).json({ error: 'A reason for the appeal is required.' });
  if (reason.length > 2000) return res.status(400).json({ error: 'Appeal reason is too long (max 2000 characters).' });

  try {
    const existing = await prisma.case.findUnique({
      where:   { id: req.params.id },
      include: { casePunishments: true, user: { select: { id: true, discordId: true, displayName: true, discordUsername: true } } },
    });
    if (!existing) return res.status(404).json({ error: 'Case not found' });

    const verdict = canAppealCase(req.user, existing);
    if (!verdict.allowed) return res.status(403).json({ error: verdict.reason });

    // The mechanics live in lib/caseAppeal so the /check-record panel grants an
    // appeal exactly the same way. The gate above (Senior Investigator+, High
    // Command for a Termination/Blacklist) stays here — this route's rule.
    const out = await require('../lib/caseAppeal').appealCase({
      existing,
      actor: { userId: req.user.id, name: req.user.displayName || req.user.discordUsername || 'Internal Affairs', rankLabel: iaRankLabel(req.user) },
      reason,
    });
    if (!out.ok) return res.status(out.status || 500).json({ error: out.error });
    const { updated, appeal, lifted, failed, kept, manual } = out;

    require('../lib/audit').record({
      req, action: 'CASE_APPEAL', category: 'ia', targetType: 'case', targetId: existing.id,
      summary: `Appeal granted on ${existing.caseRef} · ${lifted.length} punishment role(s) lifted`,
      metadata: { reason, lifted, failed, kept, manual },
    });

    res.json({ ...updated, appeal, lifted, failed, kept, manual });
  } catch (err) {
    console.error('POST /cases/:id/appeal error:', err);
    res.status(500).json({ error: 'Failed to file the appeal' });
  }
});

// ── GET /api/cases/audit ──────────────────────────────────────────
// Audit log is HICOMM/Developer only — supervisors don't get it.
router.get('/audit', requireHICOMMStrict, async (req, res) => {
  try {
    const actions = await prisma.caseAction.findMany({
      include: {
        case: { select: { caseRef: true, action: true } },
        user: { select: { discordUsername: true, displayName: true, role: true } },
      },
      orderBy: { timestamp: 'desc' },
      take: 200,
    });
    res.json(actions);
  } catch { res.status(500).json({ error: 'Failed to fetch audit log' }); }
});

// ── GET /api/cases/:id ───────────────────────────────────
// A single case with full detail — used to open a case from a shared link.
// Readable by any authenticated user (same scope as /all). Registered last so
// it doesn't shadow the specific GET routes above.
router.get('/:id', async (req, res) => {
  try {
    const c = await prisma.case.findUnique({
      where: { id: req.params.id },
      include: {
        user: { select: { discordUsername: true, displayName: true, discordAvatar: true, role: true } },
        appeals: { orderBy: { createdAt: 'desc' } },
        caseActions: {
          include: { user: { select: { discordUsername: true, displayName: true } } },
          orderBy:  { timestamp: 'desc' },
        },
      },
    });
    if (!c) return res.status(404).json({ error: 'Case not found' });
    res.json(c);
  } catch (err) {
    console.error('GET /cases/:id error:', err);
    res.status(500).json({ error: 'Failed to fetch case' });
  }
});

module.exports = router;
