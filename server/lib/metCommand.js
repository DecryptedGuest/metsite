// server/lib/metCommand.js
// /met — how to join the Metropolitan Police, posted where everybody can read it.
//
// This exists because Internal Affairs answers the same question several times a
// day, usually inside a ticket: "how do I join?" The honest answer is six steps
// spread across two Roblox groups, a Discord channel, a reaction role, a tryout
// and an exam, and typing that out by hand every time means it comes out
// differently every time — and sometimes wrong.
//
// So it is one command that posts the whole path PUBLICLY (the person asking is
// usually not the only one who wants to know), with a button that sends the same
// thing to anybody's DMs so they can work through it without scrolling back.
//
// ── Written to be followed, not admired ──────────────────────────
//
// The brief was explicit: easy to read, not complicated, and it has to work for
// somebody who is not going to read carefully. That drives everything about the
// layout:
//
//   * numbered steps, in order, one action each. No step asks for two things.
//   * the requirement that stops most people — you must be in BOTH Roblox groups
//     — is FIRST and it is step one, not a footnote at the bottom. It was at the
//     bottom of the old recruitment post, which is why people kept turning up to
//     a tryout they could not get into.
//   * every step says what happens next, so nobody is left waiting without
//     knowing what they are waiting for.
//   * no rank names people do not have yet, no jargon, no "kindly be advised".
//
// Who may run it: Internal Affairs and MET High Command (the same test
// /infract uses), or anybody with Administrator in the server. It posts a
// message to everyone in the channel, so it is not for everyone to run.

const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
        ButtonStyle, PermissionFlagsBits } = require('discord.js');
const { e, buttonEmoji } = require('./emoji');

// ── The facts, in one place ───────────────────────────────────────
// Every one of these is overridable, because a channel id or a group changing is
// not a reason to need a deploy.
const CFG = () => ({
  tryoutChannelId: process.env.MET_TRYOUT_CHANNEL_ID || '1529956084930969621',
  // The message people react to for the Tryout Notifications role.
  notifyMessageUrl: process.env.MET_TRYOUT_NOTIFY_URL
    || 'https://discord.com/channels/1191048287315304470/1529956084930969621/1531694831418478667',
  notifyEmoji: process.env.MET_TRYOUT_NOTIFY_EMOJI || '👮‍♂️',
  hendonGroupUrl: process.env.MET_HENDON_GROUP_URL
    || 'https://www.roblox.com/communities/14201396/Hendon-Police-College-SLR',
  metGroupUrl: process.env.MET_GROUP_URL
    || 'https://www.roblox.com/communities/17275620/Metropolitan-Police-SLR',
  examUrl: process.env.MET_EXAM_URL || 'https://slrmet.com/exam',
  minAccountAgeDays: num(process.env.MET_MIN_ACCOUNT_AGE_DAYS, 100),
  // Read out of the systems that actually decide these, not restated here. A
  // recruitment post that says "two events" while the ladder says something else
  // is worse than no recruitment post: it is the department telling somebody a
  // thing that will not happen, and they will hold us to it.
  xpPerEvent:         eventXp(),
  constableAtXp:      constableThreshold(),
  eventsForConstable: Math.max(1, Math.ceil(constableThreshold() / Math.max(1, eventXp()))),
});

