import { createMiddleware } from 'hono/factory';
import type { AppEnv } from './env';
import { forbidden, unauthorized } from './http';
import { loadSession, readSessionCookie, clearSessionCookie } from './auth/session';
import { timingSafeEqual } from './crypto';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Stamps a single "now" on the request so every computation in it agrees on the current instant. */
export const clock = createMiddleware<AppEnv>(async (c, next) => {
  c.set('now', Date.now());
  await next();
});

export const securityHeaders = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'same-origin');
  c.header('X-Frame-Options', 'DENY');
  if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
});

/** Requires a valid session; loads the user into context. */
export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  const token = readSessionCookie(c);
  if (!token) throw unauthorized();
  const loaded = await loadSession(c.env, token, c.get('now'));
  if (!loaded) {
    clearSessionCookie(c);
    throw unauthorized();
  }
  c.set('user', loaded.user);
  c.set('session', loaded.session);
  await next();
});

/** Origins allowed to send mutating requests: the request's own origin, plus APP_ORIGIN. */
export function isAllowedOrigin(origin: string, requestUrl: string, appOrigin: string | undefined): boolean {
  if (origin === new URL(requestUrl).origin) return true;
  return !!appOrigin && origin === appOrigin;
}

/**
 * CSRF protection for mutating requests: a per-session token in the X-CSRF-Token header
 * (the cookie alone is not enough), plus an Origin check as defence in depth.
 */
export const requireCsrf = createMiddleware<AppEnv>(async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();
  const origin = c.req.header('origin');
  if (origin && !isAllowedOrigin(origin, c.req.url, c.env.APP_ORIGIN)) throw forbidden('Cross-origin request blocked');
  const sent = c.req.header('x-csrf-token') ?? '';
  if (!sent || !timingSafeEqual(sent, c.get('session').csrfToken)) throw forbidden('Missing or invalid CSRF token');
  await next();
});
