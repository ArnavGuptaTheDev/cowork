import { describe, expect, it } from 'vitest';
import { runReminders } from '../workers/reminders/src/index';
import { createTodo, updateTodo } from '../server/services/todos';
import { localDate, zonedToUtc } from '../shared/time';
import { createEnv, insertUser } from './helpers/app';

describe('reminders worker', () => {
  it('sends a due reminder once, inside the grace window, in the user time zone', async () => {
    const env = createEnv();
    const user = await insertUser(env, 'r@example.test', { timezone: 'Asia/Kolkata' });
    const now = Date.parse('2026-10-07T03:00:00Z'); // 08:30 in Kolkata
    const today = localDate(now, user.timezone);
    await createTodo(
      env,
      user,
      {
        title: 'Water the plants',
        notes: '',
        category: 'personal',
        startDate: today,
        endDate: null,
        dueTime: null,
        reminderTime: '09:00',
        recurrence: { type: 'daily' },
        projectId: null,
        isPrivate: false,
      },
      now,
    );
    const reminderAt = zonedToUtc(today, '09:00', 'Asia/Kolkata');
    expect(new Date(reminderAt).toISOString()).toBe('2026-10-07T03:30:00.000Z');

    // Before it is due: nothing.
    let r = await runReminders(env, now);
    expect(r.due).toBe(0);

    // Due: claimed once (no subscriptions, so nothing is delivered, but it is marked).
    r = await runReminders(env, reminderAt + 60_000);
    expect(r.due).toBe(1);
    r = await runReminders(env, reminderAt + 5 * 60_000);
    expect(r.due).toBe(0);
  });

  it('drops reminders older than the grace window and skips completed todos', async () => {
    const env = createEnv();
    const user = await insertUser(env, 's@example.test');
    const now = Date.parse('2026-10-07T03:00:00Z');
    const today = localDate(now, user.timezone);
    const id = await createTodo(
      env,
      user,
      {
        title: 'Late',
        notes: '',
        category: 'work',
        startDate: today,
        endDate: null,
        dueTime: '10:00',
        reminderTime: '09:00',
        recurrence: { type: 'none' },
        projectId: null,
        isPrivate: false,
      },
      now,
    );
    const reminderAt = zonedToUtc(today, '09:00', user.timezone);
    expect((await runReminders(env, reminderAt + 2 * 3600_000)).due).toBe(0);

    // Moving the reminder later re-arms it; completing the todo silences it.
    await updateTodo(env, user, id, { reminderTime: '13:00' }, now);
    await env.DB.prepare(`UPDATE todo_instances SET status = 'done' WHERE todo_id = ?`).bind(id).run();
    expect((await runReminders(env, zonedToUtc(today, '13:00', user.timezone) + 60_000)).due).toBe(0);
  });

  it('materialises today for users who have not opened the app', async () => {
    const env = createEnv();
    const user = await insertUser(env, 't@example.test');
    const day1 = Date.parse('2026-10-07T03:00:00Z');
    await createTodo(
      env,
      user,
      {
        title: 'Meditate',
        notes: '',
        category: 'habit',
        startDate: localDate(day1, user.timezone),
        endDate: null,
        dueTime: null,
        reminderTime: '07:00',
        recurrence: { type: 'daily' },
        projectId: null,
        isPrivate: false,
      },
      day1,
    );
    const day3 = day1 + 2 * 86_400_000;
    await runReminders(env, day3);
    const rows = (
      await env.DB.prepare('SELECT date, status FROM todo_instances ORDER BY date').all<{ date: string; status: string }>()
    ).results;
    expect(rows.map((r) => r.status)).toEqual(['missed', 'missed', 'pending']);
  });
});
