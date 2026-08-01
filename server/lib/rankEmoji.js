// server/lib/rankEmoji.js
// The MET server's own rank emoji — :CON:, :SGT:, :INS:, :CINS: and the rest.
//
// Those predate anything here and are what the server already recognises, so a
// rank should be shown with its real insignia rather than with a generic mark
// we drew. This maps a rank NAME to the emoji names worth trying for it.
//
// Nothing here assumes an emoji exists. Every lookup runs through the bot's
// guild caches and returns '' if there's no match, so a server missing one (or
// naming it differently) shows the rank as plain text rather than a broken tag.

// Longest name first — "Deputy Assistant Commissioner" contains "Assistant
// Commissioner", which contains "Commissioner", and matching the short one
// first would put a Commissioner's pips on a DAC.
const RANKS = [
  { match: /deputy assistant commissioner/i,   names: ['DAC'] },
  { match: /assistant commissioner/i,          names: ['AC', 'ACC'] },
  { match: /deputy commissioner/i,             names: ['DC', 'DCC'] },
  { match: /\bcommissioner\b/i,                names: ['CMSR', 'CC'] },
  { match: /commander/i,                       names: ['COMM'] },
  { match: /chief superintendent/i,            names: ['CSUP'] },
  { match: /superintendent/i,                  names: ['SUP'] },
  { match: /chief inspector/i,                 names: ['CINS'] },
  { match: /(^|[^a-z])inspector/i,             names: ['INS'] },
  { match: /sergeant/i,                        names: ['SGT'] },
  { match: /(^|[^a-z])constable/i,             names: ['CON', 'PC'] },
  { match: /community support officer|\bcso\b/i, names: ['CSO', 'PCSO'] },
  { match: /cadet|recruit|trainee|awaiting/i,  names: ['CADET', 'REC'] },
];

/**
 * The emoji names worth trying for a rank, most specific first.
 * Always ends with the rank's own name and its acronym, so a server that named
 * its emoji `:Chief_Inspector:` or `:CI:` still resolves.
 */
function candidatesFor(rankName) {
  const name = String(rankName || '').trim();
  if (!name) return [];
  const hit = RANKS.find(r => r.match.test(name));
  const acronym = name.split(/[\s\-_]+/).filter(Boolean).map(w => w[0]).join('').toUpperCase();
  return [
    ...(hit ? hit.names : []),
    name.replace(/\s+/g, '_'),
    name.replace(/\s+/g, ''),
    // A one-letter acronym is not an identifier — "Constable" would try `:C:`
    // and take whatever happened to be called that.
    acronym.length >= 2 ? acronym : null,
  ].filter(Boolean);
}

/**
 * The server's emoji for a rank, ready to drop into a message.
 * @param {object} client the live discord.js client
 * @param {string} rankName e.g. "Chief Inspector"
 * @param {string} [fallback] returned when the server has no emoji for it
 * @returns {string} "<:CINS:123…>" or the fallback (default '')
 */
function forRank(client, rankName, fallback = '') {
  const { firstGuildEmoji } = require('./emoji');
  return firstGuildEmoji(client, candidatesFor(rankName)) || fallback;
}

module.exports = { forRank, candidatesFor, RANKS };
