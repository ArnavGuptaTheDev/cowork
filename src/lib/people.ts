import type { Me } from './types';

/** "you", the partner's first name, or "someone" for a user id. */
export function nameFor(me: Me | null | undefined, userId: string | null | undefined): string {
  if (!me || !userId) return 'someone';
  if (userId === me.user.id) return 'you';
  if (me.partner && userId === me.partner.id) return me.partner.name.split(' ')[0] ?? me.partner.name;
  return 'someone';
}

/** Assignee label for a shared todo. */
export function assigneeLabel(me: Me | null | undefined, assignedTo: string | null): string {
  if (!assignedTo) return 'either of you';
  return assignedTo === me?.user.id ? 'you' : nameFor(me, assignedTo);
}
