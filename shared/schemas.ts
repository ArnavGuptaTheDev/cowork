// Input schemas shared by the API (validation) and the client (types).
import { z } from 'zod';
import { isValidDate, isValidTimeZone } from './time';

import { CATEGORIES, PROJECT_COLORS, REACTIONS, STATUS_COLORS, STATUS_KINDS } from './constants';

export { CATEGORIES, MAX_PHOTO_BYTES, MAX_PHOTOS_PER_TARGET, PHOTO_TYPES, PROJECT_COLORS, REACTIONS } from './constants';

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

export const prioritySchema = z.number().int().min(1).max(4);

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

/** Who a shared todo is for, from the creator's point of view. */
export const assigneeSchema = z.enum(['me', 'partner', 'either']);
export type Assignee = z.infer<typeof assigneeSchema>;

function endAfterStart(v: { startDate?: string; endDate?: string | null }) {
  return !v.endDate || !v.startDate || v.endDate >= v.startDate;
}

export const todoCreateSchema = z
  .object({
    ...todoFields,
    projectId: idSchema.nullable().default(null),
    isPrivate: z.boolean().default(false),
    isShared: z.boolean().default(false),
    assignee: assigneeSchema.default('either'),
    isJoint: z.boolean().default(false),
    priority: prioritySchema.default(2),
    deadlineDate: dateSchema.nullable().default(null),
    deadlineTime: timeSchema.nullable().default(null),
  })
  .strict()
  .refine(endAfterStart, { message: 'End date must be on or after the start date', path: ['endDate'] })
  .refine((v) => !(v.isShared && v.isPrivate), { message: 'A todo can be private or shared, not both', path: ['isShared'] });
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
    isShared: z.boolean(),
    assignee: assigneeSchema,
    isJoint: z.boolean(),
    priority: prioritySchema,
    deadlineDate: dateSchema.nullable(),
    deadlineTime: timeSchema.nullable(),
  })
  .partial()
  .strict()
  .refine(endAfterStart, { message: 'End date must be on or after the start date', path: ['endDate'] })
  .refine((v) => !(v.isShared && v.isPrivate), { message: 'A todo can be private or shared, not both', path: ['isShared'] });
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
    isShared: z.boolean().default(false),
    deadlineDate: dateSchema.nullable().default(null),
    deadlineTime: timeSchema.nullable().default(null),
  })
  .strict()
  .refine((v) => !(v.isShared && v.isPrivate), { message: 'A project can be private or shared, not both', path: ['isShared'] });

export const projectUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2000),
    category: categorySchema,
    color: z.enum(PROJECT_COLORS),
    isPrivate: z.boolean(),
    isShared: z.boolean(),
    archived: z.boolean(),
    deadlineDate: dateSchema.nullable(),
    deadlineTime: timeSchema.nullable(),
  })
  .partial()
  .strict()
  .refine((v) => !(v.isShared && v.isPrivate), { message: 'A project can be private or shared, not both', path: ['isShared'] });

export const completeSchema = z.object({ note: z.string().max(1000).default('') }).strict();

export const meUpdateSchema = z
  .object({ name: z.string().trim().min(1).max(80), timezone: timezoneSchema, wrapupTime: timeSchema.nullable() })
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

export const reactSchema = z.object({ emoji: z.enum(REACTIONS).nullable() }).strict();

export const commentCreateSchema = z
  .object({ body: z.string().trim().min(1, 'Write something first').max(1000, 'Keep comments under 1000 characters') })
  .strict();

export const rescheduleSchema = z.object({ date: dateSchema }).strict();

export const snoozeSchema = z.object({ minutes: z.number().int().min(5).max(24 * 60).default(60) }).strict();

// --- Phase 2 ---

export const subtaskTitleSchema = z.string().trim().min(1, 'Give it a title').max(200);
export const subtaskCreateSchema = z.object({ title: subtaskTitleSchema }).strict();
export const subtaskUpdateSchema = z.object({ title: subtaskTitleSchema }).strict();
export const subtaskOrderSchema = z.object({ ids: z.array(idSchema).min(1).max(100) }).strict();
export const subtaskCheckSchema = z.object({ instanceId: idSchema, done: z.boolean() }).strict();

