import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { UserRow } from '../db';
import type { AppEnv, Env, SessionInfo } from '../env';
import { hmacHex, randomToken } from '../crypto';

export const SESSION_COOKIE = 'cw_session';
export const SESSION_TTL_MS = 30 * 86_400_000;
const RENEW_WHEN_REMAINING_MS = 15 * 86_400_000;

export function hashSessionToken(env: Env, token: string): Promise<string> {
  return hmacHex(env.SESSION_SECRET, `session:${token}`);
}

export async function createSession(
  env: Env,
  userId: string,
  userAgent: string | null,
  now: number,
): Promise<{ token: string; csrfToken: string; expiresAt: number }> {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const expiresAt = now + SESSION_TTL_MS;
  await env.DB.prepare(
    `INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, expires_at, last_seen_at, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(await hashSessionToken(env, token), userId, csrfToken, now, expiresAt, now, userAgent?.slice(0, 200) ?? null)
    .run();
  return { token, csrfToken, expiresAt };
}

export async function loadSession(
  env: Env,
  token: string,
  now: number,
): Promise<{ user: UserRow; session: SessionInfo } | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const tokenHash = await hashSessionToken(env, token);
  const row = await env.DB.prepare(
    `SELECT s.csrf_token, s.expires_at, u.*
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
  )
    .bind(tokenHash)
    .first<UserRow & { csrf_token: string; expires_at: number }>();
  if (!row) return null;
  if (row.expires_at <= now) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    return null;
  }
  let expiresAt = row.expires_at;
  if (expiresAt - now < RENEW_WHEN_REMAINING_MS) {
    expiresAt = now + SESSION_TTL_MS;
    await env.DB.prepare('UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE token_hash = ?')
      .bind(expiresAt, now, tokenHash)
      .run();
  }
  const { csrf_token, expires_at: _e, ...user } = row;
  return { user: user as UserRow, session: { tokenHash, csrfToken: csrf_token, expiresAt } };
}

export function setSessionCookie(c: Context<AppEnv>, token: string, expiresAt: number): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    expires: new Date(expiresAt),
  });
}

export function clearSessionCookie(c: Context<AppEnv>): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true, httpOnly: true, sameSite: 'Lax' });
}

export function readSessionCookie(c: Context<AppEnv>): string | undefined {
  return getCookie(c, SESSION_COOKIE);
}

export async function deleteUserSessions(env: Env, userId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
}
