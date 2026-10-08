// Plain constants shared by client and server. Keep this file dependency-free so it never drags zod into the browser.
export const CATEGORIES = ['personal', 'work', 'habit'] as const;
export const PROJECT_COLORS = ['clay', 'sage', 'honey', 'plum', 'sky', 'ink'] as const;
export const PHOTO_TYPES = ['image/jpeg', 'image/webp', 'image/png'] as const;
export const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
export const MAX_PHOTOS_PER_TARGET = 12;

/** The fixed set of reactions a partner can leave on a completed todo. */
export const REACTIONS = ['❤️', '🔥', '👏', '💪', '🎉', '😂'] as const;
/** One nudge per todo per this window. */
export const NUDGE_COOLDOWN_MS = 3 * 60 * 60 * 1000;
export const DEFAULT_WRAPUP_TIME = '21:00';

/** Priority levels (stored as 1..4). Default Medium. */
export const PRIORITIES = [
  { value: 1, key: 'low', label: 'Low' },
  { value: 2, key: 'medium', label: 'Medium' },
  { value: 3, key: 'high', label: 'High' },
  { value: 4, key: 'urgent', label: 'Urgent' },
] as const;
export const DEFAULT_PRIORITY = 2;

/** Status kinds: app logic keys off these, never off a status's name. */
export const STATUS_KINDS = ['todo', 'active', 'blocked', 'done'] as const;
export type StatusKind = (typeof STATUS_KINDS)[number];
export const STATUS_COLORS = ['ink', 'sky', 'honey', 'clay', 'sage', 'plum'] as const;

/** Local time of the "morning of" and "day before" deadline pushes. */
export const DEADLINE_PUSH_TIME = '08:00';
