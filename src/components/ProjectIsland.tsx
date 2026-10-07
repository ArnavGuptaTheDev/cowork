import { useEffect, useState } from 'preact/hooks';
import { describeRule } from '../../shared/recurrence';
import { errorMessage, get, send } from '../lib/api';
import { percent, relativeDay } from '../lib/format';
import type { ProjectDetail, ProjectTodo } from '../lib/types';
import { ProjectForm } from './ProjectForm';
import { TodoForm } from './TodoForm';
import { TodoSheet } from './TodoSheet';
import { Check, Empty, ErrorBox, Icon, Loading, ProgressRing, Toasts, toast, useLoad } from './ui';

function params() {
  const p = new URLSearchParams(location.search);
  return { id: p.get('id') ?? '', who: p.get('who') === 'partner' ? ('partner' as const) : ('me' as const) };
}

export default function ProjectIsland() {
  const [params_, setParams] = useState<ReturnType<typeof params> | null>(null);
  const id = params_?.id ?? '';
  const who = params_?.who ?? 'me';
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [openTodo, setOpenTodo] = useState<ProjectTodo | null>(null);
  useEffect(() => setParams(params()), []);

  const state = useLoad(async () => (id ? get<ProjectDetail>(`/api/projects/${id}`) : null), [id, who]);
  const readOnly = !state.data?.canManage;
  const canAdd = !!state.data?.canAdd;

  if (!params_) return <Loading />;
  if (!id) return <ErrorBox message="No project selected." />;
  if (state.error) return <ErrorBox message={state.error} onRetry={state.reload} />;
  if (!state.data) return <Loading />;
  const d = state.data;

  const toggle = async (t: ProjectTodo) => {
    if (!t.instanceId) return;
    const done = t.status === 'done';
    try {
      await send('POST', `/api/instances/${t.instanceId}/${done ? 'uncomplete' : 'complete'}`, {});
      await state.reload();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const archive = async () => {
    try {
      await send('PATCH', `/api/projects/${d.project.id}`, { archived: !d.project.archived });
      toast(d.project.archived ? 'Restored' : 'Archived');
      await state.reload();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const remove = async () => {
    if (!confirm(`Delete "${d.project.name}"? Its todos are kept, just without a project.`)) return;
    try {
      await send('DELETE', `/api/projects/${d.project.id}`);
      location.href = '/projects';
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const oneOff = d.todos.filter((t) => !t.stats);
  const repeating = d.todos.filter((t) => t.stats);

  return (
    <>
      <p>
        <a href={readOnly ? '/partner#projects' : '/projects'} class="btn quiet">
          <Icon name="left" /> {readOnly ? 'Partner' : 'Projects'}
        </a>
      </p>
      <header class="page-head">
        <div>
          <p class="eyebrow row">
            <i class="dot" data-color={d.project.color} aria-hidden="true" /> {d.project.category}
            {d.project.isPrivate && ' · private'}
            {d.project.archived && ' · archived'}
          </p>
          <h1 class="page-title">{d.project.name}</h1>
          {d.project.description && <p class="lede">{d.project.description}</p>}
        </div>
        <ProgressRing done={d.progress.done} total={d.progress.total} />
      </header>

      {canAdd && readOnly && (
        <div class="row">
          <button type="button" class="btn" onClick={() => setAdding(true)}>
            <Icon name="plus" /> Add todo
          </button>
          <span class="chip plum">Shared project</span>
        </div>
      )}
      {!readOnly && (
        <div class="row">
          <button type="button" class="btn" onClick={() => setAdding(true)}>
            <Icon name="plus" /> Add todo
          </button>
          <button type="button" class="btn ghost" onClick={() => setEditing(true)}>
            <Icon name="edit" /> Edit
          </button>
          <span class="spacer" />
          <button type="button" class="btn quiet" onClick={archive}>
            {d.project.archived ? 'Unarchive' : 'Archive'}
          </button>
          <button type="button" class="btn danger" onClick={remove}>
            <Icon name="trash" />
            <span class="sr-only">Delete project</span>
          </button>
        </div>
      )}

      {d.todos.length === 0 && (
        <div class="mt-6">
          <Empty title="Nothing here yet" body={readOnly ? 'No visible todos in this project.' : 'Add the first todo to start the progress bar.'} icon="folder" />
        </div>
      )}

      {oneOff.length > 0 && (
        <section class="section">
          <h2 class="section-title">
            Todos <small>{d.progress.done} of {d.progress.total} done</small>
          </h2>
          <ul class="todo-list">
            {oneOff.map((t) => (
              <li key={t.todoId} class={`todo ${t.status === 'done' ? 'is-done' : ''}`} data-category={t.category}>
                <Check checked={t.status === 'done'} label={`Mark ${t.status === 'done' ? 'not done' : 'done'}: ${t.title}`} disabled={!t.canEdit || !t.instanceId} onToggle={() => toggle(t)} />
                <button type="button" class="todo-body" onClick={() => setOpenTodo(t)}>
                  <div class="todo-title">{t.title}</div>
                  <div class="todo-meta">
                    <span>{relativeDay(t.startDate, d.today)}</span>
                    {t.isPrivate && (
                      <span>
                        <Icon name="lock" /> Private
                      </span>
                    )}
                    {t.photoCount > 0 && (
                      <span>
                        <Icon name="image" />
                        {t.photoCount}
                      </span>
                    )}
                  </div>
                </button>
                <span />
              </li>
            ))}
          </ul>
        </section>
      )}

      {repeating.length > 0 && (
        <section class="section">
          <h2 class="section-title">Repeating</h2>
          <ul class="todo-list">
            {repeating.map((t) => (
              <li key={t.todoId} class="todo" data-category={t.category}>
                <span class="check" aria-hidden="true">
                  <Icon name="repeat" />
                </span>
                <button type="button" class="todo-body" onClick={() => setOpenTodo(t)}>
                  <div class="todo-title">{t.title}</div>
                  <div class="todo-meta">
                    <span>{describeRule(t.recurrence)}</span>
                    <span>{percent(t.stats!.completionRate)} last 30 days</span>
                  </div>
                </button>
                <span class="chip honey">
                  <Icon name="flame" />
                  {t.stats!.currentStreak}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {canAdd && (
        <TodoForm open={adding} mode="create" today={d.today} defaults={{ projectId: d.project.id, category: d.project.category }} onClose={() => setAdding(false)} onSaved={state.reload} />
      )}
      {!readOnly && (
        <>
          <ProjectForm open={editing} project={d.project} onClose={() => setEditing(false)} onSaved={() => state.reload()} />
        </>
      )}
      <TodoSheet todoId={openTodo?.todoId ?? null} instanceId={openTodo?.instanceId} onClose={() => setOpenTodo(null)} onChanged={state.reload} />
      <Toasts />
    </>
  );
}
