import { describeRule } from '../../shared/recurrence';
import { prettyTime, relativeDay } from '../lib/format';
import { assigneeLabel, nameFor } from '../lib/people';
import type { DayItem } from '../lib/types';
import { Check, Icon } from './ui';
import { useMe } from './useMe';

export function TodoItem(props: {
  item: DayItem;
  today: string;
  /** Force read-only (otherwise the item's own canEdit decides). */
  readOnly?: boolean;
  onToggle?: (item: DayItem) => void;
  onOpen?: (item: DayItem) => void;
  /** Calendar: allow dragging this item to another day. */
  draggable?: boolean;
}) {
  const { item } = props;
  const me = useMe();
  const done = item.status === 'done';
  const missed = item.status === 'missed';
  const upcoming = item.status === 'upcoming';
  const paused = item.status === 'paused';
  const recurring = item.recurrence.type !== 'none';
  const canToggle = !props.readOnly && item.canEdit && !!item.instanceId && !upcoming && !paused;
  const byPartner = done && item.completedBy && me && item.completedBy !== me.user.id && item.completedBy !== item.ownerId;
  const theirs = me && item.ownerId !== me.user.id;
  return (
    <li
      class={`todo ${done ? 'is-done' : ''} ${missed ? 'is-missed' : ''} ${paused ? 'is-paused' : ''} ${item.isShared ? 'is-shared' : ''}`}
      data-category={item.category}
      draggable={props.draggable}
      onDragStart={
        props.draggable
          ? (e) => {
              e.dataTransfer?.setData('text/cowork-instance', item.instanceId ?? '');
              if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
            }
          : undefined
      }
    >
      <Check
        checked={done}
        label={`${done ? 'Mark not done' : 'Mark done'}: ${item.title}`}
        disabled={!canToggle}
        variant={missed ? 'missed' : upcoming || paused ? 'upcoming' : undefined}
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
          {item.isShared && (
            <span class="chip plum">
              <Icon name="users" />
              {theirs ? `${nameFor(me, item.ownerId)}'s · ` : ''}for {assigneeLabel(me, item.assignedTo)}
            </span>
          )}
          {item.carriedOverFrom && <span class="chip clay">From {relativeDay(item.carriedOverFrom, props.today).toLowerCase()}</span>}
          {missed && <span class="chip missed">Missed</span>}
          {paused && <span class="chip sky">Paused</span>}
          {byPartner && <span class="chip sage">✓ by {nameFor(me, item.completedBy)}</span>}
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
          {item.commentCount > 0 && (
            <span>
              <Icon name="chat" />
              {item.commentCount}
              <span class="sr-only"> comments</span>
            </span>
          )}
          {item.subtasks && item.subtasks.total > 0 && (
            <span>
              <Icon name="list" />
              {item.subtasks.done}/{item.subtasks.total}
            </span>
          )}
        </div>
        {item.reactions.length > 0 && (
          <div class="reactions" aria-label={item.reactions.map((r) => `${nameFor(me, r.userId)} reacted ${r.emoji}`).join(', ')}>
            {item.reactions.map((r) => (
              <span key={r.userId} class="reaction" aria-hidden="true">
                {r.emoji}
              </span>
            ))}
          </div>
        )}
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
