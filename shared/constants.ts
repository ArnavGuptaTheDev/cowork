// Plain constants shared by client and server. Keep this file dependency-free so it never drags zod into the browser.
export const CATEGORIES = ['personal', 'work', 'habit'] as const;
export const PROJECT_COLORS = ['clay', 'sage', 'honey', 'plum', 'sky', 'ink'] as const;
export const PHOTO_TYPES = ['image/jpeg', 'image/webp', 'image/png'] as const;
export const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
export const MAX_PHOTOS_PER_TARGET = 12;
