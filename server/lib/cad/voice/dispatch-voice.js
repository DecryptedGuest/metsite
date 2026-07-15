// server/lib/cad/voice/dispatch-voice.js
// Joins a configured voice channel, holds ONE AudioPlayer, and drains an
// in-memory queue so exactly one transmission plays at a time. Grade I incidents
// are prefixed with an attention tone. Every enqueue is synthesised via the
// TtsProvider and played; the text mirror to #radio is handled by the caller.
//
// @discordjs/voice + its audio stack (ffmpeg, an opus encoder, libsodium) are
// heavy native deps. They're require()d LAZILY here so the whole app keeps
// running if they're not installed yet — voice simply reports unavailable and
// the CAD runs text-only. Install them to enable speech (see README/CAD.md).
const fs = require('fs');
const { Readable } = require('stream');

// prism-media (used by @discordjs/voice to transcode the mp3 → Opus) needs to
// find ffmpeg. Point it at the bundled ffmpeg-static binary so playback works
// without a system ffmpeg on PATH — a common "joins but never speaks" cause.
try {
  if (!process.env.FFMPEG_PATH) {
    const p = require('ffmpeg-static');
    if (p && typeof p === 'string') process.env.FFMPEG_PATH = p;
  }
} catch (e) { /* ffmpeg-static not installed → voice stays unavailable */ }

let V = null; // the @discordjs/voice module, once loaded
function loadVoiceLib() {
  if (V) return V;
  try { V = require('@discordjs/voice'); } catch (e) { V = null; }
  return V;
}

class DispatchVoice {
  constructor({ client, ttsProvider, guildId, voiceChannelId, tonePath } = {}) {
    this.client = client || null;
    this.tts = ttsProvider || null;
    this.guildId = guildId || null;
    this.voiceChannelId = voiceChannelId || null;
    this.tonePath = tonePath || process.env.CAD_ATTENTION_TONE_PATH || null;
    this.queue = [];        // [{ text, grade }]
    this.playing = false;
    this.connection = null;
    this.player = null;
    // Diagnostics surfaced to the console so "why isn't it speaking?" is visible.
    this.diag = { lastError: null, lastSpokeAt: null, lastAttemptAt: null, ffmpeg: process.env.FFMPEG_PATH || null, events: [] };
  }

  // Record a voice-lifecycle event to a ring buffer (shown in the console panel)
  // AND the server log, so the exact handshake path is observable without digging.
  _ev(msg) {
    const line = new Date().toISOString().slice(11, 19) + ' ' + msg;
    this.diag.events.push(line);
    while (this.diag.events.length > 25) this.diag.events.shift();
    try { console.log('[CAD] voice:', msg); } catch (e) {}
  }

  // Human-readable reason voice can't run right now (null when it can).
  whyUnavailable() {
    if (!loadVoiceLib()) return 'voice library not installed (@discordjs/voice)';
    if (!this.client) return 'no Discord client';
    if (!this.guildId) return 'no server selected';
    if (!this.voiceChannelId) return 'no voice channel selected';
    if (!this.tts || !this.tts.available || !this.tts.available()) return 'no ElevenLabs API key set';
    return null;
  }
  getDiag() {
    return {
      available: this.available(), connected: this.isConnected(),
      why: this.whyUnavailable(), ffmpeg: process.env.FFMPEG_PATH || null,
      lastError: this.diag.lastError, lastSpokeAt: this.diag.lastSpokeAt, lastAttemptAt: this.diag.lastAttemptAt,
      events: this.diag.events.slice(-16),
    };
  }

  // Can we actually speak? Needs the voice lib, a configured channel, and a
  // working TTS provider. When false, callers still mirror text to #radio.
  available() {
    return !!(loadVoiceLib() && this.client && this.guildId && this.voiceChannelId && this.tts && this.tts.available && this.tts.available());
  }

  enqueue(text, { grade = null } = {}) {
    if (!text) return;
    this.queue.push({ text: String(text), grade });
    this._drain().catch(() => {});
  }

