// Shapes returned by the API (mirrors server/db.ts and server/services/views.ts).
import type { Recurrence } from '../../shared/recurrence';
import type { HabitStats, InstanceStatus } from '../../shared/streaks';

export type { Recurrence, HabitStats, InstanceStatus };
export type Category = 'personal' | 'work' | 'habit';
export type ItemStatus = InstanceStatus | 'upcoming';

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  timezone: string;
  /** Last day of the user's current pause, if they're on a break today. */
  pausedUntil?: string | null;
}

export interface Me {
  user: PublicUser;
  partner: PublicUser | null;
  pairedAt: number | null;
  csrfToken: string;
  isAdmin: boolean;
  vapidPublicKey: string | null;
  today: string;
  pendingSuggestions: number;
  wrapupTime: string | null;
  serverNow: number;
  runningTimer: { id: string; todoId: string; startedAt: number; todoTitle: string } | null;
}

export interface ProjectRef {
  id: string;
  name: string;
  color: string;
}

export interface DayItem {
  instanceId: string | null;
  todoId: string;
  ownerId: string;
  date: string;
  title: string;
  notes: string;
  category: Category;
  project: ProjectRef | null;
  dueTime: string | null;
  reminderTime: string | null;
  status: ItemStatus;
  carriedOverFrom: string | null;
  recurrence: Recurrence;
  isPrivate: boolean;
  isShared: boolean;
  assignedTo: string | null;
  completedBy: string | null;
  canEdit: boolean;
  suggestedBy: string | null;
  photoCount: number;
  commentCount: number;
  reactions: { userId: string; emoji: string }[];
  /** Checklist progress for this occurrence. */
  subtasks: { done: number; total: number } | null;
  /** Joint habits: who has checked in today. */
  isJoint: boolean;
  jointDone: string[];
  streak: number | null;
}

export interface TodayView {
  date: string;
  timezone: string;
  items: DayItem[];
  summary: { done: number; total: number };
}

export interface RangeView {
  from: string;
  to: string;
  today: string;
  days: { date: string; items: DayItem[] }[];
}

export interface Project {
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

export interface ProjectSummary extends Project {
  progress: { done: number; total: number };
  recurringCount: number;
}

export interface ProjectTodo {
  todoId: string;
  ownerId: string;
  title: string;
  category: Category;
  recurrence: Recurrence;
  isPrivate: boolean;
  isShared: boolean;
  canEdit: boolean;
  dueTime: string | null;
  startDate: string;
  instanceId: string | null;
  status: InstanceStatus | null;
  stats: HabitStats | null;
  photoCount: number;
  minutes: number;
}

export interface ProjectDetail {
  today: string;
  project: Project;
  canManage: boolean;
  canAdd: boolean;
  progress: { done: number; total: number };
  minutesTotal: number;
  todos: ProjectTodo[];
}

export interface Habit {
  todoId: string;
  ownerId: string;
  title: string;
  category: Category;
  recurrence: Recurrence;
  project: ProjectRef | null;
  isPrivate: boolean;
  isShared: boolean;
  canEdit: boolean;
  stats: HabitStats;
  todayInstanceId: string | null;
  todayStatus: InstanceStatus | null;
  recent: { date: string; status: InstanceStatus | null }[];
  ended: boolean;
}

export interface Todo {
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
  assignedTo: string | null;
  isJoint: boolean;
  ownerId: string;
  suggestedBy: string | null;
  createdAt: number;
}

export interface Photo {
  id: string;
  url: string;
  todoId: string | null;
  instanceId: string | null;
  width: number | null;
  height: number | null;
  createdAt: number;
}

export interface TodoDetail {
  todo: Todo;
  canEdit: boolean;
  isOwner: boolean;
  canComment: boolean;
  today: string;
  project: Project | null;
  suggestedBy: string | null;
  photos: Photo[];
  instances: { id: string; date: string; status: InstanceStatus; completedAt: number | null; completedBy: string | null; note: string }[];
  stats: HabitStats | null;
}

export interface Suggestion {
  id: string;
  from: { id: string; name: string };
  to: { id: string; name: string };
  title: string;
  notes: string;
  category: Category;
  startDate: string;
  endDate: string | null;
  dueTime: string | null;
  reminderTime: string | null;
  recurrence: Recurrence;
  status: 'pending' | 'accepted' | 'denied' | 'withdrawn';
  reason: string | null;
  todoId: string | null;
  createdAt: number;
  respondedAt: number | null;
  photos: Photo[];
}

export interface Invite {
  email: string;
  invitedAt: number;
  joined: boolean;
  name: string | null;
  lastLoginAt: number | null;
}

export interface Comment {
  id: string;
  authorId: string;
  authorName: string;
  authorAvatar: string | null;
  body: string;
  createdAt: number;
  mine: boolean;
}
