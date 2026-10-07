import { describe, expect, it } from 'vitest';
import { verifyIdToken } from '../server/auth/google';
import { sign, timingSafeEqual, unsign } from '../server/crypto';
import { b64urlDecode, b64urlEncode, buildPushRequest, concat, vapidAuthorization } from '../shared/webpush';

const enc = new TextEncoder();

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey('raw', ikm as Uint8Array<ArrayBuffer>, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: salt as Uint8Array<ArrayBuffer>, info: info as Uint8Array<ArrayBuffer> },
      key,
      bytes * 8,
    ),
  );
}

describe('Web Push (RFC 8291) encryption', () => {
  it('produces a payload the browser side can decrypt', async () => {
    // Browser ("user agent") key pair and auth secret.
    const ua = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
    const uaPublic = new Uint8Array((await crypto.subtle.exportKey('raw', ua.publicKey)) as ArrayBuffer);
    const authSecret = crypto.getRandomValues(new Uint8Array(16));

    // VAPID key pair.
    const v = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const vPub = new Uint8Array((await crypto.subtle.exportKey('raw', v.publicKey)) as ArrayBuffer);
    const vJwk = (await crypto.subtle.exportKey('jwk', v.privateKey)) as JsonWebKey;
    const vapid = { publicKey: b64urlEncode(vPub), privateKey: vJwk.d!, subject: 'https://cowork.test' };

    const req = await buildPushRequest(
      { endpoint: 'https://push.example.test/send/abc', p256dh: b64urlEncode(uaPublic), auth: b64urlEncode(authSecret) },
      { title: 'Hello', body: 'World', url: '/today' },
      vapid,
    );
    expect(req.headers['Content-Encoding']).toBe('aes128gcm');

    // Decrypt as the browser would.
    const body = req.body;
    const salt = body.slice(0, 16);
    const rs = new DataView(body.buffer, body.byteOffset).getUint32(16);
    expect(rs).toBe(4096);
    const idlen = body[20]!;
    const asPublic = body.slice(21, 21 + idlen);
    const ciphertext = body.slice(21 + idlen);
    const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = new Uint8Array(
      await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey } as Parameters<SubtleCrypto['deriveBits']>[0], ua.privateKey, 256),
    );
    const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
    const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
    const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
    const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aes, ciphertext));
    expect(plain[plain.length - 1]).toBe(2);
    expect(JSON.parse(new TextDecoder().decode(plain.slice(0, -1)))).toEqual({ title: 'Hello', body: 'World', url: '/today' });

    // The VAPID JWT verifies with the public key and targets the push service origin.
    const auth = await vapidAuthorization('https://push.example.test/send/abc', vapid);
    const jwt = /t=([^,]+)/.exec(auth)![1]!;
    const [h, p, s] = jwt.split('.') as [string, string, string];
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, v.publicKey, b64urlDecode(s), enc.encode(`${h}.${p}`));
    expect(ok).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(p))).aud).toBe('https://push.example.test');
  });
});

describe('Google ID token verification', () => {
  async function setup() {
    const kp = (await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const jwk = { ...((await crypto.subtle.exportKey('jwk', kp.publicKey)) as JsonWebKey), kid: 'k1' };
    const make = async (claims: Record<string, unknown>, kid = 'k1') => {
      const h = b64urlEncode(enc.encode(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })));
      const p = b64urlEncode(enc.encode(JSON.stringify(claims)));
      const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, enc.encode(`${h}.${p}`));
      return `${h}.${p}.${b64urlEncode(sig)}`;
    };
    return { make, getKeys: async () => [jwk] };
  }
  const now = Date.parse('2026-10-07T12:00:00Z');
  const base = {
    iss: 'https://accounts.google.com',
    aud: 'client-1',
    sub: '1234',
    email: 'a@example.test',
    email_verified: true,
    nonce: 'n1',
    iat: now / 1000 - 10,
    exp: now / 1000 + 3600,
  };

  it('accepts a valid token', async () => {
    const { make, getKeys } = await setup();
    const c = await verifyIdToken(await make(base), { clientId: 'client-1', nonce: 'n1', now, getKeys });
    expect(c).toMatchObject({ email: 'a@example.test', email_verified: true, sub: '1234' });
  });

  it.each([
    ['wrong audience', { aud: 'other' }],
    ['wrong issuer', { iss: 'https://evil.test' }],
    ['expired', { exp: now / 1000 - 3600 }],
    ['nonce mismatch', { nonce: 'other' }],
  ])('rejects %s', async (_name, patch) => {
    const { make, getKeys } = await setup();
    await expect(verifyIdToken(await make({ ...base, ...patch }), { clientId: 'client-1', nonce: 'n1', now, getKeys })).rejects.toThrow();
  });

  it('rejects a tampered payload', async () => {
    const { make, getKeys } = await setup();
    const [h, , s] = (await make(base)).split('.');
    const forged = b64urlEncode(enc.encode(JSON.stringify({ ...base, email: 'admin@example.test' })));
    await expect(verifyIdToken(`${h}.${forged}.${s}`, { clientId: 'client-1', nonce: 'n1', now, getKeys })).rejects.toThrow(/signature/);
  });

  it('reports email_verified=false so sign-in can refuse it', async () => {
    const { make, getKeys } = await setup();
    const c = await verifyIdToken(await make({ ...base, email_verified: false }), { clientId: 'client-1', nonce: 'n1', now, getKeys });
    expect(c.email_verified).toBe(false);
  });
});

describe('signed values', () => {
  it('detects tampering', async () => {
    const secret = 'x'.repeat(40);
    const signed = await sign(secret, 'payload');
    expect(await unsign(secret, signed)).toBe('payload');
    expect(await unsign(secret, signed.replace('payload', 'payloaD'))).toBeNull();
    expect(await unsign('y'.repeat(40), signed)).toBeNull();
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
  });
});
