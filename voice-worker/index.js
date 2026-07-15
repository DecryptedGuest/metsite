// voice-worker/index.js
// ─────────────────────────────────────────────────────────────────────────────
// MET CAD — standalone Discord VOICE WORKER
//
// WHY THIS EXISTS
//   Discord voice needs an OUTBOUND UDP handshake. Railway (where the main
//   portal runs) does not route outbound UDP, so the voice connection reaches
//   "connecting" and then stalls in "signalling" forever — it never becomes
//   Ready and nothing is spoken. This worker is a tiny separate process you run
//   on a UDP-capable host (Fly.io) whose only job is to sit in a voice channel
//   and speak. The Railway app forwards each transmission here over plain HTTPS.
//
// HOW IT TALKS TO THE MAIN APP
//   HTTP, authenticated with a shared secret (X-Worker-Secret header):
//     GET  /health                      → { ok, connected, guildId, channelId, ... }
//     POST /join   { guildId, channelId } → join / move to that channel
//     POST /leave                       → leave the channel
//     POST /speak  { guildId, channelId, text, grade } → queue a line to speak
//                    (guildId/channelId optional — joins/moves first if given)
//
// This process needs its OWN Discord bot token (a second bot application, or
// the same one — but it MUST be a different gateway login than the Railway bot,
// so use a second application). Invite it to the server with Connect + Speak.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const { Readable } = require('stream');
const { Client, GatewayIntentBits } = require('discord.js');
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource, entersState,
  VoiceConnectionStatus, AudioPlayerStatus, NoSubscriberBehavior, StreamType,
} = require('@discordjs/voice');

// prism-media (inside @discordjs/voice) needs ffmpeg to transcode mp3 → Opus.
// Point it at the bundled static binary so no system ffmpeg is required.
try {
  if (!process.env.FFMPEG_PATH) {
    const p = require('ffmpeg-static');
    if (p && typeof p === 'string') process.env.FFMPEG_PATH = p;
  }
} catch (e) { /* voice will report unavailable */ }

const {
  VOICE_BOT_TOKEN,
  WORKER_SECRET,
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID = 'onwK4e9ZLuTAKqWW03F9', // "Daniel" — British male dispatcher
  ELEVENLABS_MODEL_ID = 'eleven_turbo_v2_5',
  CAD_ATTENTION_TONE_PATH,
  PORT = 8080,
} = process.env;

if (!VOICE_BOT_TOKEN) { console.error('[voice-worker] FATAL: VOICE_BOT_TOKEN is required'); process.exit(1); }
if (!WORKER_SECRET)   { console.error('[voice-worker] FATAL: WORKER_SECRET is required (shared with the Railway app)'); process.exit(1); }
if (!ELEVENLABS_API_KEY) console.warn('[voice-worker] WARNING: no ELEVENLABS_API_KEY — /speak will accept but produce no audio.');

// ── Diagnostics ring buffer (surfaced on /health so the console can show it) ──
const diag = { lastError: null, lastSpokeAt: null, lastAttemptAt: null, events: [] };
function ev(msg) {
  const line = new Date().toISOString().slice(11, 19) + ' ' + msg;
  diag.events.push(line);
  while (diag.events.length > 30) diag.events.shift();
  console.log('[voice-worker]', msg);
}

