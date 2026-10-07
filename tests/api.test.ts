import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../server/env';
import { signInUser } from '../server/services/users';
import { localDate, addDays } from '../shared/time';
import { ADMIN_EMAIL, createEnv, insertUser, makeApp, pair, type Client } from './helpers/app';

let env: Env;
let h: ReturnType<typeof makeApp>;
let alice: Client;
let bob: Client;
let eve: Client;

const today = () => localDate(Date.now(), 'Asia/Kolkata');

async function json<T = any>(res: Response | Promise<Response>): Promise<T> {
  return (await res).json() as Promise<T>;
}

async function createTodo(c: Client, body: Record<string, unknown>) {
  const res = await c.send('POST', '/api/todos', { category: 'personal', startDate: today(), ...body });
  expect(res.status).toBe(201);
  return (await res.json<any>()).todo as { id: string };
}

beforeEach(async () => {
  env = createEnv();
  h = makeApp(env);
  const a = await insertUser(env, 'alice@example.test');
  const b = await insertUser(env, 'bob@example.test');
  const e = await insertUser(env, 'eve@example.test');
  await pair(env, a, b);
  alice = await h.login(a);
  bob = await h.login(b);
  eve = await h.login(e);
});

describe('authentication', () => {
  it('rejects requests without a session', async () => {
    expect((await h.request('/api/today')).status).toBe(401);
    expect((await h.request('/api/me')).status).toBe(401);
  });

  it('rejects a forged session cookie', async () => {
    const res = await h.request('/api/me', { headers: { cookie: 'cw_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } });
    expect(res.status).toBe(401);
  });

  it('stores only a hash of the session token', async () => {
    const rows = (await env.DB.prepare('SELECT token_hash FROM sessions').all<{ token_hash: string }>()).results;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('logout invalidates the session', async () => {
    expect((await alice.send('POST', '/api/auth/logout')).status).toBe(200);
    expect((await alice.get('/api/me')).status).toBe(401);
  });
});

describe('sign-in allow-list', () => {
  it('an uninvited email is rejected and no account is created', async () => {
    const user = await signInUser(env, { email: 'stranger@example.test', emailVerified: true, sub: 's1' }, Date.now());
    expect(user).toBeNull();
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE email = ?').bind('stranger@example.test').first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it('the super admin can sign in without an invite', async () => {
    const user = await signInUser(env, { email: ADMIN_EMAIL.toUpperCase(), emailVerified: true, sub: 'admin-sub' }, Date.now());
    expect(user?.email).toBe(ADMIN_EMAIL);
  });

  it('an unverified email is rejected even when invited', async () => {
    await env.DB.prepare('INSERT INTO invites (email, created_at) VALUES (?, ?)').bind('new@example.test', 1).run();
    expect(await signInUser(env, { email: 'new@example.test', emailVerified: false, sub: 'n' }, Date.now())).toBeNull();
  });

  it('invite -> sign in -> revoke -> signed out and rejected', async () => {
    const adminUser = (await signInUser(env, { email: ADMIN_EMAIL, emailVerified: true, sub: 'admin-sub' }, Date.now()))!;
    const admin = await h.login(adminUser);
    expect((await admin.send('POST', '/api/admin/invites', { email: 'New@Example.test' })).status).toBe(201);
    const newbie = await signInUser(env, { email: 'new@example.test', emailVerified: true, sub: 'n1' }, Date.now());
    expect(newbie).not.toBeNull();
    const newbieClient = await h.login(newbie!);
    expect((await newbieClient.get('/api/me')).status).toBe(200);

    expect((await admin.send('DELETE', `/api/admin/invites/${encodeURIComponent('new@example.test')}`)).status).toBe(200);
    expect((await newbieClient.get('/api/me')).status).toBe(401);
    expect(await signInUser(env, { email: 'new@example.test', emailVerified: true, sub: 'n1' }, Date.now())).toBeNull();
  });

  it('non-admins cannot use the admin API', async () => {
    expect((await alice.get('/api/admin/invites')).status).toBe(403);
    expect((await alice.send('POST', '/api/admin/invites', { email: 'x@example.test' })).status).toBe(403);
  });

  it('a different Google account cannot take over an existing email', async () => {
    await env.DB.prepare('INSERT INTO invites (email, created_at) VALUES (?, ?)').bind('carol@example.test', 1).run();
    expect(await signInUser(env, { email: 'carol@example.test', emailVerified: true, sub: 'g-1' }, Date.now())).not.toBeNull();
    expect(await signInUser(env, { email: 'carol@example.test', emailVerified: true, sub: 'g-2' }, Date.now())).toBeNull();
  });
});

describe('CSRF', () => {
  it('rejects mutations without the CSRF header', async () => {
    const res = await alice.send('POST', '/api/todos', { title: 'x', category: 'work', startDate: today() }, { 'x-csrf-token': '' });
    expect(res.status).toBe(403);
  });

  it("rejects another session's CSRF token", async () => {
    const res = await alice.send('POST', '/api/todos', { title: 'x', category: 'work', startDate: today() }, { 'x-csrf-token': bob.csrf });
    expect(res.status).toBe(403);
  });

  it('rejects cross-origin mutations', async () => {
    const res = await alice.send('POST', '/api/todos', { title: 'x', category: 'work', startDate: today() }, { origin: 'https://evil.test' });
    expect(res.status).toBe(403);
  });
});

describe('validation', () => {
  it('rejects bad input with a 400', async () => {
    const res = await alice.send('POST', '/api/todos', { title: '', category: 'party', startDate: '2026-02-30' });
    expect(res.status).toBe(400);
    const res2 = await alice.send('POST', '/api/todos', { title: 'x', category: 'work', startDate: today(), evil: true });
    expect(res2.status).toBe(400);
  });
});

describe('partner visibility', () => {
  it("partner sees shared todos but not private ones; a non-partner sees nothing", async () => {
    await createTodo(alice, { title: 'Ship the side project' });
    await createTodo(alice, { title: 'Surprise gift', isPrivate: true });

    const own = await json(alice.get('/api/today'));
    expect(own.items.map((i: any) => i.title).sort()).toEqual(['Ship the side project', 'Surprise gift']);

    const asPartner = await json(bob.get('/api/today?who=partner'));
    expect(asPartner.items.map((i: any) => i.title)).toEqual(['Ship the side project']);

    expect((await eve.get('/api/today?who=partner')).status).toBe(403);
  });

  it('private projects hide all their todos and the project itself', async () => {
    const proj = await json(alice.send('POST', '/api/projects', { name: 'Anniversary', category: 'personal', isPrivate: true }));
    await createTodo(alice, { title: 'Book the table', projectId: proj.project.id });
    expect((await json(bob.get('/api/today?who=partner'))).items).toEqual([]);
    expect((await json(bob.get('/api/projects?who=partner'))).projects).toEqual([]);
    expect((await bob.get(`/api/projects/${proj.project.id}?who=partner`)).status).toBe(404);
  });

  it('todo detail: partner can read shared, not private; non-partner gets 404', async () => {
    const shared = await createTodo(alice, { title: 'Gym' });
    const priv = await createTodo(alice, { title: 'Secret' , isPrivate: true });
    expect((await bob.get(`/api/todos/${shared.id}`)).status).toBe(200);
    expect((await bob.get(`/api/todos/${priv.id}`)).status).toBe(404);
    expect((await eve.get(`/api/todos/${shared.id}`)).status).toBe(404);
  });

  it('partners are read-only', async () => {
    const t = await createTodo(alice, { title: 'Mine' });
    expect((await bob.send('PATCH', `/api/todos/${t.id}`, { title: 'Hijacked' })).status).toBe(404);
    expect((await bob.send('DELETE', `/api/todos/${t.id}`)).status).toBe(404);
    const day = await json(alice.get('/api/today'));
    expect((await bob.send('POST', `/api/instances/${day.items[0].instanceId}/complete`, {})).status).toBe(404);
  });

  it('range and habits views also hide private items from the partner', async () => {
    await createTodo(alice, { title: 'Run', category: 'habit', recurrence: { type: 'daily' } });
    await createTodo(alice, { title: 'Journal', category: 'habit', recurrence: { type: 'daily' }, isPrivate: true });
    const habits = await json(bob.get('/api/habits?who=partner'));
    expect(habits.habits.map((x: any) => x.title)).toEqual(['Run']);
    const range = await json(bob.get(`/api/range?who=partner&from=${today()}&to=${addDays(today(), 6)}`));
    const titles = new Set(range.days.flatMap((d: any) => d.items.map((i: any) => i.title)));
    expect([...titles]).toEqual(['Run']);
  });
});

describe('today, carry-over and missed', () => {
  it('uncompleted one-off todos carry over; missed recurring ones do not', async () => {
    const yesterday = addDays(today(), -1);
    const oneOff = await createTodo(alice, { title: 'Post project on LinkedIn', startDate: yesterday });
    const daily = await createTodo(alice, { title: 'Stretch', category: 'habit', recurrence: { type: 'daily' }, startDate: yesterday });
    // Simulate a recurring instance from yesterday that was never done.
    await env.DB.prepare(
      `INSERT INTO todo_instances (id, todo_id, user_id, date, status, created_at) VALUES (?, ?, ?, ?, 'pending', 0)`,
    ).bind(crypto.randomUUID(), daily.id, alice.user.id, yesterday).run();

    const view = await json(alice.get('/api/today'));
    const byTitle = Object.fromEntries(view.items.map((i: any) => [i.title, i]));
    expect(byTitle['Post project on LinkedIn'].carriedOverFrom).toBe(yesterday);
    expect(byTitle['Stretch'].date).toBe(today());
    expect(view.items.filter((i: any) => i.title === 'Stretch')).toHaveLength(1);

    const missed = await env.DB.prepare('SELECT status FROM todo_instances WHERE todo_id = ? AND date = ?')
      .bind(daily.id, yesterday)
      .first<{ status: string }>();
    expect(missed?.status).toBe('missed');
    expect(oneOff.id).toBeTruthy();
  });

  it('completing and un-completing an instance', async () => {
    await createTodo(alice, { title: 'Gym', recurrence: { type: 'daily' }, category: 'habit' });
    const [item] = (await json(alice.get('/api/today'))).items;
    expect((await alice.send('POST', `/api/instances/${item.instanceId}/complete`, {})).status).toBe(200);
    let v = await json(alice.get('/api/today'));
    expect(v.summary).toEqual({ done: 1, total: 1 });
    expect(v.items[0].streak).toBe(1);
    await alice.send('POST', `/api/instances/${item.instanceId}/uncomplete`, {});
    v = await json(alice.get('/api/today'));
    expect(v.summary).toEqual({ done: 0, total: 1 });
  });

  it('week view projects future recurring occurrences', async () => {
    await createTodo(alice, { title: 'Standup', category: 'work', recurrence: { type: 'daily' } });
    const r = await json(alice.get(`/api/range?from=${today()}&to=${addDays(today(), 6)}`));
    expect(r.days).toHaveLength(7);
    expect(r.days[0].items[0].status).toBe('pending');
    expect(r.days[3].items[0].status).toBe('upcoming');
  });

  it('project progress counts one-off todos', async () => {
    const p = await json(alice.send('POST', '/api/projects', { name: 'Portfolio', category: 'work' }));
    await createTodo(alice, { title: 'A', projectId: p.project.id });
    await createTodo(alice, { title: 'B', projectId: p.project.id });
    const [first] = (await json(alice.get('/api/today'))).items;
    await alice.send('POST', `/api/instances/${first.instanceId}/complete`, {});
    const view = await json(alice.get(`/api/projects/${p.project.id}`));
    expect(view.progress).toEqual({ done: 1, total: 2 });
  });

  it("cannot attach a todo to someone else's project", async () => {
    const p = await json(bob.send('POST', '/api/projects', { name: 'Bob only', category: 'work' }));
    const res = await alice.send('POST', '/api/todos', { title: 'x', category: 'work', startDate: today(), projectId: p.project.id });
    expect(res.status).toBe(400);
  });
});

describe('pairing', () => {
  it('code flow pairs two users, and either can unpair', async () => {
    await alice.send('DELETE', '/api/pairing');
    expect((await json(bob.get('/api/me'))).partner).toBeNull();

    const { code } = await json(alice.send('POST', '/api/pairing/code'));
    expect(code).toMatch(/^[A-Z0-9]{8}$/);
    expect((await alice.send('POST', '/api/pairing/accept', { code })).status).toBe(400); // own code
    expect((await bob.send('POST', '/api/pairing/accept', { code })).status).toBe(200);
    expect((await json(alice.get('/api/me'))).partner.email).toBe('bob@example.test');
    // Codes are single use, and a third person can't join.
    expect((await eve.send('POST', '/api/pairing/accept', { code })).status).toBe(400);

    await bob.send('DELETE', '/api/pairing');
    expect((await alice.get('/api/today?who=partner')).status).toBe(403);
  });

  it('expired codes are rejected', async () => {
    await alice.send('DELETE', '/api/pairing');
    const { code } = await json(alice.send('POST', '/api/pairing/code'));
    await env.DB.prepare('UPDATE pairing_codes SET expires_at = 0').run();
    expect((await bob.send('POST', '/api/pairing/accept', { code })).status).toBe(400);
  });
});

describe('suggestions', () => {
  it('accept adds the todo to the recipient marked as suggested', async () => {
    const { id } = await json(alice.send('POST', '/api/suggestions', { title: 'Call mum', category: 'personal', startDate: today() }));
    const inbox = await json(bob.get('/api/suggestions'));
    expect(inbox.incoming[0].title).toBe('Call mum');
    expect((await alice.send('POST', `/api/suggestions/${id}/accept`, {})).status).toBe(404); // only the recipient
    const { todoId } = await json(bob.send('POST', `/api/suggestions/${id}/accept`, {}));
    const detail = await json(bob.get(`/api/todos/${todoId}`));
    expect(detail.todo.suggestedBy).toBe(alice.user.id);
    expect((await bob.send('POST', `/api/suggestions/${id}/accept`, {})).status).toBe(400); // already answered
    expect((await json(alice.get('/api/suggestions'))).outgoing[0].status).toBe('accepted');
  });

  it('deny records the reason for the suggester', async () => {
    const { id } = await json(alice.send('POST', '/api/suggestions', { title: 'Run a marathon', category: 'habit', startDate: today() }));
    await bob.send('POST', `/api/suggestions/${id}/deny`, { reason: 'Knees say no' });
    const out = await json(alice.get('/api/suggestions'));
    expect(out.outgoing[0]).toMatchObject({ status: 'denied', reason: 'Knees say no' });
  });

  it('cannot suggest without a partner', async () => {
    expect((await eve.send('POST', '/api/suggestions', { title: 'x', category: 'work', startDate: today() })).status).toBe(403);
  });
});

describe('photos', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);

  async function upload(c: Client, fields: Record<string, string>, bytes: Uint8Array = jpeg) {
    const form = new FormData();
    form.set('file', new File([bytes as Uint8Array<ArrayBuffer>], 'p.jpg', { type: 'image/jpeg' }));
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    return c.raw('/api/photos', { method: 'POST', body: form, headers: { 'x-csrf-token': c.csrf, origin: 'https://cowork.test' } });
  }

  it("owner and partner can view; private todos' photos are owner-only; strangers never", async () => {
    const shared = await createTodo(alice, { title: 'Progress pic' });
    const priv = await createTodo(alice, { title: 'Private', isPrivate: true });
    const p1 = (await json(upload(alice, { todoId: shared.id }))).photo;
    const p2 = (await json(upload(alice, { todoId: priv.id }))).photo;

    expect((await alice.get(p1.url)).status).toBe(200);
    expect((await bob.get(p1.url)).status).toBe(200);
    expect((await eve.get(p1.url)).status).toBe(404);
    expect((await h.request(p1.url)).status).toBe(401);

    expect((await alice.get(p2.url)).status).toBe(200);
    expect((await bob.get(p2.url)).status).toBe(404);
  });

  it('serves the right content type and blocks non-images', async () => {
    const t = await createTodo(alice, { title: 'x' });
    const p = (await json(upload(alice, { todoId: t.id }))).photo;
    const res = await alice.get(p.url);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toContain('private');
    const bad = await upload(alice, { todoId: t.id }, new TextEncoder().encode('<svg onload=alert(1)>'));
    expect(bad.status).toBe(415);
  });

  it("cannot attach photos to someone else's todo", async () => {
    const t = await createTodo(alice, { title: 'x' });
    expect((await upload(bob, { todoId: t.id })).status).toBe(404);
  });

  it('completion photos attach to an instance', async () => {
    await createTodo(alice, { title: 'Gym', recurrence: { type: 'daily' }, category: 'habit' });
    const [item] = (await json(alice.get('/api/today'))).items;
    const res = await upload(alice, { instanceId: item.instanceId });
    expect(res.status).toBe(201);
    expect((await res.json<any>()).photo.instanceId).toBe(item.instanceId);
  });

  it('deleting a todo removes its photos from R2', async () => {
    const t = await createTodo(alice, { title: 'x' });
    await upload(alice, { todoId: t.id });
    const r2 = env.PHOTOS as unknown as { objects: Map<string, unknown> };
    expect(r2.objects.size).toBe(1);
    await alice.send('DELETE', `/api/todos/${t.id}`);
    expect(r2.objects.size).toBe(0);
  });
});

describe('push notifications', () => {
  it('records a one-time "partner finished everything" notification', async () => {
    // VAPID keys are empty in tests, so nothing is sent over the network; the dedupe log proves the trigger fired.
    await createTodo(alice, { title: 'Only task' });
    const [item] = (await json(alice.get('/api/today'))).items;
    await alice.send('POST', `/api/instances/${item.instanceId}/complete`, {});
    await vi.waitFor(async () => {
      const row = await env.DB.prepare(
        `SELECT user_id FROM notification_log WHERE kind = 'partner_all_done'`,
      ).first<{ user_id: string }>();
      expect(row?.user_id).toBe(bob.user.id);
    });
  });
});
