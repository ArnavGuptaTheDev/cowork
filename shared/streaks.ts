// Streaks and completion rates from a recurring todo's instance history.
import { addDays } from './time';

export type InstanceStatus = 'pending' | 'done' | 'missed';

export interface HistoryEntry {
  date: string;
  status: InstanceStatus;
}

export interface HabitStats {
  currentStreak: number;
  bestStreak: number;
  /** Fraction (0-1) of resolved occurrences in the window that were done; null when nothing resolved yet. */
  completionRate: number | null;
  done: number;
  missed: number;
}

/**
 * Streak = consecutive done occurrences ending at the most recent resolved one.
 * Today's still-pending occurrence does not break the streak (the day isn't over).
 * Completion rate counts occurrences from `windowStart` to `today` (inclusive); a pending today is ignored.
 */
export function habitStats(entries: HistoryEntry[], today: string, windowDays = 30): HabitStats {
  const sorted = [...entries].filter((e) => e.date <= today).sort((a, b) => (a.date < b.date ? -1 : 1));

  let best = 0;
  let run = 0;
  for (const e of sorted) {
    if (e.status === 'done') {
      run += 1;
      best = Math.max(best, run);
    } else if (e.status === 'missed' || (e.status === 'pending' && e.date < today)) {
      run = 0;
    }
  }

  let current = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const e = sorted[i]!;
    if (e.status === 'pending' && e.date === today) continue;
    if (e.status === 'done') current += 1;
    else break;
  }

  const windowStart = addDays(today, -(windowDays - 1));
  let done = 0;
  let missed = 0;
  for (const e of sorted) {
    if (e.date < windowStart) continue;
    if (e.status === 'done') done += 1;
    else if (e.status === 'missed' || (e.status === 'pending' && e.date < today)) missed += 1;
  }

  return {
    currentStreak: current,
    bestStreak: best,
    completionRate: done + missed === 0 ? null : done / (done + missed),
    done,
    missed,
  };
}
