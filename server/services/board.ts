// Kanban boards: a project's board, and the cross-project "All work" board.
// A card is a todo's current occurrence: a one-off's instance, or a repeating todo's instance today.
import type { Category, ProjectRow, TodoRow, UserRow } from '../db';
import { placeholders } from '../db';
import { notFound } from '../http';
import { getPartner, SHARED_SQL } from './access';
import { materializeUser } from './todos';
import { defaultOf, statusDto, statusesFor, type StatusDto, type StatusRow } from './statuses';
import { boardItems, sortItems, type DayItem } from './views';

/** Done cards older than this drop off the board (they stay in history and the list view). */
export const DONE_CARD_DAYS = 14;

export interface BoardCard extends DayItem {
  /** The column (status id) the card sits in, in the board owner's statuses. */
  columnId: string | null;
}

export interface Board {
  today: string;
  /** Whose statuses make up the columns. */
  columnsOwnerId: string;
  columns: (StatusDto & { cardCount: number })[];
  cards: BoardCard[];
  /** Can the viewer move cards at all (partner boards are read-only unless shared)? */
  canEdit: boolean;
  project: { id: string; name: string; color: string; isShared: boolean } | null;
}

/** Columns: live statuses in order, plus archived ones only while they still hold cards. */
export function boardColumns(statuses: StatusRow[], cards: { columnId: string | null }[]) {
  return statuses
    .map((s) => ({ ...statusDto(s), cardCount: cards.filter((c) => c.columnId === s.id).length }))
    .filter((s) => !s.archived || s.cardCount > 0);
}

/** Picks the current instance of each todo and returns them as list items. */
async function currentCards(db: D1Database, viewer: UserRow, where: string, binds: unknown[], todays: Map<string, string>, now: number) {
  const maxToday = [...todays.values()].sort().pop()!;
  const { results: picks } = await db
    .prepare(
      `SELECT t.id, t.user_id, t.recurrence,
              (SELECT i.id FROM todo_instances i WHERE i.todo_id = t.id AND (t.recurrence = 'none' OR i.date <= ?)
                ORDER BY i.date DESC LIMIT 1) AS iid,
              (SELECT i.date FROM todo_instances i WHERE i.todo_id = t.id AND (t.recurrence = 'none' OR i.date <= ?)
                ORDER BY i.date DESC LIMIT 1) AS idate
         FROM todos t LEFT JOIN projects p ON p.id = t.project_id
        WHERE ${where}`,
    )
    .bind(maxToday, maxToday, ...binds)
    .all<{ id: string; user_id: string; recurrence: string; iid: string | null; idate: string | null }>();
  // Repeating todos only show up on the day they're scheduled.
  const ids = picks
    .filter((p) => p.iid && (p.recurrence === 'none' || p.idate === todays.get(p.user_id)))
    .map((p) => p.iid!);
  const items = await boardItems(db, viewer, ids, todays);
  const cutoff = now - DONE_CARD_DAYS * 86_400_000;
  return items.filter((i) => i.status !== 'done' || (i.completedAt ?? now) >= cutoff);
}

/** A project's board. Columns are the project owner's statuses. */
export async function projectBoard(db: D1Database, viewer: UserRow, projectId: string, now: number): Promise<Board> {
  const p = await db.prepare('SELECT * FROM projects WHERE id = ?').bind(projectId).first<ProjectRow>();
  if (!p) throw notFound('Project not found');
  const partner = await getPartner(db, viewer);
  const isOwner = p.user_id === viewer.id;
  if (!isOwner && !(partner && partner.id === p.user_id && p.is_private === 0)) throw notFound('Project not found');
  const owner = isOwner ? viewer : partner!;
  const todays = new Map<string, string>([[viewer.id, await materializeUser(db, viewer, now)]]);
  if (partner) todays.set(partner.id, await materializeUser(db, partner, now));
  const cards = await currentCards(db, viewer, `t.project_id = ? AND (t.user_id = ? OR t.is_private = 0)`, [projectId, viewer.id], todays, now);
  const statuses = (await statusesFor(db, [owner.id])).get(owner.id)!;
  const withCols: BoardCard[] = cards.map((c) => ({ ...c, columnId: c.stage?.id ?? null }));
  return {
    today: todays.get(viewer.id)!,
    columnsOwnerId: owner.id,
    columns: boardColumns(statuses, withCols),
    cards: sortByPosition(withCols),
    canEdit: isOwner || p.is_shared === 1,
    project: { id: p.id, name: p.name, color: p.color, isShared: p.is_shared === 1 },
  };
}

/**
 * The "All work" board: your todos plus your partner's shared ones, optionally by category.
 * Columns are your statuses; a partner-owned card sits in your status of the same kind.
 */
export async function allWorkBoard(db: D1Database, viewer: UserRow, category: Category | null, now: number): Promise<Board> {
  const partner = await getPartner(db, viewer);
  const todays = new Map<string, string>([[viewer.id, await materializeUser(db, viewer, now)]]);
  if (partner) todays.set(partner.id, await materializeUser(db, partner, now));
  const cat = category ? ' AND t.category = ?' : '';
  const cards = await currentCards(
    db,
    viewer,
    `(t.user_id = ? OR (t.user_id = ? AND ${SHARED_SQL}))${cat}`,
    [viewer.id, partner?.id ?? '', ...(category ? [category] : [])],
    todays,
    now,
  );
  const mine = (await statusesFor(db, [viewer.id])).get(viewer.id)!;
  const withCols: BoardCard[] = cards.map((c) => ({
    ...c,
    columnId: c.ownerId === viewer.id ? (c.stage?.id ?? null) : c.stage ? (defaultOf(mine, c.stage.kind)?.id ?? null) : null,
  }));
  return {
    today: todays.get(viewer.id)!,
    columnsOwnerId: viewer.id,
    columns: boardColumns(mine, withCols),
    cards: sortByPosition(withCols),
    canEdit: true,
    project: null,
  };
}

/** Board order within a column is the manual order (position), falling back to the default list order. */
function sortByPosition(cards: BoardCard[]): BoardCard[] {
  const fallback = sortItems([...cards]);
  const rank = new Map(fallback.map((c, i) => [c.todoId, i]));
  return cards.sort((a, b) => {
    if (a.position && b.position && a.position !== b.position) return a.position < b.position ? -1 : 1;
    if (!a.position !== !b.position) return a.position ? -1 : 1;
    return (rank.get(a.todoId) ?? 0) - (rank.get(b.todoId) ?? 0);
  });
}

export async function positionsOf(db: D1Database, ids: string[]): Promise<Map<string, TodoRow>> {
  if (!ids.length) return new Map();
  const { results } = await db.prepare(`SELECT * FROM todos WHERE id IN (${placeholders(ids.length)})`).bind(...ids).all<TodoRow>();
  return new Map(results.map((r) => [r.id, r]));
}
