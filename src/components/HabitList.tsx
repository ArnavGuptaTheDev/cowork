import { describeRule } from '../../shared/recurrence';
import { percent, shortDate } from '../lib/format';
import type { Habit } from '../lib/types';
import { Check, Icon } from './ui';

/** Habit cards: streak, completion rate and a 14-day strip. Used for your own habits and (read-only) your partner's. */
export function HabitList(props: { habits: Habit[]; readOnly?: boolean; onToggle?: (h: Habit) => void; onOpen?: (h: Habit) => void }) {
  return (
    <ul class="todo-list">
      {props.habits.map((h) => {
        const done = h.todayStatus === 'done';
        return (
          <li key={h.todoId} class="card habit" data-category={h.category}>
            <div class="habit-top">
              {h.todayInstanceId ? (
                <Check
                  checked={done}
                  label={`${done ? 'Mark not done' : 'Mark done'} today: ${h.title}`}
                  disabled={props.readOnly}
                  onToggle={() => props.onToggle?.(h)}
                />
              ) : (
                <span class="check" aria-hidden="true">
                  <Icon name="repeat" />
                </span>
              )}
              <button type="button" class="todo-body" onClick={() => props.onOpen?.(h)}>
                <div class="todo-title">{h.title}</div>
                <div class="todo-meta">
                  <span>{describeRule(h.recurrence)}</span>
                  {!h.todayInstanceId && !h.ended && <span>Not today</span>}
                  {h.ended && <span class="chip">Ended</span>}
                  {h.isPrivate && (
                    <span>
                      <Icon name="lock" /> Private
                    </span>
                  )}
                </div>
              </button>
              <div class="streak" title="Current streak">
                <Icon name="flame" class="streak-icon" />
                {h.stats.currentStreak}
                <span class="sr-only"> in a row</span>
              </div>
            </div>
            <div class="strip" role="img" aria-label={stripLabel(h)}>
              {h.recent.map((r) => (
                <i key={r.date} data-s={r.status ?? 'none'} title={`${shortDate(r.date)}: ${r.status ?? 'not scheduled'}`} />
              ))}
            </div>
            <div class="row faint">
              <span>{percent(h.stats.completionRate)} last 30 days</span>
              <span>· best streak {h.stats.bestStreak}</span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function stripLabel(h: Habit): string {
  const done = h.recent.filter((r) => r.status === 'done').length;
  const scheduled = h.recent.filter((r) => r.status !== null).length;
  return `Last 14 days: ${done} of ${scheduled} scheduled days done`;
}
