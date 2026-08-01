// server/lib/cad/tts/elevenlabs.js
// ElevenLabs implementation of TtsProvider (en-GB dispatcher voice). Returns an
// mp3 Buffer. Fully env-gated: with no ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID
// it reports available()=false and the CAD runs text-only.
const fetch = require('node-fetch');
const { TtsProvider } = require('./types');

// A stable ElevenLabs premade en-GB voice ("Daniel" — deep, authoritative
// British male, a natural fit for a control-room dispatcher). Used when no
// ELEVENLABS_VOICE_ID is set, so the CAD speaks with just the API key present.
// Override with ELEVENLABS_VOICE_ID (e.g. George JBFqnCBsd6RMkjVDRZzb, or a
// custom clone) any time.
const DEFAULT_VOICE_ID = 'onwK4e9ZLuTAKqWW03F9';

class ElevenLabsTts extends TtsProvider {
  constructor(opts = {}) {
    super();
    this.apiKey = opts.apiKey || process.env.ELEVENLABS_API_KEY || null;
    this.voiceId = opts.voiceId || process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID;
    this.modelId = opts.modelId || process.env.ELEVENLABS_MODEL_ID || 'eleven_turbo_v2_5';
  }
  get name() { return 'elevenlabs'; }
  available() { return !!(this.apiKey && this.voiceId); }

  async synthesize(text, opts = {}) {
    if (!this.available()) return { ok: false, error: 'ElevenLabs not configured' };
    const voiceId = opts.voiceId || this.voiceId;
    try {
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: { 'xi-api-key': this.apiKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify({
          text: String(text).slice(0, 900),
          model_id: this.modelId,
          voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.2, use_speaker_boost: true },
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return { ok: false, error: `ElevenLabs HTTP ${res.status}${detail ? ': ' + detail.slice(0, 160) : ''}` };
      }
      const buf = Buffer.from(await res.arrayBuffer());
      return { ok: true, audio: buf, mime: 'audio/mpeg' };
    } catch (e) {
      return { ok: false, error: 'ElevenLabs request failed: ' + e.message };
    }
  }
}

module.exports = { ElevenLabsTts };
