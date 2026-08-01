// server/lib/cad/index.js
// CAD facade + orchestrator. Ties the pure services to Discord: it owns the
// single output path (transmit → mirror to #radio + speak via DispatchVoice),
// the #radio message listener (free text → intent parser → service), and the
// action methods the web dispatch console calls. Everything is env-gated and
// best-effort so the portal never breaks if CAD isn't configured.
const prisma = require('../db');
const siteConfig = require('../siteConfig');
const services = require('./services');
const phrasing = require('./phrasing');
const { e } = require('../emoji');
const { parseIntent, isActionable } = require('./intent/parser');
const { DispatchVoice } = require('./voice/dispatch-voice');
const { VoiceWorkerClient } = require('./voice/worker-client');
const gateway = require('./voice/gateway');
const { ElevenLabsTts } = require('./tts/elevenlabs');
const { NullTtsProvider } = require('./tts/types');

let botClient = null;
let voice = null;                            // in-process voice (works only on UDP-capable hosts)
const worker = new VoiceWorkerClient();      // external worker over HTTP (we call it) — Fly.io mode
let workerHealth = null;                      // last /health snapshot, refreshed by status()
let wired = false;

// Which path speaks? Precedence: HTTP worker (we call it) → WS gateway (worker
// dials us, for free bot hosts) → in-process voice (UDP-capable hosts only).
function voiceMode() {
  if (worker.enabled()) return 'worker';
  if (gateway.enabled()) return 'gateway';
  return 'inprocess';
}
const feed = []; // in-memory recent radio/dispatch feed for the web console
const FEED_MAX = 120;

// Voice guild/channel are dev-selectable in the console and persisted in
// SystemSetting, so they survive restarts without touching env. Env vars are
// the fallback default.
function config() {
  const c = siteConfig.getCached() || {};
  return {
    guildId:        c.cadVoiceGuildId || process.env.CAD_GUILD_ID || process.env.DISCORD_GUILD_ID || null,
    radioChannelId: process.env.CAD_RADIO_CHANNEL_ID || null,
    voiceChannelId: c.cadVoiceChannelId || process.env.CAD_VOICE_CHANNEL_ID || null,
    controlRoleId:  process.env.CAD_CONTROL_ROLE_ID || null,
  };
}

function pushFeed(entry) {
  feed.push({ id: `${Date.now()}-${feed.length}`, ...entry });
  while (feed.length > FEED_MAX) feed.shift();
}
function recentFeed(limit = 60) { return feed.slice(-limit).reverse(); }

// Resolve an officer's MET identity from their Discord id (units link to the
// site account; officerName defaults to their MET display name).
async function resolveOfficer(discordUserId, fallbackName) {
  let userId = null, officerName = fallbackName || null;
  try {
    const u = await prisma.user.findUnique({ where: { discordId: String(discordUserId) }, select: { id: true, displayName: true, discordUsername: true } });
    if (u) { userId = u.id; officerName = u.displayName || u.discordUsername || officerName; }
  } catch (e) { /* CAD works without a linked account */ }
  return { userId, officerName: officerName || 'Officer' };
}

// ── The single output path: mirror text to #radio + queue speech ─────
async function transmit(text, { grade = null, ping = false } = {}) {
  pushFeed({ kind: 'dispatch', text, grade, at: new Date().toISOString() });
  const cfg = config();
  if (botClient && cfg.radioChannelId) {
    try {
      const ch = await botClient.channels.fetch(cfg.radioChannelId);
      const content = (ping && cfg.controlRoleId ? `<@&${cfg.controlRoleId}> ` : '') + e('met_radio') + ' ' + text;
      await ch.send({ content, allowedMentions: { roles: ping && cfg.controlRoleId ? [cfg.controlRoleId] : [] } });
    } catch (e) { /* best-effort */ }
  }
  // Speak it via whichever path is active (see voiceMode()).
  const mode = voiceMode();
  if (mode === 'worker') worker.speak(cfg.guildId, cfg.voiceChannelId, text, grade).catch(() => {});
  else if (mode === 'gateway') gateway.speak(cfg.guildId, cfg.voiceChannelId, text, grade);
  else if (voice) voice.enqueue(text, { grade });
  return text;
}

