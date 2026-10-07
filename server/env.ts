import type { UserRow } from './db';

/** Bindings available to the Worker (see wrangler.toml and .dev.vars.example). */
export interface Env {
  DB: D1Database;
  PHOTOS: R2Bucket;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  SUPER_ADMIN_EMAIL: string;
  /** Public origin, e.g. https://cowork.arnavg.me. Used for push links and the VAPID subject. */
  APP_ORIGIN?: string;
  /** Local development only: enables /api/auth/dev-login on localhost. Never set this in production. */
  DEV_LOGIN?: string;
}

export interface SessionInfo {
  tokenHash: string;
  csrfToken: string;
  expiresAt: number;
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    user: UserRow;
    session: SessionInfo;
    now: number;
  };
};
