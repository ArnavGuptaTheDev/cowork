import { useEffect, useState } from 'preact/hooks';
import { addDays } from '../../shared/time';
import { errorMessage, get, send } from '../lib/api';
import type { Category, Project, Recurrence, Todo } from '../lib/types';
import { copy } from '../content/copy';
import { PhotoButtons, uploadPhotos } from './PhotoPicker';
import { Sheet, toast } from './ui';

const WEEKDAYS = [
  [1, 'M', 'Monday'],
  [2, 'T', 'Tuesday'],
  [3, 'W', 'Wednesday'],
  [4, 'T', 'Thursday'],
  [5, 'F', 'Friday'],
  [6, 'S', 'Saturday'],
  [0, 'S', 'Sunday'],
] as const;

type Mode = 'create' | 'edit' | 'suggest';

interface FormState {
  title: string;
  notes: string;
  category: Category;
  projectId: string;
  startDate: string;
  endDate: string;
  dueTime: string;
  reminderTime: string;
  repeat: Recurrence['type'];
  weekdays: number[];
  monthDay: number;
  isPrivate: boolean;
}

function initialState(today: string, todo?: Todo, defaults?: Partial<FormState>): FormState {
  const r = todo?.recurrence;
  return {
    title: todo?.title ?? '',
    notes: todo?.notes ?? '',
    category: todo?.category ?? 'personal',
    projectId: todo?.projectId ?? '',
    startDate: todo?.startDate ?? today,
    endDate: todo?.endDate ?? '',
    dueTime: todo?.dueTime ?? '',
    reminderTime: todo?.reminderTime ?? '',
    repeat: r?.type ?? 'none',
    weekdays: r?.type === 'weekly' ? r.weekdays : [Number(new Date(`${today}T12:00:00Z`).getUTCDay())],
    monthDay: r?.type === 'monthly' ? r.monthDay : Number(today.slice(8, 10)),
    isPrivate: todo?.isPrivate ?? false,
    ...defaults,
  };
}

function toRecurrence(s: FormState): Recurrence {
  switch (s.repeat) {
    case 'daily':
      return { type: 'daily' };
    case 'weekly':
      return { type: 'weekly', weekdays: s.weekdays };
    case 'monthly':
      return { type: 'monthly', monthDay: s.monthDay };
    default:
      return { type: 'none' };
  }
}

