// Data export: all of my own data as JSON, and my todos and completions as CSV.
// The partner's data is left out, except items shared with me (shared todos/projects and their history).
import { localDate } from '../../shared/time';
import { placeholders, publicUser, type UserRow } from '../db';
import { getPartner } from '../services/access';
import { router } from './common';

export const exportRoutes = router();

/** Todo ids in my export: mine, plus my partner's that are shared with me. */
async function exportTodoIds(db: D1Database, user: UserRow): Promise<string[]> {
  const partner = await getPartner(db, user);
  const { results } = await db
    .prepare(
      `SELECT t.id FROM todos t LEFT JOIN projects p ON p.id = t.project_id
        WHERE t.user_id = ? OR (t.user_id = ? AND (t.is_shared = 1 OR COALESCE(p.is_shared, 0) = 1))`,
    )
    .bind(user.id, partner?.id ?? '')
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

/** Runs `sql` over `ids` in chunks; `before`/`after` are bound around the IN (...) list, in that order. */
async function rowsIn<T>(db: D1Database, sql: (ph: string) => string, ids: string[], after: unknown[] = [], before: unknown[] = []): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    const { results } = await db.prepare(sql(placeholders(part.length))).bind(...before, ...part, ...after).all<T>();
    out.push(...results);
  }
  return out;
}

