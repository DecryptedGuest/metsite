// server/routes/notifications.js
const express = require('express');
const prisma  = require('../lib/db');
const { requireDeveloper } = require('../middleware/auth');
const { sendCustomNotification, getPrefs, ALL_TICKET_TYPES } = require('../lib/push');

const router = express.Router();

// GET /api/notifications/me — current user's notification settings + push state
router.get('/me', async (req, res) => {
  try {
    const subCount = await prisma.pushSubscription.count({ where: { userId: req.user.id } });
    res.json({
      asked:       req.user.notifyAsked,
      enabled:     req.user.notifyEnabled,
      hasPush:     subCount > 0,
      prefs:       getPrefs(req.user),
      ticketTypes: ALL_TICKET_TYPES,
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load notification settings.' });
  }
});

// POST /api/notifications/ack — mark the one-time opt-in prompt as shown
router.post('/ack', async (req, res) => {
  try {
    await prisma.user.update({ where: { id: req.user.id }, data: { notifyAsked: true } });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to acknowledge.' });
  }
});

// PATCH /api/notifications/settings — update master toggle + granular prefs
router.patch('/settings', async (req, res) => {
  const { enabled, prefs } = req.body || {};
  const data = {};
  if (typeof enabled === 'boolean') data.notifyEnabled = enabled;
  if (prefs && typeof prefs === 'object') {
    data.notifyPrefs = {
      newCase:       prefs.newCase       !== false,
      newTicket:     prefs.newTicket     !== false,
      announcements: prefs.announcements !== false,
      ticketTypes:   Array.isArray(prefs.ticketTypes)
        ? prefs.ticketTypes.filter(t => ALL_TICKET_TYPES.includes(t))
        : [...ALL_TICKET_TYPES],
    };
  }
  // Enabling for the first time also counts as having been asked.
  if (data.notifyEnabled === true) data.notifyAsked = true;
  try {
    await prisma.user.update({ where: { id: req.user.id }, data });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save settings.' });
  }
});

// ── Developer: send a custom notification ─────────────────────────
// GET /api/notifications/recipients — staff list with push status (dev only)
router.get('/recipients', requireDeveloper, async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      where:   { isBlacklisted: false },
      select:  {
        id: true, discordUsername: true, displayName: true, role: true,
        notifyEnabled: true, _count: { select: { pushSubscriptions: true } },
      },
      orderBy: { discordUsername: 'asc' },
    });
    res.json(users.map(u => ({
      id: u.id,
      name: u.displayName || u.discordUsername,
      role: u.role,
      notifyEnabled: u.notifyEnabled,
      hasPush: u._count.pushSubscriptions > 0,
    })));
  } catch (e) {
    res.status(500).json({ error: 'Failed to load recipients.' });
  }
});

// POST /api/notifications/send — dev broadcast (dev only)
router.post('/send', requireDeveloper, async (req, res) => {
  const { title, body, url, all, userIds } = req.body || {};
  if (!title?.trim() || !body?.trim()) return res.status(400).json({ error: 'Title and body are required.' });
  if (!all && (!Array.isArray(userIds) || userIds.length === 0))
    return res.status(400).json({ error: 'Select at least one recipient or choose "everyone".' });
  try {
    const result = await sendCustomNotification({
      all: !!all, userIds, title: title.trim(), body: body.trim(), url: url?.trim() || '/dashboard',
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: 'Failed to send notification.' });
  }
});

module.exports = router;
