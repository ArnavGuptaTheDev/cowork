import { afterEach, describe, expect, it, vi } from 'vitest';
import { b64urlEncode } from '../shared/webpush';
import { ADMIN_EMAIL, createEnv, makeApp } from './helpers/app';

const enc = new TextEncoder();

/** Fakes Google's token + JWKS endpoints and walks the real /start → /callback flow. */
async function runFlow(email: string, opts: { verified?: boolean } = {}) {
  const env = createEnv();
  const h = makeApp(env);
  const kp = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = { ...((await crypto.subtle.exportKey('jwk', kp.publicKey)) as JsonWebKey), kid: crypto.randomUUID() };

  const start = await h.request('/api/auth/google/start?next=/habits');
  expect(start.status).toBe(302);
  const authUrl = new URL(start.headers.get('location')!);
  const state = authUrl.searchParams.get('state')!;
  const nonce = authUrl.searchParams.get('nonce')!;
  const oauthCookie = start.headers.get('set-cookie')!.split(';')[0]!;

  const header = b64urlEncode(enc.encode(JSON.stringify({ alg: 'RS256', kid: jwk.kid, typ: 'JWT' })));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64urlEncode(
    enc.encode(
      JSON.stringify({
        iss: 'https://accounts.google.com',
        aud: env.GOOGLE_CLIENT_ID,
        sub: `sub-${email}`,
        email,
        email_verified: opts.verified ?? true,
        name: 'Test Person',
        picture: 'https://lh3.googleusercontent.com/a/x',
        nonce,
        iat: now,
        exp: now + 3600,
      }),
    ),
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, enc.encode(`${header}.${payload}`));
  const idToken = `${header}.${payload}.${b64urlEncode(sig)}`;

  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://oauth2.googleapis.com/token')) return Response.json({ id_token: idToken });
    if (url.startsWith('https://www.googleapis.com/oauth2/v3/certs')) return Response.json({ keys: [jwk] });
    throw new Error(`unexpected fetch ${url}`);
  });

  const cb = await h.request(`/api/auth/google/callback?code=abc&state=${state}`, { headers: { cookie: oauthCookie } });
  return { env, cb };
}

afterEach(() => vi.unstubAllGlobals());

describe('Google OAuth callback (full flow, Google mocked)', () => {
  it('signs in the super admin and redirects to the requested page with a session cookie', async () => {
    const { cb } = await runFlow(ADMIN_EMAIL);
    const body = cb.status === 302 ? '' : await cb.text();
    expect(cb.status, body).toBe(302);
    expect(cb.headers.get('location')).toBe('/habits');
    expect(cb.headers.get('set-cookie')).toContain('cw_session=');
  });

  it('sends an uninvited email to /not-invited without creating a user', async () => {
    const { cb, env } = await runFlow('stranger@example.test');
    expect(cb.headers.get('location')).toBe('/not-invited');
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it('rejects an unverified email', async () => {
    const { cb } = await runFlow(ADMIN_EMAIL, { verified: false });
    expect(cb.headers.get('location')).toBe('/not-invited?reason=unverified');
  });
});
