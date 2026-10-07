// Test harness: an app instance bound to an in-memory D1/R2, plus helpers to create users and sessions.
import { createApp } from '../../server/app';
import { createSession } from '../../server/auth/session';
import type { UserRow } from '../../server/db';
import type { Env } from '../../server/env';
import { createTestD1, createTestR2 } from './d1';

export const ADMIN_EMAIL = 'admin@example.test';

export function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: createTestD1(),
    PHOTOS: createTestR2(),
    GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-secret',
    SESSION_SECRET: 'test-session-secret-that-is-at-least-32-chars',
    VAPID_PUBLIC_KEY: '',
    VAPID_PRIVATE_KEY: '',
    SUPER_ADMIN_EMAIL: ADMIN_EMAIL,
    APP_ORIGIN: 'https://cowork.test',
    ...overrides,
  };
}

export async function insertUser(env: Env, email: string, opts: Partial<UserRow> = {}): Promise<UserRow> {
  const u: UserRow = {
    id: crypto.randomUUID(),
    email,
    google_sub: null,
    name: email.split('@')[0]!,
    avatar_url: null,
    timezone: 'Asia/Kolkata',
    partner_id: null,
    paired_at: null,
    created_at: Date.now(),
    last_login_at: null,
    ...opts,
  };
  await env.DB.prepare(
    'INSERT INTO users (id, email, name, timezone, created_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(u.id, u.email, u.name, u.timezone, u.created_at)
    .run();
  return u;
}

export async function pair(env: Env, a: UserRow, b: UserRow): Promise<void> {
  await env.DB.prepare('UPDATE users SET partner_id = ? WHERE id = ?').bind(b.id, a.id).run();
  await env.DB.prepare('UPDATE users SET partner_id = ? WHERE id = ?').bind(a.id, b.id).run();
  a.partner_id = b.id;
  b.partner_id = a.id;
}

export interface Client {
  user: UserRow;
  csrf: string;
  get(path: string): Promise<Response>;
  send(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<Response>;
  raw(path: string, init: RequestInit): Promise<Response>;
}

const ORIGIN = 'https://cowork.test';

export function makeApp(env: Env) {
  const app = createApp();
  const request = async (path: string, init: RequestInit = {}): Promise<Response> => app.request(`${ORIGIN}${path}`, init, env);

  async function login(user: UserRow): Promise<Client> {
    const s = await createSession(env, user.id, 'vitest', Date.now());
    const cookie = `cw_session=${s.token}`;
    const raw = (path: string, init: RequestInit) =>
      request(path, { ...init, headers: { cookie, ...(init.headers as Record<string, string>) } });
    return {
      user,
      csrf: s.csrfToken,
      get: (path) => raw(path, {}),
      send: (method, path, body, extraHeaders = {}) =>
        raw(path, {
          method,
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': s.csrfToken,
            origin: ORIGIN,
            ...extraHeaders,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      raw,
    };
  }
  return { app, request, login };
}
