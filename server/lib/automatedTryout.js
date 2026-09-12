'use strict';

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const prisma = require('./db');

const LOG_CHANNEL = () =>
  process.env.AUTOMATED_TRYOUT_LOG_CHANNEL_ID
  || process.env.HPC_TRYOUT_LOG_CHANNEL_ID
  || null;

const RANKER_ROLE = () => process.env.TRYOUT_RANKER_ROLE_ID || '1426660644093952281';
const HPC_GROUP   = () => String(require('./divisions').explicitGroupId('HPC') || '35685825');
const MET_GROUP   = () => String(require('./divisions').metGroupId());
const INSTRUCTOR_MIN_RANK = () => Number(process.env.HPC_INSTRUCTOR_MIN_RANK || 100);
const CREST = () => process.env.MET_CREST_URL || null;

const RESULT = {
  passed: { label: 'Passed', colour: 0x3ECF8E },
  failed: { label: 'Failed', colour: 0xF0616F },
  kicked: { label: 'Removed', colour: 0xE5A03F },
};

function safe(v, max) {
  const s = v == null ? '' : String(v);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function stamp(v) {
  const t = v instanceof Date ? v.getTime() : (v ? Date.parse(v) : NaN);
  return Number.isFinite(t) ? `<t:${Math.floor(t / 1000)}:f>` : 'unknown';
}

function parseJson(text) {
  try { const o = JSON.parse(text || '{}'); return (o && typeof o === 'object') ? o : {}; }
  catch (e) { return {}; }
}

function viewFromRow(row, payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const pa = (p.attendee && typeof p.attendee === 'object') ? p.attendee : {};
  return {
    id: row.id,
    division: row.division,
    hostName: row.hostName,
    coHostName: row.coHostName,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    attendee: {
      userId: row.attendeeRobloxId,
      username: row.attendeeName,
      result: row.result,
      strikes: row.strikes,
      quizScore: row.quizScore,
      quizTotal: row.quizTotal,
      flags: Array.isArray(pa.flags) ? pa.flags
           : (row.flags ? String(row.flags).split(',').map(f => f.trim()).filter(Boolean) : []),
      strikeReasons: Array.isArray(pa.strikeReasons) ? pa.strikeReasons : [],
      failReason: pa.failReason || null,
    },
  };
}

function buildEmbed(row, actioned) {
  const a = row.attendee || {};
  const key = String(a.result || 'failed').toLowerCase();
  const meta = RESULT[key] || RESULT.failed;

  const e = new EmbedBuilder()
    .setTitle(`${row.division || 'HPC'} entrance tryout`)
    .setColor(actioned && actioned.kind === 'reject' ? 0x6A7076 : meta.colour)
    .addFields(
      { name: 'Trainee', value: a.username ? `${safe(a.username, 40)}\n\`${safe(a.userId, 20)}\`` : 'unknown', inline: true },
      { name: 'Result', value: meta.label, inline: true },
      { name: 'Quiz', value: (a.quizScore != null && a.quizTotal != null) ? `${a.quizScore} of ${a.quizTotal}` : 'not taken', inline: true },
      { name: 'Host', value: row.hostName || 'INSTRUCTOR', inline: true },
      { name: 'Co host', value: row.coHostName || 'none', inline: true },
      { name: 'Strikes', value: String(a.strikes == null ? 0 : a.strikes), inline: true },
    );

  const reasons = Array.isArray(a.strikeReasons) ? a.strikeReasons.filter(Boolean) : [];
  if (reasons.length) {
    e.addFields({ name: 'Strike reasons', value: safe(reasons.map(r => `• ${r}`).join('\n'), 1000) });
  }
  if (a.failReason) e.addFields({ name: 'Fail reason', value: safe(a.failReason, 500) });

  const flags = Array.isArray(a.flags) ? a.flags.filter(Boolean) : [];
  if (flags.length) e.addFields({ name: 'Flags', value: safe(flags.join(', '), 200) });

  e.addFields({ name: 'Ran', value: `${stamp(row.startedAt)} to ${stamp(row.endedAt)}` });

  if (actioned) {
    e.addFields({
      name: actioned.kind === 'approve' ? 'Ranked by' : 'Rejected by',
      value: `<@${actioned.byId}>${actioned.reason ? `\n${safe(actioned.reason, 300)}` : ''}`,
    });
  }

  if (CREST()) e.setThumbnail(CREST());
  e.setFooter({ text: 'Automated tryout' });
  e.setTimestamp(new Date());
  return e;
}

function buildRow(id, disabled) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`atr_ok_${id}`).setLabel('Approve and rank')
      .setStyle(ButtonStyle.Success).setDisabled(!!disabled),
    new ButtonBuilder().setCustomId(`atr_no_${id}`).setLabel('Reject')
      .setStyle(ButtonStyle.Danger).setDisabled(!!disabled),
  );
}

