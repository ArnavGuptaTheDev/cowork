import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { readJson, parse } from '../http';
import type { z } from 'zod';

/** A plain router. Session + CSRF middleware are applied once, where routers are mounted (server/app.ts). */
export function router() {
  return new Hono<AppEnv>();
}

export async function body<S extends z.ZodType>(c: Context<AppEnv>, schema: S): Promise<z.output<S>> {
  return parse(schema, await readJson(c.req.raw));
}

export function query<S extends z.ZodType>(c: Context<AppEnv>, schema: S): z.output<S> {
  return parse(schema, c.req.query());
}

/** Runs work after the response (notifications). Falls back to fire-and-forget outside Workers (tests). */
export function defer(c: Context<AppEnv>, work: Promise<unknown>): void {
  const safe = work.catch((e) => console.warn('background task failed', e instanceof Error ? e.message : e));
  try {
    c.executionCtx.waitUntil(safe);
  } catch {
    // No execution context (unit tests): the promise still runs.
  }
}