export function TodoForm(props: {
  open: boolean;
  mode: Mode;
  today: string;
  todo?: Todo;
  defaults?: Partial<FormState>;
  partnerName?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [s, setS] = useState<FormState>(() => initialState(props.today, props.todo, props.defaults));
  const [projects, setProjects] = useState<Project[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) return;
    setS(initialState(props.today, props.todo, props.defaults));
    setFiles([]);
    setError(null);
    if (props.mode !== 'suggest') {
      get<{ projects: Project[] }>('/api/projects').then((r) => setProjects(r.projects), () => undefined);
    }
  }, [props.open, props.todo?.id]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setS((prev) => ({ ...prev, [k]: v }));

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!s.title.trim()) return setError('Give it a title');
    if (s.repeat === 'weekly' && s.weekdays.length === 0) return setError('Pick at least one weekday');
    setBusy(true);
    setError(null);
    const recurring = s.repeat !== 'none';
    const common = {
      title: s.title.trim(),
      notes: s.notes,
      category: s.category,
      startDate: s.startDate,
      endDate: recurring && s.endDate ? s.endDate : null,
      dueTime: s.dueTime || null,
      reminderTime: s.reminderTime || null,
      recurrence: toRecurrence(s),
    };
    try {
      if (props.mode === 'suggest') {
        const { id } = await send<{ id: string }>('POST', '/api/suggestions', common);
        if (files.length) await uploadPhotos(files, { suggestionId: id });
        toast(`Suggested to ${props.partnerName ?? 'your partner'}`);
      } else if (props.mode === 'create') {
        const { todo } = await send<{ todo: Todo }>('POST', '/api/todos', {
          ...common,
          projectId: s.projectId || null,
          isPrivate: s.isPrivate,
        });
        if (files.length) await uploadPhotos(files, { todoId: todo.id });
        toast('Added');
      } else if (props.todo) {
        await send('PATCH', `/api/todos/${props.todo.id}`, { ...common, projectId: s.projectId || null, isPrivate: s.isPrivate });
        toast('Saved');
      }
      props.onSaved();
      props.onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const title = props.mode === 'edit' ? 'Edit todo' : props.mode === 'suggest' ? `Suggest to ${props.partnerName ?? 'partner'}` : 'New todo';
  const recurring = s.repeat !== 'none';

  return (
    <Sheet
      open={props.open}
      onClose={props.onClose}
      title={title}
      footer={
        <>
          <button type="button" class="btn quiet" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" form="todo-form" class={`btn ${props.mode === 'suggest' ? 'plum' : ''}`} disabled={busy}>
            {busy ? 'Saving…' : props.mode === 'suggest' ? 'Send suggestion' : props.mode === 'edit' ? 'Save' : 'Add todo'}
          </button>
        </>
      }
    >
      <form id="todo-form" onSubmit={submit} noValidate>
        <div class="field">
          <label class="sr-only" for="tf-title">
            Title
          </label>
          <input
            id="tf-title"
            class="input big"
            placeholder="What needs doing?"
            value={s.title}
            maxLength={200}
            onInput={(e) => set('title', e.currentTarget.value)}
            autoFocus
            required
          />
        </div>

        <fieldset class="segmented mt-4">
          <legend>Category</legend>
          {(['personal', 'work', 'habit'] as const).map((c) => (
            <label key={c}>
              <input type="radio" name="tf-cat" checked={s.category === c} onChange={() => set('category', c)} />
              <span>{c[0]!.toUpperCase() + c.slice(1)}</span>
            </label>
          ))}
        </fieldset>

        {props.mode !== 'suggest' && (
          <div class="field mt-4">
            <label class="label" for="tf-project">
              Project
            </label>
            <select id="tf-project" class="select" value={s.projectId} onChange={(e) => set('projectId', e.currentTarget.value)}>
              <option value="">No project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <fieldset class="segmented mt-4">
          <legend>Repeat</legend>
          {(
            [
              ['none', 'Once'],
              ['daily', 'Daily'],
              ['weekly', 'Weekly'],
              ['monthly', 'Monthly'],
            ] as const
          ).map(([v, l]) => (
            <label key={v}>
              <input type="radio" name="tf-repeat" checked={s.repeat === v} onChange={() => set('repeat', v)} />
              <span>{l}</span>
            </label>
          ))}
        </fieldset>

        {s.repeat === 'weekly' && (
          <fieldset class="segmented days mt-4">
            <legend>On these days</legend>
            {WEEKDAYS.map(([n, short, long]) => (
              <label key={n}>
                <input
                  type="checkbox"
                  aria-label={long}
                  checked={s.weekdays.includes(n)}
                  onChange={(e) =>
                    set('weekdays', e.currentTarget.checked ? [...s.weekdays, n] : s.weekdays.filter((d) => d !== n))
                  }
                />
                <span aria-hidden="true">{short}</span>
              </label>
            ))}
          </fieldset>
        )}

        {s.repeat === 'monthly' && (
          <div class="field mt-4">
            <label class="label" for="tf-mday">
              Day of the month
            </label>
            <input
              id="tf-mday"
              class="input"
              type="number"
              min={1}
              max={31}
              inputMode="numeric"
              value={s.monthDay}
              onInput={(e) => set('monthDay', Math.min(31, Math.max(1, Number(e.currentTarget.value) || 1)))}
            />
            <span class="hint">In shorter months, 29–31 fall on the last day.</span>
          </div>
        )}

        <div class="field-row mt-4">
          <div class="field">
            <label class="label" for="tf-start">
              {recurring ? 'Starts' : 'Day'}
            </label>
            <input id="tf-start" class="input" type="date" value={s.startDate} onInput={(e) => set('startDate', e.currentTarget.value)} required />
          </div>
          {recurring ? (
            <div class="field">
              <label class="label" for="tf-end">
                Ends <span class="faint">(optional)</span>
              </label>
              <input id="tf-end" class="input" type="date" min={s.startDate} value={s.endDate} onInput={(e) => set('endDate', e.currentTarget.value)} />
            </div>
          ) : (
            <div class="field">
              <span class="label" aria-hidden="true">
                &nbsp;
              </span>
              <button type="button" class="btn ghost" onClick={() => set('startDate', addDays(props.today, 1))}>
                Tomorrow
              </button>
            </div>
          )}
        </div>

        <div class="field-row">
          <div class="field">
            <label class="label" for="tf-due">
              Due at
            </label>
            <input id="tf-due" class="input" type="time" value={s.dueTime} onInput={(e) => set('dueTime', e.currentTarget.value)} />
          </div>
          <div class="field">
            <label class="label" for="tf-remind">
              Remind me
            </label>
            <input id="tf-remind" class="input" type="time" value={s.reminderTime} onInput={(e) => set('reminderTime', e.currentTarget.value)} />
          </div>
        </div>

        <div class="field">
          <label class="label" for="tf-notes">
            Notes
          </label>
          <textarea id="tf-notes" class="textarea" maxLength={5000} value={s.notes} onInput={(e) => set('notes', e.currentTarget.value)} />
        </div>

        {props.mode !== 'suggest' && (
          <label class="switch mt-4">
            <span>
              <strong>Private</strong>
              <span class="hint">{copy.privateHint}</span>
            </span>
            <input type="checkbox" role="switch" checked={s.isPrivate} onChange={(e) => set('isPrivate', e.currentTarget.checked)} />
          </label>
        )}

        {props.mode !== 'edit' && (
          <div class="field mt-4">
            <span class="label">Photos</span>
            <PhotoButtons onFiles={(f) => setFiles((prev) => [...prev, ...f].slice(0, 12))} />
            {files.length > 0 && (
              <span class="hint">
                {files.length} photo{files.length > 1 ? 's' : ''} will be resized and attached.{' '}
                <button type="button" class="btn quiet" onClick={() => setFiles([])}>
                  Clear
                </button>
              </span>
            )}
          </div>
        )}

        {error && (
          <p class="error-text mt-4" role="alert">
            {error}
          </p>
        )}
      </form>
    </Sheet>
  );
}
