import { z } from 'zod';
import { ruleFromColumns } from '../../shared/recurrence';
import { habitStats } from '../../shared/streaks';
import {
  completeSchema,
  idSchema,
  projectCreateSchema,
  projectUpdateSchema,
  rangeQuerySchema,
  rescheduleSchema,
  snoozeSchema,
  todoCreateSchema,
  todoUpdateSchema,
  whoSchema,
} from '../../shared/schemas';
import { addDays, localDate } from '../../shared/time';
import { photoDto, projectDto, publicUser, todoDto, type PhotoRow, type ProjectRow, type UserRow } from '../db';
import type { Env } from '../env';
import { badRequest, conflict, notFound, parse } from '../http';
import { getPartner, getUser, resolveTarget, todoAccess } from '../services/access';
import { notifyOnce } from '../services/notify';
import {
  completeInstance,
  createTodo,
  deleteTodo,
  getOwnTodo,
  materializeUser,
  rescheduleInstance,
  skipInstance,
  snoozeInstance,
  uncompleteInstance,
  updateTodo,
} from '../services/todos';
import {
  allDoneToday,
  habitsView,
  loadHistories,
  projectsView,
  projectView,
  rangeView,
  recentInstances,
  todayView,
} from '../services/views';
import { body, defer, query, router } from './common';

export const todoRoutes = router();

const idParam = (v: string | undefined) => parse(idSchema, v);

// --- Views (own or partner's; partners see the other's items read-only, shared items editable) ---

todoRoutes.get('/today', async (c) => {
  const { who } = query(c, whoSchema);
  const t = await resolveTarget(c.env.DB, c.get('user'), who);
  return c.json(await todayView(c.env.DB, t.owner, c.get('user'), c.get('now')));
});

todoRoutes.get('/range', async (c) => {
  const q = query(c, rangeQuerySchema);
  const t = await resolveTarget(c.env.DB, c.get('user'), q.who);
  return c.json(await rangeView(c.env.DB, t.owner, c.get('user'), q.from, q.to, c.get('now')));
});

todoRoutes.get('/habits', async (c) => {
  const { who } = query(c, whoSchema);
  const t = await resolveTarget(c.env.DB, c.get('user'), who);
  return c.json(await habitsView(c.env.DB, t.owner, c.get('user'), c.get('now')));
});

// --- Projects ---

todoRoutes.get('/projects', async (c) => {
  const q = query(c, whoSchema.extend({ archived: z.enum(['0', '1']).default('0') }));
  const t = await resolveTarget(c.env.DB, c.get('user'), q.who);
  return c.json({ projects: await projectsView(c.env.DB, t.owner, c.get('user'), q.archived === '1') });
});

todoRoutes.post('/projects', async (c) => {
  const input = await body(c, projectCreateSchema);
  const user = c.get('user');
  if (input.isShared && !(await getPartner(c.env.DB, user))) throw badRequest('Pair with your partner to share projects');
  const now = c.get('now');
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO projects (id, user_id, name, description, category, color, is_private, is_shared, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, user.id, input.name, input.description, input.category, input.color, input.isPrivate ? 1 : 0, input.isShared ? 1 : 0, now, now)
    .run();
  const row = await c.env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(id).first<ProjectRow>();
  return c.json({ project: projectDto(row!) }, 201);
});

todoRoutes.get('/projects/:id', async (c) => {
  return c.json(await projectView(c.env.DB, c.get('user'), idParam(c.req.param('id')), c.get('now')));
});

