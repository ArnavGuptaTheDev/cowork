import { idSchema, suggestionAcceptSchema, suggestionCreateSchema, suggestionDenySchema } from '../../shared/schemas';
import { ruleFromColumns, ruleToColumns } from '../../shared/recurrence';
import { photoDto, publicUser, type PhotoRow, type SuggestionRow, type UserRow } from '../db';
import { badRequest, forbidden, notFound, parse } from '../http';
import { getPartner, getUser } from '../services/access';
import { sendPushToUser } from '../services/notify';
import { createTodo } from '../services/todos';
import { body, defer, router, syncCalendar } from './common';

export const suggestionRoutes = router();

function suggestionDto(s: SuggestionRow, photos: PhotoRow[], names: Map<string, string>) {
  return {
    id: s.id,
    from: { id: s.from_user_id, name: names.get(s.from_user_id) ?? 'Partner' },
    to: { id: s.to_user_id, name: names.get(s.to_user_id) ?? 'Partner' },
    title: s.title,
    notes: s.notes,
    category: s.category,
    startDate: s.start_date,
    endDate: s.end_date,
    dueTime: s.due_time,
    reminderTime: s.reminder_time,
    recurrence: ruleFromColumns(s),
    status: s.status,
    reason: s.reason,
    todoId: s.todo_id,
    createdAt: s.created_at,
    respondedAt: s.responded_at,
    photos: photos.map(photoDto),
  };
}

async function getSuggestion(db: D1Database, id: string): Promise<SuggestionRow> {
  const s = await db.prepare('SELECT * FROM suggestions WHERE id = ?').bind(id).first<SuggestionRow>();
  if (!s) throw notFound('Suggestion not found');
  return s;
}

suggestionRoutes.get('/suggestions', async (c) => {
  const user = c.get('user');
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM suggestions WHERE to_user_id = ? OR from_user_id = ? ORDER BY created_at DESC LIMIT 200`,
  )
    .bind(user.id, user.id)
    .all<SuggestionRow>();
  const ids = results.map((s) => s.id);
  const photos = new Map<string, PhotoRow[]>();
  if (ids.length) {
    const { results: ph } = await c.env.DB.prepare(
      `SELECT * FROM photos WHERE suggestion_id IN (SELECT id FROM suggestions WHERE to_user_id = ? OR from_user_id = ?)
        ORDER BY created_at`,
    )
      .bind(user.id, user.id)
      .all<PhotoRow>();
    for (const p of ph) photos.set(p.suggestion_id!, [...(photos.get(p.suggestion_id!) ?? []), p]);
  }
  const otherIds = [...new Set(results.flatMap((s) => [s.from_user_id, s.to_user_id]))];
  const names = new Map<string, string>([[user.id, publicUser(user).name]]);
  for (const id of otherIds) {
    if (names.has(id)) continue;
    const u = await getUser(c.env.DB, id);
    if (u) names.set(id, publicUser(u).name);
  }
  const all = results.map((s) => suggestionDto(s, photos.get(s.id) ?? [], names));
  return c.json({
    incoming: all.filter((s) => s.to.id === user.id),
    outgoing: all.filter((s) => s.from.id === user.id),
  });
});

suggestionRoutes.post('/suggestions', async (c) => {
  const user = c.get('user');
  const input = await body(c, suggestionCreateSchema);
  const partner = await getPartner(c.env.DB, user);
  if (!partner) throw forbidden('Pair with your partner first');
  const id = crypto.randomUUID();
  const cols = ruleToColumns(input.recurrence);
  await c.env.DB.prepare(
    `INSERT INTO suggestions (id, from_user_id, to_user_id, title, notes, category, start_date, end_date, due_time, reminder_time,
       recurrence, recurrence_weekdays, recurrence_month_day, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  )
    .bind(
      id, user.id, partner.id, input.title, input.notes, input.category, input.startDate,
      input.recurrence.type === 'none' ? null : input.endDate, input.dueTime, input.reminderTime,
      cols.recurrence, cols.recurrence_weekdays, cols.recurrence_month_day, c.get('now'),
    )
    .run();
  defer(
    c,
    sendPushToUser(c.env, partner.id, {
      title: `${publicUser(user).name} suggested a todo`,
      body: input.title,
      url: '/suggestions',
      tag: `suggestion-${id}`,
    }),
  );
  return c.json({ id }, 201);
});

