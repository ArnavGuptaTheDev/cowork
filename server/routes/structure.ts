// Phase 2: subtasks, templates, shared goals, pause mode, weekly review, photo timeline.
import { canViewTodo } from '../../shared/authz';
import { ruleFromColumns } from '../../shared/recurrence';
import {
  goalCreateSchema,
  goalLinkSchema,
  goalUpdateSchema,
  idSchema,
  pauseCreateSchema,
  photoFeedQuerySchema,
  reviewQuerySchema,
  subtaskCheckSchema,
  subtaskCreateSchema,
  subtaskOrderSchema,
  subtaskUpdateSchema,
  templateApplySchema,
  templateCreateSchema,
  templateUpdateSchema,
} from '../../shared/schemas';
import { addDays, dateRange, localDate, maxDate, startOfWeek } from '../../shared/time';
import { photoDto, placeholders, runBatch, type Category, type PhotoRow, type TodoRow, type UserRow } from '../db';
import { badRequest, forbidden, notFound, parse } from '../http';
import { editableTodo, getPartner, todoAccess } from '../services/access';
import { loadPauses } from '../services/pause';
import { reviewFor } from '../services/review';
import { createTodo } from '../services/todos';
import { body, query, router } from './common';

export const structureRoutes = router();

const idParam = (v: string | undefined) => parse(idSchema, v);

// ---------------------------------------------------------------- Subtasks

interface SubtaskRow {
  id: string;
  todo_id: string;
  title: string;
  position: number;
}

async function subtaskForEdit(db: D1Database, user: UserRow, id: string) {
  const s = await db.prepare('SELECT * FROM subtasks WHERE id = ?').bind(id).first<SubtaskRow>();
  if (!s) throw notFound('Subtask not found');
  const access = await editableTodo(db, user, s.todo_id);
  return { s, access };
}

