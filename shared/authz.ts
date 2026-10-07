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

/** Only owners change their own data. Partners are strictly read-only. */
export function canEditTodo(viewer: Viewer, todo: Pick<OwnedTodo, 'userId'>): boolean {
  return viewer.id === todo.userId;
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
