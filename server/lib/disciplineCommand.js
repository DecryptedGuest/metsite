// server/lib/disciplineCommand.js
// The /discipline panel — the bit the issuer actually sees.
//
// Three screens, all ephemeral, all in the same message:
//
//   1. LOOKING UP   a spinner while we pull their record, their MET rank and
//                   their Roblox link
//   2. REVIEW       everything we found, what the action resolved to (a strike
//                   escalates here), and exactly what Confirm will do
//   3. APPLYING     a step tracker that fills in as each side effect lands,
//                   then settles into a green (or amber) summary
//
// The review screen is the point of the whole thing. Discipline is not
// undoable in any meaningful sense — the officer gets a DM the moment it
// lands — so the command shows its work and asks before it does anything.
//
// The animation is driven by real work, not a timer: each edit happens when a
// step actually finishes, with a small floor so a fast step still reads as a
// frame rather than a flicker. That keeps it well inside Discord's edit rate
// limit no matter how slow or fast the Roblox API is being.

const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');

const { e } = require('./emoji');
const { ACTION_CONFIG } = require('./actions');
const D = require('./discipline');
const { canDiscipline } = require('./disciplineAccess');

const COLOR = {
  working: 0x4a8fff,
  review:  0xf5b730,
  done:    0x2ed896,
  partial: 0xf5b730,
  fail:    0xf04f5e,
};

// Discord caps a slash command at 25 choices; we have well under that.
function buildCommand() {
  return new SlashCommandBuilder()
    .setName('discipline')
    .setDescription('Issue a disciplinary action to a MET officer')
    .addUserOption(o => o
      .setName('officer').setDescription('The officer being disciplined').setRequired(true))
    .addStringOption(o => o
      .setName('action').setDescription('What to issue — "Strike" picks the right number for you').setRequired(true)
      .addChoices(...D.COMMAND_ACTIONS.map(a => ({ name: a, value: a }))))
    .addStringOption(o => o
      .setName('reason').setDescription('Why — this is shown to the officer and on the log').setRequired(true)
      .setMaxLength(900))
    .addStringOption(o => o
      .setName('notes').setDescription('Anything else for the log (optional)').setMaxLength(900))
    .addStringOption(o => o
      .setName('case').setDescription('Case link or reference, if there is one (optional)').setMaxLength(300))
    .addIntegerOption(o => o
      .setName('days').setDescription('Length in days — only used by Zero Tolerance and Suspension')
      .setMinValue(1).setMaxValue(3650))
    .toJSON();
}

// ── Pending confirmations ─────────────────────────────────────────
// Held between the review screen and the Confirm button. Keyed by a nonce that
// goes in the button's customId, and scoped to the issuer so a leaked id can't
// be pressed by somebody else.
const pending = new Map();
const PENDING_TTL = 12 * 60 * 1000;   // an interaction token is good for 15 min

function stash(data) {
  const key = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  pending.set(key, { at: Date.now(), data });
  // Cheap sweep — this map is never big, and it beats holding a timer.
  for (const [k, v] of pending) if (Date.now() - v.at > PENDING_TTL) pending.delete(k);
  return key;
}
function take(key, issuerId) {
  const hit = pending.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > PENDING_TTL) { pending.delete(key); return null; }
  if (hit.data.issuerDiscordId !== issuerId) return null;
  pending.delete(key);
  return hit.data;
}

// ── Rendering ─────────────────────────────────────────────────────
const SPIN = ['met_load1', 'met_load2', 'met_load3', 'met_load4'];
const spinner = i => e(SPIN[i % SPIN.length]);

const STEP_LABELS = {
  lookup:  'Reading their record',
  record:  'Recording the punishment',
  role:    'Applying the Discord role',
  group:   'Updating their MET group rank',
  log:     'Posting to the administrative log',
  notify:  'Notifying the officer',
};

// One line per step. `states` maps a step key to 'pending' | 'running' | 'done'
// | 'failed', `details` to the short note each finished step returns.
function renderSteps(keys, states, details, frame) {
  return keys.map(k => {
    const st = states[k] || 'pending';
    const mark = st === 'done'    ? e('met_tick')
               : st === 'failed'  ? e('met_cross')
               : st === 'running' ? spinner(frame)
               : e('met_dot_off');
    const note = details[k] ? ` — ${details[k]}` : '';
    const label = st === 'pending' ? `*${STEP_LABELS[k] || k}*` : `${STEP_LABELS[k] || k}`;
    return `${mark} ${label}${st === 'done' || st === 'failed' ? note : ''}`;
  }).join('\n');
}

