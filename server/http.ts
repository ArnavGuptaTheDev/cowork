import type { z } from 'zod';

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 415 | 422 | 429 | 500,
    readonly code: string,
    message?: string,
    readonly details?: unknown,
  ) {
    super(message ?? code);
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, 'bad_request', message, details);
export const unauthorized = () => new HttpError(401, 'unauthorized', 'Please sign in');
export const forbidden = (message = 'Not allowed') => new HttpError(403, 'forbidden', message);
export const notFound = (what = 'Not found') => new HttpError(404, 'not_found', what);
export const conflict = (message: string) => new HttpError(409, 'conflict', message);

/** Validates input against a schema; throws a 400 with field errors on failure. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const fields = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw badRequest(fields[0]?.message ?? 'Invalid input', fields);
  }
  return r.data;
}

export async function readJson(req: Request): Promise<unknown> {
  const type = req.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) throw new HttpError(415, 'unsupported_media_type', 'Expected JSON');
  const text = await req.text();
  if (text.length > 64 * 1024) throw new HttpError(413, 'too_large', 'Request body too large');
  if (text === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest('Malformed JSON');
  }
}
