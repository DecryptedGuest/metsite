// server/lib/submitCaseCommand.js
// /submit-case — file a disciplinary case from Discord.
//
// The case it writes is the SAME Case row the website writes, decided by the
// same reviewers through the same buttons (lib/iaReviewCards → lib/caseDecision).
// There is deliberately no second code path here: a case filed in Discord and a
// case filed on the site have to approve, pay and audit identically, and the
// only way to guarantee that is for them to be the same record.
//
// Case.userId is a foreign key to User, so filing needs a dashboard account.
// That is surfaced as its own message rather than a flat refusal, because "sign
// in once" is a fix and "not authorised" is not.
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const prisma = require('./db');
const { e } = require('./emoji');
const { ACTION_NAMES, parseActions, isTimed, roleIdForAction } = require('./actions');
const { generateCaseRef } = require('./caseRef');
const { HICOMM_ONLY_ACTIONS } = require('./iaRank');
const { resolveAuthority, canView } = require('./iaAuthority');
const cards = require('./iaReviewCards');
const roblox = require('./roblox');

function buildCommand() {
  return new SlashCommandBuilder()
    .setName('submit-case')
    .setDescription('File a disciplinary case for review')
    .addStringOption(o => o.setName('document').setDescription('Link to the case document').setRequired(true))
    .addStringOption(o => o.setName('punishments')
      .setDescription('Comma-separated punishments').setRequired(true).setAutocomplete(true))
    .addStringOption(o => o.setName('reason').setDescription('Summary of the misconduct').setRequired(true))
    .addUserOption(o => o.setName('subject').setDescription('The Discord member being punished'))
    .addStringOption(o => o.setName('roblox').setDescription("The subject's Roblox username"))
    .addIntegerOption(o => o.setName('duration').setDescription('Days, for a timed punishment').setMinValue(1))
    .addStringOption(o => o.setName('blacklist_code').setDescription('Blacklist code, e.g. PL-M304'))
    .addStringOption(o => o.setName('notes').setDescription('Anything else the reviewer should know'))
    .toJSON();
}

/** Suggest punishments as they are typed, keeping what has already been picked. */
async function handleAutocomplete(interaction) {
  const typed  = interaction.options.getFocused() || '';
  const parts  = typed.split(',');
  const prefix = parts.slice(0, -1).join(',').trim();
  const last   = (parts[parts.length - 1] || '').trim().toLowerCase();

  const choices = ACTION_NAMES
    .filter(a => a.toLowerCase().includes(last))
    .map(a => {
      const value = (prefix ? `${prefix}, ${a}` : a).slice(0, 100);
      // Say what a punishment will COST to approve before it is chosen, so the
      // filer is not surprised by a card nobody present can decide.
      const gate = HICOMM_ONLY_ACTIONS.includes(a) ? '  (High Command)' : '';
      return { name: `${a}${gate}`.slice(0, 100), value };
    })
    .slice(0, 25);

  await interaction.respond(choices).catch(() => {});
}

