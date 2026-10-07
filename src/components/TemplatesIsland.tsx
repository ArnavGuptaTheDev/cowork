import { useEffect, useState } from 'preact/hooks';
import { describeRule } from '../../shared/recurrence';
import { errorMessage, get, getMe, send } from '../lib/api';
import type { Me, Project, Recurrence } from '../lib/types';
import { Empty, ErrorBox, Icon, Loading, Sheet, Toasts, toast, useLoad } from './ui';

interface TemplateItem {
  id: string;
  title: string;
  category: string;
  dueTime: string | null;
  recurrence: Recurrence;
  subtasks: string[];
  isPrivate: boolean;
}
interface Template {
  id: string;
  name: string;
  isShared: boolean;
  mine: boolean;
  items: TemplateItem[];
}
interface PickTodo {
  id: string;
  title: string;
  recurrence: Recurrence;
  isPrivate: boolean;
  projectName: string | null;
}

export default function TemplatesIsland() {
  const [creating, setCreating] = useState(false);
  const [applying, setApplying] = useState<Template | null>(null);
  const state = useLoad(async () => {
    const [me, t] = await Promise.all([getMe(), get<{ templates: Template[] }>('/api/templates')]);
    return { me, templates: t.templates };
  });

  if (state.loading && !state.data) return <Loading />;
  if (state.error || !state.data) return <ErrorBox message={state.error ?? 'Could not load'} onRetry={state.reload} />;
  const { me, templates } = state.data;

  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast(msg);
      await state.reload();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  return (
    <>
      <header class="page-head">
        <div>
          <p class="eyebrow">Reuse</p>
          <h1 class="page-title">Templates</h1>
          <p class="lede">Save a set of todos (with checklists and repeats) and add them again in one tap.</p>
        </div>
        <button type="button" class="btn" onClick={() => setCreating(true)}>
          <Icon name="plus" /> New
        </button>
      </header>

      {templates.length === 0 ? (
        <Empty title="No templates yet" body="Try one for a launch checklist, a trip, or your weekly routine." icon="grid">
          <button type="button" class="btn" onClick={() => setCreating(true)}>
            <Icon name="plus" /> Make a template
          </button>
        </Empty>
      ) : (
        <div class="grid-cards">
          {templates.map((t) => (
            <article key={t.id} class="card template">
              <h2 class="section-title">
                <span class="grow">{t.name}</span>
                {t.isShared && <span class="chip plum">{t.mine ? 'Shared' : `From ${me.partner?.name.split(' ')[0] ?? 'partner'}`}</span>}
              </h2>
              <ul class="list-plain template-items">
                {t.items.map((i) => (
                  <li key={i.id}>
                    <strong>{i.title}</strong>
                    <span class="faint">
                      {i.recurrence.type !== 'none' ? ` · ${describeRule(i.recurrence)}` : ''}
                      {i.subtasks.length ? ` · ${i.subtasks.length} steps` : ''}
                      {i.isPrivate ? ' · private' : ''}
                    </span>
                  </li>
                ))}
              </ul>
              <div class="row mt-2">
                <button type="button" class="btn" onClick={() => setApplying(t)}>
                  Use
                </button>
                {t.mine && (
                  <>
                    {me.partner && (
                      <button type="button" class="btn ghost small" onClick={() => act(() => send('PATCH', `/api/templates/${t.id}`, { isShared: !t.isShared }), t.isShared ? 'No longer shared' : 'Shared')}>
                        {t.isShared ? 'Unshare' : 'Share'}
                      </button>
                    )}
                    <button
                      type="button"
                      class="btn quiet small"
                      onClick={() => {
                        const name = prompt('Rename template', t.name);
                        if (name && name.trim()) void act(() => send('PATCH', `/api/templates/${t.id}`, { name: name.trim() }), 'Renamed');
                      }}
                    >
                      Rename
                    </button>
                    <span class="spacer" />
                    <button
                      type="button"
                      class="btn danger small"
                      onClick={() => confirm(`Delete “${t.name}”?`) && act(() => send('DELETE', `/api/templates/${t.id}`), 'Deleted')}
                    >
                      <Icon name="trash" />
                      <span class="sr-only">Delete template</span>
                    </button>
                  </>
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      <CreateSheet open={creating} me={me} onClose={() => setCreating(false)} onDone={state.reload} />
      <ApplySheet template={applying} today={me.today} onClose={() => setApplying(null)} />
      <Toasts />
    </>
  );
}

function CreateSheet({ open, me, onClose, onDone }: { open: boolean; me: Me; onClose: () => void; onDone: () => void }) {
  const [todos, setTodos] = useState<PickTodo[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) get<{ todos: PickTodo[] }>('/api/todos').then((r) => setTodos(r.todos), () => setTodos([]));
  }, [open]);
  const save = async () => {
    setBusy(true);
    try {
      await send('POST', '/api/templates', { name: name.trim(), todoIds: picked, isShared: shared });
      toast('Template saved');
      setPicked([]);
      setName('');
      onDone();
      onClose();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="New template"
      footer={
        <>
          <button type="button" class="btn quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="button" class="btn" disabled={busy || !name.trim() || !picked.length} onClick={save}>
            Save template
          </button>
        </>
      }
    >
      <div class="field">
        <label class="label" for="tpl-name">
          Name
        </label>
        <input id="tpl-name" class="input" value={name} maxLength={80} placeholder="e.g. Launch week" onInput={(e) => setName(e.currentTarget.value)} />
      </div>
      {me.partner && (
        <label class="switch mt-2">
          <span>
            Share with {me.partner.name.split(' ')[0]}
            <span class="hint">Items made from private todos stay hidden from them.</span>
          </span>
          <input type="checkbox" role="switch" checked={shared} onChange={(e) => setShared(e.currentTarget.checked)} />
        </label>
      )}
      <fieldset class="pick-list mt-4">
        <legend class="label">Todos to include ({picked.length})</legend>
        {todos === null && <Loading />}
        {todos?.map((t) => (
          <label key={t.id} class="pick">
            <input
              type="checkbox"
              checked={picked.includes(t.id)}
              onChange={(e) => setPicked((p) => (e.currentTarget.checked ? [...p, t.id] : p.filter((x) => x !== t.id)))}
            />
            <span>
              {t.title}
              <span class="faint">
                {t.recurrence.type !== 'none' ? ` · ${describeRule(t.recurrence)}` : ''}
                {t.projectName ? ` · ${t.projectName}` : ''}
                {t.isPrivate ? ' · private' : ''}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
    </Sheet>
  );
}

function ApplySheet({ template, today, onClose }: { template: Template | null; today: string; onClose: () => void }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectId, setProjectId] = useState('');
  const [startDate, setStartDate] = useState(today);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (template && projects === null) get<{ projects: Project[] }>('/api/projects').then((r) => setProjects(r.projects), () => setProjects([]));
  }, [template]);
  const apply = async () => {
    if (!template) return;
    setBusy(true);
    try {
      const r = await send<{ created: number }>('POST', `/api/templates/${template.id}/apply`, { startDate, projectId: projectId || null });
      toast(`Added ${r.created} todo${r.created === 1 ? '' : 's'}`);
      onClose();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={!!template}
      onClose={onClose}
      title={template ? `Use “${template.name}”` : 'Use template'}
      footer={
        <>
          <button type="button" class="btn quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="button" class="btn" disabled={busy} onClick={apply}>
            Add {template?.items.length ?? 0} todos
          </button>
        </>
      }
    >
      <div class="field">
        <label class="label" for="tpl-start">
          Starting
        </label>
        <input id="tpl-start" class="input" type="date" value={startDate} onInput={(e) => setStartDate(e.currentTarget.value)} />
      </div>
      <div class="field">
        <label class="label" for="tpl-project">
          Into project
        </label>
        <select id="tpl-project" class="select" value={projectId} onChange={(e) => setProjectId(e.currentTarget.value)}>
          <option value="">No project</option>
          {(projects ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
    </Sheet>
  );
}
