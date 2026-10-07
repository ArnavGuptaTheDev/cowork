// Recurrence rules: which local dates a todo occurs on.
import { addDays, daysInMonth, maxDate, minDate, parseDate, weekday } from './time';

export type Recurrence =
  | { type: 'none' }
  | { type: 'daily' }
  | { type: 'weekly'; weekdays: number[] } // 0 = Sunday … 6 = Saturday
  | { type: 'monthly'; monthDay: number }; // 1-31, clamped to the month's last day

export interface Schedule {
  rule: Recurrence;
  startDate: string;
  endDate: string | null;
}

export function isRecurring(rule: Recurrence): boolean {
  return rule.type !== 'none';
}

/** Does the schedule produce an occurrence on this local date? */
export function occursOn(s: Schedule, date: string): boolean {
  if (date < s.startDate) return false;
  if (s.endDate && date > s.endDate) return false;
  const { rule } = s;
  switch (rule.type) {
    case 'none':
      return date === s.startDate;
    case 'daily':
      return true;
    case 'weekly':
      return rule.weekdays.includes(weekday(date));
    case 'monthly': {
      const [y, m, d] = parseDate(date);
      return d === Math.min(rule.monthDay, daysInMonth(y, m));
    }
  }
}

/** All occurrence dates within [from, to] inclusive. */
export function occurrencesBetween(s: Schedule, from: string, to: string): string[] {
  const lo = maxDate(from, s.startDate);
  const hi = s.endDate ? minDate(to, s.endDate) : to;
  const out: string[] = [];
  if (lo > hi) return out;
  if (s.rule.type === 'none') return lo <= s.startDate && s.startDate <= hi ? [s.startDate] : out;
  for (let d = lo; d <= hi; d = addDays(d, 1)) {
    if (occursOn(s, d)) out.push(d);
  }
  return out;
}

// --- Conversions between the rule object and the DB / API representation ---

export interface RecurrenceColumns {
  recurrence: 'none' | 'daily' | 'weekly' | 'monthly';
  recurrence_weekdays: string | null;
  recurrence_month_day: number | null;
}

export function ruleFromColumns(c: RecurrenceColumns): Recurrence {
  switch (c.recurrence) {
    case 'daily':
      return { type: 'daily' };
    case 'weekly':
      return {
        type: 'weekly',
        weekdays: (c.recurrence_weekdays ?? '')
          .split(',')
          .filter((x) => x !== '')
          .map(Number),
      };
    case 'monthly':
      return { type: 'monthly', monthDay: c.recurrence_month_day ?? 1 };
    default:
      return { type: 'none' };
  }
}

export function ruleToColumns(rule: Recurrence): RecurrenceColumns {
  return {
    recurrence: rule.type,
    recurrence_weekdays:
      rule.type === 'weekly' ? [...new Set(rule.weekdays)].sort((a, b) => a - b).join(',') : null,
    recurrence_month_day: rule.type === 'monthly' ? rule.monthDay : null,
  };
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function describeRule(rule: Recurrence): string {
  switch (rule.type) {
    case 'none':
      return 'Once';
    case 'daily':
      return 'Every day';
    case 'weekly': {
      const days = [...rule.weekdays].sort((a, b) => a - b);
      if (days.length === 7) return 'Every day';
      if (days.join() === '1,2,3,4,5') return 'Weekdays';
      if (days.join() === '0,6') return 'Weekends';
      return days.map((d) => WEEKDAY_SHORT[d]).join(' · ');
    }
    case 'monthly':
      return `Monthly on the ${ordinal(rule.monthDay)}`;
  }
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
}
