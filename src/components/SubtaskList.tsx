import { useEffect, useState } from 'preact/hooks';
import { errorMessage, get, send } from '../lib/api';
import { Icon, toast } from './ui';

interface Subtask {
  id: string;
  title: string;
  position: number;
  done: boolean;
}

/**
 * Checklist for a todo. Items belong to the todo; ticks belong to one occurrence (`instanceId`),
 * so a repeating todo starts each day with a fresh list.
 */
export function SubtaskList({ todoId, instanceId, canEdit, onChanged }: { todoId: string; instanceId: string | null; canEdit: boolean; onChanged?: () => void }) {
  const [items, setItems] = useState<Subtask[] | null>(null);
  const [title, setTitle] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const load = () =>
    get<{ subtasks: Subtask[] }>(`/api/todos/${todoId}/subtasks${instanceId ? `?instanceId=${instanceId}` : ''}`).then(
      (r) => setItems(r.subtasks),
      () => setItems([]),
    );
  useEffect(() => {
    void load();
  }, [todoId, instanceId]);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load();
      onChanged?.();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const add = (e: Event) => {
    e.preventDefault();
    if (!title.trim()) return;
    void run(async () => {
      await send('POST', `/api/todos/${todoId}/subtasks`, { title: title.trim() });
      setTitle('');
    });
  };

  const toggle = (s: Subtask) => {
    if (!instanceId) return;
    setItems((list) => list && list.map((x) => (x.id === s.id ? { ...x, done: !x.done } : x)));
    void run(() => send('POST', `/api/subtasks/${s.id}/check`, { instanceId, done: !s.done }));
  };

  const move = (index: number, dir: -1 | 1) => {
    if (!items) return;
    const next = [...items];
    const [it] = next.splice(index, 1);
    next.splice(index + dir, 0, it!);
    setItems(next);
    void run(() => send('POST', `/api/todos/${todoId}/subtasks/order`, { ids: next.map((x) => x.id) }));
  };

  if (items === null) return null;
  if (!items.length && !canEdit) return null;
  const done = items.filter((s) => s.done).length;

  return (
    <section class="section">
      <h3 class="section-title">
        Checklist {items.length > 0 && <small>{done}/{items.length}</small>}
      </h3>
      <ul class="subtasks">
        {items.map((s, i) => (
          <li key={s.id} class={`subtask ${s.done ? 'done' : ''}`}>
            <input
              type="checkbox"
              id={`st-${s.id}`}
              checked={s.done}
              disabled={!canEdit || !instanceId}
              onChange={() => toggle(s)}
              title={instanceId ? undefined : 'Open a specific day to tick items off'}
            />
            {editing === s.id ? (
              <form
                class="grow row"
                onSubmit={(e) => {
                  e.preventDefault();
                  setEditing(null);
                  if (draft.trim() && draft.trim() !== s.title) void run(() => send('PATCH', `/api/subtasks/${s.id}`, { title: draft.trim() }));
                }}
              >
                <input class="input grow" value={draft} maxLength={200} onInput={(e) => setDraft(e.currentTarget.value)} autoFocus />
                <button type="submit" class="btn small">
                  Save
                </button>
              </form>
            ) : (
              <label for={`st-${s.id}`} class="grow">
                {s.title}
              </label>
            )}
            {canEdit && editing !== s.id && (
              <span class="subtask-actions">
                <button type="button" class="icon-btn small" disabled={i === 0} onClick={() => move(i, -1)}>
                  <Icon name="left" label={`Move “${s.title}” up`} class="rot90" />
                </button>
                <button type="button" class="icon-btn small" disabled={i === items.length - 1} onClick={() => move(i, 1)}>
                  <Icon name="right" label={`Move “${s.title}” down`} class="rot90" />
                </button>
                <button
                  type="button"
                  class="icon-btn small"
                  onClick={() => {
                    setEditing(s.id);
                    setDraft(s.title);
                  }}
                >
                  <Icon name="edit" label={`Rename “${s.title}”`} />
                </button>
                <button type="button" class="icon-btn small" onClick={() => run(() => send('DELETE', `/api/subtasks/${s.id}`))}>
                  <Icon name="trash" label={`Delete “${s.title}”`} />
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {canEdit && (
        <form class="comment-form mt-2" onSubmit={add}>
          <label class="sr-only" for={`new-st-${todoId}`}>
            Add a checklist item
          </label>
          <input id={`new-st-${todoId}`} class="input grow" placeholder="Add a step…" maxLength={200} value={title} onInput={(e) => setTitle(e.currentTarget.value)} />
          <button type="submit" class="btn ghost" disabled={!title.trim()}>
            Add
          </button>
        </form>
      )}
    </section>
  );
}
