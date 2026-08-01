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

// Notification categories. Tickets are no longer submitted on the site (their
// logs are mirrored from Discord), so the ticket categories are gone; what's
// left is the casework that actually needs a human.
const CATEGORIES = ['case', 'caseUpdated', 'caseAppealed', 'announcement'];

// Default preference set — used when a user has enabled notifications but has
// not customised anything yet (notifyPrefs is null).
function defaultPrefs() {
  return { newCase: true, caseUpdated: true, caseAppealed: true, announcements: true };
}

function getPrefs(user) {
  const p = user.notifyPrefs && typeof user.notifyPrefs === 'object' ? user.notifyPrefs : {};
  return {
    newCase:       p.newCase       !== false,
    caseUpdated:   p.caseUpdated   !== false,
    caseAppealed:  p.caseAppealed  !== false,
    announcements: p.announcements !== false,
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

// Notify reviewing staff of a new case, honouring each user's preferences.
//   payload: { category: 'case', title, body, url }
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
      if (payload.category === 'case') return prefs.newCase;
      return true;
    });
    await deliver(eligible, {
      title: payload.title, body: payload.body, url: payload.url,
    });
  } catch (e) {
    console.error('[Push] notifyStaff error:', e.message);
  }
}

// Targeted notification: a developer announcement, or a per-user event such as
// "changes requested on your case" / "your case was appealed".
//   opts: { userIds?: string[], all?: boolean, title, body, url, prefKey? }
// `prefKey` (e.g. 'caseUpdated', 'caseAppealed') honours that user preference;
// omit it for admin announcements, which always go out. Users who turned
// notifications off are always skipped.
async function sendCustomNotification({ userIds, all, title, body, url, prefKey }) {
  if (!CONFIGURED) return { sent: 0 };
  try {
    const where = all ? {} : { userId: { in: userIds || [] } };
    const subs = await prisma.pushSubscription.findMany({
      where,
      include: { user: { select: { notifyEnabled: true, notifyPrefs: true } } },
    });
    const targets = subs.filter(s =>
      s.user && s.user.notifyEnabled && (!prefKey || getPrefs(s.user)[prefKey] !== false));
    await deliver(targets, { title, body, url: url || '/dashboard' });
    return { sent: targets.length };
  } catch (e) {
    console.error('[Push] sendCustomNotification error:', e.message);
    return { sent: 0, error: e.message };
  }
}

module.exports = { notifyStaff, sendCustomNotification, defaultPrefs, getPrefs, CATEGORIES, CONFIGURED };
