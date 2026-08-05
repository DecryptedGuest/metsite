// server/lib/pendingJoinCommand.js
// /pendingjoin accept · /pendingjoin deny — the MET group's join-request queue,
// from Discord.
//
// The queue already exists in the developer panel. This puts it where the people
// who actually clear it are: in the MET server, letting somebody in without
// opening a browser.
//
// Four things it takes seriously:
//
//   WHO MAY DECIDE IS IN CODE, not in a Discord permission bit — MET High
//   Command, Internal Affairs and HPC High Command (mayDecide). "Can manage this
//   server" answers a different question and is held by people who have no
//   business recruiting.
//
//   ONE PERSON PER COMMAND. There is deliberately no "all". Reading the queue is
//   bulk; deciding it is not. Emptying it in one press is a thing that can only be
//   regretted afterwards, and neither accepting nor denying is undoable from here.
//
//   IT SHOWS PROGRESS. A Roblox call can take a couple of seconds, and Discord
//   shows nothing at all while it does. So the reply is a live embed with a
//   spinner and the name it is on; an unchanging "working…" is indistinguishable
//   from a hang.
//
//   IT NEVER GUESSES WHO. Accepting the wrong person is not undoable, so the name
//   given has to resolve to exactly one request in the queue. "It looked like this
//   one" is not good enough.

const {
  SlashCommandBuilder, EmbedBuilder,
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

// How far down the queue a name is looked for. Nothing is ever resolved in bulk,
// so this is only about how much of the queue one lookup reads: enough to find
// anybody who is realistically waiting, and not so much that naming one person
// pages through four hundred requests.
const MAX_PER_RUN = () => {
  const n = parseInt(process.env.PENDING_JOIN_MAX_PER_RUN, 10);
  return Number.isFinite(n) && n > 0 ? n : 200;
};

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
    .setDescription('The Roblox username or user ID whose request to decide')
    .setRequired(true);

  return new SlashCommandBuilder()
    .setName('pendingjoin')
    .setDescription('Accept or deny people waiting to join the MET Roblox group')
    .addSubcommand(sub => sub
      .setName('accept')
      .setDescription('Let one person into the MET group')
      .addStringOption(who))
    .addSubcommand(sub => sub
      .setName('deny')
      .setDescription('Refuse one person waiting to join')
      .addStringOption(who))
    .addSubcommand(sub => sub
      .setName('list')
      .setDescription('Who is waiting, without deciding anything'));
}

// Discord roles that may clear the queue on top of whatever canDiscipline says.
// HPC High Command recruit into MET as part of running training, so they are in
// by default; the env exists so another role can be added without a deploy.
const HPC_HICOMM_ROLE = '1398071632207151184';
const EXTRA_ROLE_IDS = () => {
  const raw = process.env.PENDING_JOIN_ROLE_IDS;
  const list = String(raw == null ? HPC_HICOMM_ROLE : raw)
    .split(',').map(s => s.trim()).filter(Boolean);
  return list;
};

/**
 * May this person decide who joins MET?
 *
 * MET High Command, Internal Affairs, and HPC High Command. Not Administrator:
 * "can manage this server" is a Discord housekeeping permission held by people
 * who have no business recruiting.
 *
 * canDiscipline already answers this for the first two, by any of its routes —
 * a Discord role, a dashboard account, or a live MET group rank — so a Deputy
 * Commissioner who has never opened the dashboard still gets in. HPC High
 * Command is a plain role-id check, because it is a Discord role and nothing
 * else.
 *
 * A lookup that fails is not permission — except for the role check, which
 * needs no lookup and is therefore still trustworthy when Roblox is down.
 */
