import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../server/env';
import { runReminders } from '../server/reminders';
import { boardColumns } from '../server/services/board';
import { keepsRequiredKinds, type StatusRow } from '../server/services/statuses';
import { shiftedReminder } from '../server/services/tomorrow';
import { deadlineState } from '../shared/deadline';
import { isValidKey, keyBetween } from '../shared/fractional';
import { parseQuickAdd } from '../shared/quickadd';
import { habitStats } from '../shared/streaks';
import { addDays, localDate, zonedToUtc } from '../shared/time';
import { applyMigration, createTestD1 } from './helpers/d1';
import { createEnv, insertUser, makeApp, pair, type Client } from './helpers/app';

let env: Env;
let h: ReturnType<typeof makeApp>;
let alice: Client;
let bob: Client;
let eve: Client;

const TZ = 'Asia/Kolkata';
const today = () => localDate(Date.now(), TZ);
const json = async <T = any>(r: Response | Promise<Response>): Promise<T> => (await r).json() as Promise<T>;

async function todo(c: Client, body: Record<string, unknown>) {
  const res = await c.send('POST', '/api/todos', { category: 'work', startDate: today(), ...body });
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json<any>()).todo as { id: string };
}
async function items(c: Client, who = 'me') {
  return (await json(c.get(`/api/today?who=${who}`))).items as any[];
}
async function itemOf(c: Client, title: string, who = 'me') {
  return (await items(c, who)).find((i) => i.title === title);
}
async function statuses(c: Client) {
  return (await json(c.get('/api/statuses'))).statuses as any[];
}
const byName = async (c: Client, name: string) => (await statuses(c)).find((s) => s.name === name);

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

describe('fractional order keys', () => {
  it('generates keys in order and always finds room between two', () => {
    expect(keyBetween(null, null)).toBe('a0');
    expect(keyBetween('a0', null)).toBe('a1');
    expect(keyBetween(null, 'a0')).toBe('Zz');
    const mid = keyBetween('a0', 'a1');
    expect('a0' < mid && mid < 'a1').toBe(true);

    // Random inserts keep a consistent order.
    const keys: string[] = [keyBetween(null, null)];
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let n = 0; n < 400; n++) {
      const i = Math.floor(rnd() * (keys.length + 1));
      const k = keyBetween(keys[i - 1] ?? null, keys[i] ?? null);
      keys.splice(i, 0, k);
    }
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every(isValidKey)).toBe(true);
    expect(Math.max(...keys.map((k) => k.length))).toBeLessThan(40);
  });

  it('accepts the keys the migration backfills', () => {
    const k = 'h' + (1759800000).toString(16).padStart(8, '0') + 'a1b2V';
    expect(isValidKey(k)).toBe(true);
    expect(keyBetween(k, null) > k).toBe(true);
    expect(() => keyBetween('a1', 'a0')).toThrow();
  });
});

describe('deadline states', () => {
  it.each([
    ['2026-10-06', null, 'overdue', 'Overdue by 1 day'],
    ['2026-10-07', null, 'today', 'Due today'],
    ['2026-10-07', '09:00', 'overdue', 'Overdue'],
    ['2026-10-07', '18:00', 'today', 'Due today 18:00'],
    ['2026-10-08', null, 'soon', 'Due tomorrow'],
    ['2026-10-10', null, 'soon', 'Due in 3 days'],
    ['2026-10-20', null, 'later', 'Due in 13 days'],
  ])('%s %s', (date, time, kind, label) => {
    expect(deadlineState(date, time, '2026-10-07', '12:00')).toMatchObject({ kind, label });
  });

  it('quick add understands priority', () => {
    expect(parseQuickAdd('ship it !urgent fri', '2026-10-07')).toMatchObject({ title: 'ship it', priority: 4 });
    expect(parseQuickAdd('tidy desk !low', '2026-10-07').priority).toBe(1);
    expect(parseQuickAdd('review PR !high', '2026-10-07').priority).toBe(3);
    expect(parseQuickAdd('no priority here', '2026-10-07').priority).toBeNull();
  });
});

