import { useEffect, useState } from 'preact/hooks';
import { compareDeadlines } from '../../shared/deadline';
import type { Deadline, Stage } from '../lib/types';

export type ListFilter = 'all' | 'blocked' | 'high' | 'overdue';
export type ListSort = 'priority' | 'time' | 'deadline' | 'manual';

interface Sortable {
  title: string;
  priority: number;
  deadline: Deadline | null;
  position: string | null;
  dueTime: string | null;
  stage?: Stage | null;
  status?: string | null;
}

const FILTERS: [ListFilter, string][] = [
  ['all', 'All'],
  ['blocked', 'Blocked'],
  ['high', 'High+'],
  ['overdue', 'Overdue'],
];
const SORTS: [ListSort, string][] = [
  ['priority', 'Priority'],
  ['time', 'Time'],
  ['deadline', 'Deadline'],
  ['manual', 'Manual'],
];

function load<T extends string>(key: string, fallback: T, allowed: T[]): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    // storage unavailable: the choice just isn't remembered
  }
}

const byPosition = (a: Sortable, b: Sortable) => {
  if (a.position === b.position) return 0;
  if (!a.position) return 1;
  if (!b.position) return -1;
  return a.position < b.position ? -1 : 1;
};

/**
 * Filter and sort for a list. "Priority" keeps the server's default order (overdue, priority, deadline, manual).
 * The choice is remembered per page in this browser.
 */
export function useListControls(page: string, today: string) {
  const [filter, setFilter] = useState<ListFilter>('all');
  const [sort, setSort] = useState<ListSort>('priority');
  useEffect(() => {
    setFilter(load(`cw:${page}:filter`, 'all', FILTERS.map((f) => f[0])));
    setSort(load(`cw:${page}:sort`, 'priority', SORTS.map((s) => s[0])));
  }, [page]);

  function apply<T extends Sortable>(items: T[]): T[] {
    const kept = items.filter((i) => {
      if (filter === 'blocked') return i.stage?.kind === 'blocked';
      if (filter === 'high') return i.priority >= 3;
      if (filter === 'overdue') return !!i.deadline && i.status !== 'done' && i.deadline.date < today;
      return true;
    });
    if (sort === 'priority') return kept;
    return [...kept].sort((a, b) => {
      if (sort === 'time') return (a.dueTime ?? '99:99').localeCompare(b.dueTime ?? '99:99') || byPosition(a, b);
      if (sort === 'deadline') {
        return compareDeadlines({ date: a.deadline?.date ?? null, time: a.deadline?.time ?? null }, { date: b.deadline?.date ?? null, time: b.deadline?.time ?? null }) || b.priority - a.priority;
      }
      return byPosition(a, b);
    });
  }

  const controls = (
    <div class="list-controls" role="group" aria-label="Filter and sort">
      <div class="tabs small" role="radiogroup" aria-label="Filter">
        {FILTERS.map(([v, l]) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={filter === v}
            aria-selected={filter === v}
            onClick={() => {
              setFilter(v);
              save(`cw:${page}:filter`, v);
            }}
          >
            {l}
          </button>
        ))}
      </div>
      <label class="sort-label">
        <span class="sr-only">Sort by</span>
        <select
          class="select small"
          value={sort}
          onChange={(e) => {
            const v = e.currentTarget.value as ListSort;
            setSort(v);
            save(`cw:${page}:sort`, v);
          }}
        >
          {SORTS.map(([v, l]) => (
            <option key={v} value={v}>
              Sort: {l}
            </option>
          ))}
        </select>
      </label>
    </div>
  );

  return { filter, sort, apply, controls, active: filter !== 'all' };
}