  // Point the dispatcher at a different guild/voice channel. Tears down any
  // existing connection so the next join lands in the new channel.
  setChannel(guildId, channelId) {
    const changed = (guildId || null) !== this.guildId || (channelId || null) !== this.voiceChannelId;
    this.guildId = guildId || null;
    this.voiceChannelId = channelId || null;
    if (changed && this.connection) { try { this.connection.destroy(); } catch (e) {} this.connection = null; }
  }

  // Join the configured channel now (so the bot is present before any speech).
  // Guarded so overlapping calls (a user click racing the boot auto-join or a
  // retry) share ONE attempt instead of bouncing each other in/out of the VC.
  async join() {
    if (!this.available()) return false;
    if (this._joining) return this._joining;
    this._joining = this._ensureConnection()
      .then((c) => { this._joining = null; return !!c; })
      .catch(() => { this._joining = null; return false; });
    return this._joining;
  }

  isConnected() {
    var lib = loadVoiceLib();
    // Truly connected = the UDP voice link is Ready (a Signalling/Connecting/
    // Disconnected connection is NOT playable, so it must not read as "in channel").
    return !!(lib && this.connection && this.connection.state && this.connection.state.status === lib.VoiceConnectionStatus.Ready);
  }

  leave() { this.destroy(); }

