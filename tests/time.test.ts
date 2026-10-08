import { describe, expect, it } from 'vitest';
import {
  addDays,
  dayBoundsUtc,
  diffDays,
  endOfMonth,
  isValidDate,
  isValidTimeZone,
  localDate,
  localTime,
  minutesBetween,
  startOfWeek,
  timeBefore,
  weekday,
  zonedToUtc,
} from '../shared/time';

const utc = (s: string) => Date.parse(s);

describe('localDate: day boundaries across time zones', () => {
  it('Asia/Kolkata (UTC+5:30) flips at 18:30 UTC', () => {
    expect(localDate(utc('2026-10-07T18:29:59Z'), 'Asia/Kolkata')).toBe('2026-10-07');
    expect(localDate(utc('2026-10-07T18:30:00Z'), 'Asia/Kolkata')).toBe('2026-10-08');
  });

  it('the same instant is a different date for partners in different zones', () => {
    const t = utc('2026-10-07T20:00:00Z');
    expect(localDate(t, 'Asia/Kolkata')).toBe('2026-10-08');
    expect(localDate(t, 'America/Los_Angeles')).toBe('2026-10-07');
    expect(localDate(t, 'Pacific/Kiritimati')).toBe('2026-10-08'); // UTC+14
    expect(localDate(t, 'Pacific/Pago_Pago')).toBe('2026-10-07'); // UTC-11
  });

  it('Asia/Kathmandu (UTC+5:45) handles 45-minute offsets', () => {
    expect(localDate(utc('2026-01-01T18:14:00Z'), 'Asia/Kathmandu')).toBe('2026-01-01');
    expect(localDate(utc('2026-01-01T18:15:00Z'), 'Asia/Kathmandu')).toBe('2026-01-02');
    expect(localTime(utc('2026-01-01T18:15:00Z'), 'Asia/Kathmandu')).toBe('00:00');
  });
});

describe('zonedToUtc', () => {
  it('converts Kolkata wall time to UTC', () => {
    expect(new Date(zonedToUtc('2026-10-07', '09:00', 'Asia/Kolkata')).toISOString()).toBe('2026-10-07T03:30:00.000Z');
    expect(new Date(zonedToUtc('2026-10-08', '00:00', 'Asia/Kolkata')).toISOString()).toBe('2026-10-07T18:30:00.000Z');
  });

  it('respects DST in New York', () => {
    expect(new Date(zonedToUtc('2026-01-15', '09:00', 'America/New_York')).toISOString()).toBe('2026-01-15T14:00:00.000Z');
    expect(new Date(zonedToUtc('2026-07-15', '09:00', 'America/New_York')).toISOString()).toBe('2026-07-15T13:00:00.000Z');
  });

  it('resolves spring-forward gaps forward and fall-back overlaps to the earlier instant', () => {
    // 2026-03-08 02:30 does not exist in New York; it resolves to 03:30 EDT.
    const gap = zonedToUtc('2026-03-08', '02:30', 'America/New_York');
    expect(new Date(gap).toISOString()).toBe('2026-03-08T07:30:00.000Z');
    expect(localTime(gap, 'America/New_York')).toBe('03:30');
    // 2026-11-01 01:30 happens twice; we pick the first (EDT).
    expect(new Date(zonedToUtc('2026-11-01', '01:30', 'America/New_York')).toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('round-trips through localDate/localTime for many zones', () => {
    for (const tz of ['Asia/Kolkata', 'Europe/London', 'Australia/Sydney', 'America/Sao_Paulo', 'Pacific/Auckland', 'UTC']) {
      for (const [d, t] of [['2026-02-28', '23:45'], ['2026-06-30', '00:00'], ['2026-12-31', '12:34']] as const) {
        const instant = zonedToUtc(d, t, tz);
        expect(localDate(instant, tz)).toBe(d);
        expect(localTime(instant, tz)).toBe(t);
      }
    }
  });
});

describe('dayBoundsUtc', () => {
  it('is 24h for Kolkata and 23h on the New York spring-forward day', () => {
    const [s, e] = dayBoundsUtc('2026-10-07', 'Asia/Kolkata');
    expect(new Date(s).toISOString()).toBe('2026-10-06T18:30:00.000Z');
    expect(e - s).toBe(24 * 3600_000);
    const [s2, e2] = dayBoundsUtc('2026-03-08', 'America/New_York');
    expect(e2 - s2).toBe(23 * 3600_000);
  });
});

describe('calendar helpers', () => {
  it('adds days across month and leap-year boundaries', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(diffDays('2026-01-01', '2026-12-31')).toBe(364);
  });

  it('computes weekdays and Monday-based weeks', () => {
    expect(weekday('2026-10-07')).toBe(3); // Wednesday
    expect(startOfWeek('2026-10-07')).toBe('2026-10-05');
    expect(startOfWeek('2026-10-11')).toBe('2026-10-05'); // Sunday belongs to the week that started Monday
    expect(endOfMonth('2028-02-10')).toBe('2028-02-29');
  });

  it('validates inputs', () => {
    expect(isValidDate('2026-02-29')).toBe(false);
    expect(isValidDate('2028-02-29')).toBe(true);
    expect(isValidDate('2026-13-01')).toBe(false);
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
  });
});

describe('timeBefore / minutesBetween: reminder offsets', () => {
  it('moves a time earlier on the same day', () => {
    expect(timeBefore('09:30', 60)).toBe('08:30');
    expect(timeBefore('10:05', 10)).toBe('09:55');
    expect(timeBefore('09:30', 0)).toBe('09:30');
  });
  it('refuses to cross midnight', () => {
    expect(timeBefore('00:30', 60)).toBeNull();
    expect(timeBefore('01:00', 60)).toBe('00:00');
  });
  it('measures the gap between two times', () => {
    expect(minutesBetween('08:30', '09:30')).toBe(60);
    expect(minutesBetween('10:00', '09:00')).toBe(-60);
  });
});
