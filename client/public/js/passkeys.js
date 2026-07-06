// client/public/js/passkeys.js — passkey (WebAuthn) registration, management and
// step-up, using the native navigator.credentials API (no external library).
// Produces the JSON shapes @simplewebauthn/server expects on the server side.
(function () {
  function supported() {
    return !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create);
  }

  // ── base64url <-> ArrayBuffer ──
  function b64urlToBuf(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
    const bin = atob(s + pad);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return buf.buffer;
  }
  function bufToB64url(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function csrf() { return (document.cookie.match(/csrf_token=([^;]+)/) || [])[1] || ''; }
  async function post(path, body) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
      credentials: 'same-origin',
      body: body ? JSON.stringify(body) : '{}',
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    return data;
  }

  // ── Registration ceremony ──
  async function registerPasskey(name) {
    if (!supported()) throw new Error('This device or browser does not support passkeys.');
    const options = await post('/api/webauthn/register/options');
    options.challenge = b64urlToBuf(options.challenge);
    options.user.id   = b64urlToBuf(options.user.id);
    if (Array.isArray(options.excludeCredentials)) {
      options.excludeCredentials = options.excludeCredentials.map(c => ({ ...c, id: b64urlToBuf(c.id) }));
    }
    const cred = await navigator.credentials.create({ publicKey: options });
    if (!cred) throw new Error('Registration was cancelled.');
    const att = cred.response;
    const response = {
      id: cred.id,
      rawId: bufToB64url(cred.rawId),
      type: cred.type,
      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
      authenticatorAttachment: cred.authenticatorAttachment || undefined,
      response: {
        clientDataJSON: bufToB64url(att.clientDataJSON),
        attestationObject: bufToB64url(att.attestationObject),
        transports: att.getTransports ? att.getTransports() : [],
      },
    };
    return post('/api/webauthn/register/verify', { response, name: name || 'Passkey' });
  }

  // ── Step-up authentication ceremony ──
  async function stepUp() {
    if (!supported()) throw new Error('This device or browser does not support passkeys.');
    const options = await post('/api/webauthn/authenticate/options');
    options.challenge = b64urlToBuf(options.challenge);
    if (Array.isArray(options.allowCredentials)) {
      options.allowCredentials = options.allowCredentials.map(c => ({ ...c, id: b64urlToBuf(c.id) }));
    }
    const cred = await navigator.credentials.get({ publicKey: options });
    if (!cred) throw new Error('Verification was cancelled.');
    const a = cred.response;
    const response = {
      id: cred.id,
      rawId: bufToB64url(cred.rawId),
      type: cred.type,
      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
      authenticatorAttachment: cred.authenticatorAttachment || undefined,
      response: {
        clientDataJSON: bufToB64url(a.clientDataJSON),
        authenticatorData: bufToB64url(a.authenticatorData),
        signature: bufToB64url(a.signature),
        userHandle: a.userHandle ? bufToB64url(a.userHandle) : undefined,
      },
    };
    return post('/api/webauthn/authenticate/verify', { response });
  }

  window.MetPasskeys = { supported, registerPasskey, stepUp };
})();
