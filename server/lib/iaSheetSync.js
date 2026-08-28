// server/lib/iaSheetSync.js
// One-way rebuild of the Internal Affairs Database sheet from what the site
// actually knows.
//
// ── Why this exists ───────────────────────────────────────────────
//
// The sheet is the thing IA reads, but the database is the thing that is true:
// every approved case and reviewed ticket is a row here first. Until now the
// only writes were single-cell increments, so a member who was never added by
// hand simply never scored, a rank change on Discord never reached their target,
// and nobody could tell the difference between "earned nothing" and "not on the
// sheet".
//
// This reconciles the whole thing: who is in IA, which section they belong in,
// what they have earned this week.
//
// ── What it will not do ───────────────────────────────────────────
//
// It never deletes a member row. Somebody who left IA is reported, not removed:
// a wrong role or a Discord outage would otherwise wipe a person's week, and
// putting a row back by hand is far more work than ignoring a stale one.
const prisma = require('./db');
const quota = require('./quota');

const DAY_KEYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

// The sheet's three member blocks, in the order they appear.
const SECTIONS = [
  { key: 'High Command',   title: 'HIGH COMMAND'   },
  { key: 'Middle Command', title: 'MIDDLE COMMAND' },
  { key: 'Low Command',    title: 'LOW COMMAND'    },
];

/** Monday 00:00 in the quota timezone — the start of the current quota week. */
function weekStart(now = new Date()) {
  const tz = process.env.QUOTA_TIMEZONE || 'Europe/London';
  // Work out the local weekday without pulling in a date library.
  const local = new Date(now.toLocaleString('en-US', { timeZone: tz }));
  const day = local.getDay();                     // 0 = Sunday
  const back = day === 0 ? 6 : day - 1;           // rewind to Monday
  local.setHours(0, 0, 0, 0);
  local.setDate(local.getDate() - back);
  return local;
}

/**
 * Points earned per member for the current week, split by weekday.
 *
 * Read from QuotaAward rather than recomputed from cases and tickets: the award
 * row is what was actually credited, including manual adjustments, so the sheet
 * ends up agreeing with the ledger instead of with a second opinion of it.
 */
async function pointsThisWeek({ since } = {}) {
  const from = since || weekStart();
  const awards = await prisma.quotaAward.findMany({
    where: { createdAt: { gte: from }, status: { in: ['PENDING', 'DONE'] } },
    select: { discordId: true, robloxUsername: true, points: true, createdAt: true, label: true },
  });

  const tz = process.env.QUOTA_TIMEZONE || 'Europe/London';
  const byMember = new Map();     // key -> { discordId, robloxUsername, days{}, total }

  for (const a of awards) {
    const key = a.discordId || (a.robloxUsername || '').toLowerCase();
    if (!key) continue;
    if (!byMember.has(key)) {
      byMember.set(key, {
        discordId: a.discordId || null,
        robloxUsername: a.robloxUsername || null,
        days: Object.fromEntries(DAY_KEYS.map(d => [d, 0])),
        total: 0,
      });
    }
    const m = byMember.get(key);
    if (!m.robloxUsername && a.robloxUsername) m.robloxUsername = a.robloxUsername;

    const wd = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: tz })
      .format(a.createdAt).slice(0, 3).toUpperCase();
    if (m.days[wd] != null) m.days[wd] += a.points;
    m.total += a.points;
  }
  return { from, byMember };
}

/**
 * Everyone currently in Internal Affairs, with the rank their Discord roles say.
 *
 * Discord is the authority on who is in IA and at what rank; the sheet is a
 * report of that, which is why a rank change there has to be able to move a row
 * between sections.
 */