structureRoutes.get('/todos/:id/subtasks', async (c) => {
  const todoId = idParam(c.req.param('id'));
  const access = await todoAccess(c.env.DB, c.get('user'), todoId);
  if (!access) throw notFound('Todo not found');
  const instanceId = c.req.query('instanceId');
  if (instanceId) parse(idSchema, instanceId);
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.title, s.position,
            EXISTS (SELECT 1 FROM subtask_checks sc WHERE sc.subtask_id = s.id AND sc.instance_id = ?) AS done
       FROM subtasks s WHERE s.todo_id = ? ORDER BY s.position, s.created_at`,
  )
    .bind(instanceId ?? '', todoId)
    .all<{ id: string; title: string; position: number; done: number }>();
  return c.json({ subtasks: results.map((r) => ({ id: r.id, title: r.title, position: r.position, done: r.done === 1 })), canEdit: access.canEdit });
});

structureRoutes.post('/todos/:id/subtasks', async (c) => {
  const todoId = idParam(c.req.param('id'));
  await editableTodo(c.env.DB, c.get('user'), todoId);
  const { title } = await body(c, subtaskCreateSchema);
  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(position), -1) AS maxPos FROM subtasks WHERE todo_id = ?')
    .bind(todoId)
    .first<{ n: number; maxPos: number }>();
  if ((count?.n ?? 0) >= 50) throw badRequest('Up to 50 subtasks per todo');
  const id = crypto.randomUUID();
  const now = c.get('now');
  await c.env.DB.prepare('INSERT INTO subtasks (id, todo_id, title, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, todoId, title, (count?.maxPos ?? -1) + 1, now, now)
    .run();
  return c.json({ id }, 201);
});

structureRoutes.patch('/subtasks/:id', async (c) => {
  const { s } = await subtaskForEdit(c.env.DB, c.get('user'), idParam(c.req.param('id')));
  const { title } = await body(c, subtaskUpdateSchema);
  await c.env.DB.prepare('UPDATE subtasks SET title = ?, updated_at = ? WHERE id = ?').bind(title, c.get('now'), s.id).run();
  return c.json({ ok: true });
});

structureRoutes.delete('/subtasks/:id', async (c) => {
  const { s } = await subtaskForEdit(c.env.DB, c.get('user'), idParam(c.req.param('id')));
  await c.env.DB.prepare('DELETE FROM subtasks WHERE id = ?').bind(s.id).run();
  return c.json({ ok: true });
});

structureRoutes.post('/todos/:id/subtasks/order', async (c) => {
  const todoId = idParam(c.req.param('id'));
  await editableTodo(c.env.DB, c.get('user'), todoId);
  const { ids } = await body(c, subtaskOrderSchema);
  const { results } = await c.env.DB.prepare('SELECT id FROM subtasks WHERE todo_id = ?').bind(todoId).all<{ id: string }>();
  const own = new Set(results.map((r) => r.id));
  if (ids.length !== own.size || ids.some((id) => !own.has(id))) throw badRequest('Send every subtask of this todo exactly once');
  await runBatch(
    c.env.DB,
    ids.map((id, i) => c.env.DB.prepare('UPDATE subtasks SET position = ? WHERE id = ?').bind(i, id)),
  );
  return c.json({ ok: true });
});

/** Ticks a subtask for one occurrence; repeating todos start every occurrence with a clean list. */
structureRoutes.post('/subtasks/:id/check', async (c) => {
  const user = c.get('user');
  const { s } = await subtaskForEdit(c.env.DB, user, idParam(c.req.param('id')));
  const { instanceId, done } = await body(c, subtaskCheckSchema);
  const inst = await c.env.DB.prepare('SELECT todo_id FROM todo_instances WHERE id = ?').bind(instanceId).first<{ todo_id: string }>();
  if (!inst || inst.todo_id !== s.todo_id) throw badRequest('That occurrence belongs to another todo');
  if (done) {
    await c.env.DB.prepare('INSERT OR IGNORE INTO subtask_checks (subtask_id, instance_id, checked_by, checked_at) VALUES (?, ?, ?, ?)')
      .bind(s.id, instanceId, user.id, c.get('now'))
      .run();
  } else {
    await c.env.DB.prepare('DELETE FROM subtask_checks WHERE subtask_id = ? AND instance_id = ?').bind(s.id, instanceId).run();
  }
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- Templates

interface TemplateRow {
  id: string;
  user_id: string;
  name: string;
  is_shared: number;
  created_at: number;
}
interface TemplateItemRow {
  id: string;
  template_id: string;
  position: number;
  title: string;
  notes: string;
  category: Category;
  due_time: string | null;
  reminder_time: string | null;
  recurrence: TodoRow['recurrence'];
  recurrence_weekdays: string | null;
  recurrence_month_day: number | null;
  subtasks: string;
  is_private: number;
}

/** Templates the user can see: their own, and the partner's shared ones (minus private items). */
async function visibleTemplates(db: D1Database, user: UserRow) {
  const partner = await getPartner(db, user);
  const { results } = await db
    .prepare('SELECT * FROM templates WHERE user_id = ? OR (user_id = ? AND is_shared = 1) ORDER BY created_at DESC')
    .bind(user.id, partner?.id ?? '')
    .all<TemplateRow>();
  if (!results.length) return [];
  const { results: items } = await db
    .prepare(`SELECT * FROM template_items WHERE template_id IN (${placeholders(results.length)}) ORDER BY position`)
    .bind(...results.map((t) => t.id))
    .all<TemplateItemRow>();
  return results.map((t) => {
    const mine = t.user_id === user.id;
    return {
      id: t.id,
      name: t.name,
      isShared: t.is_shared === 1,
      mine,
      ownerId: t.user_id,
      createdAt: t.created_at,
      items: items
        .filter((i) => i.template_id === t.id && (mine || i.is_private === 0))
        .map((i) => ({
          id: i.id,
          title: i.title,
          notes: i.notes,
          category: i.category,
          dueTime: i.due_time,
          reminderTime: i.reminder_time,
          recurrence: ruleFromColumns(i),
          subtasks: JSON.parse(i.subtasks) as string[],
          isPrivate: i.is_private === 1,
        })),
    };
  });
}

structureRoutes.get('/templates', async (c) => c.json({ templates: await visibleTemplates(c.env.DB, c.get('user')) }));

structureRoutes.post('/templates', async (c) => {
  const user = c.get('user');
  const input = await body(c, templateCreateSchema);
  if (input.isShared && !(await getPartner(c.env.DB, user))) throw badRequest('Pair with your partner to share templates');
  const todos: TodoRow[] = [];
  for (const id of [...new Set(input.todoIds)]) {
    const a = await todoAccess(c.env.DB, user, id);
    if (!a || !a.canEdit) throw notFound('Todo not found');
    todos.push(a.todo);
  }
  const { results: subs } = await c.env.DB.prepare(
    `SELECT todo_id, title FROM subtasks WHERE todo_id IN (${placeholders(todos.length)}) ORDER BY position`,
  )
    .bind(...todos.map((t) => t.id))
    .all<{ todo_id: string; title: string }>();
  const now = c.get('now');
  const id = crypto.randomUUID();
  await runBatch(c.env.DB, [
    c.env.DB.prepare('INSERT INTO templates (id, user_id, name, is_shared, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind(
      id,
      user.id,
      input.name,
      input.isShared ? 1 : 0,
      now,
      now,
    ),
    ...todos.map((t, i) =>
      c.env.DB.prepare(
        `INSERT INTO template_items (id, template_id, position, title, notes, category, due_time, reminder_time, recurrence,
           recurrence_weekdays, recurrence_month_day, subtasks, is_private)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(), id, i, t.title, t.notes, t.category, t.due_time, t.reminder_time, t.recurrence,
        t.recurrence_weekdays, t.recurrence_month_day,
        JSON.stringify(subs.filter((s) => s.todo_id === t.id).map((s) => s.title)),
        t.is_private,
      ),
    ),
  ]);
  return c.json({ id }, 201);
});

