import { useEffect, useState } from 'preact/hooks';
import { errorMessage, get, send } from '../lib/api';
import type { Stage, Status } from '../lib/types';
import { since, StageChip, useBlockerPrompt } from './marks';
import { toast } from './ui';

interface BlockerRow {
  id: string;
  note: string;
  blockedAt: number;
  resolvedAt: number | null;
  date: string | null;
  open: boolean;
}

function duration(ms: number): string {
  const h = Math.round(ms / 3600_000);
  if (h < 1) return 'under an hour';
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} days`;
}

/** Status picker for one occurrence, plus the todo's blocker history. */
export function StatusPanel(props: {
  todoId: string;
  title: string;
  instanceId: string | null;
  stage: Stage | null | undefined;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [statuses, setStatuses] = useState<Status[]>([]);
  const [current, setCurrent] = useState<Stage | null>(props.stage ?? null);
  const [history, setHistory] = useState<BlockerRow[]>([]);
  const prompt = useBlockerPrompt();

  const loadHistory = () => get<{ blockers: BlockerRow[] }>(`/api/todos/${props.todoId}/blockers`).then((r) => setHistory(r.blockers), () => undefined);
  useEffect(() => {
    setCurrent(props.stage ?? null);
    if (props.canEdit) get<{ statuses: Status[] }>(`/api/statuses?todoId=${props.todoId}`).then((r) => setStatuses(r.statuses), () => undefined);
    void loadHistory();
  }, [props.todoId, props.instanceId]);

  const choose = async (id: string) => {
    const target = statuses.find((s) => s.id === id);
    if (!target || !props.instanceId) return;
    let blocker: string | undefined;
    if (target.kind === 'blocked') {
      const note = await prompt.ask(props.title);
      if (note === null) return;
      blocker = note;
    }
    const prev = current;
    setCurrent(target);
    try {
      const r = await send<{ completed: boolean }>('POST', `/api/instances/${props.instanceId}/status`, { statusId: id, blocker });
      if (r.completed) toast('Done ✓');
      await loadHistory();
      props.onChanged();
    } catch (e) {
      setCurrent(prev);
      toast(errorMessage(e), 'error');
    }
  };

  const live = statuses.filter((s) => !s.archived || s.id === current?.id);
  const open = history.find((b) => b.open);

  return (
    <section class="section">
      <h3 class="section-title">Status</h3>
      {props.canEdit && props.instanceId && live.length > 0 ? (
        <div class="field">
          <label class="sr-only" for={`st-${props.todoId}`}>
            Status
          </label>
          <select id={`st-${props.todoId}`} class="select" value={current?.id ?? ''} onChange={(e) => choose(e.currentTarget.value)}>
            {!current && <option value="">Choose…</option>}
            {live.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <StageChip stage={current} />
      )}
      {open && (
        <p class="blocker-card mt-2">
          <strong>Waiting on:</strong> {open.note} <span class="faint">· {since(open.blockedAt)}</span>
        </p>
      )}
      {history.filter((b) => !b.open).length > 0 && (
        <details class="mt-2">
          <summary class="faint">Past blockers ({history.filter((b) => !b.open).length})</summary>
          <ul class="list-plain history">
            {history
              .filter((b) => !b.open)
              .map((b) => (
                <li key={b.id}>
                  <span>{b.note}</span>
                  <span class="faint">
                    {new Date(b.blockedAt).toLocaleDateString([], { day: 'numeric', month: 'short' })} · {duration((b.resolvedAt ?? b.blockedAt) - b.blockedAt)}
                  </span>
                </li>
              ))}
          </ul>
        </details>
      )}
      {prompt.element}
    </section>
  );
}