// ── ElevenLabs synthesis (mp3 Buffer) ────────────────────────────────────────
async function synthesize(text) {
  if (!ELEVENLABS_API_KEY) return { ok: false, error: 'no ELEVENLABS_API_KEY' };
  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`, {
      method: 'POST',
      headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({
        text: String(text).slice(0, 900),
        model_id: ELEVENLABS_MODEL_ID,
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.2, use_speaker_boost: true },
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, error: `ElevenLabs HTTP ${res.status}${detail ? ': ' + detail.slice(0, 160) : ''}` };
    }
    return { ok: true, audio: Buffer.from(await res.arrayBuffer()) };
  } catch (e) {
    return { ok: false, error: 'ElevenLabs request failed: ' + e.message };
  }
}

// ── Voice engine: one connection, one player, an in-memory queue ──────────────
const discord = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
let ready = false;

const engine = {
  guildId: null,
  channelId: null,
  connection: null,
  player: null,
  queue: [],        // [{ text, grade }]
  playing: false,
  joining: null,    // in-flight join promise (dedupe overlapping joins)

  connected() {
    return !!(this.connection && this.connection.state && this.connection.state.status === VoiceConnectionStatus.Ready);
  },

  // Join (or move to) a channel. Idempotent per guild — joinVoiceChannel reuses
  // an existing connection for the same guild rather than bouncing it.
  async join(guildId, channelId) {
    if (guildId) this.guildId = String(guildId);
    if (channelId) this.channelId = String(channelId);
    if (!this.guildId || !this.channelId) { diag.lastError = 'no guild/channel selected'; return false; }
    if (this.connected()) { diag.lastError = null; return true; }
    if (this.joining) return this.joining;
    this.joining = this._connect()
      .then((ok) => { this.joining = null; return ok; })
      .catch(() => { this.joining = null; return false; });
    return this.joining;
  },

  async _connect() {
    if (!ready) { diag.lastError = 'Discord client not ready yet'; return false; }
    const guild = await discord.guilds.fetch(this.guildId).catch(() => null);
    if (!guild) { diag.lastError = 'guild not found (is the voice bot in that server?)'; ev('guild not found'); return false; }
    ev(`join → guild ${this.guildId} channel ${this.channelId}`);
    try {
      this.connection = joinVoiceChannel({
        channelId: this.channelId, guildId: this.guildId,
        adapterCreator: guild.voiceAdapterCreator, selfDeaf: false,
      });
    } catch (e) { diag.lastError = 'join failed: ' + e.message; ev('join threw: ' + e.message); return false; }

    if (!this.player) this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    this.connection.subscribe(this.player);

    const conn = this.connection;
    if (!conn.__wired) {
      conn.__wired = true;
      this._rejoins = 0;
      conn.on(VoiceConnectionStatus.Ready, () => { this._rejoins = 0; diag.lastError = null; ev('READY'); });
      conn.on('stateChange', (o, n) => { if (o.status !== n.status) ev('state ' + o.status + ' → ' + n.status); });
      conn.on('error', (e) => { diag.lastError = 'connection error: ' + (e && e.message); ev('error: ' + (e && e.message)); });
      conn.on(VoiceConnectionStatus.Disconnected, async (_o, newS) => {
        const code = newS && newS.closeCode;
        ev('DISCONNECTED closeCode=' + code);
        diag.lastError = 'voice disconnected (close code ' + code + ')';
        if (code === 4014) { try { conn.destroy(); } catch (_) {} if (this.connection === conn) this.connection = null; return; }
        if ((this._rejoins || 0) >= 3) {
          try { conn.destroy(); } catch (_) {} if (this.connection === conn) this.connection = null; return;
        }
        this._rejoins = (this._rejoins || 0) + 1;
        try {
          await Promise.race([
            entersState(conn, VoiceConnectionStatus.Signalling, 5000),
            entersState(conn, VoiceConnectionStatus.Connecting, 5000),
          ]);
        } catch (e) { try { conn.destroy(); } catch (_) {} if (this.connection === conn) this.connection = null; }
      });
    }

    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 20000);
      diag.lastError = null;
      return true;
    } catch (e) {
      const st = this.connection && this.connection.state ? this.connection.state.status : 'unknown';
      diag.lastError = `voice never became ready (stuck in "${st}") — UDP handshake didn't complete on THIS host.`;
      ev(`timeout waiting for READY, stuck in ${st}`);
      try { this.connection.destroy(); } catch (_) {}
      this.connection = null;
      return false;
    }
  },

  leave() {
    try { if (this.connection) this.connection.destroy(); } catch (e) {}
    this.connection = null; this.queue = [];
    ev('left channel');
  },

  enqueue(text, grade) {
    if (!text) return;
    this.queue.push({ text: String(text), grade: grade || null });
    this._drain().catch(() => {});
  },

  _play(source, isFile) {
    return new Promise((resolve) => {
      let resource;
      try {
        const input = isFile ? fs.createReadStream(source) : Readable.from(source);
        resource = createAudioResource(input, { inputType: StreamType.Arbitrary });
      } catch (e) { diag.lastError = 'audio resource failed (ffmpeg?): ' + e.message; return resolve(false); }
      const cleanup = () => { this.player.off(AudioPlayerStatus.Idle, onIdle); this.player.off('error', onErr); };
      const onIdle = () => { cleanup(); resolve(true); };
      const onErr = (e) => { diag.lastError = 'player error: ' + (e && e.message); cleanup(); resolve(false); };
      this.player.on(AudioPlayerStatus.Idle, onIdle);
      this.player.on('error', onErr);
      try { this.player.play(resource); } catch (e) { diag.lastError = 'play() threw: ' + e.message; cleanup(); resolve(false); }
    });
  },

  async _drain() {
    if (this.playing) return;
    this.playing = true;
    try {
      while (this.queue.length) {
        const item = this.queue.shift();
        diag.lastAttemptAt = new Date().toISOString();
        const ok = await this.join();
        if (!ok) continue; // diag.lastError already set
        if (item.grade === 'I' && CAD_ATTENTION_TONE_PATH && fs.existsSync(CAD_ATTENTION_TONE_PATH)) {
          await this._play(CAD_ATTENTION_TONE_PATH, true);
        }
        const speech = await synthesize(item.text);
        if (!speech.ok || !speech.audio) { diag.lastError = 'TTS failed: ' + (speech.error || 'no audio'); continue; }
        const played = await this._play(speech.audio, false);
        if (played) { diag.lastSpokeAt = new Date().toISOString(); diag.lastError = null; }
      }
    } finally {
      this.playing = false;
    }
  },
};

