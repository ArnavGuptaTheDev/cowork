// Time tracking: one running timer per user (its start lives in the database, so it survives reloads),
// manual entries, and totals per todo.
import { idSchema, timeEntryCreateSchema, timeEntryUpdateSchema } from '../../shared/schemas';
import { badRequest, notFound, parse } from '../http';
import { editableTodo, todoAccess } from '../services/access';
import { body, router } from './common';

export const timeRoutes = router();

const idParam = (v: string | undefined) => parse(idSchema, v);
const MAX_MS = 24 * 3600_000;

interface EntryRow {
  id: string;
  user_id: string;
  todo_id: string;
  started_at: number;
  ended_at: number | null;
  note: string;
}

const dto = (e: EntryRow, viewerId: string) => ({
  id: e.id,
  todoId: e.todo_id,
  userId: e.user_id,
  startedAt: e.started_at,
  endedAt: e.ended_at,
  note: e.note,
  mine: e.user_id === viewerId,
});

/** The running timer (or null), with its todo's title. */
timeRoutes.get('/timer', async (c) => {
  const user = c.get('user');
  const row = await c.env.DB.prepare(
    `SELECT te.*, t.title FROM time_entries te JOIN todos t ON t.id = te.todo_id WHERE te.user_id = ? AND te.ended_at IS NULL`,
  )
    .bind(user.id)
    .first<EntryRow & { title: string }>();
  return c.json({ timer: row ? { ...dto(row, user.id), todoTitle: row.title } : null });
});

timeRoutes.post('/todos/:id/timer/start', async (c) => {
  const user = c.get('user');
  const todoId = idParam(c.req.param('id'));
  await editableTodo(c.env.DB, user, todoId);
  const now = c.get('now');
  const id = crypto.randomUUID();
  // Starting a timer stops whatever was running (one timer per user; the unique index backs this up).
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE time_entries SET ended_at = MAX(?, started_at) WHERE user_id = ? AND ended_at IS NULL').bind(now, user.id),
    c.env.DB.prepare('INSERT INTO time_entries (id, user_id, todo_id, started_at, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, user.id, todoId, now, now),
  ]);
  return c.json({ id, startedAt: now }, 201);
});

timeRoutes.post('/timer/stop', async (c) => {
  const user = c.get('user');
  const now = c.get('now');
  const r = await c.env.DB.prepare(
    // Forgotten timers are capped at 24h so one slip doesn't wreck the weekly numbers.
    'UPDATE time_entries SET ended_at = MIN(MAX(?, started_at), started_at + ?) WHERE user_id = ? AND ended_at IS NULL',
  )
    .bind(now, MAX_MS, user.id)
    .run();
  if (!r.meta.changes) throw notFound('No timer is running');
  return c.json({ ok: true });
});

/** Entries on a todo: yours, plus your partner's if you can see the todo. Total in minutes. */
timeRoutes.get('/todos/:id/time', async (c) => {
  const user = c.get('user');
  const todoId = idParam(c.req.param('id'));
  const access = await todoAccess(c.env.DB, user, todoId);
  if (!access) throw notFound('Todo not found');
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM time_entries WHERE todo_id = ? AND (user_id = ? OR user_id = ?) ORDER BY started_at DESC LIMIT 200`,
  )
    .bind(todoId, user.id, access.isOwner ? (access.ownerPartnerId ?? '') : access.owner.id)
    .all<EntryRow>();
  const now = c.get('now');
  const minutes = Math.round(results.reduce((s, e) => s + ((e.ended_at ?? now) - e.started_at), 0) / 60_000);
  return c.json({ entries: results.map((e) => dto(e, user.id)), totalMinutes: minutes });
});

timeRoutes.post('/todos/:id/time', async (c) => {
  const user = c.get('user');
  const todoId = idParam(c.req.param('id'));
  await editableTodo(c.env.DB, user, todoId);
  const input = await body(c, timeEntryCreateSchema);
  if (input.endedAt > c.get('now') + 60_000) throw badRequest("Entries can't end in the future");
  const id = crypto.randomUUID();
  await c.env.DB.prepare('INSERT INTO time_entries (id, user_id, todo_id, started_at, ended_at, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, user.id, todoId, input.startedAt, input.endedAt, input.note, c.get('now'))
    .run();
  return c.json({ id }, 201);
});

timeRoutes.patch('/time-entries/:id', async (c) => {
  const user = c.get('user');
  const e = await c.env.DB.prepare('SELECT * FROM time_entries WHERE id = ? AND user_id = ?').bind(idParam(c.req.param('id')), user.id).first<EntryRow>();
  if (!e) throw notFound('Entry not found');
  const input = await body(c, timeEntryUpdateSchema);
  const startedAt = input.startedAt ?? e.started_at;
  const endedAt = input.endedAt ?? e.ended_at;
  if (endedAt !== null && endedAt < startedAt) throw badRequest('An entry must end after it starts');
  if (endedAt !== null && endedAt - startedAt > MAX_MS) throw badRequest('Entries are limited to 24 hours');
  await c.env.DB.prepare('UPDATE time_entries SET started_at = ?, ended_at = ?, note = ? WHERE id = ?')
    .bind(startedAt, endedAt, input.note ?? e.note, e.id)
    .run();
  return c.json({ ok: true });
});

timeRoutes.delete('/time-entries/:id', async (c) => {
  const r = await c.env.DB.prepare('DELETE FROM time_entries WHERE id = ? AND user_id = ?').bind(idParam(c.req.param('id')), c.get('user').id).run();
  if (!r.meta.changes) throw notFound('Entry not found');
  return c.json({ ok: true });
});
