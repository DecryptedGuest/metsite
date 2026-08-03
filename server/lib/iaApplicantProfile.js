// server/lib/iaApplicantProfile.js
// Everything about an applicant, in one object, for whoever is marking them.
//
// The application answers what they SAY. This answers who they are: both
// accounts with their pictures and ages, every group and rank they hold, their
// MET standing, their record, and whether they have applied before. A marker who
// has to open Roblox in another tab to check an account age is a marker who does
// not check it.
//
// Three things shape the whole module:
//
//   It is assembled on READ, not stored. The application row carries a snapshot
//   from the moment they applied — which is evidence, and stays — but "who are
//   they now" has to be current, so this is built fresh and the snapshot is
//   compared against it. Where the two disagree, that IS the finding.
//
//   It never fails. Every external lookup is best-effort and independently
//   caught. Roblox being slow must not stop somebody reading an application, so
//   a missing piece comes back as null with a note rather than as an error, and
//   the page says "could not read" instead of showing a blank and implying zero.
//
//   It answers the questions the rules actually ask. MET requires a Roblox
//   account 100+ days old and no gang membership; the queue rule is that the
//   divisionless get first pick; the application claims no punishments in the
//   past week. Each of those is computed and labelled, rather than left for the
//   marker to work out from raw fields.

const prisma = require('./db');

// The MET tryout rule, and the only reason the account age is here at all.
const MIN_ACCOUNT_DAYS = () => {
  const n = parseInt(process.env.MET_MIN_ACCOUNT_DAYS, 10);
  return Number.isFinite(n) && n > 0 ? n : 100;
};

// Groups that disqualify unless somebody has gang permissions. Explicit ids
// only: guessing from a group NAME would flag "Gangster Squad Roleplay" and miss
// every gang that does not have the word in its title, and a false accusation on
// a marker's screen is worse than none.
const GANG_GROUP_IDS = () => String(process.env.GANG_GROUP_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const DAY = 86400000;
const daysSince = (d) => {
  const t = d ? new Date(d).getTime() : NaN;
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / DAY);
};

/**
 * When a Discord account was made, from its id.
 *
 * Free, exact, and offline: a snowflake's top 42 bits are milliseconds since
 * Discord's epoch. Worth having because "the account is four days old" is the
 * single most useful thing to know about an applicant nobody recognises.
 */
function discordCreatedAt(id) {
  const s = String(id || '');
  if (!/^\d{15,21}$/.test(s)) return null;
  try {
    const ms = (BigInt(s) >> 22n) + 1420070400000n;
    const d = new Date(Number(ms));
    return isNaN(d.getTime()) ? null : d;
  } catch (e) { return null; }
}

/** Discord's CDN URL for an avatar hash, or the default for an id. */
function discordAvatarUrl(id, hash, size = 128) {
  if (!id) return null;
  if (hash) {
    const ext = String(hash).startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${id}/${hash}.${ext}?size=${size}`;
  }
  // The default avatar. Post-migration accounts index on the id; the old scheme
  // used the discriminator, which we do not store, so the id is the honest input.
  let idx = 0;
  try { idx = Number((BigInt(id) >> 22n) % 6n); } catch (e) { idx = 0; }
  return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
}

/**
 * The applicant's Roblox side: identity, pictures, age, and every group.
 * @returns {Promise<object>} always an object; fields are null when unread.
 */
async function robloxSide(robloxId, robloxUsername) {
  const out = {
    id: robloxId ? String(robloxId) : null,
    username: robloxUsername || null,
    displayName: null,
    headshot: null,
    body: null,
    profileUrl: robloxId ? `https://www.roblox.com/users/${robloxId}/profile` : null,
    createdAt: null,
    accountAgeDays: null,
    meetsAgeRule: null,          // null = could not check
    minAccountDays: MIN_ACCOUNT_DAYS(),
    groups: [],
    groupsRead: false,
    metGroup: null,
    iaGroup: null,
    gangGroups: [],
    notes: [],
  };
  if (!out.id) {
    out.notes.push('No Roblox account is linked, so nothing here could be checked.');
    return out;
  }

  const R = require('./roblox');

  // Identity and the creation date, from the same call.
  try {
    const info = await R.getRobloxUserInfo(out.id);
    if (info) {
      out.username = info.username || out.username;
      out.displayName = info.displayName || null;
      if (info.createdAt) {
        out.createdAt = info.createdAt;
        out.accountAgeDays = daysSince(info.createdAt);
        if (out.accountAgeDays != null) {
          out.meetsAgeRule = out.accountAgeDays >= out.minAccountDays;
        }
      }
    } else {
      out.notes.push('Roblox did not return this account — it may be deleted or renamed.');
    }
  } catch (e) { out.notes.push('Could not read the Roblox account: ' + e.message); }

  // Both pictures. The headshot for the card, the full body because a uniform and
  // an avatar are things a marker genuinely looks at.
  try { out.headshot = await R.getRobloxAvatarHeadshot(out.id); }
  catch (e) { /* cosmetic */ }
  out.body = `https://thumbnails.roblox.com/v1/users/avatar?userIds=${out.id}&size=352x352&format=Png&isCircular=false`;

  // Every group and rank. This is what answers both the MET standing and the
  // gang question without a second round trip.
  try {
    const groups = await R.getUserGroups(out.id);
    out.groups = (groups || []).map(g => ({
      id: g.group.id, name: g.group.name, members: g.group.memberCount,
      rank: g.role.name, rankNumber: g.role.rank,
      icon: null,
      url: `https://www.roblox.com/groups/${g.group.id}`,
    }));
    out.groupsRead = true;

    const divisions = require('./divisions');
    const metId = String(process.env.MET_GROUP_ID || divisions.metGroupId() || '');
    const iaId = String(divisions.explicitGroupId('IA') || process.env.IA_GROUP_ID || '');
    out.metGroup = out.groups.find(g => metId && g.id === metId) || null;
    out.iaGroup = out.groups.find(g => iaId && g.id === iaId) || null;

    const gangs = GANG_GROUP_IDS();
    out.gangGroups = gangs.length ? out.groups.filter(g => gangs.includes(g.id)) : [];

    // Icons, so the group list reads as a list of places rather than of strings.
    try {
      const icons = await R.getGroupIcons(out.groups.slice(0, 30).map(g => g.id));
      out.groups.forEach(g => { if (icons && icons[g.id]) g.icon = icons[g.id]; });
    } catch (e) { /* cosmetic */ }
  } catch (e) {
    out.notes.push('Could not read their Roblox groups: ' + e.message);
  }

  return out;
}

