import { describe, expect, it } from 'vitest';
import { habitStats, type HistoryEntry } from '../shared/streaks';

const h = (pairs: [string, HistoryEntry['status']][]) => pairs.map(([date, status]) => ({ date, status }));

describe('habitStats', () => {
  it('counts the current streak and ignores a pending today', () => {
    const s = habitStats(
      h([
        ['2026-10-03', 'missed'],
        ['2026-10-04', 'done'],
        ['2026-10-05', 'done'],
        ['2026-10-06', 'done'],
        ['2026-10-07', 'pending'],
      ]),
      '2026-10-07',
    );
    expect(s.currentStreak).toBe(3);
    expect(s.bestStreak).toBe(3);
  });

  it('includes today once done', () => {
    const s = habitStats(h([['2026-10-06', 'done'], ['2026-10-07', 'done']]), '2026-10-07');
    expect(s.currentStreak).toBe(2);
  });

  it('a miss resets the current streak but best is kept', () => {
    const s = habitStats(
      h([
        ['2026-10-01', 'done'],
        ['2026-10-02', 'done'],
        ['2026-10-03', 'done'],
        ['2026-10-04', 'missed'],
        ['2026-10-05', 'done'],
      ]),
      '2026-10-05',
    );
    expect(s.currentStreak).toBe(1);
    expect(s.bestStreak).toBe(3);
  });

  it('weekly habits: streaks count occurrences, not calendar days', () => {
    const s = habitStats(h([['2026-09-28', 'done'], ['2026-09-30', 'done'], ['2026-10-02', 'done']]), '2026-10-04');
    expect(s.currentStreak).toBe(3);
  });

  it('completion rate covers the last 30 days and skips a pending today', () => {
    const s = habitStats(
      h([
        ['2026-08-01', 'missed'], // outside window
        ['2026-10-01', 'done'],
        ['2026-10-02', 'missed'],
        ['2026-10-03', 'done'],
        ['2026-10-04', 'done'],
        ['2026-10-05', 'pending'],
      ]),
      '2026-10-05',
    );
    expect(s.done).toBe(3);
    expect(s.missed).toBe(1);
    expect(s.completionRate).toBeCloseTo(0.75);
  });

  it('has no rate before anything resolves', () => {
    expect(habitStats(h([['2026-10-07', 'pending']]), '2026-10-07').completionRate).toBeNull();
  });
});
