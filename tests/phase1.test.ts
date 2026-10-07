import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../server/env';
import { reminderRecipients, runReminders, wrapupDue } from '../server/reminders';
import { addDays, localDate, zonedToUtc } from '../shared/time';
import { nudgeTarget } from '../shared/authz';
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

describe('shared todos', () => {
  it('appear in both Today views and are done for both when either completes', async () => {
    await todo(alice, { title: 'Book flights', isShared: true });
    const forBob = await itemOf(bob, 'Book flights');
    expect(forBob).toMatchObject({ isShared: true, canEdit: true, ownerId: alice.user.id });

    expect((await bob.send('POST', `/api/instances/${forBob.instanceId}/complete`, {})).status).toBe(200);
    const forAlice = await itemOf(alice, 'Book flights');
    expect(forAlice).toMatchObject({ status: 'done', completedBy: bob.user.id });
  });

  it('records the assignee relative to the creator', async () => {
    await todo(alice, { title: 'Call plumber', isShared: true, assignee: 'partner' });
    expect((await itemOf(alice, 'Call plumber')).assignedTo).toBe(bob.user.id);
    await todo(alice, { title: 'Buy gift', isShared: true, assignee: 'either' });
    expect((await itemOf(bob, 'Buy gift')).assignedTo).toBeNull();
  });

  it('lets the partner edit but not move, privatise, unshare or delete', async () => {
    const t = await todo(alice, { title: 'Plan trip', isShared: true });
    expect((await bob.send('PATCH', `/api/todos/${t.id}`, { title: 'Plan the trip', notes: 'Goa?' })).status).toBe(200);
    expect((await itemOf(alice, 'Plan the trip')).notes).toBe('Goa?');
    expect((await bob.send('PATCH', `/api/todos/${t.id}`, { isShared: false })).status).toBe(403);
    expect((await bob.send('PATCH', `/api/todos/${t.id}`, { isPrivate: true })).status).toBe(403);
    expect((await bob.send('DELETE', `/api/todos/${t.id}`)).status).toBe(404);
  });

  it('rejects private + shared, and sharing without a partner', async () => {
    expect((await alice.send('POST', '/api/todos', { title: 'x', category: 'work', startDate: today(), isShared: true, isPrivate: true })).status).toBe(400);
    expect((await eve.send('POST', '/api/todos', { title: 'x', category: 'work', startDate: today(), isShared: true })).status).toBe(400);
  });

  it('non-shared todos stay read-only for the partner', async () => {
    await todo(alice, { title: 'Mine only' });
    const it = await itemOf(bob, 'Mine only', 'partner');
    expect(it.canEdit).toBe(false);
    expect((await bob.send('POST', `/api/instances/${it.instanceId}/complete`, {})).status).toBe(404);
  });

  it('a stranger never sees or edits shared todos', async () => {
    const t = await todo(alice, { title: 'Ours', isShared: true });
    expect((await eve.get(`/api/todos/${t.id}`)).status).toBe(404);
    expect((await eve.send('PATCH', `/api/todos/${t.id}`, { title: 'pwned' })).status).toBe(404);
  });
});

describe('shared projects', () => {
  it('both can add todos, and both see them', async () => {
    const p = (await json(alice.send('POST', '/api/projects', { name: 'Wedding', category: 'personal', isShared: true }))).project;
    await todo(bob, { title: 'Venue shortlist', projectId: p.id });
    const view = await json(alice.get(`/api/projects/${p.id}`));
    expect(view.todos.map((t: any) => t.title)).toEqual(['Venue shortlist']);
    expect(view.todos[0].canEdit).toBe(true);
    expect((await json(bob.get('/api/projects'))).projects.map((x: any) => x.name)).toContain('Wedding');
    expect((await itemOf(alice, 'Venue shortlist')).isShared).toBe(true);
  });

  it('cannot hold private todos', async () => {
    const p = (await json(alice.send('POST', '/api/projects', { name: 'Home', category: 'personal' }))).project;
    await todo(alice, { title: 'Secret', projectId: p.id, isPrivate: true });
    expect((await alice.send('PATCH', `/api/projects/${p.id}`, { isShared: true })).status).toBe(409);
    expect((await alice.send('POST', '/api/projects', { name: 'x', category: 'work', isShared: true, isPrivate: true })).status).toBe(400);
  });

  it("a partner can't add to a project that isn't shared", async () => {
    const p = (await json(alice.send('POST', '/api/projects', { name: 'Solo', category: 'work' }))).project;
    expect((await bob.send('POST', '/api/todos', { title: 'x', category: 'work', startDate: today(), projectId: p.id })).status).toBe(400);
  });
});

