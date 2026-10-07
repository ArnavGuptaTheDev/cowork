// Google OpenID Connect: authorization code flow with PKCE, and ID token verification (RS256 via JWKS).
import { b64urlDecode } from '../../shared/webpush';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

export interface GoogleClaims {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
  picture?: string;
  nonce?: string;
}

export function buildAuthUrl(p: {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}): string {
  const u = new URL(GOOGLE_AUTH_URL);
  u.search = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state: p.state,
    nonce: p.nonce,
    code_challenge: p.codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return u.toString();
}

export async function exchangeCode(
  p: { code: string; clientId: string; clientSecret: string; redirectUri: string; codeVerifier: string },
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchFn(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: p.code,
      client_id: p.clientId,
      client_secret: p.clientSecret,
      redirect_uri: p.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: p.codeVerifier,
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status})`);
  const body = (await res.json()) as { id_token?: string };
  if (!body.id_token) throw new Error('No id_token in token response');
  return body.id_token;
}

type Jwk = JsonWebKey & { kid?: string };
let jwksCache: { keys: Jwk[]; expires: number } | null = null;

/** Google's signing keys, cached per their Cache-Control. `force` refetches (used when a token has an unknown kid, i.e. keys rotated). */
export async function fetchGoogleJwks(fetchFn: typeof fetch = fetch, now = Date.now(), force = false): Promise<Jwk[]> {
  if (!force && jwksCache && jwksCache.expires > now) return jwksCache.keys;
  const res = await fetchFn(GOOGLE_JWKS_URL);
  if (!res.ok) throw new Error(`JWKS fetch failed (${res.status})`);
  const { keys } = (await res.json()) as { keys: Jwk[] };
  const maxAge = /max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1];
  jwksCache = { keys, expires: now + Math.min(Number(maxAge ?? 3600), 86400) * 1000 };
  return keys;
}

const dec = new TextDecoder();

export async function verifyIdToken(
  idToken: string,
  opts: { clientId: string; nonce: string; now?: number; getKeys: (force?: boolean) => Promise<Jwk[]> },
): Promise<GoogleClaims> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('Malformed ID token');
  const [h, p, s] = parts as [string, string, string];
  const header = JSON.parse(dec.decode(b64urlDecode(h))) as { alg?: string; kid?: string };
  if (header.alg !== 'RS256') throw new Error('Unexpected ID token algorithm');

  let jwk = (await opts.getKeys()).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await opts.getKeys(true)).find((k) => k.kid === header.kid); // keys may have rotated since we cached them
  if (!jwk) throw new Error('Unknown ID token signing key');
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlDecode(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) throw new Error('Bad ID token signature');

  const c = JSON.parse(dec.decode(b64urlDecode(p))) as Record<string, unknown>;
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  if (!GOOGLE_ISSUERS.includes(String(c.iss))) throw new Error('Bad ID token issuer');
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(opts.clientId)) throw new Error('Bad ID token audience');
  if (typeof c.exp !== 'number' || c.exp + 60 < now) throw new Error('ID token expired');
  if (typeof c.iat === 'number' && c.iat - 300 > now) throw new Error('ID token issued in the future');
  if (c.nonce !== opts.nonce) throw new Error('ID token nonce mismatch');
  if (typeof c.sub !== 'string' || typeof c.email !== 'string') throw new Error('ID token missing subject or email');
  const verified = c.email_verified === true || c.email_verified === 'true';
  return {
    sub: c.sub,
    email: c.email,
    email_verified: verified,
    name: typeof c.name === 'string' ? c.name : undefined,
    picture: typeof c.picture === 'string' ? c.picture : undefined,
    nonce: c.nonce as string,
  };
}
