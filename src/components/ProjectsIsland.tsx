import { useState } from 'preact/hooks';
import { copy } from '../content/copy';
import { get } from '../lib/api';
import type { ProjectSummary } from '../lib/types';
import { ProjectCard } from './ProjectCard';
import { ProjectForm } from './ProjectForm';
import { Empty, ErrorBox, Icon, Loading, Toasts, useLoad } from './ui';

export default function ProjectsIsland() {
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const state = useLoad(() => get<{ projects: ProjectSummary[] }>(`/api/projects?archived=${showArchived ? 1 : 0}`), [showArchived]);

  return (
    <>
      <header class="page-head">
        <div>
          <p class="eyebrow">Your work</p>
          <h1 class="page-title">Projects</h1>
        </div>
        <button type="button" class="btn" onClick={() => setCreating(true)}>
          <Icon name="plus" /> New
        </button>
      </header>
      {state.error && <ErrorBox message={state.error} onRetry={state.reload} />}
      {state.loading && !state.data && <Loading />}
      {state.data &&
        (state.data.projects.length === 0 ? (
          <Empty title={copy.projects.empty.title} body={copy.projects.empty.body} icon="folder">
            <button type="button" class="btn" onClick={() => setCreating(true)}>
              <Icon name="plus" /> Create a project
            </button>
          </Empty>
        ) : (
          <div class="grid-cards">
            {state.data.projects.map((p) => (
              <ProjectCard key={p.id} project={p} href={`/project?id=${p.id}`} />
            ))}
          </div>
        ))}
      <p class="row center mt-6">
        <button type="button" class="btn quiet" onClick={() => setShowArchived((v) => !v)} aria-pressed={showArchived}>
          {showArchived ? 'Hide archived' : 'Show archived'}
        </button>
      </p>
      <ProjectForm open={creating} onClose={() => setCreating(false)} onSaved={() => state.reload()} />
      <Toasts />
    </>
  );
}
