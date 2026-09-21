// server/lib/iaSync.js
// One-way sync from the still-running IA site's database (IA_DATABASE_URL) into
// the MET database: pulls cases + tickets (pending AND resolved) so they appear
// in the MET dashboard. Idempotent — upserts by caseRef / ticketRef, so it can
// run repeatedly (manual trigger or interval) and pick up new/updated rows.
//
// Identity: IA cases/tickets reference IA's own users table, but the MET DB has
// its own users, so we resolve each row's owner by discordId and upsert a MET
// user shell (a later Discord login just enriches the same row). Rows with no
// resolvable discordId attach to a single "IA Archive" placeholder user so the
// required userId FK is always satisfied and no record is dropped.
//
// NOTE: this is ONE-WAY (IA → MET) for visibility. Actioning a synced ticket on
// the MET side does not write back to the live IA site.
const prisma = require('./db');
const { getIaClient } = require('./dbIa');

const CASE_STATUS   = new Set(['PENDING', 'APPROVED', 'DENIED']);
const norm = (v, set, dflt) => (v && set.has(String(v).toUpperCase()) ? String(v).toUpperCase() : dflt);

// Resolve (and cache) a MET user id for an IA row's owner. Upserts a shell user
// keyed by discordId; falls back to a shared placeholder when none is known.
async function makeResolver() {
  const cache = new Map();
  let placeholderId = null;
  async function placeholder() {
    if (placeholderId) return placeholderId;
    const u = await prisma.user.upsert({
      where: { discordId: 'ia-archive-import' },
      update: {},
      create: { discordId: 'ia-archive-import', discordUsername: 'IA Archive', displayName: 'IA Archive (imported)', role: 'IA' },
    });
    placeholderId = u.id;
    return placeholderId;
  }
  return async function resolve(discordId, username) {
    const did = discordId ? String(discordId) : null;
    if (!did) return placeholder();
    if (cache.has(did)) return cache.get(did);
    const u = await prisma.user.upsert({
      where: { discordId: did },
      update: {}, // never clobber a real login's data
      create: { discordId: did, discordUsername: username || `ia_${did}`, role: 'IA' },
    });
    cache.set(did, u.id);
    return u.id;
  };
}

async function syncCases(limit = 10000) {
  const ia = getIaClient();
  if (!ia) return { ok: false, reason: 'IA_DATABASE_URL not set' };
  const resolve = await makeResolver();
  const rows = await ia.$queryRawUnsafe(`
    SELECT c."caseRef", c."officerDiscordId", c."robloxUserId", c."robloxUsername",
           c."action", c."actions", c."reason", c."notes", c."caseLink",
           c."investigatorRobloxId", c."investigatorRobloxUsername", c."investigatorDiscordUsername",
           c."suspectRobloxDisplayName", c."punishmentsSummary", c."logMessageId",
           c."status"::text AS status, c."createdAt", c."updatedAt",
           u."discordId" AS "ownerDiscordId", u."discordUsername" AS "ownerDiscordUsername"
    FROM cases c LEFT JOIN users u ON u.id = c."userId"
    ORDER BY c."createdAt" ASC LIMIT ${Number(limit) || 10000}
  `);
  let synced = 0, skipped = 0;
  for (const r of rows) {
    try {
      // IA and MET number cases independently, so an IA "#5" can collide with a
      // native MET "#5". Never overwrite a natively-created case: only touch rows
      // that don't exist yet or were themselves written by IA sync.
      const ex = await prisma.case.findUnique({ where: { caseRef: r.caseRef }, select: { origin: true, status: true } }).catch(() => null);
      if (ex && ex.origin !== 'IA') { skipped++; console.warn('[IA] case sync skip (native case owns ref)', r.caseRef); continue; }
      const userId = await resolve(r.ownerDiscordId || r.officerDiscordId, r.ownerDiscordUsername);
      const data = {
        origin: 'IA',
        userId,
        officerDiscordId: r.officerDiscordId || null,
        robloxUserId: r.robloxUserId || null,
        robloxUsername: r.robloxUsername || null,
        action: r.action || 'N/A',
        actions: r.actions ?? undefined,
        reason: r.reason || 'N/A',
        notes: r.notes || 'N/A',
        caseLink: r.caseLink || null,
        investigatorRobloxId: r.investigatorRobloxId || null,
        investigatorRobloxUsername: r.investigatorRobloxUsername || null,
        investigatorDiscordUsername: r.investigatorDiscordUsername || null,
        suspectRobloxDisplayName: r.suspectRobloxDisplayName || null,
        punishmentsSummary: r.punishmentsSummary || null,
        logMessageId: r.logMessageId || null,
        status: norm(r.status, CASE_STATUS, 'PENDING'),
        updatedAt: r.updatedAt || new Date(),
      };
      // Once a synced case has been ACTIONED on the MET side (approved/denied),
      // MET is authoritative: the admin log was posted, roles applied, quota
      // enqueued. Never let a later sync revert its status / clobber its MET log
      // id — that reverted approvals to PENDING (re-approve → duplicate log).
      const updateData = { ...data };
      if (ex && ex.status && ex.status !== 'PENDING') { delete updateData.status; delete updateData.logMessageId; }
      await prisma.case.upsert({
        where: { caseRef: r.caseRef },
        update: updateData,
        create: { caseRef: r.caseRef, createdAt: r.createdAt || new Date(), ...data },
      });
      synced++;
    } catch (e) { console.warn('[IA] case sync skip', r.caseRef, '-', e.message); }
  }
  return { ok: true, synced, skipped, total: rows.length };
}

// Tickets are no longer mirrored from the IA database. Nothing on the site
// creates or holds a ticket row any more — closed tickets come straight from
// the Discord ticket-log channel (lib/ticketIngest.js), which is the same
// source the IA database was reporting second-hand.

async function syncAll() {
  if (!getIaClient()) return { ok: false, reason: 'IA_DATABASE_URL not set' };
  const cases = await syncCases().catch(e => ({ ok: false, reason: e.message }));
  return { ok: true, cases };
}

// Optional background sync. Enabled only when IA_DATABASE_URL is set; interval
// (minutes) from IA_SYNC_INTERVAL_MIN, default 10. Off entirely if unset/<=0.
function startIaSync() {
  if (!getIaClient()) return;
  const mins = parseInt(process.env.IA_SYNC_INTERVAL_MIN, 10);
  const interval = Number.isFinite(mins) ? mins : 10;
  if (interval <= 0) return;
  const run = () => syncAll().then(r => console.log('[IA] periodic sync:', JSON.stringify(r))).catch(e => console.warn('[IA] periodic sync failed:', e.message));
  setTimeout(run, 20 * 1000);            // once shortly after boot
  setInterval(run, interval * 60 * 1000);
  console.log(`[IA] periodic case/ticket sync every ${interval} min`);
}

module.exports = { syncCases, syncAll, startIaSync };