async function iaRoster(client) {
  const guildId = process.env.IA_GUILD_ID || process.env.DISCORD_GUILD_ID;
  if (!client || !guildId) return { ok: false, reason: 'no Discord client or IA_GUILD_ID', members: [] };

  let guild;
  try { guild = await client.guilds.fetch(guildId); }
  catch (err) { return { ok: false, reason: `cannot reach guild ${guildId}: ${err.message}`, members: [] }; }

  await guild.members.fetch();

  const { IA_RANKS } = safeRanks();
  const members = [];
  for (const [, m] of guild.members.cache) {
    if (m.user.bot) continue;
    const rank = rankFromMember(m, IA_RANKS);
    if (!rank) continue;                       // not IA
    members.push({
      discordId: m.user.id,
      discordName: m.displayName,
      // The nickname convention is "IA-SPVR | RobloxName".
      robloxUsername: nameFromNickname(m.displayName),
      rankName: rank.name,
      rankAbbr: rank.abbr,
      tier: quota.quotaForRank(rank.name).tier,
      quota: quota.quotaForRank(rank.name),
    });
  }
  return { ok: true, members };
}

/** The IA ladder, lowest → highest. Kept here so this module stands alone. */
function safeRanks() {
  const IA_RANKS = [
    { key: 'PINV', abbr: 'IA-PINV', name: 'Probationary Investigator' },
    { key: 'JINV', abbr: 'IA-JINV', name: 'Junior Investigator' },
    { key: 'INV',  abbr: 'IA-INV',  name: 'Investigator' },
    { key: 'SINV', abbr: 'IA-SINV', name: 'Senior Investigator' },
    { key: 'SPVR', abbr: 'IA-SPVR', name: 'Supervisor' },
    { key: 'ADIR', abbr: 'IA-ADIR', name: 'Assistant Director' },
    { key: 'DDIR', abbr: 'IA-DD',   name: 'Deputy Director' },
    { key: 'DIR',  abbr: 'IA-D',    name: 'Director' },
  ];
  return { IA_RANKS };
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Highest IA rank a member holds, by role name or a pinned IA_ROLE_* id. */
function rankFromMember(member, ranks) {
  let best = null;
  for (const rank of ranks) {
    const pinned = process.env[`IA_ROLE_${rank.key}`];
    if (pinned && member.roles.cache.has(pinned)) { best = rank; continue; }
    const hit = member.roles.cache.some(r =>
      norm(r.name) === norm(rank.name) || norm(r.name) === norm(rank.abbr) || norm(r.name) === norm(rank.key));
    if (hit) best = rank;
  }
  return best;
}

/**
 * "IA-SPVR | Fxkresl" → "Fxkresl".
 * Split on a pipe first: an unspaced hyphen belongs to the rank abbreviation
 * itself, so splitting on it blindly loses the name.
 */
function nameFromNickname(nick) {
  const raw = String(nick || '').trim();
  if (!raw) return null;
  let parts;
  if (raw.includes('|')) parts = raw.split('|');
  else if (/\s[-–]\s/.test(raw)) parts = raw.split(/\s[-–]\s/);
  else return raw;
  return parts.slice(1).join(' ').trim() || raw;
}

/**
 * Work out what the sheet SHOULD contain, without writing anything.
 *
 * Separated from the write so the dashboard can show the plan first. A sync
 * that only tells you what it did after the fact is one you cannot safely run
 * on a Sunday night.
 */
async function planSync(client, { since } = {}) {
  const roster = await iaRoster(client);
  const { from, byMember } = await pointsThisWeek({ since });

  const sections = SECTIONS.map(s => ({ ...s, rows: [] }));
  const unplaced = [];

  for (const m of roster.members) {
    const pts = byMember.get(m.discordId)
      || (m.robloxUsername ? byMember.get(m.robloxUsername.toLowerCase()) : null)
      || null;

    const row = {
      username: m.robloxUsername || m.discordName,
      discordId: m.discordId,
      rank: m.rankName,
      rankAbbr: m.rankAbbr,
      tier: m.tier,
      exempt: !!m.quota.exempt,
      target: m.quota.target,
      days: pts ? pts.days : Object.fromEntries(DAY_KEYS.map(d => [d, 0])),
      total: pts ? pts.total : 0,
      met: m.quota.exempt ? true : (m.quota.target != null ? (pts ? pts.total : 0) >= m.quota.target : null),
    };

    const section = sections.find(s => s.key === m.tier);
    if (section) section.rows.push(row);
    else unplaced.push(row);        // a rank with no tier — reported, never dropped
  }

  // Highest earners first inside each block, which is how the leaderboard reads.
  for (const s of sections) {
    s.rows.sort((a, b) => (b.total - a.total) || a.username.localeCompare(b.username));
  }

  // Points credited to somebody who is not on the roster: usually a member who
  // left IA, or an award whose Roblox name never resolved. Worth seeing.
  const rosterKeys = new Set(roster.members.flatMap(m =>
    [m.discordId, (m.robloxUsername || '').toLowerCase()].filter(Boolean)));
  const orphanAwards = [...byMember.entries()]
    .filter(([k]) => !rosterKeys.has(k))
    .map(([k, v]) => ({ key: k, robloxUsername: v.robloxUsername, total: v.total }));

  return {
    ok: roster.ok,
    reason: roster.reason || null,
    weekFrom: from,
    sections,
    unplaced,
    orphanAwards,
    counts: {
      members: roster.members.length,
      withPoints: [...byMember.values()].length,
      unplaced: unplaced.length,
      orphanAwards: orphanAwards.length,
    },
  };
}

/**
 * Apply the plan to the sheet.
 *
 * Two steps, in this order and for a reason:
 *   1. add anyone missing, so a new member has a row before we try to score it
 *   2. write the week's points for everyone
 *
 * Doing it the other way round silently drops the first week of anybody who
 * joined mid-week, which is the exact case nobody notices.
 */
async function applySync(client, { since, addMissing = true, borders = true } = {}) {
  const plan = await planSync(client, { since });
  if (!plan.ok) return { ok: false, reason: plan.reason, plan };

  const rows = plan.sections.flatMap(s => s.rows);
  const out = { ok: true, plan, added: [], updated: 0, missing: [], errors: [] };

  if (!quota.hasQuotaWebhook || !quota.hasQuotaWebhook()) {
    return { ok: false, reason: 'The quota webhook is not configured, so the sheet cannot be written.', plan };
  }

  // 1. Members the sheet has never seen.
  if (addMissing) {
    try {
      const known = await quota.callQuotaWebhook({ action: 'members' });
      const have = new Set();
      for (const m of (known && known.members) || []) {
        if (m.discordId) have.add(String(m.discordId).replace(/\D/g, ''));
        if (m.username)  have.add(String(m.username).toLowerCase());
      }
      const add = rows.filter(r =>
        !have.has(String(r.discordId || '').replace(/\D/g, '')) &&
        !have.has(String(r.username || '').toLowerCase()));
      if (add.length) {
        const res = await quota.callQuotaWebhook({
          action: 'roster',
          add: add.map(r => ({ username: r.username, discordId: r.discordId, rank: r.rank })),
          remove: [],
        });
        out.added = res && res.added ? res.added : add.map(r => r.username);
      }
    } catch (err) {
      out.errors.push(`adding members failed: ${err.message}`);
    }
  }

  // 2. The week's points, in one pass.
  try {
    const res = await quota.callQuotaWebhook({
      action: 'writeWeek', borders,
      rows: rows.map(r => ({
        username: r.username, discordId: r.discordId, rank: r.rank,
        days: r.days, total: r.total,
      })),
    });
    if (res && res.ok) {
      out.updated = res.updated || 0;
      out.missing = res.missing || [];
    } else {
      out.ok = false;
      out.errors.push(`writing points failed: ${(res && res.error) || 'no response'}`);
    }
  } catch (err) {
    out.ok = false;
    out.errors.push(`writing points failed: ${err.message}`);
  }

  return out;
}

module.exports = { planSync, applySync, pointsThisWeek, iaRoster, weekStart, SECTIONS, DAY_KEYS, nameFromNickname };