// ── Action methods (used by BOTH the web console and the radio handler) ─
async function actBookOn({ callsign, discordUserId = null, userId = null, officerName }) {
  const r = await services.units.bookOn({ callsign, discordUserId, userId, officerName });
  if (r.ok) await transmit(phrasing.ackBookOn(r.unit.callsign, r.unit.officerName));
  return r;
}
async function actBookOff({ callsign, discordUserId }) {
  const r = await services.units.bookOff({ callsign, discordUserId });
  if (r.ok) await transmit(phrasing.ackBookOff(r.unit.callsign));
  return r;
}
async function actStatus({ callsign, discordUserId, status }) {
  const r = await services.units.setStatus({ callsign, discordUserId, status });
  if (r.ok) await transmit(phrasing.ackStatus(r.unit.callsign, r.unit.status));
  return r;
}
async function actCreateIncident(input) {
  const r = await services.dispatch.createIncident(input);
  if (r.ok) await transmit(phrasing.incidentCreated(r.incident), { grade: r.incident.grade, ping: r.incident.grade === 'I' });
  return r;
}
async function actAssign({ ref, callsign }) {
  const r = await services.dispatch.assign({ ref, callsign });
  if (r.ok) await transmit(phrasing.ackAssign(r.unit.callsign, r.incident));
  return r;
}
async function actOnScene({ callsign, discordUserId, ref = null }) {
  const r = await services.dispatch.onScene({ callsign, discordUserId, ref });
  if (r.ok) await transmit(phrasing.ackStatus(r.unit.callsign, 'ON_SCENE'));
  return r;
}
async function actUpdate({ ref, message, callsign = null }) {
  const r = await services.dispatch.updateIncident({ ref, message, callsign });
  if (r.ok) await transmit(`${r.incident.cadRef}, control, update noted — ${message}.`);
  return r;
}
async function actClose({ ref, outcome }) {
  const r = await services.dispatch.closeIncident({ ref, outcome });
  if (r.ok) await transmit(phrasing.ackClose(r.incident));
  return r;
}
async function actVehicle({ callsign, vrm }) {
  const r = await services.pnc.vehicle({ vrm });
  await transmit(phrasing.vehicleResult(callsign || 'Control', (r.vrm || vrm || '').toString(), r));
  return r;
}
async function actPerson({ callsign, surname, forename }) {
  const r = await services.pnc.person({ surname, forename });
  await transmit(phrasing.personResult(callsign || 'Control', r));
  return r;
}
async function actBackup({ callsign, discordUserId, location = null }) {
  const r = await services.dispatch.requestBackup({ callsign, discordUserId, location });
  if (r.ok) await transmit(phrasing.backupAlert(r.unit.callsign, r.location), { grade: 'I', ping: true });
  return r;
}

// ── #radio free-text handler ─────────────────────────────────────────
async function handleRadioMessage(message) {
  const cfg = config();
  if (!cfg.radioChannelId || message.channelId !== cfg.radioChannelId) return;
  if (message.author && message.author.bot) return;
  const text = (message.content || '').trim();
  if (!text) return;

  const existing = await services.units.findUnit({ discordUserId: message.author.id });
  const known = existing ? existing.callsign : null;
  const intent = await parseIntent(text, { knownCallsign: known });
  pushFeed({ kind: 'radio', author: message.author.username, callsign: intent.callsign || known, text, intent: intent.intent, confidence: intent.confidence, source: intent.source, at: new Date().toISOString() });

  if (!isActionable(intent)) {
    // Ask to repeat — TEXT ONLY, never spoken.
    try { const ch = await botClient.channels.fetch(cfg.radioChannelId); await ch.send(e('met_radio') + ' ' + phrasing.repeat(intent.callsign || known)); } catch (e) {}
    return;
  }
  await routeIntent(intent, message, existing);
}

