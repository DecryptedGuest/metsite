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

  async _ensureConnection() {
    const lib = loadVoiceLib();
    if (!lib) return null;
    if (this.connection && this.connection.state.status !== lib.VoiceConnectionStatus.Destroyed) return this.connection;
    const guild = await this.client.guilds.fetch(this.guildId).catch(() => null);
    if (!guild) return null;
    this.connection = lib.joinVoiceChannel({
      channelId: this.voiceChannelId,
      guildId: this.guildId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
    });
    if (!this.player) {
      this.player = lib.createAudioPlayer({ behaviors: { noSubscriber: lib.NoSubscriberBehavior.Play } });
    }
    this.connection.subscribe(this.player);
    return this.connection;
  }

  _playResource(lib, source, isFile) {
    return new Promise((resolve) => {
      let resource;
      try {
        const input = isFile ? fs.createReadStream(source) : Readable.from(source);
        resource = lib.createAudioResource(input, { inputType: lib.StreamType.Arbitrary });
      } catch (e) { return resolve(); }
      const done = () => { this.player.off(lib.AudioPlayerStatus.Idle, done); this.player.off('error', done); resolve(); };
      this.player.on(lib.AudioPlayerStatus.Idle, done);
      this.player.on('error', done);
      try { this.player.play(resource); } catch (e) { done(); }
    });
  }

  async _drain() {
    if (this.playing) return;
    this.playing = true;
    try {
      while (this.queue.length) {
        const item = this.queue.shift();
        if (!this.available()) continue; // drop audio (text mirror already sent)
        const lib = loadVoiceLib();
        const conn = await this._ensureConnection();
        if (!conn) continue;
        // Grade I → attention tone first (best-effort; skipped if no file).
        if (item.grade === 'I' && this.tonePath && fs.existsSync(this.tonePath)) {
          await this._playResource(lib, this.tonePath, true);
        }
        const speech = await this.tts.synthesize(item.text).catch(() => ({ ok: false }));
        if (speech.ok && speech.audio) await this._playResource(lib, speech.audio, false);
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