describe('unpair', () => {
  it('unshares items, keeps them with their creator and removes cross-project todos', async () => {
    const p = (await json(alice.send('POST', '/api/projects', { name: 'Wedding', category: 'personal', isShared: true }))).project;
    const bobs = await todo(bob, { title: 'Venue', projectId: p.id });
    await todo(alice, { title: 'Flights', isShared: true, assignee: 'partner' });
    await alice.send('DELETE', '/api/pairing');

    expect(await itemOf(bob, 'Flights')).toBeUndefined();
    const flights = await itemOf(alice, 'Flights');
    expect(flights).toMatchObject({ isShared: false, assignedTo: null });
    const venue = await json(bob.get(`/api/todos/${bobs.id}`));
    expect(venue.todo.projectId).toBeNull();
    expect((await json(alice.get('/api/projects'))).projects[0].isShared).toBe(false);
  });
});

describe('reactions', () => {
  it("partner reacts to the other's completion; it shows in the view", async () => {
    await todo(alice, { title: 'Gym' });
    const it0 = await itemOf(alice, 'Gym');
    await alice.send('POST', `/api/instances/${it0.instanceId}/complete`, {});
    expect((await bob.send('POST', `/api/instances/${it0.instanceId}/react`, { emoji: '🔥' })).status).toBe(200);
    expect((await itemOf(alice, 'Gym')).reactions).toEqual([{ userId: bob.user.id, emoji: '🔥' }]);
    // Changing and removing.
    await bob.send('POST', `/api/instances/${it0.instanceId}/react`, { emoji: '👏' });
    expect((await itemOf(alice, 'Gym')).reactions[0].emoji).toBe('👏');
    await bob.send('POST', `/api/instances/${it0.instanceId}/react`, { emoji: null });
    expect((await itemOf(alice, 'Gym')).reactions).toEqual([]);
  });

  it('is refused for your own completion, pending items, private todos, strangers and odd emoji', async () => {
    await todo(alice, { title: 'Gym' });
    await todo(alice, { title: 'Secret', isPrivate: true });
    const gym = await itemOf(alice, 'Gym');
    const secret = await itemOf(alice, 'Secret');
    expect((await bob.send('POST', `/api/instances/${gym.instanceId}/react`, { emoji: '🔥' })).status).toBe(404); // pending
    await alice.send('POST', `/api/instances/${gym.instanceId}/complete`, {});
    await alice.send('POST', `/api/instances/${secret.instanceId}/complete`, {});
    expect((await alice.send('POST', `/api/instances/${gym.instanceId}/react`, { emoji: '🔥' })).status).toBe(404);
    expect((await bob.send('POST', `/api/instances/${secret.instanceId}/react`, { emoji: '🔥' })).status).toBe(404);
    expect((await eve.send('POST', `/api/instances/${gym.instanceId}/react`, { emoji: '🔥' })).status).toBe(404);
    expect((await bob.send('POST', `/api/instances/${gym.instanceId}/react`, { emoji: '💩' })).status).toBe(400);
  });
});