structureRoutes.patch('/templates/:id', async (c) => {
  const user = c.get('user');
  const id = idParam(c.req.param('id'));
  const input = await body(c, templateUpdateSchema);
  const t = await c.env.DB.prepare('SELECT * FROM templates WHERE id = ? AND user_id = ?').bind(id, user.id).first<TemplateRow>();
  if (!t) throw notFound('Template not found');
  if (input.isShared && !(await getPartner(c.env.DB, user))) throw badRequest('Pair with your partner to share templates');
  await c.env.DB.prepare('UPDATE templates SET name = ?, is_shared = ?, updated_at = ? WHERE id = ?')
    .bind(input.name ?? t.name, input.isShared === undefined ? t.is_shared : input.isShared ? 1 : 0, c.get('now'), id)
    .run();
  return c.json({ ok: true });
});

structureRoutes.delete('/templates/:id', async (c) => {
  const r = await c.env.DB.prepare('DELETE FROM templates WHERE id = ? AND user_id = ?').bind(idParam(c.req.param('id')), c.get('user').id).run();
  if (!r.meta.changes) throw notFound('Template not found');
  return c.json({ ok: true });
});

/** Creates a todo (with subtasks) for every item, starting on `startDate`, optionally into a project. */
structureRoutes.post('/templates/:id/apply', async (c) => {
  const user = c.get('user');
  const id = idParam(c.req.param('id'));
  const { startDate, projectId } = await body(c, templateApplySchema);
  const tpl = (await visibleTemplates(c.env.DB, user)).find((t) => t.id === id);
  if (!tpl) throw notFound('Template not found');
  if (!tpl.items.length) throw badRequest('This template has nothing to add');
  const now = c.get('now');
  const created: string[] = [];
  for (const item of tpl.items) {
    const todoId = await createTodo(
      c.env,
      user,
      {
        title: item.title,
        notes: item.notes,
        category: item.category,
        startDate,
        endDate: null,
        dueTime: item.dueTime,
        reminderTime: item.reminderTime,
        recurrence: item.recurrence,
        projectId,
        // Only the template's owner ever sees its private items, and they stay private.
        isPrivate: tpl.mine && item.isPrivate,
      },
      now,
    );
    created.push(todoId);
    if (item.subtasks.length) {
      await runBatch(
        c.env.DB,
        item.subtasks.slice(0, 50).map((title, i) =>
          c.env.DB.prepare('INSERT INTO subtasks (id, todo_id, title, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind(
            crypto.randomUUID(),
            todoId,
            title,
            i,
            now,
            now,
          ),
        ),
      );
    }
  }
  return c.json({ created: created.length, todoIds: created });
});

