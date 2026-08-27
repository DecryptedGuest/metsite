const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, MessageFlags } = require('discord.js');
const prisma = require('../lib/db');
const { env } = require('../lib/env');
const { isDeveloper, DENIED } = require('../lib/perms');
const { e, startLoading } = require('../lib/emoji');
const { parseCaseCard } = require('../lib/caseParser');
const roblox = require('../lib/roblox');

const data = new SlashCommandBuilder()
  .setName('sync')
  .setDescription('[DEV] Rebuild the case record from channel history')
  .addSubcommand(s => s.setName('cases').setDescription('[DEV] Scan the cases channel and store every case found')
    .addChannelOption(o => o.setName('channel').setDescription('Channel to scan (default: CASES_CHANNEL_ID)'))
    .addIntegerOption(o => o.setName('limit').setDescription('Stop after this many messages').setMinValue(1).setMaxValue(50000))
    .addBooleanOption(o => o.setName('dry').setDescription('Report only — write nothing'))
    .addBooleanOption(o => o.setName('force').setDescription('Re-parse and overwrite cases already synced')))
  .addSubcommand(s => s.setName('status').setDescription('[DEV] What is currently stored'));

/**
 * Walk a channel's history newest→oldest in pages of 100.
 * Yields messages so the caller can stream progress rather than buffering
 * tens of thousands of them.
 */
async function* iterateHistory(channel, limit) {
  let before, seen = 0;
  while (seen < limit) {
    const batch = await channel.messages.fetch({ limit: Math.min(100, limit - seen), ...(before && { before }) });
    if (!batch.size) return;
    for (const msg of batch.values()) { yield msg; seen++; }
    before = batch.last().id;
    if (batch.size < 100) return;
  }
}

/** Best-effort: resolve the subject named on a legacy card to a Roblox account. */
async function resolveSubject(parsed, guild) {
  const out = { discordId: null, robloxUserId: null, robloxUsername: null };
  if (parsed.submittedByMention) {
    // NOTE: on the legacy cards this is the SUBMITTER, not the subject — kept
    // only so the filer can be credited. The subject comes from the document.
    out.filerDiscordId = parsed.submittedByMention;
  }
  // The nickname convention gives us a Roblox username to try.
  const raw = parsed.submittedByRaw || '';
  const nameGuess = raw.split('|').pop()?.trim();
  if (nameGuess && /^[A-Za-z0-9_]{3,20}$/.test(nameGuess)) {
    const u = await roblox.getRobloxIdFromUsername(nameGuess).catch(() => null);
    if (u) { out.robloxUserId = u.id; out.robloxUsername = u.name; }
  }
  return out;
}

