// Natural-language quick add: "gym every mon wed fri 7am #health" -> a todo draft.
// Pure and dependency-free. Everything recognised is removed from the text; what remains is the title.
import type { Recurrence } from './recurrence';
import { addDays, daysInMonth, formatDate, isValidDate, parseDate, weekday } from './time';

export type QuickCategory = 'personal' | 'work' | 'habit';
export type TokenKind = 'date' | 'time' | 'reminder' | 'recurrence' | 'project' | 'category' | 'partner' | 'priority';

export interface QuickAddResult {
  title: string;
  /** Local date; null means "today" (the caller's default). */
  startDate: string | null;
  dueTime: string | null;
  reminderTime: string | null;
  recurrence: Recurrence;
  /** "#side-project" -> "side project"; the caller matches it to a project name. */
  projectName: string | null;
  category: QuickCategory | null;
  /** "for partner": turn the todo into a suggestion for the partner. */
  forPartner: boolean;
  /** "!low" / "!medium" / "!high" / "!urgent" -> 1..4; null when not given. */
  priority: number | null;
  /** The pieces that were understood, in input order, for the preview. */
  tokens: { kind: TokenKind; text: string }[];
}

const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};
const WD = '(?:sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:s|nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)';

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};
const MON = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const ORD = '(?:st|nd|rd|th)?';
// 7am, 7:30 pm, 19:00, noon, midnight
const TIME = '(?:(?:[01]?\\d|2[0-3]):[0-5]\\d(?:\\s*[ap]\\.?m\\.?)?|(?:1[0-2]|0?\\d)(?:[.:][0-5]\\d)?\\s*[ap]\\.?m\\.?|noon|midnight)';

function pad(n: number) {
  return String(n).padStart(2, '0');
}

/** "7pm" -> "19:00", "12am" -> "00:00", "7.30 p.m." -> "19:30", "noon" -> "12:00", "19:05" -> "19:05". */
export function parseTime(raw: string): string | null {
  const t = raw
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/([ap])\.?m\.?$/, '$1m')
    .replace(/^(\d{1,2})\.(\d{2})/, '$1:$2');
  if (t === 'noon') return '12:00';
  if (t === 'midnight') return '00:00';
  const m = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/.exec(t);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = m[3] === 'am' ? h % 12 : (h % 12) + 12;
  } else if (h > 23 || !m[2]) {
    return null; // bare numbers like "20" are not times
  }
  return `${pad(h)}:${pad(min)}`;
}

function weekdaysFrom(text: string): number[] {
  const out: number[] = [];
  for (const w of text.toLowerCase().match(new RegExp(WD, 'g')) ?? []) {
    const n = WEEKDAYS[w];
    if (n !== undefined && !out.includes(n)) out.push(n);
  }
  return out.sort((a, b) => a - b);
}

/** Next date (strictly after today) that falls on weekday wd. */
function nextWeekday(today: string, wd: number): string {
  const diff = (wd - weekday(today) + 7) % 7 || 7;
  return addDays(today, diff);
}

function resolveDayMonth(today: string, day: number, month: number, year?: number): string | null {
  const [ty] = parseDate(today);
  let y = year ?? ty;
  if (year !== undefined && year < 100) y = 2000 + year;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(y, month)) {
    // 29 feb in a non-leap year without an explicit year: try next year below
    if (year !== undefined) return null;
  }
  let d = formatDate(y, month, day);
  if (year === undefined && (!isValidDate(d) || d < today)) {
    d = formatDate(y + 1, month, day);
  }
  return isValidDate(d) ? d : null;
}

interface Rule {
  kind: TokenKind;
  re: RegExp;
  apply: (m: RegExpExecArray, r: QuickAddResult, today: string) => boolean;
}

// Each pattern is tried in order against what's left of the input. Prefixes like "on"/"at"/"by" are eaten too.
const PRIORITY_WORDS: Record<string, number> = { low: 1, medium: 2, med: 2, normal: 2, high: 3, urgent: 4 };

