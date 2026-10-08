// Statuses (settings), the status workflow (set status, blockers), boards, and tomorrow's habits.
import {
  boardMoveSchema,
  boardQuerySchema,
  changeFromTomorrowSchema,
  idSchema,
  setStatusSchema,
  statusCreateSchema,
  statusOrderSchema,
  statusUpdateSchema,
  tomorrowActionSchema,
} from '../../shared/schemas';
import { keyBetween } from '../../shared/fractional';
import { addDays, localDate } from '../../shared/time';
import { runBatch, type UserRow } from '../db';
import type { Env } from '../env';
import { badRequest, conflict, notFound, parse } from '../http';
import { editableTodo, getPartner, todoAccess } from '../services/access';
import { allWorkBoard, positionsOf, projectBoard } from '../services/board';
import { notifyOnce } from '../services/notify';
import { ensureStatuses, keepsRequiredKinds, statusDto, type StatusRow } from '../services/statuses';
import { actionableInstance, setInstanceStatus, updateTodo } from '../services/todos';
import { setTomorrow, tomorrowHabits } from '../services/tomorrow';
import { allDoneToday } from '../services/views';
import { publicUser } from '../db';
import { body, defer, query, router, syncCalendar } from './common';

export const workflowRoutes = router();

const idParam = (v: string | undefined) => parse(idSchema, v);

// ---------------------------------------------------------------- Statuses (settings)

async function ownStatus(db: D1Database, user: UserRow, id: string) {
  const list = await ensureStatuses(db, user.id);
  const s = list.find((x) => x.id === id);
  if (!s) throw notFound('Status not found');
  return { s, list };
}

/** Your statuses, or (with ?todoId) the statuses of that todo's owner when you can edit it. */
workflowRoutes.get('/statuses', async (c) => {
  const user = c.get('user');
  const todoId = c.req.query('todoId');
  let owner = user;
  if (todoId) {
    const a = await todoAccess(c.env.DB, user, parse(idSchema, todoId));
    if (!a) throw notFound('Todo not found');
    owner = a.owner;
  }
  const list = await ensureStatuses(c.env.DB, owner.id);
  const { results: usage } = await c.env.DB.prepare(
    'SELECT status_id, COUNT(*) AS n FROM todo_instances WHERE user_id = ? AND status_id IS NOT NULL GROUP BY status_id',
  )
    .bind(owner.id)
    .all<{ status_id: string; n: number }>();
  const used = new Map(usage.map((u) => [u.status_id, u.n]));
  return c.json({ ownerId: owner.id, statuses: list.map((s) => ({ ...statusDto(s), inUse: used.get(s.id) ?? 0 })) });
});

