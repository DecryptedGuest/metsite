// server/lib/pendingJoinCommand.js
// /pendingjoin accept · /pendingjoin deny — the MET group's join-request queue,
// from Discord.
//
// The queue already exists in the developer panel. This puts it where the people
// who actually clear it are: a High Command member in the MET server, who wants
// to let one person in or empty the queue without opening a browser.
//
// Four things it takes seriously:
//
//   IT SHOWS PROGRESS. Clearing forty requests is forty Roblox calls, one after
//   another, and Discord shows nothing for the ten seconds that takes. So the
//   reply is a live embed: a spinner, a bar, a count, and the name it is on. An
//   unchanging "working…" is indistinguishable from a hang.
//
//   ONE FAILURE IS NOT ALL OF THEM. Roblox refuses individual requests — the
//   person cancelled, they were already accepted, the group is full. Each is
//   caught on its own, and the run carries on and reports which ones did not go
//   through and why.
//
//   IT NEVER GUESSES WHO. Accepting the wrong person is not undoable from here,
//   so a named user has to resolve to exactly one request in the queue. "It
//   looked like this one" is not good enough.
//
//   DENYING EVERYTHING ASKS FIRST. Accepting the whole queue is the day's work;
//   denying it throws away every application in one press, so that one is
//   confirmed by a button before anything happens.

const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  PermissionFlagsBits,
} = require('discord.js');
const { e } = require('./emoji');

const COLOUR = {
  working: 0x3c6eff,
  done:    0x2ed896,
  partial: 0xf5b730,
  fail:    0xf04f5e,
  ask:     0xf5b730,
};

// Frames drawn for this, in the manifest. Four is enough to read as motion and
// few enough that a slow edit does not look like a jump.
const SPIN = ['met_load1', 'met_load2', 'met_load3', 'met_load4'];
const spinner = (i) => e(SPIN[((i % SPIN.length) + SPIN.length) % SPIN.length]);

// How often the live embed may be redrawn. Discord rate-limits edits per
// message, and a redraw per person would spend the whole budget on animation and
// then start dropping the ones that matter — including the final result.
const REDRAW_MS = 1400;

// The most requests one command will resolve. A queue longer than this is a
// bigger job than a slash command should hold a reply open for; it says so and
// says how many are left.
const MAX_PER_RUN = () => {
  const n = parseInt(process.env.PENDING_JOIN_MAX_PER_RUN, 10);
  return Number.isFinite(n) && n > 0 ? n : 60;
};

const PENDING_TTL = 2 * 60 * 1000;   // a confirmation nobody presses expires
const pending = new Map();           // token → { at, issuerId, data }