describe('nudges', () => {
  it('partner can nudge a pending todo once per 3 hours', async () => {
    await todo(alice, { title: 'Pay rent' });
    const it0 = await itemOf(alice, 'Pay rent');
    expect((await bob.send('POST', `/api/instances/${it0.instanceId}/nudge`)).status).toBe(200);
    expect((await bob.send('POST', `/api/instances/${it0.instanceId}/nudge`)).status).toBe(429);
    await env.DB.prepare('UPDATE nudges SET created_at = created_at - ?').bind(3 * 3600_000 + 1).run();
    expect((await bob.send('POST', `/api/instances/${it0.instanceId}/nudge`)).status).toBe(200);
  });

  it('cannot nudge yourself, private todos, done todos, or as a stranger', async () => {
    await todo(alice, { title: 'Pay rent' });
    await todo(alice, { title: 'Secret', isPrivate: true });
    const rent = await itemOf(alice, 'Pay rent');
    const secret = await itemOf(alice, 'Secret');
    expect((await alice.send('POST', `/api/instances/${rent.instanceId}/nudge`)).status).toBe(404);
    expect((await bob.send('POST', `/api/instances/${secret.instanceId}/nudge`)).status).toBe(404);
    expect((await eve.send('POST', `/api/instances/${rent.instanceId}/nudge`)).status).toBe(404);
    await alice.send('POST', `/api/instances/${rent.instanceId}/complete`, {});
    expect((await bob.send('POST', `/api/instances/${rent.instanceId}/nudge`)).status).toBe(404);
  });

  it('targets the assignee of a shared todo', () => {
    const a = { id: 'a', partnerId: 'b' };
    const shared = { userId: 'a', isPrivate: false, isShared: true };
    expect(nudgeTarget(a, { ...shared, assignedTo: 'b' }, 'b', { status: 'pending' })).toBe('b');
    expect(nudgeTarget(a, { ...shared, assignedTo: null }, 'b', { status: 'pending' })).toBe('b');
    expect(nudgeTarget(a, { ...shared, assignedTo: 'a' }, 'b', { status: 'pending' })).toBeNull();
    expect(nudgeTarget({ id: 'b', partnerId: 'a' }, { ...shared, assignedTo: null }, 'b', { status: 'pending' })).toBe('a');
  });
});

describe('comments', () => {
  it('owner and partner talk on a non-private todo; authors delete their own', async () => {
    const t = await todo(alice, { title: 'Post on LinkedIn' });
    expect((await alice.send('POST', `/api/todos/${t.id}/comments`, { body: 'Draft is ready' })).status).toBe(201);
    const { id } = await json(bob.send('POST', `/api/todos/${t.id}/comments`, { body: 'Looks great!' }));
    const list = await json(alice.get(`/api/todos/${t.id}/comments`));
    expect(list.comments.map((c: any) => c.body)).toEqual(['Draft is ready', 'Looks great!']);
    expect((await itemOf(alice, 'Post on LinkedIn')).commentCount).toBe(2);
    expect((await alice.send('DELETE', `/api/comments/${id}`)).status).toBe(404); // not the author
    expect((await bob.send('DELETE', `/api/comments/${id}`)).status).toBe(200);
  });

  it('private todos have no comments, for anyone; strangers see nothing', async () => {
    const secret = await todo(alice, { title: 'Secret', isPrivate: true });
    const open = await todo(alice, { title: 'Open' });
    expect((await alice.send('POST', `/api/todos/${secret.id}/comments`, { body: 'hm' })).status).toBe(404);
    expect((await bob.get(`/api/todos/${secret.id}/comments`)).status).toBe(404);
    expect((await eve.get(`/api/todos/${open.id}/comments`)).status).toBe(404);
    expect((await eve.send('POST', `/api/todos/${open.id}/comments`, { body: 'hi' })).status).toBe(404);
    expect((await alice.send('POST', `/api/todos/${open.id}/comments`, { body: '' })).status).toBe(400);
  });

  it('todos in a private project have no comments either', async () => {
    const p = (await json(alice.send('POST', '/api/projects', { name: 'Gift', category: 'personal', isPrivate: true }))).project;
    const t = await todo(alice, { title: 'Wrap it', projectId: p.id });
    expect((await alice.send('POST', `/api/todos/${t.id}/comments`, { body: 'hm' })).status).toBe(404);
  });
});