async function routeIntent(intent, message, unit) {
  const discordUserId = message.author.id;
  const callsign = intent.callsign || (unit && unit.callsign) || null;
  const e = intent.entities || {};
  switch (intent.intent) {
    case 'BOOK_ON': {
      const off = await resolveOfficer(discordUserId, message.member && message.member.displayName);
      return actBookOn({ callsign, discordUserId, userId: off.userId, officerName: off.officerName });
    }
    case 'BOOK_OFF':      return actBookOff({ callsign, discordUserId });
    case 'STATUS_UPDATE': return actStatus({ callsign, discordUserId, status: e.status || 'AVAILABLE' });
    case 'ON_SCENE':      return actOnScene({ callsign, discordUserId, ref: e.incidentRef });
    case 'VRM_CHECK':     return e.vrm ? actVehicle({ callsign, vrm: e.vrm }) : askRepeat(callsign);
    case 'PERSON_CHECK':  return e.surname ? actPerson({ callsign, surname: e.surname, forename: e.forename }) : askRepeat(callsign);
    case 'ASSIGN_REQUEST':return e.incidentRef ? actAssign({ ref: e.incidentRef, callsign }) : askRepeat(callsign);
    case 'INCIDENT_UPDATE':return e.incidentRef ? actUpdate({ ref: e.incidentRef, message: message.content, callsign }) : askRepeat(callsign);
    case 'REQUEST_BACKUP':return actBackup({ callsign, discordUserId, location: e.location });
    default:              return askRepeat(callsign);
  }
}
async function askRepeat(callsign) {
  const cfg = config();
  try { const ch = await botClient.channels.fetch(cfg.radioChannelId); await ch.send(e('met_radio') + ' ' + phrasing.repeat(callsign)); } catch (e) {}
}

// ── Init (called from the bot once it's ready) ───────────────────────
function init(client) {
  if (wired || !client) return;
  botClient = client;
  const cfg = config();
  // ElevenLabs needs only the API key — the voice defaults to a British
  // dispatcher voice (override with ELEVENLABS_VOICE_ID).
  const tts = process.env.ELEVENLABS_API_KEY ? new ElevenLabsTts() : new NullTtsProvider();
  voice = new DispatchVoice({
    client, ttsProvider: tts, guildId: cfg.guildId, voiceChannelId: cfg.voiceChannelId,
    tonePath: process.env.CAD_ATTENTION_TONE_PATH || null,
  });
  // Reconnect to the dev-selected voice channel after a restart (best-effort).
  // With the external worker configured, tell IT to (re)join instead of the
  // in-process voice (which can't handshake on Railway anyway).
  if (cfg.voiceChannelId) {
    setTimeout(function () {
      try {
        const mode = voiceMode();
        if (mode === 'worker') worker.join(cfg.guildId, cfg.voiceChannelId).catch(() => {});
        else if (mode === 'gateway') gateway.join(cfg.guildId, cfg.voiceChannelId);
        else voice.join();
      } catch (e) {}
    }, 5000);
  }
  if (voiceMode() === 'worker') console.log('[CAD] Voice: external worker mode (HTTP → ' + process.env.CAD_VOICE_WORKER_URL + ').');
  else if (voiceMode() === 'gateway') console.log('[CAD] Voice: gateway mode (worker dials in over WebSocket).');
  if (cfg.radioChannelId) {
    client.on('messageCreate', (m) => { try { handleRadioMessage(m).catch(() => {}); } catch (e) {} });
    console.log(`[CAD] Radio listener attached to channel ${cfg.radioChannelId}. Voice: ${voice.available() ? 'ON' : 'text-only'}. Intent: ${process.env.ANTHROPIC_API_KEY ? 'Claude' : 'rule-based'}.`);
  } else {
    console.log('[CAD] No CAD_RADIO_CHANNEL_ID set — radio listener disabled (web console still works).');
  }
  wired = true;
}

