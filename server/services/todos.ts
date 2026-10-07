// Todo templates and their per-date instances.
import { occurrencesBetween, ruleFromColumns, ruleToColumns, type Recurrence } from '../../shared/recurrence';
import { addDays, localDate, maxDate, zonedToUtc } from '../../shared/time';
import type { TodoCreateInput, TodoUpdateInput } from '../../shared/schemas';
import { runBatch, type InstanceRow, type ProjectRow, type TodoRow, type UserRow } from '../db';
import type { Env } from '../env';
import { badRequest, notFound } from '../http';
import { deletePhotoObjects } from './photos';

/** How far back the materialiser will fill gaps (e.g. after nobody opened the app for a while). */
export const MAX_BACKFILL_DAYS = 366;

function reminderAt(date: string, reminderTime: string | null, timeZone: string): number | null {
  return reminderTime ? zonedToUtc(date, reminderTime, timeZone) : null;
}

export function scheduleOf(t: Pick<TodoRow, 'start_date' | 'end_date' | 'recurrence' | 'recurrence_weekdays' | 'recurrence_month_day'>) {
  return { rule: ruleFromColumns(t), startDate: t.start_date, endDate: t.end_date };
}

/** Statements that generate missing recurring instances up to `today` (inclusive). */
export function materializeStatements(db: D1Database, user: UserRow, todos: TodoRow[], today: string, now: number) {
  const stmts: D1PreparedStatement[] = [];
  for (const t of todos) {
    if (t.recurrence === 'none') continue;
    const from = t.materialized_through ? addDays(t.materialized_through, 1) : t.start_date;
    const lo = maxDate(from, addDays(today, -MAX_BACKFILL_DAYS));
    if (lo > today) continue;
    for (const d of occurrencesBetween(scheduleOf(t), lo, today)) {
      stmts.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO todo_instances (id, todo_id, user_id, date, status, reminder_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            crypto.randomUUID(),
            t.id,
            user.id,
            d,
            d < today ? 'missed' : 'pending',
            d === today ? reminderAt(d, t.reminder_time, user.timezone) : null,
            now,
          ),
      );
    }
    stmts.push(db.prepare('UPDATE todos SET materialized_through = ? WHERE id = ?').bind(today, t.id));
  }
  return stmts;
}

/**
 * Brings a user's recurring instances up to date: generates today's (and any gap) instances
 * and marks past pending recurring instances as missed. Idempotent; safe to call on every read.
 */
export async function materializeUser(db: D1Database, user: UserRow, now: number): Promise<string> {
  const today = localDate(now, user.timezone);
  const { results } = await db
    .prepare(
      `SELECT * FROM todos
        WHERE user_id = ? AND recurrence != 'none' AND start_date <= ?
          AND (materialized_through IS NULL OR materialized_through < ?)
          AND (end_date IS NULL OR materialized_through IS NULL OR materialized_through < end_date)`,
    )
    .bind(user.id, today, today)
    .all<TodoRow>();
  const stmts = materializeStatements(db, user, results, today, now);
  stmts.push(
    db
      .prepare(
        `UPDATE todo_instances SET status = 'missed'
          WHERE user_id = ? AND status = 'pending' AND date < ?
            AND todo_id IN (SELECT id FROM todos WHERE user_id = ? AND recurrence != 'none')`,
      )
      .bind(user.id, today, user.id),
  );
  await runBatch(db, stmts);
  return today;
}

async function assertOwnProject(db: D1Database, userId: string, projectId: string | null): Promise<void> {
  if (!projectId) return;
  const p = await db
    .prepare('SELECT id FROM projects WHERE id = ? AND user_id = ? AND archived_at IS NULL')
    .bind(projectId, userId)
    .first<Pick<ProjectRow, 'id'>>();
  if (!p) throw badRequest('That project does not exist');
}

function validateRule(rule: Recurrence): void {
  if (rule.type === 'weekly' && rule.weekdays.length === 0) throw badRequest('Pick at least one weekday');
}

