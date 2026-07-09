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
const { ACTION_CONFIG, ACTION_NAMES }       = require('../lib/actions');
const { parseDocText, fetchGoogleDocText, fetchGoogleDocHtml,
        parseCheckedPunishments, buildPunishmentsFromChecklist, cleanDecision } = require('../lib/forumImport');

const router = express.Router();

// Punishments that only HICOMM (or Developer) may approve/deny — Supervisors
// can action ordinary cases but not these.
const HICOMM_ONLY_ACTIONS = ['Blacklist', 'Termination'];
function caseHasHicommOnlyPunishment(c) {
  const names = [];
  if (Array.isArray(c.actions)) c.actions.forEach(a => { if (a && a.action) names.push(a.action); });
  if (c.action) String(c.action).split(',').forEach(s => names.push(s.trim()));
  return names.some(n => HICOMM_ONLY_ACTIONS.includes(n));
}

// Resolve Roblox headshot URLs for the admin-log embed:
//   approverAvatar → the "Signed, …" author icon (the approving staff member)
//   suspectAvatar  → the embed thumbnail (the officer the case is about)
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

async function resolveCaseAvatars(approverUser, caseRow) {
  let approverAvatar = null, suspectAvatar = null;
  try {
    const { getRobloxIdFromDiscord, getRobloxIdFromUsername, getRobloxAvatarHeadshot } = require('../lib/roblox');

    // Approver → Roblox profile picture for the "Signed, …" author icon.
    let arid = approverUser && approverUser.robloxId;
    if (!arid && approverUser && approverUser.discordId) {
      try { arid = await getRobloxIdFromDiscord(approverUser.discordId); } catch (e) {}
    }
    if (arid) approverAvatar = await robloxHeadshotUrl(arid, getRobloxAvatarHeadshot);

    // Suspect → Roblox profile picture for the embed thumbnail.
    let srid = caseRow && caseRow.robloxUserId;
    if (!srid && caseRow && caseRow.robloxUsername) {
      try { const u = await getRobloxIdFromUsername(caseRow.robloxUsername); srid = u && u.id; } catch (e) {}
    }
    if (srid) suspectAvatar = await robloxHeadshotUrl(srid, getRobloxAvatarHeadshot);
  } catch (e) { /* best-effort — embed still posts without avatars */ }
  return { approverAvatar, suspectAvatar };
}

// Resolve the officer's Discord ID for a case that was filed by Roblox
// username/ID only (no linked Discord). DB-first (zero RoVer cost) — a logged-in
// officer's Discord↔Roblox link is already stored on their User row — then falls
// back to RoVer's roblox-to-discord endpoint. Returns the id or null.
async function resolveOfficerDiscordId(caseRow) {
  if (!caseRow) return null;
  if (caseRow.officerDiscordId) return caseRow.officerDiscordId;

  // Need a Roblox id to reverse-resolve; derive from username if only that's known.
  let rid = caseRow.robloxUserId;
  if (!rid && caseRow.robloxUsername) {
    try { const u = await getRobloxIdFromUsername(caseRow.robloxUsername); rid = u && u.id; } catch (e) {}
  }
  if (!rid) return null;

  // 1) DB-first: any user we've already linked to this Roblox id.
  try {
    const u = await prisma.user.findFirst({
      where: { robloxId: String(rid) }, select: { discordId: true },
    });
    if (u && u.discordId) return u.discordId;
  } catch (e) { /* fall through to RoVer */ }

  // 2) RoVer reverse lookup (cached; skipped while on cooldown inside the lib).
  try {
    const matches = await getDiscordFromRoblox(rid);
    if (Array.isArray(matches) && matches.length && matches[0].discordId) {
      return matches[0].discordId;
    }
  } catch (e) { /* best-effort */ }

  return null;
}