describe('migration 0005 on existing data', () => {
  it('seeds statuses, maps completions to Done / To do, sets Medium priority and valid positions', async () => {
    const db = createTestD1({ stopBefore: '0005' });
    const now = Date.now();
    db.sqlite.exec(`INSERT INTO users (id, email, name, timezone, created_at) VALUES ('u1', 'x@example.test', 'X', 'UTC', ${now})`);
    db.sqlite.exec(`INSERT INTO todos (id, user_id, title, category, start_date, created_at, updated_at) VALUES
      ('t1', 'u1', 'Done one', 'work', '2026-10-01', ${now}, ${now}), ('t2', 'u1', 'Open one', 'work', '2026-10-01', ${now + 1000}, ${now})`);
    db.sqlite.exec(`INSERT INTO todo_instances (id, todo_id, user_id, date, status, created_at) VALUES
      ('i1', 't1', 'u1', '2026-10-01', 'done', ${now}), ('i2', 't2', 'u1', '2026-10-01', 'pending', ${now})`);
    applyMigration(db, '0005_status_priority_deadlines.sql');

    const st = (await db.prepare('SELECT * FROM statuses WHERE user_id = ? ORDER BY position').bind('u1').all<StatusRow>()).results;
    expect(st.map((s) => [s.name, s.kind])).toEqual([
      ['To do', 'todo'],
      ['In progress', 'active'],
      ['Blocked', 'blocked'],
      ['Done', 'done'],
    ]);
    expect(st.every((s) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(s.id))).toBe(true);
    const inst = (await db.prepare('SELECT i.id, s.name FROM todo_instances i JOIN statuses s ON s.id = i.status_id ORDER BY i.id').all<any>()).results;
    expect(inst).toEqual([
      { id: 'i1', name: 'Done' },
      { id: 'i2', name: 'To do' },
    ]);
    const todos = (await db.prepare('SELECT id, priority, position FROM todos ORDER BY position').all<any>()).results;
    expect(todos.map((t: any) => [t.id, t.priority])).toEqual([
      ['t1', 2],
      ['t2', 2],
    ]);
    expect(todos.every((t: any) => isValidKey(t.position))).toBe(true);
  });
});

describe('status settings', () => {
  it('seeds four defaults and lets you add, rename, recolour and reorder', async () => {
    const s = await statuses(alice);
    expect(s.map((x) => [x.name, x.kind, x.isDefault])).toEqual([
      ['To do', 'todo', true],
      ['In progress', 'active', true],
      ['Blocked', 'blocked', true],
      ['Done', 'done', true],
    ]);
    const { id } = await json(alice.send('POST', '/api/statuses', { name: 'Review', kind: 'active', color: 'plum' }));
    expect((await alice.send('PATCH', `/api/statuses/${id}`, { name: 'In review', color: 'honey' })).status).toBe(200);
    const ids = (await statuses(alice)).map((x) => x.id);
    const reordered = [ids[0], id, ...ids.slice(1).filter((x: string) => x !== id)];
    expect((await alice.send('POST', '/api/statuses/order', { ids: reordered })).status).toBe(200);
    expect((await statuses(alice))[1]).toMatchObject({ name: 'In review', color: 'honey', kind: 'active', isDefault: false });
    // Kind is fixed.
    expect((await alice.send('PATCH', `/api/statuses/${id}`, { kind: 'done' })).status).toBe(400);
  });

  it('keeps at least one todo-kind and one done-kind status; statuses in use are archived, not deleted', async () => {
    const todoS = await byName(alice, 'To do');
    const doneS = await byName(alice, 'Done');
    expect((await alice.send('PATCH', `/api/statuses/${todoS.id}`, { archived: true })).status).toBe(409);
    expect((await alice.send('PATCH', `/api/statuses/${doneS.id}`, { archived: true })).status).toBe(409);
    expect((await alice.send('DELETE', `/api/statuses/${doneS.id}`)).status).toBe(409);

    await todo(alice, { title: 'Write spec' });
    const it0 = await itemOf(alice, 'Write spec');
    const active = await byName(alice, 'In progress');
    await alice.send('POST', `/api/instances/${it0.instanceId}/status`, { statusId: active.id });
    expect((await alice.send('DELETE', `/api/statuses/${active.id}`)).status).toBe(409);
    expect((await alice.send('PATCH', `/api/statuses/${active.id}`, { archived: true })).status).toBe(200);

    const { id: spare } = await json(alice.send('POST', '/api/statuses', { name: 'Someday', kind: 'todo' }));
    expect((await alice.send('DELETE', `/api/statuses/${spare}`)).status).toBe(200);
    expect((await bob.send('PATCH', `/api/statuses/${todoS.id}`, { name: 'Hijacked' })).status).toBe(404);
  });

  it('keepsRequiredKinds is the rule behind it', () => {
    const list = [
      { id: 'a', kind: 'todo' as const, archived_at: null },
      { id: 'b', kind: 'done' as const, archived_at: null },
      { id: 'c', kind: 'todo' as const, archived_at: 1 },
    ];
    expect(keepsRequiredKinds(list, 'a')).toBe(false);
    expect(keepsRequiredKinds([...list, { id: 'd', kind: 'todo', archived_at: null }], 'a')).toBe(true);
  });
});

