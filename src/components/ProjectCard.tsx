import type { ProjectSummary } from '../lib/types';
import { Icon, ProgressBar } from './ui';

export function ProjectCard({ project: p, href }: { project: ProjectSummary; href: string }) {
  const { done, total } = p.progress;
  return (
    <a class="card project-card" href={href}>
      <h3>
        <i class="dot" data-color={p.color} aria-hidden="true" />
        {p.name}
        {p.isPrivate && <Icon name="lock" label="Private" />}
      </h3>
      {p.description && <p class="faint">{p.description}</p>}
      <ProgressBar done={done} total={total} />
      <div class="row faint">
        <span>
          {done} / {total} done
        </span>
        {p.recurringCount > 0 && <span>· {p.recurringCount} repeating</span>}
        {p.archived && <span class="chip">Archived</span>}
        <span class="spacer" />
        <span class="chip">{p.category}</span>
      </div>
    </a>
  );
}
