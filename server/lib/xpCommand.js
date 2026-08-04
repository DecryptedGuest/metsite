// server/lib/xpCommand.js
// /xp — see where you stand, or move somebody's XP.
//
//   /xp                                    your own card
//   /xp officers:@a                        their card
//   /xp officers:@a @b @c                  a compact table for all three
//   /xp officers:@a action:add value:5      award 5 XP
//   /xp officers:@a @b action:set value:0   wipe both back to zero
//
// Viewing posts publicly — a stats card is meant to be seen. Changing XP
// answers ephemerally, because the permanent public record is the XP log
// channel, and a busy channel doesn't need the same thing twice.
//
// The officers option is a STRING rather than a user option because Discord has
// no multi-user option type. Typing @ inside it still opens the member picker
// and inserts a real mention, so it behaves like one — and it also accepts raw
// ids, Discord usernames and Roblox usernames, which a user option can't.

const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');

const { e } = require('./emoji');
const XP = require('./xp');
const xpLog = require('./xpLog');
const { canDiscipline } = require('./disciplineAccess');

const COLOR = { card: 0x4a8fff, working: 0x4a8fff, done: 0x2ed896, partial: 0xf5b730, fail: 0xf04f5e };

// More than this in one command and the panel stops being readable — and the
// Roblox lookups start to matter.
const MAX_TARGETS = 20;

function buildCommand() {
  return new SlashCommandBuilder()
    .setName('xp')
    .setDescription('XP')
    .addStringOption(o => o
      .setName('officers')
      .setDescription('Who')
      .setMaxLength(900))
    .addStringOption(o => o
      .setName('action')
      .setDescription('Action')
      .addChoices(
        { name: 'add',    value: 'ADD' },
        { name: 'remove', value: 'REMOVE' },
        { name: 'set',    value: 'SET' },
      ))
    .addIntegerOption(o => o
      .setName('value')
      .setDescription('Value')
      .setMinValue(0).setMaxValue(1000000))
    .addStringOption(o => o
      .setName('reason')
      .setDescription('Why')
      .setMaxLength(500))
    // A boolean rather than a `/xp leaderboard` subcommand, because Discord
    // makes a command either take subcommands or take options — never both —
    // and a bare `/xp` showing your own card is the thing everyone actually
    // uses. Typing "lead" in the option picker gets you here in one keystroke.
    .addBooleanOption(o => o
      .setName('leaderboard')
      .setDescription('Leaderboard'))
    .toJSON();
}

// ── The leaderboard ───────────────────────────────────────────────
/**
 * The top of the table, badged with each officer's own rank insignia.
 *
 * Their MET rank is the interesting one, but reading it means a Roblox lookup
 * per officer, and ten of those turns an instant command into a slow one. The
 * XP ladder's own rank is derived from the number already in front of us, and
 * an officer's XP rank and their MET rank agree by construction — that's what
 * the promotion half of this system is for.
 *
 * @param {number} viewerPos  the caller's position, 0 if they have no XP
 */
function buildLeaderboard(rows, client, { viewerId, viewerPos, viewerXp, total } = {}) {
  const lines = rows.map((r, i) => {
    // The server's own badge for the rank, or nothing at all — never a
    // generic stand-in, which reads as a rank of its own beside real insignia.
    const badge = require('./rankEmoji').forRank(client, r.rank.name);
    // Top of the board gets the star; everyone else gets their number in a
    // fixed-width block so the names line up in a column.
    const mark = i === 0 ? e('met_star') : `\`${String(r.position).padStart(2, ' ')}\``;
    const me   = viewerId && String(r.discordId) === String(viewerId) ? '  ←  you' : '';
    return `${mark} ${badge ? badge + ' ' : ''}<@${r.discordId}> — **${r.xp}** XP${me}`;
  });

  const embed = new EmbedBuilder()
    .setColor(COLOR.card)
    .setTitle(`${e('met_xp')} MET XP — top ${rows.length}`)
    .setDescription(lines.length ? short(lines.join('\n'), 4000) : '*Nobody has any XP yet.*')
    .setFooter({ text: total ? `${total} officers on the ladder` : 'MET XP' });

  // Only when they're actually outside it — repeating "#3" to somebody already
  // looking at themselves at #3 is noise.
  const inTop = rows.some(r => viewerId && String(r.discordId) === String(viewerId));
  if (viewerId && !inTop) {
    embed.addFields({
      name: 'You',
      value: viewerPos
        ? `\`${viewerPos}\` <@${viewerId}> — **${viewerXp}** XP`
        : `<@${viewerId}> — *no XP yet. Attend an event and you're on the board.*`,
      inline: false,
    });
  }
  return embed;
}

