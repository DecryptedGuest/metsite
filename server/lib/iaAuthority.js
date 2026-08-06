// server/lib/iaAuthority.js
// Who is this Discord user in Internal Affairs terms, and what may they do?
//
// The /ia dashboard makes the same decisions the website makes, so it has to
// answer the same questions the website answers — and answer them the SAME way.
// Every rule below delegates to the module the website already uses
// (lib/iaRank) rather than restating it, because a second copy of "a Supervisor
// cannot approve a Termination" is a copy that will eventually disagree with the
// first one, and the disagreement will be found by somebody approving a
// Termination they should not have.
//
// The one thing this file DOES own is resolving a Discord user to an IA
// standing without a dashboard session. The website reads req.user; a slash
// command has only a Discord id, so:
//
//   1. their dashboard account, if they have one (role + snapshotted IA rank)
//   2. failing that, a live resolve from their Discord roles and their rank in
//      the IA Roblox group (the same resolver login uses)
//
// Deciding a case ALSO needs a dashboard account, because CaseAction.performedBy
// is a foreign key to User.id — there is nowhere to record "who approved this"
// otherwise. That is surfaced as its own reason rather than a generic refusal,
// because "log into the dashboard once" is a fix and "not authorised" is not.

const prisma = require('./db');
const {
  caseHasHicommOnlyPunishment, canAppealCase, HICOMM_ONLY_ACTIONS,
} = require('./iaRank');

// The site roles, weakest first. Mirrors prisma Role.
const VIEW_ROLES    = ['IA', 'SUPERVISOR', 'HICOMM', 'DEVELOPER'];
const REVIEW_ROLES  = ['SUPERVISOR', 'HICOMM', 'DEVELOPER']; // = requireHICOMM
const HICOMM_ROLES  = ['HICOMM', 'DEVELOPER'];               // = requireHICOMMStrict

// How each role should be described back to the person holding it. The IA group
// rank name is better when we have it (it says "Deputy Director", not "High
// Command"), so this is only the fallback.
const ROLE_LABEL = {
  DEVELOPER:  'Developer',
  HICOMM:     'IA High Command',
  SUPERVISOR: 'Supervisor',
  IA:         'Internal Affairs',
};

/**
 * Resolve the Discord user behind an interaction to an IA standing.
 *
 * @returns {Promise<{
 *   ok: boolean, why: string|null,
 *   role: string|null, rank: number|null, rankName: string|null, label: string,
 *   discordId: string, userId: string|null, user: object|null, linked: boolean,
 * }>}
 *   `user` is the shape lib/iaRank expects (role + iaRank + iaRankName + the
 *   identity fields caseIsAbout matches on). `linked` is whether a dashboard
 *   account exists, which is what decides if they can DECIDE as opposed to read.
 */
async function resolveAuthority(interaction) {
  const discordId = String(interaction.user.id);
  const memberRoles = interaction.member && interaction.member.roles && interaction.member.roles.cache
    ? [...interaction.member.roles.cache.keys()].map(String)
    : [];

  let row = null;
  try {
    row = await prisma.user.findUnique({
      where:  { discordId },
      select: {
        id: true, role: true, iaRank: true, iaRankName: true, divisions: true,
        discordId: true, robloxId: true, robloxUsername: true,
        displayName: true, discordUsername: true, isBlacklisted: true,
      },
    });
  } catch (e) { row = null; }

  if (row && row.isBlacklisted) {
    return blank(discordId, 'Your MET Dashboard account is blacklisted.');
  }

  let role     = row && row.role && row.role !== 'NONE' ? row.role : null;
  let rank     = row && row.iaRank != null ? Number(row.iaRank) : null;
  let rankName = (row && row.iaRankName) || null;

  // No usable role on the account (or no account at all): ask the resolver that
  // login uses. It reads the developer override, an explicit grant, the live IA
  // group rank, then Discord roles.
  if (!role || rank == null) {
    try {
      const { resolveSiteRoleDetailed } = require('./roleResolver');
      const live = await resolveSiteRoleDetailed({ discordId, memberRoles });
      if (!role && live && live.role) role = live.role;
      if (rank == null && live && live.iaRank != null) rank = Number(live.iaRank);
      if (!rankName && live && live.iaRankName) rankName = live.iaRankName;
    } catch (e) { /* keep whatever the account gave us */ }
  }

  if (!role || !VIEW_ROLES.includes(role)) {
    return blank(discordId, 'This is for Internal Affairs. If you have just joined IA, log into the MET Dashboard once so your rank is picked up.');
  }

  const user = {
    id: row ? row.id : null,
    role,
    iaRank: rank,
    iaRankName: rankName,
    divisions: row ? row.divisions : null,
    discordId,
    robloxId: row ? row.robloxId : null,
    robloxUsername: row ? row.robloxUsername : null,
  };

  return {
    ok: true, why: null,
    role, rank, rankName,
    label: rankName || ROLE_LABEL[role] || 'Internal Affairs',
    discordId,
    userId: row ? row.id : null,
    name: (row && (row.displayName || row.discordUsername)) || null,
    linked: !!(row && row.id),
    user,
  };
}

function blank(discordId, why) {
  return { ok: false, why, role: null, rank: null, rankName: null, label: '',
           discordId, userId: null, name: null, linked: false, user: null };
}