describe('status workflow and blockers', () => {
  it('done-kind statuses complete exactly like the checkbox; the checkbox maps to default statuses', async () => {
    await todo(alice, { title: 'Ship' });
    const it0 = await itemOf(alice, 'Ship');
    expect(it0.stage).toMatchObject({ name: 'To do', kind: 'todo' });
    const { id: shipped } = await json(alice.send('POST', '/api/statuses', { name: 'Shipped', kind: 'done', color: 'sage' }));
    const r = await json(alice.send('POST', `/api/instances/${it0.instanceId}/status`, { statusId: shipped }));
    expect(r.completed).toBe(true);
    let now = await itemOf(alice, 'Ship');
    expect(now).toMatchObject({ status: 'done', completedBy: alice.user.id, stage: { name: 'Shipped' } });
    // Partner cheer fires for a done-kind status too (alice's only todo is done).
    await new Promise((r) => setTimeout(r, 20));
    const cheer = await env.DB.prepare(`SELECT COUNT(*) AS n FROM notification_log WHERE kind = 'partner_all_done'`).first<{ n: number }>();
    expect(cheer?.n).toBe(1);

    await alice.send('POST', `/api/instances/${it0.instanceId}/uncomplete`, {});
    now = await itemOf(alice, 'Ship');
    expect(now).toMatchObject({ status: 'pending', stage: { name: 'To do' } });
    await alice.send('POST', `/api/instances/${it0.instanceId}/complete`, {});
    expect((await itemOf(alice, 'Ship')).stage).toMatchObject({ name: 'Done', kind: 'done' });
  });

  it('blocking needs a note, unblocking resolves it, and the history keeps every blocker', async () => {
    const t = await todo(alice, { title: 'Launch' });
    const it0 = await itemOf(alice, 'Launch');
    const blocked = await byName(alice, 'Blocked');
    const active = await byName(alice, 'In progress');
    expect((await alice.send('POST', `/api/instances/${it0.instanceId}/status`, { statusId: blocked.id })).status).toBe(400);
    await alice.send('POST', `/api/instances/${it0.instanceId}/status`, { statusId: blocked.id, blocker: 'Waiting on legal' });
    const b1 = await itemOf(alice, 'Launch');
    expect(b1.stage.kind).toBe('blocked');
    expect(b1.blocker.note).toBe('Waiting on legal');
    expect(b1.blocker.since).toBeGreaterThan(0);

    await alice.send('POST', `/api/instances/${it0.instanceId}/status`, { statusId: active.id });
    expect((await itemOf(alice, 'Launch')).blocker).toBeNull();
    await alice.send('POST', `/api/instances/${it0.instanceId}/status`, { statusId: blocked.id, blocker: 'Waiting on design' });
    // Completing closes the open blocker too.
    await alice.send('POST', `/api/instances/${it0.instanceId}/complete`, {});
    const hist = (await json(alice.get(`/api/todos/${t.id}/blockers`))).blockers;
    expect(hist.map((b: any) => [b.note, b.open])).toEqual([
      ['Waiting on design', false],
      ['Waiting on legal', false],
    ]);
    expect(hist.every((b: any) => b.resolvedAt)).toBe(true);
  });

  it("partners see blockers on non-private todos only; they can't change statuses of read-only todos", async () => {
    await todo(alice, { title: 'Open one' });
    await todo(alice, { title: 'Secret', isPrivate: true });
    const blocked = await byName(alice, 'Blocked');
    for (const title of ['Open one', 'Secret']) {
      const it0 = await itemOf(alice, title);
      await alice.send('POST', `/api/instances/${it0.instanceId}/status`, { statusId: blocked.id, blocker: `waiting (${title})` });
    }
    const seen = await items(bob, 'partner');
    expect(seen.map((i) => i.title)).toEqual(['Open one']);
    expect(seen[0].blocker.note).toBe('waiting (Open one)');
    const secret = await itemOf(alice, 'Secret');
    const todoRow = await env.DB.prepare('SELECT id FROM todos WHERE title = ?').bind('Secret').first<{ id: string }>();
    expect((await bob.get(`/api/todos/${todoRow!.id}/blockers`)).status).toBe(404);
    expect((await bob.send('POST', `/api/instances/${seen[0].instanceId}/status`, { statusId: blocked.id, blocker: 'x' })).status).toBe(404);
    expect((await eve.send('POST', `/api/instances/${secret.instanceId}/status`, { statusId: blocked.id, blocker: 'x' })).status).toBe(404);
  });

  it('partners can move shared todos, using their own statuses (mapped by kind)', async () => {
    await todo(alice, { title: 'Ours', isShared: true });
    const ours = await itemOf(bob, 'Ours');
    const bobActive = await byName(bob, 'In progress');
    expect((await bob.send('POST', `/api/instances/${ours.instanceId}/status`, { statusId: bobActive.id })).status).toBe(200);
    const forAlice = await itemOf(alice, 'Ours');
    expect(forAlice.stage).toMatchObject({ kind: 'active', name: 'In progress' });
    expect(forAlice.stage.id).toBe((await byName(alice, 'In progress')).id);
  });

  it('each new occurrence of a repeating todo starts at the default todo status', async () => {
    const t = await todo(alice, { title: 'Daily review', recurrence: { type: 'daily' }, category: 'habit' });
    const it0 = await itemOf(alice, 'Daily review');
    await alice.send('POST', `/api/instances/${it0.instanceId}/status`, { statusId: (await byName(alice, 'In progress')).id });
    await runReminders(env, Date.now() + 86_400_000);
    const rows = (
      await env.DB.prepare('SELECT date, status_id FROM todo_instances WHERE todo_id = ? ORDER BY date').bind(t.id).all<any>()
    ).results;
    expect(rows).toHaveLength(2);
    expect(rows[1].status_id).toBeNull(); // = the default todo-kind status
  });
});

