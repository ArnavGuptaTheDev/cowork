import { useEffect, useState } from 'preact/hooks';
import { PROJECT_COLORS } from '../../shared/constants';
import { errorMessage, send } from '../lib/api';
import type { Category, Project } from '../lib/types';
import { TimeField } from './TimeField';
import { Sheet, toast } from './ui';
import { useMe } from './useMe';

export function ProjectForm(props: { open: boolean; project?: Project; onClose: () => void; onSaved: (p: Project) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<Category>('work');
  const [color, setColor] = useState<string>('clay');
  const [isPrivate, setPrivate] = useState(false);
  const [isShared, setShared] = useState(false);
  const [deadlineDate, setDeadlineDate] = useState('');
  const [deadlineTime, setDeadlineTime] = useState('');
  const me = useMe();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) return;
    setName(props.project?.name ?? '');
    setDescription(props.project?.description ?? '');
    setCategory(props.project?.category ?? 'work');
    setColor(props.project?.color ?? 'clay');
    setPrivate(props.project?.isPrivate ?? false);
    setShared(props.project?.isShared ?? false);
    setDeadlineDate(props.project?.deadline?.date ?? '');
    setDeadlineTime(props.project?.deadline?.time ?? '');
    setError(null);
  }, [props.open]);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!name.trim()) return setError('Give it a name');
    setBusy(true);
    try {
      const body = {
        name: name.trim(),
        description,
        category,
        color,
        isPrivate: isShared ? false : isPrivate,
        isShared,
        deadlineDate: deadlineDate || null,
        deadlineTime: deadlineDate && deadlineTime ? deadlineTime : null,
      };
      const { project } = props.project
        ? await send<{ project: Project }>('PATCH', `/api/projects/${props.project.id}`, body)
        : await send<{ project: Project }>('POST', '/api/projects', body);
      toast(props.project ? 'Project saved' : 'Project created');
      props.onSaved(project);
      props.onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={props.open}
      onClose={props.onClose}
      title={props.project ? 'Edit project' : 'New project'}
      footer={
        <>
          <button type="button" class="btn quiet" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" form="project-form" class="btn" disabled={busy}>
            {busy ? 'Saving…' : props.project ? 'Save' : 'Create'}
          </button>
        </>
      }
    >
      <form id="project-form" onSubmit={submit} noValidate>
        <div class="field">
          <label class="sr-only" for="pf-name">
            Name
          </label>
          <input id="pf-name" class="input big" placeholder="Project name" value={name} maxLength={120} onInput={(e) => setName(e.currentTarget.value)} autoFocus />
        </div>
        <fieldset class="segmented mt-4">
          <legend>Category</legend>
          {(['personal', 'work', 'habit'] as const).map((c) => (
            <label key={c}>
              <input type="radio" name="pf-cat" checked={category === c} onChange={() => setCategory(c)} />
              <span>{c[0]!.toUpperCase() + c.slice(1)}</span>
            </label>
          ))}
        </fieldset>
        <fieldset class="swatches mt-4">
          <legend class="label">Colour</legend>
          {PROJECT_COLORS.map((c) => (
            <label key={c}>
              <input type="radio" name="pf-color" aria-label={c} checked={color === c} onChange={() => setColor(c)} />
              <i class="dot" data-color={c} />
            </label>
          ))}
        </fieldset>
        <div class="field-row mt-4">
          <div class="field">
            <label class="label" for="pf-deadline">
              Deadline
            </label>
            <input id="pf-deadline" class="input" type="date" value={deadlineDate} onInput={(e) => setDeadlineDate(e.currentTarget.value)} />
          </div>
          <div class="field">
            <label class="label" for="pf-deadline-time">
              By <span class="faint">(optional)</span>
            </label>
            <TimeField id="pf-deadline-time" value={deadlineTime} onChange={setDeadlineTime} placeholder="Any time" />
          </div>
        </div>
        <div class="field mt-4">
          <label class="label" for="pf-desc">
            Description
          </label>
          <textarea id="pf-desc" class="textarea" maxLength={2000} value={description} onInput={(e) => setDescription(e.currentTarget.value)} />
        </div>
        {me?.partner && (
          <label class="switch mt-4">
            <span>
              <strong>Shared with {me.partner.name.split(' ')[0]}</strong>
              <span class="hint">You both see it and can add, edit and tick off its todos.</span>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={isShared}
              onChange={(e) => {
                setShared(e.currentTarget.checked);
                if (e.currentTarget.checked) setPrivate(false);
              }}
            />
          </label>
        )}
        {!isShared && (
          <label class="switch mt-4">
            <span>
              <strong>Private project</strong>
              <span class="hint">Hides the project and every todo in it from your partner.</span>
            </span>
            <input type="checkbox" role="switch" checked={isPrivate} onChange={(e) => setPrivate(e.currentTarget.checked)} />
          </label>
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
