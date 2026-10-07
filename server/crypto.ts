import { b64urlDecode, b64urlEncode } from '../shared/webpush';

const enc = new TextEncoder();

export function randomToken(bytes = 32): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(input)));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export async function hmacHex(secret: string, input: string): Promise<string> {
  return toHex(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(input)));
}

/** Constant-time string comparison. */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < Math.max(ab.length, bb.length); i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

/** value.signature, where signature = base64url(HMAC(secret, value)). */
export async function sign(secret: string, value: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(value));
  return `${value}.${b64urlEncode(sig)}`;
}

export async function unsign(secret: string, signed: string): Promise<string | null> {
  const i = signed.lastIndexOf('.');
  if (i <= 0) return null;
  const value = signed.slice(0, i);
  const expected = await sign(secret, value);
  return timingSafeEqual(expected, signed) ? value : null;
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return b64urlEncode(await crypto.subtle.digest('SHA-256', enc.encode(verifier)));
}

export { b64urlDecode, b64urlEncode };
