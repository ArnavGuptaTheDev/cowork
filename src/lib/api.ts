// Browser API client. Every mutating call carries the session's CSRF token.
import type { Me } from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

let mePromise: Promise<Me> | null = null;

function goToLogin(): never {
  const next = location.pathname + location.search;
  location.href = `/?next=${encodeURIComponent(next)}`;
  throw new ApiError(401, 'Signed out');
}

async function parse<T>(res: Response): Promise<T> {
  if (res.status === 401) goToLogin();
  const data = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok) throw new ApiError(res.status, data.message ?? `Request failed (${res.status})`);
  return data as T;
}

/** Current user (cached for the page). Redirects to sign-in when there is no session. */
export function getMe(refresh = false): Promise<Me> {
  if (!mePromise || refresh) {
    mePromise = fetch('/api/me', { credentials: 'same-origin' }).then((r) => parse<Me>(r));
    mePromise.catch(() => (mePromise = null));
  }
  return mePromise;
}

export async function get<T>(path: string): Promise<T> {
  return parse<T>(await fetch(path, { credentials: 'same-origin' }));
}

export async function send<T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const me = await getMe();
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-csrf-token': me.csrfToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return parse<T>(res);
}

export async function upload<T>(path: string, form: FormData): Promise<T> {
  const me = await getMe();
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'x-csrf-token': me.csrfToken },
    body: form,
  });
  return parse<T>(res);
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong';
}
