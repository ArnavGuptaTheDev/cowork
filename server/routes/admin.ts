import { createMiddleware } from 'hono/factory';
import { inviteSchema } from '../../shared/schemas';
import { isSuperAdmin, normaliseEmail } from '../../shared/authz';
import type { AppEnv } from '../env';
import type { UserRow } from '../db';
import { badRequest, forbidden, notFound } from '../http';
import { deleteUserSessions } from '../auth/session';
import { unpair } from '../services/users';
import { body, router } from './common';

export const adminRoutes = router();

const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (!isSuperAdmin(c.get('user').email, c.env.SUPER_ADMIN_EMAIL)) throw forbidden('Admins only');
  await next();
});

adminRoutes.use('/admin/*', requireAdmin);

adminRoutes.get('/admin/invites', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT i.email, i.created_at, u.id AS user_id, u.name, u.last_login_at
       FROM invites i LEFT JOIN users u ON u.email = i.email
      ORDER BY i.created_at DESC`,
  ).all<{ email: string; created_at: number; user_id: string | null; name: string | null; last_login_at: number | null }>();
  return c.json({
    invites: results.map((r) => ({
      email: r.email,
      invitedAt: r.created_at,
      joined: !!r.user_id,
      name: r.name,
      lastLoginAt: r.last_login_at,
    })),
  });
});

adminRoutes.post('/admin/invites', async (c) => {
  const { email } = await body(c, inviteSchema);
  if (isSuperAdmin(email, c.env.SUPER_ADMIN_EMAIL)) throw badRequest('The admin can always sign in');
  await c.env.DB.prepare('INSERT OR IGNORE INTO invites (email, invited_by, created_at) VALUES (?, ?, ?)')
    .bind(email, c.get('user').id, c.get('now'))
    .run();
  return c.json({ ok: true }, 201);
});

/** Revoking removes the invite, signs the person out everywhere, unpairs them and drops their push subscriptions. Their data is kept. */
adminRoutes.delete('/admin/invites/:email', async (c) => {
  const email = normaliseEmail(decodeURIComponent(c.req.param('email')));
  if (isSuperAdmin(email, c.env.SUPER_ADMIN_EMAIL)) throw badRequest("You can't revoke yourself");
  const r = await c.env.DB.prepare('DELETE FROM invites WHERE email = ?').bind(email).run();
  if (!r.meta.changes) throw notFound('No invite for that email');
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<UserRow>();
  if (user) {
    await deleteUserSessions(c.env, user.id);
    await unpair(c.env.DB, user, c.get('now'));
    await c.env.DB.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').bind(user.id).run();
  }
  return c.json({ ok: true });
});
