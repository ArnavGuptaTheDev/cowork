// Pause mode: date ranges when a user is "away". Reminders and nudges are silenced, repeating
// occurrences in the range are paused instead of missed, and streaks freeze.
import { localDate } from '../../shared/time';
import type { UserRow } from '../db';

export interface PauseRange {
  id: string;
  start_date: string;
  end_date: string;
  note: string;
}

export async function loadPauses(db: D1Database, userId: string): Promise<PauseRange[]> {
  const { results } = await db
    .prepare('SELECT id, start_date, end_date, note FROM pauses WHERE user_id = ? ORDER BY start_date')
    .bind(userId)
    .all<PauseRange>();
  return results;
}

export function pausedOn(ranges: Pick<PauseRange, 'start_date' | 'end_date'>[], date: string): boolean {
  return ranges.some((r) => r.start_date <= date && date <= r.end_date);
}

/** The pause covering the user's today, if any. */
export async function activePause(db: D1Database, user: Pick<UserRow, 'id' | 'timezone'>, now: number): Promise<PauseRange | null> {
  const today = localDate(now, user.timezone);
  return db
    .prepare('SELECT id, start_date, end_date, note FROM pauses WHERE user_id = ? AND start_date <= ? AND end_date >= ? ORDER BY end_date DESC LIMIT 1')
    .bind(user.id, today, today)
    .first<PauseRange>();
}

/** SQL expression for an instance's displayed status (alias i). */
export const STATUS_SQL = `CASE WHEN i.status = 'done' THEN 'done' WHEN i.skipped = 1 THEN 'skipped' WHEN i.paused = 1 THEN 'paused' ELSE i.status END`;
