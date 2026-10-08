import { useEffect, useState } from 'preact/hooks';
import { addDays, minutesBetween, timeBefore } from '../../shared/time';
import { errorMessage, get, send } from '../lib/api';
import type { Category, Project, Recurrence, Todo } from '../lib/types';
import { copy } from '../content/copy';
import { prettyTime } from '../lib/format';
import { PhotoButtons, uploadPhotos } from './PhotoPicker';
import { TimeField } from './TimeField';
import { Sheet, toast } from './ui';
import { useMe } from './useMe';

const WEEKDAYS = [
  [1, 'M', 'Monday'],
  [2, 'T', 'Tuesday'],
  [3, 'W', 'Wednesday'],
  [4, 'T', 'Thursday'],
  [5, 'F', 'Friday'],
  [6, 'S', 'Saturday'],
  [0, 'S', 'Sunday'],
] as const;

// Reminder presets, in minutes before the due time.
const REMIND_PRESETS = [
  [0, 'At due time'],
  [5, '5 min before'],
  [10, '10 min before'],
  [15, '15 min before'],
  [30, '30 min before'],
  [60, '1 hour before'],
  [120, '2 hours before'],
  [180, '3 hours before'],
] as const;
const DEFAULT_REMIND = 60;

/** How the reminder relates to the due time: off, a preset offset, or a time of its own. */
type RemindMode = 'none' | 'custom' | number;

function remindModeFor(dueTime: string, reminderTime: string): RemindMode {
  if (!reminderTime) return 'none';
  if (!dueTime) return 'custom';
  const gap = minutesBetween(reminderTime, dueTime);
  return REMIND_PRESETS.some(([m]) => m === gap) ? gap : 'custom';
}

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
  isShared: boolean;
  assignee: 'me' | 'partner' | 'either';
  isJoint: boolean;
  priority: number;
  deadlineDate: string;
  deadlineTime: string;
}

export type TodoFormDefaults = Partial<FormState>;

