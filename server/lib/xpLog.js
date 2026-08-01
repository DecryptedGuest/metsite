// server/lib/xpLog.js
// Everything that happens to an officer's XP goes in the XP log channel.
//
// Two kinds of post:
//   CHANGE     somebody added, removed or set XP — who, how much, from what to
//              what, and why
//   PROMOTION  a change crossed a threshold — the officer, the rank they made,
//              and whether the Roblox group actually moved
//
// A change that also promotes produces both, in that order, so the channel
// reads as a story rather than one dense line.
//
// Posting is best-effort by design. An XP award that succeeded must not be
// reported as failed because a log channel was misconfigured — the balance and
// the XpEvent row are the record; this is the readable copy.

const { e } = require('./emoji');

// The channel the XP logs go to.
const CHANNEL_ID = () => process.env.XP_LOG_CHANNEL_ID || '1531317662360146092';

const COLOR = {
  add:       0x2ed896,
  remove:    0xf04f5e,
  set:       0x4a8fff,
  promotion: 0xffc93c,
};

function short(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// A ten-pip bar showing how far through the current rank band they are.
function progressBar(p, width = 10) {
  if (!p.next) return `${e('met_star')} Top of the ladder`;
  const filled = Math.max(0, Math.min(width, Math.round(p.pct * width)));
  return e('met_dot_on').repeat(filled) + e('met_dot_off').repeat(width - filled)
    + `  **${p.have}/${p.span}** to ${p.next.name}`;
}

/**
 * Post one XP change.
 * @returns {Promise<string|null>} the message id, or null if it couldn't post
 */
async function logChange({ discordId, memberName, kind, delta, before, after, reason, capped, rank, issuedById, issuedBy }) {
  const up = delta > 0;
  const icon = kind === 'SET' ? e('met_edit') : up ? e('met_xp') : e('met_cross');
  const verb = kind === 'SET' ? 'XP set' : up ? 'XP added' : 'XP removed';

  const embed = {
    color: COLOR[kind.toLowerCase()] || COLOR.set,
    title: `${icon} ${verb}`,
    description:
      `${e('met_user')} **Officer** <@${discordId}>${memberName ? ` · ${short(memberName, 50)}` : ''}\n`
      + `${e('met_rank')} **Rank** ${rank ? rank.name : '—'}`,
    fields: [
      {
        name: 'Change',
        value: kind === 'SET'
          ? `**${before}** → **${after}** XP (set to ${after})`
          : `**${before}** → **${after}** XP (${delta > 0 ? '+' : ''}${delta})`,
        inline: true,
      },
      { name: 'By', value: issuedById ? `<@${issuedById}>` : (issuedBy || 'System'), inline: true },
      { name: 'Reason', value: short(reason || '*No reason given*', 1000), inline: false },
    ],
    footer: { text: 'MET XP' },
    timestamp: new Date().toISOString(),
  };

  // The one case where what happened differs from what was asked for.
  if (capped) {
    embed.fields.push({
      name: 'Note',
      value: `${e('met_warn')} They didn't have that much to take — the balance stopped at 0 rather than going negative.`,
      inline: false,
    });
  }

  return require('./bot').postChannelMessage(CHANNEL_ID(), {
    embeds: [embed],
    allowedMentions: { parse: [] },   // render the mention, never ping the channel
  });
}

/**
 * Post one promotion.
 * `groupResult` is what promoteInGroup returned — the log says plainly when the
 * Roblox rank did NOT move, because otherwise nobody finds out until the
 * officer asks why they're still a Constable.
 */
async function logPromotion({ discordId, memberName, from, to, xp, progress, groupResult, dmSent, avatar }) {
  const fields = [
    { name: 'Rank',  value: `${from.name} → **${to.name}**`, inline: true },
    { name: 'XP',    value: `**${xp}**`, inline: true },
    { name: 'Roblox group', value: groupResult && groupResult.ok
        ? `${e('met_tick')} Promoted to **${groupResult.to}**`
        : `${e('met_warn')} Not changed — ${short((groupResult && groupResult.reason) || 'unknown', 150)}`,
      inline: false },
  ];
  if (progress) fields.push({ name: 'Progress', value: progressBar(progress), inline: false });
  fields.push({
    name: 'Officer notified',
    value: dmSent ? `${e('met_tick')} DM sent` : `${e('met_warn')} Couldn't DM them — their DMs are closed`,
    inline: false,
  });

  const embed = {
    color: COLOR.promotion,
    title: `${e('met_promote')} Promotion — ${to.name}`,
    description: `${e('met_celebrate')} <@${discordId}>${memberName ? ` · ${short(memberName, 50)}` : ''} has reached **${to.at} XP** and made **${to.name}**.`,
    fields,
    footer: { text: 'MET XP · automatic promotion' },
    timestamp: new Date().toISOString(),
  };
  if (avatar) embed.thumbnail = { url: avatar };

  return require('./bot').postChannelMessage(CHANNEL_ID(), {
    content: `<@${discordId}>`,          // this one DOES ping — it's their promotion
    embeds: [embed],
  });
}

module.exports = { logChange, logPromotion, progressBar, CHANNEL_ID };
