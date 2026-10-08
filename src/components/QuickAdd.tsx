import { useEffect, useMemo, useState } from 'preact/hooks';
import { parseQuickAdd } from '../../shared/quickadd';
import { describeRule } from '../../shared/recurrence';
import { errorMessage, get, send } from '../lib/api';
import { prettyTime, relativeDay } from '../lib/format';
import type { Project } from '../lib/types';
import { TodoForm, type TodoFormDefaults } from './TodoForm';
import { Icon, toast } from './ui';
import { useMe } from './useMe';

const PRIORITY_LABEL: Record<number, string> = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' };

/**
 * One-line natural-language add: "gym every mon wed fri 7am #health". Shows what it understood
 * before saving, and hands over to the full form when you want more.
 */
export function QuickAdd({ today, onSaved }: { today: string; onSaved: () => void }) {
  const me = useMe();
  const [text, setText] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [busy, setBusy] = useState(false);
  const [full, setFull] = useState<TodoFormDefaults | null>(null);
  const [fullMode, setFullMode] = useState<'create' | 'suggest'>('create');

  useEffect(() => {
    get<{ projects: Project[] }>('/api/projects').then((r) => setProjects(r.projects), () => undefined);
  }, []);

  const parsed = useMemo(() => (text.trim() ? parseQuickAdd(text, today) : null), [text, today]);
  // "#side-project" matches "Side project", then "Side project 2", then "CoWork (side project)".
  const wanted = parsed?.projectName?.toLowerCase();
  const project = wanted
    ? projects.find((p) => p.name.toLowerCase() === wanted) ??
      projects.find((p) => p.name.toLowerCase().startsWith(wanted)) ??
      projects.find((p) => p.name.toLowerCase().includes(wanted))
    : undefined;
  const forPartner = !!parsed?.forPartner && !!me?.partner;

  const draft = () => {
    if (!parsed) return null;
    const r = parsed.recurrence;
    return {
      title: parsed.title,
      notes: '',
      category: parsed.category ?? project?.category ?? 'personal',
      startDate: parsed.startDate ?? today,
      endDate: null,
      dueTime: parsed.dueTime,
      reminderTime: parsed.reminderTime,
      recurrence: r,
    };
  };

  const save = async (e?: Event) => {
    e?.preventDefault();
    const d = draft();
    if (!d) return;
    if (!d.title) return toast('Add a title, e.g. “call mum tomorrow 6pm”', 'error');
    setBusy(true);
    try {
      if (forPartner) {
        await send('POST', '/api/suggestions', d);
        toast(`Suggested to ${me!.partner!.name.split(' ')[0]}`);
      } else {
        await send('POST', '/api/todos', { ...d, projectId: project?.id ?? null, ...(parsed?.priority ? { priority: parsed.priority } : {}) });
        toast('Added');
      }
      setText('');
      onSaved();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const openFull = () => {
    const d = draft();
    const r = d?.recurrence;
    setFullMode(forPartner ? 'suggest' : 'create');
    setFull({
      title: d?.title ?? text,
      category: d?.category,
      startDate: d?.startDate,
      dueTime: d?.dueTime ?? '',
      reminderTime: d?.reminderTime ?? '',
      repeat: r?.type ?? 'none',
      ...(r?.type === 'weekly' ? { weekdays: r.weekdays } : {}),
      ...(r?.type === 'monthly' ? { monthDay: r.monthDay } : {}),
      projectId: project?.id ?? '',
      ...(parsed?.priority ? { priority: parsed.priority } : {}),
    });
  };

  return (
    <div class="quickadd">
      <form class="quickadd-row" onSubmit={save}>
        <Icon name="bolt" class="quickadd-icon" />
        <label class="sr-only" for="quickadd">
          Quick add
        </label>
        <input
          id="quickadd"
          class="quickadd-input"
          placeholder="Quick add: “gym mon wed fri 7am #health”"
          autoComplete="off"
          enterKeyHint="done"
          value={text}
          onInput={(e) => setText(e.currentTarget.value)}
        />
        {text && (
          <button type="submit" class="btn" disabled={busy}>
            {forPartner ? 'Suggest' : 'Add'}
          </button>
        )}
      </form>
      {parsed && (
        <div class="quickadd-preview" aria-live="polite">
          <span class="chip ink">{parsed.title || 'No title yet'}</span>
          <span class="chip">{relativeDay(parsed.startDate ?? today, today)}</span>
          {parsed.dueTime && <span class="chip">{prettyTime(parsed.dueTime)}</span>}
          {parsed.reminderTime && (
            <span class="chip">
              <Icon name="bell" />
              {prettyTime(parsed.reminderTime)}
            </span>
          )}
          {parsed.recurrence.type !== 'none' && (
            <span class="chip sky">
              <Icon name="repeat" />
              {describeRule(parsed.recurrence)}
            </span>
          )}
          {parsed.projectName && (
            <span class={`chip ${project ? '' : 'missed'}`}>
              {project ? (
                <>
                  <i class="dot" data-color={project.color} aria-hidden="true" /> {project.name}
                </>
              ) : (
                `#${parsed.projectName}? no such project`
              )}
            </span>
          )}
          {parsed.category && <span class="chip">{parsed.category}</span>}
          {parsed.priority && !forPartner && (
            <span class={`chip prio-chip prio-${parsed.priority}`}>{PRIORITY_LABEL[parsed.priority]} priority</span>
          )}
          {parsed.forPartner && <span class={`chip ${forPartner ? 'plum' : 'missed'}`}>{forPartner ? `Suggestion for ${me!.partner!.name.split(' ')[0]}` : 'Pair up to suggest'}</span>}
          <button type="button" class="btn quiet small" onClick={openFull}>
            More options
          </button>
        </div>
      )}
      <TodoForm
        open={!!full}
        mode={fullMode}
        today={today}
        defaults={full ?? undefined}
        partnerName={me?.partner?.name.split(' ')[0]}
        onClose={() => setFull(null)}
        onSaved={() => {
          setText('');
          onSaved();
        }}
      />
    </div>
  );
}
