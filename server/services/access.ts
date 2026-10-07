import { arePartners } from '../../shared/authz';
import type { UserRow } from '../db';
import { forbidden } from '../http';

export async function getUser(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();
}

/** The viewer's partner, but only if the partnership is mutual. */
export async function getPartner(db: D1Database, user: UserRow): Promise<UserRow | null> {
  if (!user.partner_id) return null;
  const p = await getUser(db, user.partner_id);
  if (!p || !arePartners({ id: user.id, partnerId: user.partner_id }, p.id, p.partner_id)) return null;
  return p;
}

export interface ViewTarget {
  owner: UserRow;
  /** True when the viewer is looking at their partner's data: private items are filtered out. */
  asPartner: boolean;
}

export async function resolveTarget(db: D1Database, viewer: UserRow, who: 'me' | 'partner'): Promise<ViewTarget> {
  if (who === 'me') return { owner: viewer, asPartner: false };
  const partner = await getPartner(db, viewer);
  if (!partner) throw forbidden('You are not paired with anyone');
  return { owner: partner, asPartner: true };
}

/** SQL fragment that hides private todos (alias t) and todos in private projects (alias p) from partners. */
export function privacyFilter(asPartner: boolean): string {
  return asPartner ? ' AND t.is_private = 0 AND (p.id IS NULL OR p.is_private = 0)' : '';
}
