import { useState } from 'preact/hooks';
import { errorMessage, get, send } from '../lib/api';
import { nameFor } from '../lib/people';
import type { Habit, Me } from '../lib/types';
import { Icon, ProgressBar, Sheet, toast, useLoad } from './ui';

interface Goal {
  id: string;
  title: string;
  targetPerPerson: number;
  mine: boolean;
  people: { userId: string; todoId: string | null; todoTitle: string | null; done: number | null; linked: boolean }[];
}

/** Shared weekly targets ("gym 4 times each"), with progress for both partners. */
export function GoalsPanel({ me, habits }: { me: Me; habits: Habit[] }) {
  const [creating, setCreating] = useState(false);
  const state = useLoad(() => get<{ goals: Goal[] }>('/api/goals'));
  if (!me.partner) return null;
  // Your own (or shared), non-private repeating todos can count towards a goal.
  const linkable = habits.filter((h) => h.canEdit && !h.isPrivate && !h.ended);

  const link = async (goalId: string, todoId: string) => {
    try {
      await send('POST', `/api/goals/${goalId}/link`, { todoId: todoId || null });
      await state.reload();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  return (
    <section class="section">
      <h2 class="section-title">
        <span class="row">
          <Icon name="target" class="inline-icon" /> Goals together
        </span>
        <button type="button" class="btn ghost small" onClick={() => setCreating(true)}>
          <Icon name="plus" /> Goal
        </button>
      </h2>
      {state.data?.goals.length === 0 && <p class="faint">Set a weekly target for both of you, like “gym 4 times each”.</p>}
      <div class="grid-cards">
        {state.data?.goals.map((g) => {
          const mine = g.people.find((p) => p.userId === me.user.id);
          return (
            <article key={g.id} class="card goal">
              <h3 class="row">
                <span class="grow">{g.title}</span>
                <span class="chip">{g.targetPerPerson}× each this week</span>
              </h3>
              {g.people.map((p) => (
                <div key={p.userId} class="goal-row">
                  <span class="goal-who">{p.userId === me.user.id ? 'You' : nameFor(me, p.userId)}</span>
                  <ProgressBar done={Math.min(p.done ?? 0, g.targetPerPerson)} total={g.targetPerPerson} />
                  <span class="faint goal-count">
                    {p.done === null ? (p.linked ? 'hidden' : 'not linked') : `${p.done}/${g.targetPerPerson}`}
                  </span>
                </div>
              ))}
              <label class="label mt-2" for={`gl-${g.id}`}>
                Counts for you
              </label>
              <select id={`gl-${g.id}`} class="select" value={mine?.todoId ?? ''} onChange={(e) => link(g.id, e.currentTarget.value)}>
                <option value="">Pick one of your habits…</option>
                {linkable.map((h) => (
                  <option key={h.todoId} value={h.todoId}>
                    {h.title}
                  </option>
                ))}
              </select>
              {g.mine && (
                <button
                  type="button"
                  class="btn quiet small mt-2"
                  onClick={async () => {
                    if (!confirm(`Remove the goal “${g.title}”?`)) return;
                    await send('DELETE', `/api/goals/${g.id}`).catch((e) => toast(errorMessage(e), 'error'));
                    await state.reload();
                  }}
                >
                  Remove goal
                </button>
              )}
            </article>
          );
        })}
      </div>
      <CreateGoal open={creating} linkable={linkable} onClose={() => setCreating(false)} onDone={state.reload} />
    </section>
  );
}

function CreateGoal({ open, linkable, onClose, onDone }: { open: boolean; linkable: Habit[]; onClose: () => void; onDone: () => void }) {
  const [title, setTitle] = useState('');
  const [target, setTarget] = useState(3);
  const [todoId, setTodoId] = useState('');
  const save = async () => {
    try {
      await send('POST', '/api/goals', { title: title.trim(), targetPerPerson: target, todoId: todoId || null });
      toast('Goal set');
      setTitle('');
      onDone();
      onClose();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="New shared goal"
      footer={
        <>
          <button type="button" class="btn quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="button" class="btn" disabled={!title.trim()} onClick={save}>
            Set goal
          </button>
        </>
      }
    >
      <div class="field">
        <label class="label" for="goal-title">
          Goal
        </label>
        <input id="goal-title" class="input" placeholder="Gym" maxLength={120} value={title} onInput={(e) => setTitle(e.currentTarget.value)} />
      </div>
      <div class="field">
        <label class="label" for="goal-target">
          Times each, per week
        </label>
        <input id="goal-target" class="input" type="number" min={1} max={50} value={target} onInput={(e) => setTarget(Math.max(1, Math.min(50, Number(e.currentTarget.value) || 1)))} />
      </div>
      <div class="field">
        <label class="label" for="goal-todo">
          Which of your habits counts
        </label>
        <select id="goal-todo" class="select" value={todoId} onChange={(e) => setTodoId(e.currentTarget.value)}>
          <option value="">Choose later</option>
          {linkable.map((h) => (
            <option key={h.todoId} value={h.todoId}>
              {h.title}
            </option>
          ))}
        </select>
        <span class="hint">Your partner links their own habit. Private habits can't count, so the numbers never reveal them.</span>
      </div>
    </Sheet>
  );
}
