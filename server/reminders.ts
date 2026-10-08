// Cron job (every 5 minutes, see wrangler.toml): materialises today's recurring instances for every user,
// sends Web Push for reminders that have come due, and sends each user's evening wrap-up.
import type { UserRow } from './db';
import { publicUser } from './db';
import { sendPushToUser, type PushEnv } from './services/notify';
import { pausedOn } from './services/pause';
import { reconcileCalendars, type GcalEnv } from './services/gcal';
import { materializeUser } from './services/todos';
import { todayView } from './services/views';
import { tomorrowHabits } from './services/tomorrow';
import { DEADLINE_PUSH_TIME } from '../shared/constants';
import { addDays } from '../shared/time';
import { notifyOnce } from './services/notify';
import { localDate, localTime } from '../shared/time';

/** Reminders older than this are dropped instead of sent late (e.g. after an outage). */
export const REMINDER_GRACE_MS = 30 * 60_000;
/** The wrap-up goes out within this window after the chosen time (cron runs every 5 minutes). */
export const WRAPUP_WINDOW_MIN = 60;

interface DueRow {
  id: string;
  todo_id: string;
  user_id: string;
  title: string;
  due_time: string | null;
  recurrence: string;
  timezone: string;
  reminder_at: number;
  shared: number;
  assigned_to: string | null;
  partner_id: string | null;
  partner_partner_id: string | null;
}

/** Who gets a reminder: the owner; on a shared todo the assignee, or both of you when it's for either. */
export function reminderRecipients(r: Pick<DueRow, 'user_id' | 'shared' | 'assigned_to' | 'partner_id' | 'partner_partner_id'>): string[] {
  if (!r.shared) return [r.user_id];
  if (r.assigned_to) return [r.assigned_to];
  const mutual = r.partner_id && r.partner_partner_id === r.user_id;
  return mutual ? [r.user_id, r.partner_id!] : [r.user_id];
}

/** Users on a break today (their own local date): reminders, nudges and wrap-ups stay quiet. */
async function pausedToday(env: PushEnv, users: UserRow[], now: number): Promise<Set<string>> {
  const { results } = await env.DB.prepare('SELECT user_id, start_date, end_date FROM pauses').all<{ user_id: string; start_date: string; end_date: string }>();
  const out = new Set<string>();
  for (const u of users) {
    const today = localDate(now, u.timezone);
    if (pausedOn(results.filter((r) => r.user_id === u.id), today)) out.add(u.id);
  }
  return out;
}