function short(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** A progress bar somebody can read at a glance. */
function bar(done, total, width = 18) {
  if (!total) return '';
  const filled = Math.max(0, Math.min(width, Math.round((done / total) * width)));
  return '`' + '█'.repeat(filled) + '░'.repeat(width - filled) + '`';
}

// ── The command ───────────────────────────────────────────────────
function buildCommand() {
  const who = (opt) => opt
    .setName('user')
    .setDescription('The Roblox username or user ID whose request to decide. Leave empty and use all instead.')
    .setRequired(false);
  const every = (opt) => opt
    .setName('all')
    .setDescription('Do every request in the queue, not just one person.')
    .setRequired(false);

  return new SlashCommandBuilder()
    .setName('pendingjoin')
    .setDescription('Accept or deny people waiting to join the MET Roblox group')
    .addSubcommand(sub => sub
      .setName('accept')
      .setDescription('Let somebody into the MET group, or let everybody waiting in')
      .addStringOption(who)
      .addBooleanOption(every))
    .addSubcommand(sub => sub
      .setName('deny')
      .setDescription('Refuse somebody, or refuse everybody waiting')
      .addStringOption(who)
      .addBooleanOption(every))
    .addSubcommand(sub => sub
      .setName('list')
      .setDescription('Who is waiting, without deciding anything'));
}

/**
 * May this person decide who joins MET?
 *
 * Administrator, or MET High Command. Deliberately checked in code rather than
 * with a Discord permission bit: letting somebody into the group is a Roblox
 * action with no undo from here, and "can manage this server" is not the same
 * question as "may recruit".
 */
async function mayDecide(interaction) {
  try {
    if (interaction.memberPermissions
        && interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
      return { ok: true, via: 'administrator' };
    }
  } catch (err) { /* fall through to the rank test */ }

  try {
    const prisma = require('./db');
    const user = await prisma.user.findUnique({ where: { discordId: String(interaction.user.id) } });
    if (user) {
      const { userIsMetHicomm } = require('./metRank');
      // The MET roles they are wearing right now, so a role given a minute ago
      // counts. The stored snapshot can be a day old.
      const roleIds = interaction.member && interaction.member.roles && interaction.member.roles.cache
        ? [...interaction.member.roles.cache.keys()] : null;
      const withRoles = roleIds ? { ...user, metRoleIds: roleIds } : user;
      if (await userIsMetHicomm(withRoles)) return { ok: true, via: 'MET High Command' };
    }
    return { ok: false, why: 'Only MET High Command and server administrators can decide who joins the group.' };
  } catch (err) {
    console.error('[/pendingjoin] access check failed:', err.message);
    // A failed lookup is not permission.
    return { ok: false, why: 'Your access could not be checked just now — try again shortly.' };
  }
}

// ── Reading the queue ─────────────────────────────────────────────

/**
 * Every pending request, paged.
 *
 * A page that fails mid-way is an error, not "the rest of the queue is empty" —
 * treating it as empty would make "deny all" look like it had nothing to do.
 */
async function readQueue(max) {
  const R = require('./roblox');
  const gid = R.mainGroupId();
  const cookie = R.cookieForDivision('MET');
  const out = [];
  let token = null, pages = 0;
  do {
    const page = await R.listJoinRequests(token, gid, cookie);
    out.push(...page.requests);
    token = page.nextPageToken;
    pages++;
    // Enough to act on, plus one — no point paging 400 requests to resolve 60.
    // `more` then means "there are others we did not read", and NOTHING may
    // report what we did read as the size of the queue.
  } while (token && pages < 40 && out.length < max + 1);
  return { requests: out, more: !!token, gid, cookie };
}

/**
 * Find the one request a name refers to.
 *
 * Exact match on the id, then exact on the username, then a case-insensitive
 * pass. Anything ambiguous is refused rather than picked between: two people
 * whose names differ only in case is unlikely, and getting it wrong lets the
 * wrong person into the group.
 */
function findOne(requests, needle) {
  const want = String(needle || '').trim().replace(/^@/, '');
  if (!want) return { error: 'Say who — a Roblox username or user ID.' };

  const byId = requests.filter(r => r.userId === want);
  if (byId.length === 1) return { hit: byId[0] };

  const exact = requests.filter(r => r.username === want);
  if (exact.length === 1) return { hit: exact[0] };

  const loose = requests.filter(r => String(r.username).toLowerCase() === want.toLowerCase());
  if (loose.length === 1) return { hit: loose[0] };
  if (loose.length > 1) {
    return { error: `${loose.length} people waiting match "${short(want, 40)}". Use their user ID instead.` };
  }
  return { error: `Nobody called "${short(want, 40)}" is waiting to join. `
    + `Use \`/pendingjoin list\` to see who is.` };
}

// ── The live embed ────────────────────────────────────────────────

function workingEmbed({ action, total, done, failed, current, frame, phase }) {
  const verb = action === 'approve' ? 'Accepting' : 'Denying';
  const lines = [];
  if (phase) {
    lines.push(`${spinner(frame)} ${phase}`);
  } else {
    // The count lives in ONE place. Saying "Accepting 10 of 23" above a bar
    // reading 9/23 is two numbers disagreeing on the same screen: one counts the
    // request in flight, the other the ones finished, and the reader cannot tell.
    lines.push(`${spinner(frame)} **${verb}**`
      + (current ? ` — ${short(current.username, 30)}` : ''));
    lines.push('');
    lines.push(`${bar(done, total)}  **${done}** of **${total}** done`);
    if (failed) lines.push(`${e('met_warn')} ${failed} could not be done`);
  }
  return new EmbedBuilder()
    .setColor(COLOUR.working)
    .setTitle(`${e('met_users')}  ${action === 'approve' ? 'Accepting join requests' : 'Denying join requests'}`)
    .setDescription(lines.join('\n'))
    .setFooter({ text: 'Roblox is asked one person at a time, so this takes a moment.' });
}

/**
 * Redraw the reply, but not more often than the rate limit allows.
 *
 * Returns a function to call as often as you like; it drops the redraws it
 * cannot afford. `flush` forces the last one, so the final state is never the
 * one that got dropped.
 */
function throttledEditor(interaction) {
  let last = 0, pendingPayload = null, inFlight = false;
  const send = async (payload) => {
    inFlight = true;
    last = Date.now();
    try { await interaction.editReply(payload); } catch (err) { /* a lost edit is cosmetic */ }
    inFlight = false;
    // Anything that arrived while that was in the air.
    if (pendingPayload) {
      const next = pendingPayload;
      pendingPayload = null;
      if (Date.now() - last >= REDRAW_MS) await send(next);
    }
  };
  return {
    async draw(payload) {
      if (inFlight || Date.now() - last < REDRAW_MS) { pendingPayload = payload; return; }
      await send(payload);
    },
    async flush(payload) {
      pendingPayload = null;
      // Wait out an edit already in the air rather than racing it, or the final
      // result can be overwritten by a progress frame.
      for (let i = 0; inFlight && i < 20; i++) await new Promise(r => setTimeout(r, 100));
      try { await interaction.editReply(payload); } catch (err) { /* nothing left to do */ }
    },
  };
}

// ── Doing it ──────────────────────────────────────────────────────

/**
 * Resolve a list of requests, one at a time, reporting progress.
 *
 * Never throws. Each request is caught on its own so one refusal does not end
 * the run, and the reason comes back with the name it belongs to.
 */
async function resolveMany(requests, action, ctx, editor) {
  const R = require('./roblox');
  const okd = [], failed = [];
  let frame = 0, current = requests[0] || null;

  // The spinner turns on a TIMER, not once per person. One Roblox call can take
  // two seconds; advancing the frame only when a call returns would leave the
  // "animation" frozen for exactly the stretch it exists to cover.
  const tick = setInterval(() => {
    editor.draw({ embeds: [workingEmbed({
      action, total: requests.length, done: okd.length, failed: failed.length,
      current, frame: frame++,
    })], components: [] }).catch(() => {});
  }, REDRAW_MS);

  try {
    for (const r of requests) {
      current = r;
      try {
        await R.resolveJoinRequest(r.userId, action, ctx.gid, ctx.cookie);
        okd.push(r);
      } catch (err) {
        failed.push({ ...r, why: cleanReason(err.message) });
      }
    }
  } finally {
    // Always, or a thrown error leaves a timer redrawing a finished job forever.
    clearInterval(tick);
  }
  return { okd, failed };
}

/**
 * A Roblox error as somebody can act on it.
 *
 * The raw message is "Roblox API 400 on approve: {"errors":[{"code":9,...". The
 * codes that actually come up are worth naming, because "already handled" and
 * "you cannot do that" call for completely different responses.
 */
function cleanReason(message) {
  const m = String(message || '');
  if (/\b404\b/.test(m) || /not found/i.test(m)) return 'their request is gone — cancelled or already decided';
  if (/\b403\b/.test(m)) return 'Roblox refused it — the bot may not have permission';
  if (/\b401\b/.test(m)) return 'the Roblox login has expired';
  if (/\b429\b/.test(m)) return 'Roblox is rate-limiting us — try the rest in a moment';
  if (/\b5\d\d\b/.test(m)) return 'Roblox had an error at their end';
  const brief = m.replace(/^Roblox API \d+ on \w+:\s*/, '');
  return short(brief || 'unknown error', 90);
}

function resultEmbed({ action, okd, failed, more, remaining, issuerName }) {
  const accepted = action === 'approve';
  const total = okd.length + failed.length;
  const colour = !failed.length ? COLOUR.done : (okd.length ? COLOUR.partial : COLOUR.fail);
  const mark = !failed.length ? (accepted ? e('met_tick') : e('met_cross')) : e('met_warn');

  const embed = new EmbedBuilder()
    .setColor(total ? colour : COLOUR.done)
    .setTitle(total
      ? `${mark}  ${accepted ? 'Accepted' : 'Denied'} ${okd.length} of ${total}`
      : `${e('met_tick')}  Nobody was waiting`)
    .setFooter({ text: `By ${issuerName}` })
    .setTimestamp(new Date());

  if (okd.length) {
    embed.addFields({
      name: `${accepted ? e('met_tick') : e('met_cross')}  ${accepted ? 'Let in' : 'Refused'}`,
      value: nameList(okd), inline: false,
    });
  }
  if (failed.length) {
    embed.addFields({
      name: `${e('met_warn')}  Could not be done · ${failed.length}`,
      // The reason per person, because "3 failed" tells nobody what to do next.
      value: short(failed.slice(0, 12).map(f => `**${short(f.username, 24)}** — ${f.why}`).join('\n')
        + (failed.length > 12 ? `\n*and ${failed.length - 12} more*` : ''), 1024),
      inline: false,
    });
  }
  if (more || remaining) {
    embed.addFields({
      name: `${e('met_hourglass')}  Still waiting`,
      // "40 left" would be a lie when the queue was only read as far as it needed
      // to be. At least 40, then, and say so.
      value: `**${remaining}${more ? '+' : ''}** left in the queue. Run it again to carry on.`,
      inline: false,
    });
  }
  if (!total) {
    embed.setDescription('The join-request queue is empty, so nothing was changed.');
  }
  return embed;
}

// Names, capped by COUNT as well as by length, with an honest tail.
//
// The length cap alone let sixty short usernames through, which is a wall of text
// rather than a list — and the number is the useful part by then anyway.
const NAME_LIST_MAX = 20;

function nameList(list) {
  const parts = [];
  let used = 0;
  for (const r of list) {
    if (parts.length >= NAME_LIST_MAX) break;
    const s = `\`${short(r.username, 24)}\``;
    if (used + s.length + 2 > 940) break;
    parts.push(s);
    used += s.length + 2;
  }
  const rest = list.length - parts.length;
  return parts.join(' · ') + (rest > 0 ? ` *and ${rest} more*` : '');
}

// ── The handler ───────────────────────────────────────────────────
async function handlePendingJoinCommand(interaction) {
  const sub = interaction.options.getSubcommand();

  const access = await mayDecide(interaction);
  if (!access.ok) {
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(COLOUR.fail)
        .setTitle(`${e('met_denied')} Not for you`)
        .setDescription(access.why || 'You cannot decide who joins the group.')],
      flags: 64,
    });
  }

  // Ephemeral: this is queue work, not an announcement, and the queue can name
  // people who are about to be refused.
  await interaction.deferReply({ flags: 64 });
  const editor = throttledEditor(interaction);

  // Reading the queue is itself slow enough to need saying.
  await editor.draw({ embeds: [workingEmbed({
    action: sub === 'deny' ? 'decline' : 'approve', frame: 0,
    phase: 'Reading the join-request queue…',
  })] });

  const max = MAX_PER_RUN();
  let queue;
  try {
    queue = await readQueue(max);
  } catch (err) {
    console.error('[/pendingjoin] could not read the queue:', err.message);
    return editor.flush({ embeds: [new EmbedBuilder().setColor(COLOUR.fail)
      .setTitle(`${e('met_cross')} Could not read the queue`)
      .setDescription(cleanReason(err.message)
        + '\n\nNothing was accepted or denied.')] });
  }

  if (sub === 'list') return showList(editor, queue, max);

  const action = sub === 'accept' ? 'approve' : 'decline';
  const all = interaction.options.getBoolean('all') === true;
  const named = interaction.options.getString('user');

  if (!all && !named) {
    return editor.flush({ embeds: [new EmbedBuilder().setColor(COLOUR.ask)
      .setTitle(`${e('met_warn')} Who?`)
      .setDescription(`Name somebody with \`user:\`, or pass \`all: true\` to `
        + `${sub} everybody waiting.\n\n${queue.requests.length
          ? `**${queue.requests.length}${queue.more ? '+' : ''}** `
            + `${queue.requests.length === 1 ? 'person is' : 'people are'} waiting.`
          : 'Nobody is waiting at the moment.'}`)] });
  }
  if (all && named) {
    return editor.flush({ embeds: [new EmbedBuilder().setColor(COLOUR.ask)
      .setTitle(`${e('met_warn')} One or the other`)
      .setDescription('You gave a name AND `all`. Drop one — doing everybody and doing one person '
        + 'are different jobs and I will not guess which you meant.')] });
  }

  if (!queue.requests.length) {
    return editor.flush({ embeds: [new EmbedBuilder().setColor(COLOUR.done)
      .setTitle(`${e('met_tick')} Nobody is waiting`)
      .setDescription('The join-request queue is empty.')] });
  }

  // One person.
  if (named) {
    const found = findOne(queue.requests, named);
    if (found.error) {
      return editor.flush({ embeds: [new EmbedBuilder().setColor(COLOUR.ask)
        .setTitle(`${e('met_warn')} Not sure who you mean`)
        .setDescription(found.error)] });
    }
    const { okd, failed } = await resolveMany([found.hit], action, queue, editor);
    return editor.flush({ embeds: [resultEmbed({
      action, okd, failed, more: false,
      remaining: Math.max(0, queue.requests.length - 1),
      issuerName: issuerNameOf(interaction),
    })], components: [] });
  }

  // Everybody. Accepting the whole queue is the ordinary job; DENYING it throws
  // away every application at once, so that one is confirmed first.
  const batch = queue.requests.slice(0, max);
  if (action === 'decline') {
    const token = `pj:${interaction.id}`;
    pending.set(token, { at: Date.now(), issuerId: interaction.user.id,
                         data: { batch, queue, action } });
    return editor.flush({
      embeds: [new EmbedBuilder().setColor(COLOUR.ask)
        .setTitle(`${e('met_warn')} Deny all ${batch.length}?`)
        .setDescription(`Every one of these people is refused, and their request is gone. `
          + `They can ask again, but nothing here tells them why.\n\n${nameList(batch)}`)
        .setFooter({ text: 'This does nothing until you press Deny them all.' })],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`pjyes:${token}`).setStyle(ButtonStyle.Danger)
          .setLabel(`Deny all ${batch.length}`),
        new ButtonBuilder().setCustomId(`pjno:${token}`).setStyle(ButtonStyle.Secondary)
          .setLabel('Cancel'),
      )],
    });
  }

  const { okd, failed } = await resolveMany(batch, action, queue, editor);
  return editor.flush({ embeds: [resultEmbed({
    action, okd, failed, more: queue.more,
    remaining: Math.max(0, queue.requests.length - batch.length),
    issuerName: issuerNameOf(interaction),
  })], components: [] });
}

