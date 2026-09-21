// server/lib/secretBox.js — authenticated encryption for secrets we have to
// keep, so a database dump is not a list of live credentials.
//
// AES-256-GCM. The key is derived from JWT_SECRET, which boot already refuses to
// run without and already refuses to accept weak — so there is no second secret
// to forget to set, and rotating JWT_SECRET correctly invalidates every stored
// credential rather than silently decrypting to rubbish.
//
// Set SECRET_BOX_KEY to pin the key independently of JWT_SECRET (rotating one
// without the other is then possible).
const crypto = require('crypto');

const VERSION = 'v1';

let _key = null;
function key() {
  if (_key) return _key;
  const src = process.env.SECRET_BOX_KEY || process.env.JWT_SECRET;
  if (!src || String(src).length < 32) {
    throw new Error('Cannot encrypt secrets · SECRET_BOX_KEY or JWT_SECRET must be set to at least 32 characters.');
  }
  // A fixed salt is correct here: the input is already a high-entropy secret, so
  // this is domain separation from anything else JWT_SECRET is used for, not
  // password stretching.
  _key = crypto.hkdfSync('sha256', String(src), 'metsite.secretbox.v1', 'secret-box', 32);
  return Buffer.from(_key);
}

// Returns "v1.<iv>.<tag>.<ciphertext>", all base64url. Safe to store as text.
function seal(plaintext) {
  const iv = crypto.randomBytes(12);
  const c  = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return [VERSION, iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

// Throws if the value was tampered with or the key has changed — never returns
// a half-decrypted string.
function open(sealed) {
  const parts = String(sealed || '').split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('Stored secret is not in a readable format.');
  const [, iv, tag, ct] = parts;
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

function isSealed(v) { return typeof v === 'string' && v.startsWith(VERSION + '.') && v.split('.').length === 4; }

// True when sealing is possible at all, so a caller can say "not configured"
// instead of throwing at the user.
function available() { try { key(); return true; } catch { return false; } }

module.exports = { seal, open, isSealed, available };