export async function createTodo(
  env: Env,
  user: UserRow,
  input: TodoCreateInput,
  now: number,
  extra: { suggestedBy?: string | null } = {},
): Promise<string> {
  validateRule(input.recurrence);
  await assertOwnProject(env.DB, user.id, input.projectId);
  const id = crypto.randomUUID();
  const cols = ruleToColumns(input.recurrence);
  const today = localDate(now, user.timezone);
  const recurring = input.recurrence.type !== 'none';
  // Recurring history starts the day the todo is created: earlier dates are never backfilled as "missed".
  const materializedThrough = recurring ? addDays(maxDate(input.startDate, today), -1) : null;
  const row: TodoRow = {
    id,
    user_id: user.id,
    project_id: input.projectId,
    title: input.title,
    notes: input.notes,
    category: input.category,
    start_date: input.startDate,
    end_date: recurring ? input.endDate : null,
    due_time: input.dueTime,
    reminder_time: input.reminderTime,
    ...cols,
    is_private: input.isPrivate ? 1 : 0,
    suggested_by: extra.suggestedBy ?? null,
    materialized_through: materializedThrough,
    created_at: now,
    updated_at: now,
  };
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO todos (id, user_id, project_id, title, notes, category, start_date, end_date, due_time, reminder_time,
         recurrence, recurrence_weekdays, recurrence_month_day, is_private, suggested_by, materialized_through, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      row.id, row.user_id, row.project_id, row.title, row.notes, row.category, row.start_date, row.end_date,
      row.due_time, row.reminder_time, row.recurrence, row.recurrence_weekdays, row.recurrence_month_day,
      row.is_private, row.suggested_by, row.materialized_through, row.created_at, row.updated_at,
    ),
  ];
  if (!recurring) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO todo_instances (id, todo_id, user_id, date, status, reminder_at, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      ).bind(crypto.randomUUID(), id, user.id, input.startDate, reminderAt(input.startDate, input.reminderTime, user.timezone), now),
    );
  } else {
    stmts.push(...materializeStatements(env.DB, user, [row], today, now));
  }
  await env.DB.batch(stmts);
  return id;
}

export async function getOwnTodo(db: D1Database, userId: string, todoId: string): Promise<TodoRow> {
  const t = await db.prepare('SELECT * FROM todos WHERE id = ? AND user_id = ?').bind(todoId, userId).first<TodoRow>();
  if (!t) throw notFound('Todo not found');
  return t;
}