/** The applicant's Discord side. No API call needed for any of it. */
function discordSide(user, snapshot) {
  const id = (user && user.discordId) || (snapshot && snapshot.discordId) || null;
  const hash = (user && user.discordAvatar)
    || (snapshot && snapshot.discord && snapshot.discord.avatar) || null;
  const created = discordCreatedAt(id);
  return {
    id: id || null,
    username: (user && user.discordUsername)
      || (snapshot && snapshot.discord && snapshot.discord.username) || null,
    displayName: (user && user.displayName)
      || (snapshot && snapshot.discord && snapshot.discord.displayName) || null,
    avatar: discordAvatarUrl(id, hash, 256),
    createdAt: created,
    accountAgeDays: daysSince(created),
  };
}

/** Their MET standing: rank, XP, where that puts them, and their divisions. */
async function metSide(user) {
  const out = {
    siteRole: (user && user.role) || null,
    rank: null,
    rankSource: null,
    divisions: [],
    divisionless: null,
    xp: null,
    xpRank: null,
    xpNext: null,
    xpPosition: null,
    xpOf: null,
    notes: [],
  };
  if (!user) return out;

  out.rank = (user.metRankOverride && user.metRankOverride.name)
          || (user.metRankNatural && user.metRankNatural.name) || null;
  out.rankSource = user.metRankOverride ? 'set by hand' : (user.metRankNatural ? 'from the group' : null);

  const divs = Array.isArray(user.divisions) ? user.divisions : [];
  out.divisions = divs.filter(Boolean).map(d => ({
    division: d.division, rank: d.rankName || null, hicomm: !!d.hicomm,
  }));
  // The queue rule: officers with NO division get first pick. It is only
  // applicable if the marker can see it, so it is stated rather than implied.
  out.divisionless = out.divisions.length === 0;

  if (!user.discordId) return out;
  try {
    const XP = require('./xp');
    const bal = await XP.getBalance(String(user.discordId));
    out.xp = bal ? bal.xp : 0;
    const prog = XP.progress ? XP.progress(out.xp) : null;
    if (prog) {
      out.xpRank = prog.rank || (prog.current && prog.current.name) || null;
      out.xpNext = prog.next || null;
    }
    const st = await XP.standing(String(user.discordId));
    if (st) { out.xpPosition = st.position; out.xpOf = st.total; }
  } catch (e) { out.notes.push('Could not read their XP: ' + e.message); }

  return out;
}

/**
 * Their record. The application claims "no strikes or punishments in the past
 * week", and this is the only way to check it without going digging.
 */
