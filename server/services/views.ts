// Read models for the Today, Week/Month, Habits and Projects views.
// Every list shows the owner's items plus the shared items owned by the owner's partner.
import { occurrencesBetween, ruleFromColumns, type Recurrence } from '../../shared/recurrence';
import { habitStats, type HabitStats, type InstanceStatus } from '../../shared/streaks';
import { addDays, dateRange, localDate } from '../../shared/time';
import { placeholders, projectDto, type Category, type ProjectDto, type ProjectRow, type TodoRow, type UserRow } from '../db';
import { badRequest, notFound } from '../http';
import { getPartner, privacyFilter, SHARED_SQL } from './access';
import { STATUS_SQL } from './pause';
import { materializeUser, scheduleOf } from './todos';

export type ItemStatus = InstanceStatus | 'upcoming';

export interface DayItem {
  instanceId: string | null;
  todoId: string;
  ownerId: string;
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
  /** Shared by flag or through its project. */
  isShared: boolean;
  /** Shared todos: who it's for (user id), null = either of us. */
  assignedTo: string | null;
  completedBy: string | null;
  /** May the viewer tick it off / edit it? */
  canEdit: boolean;
  suggestedBy: string | null;
  photoCount: number;
  commentCount: number;
  reactions: { userId: string; emoji: string }[];
  /** Checklist progress for this occurrence. */
  subtasks: { done: number; total: number } | null;
  /** Joint habits: who has checked in for this occurrence. */
  isJoint: boolean;
  jointDone: string[];
  streak: number | null;
}

type JoinedRow = TodoRow & {
  instance_id: string;
  date: string;
  status: InstanceStatus;
  completed_on: string | null;
  completed_by: string | null;
  project_name: string | null;
  project_color: string | null;
  project_shared: number | null;
  photo_count: number;
  comment_count: number;
  subtask_total: number;
  subtask_done: number;
};

const ITEM_SELECT = `
  SELECT t.*, i.id AS instance_id, i.date, ${STATUS_SQL} AS status, i.completed_on, i.completed_by,
         p.name AS project_name, p.color AS project_color, p.is_shared AS project_shared,
         (SELECT COUNT(*) FROM photos ph WHERE ph.todo_id = t.id) AS photo_count,
         (SELECT COUNT(*) FROM comments c WHERE c.todo_id = t.id) AS comment_count,
         (SELECT COUNT(*) FROM subtasks s WHERE s.todo_id = t.id) AS subtask_total,
         (SELECT COUNT(*) FROM subtask_checks sc WHERE sc.instance_id = i.id) AS subtask_done
    FROM todo_instances i
    JOIN todos t ON t.id = i.todo_id
    LEFT JOIN projects p ON p.id = t.project_id`;

type TodoWithProject = TodoRow & { project_name: string | null; project_color: string | null; project_shared: number | null };

const TODO_SELECT = `
  SELECT t.*, p.name AS project_name, p.color AS project_color, p.is_shared AS project_shared
    FROM todos t LEFT JOIN projects p ON p.id = t.project_id`;

function isShared(r: { is_shared: number; project_shared: number | null }): boolean {
  return r.is_shared === 1 || r.project_shared === 1;
}

function projectRef(r: TodoWithProject) {
  return r.project_id && r.project_name ? { id: r.project_id, name: r.project_name, color: r.project_color ?? 'clay' } : null;
}

function baseItem(r: TodoWithProject, viewer: UserRow) {
  const shared = isShared(r);
  return {
    todoId: r.id,
    ownerId: r.user_id,
    title: r.title,
    notes: r.notes,
    category: r.category,
    project: projectRef(r),
    dueTime: r.due_time,
    reminderTime: r.reminder_time,
    recurrence: ruleFromColumns(r),
    isPrivate: r.is_private === 1,
    isShared: shared,
    assignedTo: shared ? r.assigned_to : null,
    // Lists only ever contain the viewer's items, or the partner's visible/shared ones.
    canEdit: r.user_id === viewer.id || shared,
    suggestedBy: r.suggested_by,
    isJoint: r.is_joint === 1 && shared,
  };
}

