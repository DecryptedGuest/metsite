// scripts/emoji/manifest.js
// The MET custom emoji set — one definition per emoji, used for three things:
//
//   1. scripts/build-emoji.js rasterises `svg` into client/public/img/emoji/<name>.png
//   2. server/lib/emoji.js uploads those PNGs to the Discord guild and resolves
//      e('name') → "<:met_name:12345>" for bot messages, embeds and webhooks
//   3. the site renders the same PNG inline, so Discord and the website show the
//      identical mark
//
// `fallback` is the unicode character the emoji replaces. It is what e() returns
// when the guild upload hasn't happened yet (or failed), so nothing ever renders
// as a broken tag — the worst case is that it looks the way it did before.
//
// `discord: false` marks a site-only emoji (seasonal effects, mostly). Those are
// never uploaded, which keeps the guild's emoji slots for the ones Discord
// actually needs — a non-boosted guild only has 50.
//
// ORDER MATTERS. The syncer uploads top to bottom, so if the guild runs out of
// emoji slots part-way the ones that matter most are already in. Add new emoji
// below the group they belong to, not at the top. (If slots are tight, point
// EMOJI_GUILD_ID at a second server the bot is in — resolution is by ID, so the
// emoji render anywhere the bot posts.)
//
// Art direction: flat, high-contrast, no fine detail. These are read at ~22px in
// a Discord message, so a shape that isn't obvious at that size is the wrong
// shape. Colours come from the site palette in client/public/css/main.css.

const C = {
  green:  '#2ed896',
  red:    '#f04f5e',
  amber:  '#f5b730',
  blue:   '#4a8fff',
  purple: '#9d7dff',
  cyan:   '#19c6d8',
  slate:  '#8fa3bd',
  ink:    '#0b1424',
  paper:  '#e8eef7',
  gold:   '#ffc93c',
};