async function sendDueReminders(env: PushEnv, now: number, fetchFn: typeof fetch, paused: Set<string>) {
  const { results: due } = await env.DB.prepare(
    `SELECT i.id, i.todo_id, i.user_id, i.reminder_at, t.title, t.due_time, t.recurrence, t.assigned_to, u.timezone,
            (t.is_shared = 1 OR COALESCE(p.is_shared, 0) = 1) AS shared,
            u.partner_id, pu.partner_id AS partner_partner_id
       FROM todo_instances i
       JOIN todos t ON t.id = i.todo_id
       LEFT JOIN projects p ON p.id = t.project_id
       JOIN users u ON u.id = i.user_id
       LEFT JOIN users pu ON pu.id = u.partner_id
      WHERE i.status = 'pending' AND i.paused = 0 AND i.skipped = 0 AND i.reminded_at IS NULL AND i.reminder_at IS NOT NULL
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
    const actions = [
      { action: 'done', title: 'Done' },
      { action: 'snooze', title: 'Snooze 1h' },
      ...(r.recurrence === 'none' ? [{ action: 'tomorrow', title: 'Tomorrow' }] : []),
    ];
    for (const to of reminderRecipients(r).filter((id) => !paused.has(id))) {
      sent += await sendPushToUser(
        env,
        to,
        {
          title: r.title,
          body: r.due_time ? `Due at ${r.due_time}` : `Reminder · ${localTime(r.reminder_at, r.timezone)}`,
          url: `/today?todo=${r.todo_id}`,
          tag: `reminder-${r.id}`,
          instanceId: r.id,
          actions,
        },
        fetchFn,
      );
    }
  }
  return { due: due.length, sent };
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

/** Is it wrap-up time for this user right now (and not yet sent today)? */
export function wrapupDue(u: Pick<UserRow, 'timezone' | 'wrapup_time' | 'wrapup_sent_on'>, now: number): boolean {
  if (!u.wrapup_time) return false;
  if (u.wrapup_sent_on === localDate(now, u.timezone)) return false;
  const diff = minutesOf(localTime(now, u.timezone)) - minutesOf(u.wrapup_time);
  return diff >= 0 && diff < WRAPUP_WINDOW_MIN;
}

async function sendWrapups(env: PushEnv, users: UserRow[], now: number, fetchFn: typeof fetch, paused: Set<string>) {
  let sent = 0;
  const byId = new Map(users.map((u) => [u.id, u]));
  for (const u of users) {
    if (paused.has(u.id) || !wrapupDue(u, now)) continue;
    const today = localDate(now, u.timezone);
    const claim = await env.DB.prepare(
      'UPDATE users SET wrapup_sent_on = ? WHERE id = ? AND (wrapup_sent_on IS NULL OR wrapup_sent_on != ?)',
    )
      .bind(today, u.id, today)
      .run();
    if (!claim.meta.changes) continue;
    const mine = await todayView(env.DB, u, u, now);
    const upcoming = await tomorrowHabits(env.DB, u, now);
    if (mine.summary.total === 0 && upcoming.habits.length === 0) continue;
    const left = mine.summary.total - mine.summary.done;
    let body = left === 0 ? `All ${mine.summary.done} done. Lovely.` : `${mine.summary.done} done, ${left} left.`;
    const partner = u.partner_id ? byId.get(u.partner_id) : undefined;
    if (partner && partner.partner_id === u.id) {
      // Partner's count excludes their private todos.
      const theirs = await todayView(env.DB, partner, u, now);
      body += ` ${publicUser(partner).name.split(' ')[0]}: ${theirs.summary.done}/${theirs.summary.total}.`;
    }
    // Tomorrow's habits ride along in the same push (never a separate one per habit).
    const tomorrow = await tomorrowHabits(env.DB, u, now);
    if (tomorrow.habits.length) {
      const list = tomorrow.habits.slice(0, 4).map((h) => (h.time ? `${h.title} ${h.time}` : h.title));
      body += ` Tomorrow: ${list.join(', ')}${tomorrow.habits.length > 4 ? '…' : ''}.`;
    }
    sent += await sendPushToUser(
      env,
      u.id,
      { title: left === 0 ? 'Evening wrap-up 🌙' : 'Evening wrap-up: a few leftovers', body, url: '/wrapup', tag: `wrapup-${today}` },
      fetchFn,
    );
  }
  return sent;
}

/**
 * Deadline pushes: the day before and on the morning of a deadline, at DEADLINE_PUSH_TIME in the owner's time
 * zone (sent within the following 4 hours, once each). Done todos are skipped; shared ones go to the assignee,
 * or both of you.
 */
export async function sendDeadlinePushes(env: PushEnv, users: UserRow[], now: number, paused: Set<string>) {
  let sent = 0;
  const byId = new Map(users.map((u) => [u.id, u]));
  for (const u of users) {
    const local = localTime(now, u.timezone);
    if (local < DEADLINE_PUSH_TIME || minutesBetween(DEADLINE_PUSH_TIME, local) >= 240) continue;
    const today = localDate(now, u.timezone);
    const tomorrow = addDays(today, 1);
    const { results } = await env.DB.prepare(
      `SELECT t.id, t.title, t.deadline_date, t.deadline_time, t.assigned_to,
              (t.is_shared = 1 OR COALESCE(p.is_shared, 0) = 1) AS shared
         FROM todos t LEFT JOIN projects p ON p.id = t.project_id
        WHERE t.user_id = ? AND t.deadline_date IN (?, ?)
          AND NOT (t.recurrence = 'none' AND EXISTS (SELECT 1 FROM todo_instances i WHERE i.todo_id = t.id AND i.status = 'done'))`,
    )
      .bind(u.id, today, tomorrow)
      .all<{ id: string; title: string; deadline_date: string; deadline_time: string | null; assigned_to: string | null; shared: number }>();
    for (const t of results) {
      const kind = t.deadline_date === today ? 'deadline_day' : 'deadline_eve';
      const partner = u.partner_id ? byId.get(u.partner_id) : undefined;
      const recipients = reminderRecipients({
        user_id: u.id,
        shared: t.shared,
        assigned_to: t.assigned_to,
        partner_id: u.partner_id,
        partner_partner_id: partner?.partner_id ?? null,
      }).filter((id) => !paused.has(id));
      for (const to of recipients) {
        await notifyOnce(env, to, kind, `${t.id}:${t.deadline_date}`, {
          title: kind === 'deadline_day' ? `Due today${t.deadline_time ? ` at ${t.deadline_time}` : ''}: ${t.title}` : `Due tomorrow: ${t.title}`,
          body: kind === 'deadline_day' ? 'Today is the deadline.' : 'The deadline is tomorrow.',
          url: `/today?todo=${t.id}`,
          tag: `deadline-${t.id}`,
        });
        sent += 1;
      }
    }
  }
  return sent;
}

function minutesBetween(a: string, b: string): number {
  const m = (x: string) => Number(x.slice(0, 2)) * 60 + Number(x.slice(3, 5));
  return m(b) - m(a);
}

export async function runReminders(env: PushEnv & Partial<GcalEnv>, now: number, fetchFn: typeof fetch = fetch) {
  const { results: users } = await env.DB.prepare('SELECT * FROM users').all<UserRow>();
  for (const u of users) {
    try {
      await materializeUser(env.DB, u, now);
    } catch (e) {
      console.error('materialize failed', u.id, e);
    }
  }
  const paused = await pausedToday(env, users, now);
  const reminders = await sendDueReminders(env, now, fetchFn, paused);
  const wrapups = await sendWrapups(env, users, now, fetchFn, paused);
  const deadlines = await sendDeadlinePushes(env, users, now, paused);
  // Safety net for Google Calendar: drop partner copies of todos that are no longer shared with them.
  let calendarCleaned = 0;
  if (env.CALENDAR_TOKEN_KEY && env.GOOGLE_CLIENT_ID) {
    calendarCleaned = await reconcileCalendars(env as GcalEnv, fetchFn).catch((e) => {
      console.warn('calendar reconcile', e);
      return 0;
    });
  }
  return { users: users.length, due: reminders.due, sent: reminders.sent, wrapups, deadlines, calendarCleaned };
}
