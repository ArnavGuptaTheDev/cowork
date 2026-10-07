import { useEffect, useState } from 'preact/hooks';
import { addDays, startOfWeek } from '../../shared/time';
import { get, getMe } from '../lib/api';
import { percent, shortDate, shortDay } from '../lib/format';
import type { Me } from '../lib/types';
import { BarChart, HBars } from './charts';
import { ErrorBox, Icon, Loading, ProgressRing, useLoad } from './ui';

interface DayStat {
  date: string;
  done: number;
  missed: number;
  open: number;
}
interface Stats {
  done: number;
  missed: number;
  open: number;
  paused: number;
  rate: number | null;
  byWeekday: { weekday: number; done: number; total: number }[];
  byCategory: { category: string; done: number; total: number }[];
  days: DayStat[];
  bestDay: DayStat | null;
  worstDay: DayStat | null;
  streaks: { title: string; current: number; best: number }[];
  minutesByDay: number[];
  minutesTotal: number;
}
interface Review {
  weekStart: string;
  me: Stats;
  partner: Stats | null;
}

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function hours(min: number): string {
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ''}`;
}

function Column({ name, s, partner }: { name: string; s: Stats; partner?: boolean }) {
  const resolved = s.done + s.missed;
  return (
    <section class={`card review-col ${partner ? 'is-partner' : ''}`} aria-label={`${name}'s week`}>
      <header class="row">
        <h2 class="section-title grow">{name}</h2>
        <ProgressRing done={s.done} total={resolved} label={`${name}: ${percent(s.rate)} done`} />
      </header>
      <p class="faint">
        {s.done} done · {s.missed} missed{s.open ? ` · ${s.open} open` : ''}
        {s.paused ? ` · ${s.paused} paused` : ''} · <strong>{percent(s.rate)}</strong>
      </p>

      <h3 class="label mt-4">By day</h3>
      <BarChart
        title={`${name}: completions by weekday`}
        bars={s.byWeekday.map((d, i) => ({ label: DOW[i]!, value: d.done, total: d.total }))}
      />

      {s.bestDay && (
        <p class="mt-2">
          <span class="chip sage">Best</span> {shortDay(s.bestDay.date)} {shortDate(s.bestDay.date)} · {s.bestDay.done} done
        </p>
      )}
      {s.worstDay && (
        <p class="mt-2">
          <span class="chip missed">Toughest</span> {shortDay(s.worstDay.date)} {shortDate(s.worstDay.date)} · {s.worstDay.missed} missed
        </p>
      )}

      {s.byCategory.length > 0 && (
        <>
          <h3 class="label mt-4">By category</h3>
          <HBars title={`${name}: by category`} rows={s.byCategory.map((c) => ({ label: c.category, done: c.done, total: c.total }))} />
        </>
      )}

      {s.streaks.length > 0 && (
        <>
          <h3 class="label mt-4">Streaks</h3>
          <ul class="list-plain">
            {s.streaks.map((st) => (
              <li key={st.title} class="row">
                <span class="grow">{st.title}</span>
                <span class="chip honey">
                  <Icon name="flame" />
                  {st.current}
                </span>
                <span class="faint">best {st.best}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {s.minutesTotal > 0 && (
        <>
          <h3 class="label mt-4">Time tracked · {hours(s.minutesTotal)}</h3>
          <BarChart title={`${name}: minutes tracked per day`} unit=" min" bars={s.minutesByDay.map((m, i) => ({ label: DOW[i]!, value: m }))} />
        </>
      )}
    </section>
  );
}

export default function ReviewIsland() {
  const [me, setMe] = useState<Me | null>(null);
  const [week, setWeek] = useState<string | null>(null);
  useEffect(() => {
    getMe().then((m) => {
      setMe(m);
      setWeek(new URLSearchParams(location.search).get('week') ?? startOfWeek(m.today));
    }, () => undefined);
  }, []);
  const state = useLoad(async () => (week ? get<Review>(`/api/review?week=${week}`) : null), [week]);

  useEffect(() => {
    if (week) history.replaceState(null, '', `/review?week=${week}`);
  }, [week]);

  if (!me || !week || (state.loading && !state.data)) return <Loading />;
  if (state.error || !state.data) return <ErrorBox message={state.error ?? 'Could not load'} onRetry={state.reload} />;
  const r = state.data;
  const thisWeek = startOfWeek(me.today);

  return (
    <>
      <header class="page-head">
        <div>
          <p class="eyebrow">Weekly review</p>
          <h1 class="page-title">
            {shortDate(r.weekStart)} – <em>{shortDate(addDays(r.weekStart, 6))}</em>
          </h1>
        </div>
      </header>
      <div class="pager">
        <button type="button" class="icon-btn" onClick={() => setWeek(addDays(r.weekStart, -7))}>
          <Icon name="left" label="Previous week" />
        </button>
        <label class="sr-only" for="week-pick">
          Pick a week
        </label>
        <input id="week-pick" class="input date-input" type="date" value={week} onChange={(e) => e.currentTarget.value && setWeek(startOfWeek(e.currentTarget.value))} />
        <button type="button" class="icon-btn" disabled={r.weekStart >= thisWeek} onClick={() => setWeek(addDays(r.weekStart, 7))}>
          <Icon name="right" label="Next week" />
        </button>
      </div>
      <div class="review-grid">
        <Column name="You" s={r.me} />
        {r.partner && me.partner && <Column name={me.partner.name.split(' ')[0] ?? 'Partner'} s={r.partner} partner />}
      </div>
      {r.partner && <p class="faint mt-4">Your partner's numbers leave out their private todos.</p>}
    </>
  );
}
