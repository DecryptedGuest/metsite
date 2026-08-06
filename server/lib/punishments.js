// server/lib/punishments.js
// Build a member's disciplinary history from the Internal Affairs case data
// (the `cases` + `case_punishments` tables). A "punishment" against a member is
// an APPROVED case filed with them as the suspect — matched by their Roblox id,
// Roblox username, or the suspect Discord id stored on the case
// (`officerDiscordId`). Returns rows shaped like the bot-written MetPunishment
// rows so the profile can merge and render both in one table.
const prisma = require('./db');

// Action/type strings that aren't real punishments — legacy import placeholders.
const PLACEHOLDER = /^(legacy case|imported|punishments?:|n\/a|none)/i;

function cleanType(caseRow) {
  // Prefer the structured multi-action list, else the single action, else a
  // cleaned summary. Never surface an import placeholder as the type.
  const actions = Array.isArray(caseRow.actions) ? caseRow.actions.map(a => a && a.action).filter(Boolean) : [];
  const real = actions.filter(a => !PLACEHOLDER.test(a));
  if (real.length) return real.join(', ');
  if (caseRow.action && !PLACEHOLDER.test(caseRow.action)) return caseRow.action;
  if (caseRow.punishmentsSummary && !PLACEHOLDER.test(caseRow.punishmentsSummary)) {
    return caseRow.punishmentsSummary.replace(/^punishments?:\s*/i, '').slice(0, 60);
  }
  return caseRow.action || 'Case';
}

// A member's case-derived punishment rows, newest first. Best-effort: returns
// [] on any DB error so the profile never fails to load over it.
//   → [{ id, type, reason, issuedBy, caseRef, active, issuedAt, expiresAt, source }]
async function getCasePunishments({ discordId, robloxId, robloxUsername } = {}) {
  const or = [];
  if (discordId)      or.push({ officerDiscordId: String(discordId) });
  if (robloxId)       or.push({ robloxUserId: String(robloxId) });
  if (robloxUsername) or.push({ robloxUsername: { equals: String(robloxUsername), mode: 'insensitive' } });
  if (!or.length) return [];

  let cases = [];
  try {
    // OVERTURNED as well as APPROVED: an appealed punishment stays on the
    // record marked as appealed rather than vanishing, so the history is
    // honest about what happened and what was put right.
    cases = await prisma.case.findMany({
      where:   { OR: or, status: { in: ['APPROVED', 'OVERTURNED'] } },
      include: { casePunishments: true },
      orderBy: { createdAt: 'desc' },
      take:    200,
    });
  } catch (e) { return []; }

  return cases.map(c => {
    const puns    = Array.isArray(c.casePunishments) ? c.casePunishments : [];
    // A case is "active" while any of its punishments is still in force
    // (role not yet removed and not past its expiry). Cases with no timed
    // punishment (e.g. a warning) are treated as historical, not active.
    const active  = puns.some(p => !p.roleRemoved && (!p.expiresAt || new Date(p.expiresAt) > new Date()));
    // Show the latest expiry among the case's punishments (null = permanent/none).
    const expiry  = puns.reduce((acc, p) => {
      if (!p.expiresAt) return acc;
      const d = new Date(p.expiresAt);
      return (!acc || d > acc) ? d : acc;
    }, null);
    const appealed = c.status === 'OVERTURNED' || !!c.appealedAt;
    return {
      id:        c.id,
      type:      cleanType(c),
      reason:    c.reason || null,
      notes:     (c.notes && c.notes !== 'N/A') ? c.notes : null,
      caseRef:   c.caseRef || null,
      // Each punishment separately, so the detail view can show a multi-action
      // case as the several things it actually was.
      actions:   puns.length
        ? puns.map(p => ({ action: p.action, durationDays: p.durationDays, expiresAt: p.expiresAt, lifted: p.roleRemoved }))
        : (Array.isArray(c.actions) ? c.actions.map(a => ({ action: a && a.action, durationDays: a && a.durationDays })) : null),
      // NOT included, deliberately: who filed it, who approved it, who granted
      // the appeal, the review notes. This payload goes to the subject of the
      // punishment, and none of that is theirs to see.
      appealed,
      appealedAt: c.appealedAt || null,
      direct:    c.origin === 'DISCIPLINE',
      caseLink:  c.caseLink || null,
      active:    active && !appealed,
      issuedAt:  c.createdAt,
      expiresAt: expiry,
      source:    'case',
    };
  });
}

module.exports = { getCasePunishments };
