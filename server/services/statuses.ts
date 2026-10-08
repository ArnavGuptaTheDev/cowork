// Statuses (per user) and the status workflow of an instance: checkbox, blockers, done-kind completion.
// App logic always keys off `kind` (todo | active | blocked | done), never the status's name.
import type { StatusKind } from '../../shared/constants';
import { placeholders, type UserRow } from '../db';
import type { Env } from '../env';
import { badRequest } from '../http';

export interface StatusRow {
  id: string;
  user_id: string;
  name: string;
  color: string;
  kind: StatusKind;
  position: number;
  is_default: number;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface StatusDto {
  id: string;
  name: string;
  color: string;
  kind: StatusKind;
  position: number;
  isDefault: boolean;
  archived: boolean;
}

export const statusDto = (s: StatusRow): StatusDto => ({
  id: s.id,
  name: s.name,
  color: s.color,
  kind: s.kind,
  position: s.position,
  isDefault: s.is_default === 1,
  archived: s.archived_at !== null,
});

const DEFAULTS: { name: string; color: string; kind: StatusKind }[] = [
  { name: 'To do', color: 'ink', kind: 'todo' },
  { name: 'In progress', color: 'sky', kind: 'active' },
  { name: 'Blocked', color: 'clay', kind: 'blocked' },
  { name: 'Done', color: 'sage', kind: 'done' },
];

/** A user's statuses in order, seeding the four defaults the first time. */
export async function ensureStatuses(db: D1Database, userId: string, now = Date.now()): Promise<StatusRow[]> {
  const { results } = await db.prepare('SELECT * FROM statuses WHERE user_id = ? ORDER BY position, created_at').bind(userId).all<StatusRow>();
  if (results.length) return results;
  await db.batch(
    DEFAULTS.map((d, i) =>
      db
        .prepare(
          `INSERT INTO statuses (id, user_id, name, color, kind, position, is_default, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .bind(crypto.randomUUID(), userId, d.name, d.color, d.kind, (i + 1) * 1000, now, now),
    ),
  );
  return (await db.prepare('SELECT * FROM statuses WHERE user_id = ? ORDER BY position').bind(userId).all<StatusRow>()).results;
}

/** Statuses for several users at once (seeding any that have none). */
export async function statusesFor(db: D1Database, userIds: string[]): Promise<Map<string, StatusRow[]>> {
  const ids = [...new Set(userIds)];
  const out = new Map<string, StatusRow[]>();
  if (!ids.length) return out;
  const { results } = await db
    .prepare(`SELECT * FROM statuses WHERE user_id IN (${placeholders(ids.length)}) ORDER BY position, created_at`)
    .bind(...ids)
    .all<StatusRow>();
  for (const id of ids) {
    const mine = results.filter((s) => s.user_id === id);
    out.set(id, mine.length ? mine : await ensureStatuses(db, id));
  }
  return out;
}

/** The default status of a kind: the flagged default, else the first live one of that kind. */
export function defaultOf(list: StatusRow[], kind: StatusKind): StatusRow | null {
  const live = list.filter((s) => s.kind === kind && s.archived_at === null);
  return live.find((s) => s.is_default === 1) ?? live[0] ?? null;
}

/**
 * The effective status of an instance: its own status_id, or (NULL) the default for its completion state.
 * New occurrences therefore start at the default todo-kind status without being written to.
 */
export function effectiveStatus(list: StatusRow[], statusId: string | null, done: boolean): StatusRow | null {
  const own = statusId ? list.find((s) => s.id === statusId) : undefined;
  return own ?? defaultOf(list, done ? 'done' : 'todo');
}

/** Pure check used by the settings routes: there must always be a live todo-kind and done-kind status. */
export function keepsRequiredKinds(list: Pick<StatusRow, 'id' | 'kind' | 'archived_at'>[], removingId: string): boolean {
  const remaining = list.filter((s) => s.id !== removingId && s.archived_at === null);
  return remaining.some((s) => s.kind === 'todo') && remaining.some((s) => s.kind === 'done');
}

/**
 * Resolves a requested status for a todo owned by `owner`. The id may be one of the owner's statuses, or
 * (cross-project boards, shared todos) one of the actor's own, which is mapped to the owner's status of the same kind.
 */
export async function resolveTargetStatus(db: D1Database, owner: UserRow, actor: UserRow, statusId: string): Promise<StatusRow> {
  const map = await statusesFor(db, [owner.id, actor.id]);
  const ownerList = map.get(owner.id)!;
  const direct = ownerList.find((s) => s.id === statusId);
  if (direct) {
    if (direct.archived_at !== null) throw badRequest('That status is archived');
    return direct;
  }
  const mine = map.get(actor.id)!.find((s) => s.id === statusId);
  if (!mine) throw badRequest('Unknown status');
  const mapped = defaultOf(ownerList, mine.kind);
  if (!mapped) throw badRequest(`There's no “${mine.kind}” status for this todo's owner`);
  return mapped;
}

/** Closes an instance's open blocker, if any. */
export function resolveBlockerStmt(env: Env, instanceId: string, by: string, now: number) {
  return env.DB.prepare('UPDATE blockers SET resolved_at = ?, resolved_by = ? WHERE instance_id = ? AND resolved_at IS NULL').bind(now, by, instanceId);
}
