// Web Push for Workers using WebCrypto only.
// Payload encryption: RFC 8291 (aes128gcm, RFC 8188). Authentication: VAPID (RFC 8292).

export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string; // base64url, uncompressed P-256 point (65 bytes)
  auth: string; // base64url, 16 bytes
}

export interface VapidKeys {
  publicKey: string; // base64url, uncompressed P-256 point (65 bytes)
  privateKey: string; // base64url, 32-byte scalar
  subject: string; // mailto: or https: URL
}

export interface PushRequest {
  endpoint: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

const enc = new TextEncoder();

/** ECDH params: the DOM and Workers typings disagree on the shape, the runtime takes { name, public }. */
type DeriveAlgorithm = Parameters<SubtleCrypto['deriveBits']>[0];

export function b64urlEncode(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(norm + '='.repeat((4 - (norm.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** WebCrypto wants ArrayBuffer-backed views; all of ours are. */
const buf = (u: Uint8Array) => u as Uint8Array<ArrayBuffer>;

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey('raw', buf(ikm), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: buf(info) }, key, bytes * 8),
  );
}

/** Encrypts a payload for a subscription (RFC 8291). Exposed for tests. */
export async function encryptPayload(
  payload: Uint8Array,
  uaPublicB64: string,
  authSecretB64: string,
  opts: { salt?: Uint8Array; serverKeys?: CryptoKeyPair } = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const uaPublic = b64urlDecode(uaPublicB64);
  const authSecret = b64urlDecode(authSecretB64);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error('Invalid subscription keys');

  const serverKeys =
    opts.serverKeys ??
    ((await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair);
  const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', serverKeys.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey } as DeriveAlgorithm, serverKeys.privateKey, 256),
  );

  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  // Single record: payload followed by the 0x02 "last record" delimiter.
  const plaintext = concat(payload, new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey('raw', buf(cek), 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(nonce) }, aesKey, plaintext));

  const rs = 4096;
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, rs);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

async function importVapidPrivateKey(vapid: VapidKeys): Promise<CryptoKey> {
  const pub = b64urlDecode(vapid.publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID_PUBLIC_KEY must be an uncompressed P-256 point');
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: b64urlEncode(pub.slice(1, 33)),
    y: b64urlEncode(pub.slice(33, 65)),
    d: vapid.privateKey,
    ext: true,
  };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/** Builds the VAPID Authorization header value for an endpoint. */
export async function vapidAuthorization(endpoint: string, vapid: VapidKeys, nowMs = Date.now()): Promise<string> {
  const aud = new URL(endpoint).origin;
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64urlEncode(
    enc.encode(JSON.stringify({ aud, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: vapid.subject })),
  );
  const unsigned = `${header}.${claims}`;
  const key = await importVapidPrivateKey(vapid);
  // WebCrypto ECDSA signatures are already IEEE P1363 (r || s), which is what JWS ES256 expects.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(unsigned));
  return `vapid t=${unsigned}.${b64urlEncode(sig)}, k=${vapid.publicKey}`;
}

export async function buildPushRequest(
  sub: PushSubscriptionKeys,
  payload: unknown,
  vapid: VapidKeys,
  opts: { ttlSeconds?: number; urgency?: 'very-low' | 'low' | 'normal' | 'high'; topic?: string } = {},
): Promise<PushRequest> {
  const body = await encryptPayload(enc.encode(JSON.stringify(payload)), sub.p256dh, sub.auth);
  const headers: Record<string, string> = {
    Authorization: await vapidAuthorization(sub.endpoint, vapid),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(opts.ttlSeconds ?? 24 * 3600),
    Urgency: opts.urgency ?? 'normal',
  };
  if (opts.topic) headers.Topic = opts.topic;
  return { endpoint: sub.endpoint, headers, body };
}
