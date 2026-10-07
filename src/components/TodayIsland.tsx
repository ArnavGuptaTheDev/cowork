import { useEffect, useState } from 'preact/hooks';
import { copy } from '../content/copy';
import { get, getMe } from '../lib/api';
import { dayMonth, dayName, greeting, relativeDay } from '../lib/format';
import type { DayItem, Me, TodayView } from '../lib/types';
import { QuickAdd } from './QuickAdd';
import { TodoForm } from './TodoForm';
import { TodoItem } from './TodoItem';
import { TodoSheet } from './TodoSheet';
import { Empty, ErrorBox, Icon, Loading, ProgressBar, ProgressRing, Toasts, useLoad } from './ui';
import { sortForDisplay, toggleItem } from './useTodos';

export default function TodayIsland() {
  const [creating, setCreating] = useState(false);
  const [openItem, setOpenItem] = useState<DayItem | null>(null);
  // Deep link from a notification: /today?todo=<id> opens that todo.
  const [deepTodo, setDeepTodo] = useState<string | null>(null);
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('todo');
    if (id) setDeepTodo(id);
  }, []);
  const state = useLoad(async () => {
    const me = await getMe();
    const [mine, partner] = await Promise.all([
      get<TodayView>('/api/today'),
      me.partner ? get<TodayView>('/api/today?who=partner').catch(() => null) : Promise.resolve(null),
    ]);
    return { me, mine, partner };
  });

  const apply = (instanceId: string, status: DayItem['status']) =>
    state.setData((d) => {
      if (!d) return d;
      const items = d.mine.items.map((i) => (i.instanceId === instanceId ? { ...i, status, streak: streakAfter(i, status) } : i));
      return { ...d, mine: { ...d.mine, items, summary: { done: items.filter((i) => i.status === 'done').length, total: items.length } } };
    });

  if (state.loading && !state.data) return <Loading />;
  if (state.error || !state.data) return <ErrorBox message={state.error ?? 'Could not load today'} onRetry={state.reload} />;

  const { me, mine, partner } = state.data;
  const { open, done } = sortForDisplay(mine.items);
  const allDone = mine.summary.total > 0 && mine.summary.done === mine.summary.total;

  return (
    <>
      <header class="page-head">
        <div>
          <p class="eyebrow">
            {greeting()}, {firstName(me)}
          </p>
          <h1 class="page-title">
            {dayName(mine.date)}
            <br />
            <em>{dayMonth(mine.date)}</em>
          </h1>
        </div>
        <ProgressRing done={mine.summary.done} total={mine.summary.total} label={`Today: ${mine.summary.done} of ${mine.summary.total} done`} />
      </header>

      {me.user.pausedUntil && (
        <p class="partner-banner mb-4">
          <Icon name="pause" /> You're on a break until {relativeDay(me.user.pausedUntil, mine.date).toLowerCase()}. Reminders are off.{' '}
          <a href="/settings">End it</a>
        </p>
      )}

      <div class="split">
        <aside class="split-side">
          <button type="button" class="btn block desk-only" onClick={() => setCreating(true)}>
            <Icon name="plus" /> {copy.today.add}
          </button>
          {me.partner && partner && (
            <a class="glance" href="/partner">
              <Icon name="users" />
              <span>
                {me.partner.name.split(' ')[0]}
                {me.partner.pausedUntil ? ' · on a break' : ''}
              </span>
              <ProgressBar done={partner.summary.done} total={partner.summary.total} />
              <span>
                {partner.summary.done}/{partner.summary.total}
              </span>
            </a>
          )}
        </aside>

        <div class="split-main">
          <QuickAdd today={mine.date} onSaved={state.reload} />
          {mine.items.length === 0 ? (
            <Empty title={copy.today.empty.title} body={copy.today.empty.body} icon="sun">
              <button type="button" class="btn" onClick={() => setCreating(true)}>
                <Icon name="plus" /> {copy.today.add}
              </button>
            </Empty>
          ) : (
            <>
              {allDone && <p class="celebrate">{copy.today.allDone}</p>}
              <ul class="todo-list" aria-label="To do">
                {open.map((item) => (
                  <TodoItem key={item.instanceId} item={item} today={mine.date} onToggle={(i) => toggleItem(i, mine.date, apply, state.reload)} onOpen={setOpenItem} />
                ))}
              </ul>
              {done.length > 0 && (
                <>
                  <p class="done-divider">Done · {done.length}</p>
                  <ul class="todo-list" aria-label="Done">
                    {done.map((item) => (
                      <TodoItem key={item.instanceId} item={item} today={mine.date} onToggle={(i) => toggleItem(i, mine.date, apply, state.reload)} onOpen={setOpenItem} />
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </div>
      </div>

      <button type="button" class="fab" onClick={() => setCreating(true)} aria-label={copy.today.add}>
        <Icon name="plus" />
      </button>

      <TodoForm open={creating} mode="create" today={mine.date} onClose={() => setCreating(false)} onSaved={state.reload} />
      <TodoSheet
        todoId={openItem?.todoId ?? deepTodo}
        instanceId={openItem?.instanceId ?? mine.items.find((i) => i.todoId === deepTodo)?.instanceId}
        item={openItem ?? mine.items.find((i) => i.todoId === deepTodo)}
        onClose={() => {
          setOpenItem(null);
          if (deepTodo) {
            setDeepTodo(null);
            history.replaceState(null, '', '/today');
          }
        }}
        onChanged={state.reload}
      />
      <Toasts />
    </>
  );
}

function firstName(me: Me): string {
  return me.user.name.split(' ')[0] ?? me.user.name;
}

function streakAfter(i: DayItem, status: DayItem['status']): number | null {
  if (i.streak === null || i.recurrence.type === 'none') return i.streak;
  if (status === 'done' && i.status !== 'done') return i.streak + 1;
  if (status !== 'done' && i.status === 'done') return Math.max(0, i.streak - 1);
  return i.streak;
}
