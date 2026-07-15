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
const { parseIntent, isActionable } = require('./intent/parser');
const { DispatchVoice } = require('./voice/dispatch-voice');
const { ElevenLabsTts } = require('./tts/elevenlabs');
const { NullTtsProvider } = require('./tts/types');

let botClient = null;
let voice = null;
let wired = false;
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
      const content = (ping && cfg.controlRoleId ? `<@&${cfg.controlRoleId}> ` : '') + '📻 ' + text;
      await ch.send({ content, allowedMentions: { roles: ping && cfg.controlRoleId ? [cfg.controlRoleId] : [] } });
    } catch (e) { /* best-effort */ }
  }
  if (voice) voice.enqueue(text, { grade });
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
    try { const ch = await botClient.channels.fetch(cfg.radioChannelId); await ch.send('📻 ' + phrasing.repeat(intent.callsign || known)); } catch (e) {}
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
  try { const ch = await botClient.channels.fetch(cfg.radioChannelId); await ch.send('📻 ' + phrasing.repeat(callsign)); } catch (e) {}
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
  if (cfg.voiceChannelId) { setTimeout(function () { try { voice.join(); } catch (e) {} }, 3000); }
  if (cfg.radioChannelId) {
    client.on('messageCreate', (m) => { try { handleRadioMessage(m).catch(() => {}); } catch (e) {} });
    console.log(`[CAD] Radio listener attached to channel ${cfg.radioChannelId}. Voice: ${voice.available() ? 'ON' : 'text-only'}. Intent: ${process.env.ANTHROPIC_API_KEY ? 'Claude' : 'rule-based'}.`);
  } else {
    console.log('[CAD] No CAD_RADIO_CHANNEL_ID set — radio listener disabled (web console still works).');
  }
  wired = true;
}

function status() {
  const cfg = config();
  return {
    configured: !!cfg.radioChannelId,
    radioChannelId: cfg.radioChannelId, voiceChannelId: cfg.voiceChannelId, controlRoleId: cfg.controlRoleId,
    voiceGuildId: cfg.guildId,
    voiceReady: !!(voice && voice.available()),
    voiceConnected: !!(voice && voice.isConnected && voice.isConnected()),
    voice: voice && voice.getDiag ? voice.getDiag() : null,
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
  if (voice) {
    voice.setChannel(String(guildId), String(channelId));
    const joined = await voice.join().catch(() => false);
    if (!joined && !process.env.ELEVENLABS_API_KEY) return { ok: true, joined: false, note: 'Saved. Add an ElevenLabs API key to speak.' };
    if (!joined) return { ok: true, joined: false, note: 'Saved, but could not join yet (check the bot can see/join that channel).' };
  }
  return { ok: true, joined: true };
}
async function leaveVoice() {
  await siteConfig.set('cadVoiceChannelId', '');
  if (voice) voice.leave();
  return { ok: true };
}

module.exports = {
  init, status, transmit, config, recentFeed, setVoiceChannel, leaveVoice,
  // actions used by the web console + radio
  actBookOn, actBookOff, actStatus, actCreateIncident, actAssign, actOnScene, actUpdate, actClose, actVehicle, actPerson, actBackup,
  services, phrasing,
};