// ── HTTP API ──────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '256kb' }));

// Health is unauthenticated (Fly uses it for checks); it reveals no secrets.
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    ready,
    connected: engine.connected(),
    guildId: engine.guildId,
    channelId: engine.channelId,
    hasElevenKey: !!ELEVENLABS_API_KEY,
    lastError: diag.lastError,
    lastSpokeAt: diag.lastSpokeAt,
    lastAttemptAt: diag.lastAttemptAt,
    events: diag.events.slice(-16),
  });
});

// Everything else requires the shared secret.
function auth(req, res, next) {
  const got = req.get('x-worker-secret') || '';
  if (got !== WORKER_SECRET) return res.status(401).json({ ok: false, error: 'bad worker secret' });
  next();
}

app.post('/join', auth, async (req, res) => {
  const { guildId, channelId } = req.body || {};
  if (!guildId || !channelId) return res.status(400).json({ ok: false, error: 'guildId and channelId required' });
  const ok = await engine.join(guildId, channelId);
  res.json({ ok, connected: engine.connected(), error: ok ? null : diag.lastError });
});

app.post('/leave', auth, (_req, res) => { engine.leave(); res.json({ ok: true }); });

app.post('/speak', auth, async (req, res) => {
  const { guildId, channelId, text, grade } = req.body || {};
  if (!text) return res.status(400).json({ ok: false, error: 'text required' });
  if (guildId && channelId) engine.join(guildId, channelId).catch(() => {}); // fire-and-forget move
  engine.enqueue(text, grade);
  res.json({ ok: true, queued: engine.queue.length });
});

app.listen(PORT, () => console.log(`[voice-worker] HTTP listening on :${PORT}`));

// ── Discord login ──────────────────────────────────────────────────────────────
discord.once('ready', () => { ready = true; ev(`logged in as ${discord.user.tag}`); });
discord.on('error', (e) => ev('discord client error: ' + (e && e.message)));
discord.login(VOICE_BOT_TOKEN).catch((e) => { console.error('[voice-worker] login failed:', e.message); process.exit(1); });
