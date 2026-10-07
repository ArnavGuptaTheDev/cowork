import { describe, expect, it } from 'vitest';
import { describeRule, occurrencesBetween, occursOn, ruleFromColumns, ruleToColumns, type Recurrence, type Schedule } from '../shared/recurrence';

const s = (rule: Schedule['rule'], startDate = '2026-10-01', endDate: string | null = null): Schedule => ({ rule, startDate, endDate });

describe('occursOn', () => {
  it('one-off todos occur only on their day', () => {
    const sch = s({ type: 'none' }, '2026-10-07');
    expect(occursOn(sch, '2026-10-07')).toBe(true);
    expect(occursOn(sch, '2026-10-08')).toBe(false);
  });

  it('daily respects start and end', () => {
    const sch = s({ type: 'daily' }, '2026-10-05', '2026-10-07');
    expect(occurrencesBetween(sch, '2026-10-01', '2026-10-31')).toEqual(['2026-10-05', '2026-10-06', '2026-10-07']);
  });

  it('weekly picks the chosen weekdays', () => {
    // Mon, Wed, Fri
    const sch = s({ type: 'weekly', weekdays: [1, 3, 5] }, '2026-10-01');
    expect(occurrencesBetween(sch, '2026-10-05', '2026-10-11')).toEqual(['2026-10-05', '2026-10-07', '2026-10-09']);
  });

  it('monthly clamps day 31 to the last day of shorter months', () => {
    const sch = s({ type: 'monthly', monthDay: 31 }, '2026-01-01');
    const hits = occurrencesBetween(sch, '2026-01-01', '2026-06-30');
    expect(hits).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30']);
  });

  it('monthly on the 29th in a leap year', () => {
    const sch = s({ type: 'monthly', monthDay: 29 }, '2028-01-01');
    expect(occurrencesBetween(sch, '2028-02-01', '2028-02-29')).toEqual(['2028-02-29']);
  });

  it('never occurs before the start date', () => {
    expect(occurrencesBetween(s({ type: 'daily' }, '2026-10-10'), '2026-10-01', '2026-10-11')).toEqual(['2026-10-10', '2026-10-11']);
  });
});

describe('column mapping', () => {
  it('round-trips rules through DB columns', () => {
    for (const rule of [
      { type: 'none' },
      { type: 'daily' },
      { type: 'weekly', weekdays: [1, 3, 5] },
      { type: 'monthly', monthDay: 15 },
    ] as Recurrence[]) {
      expect(ruleFromColumns(ruleToColumns(rule))).toEqual(rule);
    }
  });

  it('dedupes and sorts weekdays', () => {
    expect(ruleToColumns({ type: 'weekly', weekdays: [5, 1, 5] }).recurrence_weekdays).toBe('1,5');
  });

  it('describes rules for humans', () => {
    expect(describeRule({ type: 'weekly', weekdays: [1, 2, 3, 4, 5] })).toBe('Weekdays');
    expect(describeRule({ type: 'monthly', monthDay: 22 })).toBe('Monthly on the 22nd');
  });
});
