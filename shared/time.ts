// Time-zone and calendar-date helpers. Pure and runtime-agnostic (Intl only).
// Local calendar dates are represented as 'YYYY-MM-DD' strings; instants as UTC epoch milliseconds.

export const DEFAULT_TIMEZONE = 'Asia/Kolkata';
export const DAY_MS = 86_400_000;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function isValidDate(date: string): boolean {
  const m = DATE_RE.exec(date);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonth(y, mo);
}

export function isValidTime(time: string): boolean {
  return TIME_RE.test(time);
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function zonedParts(instant: number, timeZone: string): ZonedParts {
  const out: Record<string, number> = {};
  for (const p of partsFormatter(timeZone).formatToParts(new Date(instant))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return {
    year: out.year!,
    month: out.month!,
    day: out.day!,
    hour: out.hour! % 24,
    minute: out.minute!,
    second: out.second!,
  };
}

/** The local calendar date of an instant in a time zone. */
export function localDate(instant: number, timeZone: string): string {
  const p = zonedParts(instant, timeZone);
  return formatDate(p.year, p.month, p.day);
}

/** Local wall-clock time 'HH:MM' of an instant in a time zone. */
export function localTime(instant: number, timeZone: string): string {
  const p = zonedParts(instant, timeZone);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** Offset of the zone from UTC at the given instant, in milliseconds (local - UTC). */
export function zoneOffset(instant: number, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const truncated = instant - (((instant % 1000) + 1000) % 1000);
  return asUtc - truncated;
}

/**
 * Converts a local date + wall-clock time in a zone to a UTC instant.
 * Times that don't exist (spring-forward gaps) resolve to the instant just after the gap;
 * ambiguous times (fall-back overlaps) resolve to the earlier instant.
 */
export function zonedToUtc(date: string, time: string, timeZone: string): number {
  const [y, mo, d] = parseDate(date);
  const [h, mi] = time.split(':').map(Number) as [number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  // Try both candidate offsets (before/after a possible transition) and keep the earliest that round-trips.
  const o1 = zoneOffset(wall - DAY_MS / 2, timeZone);
  const o2 = zoneOffset(wall + DAY_MS / 2, timeZone);
  const candidates = [wall - o1, wall - o2].sort((a, b) => a - b);
  for (const c of candidates) {
    if (c + zoneOffset(c, timeZone) === wall) return c;
  }
  // In a gap: neither candidate round-trips. Use the pre-transition offset, which lands after the gap.
  return wall - Math.min(o1, o2);
}

/** [start, end) of a local calendar day as UTC instants. */
export function dayBoundsUtc(date: string, timeZone: string): [number, number] {
  return [zonedToUtc(date, '00:00', timeZone), zonedToUtc(addDays(date, 1), '00:00', timeZone)];
}

export function parseDate(date: string): [number, number, number] {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`Invalid date: ${date}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function formatDate(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${pad(m)}-${pad(d)}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function dateToUtcMs(date: string): number {
  const [y, m, d] = parseDate(date);
  return Date.UTC(y, m - 1, d);
}

function utcMsToDate(ms: number): string {
  const dt = new Date(ms);
  return formatDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function addDays(date: string, n: number): string {
  return utcMsToDate(dateToUtcMs(date) + n * DAY_MS);
}

/** Whole days from a to b (b - a). */
export function diffDays(a: string, b: string): number {
  return Math.round((dateToUtcMs(b) - dateToUtcMs(a)) / DAY_MS);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(date: string): number {
  return new Date(dateToUtcMs(date)).getUTCDay();
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Monday-based start of the week containing date. */
export function startOfWeek(date: string, weekStartsOn = 1): string {
  const wd = weekday(date);
  return addDays(date, -((wd - weekStartsOn + 7) % 7));
}

export function startOfMonth(date: string): string {
  const [y, m] = parseDate(date);
  return formatDate(y, m, 1);
}

export function endOfMonth(date: string): string {
  const [y, m] = parseDate(date);
  return formatDate(y, m, daysInMonth(y, m));
}

export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function minDate(a: string, b: string): string {
  return a < b ? a : b;
}

export function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}
