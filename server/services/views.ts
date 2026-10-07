// Read models for the Today, Week/Month, Habits and Projects views.
import { occurrencesBetween, ruleFromColumns, type Recurrence } from '../../shared/recurrence';
import { habitStats, type HabitStats, type InstanceStatus } from '../../shared/streaks';
import { addDays, dateRange, localDate } from '../../shared/time';
import { placeholders, projectDto, type Category, type ProjectDto, type ProjectRow, type TodoRow, type UserRow } from '../db';
import { badRequest, notFound } from '../http';
import { privacyFilter } from './access';
import { materializeUser, scheduleOf } from './todos';

export type ItemStatus = InstanceStatus | 'upcoming';

export interface DayItem {
  instanceId: string | null;
  todoId: string;
  date: string;
  title: string;
  notes: string;
  category: Category;
  project: { id: string; name: string; color: string } | null;
  dueTime: string | null;
  reminderTime: string | null;
  status: ItemStatus;
  carriedOverFrom: string | null;
  recurrence: Recurrence;
  isPrivate: boolean;
  suggestedBy: string | null;
  photoCount: number;
  streak: number | null;
}

type JoinedRow = TodoRow & {
  instance_id: string;
  date: string;
  status: InstanceStatus;
  completed_on: string | null;
  project_name: string | null;
  project_color: string | null;
  photo_count: number;
};

const ITEM_SELECT = `
  SELECT t.*, i.id AS instance_id, i.date, i.status, i.completed_on,
         p.name AS project_name, p.color AS project_color,
         (SELECT COUNT(*) FROM photos ph WHERE ph.todo_id = t.id) AS photo_count
    FROM todo_instances i
    JOIN todos t ON t.id = i.todo_id
    LEFT JOIN projects p ON p.id = t.project_id`;

function toItem(r: JoinedRow, today: string, streaks: Map<string, number>): DayItem {
  return {
    instanceId: r.instance_id,
    todoId: r.id,
    date: r.date,
    title: r.title,
    notes: r.notes,
    category: r.category,
    project: r.project_id && r.project_name ? { id: r.project_id, name: r.project_name, color: r.project_color ?? 'clay' } : null,
    dueTime: r.due_time,
    reminderTime: r.reminder_time,
    status: r.status,
    carriedOverFrom: r.recurrence === 'none' && r.date < today ? r.date : null,
    recurrence: ruleFromColumns(r),
    isPrivate: r.is_private === 1,
    suggestedBy: r.suggested_by,
    photoCount: r.photo_count,
    streak: streaks.get(r.id) ?? null,
  };
}