// The highest existing case number across the WHOLE shared database — native
// and IA-synced/imported cases alike (all use "#N" refs). So new refs continue
// in step with the IA database instead of a separate, out-of-sync counter.
async function highestCaseNumber() {
  let max = 0;
  try {
    const rows = await prisma.case.findMany({ select: { caseRef: true } });
    for (const c of rows) {
      const m = String(c.caseRef || '').match(/^#?(\d+)$/);
      if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; }
    }
  } catch (e) { /* fall back to the counter below */ }
  try { const ctr = await prisma.caseCounter.findUnique({ where: { id: 1 } }); if (ctr && ctr.count > max) max = ctr.count; } catch (e) {}
  return max;
}

async function generateCaseRef() {
  let n = (await highestCaseNumber()) + 1;
  // Ensure the ref is free (caseRef is @unique) and keep the counter in step.
  for (let i = 0; i < 100; i++) {
    const ref = `#${n}`;
    const exists = await prisma.case.findUnique({ where: { caseRef: ref } }).catch(() => null);
    if (!exists) {
      await prisma.caseCounter.upsert({ where: { id: 1 }, update: { count: n }, create: { id: 1, count: n } }).catch(() => {});
      return ref;
    }
    n++;
  }
  return `#${n}`;
}

// ── GET /api/cases/actions ────────────────────────────────────────
router.get('/actions', (req, res) => res.json(ACTION_NAMES));

// ── POST /api/cases/ai-document ───────────────────────────────────
// Generate a completed disciplinary Google Doc from investigator input and
// return its URL (shared: anyone-with-link view + the email as editor).
router.post('/ai-document', async (req, res) => {
  const b = req.body || {};
  if (!b.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(b.email).trim()))
    return res.status(400).json({ error: 'A valid email address is required.' });
  if (!b.suspect || !b.suspect.user) return res.status(400).json({ error: 'Suspect details are required.' });
  if (!b.punishment) return res.status(400).json({ error: 'A punishment is required.' });
  if (!Array.isArray(b.penalCodes) || !b.penalCodes.length) return res.status(400).json({ error: 'At least one penal code is required.' });
  try {
    const { buildCaseDocument } = require('../lib/caseDoc');
    const result = await buildCaseDocument({
      email:      String(b.email).trim(),
      suspect:    { user: b.suspect.user, rank: b.suspect.rank, userId: b.suspect.userId },
      punishment: b.punishment,
      penalCodes: b.penalCodes,
      evidence:   Array.isArray(b.evidence) ? b.evidence : [],
      summary:    b.summary || null,
      uploaderId: req.user.id,
      investigator: {
        name: req.user.robloxUsername || req.user.displayName || req.user.discordUsername,
        rank: b.investigatorRank || req.user.role || '',
        id:   req.user.discordId || '',
      },
    });
    res.json(result);
  } catch (err) {
    console.error('[cases] ai-document error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to generate the case document.' });
  }
});

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