function toItem(r: JoinedRow, today: string, viewer: UserRow, streaks: Map<string, number>): DayItem {
  return {
    ...baseItem(r, viewer),
    instanceId: r.instance_id,
    date: r.date,
    status: r.status,
    carriedOverFrom: r.recurrence === 'none' && r.date < today ? r.date : null,
    completedBy: r.completed_by,
    photoCount: r.photo_count,
    commentCount: r.comment_count,
    reactions: [],
    subtasks: r.subtask_total > 0 ? { done: r.subtask_done, total: r.subtask_total } : null,
    jointDone: [],
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
        `SELECT i.todo_id, i.date, ${STATUS_SQL} AS status FROM todo_instances i
          WHERE i.todo_id IN (${placeholders(ids.length)}) AND i.date >= ? ORDER BY i.date`,
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

/** Attaches reactions to items (by instance). */
async function attachReactions(db: D1Database, items: DayItem[]): Promise<void> {
  const ids = items.map((i) => i.instanceId).filter((x): x is string => !!x);
  const byInstance = new Map<string, { userId: string; emoji: string }[]>();
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    const { results } = await db
      .prepare(`SELECT instance_id, user_id, emoji FROM reactions WHERE instance_id IN (${placeholders(part.length)}) ORDER BY created_at`)
      .bind(...part)
      .all<{ instance_id: string; user_id: string; emoji: string }>();
    for (const r of results) byInstance.set(r.instance_id, [...(byInstance.get(r.instance_id) ?? []), { userId: r.user_id, emoji: r.emoji }]);
  }
  for (const it of items) if (it.instanceId) it.reactions = byInstance.get(it.instanceId) ?? [];
  // Joint habits: who has checked in.
  const jointIds = items.filter((i) => i.isJoint && i.instanceId).map((i) => i.instanceId!);
  if (jointIds.length) {
    const { results } = await db
      .prepare(`SELECT instance_id, user_id FROM instance_completions WHERE instance_id IN (${placeholders(jointIds.length)})`)
      .bind(...jointIds)
      .all<{ instance_id: string; user_id: string }>();
    for (const it of items) if (it.isJoint) it.jointDone = results.filter((r) => r.instance_id === it.instanceId).map((r) => r.user_id);
  }
}

async function streaksFor(db: D1Database, rows: { id: string; recurrence: string }[], today: string) {
  const ids = [...new Set(rows.filter((r) => r.recurrence !== 'none').map((r) => r.id))];
  const histories = await loadHistories(db, ids, addDays(today, -400));
  const streaks = new Map<string, number>();
  for (const [id, h] of histories) streaks.set(id, habitStats(h, today).currentStreak);
  return streaks;
}

export interface TodayView {
  date: string;
  timezone: string;
  items: DayItem[];
  summary: { done: number; total: number };
}

function todayRows(db: D1Database, userId: string, today: string, extra: string) {
  return db
    .prepare(
      `${ITEM_SELECT}
        WHERE i.user_id = ?
          AND (i.date = ?
               OR (t.recurrence = 'none' AND i.status = 'pending' AND i.date < ?)
               OR (t.recurrence = 'none' AND i.status = 'done' AND i.date < ? AND i.completed_on = ?))
          ${extra}`,
    )
    .bind(userId, today, today, today, today)
    .all<JoinedRow>();
}

/**
 * The owner's day as `viewer` sees it: the owner's items (private ones only for the owner themself)
 * plus the shared items owned by the owner's partner, on that partner's own calendar day.
 */
export async function todayView(db: D1Database, owner: UserRow, viewer: UserRow, now: number): Promise<TodayView> {
  const asPartner = viewer.id !== owner.id;
  const today = await materializeUser(db, owner, now);
  const partner = await getPartner(db, owner);
  const own = await todayRows(db, owner.id, today, privacyFilter(asPartner));
  let theirs: JoinedRow[] = [];
  let partnerToday = today;
  if (partner) {
    partnerToday = await materializeUser(db, partner, now);
    theirs = (await todayRows(db, partner.id, partnerToday, ` AND ${SHARED_SQL}`)).results;
  }
  const streaks = await streaksFor(db, [...own.results, ...theirs], today);
  const items = sortItems([
    ...own.results.map((r) => toItem(r, today, viewer, streaks)),
    ...theirs.map((r) => toItem(r, partnerToday, viewer, streaks)),
  ]);
  await attachReactions(db, items);
  // Paused occurrences don't count towards the day.
  const counted = items.filter((i) => i.status !== 'paused');
  return {
    date: today,
    timezone: owner.timezone,
    items,
    summary: { done: counted.filter((i) => i.status === 'done').length, total: counted.length },
  };
}

/** True when the user has at least one item of their own today and every one is done (private ones included). */
export async function allDoneToday(db: D1Database, owner: UserRow, now: number): Promise<boolean> {
  const v = await todayView(db, owner, owner, now);
  const mine = v.items.filter((i) => (i.ownerId === owner.id || i.assignedTo === owner.id) && i.status !== 'paused');
  return mine.length > 0 && mine.every((i) => i.status === 'done');
}

export interface RangeView {
  from: string;
  to: string;
  today: string;
  days: { date: string; items: DayItem[] }[];
}

export const MAX_RANGE_DAYS = 62;

async function rangeItems(
  db: D1Database,
  user: UserRow,
  viewer: UserRow,
  today: string,
  from: string,
  to: string,
  extra: string,
): Promise<DayItem[]> {
  const out: DayItem[] = [];
  const none = new Map<string, number>();
  const seen = new Set<string>();
  // Stored instances: one-off todos (any date) and recurring ones up to today.
  const { results: stored } = await db
    .prepare(`${ITEM_SELECT} WHERE i.user_id = ? AND i.date BETWEEN ? AND ? ${extra}`)
    .bind(user.id, from, to)
    .all<JoinedRow>();
  for (const r of stored) {
    const item = toItem(r, today, viewer, none);
    item.carriedOverFrom = null;
    out.push(item);
    seen.add(`${r.id}|${r.date}`);
  }
  // Projected future occurrences of recurring todos.
  if (to > today) {
    const { results: recurring } = await db
      .prepare(
        `${TODO_SELECT}
          WHERE t.user_id = ? AND t.recurrence != 'none' AND t.start_date <= ?
            AND (t.end_date IS NULL OR t.end_date >= ?) ${extra}`,
      )
      .bind(user.id, to, from)
      .all<TodoWithProject>();
    const futureFrom = addDays(today, 1) > from ? addDays(today, 1) : from;
    for (const t of recurring) {
      for (const d of occurrencesBetween(scheduleOf(t), futureFrom, to)) {
        if (seen.has(`${t.id}|${d}`)) continue;
        out.push({
          ...baseItem(t, viewer),
          instanceId: null,
          date: d,
          status: 'upcoming',
          carriedOverFrom: null,
          completedBy: null,
          photoCount: 0,
          commentCount: 0,
          reactions: [],
          subtasks: null,
          jointDone: [],
          streak: null,
        });
      }
    }
  }
  return out;
}

export async function rangeView(
  db: D1Database,
  owner: UserRow,
  viewer: UserRow,
  from: string,
  to: string,
  now: number,
): Promise<RangeView> {
  if (dateRange(from, to).length > MAX_RANGE_DAYS) throw badRequest(`Ranges are limited to ${MAX_RANGE_DAYS} days`);
  const asPartner = viewer.id !== owner.id;
  const today = await materializeUser(db, owner, now);
  const items = await rangeItems(db, owner, viewer, today, from, to, privacyFilter(asPartner));
  const partner = await getPartner(db, owner);
  if (partner) {
    const partnerToday = await materializeUser(db, partner, now);
    items.push(...(await rangeItems(db, partner, viewer, partnerToday, from, to, ` AND ${SHARED_SQL}`)));
  }
  await attachReactions(db, items);
  const byDate = new Map<string, DayItem[]>();
  for (const it of items) (byDate.get(it.date) ?? byDate.set(it.date, []).get(it.date)!).push(it);
  return {
    from,
    to,
    today,
    days: dateRange(from, to).map((date) => ({ date, items: sortItems(byDate.get(date) ?? []) })),
  };
}

export interface HabitView {
  todoId: string;
  ownerId: string;
  title: string;
  category: Category;
  recurrence: Recurrence;
  project: { id: string; name: string; color: string } | null;
  isPrivate: boolean;
  isShared: boolean;
  canEdit: boolean;
  stats: HabitStats;
  todayInstanceId: string | null;
  todayStatus: InstanceStatus | null;
  /** Last 14 days, oldest first: status, or null when not scheduled that day. */
  recent: { date: string; status: InstanceStatus | null }[];
  ended: boolean;
}

async function habitsFor(db: D1Database, user: UserRow, viewer: UserRow, today: string, extra: string): Promise<HabitView[]> {
  const { results } = await db
    .prepare(
      `${TODO_SELECT}
        WHERE t.user_id = ? AND t.recurrence != 'none' ${extra}
        ORDER BY CASE t.category WHEN 'habit' THEN 0 ELSE 1 END, t.created_at`,
    )
    .bind(user.id)
    .all<TodoWithProject>();
  const histories = await loadHistories(
    db,
    results.map((r) => r.id),
    addDays(today, -400),
  );
  const { results: inst } = await db
    .prepare(`SELECT id, todo_id FROM todo_instances WHERE user_id = ? AND date = ?`)
    .bind(user.id, today)
    .all<{ id: string; todo_id: string }>();
  const todayIds = new Map(inst.map((i) => [i.todo_id, i.id]));
  const recentDates = dateRange(addDays(today, -13), today);
  return results.map((t) => {
    const h = histories.get(t.id) ?? [];
    const byDate = new Map(h.map((e) => [e.date, e.status]));
    const b = baseItem(t, viewer);
    return {
      todoId: t.id,
      ownerId: t.user_id,
      title: t.title,
      category: t.category,
      recurrence: b.recurrence,
      project: b.project,
      isPrivate: b.isPrivate,
      isShared: b.isShared,
      canEdit: b.canEdit,
      stats: habitStats(h, today),
      todayInstanceId: todayIds.get(t.id) ?? null,
      todayStatus: byDate.get(today) ?? null,
      recent: recentDates.map((d) => ({ date: d, status: byDate.get(d) ?? null })),
      ended: !!t.end_date && t.end_date < today,
    };
  });
}

export async function habitsView(db: D1Database, owner: UserRow, viewer: UserRow, now: number) {
  const asPartner = viewer.id !== owner.id;
  const today = await materializeUser(db, owner, now);
  const habits = await habitsFor(db, owner, viewer, today, privacyFilter(asPartner));
  const partner = await getPartner(db, owner);
  if (partner) {
    const partnerToday = await materializeUser(db, partner, now);
    habits.push(...(await habitsFor(db, partner, viewer, partnerToday, ` AND ${SHARED_SQL}`)));
  }
  return { today, habits };
}

export interface ProjectSummary extends ProjectDto {
  progress: { done: number; total: number };
  recurringCount: number;
}

/** SQL: todos visible to the viewer (private todos only to their owner). */
const VISIBLE_TODO = '(t.user_id = ? OR t.is_private = 0)';

export async function projectsView(db: D1Database, owner: UserRow, viewer: UserRow, includeArchived: boolean) {
  const asPartner = viewer.id !== owner.id;
  const partner = await getPartner(db, owner);
  const archived = includeArchived ? '' : ' AND p.archived_at IS NULL';
  const { results } = await db
    .prepare(
      `SELECT p.*,
          (SELECT COUNT(*) FROM todos t WHERE t.project_id = p.id AND t.recurrence = 'none' AND ${VISIBLE_TODO}) AS total,
          (SELECT COUNT(*) FROM todos t JOIN todo_instances i ON i.todo_id = t.id
            WHERE t.project_id = p.id AND t.recurrence = 'none' AND i.status = 'done' AND ${VISIBLE_TODO}) AS done,
          (SELECT COUNT(*) FROM todos t WHERE t.project_id = p.id AND t.recurrence != 'none' AND ${VISIBLE_TODO}) AS recurring
         FROM projects p
        WHERE ((p.user_id = ?${asPartner ? ' AND p.is_private = 0' : ''})
               OR (p.user_id = ? AND p.is_shared = 1))${archived}
        ORDER BY p.archived_at IS NOT NULL, p.created_at`,
    )
    .bind(viewer.id, viewer.id, viewer.id, owner.id, partner?.id ?? '')
    .all<ProjectRow & { total: number; done: number; recurring: number }>();
  return results.map<ProjectSummary>((r) => ({
    ...projectDto(r),
    progress: { done: r.done, total: r.total },
    recurringCount: r.recurring,
  }));
}

export interface ProjectTodo {
  todoId: string;
  ownerId: string;
  title: string;
  category: Category;
  recurrence: Recurrence;
  isPrivate: boolean;
  isShared: boolean;
  canEdit: boolean;
  dueTime: string | null;
  startDate: string;
  /** One-off: its instance. Recurring: null. */
  instanceId: string | null;
  status: InstanceStatus | null;
  stats: HabitStats | null;
  photoCount: number;
}

/** A project as the viewer sees it: their own, their partner's (non-private), or a shared one. */
export async function projectView(db: D1Database, viewer: UserRow, projectId: string, now: number) {
  const p = await db.prepare(`SELECT * FROM projects WHERE id = ?`).bind(projectId).first<ProjectRow>();
  if (!p) throw notFound('Project not found');
  const isOwner = p.user_id === viewer.id;
  const partner = await getPartner(db, viewer);
  const partnerProject = !!partner && partner.id === p.user_id;
  if (!isOwner && !(partnerProject && p.is_private === 0)) throw notFound('Project not found');
  const shared = p.is_shared === 1;
  const today = await materializeUser(db, viewer, now);
  if (partner) await materializeUser(db, partner, now);
  const { results } = await db
    .prepare(
      `SELECT t.*,
          (SELECT i.id FROM todo_instances i WHERE i.todo_id = t.id ORDER BY i.date DESC LIMIT 1) AS instance_id,
          (SELECT ${STATUS_SQL} FROM todo_instances i WHERE i.todo_id = t.id ORDER BY i.date DESC LIMIT 1) AS status,
          (SELECT COUNT(*) FROM photos ph WHERE ph.todo_id = t.id) AS photo_count
         FROM todos t
        WHERE t.project_id = ? AND ${VISIBLE_TODO}
        ORDER BY t.start_date, t.created_at`,
    )
    .bind(projectId, viewer.id)
    .all<TodoRow & { instance_id: string | null; status: InstanceStatus | null; photo_count: number }>();
  const recurringIds = results.filter((t) => t.recurrence !== 'none').map((t) => t.id);
  const histories = await loadHistories(db, recurringIds, addDays(today, -400));
  const todos: ProjectTodo[] = results.map((t) => {
    const recurring = t.recurrence !== 'none';
    const todoShared = shared || t.is_shared === 1;
    return {
      todoId: t.id,
      ownerId: t.user_id,
      title: t.title,
      category: t.category,
      recurrence: ruleFromColumns(t),
      isPrivate: t.is_private === 1,
      isShared: todoShared,
      canEdit: t.user_id === viewer.id || todoShared,
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
    /** Project settings are the owner's; adding todos is open to both on a shared project. */
    canManage: isOwner,
    canAdd: isOwner || shared,
    progress: { done: oneOff.filter((t) => t.status === 'done').length, total: oneOff.length },
    todos,
  };
}

/** Recent instances (newest first) for the todo detail sheet. */
export async function recentInstances(db: D1Database, todoId: string, limit = 60) {
  const { results } = await db
    .prepare(
      `SELECT i.id, i.date, ${STATUS_SQL} AS status, i.completed_at, i.completed_by, i.note FROM todo_instances i
        WHERE i.todo_id = ? ORDER BY i.date DESC LIMIT ?`,
    )
    .bind(todoId, limit)
    .all<{ id: string; date: string; status: InstanceStatus; completed_at: number | null; completed_by: string | null; note: string }>();
  return results;
}

export { localDate };