todoRoutes.patch('/projects/:id', async (c) => {
  const id = idParam(c.req.param('id'));
  const input = await body(c, projectUpdateSchema);
  const user = c.get('user');
  const p = await c.env.DB.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').bind(id, user.id).first<ProjectRow>();
  if (!p) throw notFound('Project not found');
  const isPrivate = input.isPrivate === undefined ? p.is_private : input.isPrivate ? 1 : 0;
  const isShared = input.isShared === undefined ? p.is_shared : input.isShared ? 1 : 0;
  if (isPrivate && isShared) throw badRequest('A project can be private or shared, not both');
  if (isShared && !p.is_shared) {
    if (!(await getPartner(c.env.DB, user))) throw badRequest('Pair with your partner to share projects');
    const priv = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM todos WHERE project_id = ? AND is_private = 1')
      .bind(id)
      .first<{ n: number }>();
    if (priv?.n) throw conflict(`This project has ${priv.n} private todo${priv.n > 1 ? 's' : ''}. Make them non-private or move them out first`);
  }
  const archivedAt = input.archived === undefined ? p.archived_at : input.archived ? (p.archived_at ?? c.get('now')) : null;
  await c.env.DB.prepare(
    `UPDATE projects SET name = ?, description = ?, category = ?, color = ?, is_private = ?, is_shared = ?, archived_at = ?, updated_at = ?
      WHERE id = ? AND user_id = ?`,
  )
    .bind(
      input.name ?? p.name,
      input.description ?? p.description,
      input.category ?? p.category,
      input.color ?? p.color,
      isPrivate,
      isShared,
      archivedAt,
      c.get('now'),
      id,
      user.id,
    )
    .run();
  if (p.is_shared && !isShared) {
    // Unsharing: the partner's todos in it move out (they keep them, without the project).
    await c.env.DB.prepare('UPDATE todos SET project_id = NULL WHERE project_id = ? AND user_id != ?').bind(id, user.id).run();
  }
  const row = await c.env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(id).first<ProjectRow>();
  return c.json({ project: projectDto(row!) });
});

todoRoutes.delete('/projects/:id', async (c) => {
  const id = idParam(c.req.param('id'));
  const r = await c.env.DB.prepare('DELETE FROM projects WHERE id = ? AND user_id = ?').bind(id, c.get('user').id).run();
  if (!r.meta.changes) throw notFound('Project not found');
  return c.json({ ok: true });
});

// --- Todos ---

todoRoutes.post('/todos', async (c) => {
  const input = await body(c, todoCreateSchema);
  const id = await createTodo(c.env, c.get('user'), input, c.get('now'));
  const row = await getOwnTodo(c.env.DB, c.get('user').id, id);
  return c.json({ todo: todoDto(row) }, 201);
});

/** Todo detail: visible to the owner, and to the partner unless private. */
todoRoutes.get('/todos/:id', async (c) => {
  const id = idParam(c.req.param('id'));
  const viewer = c.get('user');
  const access = await todoAccess(c.env.DB, viewer, id);
  if (!access) throw notFound('Todo not found');
  const { todo: row, owner } = access;
  const now = c.get('now');
  const today = await materializeUser(c.env.DB, owner, now);
  const [photos, instances, suggester] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM photos WHERE todo_id = ? ORDER BY created_at').bind(id).all<PhotoRow>(),
    recentInstances(c.env.DB, id),
    row.suggested_by ? getUser(c.env.DB, row.suggested_by) : null,
  ]);
  const history = row.recurrence !== 'none' ? (await loadHistories(c.env.DB, [id], addDays(today, -400))).get(id) ?? [] : null;
  return c.json({
    todo: { ...todoDto(row), isShared: access.shared },
    canEdit: access.canEdit,
    isOwner: access.isOwner,
    canComment: row.is_private === 0 && access.project?.is_private !== 1,
    today,
    project: access.project ? projectDto(access.project) : null,
    suggestedBy: suggester ? publicUser(suggester).name : null,
    photos: photos.results.map(photoDto),
    instances: instances.map((i) => ({ ...i, completedAt: i.completed_at, completedBy: i.completed_by })),
    stats: history ? habitStats(history, today) : null,
  });
});

todoRoutes.patch('/todos/:id', async (c) => {
  const id = idParam(c.req.param('id'));
  const input = await body(c, todoUpdateSchema);
  const row = await updateTodo(c.env, c.get('user'), id, input, c.get('now'));
  return c.json({ todo: todoDto(row) });
});

