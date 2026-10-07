import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from '../env';
import { buildAuthUrl, exchangeCode, fetchGoogleJwks, verifyIdToken } from '../auth/google';
import { clearSessionCookie, createSession, setSessionCookie } from '../auth/session';
import { b64urlDecode, b64urlEncode, pkceChallenge, randomToken, sign, unsign } from '../crypto';
import { requireCsrf, requireSession } from '../middleware';
import { signInUser } from '../services/users';

const OAUTH_COOKIE = 'cw_oauth';
const OAUTH_TTL_MS = 10 * 60_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

/** Only same-site relative paths are allowed as post-login destinations (no open redirects). */
export function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\') || next.startsWith('/api/')) {
    return '/today';
  }
  return next.slice(0, 200);
}

interface OAuthState {
  s: string; // state
  v: string; // PKCE verifier
  n: string; // nonce
  x: number; // expiry
  r: string; // post-login path
}

export const authRoutes = new Hono<AppEnv>();

authRoutes.get('/google/start', async (c) => {
  if (!c.env.GOOGLE_CLIENT_ID) return c.text('Google sign-in is not configured', 500);
  const st: OAuthState = {
    s: randomToken(16),
    v: randomToken(48),
    n: randomToken(16),
    x: c.get('now') + OAUTH_TTL_MS,
    r: safeNext(c.req.query('next')),
  };
  const value = await sign(c.env.SESSION_SECRET, b64urlEncode(enc.encode(JSON.stringify(st))));
  setCookie(c, OAUTH_COOKIE, value, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/api/auth',
    maxAge: OAUTH_TTL_MS / 1000,
  });
  const origin = new URL(c.req.url).origin;
  return c.redirect(
    buildAuthUrl({
      clientId: c.env.GOOGLE_CLIENT_ID,
      redirectUri: `${origin}/api/auth/google/callback`,
      state: st.s,
      nonce: st.n,
      codeChallenge: await pkceChallenge(st.v),
    }),
  );
});

authRoutes.get('/google/callback', async (c) => {
  const fail = (reason: string) => c.redirect(`/?error=${encodeURIComponent(reason)}`);
  if (c.req.query('error')) return fail('cancelled');

  const raw = getCookie(c, OAUTH_COOKIE);
  deleteCookie(c, OAUTH_COOKIE, { path: '/api/auth', secure: true, httpOnly: true, sameSite: 'Lax' });
  const unsigned = raw ? await unsign(c.env.SESSION_SECRET, raw) : null;
  if (!unsigned) return fail('expired');
  let st: OAuthState;
  try {
    st = JSON.parse(dec.decode(b64urlDecode(unsigned))) as OAuthState;
  } catch {
    return fail('expired');
  }
  const code = c.req.query('code');
  if (!code || c.req.query('state') !== st.s || st.x < c.get('now')) return fail('expired');

  const origin = new URL(c.req.url).origin;
  let claims;
  try {
    const idToken = await exchangeCode({
      code,
      clientId: c.env.GOOGLE_CLIENT_ID,
      clientSecret: c.env.GOOGLE_CLIENT_SECRET,
      redirectUri: `${origin}/api/auth/google/callback`,
      codeVerifier: st.v,
    });
    claims = await verifyIdToken(idToken, {
      clientId: c.env.GOOGLE_CLIENT_ID,
      nonce: st.n,
      now: c.get('now'),
      getKeys: (force) => fetchGoogleJwks(fetch, Date.now(), force),
    });
  } catch (e) {
    console.warn('google sign-in failed', e instanceof Error ? e.message : e);
    return fail('google');
  }
  if (!claims.email_verified) return c.redirect('/not-invited?reason=unverified');

  const user = await signInUser(
    c.env,
    { email: claims.email, emailVerified: claims.email_verified, sub: claims.sub, name: claims.name, picture: claims.picture },
    c.get('now'),
  );
  if (!user) return c.redirect('/not-invited');

  const s = await createSession(c.env, user.id, c.req.header('user-agent') ?? null, c.get('now'));
  setSessionCookie(c, s.token, s.expiresAt);
  return c.redirect(st.r);
});

/**
 * Local development only: sign in as an (invited) email without Google.
 * Requires DEV_LOGIN=true in .dev.vars AND a localhost request URL, so it can never work in production.
 */
authRoutes.get('/dev-login', async (c) => {
  const host = new URL(c.req.url).hostname;
  if (c.env.DEV_LOGIN !== 'true' || (host !== 'localhost' && host !== '127.0.0.1')) return c.notFound();
  const email = c.req.query('email') ?? '';
  const user = await signInUser(c.env, { email, emailVerified: true, sub: null, name: email.split('@')[0] }, c.get('now'));
  if (!user) return c.redirect('/not-invited');
  const s = await createSession(c.env, user.id, 'dev-login', c.get('now'));
  setSessionCookie(c, s.token, s.expiresAt);
  return c.redirect(safeNext(c.req.query('next')));
});

authRoutes.post('/logout', requireSession, requireCsrf, async (c) => {
  await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(c.get('session').tokenHash).run();
  clearSessionCookie(c);
  return c.json({ ok: true });
});