function issuerNameOf(interaction) {
  return (interaction.member && interaction.member.displayName)
    || interaction.user.globalName || interaction.user.username;
}

async function showList(editor, queue, max) {
  const rows = queue.requests.slice(0, 25);
  // The queue is only read as far as a run could act on it, so the count is a
  // floor rather than a total — and a headline that says "100" when 230 are
  // waiting is worse than one that says "100+".
  const count = `${queue.requests.length || 'No'}${queue.more ? '+' : ''}`;
  const embed = new EmbedBuilder()
    .setColor(queue.requests.length ? COLOUR.working : COLOUR.done)
    .setTitle(`${e('met_users')}  ${count} `
      + `${queue.requests.length === 1 ? 'person' : 'people'} waiting to join`);
  if (!queue.requests.length) {
    embed.setDescription(`${e('met_tick')} The queue is empty.`);
  } else {
    embed.setDescription(rows.map(r => {
      const when = r.requestedAt && !isNaN(new Date(r.requestedAt))
        ? ` · <t:${Math.floor(new Date(r.requestedAt).getTime() / 1000)}:R>` : '';
      return `${e('met_user')} \`${short(r.username, 24)}\` `
        + `[profile](https://www.roblox.com/users/${r.userId}/profile)${when}`;
    }).join('\n'));
    if (queue.requests.length > rows.length || queue.more) {
      embed.addFields({ name: '​',
        value: `*…and ${queue.more ? 'more' : queue.requests.length - rows.length} beyond these.*`,
        inline: false });
    }
    embed.setFooter({ text: `Accept one with /pendingjoin accept user:<name>, `
      + `or up to ${max} at once with all: true.` });
  }
  return editor.flush({ embeds: [embed], components: [] });
}