export async function updateTodo(env: Env, user: UserRow, todoId: string, patch: TodoUpdateInput, now: number) {
  const db = env.DB;
  const old = await getOwnTodo(db, user.id, todoId);
  if (patch.recurrence) validateRule(patch.recurrence);
  if (patch.projectId !== undefined) await assertOwnProject(db, user.id, patch.projectId);

  const rule = patch.recurrence ?? ruleFromColumns(old);
  const recurring = rule.type !== 'none';
  const next: TodoRow = {
    ...old,
    title: patch.title ?? old.title,
    notes: patch.notes ?? old.notes,
    category: patch.category ?? old.category,
    project_id: patch.projectId !== undefined ? patch.projectId : old.project_id,
    start_date: patch.startDate ?? old.start_date,
    end_date: recurring ? (patch.endDate !== undefined ? patch.endDate : old.end_date) : null,
    due_time: patch.dueTime !== undefined ? patch.dueTime : old.due_time,
    reminder_time: patch.reminderTime !== undefined ? patch.reminderTime : old.reminder_time,
    ...ruleToColumns(rule),
    is_private: patch.isPrivate !== undefined ? (patch.isPrivate ? 1 : 0) : old.is_private,
    updated_at: now,
  };
  if (next.end_date && next.end_date < next.start_date) throw badRequest('End date must be on or after the start date');

  const scheduleChanged =
    next.start_date !== old.start_date ||
    next.end_date !== old.end_date ||
    next.reminder_time !== old.reminder_time ||
    next.recurrence !== old.recurrence ||
    next.recurrence_weekdays !== old.recurrence_weekdays ||
    next.recurrence_month_day !== old.recurrence_month_day;

  const today = localDate(now, user.timezone);
  const stmts: D1PreparedStatement[] = [];
  const wasRecurring = old.recurrence !== 'none';

  if (scheduleChanged) {
    if (!recurring && !wasRecurring) {
      // One-off stays one-off: move its instance (keeping its status).
      stmts.push(
        db.prepare(
          `UPDATE OR IGNORE todo_instances SET date = ?, reminder_at = ?, reminded_at = NULL
            WHERE id = (SELECT id FROM todo_instances WHERE todo_id = ? ORDER BY date DESC LIMIT 1)`,
        ).bind(next.start_date, reminderAt(next.start_date, next.reminder_time, user.timezone), todoId),
      );
    } else if (!recurring) {
      // Recurring -> one-off: keep done/missed history, drop pending, add the single occurrence.
      stmts.push(db.prepare(`DELETE FROM todo_instances WHERE todo_id = ? AND status = 'pending'`).bind(todoId));
      stmts.push(
        db.prepare(
          `INSERT OR IGNORE INTO todo_instances (id, todo_id, user_id, date, status, reminder_at, created_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
        ).bind(crypto.randomUUID(), todoId, user.id, next.start_date, reminderAt(next.start_date, next.reminder_time, user.timezone), now),
      );
      next.materialized_through = null;
    } else {
      // Now recurring: regenerate from today on. Past instances (history) are untouched.
      stmts.push(
        db.prepare(
          `DELETE FROM todo_instances
            WHERE todo_id = ? AND status = 'pending' AND (date >= ? OR ? = 'none')
              AND id NOT IN (SELECT instance_id FROM photos WHERE instance_id IS NOT NULL)`,
        ).bind(todoId, today, old.recurrence),
      );
      next.materialized_through = addDays(maxDate(next.start_date, today), -1);
    }
  }

  stmts.push(
    db.prepare(
      `UPDATE todos SET project_id = ?, title = ?, notes = ?, category = ?, start_date = ?, end_date = ?, due_time = ?,
         reminder_time = ?, recurrence = ?, recurrence_weekdays = ?, recurrence_month_day = ?, is_private = ?,
         materialized_through = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
    ).bind(
      next.project_id, next.title, next.notes, next.category, next.start_date, next.end_date, next.due_time,
      next.reminder_time, next.recurrence, next.recurrence_weekdays, next.recurrence_month_day, next.is_private,
      next.materialized_through, now, todoId, user.id,
    ),
  );
  if (scheduleChanged && recurring) stmts.push(...materializeStatements(db, user, [next], today, now));
  await runBatch(db, stmts);
  return next;
}

export async function deleteTodo(env: Env, userId: string, todoId: string): Promise<void> {
  await getOwnTodo(env.DB, userId, todoId);
  const { results } = await env.DB.prepare('SELECT r2_key FROM photos WHERE todo_id = ?')
    .bind(todoId)
    .all<{ r2_key: string }>();
  await env.DB.prepare('DELETE FROM todos WHERE id = ? AND user_id = ?').bind(todoId, userId).run();
  await deletePhotoObjects(env, results.map((r) => r.r2_key));
}

export interface InstanceWithTodo extends InstanceRow {
  recurrence: TodoRow['recurrence'];
}

export async function getOwnInstance(db: D1Database, userId: string, instanceId: string): Promise<InstanceWithTodo> {
  const i = await db
    .prepare(
      `SELECT i.*, t.recurrence FROM todo_instances i JOIN todos t ON t.id = i.todo_id
        WHERE i.id = ? AND i.user_id = ?`,
    )
    .bind(instanceId, userId)
    .first<InstanceWithTodo>();
  if (!i) throw notFound('Todo not found');
  return i;
}

export async function completeInstance(env: Env, user: UserRow, instanceId: string, note: string, now: number) {
  const inst = await getOwnInstance(env.DB, user.id, instanceId);
  const today = localDate(now, user.timezone);
  if (inst.recurrence !== 'none' && inst.date > today) throw badRequest("You can't complete a future occurrence yet");
  await env.DB.prepare(
    `UPDATE todo_instances SET status = 'done', completed_at = ?, completed_on = ?, note = ? WHERE id = ?`,
  )
    .bind(now, today, note, instanceId)
    .run();
  return { ...inst, status: 'done' as const, completed_at: now, completed_on: today, note };
}

export async function uncompleteInstance(env: Env, user: UserRow, instanceId: string, now: number) {
  const inst = await getOwnInstance(env.DB, user.id, instanceId);
  const today = localDate(now, user.timezone);
  const status = inst.recurrence !== 'none' && inst.date < today ? 'missed' : 'pending';
  await env.DB.prepare(
    `UPDATE todo_instances SET status = ?, completed_at = NULL, completed_on = NULL WHERE id = ?`,
  )
    .bind(status, instanceId)
    .run();
  return { ...inst, status };
}

/** Recomputes reminder times of upcoming pending instances, e.g. after a time-zone change. */
export async function recomputeReminders(db: D1Database, user: UserRow, now: number): Promise<void> {
  const today = localDate(now, user.timezone);
  const { results } = await db
    .prepare(
      `SELECT i.id, i.date, t.reminder_time FROM todo_instances i JOIN todos t ON t.id = i.todo_id
        WHERE i.user_id = ? AND i.status = 'pending' AND i.date >= ? AND t.reminder_time IS NOT NULL`,
    )
    .bind(user.id, today)
    .all<{ id: string; date: string; reminder_time: string }>();
  await runBatch(
    db,
    results.map((r) =>
      db.prepare('UPDATE todo_instances SET reminder_at = ? WHERE id = ?').bind(zonedToUtc(r.date, r.reminder_time, user.timezone), r.id),
    ),
  );
}
