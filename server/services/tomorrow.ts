// "Tomorrow's habits" for the evening wrap-up: keep, change tomorrow only (time or skip), or change permanently.
import { occursOn, ruleFromColumns } from '../../shared/recurrence';
import { addDays, localDate } from '../../shared/time';
import type { TodoRow, UserRow } from '../db';
import type { Env } from '../env';
import { badRequest } from '../http';
import { editableTodo } from './access';
import { loadPauses, pausedOn } from './pause';
import { reminderAt, scheduleOf } from './todos';

export interface TomorrowHabit {
  todoId: string;
  title: string;
  /** The time it happens tomorrow (one-day override, else due time, else reminder time). */
  time: string | null;
  dueTime: string | null;
  reminderTime: string | null;
  recurrence: ReturnType<typeof ruleFromColumns>;
  override: { skipped: boolean; time: string | null } | null;
}

/** The user's own habits (repeating todos in the habit category) scheduled for their tomorrow. */
export async function tomorrowHabits(db: D1Database, user: UserRow, now: number): Promise<{ date: string; habits: TomorrowHabit[] }> {
  const date = addDays(localDate(now, user.timezone), 1);
  if (pausedOn(await loadPauses(db, user.id), date)) return { date, habits: [] };
  const { results } = await db
    .prepare(
      `SELECT * FROM todos
        WHERE user_id = ? AND recurrence != 'none' AND category = 'habit'
          AND start_date <= ? AND (end_date IS NULL OR end_date >= ?)`,
    )
    .bind(user.id, date, date)
    .all<TodoRow>();
  const scheduled = results.filter((t) => occursOn(scheduleOf(t), date));
  const { results: inst } = await db
    .prepare('SELECT todo_id, skipped, override_time FROM todo_instances WHERE user_id = ? AND date = ?')
    .bind(user.id, date)
    .all<{ todo_id: string; skipped: number; override_time: string | null }>();
  const byTodo = new Map(inst.map((i) => [i.todo_id, i]));
  const habits = scheduled.map((t) => {
    const o = byTodo.get(t.id);
    const override = o && (o.skipped === 1 || o.override_time) ? { skipped: o.skipped === 1, time: o.override_time } : null;
    return {
      todoId: t.id,
      title: t.title,
      time: override?.time ?? t.due_time ?? t.reminder_time,
      dueTime: t.due_time,
      reminderTime: t.reminder_time,
      recurrence: ruleFromColumns(t),
      override,
    };
  });
  habits.sort((a, b) => (a.time ?? '99:99').localeCompare(b.time ?? '99:99') || a.title.localeCompare(b.title));
  return { date, habits };
}

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
};
const hhmm = (min: number) => {
  const v = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
};

/** The reminder time for a moved occurrence: keep the same lead before the due time; with no due time, remind at the new time. */
export function shiftedReminder(dueTime: string | null, reminderTime: string | null, newTime: string): string | null {
  if (!reminderTime) return null;
  if (!dueTime) return newTime;
  return hhmm(minutes(newTime) - (minutes(dueTime) - minutes(reminderTime)));
}

/**
 * A one-day change to tomorrow's occurrence. The occurrence is created early to hold it (the materialiser's
 * INSERT OR IGNORE leaves it alone later); the repeat rule is untouched.
 */
export async function setTomorrow(
  env: Env,
  actor: UserRow,
  todoId: string,
  change: { action: 'keep' } | { action: 'skip' } | { action: 'time'; time: string },
  now: number,
) {
  const { todo, owner } = await editableTodo(env.DB, actor, todoId);
  if (todo.recurrence === 'none') throw badRequest('Only repeating todos have a tomorrow to change');
  const date = addDays(localDate(now, owner.timezone), 1);
  if (!occursOn(scheduleOf(todo), date)) throw badRequest("It isn't scheduled tomorrow");
  const paused = pausedOn(await loadPauses(env.DB, owner.id), date) ? 1 : 0;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO todo_instances (id, todo_id, user_id, date, status, paused, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
  )
    .bind(crypto.randomUUID(), todo.id, owner.id, date, paused, now)
    .run();
  let skipped = 0;
  let override: string | null = null;
  let reminder: number | null = paused ? null : reminderAt(date, todo.reminder_time, owner.timezone);
  if (change.action === 'skip') {
    skipped = 1;
    reminder = null;
  } else if (change.action === 'time') {
    override = change.time;
    const rt = shiftedReminder(todo.due_time, todo.reminder_time, change.time);
    reminder = paused ? null : reminderAt(date, rt, owner.timezone);
  }
  await env.DB.prepare(
    `UPDATE todo_instances SET skipped = ?, override_time = ?, reminder_at = ?, reminded_at = NULL
      WHERE todo_id = ? AND date = ? AND status != 'done'`,
  )
    .bind(skipped, override, reminder, todo.id, date)
    .run();
  return { date, skipped: skipped === 1, time: override };
}