async function handleSubmitCase(interaction) {
  const subject    = interaction.options.getUser('subject');
  const robloxName = interaction.options.getString('roblox');
  const doc        = (interaction.options.getString('document') || '').trim();
  const rawActions = interaction.options.getString('punishments');

  // Everything that can be refused without a round-trip is refused first, so an
  // obvious typo comes back instantly instead of after three Roblox lookups.
  if (!subject && !robloxName) {
    return interaction.reply({ content: `${e('met_denied')} Give either a \`subject\` or a \`roblox\` username.`,
      flags: MessageFlags.Ephemeral });
  }
  if (!/^https?:\/\//i.test(doc)) {
    return interaction.reply({ content: `${e('met_denied')} \`document\` must be a link.`,
      flags: MessageFlags.Ephemeral });
  }
  const { actions, invalid } = parseActions(rawActions);
  if (invalid.length) {
    return interaction.reply({ content: `${e('met_denied')} Not a punishment: \`${invalid[0]}\`.`
      + ` Pick from: ${ACTION_NAMES.join(', ')}`, flags: MessageFlags.Ephemeral });
  }
  if (!actions.length) {
    return interaction.reply({ content: `${e('met_denied')} Pick at least one punishment.`,
      flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const auth = await resolveAuthority(interaction);
  const view = canView(auth);
  if (!view.allowed) return interaction.editReply(`${e('met_denied')} ${view.reason}`);
  if (!auth.userId) {
    return interaction.editReply(`${e('met_warn')} Sign in to the MET Dashboard once with Discord, then file this again.`
      + ' A case has to be recorded against an account, and you do not have one yet.');
  }

  // Resolve the subject's Roblox identity. Best-effort: a case against somebody
  // whose account cannot be resolved is still a case worth filing.
  let robloxUserId = null;
  let robloxUsername = robloxName || null;
  try {
    if (subject) {
      robloxUserId = await roblox.getRobloxIdFromDiscord(subject.id);
      if (robloxUserId) {
        const info = await roblox.getRobloxUserInfo(robloxUserId);
        robloxUsername = (info && (info.name || info.username)) || robloxUsername;
      }
    } else if (robloxName) {
      const u = await roblox.getRobloxIdFromUsername(robloxName);
      if (u) { robloxUserId = u.id; robloxUsername = u.name || u.username || robloxUsername; }
    }
  } catch (err) { /* keep whatever was typed */ }

  const duration = interaction.options.getInteger('duration');
  const blCode   = interaction.options.getString('blacklist_code');
  // A duration only attaches to a punishment that HAS one. Storing it on a
  // warning is what once turned "Strike(s) [2]" into a two-day strike.
  const enriched = actions.map(a => ({
    action: a,
    roleId: roleIdForAction(a),
    durationDays: isTimed(a) ? (duration || null) : null,
    ...(a === 'Blacklist' && blCode ? { code: blCode } : {}),
  }));

  let created;
  try {
    created = await prisma.case.create({
      data: {
        caseRef: await generateCaseRef(),
        userId: auth.userId,
        officerDiscordId: subject ? subject.id : null,
        robloxUserId: robloxUserId ? String(robloxUserId) : null,
        robloxUsername,
        action: enriched.map(a => a.action).join(', '),
        actions: enriched,
        reason: interaction.options.getString('reason'),
        notes:  interaction.options.getString('notes') || 'N/A',
        caseLink: doc,
        investigatorDiscordUsername: interaction.user.username,
        status: 'PENDING',
      },
    });
  } catch (err) {
    return interaction.editReply(`${e('met_cross')} Could not file the case: ${err.message}`);
  }

  await prisma.caseAction.create({
    data: {
      caseId: created.id, actionType: 'CREATED',
      performedBy: auth.userId, notes: 'Submitted via /submit-case',
    },
  }).catch(() => {});

  // The card. Losing it must never undo the record, so a failure here downgrades
  // the reply rather than throwing: the case exists and is visible on the site.
  let messageId = null;
  try {
    const filer = interaction.member || interaction.user;
    const avatar = robloxUserId ? await roblox.getRobloxAvatarHeadshot(robloxUserId).catch(() => null) : null;
    messageId = await cards.postCaseCard(interaction.client, created, { filer, subjectAvatar: avatar });
    if (messageId) {
      await prisma.case.update({ where: { id: created.id }, data: { cardMessageId: messageId } }).catch(() => {});
    }
  } catch (err) {
    console.warn('[IA] /submit-case card not posted:', err.message);
  }

  const needsHicomm = enriched.some(a => HICOMM_ONLY_ACTIONS.includes(a.action));
  const gate = needsHicomm ? 'High Command' : 'Supervisor and above';

  if (!messageId) {
    return interaction.editReply(`${e('met_warn')} Filed **${created.caseRef}**, but the review card could not be posted.`
      + ' Check `CASES_CHANNEL_ID` and that the bot can post there. The case is on the dashboard either way.');
  }
  return interaction.editReply(`${e('met_tick')} Filed **${created.caseRef}** and posted it for review.`
    + ` **${gate}** can decide it.`);
}

module.exports = { buildCommand, handleSubmitCase, handleAutocomplete };