const RULES: Rule[] = [
  {
    kind: 'priority',
    re: /(?:^|\s)!(low|medium|med|normal|high|urgent)\b/i,
    apply: (m, r) => ((r.priority = PRIORITY_WORDS[m[1]!.toLowerCase()]!), true),
  },
  {
    kind: 'partner',
    re: /(?:^|\s)for\s+(?:my\s+)?partner\b/i,
    apply: (_m, r) => ((r.forPartner = true), true),
  },
  {
    kind: 'project',
    re: /(?:^|\s)#([\p{L}\p{N}][\p{L}\p{N}_-]*)/u,
    apply: (m, r) => ((r.projectName = m[1]!.replace(/[-_]+/g, ' ').trim()), true),
  },
  {
    kind: 'category',
    re: /(?:^|\s)@(work|personal|habit|home)\b/i,
    apply: (m, r) => {
      const c = m[1]!.toLowerCase();
      r.category = c === 'home' ? 'personal' : (c as QuickCategory);
      return true;
    },
  },
  // --- recurrence ---
  {
    kind: 'recurrence',
    re: new RegExp(`(?:^|\\s)(?:every\\s+(?:day|morning|evening|night)|daily|each\\s+day)\\b`, 'i'),
    apply: (_m, r) => ((r.recurrence = { type: 'daily' }), true),
  },
  {
    kind: 'recurrence',
    re: /(?:^|\s)(?:every\s+weekdays?|on\s+weekdays|weekdays)\b/i,
    apply: (_m, r) => ((r.recurrence = { type: 'weekly', weekdays: [1, 2, 3, 4, 5] }), true),
  },
  {
    kind: 'recurrence',
    re: /(?:^|\s)(?:every\s+weekends?|on\s+weekends|weekends)\b/i,
    apply: (_m, r) => ((r.recurrence = { type: 'weekly', weekdays: [0, 6] }), true),
  },
  {
    kind: 'recurrence',
    re: new RegExp(`(?:^|\\s)(?:every|each|weekly\\s+on|on\\s+every)\\s+(${WD}s?(?:\\s*(?:,|&|and|\\+|/)?\\s*${WD}s?)*)\\b`, 'i'),
    apply: (m, r) => {
      const days = weekdaysFrom(m[1]!);
      if (!days.length) return false;
      r.recurrence = { type: 'weekly', weekdays: days };
      return true;
    },
  },
  {
    kind: 'recurrence',
    re: new RegExp(`(?:^|\\s)(?:(?:every\\s+month|monthly|each\\s+month)(?:\\s+on)?(?:\\s+the)?\\s+(\\d{1,2})${ORD}|every\\s+(\\d{1,2})${ORD}(?:\\s+of\\s+the\\s+month)?)\\b`, 'i'),
    apply: (m, r) => {
      const day = Number(m[1] ?? m[2]);
      if (day < 1 || day > 31) return false;
      r.recurrence = { type: 'monthly', monthDay: day };
      return true;
    },
  },
  {
    kind: 'recurrence',
    re: /(?:^|\s)(?:every\s+month|monthly)\b/i,
    apply: (_m, r, today) => ((r.recurrence = { type: 'monthly', monthDay: parseDate(r.startDate ?? today)[2] }), true),
  },
  {
    kind: 'recurrence',
    re: /(?:^|\s)(?:every\s+week|weekly)\b/i,
    apply: (_m, r, today) => ((r.recurrence = { type: 'weekly', weekdays: [weekday(r.startDate ?? today)] }), true),
  },
  // --- reminder before plain times ---
  {
    kind: 'reminder',
    re: new RegExp(`(?:^|\\s)remind(?:\\s+me)?(?:\\s+at)?\\s+(${TIME})(?=\\s|$|[,.!?])`, 'i'),
    apply: (m, r) => {
      const t = parseTime(m[1]!);
      if (!t) return false;
      r.reminderTime = t;
      return true;
    },
  },
  {
    kind: 'time',
    re: new RegExp(`(?:^|\\s)(?:at\\s+|by\\s+|@\\s*)?(${TIME})(?=\\s|$|[,.!?])`, 'i'),
    apply: (m, r) => {
      const t = parseTime(m[1]!);
      if (!t) return false;
      r.dueTime = t;
      return true;
    },
  },
  {
    // "at 7" without am/pm: 1-6 -> afternoon/evening, 7-11 -> morning, 12 -> noon.
    kind: 'time',
    re: /(?:^|\s)at\s+(\d{1,2})(?=\s|$|[,.!?])/i,
    apply: (m, r) => {
      const h = Number(m[1]);
      if (h < 1 || h > 12) return false;
      r.dueTime = `${pad(h <= 6 ? h + 12 : h)}:00`;
      return true;
    },
  },
  // --- dates ---
  {
    kind: 'date',
    re: /(?:^|\s)(?:the\s+)?day\s+after\s+tomorrow\b/i,
    apply: (_m, r, today) => ((r.startDate = addDays(today, 2)), true),
  },
  {
    kind: 'date',
    re: /(?:^|\s)(?:today|tonight|tod)\b/i,
    apply: (_m, r, today) => ((r.startDate = today), true),
  },
  {
    kind: 'date',
    re: /(?:^|\s)(?:tomorrow|tmrw|tmr|tomo)\b/i,
    apply: (_m, r, today) => ((r.startDate = addDays(today, 1)), true),
  },
  {
    kind: 'date',
    re: /(?:^|\s)in\s+(\d{1,3})\s+(day|days|week|weeks)\b/i,
    apply: (m, r, today) => {
      const n = Number(m[1]);
      r.startDate = addDays(today, m[2]!.toLowerCase().startsWith('week') ? n * 7 : n);
      return true;
    },
  },
  {
    kind: 'date',
    re: /(?:^|\s)next\s+week\b/i,
    apply: (_m, r, today) => ((r.startDate = nextWeekday(today, 1)), true),
  },
  {
    // "next fri": the Friday of next week (Mon-Sun weeks).
    kind: 'date',
    re: new RegExp(`(?:^|\\s)next\\s+(${WD})\\b`, 'i'),
    apply: (m, r, today) => {
      const wd = WEEKDAYS[m[1]!.toLowerCase()]!;
      const nextMonday = nextWeekday(today, 1);
      r.startDate = addDays(nextMonday, (wd + 6) % 7);
      return true;
    },
  },
  {
    // ISO: 2026-10-12
    kind: 'date',
    re: /(?:^|\s)(?:on\s+|by\s+|due\s+)?(\d{4})-(\d{2})-(\d{2})\b/i,
    apply: (m, r) => {
      const d = `${m[1]}-${m[2]}-${m[3]}`;
      if (!isValidDate(d)) return false;
      r.startDate = d;
      return true;
    },
  },
  {
    // 12 oct, 12th october 2026
    kind: 'date',
    re: new RegExp(`(?:^|\\s)(?:on\\s+|by\\s+|due\\s+)?(?:the\\s+)?(\\d{1,2})${ORD}\\s+(?:of\\s+)?(${MON})\\.?(?:,?\\s+(\\d{4}))?\\b`, 'i'),
    apply: (m, r, today) => {
      const d = resolveDayMonth(today, Number(m[1]), MONTHS[m[2]!.toLowerCase().replace(/\.$/, '')]!, m[3] ? Number(m[3]) : undefined);
      if (!d) return false;
      r.startDate = d;
      return true;
    },
  },
  {
    // oct 12, october 12th, 2026
    kind: 'date',
    re: new RegExp(`(?:^|\\s)(?:on\\s+|by\\s+|due\\s+)?(${MON})\\.?\\s+(\\d{1,2})${ORD}(?:,?\\s+(\\d{4}))?\\b`, 'i'),
    apply: (m, r, today) => {
      const d = resolveDayMonth(today, Number(m[2]), MONTHS[m[1]!.toLowerCase()]!, m[3] ? Number(m[3]) : undefined);
      if (!d) return false;
      r.startDate = d;
      return true;
    },
  },
  {
    // 12/10 or 12/10/2026: day first (as used in India and most of the world).
    kind: 'date',
    re: /(?:^|\s)(?:on\s+|by\s+|due\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?=\s|$|[,.!?])/i,
    apply: (m, r, today) => {
      const d = resolveDayMonth(today, Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : undefined);
      if (!d) return false;
      r.startDate = d;
      return true;
    },
  },
  {
    // "fri", "on friday": the next one, not today.
    kind: 'date',
    re: new RegExp(`(?:^|\\s)(?:on\\s+|by\\s+|due\\s+|this\\s+)?(${WD})\\b`, 'i'),
    apply: (m, r, today) => {
      const wd = WEEKDAYS[m[1]!.toLowerCase()];
      if (wd === undefined) return false;
      r.startDate = nextWeekday(today, wd);
      return true;
    },
  },
];

