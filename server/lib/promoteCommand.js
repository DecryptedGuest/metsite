// server/lib/promoteCommand.js
// /promote — move somebody up exactly one rank in the MET group.
//
// The XP system promotes automatically when somebody crosses a threshold, and
// /discipline demotes. Between them there was no way to simply promote a person
// — the one thing supervisors do most often — without opening Roblox.
//
// One rank up, deliberately. Not "to a rank you pick": a picker invites
// mistakes (a wrong click is four promotions at once) and the group ladder has
// plenty of rungs that are not ordinary member ranks. The next rung up is
// unambiguous, and doing it twice is two commands.
//
// What it will not do:
//   · promote past the ceiling. PROMOTE_MAX_RANK (default: below the first
//     High Command rank) is a hard stop, because handing out High Command from
//     a slash command is not a supervisor's decision.
//   · promote somebody at or above the person running it. You cannot make
//     somebody your equal or your senior.
//   · promote somebody it cannot read the current rank of — no guessing.
//
// XP follows the rank rather than the other way round, so a promotion here
// re-seeds their XP to the floor of the new rank. Otherwise a Constable
// promoted to Sergeant by hand keeps 2 XP and gets congratulated on making
// Sergeant again the moment they reach 15.

const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');

const { e } = require('./emoji');
const XP = require('./xp');

const COLOR = { review: 0x4a8fff, working: 0x4a8fff, done: 0x2ed896, fail: 0xf04f5e, warn: 0xf5b730 };
const TTL_MS = 14 * 60 * 1000;

