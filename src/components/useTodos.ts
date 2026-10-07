import { errorMessage, send } from '../lib/api';
import type { DayItem } from '../lib/types';
import { toast } from './ui';

/** Optimistically toggles an item's instance; rolls back on failure. */
export async function toggleItem(item: DayItem, today: string, apply: (instanceId: string, status: DayItem['status']) => void) {
  if (!item.instanceId) return;
  const wasDone = item.status === 'done';
  const next: DayItem['status'] = wasDone ? (item.recurrence.type !== 'none' && item.date < today ? 'missed' : 'pending') : 'done';
  apply(item.instanceId, next);
  try {
    await send('POST', `/api/instances/${item.instanceId}/${wasDone ? 'uncomplete' : 'complete'}`, {});
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
