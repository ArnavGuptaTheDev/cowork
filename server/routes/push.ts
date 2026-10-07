import { pushSubscriptionSchema, pushUnsubscribeSchema } from '../../shared/schemas';
import { sendPushToUser } from '../services/notify';
import { body, router } from './common';

export const pushRoutes = router();

pushRoutes.post('/push/subscribe', async (c) => {
  const sub = await body(c, pushSubscriptionSchema);
  const user = c.get('user');
  await c.env.DB.prepare(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
       user_agent = excluded.user_agent`,
  )
    .bind(crypto.randomUUID(), user.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth, c.req.header('user-agent')?.slice(0, 200) ?? null, c.get('now'))
    .run();
  return c.json({ ok: true });
});

pushRoutes.post('/push/unsubscribe', async (c) => {
  const { endpoint } = await body(c, pushUnsubscribeSchema);
  await c.env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').bind(endpoint, c.get('user').id).run();
  return c.json({ ok: true });
});

pushRoutes.post('/push/test', async (c) => {
  const delivered = await sendPushToUser(c.env, c.get('user').id, {
    title: 'CoWork notifications are on',
    body: "This is what a reminder will look like.",
    url: '/today',
    tag: 'test',
  });
  return c.json({ delivered });
});