async function recordSide(user) {
  const out = {
    casesAgainstThem: null,
    casesInLastWeek: null,
    recentCases: [],
    activePunishments: [],
    ticketsHandled: null,
    isBlacklisted: !!(user && user.isBlacklisted),
    blacklistReason: (user && user.blacklistReason) || null,
    notes: [],
  };
  const did = user && user.discordId ? String(user.discordId) : null;
  if (!did) return out;

  const weekAgo = new Date(Date.now() - 7 * DAY);
  try {
    const [total, lastWeek, recent, tickets] = await Promise.all([
      prisma.case.count({ where: { officerDiscordId: did } }),
      prisma.case.count({ where: { officerDiscordId: did, createdAt: { gte: weekAgo } } }),
      prisma.case.findMany({
        where: { officerDiscordId: did },
        orderBy: { createdAt: 'desc' }, take: 8,
        select: {
          caseRef: true, action: true, reason: true, status: true, createdAt: true,
          // The relation is `casePunishments`, not `punishments` — the shorter
          // name does not exist and Prisma rejects the whole query for it, which
          // took out the entire record section rather than just this column.
          casePunishments: { select: { action: true, durationDays: true, expiresAt: true } },
        },
      }),
      prisma.ticketLog.count({ where: { closerDiscordId: did } }),
    ]);
    out.casesAgainstThem = total;
    out.casesInLastWeek = lastWeek;
    out.ticketsHandled = tickets;
    out.recentCases = recent.map(c => ({
      caseRef: c.caseRef, action: c.action, status: c.status, createdAt: c.createdAt,
      // Trimmed: a marker is triaging, and the full reason is one click away in
      // the case itself.
      reason: c.reason ? String(c.reason).slice(0, 220) : null,
      punishments: (c.casePunishments || []).map(p => ({
        action: p.action, durationDays: p.durationDays, expiresAt: p.expiresAt,
      })),
    }));
    // Still running right now, which is a different question from "ever punished".
    const now = Date.now();
    for (const c of recent) {
      for (const p of (c.casePunishments || [])) {
        if (p.expiresAt && new Date(p.expiresAt).getTime() > now) {
          out.activePunishments.push({
            caseRef: c.caseRef, action: p.action, expiresAt: p.expiresAt,
            daysLeft: Math.ceil((new Date(p.expiresAt).getTime() - now) / DAY),
          });
        }
      }
    }
  } catch (e) {
    out.notes.push('Could not read their record: ' + e.message);
  }
  return out;
}

/** Have they applied before, and what happened? */
async function historyFor(applicantId, exceptId) {
  try {
    const rows = await prisma.iaApplication.findMany({
      where: { applicantId, status: { in: ['SUBMITTED', 'ACCEPTED', 'REJECTED'] },
               id: exceptId ? { not: exceptId } : undefined },
      orderBy: { submittedAt: 'desc' }, take: 10,
      select: { id: true, appRef: true, status: true, submittedAt: true, markedAt: true,
                markedByName: true, percentage: true, score: true, maxScore: true },
    });
    return rows;
  } catch (e) { return []; }
}

/**
 * Where the snapshot taken at submit disagrees with what is true now.
 *
 * This is a finding, not a formatting detail. A Roblox username that has changed
 * since they applied is worth a marker's attention, and so is somebody who has
 * joined a division since — because "the divisionless get first pick" was
 * decided on the older fact.
 */
function driftBetween(snapshot, live) {
  const drift = [];
  const snapRoblox = snapshot && snapshot.captured && snapshot.captured.roblox;
  if (snapRoblox && snapRoblox.username && live.roblox.username
      && String(snapRoblox.username).toLowerCase() !== String(live.roblox.username).toLowerCase()) {
    drift.push({
      what: 'Roblox username',
      then: snapRoblox.username, now: live.roblox.username,
    });
  }
  const snapDiscord = snapshot && snapshot.captured && snapshot.captured.discord;
  if (snapDiscord && snapDiscord.username && live.discord.username
      && snapDiscord.username !== live.discord.username) {
    drift.push({ what: 'Discord username', then: snapDiscord.username, now: live.discord.username });
  }
  const ctx = snapshot && snapshot.context;
  if (ctx && typeof ctx.divisionless === 'boolean' && live.met.divisionless !== null
      && ctx.divisionless !== live.met.divisionless) {
    drift.push({
      what: 'Divisions',
      then: ctx.divisionless ? 'no division' : (ctx.divisions || []).join(', ') || 'in a division',
      now: live.met.divisionless ? 'no division' : live.met.divisions.map(d => d.division).join(', '),
    });
  }
  if (ctx && typeof ctx.isBlacklisted === 'boolean' && ctx.isBlacklisted !== live.record.isBlacklisted) {
    drift.push({
      what: 'Blacklist', then: ctx.isBlacklisted ? 'blacklisted' : 'not blacklisted',
      now: live.record.isBlacklisted ? 'blacklisted' : 'not blacklisted',
    });
  }
  return drift;
}

/**
 * The checks the RULES make, each with a verdict a marker can act on.
 *
 * 'pass' | 'fail' | 'unknown' — never a silent absence. An unknown is a thing to
 * go and look at; a blank looks like a pass.
 */
