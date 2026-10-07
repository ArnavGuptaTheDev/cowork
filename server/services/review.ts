// Weekly review: completion rate, by weekday, by category, best/worst day, streaks, time tracked.
// Counting is done in SQL (GROUP BY); only the grouped rows come back to the Worker.
import { addDays, dateRange, startOfWeek, weekday } from '../../shared/time';
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
  /** Minutes tracked per day (phase 3), Mon..Sun. */
  minutesByDay: number[];
  minutesTotal: number;
}

/** Pure: turns grouped rows into the review numbers. Exported for tests. */
export function summarizeWeek(rows: ReviewRow[], weekStart: string): Omit<ReviewStats, 'streaks' | 'minutesByDay' | 'minutesTotal'> {
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

/** Minutes tracked per day of the week (Mon..Sun). Time tracking arrives in phase 3. */
async function minutesTracked(_db: D1Database, _user: UserRow, _asPartner: boolean, _weekStart: string): Promise<number[]> {
  return Array.from({ length: 7 }, () => 0);
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

  return { ...base, streaks, minutesByDay, minutesTotal: minutesByDay.reduce((a, b) => a + b, 0) };
}