describe('priority and deadlines', () => {
  it('sorts Today by overdue, then priority, then deadline; overdue todos join Today', async () => {
    await todo(alice, { title: 'Low', priority: 1 });
    await todo(alice, { title: 'Urgent', priority: 4 });
    await todo(alice, { title: 'High later', priority: 3, deadlineDate: addDays(today(), 5) });
    await todo(alice, { title: 'High soon', priority: 3, deadlineDate: addDays(today(), 1) });
    await todo(alice, { title: 'Late', priority: 1, startDate: addDays(today(), 3), deadlineDate: addDays(today(), -1) });
    expect((await items(alice)).map((i) => i.title)).toEqual(['Late', 'Urgent', 'High soon', 'High later', 'Low']);
    expect((await itemOf(alice, 'High soon')).deadline).toEqual({ date: addDays(today(), 1), time: null });
  });

  it('defaults to Medium and validates', async () => {
    await todo(alice, { title: 'Plain' });
    expect((await itemOf(alice, 'Plain')).priority).toBe(2);
    expect((await alice.send('POST', '/api/todos', { title: 'x', category: 'work', startDate: today(), priority: 5 })).status).toBe(400);
  });

  it('warns when a todo is due after its project', async () => {
    const p = (await json(alice.send('POST', '/api/projects', { name: 'Launch', category: 'work', deadlineDate: addDays(today(), 7) }))).project;
    expect(p.deadline).toEqual({ date: addDays(today(), 7), time: null });
    await todo(alice, { title: 'On time', projectId: p.id, deadlineDate: addDays(today(), 3) });
    await todo(alice, { title: 'Too late', projectId: p.id, deadlineDate: addDays(today(), 9) });
    const view = await json(alice.get(`/api/projects/${p.id}`));
    expect(view.deadlineWarnings.map((w: any) => w.title)).toEqual(['Too late']);
  });

  it('pushes the day before and on the morning of a deadline, once each, skipping done todos', async () => {
    const d = today();
    await todo(alice, { title: 'Due tomorrow', deadlineDate: addDays(d, 1) });
    await todo(alice, { title: 'Due today', deadlineDate: d, deadlineTime: '17:00' });
    await todo(alice, { title: 'Already done', deadlineDate: d });
    const done = await itemOf(alice, 'Already done');
    await alice.send('POST', `/api/instances/${done.instanceId}/complete`, {});
    const log = () => env.DB.prepare(`SELECT kind, ref FROM notification_log WHERE kind LIKE 'deadline_%' ORDER BY kind`).all<any>();

    expect((await runReminders(env, zonedToUtc(d, '07:30', TZ))).deadlines).toBe(0);
    expect((await runReminders(env, zonedToUtc(d, '08:10', TZ))).deadlines).toBe(2);
    expect((await log()).results.map((r: any) => r.kind)).toEqual(['deadline_day', 'deadline_eve']);
    await runReminders(env, zonedToUtc(d, '09:00', TZ));
    expect((await log()).results).toHaveLength(2);
  });
});