// ── The deny-all confirmation ─────────────────────────────────────
async function handlePendingJoinButton(interaction) {
  // "pjyes:pj:<id>" — split on the FIRST colon only, because the token has one
  // of its own and splitting on all of them loses half of it.
  const cut = interaction.customId.indexOf(':');
  const kind = interaction.customId.slice(0, cut);
  const token = interaction.customId.slice(cut + 1);

  const hit = pending.get(token);
  if (!hit || Date.now() - hit.at > PENDING_TTL) {
    pending.delete(token);
    return interaction.update({
      embeds: [new EmbedBuilder().setColor(COLOUR.fail)
        .setTitle(`${e('met_hourglass')} That expired`)
        .setDescription('Run the command again — nothing was denied.')],
      components: [],
    }).catch(() => {});
  }
  // Only the person who asked. Somebody else pressing a destructive button they
  // did not open is not a decision they made.
  if (hit.issuerId !== interaction.user.id) {
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(COLOUR.fail)
        .setTitle(`${e('met_denied')} Not yours to press`)
        .setDescription('Run `/pendingjoin deny all: true` yourself if you want to do this.')],
      flags: 64,
    }).catch(() => {});
  }

  if (kind === 'pjno') {
    pending.delete(token);
    return interaction.update({
      embeds: [new EmbedBuilder().setColor(COLOUR.fail)
        .setTitle(`${e('met_cross')} Cancelled`)
        .setDescription('Nobody was denied. The queue is untouched.')],
      components: [],
    }).catch(() => {});
  }

  // One press only.
  pending.delete(token);
  const { batch, queue, action } = hit.data;
  await interaction.update({
    embeds: [workingEmbed({ action, total: batch.length, done: 0, failed: 0, frame: 0 })],
    components: [],
  }).catch(() => {});

  const editor = throttledEditor(interaction);
  const { okd, failed } = await resolveMany(batch, action, queue, editor);
  return editor.flush({ embeds: [resultEmbed({
    action, okd, failed, more: queue.more,
    remaining: Math.max(0, queue.requests.length - batch.length),
    issuerName: issuerNameOf(interaction),
  })], components: [] });
}

module.exports = {
  buildCommand, handlePendingJoinCommand, handlePendingJoinButton,
  // exported for the tests
  mayDecide, readQueue, findOne, resolveMany, cleanReason, resultEmbed,
  workingEmbed, bar, throttledEditor, MAX_PER_RUN,
};
