// server/lib/cad/tts/types.js
// The TtsProvider abstraction the DispatchVoice service speaks through, so the
// engine (ElevenLabs today) can be swapped without touching dispatch logic.
//
// A provider implements:  async synthesize(text, opts) -> TtsResult
//   TtsResult: { ok:true, audio:Buffer, mime:string } | { ok:false, error:string }
//   opts: { voiceId?, format? }
//
// `available()` lets callers decide whether to attempt voice at all (so the CAD
// degrades to text-only when no key/voice is configured).

class TtsProvider {
  // eslint-disable-next-line no-unused-vars
  async synthesize(text, opts) { return { ok: false, error: 'not implemented' }; }
  available() { return false; }
  get name() { return 'base'; }
}

// A provider that never speaks — used when TTS isn't configured. The dispatch
// still mirrors every transmission as text in #radio.
class NullTtsProvider extends TtsProvider {
  async synthesize() { return { ok: false, error: 'TTS not configured' }; }
  available() { return false; }
  get name() { return 'null'; }
}

module.exports = { TtsProvider, NullTtsProvider };
