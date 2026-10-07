import { canSignIn, normaliseEmail } from '../../shared/authz';
import { DEFAULT_TIMEZONE } from '../../shared/time';
import type { UserRow } from '../db';
import type { Env } from '../env';

export interface Identity {
  email: string;
  emailVerified: boolean;
  sub: string | null;
  name?: string;
  picture?: string;
}

export async function isInvited(db: D1Database, email: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 AS ok FROM invites WHERE email = ?').bind(normaliseEmail(email)).first();
  return !!row;
}

/**
 * Signs in (or creates) the user for a verified identity. Returns null when the email is not
 * allowed; in that case nothing is written, so no account exists for uninvited people.
 */
export async function signInUser(env: Env, id: Identity, now: number): Promise<UserRow | null> {
  const email = normaliseEmail(id.email);
  if (!canSignIn(email, id.emailVerified, env.SUPER_ADMIN_EMAIL, await isInvited(env.DB, email))) return null;

  const existing = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<UserRow>();
  if (existing) {
    // A Google account is bound to the user on first sign-in; a different account claiming the same email is refused.
    if (existing.google_sub && id.sub && existing.google_sub !== id.sub) return null;
    await env.DB.prepare(
      `UPDATE users SET google_sub = COALESCE(google_sub, ?), name = CASE WHEN name = '' THEN ? ELSE name END,
         avatar_url = COALESCE(?, avatar_url), last_login_at = ? WHERE id = ?`,
    )
      .bind(id.sub, id.name ?? '', id.picture ?? null, now, existing.id)
      .run();
    return env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(existing.id).first<UserRow>();
  }

  const user: UserRow = {
    id: crypto.randomUUID(),
    email,
    google_sub: id.sub,
    name: id.name ?? '',
    avatar_url: id.picture ?? null,
    timezone: DEFAULT_TIMEZONE,
    partner_id: null,
    paired_at: null,
    created_at: now,
    last_login_at: now,
    wrapup_time: '21:00',
    wrapup_sent_on: null,
  };
  await env.DB.prepare(
    `INSERT INTO users (id, email, google_sub, name, avatar_url, timezone, created_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(user.id, user.email, user.google_sub, user.name, user.avatar_url, user.timezone, now, now)
    .run();
  return user;
}

/**
 * Removes a partnership from both sides and withdraws pending suggestions between them.
 * Shared items stay with whoever created them and become unshared; a todo one partner had put in
 * the other's shared project leaves that project.
 */
export async function unpair(db: D1Database, user: UserRow, now: number): Promise<void> {
  const partnerId = user.partner_id;
  if (!partnerId) return;
  await db.batch([
    db.prepare(
      `UPDATE todos SET project_id = NULL
        WHERE (user_id = ?1 AND project_id IN (SELECT id FROM projects WHERE user_id = ?2))
           OR (user_id = ?2 AND project_id IN (SELECT id FROM projects WHERE user_id = ?1))`,
    ).bind(user.id, partnerId),
    db.prepare('UPDATE todos SET is_shared = 0, assigned_to = NULL WHERE user_id IN (?, ?)').bind(user.id, partnerId),
    db.prepare('UPDATE projects SET is_shared = 0 WHERE user_id IN (?, ?)').bind(user.id, partnerId),
    db.prepare('UPDATE users SET partner_id = NULL, paired_at = NULL WHERE id = ? OR (id = ? AND partner_id = ?)').bind(user.id, partnerId, user.id),
    db
      .prepare(
        `UPDATE suggestions SET status = 'withdrawn', responded_at = ?
          WHERE status = 'pending' AND ((from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?))`,
      )
      .bind(now, user.id, partnerId, partnerId, user.id),
  ]);
}
