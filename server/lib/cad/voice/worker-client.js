// server/lib/cad/voice/worker-client.js
// Thin HTTP client for the standalone voice worker (voice-worker/, deployed on a
// UDP-capable host like Fly.io). Railway can't do the Discord voice UDP handshake
// itself, so when CAD_VOICE_WORKER_URL + CAD_VOICE_WORKER_SECRET are set the CAD
// forwards spoken lines here instead of using the in-process DispatchVoice.
//
// Everything is best-effort: if the worker is down the CAD carries on text-only.
const fetch = require('node-fetch');

class VoiceWorkerClient {
  constructor() {
    this.baseUrl = (process.env.CAD_VOICE_WORKER_URL || '').replace(/\/+$/, '') || null;
    this.secret = process.env.CAD_VOICE_WORKER_SECRET || null;
  }

  // Worker mode is on only when BOTH the URL and the shared secret are present.
  enabled() { return !!(this.baseUrl && this.secret); }

  async _post(path, body, timeoutMs = 8000) {
    if (!this.enabled()) return { ok: false, error: 'voice worker not configured' };
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(this.baseUrl + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-worker-secret': this.secret },
        body: JSON.stringify(body || {}),
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: data.error || `worker HTTP ${res.status}` };
      return { ok: true, ...data };
    } catch (e) {
      return { ok: false, error: 'voice worker unreachable: ' + e.message };
    } finally { clearTimeout(t); }
  }

  speak(guildId, channelId, text, grade) { return this._post('/speak', { guildId, channelId, text, grade }); }
  join(guildId, channelId) { return this._post('/join', { guildId, channelId }); }
  leave() { return this._post('/leave', {}); }

  // Health is unauthenticated on the worker but we still send the header.
  async health(timeoutMs = 5000) {
    if (!this.enabled()) return null;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(this.baseUrl + '/health', { headers: { 'x-worker-secret': this.secret }, signal: ctrl.signal });
      const data = await res.json().catch(() => ({}));
      return res.ok ? data : { ok: false, error: `worker HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, error: 'voice worker unreachable: ' + e.message };
    } finally { clearTimeout(t); }
  }
}

module.exports = { VoiceWorkerClient };
