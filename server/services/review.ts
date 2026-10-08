// Weekly review: completion rate, by weekday, by category, best/worst day, streaks, time tracked.
// Counting is done in SQL (GROUP BY); only the grouped rows come back to the Worker.
import { addDays, dateRange, localDate, startOfWeek, weekday, zonedToUtc } from '../../shared/time';
import type { UserRow } from '../db';
import { privacyFilter } from './access';
import { STATUS_SQL } from './pause';
import { materializeUser } from './todos';
import { habitsView } from './views';

export interface ReviewRow {
  date: string;
  category: string;
  status: string;
  n: number;
}

export interface DayStat {
  date: string;
  done: number;
  missed: number;
  open: number;
}

export interface ReviewStats {
  done: number;
  missed: number;
  open: number;
  paused: number;
  /** done / (done + missed); null when nothing resolved. */
  rate: number | null;
  /** Mon..Sun */
  byWeekday: { weekday: number; done: number; total: number }[];
  byCategory: { category: string; done: number; total: number }[];
  days: DayStat[];
  bestDay: DayStat | null;
  worstDay: DayStat | null;
  streaks: { title: string; current: number; best: number }[];
  /** Open blockers right now, and the one that has waited longest. */
  blocked: { count: number; longest: { title: string; note: string; since: number } | null };
  /** Minutes tracked per day (phase 3), Mon..Sun. */
  minutesByDay: number[];
  minutesTotal: number;
}

/** Pure: turns grouped rows into the review numbers. Exported for tests. */
export function summarizeWeek(rows: ReviewRow[], weekStart: string): Omit<ReviewStats, 'streaks' | 'minutesByDay' | 'minutesTotal' | 'blocked'> {
  const dates = dateRange(weekStart, addDays(weekStart, 6));
  const days = new Map<string, DayStat>(dates.map((d) => [d, { date: d, done: 0, missed: 0, open: 0 }]));
  const cats = new Map<string, { category: string; done: number; total: number }>();
  let done = 0;
  let missed = 0;
  let open = 0;
  let paused = 0;
  for (const r of rows) {
    const day = days.get(r.date);
    if (!day) continue;
    if (r.status === 'paused') {
      paused += r.n;
      continue;
    }
    const cat = cats.get(r.category) ?? { category: r.category, done: 0, total: 0 };
    cat.total += r.n;
    if (r.status === 'done') {
      day.done += r.n;
      cat.done += r.n;
      done += r.n;
    } else if (r.status === 'missed') {
      day.missed += r.n;
      missed += r.n;
    } else {
      day.open += r.n;
      open += r.n;
    }
    cats.set(r.category, cat);
  }
  const dayList = [...days.values()];
  const byWeekday = dayList.map((d) => ({ weekday: weekday(d.date), done: d.done, total: d.done + d.missed + d.open }));
  const scored = dayList.filter((d) => d.done + d.missed > 0);
  const rateOf = (d: DayStat) => d.done / (d.done + d.missed);
  const best = scored.length ? scored.reduce((a, b) => (rateOf(b) > rateOf(a) || (rateOf(b) === rateOf(a) && b.done > a.done) ? b : a)) : null;
  const worst = scored.length ? scored.reduce((a, b) => (rateOf(b) < rateOf(a) || (rateOf(b) === rateOf(a) && b.missed > a.missed) ? b : a)) : null;
  return {
    done,
    missed,
    open,
    paused,
    rate: done + missed === 0 ? null : done / (done + missed),
    byWeekday,
    byCategory: [...cats.values()].sort((a, b) => a.category.localeCompare(b.category)),
    days: dayList,
    bestDay: best,
    worstDay: worst && worst !== best ? worst : null,
  };
}

/**
 * Minutes tracked per day of the week (Mon..Sun), summed in SQL per 15-minute bucket (every time zone offset is a
 * multiple of 15 minutes) and then placed on the
 * user's local day. Time on private todos is left out of the partner's view.
 */
async function minutesTracked(db: D1Database, user: UserRow, asPartner: boolean, weekStart: string): Promise<number[]> {
  const days = dateRange(weekStart, addDays(weekStart, 6));
  const from = zonedToUtc(weekStart, '00:00', user.timezone);
  const to = zonedToUtc(addDays(weekStart, 7), '00:00', user.timezone);
  const { results } = await db
    .prepare(
      `SELECT (te.started_at / 900000) AS bucket, SUM(te.ended_at - te.started_at) AS ms
         FROM time_entries te
         JOIN todos t ON t.id = te.todo_id
         LEFT JOIN projects p ON p.id = t.project_id
        WHERE te.user_id = ? AND te.ended_at IS NOT NULL AND te.started_at >= ? AND te.started_at < ? ${privacyFilter(asPartner)}
        GROUP BY bucket`,
    )
    .bind(user.id, from, to)
    .all<{ bucket: number; ms: number }>();
  const out = days.map(() => 0);
  for (const r of results) {
    const idx = days.indexOf(localDate(r.bucket * 900000, user.timezone));
    if (idx >= 0) out[idx]! += Math.round(r.ms / 60_000);
  }
  return out;
}

/** A user's week as `viewer` sees it (partners don't see private todos in the numbers). */
export async function reviewFor(db: D1Database, user: UserRow, viewer: UserRow, anyDateInWeek: string, now: number): Promise<ReviewStats> {
  const asPartner = viewer.id !== user.id;
  await materializeUser(db, user, now);
  const weekStart = startOfWeek(anyDateInWeek);
  const weekEnd = addDays(weekStart, 6);
  const { results } = await db
    .prepare(
      `SELECT i.date AS date, t.category AS category, ${STATUS_SQL} AS status, COUNT(*) AS n
         FROM todo_instances i
         JOIN todos t ON t.id = i.todo_id
         LEFT JOIN projects p ON p.id = t.project_id
        WHERE i.user_id = ? AND i.date BETWEEN ? AND ? ${privacyFilter(asPartner)}
        GROUP BY i.date, t.category, status`,
    )
    .bind(user.id, weekStart, weekEnd)
    .all<ReviewRow>();
  const base = summarizeWeek(results, weekStart);

  const minutesByDay = await minutesTracked(db, user, asPartner, weekStart);

  // Current streaks of the user's repeating todos (the partner sees non-private ones only).
  const { habits } = await habitsView(db, user, viewer, now);
  const streaks = habits
    .filter((h) => h.ownerId === user.id && !h.ended)
    .map((h) => ({ title: h.title, current: h.stats.currentStreak, best: h.stats.bestStreak }))
    .sort((a, b) => b.current - a.current)
    .slice(0, 5);

  const { results: blocked } = await db
    .prepare(
      `SELECT t.title, b.note, b.blocked_at FROM blockers b
         JOIN todos t ON t.id = b.todo_id LEFT JOIN projects p ON p.id = t.project_id
        WHERE t.user_id = ? AND b.resolved_at IS NULL ${privacyFilter(asPartner)}
        ORDER BY b.blocked_at ASC`,
    )
    .bind(user.id)
    .all<{ title: string; note: string; blocked_at: number }>();
  const first = blocked[0];
  return {
    ...base,
    streaks,
    minutesByDay,
    minutesTotal: minutesByDay.reduce((a, b) => a + b, 0),
    blocked: { count: blocked.length, longest: first ? { title: first.title, note: first.note, since: first.blocked_at } : null },
  };
}
