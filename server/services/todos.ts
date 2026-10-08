// Todo templates and their per-date instances.
import { occurrencesBetween, ruleFromColumns, ruleToColumns, type Recurrence } from '../../shared/recurrence';
import { addDays, localDate, maxDate, zonedToUtc } from '../../shared/time';
import type { TodoCreateInput, TodoUpdateInput } from '../../shared/schemas';
import { runBatch, type InstanceRow, type ProjectRow, type TodoRow, type UserRow } from '../db';
import type { Env } from '../env';
import { badRequest, forbidden, notFound } from '../http';
import { editableTodo, getPartner, todoAccess, type TodoAccess } from './access';
import { loadPauses, pausedOn, type PauseRange } from './pause';
import { deletePhotoObjects } from './photos';
import { keyBetween } from '../../shared/fractional';
import { effectiveStatus, resolveTargetStatus, statusesFor, type StatusRow } from './statuses';

export type { TodoAccess };

/** Create input; the sharing fields are optional for internal callers (suggestions, templates). */
export type CreateTodoInput = Omit<TodoCreateInput, 'isShared' | 'assignee' | 'isJoint' | 'priority' | 'deadlineDate' | 'deadlineTime'> &
  Partial<Pick<TodoCreateInput, 'isShared' | 'assignee' | 'isJoint' | 'priority' | 'deadlineDate' | 'deadlineTime'>>;

/** A manual-order key after everything the user already has. */
export async function nextPosition(db: D1Database, userId: string): Promise<string> {
  const r = await db.prepare('SELECT MAX(position) AS p FROM todos WHERE user_id = ?').bind(userId).first<{ p: string | null }>();
  return keyBetween(r?.p ?? null, null);
}

/** How far back the materialiser will fill gaps (e.g. after nobody opened the app for a while). */
export const MAX_BACKFILL_DAYS = 366;

export function reminderAt(date: string, reminderTime: string | null, timeZone: string): number | null {
  return reminderTime ? zonedToUtc(date, reminderTime, timeZone) : null;
}

export function scheduleOf(t: Pick<TodoRow, 'start_date' | 'end_date' | 'recurrence' | 'recurrence_weekdays' | 'recurrence_month_day'>) {
  return { rule: ruleFromColumns(t), startDate: t.start_date, endDate: t.end_date };
}

/**
 * Statements that generate missing recurring instances up to `today` (inclusive).
 * Occurrences inside one of the user's pauses are created paused (never missed).
 */