function short(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Their record as the issuer needs to read it: where they stand on the strike
// ladder first, then the entries behind it.
//
// The standing line is not decoration. A strike handed out by hand exists only
// as a Discord role, so the entry list below can be empty while the officer is
// plainly on Strike 3 — and "Clean — nothing on record" sitting under "already
// on Strike 3" would read as a contradiction. Saying where the level came from
// resolves it.
function recordSummary(record, strike) {
  const lines = [];
  const level = strike && strike.level ? strike.level : 0;
  if (level) {
    lines.push(`${e('met_strike' + level)} **On Strike ${level}** — ${short((strike.sources || []).join('; '), 200) || 'source unknown'}`);
  }
  if (!record.entries.length) {
    lines.push(level ? '*Nothing else on file.*' : `${e('met_tick')} Clean — nothing on record.`);
    return lines.join('\n');
  }
  for (const en of record.entries) {
    const when = en.at ? `<t:${Math.floor(new Date(en.at).getTime() / 1000)}:d>` : 'unknown date';
    const ref  = en.ref ? ` · ${short(en.ref, 40)}` : '';
    lines.push(`${en.active ? e('met_warn') : e('met_dot_off')} **${short(en.type, 40)}** — ${when}${ref}`);
  }
  const more = record.total - record.entries.length;
  if (more > 0) lines.push(`*…and ${more} more*`);
  return lines.join('\n');
}

// ── The command ───────────────────────────────────────────────────
async function handleDisciplineCommand(interaction) {
  await interaction.deferReply({ flags: 64 });   // 64 = ephemeral

  const issuer = interaction.user;
  const issuerRoles = interaction.member && interaction.member.roles && interaction.member.roles.cache
    ? [...interaction.member.roles.cache.keys()]
    : [];

  const lookupStates = { lookup: 'running' };
  await interaction.editReply({
    embeds: [new EmbedBuilder()
      .setColor(COLOR.working)
      .setTitle(`${spinner(0)} Checking…`)
      .setDescription(renderSteps(['lookup'], lookupStates, {}, 0))],
  }).catch(() => {});

  // Authorisation.
  const access = await canDiscipline(issuer.id, issuerRoles);
  if (!access.ok) {
    return interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(COLOR.fail)
        .setTitle(`${e('met_denied')} Not authorised`)
        .setDescription(access.why || 'This command is for Internal Affairs and Deputy Commissioner and above.')],
    }).catch(() => {});
  }

  const target    = interaction.options.getUser('officer');
  const choice    = interaction.options.getString('action');
  const reason    = interaction.options.getString('reason');
  const notes     = interaction.options.getString('notes');
  const caseLink  = interaction.options.getString('case');
  const days      = interaction.options.getInteger('days');

  if (target.bot) {
    return interaction.editReply({
      embeds: [new EmbedBuilder().setColor(COLOR.fail)
        .setTitle(`${e('met_cross')} That's a bot`)
        .setDescription('Pick an officer.')],
    }).catch(() => {});
  }
  if (target.id === issuer.id) {
    return interaction.editReply({
      embeds: [new EmbedBuilder().setColor(COLOR.fail)
        .setTitle(`${e('met_cross')} You can't discipline yourself`)
        .setDescription('Ask somebody else.')],
    }).catch(() => {});
  }

  // Everything we need about the target, gathered in parallel — the Roblox
  // calls are the slow part and none of them depend on each other.
  const member = interaction.guild
    ? await interaction.guild.members.fetch(target.id).catch(() => null)
    : null;
  const targetRoleIds = member ? [...member.roles.cache.keys()] : [];

  const roblox = require('./roblox');
  const [strike, record, robloxId] = await Promise.all([
    D.currentStrikeLevel({ discordId: target.id, roleIds: targetRoleIds }),
    D.loadRecord(target.id),
    roblox.getRobloxIdFromDiscord(target.id).catch(() => null),
  ]);
  const [info, avatar, metRole] = await Promise.all([
    robloxId ? roblox.getRobloxUserInfo(robloxId).catch(() => null) : null,
    robloxId ? roblox.getRobloxAvatarHeadshot(robloxId).catch(() => null) : null,
    robloxId ? require('./metRank').metRole(robloxId).catch(() => null) : null,
  ]);

  const resolved = D.resolveAction(choice, strike.level);

  // Already on Strike 3 and they asked for another. We refuse to guess what
  // comes after the last strike — that's a call for a person to make.
  if (resolved.capped) {
    return interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(COLOR.review)
        .setTitle(`${e('met_strike3')} Already on Strike ${D.MAX_STRIKE}`)
        .setDescription(
          `**${short(member ? member.displayName : target.username, 60)}** already holds `
          + `**Disciplinary Strike ${strike.level}**, so there is no higher strike to escalate to.\n\n`
          + `Run the command again and pick the action you actually want — `
          + `**Termination**, **Blacklist** or **Suspension** — so it's on the record as a decision, not an automatic step.`)
        .addFields({ name: 'Their record', value: short(recordSummary(record, strike), 1000) })],
    }).catch(() => {});
  }

  const action = resolved.action;
  const cfg = ACTION_CONFIG[action] || {};

  // Review screen.
  const displayName = member ? member.displayName : target.username;
  const effects = D.plannedEffects(action, { hasRoblox: !!robloxId, durationDays: days });

  const actionLine = resolved.escalated
    ? `**${action}**\n${e('met_rank')} Escalated automatically — they already had **Strike ${resolved.from}**.`
    : resolved.to && choice === D.AUTO_STRIKE
      ? `**${action}**\n${e('met_tick')} First strike — nothing else on record.`
      : `**${action}**`;

  const embed = new EmbedBuilder()
    .setColor(COLOR.review)
    .setTitle(`${e('met_gavel')} Review before issuing`)
    .setDescription(
      `${e('met_user')} **Officer** <@${target.id}>`
      + (info ? ` · [${info.username}](https://www.roblox.com/users/${robloxId}/profile)` : ' · *no Roblox account linked*')
      + (metRole ? `\n${e('met_rank')} **MET rank** ${metRole.name}` : ''))
    .addFields(
      { name: 'Action',  value: actionLine, inline: false },
      { name: 'Reason',  value: short(reason, 1000), inline: false },
      ...(notes ? [{ name: 'Notes', value: short(notes, 1000), inline: false }] : []),
      { name: 'Case',    value: caseLink ? short(caseLink, 300) : '*Not linked — direct action*', inline: false },
      { name: 'Their record', value: short(recordSummary(record, strike), 1000), inline: false },
      { name: 'Confirming will', value: effects.map(f => `${e('met_dot_on')} ${f.text}`).join('\n'), inline: false },
    )
    .setFooter({ text: `Issued by ${access.label}${access.name ? ` · ${access.name}` : ''}` });
  if (avatar) embed.setThumbnail(avatar);

  // Warn about the two things that quietly do nothing.
  const caveats = [];
  if (!cfg.roleId && action !== 'Demotion' && action !== 'Termination') {
    caveats.push(`${e('met_warn')} No Discord role is configured for **${action}** — it will be recorded and logged, but no role is added.`);
  }
  if (!robloxId && (cfg.exile || action === 'Demotion')) {
    caveats.push(`${e('met_warn')} **${action}** needs a linked Roblox account and this officer has none — the group change will be skipped and has to be done by hand.`);
  }
  if (cfg.timed && !days) {
    caveats.push(`${e('met_warn')} **${action}** is a timed punishment and no **days** was given — it will not expire on its own.`);
  }
  if (caveats.length) embed.addFields({ name: 'Worth knowing', value: short(caveats.join('\n'), 1000), inline: false });

  const key = stash({
    action, reason, notes, caseLink,
    durationDays: cfg.timed ? days : null,
    targetDiscordId: target.id,
    targetRobloxId: robloxId || null,
    targetName: info ? info.username : null,
    targetAvatar: avatar || null,
    targetDisplay: displayName,
    issuerDiscordId: issuer.id,
    issuerName: `${access.name || issuer.username}${access.label ? ` (${access.label})` : ''}`,
    escalated: resolved.escalated, from: resolved.from,
  });

  await interaction.editReply({
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`disc_go_${key}`).setLabel(`Issue ${action}`).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`disc_no_${key}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    )],
  }).catch(() => {});
}

// ── Confirm / cancel ──────────────────────────────────────────────
async function handleDisciplineButton(interaction) {
  const id = interaction.customId;
  const key = id.slice('disc_go_'.length);

  if (id.startsWith('disc_no_')) {
    take(id.slice('disc_no_'.length), interaction.user.id);
    return interaction.update({
      embeds: [new EmbedBuilder().setColor(0x8fa3bd)
        .setTitle(`${e('met_cross')} Cancelled`)
        .setDescription('Nothing was issued.')],
      components: [],
    }).catch(() => {});
  }
  if (!id.startsWith('disc_go_')) return;

  const job = take(key, interaction.user.id);
  if (!job) {
    return interaction.update({
      embeds: [new EmbedBuilder().setColor(COLOR.fail)
        .setTitle(`${e('met_warn')} This panel has expired`)
        .setDescription('Run `/discipline` again — nothing was issued.')],
      components: [],
    }).catch(() => {});
  }

  // Which steps this action will actually run, so the tracker doesn't show a
  // group step for a warning.
  const cfg = ACTION_CONFIG[job.action] || {};
  const keys = ['record'];
  if (cfg.roleId) keys.push('role');
  if (job.targetRobloxId && (cfg.exile || job.action === 'Demotion')) keys.push('group');
  keys.push('log', 'notify');

  const states = Object.fromEntries(keys.map(k => [k, 'pending']));
  const details = {};
  let frame = 0;
  let lastEdit = 0;

  const draw = async (title, color) => {
    frame++;
    // A floor between edits: a step that finishes in 20ms would otherwise be
    // gone before it rendered, and back-to-back edits are the only way this
    // could hit a rate limit.
    const wait = 420 - (Date.now() - lastEdit);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastEdit = Date.now();
    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(renderSteps(keys, states, details, frame))
        .setFooter({ text: `${job.action} → ${job.targetDisplay}` })],
      components: [],
    }).catch(() => {});
  };

  await interaction.update({
    embeds: [new EmbedBuilder().setColor(COLOR.working)
      .setTitle(`${spinner(0)} Issuing ${job.action}…`)
      .setDescription(renderSteps(keys, states, details, 0))],
    components: [],
  }).catch(() => {});
  lastEdit = Date.now();

  const result = await D.applyDiscipline({
    ...job,
    onStep: async (step, state, detail) => {
      states[step] = state;
      if (detail) details[step] = short(detail, 90);
      await draw(`${spinner(frame)} Issuing ${job.action}…`, COLOR.working);
    },
  });

  // Settle.
  const failed = Object.entries(result.steps).filter(([, v]) => !v.ok).map(([k]) => k);
  // A failed DM is not a failed punishment — plenty of people have DMs closed.
  const realFailure = failed.some(k => k !== 'notify');

  const finalEmbed = new EmbedBuilder()
    .setColor(realFailure ? COLOR.partial : COLOR.done)
    .setTitle(realFailure
      ? `${e('met_warn')} ${job.action} issued — with problems`
      : `${e('met_tick')} ${job.action} issued`)
    .setDescription(
      `${e('met_user')} **<@${job.targetDiscordId}>**`
      + (job.escalated ? `\n${e('met_rank')} Escalated from **Strike ${job.from}**.` : '')
      + `\n\n${renderSteps(keys, states, details, frame)}`)
    .setFooter({ text: result.punishmentId ? `Record ${result.punishmentId.slice(0, 8)}` : 'Not recorded' });

  if (failed.includes('notify') && !realFailure) {
    finalEmbed.addFields({
      name: 'Note',
      value: `${e('met_warn')} They could not be DM'd (their DMs are closed). Everything else went through — tell them another way.`,
    });
  }
  if (realFailure) {
    finalEmbed.addFields({
      name: 'What to do',
      value: result.warnings.map(w => `${e('met_cross')} ${short(w, 200)}`).join('\n').slice(0, 1000)
        + `\n\nThe punishment ${result.punishmentId ? 'IS' : 'is NOT'} on their record. Fix the failing step by hand.`,
    });
  }

  await new Promise(r => setTimeout(r, 300));
  await interaction.editReply({ embeds: [finalEmbed], components: [] }).catch(() => {});
}

module.exports = { buildCommand, handleDisciplineCommand, handleDisciplineButton };
