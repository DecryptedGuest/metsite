// server/lib/tryouts.js
// MET (HPC) tryout scheduling: a background worker fires each scheduled tryout
// at its time — provisioning a Roblox private server, then DMing the host the
// details + link with buttons to pick a co-host and post the announcement.
//
// The Roblox-server + Discord-DM steps need external config (see getServerLink
// and lib/bot.sendTryoutHostDM); they no-op gracefully until configured, so the
// scheduling/web/public parts work regardless.
const prisma = require('./db');

const TRYOUT_PING_ROLE = () => process.env.TRYOUT_PING_ROLE_ID || '1432426322059329567';

// The MET custom guild emoji. Discord only renders a custom emoji from its full
// token `<:name:id>` — a bare `:HPC:` shows as literal text. Overridable via env
// in case the emoji is re-uploaded (new id).
const HPC_EMOJI = () => process.env.TRYOUT_HPC_EMOJI || '<:HPC:1191469403087319120>';

// Split a comma/space-separated list of Discord ids into a clean array.
function splitIds(v) { return String(v || '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean); }

// Per-division tryout config. HPC is the original programme; CID is a parallel
// programme with its own Discord channel, ping roles, custom emoji and labels.
// Everything no-ops gracefully until the relevant env vars are set. `division`
// on a Tryout/TryoutLog row selects which config applies — HPC and CID never mix.
function divisionConfig(division) {
  const d = String(division || 'HPC').toUpperCase();
  if (d === 'CID') {
    // Ping roles: the two named env vars (CID_TRYOUT_PING_ROLE_1/2) take
    // precedence; fall back to the comma-separated CID_TRYOUT_PING_ROLE_IDS.
    const namedPings = [process.env.CID_TRYOUT_PING_ROLE_1, process.env.CID_TRYOUT_PING_ROLE_2].filter(Boolean);
    return {
      division:               'CID',
      channelId:              process.env.CID_TRYOUT_CHANNEL_ID || null,
      pingRoleIds:            namedPings.length ? namedPings : splitIds(process.env.CID_TRYOUT_PING_ROLE_IDS),
      emoji:                  process.env.CID_EMOJI || ':CID:',
      eventType:              'CID Tryout',
      // Host-DM presentation (CID-specific, so a CID host never sees HPC wording).
      dashboardSlug:          'cid',
      panelName:              'CID Tryout Panel',
      dmTitle:                'Your CID Tryout is live',
      dmColor:                0xe8842a,
      recruitmentChannelId:   process.env.CID_RECRUITMENT_CHANNEL_ID || null,
      recruitmentPingRoleIds: splitIds(process.env.CID_RECRUITMENT_PING_ROLE_IDS),
      recruitmentInvite:      process.env.CID_RECRUITMENT_INVITE || 'https://discord.gg/PEV6H9suC6',
      recruitmentInfo:        process.env.CID_RECRUITMENT_INFO || null,
      logWebhook:             process.env.CID_TRYOUT_LOG_WEBHOOK || null,
    };
  }
  return {
    division:    'HPC',
    channelId:   process.env.TRYOUT_ANNOUNCE_CHANNEL_ID || null,
    pingRoleIds: [TRYOUT_PING_ROLE()],
    emoji:       HPC_EMOJI(),
    eventType:   'MET Tryout',
    dashboardSlug: 'hpc',
    panelName:     'HPC Instructor Panel',
    dmTitle:       'Your MET Tryout is live',
    dmColor:       0x2ed896,
    logWebhook:  process.env.HPC_TRYOUT_LOG_WEBHOOK || null,
  };
}

// The site dashboard URL a host reviews/posts their tryout on (by division).
function reviewUrl(tryout) {
  const base = process.env.PUBLIC_BASE_URL ? process.env.PUBLIC_BASE_URL.replace(/\/$/, '') : null;
  if (!base) return null;
  return `${base}/${divisionConfig(tryout && tryout.division).dashboardSlug}/dashboard`;
}

// The Discord channel a tryout's announcement lives in (by division).
function announceChannelId(tryout) { return divisionConfig(tryout && tryout.division).channelId; }

// Format the scheduled start as HH:MM in the configured timezone (for CID's
// "Starting at" line). Falls back to the literal placeholder if unparseable.
function fmtStartAt(tryout) {
  try {
    const tz = process.env.TRYOUT_TIMEZONE || process.env.QUOTA_TIMEZONE || 'Europe/London';
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz })
      .format(new Date(tryout.scheduledAt));
  } catch (e) { return 'XX:XX'; }
}

// The ping line for an announcement: role mentions, or plain "(test mode)" when
// suppressPings is set (so a test announcement pings nobody).
function pingLine(cfg, tryout) {
  if (tryout.suppressPings) return 'Ping: (test mode — no ping)';
  return cfg.pingRoleIds.length ? cfg.pingRoleIds.map(id => `<@&${id}>`).join(' ') : '';
}

