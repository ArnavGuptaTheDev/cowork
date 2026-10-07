// Cron Worker (every 5 minutes): materialises today's recurring instances for every user,
// then sends Web Push for reminders that have come due.
import type { UserRow } from '../../../server/db';
import { sendPushToUser, type PushEnv } from '../../../server/services/notify';
import { materializeUser } from '../../../server/services/todos';
import { localTime } from '../../../shared/time';

export interface Env extends PushEnv {
  DB: D1Database;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  APP_ORIGIN?: string;
}

/** Reminders older than this are dropped instead of sent late (e.g. after an outage). */
export const REMINDER_GRACE_MS = 30 * 60_000;

interface DueRow {
  id: string;
  user_id: string;
  title: string;
  due_time: string | null;
  timezone: string;
  reminder_at: number;
}

export async function runReminders(env: Env, now: number, fetchFn: typeof fetch = fetch) {
  const { results: users } = await env.DB.prepare('SELECT * FROM users').all<UserRow>();
  for (const u of users) {
    try {
      await materializeUser(env.DB, u, now);
    } catch (e) {
      console.error('materialize failed', u.id, e);
    }
  }

  const { results: due } = await env.DB.prepare(
    `SELECT i.id, i.user_id, i.reminder_at, t.title, t.due_time, u.timezone
       FROM todo_instances i
       JOIN todos t ON t.id = i.todo_id
       JOIN users u ON u.id = i.user_id
      WHERE i.status = 'pending' AND i.reminded_at IS NULL AND i.reminder_at IS NOT NULL
        AND i.reminder_at <= ? AND i.reminder_at > ?
      ORDER BY i.reminder_at
      LIMIT 500`,
  )
    .bind(now, now - REMINDER_GRACE_MS)
    .all<DueRow>();

  let sent = 0;
  for (const r of due) {
    // Claim first so overlapping cron runs never double-send.
    const claim = await env.DB.prepare('UPDATE todo_instances SET reminded_at = ? WHERE id = ? AND reminded_at IS NULL')
      .bind(now, r.id)
      .run();
    if (!claim.meta.changes) continue;
    sent += await sendPushToUser(
      env,
      r.user_id,
      {
        title: r.title,
        body: r.due_time ? `Due at ${r.due_time}` : `Reminder · ${localTime(r.reminder_at, r.timezone)}`,
        url: '/today',
        tag: `reminder-${r.id}`,
      },
      fetchFn,
    );
  }
  return { users: users.length, due: due.length, sent };
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      runReminders(env, Date.now()).then((r) => console.log('reminders', JSON.stringify(r))),
    );
  },
  async fetch() {
    return new Response('CoWork reminders worker. Nothing to see here.', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
