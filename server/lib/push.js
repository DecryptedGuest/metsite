// server/lib/push.js — Web Push notification helpers
const webpush = require('web-push');
const prisma   = require('./db');

// Only initialise if the VAPID keys are present — missing keys crash the module.
const CONFIGURED = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (CONFIGURED) {
  webpush.setVapidDetails(
    process.env.VAPID_EMAIL || 'mailto:admin@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
}

const ALL_TICKET_TYPES = ['GENERAL_SUPPORT', 'HICOMM', 'OFFICER_REPORT', 'APPEAL'];

// Default preference set — used when a user has enabled notifications but has
// not customised anything yet (notifyPrefs is null).
function defaultPrefs() {
  return { newCase: true, newTicket: true, ticketTypes: [...ALL_TICKET_TYPES], announcements: true };
}

function getPrefs(user) {
  const p = user.notifyPrefs && typeof user.notifyPrefs === 'object' ? user.notifyPrefs : {};
  const d = defaultPrefs();
  return {
    newCase:       p.newCase       !== false,
    newTicket:     p.newTicket     !== false,
    announcements: p.announcements !== false,
    ticketTypes:   Array.isArray(p.ticketTypes) ? p.ticketTypes : d.ticketTypes,
  };
}

// Low-level: deliver a payload to a list of subscription rows, pruning dead ones.
async function deliver(subs, payload) {
  if (!CONFIGURED || !subs.length) return;
  const data = JSON.stringify(payload);
  await Promise.allSettled(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        data,
      );
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        await prisma.pushSubscription.deleteMany({ where: { endpoint: s.endpoint } }).catch(() => {});
      }
    }
  }));
}

// Notify staff of a new case/ticket, honouring each user's preferences.
//   payload: { category: 'case'|'ticket', ticketType?, title, body, url }
async function notifyStaff(payload) {
  if (!CONFIGURED) return;
  try {
    const subs = await prisma.pushSubscription.findMany({
      include: { user: { select: { role: true, notifyEnabled: true, notifyPrefs: true } } },
    });
    const eligible = subs.filter((s) => {
      const u = s.user;
      if (!u || !['HICOMM', 'SUPERVISOR', 'DEVELOPER'].includes(u.role)) return false;
      if (!u.notifyEnabled) return false;
      const prefs = getPrefs(u);
      if (payload.category === 'case')   return prefs.newCase;
      if (payload.category === 'ticket') {
        if (!prefs.newTicket) return false;
        if (payload.ticketType && prefs.ticketTypes.length)
          return prefs.ticketTypes.includes(payload.ticketType);
        return true;
      }
      return true;
    });
    await deliver(eligible, {
      title: payload.title, body: payload.body, url: payload.url,
    });
  } catch (e) {
    console.error('[Push] notifyStaff error:', e.message);
  }
}

// Developer-initiated custom notification.
//   opts: { userIds?: string[], all?: boolean, title, body, url }
// Sends to every active subscription of the targeted users (admin intent — not
// gated on category prefs), but still skips users who disabled notifications.
async function sendCustomNotification({ userIds, all, title, body, url }) {
  if (!CONFIGURED) return { sent: 0 };
  try {
    const where = all ? {} : { userId: { in: userIds || [] } };
    const subs = await prisma.pushSubscription.findMany({
      where,
      include: { user: { select: { notifyEnabled: true } } },
    });
    const targets = subs.filter(s => s.user && s.user.notifyEnabled);
    await deliver(targets, { title, body, url: url || '/dashboard' });
    return { sent: targets.length };
  } catch (e) {
    console.error('[Push] sendCustomNotification error:', e.message);
    return { sent: 0, error: e.message };
  }
}

module.exports = { notifyStaff, sendCustomNotification, defaultPrefs, getPrefs, ALL_TICKET_TYPES, CONFIGURED };