// ── POST /api/cases/parse-doc ─────────────────────────────────────
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
      return res.status(400).json({ error: 'Could not read that doc — make sure it is shared as "Anyone with the link can view".' });
    }

    const doc   = parseDocText(text) || {};
    const built = buildPunishmentsFromChecklist(parseCheckedPunishments(html), doc.finalDecision);
    const punishments = built.length ? built : (doc.punishments || []);
    const finalDecisionClean = cleanDecision(doc.finalDecision);

    // ── Suspect ──────────────────────────────────────────────────────
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

    // ── Investigator ─────────────────────────────────────────────────
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

    return res.json({
      docId,
      caseLink:          url.split('?')[0],
      suspect,
      investigator,
      punishments,
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

// ── GET /api/cases/records-lookup ─────────────────────────────────
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
    // ── Step 1: resolve the primary identifier ──────────────────────
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

    // ── Step 4: Discord presence + roles ───────────────────────────
    if (discordId && discord.inDiscord === null) {
      discord = await getMemberRecord(discordId);
    }

    // ── Step 5: active punishment roles held in Discord ────────────
    const heldRoleSet = new Set(discord.roleIds || []);
    const punishmentRoles = Object.entries(ACTION_CONFIG)
      .filter(([, cfg]) => cfg.roleId && heldRoleSet.has(cfg.roleId))
      .map(([name, cfg]) => ({ action: name, roleId: cfg.roleId }));

    // ── Step 6: cases filed against this target ────────────────────
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
      action:    c.action,
      actions:   Array.isArray(c.actions) ? c.actions : null,
      reason:    c.reason,
      notes:     c.notes,
      status:    c.status,
      createdAt: c.createdAt,
      investigator: c.user ? (c.user.displayName || c.user.discordUsername) : null,
      punishments: (c.casePunishments || []).map(p => ({
        action: p.action, durationDays: p.durationDays, expiresAt: p.expiresAt,
        roleRemoved: p.roleRemoved, active: !p.roleRemoved && (!p.expiresAt || new Date(p.expiresAt) > new Date()),
      })),
    });

    // APPROVED cases count toward the record; PENDING/DENIED are logged only.
    const approvedCases = cases.filter(c => c.status === 'APPROVED').map(serialize);
    const otherCases    = cases.filter(c => c.status !== 'APPROVED').map(serialize);

    // Punishment record = distinct approved actions (excludes pending/denied).
    // Only real punishment names — never import placeholders like
    // "Legacy Case (imported)" or "Punishments: …".
    const recordSet = new Set();
    for (const c of approvedCases) {
      if (Array.isArray(c.actions) && c.actions.length) {
        c.actions.forEach(a => { if (a && ACTION_NAMES.includes(a.action)) recordSet.add(a.action); });
      } else if (c.action && ACTION_NAMES.includes(c.action)) {
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
      otherCases,
      counts: {
        total:    cases.length,
        approved: approvedCases.length,
        pending:  otherCases.filter(c => c.status === 'PENDING').length,
        denied:   otherCases.filter(c => c.status === 'DENIED').length,
      },
      notes,
    });
  } catch (err) {
    console.error('records-lookup error:', err);
    return res.status(500).json({ error: 'Lookup failed: ' + err.message });
  }
});

// ── GET /api/cases/lookup-member/:discordId ───────────────────────
router.get('/lookup-member/:discordId', async (req, res) => {
  const { discordId } = req.params;
  if (!/^\d{17,20}$/.test(discordId)) return res.status(400).json({ error: 'Invalid Discord ID format' });
  const { getMemberDisplayName } = require('../lib/bot');
  const member = await getMemberDisplayName(discordId);
  res.json({ displayName: member || null });
});

// ── GET /api/cases/officer-profile/:id ────────────────────────────
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

// ── GET /api/cases/stats ──────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const isElevated = ['HICOMM','SUPERVISOR','DEVELOPER'].includes(req.user.role);
    // scope=mine → always the current user's own cases, regardless of role
    const where      = (req.query.scope === 'mine' || !isElevated) ? { userId: req.user.id } : {};
    const [total, pending, approved, denied] = await Promise.all([
      prisma.case.count({ where }),
      prisma.case.count({ where: { ...where, status: 'PENDING'  } }),
      prisma.case.count({ where: { ...where, status: 'APPROVED' } }),
      prisma.case.count({ where: { ...where, status: 'DENIED'   } }),
    ]);
    res.json({ total, pending, approved, denied });
  } catch { res.status(500).json({ error: 'Failed to fetch stats' }); }
});

