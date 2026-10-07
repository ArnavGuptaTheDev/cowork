import { errorMessage, getMe, send } from '../lib/api';
import type { DayItem } from '../lib/types';
import { toast } from './ui';

/** Has the current user ticked this off? (For joint habits: their own check-in.) */
export function checkedByMe(item: DayItem, meId: string | null | undefined): boolean {
  if (item.status === 'done') return true;
  return item.isJoint && !!meId && item.jointDone.includes(meId);
}

/**
 * Optimistically toggles an item's instance; rolls back on failure. Joint habits wait for the server
 * (they only become done when both partners have checked in) and then reload.
 */
export async function toggleItem(
  item: DayItem,
  today: string,
  apply: (instanceId: string, status: DayItem['status']) => void,
  reload?: () => void,
) {
  if (!item.instanceId) return;
  const me = await getMe().catch(() => null);
  const wasDone = checkedByMe(item, me?.user.id);
  const open = item.subtasks ? item.subtasks.total - item.subtasks.done : 0;
  if (!wasDone && open > 0 && !confirm(`${open} checklist item${open > 1 ? 's are' : ' is'} still open. Mark it done anyway?`)) return;
  const next: DayItem['status'] = wasDone ? (item.recurrence.type !== 'none' && item.date < today ? 'missed' : 'pending') : 'done';
  if (!item.isJoint) apply(item.instanceId, next);
  try {
    const res = await send<{ instance: { status: DayItem['status'] } }>(
      'POST',
      `/api/instances/${item.instanceId}/${wasDone ? 'uncomplete' : 'complete'}`,
      {},
    );
    if (item.isJoint) {
      if (!wasDone && res.instance.status !== 'done') toast('Checked in. It counts once you both have');
      reload?.();
    }
    if (!wasDone && 'vibrate' in navigator) navigator.vibrate?.(12);
  } catch (e) {
    apply(item.instanceId, item.status);
    toast(errorMessage(e), 'error');
  }
}

export function sortForDisplay(items: DayItem[]): { open: DayItem[]; done: DayItem[] } {
  return {
    open: items.filter((i) => i.status !== 'done'),
    done: items.filter((i) => i.status === 'done'),
  };
}
