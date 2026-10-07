import { useState } from 'preact/hooks';
import { copy } from '../content/copy';
import { errorMessage, get, send } from '../lib/api';
import type { Habit } from '../lib/types';
import { HabitList } from './HabitList';
import { TodoForm } from './TodoForm';
import { TodoSheet } from './TodoSheet';
import { Empty, ErrorBox, Icon, Loading, Toasts, toast, useLoad } from './ui';

export default function HabitsIsland() {
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<Habit | null>(null);
  const state = useLoad(() => get<{ today: string; habits: Habit[] }>('/api/habits'));

  const toggle = async (h: Habit) => {
    if (!h.todayInstanceId) return;
    const done = h.todayStatus === 'done';
    try {
      await send('POST', `/api/instances/${h.todayInstanceId}/${done ? 'uncomplete' : 'complete'}`, {});
      await state.reload();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const active = state.data?.habits.filter((h) => !h.ended) ?? [];
  const ended = state.data?.habits.filter((h) => h.ended) ?? [];

  return (
    <>
      <header class="page-head">
        <div>
          <p class="eyebrow">Little and often</p>
          <h1 class="page-title">Habits</h1>
        </div>
        <button type="button" class="btn" onClick={() => setCreating(true)}>
          <Icon name="plus" /> New
        </button>
      </header>
      {state.error && <ErrorBox message={state.error} onRetry={state.reload} />}
      {state.loading && !state.data && <Loading />}
      {state.data && state.data.habits.length === 0 && (
        <Empty title={copy.habits.empty.title} body={copy.habits.empty.body} icon="flame">
          <button type="button" class="btn" onClick={() => setCreating(true)}>
            <Icon name="plus" /> Start a habit
          </button>
        </Empty>
      )}
      {active.length > 0 && <HabitList habits={active} onToggle={toggle} onOpen={setOpen} />}
      {ended.length > 0 && (
        <section class="section">
          <h2 class="section-title">Finished</h2>
          <HabitList habits={ended} readOnly onOpen={setOpen} />
        </section>
      )}
      {state.data && (
        <TodoForm
          open={creating}
          mode="create"
          today={state.data.today}
          defaults={{ category: 'habit', repeat: 'daily' }}
          onClose={() => setCreating(false)}
          onSaved={state.reload}
        />
      )}
      <TodoSheet todoId={open?.todoId ?? null} instanceId={open?.todayInstanceId} onClose={() => setOpen(null)} onChanged={state.reload} />
      <Toasts />
    </>
  );
}