// A filled disc behind a glyph — the shape most of these share.
const disc = (fill) => `<circle cx="64" cy="64" r="58" fill="${fill}"/>`;
// A rounded square, for the "badge" style marks (strikes, database, ticket).
const tile = (fill) => `<rect x="8" y="8" width="112" height="112" rx="26" fill="${fill}"/>`;
// The tick and cross glyphs, drawn as thick strokes so they survive downscaling.
const tickPath = (stroke, w = 14) =>
  `<path d="M36 66 L56 86 L92 44" fill="none" stroke="${stroke}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
const crossPath = (stroke, w = 14) =>
  `<path d="M42 42 L86 86 M86 42 L42 86" fill="none" stroke="${stroke}" stroke-width="${w}" stroke-linecap="round"/>`;

// Text glyph helper — used sparingly, only where a letterform reads better than
// a picture (the strike numbers).
const glyph = (t, fill, size = 62, dy = 22) =>
  `<text x="64" y="${64 + dy}" font-family="DejaVu Sans, Verdana, sans-serif" font-size="${size}" font-weight="bold" fill="${fill}" text-anchor="middle">${t}</text>`;

const EMOJI = [
  // ── Decisions ───────────────────────────────────────────────────
  { name: 'met_tick',    fallback: '✅', desc: 'approved / yes',
    svg: disc(C.green) + tickPath('#08210f') },
  { name: 'met_cross',   fallback: '❌', desc: 'denied / no',
    svg: disc(C.red) + crossPath('#2a0409') },
  { name: 'met_warn',    fallback: '⚠',  desc: 'warning',
    svg: `<path d="M64 12 L122 114 H6 Z" fill="${C.amber}"/>`
       + `<rect x="57" y="46" width="14" height="38" rx="7" fill="${C.ink}"/>`
       + `<circle cx="64" cy="97" r="8" fill="${C.ink}"/>` },
  { name: 'met_pending', fallback: '🟡', desc: 'pending / waiting',
    svg: disc(C.amber)
       + `<path d="M64 34 V64 L84 78" fill="none" stroke="${C.ink}" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>` },
  { name: 'met_stop',    fallback: '🛑', desc: 'stop / halt',
    svg: `<path d="M115.7 85.4 L85.4 115.7 L42.6 115.7 L12.3 85.4 L12.3 42.6 L42.6 12.3 L85.4 12.3 L115.7 42.6 Z" fill="${C.red}"/>`
       + `<rect x="34" y="56" width="60" height="16" rx="8" fill="${C.paper}"/>` },
  { name: 'met_denied',  fallback: '⛔', desc: 'blocked / forbidden',
    svg: disc(C.red)
       + `<circle cx="64" cy="64" r="58" fill="none" stroke="#2a0409" stroke-width="8"/>`
       + `<rect x="30" y="56" width="68" height="16" rx="8" fill="#2a0409" transform="rotate(-45 64 64)"/>` },

  // ── Status dots ─────────────────────────────────────────────────
  { name: 'met_online',  fallback: '🟢', desc: 'online / live',
    svg: disc(C.green) + `<circle cx="64" cy="64" r="26" fill="#0d3a24" opacity=".35"/>` },
  { name: 'met_offline', fallback: '🔴', desc: 'offline / stopped',
    svg: disc(C.red) + `<circle cx="64" cy="64" r="26" fill="#3a0d14" opacity=".35"/>` },

  // ── Discipline ──────────────────────────────────────────────────
  { name: 'met_strike1', fallback: '⚠',  desc: 'disciplinary strike 1',
    svg: tile(C.amber) + glyph('1', C.ink) },
  { name: 'met_strike2', fallback: '⚠',  desc: 'disciplinary strike 2',
    svg: tile('#ff8b3d') + glyph('2', C.ink) },
  { name: 'met_strike3', fallback: '⛔', desc: 'disciplinary strike 3',
    svg: tile(C.red) + glyph('3', C.paper) },
  { name: 'met_gavel',   fallback: '⚖',  desc: 'disciplinary action',
    svg: `<rect x="12" y="100" width="104" height="18" rx="9" fill="${C.slate}"/>`
       + `<g transform="rotate(-38 64 58)">`
       + `<rect x="26" y="34" width="76" height="30" rx="9" fill="${C.gold}"/>`
       + `<rect x="57" y="62" width="14" height="42" rx="7" fill="#c8901f"/></g>` },
  { name: 'met_scales',  fallback: '⚖',  desc: 'internal affairs / justice',
    // Redrawn. The old one was a thin gold armature: correct as a diagram of a
    // balance, and at 22px an indistinct sliver, which is the worst outcome for
    // the mark that stands for Internal Affairs itself.
    //
    // Everything is heavier and there is less of it. The pans are wide solid
    // wedges — the widest thing in the shape, so they set the silhouette — and
    // they hang BELOW the beam with a gap, which is what makes it read as a
    // balance rather than as a lump.
    svg: `<rect x="57" y="16" width="14" height="86" rx="7" fill="${C.gold}"/>`
       + `<rect x="12" y="30" width="104" height="14" rx="7" fill="${C.gold}"/>`
       + `<g fill="${C.gold}">`
       + `<path d="M4 56 h56 L32 96 Z"/><path d="M68 56 h56 L96 96 Z"/></g>`
       // The hangers, so the pans are visibly suspended from the ends of the beam.
       + `<g stroke="${C.gold}" stroke-width="6"><path d="M32 44 V56"/><path d="M96 44 V56"/></g>`
       + `<rect x="30" y="102" width="68" height="16" rx="8" fill="${C.gold}"/>` },
  { name: 'met_kick',    fallback: '👢', desc: 'kicked from the group',
    svg: `<path d="M38 16 h30 v46 q0 8 8 12 l24 12 q10 5 10 16 v10 H38 Z" fill="#7a4a22"/>`
       + `<rect x="32" y="106" width="82" height="14" rx="7" fill="${C.ink}"/>` },
  { name: 'met_leave',   fallback: '🚪', desc: 'left / removed',
    svg: `<rect x="14" y="10" width="56" height="108" rx="6" fill="${C.slate}"/>`
       + `<rect x="24" y="20" width="36" height="88" rx="4" fill="${C.ink}"/>`
       + `<circle cx="52" cy="66" r="5" fill="${C.slate}"/>`
       + `<path d="M78 56 h22 V40 l26 24 -26 24 V72 H78 Z" fill="${C.red}"/>` },

  // ── Dashboard objects ──────────────────────────────────────────────
  { name: 'met_shield',  fallback: '🛡',  desc: 'MET / protected',
    svg: `<path d="M64 8 L114 30 v34 c0 32 -22 50 -50 58 -28 -8 -50 -26 -50 -58 V30 Z" fill="${C.blue}"/>`
       + tickPath('#0b1f47', 12) },
  { name: 'met_folder',  fallback: '📁', desc: 'case / folder',
    // One flat colour meant the tab had no edge to show, so at 22px this was an
    // amber rectangle and nothing more. Two tones and a visible front flap give
    // it an internal line, which is the only thing that makes a folder a folder
    // when it is 22 pixels wide.
    svg: `<path d="M8 30 h40 l12 14 h60 a8 8 0 0 1 8 8 v56 a8 8 0 0 1 -8 8 H8 a8 8 0 0 1 -8 -8 V38 a8 8 0 0 1 8 -8 Z" fill="#c8901f"/>`
       + `<path d="M4 58 h120 a6 6 0 0 1 6 6 v44 a8 8 0 0 1 -8 8 H6 a8 8 0 0 1 -8 -8 V64 a6 6 0 0 1 6 -6 Z" fill="${C.amber}"/>` },
  { name: 'met_ticket',  fallback: '🎫', desc: 'ticket log',
    svg: tile(C.cyan)
       + `<path d="M30 46 h68 v14 a10 10 0 0 0 0 20 v14 H30 V80 a10 10 0 0 0 0 -20 Z" fill="${C.ink}"/>` },
  { name: 'met_database',fallback: '🗄',  desc: 'database / records',
    svg: `<ellipse cx="64" cy="30" rx="46" ry="16" fill="${C.cyan}"/>`
       + `<path d="M18 30 v34 c0 9 21 16 46 16 s46 -7 46 -16 V30 Z" fill="${C.cyan}" opacity=".8"/>`
       + `<path d="M18 66 v32 c0 9 21 16 46 16 s46 -7 46 -16 V66 Z" fill="${C.cyan}" opacity=".6"/>` },
  { name: 'met_link',    fallback: '🔗', desc: 'link',
    svg: `<g fill="none" stroke="${C.blue}" stroke-width="14" stroke-linecap="round">`
       + `<path d="M52 76 L76 52"/><path d="M46 62 L34 74 a20 20 0 0 0 28 28 l12 -12"/>`
       + `<path d="M82 66 L94 54 a20 20 0 0 0 -28 -28 L54 38"/></g>` },
  { name: 'met_edit',    fallback: '✏',  desc: 'edit / changes requested',
    svg: `<path d="M22 88 L88 22 l18 18 L40 106 H22 Z" fill="${C.amber}"/>`
       + `<path d="M84 26 l18 18" stroke="${C.ink}" stroke-width="8" stroke-linecap="round"/>` },
  { name: 'met_search',  fallback: '🔎', desc: 'search / lookup',
    svg: `<circle cx="56" cy="54" r="30" fill="none" stroke="${C.blue}" stroke-width="13"/>`
       + `<path d="M78 78 L106 106" stroke="${C.blue}" stroke-width="15" stroke-linecap="round"/>` },
  { name: 'met_lock',    fallback: '🔒', desc: 'locked / secure',
    svg: `<path d="M42 58 V42 a22 22 0 0 1 44 0 v16" fill="none" stroke="${C.slate}" stroke-width="13"/>`
       + `<rect x="26" y="56" width="76" height="58" rx="12" fill="${C.amber}"/>`
       + `<circle cx="64" cy="82" r="9" fill="${C.ink}"/>` },
  { name: 'met_star',    fallback: '⭐', desc: 'featured / investigator of the week',
    svg: `<path d="M64 10 l16 34 38 5 -28 26 7 38 -33 -18 -33 18 7 -38 -28 -26 38 -5 Z" fill="${C.gold}"/>` },
  { name: 'met_announce',fallback: '📢', desc: 'announcement',
    svg: `<path d="M20 52 h22 L88 24 v80 L42 76 H20 a8 8 0 0 1 -8 -8 V60 a8 8 0 0 1 8 -8 Z" fill="${C.blue}"/>`
       + `<path d="M100 48 a26 26 0 0 1 0 32" fill="none" stroke="${C.blue}" stroke-width="10" stroke-linecap="round"/>` },
  { name: 'met_bot',     fallback: '🤖', desc: 'automated / bot',
    svg: tile(C.slate)
       + `<circle cx="48" cy="60" r="9" fill="${C.ink}"/><circle cx="80" cy="60" r="9" fill="${C.ink}"/>`
       + `<rect x="44" y="82" width="40" height="10" rx="5" fill="${C.ink}"/>`
       + `<rect x="60" y="10" width="8" height="14" rx="4" fill="${C.slate}"/>` },
  { name: 'met_celebrate',fallback:'🎉', desc: 'quota met / success',
    svg: `<path d="M16 112 L54 34 l40 40 Z" fill="${C.purple}"/>`
       + `<circle cx="92" cy="26" r="8" fill="${C.gold}"/><circle cx="112" cy="52" r="6" fill="${C.green}"/>`
       + `<circle cx="74" cy="14" r="5" fill="${C.cyan}"/>` },
  { name: 'met_radio',   fallback: '📻', desc: 'CAD radio',
    svg: `<rect x="12" y="46" width="104" height="62" rx="12" fill="${C.slate}"/>`
       + `<circle cx="42" cy="78" r="16" fill="${C.ink}"/>`
       + `<rect x="68" y="62" width="36" height="10" rx="5" fill="${C.ink}"/>`
       + `<rect x="68" y="84" width="36" height="10" rx="5" fill="${C.ink}"/>`
       + `<path d="M74 44 L98 16" stroke="${C.slate}" stroke-width="8" stroke-linecap="round"/>` },
  { name: 'met_mic',     fallback: '🎙',  desc: 'voice / microphone',
    svg: `<rect x="50" y="14" width="28" height="56" rx="14" fill="${C.paper}"/>`
       + `<path d="M36 62 a28 28 0 0 0 56 0" fill="none" stroke="${C.blue}" stroke-width="11" stroke-linecap="round"/>`
       + `<rect x="58" y="90" width="12" height="24" rx="6" fill="${C.blue}"/>` },
  { name: 'met_speaker', fallback: '🔊', desc: 'audio on',
    svg: `<path d="M18 50 h20 L68 24 v80 L38 78 H18 a6 6 0 0 1 -6 -6 V56 a6 6 0 0 1 6 -6 Z" fill="${C.paper}"/>`
       + `<g fill="none" stroke="${C.green}" stroke-width="9" stroke-linecap="round">`
       + `<path d="M84 48 a24 24 0 0 1 0 32"/><path d="M98 34 a44 44 0 0 1 0 60"/></g>` },

  // ── People and rank ─────────────────────────────────────────────
  { name: 'met_user',    fallback: '👤', desc: 'officer / member',
    svg: disc('#1b2942')
       + `<circle cx="64" cy="50" r="21" fill="${C.paper}"/>`
       + `<path d="M26 108 a38 34 0 0 1 76 0 Z" fill="${C.paper}"/>` },
  { name: 'met_rank',    fallback: '🎖',  desc: 'group rank',
    svg: `<g fill="${C.gold}">`
       + `<path d="M64 14 L112 50 H92 L64 30 L36 50 H16 Z"/>`
       + `<path d="M64 52 L112 88 H92 L64 68 L36 88 H16 Z"/>`
       + `<path d="M64 86 L104 116 H24 Z" opacity=".55"/></g>` },

  // ── XP ──────────────────────────────────────────────────────────
  { name: 'met_xp',      fallback: '✨', desc: 'experience points',
    svg: tile(C.purple) + glyph('XP', C.paper, 46, 16) },
  { name: 'met_promote', fallback: '⬆', desc: 'promoted',
    svg: disc(C.green)
       + `<path d="M64 30 L98 68 H78 V98 H50 V68 H30 Z" fill="#08210f"/>` },

  // ── Weekly quota check ──────────────────────────────────────────
  // The review posts every Sunday night and is read at a glance by twenty
  // people, so it gets marks of its own rather than a plain tick and cross:
  // "met the quota" is a different fact from "approved".
  { name: 'met_quota_met',  fallback: '\u{1F3AF}', desc: 'quota met',
    svg: disc(C.green)
       + `<circle cx="64" cy="64" r="36" fill="none" stroke="#08210f" stroke-width="9"/>`
       + `<circle cx="64" cy="64" r="14" fill="#08210f"/>` },
  { name: 'met_quota_miss', fallback: '\u{1F4C9}', desc: 'quota not met',
    svg: disc(C.amber)
       + `<path d="M28 44 L58 74 L74 58 L100 84" fill="none" stroke="${C.ink}"`
       + ` stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>`
       + `<path d="M100 60 V84 H76" fill="none" stroke="${C.ink}" stroke-width="11"`
       + ` stroke-linecap="round" stroke-linejoin="round"/>` },
  { name: 'met_exempt',     fallback: '\u{1F6E1}', desc: 'exempt from quota',
    svg: tile(C.purple) + glyph('EX', C.paper, 44, 15) },
  { name: 'met_trophy',     fallback: '\u{1F3C6}', desc: 'investigator of the week',
    svg: `<path d="M40 16 h48 v26 a24 24 0 0 1 -48 0 Z" fill="${C.gold}"/>`
       + `<path d="M40 22 H24 a16 16 0 0 0 16 22 Z M88 22 h16 a16 16 0 0 1 -16 22 Z" fill="${C.gold}"/>`
       + `<rect x="56" y="66" width="16" height="24" fill="${C.gold}"/>`
       + `<rect x="38" y="90" width="52" height="16" rx="6" fill="#8a6a12"/>`
       + `<rect x="30" y="106" width="68" height="14" rx="7" fill="${C.ink}"/>` },
  { name: 'met_chart',      fallback: '\u{1F4CA}', desc: 'weekly figures',
    svg: tile(C.blue)
       + `<g fill="${C.paper}"><rect x="28" y="70" width="16" height="30" rx="4"/>`
       + `<rect x="56" y="52" width="16" height="48" rx="4"/>`
       + `<rect x="84" y="34" width="16" height="66" rx="4"/></g>` },

  // ── Leave of absence ────────────────────────────────────────────
  // /loa needs marks of its own: a date range, time left to run, and coming
  // back. met_leave is a door and reads as "gone", which is the wrong idea —
  // an LOA is a return date, not a departure.
  { name: 'met_calendar', fallback: '\u{1F4C5}', desc: 'a date / a leave period',
    svg: `<rect x="12" y="24" width="104" height="92" rx="12" fill="${C.paper}"/>`
       + `<rect x="12" y="24" width="104" height="26" rx="12" fill="${C.blue}"/>`
       + `<rect x="34" y="12" width="12" height="24" rx="6" fill="${C.ink}"/>`
       + `<rect x="82" y="12" width="12" height="24" rx="6" fill="${C.ink}"/>`
       + `<g fill="${C.ink}"><rect x="30" y="62" width="18" height="16" rx="4"/>`
       + `<rect x="56" y="62" width="18" height="16" rx="4"/>`
       + `<rect x="82" y="62" width="18" height="16" rx="4"/>`
       + `<rect x="30" y="86" width="18" height="16" rx="4"/>`
       + `<rect x="56" y="86" width="18" height="16" rx="4"/></g>` },
  { name: 'met_hourglass', fallback: '\u{23F3}', desc: 'time left to run',
    svg: `<path d="M32 12 h64 v18 L74 64 l22 34 v18 H32 v-18 l22 -34 -22 -34 Z" fill="${C.amber}"/>`
       + `<rect x="24" y="8" width="80" height="12" rx="6" fill="${C.ink}"/>`
       + `<rect x="24" y="108" width="80" height="12" rx="6" fill="${C.ink}"/>`
       + `<path d="M50 96 h28 l-14 -20 Z" fill="${C.ink}" opacity=".45"/>` },
  { name: 'met_return',   fallback: '\u{1F519}', desc: 'back from leave',
    svg: disc(C.green)
       + `<path d="M78 40 H56 a22 22 0 1 0 0 44 h6" fill="none" stroke="#08210f"`
       + ` stroke-width="12" stroke-linecap="round"/>`
       + `<path d="M68 26 L86 40 L68 54 Z" fill="#08210f"/>` },

  // ── Patrol and event logs ───────────────────────────────────────
  // A patrol log and an event log are the two things IA files most often, and
  // both are read in Discord as an embed. Generic marks made them look like every
  // other embed the bot sends, so each field on those logs gets a mark that says
  // what that field IS — the shift times, the roll, the proof — rather than a
  // decoration.
  //
  // met_patrol is the Sillitoe tartan: the blue-and-white check on a British
  // police cap band. It is the one mark in this set that needs no explaining to
  // anybody who has seen a police car, and a two-row checkerboard is still
  // legible at 22px when a car silhouette is not.
  { name: 'met_patrol', fallback: '\u{1F693}', desc: 'patrol log',
    // Clipped rather than outlined. An outline thick enough to define the tile at
    // 96px eats a third of the check at 22px, and the check IS the mark.
    svg: `<defs><clipPath id="pb"><rect x="8" y="32" width="112" height="64" rx="12"/></clipPath></defs>`
       + `<g clip-path="url(#pb)">`
       + `<rect x="8" y="32" width="112" height="64" fill="${C.paper}"/>`
       + `<g fill="${C.blue}">`
       + `<rect x="8"  y="32" width="28" height="32"/><rect x="64" y="32" width="28" height="32"/>`
       + `<rect x="36" y="64" width="28" height="32"/><rect x="92" y="64" width="28" height="32"/>`
       + `</g></g>` },
  // An event is a thing on a date that people turn up to. A pennant on a staff
  // reads as "an occasion" at any size, and it is distinct in silhouette from
  // every other mark here — nothing else in the set is a tall vertical.
  { name: 'met_event', fallback: '\u{1F3C1}', desc: 'event log',
    svg: `<rect x="24" y="12" width="12" height="104" rx="6" fill="${C.slate}"/>`
       + `<path d="M36 20 h72 l-18 24 18 24 H36 Z" fill="${C.purple}"/>`
       + `<circle cx="30" cy="14" r="9" fill="${C.gold}"/>` },
  // A shift is a span of time, and it is drawn as a span rather than as a clock
  // ON PURPOSE. A clock face was the obvious choice and it was wrong: met_pending
  // is already an amber clock, and at 22px two discs with hands on them are the
  // same mark in two colours — they would sit in the same embed, one as the
  // status and one as the shift, and read as a mistake.
  //
  // A wide, short silhouette is unlike anything else in this set, so it survives
  // being small. Two end-stops with a bar between them, the first half filled:
  // from, to, and time spent.
  { name: 'met_clock', fallback: '\u{1F551}', desc: 'shift span (from → to)',
    svg: `<g fill="${C.blue}"><rect x="10" y="36" width="14" height="56" rx="7"/>`
       + `<rect x="104" y="36" width="14" height="56" rx="7"/></g>`
       + `<rect x="24" y="54" width="80" height="20" rx="10" fill="#2a3a55"/>`
       + `<rect x="24" y="54" width="48" height="20" rx="10" fill="${C.cyan}"/>` },
  // The roll. Two heads and shoulders, the front one overlapping, which is what
  // makes it read as "more than one person" rather than as a blob.
  { name: 'met_users', fallback: '\u{1F465}', desc: 'attendees / the roll',
    svg: `<g fill="${C.slate}"><circle cx="88" cy="48" r="19"/>`
       + `<path d="M56 106 a34 30 0 0 1 68 0 Z"/></g>`
       + `<g fill="${C.cyan}"><circle cx="48" cy="46" r="23" stroke="${C.ink}" stroke-width="6"/>`
       + `<path d="M8 108 a40 34 0 0 1 80 0 Z" stroke="${C.ink}" stroke-width="6"/></g>` },
  // Proof. A lens big enough to be the whole point of the shape — a camera drawn
  // to scale is a grey rectangle at 22px.
  { name: 'met_camera', fallback: '\u{1F4F8}', desc: 'proof / screenshots',
    svg: `<rect x="8" y="34" width="112" height="80" rx="16" fill="${C.slate}"/>`
       + `<path d="M44 34 l10 -14 h20 l10 14 Z" fill="${C.slate}"/>`
       + `<circle cx="64" cy="74" r="28" fill="${C.ink}"/>`
       + `<circle cx="64" cy="74" r="16" fill="${C.cyan}"/>`
       + `<circle cx="102" cy="50" r="6" fill="${C.amber}"/>` },
  // Notes. A page with ruled lines — deliberately NOT met_edit's pencil, which
  // means "change this", nor met_folder, which means "a case".
  { name: 'met_note', fallback: '\u{1F4DD}', desc: 'notes on a log',
    svg: `<rect x="22" y="10" width="84" height="108" rx="10" fill="${C.paper}"/>`
       + `<g fill="${C.blue}"><rect x="36" y="34" width="56" height="9" rx="4"/>`
       + `<rect x="36" y="56" width="56" height="9" rx="4"/>`
       + `<rect x="36" y="78" width="36" height="9" rx="4"/></g>`
       + `<rect x="22" y="10" width="12" height="108" fill="${C.blue}"/>` },

  // ── Recruitment (/met) ──────────────────────────────────────────
  // The buttons on the recruitment post. A Discord button emoji renders at the
  // same size as a message one, so the same rule applies — and these two sit next
  // to text, so they need a silhouette that is not a rectangle.
  { name: 'met_dm', fallback: '\u{1F4E9}', desc: 'sent to your DMs',
    svg: `<rect x="8" y="26" width="112" height="76" rx="12" fill="${C.paper}"/>`
       // The flap, filled, so the envelope reads as an envelope at 22px rather
       // than as a pale rectangle.
       + `<path d="M8 34 L64 74 L120 34 v-2 a10 10 0 0 0 -10 -8 H18 a10 10 0 0 0 -10 8 Z" fill="${C.blue}"/>`
       + `<path d="M8 38 L64 78 L120 38" fill="none" stroke="${C.blue}" stroke-width="9" stroke-linejoin="round"/>` },
  // A marked paper: the exam, as distinct from met_note, which is just notes.
  { name: 'met_exam', fallback: '\u{1F4C4}', desc: 'the final exam',
    svg: `<rect x="20" y="8" width="88" height="112" rx="10" fill="${C.paper}"/>`
       + `<g fill="${C.slate}"><rect x="34" y="28" width="44" height="8" rx="4"/>`
       + `<rect x="34" y="48" width="60" height="8" rx="4"/>`
       + `<rect x="34" y="68" width="36" height="8" rx="4"/></g>`
       // The tick is the mark, so it is the biggest thing on the page and it
       // overhangs the edge — which is what stops this reading as met_note.
       + `<circle cx="90" cy="92" r="30" fill="${C.green}"/>`
       + `<path d="M76 92 L88 104 L106 82" fill="none" stroke="#08210f" stroke-width="11"`
       + ` stroke-linecap="round" stroke-linejoin="round"/>` },

  // ── Loading animation ───────────────────────────────────────────
  // Four frames of one spinner. The bot doesn't use animated emoji — it edits
  // the ephemeral embed frame by frame, which renders as a spin and degrades to
  // a plain hourglass if the upload never happened.
  ...[0, 1, 2, 3].map(i => ({
    name: `met_load${i + 1}`, fallback: '⏳', desc: `loading spinner, frame ${i + 1}`,
    svg: `<circle cx="64" cy="64" r="48" fill="none" stroke="#2a3a55" stroke-width="14"/>`
       + `<g transform="rotate(${i * 90 - 90} 64 64)">`
       + `<circle cx="64" cy="64" r="48" fill="none" stroke="${C.blue}" stroke-width="14"`
       + ` stroke-linecap="round" stroke-dasharray="75 227"/></g>`,
  })),
  // Progress pips — the step tracker in the discipline panel fills these left to
  // right as each stage lands.
  { name: 'met_dot_on',  fallback: '🔵', desc: 'progress step done',
    svg: `<circle cx="64" cy="64" r="40" fill="${C.blue}"/>` },
  { name: 'met_dot_off', fallback: '⚪', desc: 'progress step pending',
    svg: `<circle cx="64" cy="64" r="34" fill="none" stroke="#3f5170" stroke-width="12"/>` },

  // ── Internal Affairs dashboard (/ia) ────────────────────────────
  // The /ia panel is a whole dashboard in a message, so it needs marks for the
  // things a dashboard has: sections, a review queue, a verdict, a rank. These
  // are IA's own — amber/purple against the MET blue — so a glance at an embed
  // says "this is Internal Affairs" before you have read a word of it.
  { name: 'met_ia',        fallback: '🛡', desc: 'Internal Affairs crest',
    svg: `<path d="M64 8 L114 30 v34 c0 32 -22 50 -50 58 -28 -8 -50 -26 -50 -58 V30 Z" fill="${C.purple}"/>`
       + `<circle cx="58" cy="56" r="19" fill="none" stroke="${C.paper}" stroke-width="9"/>`
       + `<path d="M72 70 L92 90" stroke="${C.paper}" stroke-width="10" stroke-linecap="round"/>` },
  { name: 'met_ia_home',   fallback: '🏠', desc: 'dashboard home',
    svg: tile(C.purple)
       + `<path d="M28 66 L64 34 L100 66 v30 a6 6 0 0 1 -6 6 H34 a6 6 0 0 1 -6 -6 Z" fill="${C.paper}"/>`
       + `<rect x="56" y="76" width="16" height="26" fill="${C.purple}"/>` },
  { name: 'met_ia_queue',  fallback: '📥', desc: 'pending review queue',
    svg: tile(C.amber)
       + `<path d="M26 70 h20 l8 12 h20 l8 -12 h20 v26 a6 6 0 0 1 -6 6 H32 a6 6 0 0 1 -6 -6 Z" fill="${C.ink}"/>`
       + `<path d="M64 24 v30 M50 44 L64 58 L78 44" fill="none" stroke="${C.ink}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>` },
  { name: 'met_ia_verdict',fallback: '⚖', desc: 'decision recorded',
    svg: disc(C.gold)
       + `<path d="M64 26 v72 M36 44 h56" stroke="${C.ink}" stroke-width="9" stroke-linecap="round"/>`
       + `<path d="M36 44 L24 70 h24 Z M92 44 L80 70 h24 Z" fill="${C.ink}"/>` },
  { name: 'met_ia_locked', fallback: '⛔', desc: 'above your rank',
    svg: disc(C.slate)
       + `<path d="M44 60 V46 a20 20 0 0 1 40 0 v14" fill="none" stroke="${C.ink}" stroke-width="11"/>`
       + `<rect x="34" y="58" width="60" height="46" rx="10" fill="${C.ink}"/>` },
  { name: 'met_ia_case',   fallback: '🗂', desc: 'IA case file',
    svg: `<path d="M14 26 h44 l10 12 h46 a8 8 0 0 1 8 8 v58 a8 8 0 0 1 -8 8 H14 a8 8 0 0 1 -8 -8 V34 a8 8 0 0 1 8 -8 Z" fill="#6f56c4"/>`
       + `<rect x="30" y="54" width="68" height="52" rx="6" fill="${C.paper}"/>`
       + `<g stroke="#6f56c4" stroke-width="7" stroke-linecap="round">`
       + `<path d="M42 70 h44 M42 84 h44 M42 96 h26"/></g>` },
  { name: 'met_ia_evidence',fallback:'📎', desc: 'exhibit / evidence',
    svg: tile(C.cyan)
       + `<path d="M84 44 L52 76 a13 13 0 0 0 18 18 l30 -30 a22 22 0 0 0 -31 -31 L36 66 a31 31 0 0 0 44 44"`
       + ` fill="none" stroke="${C.ink}" stroke-width="9" stroke-linecap="round"/>` },
  { name: 'met_ia_stats',  fallback: '📊', desc: 'IA statistics',
    svg: tile(C.purple)
       + `<g fill="${C.paper}"><rect x="30" y="66" width="16" height="36" rx="4"/>`
       + `<rect x="56" y="46" width="16" height="56" rx="4"/>`
       + `<rect x="82" y="30" width="16" height="72" rx="4"/></g>` },
  { name: 'met_ia_quota',  fallback: '🎯', desc: 'weekly quota target',
    svg: disc(C.paper) + `<circle cx="64" cy="64" r="40" fill="${C.red}"/>`
       + `<circle cx="64" cy="64" r="24" fill="${C.paper}"/>`
       + `<circle cx="64" cy="64" r="10" fill="${C.red}"/>` },
  { name: 'met_ia_appeal', fallback: '🔨', desc: 'appeal granted',
    svg: `<path d="M22 96 L62 56 l14 14 -40 40 Z" fill="#8a6a3a"/>`
       + `<rect x="64" y="24" width="44" height="26" rx="7" transform="rotate(45 86 37)" fill="${C.slate}"/>` },
  { name: 'met_ia_officer',fallback: '🕵', desc: 'officer under investigation',
    svg: disc('#1b2942')
       + `<path d="M28 46 q36 -22 72 0" fill="none" stroke="${C.paper}" stroke-width="9" stroke-linecap="round"/>`
       + `<circle cx="64" cy="62" r="17" fill="${C.paper}"/>`
       + `<path d="M30 108 a34 30 0 0 1 68 0 Z" fill="${C.paper}"/>` },
  { name: 'met_ia_prev',   fallback: '◀', desc: 'previous page',
    svg: disc('#2a3a58') + `<path d="M76 34 L46 64 L76 94" fill="none" stroke="${C.paper}" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/>` },
  { name: 'met_ia_next',   fallback: '▶', desc: 'next page',
    svg: disc('#2a3a58') + `<path d="M52 34 L82 64 L52 94" fill="none" stroke="${C.paper}" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/>` },
  { name: 'met_ia_refresh',fallback: '🔄', desc: 'refresh the panel',
    svg: `<path d="M64 22 a42 42 0 1 0 42 42" fill="none" stroke="${C.green}" stroke-width="13" stroke-linecap="round"/>`
       + `<path d="M64 4 L64 40 L94 22 Z" fill="${C.green}"/>` },

  // ── Site-only (seasonal effects) ────────────────────────────────
  { name: 'met_pumpkin', fallback: '🎃', discord: false, desc: 'halloween',
    svg: `<ellipse cx="64" cy="76" rx="52" ry="44" fill="#ff7a1a"/>`
       + `<rect x="58" y="20" width="12" height="20" rx="6" fill="#3d7a2a"/>`
       + `<path d="M42 66 l14 -12 v18 Z M86 66 l-14 -12 v18 Z" fill="${C.ink}"/>`
       + `<path d="M40 90 h48 l-8 10 h-10 l-6 -8 -6 8 h-10 Z" fill="${C.ink}"/>` },
  { name: 'met_ghost',   fallback: '👻', discord: false, desc: 'halloween',
    svg: `<path d="M64 12 a44 44 0 0 1 44 44 v58 l-15 -12 -14 12 -15 -12 -15 12 -15 -12 -14 12 V56 a44 44 0 0 1 44 -44 Z" fill="${C.paper}"/>`
       + `<circle cx="50" cy="58" r="8" fill="${C.ink}"/><circle cx="78" cy="58" r="8" fill="${C.ink}"/>` },
  { name: 'met_bat',     fallback: '🦇', discord: false, desc: 'halloween',
    svg: `<path d="M50 40 l6 -22 10 16 h-4 Z M78 40 l-6 -22 -10 16 h4 Z" fill="#241a33"/>`
       + `<ellipse cx="64" cy="62" rx="17" ry="21" fill="#241a33"/>`
       + `<path d="M47 52 q-18 -14 -40 -6 q14 6 12 18 q12 -6 18 4 q6 -10 10 -16 Z" fill="#241a33"/>`
       + `<path d="M81 52 q18 -14 40 -6 q-14 6 -12 18 q-12 -6 -18 4 q-6 -10 -10 -16 Z" fill="#241a33"/>`
       + `<circle cx="57" cy="58" r="4" fill="#ffb02e"/><circle cx="71" cy="58" r="4" fill="#ffb02e"/>` },
  { name: 'met_spider',  fallback: '🕷',  discord: false, desc: 'halloween',
    svg: `<g stroke="${C.ink}" stroke-width="7" stroke-linecap="round">`
       + `<path d="M40 44 L14 24 M40 60 L10 56 M40 76 L14 96 M88 44 L114 24 M88 60 L118 56 M88 76 L114 96"/></g>`
       + `<ellipse cx="64" cy="66" rx="26" ry="30" fill="${C.ink}"/>` },
  { name: 'met_web',     fallback: '🕸',  discord: false, desc: 'halloween',
    svg: `<g fill="none" stroke="${C.paper}" stroke-width="6" stroke-linecap="round">`
       + `<path d="M10 10 V118 M10 10 H118 M10 10 L92 92 M10 10 L52 118 M10 10 L118 52"/>`
       + `<path d="M10 42 Q30 30 42 10 M10 74 Q46 46 74 10 M10 106 Q62 62 106 10"/></g>` },
  { name: 'met_snow',    fallback: '❄',  discord: false, desc: 'winter',
    svg: `<g stroke="${C.cyan}" stroke-width="8" stroke-linecap="round">`
       + `<path d="M64 12 V116 M20 38 L108 90 M108 38 L20 90"/>`
       + `<path d="M50 26 L64 38 L78 26 M50 102 L64 90 L78 102"/></g>` },
];

module.exports = { EMOJI, C };