export function parseQuickAdd(input: string, today: string): QuickAddResult {
  const r: QuickAddResult = {
    title: '',
    startDate: null,
    dueTime: null,
    reminderTime: null,
    recurrence: { type: 'none' },
    projectName: null,
    category: null,
    forPartner: false,
    priority: null,
    tokens: [],
  };
  let rest = ` ${input.replace(/\s+/g, ' ').trim()} `;
  const found: { index: number; kind: TokenKind; text: string }[] = [];
  const done = new Set<TokenKind>();

  for (const rule of RULES) {
    // One token per kind (first match wins), except that a date may still follow a recurrence ("every mon from 12 oct").
    if (done.has(rule.kind)) continue;
    const m = rule.re.exec(rest);
    if (!m) continue;
    if (!rule.apply(m, r, today)) continue;
    done.add(rule.kind);
    const text = m[0].trim();
    found.push({ index: m.index, kind: rule.kind, text });
    rest = `${rest.slice(0, m.index)} ${rest.slice(m.index + m[0].length)}`;
  }

  // A weekday-only "every mon" with no explicit date starts on the next matching day (or today if it matches).
  if (r.recurrence.type === 'weekly' && !r.startDate) {
    const wds = r.recurrence.weekdays;
    if (!wds.includes(weekday(today))) {
      const next = Math.min(...wds.map((w) => (w - weekday(today) + 7) % 7 || 7));
      r.startDate = addDays(today, next);
    }
  }
  if (r.recurrence.type !== 'none' && !r.category) r.category = 'habit';

  r.title = rest
    .replace(/\s+/g, ' ')
    .replace(/^\s*(?:to|-|:)\s+/i, '')
    .replace(/\s+(?:at|on|by|due|for|every|from)\s*$/i, '')
    .trim();
  r.tokens = found.sort((a, b) => a.index - b.index).map(({ kind, text }) => ({ kind, text }));
  return r;
}