// Is the tryout's game server LOCKED (Adonis :serverlock on / :slock)? The lock
// state is reported live by the Hendon game; we default to LOCKED. Accepts the
// legacy SLOCKED/UNSLOCKED values as well as the current LOCKED/UNLOCKED ones.
function isServerLocked(tryout) {
  const s = String((tryout && tryout.lockState) || '').toUpperCase();
  return !(s === 'UNLOCKED' || s === 'UNSLOCKED');
}

// allowed_mentions for a tryout announcement: no pings at all when the tryout is
// in test mode (suppressPings), otherwise mention roles/users normally.
function announcementAllowedMentions(tryout) {
  return (tryout && tryout.suppressPings) ? { parse: [] } : { parse: ['roles', 'users', 'everyone'] };
}

// Dispatch to the right announcement template by division. HPC and CID have
// different formats; both track the live lock state in a STATUS line so it can
// be edited in place on :serverlock on/off.
function formatAnnouncement(tryout, opts = {}) {
  if (String(tryout && tryout.division).toUpperCase() === 'CID') return formatCidAnnouncement(tryout, opts);
  return formatHpcAnnouncement(tryout, opts);
}

// A Discord dynamic timestamp for the tryout start — renders in each viewer's
// local timezone: full date/time, plus a relative "in 2 hours".
function fmtDiscordTs(tryout) {
  const ms = tryout.scheduledAt ? new Date(tryout.scheduledAt).getTime() : Date.now();
  const s  = Math.floor(ms / 1000);
  return `<t:${s}:F> (<t:${s}:R>)`;
}

// The CID tryout announcement (posted to the CID Discord by the same game-driven
// flow as HPC). Wording/emoji/structure are kept verbatim to the CID spec.
function formatCidAnnouncement(tryout, { hostMention, coHostText } = {}) {
  const cfg    = divisionConfig('CID');
  const host   = hostMention || (tryout.hostDiscordId ? `<@${tryout.hostDiscordId}>` : (tryout.hostName || ''));
  const coHost = coHostText  || (tryout.coHostDiscordId ? `<@${tryout.coHostDiscordId}>` : (tryout.coHostName || 'N/A'));
  const link   = tryout.privateServerLink || 'TBA';
  const e      = cfg.emoji;
  const ping   = tryout.suppressPings ? '' : cfg.pingRoleIds.map(id => `<@&${id}>`).join(' ');
  return [
    `${e} CID TRYOUT ${e}`,
    `Host: ${host}`,
    `Co-Host: ${coHost}`,
    `Starting: ${fmtDiscordTs(tryout)}`,
    'Reactions: 3+ (3 ✅ needed to start the tryout, including the host)',
    `Game link: ${link}`,
    'Information:',
    "`• CID is the Metropolitan Police Service's (MPS) Criminal Investigations unit. This elite group of individuals are trained for immediate responses to any crime scene.",
    '- The standard weapon issued to CID is a GlockS.',
    '- Members who achieve the rank of Detective Inspector+ will be able to host.',
    '- Tryout will last approximately 30–50 minutes.`',
    'Notes: If you are a Community Support Officer, let your Instructor know beforehand and they will put you on the waiting list.',
    'Requirements: CSO+ RANK',
    'Join CID Today! Together we are unstoppable.',
    'THIS TRYOUT WILL BE HOSTED IN HENDON POLICE CAMPUS',
    ...(ping ? [ping] : []),
  ].join('\n');
}

// The longer CID recruitment cross-post (optional — only when
// CID_RECRUITMENT_CHANNEL_ID is set). The info block is configurable via
// CID_RECRUITMENT_INFO so the exact wording lives in config, not code.
function formatCidRecruitment(tryout) {
  const cfg    = divisionConfig('CID');
  const host   = tryout.hostDiscordId ? `<@${tryout.hostDiscordId}>` : (tryout.hostName || '');
  const coHost = tryout.coHostDiscordId ? `<@${tryout.coHostDiscordId}>` : (tryout.coHostName || 'N/A');
  const ping   = tryout.suppressPings
    ? '(test mode — no ping)'
    : (cfg.recruitmentPingRoleIds.length ? cfg.recruitmentPingRoleIds.map(id => `<@&${id}>`).join(' ') : '');
  return [
    `#  ${cfg.emoji} CID TRYOUT ${cfg.emoji}`,
    '',
    `Host: ${host}`,
    `Co-Host: ${coHost}`,
    `[Discord Link](${cfg.recruitmentInvite})`,
    '**Information:**',
    cfg.recruitmentInfo || '• CID is the MPS Criminal Investigations unit.',
    '**Requirements:** CSO or CON rank',
    ...(ping ? [ping] : []),
  ].join('\n');
}