// ── GET /api/cases/my ─────────────────────────────────────────────
router.get('/my', async (req, res) => {
  try {
    // "My Cases" is always only the cases the current user submitted, regardless
    // of role. Everything lives in "All Cases".
    const where = { userId: req.user.id };
    const cases = await prisma.case.findMany({
      where,
      include: {
        user: { select: { discordUsername: true, displayName: true, discordAvatar: true, role: true } },
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

// ── GET /api/cases/all ────────────────────────────────────────────
// Readable by any authenticated user (IA + HICOMM). HICOMM-only actions
// (approve/deny/delete) remain gated on their own endpoints.
router.get('/all', async (req, res) => {
  try {
    const { status } = req.query;
    const cases = await prisma.case.findMany({
      where: status ? { status } : {},
      include: {
        user: { select: { discordUsername: true, displayName: true, discordAvatar: true, discordId: true } },
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

// ── POST /api/cases ───────────────────────────────────────────────
// Body: { actions: [{ action, durationDays }], reason, notes, officerInput }
// officerInput can be a Discord ID (17-20 digits) or Roblox ID (≤16 digits)
router.post('/', async (req, res) => {
  const { actions: rawActions, reason, notes, officerInput, caseLink } = req.body;

  if (!Array.isArray(rawActions) || !rawActions.length) {
    return res.status(400).json({ error: 'At least one action is required.' });
  }
  if (!reason?.trim()) {
    return res.status(400).json({ error: 'Reason is required.' });
  }
  if (!officerInput?.trim()) {
    return res.status(400).json({ error: 'Officer Discord or Roblox ID is required.' });
  }
  if (!caseLink?.trim()) {
    return res.status(400).json({ error: 'Case link is required.' });
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
    const caseRef = await generateCaseRef();
    const newCase = await prisma.case.create({
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
        suspectRobloxDisplayName:    req.body.suspectRobloxDisplayName    || null,
        investigatorRobloxId:        req.body.investigatorRobloxId        || null,
        investigatorRobloxUsername:  req.body.investigatorRobloxUsername  || null,
        investigatorDiscordUsername: req.body.investigatorDiscordUsername || null,
        punishmentsSummary:          req.body.punishmentsSummary          || null,
        status:           'PENDING',
      },
      include: { user: { select: { discordUsername: true, displayName: true } } },
    });

    await prisma.caseAction.create({
      data: { caseId: newCase.id, actionType: 'CREATED', performedBy: req.user.id, notes: 'Case submitted' },
    });

    // Fire-and-forget — don't delay the response
    notifyStaff({
      category: 'case',
      title: `New Case — ${caseRef}`,
      body:  `${robloxUsername || 'Unknown'} · ${actionDisplay}`,
      url:   `/dashboard?page=review&case=${newCase.id}`,
    });

    res.status(201).json(newCase);
  } catch (err) {
    console.error('POST /cases error:', err);
    res.status(500).json({ error: 'Failed to create case' });
  }
});

// ── PATCH /api/cases/:id/approve ──────────────────────────────────
router.patch('/:id/approve', requireHICOMM, async (req, res) => {
  try {
    const existing = await prisma.case.findUnique({
      where:   { id: req.params.id },
      include: { user: { select: { discordUsername: true, displayName: true, discordId: true, robloxId: true, robloxUsername: true } } },
    });

    if (!existing)                     return res.status(404).json({ error: 'Case not found' });
    if (existing.status !== 'PENDING') return res.status(409).json({ error: 'Case is not pending' });
    if (req.user.role === 'SUPERVISOR' && caseHasHicommOnlyPunishment(existing))
      return res.status(403).json({ error: 'Only HICOMM can approve a case involving a Blacklist or Termination.' });
    // Separation of duties: you can't review (and self-award quota for) your own case.
    if (existing.userId === req.user.id && req.user.role !== 'DEVELOPER')
      return res.status(403).json({ error: 'You cannot review your own case; another reviewer must approve it.' });

    // Atomically claim the PENDING→APPROVED transition so two concurrent
    // approvals can't both run the side effects (double demotion / dupe rows).
    const claim = await prisma.case.updateMany({ where: { id: req.params.id, status: 'PENDING' }, data: { status: 'APPROVED' } });
    if (claim.count === 0) return res.status(409).json({ error: 'Case is not pending' });
    const updated = await prisma.case.findUnique({ where: { id: req.params.id } });

    await prisma.caseAction.create({
      data: { caseId: existing.id, actionType: 'APPROVED', performedBy: req.user.id, notes: 'Approved by HICOMM/Developer' },
    });

    // Suspect's Roblox headshot → embed thumbnail. (The "Signed, …" author is a
    // fixed Internal Affairs High Command signature set in buildCaseEmbed.)
    const { suspectAvatar } = await resolveCaseAvatars(null, existing);

    // If the case was filed by Roblox only, convert to the officer's Discord ID
    // so the log can mention them and roles/expiry can be applied. Persist it.
    const officerDiscordId = existing.officerDiscordId || await resolveOfficerDiscordId(existing);
    if (officerDiscordId && officerDiscordId !== existing.officerDiscordId) {
      existing.officerDiscordId = officerDiscordId;
      await prisma.case.update({ where: { id: existing.id }, data: { officerDiscordId } }).catch(() => {});
    }

    // Determine action list — use enriched JSON if present, else legacy single action
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

    // Assign Discord roles + create expiry records (requires Discord ID).
    // Resolve the role from the current (env-driven) config so every configured
    // punishment gets its role — even cases created before a role was added —
    // falling back to any roleId snapshotted on the case action.
    if (existing.officerDiscordId) {
      for (const a of actions) {
        const roleId = ACTION_CONFIG[a.action]?.roleId || a.roleId || null;
        if (!roleId) continue;
        await assignRole(existing.officerDiscordId, roleId);
        const expiresAt = a.durationDays
          ? new Date(Date.now() + a.durationDays * 86400000)
          : null;
        await prisma.casePunishment.create({
          data: {
            caseId:       existing.id,
            action:       a.action,
            roleId,
            durationDays: a.durationDays || null,
            expiresAt,
          },
        });
      }
    }

    // Exile from Roblox group for exile-flagged actions (requires Roblox ID, independent of Discord ID)
    if (existing.robloxUserId) {
      let exiledOnce = false;
      for (const a of actions) {
        if (!ACTION_CONFIG[a.action]?.exile) continue;
        if (exiledOnce) continue; // only need to remove from group once per case
        const exiled = await exileFromGroup(existing.robloxUserId);
        exiledOnce   = exiled;
        await prisma.caseAction.create({
          data: {
            caseId:      existing.id,
            actionType:  'APPROVED',
            performedBy: req.user.id,
            notes: exiled
              ? `Roblox group exile executed for "${a.action}" (user ${existing.robloxUserId})`
              : `Roblox group exile failed for "${a.action}" (user ${existing.robloxUserId})`,
          },
        });
      }
    }

    // Demotion → drop the suspect one rank in the Roblox group (requires Roblox ID)
    if (existing.robloxUserId && actions.some(a => a.action === 'Demotion')) {
      const { demoteByOneRank } = require('../lib/roblox');
      const result = await demoteByOneRank(existing.robloxUserId);
      await prisma.caseAction.create({
        data: {
          caseId:      existing.id,
          actionType:  'APPROVED',
          performedBy: req.user.id,
          notes: result.ok
            ? `Group demotion: ${result.from} → ${result.to} (user ${existing.robloxUserId})`
            : `Group demotion failed: ${result.reason} (user ${existing.robloxUserId})`,
        },
      }).catch(() => {});
    }

    // +4 quota points for the IA member who submitted the case — queued durably
    // so a transient failure (or a rapid approve burst) never drops the points.
    // Never award for imported/legacy cases (owned by the import system user).
    // Never award quota for imported/synced records (legacy import or IA sync),
    // nor for an IA-origin synced case regardless of how its owner resolved.
    const IMPORT_OWNERS = new Set(['SYSTEM_LEGACY_IMPORT', 'ia-archive-import']);
    if (existing.origin !== 'IA' && existing.user && !IMPORT_OWNERS.has(existing.user.discordId)) {
      const { enqueueQuotaAward } = require('../lib/quota');
      enqueueQuotaAward({
        refType: 'case', refId: existing.id,
        discordId: existing.user.discordId, robloxUsername: existing.user.robloxUsername,
        points: 4, label: `case ${existing.caseRef}`,
      }).catch(() => {});
    }

    res.json(updated);
  } catch (err) {
    console.error('PATCH /approve error:', err);
    res.status(500).json({ error: 'Failed to approve case' });
  }
});

// ── PATCH /api/cases/:id/deny ─────────────────────────────────────
router.patch('/:id/deny', requireHICOMM, async (req, res) => {
  try {
    const existing = await prisma.case.findUnique({ where: { id: req.params.id } });
    if (!existing)                     return res.status(404).json({ error: 'Case not found' });
    if (existing.status !== 'PENDING') return res.status(409).json({ error: 'Case is not pending' });
    if (req.user.role === 'SUPERVISOR' && caseHasHicommOnlyPunishment(existing))
      return res.status(403).json({ error: 'Only HICOMM can deny a case involving a Blacklist or Termination.' });
    if (existing.userId === req.user.id && req.user.role !== 'DEVELOPER')
      return res.status(403).json({ error: 'You cannot review your own case; another reviewer must deny it.' });

    const claim = await prisma.case.updateMany({ where: { id: req.params.id, status: 'PENDING' }, data: { status: 'DENIED' } });
    if (claim.count === 0) return res.status(409).json({ error: 'Case is not pending' });
    const updated = await prisma.case.findUnique({ where: { id: req.params.id } });
    await prisma.caseAction.create({
      data: { caseId: existing.id, actionType: 'DENIED', performedBy: req.user.id, notes: 'Denied by HICOMM/Developer' },
    });
    res.json(updated);
  } catch (err) {
    console.error('PATCH /deny error:', err);
    res.status(500).json({ error: 'Failed to deny case' });
  }
});

// ── PATCH /api/cases/:id — edit a case (HICOMM / Developer) ────────
// Body: { actions, reason, notes, caseLink, repost }
// Updates the case; if `repost` and the case is APPROVED, re-posts the
// Administrative Log to the webhook with the new details.
router.patch('/:id', async (req, res) => {
  const { actions: rawActions, reason, notes, caseLink, repost } = req.body;
  try {
    const existing = await prisma.case.findUnique({
      where:   { id: req.params.id },
      include: { user: { select: { discordUsername: true, displayName: true, discordId: true, robloxId: true, robloxUsername: true } } },
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

    const data = {};
    // Editing always clears any outstanding "changes requested" note + parsed changes.
    if (existing.reviewNote)    data.reviewNote    = null;
    if (existing.reviewChanges) data.reviewChanges = null;
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

    const updated = await prisma.case.update({ where: { id: req.params.id }, data });

    await prisma.caseAction.create({
      data: { caseId: existing.id, actionType: 'CREATED', performedBy: req.user.id,
              notes: `Case edited by ${req.user.displayName || req.user.discordUsername}` },
    }).catch(() => {});

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

// ── PATCH /api/cases/:id/request-changes ──────────────────────────
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
    .filter(a => ACTION_NAMES.includes(a.action));
  // Always record who requested the changes and when, so every viewer sees it.
  const reviewChanges = {
    actions: validActions,
    by:      req.user.displayName || req.user.discordUsername || null,
    byId:    req.user.discordId || null,
    at:      new Date().toISOString(),
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
      data:  { reviewNote: note, reviewChanges },
    });

    await prisma.caseAction.create({
      data: { caseId: existing.id, actionType: 'CREATED', performedBy: req.user.id,
              notes: `Changes requested by ${req.user.displayName || req.user.discordUsername}: ${note}` },
    }).catch(() => {});

    // Notify the submitter (reaches them if they have notifications enabled).
    if (existing.user && existing.userId) {
      sendCustomNotification({
        userIds: [existing.userId],
        title:   `Changes requested — ${existing.caseRef}`,
        body:    note,
        url:     `/dashboard?page=my-cases&case=${existing.id}`,
      }).catch(() => {});
    }

    res.json(updated);
  } catch (err) {
    console.error('PATCH /cases/:id/request-changes error:', err);
    res.status(500).json({ error: 'Failed to request changes' });
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

// ── GET /api/cases/:id ────────────────────────────────────────────
// A single case with full detail — used to open a case from a shared link.
// Readable by any authenticated user (same scope as /all). Registered last so
// it doesn't shadow the specific GET routes above.
router.get('/:id', async (req, res) => {
  try {
    const c = await prisma.case.findUnique({
      where: { id: req.params.id },
      include: {
        user: { select: { discordUsername: true, displayName: true, discordAvatar: true, role: true } },
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