async function mayRank(interaction) {
  if (interaction.member && interaction.member.roles && interaction.member.roles.cache) {
    if (interaction.member.roles.cache.has(RANKER_ROLE())) return true;
  }
  try {
    const user = await prisma.user.findFirst({
      where: { discordId: String(interaction.user.id) },
      select: { robloxId: true, role: true },
    });
    if (user && user.role === 'DEVELOPER') return true;
    if (user && user.robloxId) {
      const { getUserGroupRole } = require('./roblox');
      const r = await getUserGroupRole(String(user.robloxId), HPC_GROUP());
      if (r && Number(r.rank) >= INSTRUCTOR_MIN_RANK()) return true;
    }
  } catch (e) { /* fall through to refusal */ }
  return false;
}

async function post(row, payload) {
  const view = payload === undefined ? row : viewFromRow(row, payload);
  const bot = require('./bot');
  const channelId = LOG_CHANNEL();
  if (!channelId) return { posted: false, why: 'no automated tryout log channel is configured' };
  const client = bot.getClient && bot.getClient();
  if (!client) return { posted: false, why: 'the bot is not connected' };

  const passed = String(view.attendee && view.attendee.result).toLowerCase() === 'passed';
  try {
    const ch = await client.channels.fetch(channelId);
    const msg = await ch.send({
      embeds: [buildEmbed(view, null)],
      components: passed ? [buildRow(view.id, false)] : [],
    });
    return { posted: true, messageId: msg.id, channelId };
  } catch (e) {
    return { posted: false, why: e.message };
  }
}

async function handleButton(interaction) {
  const id = interaction.customId || '';
  const approve = id.startsWith('atr_ok_');
  const reject = id.startsWith('atr_no_');
  if (!approve && !reject) return false;
  const logId = id.slice(7);

  if (!(await mayRank(interaction))) {
    await interaction.reply({
      content: 'Only tryout rankers and HPC instructors can action this.',
      flags: 64,
    }).catch(() => {});
    return true;
  }

  const row = await prisma.automatedTryout.findUnique({ where: { id: logId } }).catch(() => null);
  if (!row) {
    await interaction.reply({ content: 'That tryout record no longer exists.', flags: 64 }).catch(() => {});
    return true;
  }
  if (row.actionedById) {
    await interaction.reply({
      content: `Already actioned by <@${row.actionedById}>.`,
      flags: 64,
    }).catch(() => {});
    return true;
  }

  await interaction.deferUpdate().catch(() => {});

  const claim = await prisma.automatedTryout.updateMany({
    where: { id: logId, actionedById: null },
    data: {
      actionedById: String(interaction.user.id),
      actionedAt: new Date(),
      actionKind: approve ? 'approve' : 'reject',
    },
  }).catch(() => null);

  if (!claim) {
    await interaction.followUp({
      content: 'Could not record that just now. Nothing was changed, so please try again.',
      flags: 64,
    }).catch(() => {});
    return true;
  }
  if (claim.count !== 1) {
    const now = await prisma.automatedTryout.findUnique({ where: { id: logId } }).catch(() => null);
    await interaction.followUp({
      content: now && now.actionedById
        ? `Already actioned by <@${now.actionedById}>.`
        : 'That tryout record no longer exists.',
      flags: 64,
    }).catch(() => {});
    return true;
  }

  let note = null;
  if (approve) {
    try {
      const { changeGroupRank, listGroupRoles } = require('./roblox');
      const cookie = process.env.ROBLOX_COOKIE || process.env.ROBLOX_GROUP_COOKIE || null;
      const roles = await listGroupRoles(MET_GROUP(), cookie);
      const want = String(process.env.MET_ENTRY_RANK_NAME || 'PCSO').toLowerCase();
      const role = (roles || []).find(r => String(r.name || '').toLowerCase().includes(want));
      if (!role) throw new Error('the entry rank was not found in the MET group');
      const r = await changeGroupRank(String(row.attendeeRobloxId), role.id, MET_GROUP(), cookie);
      if (r && r.ok === false) throw new Error(r.reason || 'the rank change was rejected');
      note = `Ranked to ${role.name}.`;
    } catch (e) {
      await prisma.automatedTryout.updateMany({
        where: { id: logId, actionedById: String(interaction.user.id) },
        data: { actionedById: null, actionedAt: null, actionKind: null },
      }).catch(() => {});
      await interaction.followUp({
        content: `Could not rank them: ${e.message}. Nothing was recorded, so you can try again.`,
        flags: 64,
      }).catch(() => {});
      return true;
    }
  }

  const saved = await prisma.automatedTryout.findUnique({ where: { id: logId } }).catch(() => null);
  const view = viewFromRow(saved || row, parseJson((saved || row).payload));
  await interaction.message.edit({
    embeds: [buildEmbed(view, { kind: approve ? 'approve' : 'reject', byId: interaction.user.id, reason: note })],
    components: [buildRow(logId, true)],
  }).catch(() => {});

  await interaction.followUp({
    content: approve ? `Done. ${note || ''}`.trim() : 'Marked as not actioned.',
    flags: 64,
  }).catch(() => {});
  return true;
}

module.exports = { post, handleButton, buildEmbed, buildRow, viewFromRow, LOG_CHANNEL };
