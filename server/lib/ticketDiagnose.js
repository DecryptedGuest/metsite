// server/lib/ticketDiagnose.js
// One answer to "why did nothing appear in the tickets channel?".
//
// The pipeline is: Tickety posts a close log in a SOURCE channel → the bot reads
// it → a row is stored → a review card is posted to the DESTINATION channel. Six
// things can stop that, they fail in different places, and each one used to
// surface as its own unrelated line in a deploy log (or as nothing at all).
//
// This walks the whole path and reports each step as pass or fail with the fix,
// so the answer is one screen rather than an archaeology exercise.
const prisma = require('./db');

const ok   = (step, detail) => ({ step, ok: true,  detail });
const bad  = (step, detail, fix) => ({ step, ok: false, detail, fix });

/** Can the bot see this channel, and do what it needs to there? */
async function checkChannel(client, channelId, { post = false, label }) {
  if (!channelId) {
    return bad(label, 'no channel id is configured', 'set the channel id');
  }
  let channel;
  try {
    channel = await client.channels.fetch(String(channelId));
  } catch (err) {
    const missing = /Missing Access|50001/i.test(err.message);
    return bad(label, `${channelId} · ${err.message}`,
      missing
        ? 'the bot is not in that server, or cannot see that channel · re-invite it and give it View Channel'
        : 'check the channel id is right and the channel still exists');
  }
  if (!channel) return bad(label, `${channelId} · not found`, 'check the channel id');

  // Permissions, specifically. A channel the bot can FETCH is not necessarily
  // one it can post in, and "the card silently did not appear" is what that
  // looks like from the outside.
  const me = channel.guild && channel.guild.members
    ? (channel.guild.members.me || await channel.guild.members.fetchMe().catch(() => null))
    : null;
  const perms = me && channel.permissionsFor ? channel.permissionsFor(me) : null;
  if (perms) {
    const need = post ? ['ViewChannel', 'SendMessages', 'EmbedLinks'] : ['ViewChannel', 'ReadMessageHistory'];
    const lacks = need.filter(p => !perms.has(p));
    if (lacks.length) {
      return bad(label, `#${channel.name} · missing ${lacks.join(', ')}`,
        `give the bot ${lacks.join(' + ')} in that channel`);
    }
  }
  return ok(label, `#${channel.name} in "${channel.guild ? channel.guild.name : 'unknown'}"`);
}

/**
 * Walk the whole ticket pipeline.
 * Read-only: nothing is posted, nothing is written.
 */
async function diagnose(client) {
  const out = { ok: true, checks: [], facts: {} };
  const add = (c) => { out.checks.push(c); if (!c.ok) out.ok = false; };

  if (!client) {
    add(bad('Discord', 'the bot is not connected', 'wait for it to come online, then run this again'));
    return out;
  }

  const ingest = require('./ticketIngest');
  const cards  = require('./iaReviewCards');

  // 1. The SOURCE channels: where Tickety posts its close logs.
  for (const src of ingest.ticketSources()) {
    add(await checkChannel(client, src.channelId, {
      post: false, label: `Read ${src.division} ticket logs`,
    }));
  }

  // 2. The DESTINATION channels: where review cards go. A different server, and
  //    that is exactly the distinction that gets lost.
  add(await checkChannel(client, cards.ticketsChannelId(), { post: true, label: 'Post ticket cards' }));
  add(await checkChannel(client, cards.casesChannelId(),   { post: true, label: 'Post case cards' }));

  // 3. Message Content. Without it every log parses as "not a ticket log",
  //    which looks exactly like an empty channel.
  const intents = client.options && client.options.intents;
  const hasMC = intents && typeof intents.has === 'function' ? intents.has('MessageContent') : null;
  add(hasMC === false
    ? bad('Message Content intent', 'not requested · embeds from Tickety will be empty',
        'enable Message Content for the bot in the Discord Developer Portal')
    : ok('Message Content intent', hasMC === null ? 'could not be checked' : 'requested'));

  // 4. The carding line. Anything closed before it is stored but not queued,
  //    which is the one "working as intended" reason for a missing card.
  try {
    const line = await ingest.cardingStartedAt();
    out.facts.cardsStartFrom = line.toISOString();
    add(ok('Cards start from', `${line.toISOString()} · anything closed before this is stored, not queued`));
  } catch (err) {
    add(bad('Cards start from', err.message, 'check the database connection'));
  }

  // 5. What is actually in the table, so "it never arrived" can be told apart
  //    from "it arrived and was not carded".
  try {
    const [total, pending, uncarded, latest] = await Promise.all([
      prisma.ticketLog.count(),
      prisma.ticketLog.count({ where: { status: 'PENDING', voidedAt: null } }),
      prisma.ticketLog.count({ where: { status: 'PENDING', voidedAt: null, cardMessageId: null } }),
      prisma.ticketLog.findFirst({
        orderBy: { closedAt: 'desc' },
        select: { ticketNo: true, ticketName: true, closedAt: true, closerUsername: true,
                  cardMessageId: true, division: true, status: true },
      }),
    ]);
    out.facts.total = total;
    out.facts.pending = pending;
    out.facts.uncarded = uncarded;
    out.facts.latest = latest;
    add(ok('Stored tickets', `${total} total · ${pending} pending · ${uncarded} pending with no card`));
    if (latest) {
      add(ok('Most recent close', `#${latest.ticketNo ?? '?'} ${latest.ticketName || ''} `
        + `closed ${new Date(latest.closedAt).toISOString()} by ${latest.closerUsername || 'nobody named'}`
        + ` · ${latest.cardMessageId ? 'carded' : 'NOT carded'}`));
    } else {
      add(bad('Most recent close', 'the table is empty · no ticket log has ever been read',
        'check the source channel above, and that Message Content is enabled'));
    }
  } catch (err) {
    add(bad('Stored tickets', err.message, 'check the database connection'));
  }

  return out;
}

module.exports = { diagnose };
