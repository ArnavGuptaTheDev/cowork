// Input schemas shared by the API (validation) and the client (types).
import { z } from 'zod';
import { isValidDate, isValidTimeZone } from './time';

import { CATEGORIES, PROJECT_COLORS } from './constants';

export { CATEGORIES, MAX_PHOTO_BYTES, MAX_PHOTOS_PER_TARGET, PHOTO_TYPES, PROJECT_COLORS } from './constants';

export const categorySchema = z.enum(CATEGORIES);
export const dateSchema = z.string().refine(isValidDate, 'Expected a date (YYYY-MM-DD)');
export const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected a time (HH:MM)');
export const timezoneSchema = z.string().min(1).max(64).refine(isValidTimeZone, 'Unknown time zone');
export const idSchema = z.uuid();

export const recurrenceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('daily') }),
  z.object({
    type: z.literal('weekly'),
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  }),
  z.object({ type: z.literal('monthly'), monthDay: z.number().int().min(1).max(31) }),
]);

const todoFields = {
  title: z.string().trim().min(1, 'Give it a title').max(200),
  notes: z.string().max(5000).default(''),
  category: categorySchema,
  startDate: dateSchema,
  endDate: dateSchema.nullable().default(null),
  dueTime: timeSchema.nullable().default(null),
  reminderTime: timeSchema.nullable().default(null),
  recurrence: recurrenceSchema.default({ type: 'none' }),
};

function endAfterStart(v: { startDate?: string; endDate?: string | null }) {
  return !v.endDate || !v.startDate || v.endDate >= v.startDate;
}

export const todoCreateSchema = z
  .object({
    ...todoFields,
    projectId: idSchema.nullable().default(null),
    isPrivate: z.boolean().default(false),
  })
  .strict()
  .refine(endAfterStart, { message: 'End date must be on or after the start date', path: ['endDate'] });
export type TodoCreateInput = z.infer<typeof todoCreateSchema>;

export const todoUpdateSchema = z
  .object({
    title: todoFields.title,
    notes: z.string().max(5000),
    category: categorySchema,
    startDate: dateSchema,
    endDate: dateSchema.nullable(),
    dueTime: timeSchema.nullable(),
    reminderTime: timeSchema.nullable(),
    recurrence: recurrenceSchema,
    projectId: idSchema.nullable(),
    isPrivate: z.boolean(),
  })
  .partial()
  .strict()
  .refine(endAfterStart, { message: 'End date must be on or after the start date', path: ['endDate'] });
export type TodoUpdateInput = z.infer<typeof todoUpdateSchema>;

export const suggestionCreateSchema = z
  .object({ ...todoFields })
  .strict()
  .refine(endAfterStart, { message: 'End date must be on or after the start date', path: ['endDate'] });
export type SuggestionCreateInput = z.infer<typeof suggestionCreateSchema>;

export const suggestionAcceptSchema = z
  .object({ projectId: idSchema.nullable().default(null), isPrivate: z.boolean().default(false) })
  .strict();

export const suggestionDenySchema = z
  .object({ reason: z.string().trim().max(500).default('') })
  .strict();

export const projectCreateSchema = z
  .object({
    name: z.string().trim().min(1, 'Give it a name').max(120),
    description: z.string().max(2000).default(''),
    category: categorySchema,
    color: z.enum(PROJECT_COLORS).default('clay'),
    isPrivate: z.boolean().default(false),
  })
  .strict();

export const projectUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2000),
    category: categorySchema,
    color: z.enum(PROJECT_COLORS),
    isPrivate: z.boolean(),
    archived: z.boolean(),
  })
  .partial()
  .strict();

export const completeSchema = z.object({ note: z.string().max(1000).default('') }).strict();

export const meUpdateSchema = z
  .object({ name: z.string().trim().min(1).max(80), timezone: timezoneSchema })
  .partial()
  .strict();

export const pairAcceptSchema = z
  .object({ code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{8}$/, 'Codes are 8 letters or digits') })
  .strict();

export const inviteSchema = z.object({ email: z.string().trim().toLowerCase().pipe(z.email().max(254)) }).strict();

export const pushSubscriptionSchema = z
  .looseObject({
    endpoint: z.url({ protocol: /^https$/ }).max(2048),
    keys: z.object({
      p256dh: z.string().regex(/^[A-Za-z0-9_-]{80,100}$/),
      auth: z.string().regex(/^[A-Za-z0-9_-]{16,32}$/),
    }),
  });

export const pushUnsubscribeSchema = z.object({ endpoint: z.url().max(2048) }).strict();

export const rangeQuerySchema = z
  .object({ from: dateSchema, to: dateSchema, who: z.enum(['me', 'partner']).default('me') })
  .refine((v) => v.from <= v.to, 'from must be before to');

export const whoSchema = z.object({ who: z.enum(['me', 'partner']).default('me') });

export const photoUploadFieldsSchema = z.object({
  todoId: idSchema.optional(),
  instanceId: idSchema.optional(),
  suggestionId: idSchema.optional(),
  width: z.coerce.number().int().min(1).max(10000).optional(),
  height: z.coerce.number().int().min(1).max(10000).optional(),
});
