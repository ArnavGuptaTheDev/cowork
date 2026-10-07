// Partner interaction: reactions on completions, nudges on open todos, comment threads.
import { canComment, canReact, nudgeTarget } from '../../shared/authz';
import { NUDGE_COOLDOWN_MS } from '../../shared/constants';
import { commentCreateSchema, idSchema, reactSchema } from '../../shared/schemas';
import type { Context } from 'hono';
import { publicUser } from '../db';
import type { AppEnv } from '../env';
import { HttpError, notFound, parse } from '../http';
import { authzTodo, getUser, todoAccess } from '../services/access';
import { activePause } from '../services/pause';
import { sendPushToUser } from '../services/notify';
import { visibleInstance } from '../services/todos';
import { body, defer, router } from './common';

export const interactRoutes = router();

const idParam = (v: string | undefined) => parse(idSchema, v);

/** Truncates a todo title for push bodies. */
const short = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// --- Reactions ---

interactRoutes.post('/instances/:id/react', async (c) => {
  const user = c.get('user');
  const { emoji } = await body(c, reactSchema);
  const { inst, access } = await visibleInstance(c.env.DB, user, idParam(c.req.param('id')));
  const allowed = canReact(
    { id: user.id, partnerId: user.partner_id },
    authzTodo(access.todo, access.project),
    access.owner.partner_id,
    { status: inst.status, completedBy: inst.completed_by },
  );
  if (!allowed) throw notFound('Nothing to react to');
  if (emoji === null) {
    await c.env.DB.prepare('DELETE FROM reactions WHERE instance_id = ? AND user_id = ?').bind(inst.id, user.id).run();
    return c.json({ ok: true });
  }
  await c.env.DB.prepare(
    `INSERT INTO reactions (instance_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(instance_id, user_id) DO UPDATE SET emoji = excluded.emoji, created_at = excluded.created_at`,
  )
    .bind(inst.id, user.id, emoji, c.get('now'))
    .run();
  const to = inst.completed_by ?? access.todo.user_id;
  defer(
    c,
    sendPushToUser(c.env, to, {
      title: `${publicUser(user).name} reacted ${emoji}`,
      body: `to “${short(access.todo.title)}”`,
      url: `/today?todo=${access.todo.id}`,
      tag: `reaction-${inst.id}`,
    }),
  );
  return c.json({ ok: true });
});

// --- Nudges (one per todo per 3 hours) ---

interactRoutes.post('/instances/:id/nudge', async (c) => {
  const user = c.get('user');
  const now = c.get('now');
  const { inst, access } = await visibleInstance(c.env.DB, user, idParam(c.req.param('id')));
  const target = nudgeTarget(
    { id: user.id, partnerId: user.partner_id },
    authzTodo(access.todo, access.project),
    access.owner.partner_id,
    { status: inst.status },
  );
  if (!target) throw notFound('Nothing to nudge');
  const targetUser = target === user.id ? user : await getUser(c.env.DB, target);
  const paused = targetUser ? await activePause(c.env.DB, targetUser, now) : null;
  if (paused) throw new HttpError(409, 'paused', `${publicUser(targetUser!).name.split(' ')[0]} is taking a break until ${paused.end_date}`);
  const last = await c.env.DB.prepare('SELECT MAX(created_at) AS at FROM nudges WHERE todo_id = ?')
    .bind(inst.todo_id)
    .first<{ at: number | null }>();
  if (last?.at && now - last.at < NUDGE_COOLDOWN_MS) {
    const mins = Math.ceil((NUDGE_COOLDOWN_MS - (now - last.at)) / 60_000);
    throw new HttpError(429, 'too_many_nudges', `Already nudged. Try again in ${mins >= 60 ? `${Math.ceil(mins / 60)}h` : `${mins} min`}`);
  }
  await c.env.DB.prepare(
    'INSERT INTO nudges (id, todo_id, instance_id, from_user_id, to_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(crypto.randomUUID(), inst.todo_id, inst.id, user.id, target, now)
    .run();
  defer(
    c,
    sendPushToUser(c.env, target, {
      title: `👋 ${publicUser(user).name} nudged you`,
      body: short(access.todo.title),
      url: `/today?todo=${access.todo.id}`,
      tag: `nudge-${inst.todo_id}`,
    }),
  );
  return c.json({ ok: true });
});

// --- Comments ---

async function commentableTodo(c: Context<AppEnv>, todoId: string) {
  const user = c.get('user');
  const access = await todoAccess(c.env.DB, user, todoId);
  if (!access || !canComment({ id: user.id, partnerId: user.partner_id }, authzTodo(access.todo, access.project), access.owner.partner_id)) {
    throw notFound('Todo not found');
  }
  return access;
}

interactRoutes.get('/todos/:id/comments', async (c) => {
  const access = await commentableTodo(c, idParam(c.req.param('id')));
  const { results } = await c.env.DB.prepare(
    `SELECT c.id, c.author_id, c.body, c.created_at, u.name, u.email, u.avatar_url
       FROM comments c JOIN users u ON u.id = c.author_id
      WHERE c.todo_id = ? ORDER BY c.created_at LIMIT 200`,
  )
    .bind(access.todo.id)
    .all<{ id: string; author_id: string; body: string; created_at: number; name: string; email: string; avatar_url: string | null }>();
  return c.json({
    comments: results.map((r) => ({
      id: r.id,
      authorId: r.author_id,
      authorName: r.name || r.email.split('@')[0],
      authorAvatar: r.avatar_url,
      body: r.body,
      createdAt: r.created_at,
      mine: r.author_id === c.get('user').id,
    })),
  });
});

interactRoutes.post('/todos/:id/comments', async (c) => {
  const user = c.get('user');
  const access = await commentableTodo(c, idParam(c.req.param('id')));
  const { body: text } = await body(c, commentCreateSchema);
  const id = crypto.randomUUID();
  await c.env.DB.prepare('INSERT INTO comments (id, todo_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, access.todo.id, user.id, text, c.get('now'))
    .run();
  // The "other person": the owner, or the owner's partner when the owner is commenting.
  const other = user.id === access.owner.id ? access.ownerPartnerId : access.owner.id;
  if (other) {
    defer(
      c,
      sendPushToUser(c.env, other, {
        title: `${publicUser(user).name} on “${short(access.todo.title, 40)}”`,
        body: short(text, 120),
        url: `/today?todo=${access.todo.id}`,
        tag: `comments-${access.todo.id}`,
      }),
    );
  }
  return c.json({ id }, 201);
});

interactRoutes.delete('/comments/:id', async (c) => {
  const r = await c.env.DB.prepare('DELETE FROM comments WHERE id = ? AND author_id = ?')
    .bind(idParam(c.req.param('id')), c.get('user').id)
    .run();
  if (!r.meta.changes) throw notFound('Comment not found');
  return c.json({ ok: true });
});