// ---------------------------------------------------------------- Shared goals

interface GoalRow {
  id: string;
  created_by: string;
  title: string;
  target_per_person: number;
  created_at: number;
}

/** Completions by `userId` of todo `todoId` in their current week (joint check-ins count too). */
async function weekProgress(db: D1Database, user: UserRow, todoId: string, now: number): Promise<number> {
  const start = startOfWeek(localDate(now, user.timezone));
  const r = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM todo_instances i
        WHERE i.todo_id = ? AND i.date BETWEEN ? AND ?
          AND ((i.status = 'done' AND COALESCE(i.completed_by, i.user_id) = ?)
               OR EXISTS (SELECT 1 FROM instance_completions ic WHERE ic.instance_id = i.id AND ic.user_id = ?))`,
    )
    .bind(todoId, start, addDays(start, 6), user.id, user.id)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

async function linkableTodo(db: D1Database, user: UserRow, todoId: string) {
  const a = await todoAccess(db, user, todoId);
  if (!a || !a.canEdit) throw notFound('Todo not found');
  if (a.todo.is_private || a.project?.is_private) throw badRequest("Private todos can't count towards a shared goal");
  return a;
}

structureRoutes.get('/goals', async (c) => {
  const user = c.get('user');
  const now = c.get('now');
  const partner = await getPartner(c.env.DB, user);
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM goals WHERE (created_by = ? OR created_by = ?) AND archived_at IS NULL ORDER BY created_at',
  )
    .bind(user.id, partner?.id ?? '')
    .all<GoalRow>();
  const people = [user, ...(partner ? [partner] : [])];
  const goals = [];
  for (const g of results) {
    const { results: links } = await c.env.DB.prepare(
      `SELECT gl.user_id, gl.todo_id, t.title, t.user_id AS owner_id, t.is_private, p.is_private AS project_private,
              t.is_shared, p.is_shared AS project_shared
         FROM goal_links gl JOIN todos t ON t.id = gl.todo_id LEFT JOIN projects p ON p.id = t.project_id
        WHERE gl.goal_id = ?`,
    )
      .bind(g.id)
      .all<{ user_id: string; todo_id: string; title: string; owner_id: string; is_private: number; project_private: number | null; is_shared: number; project_shared: number | null }>();
    const perPerson = [];
    for (const p of people) {
      const link = links.find((l) => l.user_id === p.id);
      // A link that has since become private is hidden from the other person (count included).
      const visible =
        !!link &&
        canViewTodo({ id: user.id, partnerId: user.partner_id }, { userId: link.owner_id, isPrivate: link.is_private === 1, projectPrivate: link.project_private === 1 }, link.owner_id === user.id ? (partner?.id ?? null) : user.id);
      perPerson.push({
        userId: p.id,
        todoId: visible ? link!.todo_id : null,
        todoTitle: visible ? link!.title : null,
        done: visible ? await weekProgress(c.env.DB, p, link!.todo_id, now) : null,
        linked: !!link,
      });
    }
    goals.push({ id: g.id, title: g.title, targetPerPerson: g.target_per_person, createdBy: g.created_by, mine: g.created_by === user.id, people: perPerson });
  }
  return c.json({ goals });
});

structureRoutes.post('/goals', async (c) => {
  const user = c.get('user');
  const input = await body(c, goalCreateSchema);
  if (!(await getPartner(c.env.DB, user))) throw badRequest('Pair with your partner to set shared goals');
  if (input.todoId) await linkableTodo(c.env.DB, user, input.todoId);
  const id = crypto.randomUUID();
  const stmts = [
    c.env.DB.prepare('INSERT INTO goals (id, created_by, title, target_per_person, created_at) VALUES (?, ?, ?, ?, ?)').bind(
      id,
      user.id,
      input.title,
      input.targetPerPerson,
      c.get('now'),
    ),
  ];
  if (input.todoId) stmts.push(c.env.DB.prepare('INSERT INTO goal_links (goal_id, user_id, todo_id) VALUES (?, ?, ?)').bind(id, user.id, input.todoId));
  await c.env.DB.batch(stmts);
  return c.json({ id }, 201);
});

async function visibleGoal(db: D1Database, user: UserRow, id: string) {
  const g = await db.prepare('SELECT * FROM goals WHERE id = ?').bind(id).first<GoalRow>();
  const partner = await getPartner(db, user);
  if (!g || (g.created_by !== user.id && g.created_by !== partner?.id)) throw notFound('Goal not found');
  return g;
}

structureRoutes.patch('/goals/:id', async (c) => {
  const user = c.get('user');
  const g = await visibleGoal(c.env.DB, user, idParam(c.req.param('id')));
  if (g.created_by !== user.id) throw forbidden('Only the person who set the goal can change it');
  const input = await body(c, goalUpdateSchema);
  await c.env.DB.prepare('UPDATE goals SET title = ?, target_per_person = ?, archived_at = ? WHERE id = ?')
    .bind(input.title ?? g.title, input.targetPerPerson ?? g.target_per_person, input.archived ? c.get('now') : null, g.id)
    .run();
  return c.json({ ok: true });
});

structureRoutes.delete('/goals/:id', async (c) => {
  const user = c.get('user');
  const g = await visibleGoal(c.env.DB, user, idParam(c.req.param('id')));
  if (g.created_by !== user.id) throw forbidden('Only the person who set the goal can delete it');
  await c.env.DB.prepare('DELETE FROM goals WHERE id = ?').bind(g.id).run();
  return c.json({ ok: true });
});

/** Each partner links one of their own (or a shared, non-private) todos to a goal. */
structureRoutes.post('/goals/:id/link', async (c) => {
  const user = c.get('user');
  const g = await visibleGoal(c.env.DB, user, idParam(c.req.param('id')));
  const { todoId } = await body(c, goalLinkSchema);
  if (!todoId) {
    await c.env.DB.prepare('DELETE FROM goal_links WHERE goal_id = ? AND user_id = ?').bind(g.id, user.id).run();
    return c.json({ ok: true });
  }
  await linkableTodo(c.env.DB, user, todoId);
  await c.env.DB.prepare(
    `INSERT INTO goal_links (goal_id, user_id, todo_id) VALUES (?, ?, ?)
     ON CONFLICT(goal_id, user_id) DO UPDATE SET todo_id = excluded.todo_id`,
  )
    .bind(g.id, user.id, todoId)
    .run();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- Pause mode

structureRoutes.get('/pauses', async (c) => {
  const user = c.get('user');
  const today = localDate(c.get('now'), user.timezone);
  const pauses = (await loadPauses(c.env.DB, user.id)).filter((p) => p.end_date >= addDays(today, -30));
  return c.json({
    today,
    pauses: pauses.map((p) => ({ id: p.id, startDate: p.start_date, endDate: p.end_date, note: p.note, active: p.start_date <= today && today <= p.end_date })),
  });
});

structureRoutes.post('/pauses', async (c) => {
  const user = c.get('user');
  const input = await body(c, pauseCreateSchema);
  if (dateRange(input.startDate, input.endDate).length > 366) throw badRequest('Pauses are limited to a year');
  const id = crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO pauses (id, user_id, start_date, end_date, note, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(
      id,
      user.id,
      input.startDate,
      input.endDate,
      input.note,
      c.get('now'),
    ),
    // Repeating occurrences not done in the range are paused (missed ones too: they stop counting against
    // streaks). One-off todos are left alone: they simply carry over, and their reminders are silenced.
    c.env.DB.prepare(
      `UPDATE todo_instances SET paused = 1
        WHERE user_id = ? AND date BETWEEN ? AND ? AND status != 'done'
          AND todo_id IN (SELECT id FROM todos WHERE recurrence != 'none')`,
    ).bind(user.id, input.startDate, input.endDate),
  ]);
  return c.json({ id }, 201);
});

/** Ends/cancels a pause. The rest of it (from today) comes back to life; earlier days stay paused in history. */
structureRoutes.delete('/pauses/:id', async (c) => {
  const user = c.get('user');
  const id = idParam(c.req.param('id'));
  const p = await c.env.DB.prepare('SELECT * FROM pauses WHERE id = ? AND user_id = ?')
    .bind(id, user.id)
    .first<{ id: string; start_date: string; end_date: string }>();
  if (!p) throw notFound('Pause not found');
  const today = localDate(c.get('now'), user.timezone);
  const from = maxDate(p.start_date, today);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM pauses WHERE id = ?').bind(id),
    c.env.DB.prepare(
      `UPDATE todo_instances SET paused = 0
        WHERE user_id = ? AND date BETWEEN ? AND ? AND status != 'done'
          AND NOT EXISTS (SELECT 1 FROM pauses ps WHERE ps.user_id = todo_instances.user_id
                            AND todo_instances.date BETWEEN ps.start_date AND ps.end_date)`,
    ).bind(user.id, from, p.end_date),
  ]);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- Weekly review

structureRoutes.get('/review', async (c) => {
  const user = c.get('user');
  const now = c.get('now');
  const { week } = query(c, reviewQuerySchema);
  const anchor = week ?? localDate(now, user.timezone);
  const partner = await getPartner(c.env.DB, user);
  const [me, them] = await Promise.all([
    reviewFor(c.env.DB, user, user, anchor, now),
    partner ? reviewFor(c.env.DB, partner, user, anchor, now) : null,
  ]);
  return c.json({ weekStart: startOfWeek(anchor), me, partner: them });
});

// ---------------------------------------------------------------- Photo timeline

/**
 * Completion photos, newest first, 24 per page. Same rules as /api/photos/:id: your own todos' photos,
 * and your partner's unless the todo (or its project) is private.
 */
structureRoutes.get('/timeline/photos', async (c) => {
  const user = c.get('user');
  const q = query(c, photoFeedQuerySchema);
  const partner = await getPartner(c.env.DB, user);
  const filters: string[] = [];
  const binds: (string | number)[] = [];
  const mine = 't.user_id = ?';
  const theirs = 't.user_id = ? AND t.is_private = 0 AND (p.id IS NULL OR p.is_private = 0)';
  if (q.who === 'me') {
    filters.push(`(${mine})`);
    binds.push(user.id);
  } else if (q.who === 'partner') {
    if (!partner) return c.json({ photos: [], next: null });
    filters.push(`(${theirs})`);
    binds.push(partner.id);
  } else {
    filters.push(`((${mine}) OR (${theirs}))`);
    binds.push(user.id, partner?.id ?? '');
  }
  if (q.projectId) {
    filters.push('t.project_id = ?');
    binds.push(q.projectId);
  }
  if (q.todoId) {
    filters.push('t.id = ?');
    binds.push(q.todoId);
  }
  if (q.before) {
    const [at, id] = q.before.split('_') as [string, string];
    filters.push('(ph.created_at < ? OR (ph.created_at = ? AND ph.id < ?))');
    binds.push(Number(at), Number(at), id);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT ph.*, t.title AS todo_title, t.user_id AS todo_owner, i.date AS instance_date, i.completed_by,
            p.name AS project_name, p.color AS project_color
       FROM photos ph
       JOIN todos t ON t.id = ph.todo_id
       JOIN todo_instances i ON i.id = ph.instance_id
       LEFT JOIN projects p ON p.id = t.project_id
      WHERE ${filters.join(' AND ')}
      ORDER BY ph.created_at DESC, ph.id DESC
      LIMIT 25`,
  )
    .bind(...binds)
    .all<PhotoRow & { todo_title: string; todo_owner: string; instance_date: string; completed_by: string | null; project_name: string | null; project_color: string | null }>();
  const page = results.slice(0, 24);
  const last = page[page.length - 1];
  return c.json({
    photos: page.map((r) => ({
      ...photoDto(r),
      todoTitle: r.todo_title,
      ownerId: r.todo_owner,
      date: r.instance_date,
      completedBy: r.completed_by,
      project: r.project_name ? { name: r.project_name, color: r.project_color ?? 'clay' } : null,
    })),
    next: results.length > 24 && last ? `${last.created_at}_${last.id}` : null,
  });
});