async function mayDecide(interaction) {
  const REFUSAL = 'Only MET High Command, Internal Affairs and HPC High Command '
    + 'can decide who joins the MET group.';

  const roleIds = interaction.member && interaction.member.roles && interaction.member.roles.cache
    ? [...interaction.member.roles.cache.keys()].map(String)
    : (Array.isArray(interaction.member && interaction.member.roles)
        ? interaction.member.roles.map(String) : []);

  // First, because it costs nothing and still works when the rank lookup can't.
  for (const rid of EXTRA_ROLE_IDS()) {
    if (roleIds.includes(String(rid))) {
      return { ok: true, via: 'hpc-hicomm-role', label: 'HPC High Command' };
    }
  }

  try {
    const { canDiscipline } = require('./disciplineAccess');
    const verdict = await canDiscipline(String(interaction.user.id), roleIds);
    if (verdict && verdict.ok) {
      return { ok: true, via: verdict.via, label: verdict.label || 'MET High Command' };
    }
    // canDiscipline's own refusal names ITS gate ("Internal Affairs and Deputy
    // Commissioner"), which is not this one — so the sentence is ours. What is
    // worth keeping is anything it added about WHY it could not place them: a
    // missing RoVer link or a blacklisted account are the reader's next step,
    // and neither is implied by "not for you".
    const extra = verdict && verdict.why
      ? verdict.why.split(/(?<=\.)\s+/).filter(s => !/^This command is for/.test(s)).join(' ').trim()
      : '';
    return { ok: false, why: REFUSAL + (extra ? `\n\n${extra}` : '') };
  } catch (err) {
    console.error('[/pendingjoin] access check failed:', err.message);
    return { ok: false, why: 'Your rank could not be checked just now · try again shortly.' };
  }
}

// ── Reading the queue ─────────────────────────────────────────────

/**
 * Every pending request, paged.
 *
 * A page that fails mid-way is an error, not "the rest of the queue is empty" —
 * treating it as empty would make "deny all" look like it had nothing to do.
 */
// The page cap. 100 per page, so this is 4,000 requests — far past any queue MET
// will have, and a hard stop so a broken cursor cannot loop.
const MAX_PAGES = 40;

/**
 * @param {number} max      how many requests a run could act on
 * @param {object} opts     `all: true` reads the WHOLE queue rather than stopping
 *                          at `max`
 *
 * The queue comes back oldest-first, so stopping early reads the oldest requests
 * and misses the newest — which is exactly the person somebody is most likely to
 * be trying to accept. `list` can stop early because it only shows the top of the
 * queue anyway; looking somebody up must not.
 */
async function readQueue(max, opts = {}) {
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
    // `more` means "there are others we did not read", and NOTHING may report
    // what we did read as the size of the queue.
  } while (token && pages < MAX_PAGES && (opts.all || out.length < max + 1));
  return { requests: out, more: !!token, pages, gid, cookie };
}

/**
 * Find the one request a name refers to.
 *
 * Id, then username, then DISPLAY NAME — because the display name is what Roblox
 * shows on a profile and in game, so it is what people copy. Each pass is exact
 * first, then case-insensitive.
 *
 * Anything ambiguous is refused rather than picked between: getting it wrong lets
 * the wrong person into the group, and that is not undoable from here.
 */
function findOne(requests, needle) {
  const want = String(needle || '').trim().replace(/^@/, '');
  if (!want) return { error: 'Say who · a Roblox username or user ID.' };
  const lower = want.toLowerCase();
  const low = v => String(v == null ? '' : v).toLowerCase();

  const byId = requests.filter(r => r.userId === want);
  if (byId.length === 1) return { hit: byId[0] };

  for (const pass of [
    r => r.username === want,
    r => low(r.username) === lower,
    r => r.displayName === want,
    r => low(r.displayName) === lower,
  ]) {
    const hits = requests.filter(pass);
    if (hits.length === 1) return { hit: hits[0] };
    if (hits.length > 1) {
      return {
        ambiguous: true,
        error: `${hits.length} people waiting match "${short(want, 40)}" · `
             + hits.slice(0, 5).map(r => `\`${short(r.username, 20)}\``).join(' · ')
             + '. Use their user ID instead.',
      };
    }
  }
  return { notHere: true, error: `Nobody called "${short(want, 40)}" is waiting to join.` };
}

/**
 * Who a name refers to on Roblox, regardless of the queue.
 *
 * The fallback when a name is not in what we read. Roblox itself is the authority
 * on whether they have a request open — asking to accept somebody with none comes
 * back 404 — so this only has to turn a name into an id.
 *
 * @returns {Promise<{userId, username, displayName, viaLookup:true}|null>}
 */