// The Discord announcement text, in the exact MET format. STATUS reflects the
// live server-lock state (:serverlock on/off) of the Hendon tryout server.
// When the tryout is in test mode (suppressPings) the Ping line is rendered as
// plain text with NO role mention.
function formatHpcAnnouncement(tryout, { hostMention, coHostText } = {}) {
  const host   = hostMention || (tryout.hostDiscordId ? `<@${tryout.hostDiscordId}>` : tryout.hostName);
  const coHost = coHostText  || (tryout.coHostDiscordId ? `<@${tryout.coHostDiscordId}>` : (tryout.coHostName || 'N/A'));
  const link   = tryout.privateServerLink || 'TBA';
  const status = isServerLocked(tryout) ? 'Locked' : 'Unlocked';
  const ping   = tryout.suppressPings ? 'Ping: (test mode — no ping)' : `Ping: <@&${TRYOUT_PING_ROLE()}>`;
  const hpc    = HPC_EMOJI();
  return [
    `${hpc} College Entrance ${hpc}`,
    'Metropolitan Police Tryout',
    `HOST: ${host}`,
    `CO-HOST: ${coHost}`,
    `Link: ${link}`,
    '',
    `STATUS: ${status}`,
    ping,
    '**Requirements,**',
    '▫️Must wear blocky avatar.',
    '▫️Must be in Uniform and shoulder to shoulder.',
    '▫️Must have an account 100 days or older.',
    '▫️Make sure You Are in the HPC Group To get access to the Game!',
    '▫️Must be 16 years old.',
    '▫️Make Sure You Are Verified.',
  ].join('\n');
}

// Provision (or reuse) a Roblox private server link for the tryout.
// Strategy, in order:
//   1. TRYOUT_PRIVATE_SERVER_LINK — a fixed reusable private-server link MET
//      created in-game once. Simplest and reliable; returned as-is.
//   2. Roblox authenticated API (roblox.createPrivateServer) — dynamic per
//      tryout; only if configured (place with private servers + ROBLOX_COOKIE).
// Returns { link, id } or { link:null } if nothing is configured yet.
async function getServerLink(tryout) {
  const fixed = process.env.TRYOUT_PRIVATE_SERVER_LINK;
  if (fixed) return { link: fixed, id: null };
  try {
    const { createPrivateServer } = require('./roblox');
    if (typeof createPrivateServer === 'function') {
      const r = await createPrivateServer();
      if (r && r.link) return r;
    }
  } catch (e) { console.warn('[Tryout] dynamic server creation failed:', e.message); }
  return { link: null, id: null };
}

// Fire one tryout: create the server, mark LIVE, DM the host.
async function fireTryout(t) {
  const { link, id } = await getServerLink(t);
  const updated = await prisma.tryout.update({
    where: { id: t.id },
    data: {
      status: 'LIVE',
      // A fresh tryout server is open — default to UNLOCKED so the first DM/
      // announcement shows the real status (the game corrects it via /serverlock).
      lockState: t.lockState || 'UNLOCKED',
      privateServerLink: link || null,
      privateServerId: id || null,
      serverCreatedAt: new Date(),
    },
  });
  console.log(`[Tryout] ${t.id} is now LIVE (link: ${link ? 'yes' : 'none'})`);

  // DM the host with the details + action buttons (best-effort).
  try {
    const { sendTryoutHostDM } = require('./bot');
    if (typeof sendTryoutHostDM === 'function') {
      const dmId = await sendTryoutHostDM(updated).catch(() => null);
      if (dmId) await prisma.tryout.update({ where: { id: t.id }, data: { hostDmMessageId: dmId } }).catch(() => {});
    }
  } catch (e) { console.warn('[Tryout] host DM failed:', e.message); }

  return updated;
}

async function processDueTryouts() {
  try {
    const due = await prisma.tryout.findMany({
      where: { status: 'SCHEDULED', scheduledAt: { lte: new Date() } },
      orderBy: { scheduledAt: 'asc' },
      take: 10,
    });
    for (const t of due) {
      try { await fireTryout(t); }
      catch (e) { console.error('[Tryout] fire error for', t.id, e.message); }
    }
  } catch (e) {
    console.error('[Tryout] processDueTryouts error:', e.message);
  }
}

function startTryoutWorker() {
  // Check shortly after boot, then every 30s.
  setTimeout(processDueTryouts, 20 * 1000);
  setInterval(processDueTryouts, 30 * 1000);
}

module.exports = {
  startTryoutWorker, processDueTryouts, fireTryout,
  formatAnnouncement, formatCidRecruitment, announcementAllowedMentions,
  isServerLocked, getServerLink, TRYOUT_PING_ROLE,
  divisionConfig, announceChannelId, reviewUrl,
};
