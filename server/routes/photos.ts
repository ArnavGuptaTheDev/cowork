import { idSchema, MAX_PHOTO_BYTES, photoUploadFieldsSchema } from '../../shared/schemas';
import { photoDto } from '../db';
import { badRequest, HttpError, notFound, parse } from '../http';
import { deleteOwnPhoto, getViewablePhoto, resolveUploadTarget, storePhoto } from '../services/photos';
import { router } from './common';

export const photoRoutes = router();

photoRoutes.post('/photos', async (c) => {
  const len = Number(c.req.header('content-length') ?? 0);
  if (len > MAX_PHOTO_BYTES + 64 * 1024) throw new HttpError(413, 'too_large', 'Photos must be under 4 MB');
  if (!(c.req.header('content-type') ?? '').startsWith('multipart/form-data')) {
    throw new HttpError(415, 'unsupported_media_type', 'Expected multipart/form-data');
  }
  const form = await c.req.parseBody();
  const file = form.file;
  if (!(file instanceof File)) throw badRequest('Missing file');
  const fields = parse(photoUploadFieldsSchema, {
    todoId: form.todoId || undefined,
    instanceId: form.instanceId || undefined,
    suggestionId: form.suggestionId || undefined,
    width: form.width || undefined,
    height: form.height || undefined,
  });
  const user = c.get('user');
  const target = await resolveUploadTarget(c.env.DB, user, fields);
  const row = await storePhoto(c.env, user, target, file, fields, c.get('now'));
  return c.json({ photo: photoDto(row) }, 201);
});

/** Authenticated photo delivery. The bucket is private; this is the only way to read an object. */
photoRoutes.get('/photos/:id', async (c) => {
  const id = parse(idSchema, c.req.param('id'));
  const photo = await getViewablePhoto(c.env.DB, c.get('user'), id);
  if (!photo) throw notFound('Photo not found');
  const obj = await c.env.PHOTOS.get(photo.r2_key);
  if (!obj) throw notFound('Photo not found');
  return new Response(obj.body, {
    headers: {
      'Content-Type': photo.content_type,
      'Content-Length': String(obj.size),
      'Cache-Control': 'private, max-age=300',
      'Content-Disposition': 'inline',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
      ETag: obj.httpEtag,
    },
  });
});

photoRoutes.delete('/photos/:id', async (c) => {
  await deleteOwnPhoto(c.env, c.get('user').id, parse(idSchema, c.req.param('id')));
  return c.json({ ok: true });
});
