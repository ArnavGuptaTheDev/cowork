// Small markers shared by rows, cards and sheets: priority, deadline state, workflow status, blocker.
import { useState } from 'preact/hooks';
import { deadlineState } from '../../shared/deadline';
import type { Deadline, Stage } from '../lib/types';
import { Icon, Sheet } from './ui';

export const PRIORITY_LABELS = ['', 'Low', 'Medium', 'High', 'Urgent'];

/** A small priority marker. Medium (the default) stays quiet unless `always` is set. */
export function PriorityMark({ value, always = false }: { value: number; always?: boolean }) {
  if (value === 2 && !always) return null;
  return (
    <span class={`prio prio-${value}`} title={`${PRIORITY_LABELS[value]} priority`}>
      <span aria-hidden="true">{'!'.repeat(Math.max(1, value - 1))}</span>
      <span class="sr-only">{PRIORITY_LABELS[value]} priority</span>
    </span>
  );
}

function nowTime(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "Due in N days" / "Due today" / "Overdue", weighted by urgency. Done items show it quietly. */
export function DeadlineBadge({ deadline, today, done = false }: { deadline: Deadline | null; today: string; done?: boolean }) {
  if (!deadline) return null;
  const s = deadlineState(deadline.date, deadline.time, today, nowTime());
  return (
    <span class={`deadline dl-${done ? 'done' : s.kind}`} title={`Deadline ${deadline.date}${deadline.time ? ` ${deadline.time}` : ''}`}>
      <Icon name="target" />
      {done ? `Deadline ${deadline.date.slice(5)}` : s.label}
    </span>
  );
}

export function StageChip({ stage }: { stage: Stage | null }) {
  if (!stage) return null;
  return (
    <span class="stage" data-color={stage.color} data-kind={stage.kind}>
      <i aria-hidden="true" />
      {stage.name}
    </span>
  );
}

/** "3d", "5h", "12m" since a timestamp. */
export function since(ms: number, now = Date.now()): string {
  const min = Math.max(0, Math.floor((now - ms) / 60_000));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function BlockerLine({ blocker }: { blocker: { note: string; since: number } | null }) {
  if (!blocker) return null;
  return (
    <span class="blocker-line" title={`Blocked since ${new Date(blocker.since).toLocaleString()}`}>
      <Icon name="pause" />
      <span class="blocker-text">{blocker.note}</span>
      <span class="blocker-age">· {since(blocker.since)}</span>
    </span>
  );
}

/**
 * Asks what a todo is waiting on before it moves to a blocked status. Resolves with the note, or null if cancelled.
 */
export function useBlockerPrompt() {
  const [pending, setPending] = useState<{ title: string; resolve: (v: string | null) => void } | null>(null);
  const [note, setNote] = useState('');
  const ask = (title: string) =>
    new Promise<string | null>((resolve) => {
      setNote('');
      setPending({ title, resolve });
    });
  const finish = (v: string | null) => {
    pending?.resolve(v);
    setPending(null);
  };
  const element = (
    <Sheet
      open={!!pending}
      onClose={() => finish(null)}
      title="What is it waiting on?"
      footer={
        <>
          <button type="button" class="btn quiet" onClick={() => finish(null)}>
            Cancel
          </button>
          <button type="submit" form="blocker-form" class="btn" disabled={!note.trim()}>
            Mark blocked
          </button>
        </>
      }
    >
      <form
        id="blocker-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (note.trim()) finish(note.trim());
        }}
      >
        {pending && <p class="faint">{pending.title}</p>}
        <label class="label mt-2" for="blocker-note">
          Blocker
        </label>
        <input
          id="blocker-note"
          class="input"
          maxLength={300}
          placeholder="e.g. Waiting on design feedback"
          value={note}
          onInput={(e) => setNote(e.currentTarget.value)}
          autoFocus
        />
      </form>
    </Sheet>
  );
  return { ask, element };
}
