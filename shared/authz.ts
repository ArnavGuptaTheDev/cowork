// Authorisation rules. Pure functions so they can be unit-tested and reused by every route.

export interface Viewer {
  id: string;
  partnerId: string | null;
}

export interface OwnedTodo {
  userId: string;
  isPrivate: boolean;
  /** Privacy of the todo's project, if any. A private project hides all its todos. */
  projectPrivate?: boolean;
  /** Shared todos (or todos in a shared project) are editable by both partners. */
  isShared?: boolean;
  projectShared?: boolean;
}

export function isSharedTodo(todo: Pick<OwnedTodo, 'isShared' | 'projectShared'>): boolean {
  return !!todo.isShared || !!todo.projectShared;
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Only the super admin or an invited email may sign in. */
export function canSignIn(
  email: string,
  emailVerified: boolean,
  superAdminEmail: string | undefined,
  isInvited: boolean,
): boolean {
  if (!emailVerified) return false;
  const e = normaliseEmail(email);
  if (!e) return false;
  if (superAdminEmail && normaliseEmail(superAdminEmail) !== '' && e === normaliseEmail(superAdminEmail)) {
    return true;
  }
  return isInvited;
}

export function isSuperAdmin(email: string, superAdminEmail: string | undefined): boolean {
  return !!superAdminEmail && normaliseEmail(superAdminEmail) !== '' && normaliseEmail(email) === normaliseEmail(superAdminEmail);
}

/** Are viewer and owner partners of each other? */
export function arePartners(viewer: Viewer, ownerId: string, ownerPartnerId: string | null): boolean {
  return viewer.partnerId === ownerId && ownerPartnerId === viewer.id;
}

/** May the viewer see anything belonging to ownerId at all? */
export function canViewUser(viewer: Viewer, ownerId: string, ownerPartnerId: string | null): boolean {
  return viewer.id === ownerId || arePartners(viewer, ownerId, ownerPartnerId);
}

/** May the viewer see this todo (and, by extension, its instances and photos)? */
export function canViewTodo(viewer: Viewer, todo: OwnedTodo, ownerPartnerId: string | null): boolean {
  if (viewer.id === todo.userId) return true;
  if (!arePartners(viewer, todo.userId, ownerPartnerId)) return false;
  return !todo.isPrivate && !todo.projectPrivate;
}

/** Owners edit their todos; partners may edit only shared ones (never private ones). */
export function canEditTodo(
  viewer: Viewer,
  todo: Pick<OwnedTodo, 'userId'> & Partial<OwnedTodo>,
  ownerPartnerId: string | null = null,
): boolean {
  if (viewer.id === todo.userId) return true;
  if (todo.isPrivate || todo.projectPrivate) return false;
  return isSharedTodo(todo) && arePartners(viewer, todo.userId, ownerPartnerId);
}

/** Comments live on non-private todos only, and only the owner and partner take part. */
export function canComment(viewer: Viewer, todo: OwnedTodo, ownerPartnerId: string | null): boolean {
  if (todo.isPrivate || todo.projectPrivate) return false;
  return canViewTodo(viewer, todo, ownerPartnerId);
}

/** Reactions: on a done instance someone else completed, of a todo the viewer can see (never private). */
export function canReact(
  viewer: Viewer,
  todo: OwnedTodo,
  ownerPartnerId: string | null,
  instance: { status: string; completedBy: string | null },
): boolean {
  if (instance.status !== 'done' || todo.isPrivate || todo.projectPrivate) return false;
  if (!canViewTodo(viewer, todo, ownerPartnerId)) return false;
  return (instance.completedBy ?? todo.userId) !== viewer.id;
}

/**
 * Who a nudge on this todo would go to: the assignee of a shared todo, otherwise the owner.
 * Returns null when the viewer can't nudge (not visible, private, or it would nudge themselves).
 */
export function nudgeTarget(
  viewer: Viewer,
  todo: OwnedTodo & { assignedTo?: string | null },
  ownerPartnerId: string | null,
  instance: { status: string },
): string | null {
  if (instance.status !== 'pending' || todo.isPrivate || todo.projectPrivate) return null;
  if (!canViewTodo(viewer, todo, ownerPartnerId)) return null;
  let target: string | null;
  if (isSharedTodo(todo)) {
    // "Either of us": nudge the other person.
    target = todo.assignedTo ?? (todo.userId === viewer.id ? viewer.partnerId : todo.userId);
  } else {
    target = todo.userId;
  }
  return target && target !== viewer.id ? target : null;
}

export interface PhotoContext {
  ownerId: string;
  todo: OwnedTodo | null;
  suggestion: { fromUserId: string; toUserId: string } | null;
}

export function canViewPhoto(viewer: Viewer, photo: PhotoContext, ownerPartnerId: string | null): boolean {
  if (photo.todo) return canViewTodo(viewer, photo.todo, ownerPartnerId);
  if (photo.suggestion) {
    return viewer.id === photo.suggestion.fromUserId || viewer.id === photo.suggestion.toUserId;
  }
  return viewer.id === photo.ownerId;
}
