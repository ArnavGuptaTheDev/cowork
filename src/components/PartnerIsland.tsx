import { useEffect, useState } from 'preact/hooks';
import { copy } from '../content/copy';
import { get, getMe } from '../lib/api';
import { dayMonth, dayName } from '../lib/format';
import type { DayItem, Habit, Me, ProjectSummary, TodayView } from '../lib/types';
import { HabitList } from './HabitList';
import { ProjectCard } from './ProjectCard';
import { TodoForm } from './TodoForm';
import { TodoItem } from './TodoItem';
import { TodoSheet } from './TodoSheet';
import { Avatar, Empty, ErrorBox, Icon, Loading, ProgressRing, Toasts, useLoad } from './ui';

type Tab = 'today' | 'projects' | 'habits';

export default function PartnerIsland() {
  const [tab, setTab] = useState<Tab>('today');
  const [suggesting, setSuggesting] = useState(false);
  const [open, setOpen] = useState<{ todoId: string } | null>(null);

  useEffect(() => {
    const h = location.hash.slice(1);
    if (h === 'projects' || h === 'habits') setTab(h);
  }, []);
  const choose = (t: Tab) => {
    setTab(t);
    history.replaceState(null, '', `#${t}`);
  };

  const state = useLoad(async () => {
    const me = await getMe(true);
    if (!me.partner) return { me, today: null, projects: null, habits: null };
    const [today, projects, habits] = await Promise.all([
      get<TodayView>('/api/today?who=partner'),
      get<{ projects: ProjectSummary[] }>('/api/projects?who=partner'),
      get<{ habits: Habit[] }>('/api/habits?who=partner'),
    ]);
    return { me, today, projects: projects.projects, habits: habits.habits };
  });

  if (state.loading && !state.data) return <Loading />;
  if (state.error || !state.data) return <ErrorBox message={state.error ?? 'Could not load'} onRetry={state.reload} />;
  const { me, today, projects, habits } = state.data as { me: Me; today: TodayView | null; projects: ProjectSummary[] | null; habits: Habit[] | null };

  if (!me.partner || !today) {
    return (
      <>
        <header class="page-head">
          <div>
            <p class="eyebrow">Partner</p>
            <h1 class="page-title">Just you, for now</h1>
          </div>
        </header>
        <Empty title={copy.partner.none.title} body={copy.partner.none.body} icon="users">
          <a class="btn plum" href="/settings#pairing">
            {copy.partner.none.cta}
          </a>
        </Empty>
      </>
    );
  }

  const partner = me.partner;
  const first = partner.name.split(' ')[0];

  return (
    <>
      <header class="page-head">
        <div>
          <p class="eyebrow row">
            <Avatar name={partner.name} url={partner.avatarUrl} partner /> {partner.name}
          </p>
          <h1 class="page-title">
            {first}'s {dayName(today.date)}
            <br />
            <em>{dayMonth(today.date)}</em>
          </h1>
        </div>
        <ProgressRing done={today.summary.done} total={today.summary.total} label={`${first}: ${today.summary.done} of ${today.summary.total} done today`} />
      </header>

      <div class="row mb-4">
        <div class="tabs" role="tablist" aria-label="Partner views">
          {(['today', 'projects', 'habits'] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => choose(t)}>
              {t[0]!.toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        <span class="spacer" />
        <button type="button" class="btn plum" onClick={() => setSuggesting(true)}>
          <Icon name="heart" /> Suggest
        </button>
      </div>

      <p class="faint mb-4">
        <Icon name="lock" class="inline-icon" /> {copy.partner.readOnly}{' '}
        <a href="/week?who=partner">See their week</a>
      </p>

      {tab === 'today' &&
        (today.items.length ? (
          <ul class="todo-list">
            {today.items.map((item: DayItem) => (
              <TodoItem key={item.instanceId} item={item} today={today.date} readOnly onOpen={(i) => setOpen({ todoId: i.todoId })} />
            ))}
          </ul>
        ) : (
          <Empty title="Nothing on their plate" body={`${first} has nothing (visible) due today.`} icon="sun" />
        ))}

      {tab === 'projects' &&
        (projects && projects.length ? (
          <div class="grid-cards">
            {projects.map((p) => (
              <ProjectCard key={p.id} project={p} href={`/project?id=${p.id}&who=partner`} />
            ))}
          </div>
        ) : (
          <Empty title="No projects to show" body={`${first} has no shared projects yet.`} icon="folder" />
        ))}

      {tab === 'habits' &&
        (habits && habits.length ? (
          <HabitList habits={habits} readOnly onOpen={(h) => setOpen({ todoId: h.todoId })} />
        ) : (
          <Empty title="No habits to show" body={`${first} isn't tracking any shared habits.`} icon="flame" />
        ))}

      <TodoForm open={suggesting} mode="suggest" today={today.date} partnerName={first} onClose={() => setSuggesting(false)} onSaved={() => undefined} />
      <TodoSheet todoId={open?.todoId ?? null} onClose={() => setOpen(null)} onChanged={state.reload} />
      <Toasts />
    </>
  );
}
