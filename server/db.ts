// Row types (as stored in D1) and mappers to the JSON shapes the API returns.
import { ruleFromColumns, type Recurrence } from '../shared/recurrence';
import type { InstanceStatus } from '../shared/streaks';

export type Category = 'personal' | 'work' | 'habit';

export interface UserRow {
  id: string;
  email: string;
  google_sub: string | null;
  name: string;
  avatar_url: string | null;
  timezone: string;
  partner_id: string | null;
  paired_at: number | null;
  created_at: number;
  last_login_at: number | null;
  wrapup_time: string | null;
  wrapup_sent_on: string | null;
}

export interface ProjectRow {
  id: string;
  user_id: string;
  name: string;
  description: string;
  category: Category;
  color: string;
  is_private: number;
  is_shared: number;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface TodoRow {
  id: string;
  user_id: string;
  project_id: string | null;
  title: string;
  notes: string;
  category: Category;
  start_date: string;
  end_date: string | null;
  due_time: string | null;
  reminder_time: string | null;
  recurrence: 'none' | 'daily' | 'weekly' | 'monthly';
  recurrence_weekdays: string | null;
  recurrence_month_day: number | null;
  is_private: number;
  is_shared: number;
  assigned_to: string | null;
  suggested_by: string | null;
  materialized_through: string | null;
  created_at: number;
  updated_at: number;
}

export interface InstanceRow {
  id: string;
  todo_id: string;
  user_id: string;
  date: string;
  status: InstanceStatus;
  completed_at: number | null;
  completed_on: string | null;
  completed_by: string | null;
  note: string;
  reminder_at: number | null;
  reminded_at: number | null;
  created_at: number;
}

export interface SuggestionRow {
  id: string;
  from_user_id: string;
  to_user_id: string;
  title: string;
  notes: string;
  category: Category;
  start_date: string;
  end_date: string | null;
  due_time: string | null;
  reminder_time: string | null;
  recurrence: 'none' | 'daily' | 'weekly' | 'monthly';
  recurrence_weekdays: string | null;
  recurrence_month_day: number | null;
  status: 'pending' | 'accepted' | 'denied' | 'withdrawn';
  reason: string | null;
  todo_id: string | null;
  created_at: number;
  responded_at: number | null;
}

export interface PhotoRow {
  id: string;
  owner_id: string;
  todo_id: string | null;
  instance_id: string | null;
  suggestion_id: string | null;
  r2_key: string;
  content_type: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  created_at: number;
}

// --- DTOs ---

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  timezone: string;
}

export function publicUser(u: UserRow): PublicUser {
  return { id: u.id, name: u.name || u.email.split('@')[0]!, email: u.email, avatarUrl: u.avatar_url, timezone: u.timezone };
}

export interface ProjectDto {
  id: string;
  name: string;
  description: string;
  category: Category;
  color: string;
  isPrivate: boolean;
  isShared: boolean;
  ownerId: string;
  archived: boolean;
  createdAt: number;
}

export function projectDto(p: ProjectRow): ProjectDto {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    category: p.category,
    color: p.color,
    isPrivate: p.is_private === 1,
    isShared: p.is_shared === 1,
    ownerId: p.user_id,
    archived: p.archived_at !== null,
    createdAt: p.created_at,
  };
}

export interface TodoDto {
  id: string;
  title: string;
  notes: string;
  category: Category;
  projectId: string | null;
  startDate: string;
  endDate: string | null;
  dueTime: string | null;
  reminderTime: string | null;
  recurrence: Recurrence;
  isPrivate: boolean;
  isShared: boolean;
  /** Assignee of a shared todo (user id), null = either of us. */
  assignedTo: string | null;
  ownerId: string;
  suggestedBy: string | null;
  createdAt: number;
}

export function todoDto(t: TodoRow): TodoDto {
  return {
    id: t.id,
    title: t.title,
    notes: t.notes,
    category: t.category,
    projectId: t.project_id,
    startDate: t.start_date,
    endDate: t.end_date,
    dueTime: t.due_time,
    reminderTime: t.reminder_time,
    recurrence: ruleFromColumns(t),
    isPrivate: t.is_private === 1,
    isShared: t.is_shared === 1,
    assignedTo: t.assigned_to,
    ownerId: t.user_id,
    suggestedBy: t.suggested_by,
    createdAt: t.created_at,
  };
}

export interface PhotoDto {
  id: string;
  url: string;
  todoId: string | null;
  instanceId: string | null;
  width: number | null;
  height: number | null;
  createdAt: number;
}

export function photoDto(p: PhotoRow): PhotoDto {
  return {
    id: p.id,
    url: `/api/photos/${p.id}`,
    todoId: p.todo_id,
    instanceId: p.instance_id,
    width: p.width,
    height: p.height,
    createdAt: p.created_at,
  };
}

export function bool(n: number | null | undefined): boolean {
  return n === 1;
}

/** Splits an array into chunks (D1 batches and bound-parameter limits). */
export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function runBatch(db: D1Database, stmts: D1PreparedStatement[]): Promise<void> {
  for (const part of chunk(stmts, 50)) {
    if (part.length) await db.batch(part);
  }
}

export function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(',');
}
