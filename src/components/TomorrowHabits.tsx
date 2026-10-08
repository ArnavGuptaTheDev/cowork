import { useEffect, useState } from 'preact/hooks';
import { describeRule } from '../../shared/recurrence';
import { errorMessage, get, send } from '../lib/api';
import { prettyTime } from '../lib/format';
import type { Recurrence, TomorrowHabit } from '../lib/types';
import { TimeField } from './TimeField';
import { toast } from './ui';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

type Mode = 'keep' | 'once' | 'always';

/** "Tomorrow's habits" on the wrap-up screen. Renders nothing when there are none. */
export function TomorrowHabits() {
  const [data, setData] = useState<{ date: string; habits: TomorrowHabit[] } | null>(null);
  const load = () => get<{ date: string; habits: TomorrowHabit[] }>('/api/wrapup/tomorrow').then(setData, () => undefined);
  useEffect(() => {
    void load();
  }, []);
  if (!data || data.habits.length === 0) return null;
  return (
    <section class="section" aria-labelledby="tomorrow-title">
      <h2 class="section-title" id="tomorrow-title">
        Tomorrow's habits
      </h2>
      <ul class="todo-list">
        {data.habits.map((h) => (
          <HabitRow key={h.todoId} habit={h} onChanged={load} />
        ))}
      </ul>
    </section>
  );
}

function HabitRow({ habit, onChanged }: { habit: TomorrowHabit; onChanged: () => void }) {
  const [mode, setMode] = useState<Mode>('keep');
  const [time, setTime] = useState(habit.override?.time ?? habit.dueTime ?? habit.reminderTime ?? '');
  const [rule, setRule] = useState<Recurrence>(habit.recurrence);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast(done);
      setMode('keep');
      onChanged();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const status = habit.override?.skipped ? 'Skipping tomorrow' : habit.override?.time ? `Tomorrow only: ${prettyTime(habit.override.time)}` : null;
  const weekdays = rule.type === 'weekly' ? rule.weekdays : null;

  return (
    <li class="card wrapup-item" data-category="habit">
      <div class="row between">
        <div>
          <strong>{habit.title}</strong>
          <div class="faint">
            {habit.override?.skipped ? 'Skipped' : habit.time ? prettyTime(habit.time) : 'Any time'} · {describeRule(habit.recurrence)}
          </div>
          {status && <span class="chip">{status}</span>}
        </div>
      </div>
      <div class="tabs small mt-2" role="radiogroup" aria-label={`What to do with ${habit.title} tomorrow`}>
        {(
          [
            ['keep', 'Keep'],
            ['once', 'Tomorrow only'],
            ['always', 'From tomorrow on'],
          ] as [Mode, string][]
        ).map(([v, l]) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={mode === v}
            aria-selected={mode === v}
            onClick={() => {
              setMode(v);
              if (v === 'keep' && habit.override) void run(() => send('POST', `/api/todos/${habit.todoId}/tomorrow`, { action: 'keep' }), 'Back to the usual plan');
            }}
          >
            {l}
          </button>
        ))}
      </div>

      {mode === 'once' && (
        <div class="row mt-2">
          <TimeField id={`tm-${habit.todoId}`} value={time} onChange={setTime} placeholder="New time" />
          <button
            type="button"
            class="btn small"
            disabled={busy || !time}
            onClick={() => run(() => send('POST', `/api/todos/${habit.todoId}/tomorrow`, { action: 'time', time }), `Tomorrow at ${prettyTime(time)}`)}
          >
            Move
          </button>
          <button
            type="button"
            class="btn ghost small"
            disabled={busy || habit.override?.skipped}
            onClick={() => run(() => send('POST', `/api/todos/${habit.todoId}/tomorrow`, { action: 'skip' }), 'Skipping tomorrow. Your streak is safe')}
          >
            Skip tomorrow
          </button>
        </div>
      )}

      {mode === 'always' && (
        <div class="mt-2">
          <div class="field">
            <label class="label" for={`ta-${habit.todoId}`}>
              Time
            </label>
            <TimeField id={`ta-${habit.todoId}`} value={time} onChange={setTime} placeholder="No set time" />
          </div>
          <fieldset class="segmented mt-2">
            <legend>Repeats</legend>
            <label>
              <input type="radio" name={`rr-${habit.todoId}`} checked={rule.type === 'daily'} onChange={() => setRule({ type: 'daily' })} />
              <span>Every day</span>
            </label>
            <label>
              <input
                type="radio"
                name={`rr-${habit.todoId}`}
                checked={rule.type === 'weekly'}
                onChange={() => setRule({ type: 'weekly', weekdays: weekdays ?? [1, 2, 3, 4, 5] })}
              />
              <span>Some days</span>
            </label>
          </fieldset>
          {weekdays && (
            <div class="weekday-picks mt-2" role="group" aria-label="Days">
              {DAYS.map((d, i) => (
                <button
                  key={d}
                  type="button"
                  class="chip-toggle"
                  aria-pressed={weekdays.includes(i)}
                  onClick={() => {
                    const next = weekdays.includes(i) ? weekdays.filter((x) => x !== i) : [...weekdays, i].sort();
                    if (next.length) setRule({ type: 'weekly', weekdays: next });
                  }}
                >
                  {d}
                </button>
              ))}
            </div>
          )}
          <p class="faint mt-2">Applies from tomorrow. Past days and your streak stay as they are.</p>
          <button
            type="button"
            class="btn small mt-2"
            disabled={busy}
            onClick={() =>
              run(
                () =>
                  send('POST', `/api/todos/${habit.todoId}/change-from-tomorrow`, {
                    recurrence: rule.type === 'monthly' || rule.type === 'none' ? habit.recurrence : rule,
                    dueTime: time || null,
                    // Keep the reminder's lead before the time; with no reminder, stay without one.
                    reminderTime: habit.reminderTime ? shift(habit.dueTime, habit.reminderTime, time) : null,
                  }),
                'Changed from tomorrow on',
              )
            }
          >
            Save from tomorrow
          </button>
        </div>
      )}
    </li>
  );
}

const mins = (t: string) => {
  const [h, m] = t.split(':').map(Number) as [number, number];
  return h * 60 + m;
};

/** Same lead as before (mirrors server/services/tomorrow.ts shiftedReminder). */
function shift(due: string | null, reminder: string, next: string): string | null {
  if (!next) return reminder;
  const lead = due ? mins(due) - mins(reminder) : 0;
  const v = (((mins(next) - lead) % 1440) + 1440) % 1440;
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
}
