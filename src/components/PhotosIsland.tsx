import { useEffect, useState } from 'preact/hooks';
import { get, getMe } from '../lib/api';
import { relativeDay } from '../lib/format';
import { nameFor } from '../lib/people';
import type { Habit, Me, ProjectSummary } from '../lib/types';
import { Empty, ErrorBox, Loading } from './ui';

interface FeedPhoto {
  id: string;
  url: string;
  width: number | null;
  height: number | null;
  todoTitle: string;
  ownerId: string;
  date: string;
  completedBy: string | null;
  project: { name: string; color: string } | null;
}

/** All completion photos, newest first, filterable by project or habit. */
export default function PhotosIsland() {
  const [me, setMe] = useState<Me | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [habits, setHabits] = useState<Habit[]>([]);
  const [filter, setFilter] = useState('');
  const [who, setWho] = useState<'all' | 'me' | 'partner'>('all');
  const [photos, setPhotos] = useState<FeedPhoto[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<FeedPhoto | null>(null);

  useEffect(() => {
    getMe().then(setMe, () => undefined);
    get<{ projects: ProjectSummary[] }>('/api/projects').then((r) => setProjects(r.projects), () => undefined);
    get<{ habits: Habit[] }>('/api/habits').then((r) => setHabits(r.habits), () => undefined);
  }, []);

  const url = (before?: string | null) => {
    const q = new URLSearchParams({ who });
    if (filter.startsWith('p:')) q.set('projectId', filter.slice(2));
    if (filter.startsWith('t:')) q.set('todoId', filter.slice(2));
    if (before) q.set('before', before);
    return `/api/timeline/photos?${q}`;
  };

  const load = async (more = false) => {
    setBusy(true);
    try {
      const r = await get<{ photos: FeedPhoto[]; next: string | null }>(url(more ? next : null));
      setPhotos((p) => (more && p ? [...p, ...r.photos] : r.photos));
      setNext(r.next);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void load(false);
  }, [filter, who]);

  return (
    <>
      <header class="page-head">
        <div>
          <p class="eyebrow">Proof &amp; progress</p>
          <h1 class="page-title">Photos</h1>
        </div>
      </header>
      <div class="row mb-4">
        {me?.partner && (
          <div class="tabs" role="tablist" aria-label="Whose photos">
            {(['all', 'me', 'partner'] as const).map((w) => (
              <button key={w} type="button" role="tab" aria-selected={who === w} onClick={() => setWho(w)}>
                {w === 'all' ? 'Both' : w === 'me' ? 'Mine' : me.partner!.name.split(' ')[0]}
              </button>
            ))}
          </div>
        )}
        <label class="sr-only" for="photo-filter">
          Filter
        </label>
        <select id="photo-filter" class="select grow filter-select" value={filter} onChange={(e) => setFilter(e.currentTarget.value)}>
          <option value="">Everything</option>
          {projects.length > 0 && (
            <optgroup label="Projects">
              {projects.map((p) => (
                <option key={p.id} value={`p:${p.id}`}>
                  {p.name}
                </option>
              ))}
            </optgroup>
          )}
          {habits.length > 0 && (
            <optgroup label="Habits">
              {habits.map((h) => (
                <option key={h.todoId} value={`t:${h.todoId}`}>
                  {h.title}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </div>

      {error && <ErrorBox message={error} onRetry={() => load(false)} />}
      {photos === null && !error && <Loading />}
      {photos && photos.length === 0 && <Empty title="No photos yet" body="Add a photo when you complete something (proof or progress) and it shows up here." icon="camera" />}
      {photos && photos.length > 0 && (
        <ul class="timeline">
          {photos.map((p) => (
            <li key={p.id}>
              <button type="button" class="timeline-photo" onClick={() => setOpen(p)} aria-label={`${p.todoTitle}, ${relativeDay(p.date, me?.today ?? p.date)}`}>
                <img src={p.url} alt="" loading="lazy" width={p.width ?? undefined} height={p.height ?? undefined} />
              </button>
              <div class="timeline-meta">
                <strong>{p.todoTitle}</strong>
                <span class="faint">
                  {relativeDay(p.date, me?.today ?? p.date)}
                  {p.project ? ` · ${p.project.name}` : ''}
                  {me && p.ownerId !== me.user.id ? ` · ${nameFor(me, p.ownerId)}` : ''}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {next && (
        <p class="row center mt-6">
          <button type="button" class="btn ghost" disabled={busy} onClick={() => load(true)}>
            {busy ? 'Loading…' : 'Load more'}
          </button>
        </p>
      )}
      {open && (
        <dialog
          class="lightbox"
          ref={(el) => {
            if (el && !el.open) el.showModal();
          }}
          onClick={(e) => (e.currentTarget as HTMLDialogElement).close()}
          onClose={() => setOpen(null)}
          aria-label={open.todoTitle}
        >
          <img src={open.url} alt="" />
        </dialog>
      )}
    </>
  );
}