async function lookupPerson(needle) {
  const want = String(needle || '').trim().replace(/^@/, '');
  if (!want) return null;
  const R = require('./roblox');
  try {
    if (/^\d+$/.test(want)) {
      const info = await R.getRobloxUserInfo(want);
      if (!info) return null;
      return { userId: String(info.id), username: info.username, displayName: info.displayName, viaLookup: true };
    }
    // The map comes back keyed on the lowercased name — both what we asked for
    // and what the account is called now.
    const found = await R.getRobloxIdsFromUsernames([want], { attempts: 2 });
    const hit = found && found.users ? found.users.get(want.toLowerCase()) : null;
    if (!hit || !/^\d+$/.test(String(hit.id))) return null;
    return { userId: String(hit.id), username: hit.username || want, displayName: hit.displayName || null, viaLookup: true };
  } catch (err) {
    return null;
  }
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
      + (current ? ` · ${short(current.username, 30)}` : ''));
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
        // Somebody we found by asking Roblox who they are, rather than by seeing
        // them in the queue, has never been shown to have a request open — so a
        // 404 on them means "they are not waiting", not "their request is gone".
        const why = r.viaLookup && /\b404\b|not found/i.test(String(err.message))
          ? 'they are not waiting to join · no request from them is open'
          : cleanReason(err.message);
        failed.push({ ...r, why });
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
  if (/\b404\b/.test(m) || /not found/i.test(m)) return 'their request is gone · cancelled or already decided';
  if (/\b403\b/.test(m)) return 'Roblox refused it · the bot may not have permission';
  if (/\b401\b/.test(m)) return 'the Roblox login has expired';
  if (/\b429\b/.test(m)) return 'Roblox is rate-limiting us · try the rest in a moment';
  if (/\b5\d\d\b/.test(m)) return 'Roblox had an error at their end';
  const brief = m.replace(/^Roblox API \d+ on \w+:\s*/, '');
  return short(brief || 'unknown error', 90);
}

