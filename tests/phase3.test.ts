import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../server/env';
import { toCsv } from '../server/routes/export';
import { open, seal } from '../server/secretbox';
import { clearTokenCache, eventBody, reconcileCalendars, rrule, syncTodo } from '../server/services/gcal';
import type { TodoRow } from '../server/db';
import { localDate } from '../shared/time';
import { b64urlEncode } from '../shared/webpush';
import { createEnv, insertUser, makeApp, pair, type Client } from './helpers/app';

let env: Env;
let h: ReturnType<typeof makeApp>;
let alice: Client;
let bob: Client;
let eve: Client;

const KEY = b64urlEncode(new Uint8Array(32).fill(7));
const today = () => localDate(Date.now(), 'Asia/Kolkata');
const json = async <T = any>(r: Response | Promise<Response>): Promise<T> => (await r).json() as Promise<T>;

async function todo(c: Client, body: Record<string, unknown>) {
  const res = await c.send('POST', '/api/todos', { category: 'personal', startDate: today(), ...body });
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json<any>()).todo as { id: string };
}
async function itemOf(c: Client, title: string) {
  return (await json(c.get('/api/today'))).items.find((i: any) => i.title === title);
}

beforeEach(async () => {
  env = createEnv({ CALENDAR_TOKEN_KEY: KEY });
  h = makeApp(env);
  const a = await insertUser(env, 'alice@example.test');
  const b = await insertUser(env, 'bob@example.test');
  const e = await insertUser(env, 'eve@example.test');
  await pair(env, a, b);
  alice = await h.login(a);
  bob = await h.login(b);
  eve = await h.login(e);
  clearTokenCache();
});

afterEach(() => vi.unstubAllGlobals());

describe('refresh tokens at rest', () => {
  it('round-trips, is bound to the user, and never stores plaintext', async () => {
    const sealed = await seal(KEY, '1//refresh-token-value', 'user-a');
    expect(sealed).not.toContain('refresh');
    expect(await open(KEY, sealed, 'user-a')).toBe('1//refresh-token-value');
    await expect(open(KEY, sealed, 'user-b')).rejects.toThrow();
    await expect(open(b64urlEncode(new Uint8Array(32).fill(8)), sealed, 'user-a')).rejects.toThrow();
    await expect(seal(undefined, 'x', 'u')).rejects.toThrow(/CALENDAR_TOKEN_KEY/);
  });
});

describe('Google Calendar mapping', () => {
  const base = { recurrence: 'none', recurrence_weekdays: null, recurrence_month_day: null, end_date: null } as const;
  it('builds RRULEs that match the app, including month-end clamping', () => {
    expect(rrule({ ...base })).toBeNull();
    expect(rrule({ ...base, recurrence: 'daily' })).toBe('RRULE:FREQ=DAILY');
    expect(rrule({ ...base, recurrence: 'weekly', recurrence_weekdays: '1,3,5' })).toBe('RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR');
    expect(rrule({ ...base, recurrence: 'monthly', recurrence_month_day: 5 })).toBe('RRULE:FREQ=MONTHLY;BYMONTHDAY=5');
    expect(rrule({ ...base, recurrence: 'monthly', recurrence_month_day: 31 })).toBe('RRULE:FREQ=MONTHLY;BYMONTHDAY=28,29,30,31;BYSETPOS=-1');
    expect(rrule({ ...base, recurrence: 'daily', end_date: '2026-12-31' })).toBe('RRULE:FREQ=DAILY;UNTIL=20261231T235959Z');
  });

  it('only todos with a due time become events; 30 minutes, in the owner time zone', () => {
    const t = { id: 'x', title: 'Dinner', notes: '', start_date: '2026-10-07', due_time: '23:45', ...base } as unknown as TodoRow;
    const e = eventBody(t, 'Asia/Kolkata', false)!;
    expect(e.start).toEqual({ dateTime: '2026-10-07T23:45:00', timeZone: 'Asia/Kolkata' });
    expect(e.end).toEqual({ dateTime: '2026-10-08T00:15:00', timeZone: 'Asia/Kolkata' });
    expect(eventBody(t, 'Asia/Kolkata', true)!.summary).toBe('✓ Dinner');
    expect(eventBody({ ...t, due_time: null } as TodoRow, 'UTC', false)).toBeNull();
  });
});