todoRoutes.delete('/todos/:id', async (c) => {
  await deleteTodo(c.env, c.get('user').id, idParam(c.req.param('id')));
  return c.json({ ok: true });
});

// --- Instances (checking things off, moving them) ---

/** Push the partner once when the actor has finished everything for their day. */
async function cheerIfAllDone(env: Env, actor: UserRow, now: number) {
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

todoRoutes.post('/instances/:id/complete', async (c) => {
  const user = c.get('user');
  const now = c.get('now');
  const { note } = await body(c, completeSchema);
  const { inst } = await completeInstance(c.env, user, idParam(c.req.param('id')), note, now);
  defer(c, cheerIfAllDone(c.env, user, now));
  return c.json({ instance: { id: inst.id, status: inst.status, completedAt: inst.completed_at, completedBy: inst.completed_by } });
});

todoRoutes.post('/instances/:id/uncomplete', async (c) => {
  const { inst } = await uncompleteInstance(c.env, c.get('user'), idParam(c.req.param('id')), c.get('now'));
  return c.json({ instance: { id: inst.id, status: inst.status, completedAt: null, completedBy: null } });
});

todoRoutes.post('/instances/:id/reschedule', async (c) => {
  const { date } = await body(c, rescheduleSchema);
  const { inst } = await rescheduleInstance(c.env, c.get('user'), idParam(c.req.param('id')), date, c.get('now'));
  return c.json({ instance: { id: inst.id, date: inst.date } });
});

/** "Tomorrow" in the owner's calendar (used by notification actions, which don't know the date). */
todoRoutes.post('/instances/:id/tomorrow', async (c) => {
  const user = c.get('user');
  const now = c.get('now');
  const id = idParam(c.req.param('id'));
  const inst = await c.env.DB.prepare('SELECT todo_id FROM todo_instances WHERE id = ?').bind(id).first<{ todo_id: string }>();
  const access = inst ? await todoAccess(c.env.DB, user, inst.todo_id) : null;
  if (!access) throw notFound('Todo not found');
  const tomorrow = addDays(localDate(now, access.owner.timezone), 1);
  const r = await rescheduleInstance(c.env, user, id, tomorrow, now);
  return c.json({ instance: { id: r.inst.id, date: r.inst.date } });
});

todoRoutes.post('/instances/:id/skip', async (c) => {
  await skipInstance(c.env, c.get('user'), idParam(c.req.param('id')));
  return c.json({ ok: true });
});

todoRoutes.post('/instances/:id/snooze', async (c) => {
  const { minutes } = await body(c, snoozeSchema);
  const at = await snoozeInstance(c.env, c.get('user'), idParam(c.req.param('id')), minutes, c.get('now'));
  return c.json({ reminderAt: at });
});

/** Todos the user can edit (their own and shared ones), for pickers like "save as template". */
todoRoutes.get('/todos', async (c) => {
  const user = c.get('user');
  const partner = await getPartner(c.env.DB, user);
  const { results } = await c.env.DB.prepare(
    `SELECT t.id, t.title, t.category, t.recurrence, t.recurrence_weekdays, t.recurrence_month_day, t.is_private, t.user_id,
            p.name AS project_name
       FROM todos t LEFT JOIN projects p ON p.id = t.project_id
      WHERE t.user_id = ? OR (t.user_id = ? AND (t.is_shared = 1 OR COALESCE(p.is_shared, 0) = 1))
      ORDER BY t.recurrence != 'none' DESC, t.created_at DESC
      LIMIT 300`,
  )
    .bind(user.id, partner?.id ?? '')
    .all<{ id: string; title: string; category: string; recurrence: 'none' | 'daily' | 'weekly' | 'monthly'; recurrence_weekdays: string | null; recurrence_month_day: number | null; is_private: number; user_id: string; project_name: string | null }>();
  return c.json({
    todos: results.map((t) => ({
      id: t.id,
      title: t.title,
      category: t.category,
      recurrence: ruleFromColumns(t),
      isPrivate: t.is_private === 1,
      ownerId: t.user_id,
      projectName: t.project_name,
    })),
  });
});