async function showLeaderboard(interaction) {
  const [rows, standing, self] = await Promise.all([
    XP.leaderboard(10).catch(() => []),
    XP.standing(interaction.user.id).catch(() => ({ position: 0, total: 0 })),
    XP.getBalance(interaction.user.id).catch(() => null),
  ]);
  return interaction.editReply({
    embeds: [buildLeaderboard(rows, interaction.client, {
      viewerId: interaction.user.id,
      // standing() ranks everyone including officers on 0, so an officer with
      // no XP at all would otherwise be reported at some flattering position
      // shared with every other blank row.
      viewerPos: self && self.xp > 0 ? standing.position : 0,
      viewerXp: self ? self.xp : 0,
      total: standing.total,
    })],
  }).catch(() => {});
}

// ── Rendering ─────────────────────────────────────────────────────
const SPIN = ['met_load1', 'met_load2', 'met_load3', 'met_load4'];
const spinner = i => e(SPIN[i % SPIN.length]);

function short(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ── Resolving who they meant ──────────────────────────────────────
/**
 * Pull Discord user ids out of the officers string.
 *
 * Handles, in order of how certain each is:
 *   <@123> / <@!123>   a real mention (what the @ picker inserts)
 *   123…               a raw snowflake
 *   anything else      a name — resolved against the guild, then against
 *                      Roblox usernames via RoVer
 */
async function resolveTargets(raw, guild) {
  const out = [];
  const seen = new Set();
  const problems = [];
  // Roblox accounts with XP waiting for them but no Discord account to put it
  // on. Reported rather than dropped — see the end of the name loop.
  const unlinked = [];

  const push = (id, how) => {
    const s = String(id);
    if (seen.has(s)) return;
    seen.add(s);
    out.push({ discordId: s, via: how });
  };

  const text = String(raw || '').trim();
  if (!text) return { targets: out, problems };

  // Mentions and raw ids first — pull them out and take what's left as names.
  let rest = text;
  for (const m of text.matchAll(/<@!?(\d{15,25})>/g)) push(m[1], 'mention');
  rest = rest.replace(/<@!?\d{15,25}>/g, ' ');
  for (const m of rest.matchAll(/\b(\d{15,25})\b/g)) push(m[1], 'id');
  rest = rest.replace(/\b\d{15,25}\b/g, ' ');

  const names = rest.split(/[\s,]+/).map(s => s.trim().replace(/^@/, '')).filter(Boolean);
  for (const name of names) {
    if (out.length >= MAX_TARGETS) break;
    let found = null;

    // A Discord username / nickname in this server. Timed, like everything else
    // that leaves this process — a stalled member search is otherwise a command
    // that never answers.
    if (guild) {
      try {
        const hits = await withTimeout(guild.members.fetch({ query: name, limit: 5 }), LOOKUP_MS(), null);
        if (!hits) throw new Error('member search timed out');
        const q = name.toLowerCase();
        const m = hits.find(x => x.user.username.toLowerCase() === q)
               || hits.find(x => (x.displayName || '').toLowerCase() === q)
               // "PC | realangeloo" — match the Roblox half of a rank nickname.
               || hits.find(x => (x.displayName || '').toLowerCase().split('|').pop().trim() === q)
               || hits.first();
        if (m) found = { id: m.id, via: 'name' };
      } catch (err) { /* fall through to Roblox */ }
    }

    // A Roblox username — go the other way through RoVer.
    let roblox = null;   // kept for the pending-XP fallback below
    if (!found) {
      try {
        const R = require('./roblox');
        const rid = await withTimeout(R.getRobloxIdFromUsername(name), LOOKUP_MS(), null);
        if (rid) roblox = rid;
        // getDiscordFromRoblox answers with an ARRAY of members — possibly empty,
        // and an empty array is truthy. Treating it as an id turned "this Roblox
        // account is in nobody's Discord" into a target called "[object Object]".
        const members = rid
          ? await withTimeout(R.getDiscordFromRoblox(rid.id || rid), LOOKUP_MS(), [])
          : [];
        const hit = (members || []).find(m => m && m.discordId);
        if (hit) found = { id: String(hit.discordId), via: 'roblox' };
      } catch (err) { /* nothing more to try */ }
    }

    if (found) { push(found.id, found.via); continue; }

    // Nobody on Discord — but there may be XP waiting for that Roblox account
    // from the leaderboard import. Saying "35 XP is waiting for them, they just
    // aren't in the server" is a real answer; "who?" is not.
    try {
      const waiting = await withTimeout(
        require('./xp').pendingFor({ robloxId: roblox ? roblox.id : null, robloxUsername: name }),
        LOOKUP_MS(), null);
      if (waiting) {
        unlinked.push({
          username: roblox ? roblox.username : name,
          robloxId: waiting.robloxId || (roblox ? roblox.id : null),
          xp: waiting.xp, claimed: !!waiting.claimedAt, source: waiting.source,
        });
        continue;
      }
    } catch (err) { /* fall through to "not found" */ }

    problems.push(name);
  }

  return { targets: out.slice(0, MAX_TARGETS), problems, unlinked,
           overflow: out.length > MAX_TARGETS };
}

/**
 * Resolve, or give up by a deadline.
 *
 * Every lookup below talks to somebody else's server — Discord, RoVer, Roblox —
 * and node-fetch has no default timeout, so a stalled socket is a promise that
 * never settles. That is exactly what left `/xp` sitting on "Reading the
 * record…" forever: not an error anywhere, just a call that never came back,
 * and an interaction whose last edit stays on screen for good.
 *
 * A card missing an avatar is a card. A card that never arrives is a bug.
 */
function withTimeout(promise, ms, fallback) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// Per-call budget. Generous enough that a healthy lookup always wins the race,
// short enough that a dead one doesn't hold up the whole command.
const LOOKUP_MS = () => {
  const n = parseInt(process.env.XP_LOOKUP_TIMEOUT_MS || '6000', 10);
  return Number.isFinite(n) && n > 0 ? n : 6000;
};

/**
 * Everything the card needs about one officer: their Roblox identity, their
 * live MET group rank, and their XP row (seeded from that rank the first time
 * we see them, so a serving Inspector doesn't show as a Student Officer).
 *
 * Nothing here is allowed to hang. Each external call has its own deadline and
 * its own fallback, so a card always renders — with whatever we managed to
 * find out in the time available.
 */
async function loadOfficer(discordId, guild) {
  const roblox = require('./roblox');
  const t = LOOKUP_MS();

  const member = guild
    ? await withTimeout(guild.members.fetch(discordId), t, null)
    : null;

  // The same resolver /discipline uses — RoVer, then their MET Dashboard
  // account, then their MET nickname. A missing Roblox link here means no rank,
  // which means no XP placement at all.
  const link = await withTimeout(
    require('./robloxLink').resolveRoblox(discordId), t, { robloxId: null, username: null });
  const robloxId = link.robloxId;
  const info = link.username ? { id: robloxId, username: link.username } : null;

  const [avatar, groupRole] = await Promise.all([
    robloxId ? withTimeout(roblox.getRobloxAvatarHeadshot(robloxId), t, null) : null,
    robloxId ? withTimeout(require('./metRank').metRole(robloxId), t, null) : null,
  ]);

  // Establish their baseline before anything reads it. This creates NO row for
  // somebody whose group rank can't be placed on the ladder — being unplaceable
  // is different from being at the bottom of it.
  //
  // Timed too: placing a rank can need an authenticated group-roles call, and
  // that is one more thing that can stall.
  await withTimeout(XP.seedFromRank(discordId, groupRole), t, null);

  // Any XP imported for their Roblox account before we knew their Discord id.
  // Looking somebody up is exactly the moment to settle that: it takes the higher
  // of the two numbers, so it can only ever raise them, and once claimed it never
  // runs again for that account.
  if (robloxId || (info && info.username)) {
    await withTimeout(XP.claimPending({
      discordId, robloxId, robloxUsername: info ? info.username : null,
    }), t, null);
  }

  let row = await withTimeout(XP.getBalance(discordId), LOOKUP_MS(), null);
  // Only attach Roblox details to a row that already exists. Calling ensure()
  // unconditionally would create the very row seedFromRank just declined to,
  // and hand an unranked member a Community Support Officer badge.
  if (row && (robloxId || (info && info.username))) {
    row = await withTimeout(XP.ensure(discordId, {
      robloxId: robloxId ? String(robloxId) : null,
      robloxUsername: info ? info.username : null,
    }), LOOKUP_MS(), row) || row;
  }

  const xp = row ? row.xp : 0;

  return {
    discordId, member, robloxId,
    robloxUsername: info ? info.username : (row ? row.robloxUsername : null),
    displayName: member ? member.displayName : (info ? info.username : null),
    avatar, groupRole, row, xp,
    // An officer with no row has never been placed and has never been given
    // XP. They are unranked, not a CSO.
    ranked: !!row,
    rank: XP.rankFor(xp),
    progress: XP.progress(xp),
  };
}

/**
 * The stats card for one officer.
 *
 * On telling the label apart from the answer: Discord renders an embed's field
 * NAME in bold white and its VALUE in plain grey, which is already a clear
 * hierarchy — the original problem was that the values were **bolded** on top
 * of that, making both halves the same weight. Markdown headings do not render
 * inside a field value at all (they come out as literal "###"), so the fix is
 * simply to leave the value alone and let Discord's own styling do the work.
 *
 * @param {object} client the live client, for the server's own rank emoji
 */
async function buildCard(o, client) {
  const [hist, standing] = await Promise.all([
    XP.history(o.discordId, 5).catch(() => []),
    XP.standing(o.discordId).catch(() => ({ position: 0, total: 0 })),
  ]);

  const p = o.progress;
  // The XP field already says how many more are needed, so this names the rank
  // they're climbing towards rather than repeating the count back at them.
  const nextLine = p.next
    ? `${e('met_promote')} **${p.next.name}** at **${p.next.at} XP**`
    : `${e('met_star')} Top of the XP ladder — nothing left to climb.`;

  const embed = new EmbedBuilder()
    .setColor(COLOR.card)
    .setTitle(`${e('met_xp')} ${short(o.displayName || 'Officer', 60)}`)
    .setDescription(
      `${e('met_user')} <@${o.discordId}>`
      + (o.robloxUsername
        ? ` · [${short(o.robloxUsername, 30)}](https://www.roblox.com/users/${o.robloxId}/profile)`
        : ' · *no Roblox account linked*'))
    .addFields(
      { name: 'Rank',     value: rankLine(o, client), inline: true },
      // XP measures the climb to the NEXT rank, so the denominator is what that
      // rank costs — not the ceiling. A CSO on 1 XP reads "1 / 2 XP", which is
      // the number they actually care about.
      { name: 'XP',       value: o.ranked
          ? (p.next
              ? `${o.xp} / ${p.next.at} XP\n${p.need} more to go!`
              : `${o.xp} / ${XP.maxXp()} XP\nMax rank reached.`)
          : '—', inline: true },
      { name: 'Standing', value: o.ranked && standing.total ? `#${standing.position} of ${standing.total}` : '—', inline: true },
      { name: o.ranked ? 'Next rank' : 'Why there is no XP here',
        value: o.ranked ? `${nextLine}\n${xpLog.progressBar(p)}` : unrankedLine(o),
        inline: false },
    )
    .setFooter({ text: 'MET XP' });

  if (o.avatar) embed.setThumbnail(o.avatar);

  if (hist.length) {
    embed.addFields({
      name: 'Recent',
      value: short(hist.map(h => {
        const when = `<t:${Math.floor(new Date(h.createdAt).getTime() / 1000)}:R>`;
        if (h.kind === 'PROMOTION') return `${e('met_promote')} Promoted to **${h.toRank}** — ${when}`;
        if (h.kind === 'DEMOTION')  return `${e('met_warn')} Demoted to **${h.toRank}** — ${when}`;
        const sign = h.delta > 0 ? `+${h.delta}` : String(h.delta);
        const icon = h.kind === 'SET' ? e('met_edit') : h.delta > 0 ? e('met_xp') : e('met_cross');
        return `${icon} **${sign}** → ${h.after} XP${h.reason ? ` · ${short(h.reason, 50)}` : ''} — ${when}`;
      }).join('\n'), 1000),
      inline: false,
    });
  } else {
    embed.addFields({ name: 'Recent', value: '*No XP activity yet.*', inline: false });
  }

  return embed;
}

/**
 * The Rank line — their actual MET rank, badged with the server's own emoji for
 * it rather than anything we drew. That is the insignia the server already
 * recognises; a generic mark would be a downgrade.
 *
 * Their MET rank IS their rank, so there is no separate "MET group rank" row
 * saying the same thing twice. The XP-ladder rank only stands in when we can't
 * read the group.
 */
function rankLine(o, client) {
  const name = (o.groupRole && o.groupRole.name) || (o.ranked ? o.rank.name : null);
  if (!name) return 'Unranked';
  const badge = require('./rankEmoji').forRank(client, name);
  return `${badge ? badge + ' ' : ''}${short(name, 40)}`;
}

/** A compact table when several officers were named at once. */
function buildTable(officers, client) {
  const lines = officers.map(o => {
    if (!o.ranked) return `${e('met_user')} <@${o.discordId}> — *unranked*`;
    const p = o.progress;
    const name = (o.groupRole && o.groupRole.name) || o.rank.name;
    const badge = require('./rankEmoji').forRank(client, name);
    const score = p.next ? `**${o.xp}/${p.next.at}** XP` : `**${o.xp}** XP`;
    const tail = p.next ? `${p.need} more to ${p.next.code}` : 'max';
    return `${badge ? badge + ' ' : ''}<@${o.discordId}> — ${score} · ${short(name, 30)} · *${tail}*`;
  });
  return new EmbedBuilder()
    .setColor(COLOR.card)
    .setTitle(`${e('met_xp')} XP — ${officers.length} officers`)
    .setDescription(short(lines.join('\n'), 4000))
    .setFooter({ text: 'MET XP · name one officer for the full card' });
}

// ── Who may change XP ─────────────────────────────────────────────
// Three routes, checked cheapest first. Anyone at all may VIEW XP — this gate
// only covers add / remove / set.
//
//   1. the FLP officer role                    (a role id — free)
//   2. Administrator in the server             (a permission bit — free)
//   3. Deputy Commissioner and above           (MET group rank — a lookup)
//
// XP_MANAGER_ROLE_IDS adds more roles to route 1 without a deploy.
const FLP_OFFICER_ROLE_ID = () => process.env.FLP_OFFICER_ROLE_ID || '1431554710594388018';

function xpRoleIds() {
  const extra = String(process.env.XP_MANAGER_ROLE_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  return [FLP_OFFICER_ROLE_ID(), ...extra].filter(Boolean);
}

/**
 * @param {object} o
 * @param {string}   o.discordId
 * @param {string[]} o.roleIds  the invoker's roles in this guild
 * @param {boolean}  o.isAdmin  do they have Administrator here
 */
async function canManageXp({ discordId, roleIds, isAdmin }) {
  const held = Array.isArray(roleIds) ? roleIds.map(String) : [];

  for (const rid of xpRoleIds()) {
    if (held.includes(String(rid))) {
      return { ok: true, via: 'role', label: rid === FLP_OFFICER_ROLE_ID() ? 'FLP Officer' : 'XP Manager', name: null, why: null };
    }
  }

  if (isAdmin) return { ok: true, via: 'admin', label: 'Server Administrator', name: null, why: null };

  // Deputy Commissioner and above. canDiscipline also lets Internal Affairs
  // through, so only the MET High Command half of its verdict counts here — an
  // investigator has no business moving XP unless they are also DC+, an
  // administrator, or hold one of the roles above.
  const v = await canDiscipline(discordId, held);
  if (v.ok && v.isMetHicomm) {
    return { ok: true, via: v.via, label: v.label, name: v.name, why: null };
  }

  return {
    ok: false, via: null, label: '', name: v.name,
    why: 'Changing XP is for FLP officers, Deputy Commissioner and above, and server administrators. '
       + 'Anyone can run `/xp` to look at their own.',
  };
}

// ── The command ───────────────────────────────────────────────────
async function handleXpCommand(interaction) {
  const rawTargets = interaction.options.getString('officers');
  const action     = interaction.options.getString('action');
  const value      = interaction.options.getInteger('value');
  const reason     = interaction.options.getString('reason');
  const board      = interaction.options.getBoolean
    ? interaction.options.getBoolean('leaderboard')
    : null;
  const changing   = !!action;

  // Viewing is public; changing is ephemeral (the XP log is the public record).
  await interaction.deferReply(changing ? { flags: 64 } : {});

  // The leaderboard answers a different question from everything below it, so
  // it takes the whole command rather than being squeezed in beside a card.
  if (board && !changing) return showLeaderboard(interaction);

  const guild = interaction.guild || null;
  const issuerRoles = interaction.member && interaction.member.roles && interaction.member.roles.cache
    ? [...interaction.member.roles.cache.keys()]
    : [];
  // memberPermissions is the resolved set for the guild the command was run in.
  // It's a bitfield on a real interaction; guard so a partial member object
  // can't throw here.
  const isAdmin = !!(interaction.memberPermissions
    && typeof interaction.memberPermissions.has === 'function'
    && interaction.memberPermissions.has(PermissionFlagsBits.Administrator));

  let frame = 0;
  let lastEdit = 0;
  const draw = async (embed) => {
    // Same pacing rule as /discipline: a floor between edits so a fast step
    // still renders as a frame, and no burst can reach a rate limit.
    const wait = 420 - (Date.now() - lastEdit);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastEdit = Date.now();
    await interaction.editReply({ embeds: [embed] }).catch(() => {});
  };

  const working = (title, body) => new EmbedBuilder()
    .setColor(COLOR.working).setTitle(`${spinner(++frame)} ${title}`).setDescription(body || '​');
  const fail = (title, body) => new EmbedBuilder()
    .setColor(COLOR.fail).setTitle(`${e('met_cross')} ${title}`).setDescription(body);

  await draw(working('Looking that up…'));

  // ── Argument sanity, before anything else happens ──
  if (action && (value == null)) {
    return interaction.editReply({ embeds: [fail('That needs a value',
      `**${action.toLowerCase()}** needs a **value** — how much XP to ${action.toLowerCase()}. Run it again with one.`)] }).catch(() => {});
  }
  if (!action && value != null) {
    return interaction.editReply({ embeds: [fail('That needs an action',
      'You gave a **value** but no **action**. Pick **add**, **remove** or **set**.')] }).catch(() => {});
  }

  // ── Who ──
  let targets = [];
  let problems = [];
  let unlinked = [];
  if (rawTargets) {
    const r = await resolveTargets(rawTargets, guild);
    targets = r.targets;
    problems = r.problems;
    unlinked = r.unlinked || [];
  } else if (!changing) {
    targets = [{ discordId: interaction.user.id, via: 'self' }];
  }

  if (changing && !rawTargets) {
    return interaction.editReply({ embeds: [fail('Who?',
      'Name the officers whose XP you want to change — `officers:@someone`. '
      + 'Leaving it blank only works for looking at your own card.')] }).catch(() => {});
  }
  // Nobody on Discord, but XP is being held for the Roblox account they named.
  // That is an answer, not a failure, so it gets its own reply rather than
  // "couldn't find them".
  if (!targets.length && unlinked.length) {
    return interaction.editReply({ embeds: [waitingEmbed(unlinked, problems)] }).catch(() => {});
  }
  if (!targets.length) {
    return interaction.editReply({ embeds: [fail('Couldn\'t find them',
      problems.length
        ? `No MET member matched: ${problems.map(p => `\`${short(p, 30)}\``).join(', ')}.\n\n`
          + 'Try @-mentioning them instead — the picker inserts a real mention, which always resolves.'
        : 'Nobody was named.')] }).catch(() => {});
  }

  // ── Permission, only when actually changing something ──
  if (changing) {
    const access = await canManageXp({ discordId: interaction.user.id, roleIds: issuerRoles, isAdmin });
    if (!access.ok) {
      return interaction.editReply({
        embeds: [new EmbedBuilder().setColor(COLOR.fail)
          .setTitle(`${e('met_denied')} Not authorised`)
          .setDescription(access.why)],
      }).catch(() => {});
    }
    // Awarding yourself XP isn't a thing, however senior you are.
    if (targets.some(t => t.discordId === interaction.user.id)) {
      return interaction.editReply({ embeds: [fail('Not on yourself',
        'You can\'t change your own XP. Ask somebody else to.')] }).catch(() => {});
    }
    return runChange({ interaction, targets, problems, action, value, reason, access, guild, draw, working });
  }

  // ── Just looking ──
  await draw(working(`Reading ${targets.length === 1 ? 'the record' : `${targets.length} records`}…`));
  const officers = [];
  for (const t of targets) officers.push(await loadOfficer(t.discordId, guild));

  const embed = officers.length === 1
    ? await buildCard(officers[0], interaction.client)
    : buildTable(officers, interaction.client);
  if (problems.length) {
    embed.addFields({
      name: 'Not found',
      value: `${e('met_warn')} ${problems.map(p => `\`${short(p, 30)}\``).join(', ')} — skipped.`,
      inline: false,
    });
  }
  if (unlinked.length) {
    embed.addFields({
      name: 'Waiting for a Discord account',
      value: unlinked.map(u => waitingLine(u)).join('\n'),
      inline: false,
    });
  }
  await interaction.editReply({ embeds: [embed] }).catch(() => {});
}

/**
 * Why somebody has no XP standing — and it is not always the same reason.
 *
 * It used to always say "their MET rank isn't one the XP ladder covers", which is
 * wrong and confusing for the commonest case by far: somebody who is not in MET at
 * all. The ladder has nothing to do with it; there is no rank to place.
 *
 * Three genuinely different situations, three answers:
 *   no Roblox link   nothing can be looked up, so nothing can be said
 *   not in the group they are not a MET officer
 *   unplaceable rank they are, at a rank above or outside the ladder
 */
function unrankedLine(o) {
  if (!o.robloxId) {
    return `${e('met_warn')} No Roblox account is linked to them, so their MET rank cannot be `
      + `looked up. They need to verify with RoVer or log into the dashboard once.`;
  }
  if (!o.groupRole) {
    return `${e('met_note')} They are not in the MET group, so there is no rank to place them on `
      + `the XP ladder. Nothing is wrong — XP is for serving officers.`;
  }
  const name = (o.groupRole && o.groupRole.name) ? short(o.groupRole.name, 40) : 'their rank';
  return `${e('met_warn')} **${name}** is not a rank the XP ladder covers, so they have no XP `
    + `standing yet. Giving them any XP places them.`;
}

/** One Roblox account with XP held for it. */
function waitingLine(u) {
  return `${e('met_hourglass')} `
    + (u.robloxId
      ? `[${short(u.username, 30)}](https://www.roblox.com/users/${u.robloxId}/profile)`
      : `\`${short(u.username, 30)}\``)
    + ` — **${u.xp} XP**`
    + (u.claimed ? ' *(already given to their account)*' : ' waiting');
}

/**
 * A card for Roblox accounts that have XP but no Discord account.
 *
 * The XP is real and it is theirs; there is simply nowhere to put it until they
 * verify. Saying that plainly beats "couldn't find them", which reads as though
 * the number does not exist.
 */
function waitingEmbed(unlinked, problems) {
  const embed = new EmbedBuilder()
    .setColor(COLOR.card)
    .setTitle(`${e('met_hourglass')} ${unlinked.length === 1
      ? 'Not in the server yet' : `${unlinked.length} not in the server yet`}`)
    .setDescription(unlinked.map(u => waitingLine(u)).join('\n')
      + '\n\nThis XP is held against the Roblox account. It goes onto their record '
      + 'the first time they verify with RoVer or log into the dashboard, so there '
      + 'is nothing to do now.');
  if (problems.length) {
    embed.addFields({
      name: 'Not found at all',
      value: `${e('met_warn')} ${problems.map(p => `\`${short(p, 30)}\``).join(', ')}`,
      inline: false,
    });
  }
  return embed;
}

// ── Changing XP ───────────────────────────────────────────────────
async function runChange({ interaction, targets, problems, action, value, reason, access, guild, draw, working }) {
  const issuerName = access.name || interaction.user.username;
  const states = new Map(targets.map(t => [t.discordId, { state: 'pending', note: '' }]));

  const board = () => [...states.entries()].map(([id, s]) => {
    const mark = s.state === 'done'    ? e('met_tick')
               : s.state === 'failed'  ? e('met_cross')
               : s.state === 'running' ? e('met_load2')
               : e('met_dot_off');
    return `${mark} <@${id}>${s.note ? ` — ${s.note}` : ''}`;
  }).join('\n');

  const verb = action === 'ADD' ? `Adding ${value} XP` : action === 'REMOVE' ? `Removing ${value} XP` : `Setting XP to ${value}`;

  await draw(working(`${verb}…`, board()));

  const results = [];
  for (const t of targets) {
    states.get(t.discordId).state = 'running';
    await draw(working(`${verb}…`, board()));

    try {
      const o = await loadOfficer(t.discordId, guild);

      const res = await XP.applyXp({
        discordId: t.discordId,
        kind: action, value,
        reason, issuedById: interaction.user.id, issuedBy: issuerName,
        robloxId: o.robloxId, robloxUsername: o.robloxUsername,
      });

      // The XP log — the permanent, public record. Best-effort: a log channel
      // problem must never make a successful award look failed.
      await xpLog.logChange({
        discordId: t.discordId,
        memberName: o.displayName,
        kind: action, delta: res.delta, before: res.before, after: res.after,
        reason, capped: res.capped, rank: res.rank,
        issuedById: interaction.user.id, issuedBy: issuerName,
      }).catch(() => null);

      // A change crosses a threshold in exactly one direction, never both.
      let promoted = null;
      let demoted  = null;
      if (res.promotion) {
        promoted = await promote({
          officer: o, promotion: res.promotion, xp: res.after,
          issuedById: interaction.user.id, issuedBy: issuerName,
        });
      } else if (res.demotion) {
        demoted = await demote({
          officer: o, demotion: res.demotion, xp: res.after, reason,
          issuedById: interaction.user.id, issuedBy: issuerName,
        });
      }

      const s = states.get(t.discordId);
      s.state = 'done';
      s.note = `**${res.before} → ${res.after}** XP`
        + (res.capped ? ' *(stopped at 0)*' : '')
        + (promoted ? ` · ${e('met_promote')} **${promoted.to.name}**` : '')
        + (demoted  ? ` · ${e('met_warn')} **${demoted.to.name}**` : '');
      results.push({ id: t.discordId, ok: true, res, promoted, demoted, officer: o });
    } catch (err) {
      const s = states.get(t.discordId);
      s.state = 'failed';
      s.note = short(err.message, 90);
      results.push({ id: t.discordId, ok: false, error: err.message });
    }
    await draw(working(`${verb}…`, board()));
  }

  // ── Settle ──
  const failed = results.filter(r => !r.ok);
  const promotions = results.filter(r => r.promoted);
  const demotions  = results.filter(r => r.demoted);

  const embed = new EmbedBuilder()
    .setColor(failed.length ? COLOR.partial : COLOR.done)
    .setTitle(failed.length
      ? `${e('met_warn')} ${verb} — ${results.length - failed.length} of ${results.length} done`
      : `${e('met_tick')} ${verb} — done`)
    .setDescription(board())
    .setFooter({ text: `Logged to #xp-logs by ${issuerName}` });

  if (reason) embed.addFields({ name: 'Reason', value: short(reason, 1000), inline: false });

  if (promotions.length) {
    embed.addFields({
      name: `${e('met_celebrate')} Promoted`,
      value: short(promotions.map(r =>
        `<@${r.id}> → **${r.promoted.to.name}**`
        + (r.promoted.group.ok ? '' : ` ${e('met_warn')} *(group rank not changed: ${short(r.promoted.group.reason, 60)})*`)
        + (r.promoted.dmSent ? '' : ` ${e('met_warn')} *(couldn't DM them)*`),
      ).join('\n'), 1000),
      inline: false,
    });
  }
  if (demotions.length) {
    embed.addFields({
      name: `${e('met_warn')} Demoted`,
      value: short(demotions.map(r =>
        `<@${r.id}> → **${r.demoted.to.name}**`
        + (r.demoted.group.ok ? '' : ` ${e('met_warn')} *(group rank not changed: ${short(r.demoted.group.reason, 60)})*`)
        + (r.demoted.dmSent ? '' : ` ${e('met_warn')} *(couldn't DM them)*`),
      ).join('\n'), 1000),
      inline: false,
    });
  }
  if (problems.length) {
    embed.addFields({
      name: 'Not found',
      value: `${e('met_warn')} ${problems.map(p => `\`${short(p, 30)}\``).join(', ')} — skipped, no XP changed for them.`,
      inline: false,
    });
  }

  await new Promise(r => setTimeout(r, 300));
  await interaction.editReply({ embeds: [embed] }).catch(() => {});
}

/**
 * Everything a promotion involves: move them in the Roblox group, tell them,
 * write it down, and post it to the XP log.
 *
 * The order matters. The group change and the DM are attempted first and their
 * outcome is recorded, so a promotion whose group rank didn't move is visible
 * in the log rather than silently half-done.
 */
async function promote({ officer, promotion, xp, issuedById, issuedBy }) {
  const { from, to } = promotion;

  const group = await XP.promoteInGroup(officer.robloxId, to);

  let dmSent = false;
  try {
    dmSent = await require('./bot').dmMemberNotice(officer.discordId, {
      color: 0xffc93c,
      title: `Congratulations — you've been promoted to ${to.name}`,
      description:
        `You've reached **${xp} XP** and made ${xpLog.rankIcon(to.name)} **${to.name}**.\n\n`
        + `**Previous rank:** ${from.name}\n`
        + (group.ok
          ? `**Roblox group:** updated to **${group.to}**\n`
          : `**Roblox group:** not updated yet (${group.reason}) — speak to High Command if it doesn't change shortly.\n`)
        + `\nKeep it up. Your full record is on the dashboard.`,
      appealUrl: `${(process.env.PUBLIC_BASE_URL || 'https://metia.uk').replace(/\/+$/, '')}/profile`,
      appealLabel: 'View my record',
    });
  } catch (err) { dmSent = false; }

  await XP.recordPromotion({
    discordId: officer.discordId, from, to,
    groupResult: group, issuedById, issuedBy,
  }).catch(() => {});

  await xpLog.logPromotion({
    discordId: officer.discordId,
    memberName: officer.displayName,
    from, to, xp,
    progress: XP.progress(xp),
    groupResult: group, dmSent,
    avatar: officer.avatar,
  }).catch(() => null);

  return { from, to, group, dmSent };
}

/**
 * Everything a demotion involves — the mirror of promote().
 *
 * The DM is written to be plain rather than punitive. Somebody chose to take
 * the XP off and gave a reason; the officer is entitled to know what happened
 * and what it would take to get back, not to be told off by a bot.
 */
async function demote({ officer, demotion, xp, reason, issuedById, issuedBy }) {
  const { from, to } = demotion;

  const group = await XP.demoteInGroup(officer.robloxId, to);
  const p = XP.progress(xp);

  let dmSent = false;
  try {
    dmSent = await require('./bot').dmMemberNotice(officer.discordId, {
      color: 0xe8842a,
      title: `Your rank has changed — you are now ${to.name}`,
      description:
        `Your XP was adjusted to **${xp}**, which puts you at ${xpLog.rankIcon(to.name)} **${to.name}**.\n\n`
        + `**Previous rank:** ${from.name}\n`
        + (reason ? `**Reason for the change:** ${String(reason).slice(0, 600)}\n` : '')
        + (group.ok
          ? `**Roblox group:** set to **${group.to}**\n`
          : `**Roblox group:** unchanged (${group.reason})\n`)
        + (p.next ? `\nYou need **${p.need}** more XP to reach **${p.next.name}** again.` : '')
        + `\n\nIf you think this is wrong, speak to High Command — every XP change is logged with who made it.`,
      appealUrl: `${(process.env.PUBLIC_BASE_URL || 'https://metia.uk').replace(/\/+$/, '')}/profile`,
      appealLabel: 'View my record',
    });
  } catch (err) { dmSent = false; }

  await XP.recordDemotion({
    discordId: officer.discordId, from, to,
    groupResult: group, issuedById, issuedBy,
  }).catch(() => {});

  await xpLog.logDemotion({
    discordId: officer.discordId,
    memberName: officer.displayName,
    from, to, xp, progress: p,
    groupResult: group, dmSent, reason, issuedById,
    avatar: officer.avatar,
  }).catch(() => null);

  return { from, to, group, dmSent };
}

module.exports = {
  buildCommand, handleXpCommand,
  resolveTargets, loadOfficer, buildCard, buildTable, buildLeaderboard, showLeaderboard,
  canManageXp, xpRoleIds, promote, demote,
};
