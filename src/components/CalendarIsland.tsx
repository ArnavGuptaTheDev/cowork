import { useEffect, useState } from 'preact/hooks';
import { addDays, endOfMonth, startOfMonth, startOfWeek, weekday } from '../../shared/time';
import { get, getMe } from '../lib/api';
import { dayOfMonth, monthYear, shortDate, shortDay } from '../lib/format';
import type { DayItem, Me, RangeView } from '../lib/types';
import { TodoItem } from './TodoItem';
import { TodoSheet } from './TodoSheet';
import { ErrorBox, Icon, Loading, Toasts } from './ui';
import { toggleItem } from './useTodos';

type Mode = 'week' | 'month';

function readParams(): { who: 'me' | 'partner'; anchor: string | null } {
  const p = new URLSearchParams(location.search);
  return { who: p.get('who') === 'partner' ? 'partner' : 'me', anchor: p.get('d') };
}

export default function CalendarIsland({ mode }: { mode: Mode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [who, setWho] = useState<'me' | 'partner'>('me');
  const [anchor, setAnchor] = useState<string | null>(null);
  const [data, setData] = useState<RangeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [openItem, setOpenItem] = useState<DayItem | null>(null);

  useEffect(() => {
    const p = readParams();
    setWho(p.who);
    getMe().then((m) => {
      setMe(m);
      setAnchor(p.anchor ?? m.today);
    }, (e) => setError(String(e)));
  }, []);

  const range = (a: string): [string, string] =>
    mode === 'week' ? [startOfWeek(a), addDays(startOfWeek(a), 6)] : [startOfMonth(a), endOfMonth(a)];

  const load = async () => {
    if (!anchor) return;
    const [from, to] = range(anchor);
    try {
      setData(await get<RangeView>(`/api/range?from=${from}&to=${to}&who=${who}`));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load');
    }
  };

  useEffect(() => {
    void load();
    if (anchor) {
      const url = new URL(location.href);
      url.searchParams.set('d', anchor);
      if (who === 'partner') url.searchParams.set('who', 'partner');
      else url.searchParams.delete('who');
      history.replaceState(null, '', url);
    }
  }, [anchor, who]);

  const shift = (dir: -1 | 1) => {
    if (!anchor) return;
    if (mode === 'week') setAnchor(addDays(anchor, 7 * dir));
    else {
      const first = startOfMonth(anchor);
      setAnchor(dir === 1 ? addDays(endOfMonth(first), 1) : startOfMonth(addDays(first, -1)));
    }
    setSelected(null);
  };

  const apply = (instanceId: string, status: DayItem['status']) =>
    setData((d) =>
      d && {
        ...d,
        days: d.days.map((day) => ({ ...day, items: day.items.map((i) => (i.instanceId === instanceId ? { ...i, status } : i)) })),
      },
    );

  if (error) return <ErrorBox message={error} onRetry={load} />;
  if (!me || !anchor) return <Loading />;

  const [from, to] = range(anchor);
  const readOnly = who === 'partner';
  const title = mode === 'week' ? `${shortDate(from)} – ${shortDate(to)}` : monthYear(anchor);
  const today = data?.today ?? me.today;

  return (
    <>
      <header class="page-head">
        <div>
          <p class="eyebrow">{readOnly ? `${me.partner?.name ?? 'Partner'}'s` : 'Your'} {mode}</p>
          <h1 class="page-title">{mode === 'week' ? 'This week' : 'The month'}</h1>
        </div>
        <nav class="tabs" aria-label="Calendar view">
          <a href={`/week${who === 'partner' ? '?who=partner' : ''}`} aria-current={mode === 'week' ? 'page' : undefined}>
            Week
          </a>
          <a href={`/month${who === 'partner' ? '?who=partner' : ''}`} aria-current={mode === 'month' ? 'page' : undefined}>
            Month
          </a>
        </nav>
      </header>

      {me.partner && (
        <div class="tabs mb-4" role="tablist" aria-label="Whose calendar">
          <button type="button" role="tab" aria-selected={who === 'me'} onClick={() => setWho('me')}>
            Mine
          </button>
          <button type="button" role="tab" aria-selected={who === 'partner'} onClick={() => setWho('partner')}>
            {me.partner.name.split(' ')[0]}
          </button>
        </div>
      )}

      <div class="pager">
        <button type="button" class="icon-btn" onClick={() => shift(-1)}>
          <Icon name="left" label={`Previous ${mode}`} />
        </button>
        <h2 aria-live="polite">{title}</h2>
        <button type="button" class="icon-btn" onClick={() => shift(1)}>
          <Icon name="right" label={`Next ${mode}`} />
        </button>
      </div>
      {anchor !== me.today && (from > me.today || to < me.today) && (
        <p class="row center">
          <button type="button" class="btn quiet" onClick={() => setAnchor(me.today)}>
            Back to today
          </button>
        </p>
      )}

      {!data || data.from !== from ? (
        <Loading />
      ) : mode === 'week' ? (
        <div class="week">
          {data.days.map((day) => (
            <section key={day.date} class={`day ${day.date === today ? 'is-today' : ''}`} aria-label={`${shortDay(day.date)} ${shortDate(day.date)}`}>
              <div class="day-label" aria-hidden="true">
                <div class="dow">{shortDay(day.date)}</div>
                <div class="num">{dayOfMonth(day.date)}</div>
              </div>
              {day.items.length ? (
                <ul class="todo-list">
                  {day.items.map((item) => (
                    <TodoItem
                      key={`${item.todoId}-${day.date}`}
                      item={item}
                      today={today}
                      readOnly={readOnly}
                      onToggle={(i) => toggleItem(i, today, apply)}
                      onOpen={setOpenItem}
                    />
                  ))}
                </ul>
              ) : (
                <p class="day-empty">Nothing planned</p>
              )}
            </section>
          ))}
        </div>
      ) : (
        <MonthGrid data={data} today={today} selected={selected} onSelect={setSelected} readOnly={readOnly} apply={apply} onOpen={setOpenItem} />
      )}

      <TodoSheet todoId={openItem?.todoId ?? null} instanceId={openItem?.instanceId} onClose={() => setOpenItem(null)} onChanged={load} />
      <Toasts />
    </>
  );
}

function MonthGrid(props: {
  data: RangeView;
  today: string;
  selected: string | null;
  onSelect: (d: string) => void;
  readOnly: boolean;
  apply: (id: string, s: DayItem['status']) => void;
  onOpen: (i: DayItem) => void;
}) {
  const lead = (weekday(props.data.from) + 6) % 7; // Monday-first
  const sel = props.selected ?? (props.data.days.some((d) => d.date === props.today) ? props.today : props.data.from);
  const selDay = props.data.days.find((d) => d.date === sel);
  return (
    <>
      <div class="month-grid" role="group" aria-label="Days of the month">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
          <div key={i} class="dow" aria-hidden="true">
            {d}
          </div>
        ))}
        {Array.from({ length: lead }, (_, i) => (
          <div key={`l${i}`} class="month-cell out" aria-hidden="true" />
        ))}
        {props.data.days.map((day) => {
          const done = day.items.filter((i) => i.status === 'done').length;
          return (
            <button
              type="button"
              key={day.date}
              class={`month-cell ${day.date === props.today ? 'is-today' : ''}`}
              aria-pressed={day.date === sel}
              aria-label={`${shortDay(day.date)} ${shortDate(day.date)}: ${day.items.length} items, ${done} done`}
              onClick={() => props.onSelect(day.date)}
            >
              <span>{dayOfMonth(day.date)}</span>
              <span class="pips" aria-hidden="true">
                {day.items.slice(0, 6).map((i, n) => (
                  <i key={n} data-s={i.status} />
                ))}
              </span>
            </button>
          );
        })}
      </div>
      {selDay && (
        <section class="section">
          <h3 class="section-title">
            {shortDay(selDay.date)} {shortDate(selDay.date)}
            <small>{selDay.items.length} items</small>
          </h3>
          {selDay.items.length ? (
            <ul class="todo-list">
              {selDay.items.map((item) => (
                <TodoItem
                  key={`${item.todoId}-${selDay.date}`}
                  item={item}
                  today={props.today}
                  readOnly={props.readOnly}
                  onToggle={(i) => toggleItem(i, props.today, props.apply)}
                  onOpen={props.onOpen}
                />
              ))}
            </ul>
          ) : (
            <p class="day-empty">Nothing planned</p>
          )}
        </section>
      )}
    </>
  );
}
