import { describeRule } from '../../shared/recurrence';
import { prettyTime, relativeDay } from '../lib/format';
import type { DayItem } from '../lib/types';
import { Check, Icon } from './ui';

export function TodoItem(props: {
  item: DayItem;
  today: string;
  readOnly?: boolean;
  onToggle?: (item: DayItem) => void;
  onOpen?: (item: DayItem) => void;
}) {
  const { item } = props;
  const done = item.status === 'done';
  const missed = item.status === 'missed';
  const upcoming = item.status === 'upcoming';
  const recurring = item.recurrence.type !== 'none';
  const canToggle = !props.readOnly && !!item.instanceId && !upcoming;
  return (
    <li class={`todo ${done ? 'is-done' : ''} ${missed ? 'is-missed' : ''}`} data-category={item.category}>
      <Check
        checked={done}
        label={`${done ? 'Mark not done' : 'Mark done'}: ${item.title}`}
        disabled={!canToggle}
        variant={missed ? 'missed' : upcoming ? 'upcoming' : undefined}
        onToggle={canToggle ? () => props.onToggle?.(item) : undefined}
      />
      <button type="button" class="todo-body" onClick={() => props.onOpen?.(item)} disabled={!props.onOpen}>
        <div class="todo-title">{item.title}</div>
        <div class="todo-meta">
          {item.dueTime && (
            <span>
              <Icon name="clock" />
              {prettyTime(item.dueTime)}
            </span>
          )}
          {item.reminderTime && !done && (
            <span>
              <Icon name="bell" />
              <span class="sr-only">Reminder at</span>
              {prettyTime(item.reminderTime)}
            </span>
          )}
          {recurring && (
            <span>
              <Icon name="repeat" />
              {describeRule(item.recurrence)}
            </span>
          )}
          {item.project && (
            <span>
              <i class="dot" data-color={item.project.color} aria-hidden="true" />
              {item.project.name}
            </span>
          )}
          {item.carriedOverFrom && <span class="chip clay">From {relativeDay(item.carriedOverFrom, props.today).toLowerCase()}</span>}
          {missed && <span class="chip missed">Missed</span>}
          {item.isPrivate && (
            <span>
              <Icon name="lock" />
              Private
            </span>
          )}
          {item.suggestedBy && (
            <span>
              <Icon name="heart" />
              Suggested
            </span>
          )}
          {item.photoCount > 0 && (
            <span>
              <Icon name="image" />
              {item.photoCount}
            </span>
          )}
        </div>
      </button>
      {item.streak !== null && item.streak > 0 ? (
        <span class="chip honey" title="Current streak">
          <Icon name="flame" />
          {item.streak}
          <span class="sr-only"> day streak</span>
        </span>
      ) : (
        <span />
      )}
    </li>
  );
}