function download(body: string, filename: string, type: string) {
  return new Response(body, {
    headers: {
      'Content-Type': `${type}; charset=utf-8`,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/** RFC 4180 CSV; cells that look like formulas are prefixed so spreadsheets don't execute them. */
export function toCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

exportRoutes.get('/export/json', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const partner = await getPartner(db, user);
  const todoIds = await exportTodoIds(db, user);
  const todos = await rowsIn<Record<string, unknown>>(db, (ph) => `SELECT * FROM todos WHERE id IN (${ph})`, todoIds);
  const projectIds = [...new Set(todos.map((t) => t.project_id as string | null).filter((x): x is string => !!x))];
  const projects = await db
    .prepare(`SELECT * FROM projects WHERE user_id = ? ${projectIds.length ? `OR id IN (${placeholders(projectIds.length)})` : ''}`)
    .bind(user.id, ...projectIds)
    .all();
  const instances = await rowsIn(db, (ph) => `SELECT * FROM todo_instances WHERE todo_id IN (${ph}) ORDER BY date`, todoIds);
  const subtasks = await rowsIn(db, (ph) => `SELECT * FROM subtasks WHERE todo_id IN (${ph}) ORDER BY position`, todoIds);
  const subtaskChecks = await rowsIn(
    db,
    (ph) => `SELECT sc.* FROM subtask_checks sc JOIN subtasks s ON s.id = sc.subtask_id WHERE s.todo_id IN (${ph})`,
    todoIds,
  );
  // Comments: mine anywhere, and anything on shared items (the conversation belongs to both of us).
  const comments = await rowsIn<Record<string, unknown>>(
    db,
    (ph) =>
      `SELECT c.* FROM comments c JOIN todos t ON t.id = c.todo_id LEFT JOIN projects p ON p.id = t.project_id
        WHERE c.todo_id IN (${ph}) AND (c.author_id = ? OR t.is_shared = 1 OR COALESCE(p.is_shared, 0) = 1)`,
    todoIds,
    [user.id],
  );
  const photos = await rowsIn<Record<string, unknown>>(
    db,
    (ph) => `SELECT id, todo_id, instance_id, owner_id, content_type, size_bytes, width, height, created_at FROM photos WHERE todo_id IN (${ph})`,
    todoIds,
  );
  const [timeEntries, templates, templateItems, goals, goalLinks, pauses, suggestions, reactions] = await Promise.all([
    db.prepare('SELECT * FROM time_entries WHERE user_id = ? ORDER BY started_at').bind(user.id).all(),
    db.prepare('SELECT * FROM templates WHERE user_id = ?').bind(user.id).all(),
    db.prepare('SELECT ti.* FROM template_items ti JOIN templates t ON t.id = ti.template_id WHERE t.user_id = ?').bind(user.id).all(),
    db.prepare('SELECT * FROM goals WHERE created_by = ?').bind(user.id).all(),
    db.prepare('SELECT * FROM goal_links WHERE user_id = ?').bind(user.id).all(),
    db.prepare('SELECT * FROM pauses WHERE user_id = ?').bind(user.id).all(),
    db.prepare('SELECT * FROM suggestions WHERE from_user_id = ?').bind(user.id).all(),
    db.prepare('SELECT * FROM reactions WHERE user_id = ?').bind(user.id).all(),
  ]);
  const data = {
    format: 'cowork-export',
    version: 1,
    exportedAt: new Date(c.get('now')).toISOString(),
    user: { ...publicUser(user), wrapupTime: user.wrapup_time, createdAt: user.created_at },
    partner: partner ? { id: partner.id, name: publicUser(partner).name } : null,
    projects: projects.results,
    todos,
    instances,
    subtasks,
    subtaskChecks,
    comments,
    photos: photos.map((p) => ({ ...p, url: `/api/photos/${p.id}` })),
    timeEntries: timeEntries.results,
    templates: templates.results,
    templateItems: templateItems.results,
    goals: goals.results,
    goalLinks: goalLinks.results,
    pauses: pauses.results,
    suggestionsSent: suggestions.results,
    reactionsGiven: reactions.results,
  };
  const day = localDate(c.get('now'), user.timezone);
  return download(JSON.stringify(data, null, 2), `cowork-export-${day}.json`, 'application/json');
});

exportRoutes.get('/export/todos.csv', async (c) => {
  const user = c.get('user');
  const todoIds = await exportTodoIds(c.env.DB, user);
  const rows = await rowsIn<Record<string, string | number | null>>(
    c.env.DB,
    (ph) =>
      `SELECT t.id, t.title, t.notes, t.category, p.name AS project, t.start_date, t.end_date, t.due_time, t.reminder_time,
              t.recurrence, t.recurrence_weekdays, t.recurrence_month_day, t.is_private, t.is_shared, t.user_id = ? AS mine,
              t.created_at,
              (SELECT COALESCE(SUM(COALESCE(te.ended_at, te.started_at) - te.started_at), 0) / 60000 FROM time_entries te
                WHERE te.todo_id = t.id AND te.user_id = ?) AS minutes_tracked
         FROM todos t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id IN (${ph}) ORDER BY t.created_at`,
    todoIds,
    [],
    [user.id, user.id],
  );
  const header = ['id', 'title', 'notes', 'category', 'project', 'start_date', 'end_date', 'due_time', 'reminder_time', 'recurrence', 'weekdays', 'month_day', 'private', 'shared', 'mine', 'created_at', 'minutes_tracked'];
  const csv = toCsv(
    header,
    rows.map((r) => [
      r.id, r.title, r.notes, r.category, r.project, r.start_date, r.end_date, r.due_time, r.reminder_time, r.recurrence,
      r.recurrence_weekdays, r.recurrence_month_day, r.is_private ? 'yes' : 'no', r.is_shared ? 'yes' : 'no', r.mine ? 'yes' : 'no',
      new Date(Number(r.created_at)).toISOString(), Math.round(Number(r.minutes_tracked ?? 0)),
    ]),
  );
  return download(csv, `cowork-todos-${localDate(c.get('now'), user.timezone)}.csv`, 'text/csv');
});

exportRoutes.get('/export/completions.csv', async (c) => {
  const user = c.get('user');
  const todoIds = await exportTodoIds(c.env.DB, user);
  const rows = await rowsIn<Record<string, string | number | null>>(
    c.env.DB,
    (ph) =>
      `SELECT i.date, t.title, t.category, p.name AS project,
              CASE WHEN i.paused = 1 AND i.status != 'done' THEN 'paused' ELSE i.status END AS status,
              i.completed_at, u.name AS completed_by, i.note, i.todo_id
         FROM todo_instances i JOIN todos t ON t.id = i.todo_id LEFT JOIN projects p ON p.id = t.project_id
         LEFT JOIN users u ON u.id = i.completed_by
        WHERE i.todo_id IN (${ph}) ORDER BY i.date, t.title`,
    todoIds,
  );
  const csv = toCsv(
    ['date', 'todo', 'category', 'project', 'status', 'completed_at', 'completed_by', 'note', 'todo_id'],
    rows.map((r) => [r.date, r.title, r.category, r.project, r.status, r.completed_at ? new Date(Number(r.completed_at)).toISOString() : null, r.completed_by, r.note, r.todo_id]),
  );
  return download(csv, `cowork-completions-${localDate(c.get('now'), user.timezone)}.csv`, 'text/csv');
});