workflowRoutes.post('/statuses', async (c) => {
  const user = c.get('user');
  const input = await body(c, statusCreateSchema);
  const list = await ensureStatuses(c.env.DB, user.id);
  if (list.length >= 20) throw badRequest('Up to 20 statuses');
  const now = c.get('now');
  const id = crypto.randomUUID();
  const hasDefault = list.some((s) => s.kind === input.kind && s.is_default === 1 && s.archived_at === null);
  await c.env.DB.prepare(
    `INSERT INTO statuses (id, user_id, name, color, kind, position, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, user.id, input.name, input.color, input.kind, Math.max(0, ...list.map((s) => s.position)) + 1000, hasDefault ? 0 : 1, now, now)
    .run();
  return c.json({ id }, 201);
});

workflowRoutes.patch('/statuses/:id', async (c) => {
  const user = c.get('user');
  const { s, list } = await ownStatus(c.env.DB, user, idParam(c.req.param('id')));
  const input = await body(c, statusUpdateSchema);
  const now = c.get('now');
  const stmts: D1PreparedStatement[] = [];
  let archivedAt = s.archived_at;
  let isDefault = s.is_default;
  if (input.archived === true && s.archived_at === null) {
    if (!keepsRequiredKinds(list, s.id)) throw conflict('You always need at least one “to do” and one “done” status');
    archivedAt = now;
    if (s.is_default) {
      // Hand the default role to the next live status of the same kind, if there is one.
      const next = list.find((x) => x.id !== s.id && x.kind === s.kind && x.archived_at === null);
      if (next) stmts.push(c.env.DB.prepare('UPDATE statuses SET is_default = 1 WHERE id = ?').bind(next.id));
      isDefault = 0;
    }
  } else if (input.archived === false) {
    archivedAt = null;
    if (!list.some((x) => x.kind === s.kind && x.is_default === 1 && x.archived_at === null)) isDefault = 1;
  }
  if (input.isDefault) {
    if (archivedAt !== null) throw badRequest("An archived status can't be the default");
    stmts.push(c.env.DB.prepare('UPDATE statuses SET is_default = 0 WHERE user_id = ? AND kind = ?').bind(user.id, s.kind));
    isDefault = 1;
  }
  stmts.push(
    c.env.DB.prepare('UPDATE statuses SET name = ?, color = ?, archived_at = ?, is_default = ?, updated_at = ? WHERE id = ?').bind(
      input.name ?? s.name,
      input.color ?? s.color,
      archivedAt,
      isDefault,
      now,
      s.id,
    ),
  );
  await c.env.DB.batch(stmts);
  return c.json({ ok: true });
});

workflowRoutes.post('/statuses/order', async (c) => {
  const user = c.get('user');
  const { ids } = await body(c, statusOrderSchema);
  const list = await ensureStatuses(c.env.DB, user.id);
  if (ids.length !== list.length || ids.some((id) => !list.some((s) => s.id === id))) throw badRequest('Send every status exactly once');
  await runBatch(
    c.env.DB,
    ids.map((id, i) => c.env.DB.prepare('UPDATE statuses SET position = ?, updated_at = ? WHERE id = ? AND user_id = ?').bind((i + 1) * 1000, c.get('now'), id, user.id)),
  );
  return c.json({ ok: true });
});

/** Only unused statuses can be deleted; anything in use is archived instead. */
workflowRoutes.delete('/statuses/:id', async (c) => {
  const user = c.get('user');
  const { s, list } = await ownStatus(c.env.DB, user, idParam(c.req.param('id')));
  const used = await c.env.DB.prepare('SELECT 1 AS x FROM todo_instances WHERE status_id = ? LIMIT 1').bind(s.id).first();
  if (used) throw conflict('This status is in use. Archive it instead');
  if (s.is_default && s.archived_at === null && (s.kind === 'todo' || s.kind === 'done')) {
    throw conflict('This is the default for its kind. Make another one the default first');
  }
  if (s.archived_at === null && !keepsRequiredKinds(list, s.id)) throw conflict('You always need at least one “to do” and one “done” status');
  await c.env.DB.prepare('DELETE FROM statuses WHERE id = ?').bind(s.id).run();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- Status workflow

/** After a status change that completed something: the same follow-ups as ticking the checkbox. */
async function afterComplete(env: Env, actor: UserRow, now: number) {
  const partner = await getPartner(env.DB, actor);
  if (!partner || !(await allDoneToday(env.DB, actor, now))) return;
  const today = localDate(now, actor.timezone);
  await notifyOnce(env, partner.id, 'partner_all_done', `${actor.id}:${today}`, {
    title: `${publicUser(actor).name} finished everything today 🎉`,
    body: 'Every todo for today is ticked off. Maybe send a cheer.',
    url: '/partner',
    tag: `all-done-${actor.id}`,
  });
}

workflowRoutes.post('/instances/:id/status', async (c) => {
  const user = c.get('user');
  const now = c.get('now');
  const { statusId, blocker } = await body(c, setStatusSchema);
  const r = await setInstanceStatus(c.env, user, idParam(c.req.param('id')), statusId, blocker, now);
  if (r.completed) defer(c, afterComplete(c.env, user, now));
  syncCalendar(c, r.inst.todo_id);
  return c.json({ status: statusDto(r.status), completed: r.completed });
});

/** Blocker history for a todo (newest first). Visible wherever the todo is (never private ones to the partner). */
workflowRoutes.get('/todos/:id/blockers', async (c) => {
  const a = await todoAccess(c.env.DB, c.get('user'), idParam(c.req.param('id')));
  if (!a) throw notFound('Todo not found');
  const { results } = await c.env.DB.prepare(
    `SELECT b.id, b.note, b.blocked_at, b.resolved_at, b.instance_id, i.date FROM blockers b
       LEFT JOIN todo_instances i ON i.id = b.instance_id
      WHERE b.todo_id = ? ORDER BY b.blocked_at DESC LIMIT 50`,
  )
    .bind(a.todo.id)
    .all<{ id: string; note: string; blocked_at: number; resolved_at: number | null; instance_id: string | null; date: string | null }>();
  return c.json({
    blockers: results.map((b) => ({ id: b.id, note: b.note, blockedAt: b.blocked_at, resolvedAt: b.resolved_at, date: b.date, open: b.resolved_at === null })),
  });
});

// ---------------------------------------------------------------- Boards

workflowRoutes.get('/board', async (c) => {
  const q = query(c, boardQuerySchema);
  const user = c.get('user');
  const now = c.get('now');
  return c.json(q.projectId ? await projectBoard(c.env.DB, user, q.projectId, now) : await allWorkBoard(c.env.DB, user, q.category ?? null, now));
});

/**
 * A board drop: optionally a new status (column), and a new place in the manual order between two cards.
 * The order key is computed between the neighbours, so only the moved todo's row changes.
 */
workflowRoutes.post('/board/cards/:instanceId/move', async (c) => {
  const user = c.get('user');
  const now = c.get('now');
  const instanceId = idParam(c.req.param('instanceId'));
  const input = await body(c, boardMoveSchema);
  const { inst } = await actionableInstance(c.env.DB, user, instanceId);
  let status = null;
  let completed = false;
  if (input.statusId) {
    const r = await setInstanceStatus(c.env, user, instanceId, input.statusId, input.blocker, now);
    status = statusDto(r.status);
    completed = r.completed;
    if (completed) defer(c, afterComplete(c.env, user, now));
  }
  let position: string | null = null;
  if (input.beforeId !== null || input.afterId !== null) {
    const ids = [input.beforeId, input.afterId].filter((x): x is string => !!x && x !== inst.todo_id);
    for (const id of ids) if (!(await todoAccess(c.env.DB, user, id))) throw badRequest('Unknown neighbouring card');
    const rows = await positionsOf(c.env.DB, ids);
    const before = input.beforeId ? (rows.get(input.beforeId)?.position ?? null) : null;
    const after = input.afterId ? (rows.get(input.afterId)?.position ?? null) : null;
    try {
      position = keyBetween(before, after);
    } catch {
      throw conflict('The board changed. Reload and try again');
    }
    await c.env.DB.prepare('UPDATE todos SET position = ? WHERE id = ?').bind(position, inst.todo_id).run();
  }
  syncCalendar(c, inst.todo_id);
  return c.json({ status, completed, position });
});

// ---------------------------------------------------------------- Tomorrow's habits

workflowRoutes.get('/wrapup/tomorrow', async (c) => c.json(await tomorrowHabits(c.env.DB, c.get('user'), c.get('now'))));

/** Change tomorrow only: keep as planned, skip it, or move it to another time. */
workflowRoutes.post('/todos/:id/tomorrow', async (c) => {
  const change = await body(c, tomorrowActionSchema);
  return c.json(await setTomorrow(c.env, c.get('user'), idParam(c.req.param('id')), change, c.get('now')));
});

/** Change permanently, from tomorrow on: today's occurrence, past ones and streaks are untouched. */
workflowRoutes.post('/todos/:id/change-from-tomorrow', async (c) => {
  const user = c.get('user');
  const id = idParam(c.req.param('id'));
  const patch = await body(c, changeFromTomorrowSchema);
  const { todo, owner } = await editableTodo(c.env.DB, user, id);
  if (todo.recurrence === 'none') throw badRequest('Only repeating todos can be changed from tomorrow');
  const tomorrow = addDays(localDate(c.get('now'), owner.timezone), 1);
  const row = await updateTodo(c.env, user, id, patch, c.get('now'), { effectiveFrom: tomorrow });
  syncCalendar(c, id);
  return c.json({ ok: true, from: tomorrow, recurrence: patch.recurrence ?? null, todoId: row.id });
});

export type { StatusRow };