export const templateCreateSchema = z
  .object({
    name: z.string().trim().min(1, 'Name the template').max(80),
    todoIds: z.array(idSchema).min(1, 'Pick at least one todo').max(50),
    isShared: z.boolean().default(false),
  })
  .strict();
export const templateUpdateSchema = z
  .object({ name: z.string().trim().min(1).max(80), isShared: z.boolean() })
  .partial()
  .strict();
export const templateApplySchema = z
  .object({ startDate: dateSchema, projectId: idSchema.nullable().default(null) })
  .strict();

export const goalCreateSchema = z
  .object({
    title: z.string().trim().min(1, 'Name the goal').max(120),
    targetPerPerson: z.number().int().min(1).max(50),
    todoId: idSchema.nullable().default(null),
  })
  .strict();
export const goalUpdateSchema = z
  .object({ title: z.string().trim().min(1).max(120), targetPerPerson: z.number().int().min(1).max(50), archived: z.boolean() })
  .partial()
  .strict();
export const goalLinkSchema = z.object({ todoId: idSchema.nullable() }).strict();

export const pauseCreateSchema = z
  .object({ startDate: dateSchema, endDate: dateSchema, note: z.string().trim().max(200).default('') })
  .strict()
  .refine((v) => v.endDate >= v.startDate, { message: 'The pause must end on or after it starts', path: ['endDate'] });

export const reviewQuerySchema = z.object({ week: dateSchema.optional() });

export const photoFeedQuerySchema = z.object({
  before: z
    .string()
    .regex(/^\d{1,16}_[0-9a-f-]{36}$/)
    .optional(),
  projectId: idSchema.optional(),
  todoId: idSchema.optional(),
  who: z.enum(['all', 'me', 'partner']).default('all'),
});

// --- Phase 3 ---

const msSchema = z.number().int().min(0).max(8_640_000_000_000);
export const timeEntryCreateSchema = z
  .object({ startedAt: msSchema, endedAt: msSchema, note: z.string().trim().max(300).default('') })
  .strict()
  .refine((v) => v.endedAt >= v.startedAt, { message: 'An entry must end after it starts', path: ['endedAt'] })
  .refine((v) => v.endedAt - v.startedAt <= 24 * 3600_000, { message: 'Entries are limited to 24 hours', path: ['endedAt'] });
export const timeEntryUpdateSchema = z
  .object({ startedAt: msSchema, endedAt: msSchema, note: z.string().trim().max(300) })
  .partial()
  .strict();

// --- Statuses, board, tomorrow's habits ---

export const statusNameSchema = z.string().trim().min(1, 'Name the status').max(40);
export const statusCreateSchema = z
  .object({ name: statusNameSchema, color: z.enum(STATUS_COLORS).default('ink'), kind: z.enum(STATUS_KINDS) })
  .strict();
/** Kind is fixed once created. */
export const statusUpdateSchema = z
  .object({ name: statusNameSchema, color: z.enum(STATUS_COLORS), archived: z.boolean(), isDefault: z.literal(true) })
  .partial()
  .strict();
export const statusOrderSchema = z.object({ ids: z.array(idSchema).min(1).max(50) }).strict();

export const blockerNoteSchema = z.string().trim().min(1, 'Say what it is waiting on').max(300);
export const setStatusSchema = z.object({ statusId: idSchema, blocker: blockerNoteSchema.optional() }).strict();

export const boardQuerySchema = z.object({
  projectId: idSchema.optional(),
  category: z.enum(CATEGORIES).optional(),
});
/** A board drop: optional new column (status), and the cards it lands between (null = column start/end). */
export const boardMoveSchema = z
  .object({
    statusId: idSchema.optional(),
    blocker: blockerNoteSchema.optional(),
    beforeId: idSchema.nullable().default(null),
    afterId: idSchema.nullable().default(null),
  })
  .strict();

export const tomorrowActionSchema = z
  .discriminatedUnion('action', [
    z.object({ action: z.literal('keep') }).strict(),
    z.object({ action: z.literal('skip') }).strict(),
    z.object({ action: z.literal('time'), time: timeSchema }).strict(),
  ]);
export const changeFromTomorrowSchema = z
  .object({ recurrence: recurrenceSchema, dueTime: timeSchema.nullable(), reminderTime: timeSchema.nullable() })
  .partial()
  .strict();
