// server/routes/cad.js — CAD dispatch console API (developer-only).
// Mounted at /api/cad behind requireAuth. Every write routes through the same
// orchestrator methods the #radio channel uses, so the console and the radio
// produce identical dispatch responses (mirrored to #radio + spoken via TTS
// when configured). Reads come straight from the pure services.
const express = require('express');
const cad = require('../lib/cad');
const audit = require('../lib/audit');

const router = express.Router();

// Developer-only gate for the whole console.
router.use((req, res, next) => {
  if (!req.user || req.user.role !== 'DEVELOPER') return res.status(403).json({ error: 'Developers only.' });
  next();
});

const send = (res, r) => (r && r.ok === false ? res.status(400).json({ error: r.error, code: r.code }) : res.json(r));

// ── Live state ───────────────────────────────────────────────────────
router.get('/status', async (req, res) => res.json(await cad.status()));
router.get('/board', async (req, res) => send(res, await cad.services.units.board()));
router.get('/incidents', async (req, res) => send(res, await cad.services.dispatch.listOpen()));
router.get('/incidents/:ref', async (req, res) => send(res, await cad.services.dispatch.getIncident(req.params.ref)));
router.get('/feed', (req, res) => res.json({ feed: cad.recentFeed(Number(req.query.limit) || 60) }));

// ── Units ────────────────────────────────────────────────────────────
router.post('/bookon', async (req, res) => {
  const { callsign, discordUserId, officerName } = req.body || {};
  const r = await cad.actBookOn({ callsign, discordUserId: discordUserId || null, officerName: officerName || 'Console' });
  if (r.ok) audit.record({ req, action: 'CAD_BOOKON', category: 'CAD', summary: `Booked on ${r.unit.callsign}` });
  send(res, r);
});
router.post('/bookoff', async (req, res) => send(res, await cad.actBookOff({ callsign: (req.body || {}).callsign })));
router.post('/status', async (req, res) => {
  const { callsign, status } = req.body || {};
  send(res, await cad.actStatus({ callsign, status }));
});

// ── Incidents ────────────────────────────────────────────────────────
router.post('/incident', async (req, res) => {
  const { grade, location, category, description } = req.body || {};
  const r = await cad.actCreateIncident({ grade, location, category, description, createdById: req.user.id, createdByName: req.user.displayName || req.user.discordUsername });
  if (r.ok) audit.record({ req, action: 'CAD_INCIDENT_CREATE', category: 'CAD', targetType: 'cadIncident', targetId: r.incident.id, summary: `Created ${r.incident.cadRef} (Grade ${r.incident.grade})` });
  send(res, r);
});
router.post('/incident/assign', async (req, res) => {
  const { ref, callsign } = req.body || {};
  send(res, await cad.actAssign({ ref, callsign }));
});
router.post('/incident/onscene', async (req, res) => {
  const { callsign, ref } = req.body || {};
  send(res, await cad.actOnScene({ callsign, ref: ref || null }));
});
router.post('/incident/update', async (req, res) => {
  const { ref, message } = req.body || {};
  send(res, await cad.actUpdate({ ref, message }));
});
router.post('/incident/close', async (req, res) => {
  const { ref, outcome } = req.body || {};
  const r = await cad.actClose({ ref, outcome });
  if (r.ok) audit.record({ req, action: 'CAD_INCIDENT_CLOSE', category: 'CAD', targetType: 'cadIncident', targetId: r.incident.id, summary: `Closed ${r.incident.cadRef}` });
  send(res, r);
});

// ── PNC ──────────────────────────────────────────────────────────────
router.post('/pnc/vehicle', async (req, res) => send(res, await cad.actVehicle({ callsign: (req.body || {}).callsign || 'Control', vrm: (req.body || {}).vrm })));
router.post('/pnc/person', async (req, res) => {
  const { surname, forename, callsign } = req.body || {};
  send(res, await cad.actPerson({ callsign: callsign || 'Control', surname, forename }));
});

// ── Backup + free dispatcher broadcast ───────────────────────────────
router.post('/backup', async (req, res) => {
  const { callsign } = req.body || {};
  const r = await cad.actBackup({ callsign });
  if (r.ok) audit.record({ req, action: 'CAD_BACKUP', category: 'CAD', summary: `Urgent assistance broadcast for ${callsign}` });
  send(res, r);
});
router.post('/transmit', async (req, res) => {
  const { text, grade } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'Nothing to transmit.' });
  await cad.transmit(String(text).trim().slice(0, 900), { grade: grade || null });
  res.json({ ok: true });
});

// ── Voice channel picker (dev chooses server → voice channel) ────────
const bot = require('../lib/bot');
router.get('/guilds', async (req, res) => { res.json({ guilds: await bot.listBotGuilds() }); });
router.get('/guilds/:id/voice-channels', async (req, res) => { res.json({ channels: await bot.listGuildVoiceChannels(req.params.id) }); });
router.post('/voice/join', async (req, res) => {
  const { guildId, channelId } = req.body || {};
  const r = await cad.setVoiceChannel(guildId, channelId);
  if (r.ok) audit.record({ req, action: 'CAD_VOICE_JOIN', category: 'CAD', summary: `CAD voice set to channel ${channelId} in guild ${guildId}` });
  res.json(r);
});
router.post('/voice/leave', async (req, res) => { res.json(await cad.leaveVoice()); });
router.post('/voice/test', async (req, res) => {
  await cad.transmit('Control to all units, radio check, receiving you loud and clear.');
  // Give the queue a moment to attempt playback, then report what happened so
  // the console can show WHY it did or didn't speak.
  await new Promise((r) => setTimeout(r, 2500));
  const s = await cad.status();
  res.json({ ok: true, voice: s.voice });
});

// ── Seed the fictional PNC records ───────────────────────────────────
router.post('/seed', async (req, res) => {
  try {
    const r = await require('../lib/cad/seed').seedPnc();
    audit.record({ req, action: 'CAD_SEED', category: 'CAD', summary: `Seeded PNC (${r.vehicles} vehicles, ${r.persons} persons)` });
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ error: 'Seed failed.' }); }
});

module.exports = router;