describe('Google Calendar sync (Google faked)', () => {
  let calls: { method: string; url: string; body?: any }[];
  let nextId = 0;

  async function connect(c: Client) {
    await env.DB.prepare(
      `INSERT INTO calendar_links (user_id, google_sub, calendar_id, refresh_token_enc, scope, created_at, updated_at)
       VALUES (?, 'sub', ?, ?, 'scope', 0, 0)`,
    )
      .bind(c.user.id, `cal-${c.user.email}`, await seal(KEY, `refresh-${c.user.id}`, c.user.id))
      .run();
  }

  beforeEach(async () => {
    calls = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.startsWith('https://oauth2.googleapis.com/token')) return Response.json({ access_token: 'at', expires_in: 3600 });
      const isJson = String((init?.headers as Record<string, string> | undefined)?.['content-type'] ?? '').includes('json');
      const body = init?.body && isJson ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      if (method === 'POST') return Response.json({ id: `ev${++nextId}` });
      if (method === 'DELETE') return new Response(null, { status: 204 });
      return Response.json({ id: url.split('/').pop() });
    });
    await connect(alice);
    await connect(bob);
  });

  const calOf = (c: Client) => encodeURIComponent(`cal-${c.user.email}`);
  const hits = (c: Client, method: string) => calls.filter((x) => x.method === method && x.url.includes(`/calendars/${calOf(c)}/`));

  it("puts private todos only in the owner's calendar, shared ones in both", async () => {
    const p = await todo(alice, { title: 'Therapy', isPrivate: true, dueTime: '18:00' });
    const s = await todo(alice, { title: 'Dinner date', isShared: true, dueTime: '20:00' });
    // The routes already sync in the background; a second, concurrent sync must not duplicate events.
    await syncTodo(env, p.id);
    await syncTodo(env, s.id);
    await vi.waitFor(() => expect(hits(alice, 'POST').map((x) => x.body.summary).sort()).toEqual(['Dinner date', 'Therapy']));
    await vi.waitFor(() => expect(hits(bob, 'POST').map((x) => x.body.summary)).toEqual(['Dinner date']));
    await new Promise((r) => setTimeout(r, 50));
    expect(hits(alice, 'POST')).toHaveLength(2);
  });

  it("removes the partner's copy when a todo stops being shared, and marks completion", async () => {
    const s = await todo(alice, { title: 'Plan trip', isShared: true, dueTime: '10:00' });
    await syncTodo(env, s.id);
    await vi.waitFor(() => expect(hits(bob, 'POST')).toHaveLength(1));
    await alice.send('PATCH', `/api/todos/${s.id}`, { isShared: false });
    await vi.waitFor(() => expect(hits(bob, 'DELETE')).toHaveLength(1));

    const it0 = await itemOf(alice, 'Plan trip');
    await alice.send('POST', `/api/instances/${it0.instanceId}/complete`, {});
    await vi.waitFor(() => expect(hits(alice, 'PUT').at(-1)?.body.summary).toBe('✓ Plan trip'));
    expect(hits(alice, 'POST')).toHaveLength(1);
  });

  it('skips todos without a due time and deletes events when the todo is deleted', async () => {
    const t = await todo(alice, { title: 'Whenever' });
    await syncTodo(env, t.id);
    expect(calls).toHaveLength(0);
    const d = await todo(alice, { title: 'Dentist', dueTime: '09:30' });
    await syncTodo(env, d.id);
    await vi.waitFor(() => expect(hits(alice, 'POST')).toHaveLength(1));
    calls = [];
    expect((await alice.send('DELETE', `/api/todos/${d.id}`)).status).toBe(200);
    await vi.waitFor(() => expect(hits(alice, 'DELETE')).toHaveLength(1));
  });

  it('reconcile cleans up partner copies after unpairing', async () => {
    const s = await todo(alice, { title: 'Wedding prep', isShared: true, dueTime: '11:00' });
    await syncTodo(env, s.id);
    await vi.waitFor(() => expect(hits(bob, 'POST')).toHaveLength(1));
    await env.DB.prepare('UPDATE users SET partner_id = NULL').run(); // unpaired behind the app's back
    expect(await reconcileCalendars(env)).toBe(1);
    expect(hits(bob, 'DELETE')).toHaveLength(1);
    const left = await env.DB.prepare('SELECT user_id FROM calendar_events').all<{ user_id: string }>();
    expect(left.results.map((r) => r.user_id)).toEqual([alice.user.id]);
  });

  it('status and disconnect are per user; disconnect forgets the token', async () => {
    expect((await json(alice.get('/api/calendar/status'))).connected).toBe(true);
    expect((await json(eve.get('/api/calendar/status'))).connected).toBe(false);
    expect((await alice.send('POST', '/api/calendar/disconnect')).status).toBe(200);
    expect((await json(alice.get('/api/calendar/status'))).connected).toBe(false);
    expect(calls.some((x) => x.url.startsWith('https://oauth2.googleapis.com/revoke'))).toBe(true);
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM calendar_links WHERE user_id = ?').bind(alice.user.id).first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
});