export function materializeStatements(
  db: D1Database,
  user: UserRow,
  todos: TodoRow[],
  today: string,
  now: number,
  pauses: Pick<PauseRange, 'start_date' | 'end_date'>[] = [],
) {
  const stmts: D1PreparedStatement[] = [];
  for (const t of todos) {
    if (t.recurrence === 'none') continue;
    const from = t.materialized_through ? addDays(t.materialized_through, 1) : t.start_date;
    const lo = maxDate(from, addDays(today, -MAX_BACKFILL_DAYS));
    if (lo > today) continue;
    for (const d of occurrencesBetween(scheduleOf(t), lo, today)) {
      const paused = pausedOn(pauses, d);
      stmts.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO todo_instances (id, todo_id, user_id, date, status, reminder_at, paused, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            crypto.randomUUID(),
            t.id,
            user.id,
            d,
            d < today && !paused ? 'missed' : 'pending',
            d === today && !paused ? reminderAt(d, t.reminder_time, user.timezone) : null,
            paused ? 1 : 0,
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
  const pauses = results.length ? await loadPauses(db, user.id) : [];
  const stmts = materializeStatements(db, user, results, today, now, pauses);
  stmts.push(
    db
      .prepare(
        `UPDATE todo_instances SET status = 'missed'
          WHERE user_id = ? AND status = 'pending' AND date < ? AND paused = 0 AND skipped = 0
            AND todo_id IN (SELECT id FROM todos WHERE user_id = ? AND recurrence != 'none')`,
      )
      .bind(user.id, today, user.id),
  );
  await runBatch(db, stmts);
  return today;
}

/** A project the user may put todos in: their own, or their partner's shared project. */
export async function usableProject(db: D1Database, user: UserRow, projectId: string | null): Promise<ProjectRow | null> {
  if (!projectId) return null;
  const p = await db.prepare('SELECT * FROM projects WHERE id = ? AND archived_at IS NULL').bind(projectId).first<ProjectRow>();
  if (p && p.user_id === user.id) return p;
  if (p && p.is_shared === 1) {
    const partner = await getPartner(db, user);
    if (partner && partner.id === p.user_id) return p;
  }
  throw badRequest('That project does not exist');
}

/** Maps a creator-relative assignee ("me" / "partner" / "either") to a user id (null = either of us). */
function assigneeId(actor: UserRow, otherId: string | null, assignee: 'me' | 'partner' | 'either' | undefined): string | null {
  if (assignee === 'me') return actor.id;
  if (assignee === 'partner') return otherId;
  return null;
}

function validateRule(rule: Recurrence): void {
  if (rule.type === 'weekly' && rule.weekdays.length === 0) throw badRequest('Pick at least one weekday');
}

export async function createTodo(
  env: Env,
  user: UserRow,
  input: CreateTodoInput,
  now: number,
  extra: { suggestedBy?: string | null; id?: string } = {},
): Promise<string> {
  validateRule(input.recurrence);
  const project = await usableProject(env.DB, user, input.projectId);
  const shared = !!input.isShared || project?.is_shared === 1;
  const partner = shared ? await getPartner(env.DB, user) : null;
  if (input.isShared && !partner) throw badRequest('Pair with your partner to share todos');
  if (shared && input.isPrivate) throw badRequest('A todo can be private or shared, not both');
  if (input.isJoint && (!shared || input.recurrence.type === 'none')) {
    throw badRequest('Joint habits must be shared and repeating');
  }
  const id = extra.id ?? crypto.randomUUID();
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
    is_shared: input.isShared ? 1 : 0,
    assigned_to: shared && !input.isJoint ? assigneeId(user, partner?.id ?? null, input.assignee) : null,
    is_joint: input.isJoint ? 1 : 0,
    priority: input.priority ?? 2,
    deadline_date: input.deadlineDate ?? null,
    deadline_time: input.deadlineDate ? (input.deadlineTime ?? null) : null,
    position: await nextPosition(env.DB, user.id),
    suggested_by: extra.suggestedBy ?? null,
    materialized_through: materializedThrough,
    created_at: now,
    updated_at: now,
  };
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO todos (id, user_id, project_id, title, notes, category, start_date, end_date, due_time, reminder_time,
         recurrence, recurrence_weekdays, recurrence_month_day, is_private, is_shared, assigned_to, is_joint, priority,
         deadline_date, deadline_time, position, suggested_by, materialized_through, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      row.id, row.user_id, row.project_id, row.title, row.notes, row.category, row.start_date, row.end_date,
      row.due_time, row.reminder_time, row.recurrence, row.recurrence_weekdays, row.recurrence_month_day,
      row.is_private, row.is_shared, row.assigned_to, row.is_joint, row.priority, row.deadline_date, row.deadline_time,
      row.position, row.suggested_by, row.materialized_through, row.created_at, row.updated_at,
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
    stmts.push(...materializeStatements(env.DB, user, [row], today, now, await loadPauses(env.DB, user.id)));
  }
  await env.DB.batch(stmts);
  return id;
}

export async function getOwnTodo(db: D1Database, userId: string, todoId: string): Promise<TodoRow> {
  const t = await db.prepare('SELECT * FROM todos WHERE id = ? AND user_id = ?').bind(todoId, userId).first<TodoRow>();
  if (!t) throw notFound('Todo not found');
  return t;
}

/**
 * Edits a todo. The owner may change anything; on a shared todo the partner may change everything except
 * where it lives and who sees it (project, privacy, sharing). Schedules always follow the owner's time zone.
 */
export async function updateTodo(
  env: Env,
  editor: UserRow,
  todoId: string,
  patch: TodoUpdateInput,
  now: number,
  opts: { effectiveFrom?: string } = {},
) {
  const db = env.DB;
  const access = await editableTodo(db, editor, todoId);
  const { todo: old, owner } = access;
  if (!access.isOwner) {
    const ownerOnly =
      (patch.projectId !== undefined && patch.projectId !== old.project_id) ||
      (patch.isPrivate !== undefined && (patch.isPrivate ? 1 : 0) !== old.is_private) ||
      (patch.isShared !== undefined && (patch.isShared ? 1 : 0) !== old.is_shared) ||
      (patch.isJoint !== undefined && (patch.isJoint ? 1 : 0) !== old.is_joint);
    if (ownerOnly) throw forbidden('Only the person who created this todo can move it, share it or make it private');
  }
  if (patch.recurrence) validateRule(patch.recurrence);
  const project = patch.projectId !== undefined ? await usableProject(db, owner, patch.projectId) : access.project;
  const ownerPartner = await getPartner(db, owner);

  const rule = patch.recurrence ?? ruleFromColumns(old);
  const recurring = rule.type !== 'none';
  const isShared = patch.isShared !== undefined ? (patch.isShared ? 1 : 0) : old.is_shared;
  const isPrivate = patch.isPrivate !== undefined ? (patch.isPrivate ? 1 : 0) : old.is_private;
  const shared = isShared === 1 || project?.is_shared === 1;
  if (isShared === 1 && !ownerPartner) throw badRequest('Pair with your partner to share todos');
  if (shared && isPrivate === 1) throw badRequest('A todo can be private or shared, not both');
  const isJoint = patch.isJoint !== undefined ? (patch.isJoint ? 1 : 0) : old.is_joint;
  if (isJoint === 1 && (!shared || !recurring)) throw badRequest('Joint habits must be shared and repeating');

  // The assignee is relative to whoever is editing.
  let assignedTo = old.assigned_to;
  if (patch.assignee !== undefined) {
    const other = editor.id === owner.id ? (ownerPartner?.id ?? null) : owner.id;
    assignedTo = assigneeId(editor, other, patch.assignee);
  }
  if (!shared || isJoint === 1) assignedTo = null;

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
    is_private: isPrivate,
    is_shared: isShared,
    assigned_to: assignedTo,
    is_joint: isJoint,
    priority: patch.priority ?? old.priority,
    deadline_date: patch.deadlineDate !== undefined ? patch.deadlineDate : old.deadline_date,
    deadline_time: patch.deadlineTime !== undefined ? patch.deadlineTime : old.deadline_time,
    updated_at: now,
  };
  if (!next.deadline_date) next.deadline_time = null;
  if (next.end_date && next.end_date < next.start_date) throw badRequest('End date must be on or after the start date');

  const scheduleChanged =
    next.start_date !== old.start_date ||
    next.end_date !== old.end_date ||
    next.reminder_time !== old.reminder_time ||
    next.recurrence !== old.recurrence ||
    next.recurrence_weekdays !== old.recurrence_weekdays ||
    next.recurrence_month_day !== old.recurrence_month_day;

  const today = localDate(now, owner.timezone);
  // Schedule changes apply from today, or from a later day ("change permanently from tomorrow").
  const from = opts.effectiveFrom && opts.effectiveFrom > today ? opts.effectiveFrom : today;
  const stmts: D1PreparedStatement[] = [];
  const wasRecurring = old.recurrence !== 'none';

  if (scheduleChanged) {
    if (!recurring && !wasRecurring) {
      // One-off stays one-off: move its instance (keeping its status).
      stmts.push(
        db.prepare(
          `UPDATE OR IGNORE todo_instances SET date = ?, reminder_at = ?, reminded_at = NULL
            WHERE id = (SELECT id FROM todo_instances WHERE todo_id = ? ORDER BY date DESC LIMIT 1)`,
        ).bind(next.start_date, reminderAt(next.start_date, next.reminder_time, owner.timezone), todoId),
      );
    } else if (!recurring) {
      // Recurring -> one-off: keep done/missed history, drop pending, add the single occurrence.
      stmts.push(db.prepare(`DELETE FROM todo_instances WHERE todo_id = ? AND status = 'pending'`).bind(todoId));
      stmts.push(
        db.prepare(
          `INSERT OR IGNORE INTO todo_instances (id, todo_id, user_id, date, status, reminder_at, created_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
        ).bind(crypto.randomUUID(), todoId, owner.id, next.start_date, reminderAt(next.start_date, next.reminder_time, owner.timezone), now),
      );
      next.materialized_through = null;
    } else {
      // Now recurring: regenerate from today on. Past instances (history) are untouched.
      stmts.push(
        db.prepare(
          `DELETE FROM todo_instances
            WHERE todo_id = ? AND status = 'pending' AND (date >= ? OR ? = 'none')
              AND id NOT IN (SELECT instance_id FROM photos WHERE instance_id IS NOT NULL)`,
        ).bind(todoId, from, old.recurrence),
      );
      next.materialized_through = addDays(maxDate(next.start_date, from), -1);
    }
  }

  stmts.push(
    db.prepare(
      `UPDATE todos SET project_id = ?, title = ?, notes = ?, category = ?, start_date = ?, end_date = ?, due_time = ?,
         reminder_time = ?, recurrence = ?, recurrence_weekdays = ?, recurrence_month_day = ?, is_private = ?,
         is_shared = ?, assigned_to = ?, is_joint = ?, priority = ?, deadline_date = ?, deadline_time = ?,
         materialized_through = ?, updated_at = ?
       WHERE id = ?`,
    ).bind(
      next.project_id, next.title, next.notes, next.category, next.start_date, next.end_date, next.due_time,
      next.reminder_time, next.recurrence, next.recurrence_weekdays, next.recurrence_month_day, next.is_private,
      next.is_shared, next.assigned_to, next.is_joint, next.priority, next.deadline_date, next.deadline_time,
      next.materialized_through, now, todoId,
    ),
  );
  if (scheduleChanged && recurring) stmts.push(...materializeStatements(db, owner, [next], today, now, await loadPauses(db, owner.id)));
  await runBatch(db, stmts);
  return next;
}

/** Only the creator deletes a todo, shared or not. */
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

async function loadInstance(db: D1Database, instanceId: string): Promise<InstanceWithTodo> {
  const inst = await db
    .prepare(`SELECT i.*, t.recurrence FROM todo_instances i JOIN todos t ON t.id = i.todo_id WHERE i.id = ?`)
    .bind(instanceId)
    .first<InstanceWithTodo>();
  if (!inst) throw notFound('Todo not found');
  return inst;
}

/** An instance the actor may act on (their own, or one of a shared todo), with the todo's access info. */
export async function actionableInstance(db: D1Database, actor: UserRow, instanceId: string) {
  const inst = await loadInstance(db, instanceId);
  const access = await todoAccess(db, actor, inst.todo_id);
  if (!access || !access.canEdit) throw notFound('Todo not found');
  return { inst, access };
}

/** An instance the viewer can see (reactions, nudges). */
export async function visibleInstance(db: D1Database, viewer: UserRow, instanceId: string) {
  const inst = await loadInstance(db, instanceId);
  const access = await todoAccess(db, viewer, inst.todo_id);
  if (!access) throw notFound('Todo not found');
  return { inst, access };
}

export async function completeInstance(env: Env, actor: UserRow, instanceId: string, note: string, now: number) {
  const { inst, access } = await actionableInstance(env.DB, actor, instanceId);
  const today = localDate(now, access.owner.timezone);
  if (inst.recurrence !== 'none' && inst.date > today) throw badRequest("You can't complete a future occurrence yet");
  if (access.todo.is_joint === 1 && access.shared) {
    // Joint habit: record this person's half; it's done only once both partners have.
    await env.DB.prepare('INSERT OR IGNORE INTO instance_completions (instance_id, user_id, completed_at) VALUES (?, ?, ?)')
      .bind(instanceId, actor.id, now)
      .run();
    const both = await env.DB.prepare('SELECT COUNT(*) AS n FROM instance_completions WHERE instance_id = ?')
      .bind(instanceId)
      .first<{ n: number }>();
    if ((both?.n ?? 0) < 2) {
      return { inst: { ...inst, completed_by: null }, access, joint: { waiting: true } };
    }
  }
  // Done: the status becomes the default done-kind status (NULL = default) and any open blocker closes.
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE todo_instances SET status = 'done', completed_at = ?, completed_on = ?, completed_by = ?, note = ?, status_id = NULL
        WHERE id = ?`,
    ).bind(now, today, actor.id, note, instanceId),
    env.DB.prepare('UPDATE blockers SET resolved_at = ?, resolved_by = ? WHERE instance_id = ? AND resolved_at IS NULL').bind(now, actor.id, instanceId),
  ]);
  return {
    inst: { ...inst, status: 'done' as const, completed_at: now, completed_on: today, completed_by: actor.id, note },
    access,
  };
}

export async function uncompleteInstance(env: Env, actor: UserRow, instanceId: string, now: number) {
  const { inst, access } = await actionableInstance(env.DB, actor, instanceId);
  const today = localDate(now, access.owner.timezone);
  const status = inst.recurrence !== 'none' && inst.date < today && inst.paused !== 1 ? 'missed' : 'pending';
  await env.DB.batch([
    env.DB.prepare('DELETE FROM instance_completions WHERE instance_id = ? AND user_id = ?').bind(instanceId, actor.id),
    // Unticking returns to the default todo-kind status.
    env.DB.prepare(
      `UPDATE todo_instances SET status = ?, completed_at = NULL, completed_on = NULL, completed_by = NULL, status_id = NULL
        WHERE id = ?`,
    ).bind(status, instanceId),
  ]);
  return { inst: { ...inst, status }, access };
}

/**
 * Sets an instance's status. Done-kind completes it exactly like the checkbox (streaks, pushes, calendar);
 * blocked-kind needs a note and opens a blocker; leaving blocked closes the blocker (history is kept).
 */
export async function setInstanceStatus(env: Env, actor: UserRow, instanceId: string, statusId: string, blockerNote: string | undefined, now: number) {
  const { inst, access } = await actionableInstance(env.DB, actor, instanceId);
  const target = await resolveTargetStatus(env.DB, access.owner, actor, statusId);
  const list = (await statusesFor(env.DB, [access.owner.id])).get(access.owner.id)!;
  const current = effectiveStatus(list, inst.status_id, inst.status === 'done');
  const note = blockerNote?.trim();

  if (target.kind === 'done') {
    const r = await completeInstance(env, actor, instanceId, inst.note, now);
    if (r.inst.status === 'done' && target.is_default !== 1) {
      await env.DB.prepare('UPDATE todo_instances SET status_id = ? WHERE id = ?').bind(target.id, instanceId).run();
    }
    return { inst: r.inst, access, status: target, completed: r.inst.status === 'done', previous: current };
  }
  if (target.kind === 'blocked' && !note && current?.kind !== 'blocked') throw badRequest('Say what it is waiting on');
  if (inst.status === 'done') await uncompleteInstance(env, actor, instanceId, now);

  const stmts: D1PreparedStatement[] = [
    env.DB.prepare('UPDATE todo_instances SET status_id = ? WHERE id = ?').bind(target.id, instanceId),
  ];
  const wasBlocked = current?.kind === 'blocked';
  if (wasBlocked && (target.kind !== 'blocked' || note)) {
    stmts.push(env.DB.prepare('UPDATE blockers SET resolved_at = ?, resolved_by = ? WHERE instance_id = ? AND resolved_at IS NULL').bind(now, actor.id, instanceId));
  }
  if (target.kind === 'blocked' && note) {
    stmts.push(
      env.DB.prepare('INSERT INTO blockers (id, todo_id, instance_id, note, blocked_at, blocked_by) VALUES (?, ?, ?, ?, ?, ?)').bind(
        crypto.randomUUID(),
        inst.todo_id,
        instanceId,
        note,
        now,
        actor.id,
      ),
    );
  }
  await env.DB.batch(stmts);
  return { inst, access, status: target, completed: false, previous: current };
}

export type { StatusRow };

/** Moves a pending one-off todo to another day (wrap-up, calendar drag, the notification's "Tomorrow"). */
export async function rescheduleInstance(env: Env, actor: UserRow, instanceId: string, date: string, now: number) {
  const { inst, access } = await actionableInstance(env.DB, actor, instanceId);
  if (inst.recurrence !== 'none') throw badRequest('Repeating todos follow their schedule. Edit the todo to change it');
  if (inst.status === 'done') throw badRequest('That one is already done');
  const reminder = reminderAt(date, access.todo.reminder_time, access.owner.timezone);
  await env.DB.batch([
    env.DB.prepare(`UPDATE todo_instances SET date = ?, reminder_at = ?, reminded_at = NULL WHERE id = ?`).bind(date, reminder, instanceId),
    env.DB.prepare(`UPDATE todos SET start_date = ?, updated_at = ? WHERE id = ?`).bind(date, now, inst.todo_id),
  ]);
  return { inst: { ...inst, date }, access };
}

/** Skips an open occurrence of a repeating todo (marks it missed). */
export async function skipInstance(env: Env, actor: UserRow, instanceId: string) {
  const { inst } = await actionableInstance(env.DB, actor, instanceId);
  if (inst.recurrence === 'none') throw badRequest('Only repeating todos can be skipped');
  if (inst.status !== 'pending') throw badRequest('Only open todos can be skipped');
  await env.DB.prepare(`UPDATE todo_instances SET status = 'missed' WHERE id = ?`).bind(instanceId).run();
}

/** Pushes an instance's reminder later (the notification's "Snooze"). */
export async function snoozeInstance(env: Env, actor: UserRow, instanceId: string, minutes: number, now: number) {
  const { inst } = await actionableInstance(env.DB, actor, instanceId);
  if (inst.status !== 'pending') throw badRequest('Only open todos can be snoozed');
  const at = now + minutes * 60_000;
  await env.DB.prepare(`UPDATE todo_instances SET reminder_at = ?, reminded_at = NULL WHERE id = ?`).bind(at, instanceId).run();
  return at;
}

/** Recomputes reminder times of upcoming pending instances, e.g. after a time-zone change. */
export async function recomputeReminders(db: D1Database, user: UserRow, now: number): Promise<void> {
  const today = localDate(now, user.timezone);
  const { results } = await db
    .prepare(
      `SELECT i.id, i.date, t.reminder_time FROM todo_instances i JOIN todos t ON t.id = i.todo_id
        WHERE i.user_id = ? AND i.status = 'pending' AND i.paused = 0 AND i.date >= ? AND t.reminder_time IS NOT NULL`,
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