  async _ensureConnection() {
    const lib = loadVoiceLib();
    if (!lib) return null;
    // Already Ready → healthy connection, clear any stale error and reuse it.
    if (this.isConnected()) { this.diag.lastError = null; return this.connection; }
    // NOTE: joinVoiceChannel() is idempotent per guild — calling it again for the
    // same guild/channel reuses the existing connection rather than bouncing it —
    // so we do NOT pre-destroy here (that was the leave/rejoin churn). We only try
    // a couple of times for a flaky first handshake.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const conn = await this._connectOnce(lib, attempt);
      if (conn) { this.diag.lastError = null; return conn; }
      await new Promise((r) => setTimeout(r, 700));
    }
    return null;
  }

  async _connectOnce(lib, attempt) {
    const guild = await this.client.guilds.fetch(this.guildId).catch(() => null);
    if (!guild) { this.diag.lastError = 'guild not found (is the bot in that server?)'; this._ev('guild not found'); return null; }
    this._ev(`join attempt ${attempt} → channel ${this.voiceChannelId}`);
    try {
      this.connection = lib.joinVoiceChannel({
        channelId: this.voiceChannelId, guildId: this.guildId,
        adapterCreator: guild.voiceAdapterCreator, selfDeaf: false,
      });
    } catch (e) { this.diag.lastError = 'join failed: ' + e.message; this._ev('join threw: ' + e.message); return null; }
    if (!this.player) this.player = lib.createAudioPlayer({ behaviors: { noSubscriber: lib.NoSubscriberBehavior.Play } });
    this.connection.subscribe(this.player);
    const conn = this.connection;
    if (!conn.__cadWired) {
      conn.__cadWired = true;
      this._rejoins = 0;
      conn.on(lib.VoiceConnectionStatus.Ready, () => { this._rejoins = 0; this._ev('READY'); });
      conn.on('stateChange', (o, n) => { if (o.status !== n.status) this._ev('state ' + o.status + ' → ' + n.status); });
      conn.on('error', (e) => { this.diag.lastError = 'connection error: ' + (e && e.message); this._ev('error: ' + (e && e.message)); });
      // Disconnected: record the close code (the key diagnostic), and cap
      // reconnect attempts so a rejected session (e.g. 4006) can't loop forever.
      conn.on(lib.VoiceConnectionStatus.Disconnected, async (oldS, newS) => {
        const code = newS && newS.closeCode;
        this._ev('DISCONNECTED closeCode=' + code + ' reason=' + (newS && newS.reason));
        this.diag.lastError = 'voice disconnected (close code ' + code + ')';
        if (code === 4014) { try { conn.destroy(); } catch (_) {} if (this.connection === conn) this.connection = null; return; }
        if ((this._rejoins || 0) >= 3) {
          this.diag.lastError = 'voice kept disconnecting (close code ' + code + ') — giving up. Usually a network/UDP or session issue, not permissions.';
          try { conn.destroy(); } catch (_) {} if (this.connection === conn) this.connection = null; return;
        }
        this._rejoins = (this._rejoins || 0) + 1;
        try {
          await Promise.race([
            lib.entersState(conn, lib.VoiceConnectionStatus.Signalling, 5000),
            lib.entersState(conn, lib.VoiceConnectionStatus.Connecting, 5000),
          ]);
        } catch (e) { try { conn.destroy(); } catch (_) {} if (this.connection === conn) this.connection = null; }
      });
    }
    // CRITICAL: wait until the UDP voice connection is actually Ready before we
    // play — playing too early means Discord never hears the audio.
    try {
      await lib.entersState(this.connection, lib.VoiceConnectionStatus.Ready, 20000);
      return this.connection;
    } catch (e) {
      const st = this.connection && this.connection.state ? this.connection.state.status : 'unknown';
      this.diag.lastError = `voice never became ready (attempt ${attempt}, stuck in "${st}") — the UDP voice handshake didn't complete. This is a network/host issue, not permissions.`;
      this._ev(`timeout waiting for READY, stuck in ${st}`);
      try { this.connection.destroy(); } catch (_) {}
      this.connection = null;
      return null;
    }
  }

  // Resolves true if the clip played to the end, false (with diag.lastError set)
  // on any failure.
  _playResource(lib, source, isFile) {
    return new Promise((resolve) => {
      let resource;
      try {
        const input = isFile ? fs.createReadStream(source) : Readable.from(source);
        resource = lib.createAudioResource(input, { inputType: lib.StreamType.Arbitrary });
      } catch (e) { this.diag.lastError = 'audio resource failed (ffmpeg?): ' + e.message; return resolve(false); }
      const cleanup = () => { this.player.off(lib.AudioPlayerStatus.Idle, onIdle); this.player.off('error', onErr); };
      const onIdle = () => { cleanup(); resolve(true); };
      const onErr = (e) => { this.diag.lastError = 'player error: ' + (e && e.message); cleanup(); resolve(false); };
      this.player.on(lib.AudioPlayerStatus.Idle, onIdle);
      this.player.on('error', onErr);
      try { this.player.play(resource); } catch (e) { this.diag.lastError = 'play() threw: ' + e.message; cleanup(); resolve(false); }
    });
  }

  async _drain() {
    if (this.playing) return;
    this.playing = true;
    try {
      while (this.queue.length) {
        const item = this.queue.shift();
        this.diag.lastAttemptAt = new Date().toISOString();
        const why = this.whyUnavailable();
        if (why) { this.diag.lastError = why; continue; } // drop audio (text already mirrored)
        const lib = loadVoiceLib();
        const conn = await this._ensureConnection();
        if (!conn) continue; // diag.lastError already set with the reason
        if (item.grade === 'I' && this.tonePath && fs.existsSync(this.tonePath)) {
          await this._playResource(lib, this.tonePath, true);
        }
        const speech = await this.tts.synthesize(item.text).catch((e) => ({ ok: false, error: e.message }));
        if (!speech.ok || !speech.audio) { this.diag.lastError = 'TTS failed: ' + (speech.error || 'no audio returned'); continue; }
        const played = await this._playResource(lib, speech.audio, false);
        if (played) { this.diag.lastSpokeAt = new Date().toISOString(); this.diag.lastError = null; }
      }
    } finally {
      this.playing = false;
    }
  }

  destroy() {
    try { if (this.connection) this.connection.destroy(); } catch (e) {}
    this.connection = null; this.player = null; this.queue = [];
  }
}

module.exports = { DispatchVoice };
