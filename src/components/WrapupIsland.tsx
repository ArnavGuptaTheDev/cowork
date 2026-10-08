import { useState } from 'preact/hooks';
import { addDays } from '../../shared/time';
import { errorMessage, get, getMe, send } from '../lib/api';
import { relativeDay } from '../lib/format';
import type { DayItem, TodayView } from '../lib/types';
import { TomorrowHabits } from './TomorrowHabits';
import { Empty, ErrorBox, Icon, Loading, ProgressRing, Toasts, toast, useLoad } from './ui';

/** Evening wrap-up: today's leftovers with one-tap "tomorrow", "pick a date" or "drop". */
export default function WrapupIsland() {
  const [picking, setPicking] = useState<string | null>(null);
  const [pickDate, setPickDate] = useState('');
  const state = useLoad(async () => {
    const me = await getMe();
    const [mine, partner] = await Promise.all([
      get<TodayView>('/api/today'),
      me.partner ? get<TodayView>('/api/today?who=partner').catch(() => null) : Promise.resolve(null),
    ]);
    return { me, mine, partner };
  });

  if (state.loading && !state.data) return <Loading />;
  if (state.error || !state.data) return <ErrorBox message={state.error ?? 'Could not load'} onRetry={state.reload} />;
  const { me, mine, partner } = state.data;
  const leftovers = mine.items.filter((i) => i.status === 'pending' && i.canEdit);
  const today = mine.date;

  const act = async (item: DayItem, action: 'tomorrow' | 'date' | 'drop', date?: string) => {
    if (!item.instanceId) return;
    try {
      if (action === 'tomorrow') {
        await send('POST', `/api/instances/${item.instanceId}/reschedule`, { date: addDays(today, 1) });
        toast(`“${item.title}” moved to tomorrow`);
      } else if (action === 'date' && date) {
        await send('POST', `/api/instances/${item.instanceId}/reschedule`, { date });
        toast(`Moved to ${relativeDay(date, today).toLowerCase()}`);
        setPicking(null);
      } else if (action === 'drop') {
        if (item.recurrence.type !== 'none') {
          await send('POST', `/api/instances/${item.instanceId}/skip`, {});
          toast('Skipped for today');
        } else {
          if (!confirm(`Drop “${item.title}” for good?`)) return;
          await send('DELETE', `/api/todos/${item.todoId}`);
          toast('Dropped');
        }
      }
      await state.reload();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  return (
    <>
      <header class="page-head">
        <div>
          <p class="eyebrow">Evening wrap-up</p>
          <h1 class="page-title">
            {leftovers.length === 0 ? 'All tidy' : `${leftovers.length} left`}
            <br />
            <em>{relativeDay(today, today)}</em>
          </h1>
        </div>
        <ProgressRing done={mine.summary.done} total={mine.summary.total} />
      </header>

      {partner && me.partner && (
        <p class="glance">
          <Icon name="users" />
          <span>
            {me.partner.name.split(' ')[0]} did {partner.summary.done} of {partner.summary.total}
          </span>
        </p>
      )}

      {leftovers.length === 0 ? (
        <Empty title="Nothing left over" body="Everything for today is done or moved. Sleep well." icon="moon" />
      ) : (
        <ul class="todo-list">
          {leftovers.map((item) => {
            const oneOff = item.recurrence.type === 'none';
            const canDrop = !oneOff || item.ownerId === me.user.id;
            return (
              <li key={item.instanceId} class="card wrapup-item" data-category={item.category}>
                <div>
                  <strong>{item.title}</strong>
                  <div class="faint">
                    {item.carriedOverFrom ? `From ${relativeDay(item.carriedOverFrom, today).toLowerCase()}` : oneOff ? 'Today' : 'Repeats'}
                    {item.project ? ` · ${item.project.name}` : ''}
                  </div>
                </div>
                <div class="row mt-2">
                  {oneOff && (
                    <>
                      <button type="button" class="btn ghost small" onClick={() => act(item, 'tomorrow')}>
                        Tomorrow
                      </button>
                      <button
                        type="button"
                        class="btn ghost small"
                        aria-expanded={picking === item.instanceId}
                        onClick={() => {
                          setPicking(picking === item.instanceId ? null : item.instanceId);
                          setPickDate(addDays(today, 2));
                        }}
                      >
                        Pick a date
                      </button>
                    </>
                  )}
                  {canDrop && (
                    <button type="button" class="btn danger small" onClick={() => act(item, 'drop')}>
                      {oneOff ? 'Drop' : 'Skip today'}
                    </button>
                  )}
                </div>
                {picking === item.instanceId && (
                  <div class="row mt-2">
                    <label class="sr-only" for={`d-${item.instanceId}`}>
                      New date
                    </label>
                    <input id={`d-${item.instanceId}`} class="input date-input" type="date" min={addDays(today, 1)} value={pickDate} onInput={(e) => setPickDate(e.currentTarget.value)} />
                    <button type="button" class="btn small" onClick={() => act(item, 'date', pickDate)} disabled={!pickDate}>
                      Move
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <TomorrowHabits />
      <p class="row center mt-6">
        <a class="btn quiet" href="/today">
          Back to today
        </a>
      </p>
      <Toasts />
    </>
  );
}
