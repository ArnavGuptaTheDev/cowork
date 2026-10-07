// Encryption at rest for small secrets (Google refresh tokens): AES-256-GCM with a key from a Worker secret.
// Output: base64url(12-byte IV || ciphertext+tag). The user id is bound in as additional data, so a ciphertext
// copied onto another user's row won't decrypt.
import { b64urlDecode, b64urlEncode } from '../shared/webpush';

const enc = new TextEncoder();
const dec = new TextDecoder();

async function importKey(keyB64: string | undefined): Promise<CryptoKey> {
  if (!keyB64) throw new Error('CALENDAR_TOKEN_KEY is not configured');
  const raw = b64urlDecode(keyB64);
  if (raw.length !== 32) throw new Error('CALENDAR_TOKEN_KEY must be 32 bytes (base64url)');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function seal(keyB64: string | undefined, plaintext: string, context: string): Promise<string> {
  const key = await importKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(context) }, key, enc.encode(plaintext));
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), 12);
  return b64urlEncode(out);
}

export async function open(keyB64: string | undefined, sealed: string, context: string): Promise<string> {
  const key = await importKey(keyB64);
  const bytes = b64urlDecode(sealed);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: enc.encode(context) },
    key,
    bytes.slice(12),
  );
  return dec.decode(pt);
}
