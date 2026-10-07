import { describe, expect, it } from 'vitest';
import { canEditTodo, canSignIn, canViewPhoto, canViewTodo, canViewUser, isSuperAdmin } from '../shared/authz';

const alice = { id: 'a', partnerId: 'b' };
const bob = { id: 'b', partnerId: 'a' };
const eve = { id: 'e', partnerId: null };

describe('sign-in rules', () => {
  it('lets the super admin in, case-insensitively', () => {
    expect(canSignIn('Admin@Example.com', true, 'admin@example.com', false)).toBe(true);
  });
  it('rejects an uninvited email', () => {
    expect(canSignIn('stranger@example.com', true, 'admin@example.com', false)).toBe(false);
  });
  it('accepts an invited email', () => {
    expect(canSignIn('friend@example.com', true, 'admin@example.com', true)).toBe(true);
  });
  it('requires a verified email, even for the admin', () => {
    expect(canSignIn('admin@example.com', false, 'admin@example.com', false)).toBe(false);
  });
  it('an unset SUPER_ADMIN_EMAIL never matches', () => {
    expect(canSignIn('', true, '', false)).toBe(false);
    expect(isSuperAdmin('', '')).toBe(false);
    expect(isSuperAdmin('x@example.com', undefined)).toBe(false);
  });
});

describe('todo visibility', () => {
  const shared = { userId: 'a', isPrivate: false };
  const priv = { userId: 'a', isPrivate: true };
  const inPrivateProject = { userId: 'a', isPrivate: false, projectPrivate: true };

  it('owner sees everything', () => {
    expect(canViewTodo(alice, priv, 'b')).toBe(true);
  });
  it('partner sees shared todos', () => {
    expect(canViewTodo(bob, shared, 'b')).toBe(true);
  });
  it('partner cannot see private todos or todos in private projects', () => {
    expect(canViewTodo(bob, priv, 'b')).toBe(false);
    expect(canViewTodo(bob, inPrivateProject, 'b')).toBe(false);
  });
  it('a non-partner sees nothing', () => {
    expect(canViewTodo(eve, shared, 'b')).toBe(false);
    expect(canViewUser(eve, 'a', 'b')).toBe(false);
  });
  it('a one-sided partner claim is not enough', () => {
    const claimant = { id: 'e', partnerId: 'a' };
    expect(canViewTodo(claimant, shared, 'b')).toBe(false);
  });
  it('only owners edit', () => {
    expect(canEditTodo(alice, shared)).toBe(true);
    expect(canEditTodo(bob, shared)).toBe(false);
  });
});

describe('photo visibility', () => {
  it("private todos' photos are owner-only", () => {
    const photo = { ownerId: 'a', todo: { userId: 'a', isPrivate: true }, suggestion: null };
    expect(canViewPhoto(alice, photo, 'b')).toBe(true);
    expect(canViewPhoto(bob, photo, 'b')).toBe(false);
  });
  it('suggestion photos are visible to both ends of the suggestion only', () => {
    const photo = { ownerId: 'a', todo: null, suggestion: { fromUserId: 'a', toUserId: 'b' } };
    expect(canViewPhoto(bob, photo, 'b')).toBe(true);
    expect(canViewPhoto(eve, photo, 'b')).toBe(false);
  });
});