async function execute(interaction) {
  if (!isDeveloper(interaction.member)) {
    return interaction.reply({ content: DENIED, flags: MessageFlags.Ephemeral });
  }
  const sub = interaction.options.getSubcommand();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (sub === 'status') {
    const [cases, synced, pending, approved, denied, tickets, awards, pendingAwards, failedAwards, counter] =
      await Promise.all([
        prisma.case.count(),
        prisma.case.count({ where: { syncedAt: { not: null } } }),
        prisma.case.count({ where: { status: 'PENDING' } }),
        prisma.case.count({ where: { status: 'APPROVED' } }),
        prisma.case.count({ where: { status: 'DENIED' } }),
        prisma.ticket.count(),
        prisma.quotaAward.count(),
        prisma.quotaAward.count({ where: { status: 'PENDING' } }),
        prisma.quotaAward.count({ where: { status: 'FAILED' } }),
        prisma.caseCounter.findUnique({ where: { id: 1 } }).catch(() => null),
      ]);
    const highest = await prisma.case.findFirst({ orderBy: { createdAt: 'desc' }, select: { caseRef: true } });

    return interaction.editReply({ embeds: [new EmbedBuilder()
      .setColor(0x4a8fff)
      .setTitle(`${e('DB')} Stored record`)
      .addFields(
        { name: 'Cases', value: `**${cases}** total\n${synced} synced from history`, inline: true },
        { name: 'By status', value: `${e('PENDING')} ${pending}\n${e('APPROVE')} ${approved}\n${e('DENY')} ${denied}`, inline: true },
        { name: 'Tickets', value: `**${tickets}**`, inline: true },
        { name: 'Quota awards', value: `**${awards}** total\n${pendingAwards} pending · ${failedAwards} failed`, inline: true },
        { name: 'Counter', value: `next case = #${(counter?.count ?? 0) + 1}`, inline: true },
        { name: 'Latest', value: highest?.caseRef || '*none*', inline: true },
      )] });
  }

  // ── sync cases ──────────────────────────────────────────────────
  const channel = interaction.options.getChannel('channel')
    || await interaction.client.channels.fetch(env('CASES_CHANNEL_ID')).catch(() => null);
  if (!channel?.messages) {
    return interaction.editReply(`${e('DENY')} No readable channel — pass one, or set \`CASES_CHANNEL_ID\`.`);
  }

  const limit = interaction.options.getInteger('limit') || 5000;
  const dry   = interaction.options.getBoolean('dry')   || false;
  const force = interaction.options.getBoolean('force') || false;

  const loader = startLoading(interaction, dry ? 'Scanning (dry run)' : 'Syncing cases');
  const stats = { scanned: 0, parsed: 0, created: 0, updated: 0, skipped: 0, unparsed: 0, punishments: 0 };
  const problems = [];
  const seenRefs = new Set();

  try {
    for await (const msg of iterateHistory(channel, limit)) {
      stats.scanned++;
      if (stats.scanned % 50 === 0) {
        loader.update(`${stats.scanned} messages · ${stats.parsed} cases found · ${stats.created + stats.updated} written`);
      }

      const parsed = parseCaseCard(msg);
      if (!parsed) { if (msg.embeds?.length) stats.unparsed++; continue; }
      stats.parsed++;

      // Cards get edited on approval, so the same case can appear twice.
      // History runs newest-first, so the first sighting is the freshest.
      if (seenRefs.has(parsed.caseRef)) { stats.skipped++; continue; }
      seenRefs.add(parsed.caseRef);

      if (!parsed.punishments.length) {
        problems.push(`${parsed.caseRef}: no punishments could be read`);
      }
      if (!parsed.docUrl) {
        problems.push(`${parsed.caseRef}: no case document link`);
      }
      stats.punishments += parsed.punishments.length;

      if (dry) continue;

      const existing = await prisma.case.findUnique({ where: { caseRef: parsed.caseRef } });
      if (existing && !force) { stats.skipped++; continue; }

      const subject = await resolveSubject(parsed, interaction.guild);
      const bl = parsed.punishments.find(p => p.code);
      const actions = parsed.punishments.map(p => ({
        action: p.action,
        roleId: require('../lib/actions').roleIdForAction(p.action),
        durationDays: p.durationDays || null,
        ...(p.code ? { code: p.code } : {}),
      }));

      const payload = {
        caseRef: parsed.caseRef,
        submitterDiscordId: subject.filerDiscordId || 'UNKNOWN_SYNCED',
        robloxUserId:   subject.robloxUserId,
        robloxUsername: subject.robloxUsername,
        action:  actions.map(a => a.action).join(', ') || 'Unknown',
        actions,
        reason:  `Synced from ${channel.name}`,
        notes:   parsed.templateOnly.length
          ? `Unfilled template rows on the card: ${parsed.templateOnly.map(t => t.action).join(', ')}`
          : 'N/A',
        caseLink: parsed.docUrl,
        docUrl:   parsed.docUrl,
        blacklistCode:   bl?.code || null,
        blacklistReason: bl?.codeReason || null,
        pointsAwarded:   parsed.pointsAwarded,
        status: parsed.status,
        reviewedByRaw: parsed.reviewedByRaw,
        reviewedAt: parsed.status === 'PENDING' ? null : (parsed.postedAt || new Date()),
        sourceMessageId: parsed.sourceMessageId,
        sourceUrl: parsed.sourceUrl,
        syncedAt: new Date(),
        syncNotes: problems.filter(p => p.startsWith(parsed.caseRef)).join('; ') || null,
        createdAt: parsed.postedAt || undefined,
      };

      if (existing) {
        await prisma.case.update({ where: { id: existing.id }, data: payload });
        stats.updated++;
      } else {
        await prisma.case.create({ data: payload });
        stats.created++;
      }
    }

    // Keep the counter ahead of everything synced, so new cases never collide.
    if (!dry && seenRefs.size) {
      const highest = Math.max(...[...seenRefs].map(r => Number(r.replace('#', '')) || 0));
      const counter = await prisma.caseCounter.findUnique({ where: { id: 1 } }).catch(() => null);
      if (!counter || counter.count < highest) {
        await prisma.caseCounter.upsert({
          where: { id: 1 }, update: { count: highest }, create: { id: 1, count: highest },
        });
      }
    }
  } catch (err) {
    loader.stop();
    return interaction.editReply(`${e('DENY')} Sync failed after ${stats.scanned} messages: ${err.message}`);
  } finally {
    loader.stop();
  }

  const embed = new EmbedBuilder()
    .setColor(problems.length ? 0xf5b730 : 0x2ed896)
    .setTitle(`${e('SYNC')} ${dry ? 'Dry run' : 'Sync'} complete`)
    .setDescription(`Scanned **${stats.scanned}** messages in ${channel}.`)
    .addFields(
      { name: 'Cases found',  value: String(stats.parsed), inline: true },
      { name: 'Created',      value: dry ? '—' : String(stats.created), inline: true },
      { name: 'Updated',      value: dry ? '—' : String(stats.updated), inline: true },
      { name: 'Skipped',      value: String(stats.skipped), inline: true },
      { name: 'Punishments',  value: String(stats.punishments), inline: true },
      { name: 'Embeds unread', value: String(stats.unparsed), inline: true },
    )
    .setFooter({ text: dry ? 'Nothing was written — re-run without dry' : 'Case counter advanced past the highest ref' })
    .setTimestamp();

  if (problems.length) {
    embed.addFields({
      name: `${e('WARNING')} Needs a look (${problems.length})`,
      value: problems.slice(0, 8).join('\n').slice(0, 1000) + (problems.length > 8 ? `\n…and ${problems.length - 8} more` : ''),
    });
  }

  const files = [];
  if (problems.length > 8) {
    files.push(new AttachmentBuilder(Buffer.from(problems.join('\n'), 'utf8'), { name: 'sync-problems.txt' }));
  }
  return interaction.editReply({ content: '', embeds: [embed], files });
}

module.exports = { data, execute };
