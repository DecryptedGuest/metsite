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
    .setDescription('See your XP and rank, or change somebody else\'s')
    .addStringOption(o => o
      .setName('officers')
      .setDescription('Who — @mention one or several. Leave blank for yourself.')
      .setMaxLength(900))
    .addStringOption(o => o
      .setName('action')
      .setDescription('Change their XP (leave blank to just look)')
      .addChoices(
        { name: 'add',    value: 'ADD' },
        { name: 'remove', value: 'REMOVE' },
        { name: 'set',    value: 'SET' },
      ))
    .addIntegerOption(o => o
      .setName('value')
      .setDescription('How much XP to add, remove, or set them to')
      .setMinValue(0).setMaxValue(1000000))
    .addStringOption(o => o
      .setName('reason')
      .setDescription('Why — goes on the XP log')
      .setMaxLength(500))
    .toJSON();
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

    // A Discord username / nickname in this server.
    if (guild) {
      try {
        const hits = await guild.members.fetch({ query: name, limit: 5 });
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
    if (!found) {
      try {
        const roblox = require('./roblox');
        const rid = await roblox.getRobloxIdFromUsername(name);
        const did = rid ? await roblox.getDiscordFromRoblox(rid) : null;
        if (did) found = { id: did, via: 'roblox' };
      } catch (err) { /* nothing more to try */ }
    }

    if (found) push(found.id, found.via);
    else problems.push(name);
  }

  return { targets: out.slice(0, MAX_TARGETS), problems, overflow: out.length > MAX_TARGETS };
}

/**
 * Everything the card needs about one officer: their Roblox identity, their
 * live MET group rank, and their XP row (seeded from that rank the first time
 * we see them, so a serving Inspector doesn't show as a Student Officer).
 */
async function loadOfficer(discordId, guild) {
  const roblox = require('./roblox');
  const member = guild ? await guild.members.fetch(discordId).catch(() => null) : null;

  let robloxId = null;
  try { robloxId = await roblox.getRobloxIdFromDiscord(discordId); } catch (err) { robloxId = null; }

  const [info, avatar, groupRole] = await Promise.all([
    robloxId ? roblox.getRobloxUserInfo(robloxId).catch(() => null) : null,
    robloxId ? roblox.getRobloxAvatarHeadshot(robloxId).catch(() => null) : null,
    robloxId ? require('./metRank').metRole(robloxId).catch(() => null) : null,
  ]);

  // Establish their baseline before anything reads it.
  await XP.seedFromRank(discordId, groupRole ? groupRole.name : null).catch(() => {});
  if (robloxId || (info && info.username)) {
    await XP.ensure(discordId, {
      robloxId: robloxId ? String(robloxId) : null,
      robloxUsername: info ? info.username : null,
    }).catch(() => {});
  }

  const row = await XP.getBalance(discordId);
  const xp = row ? row.xp : 0;

  return {
    discordId, member, robloxId,
    robloxUsername: info ? info.username : (row ? row.robloxUsername : null),
    displayName: member ? member.displayName : (info ? info.username : null),
    avatar, groupRole, row, xp,
    rank: XP.rankFor(xp),
    progress: XP.progress(xp),
  };
}

/** The stats card for one officer. */
async function buildCard(o) {
  const [hist, standing] = await Promise.all([
    XP.history(o.discordId, 5).catch(() => []),
    XP.standing(o.discordId).catch(() => ({ position: 0, total: 0 })),
  ]);

  const p = o.progress;
  const nextLine = p.next
    ? `${e('met_promote')} **${p.need}** more to **${p.next.name}** (${p.next.at} XP)`
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
      { name: 'XP',        value: `**${o.xp}**`, inline: true },
      { name: 'XP rank',   value: `**${o.rank.name}**`, inline: true },
      { name: 'Standing',  value: standing.total ? `**#${standing.position}** of ${standing.total}` : '—', inline: true },
      { name: 'Next rank', value: `${nextLine}\n${xpLog.progressBar(p)}`, inline: false },
      {
        name: 'MET group rank',
        value: o.groupRole
          ? `${e('met_rank')} ${o.groupRole.name}`
          : `${e('met_warn')} Not found — ${o.robloxId ? 'not in the MET group' : 'no linked Roblox account'}`,
        inline: false,
      },
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

/** A compact table when several officers were named at once. */
function buildTable(officers) {
  const lines = officers.map(o => {
    const p = o.progress;
    const tail = p.next ? `${p.need} to ${p.next.code}` : 'max';
    return `${e('met_user')} <@${o.discordId}> — **${o.xp}** XP · **${o.rank.name}** · *${tail}*`;
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
  const changing   = !!action;

  // Viewing is public; changing is ephemeral (the XP log is the public record).
  await interaction.deferReply(changing ? { flags: 64 } : {});

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
  if (rawTargets) {
    const r = await resolveTargets(rawTargets, guild);
    targets = r.targets;
    problems = r.problems;
  } else if (!changing) {
    targets = [{ discordId: interaction.user.id, via: 'self' }];
  }

  if (changing && !rawTargets) {
    return interaction.editReply({ embeds: [fail('Who?',
      'Name the officers whose XP you want to change — `officers:@someone`. '
      + 'Leaving it blank only works for looking at your own card.')] }).catch(() => {});
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

  const embed = officers.length === 1 ? await buildCard(officers[0]) : buildTable(officers);
  if (problems.length) {
    embed.addFields({
      name: 'Not found',
      value: `${e('met_warn')} ${problems.map(p => `\`${short(p, 30)}\``).join(', ')} — skipped.`,
      inline: false,
    });
  }
  await interaction.editReply({ embeds: [embed] }).catch(() => {});
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
        `You've reached **${xp} XP** and made **${to.name}**.\n\n`
        + `**Previous rank:** ${from.name}\n`
        + (group.ok
          ? `**Roblox group:** updated to **${group.to}**\n`
          : `**Roblox group:** not updated yet (${group.reason}) — speak to High Command if it doesn't change shortly.\n`)
        + `\nKeep it up. Your full record is on the portal.`,
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
        `Your XP was adjusted to **${xp}**, which puts you at **${to.name}**.\n\n`
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
  resolveTargets, loadOfficer, buildCard, buildTable, canManageXp,
};