function resultEmbed({ action, okd, failed, more, remaining, issuerName }) {
  const accepted = action === 'approve';
  const total = okd.length + failed.length;
  const colour = !failed.length ? COLOUR.done : (okd.length ? COLOUR.partial : COLOUR.fail);
  const mark = !failed.length ? (accepted ? e('met_tick') : e('met_cross')) : e('met_warn');

  // One person is the normal case, so the headline names them rather than counting
  // to one: "Accepted 1 of 1" is a report about arithmetic, not about a person.
  let title;
  if (!total) title = `${e('met_tick')}  Nobody was waiting`;
  else if (total === 1) {
    const only = okd[0] || failed[0];
    title = okd.length
      ? `${mark}  ${accepted ? 'Accepted' : 'Denied'} ${short(only.username, 40)}`
      : `${mark}  Could not ${accepted ? 'accept' : 'deny'} ${short(only.username, 40)}`;
  } else title = `${mark}  ${accepted ? 'Accepted' : 'Denied'} ${okd.length} of ${total}`;

  const embed = new EmbedBuilder()
    .setColor(total ? colour : COLOUR.done)
    .setTitle(title)
    .setFooter({ text: `By ${issuerName}` })
    .setTimestamp(new Date());

  // With a single person the title already names them; repeating it in a field
  // says the same thing twice.
  if (okd.length && total > 1) {
    embed.addFields({
      name: `${accepted ? e('met_tick') : e('met_cross')}  ${accepted ? 'Let in' : 'Refused'}`,
      value: nameList(okd), inline: false,
    });
  }
  if (failed.length && total === 1) {
    // The reason IS the message here, so it goes in the description rather than a
    // field titled with the same thing the title already said.
    embed.setDescription(`${failed[0].why}\n\nNothing was changed.`);
  } else if (failed.length) {
    embed.addFields({
      name: `${e('met_warn')}  Could not be done · ${failed.length}`,
      // The reason per person, because "3 failed" tells nobody what to do next.
      value: short(failed.slice(0, 12).map(f => `**${short(f.username, 24)}** · ${f.why}`).join('\n')
        + (failed.length > 12 ? `\n*and ${failed.length - 12} more*` : ''), 1024),
      inline: false,
    });
  }
  if (okd.length === 1 && total === 1) {
    const only = okd[0];
    embed.setDescription(`[${short(only.username, 40)}]`
      + `(https://www.roblox.com/users/${only.userId}/profile) `
      + (accepted ? 'is in the MET group now.' : 'was refused, and their request is gone.'));
  }
  if (more || remaining) {
    embed.addFields({
      name: `${e('met_hourglass')}  Still waiting`,
      // "40 left" would be a lie when the queue was only read as far as it needed
      // to be. At least 40, then, and say so.
      value: `**${remaining}${more ? '+' : ''}** still waiting. `
        + '`/pendingjoin list` shows who.',
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
    // Looking somebody up reads the WHOLE queue. It comes back oldest-first, so
    // stopping at 200 was reading the oldest 200 and reporting anybody newer as
    // not waiting — which is the person most likely to be looked up.
    queue = await readQueue(max, { all: sub !== 'list' });
  } catch (err) {
    console.error('[/pendingjoin] could not read the queue:', err.message);
    return editor.flush({ embeds: [new EmbedBuilder().setColor(COLOUR.fail)
      .setTitle(`${e('met_cross')} Could not read the queue`)
      .setDescription(cleanReason(err.message)
        + '\n\nNothing was accepted or denied.')] });
  }

  if (sub === 'list') return showList(editor, queue);

  const action = sub === 'accept' ? 'approve' : 'decline';
  const named = interaction.options.getString('user');

  if (!queue.requests.length) {
    return editor.flush({ embeds: [new EmbedBuilder().setColor(COLOUR.done)
      .setTitle(`${e('met_tick')} Nobody is waiting`)
      .setDescription('The join-request queue is empty.')] });
  }

  // One person, always. `user` is a required option, so an empty one only happens
  // if Discord sends a malformed interaction — worth answering rather than
  // resolving whoever happens to be first in the queue.
  let found = findOne(queue.requests, named);

  // Not in the queue we read — but the queue we read is not the whole world. The
  // cursor can be capped, a request can arrive between the read and now, and the
  // name may be one Roblox knows under a different spelling. So ask Roblox who
  // that is and put it to them directly: they are the authority on whether a
  // request is open, and they answer 404 when it is not.
  if (found.notHere) {
    await editor.draw({ embeds: [workingEmbed({
      action, frame: 1, phase: `Not in the queue we read · asking Roblox who ${short(named, 30)} is…`,
    })] });
    const person = await lookupPerson(named);
    if (person) found = { hit: person };
  }

  if (found.error) {
    const embed = new EmbedBuilder().setColor(COLOUR.ask)
      .setTitle(`${e('met_warn')} Not sure who you mean`)
      .setDescription(found.error);
    // What was actually looked at, so "nobody called that" is a statement with a
    // scope rather than a flat denial.
    if (found.notHere) {
      embed.addFields({
        name: 'What was checked',
        value: `${queue.requests.length}${queue.more ? '+' : ''} pending request`
             + `${queue.requests.length === 1 ? '' : 's'}, and Roblox's own user search.\n`
             + 'If they are definitely waiting, try their **user ID** · '
             + '`/pendingjoin list` shows both.',
        inline: false,
      });
    }
    return editor.flush({ embeds: [embed] });
  }
  const { okd, failed } = await resolveMany([found.hit], action, queue, editor);
  return editor.flush({ embeds: [resultEmbed({
    action, okd, failed, more: queue.more,
    remaining: Math.max(0, queue.requests.length - 1),
    issuerName: issuerNameOf(interaction),
  })], components: [] });
}

function issuerNameOf(interaction) {
  return (interaction.member && interaction.member.displayName)
    || interaction.user.globalName || interaction.user.username;
}

async function showList(editor, queue) {
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
      // The display name too when it differs — that is what a profile shows, so
      // it is what somebody looking them up is most likely to type.
      const also = r.displayName && r.displayName !== r.username
        ? ` · *${short(r.displayName, 24)}*` : '';
      return `${e('met_user')} \`${short(r.username, 24)}\`${also} `
        + `[profile](https://www.roblox.com/users/${r.userId}/profile)${when}`;
    }).join('\n'));
    if (queue.requests.length > rows.length || queue.more) {
      embed.addFields({ name: '​',
        value: `*…and ${queue.more ? 'more' : queue.requests.length - rows.length} beyond these.*`,
        inline: false });
    }
    embed.setFooter({ text: 'Decide one with /pendingjoin accept user:<name> '
      + 'or /pendingjoin deny user:<name>.' });
  }
  return editor.flush({ embeds: [embed], components: [] });
}

module.exports = {
  buildCommand, handlePendingJoinCommand,
  // exported for the tests
  mayDecide, readQueue, findOne, lookupPerson, resolveMany, cleanReason, resultEmbed,
  workingEmbed, bar, throttledEditor, MAX_PER_RUN, MAX_PAGES, EXTRA_ROLE_IDS, nameList,
};