function num(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

// What one event is actually worth to somebody who attends it.
function eventXp() {
  const n = parseInt(process.env.EVENT_ATTENDEE_XP || '1', 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

// The XP at which the ladder promotes a Community Support Officer to Constable.
// Taken from the ladder itself; 2 only if the ladder cannot be read.
function constableThreshold() {
  try {
    const xp = require('./xp');
    const rungs = xp.LADDER || xp.RANKS || xp.ROLESET || null;
    if (Array.isArray(rungs)) {
      const con = rungs.find(r => r && (r.code === 'CON' || /^constable$/i.test(r.name || '')));
      if (con && Number.isFinite(con.at) && con.at > 0) return con.at;
    }
  } catch (err) { /* fall through to the known value */ }
  return 2;
}

const BLUE = 0x1d4ed8;

// An image only helps if it is actually reachable from Discord's side, which
// means an absolute https URL on a host that is up. Without PUBLIC_BASE_URL there
// is no such URL, and a broken image is worse than none — Discord renders the
// embed with a grey box in it.
function bannerUrl(name) {
  const { siteBaseUrl } = require('./dmOptOut');
  const base = siteBaseUrl();
  return base ? `${base}/img/${name}` : null;
}

function buildCommand() {
  return new SlashCommandBuilder()
    .setName('met')
    .setDescription('Post how to join the Metropolitan Police')
    .addBooleanOption(o => o
      .setName('quiet')
      .setDescription('Show it only to you, instead of posting it in the channel'))
    .toJSON();
}

// ── The message ───────────────────────────────────────────────────

// The hook. Their recruitment copy, cut to what somebody will actually read
// before scrolling. The long version lives in the recruitment post; repeating it
// here would bury the six steps that are the point of this message.
function intro() {
  const c = CFG();
  return 'Every Metropolitan Police officer starts at **Hendon Police College**. '
       + 'Pass the tryout and the exam and you are in, and after '
       + `${spell(c.eventsForConstable)} events you are a **Police Constable** `
       + 'on the streets of London.\n\n'
       + 'Follow the steps below in order. It takes about a week.';
}

function stepsEmbed() {
  const c = CFG();
  const eb = new EmbedBuilder()
    .setColor(BLUE)
    .setTitle(`${e('met_shield')}  How to join the Metropolitan Police`)
    .setDescription(intro());

  // STEP 1 is the groups, deliberately. Nobody can get into Hendon without both,
  // and this being buried at the bottom of the recruitment post is why people
  // turned up to tryouts they could not attend.
  eb.addFields({
    name: `${e('met_link')}  Step 1 · Join both Roblox groups`,
    value: `You cannot get into Hendon without **both** of these. Do this first.\n`
         + `· [Hendon Police College](${c.hendonGroupUrl})\n`
         + `· [Metropolitan Police](${c.metGroupUrl})`,
  });

  eb.addFields({
    name: `${e('met_announce')}  Step 2 · Turn on tryout pings`,
    value: `Tryouts are not on a timetable, so get told when one starts.\n`
         + `Go to [this message](${c.notifyMessageUrl}) and react with ${c.notifyEmoji}.\n`
         + `You will get the **Tryout Notifications** role and a ping every time one is hosted.`,
  });

  eb.addFields({
    name: `${e('met_patrol')}  Step 3 · Attend a tryout`,
    value: `When you get the ping, go to <#${c.tryoutChannelId}> and join.\n`
         + `A Hendon instructor runs it live. Do what they ask, listen, and don't mess about.`,
  });

  eb.addFields({
    name: `${e('met_note')}  Step 4 · Sit the final exam`,
    value: `Pass the tryout and you are sent to the exam: **[${prettyUrl(c.examUrl)}](${c.examUrl})**\n`
         + `Written questions. Take your time. There is no rush, and no penalty for thinking.`,
  });

  eb.addFields({
    name: `${e('met_search')}  Step 5 · Wait for it to be marked`,
    value: `A member of the **Hendon Police College** marks it by hand. That is a person, not a bot, `
         + `so give it a little time.\n`
         + `Pass, and you are accepted into the Metropolitan Police as a **Community Support Officer**.`,
  });

  eb.addFields({
    name: `${e('met_promote')}  Step 6 · ${spell(c.eventsForConstable).replace(/^./, m => m.toUpperCase())} events, then Constable`,
    value: `As a Community Support Officer, attend **${c.eventsForConstable} event`
         + `${c.eventsForConstable === 1 ? '' : 's'}**. Each one is worth **${c.xpPerEvent} XP**.\n`
         + `At **${c.constableAtXp} XP** you are promoted to **Police Constable** automatically, `
         + `and you do not have to ask anybody.\n`
         + `That is it. You are officially Metropolitan Police.`,
  });

  // The two things that disqualify people, said plainly and said once. Somebody
  // who reads only one field should not be the person who wasted an evening.
  eb.addFields({
    name: `${e('met_warn')}  Before you start: two rules`,
    value: `· Your Roblox account must be at least **${c.minAccountAgeDays} days old**.\n`
         + `· You **cannot be in a gang**, unless you have been given gang permissions.\n`
         + `If either of these is you, sort it out before the tryout, not after.`,
  });

  eb.addFields({
    name: `${e('met_star')}  After you are a Constable`,
    value: 'Constables can apply to the specialist divisions: response, criminal '
         + 'investigation, firearms, public protection, intelligence and more. '
         + 'That is where the career actually opens up.',
  });

  eb.setFooter({ text: 'Metropolitan Police · Working together for a safer London' });

  const banner = bannerUrl('metbanner.png');
  if (banner) eb.setImage(banner);
  return eb;
}

function prettyUrl(u) {
  return String(u || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

// Small numbers read better as words in a heading. Anything bigger stays a digit.
function spell(n) {
  return ['zero', 'one', 'two', 'three', 'four', 'five', 'six'][n] || String(n);
}

// The button. One job: put the same steps in your own DMs, so you can follow
// them without scrolling back through a channel that has moved on.
function buttons() {
  const c = CFG();
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('met_dm_steps')
      .setLabel('DM me these steps')
      // Our own marks, not stock unicode. buttonEmoji() hands back the object
      // discord.js wants ({ id } for a custom emoji) and degrades to the unicode
      // character if the application emoji have not been uploaded yet, so the
      // button always has an icon.
      .setEmoji(buttonEmoji('met_dm'))
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setLabel('Tryout notifications')
      .setEmoji(buttonEmoji('met_announce'))
      .setURL(c.notifyMessageUrl)
      .setStyle(ButtonStyle.Link),
    new ButtonBuilder()
      .setLabel('Final exam')
      .setEmoji(buttonEmoji('met_exam'))
      .setURL(c.examUrl)
      .setStyle(ButtonStyle.Link),
  );
  return [row];
}

// ── Who may run it ────────────────────────────────────────────────
// Internal Affairs and MET High Command, by the same test /infract uses — or
// anybody with Administrator in the server. It posts to everyone in the channel,
// which is not something everyone should be able to do.
async function mayPost(interaction) {
  try {
    if (interaction.memberPermissions
        && interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
      return { ok: true, via: 'administrator' };
    }
  } catch (err) { /* fall through to the rank test */ }

  const roleIds = interaction.member && interaction.member.roles && interaction.member.roles.cache
    ? [...interaction.member.roles.cache.keys()]
    : [];
  try {
    const { canDiscipline } = require('./disciplineAccess');
    const access = await canDiscipline(interaction.user.id, roleIds);
    if (access && access.ok) return { ok: true, via: access.via || 'rank' };
    return { ok: false, why: access && access.why };
  } catch (err) {
    console.error('[/met] access check failed:', err.message);
    // A failed lookup is not permission. The command posts to a whole channel.
    return { ok: false, why: 'Your access could not be checked just now · try again shortly.' };
  }
}

// ── The command ───────────────────────────────────────────────────
async function handleMetCommand(interaction) {
  const quiet = interaction.options.getBoolean('quiet') === true;

  const access = await mayPost(interaction);
  if (!access.ok) {
    return interaction.reply({
      flags: 64,
      embeds: [new EmbedBuilder()
        .setColor(0xf04f5e)
        .setTitle(`${e('met_denied')} Not for you to post`)
        .setDescription(access.why
          || 'This posts a message to the whole channel, so it is limited to Internal Affairs, '
           + 'MET High Command, and server administrators.\n\n'
           + 'If you want the steps for yourself, ask any of them to run it.')],
    }).catch(() => {});
  }

  // Ephemeral when asked for, so somebody can check what it looks like without
  // posting it to a channel first.
  await interaction.reply({
    flags: quiet ? 64 : undefined,
    embeds: [stepsEmbed()],
    components: buttons(),
    allowedMentions: { parse: [] },
  });
}

// ── The DM button ─────────────────────────────────────────────────
async function handleMetButton(interaction) {
  if (interaction.customId !== 'met_dm_steps') return;

  // Answered privately either way: whether somebody's DMs are open is their
  // business, and a public "your DMs are closed" is a small humiliation in front
  // of a channel.
  await interaction.deferReply({ flags: 64 }).catch(() => {});

  const eb = stepsEmbed();
  // A DM has no channel context, so the tryout channel mention would render as a
  // dead <#id>. Say the name instead.
  const c = CFG();
  eb.setFields(eb.data.fields.map(f => ({
    ...f,
    value: String(f.value).replace(new RegExp(`<#${c.tryoutChannelId}>`, 'g'), 'the **tryouts** channel'),
  })));

  try {
    await interaction.user.send({
      embeds: [eb],
      // Only the link buttons: "DM me these steps" inside the DM itself is a
      // button that does nothing you have not already done.
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('Tryout notifications').setEmoji(buttonEmoji('met_announce'))
          .setURL(c.notifyMessageUrl).setStyle(ButtonStyle.Link),
        new ButtonBuilder().setLabel('Final exam').setEmoji(buttonEmoji('met_exam'))
          .setURL(c.examUrl).setStyle(ButtonStyle.Link),
      )],
    });
    return interaction.editReply({
      content: `${e('met_tick')} Sent · check your DMs. Work through it in order and you'll be fine.`,
    }).catch(() => {});
  } catch (err) {
    // The only failure that actually happens: DMs closed to server members.
    return interaction.editReply({
      content: `${e('met_warn')} I couldn't DM you · your privacy settings are blocking direct messages `
             + 'from this server.\n\nTurn them on in **Privacy Settings → Direct Messages** for this server, '
             + 'or just read the steps above; they are the same.',
    }).catch(() => {});
  }
}

module.exports = { buildCommand, handleMetCommand, handleMetButton, stepsEmbed, mayPost, CFG };