describe('boards', () => {
  it('a project board has status columns; a drop moves status and reorders by touching one row', async () => {
    const p = (await json(alice.send('POST', '/api/projects', { name: 'Site', category: 'work' }))).project;
    for (const title of ['A', 'B', 'C']) await todo(alice, { title, projectId: p.id });
    const board = await json(alice.get(`/api/board?projectId=${p.id}`));
    expect(board.columns.map((c: any) => c.name)).toEqual(['To do', 'In progress', 'Blocked', 'Done']);
    expect(board.canEdit).toBe(true);
    const todoCol = board.columns[0].id;
    const cards = board.cards.filter((c: any) => c.columnId === todoCol);
    expect(cards.map((c: any) => c.title)).toEqual(['A', 'B', 'C']);

    const before = (await env.DB.prepare('SELECT id, position FROM todos ORDER BY id').all<any>()).results;
    const c = cards[2];
    // Move C to the top of "In progress".
    const res = await json(alice.send('POST', `/api/board/cards/${c.instanceId}/move`, { statusId: board.columns[1].id, beforeId: null, afterId: cards[0].todoId }));
    expect(res.status.name).toBe('In progress');
    const after = (await env.DB.prepare('SELECT id, position FROM todos ORDER BY id').all<any>()).results;
    const changed = after.filter((r: any, i: number) => r.position !== before[i].position);
    expect(changed.map((r: any) => r.id)).toEqual([c.todoId]);

    const again = await json(alice.get(`/api/board?projectId=${p.id}`));
    expect(again.cards.find((x: any) => x.todoId === c.todoId).columnId).toBe(board.columns[1].id);
    expect(again.cards.map((x: any) => x.title)).toEqual(['C', 'A', 'B']);
  });

  it('dropping into a blocked column needs a blocker; into a done column completes', async () => {
    const p = (await json(alice.send('POST', '/api/projects', { name: 'Site', category: 'work' }))).project;
    await todo(alice, { title: 'Card', projectId: p.id });
    const board = await json(alice.get(`/api/board?projectId=${p.id}`));
    const card = board.cards[0];
    const blockedCol = board.columns.find((c: any) => c.kind === 'blocked');
    const doneCol = board.columns.find((c: any) => c.kind === 'done');
    expect((await alice.send('POST', `/api/board/cards/${card.instanceId}/move`, { statusId: blockedCol.id })).status).toBe(400);
    expect((await alice.send('POST', `/api/board/cards/${card.instanceId}/move`, { statusId: blockedCol.id, blocker: 'API keys' })).status).toBe(200);
    const done = await json(alice.send('POST', `/api/board/cards/${card.instanceId}/move`, { statusId: doneCol.id }));
    expect(done.completed).toBe(true);
    expect((await itemOf(alice, 'Card')).status).toBe('done');
  });

  it("is read-only for the partner unless the project is shared; strangers can't see it", async () => {
    const solo = (await json(alice.send('POST', '/api/projects', { name: 'Solo', category: 'work' }))).project;
    const ours = (await json(alice.send('POST', '/api/projects', { name: 'Ours', category: 'work', isShared: true }))).project;
    await todo(alice, { title: 'S1', projectId: solo.id });
    await todo(alice, { title: 'O1', projectId: ours.id });
    const soloBoard = await json(bob.get(`/api/board?projectId=${solo.id}`));
    expect(soloBoard.canEdit).toBe(false);
    expect((await bob.send('POST', `/api/board/cards/${soloBoard.cards[0].instanceId}/move`, { statusId: soloBoard.columns[1].id })).status).toBe(404);
    const oursBoard = await json(bob.get(`/api/board?projectId=${ours.id}`));
    expect(oursBoard.canEdit).toBe(true);
    expect((await bob.send('POST', `/api/board/cards/${oursBoard.cards[0].instanceId}/move`, { statusId: oursBoard.columns[1].id })).status).toBe(200);
    expect((await eve.get(`/api/board?projectId=${solo.id}`)).status).toBe(404);
  });

  it('hides archived columns unless they still hold cards; the All work board filters by category', async () => {
    await todo(alice, { title: 'Work thing', category: 'work' });
    await todo(alice, { title: 'Home thing', category: 'personal' });
    await todo(bob, { title: "Bob's shared", category: 'work', isShared: true });
    const review = (await json(alice.send('POST', '/api/statuses', { name: 'Review', kind: 'active' }))).id;
    const wt = await itemOf(alice, 'Work thing');
    await alice.send('POST', `/api/instances/${wt.instanceId}/status`, { statusId: review });
    await alice.send('PATCH', `/api/statuses/${review}`, { archived: true });

    const all = await json(alice.get('/api/board?category=work'));
    expect(all.cards.map((c: any) => c.title).sort()).toEqual(["Bob's shared", 'Work thing']);
    expect(all.columns.map((c: any) => c.name)).toContain('Review'); // archived but holds a card
    const shared = all.cards.find((c: any) => c.title === "Bob's shared");
    expect(shared.columnId).toBe((await byName(alice, 'To do')).id);

    await alice.send('POST', `/api/instances/${wt.instanceId}/status`, { statusId: (await byName(alice, 'In progress')).id });
    const after = await json(alice.get('/api/board'));
    expect(after.columns.map((c: any) => c.name)).not.toContain('Review');
    expect(boardColumns([], [])).toEqual([]);
  });
});