describe('wrap-up, reschedule, skip, snooze', () => {
  it('wrapupDue fires once inside the window after the chosen time', () => {
    const u = { timezone: 'Asia/Kolkata', wrapup_time: '21:00', wrapup_sent_on: null as string | null };
    const at = (t: string) => zonedToUtc('2026-10-07', t, 'Asia/Kolkata');
    expect(wrapupDue(u, at('20:55'))).toBe(false);
    expect(wrapupDue(u, at('21:00'))).toBe(true);
    expect(wrapupDue(u, at('21:55'))).toBe(true);
    expect(wrapupDue(u, at('22:05'))).toBe(false);
    expect(wrapupDue({ ...u, wrapup_sent_on: '2026-10-07' }, at('21:05'))).toBe(false);
    expect(wrapupDue({ ...u, wrapup_time: null }, at('21:05'))).toBe(false);
  });

  it('the cron sends one wrap-up per day', async () => {
    await todo(alice, { title: 'Something' });
    const day = today();
    const nine = zonedToUtc(day, '21:02', 'Asia/Kolkata');
    expect((await runReminders(env, nine)).wrapups).toBe(0); // no push subscriptions, but it was claimed:
    const row = await env.DB.prepare('SELECT wrapup_sent_on FROM users WHERE id = ?').bind(alice.user.id).first<{ wrapup_sent_on: string }>();
    expect(row?.wrapup_sent_on).toBe(day);
    // Turning it off via the API.
    expect((await alice.send('PATCH', '/api/me', { wrapupTime: null })).status).toBe(200);
    expect((await json(alice.get('/api/me'))).wrapupTime).toBeNull();
    expect((await alice.send('PATCH', '/api/me', { wrapupTime: '22:30' })).status).toBe(200);
    expect((await json(alice.get('/api/me'))).wrapupTime).toBe('22:30');
  });

  it('moves a one-off to another day, skips a repeating one, snoozes a reminder', async () => {
    await todo(alice, { title: 'Leftover', reminderTime: '09:00' });
    await todo(alice, { title: 'Stretch', recurrence: { type: 'daily' } });
    const left = await itemOf(alice, 'Leftover');
    const stretch = await itemOf(alice, 'Stretch');

    expect((await alice.send('POST', `/api/instances/${stretch.instanceId}/reschedule`, { date: addDays(today(), 1) })).status).toBe(400);
    expect((await alice.send('POST', `/api/instances/${left.instanceId}/tomorrow`, {})).status).toBe(200);
    expect(await itemOf(alice, 'Leftover')).toBeUndefined();
    const week = await json(alice.get(`/api/range?from=${today()}&to=${addDays(today(), 1)}`));
    expect(week.days[1].items.map((i: any) => i.title)).toContain('Leftover');

    expect((await alice.send('POST', `/api/instances/${stretch.instanceId}/skip`, {})).status).toBe(200);
    expect((await itemOf(alice, 'Stretch')).status).toBe('missed');

    const r = await json(alice.send('POST', `/api/instances/${left.instanceId}/snooze`, { minutes: 60 }));
    expect(r.reminderAt).toBeGreaterThan(Date.now() + 59 * 60_000);
    expect((await bob.send('POST', `/api/instances/${left.instanceId}/snooze`, { minutes: 60 })).status).toBe(404);
  });

  it('reminders on shared todos go to the assignee, or both', () => {
    const base = { user_id: 'a', partner_id: 'b', partner_partner_id: 'a' };
    expect(reminderRecipients({ ...base, shared: 0, assigned_to: null })).toEqual(['a']);
    expect(reminderRecipients({ ...base, shared: 1, assigned_to: 'b' })).toEqual(['b']);
    expect(reminderRecipients({ ...base, shared: 1, assigned_to: null })).toEqual(['a', 'b']);
    expect(reminderRecipients({ ...base, partner_partner_id: null, shared: 1, assigned_to: null })).toEqual(['a']);
  });
});