function sortItems(items: DayItem[]): DayItem[] {
  return items.sort((a, b) => {
    const at = a.dueTime ?? '99:99';
    const bt = b.dueTime ?? '99:99';
    if (at !== bt) return at < bt ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
}

/** Instance history (date, status) for a set of todos since a date. */
export async function loadHistories(db: D1Database, todoIds: string[], since: string) {
  const map = new Map<string, { date: string; status: InstanceStatus }[]>();
  for (let i = 0; i < todoIds.length; i += 90) {
    const ids = todoIds.slice(i, i + 90);
    const { results } = await db
      .prepare(
        `SELECT todo_id, date, status FROM todo_instances
          WHERE todo_id IN (${placeholders(ids.length)}) AND date >= ? ORDER BY date`,
      )
      .bind(...ids, since)
      .all<{ todo_id: string; date: string; status: InstanceStatus }>();
    for (const r of results) {
      const list = map.get(r.todo_id) ?? [];
      list.push({ date: r.date, status: r.status });
      map.set(r.todo_id, list);
    }
  }
  return map;
}

export interface TodayView {
  date: string;
  timezone: string;
  items: DayItem[];
  summary: { done: number; total: number };
}

export async function todayView(db: D1Database, owner: UserRow, asPartner: boolean, now: number): Promise<TodayView> {
  const today = await materializeUser(db, owner, now);
  const { results } = await db
    .prepare(
      `${ITEM_SELECT}
        WHERE i.user_id = ?
          AND (i.date = ?
               OR (t.recurrence = 'none' AND i.status = 'pending' AND i.date < ?)
               OR (t.recurrence = 'none' AND i.status = 'done' AND i.date < ? AND i.completed_on = ?))
          ${privacyFilter(asPartner)}`,
    )
    .bind(owner.id, today, today, today, today)
    .all<JoinedRow>();

  const recurringIds = results.filter((r) => r.recurrence !== 'none').map((r) => r.id);
  const histories = await loadHistories(db, recurringIds, addDays(today, -400));
  const streaks = new Map<string, number>();
  for (const [id, h] of histories) streaks.set(id, habitStats(h, today).currentStreak);

  const items = sortItems(results.map((r) => toItem(r, today, streaks)));
  return {
    date: today,
    timezone: owner.timezone,
    items,
    summary: { done: items.filter((i) => i.status === 'done').length, total: items.length },
  };
}

/** True when the user has at least one item today and every one is done (private ones included). */
export async function allDoneToday(db: D1Database, owner: UserRow, now: number): Promise<boolean> {
  const v = await todayView(db, owner, false, now);
  return v.summary.total > 0 && v.summary.done === v.summary.total;
}

export interface RangeView {
  from: string;
  to: string;
  today: string;
  days: { date: string; items: DayItem[] }[];
}

export const MAX_RANGE_DAYS = 62;

export async function rangeView(
  db: D1Database,
  owner: UserRow,
  asPartner: boolean,
  from: string,
  to: string,
  now: number,
): Promise<RangeView> {
  if (dateRange(from, to).length > MAX_RANGE_DAYS) throw badRequest(`Ranges are limited to ${MAX_RANGE_DAYS} days`);
  const today = await materializeUser(db, owner, now);

  // Stored instances: one-off todos (any date) and recurring ones up to today.
  const { results: stored } = await db
    .prepare(`${ITEM_SELECT} WHERE i.user_id = ? AND i.date BETWEEN ? AND ? ${privacyFilter(asPartner)}`)
    .bind(owner.id, from, to)
    .all<JoinedRow>();

  const byDate = new Map<string, DayItem[]>();
  const none = new Map<string, number>();
  const seen = new Set<string>();
  for (const r of stored) {
    const item = toItem(r, today, none);
    item.carriedOverFrom = null;
    (byDate.get(r.date) ?? byDate.set(r.date, []).get(r.date)!).push(item);
    seen.add(`${r.id}|${r.date}`);
  }

  // Projected future occurrences of recurring todos.
  if (to > today) {
    const { results: recurring } = await db
      .prepare(
        `SELECT t.*, p.name AS project_name, p.color AS project_color
           FROM todos t LEFT JOIN projects p ON p.id = t.project_id
          WHERE t.user_id = ? AND t.recurrence != 'none' AND t.start_date <= ?
            AND (t.end_date IS NULL OR t.end_date >= ?) ${privacyFilter(asPartner)}`,
      )
      .bind(owner.id, to, from)
      .all<TodoRow & { project_name: string | null; project_color: string | null }>();
    const futureFrom = addDays(today, 1) > from ? addDays(today, 1) : from;
    for (const t of recurring) {
      for (const d of occurrencesBetween(scheduleOf(t), futureFrom, to)) {
        if (seen.has(`${t.id}|${d}`)) continue;
        const item: DayItem = {
          instanceId: null,
          todoId: t.id,
          date: d,
          title: t.title,
          notes: t.notes,
          category: t.category,
          project: t.project_id && t.project_name ? { id: t.project_id, name: t.project_name, color: t.project_color ?? 'clay' } : null,
          dueTime: t.due_time,
          reminderTime: t.reminder_time,
          status: 'upcoming',
          carriedOverFrom: null,
          recurrence: ruleFromColumns(t),
          isPrivate: t.is_private === 1,
          suggestedBy: t.suggested_by,
          photoCount: 0,
          streak: null,
        };
        (byDate.get(d) ?? byDate.set(d, []).get(d)!).push(item);
      }
    }
  }

  return {
    from,
    to,
    today,
    days: dateRange(from, to).map((date) => ({ date, items: sortItems(byDate.get(date) ?? []) })),
  };
}

export interface HabitView {
  todoId: string;
  title: string;
  category: Category;
  recurrence: Recurrence;
  project: { id: string; name: string; color: string } | null;
  isPrivate: boolean;
  stats: HabitStats;
  todayInstanceId: string | null;
  todayStatus: InstanceStatus | null;
  /** Last 14 days, oldest first: status, or null when not scheduled that day. */
  recent: { date: string; status: InstanceStatus | null }[];
  ended: boolean;
}

export async function habitsView(db: D1Database, owner: UserRow, asPartner: boolean, now: number) {
  const today = await materializeUser(db, owner, now);
  const { results } = await db
    .prepare(
      `SELECT t.*, p.name AS project_name, p.color AS project_color
         FROM todos t LEFT JOIN projects p ON p.id = t.project_id
        WHERE t.user_id = ? AND t.recurrence != 'none' ${privacyFilter(asPartner)}
        ORDER BY CASE t.category WHEN 'habit' THEN 0 ELSE 1 END, t.created_at`,
    )
    .bind(owner.id)
    .all<TodoRow & { project_name: string | null; project_color: string | null }>();
  const histories = await loadHistories(
    db,
    results.map((r) => r.id),
    addDays(today, -400),
  );
  const recentDates = dateRange(addDays(today, -13), today);
  const habits: HabitView[] = results.map((t) => {
    const h = histories.get(t.id) ?? [];
    const byDate = new Map(h.map((e) => [e.date, e.status]));
    const todayEntry = h.find((e) => e.date === today);
    return {
      todoId: t.id,
      title: t.title,
      category: t.category,
      recurrence: ruleFromColumns(t),
      project: t.project_id && t.project_name ? { id: t.project_id, name: t.project_name, color: t.project_color ?? 'clay' } : null,
      isPrivate: t.is_private === 1,
      stats: habitStats(h, today),
      todayInstanceId: null,
      todayStatus: todayEntry?.status ?? null,
      recent: recentDates.map((d) => ({ date: d, status: byDate.get(d) ?? null })),
      ended: !!t.end_date && t.end_date < today,
    };
  });
  // Today's instance ids, for checking off straight from the Habits view.
  if (habits.length) {
    const { results: inst } = await db
      .prepare(`SELECT id, todo_id FROM todo_instances WHERE user_id = ? AND date = ?`)
      .bind(owner.id, today)
      .all<{ id: string; todo_id: string }>();
    const m = new Map(inst.map((i) => [i.todo_id, i.id]));
    for (const h of habits) h.todayInstanceId = m.get(h.todoId) ?? null;
  }
  return { today, habits };
}

export interface ProjectSummary extends ProjectDto {
  progress: { done: number; total: number };
  recurringCount: number;
}

export async function projectsView(db: D1Database, owner: UserRow, asPartner: boolean, includeArchived: boolean) {
  const filter = asPartner ? ' AND t.is_private = 0' : '';
  const { results } = await db
    .prepare(
      `SELECT p.*,
          (SELECT COUNT(*) FROM todos t WHERE t.project_id = p.id AND t.recurrence = 'none'${filter}) AS total,
          (SELECT COUNT(*) FROM todos t JOIN todo_instances i ON i.todo_id = t.id
            WHERE t.project_id = p.id AND t.recurrence = 'none' AND i.status = 'done'${filter}) AS done,
          (SELECT COUNT(*) FROM todos t WHERE t.project_id = p.id AND t.recurrence != 'none'${filter}) AS recurring
         FROM projects p
        WHERE p.user_id = ?${asPartner ? ' AND p.is_private = 0' : ''}${includeArchived ? '' : ' AND p.archived_at IS NULL'}
        ORDER BY p.archived_at IS NOT NULL, p.created_at`,
    )
    .bind(owner.id)
    .all<ProjectRow & { total: number; done: number; recurring: number }>();
  return results.map<ProjectSummary>((r) => ({
    ...projectDto(r),
    progress: { done: r.done, total: r.total },
    recurringCount: r.recurring,
  }));
}

export interface ProjectTodo {
  todoId: string;
  title: string;
  category: Category;
  recurrence: Recurrence;
  isPrivate: boolean;
  dueTime: string | null;
  startDate: string;
  /** One-off: its instance. Recurring: null. */
  instanceId: string | null;
  status: InstanceStatus | null;
  stats: HabitStats | null;
  photoCount: number;
}

export async function projectView(db: D1Database, owner: UserRow, asPartner: boolean, projectId: string, now: number) {
  const p = await db
    .prepare(`SELECT * FROM projects p WHERE p.id = ? AND p.user_id = ?${asPartner ? ' AND p.is_private = 0' : ''}`)
    .bind(projectId, owner.id)
    .first<ProjectRow>();
  if (!p) throw notFound('Project not found');
  const today = await materializeUser(db, owner, now);
  const { results } = await db
    .prepare(
      `SELECT t.*,
          (SELECT i.id FROM todo_instances i WHERE i.todo_id = t.id ORDER BY i.date DESC LIMIT 1) AS instance_id,
          (SELECT i.status FROM todo_instances i WHERE i.todo_id = t.id ORDER BY i.date DESC LIMIT 1) AS status,
          (SELECT COUNT(*) FROM photos ph WHERE ph.todo_id = t.id) AS photo_count
         FROM todos t
        WHERE t.project_id = ? AND t.user_id = ?${asPartner ? ' AND t.is_private = 0' : ''}
        ORDER BY t.start_date, t.created_at`,
    )
    .bind(projectId, owner.id)
    .all<TodoRow & { instance_id: string | null; status: InstanceStatus | null; photo_count: number }>();
  const recurringIds = results.filter((t) => t.recurrence !== 'none').map((t) => t.id);
  const histories = await loadHistories(db, recurringIds, addDays(today, -400));
  const todos: ProjectTodo[] = results.map((t) => {
    const recurring = t.recurrence !== 'none';
    return {
      todoId: t.id,
      title: t.title,
      category: t.category,
      recurrence: ruleFromColumns(t),
      isPrivate: t.is_private === 1,
      dueTime: t.due_time,
      startDate: t.start_date,
      instanceId: recurring ? null : t.instance_id,
      status: recurring ? null : t.status,
      stats: recurring ? habitStats(histories.get(t.id) ?? [], today) : null,
      photoCount: t.photo_count,
    };
  });
  const oneOff = todos.filter((t) => t.stats === null);
  return {
    today,
    project: projectDto(p),
    progress: { done: oneOff.filter((t) => t.status === 'done').length, total: oneOff.length },
    todos,
  };
}

/** Recent instances (newest first) for the todo detail sheet. */
export async function recentInstances(db: D1Database, todoId: string, limit = 60) {
  const { results } = await db
    .prepare(
      `SELECT id, date, status, completed_at, note FROM todo_instances
        WHERE todo_id = ? ORDER BY date DESC LIMIT ?`,
    )
    .bind(todoId, limit)
    .all<{ id: string; date: string; status: InstanceStatus; completed_at: number | null; note: string }>();
  return results;
}

export { localDate };