function checksFor(live) {
  const checks = [];
  const push = (label, verdict, detail) => checks.push({ label, verdict, detail });

  if (live.roblox.meetsAgeRule === null) {
    push('Roblox account age', 'unknown',
      live.roblox.id ? 'Roblox would not say when the account was made.' : 'No Roblox account is linked.');
  } else {
    push('Roblox account age', live.roblox.meetsAgeRule ? 'pass' : 'fail',
      `${live.roblox.accountAgeDays} days old · ${live.roblox.minAccountDays} required`);
  }

  if (!live.roblox.groupsRead) {
    push('Gang membership', 'unknown', 'Their group list could not be read.');
  } else if (!GANG_GROUP_IDS().length) {
    push('Gang membership', 'unknown',
      'No gang groups are configured, so this cannot be checked automatically — read the group list.');
  } else {
    push('Gang membership', live.roblox.gangGroups.length ? 'fail' : 'pass',
      live.roblox.gangGroups.length
        ? 'In ' + live.roblox.gangGroups.map(g => g.name).join(', ')
        : 'Not in any configured gang group.');
  }

  push('In the MET group', live.roblox.groupsRead ? (live.roblox.metGroup ? 'pass' : 'fail') : 'unknown',
    live.roblox.metGroup ? live.roblox.metGroup.rank
      : (live.roblox.groupsRead ? 'Not a member of the MET group.' : 'Could not check.'));

  if (live.record.casesInLastWeek == null) {
    push('Nothing in the past week', 'unknown', 'Their record could not be read.');
  } else {
    push('Nothing in the past week', live.record.casesInLastWeek ? 'fail' : 'pass',
      live.record.casesInLastWeek
        ? `${live.record.casesInLastWeek} case(s) filed against them in the last 7 days`
        : 'No cases against them in the last 7 days.');
  }

  push('Not blacklisted', live.record.isBlacklisted ? 'fail' : 'pass',
    live.record.isBlacklisted ? (live.record.blacklistReason || 'Blacklisted.') : 'Clear.');

  if (live.met.divisionless === null) {
    push('Division', 'unknown', 'Could not read their divisions.');
  } else {
    // Not a pass/fail — being in a division is allowed, it just puts them behind
    // the divisionless in the queue. Reported as information, deliberately.
    push('Division', 'note', live.met.divisionless
      ? 'No division — first pick, by the rule.'
      : 'In ' + live.met.divisions.map(d => d.division + (d.rank ? ` (${d.rank})` : '')).join(', '));
  }

  return checks;
}

/**
 * Build the profile.
 *
 * @param {object} row  the IaApplication row
 * @returns {Promise<object>}
 */
async function build(row) {
  if (!row) return null;

  // The live account, by id where we have one and by the snapshotted Discord id
  // otherwise — an applicant whose site row was deleted still has an application
  // worth reading.
  let user = null;
  try {
    user = await prisma.user.findUnique({ where: { id: row.applicantId } });
    if (!user && row.discordId) {
      user = await prisma.user.findUnique({ where: { discordId: String(row.discordId) } });
    }
  } catch (e) { /* fall through with what the snapshot holds */ }

  const robloxId = (user && user.robloxId) || row.robloxId || null;
  const robloxUsername = (user && user.robloxUsername) || row.robloxUsername || null;

  // In parallel: they are independent, and a marker is waiting.
  const [roblox, met, record, history] = await Promise.all([
    robloxSide(robloxId, robloxUsername),
    metSide(user),
    recordSide(user || { discordId: row.discordId, isBlacklisted: false }),
    historyFor(row.applicantId, row.id),
  ]);

  const live = {
    discord: discordSide(user, { discordId: row.discordId, discord: row.captured && row.captured.discord }),
    roblox, met, record,
    site: {
      accountCreated: (user && user.createdAt) || null,
      accountAgeDays: daysSince(user && user.createdAt),
      lastLogin: (user && user.lastLogin) || null,
      lastLoginDaysAgo: daysSince(user && user.lastLogin),
      everSignedIn: !!(user && user.lastLogin),
      exists: !!user,
    },
    history,
  };

  live.checks = checksFor(live);
  live.drift = driftBetween(row, live);
  // What the applicant declared about themselves, next to what we can see —
  // side by side is the only arrangement in which a contradiction is obvious.
  const answers = row.answers || {};
  live.declared = {
    age: answers.age_band || null,
    platform: answers.platform || null,
    timezone: answers.timezone || null,
    device: answers.device || null,
  };
  live.snapshot = row.captured || null;
  live.snapshotContext = row.context || null;

  return live;
}

module.exports = {
  build, discordCreatedAt, discordAvatarUrl, checksFor, driftBetween,
  robloxSide, discordSide, metSide, recordSide, historyFor,
  MIN_ACCOUNT_DAYS, GANG_GROUP_IDS,
};
