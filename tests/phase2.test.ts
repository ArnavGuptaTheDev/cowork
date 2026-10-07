import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../server/env';
import { runReminders } from '../server/reminders';
import { summarizeWeek } from '../server/services/review';
import { habitStats } from '../shared/streaks';
import { addDays, localDate, startOfWeek, zonedToUtc } from '../shared/time';
import { createEnv, insertUser, makeApp, pair, type Client } from './helpers/app';

let env: Env;
let h: ReturnType<typeof makeApp>;
let alice: Client;
let bob: Client;
let eve: Client;

const today = () => localDate(Date.now(), 'Asia/Kolkata');
const json = async <T = any>(r: Response | Promise<Response>): Promise<T> => (await r).json() as Promise<T>;

async function todo(c: Client, body: Record<string, unknown>) {
  const res = await c.send('POST', '/api/todos', { category: 'personal', startDate: today(), ...body });
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json<any>()).todo as { id: string };
}
async function itemOf(c: Client, title: string, who = 'me') {
  const v = await json(c.get(`/api/today?who=${who}`));
  return v.items.find((i: any) => i.title === title);
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

describe('subtasks', () => {
  it('reorder, per-occurrence ticks and progress on the parent', async () => {
    const t = await todo(alice, { title: 'Morning routine', recurrence: { type: 'daily' }, category: 'habit' });
    const a = (await json(alice.send('POST', `/api/todos/${t.id}/subtasks`, { title: 'Stretch' }))).id;
    const b = (await json(alice.send('POST', `/api/todos/${t.id}/subtasks`, { title: 'Water' }))).id;
    expect((await alice.send('POST', `/api/todos/${t.id}/subtasks/order`, { ids: [b, a] })).status).toBe(200);
    const item = await itemOf(alice, 'Morning routine');
    expect((await alice.send('POST', `/api/subtasks/${a}/check`, { instanceId: item.instanceId, done: true })).status).toBe(200);

    const list = await json(alice.get(`/api/todos/${t.id}/subtasks?instanceId=${item.instanceId}`));
    expect(list.subtasks.map((s: any) => [s.title, s.done])).toEqual([['Water', false], ['Stretch', true]]);
    expect((await itemOf(alice, 'Morning routine')).subtasks).toEqual({ done: 1, total: 2 });

    // Another occurrence of the same habit starts with a clean checklist.
    const yesterday = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO todo_instances (id, todo_id, user_id, date, status, created_at) VALUES (?, ?, ?, ?, 'done', 0)`)
      .bind(yesterday, t.id, alice.user.id, addDays(today(), -1))
      .run();
    const other = await json(alice.get(`/api/todos/${t.id}/subtasks?instanceId=${yesterday}`));
    expect(other.subtasks.every((s: any) => !s.done)).toBe(true);
  });

  it('only people who can edit the todo change subtasks; private ones stay hidden', async () => {
    const mine = await todo(alice, { title: 'Mine' });
    const ours = await todo(alice, { title: 'Ours', isShared: true });
    const secret = await todo(alice, { title: 'Secret', isPrivate: true });
    expect((await bob.send('POST', `/api/todos/${mine.id}/subtasks`, { title: 'x' })).status).toBe(404);
    expect((await bob.send('POST', `/api/todos/${ours.id}/subtasks`, { title: 'x' })).status).toBe(201);
    expect((await bob.get(`/api/todos/${secret.id}/subtasks`)).status).toBe(404);
    expect((await eve.get(`/api/todos/${ours.id}/subtasks`)).status).toBe(404);
  });

  it("won't tick a subtask against another todo's occurrence", async () => {
    const t1 = await todo(alice, { title: 'One' });
    await todo(alice, { title: 'Two' });
    const s = (await json(alice.send('POST', `/api/todos/${t1.id}/subtasks`, { title: 'x' }))).id;
    const two = await itemOf(alice, 'Two');
    expect((await alice.send('POST', `/api/subtasks/${s}/check`, { instanceId: two.instanceId, done: true })).status).toBe(400);
  });
});

describe('templates', () => {
  it('saves todos with subtasks and recurrence; the partner never sees or applies private items', async () => {
    const p = (await json(alice.send('POST', '/api/projects', { name: 'Launch', category: 'work' }))).project;
    const a = await todo(alice, { title: 'Write post', category: 'work' });
    await alice.send('POST', `/api/todos/${a.id}/subtasks`, { title: 'Draft' });
    const r = await todo(alice, { title: 'Weekly sync', category: 'work', recurrence: { type: 'weekly', weekdays: [1] } });
    const s = await todo(alice, { title: 'Secret bonus', isPrivate: true });
    const { id } = await json(alice.send('POST', '/api/templates', { name: 'Launch kit', todoIds: [a.id, r.id, s.id] }));

    const mine = (await json(alice.get('/api/templates'))).templates[0];
    expect(mine.items.map((i: any) => i.title)).toEqual(['Write post', 'Weekly sync', 'Secret bonus']);
    expect((await json(bob.get('/api/templates'))).templates).toEqual([]); // not shared yet

    await alice.send('PATCH', `/api/templates/${id}`, { isShared: true });
    const theirs = (await json(bob.get('/api/templates'))).templates[0];
    expect(theirs.items.map((i: any) => i.title)).toEqual(['Write post', 'Weekly sync']);

    const applied = await json(bob.send('POST', `/api/templates/${id}/apply`, { startDate: today() }));
    expect(applied.created).toBe(2);
    expect((await itemOf(bob, 'Secret bonus'))).toBeUndefined();

    // Owner applies into a project; subtasks and private flag come along.
    const mineApplied = await json(alice.send('POST', `/api/templates/${id}/apply`, { startDate: today(), projectId: p.id }));
    expect(mineApplied.created).toBe(3);
    const copies = (await json(alice.get(`/api/projects/${p.id}`))).todos;
    expect(copies.find((t: any) => t.title === 'Secret bonus').isPrivate).toBe(true);
    const post = copies.find((t: any) => t.title === 'Write post');
    expect((await json(alice.get(`/api/todos/${post.todoId}/subtasks`))).subtasks.map((x: any) => x.title)).toEqual(['Draft']);
  });

  it('only the owner edits or deletes; strangers see nothing', async () => {
    const a = await todo(alice, { title: 'x' });
    const { id } = await json(alice.send('POST', '/api/templates', { name: 'T', todoIds: [a.id], isShared: true }));
    expect((await bob.send('DELETE', `/api/templates/${id}`)).status).toBe(404);
    expect((await eve.send('POST', `/api/templates/${id}/apply`, { startDate: today() })).status).toBe(404);
    expect((await eve.send('POST', '/api/templates', { name: 'steal', todoIds: [a.id] })).status).toBe(404);
  });
});

describe('joint habits', () => {
  it('count for the day only when both complete', async () => {
    await todo(alice, { title: 'Walk together', category: 'habit', recurrence: { type: 'daily' }, isShared: true, isJoint: true });
    const it0 = await itemOf(alice, 'Walk together');
    expect(it0.isJoint).toBe(true);
    await alice.send('POST', `/api/instances/${it0.instanceId}/complete`, {});
    let state = await itemOf(bob, 'Walk together');
    expect(state.status).toBe('pending');
    expect(state.jointDone).toEqual([alice.user.id]);
    await bob.send('POST', `/api/instances/${it0.instanceId}/complete`, {});
    state = await itemOf(alice, 'Walk together');
    expect(state.status).toBe('done');
    expect(state.streak).toBe(1);
    await bob.send('POST', `/api/instances/${it0.instanceId}/uncomplete`, {});
    state = await itemOf(alice, 'Walk together');
    expect(state.status).toBe('pending');
    expect(state.jointDone).toEqual([alice.user.id]);
  });

  it('must be shared and repeating', async () => {
    expect((await alice.send('POST', '/api/todos', { title: 'x', category: 'habit', startDate: today(), isJoint: true, recurrence: { type: 'daily' } })).status).toBe(400);
    expect((await alice.send('POST', '/api/todos', { title: 'x', category: 'habit', startDate: today(), isJoint: true, isShared: true })).status).toBe(400);
  });
});

describe('shared goals', () => {
  it('tracks weekly progress for both partners', async () => {
    const ag = await todo(alice, { title: 'Gym (A)', category: 'habit', recurrence: { type: 'daily' } });
    const bg = await todo(bob, { title: 'Gym (B)', category: 'habit', recurrence: { type: 'daily' } });
    const { id } = await json(alice.send('POST', '/api/goals', { title: 'Gym', targetPerPerson: 4, todoId: ag.id }));
    expect((await bob.send('POST', `/api/goals/${id}/link`, { todoId: bg.id })).status).toBe(200);
    const ai = await itemOf(alice, 'Gym (A)');
    await alice.send('POST', `/api/instances/${ai.instanceId}/complete`, {});
    const goals = (await json(bob.get('/api/goals'))).goals;
    expect(goals[0].people.find((p: any) => p.userId === alice.user.id)).toMatchObject({ done: 1, todoTitle: 'Gym (A)' });
    expect(goals[0].people.find((p: any) => p.userId === bob.user.id)).toMatchObject({ done: 0 });
  });

  it("won't count a private todo, and strangers can't see goals", async () => {
    const s = await todo(alice, { title: 'Secret', isPrivate: true, recurrence: { type: 'daily' } });
    expect((await alice.send('POST', '/api/goals', { title: 'x', targetPerPerson: 2, todoId: s.id })).status).toBe(400);
    const { id } = await json(alice.send('POST', '/api/goals', { title: 'Read', targetPerPerson: 3 }));
    expect((await json(eve.get('/api/goals'))).goals).toEqual([]);
    expect((await eve.send('POST', `/api/goals/${id}/link`, { todoId: null })).status).toBe(404);
    expect((await bob.send('DELETE', `/api/goals/${id}`)).status).toBe(403);
  });
});

describe('pause mode', () => {
  it('pauses instead of missing, freezes streaks, silences nudges, and shows the partner', async () => {
    await todo(alice, { title: 'Run', category: 'habit', recurrence: { type: 'daily' } });
    await todo(alice, { title: 'Call bank' });
    const day = today();
    const { id } = await json(alice.send('POST', '/api/pauses', { startDate: day, endDate: addDays(day, 3), note: 'Holiday' }));

    const run = await itemOf(alice, 'Run');
    expect(run.status).toBe('paused');
    const v = await json(alice.get('/api/today'));
    expect(v.summary.total).toBe(1); // only the one-off counts; the paused habit doesn't
    expect((await json(bob.get('/api/me'))).partner.pausedUntil).toBe(addDays(day, 3));

    const bank = await itemOf(alice, 'Call bank');
    expect(bank.status).toBe('pending'); // one-offs aren't paused, they carry over
    expect((await bob.send('POST', `/api/instances/${bank.instanceId}/nudge`)).status).toBe(409);

    // Ending the pause brings today back.
    await alice.send('DELETE', `/api/pauses/${id}`);
    expect((await itemOf(alice, 'Run')).status).toBe('pending');
  });

  it('days inside a pause are materialised as paused, not missed', async () => {
    const t = await todo(alice, { title: 'Meditate', category: 'habit', recurrence: { type: 'daily' } });
    const day = today();
    await alice.send('POST', '/api/pauses', { startDate: addDays(day, 1), endDate: addDays(day, 2) });
    // Pretend three days pass without opening the app.
    await runReminders(env, Date.now() + 3 * 86_400_000);
    const rows = (await env.DB.prepare('SELECT date, status, paused FROM todo_instances WHERE todo_id = ? ORDER BY date').bind(t.id).all<any>()).results;
    expect(rows.map((r: any) => [r.status, r.paused])).toEqual([
      ['missed', 0],
      ['pending', 1],
      ['pending', 1],
      ['pending', 0],
    ]);
  });

  it('streaks freeze across paused days', () => {
    const s = habitStats(
      [
        { date: '2026-10-01', status: 'done' },
        { date: '2026-10-02', status: 'paused' },
        { date: '2026-10-03', status: 'paused' },
        { date: '2026-10-04', status: 'done' },
      ],
      '2026-10-04',
    );
    expect(s.currentStreak).toBe(2);
    expect(s.completionRate).toBe(1);
  });

  it('silences reminders while paused (and delivers them otherwise)', async () => {
    // A real subscription + VAPID keys, with the push service mocked: count delivery attempts.
    const ua = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
    const v = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])) as CryptoKeyPair;
    const b64 = (b: ArrayBuffer | Uint8Array) => Buffer.from(b as ArrayBuffer).toString('base64url');
    env.VAPID_PUBLIC_KEY = b64((await crypto.subtle.exportKey('raw', v.publicKey)) as ArrayBuffer);
    env.VAPID_PRIVATE_KEY = ((await crypto.subtle.exportKey('jwk', v.privateKey)) as JsonWebKey).d!;
    for (const c of [alice, bob]) {
      await env.DB.prepare('INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, 0)')
        .bind(crypto.randomUUID(), c.user.id, `https://push.test/${c.user.id}`, b64((await crypto.subtle.exportKey('raw', ua.publicKey)) as ArrayBuffer), b64(crypto.getRandomValues(new Uint8Array(16))))
        .run();
    }
    const sentTo: string[] = [];
    const fakeFetch = (async (url: string) => {
      sentTo.push(String(url));
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;

    await todo(alice, { title: 'Pills', reminderTime: '09:00' });
    await todo(bob, { title: 'Water plants', reminderTime: '09:00' });
    await alice.send('POST', '/api/pauses', { startDate: today(), endDate: today() });
    const r = await runReminders(env, zonedToUtc(today(), '09:01', 'Asia/Kolkata'), fakeFetch);
    expect(r.due).toBe(2);
    expect(sentTo).toEqual([`https://push.test/${bob.user.id}`]); // Alice is on a break
  });
});

describe('weekly review', () => {
  it('summarizeWeek aggregates by day, weekday and category', () => {
    const week = '2026-10-05';
    const s = summarizeWeek(
      [
        { date: '2026-10-05', category: 'work', status: 'done', n: 3 },
        { date: '2026-10-05', category: 'habit', status: 'missed', n: 1 },
        { date: '2026-10-06', category: 'habit', status: 'done', n: 2 },
        { date: '2026-10-07', category: 'work', status: 'missed', n: 2 },
        { date: '2026-10-08', category: 'work', status: 'pending', n: 1 },
        { date: '2026-10-09', category: 'habit', status: 'paused', n: 1 },
      ],
      week,
    );
    expect(s).toMatchObject({ done: 5, missed: 3, open: 1, paused: 1 });
    expect(s.rate).toBeCloseTo(5 / 8);
    expect(s.bestDay?.date).toBe('2026-10-06');
    expect(s.worstDay?.date).toBe('2026-10-07');
    expect(s.byWeekday[0]).toEqual({ weekday: 1, done: 3, total: 4 });
    expect(s.byCategory).toEqual([
      { category: 'habit', done: 2, total: 3 },
      { category: 'work', done: 3, total: 6 },
    ]);
  });

  it('shows both partners side by side; private todos never count in the partner column', async () => {
    await todo(alice, { title: 'Open' });
    await todo(alice, { title: 'Secret', isPrivate: true });
    for (const t of ['Open', 'Secret']) {
      const it0 = await itemOf(alice, t);
      await alice.send('POST', `/api/instances/${it0.instanceId}/complete`, {});
    }
    const mine = await json(alice.get('/api/review'));
    expect(mine.weekStart).toBe(startOfWeek(today()));
    expect(mine.me.done).toBe(2);
    const theirs = await json(bob.get('/api/review'));
    expect(theirs.partner.done).toBe(1);
    expect((await json(eve.get('/api/review'))).partner).toBeNull();
  });
});

describe('photo timeline', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
  async function proof(c: Client, instanceId: string) {
    const form = new FormData();
    form.set('file', new File([jpeg as Uint8Array<ArrayBuffer>], 'p.jpg', { type: 'image/jpeg' }));
    form.set('instanceId', instanceId);
    const r = await c.raw('/api/photos', { method: 'POST', body: form, headers: { 'x-csrf-token': c.csrf, origin: 'https://cowork.test' } });
    expect(r.status).toBe(201);
  }

  it('lists completion photos newest first with the usual privacy, and paginates', async () => {
    await todo(alice, { title: 'Gym' });
    await todo(alice, { title: 'Secret', isPrivate: true });
    const gym = await itemOf(alice, 'Gym');
    const secret = await itemOf(alice, 'Secret');
    await proof(alice, gym.instanceId);
    await proof(alice, secret.instanceId);

    expect((await json(alice.get('/api/timeline/photos'))).photos).toHaveLength(2);
    const forBob = (await json(bob.get('/api/timeline/photos'))).photos;
    expect(forBob.map((p: any) => p.todoTitle)).toEqual(['Gym']);
    expect((await json(eve.get('/api/timeline/photos'))).photos).toEqual([]);

    // 30 more photos -> two pages.
    for (let i = 0; i < 30; i++) {
      await env.DB.prepare(
        `INSERT INTO photos (id, owner_id, todo_id, instance_id, r2_key, content_type, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, 'image/jpeg', 1, ?)`,
      )
        .bind(crypto.randomUUID(), alice.user.id, gym.todoId, gym.instanceId, `k${i}`, i)
        .run();
    }
    const page1 = await json(alice.get(`/api/timeline/photos?todoId=${gym.todoId}`));
    expect(page1.photos).toHaveLength(24);
    expect(page1.next).toBeTruthy();
    const page2 = await json(alice.get(`/api/timeline/photos?todoId=${gym.todoId}&before=${page1.next}`));
    expect(page2.photos).toHaveLength(7);
    expect(page2.next).toBeNull();
    const ids = new Set([...page1.photos, ...page2.photos].map((p: any) => p.id));
    expect(ids.size).toBe(31);
  });
});