describe('time tracking', () => {
  it('runs one timer per user, survives reloads, and stops', async () => {
    const a = await todo(alice, { title: 'Write post' });
    const b = await todo(alice, { title: 'Review PR' });
    expect((await alice.send('POST', `/api/todos/${a.id}/timer/start`)).status).toBe(201);
    expect((await json(alice.get('/api/timer'))).timer.todoTitle).toBe('Write post');
    expect((await json(alice.get('/api/me'))).runningTimer.todoTitle).toBe('Write post');
    await alice.send('POST', `/api/todos/${b.id}/timer/start`);
    const running = await env.DB.prepare('SELECT COUNT(*) AS n FROM time_entries WHERE ended_at IS NULL').first<{ n: number }>();
    expect(running?.n).toBe(1);
    expect((await json(alice.get('/api/timer'))).timer.todoTitle).toBe('Review PR');
    expect((await alice.send('POST', '/api/timer/stop')).status).toBe(200);
    expect((await json(alice.get('/api/timer'))).timer).toBeNull();
    expect((await alice.send('POST', '/api/timer/stop')).status).toBe(404);
  });

  it('manual entries, edits and totals; the weekly review counts them', async () => {
    const a = await todo(alice, { title: 'Deep work' });
    const now = Date.now();
    const { id } = await json(alice.send('POST', `/api/todos/${a.id}/time`, { startedAt: now - 90 * 60_000, endedAt: now - 30 * 60_000, note: 'focus' }));
    expect((await json(alice.get(`/api/todos/${a.id}/time`))).totalMinutes).toBe(60);
    expect((await alice.send('PATCH', `/api/time-entries/${id}`, { endedAt: now - 60 * 60_000 })).status).toBe(200);
    expect((await json(alice.get(`/api/todos/${a.id}/time`))).totalMinutes).toBe(30);
    expect((await alice.send('POST', `/api/todos/${a.id}/time`, { startedAt: now, endedAt: now - 1 })).status).toBe(400);
    expect((await alice.send('POST', `/api/todos/${a.id}/time`, { startedAt: now - 30 * 3600_000, endedAt: now })).status).toBe(400);
    const review = await json(alice.get('/api/review'));
    expect(review.me.minutesTotal).toBe(30);
    expect((await bob.send('PATCH', `/api/time-entries/${id}`, { note: 'x' })).status).toBe(404);
    expect((await bob.send('DELETE', `/api/time-entries/${id}`)).status).toBe(404);
  });

  it("partners can't time your todos, and never see time on private ones", async () => {
    const mine = await todo(alice, { title: 'Mine' });
    const ours = await todo(alice, { title: 'Ours', isShared: true });
    const secret = await todo(alice, { title: 'Secret', isPrivate: true });
    expect((await bob.send('POST', `/api/todos/${mine.id}/timer/start`)).status).toBe(404);
    expect((await bob.send('POST', `/api/todos/${ours.id}/timer/start`)).status).toBe(201);
    await alice.send('POST', `/api/todos/${secret.id}/time`, { startedAt: Date.now() - 3600_000, endedAt: Date.now() - 60_000 });
    expect((await bob.get(`/api/todos/${secret.id}/time`)).status).toBe(404);
    expect((await json(bob.get('/api/review'))).partner.minutesTotal).toBe(0);
    expect((await eve.get(`/api/todos/${ours.id}/time`)).status).toBe(404);
  });
});

describe('data export', () => {
  it("JSON has my data plus shared items, never the partner's own", async () => {
    await todo(alice, { title: 'Mine' });
    await todo(alice, { title: 'Ours', isShared: true });
    await todo(bob, { title: "Bob's shared", isShared: true });
    await todo(bob, { title: "Bob's own" });
    const res = await alice.get('/api/export/json');
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="cowork-export-/);
    const data = await res.json<any>();
    expect(data.todos.map((t: any) => t.title).sort()).toEqual(["Bob's shared", 'Mine', 'Ours']);
    expect(data.instances.length).toBe(3);
  });

  it('CSV exports todos and completions', async () => {
    await todo(alice, { title: '=SUM(A1) "quoted", title' });
    const it0 = await itemOf(alice, '=SUM(A1) "quoted", title');
    await alice.send('POST', `/api/instances/${it0.instanceId}/complete`, {});
    const todosCsv = await (await alice.get('/api/export/todos.csv')).text();
    expect(todosCsv.split('\r\n')[0]).toContain('id,title,notes');
    expect(todosCsv).toContain(`"'=SUM(A1) ""quoted"", title"`);
    const done = await (await alice.get('/api/export/completions.csv')).text();
    expect(done.split('\r\n')[1]).toMatch(/,done,/);
    expect((await eve.get('/api/export/completions.csv')).status).toBe(200);
    expect((await (await eve.get('/api/export/completions.csv')).text()).trim().split('\r\n')).toHaveLength(1);
  });

  it('toCsv escapes and defuses formulas', () => {
    expect(toCsv(['a', 'b'], [['x,y', '+1'], [null, 'line\nbreak']])).toBe('a,b\r\n"x,y",\'+1\r\n,"line\nbreak"\r\n');
  });

  it('requires a session', async () => {
    expect((await h.request('/api/export/json')).status).toBe(401);
  });
});

describe('schema guard', () => {
  it('migration 0004 adds no offline tables (offline support is out of scope for now)', async () => {
    const t = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE name = 'idempotency_keys'`).first();
    expect(t).toBeNull();
  });
});