// ── Capability tests ──────────────────────────────────────────────
// Each returns { allowed, reason } so a refusal can be SHOWN rather than the
// button simply doing nothing.

function isReviewer(auth) { return !!auth && REVIEW_ROLES.includes(auth.role); }
function isHicomm(auth)   { return !!auth && HICOMM_ROLES.includes(auth.role); }

/** Reading cases and tickets: any IA member. */
function canView(auth) {
  if (!auth || !auth.ok) return { allowed: false, reason: (auth && auth.why) || 'Not authorised.' };
  return { allowed: true, reason: null };
}

/**
 * Approve or deny a case.
 *
 * The website's rule, exactly: reviewing is Supervisor and above, and a
 * Supervisor may not decide a case carrying a Termination or a Blacklist —
 * those are Deputy Director and above. The punishment test reads the enriched
 * actions, the legacy comma-joined string AND the applied CasePunishment rows,
 * so a Termination edited off a case cannot launder it past the gate.
 */
function canDecideCase(auth, kase) {
  const base = canView(auth);
  if (!base.allowed) return base;
  if (!kase) return { allowed: false, reason: 'That case is no longer there.' };
  if (kase.status !== 'PENDING') {
    return { allowed: false, reason: `That case is already ${String(kase.status || '').toLowerCase()}.` };
  }
  if (!isReviewer(auth)) {
    return { allowed: false, reason: 'Approving and denying is for Supervisor and above.' };
  }
  if (auth.role === 'SUPERVISOR' && caseHasHicommOnlyPunishment(kase)) {
    return { allowed: false, reason: 'This case carries a Termination or Blacklist · only Deputy Director and above can decide it.' };
  }
  if (!auth.linked) {
    return { allowed: false, reason: 'Log into the MET Dashboard once first · a decision is recorded against your account, and you do not have one yet.' };
  }
  return { allowed: true, reason: null };
}

/**
 * Request changes on a case. Supervisor and above, with NO Termination or
 * Blacklist gate — the website lets a Supervisor bounce one of those back for
 * more work, it just does not let them decide it.
 */
function canRequestChanges(auth, kase) {
  const base = canView(auth);
  if (!base.allowed) return base;
  if (!kase) return { allowed: false, reason: 'That case is no longer there.' };
  if (kase.status !== 'PENDING') {
    return { allowed: false, reason: `That case is already ${String(kase.status || '').toLowerCase()}.` };
  }
  if (!isReviewer(auth)) {
    return { allowed: false, reason: 'Requesting changes is for Supervisor and above.' };
  }
  if (!auth.linked) {
    return { allowed: false, reason: 'Log into the MET Dashboard once first · the request is recorded against your account.' };
  }
  return { allowed: true, reason: null };
}

/** Approve or deny a closed-ticket log. Supervisor and above, no punishment gate. */
function canReviewTicket(auth, ticket) {
  const base = canView(auth);
  if (!base.allowed) return base;
  if (!ticket) return { allowed: false, reason: 'That ticket is no longer there.' };
  if (ticket.status && ticket.status !== 'PENDING') {
    return { allowed: false, reason: `That ticket is already ${String(ticket.status).toLowerCase()}.` };
  }
  if (!isReviewer(auth)) {
    return { allowed: false, reason: 'Reviewing tickets is for Supervisor and above.' };
  }
  if (!auth.linked) {
    return { allowed: false, reason: 'Log into the MET Dashboard once first · the review is recorded against your account.' };
  }
  return { allowed: true, reason: null };
}

/**
 * File an appeal. Straight through to the website's own rule: an approved case
 * only, never one about yourself, Senior Investigator and above, and High
 * Command for a Termination or Blacklist.
 */
function canAppeal(auth, kase) {
  const base = canView(auth);
  if (!base.allowed) return base;
  const verdict = canAppealCase(auth.user, kase);
  if (!verdict.allowed) return verdict;
  if (!auth.linked) {
    return { allowed: false, reason: 'Log into the MET Dashboard once first · an appeal is recorded against your account.' };
  }
  return { allowed: true, reason: null };
}

/**
 * A plain-English summary of what this person may do, for the dashboard home.
 * Shown so nobody has to discover their own permissions by being refused.
 */
function capabilitySummary(auth) {
  if (!auth || !auth.ok) return [];
  const yes = [], no = [];
  yes.push('View cases, tickets and records');
  if (isReviewer(auth)) {
    yes.push('Approve and deny cases and tickets');
    yes.push('Request changes on a case');
    if (isHicomm(auth)) yes.push(`Decide cases carrying a ${HICOMM_ONLY_ACTIONS.join(' or ')}`);
    else no.push(`Decide cases carrying a ${HICOMM_ONLY_ACTIONS.join(' or ')} (Deputy Director and above)`);
  } else {
    no.push('Approve, deny or request changes (Supervisor and above)');
  }
  if (!auth.linked) no.push('Any decision · log into the MET Dashboard once to link your account');
  return { yes, no };
}

module.exports = {
  resolveAuthority, capabilitySummary,
  isReviewer, isHicomm,
  canView, canDecideCase, canRequestChanges, canReviewTicket, canAppeal,
  VIEW_ROLES, REVIEW_ROLES, HICOMM_ROLES, ROLE_LABEL,
};
