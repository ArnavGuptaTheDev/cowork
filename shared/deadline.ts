// Deadlines: "when it must be finished", separate from the scheduled day ("when I plan to work on it").
import { diffDays } from './time';

export type DeadlineKind = 'overdue' | 'today' | 'soon' | 'later';

export interface DeadlineState {
  kind: DeadlineKind;
  /** Whole days from today to the deadline (negative when overdue). */
  days: number;
  label: string;
}

/** Days ahead that still count as "soon" (stronger visual weight). */
export const SOON_DAYS = 3;

/**
 * State of a deadline seen from the owner's local `today` (and, optionally, local time `nowTime` 'HH:MM').
 * A deadline with a time that has passed today is overdue; without a time, the whole day counts.
 */
export function deadlineState(date: string, time: string | null, today: string, nowTime?: string): DeadlineState {
  const days = diffDays(today, date);
  if (days < 0 || (days === 0 && time && nowTime && nowTime > time)) {
    const late = -days;
    return { kind: 'overdue', days, label: late === 0 ? 'Overdue' : late === 1 ? 'Overdue by 1 day' : `Overdue by ${late} days` };
  }
  if (days === 0) return { kind: 'today', days, label: time ? `Due today ${time}` : 'Due today' };
  if (days === 1) return { kind: 'soon', days, label: 'Due tomorrow' };
  return { kind: days <= SOON_DAYS ? 'soon' : 'later', days, label: `Due in ${days} days` };
}

/** Sort helper: earlier deadlines first, no deadline last. */
export function compareDeadlines(a: { date: string | null; time: string | null }, b: { date: string | null; time: string | null }): number {
  if (!a.date && !b.date) return 0;
  if (!a.date) return 1;
  if (!b.date) return -1;
  const ak = `${a.date} ${a.time ?? '99:99'}`;
  const bk = `${b.date} ${b.time ?? '99:99'}`;
  return ak < bk ? -1 : ak > bk ? 1 : 0;
}
