import { parseDate } from '../../shared/time';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function utcDate(date: string): Date {
  const [y, m, d] = parseDate(date);
  return new Date(Date.UTC(y, m - 1, d));
}

export function dayName(date: string): string {
  return DAYS[utcDate(date).getUTCDay()]!;
}

export function shortDay(date: string): string {
  return dayName(date).slice(0, 3);
}

/** "7 October" */
export function dayMonth(date: string): string {
  const [, m, d] = parseDate(date);
  return `${d} ${MONTHS[m - 1]}`;
}

/** "7 Oct" */
export function shortDate(date: string): string {
  const [, m, d] = parseDate(date);
  return `${d} ${MONTHS_SHORT[m - 1]}`;
}

/** "October 2026" */
export function monthYear(date: string): string {
  const [y, m] = parseDate(date);
  return `${MONTHS[m - 1]} ${y}`;
}

export function dayOfMonth(date: string): number {
  return parseDate(date)[2];
}

/** "Yesterday", "Mon 5 Oct", etc. relative to today. */
export function relativeDay(date: string, today: string): string {
  const diff = Math.round((utcDate(date).getTime() - utcDate(today).getTime()) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === -1) return 'Yesterday';
  if (diff === 1) return 'Tomorrow';
  return `${shortDay(date)} ${shortDate(date)}`;
}

/** 24h "HH:MM" -> "9:30 am" */
export function prettyTime(time: string | null): string {
  if (!time) return '';
  const [h, m] = time.split(':').map(Number) as [number, number];
  const suffix = h < 12 ? 'am' : 'pm';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(m).padStart(2, '0')} ${suffix}`;
}

export function percent(n: number | null): string {
  return n === null ? 'n/a' : `${Math.round(n * 100)}%`;
}

export function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]!.toUpperCase())
      .join('') || '?'
  );
}

export function greeting(hour = new Date().getHours()): string {
  if (hour < 5) return 'Still up';
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}