function initialState(today: string, todo?: Todo, defaults?: Partial<FormState>, meId?: string): FormState {
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
    isShared: todo?.isShared ?? false,
    isJoint: todo?.isJoint ?? false,
    priority: todo?.priority ?? 2,
    deadlineDate: todo?.deadline?.date ?? '',
    deadlineTime: todo?.deadline?.time ?? '',
    assignee: !todo?.assignedTo ? 'either' : todo.assignedTo === meId ? 'me' : 'partner',
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
  const me = useMe();
  const [s, setS] = useState<FormState>(() => initialState(props.today, props.todo, props.defaults));
  const [remind, setRemind] = useState<RemindMode>(() => remindModeFor(s.dueTime, s.reminderTime));
  const [projects, setProjects] = useState<Project[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) return;
    const next = initialState(props.today, props.todo, props.defaults, me?.user.id);
    setS(next);
    setRemind(remindModeFor(next.dueTime, next.reminderTime));
    setFiles([]);
    setError(null);
    if (props.mode !== 'suggest') {
      get<{ projects: Project[] }>('/api/projects').then((r) => setProjects(r.projects), () => undefined);
    }
  }, [props.open, props.todo?.id, me?.user.id]);

  // On a partner's shared todo you can edit the details, not where it lives or who sees it.
  const ownerEditing = props.mode !== 'edit' || !props.todo || !me || props.todo.ownerId === me.user.id;
  const project = projects.find((p) => p.id === s.projectId);
  const sharedNow = s.isShared || !!project?.isShared;

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setS((prev) => ({ ...prev, [k]: v }));

  // A preset reminder follows the due time. Setting a due time for the first time turns on the default reminder.
  const setDue = (dueTime: string) => {
    let mode = remind;
    if (dueTime && !s.dueTime && mode === 'none' && !s.reminderTime) mode = DEFAULT_REMIND;
    if (!dueTime && typeof mode === 'number') mode = 'custom';
    let reminderTime = s.reminderTime;
    if (dueTime && typeof mode === 'number') {
      // Too early in the day for this offset? Use the largest preset that still fits.
      const fits = REMIND_PRESETS.filter(([m]) => m <= (mode as number) && timeBefore(dueTime, m) !== null);
      mode = fits[fits.length - 1]![0];
      reminderTime = timeBefore(dueTime, mode)!;
    }
    setRemind(mode);
    setS((prev) => ({ ...prev, dueTime, reminderTime }));
  };

  const chooseRemind = (value: string) => {
    if (value === 'none') {
      setRemind('none');
      set('reminderTime', '');
    } else if (value === 'custom') {
      setRemind('custom');
      if (!s.reminderTime && s.dueTime) set('reminderTime', timeBefore(s.dueTime, DEFAULT_REMIND) ?? s.dueTime);
    } else {
      const m = Number(value);
      setRemind(m);
      set('reminderTime', timeBefore(s.dueTime, m) ?? s.dueTime);
    }
  };

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
    // Priority and deadline belong to your own todos (suggestions keep the original fields).
    const planning = {
      priority: s.priority,
      deadlineDate: s.deadlineDate || null,
      deadlineTime: s.deadlineDate && s.deadlineTime ? s.deadlineTime : null,
    };
    try {
      if (props.mode === 'suggest') {
        const { id } = await send<{ id: string }>('POST', '/api/suggestions', common);
        if (files.length) await uploadPhotos(files, { suggestionId: id });
        toast(`Suggested to ${props.partnerName ?? 'your partner'}`);
      } else if (props.mode === 'create') {
        const { todo } = await send<{ todo: Todo }>('POST', '/api/todos', {
          ...common,
          ...planning,
          projectId: s.projectId || null,
          isPrivate: sharedNow ? false : s.isPrivate,
          isShared: s.isShared,
          assignee: s.assignee,
          isJoint: sharedNow && s.repeat !== 'none' && s.isJoint,
        });
        if (files.length) await uploadPhotos(files, { todoId: todo.id });
        toast('Added');
      } else if (props.todo) {
        await send(
          'PATCH',
          `/api/todos/${props.todo.id}`,
          ownerEditing
            ? {
                ...common,
                ...planning,
                projectId: s.projectId || null,
                isPrivate: sharedNow ? false : s.isPrivate,
                isShared: s.isShared,
                assignee: s.assignee,
                isJoint: sharedNow && s.repeat !== 'none' && s.isJoint,
              }
            : { ...common, ...planning, ...(sharedNow ? { assignee: s.assignee } : {}) },
        );
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

        {props.mode !== 'suggest' && ownerEditing && (
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
            <TimeField id="tf-due" value={s.dueTime} onChange={setDue} placeholder="No due time" />
          </div>
          <div class="field">
            <label class="label" for="tf-remind">
              Remind me
            </label>
            <select id="tf-remind" class="select" value={String(remind)} onChange={(e) => chooseRemind(e.currentTarget.value)}>
              <option value="none">No reminder</option>
              {s.dueTime &&
                REMIND_PRESETS.map(([m, l]) => (
                  <option key={m} value={String(m)} disabled={timeBefore(s.dueTime, m) === null}>
                    {l}
                  </option>
                ))}
              <option value="custom">Pick a time…</option>
            </select>
            {remind === 'custom' && (
              <TimeField
                id="tf-remind-at"
                value={s.reminderTime}
                onChange={(v) => {
                  set('reminderTime', v);
                  if (!v) setRemind('none');
                }}
                placeholder="Pick a time"
              />
            )}
            {typeof remind === 'number' && s.reminderTime && <span class="hint">At {prettyTime(s.reminderTime)}</span>}
          </div>
        </div>

        {props.mode !== 'suggest' && (
          <>
            <fieldset class="segmented mt-4">
              <legend>Priority</legend>
              {(
                [
                  [1, 'Low'],
                  [2, 'Medium'],
                  [3, 'High'],
                  [4, 'Urgent'],
                ] as const
              ).map(([v, l]) => (
                <label key={v}>
                  <input type="radio" name="tf-priority" checked={s.priority === v} onChange={() => set('priority', v)} />
                  <span class={`prio-opt prio-opt-${v}`}>{l}</span>
                </label>
              ))}
            </fieldset>
            <div class="field-row mt-4">
              <div class="field">
                <label class="label" for="tf-deadline">
                  Deadline <span class="faint">(must be done by)</span>
                </label>
                <input
                  id="tf-deadline"
                  class="input"
                  type="date"
                  value={s.deadlineDate}
                  onInput={(e) => set('deadlineDate', e.currentTarget.value)}
                />
              </div>
              <div class="field">
                <label class="label" for="tf-deadline-time">
                  By <span class="faint">(optional)</span>
                </label>
                <TimeField
                  id="tf-deadline-time"
                  value={s.deadlineTime}
                  onChange={(v: string) => set('deadlineTime', v)}
                  placeholder={s.deadlineDate ? 'Any time' : 'Pick a date first'}
                />
              </div>
            </div>
            {s.deadlineDate && (
              <button type="button" class="btn quiet small" onClick={() => setS((p) => ({ ...p, deadlineDate: '', deadlineTime: '' }))}>
                Clear deadline
              </button>
            )}
          </>
        )}

        <div class="field">
          <label class="label" for="tf-notes">
            Notes
          </label>
          <textarea id="tf-notes" class="textarea" maxLength={5000} value={s.notes} onInput={(e) => set('notes', e.currentTarget.value)} />
        </div>

        {props.mode !== 'suggest' && ownerEditing && me?.partner && !project?.isShared && (
          <label class="switch mt-4">
            <span>
              <strong>Shared with {me.partner.name.split(' ')[0]}</strong>
              <span class="hint">You both see it, either of you can tick it off.</span>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={s.isShared}
              onChange={(e) => setS((prev) => ({ ...prev, isShared: e.currentTarget.checked, isPrivate: e.currentTarget.checked ? false : prev.isPrivate }))}
            />
          </label>
        )}

        {props.mode !== 'suggest' && sharedNow && me?.partner && s.repeat !== 'none' && ownerEditing && (
          <label class="switch mt-4">
            <span>
              <strong>Do it together</strong>
              <span class="hint">A joint habit only counts for the day when you both tick it off.</span>
            </span>
            <input type="checkbox" role="switch" checked={s.isJoint} onChange={(e) => set('isJoint', e.currentTarget.checked)} />
          </label>
        )}

        {props.mode !== 'suggest' && sharedNow && me?.partner && !(s.isJoint && s.repeat !== 'none') && (
          <fieldset class="segmented mt-4">
            <legend>Who's on it</legend>
            {(
              [
                ['me', 'Me'],
                ['partner', me.partner.name.split(' ')[0] ?? 'Partner'],
                ['either', 'Either of us'],
              ] as const
            ).map(([v, l]) => (
              <label key={v}>
                <input type="radio" name="tf-assignee" checked={s.assignee === v} onChange={() => set('assignee', v)} />
                <span>{l}</span>
              </label>
            ))}
          </fieldset>
        )}

        {props.mode !== 'suggest' && ownerEditing && !sharedNow && (
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
