// Sends Web Push notifications to every subscription a user has.
import { buildPushRequest, type VapidKeys } from '../../shared/webpush';

export interface PushEnv {
  DB: D1Database;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  APP_ORIGIN?: string;
}

export interface PushMessage {
  title: string;
  body: string;
  /** Path inside the app to open when the notification is tapped. */
  url: string;
  tag?: string;
  /** Reminder pushes: the instance the service worker's action buttons act on. */
  instanceId?: string;
  actions?: { action: string; title: string }[];
}

interface SubRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

function vapidKeys(env: PushEnv): VapidKeys | null {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
  return {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.APP_ORIGIN?.startsWith('https://') ? env.APP_ORIGIN : 'https://cowork.arnavg.me',
  };
}

export async function sendPushToUser(
  env: PushEnv,
  userId: string,
  msg: PushMessage,
  fetchFn: typeof fetch = fetch,
): Promise<number> {
  const vapid = vapidKeys(env);
  if (!vapid) return 0;
  const { results } = await env.DB.prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?')
    .bind(userId)
    .all<SubRow>();
  let delivered = 0;
  await Promise.all(
    results.map(async (s) => {
      try {
        const req = await buildPushRequest(s, msg, vapid, { urgency: 'normal' });
        const res = await fetchFn(req.endpoint, { method: 'POST', headers: req.headers, body: req.body });
        if (res.status === 404 || res.status === 410) {
          await env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(s.id).run();
        } else if (res.ok) {
          delivered += 1;
          await env.DB.prepare('UPDATE push_subscriptions SET last_success_at = ? WHERE id = ?').bind(Date.now(), s.id).run();
        } else {
          console.warn('push failed', res.status, new URL(s.endpoint).host);
        }
      } catch (e) {
        console.warn('push error', e instanceof Error ? e.message : e);
      }
    }),
  );
  return delivered;
}

/** Sends a notification at most once per (user, kind, ref). */
export async function notifyOnce(env: PushEnv, userId: string, kind: string, ref: string, msg: PushMessage): Promise<void> {
  const r = await env.DB.prepare(
    'INSERT OR IGNORE INTO notification_log (user_id, kind, ref, created_at) VALUES (?, ?, ?, ?)',
  )
    .bind(userId, kind, ref, Date.now())
    .run();
  if ((r.meta?.changes ?? 0) > 0) await sendPushToUser(env, userId, msg);
}