async function status() {
  const cfg = config();
  const mode = voiceMode();
  // The source of truth for "in channel / speaking?" depends on the mode. For
  // external modes the ElevenLabs key + voice connection live on the WORKER, so
  // health comes from there — not the (non-functional on Railway) in-process voice.
  let wh = null;              // normalised worker health
  let workerInfo = { enabled: false };
  if (mode === 'worker') {
    try { workerHealth = await worker.health(); } catch (e) { workerHealth = { ok: false, error: e.message }; }
    wh = workerHealth;
    workerInfo = { enabled: true, transport: 'http', url: process.env.CAD_VOICE_WORKER_URL || null, health: wh };
  } else if (mode === 'gateway') {
    const gs = gateway.getState();
    wh = gs.health || (gs.connected ? { ok: true, connected: false } : null);
    if (!gs.connected) wh = { ok: false, error: 'voice worker not connected yet — deploy it and it will dial in.' };
    workerInfo = { enabled: true, transport: 'websocket', connected: gs.connected, lastSeenAt: gs.lastSeenAt, health: gs.health };
  }
  const external = mode !== 'inprocess';
  const localDiag = voice && voice.getDiag ? voice.getDiag() : null;
  return {
    configured: !!cfg.radioChannelId,
    radioChannelId: cfg.radioChannelId, voiceChannelId: cfg.voiceChannelId, controlRoleId: cfg.controlRoleId,
    voiceGuildId: cfg.guildId,
    voiceMode: mode,
    voiceReady: external ? !!(wh && wh.ok) : !!(voice && voice.available()),
    voiceConnected: external ? !!(wh && wh.connected) : !!(voice && voice.isConnected && voice.isConnected()),
    // Present the worker's diagnostics in the same shape the console already renders.
    voice: external
      ? (wh ? { available: !!wh.ok, connected: !!wh.connected, why: wh.ok ? null : (wh.error || 'worker unavailable'), lastError: wh.lastError || wh.error || null, lastSpokeAt: wh.lastSpokeAt || null, lastAttemptAt: wh.lastAttemptAt || null, events: wh.events || [] } : { available: false, connected: false, why: 'voice worker not connected', events: [] })
      : localDiag,
    worker: workerInfo,
    intentEngine: process.env.ANTHROPIC_API_KEY ? 'claude' : 'rules',
    ttsEngine: process.env.ELEVENLABS_API_KEY ? 'elevenlabs' : 'none',
    hasElevenKey: !!process.env.ELEVENLABS_API_KEY,
  };
}

// Dev picks a server + voice channel in the console → persist + (re)join.
async function setVoiceChannel(guildId, channelId) {
  if (!guildId || !channelId) return { ok: false, error: 'Pick a server and a voice channel.' };
  await siteConfig.set('cadVoiceGuildId', String(guildId));
  await siteConfig.set('cadVoiceChannelId', String(channelId));
  const mode = voiceMode();
  // HTTP worker mode: the Fly.io worker owns the actual voice connection.
  if (mode === 'worker') {
    const r = await worker.join(String(guildId), String(channelId));
    if (r.ok) return { ok: true, joined: !!r.connected, note: r.connected ? undefined : (r.error || 'Saved — worker is connecting.') };
    return { ok: true, joined: false, note: r.error ? ('Saved, but the voice worker said: ' + r.error) : 'Saved, but could not reach the voice worker.' };
  }
  // Gateway mode: push a join to the worker that dialled in.
  if (mode === 'gateway') {
    if (!gateway.hasWorker()) return { ok: true, joined: false, note: 'Saved. Waiting for the voice worker to connect — check it is deployed and running.' };
    gateway.join(String(guildId), String(channelId));
    return { ok: true, joined: true, note: 'Sent to the voice worker.' };
  }
  if (voice) {
    // Already sitting in exactly this channel → don't bounce out and back in.
    if (voice.isConnected() && String(voice.guildId) === String(guildId) && String(voice.voiceChannelId) === String(channelId)) {
      return { ok: true, joined: true, note: 'Already connected to that channel.' };
    }
    voice.setChannel(String(guildId), String(channelId)); // only tears down on a real change
    const joined = await voice.join().catch(() => false);
    if (!joined && !process.env.ELEVENLABS_API_KEY) return { ok: true, joined: false, note: 'Saved. Add an ElevenLabs API key to speak.' };
    if (!joined) return { ok: true, joined: false, note: 'Saved, but could not join yet (check the bot has Connect + Speak on that channel).' };
  }
  return { ok: true, joined: true };
}
async function leaveVoice() {
  await siteConfig.set('cadVoiceChannelId', '');
  if (worker.enabled()) { await worker.leave().catch(() => {}); }
  else if (gateway.enabled()) { gateway.leave(); }
  if (voice) voice.leave();
  return { ok: true };
}

module.exports = {
  init, status, transmit, config, recentFeed, setVoiceChannel, leaveVoice,
  // actions used by the web console + radio
  actBookOn, actBookOff, actStatus, actCreateIncident, actAssign, actOnScene, actUpdate, actClose, actVehicle, actPerson, actBackup,
  services, phrasing,
};
