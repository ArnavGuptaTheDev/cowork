import { arePartners, canEditTodo, canViewTodo, isSharedTodo } from '../../shared/authz';
import type { ProjectRow, TodoRow, UserRow } from '../db';
import { forbidden, notFound } from '../http';

export async function getUser(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();
}

/** The viewer's partner, but only if the partnership is mutual. */
export async function getPartner(db: D1Database, user: UserRow): Promise<UserRow | null> {
  if (!user.partner_id) return null;
  const p = await getUser(db, user.partner_id);
  if (!p || !arePartners({ id: user.id, partnerId: user.partner_id }, p.id, p.partner_id)) return null;
  return p;
}

export interface ViewTarget {
  owner: UserRow;
  /** True when the viewer is looking at their partner's data: private items are filtered out. */
  asPartner: boolean;
}

export async function resolveTarget(db: D1Database, viewer: UserRow, who: 'me' | 'partner'): Promise<ViewTarget> {
  if (who === 'me') return { owner: viewer, asPartner: false };
  const partner = await getPartner(db, viewer);
  if (!partner) throw forbidden('You are not paired with anyone');
  return { owner: partner, asPartner: true };
}

/** SQL fragment that hides private todos (alias t) and todos in private projects (alias p) from partners. */
export function privacyFilter(asPartner: boolean): string {
  return asPartner ? ' AND t.is_private = 0 AND (p.id IS NULL OR p.is_private = 0)' : '';
}

/** SQL condition: the todo (alias t, project alias p) is shared, by its own flag or its project's. */
export const SHARED_SQL = '(t.is_shared = 1 OR COALESCE(p.is_shared, 0) = 1)';

// --- Per-todo access (ownership, partnership, sharing) ---

export interface TodoAccess {
  todo: TodoRow;
  owner: UserRow;
  project: ProjectRow | null;
  /** Shared by flag or through a shared project. */
  shared: boolean;
  isOwner: boolean;
  canView: boolean;
  canEdit: boolean;
  /** Owner's partner id when the partnership is mutual, else null. */
  ownerPartnerId: string | null;
}

export function authzTodo(t: TodoRow, project: ProjectRow | null) {
  return {
    userId: t.user_id,
    isPrivate: t.is_private === 1,
    projectPrivate: project?.is_private === 1,
    isShared: t.is_shared === 1,
    projectShared: project?.is_shared === 1,
    assignedTo: t.assigned_to,
  };
}

/** Loads a todo with everything needed to authorise it. Returns null when it doesn't exist or isn't visible. */
export async function todoAccess(db: D1Database, viewer: UserRow, todoId: string): Promise<TodoAccess | null> {
  const todo = await db.prepare('SELECT * FROM todos WHERE id = ?').bind(todoId).first<TodoRow>();
  if (!todo) return null;
  const [owner, project] = await Promise.all([
    todo.user_id === viewer.id ? viewer : getUser(db, todo.user_id),
    todo.project_id ? db.prepare('SELECT * FROM projects WHERE id = ?').bind(todo.project_id).first<ProjectRow>() : null,
  ]);
  if (!owner) return null;
  const v = { id: viewer.id, partnerId: viewer.partner_id };
  const a = authzTodo(todo, project);
  const canView = canViewTodo(v, a, owner.partner_id);
  if (!canView) return null;
  // Seeing someone else's todo already implies a mutual partnership with them (canViewTodo checks it).
  const ownerPartnerId = owner.id === viewer.id ? ((await getPartner(db, viewer))?.id ?? null) : viewer.id;
  return {
    todo,
    owner,
    project,
    shared: isSharedTodo(a),
    isOwner: todo.user_id === viewer.id,
    canView,
    canEdit: canEditTodo(v, a, owner.partner_id),
    ownerPartnerId,
  };
}

/** Like todoAccess, but 404s unless the viewer may edit. */
export async function editableTodo(db: D1Database, viewer: UserRow, todoId: string): Promise<TodoAccess> {
  const a = await todoAccess(db, viewer, todoId);
  if (!a || !a.canEdit) throw notFound('Todo not found');
  return a;
}