suggestionRoutes.post('/suggestions/:id/accept', async (c) => {
  const user = c.get('user');
  const s = await getSuggestion(c.env.DB, parse(idSchema, c.req.param('id')));
  if (s.to_user_id !== user.id) throw notFound('Suggestion not found');
  if (s.status !== 'pending') throw badRequest('This suggestion was already answered');
  const opts = await body(c, suggestionAcceptSchema);
  const now = c.get('now');
  // Claim it first so a double tap can't create two todos.
  const claim = await c.env.DB.prepare(
    `UPDATE suggestions SET status = 'accepted', responded_at = ? WHERE id = ? AND status = 'pending'`,
  )
    .bind(now, s.id)
    .run();
  if (!claim.meta.changes) throw badRequest('This suggestion was already answered');
  let todoId: string;
  try {
    todoId = await createTodo(
      c.env,
      user,
      {
        title: s.title,
        notes: s.notes,
        category: s.category,
        startDate: s.start_date,
        endDate: s.end_date,
        dueTime: s.due_time,
        reminderTime: s.reminder_time,
        recurrence: ruleFromColumns(s),
        projectId: opts.projectId,
        isPrivate: opts.isPrivate,
      },
      now,
      { suggestedBy: s.from_user_id },
    );
  } catch (e) {
    await c.env.DB.prepare(`UPDATE suggestions SET status = 'pending', responded_at = NULL WHERE id = ?`).bind(s.id).run();
    throw e;
  }
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE suggestions SET todo_id = ? WHERE id = ?').bind(todoId, s.id),
    // The suggester's photos travel with the todo; it now belongs to the recipient.
    c.env.DB.prepare('UPDATE photos SET todo_id = ?, owner_id = ? WHERE suggestion_id = ?').bind(todoId, user.id, s.id),
  ]);
  syncCalendar(c, todoId);
  defer(
    c,
    sendPushToUser(c.env, s.from_user_id, {
      title: `${publicUser(user).name} accepted your suggestion`,
      body: s.title,
      url: '/suggestions',
      tag: `suggestion-${s.id}`,
    }),
  );
  return c.json({ todoId });
});

suggestionRoutes.post('/suggestions/:id/deny', async (c) => {
  const user = c.get('user');
  const s = await getSuggestion(c.env.DB, parse(idSchema, c.req.param('id')));
  if (s.to_user_id !== user.id) throw notFound('Suggestion not found');
  if (s.status !== 'pending') throw badRequest('This suggestion was already answered');
  const { reason } = await body(c, suggestionDenySchema);
  await c.env.DB.prepare(`UPDATE suggestions SET status = 'denied', reason = ?, responded_at = ? WHERE id = ?`)
    .bind(reason || null, c.get('now'), s.id)
    .run();
  defer(
    c,
    sendPushToUser(c.env, s.from_user_id, {
      title: `${publicUser(user).name} passed on your suggestion`,
      body: reason ? `${s.title}: "${reason}"` : s.title,
      url: '/suggestions',
      tag: `suggestion-${s.id}`,
    }),
  );
  return c.json({ ok: true });
});

suggestionRoutes.post('/suggestions/:id/withdraw', async (c) => {
  const user: UserRow = c.get('user');
  const s = await getSuggestion(c.env.DB, parse(idSchema, c.req.param('id')));
  if (s.from_user_id !== user.id) throw notFound('Suggestion not found');
  if (s.status !== 'pending') throw badRequest('This suggestion was already answered');
  await c.env.DB.prepare(`UPDATE suggestions SET status = 'withdrawn', responded_at = ? WHERE id = ?`).bind(c.get('now'), s.id).run();
  return c.json({ ok: true });
});
