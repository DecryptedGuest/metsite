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

// The Discord announcement text, in the exact MET format. STATUS reflects the
// live server-lock state (:serverlock on/off) of the Hendon tryout server.
// When the tryout is in test mode (suppressPings) the Ping line is rendered as
// plain text with NO role mention.
function formatAnnouncement(tryout, { hostMention, coHostText } = {}) {
  const host   = hostMention || (tryout.hostDiscordId ? `<@${tryout.hostDiscordId}>` : tryout.hostName);
  const coHost = coHostText  || (tryout.coHostDiscordId ? `<@${tryout.coHostDiscordId}>` : (tryout.coHostName || 'N/A'));
  const link   = tryout.privateServerLink || 'TBA';
  const status = isServerLocked(tryout) ? '🔒 SERVER LOCKED' : '🔓 SERVER UNLOCKED';
  const ping   = tryout.suppressPings ? 'Ping: (test mode — no ping)' : `Ping: <@&${TRYOUT_PING_ROLE()}>`;
  return [
    ':HPC: College Entrance :HPC:',
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

module.exports = { startTryoutWorker, processDueTryouts, fireTryout, formatAnnouncement, announcementAllowedMentions, isServerLocked, getServerLink, TRYOUT_PING_ROLE };
