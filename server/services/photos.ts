import { canViewPhoto, type Viewer } from '../../shared/authz';
import { MAX_PHOTO_BYTES, MAX_PHOTOS_PER_TARGET, PHOTO_TYPES } from '../../shared/constants';
import type { PhotoRow, SuggestionRow, TodoRow, UserRow } from '../db';
import type { Env } from '../env';
import { badRequest, HttpError, notFound } from '../http';
import { todoAccess } from './access';

export async function deletePhotoObjects(env: Env, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 500) {
    const part = keys.slice(i, i + 500);
    if (part.length) await env.PHOTOS.delete(part);
  }
}

/** Checks the magic bytes so the stored content type is truthful. */
export function sniffImageType(bytes: Uint8Array): (typeof PHOTO_TYPES)[number] | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

export interface UploadTarget {
  todoId: string | null;
  instanceId: string | null;
  suggestionId: string | null;
}

/**
 * Resolves and authorises an upload target: people who can edit the todo attach photos (the owner, or the
 * partner on a shared todo); suggesters attach to their own pending suggestions.
 */
export async function resolveUploadTarget(
  db: D1Database,
  user: UserRow,
  fields: { todoId?: string; instanceId?: string; suggestionId?: string },
): Promise<UploadTarget> {
  if (fields.instanceId) {
    const i = await db
      .prepare('SELECT id, todo_id FROM todo_instances WHERE id = ?')
      .bind(fields.instanceId)
      .first<{ id: string; todo_id: string }>();
    if (!i || !(await todoAccess(db, user, i.todo_id))?.canEdit) throw notFound('Todo not found');
    return { todoId: i.todo_id, instanceId: i.id, suggestionId: null };
  }
  if (fields.todoId) {
    if (!(await todoAccess(db, user, fields.todoId))?.canEdit) throw notFound('Todo not found');
    return { todoId: fields.todoId, instanceId: null, suggestionId: null };
  }
  if (fields.suggestionId) {
    const s = await db
      .prepare(`SELECT id FROM suggestions WHERE id = ? AND from_user_id = ? AND status = 'pending'`)
      .bind(fields.suggestionId, user.id)
      .first();
    if (!s) throw notFound('Suggestion not found');
    return { todoId: null, instanceId: null, suggestionId: fields.suggestionId };
  }
  throw badRequest('Attach the photo to a todo, a completion or a suggestion');
}

export async function storePhoto(
  env: Env,
  user: UserRow,
  target: UploadTarget,
  file: File,
  dims: { width?: number; height?: number },
  now: number,
): Promise<PhotoRow> {
  if (file.size > MAX_PHOTO_BYTES) throw new HttpError(413, 'too_large', 'Photos must be under 4 MB');
  if (file.size === 0) throw badRequest('Empty file');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffImageType(bytes);
  if (!type) throw new HttpError(415, 'unsupported_media_type', 'Only JPEG, PNG or WebP images');

  const countCol = target.instanceId ? 'instance_id' : target.todoId ? 'todo_id' : 'suggestion_id';
  const countVal = target.instanceId ?? target.todoId ?? target.suggestionId;
  const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM photos WHERE ${countCol} = ?`)
    .bind(countVal)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_PHOTOS_PER_TARGET) throw badRequest(`Up to ${MAX_PHOTOS_PER_TARGET} photos each`);

  const id = crypto.randomUUID();
  const key = `u/${user.id}/${id}`;
  await env.PHOTOS.put(key, bytes, { httpMetadata: { contentType: type } });
  const row: PhotoRow = {
    id,
    owner_id: user.id,
    todo_id: target.todoId,
    instance_id: target.instanceId,
    suggestion_id: target.suggestionId,
    r2_key: key,
    content_type: type,
    size_bytes: bytes.length,
    width: dims.width ?? null,
    height: dims.height ?? null,
    created_at: now,
  };
  try {
    await env.DB.prepare(
      `INSERT INTO photos (id, owner_id, todo_id, instance_id, suggestion_id, r2_key, content_type, size_bytes, width, height, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(row.id, row.owner_id, row.todo_id, row.instance_id, row.suggestion_id, row.r2_key, row.content_type, row.size_bytes, row.width, row.height, row.created_at)
      .run();
  } catch (e) {
    await env.PHOTOS.delete(key);
    throw e;
  }
  return row;
}

/** Loads a photo if (and only if) the viewer may see it. Returns null otherwise, so callers answer 404 either way. */
export async function getViewablePhoto(db: D1Database, viewer: UserRow, photoId: string): Promise<PhotoRow | null> {
  const row = await db
    .prepare(
      `SELECT ph.*, t.user_id AS t_user_id, t.is_private AS t_private, pr.is_private AS p_private,
              s.from_user_id AS s_from, s.to_user_id AS s_to, owner.partner_id AS owner_partner
         FROM photos ph
         JOIN users owner ON owner.id = ph.owner_id
         LEFT JOIN todos t ON t.id = ph.todo_id
         LEFT JOIN projects pr ON pr.id = t.project_id
         LEFT JOIN suggestions s ON s.id = ph.suggestion_id
        WHERE ph.id = ?`,
    )
    .bind(photoId)
    .first<
      PhotoRow & {
        t_user_id: string | null;
        t_private: number | null;
        p_private: number | null;
        s_from: string | null;
        s_to: string | null;
        owner_partner: string | null;
      }
    >();
  if (!row) return null;
  const v: Viewer = { id: viewer.id, partnerId: viewer.partner_id };
  const allowed = canViewPhoto(
    v,
    {
      ownerId: row.owner_id,
      todo: row.t_user_id
        ? { userId: row.t_user_id, isPrivate: row.t_private === 1, projectPrivate: row.p_private === 1 }
        : null,
      suggestion: row.s_from && row.s_to && !row.t_user_id ? { fromUserId: row.s_from, toUserId: row.s_to } : null,
    },
    row.owner_partner,
  );
  return allowed ? row : null;
}

export async function deleteOwnPhoto(env: Env, userId: string, photoId: string): Promise<void> {
  const p = await env.DB.prepare('SELECT * FROM photos WHERE id = ? AND owner_id = ?').bind(photoId, userId).first<PhotoRow>();
  if (!p) throw notFound('Photo not found');
  await env.DB.prepare('DELETE FROM photos WHERE id = ?').bind(photoId).run();
  await env.PHOTOS.delete(p.r2_key);
}

export async function photosForTodo(db: D1Database, todo: TodoRow): Promise<PhotoRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM photos WHERE todo_id = ? ORDER BY created_at')
    .bind(todo.id)
    .all<PhotoRow>();
  return results;
}

export async function photosForSuggestion(db: D1Database, s: SuggestionRow): Promise<PhotoRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM photos WHERE suggestion_id = ? ORDER BY created_at')
    .bind(s.id)
    .all<PhotoRow>();
  return results;
}
