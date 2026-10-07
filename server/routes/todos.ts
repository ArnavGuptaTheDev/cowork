import { z } from 'zod';
import { canViewTodo } from '../../shared/authz';
import { habitStats } from '../../shared/streaks';
import {
  completeSchema,
  idSchema,
  projectCreateSchema,
  projectUpdateSchema,
  rangeQuerySchema,
  todoCreateSchema,
  todoUpdateSchema,
  whoSchema,
} from '../../shared/schemas';
import { addDays, localDate } from '../../shared/time';
import { photoDto, projectDto, publicUser, todoDto, type PhotoRow, type ProjectRow, type TodoRow } from '../db';
import { notFound, parse } from '../http';
import { getPartner, getUser, resolveTarget } from '../services/access';
import { notifyOnce } from '../services/notify';
import {
  completeInstance,
  createTodo,
  deleteTodo,
  getOwnTodo,
  materializeUser,
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

// --- Views (own or partner's, read-only for partners) ---

todoRoutes.get('/today', async (c) => {
  const { who } = query(c, whoSchema);
  const t = await resolveTarget(c.env.DB, c.get('user'), who);
  return c.json(await todayView(c.env.DB, t.owner, t.asPartner, c.get('now')));
});

todoRoutes.get('/range', async (c) => {
  const q = query(c, rangeQuerySchema);
  const t = await resolveTarget(c.env.DB, c.get('user'), q.who);
  return c.json(await rangeView(c.env.DB, t.owner, t.asPartner, q.from, q.to, c.get('now')));
});

todoRoutes.get('/habits', async (c) => {
  const { who } = query(c, whoSchema);
  const t = await resolveTarget(c.env.DB, c.get('user'), who);
  return c.json(await habitsView(c.env.DB, t.owner, t.asPartner, c.get('now')));
});

// --- Projects ---

todoRoutes.get('/projects', async (c) => {
  const q = query(c, whoSchema.extend({ archived: z.enum(['0', '1']).default('0') }));
  const t = await resolveTarget(c.env.DB, c.get('user'), q.who);
  return c.json({ projects: await projectsView(c.env.DB, t.owner, t.asPartner, q.archived === '1') });
});

todoRoutes.post('/projects', async (c) => {
  const input = await body(c, projectCreateSchema);
  const user = c.get('user');
  const now = c.get('now');
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO projects (id, user_id, name, description, category, color, is_private, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, user.id, input.name, input.description, input.category, input.color, input.isPrivate ? 1 : 0, now, now)
    .run();
  const row = await c.env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(id).first<ProjectRow>();
  return c.json({ project: projectDto(row!) }, 201);
});

todoRoutes.get('/projects/:id', async (c) => {
  const { who } = query(c, whoSchema);
  const t = await resolveTarget(c.env.DB, c.get('user'), who);
  return c.json(await projectView(c.env.DB, t.owner, t.asPartner, idParam(c.req.param('id')), c.get('now')));
});

todoRoutes.patch('/projects/:id', async (c) => {
  const id = idParam(c.req.param('id'));
  const input = await body(c, projectUpdateSchema);
  const user = c.get('user');
  const p = await c.env.DB.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').bind(id, user.id).first<ProjectRow>();
  if (!p) throw notFound('Project not found');
  const archivedAt = input.archived === undefined ? p.archived_at : input.archived ? (p.archived_at ?? c.get('now')) : null;
  await c.env.DB.prepare(
    `UPDATE projects SET name = ?, description = ?, category = ?, color = ?, is_private = ?, archived_at = ?, updated_at = ?
      WHERE id = ? AND user_id = ?`,
  )
    .bind(
      input.name ?? p.name,
      input.description ?? p.description,
      input.category ?? p.category,
      input.color ?? p.color,
      input.isPrivate === undefined ? p.is_private : input.isPrivate ? 1 : 0,
      archivedAt,
      c.get('now'),
      id,
      user.id,
    )
    .run();
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
  const row = await c.env.DB.prepare(
    `SELECT t.*, p.is_private AS project_private FROM todos t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = ?`,
  )
    .bind(id)
    .first<TodoRow & { project_private: number | null }>();
  if (!row) throw notFound('Todo not found');
  const owner = row.user_id === viewer.id ? viewer : await getUser(c.env.DB, row.user_id);
  if (
    !owner ||
    !canViewTodo(
      { id: viewer.id, partnerId: viewer.partner_id },
      { userId: row.user_id, isPrivate: row.is_private === 1, projectPrivate: row.project_private === 1 },
      owner.partner_id,
    )
  ) {
    throw notFound('Todo not found');
  }
  const now = c.get('now');
  const today = await materializeUser(c.env.DB, owner, now);
  const [project, photos, instances, suggester] = await Promise.all([
    row.project_id ? c.env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(row.project_id).first<ProjectRow>() : null,
    c.env.DB.prepare('SELECT * FROM photos WHERE todo_id = ? ORDER BY created_at').bind(id).all<PhotoRow>(),
    recentInstances(c.env.DB, id),
    row.suggested_by ? getUser(c.env.DB, row.suggested_by) : null,
  ]);
  const history = row.recurrence !== 'none' ? (await loadHistories(c.env.DB, [id], addDays(today, -400))).get(id) ?? [] : null;
  return c.json({
    todo: todoDto(row),
    canEdit: owner.id === viewer.id,
    today,
    project: project ? projectDto(project) : null,
    suggestedBy: suggester ? publicUser(suggester).name : null,
    photos: photos.results.map(photoDto),
    instances: instances.map((i) => ({ ...i, completedAt: i.completed_at })),
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

// --- Instances (checking things off) ---

todoRoutes.post('/instances/:id/complete', async (c) => {
  const user = c.get('user');
  const now = c.get('now');
  const { note } = await body(c, completeSchema);
  const inst = await completeInstance(c.env, user, idParam(c.req.param('id')), note, now);
  defer(
    c,
    (async () => {
      const partner = await getPartner(c.env.DB, user);
      if (!partner || !(await allDoneToday(c.env.DB, user, now))) return;
      const today = localDate(now, user.timezone);
      await notifyOnce(c.env, partner.id, 'partner_all_done', `${user.id}:${today}`, {
        title: `${publicUser(user).name} finished everything today 🎉`,
        body: 'Every todo for today is ticked off. Maybe send a cheer.',
        url: '/partner',
        tag: `all-done-${user.id}`,
      });
    })(),
  );
  return c.json({ instance: { id: inst.id, status: inst.status, completedAt: inst.completed_at } });
});

todoRoutes.post('/instances/:id/uncomplete', async (c) => {
  const inst = await uncompleteInstance(c.env, c.get('user'), idParam(c.req.param('id')), c.get('now'));
  return c.json({ instance: { id: inst.id, status: inst.status, completedAt: null } });
});