function short(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function buildCommand() {
  return new SlashCommandBuilder()
    .setName('promote')
    .setDescription('Promote an officer')
    .addUserOption(o => o
      .setName('officer')
      .setDescription('Who')
      .setRequired(true))
    .addStringOption(o => o
      .setName('reason')
      .setDescription('Why')
      .setMaxLength(300))
    .toJSON();
}

// ── The ladder ────────────────────────────────────────────────────
// Roles the group has that are NOT ordinary member ranks — a promotion must
// never step into one of these by accident.
const NOT_A_RANK = /^-+$|guest|^member$|banned|blacklist|suspended|awaiting|^n\/?a$/i;

// The ceiling. Nothing at or above this rank number can be reached with
// /promote; PROMOTE_MAX_RANK pins it, otherwise it is discovered as "one below
// the first High Command rank".
const HICOMM_NAMES = /deputy commissioner|assistant commissioner|\bcommissioner\b|chief of|commander[- ]in[- ]chief/i;

/**
 * Every promotable rank in the MET group, lowest first.
 * @returns {Promise<Array<{id, name, rank}>>}
 */
async function promotableRanks() {
  const { getGroupRolesPublic } = require('./roblox');
  const { metGroupId } = require('./divisions');
  const roles = await getGroupRolesPublic(metGroupId());
  return (roles || [])
    .filter(r => Number(r.rank) > 0 && !NOT_A_RANK.test(String(r.name || '').trim()))
    .sort((a, b) => Number(a.rank) - Number(b.rank));
}

/** The highest rank number /promote is allowed to reach. */
function ceilingFor(ranks) {
  const pinned = parseInt(process.env.PROMOTE_MAX_RANK || '', 10);
  if (Number.isFinite(pinned)) return pinned;
  const firstHicomm = ranks.find(r => HICOMM_NAMES.test(String(r.name || '')));
  // One below the first High Command rank. With no High Command rank found at
  // all, fall back to the top of the ladder rather than refusing everything.
  return firstHicomm ? Number(firstHicomm.rank) - 1 : Number((ranks[ranks.length - 1] || {}).rank || 0);
}

/**
 * Work out the promotion, without performing it.
 *
 * @param {object} current   their live group role { id, name, rank }
 * @param {number|null} issuerRank  the rank of whoever is running the command
 * @returns {Promise<{ok, from, to, why, ceiling}>}
 */
async function planPromotion(current, issuerRank) {
  if (!current || current.rank == null) {
    return { ok: false, why: 'Their MET group rank could not be read, so there is nothing to promote from.' };
  }

  let ranks;
  try { ranks = await promotableRanks(); }
  catch (err) { return { ok: false, why: `The MET group's ranks could not be read (${err.message}).` }; }
  if (!ranks.length) return { ok: false, why: "The MET group returned no ranks — refusing to guess at one." };

  const ceiling = ceilingFor(ranks);
  const from = ranks.find(r => Number(r.rank) === Number(current.rank))
    || { id: null, name: current.name, rank: Number(current.rank) };
  const to = ranks.find(r => Number(r.rank) > Number(current.rank));

  if (!to) return { ok: false, from, ceiling, why: `**${from.name}** is the top of the ladder — there is nothing above it.` };
  if (Number(to.rank) > ceiling) {
    return { ok: false, from, to, ceiling,
      why: `The next rank up is **${to.name}**, which is High Command. `
        + `/promote stops below that — a promotion into High Command is not a slash-command decision.` };
  }
  if (issuerRank != null && Number(to.rank) >= Number(issuerRank)) {
    return { ok: false, from, to, ceiling,
      why: `That would make them **${to.name}**, which is at or above your own rank. `
        + `You can't promote somebody to your level or past it.` };
  }
  return { ok: true, from, to, ceiling, why: null };
}

// ── Pending confirmations ─────────────────────────────────────────
const pending = new Map();   // token → { ... , at }

function keep(state) {
  const token = Math.random().toString(36).slice(2, 10);
  pending.set(token, { ...state, at: Date.now() });
  if (pending.size > 200) {
    for (const [k, v] of pending) if (Date.now() - v.at > TTL_MS) pending.delete(k);
  }
  return token;
}
function recall(token) {
  const s = pending.get(token);
  if (!s) return null;
  if (Date.now() - s.at > TTL_MS) { pending.delete(token); return null; }
  return s;
}

// ── The command ───────────────────────────────────────────────────
async function handlePromoteCommand(interaction) {
  await interaction.deferReply({ flags: 64 });   // 64 = ephemeral

  const target = interaction.options.getUser('officer');
  const reason = interaction.options.getString('reason');

  const fail = (title, body) => new EmbedBuilder()
    .setColor(COLOR.fail).setTitle(`${e('met_cross')} ${title}`).setDescription(body);

  if (target.bot) {
    return interaction.editReply({ embeds: [fail("That's a bot", 'Pick an officer.')] }).catch(() => {});
  }

  // Permission: the same people who may move XP may promote. Both are "this
  // person's standing in the MET changes", and splitting them would mean two
  // lists to keep in step.
  const roleIds = interaction.member && interaction.member.roles && interaction.member.roles.cache
    ? [...interaction.member.roles.cache.keys()] : [];
  const isAdmin = !!(interaction.memberPermissions
    && typeof interaction.memberPermissions.has === 'function'
    && interaction.memberPermissions.has(require('discord.js').PermissionFlagsBits.Administrator));
  const access = await require('./xpCommand').canManageXp({
    discordId: interaction.user.id, roleIds, isAdmin,
  });
  if (!access.ok) {
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLOR.fail)
      .setTitle(`${e('met_denied')} Not authorised`)
      .setDescription('Promoting is for FLP officers, Deputy Commissioner and above, and server administrators.')],
    }).catch(() => {});
  }

  if (target.id === interaction.user.id) {
    return interaction.editReply({ embeds: [fail('Not yourself', 'Ask somebody else to.')] }).catch(() => {});
  }

  const [link, issuerLink] = await Promise.all([
    require('./robloxLink').resolveRoblox(target.id).catch(() => ({ robloxId: null, username: null })),
    require('./robloxLink').resolveRoblox(interaction.user.id).catch(() => ({ robloxId: null })),
  ]);
  if (!link.robloxId) {
    return interaction.editReply({ embeds: [fail('No Roblox account',
      `<@${target.id}> has no Roblox account we can find — verify them with RoVer, or have them log into the MET Dashboard once, and try again.`)],
    }).catch(() => {});
  }

  const metRank = require('./metRank');
  const [current, issuerRole, avatar] = await Promise.all([
    metRank.metRole(link.robloxId).catch(() => null),
    issuerLink.robloxId ? metRank.metRole(issuerLink.robloxId).catch(() => null) : null,
    require('./roblox').getRobloxAvatarHeadshot(link.robloxId).catch(() => null),
  ]);

  // A server administrator promoting without being in the group themselves is
  // fine — the "not above you" rule only applies when we know their rank.
  const issuerRank = issuerRole && issuerRole.rank != null ? Number(issuerRole.rank) : null;

  const plan = await planPromotion(current, issuerRank);
  if (!plan.ok) {
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLOR.warn)
      .setTitle(`${e('met_warn')} Can't promote them`)
      .setDescription(plan.why)
      .setFooter({ text: current ? `Currently ${current.name}` : 'MET rank unknown' })],
    }).catch(() => {});
  }

  const icon = n => require('./rankEmoji').forRank(interaction.client, n, e('met_rank'));
  const token = keep({
    ownerId: interaction.user.id,
    targetId: target.id,
    robloxId: String(link.robloxId),
    username: link.username || null,
    from: plan.from, to: plan.to, reason: reason || null,
    issuerName: access.name || (interaction.member && interaction.member.displayName) || interaction.user.username,
    avatar,
  });

  const embed = new EmbedBuilder()
    .setColor(COLOR.review)
    .setTitle(`${e('met_promote')} Promote`)
    .setDescription(
      `${e('met_user')} <@${target.id}>`
      + (link.username ? ` · [${short(link.username, 30)}](https://www.roblox.com/users/${link.robloxId}/profile)` : ''))
    .addFields(
      { name: 'From', value: `${icon(plan.from.name)} ${short(plan.from.name, 40)}`, inline: true },
      { name: 'To',   value: `${icon(plan.to.name)} ${short(plan.to.name, 40)}`, inline: true },
      ...(reason ? [{ name: 'Reason', value: short(reason, 500), inline: false }] : []),
      { name: 'This will', value: [
        `${e('met_dot_on')} Set their MET group rank to **${plan.to.name}**`,
        `${e('met_dot_on')} Move their XP to the floor of that rank`,
        `${e('met_dot_on')} DM them, and post it to the XP log`,
      ].join('\n'), inline: false },
    )
    .setFooter({ text: `By ${access.name || interaction.user.username}${access.label ? ` · ${access.label}` : ''}` });
  if (avatar) embed.setThumbnail(avatar);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`prom_go_${token}`).setLabel(`Promote to ${short(plan.to.name, 40)}`).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`prom_no_${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );

  return interaction.editReply({ embeds: [embed], components: [row] }).catch(() => {});
}

// ── Confirmation ──────────────────────────────────────────────────
async function handlePromoteButton(interaction) {
  const m = String(interaction.customId || '').match(/^prom_(go|no)_([a-z0-9]+)$/i);
  if (!m) return;
  const [, verb, token] = m;

  const state = recall(token);
  if (!state) {
    return interaction.update({
      embeds: [new EmbedBuilder().setColor(COLOR.warn)
        .setTitle(`${e('met_warn')} This has expired`)
        .setDescription('Run `/promote` again — nothing was changed.')],
      components: [],
    }).catch(() => {});
  }
  if (String(state.ownerId) !== String(interaction.user.id)) {
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(COLOR.fail)
        .setTitle(`${e('met_denied')} Not yours`)
        .setDescription('Run `/promote` to open your own.')],
      flags: 64,
    }).catch(() => {});
  }

  if (verb === 'no') {
    pending.delete(token);
    return interaction.update({
      embeds: [new EmbedBuilder().setColor(COLOR.fail)
        .setTitle(`${e('met_cross')} Cancelled`)
        .setDescription('Nothing was changed.')],
      components: [],
    }).catch(() => {});
  }

  // One press only.
  pending.delete(token);
  await interaction.update({
    embeds: [new EmbedBuilder().setColor(COLOR.working)
      .setTitle(`${e('met_load2')} Promoting…`)
      .setDescription(`<@${state.targetId}> → **${state.to.name}**`)],
    components: [],
  }).catch(() => {});

  const result = await applyPromotion(state, interaction.client);

  const line = (ok, text) => `${ok ? e('met_tick') : e('met_cross')} ${text}`;
  const embed = new EmbedBuilder()
    .setColor(result.group.ok ? COLOR.done : COLOR.fail)
    .setTitle(`${result.group.ok ? e('met_promote') : e('met_cross')} ${result.group.ok ? 'Promoted' : 'Promotion failed'}`)
    .setDescription(`${e('met_user')} <@${state.targetId}>`
      + (state.username ? ` · ${short(state.username, 30)}` : ''))
    .addFields(
      { name: 'Rank', value: `${short(state.from.name, 40)} → **${short(state.to.name, 40)}**`, inline: false },
      { name: 'Steps', value: [
        line(result.group.ok, `MET group rank — ${result.group.ok ? `now **${state.to.name}**` : short(result.group.reason || 'failed', 90)}`),
        line(result.xp.ok, `XP — ${result.xp.ok ? `set to **${result.xp.value}**` : short(result.xp.reason || 'unchanged', 90)}`),
        line(result.dm, result.dm ? 'Officer notified' : "Couldn't DM them — their DMs are closed"),
        line(result.logged, result.logged ? 'Posted to the XP log' : 'XP log not posted'),
      ].join('\n'), inline: false },
    )
    .setFooter({ text: `By ${state.issuerName}` });
  if (state.avatar) embed.setThumbnail(state.avatar);

  return interaction.editReply({ embeds: [embed], components: [] }).catch(() => {});
}

/**
 * Do it. Never throws — a failure in one step is reported on that step and the
 * rest still run, so a Roblox hiccup doesn't leave the XP and the DM in limbo.
 */
async function applyPromotion(state, client) {
  const out = {
    group: { ok: false, reason: null },
    xp: { ok: false, value: null, reason: null },
    dm: false, logged: false,
  };

  // 1. The group. Everything else describes this, so if it fails the rest is a
  //    lie and is skipped.
  try {
    await require('./roblox').changeGroupRank(
      state.robloxId, state.to.id, require('./divisions').metGroupId());
    out.group.ok = true;
  } catch (err) {
    out.group.reason = err.message;
    return out;
  }

  // 2. XP follows the rank. Set to the floor of the new rank so the next
  //    threshold they cross is the real next one.
  try {
    const rung = await XP.rungForGroupRank({ name: state.to.name, rank: state.to.rank });
    if (rung) {
      const res = await XP.applyXp({
        discordId: state.targetId, kind: 'SET', value: rung.at,
        reason: `Promoted to ${state.to.name}`,
        issuedBy: state.issuerName,
      });
      // Mark the rank as already reached, so the XP system doesn't announce a
      // promotion to a rank they were just given by hand.
      await XP.recordPromotion({
        discordId: state.targetId,
        from: XP.rankFor(res.before), to: rung,
        groupResult: { ok: true, to: state.to.name },
        issuedBy: state.issuerName,
      }).catch(() => {});
      out.xp = { ok: true, value: rung.at, reason: null };
    } else {
      out.xp.reason = 'that rank is not on the XP ladder';
    }
  } catch (err) {
    out.xp.reason = err.message;
  }

  // 3. Tell them.
  try {
    const base = (process.env.PUBLIC_BASE_URL || 'https://metia.uk').replace(/\/+$/, '');
    out.dm = await require('./bot').dmMemberNotice(state.targetId, {
      color: 0xffc93c,
      title: `Congratulations — you've been promoted to ${state.to.name}`,
      description:
        `You have been promoted from **${state.from.name}** to **${state.to.name}** in the Metropolitan Police.\n\n`
        + (state.reason ? `**Reason:** ${short(state.reason, 400)}\n` : '')
        + `**Promoted by:** ${short(state.issuerName, 60)}\n\n`
        + `Your rank and record are on the MET Dashboard.`,
      appealUrl: `${base}/profile`,
      appealLabel: 'View my record',
    });
  } catch (err) { out.dm = false; }

  // 4. And the log.
  try {
    const msg = await require('./xpLog').logPromotion({
      discordId: state.targetId,
      memberName: state.username,
      from: { name: state.from.name, at: null },
      to: { name: state.to.name, at: out.xp.value },
      xp: out.xp.value,
      groupResult: { ok: true, to: state.to.name },
      dmSent: out.dm,
      avatar: state.avatar,
      by: state.issuerName,
      reason: state.reason,
    });
    out.logged = !!msg;
  } catch (err) { out.logged = false; }

  return out;
}

module.exports = {
  buildCommand, handlePromoteCommand, handlePromoteButton,
  planPromotion, promotableRanks, ceilingFor, applyPromotion, keep, recall,
};