describe("tomorrow's habits", () => {
  it('lists habits scheduled tomorrow with their time', async () => {
    await todo(alice, { title: 'Gym', category: 'habit', recurrence: { type: 'daily' }, dueTime: '07:00', reminderTime: '06:30' });
    await todo(alice, { title: 'Standup', category: 'work', recurrence: { type: 'daily' }, dueTime: '10:00' });
    const t = await json(alice.get('/api/wrapup/tomorrow'));
    expect(t.date).toBe(addDays(today(), 1));
    expect(t.habits.map((x: any) => [x.title, x.time])).toEqual([['Gym', '07:00']]);
  });

  it('change tomorrow only: a new time (reminder keeps its lead) or a skip that never breaks the streak', async () => {
    const g = await todo(alice, { title: 'Gym', category: 'habit', recurrence: { type: 'daily' }, dueTime: '07:00', reminderTime: '06:30' });
    const r = await json(alice.send('POST', `/api/todos/${g.id}/tomorrow`, { action: 'time', time: '18:00' }));
    expect(r).toMatchObject({ date: addDays(today(), 1), time: '18:00', skipped: false });
    const row = await env.DB.prepare('SELECT override_time, reminder_at FROM todo_instances WHERE todo_id = ? AND date = ?')
      .bind(g.id, addDays(today(), 1))
      .first<any>();
    expect(row.override_time).toBe('18:00');
    expect(row.reminder_at).toBe(zonedToUtc(addDays(today(), 1), '17:30', TZ));
    expect((await json(alice.get('/api/wrapup/tomorrow'))).habits[0]).toMatchObject({ time: '18:00', override: { time: '18:00', skipped: false } });

    // Skip it instead; a day later it's "skipped", not "missed", and the streak is intact.
    const it0 = await itemOf(alice, 'Gym');
    await alice.send('POST', `/api/instances/${it0.instanceId}/complete`, {});
    await alice.send('POST', `/api/todos/${g.id}/tomorrow`, { action: 'skip' });
    await runReminders(env, Date.now() + 2 * 86_400_000);
    const rows = (await env.DB.prepare('SELECT date, status, skipped FROM todo_instances WHERE todo_id = ? ORDER BY date').bind(g.id).all<any>()).results;
    expect(rows.map((x: any) => [x.status, x.skipped])).toEqual([
      ['done', 0],
      ['pending', 1],
      ['pending', 0],
    ]);
    const detail = await json(alice.get(`/api/todos/${g.id}`));
    expect(detail.instances.find((i: any) => i.date === addDays(today(), 1)).status).toBe('skipped');
    expect(habitStats([{ date: '2026-10-01', status: 'done' }, { date: '2026-10-02', status: 'skipped' }], '2026-10-02').currentStreak).toBe(1);

    // Keep undoes the one-day change.
    const kept = await json(alice.send('POST', `/api/todos/${g.id}/tomorrow`, { action: 'keep' }));
    expect(kept).toMatchObject({ skipped: false, time: null });
    expect((await json(alice.get('/api/wrapup/tomorrow'))).habits[0].override).toBeNull();
  });

  it('change permanently from tomorrow leaves today and history alone', async () => {
    const g = await todo(alice, { title: 'Run', category: 'habit', recurrence: { type: 'daily' }, dueTime: '06:00' });
    const it0 = await itemOf(alice, 'Run');
    await alice.send('POST', `/api/instances/${it0.instanceId}/complete`, {});
    const r = await alice.send('POST', `/api/todos/${g.id}/change-from-tomorrow`, { recurrence: { type: 'weekly', weekdays: [1, 3, 5] }, dueTime: '07:00' });
    expect(r.status).toBe(200);
    const still = await itemOf(alice, 'Run');
    expect(still).toMatchObject({ instanceId: it0.instanceId, status: 'done', dueTime: '07:00' });
    expect(still.recurrence).toEqual({ type: 'weekly', weekdays: [1, 3, 5] });
    expect((await bob.send('POST', `/api/todos/${g.id}/change-from-tomorrow`, { dueTime: '08:00' })).status).toBe(404);
  });

  it('shiftedReminder keeps the lead before the due time', () => {
    expect(shiftedReminder('07:00', '06:30', '18:00')).toBe('17:30');
    expect(shiftedReminder(null, '06:30', '18:00')).toBe('18:00');
    expect(shiftedReminder('07:00', null, '18:00')).toBeNull();
    expect(shiftedReminder('00:30', '23:45', '00:10')).toBe('23:25');
  });
});

describe('weekly review', () => {
  it('reports blocked count and the longest-blocked item, without private ones for the partner', async () => {
    await todo(alice, { title: 'Old block' });
    await todo(alice, { title: 'Private block', isPrivate: true });
    const blocked = await byName(alice, 'Blocked');
    for (const t of ['Old block', 'Private block']) {
      const it0 = await itemOf(alice, t);
      await alice.send('POST', `/api/instances/${it0.instanceId}/status`, { statusId: blocked.id, blocker: `on ${t}` });
    }
    await env.DB.prepare(`UPDATE blockers SET blocked_at = blocked_at - 86400000 WHERE note = 'on Old block'`).run();
    const mine = await json(alice.get('/api/review'));
    expect(mine.me.blocked.count).toBe(2);
    expect(mine.me.blocked.longest.title).toBe('Old block');
    const theirs = await json(bob.get('/api/review'));
    expect(theirs.partner.blocked.count).toBe(1);
  });
});
