import { useEffect, useState } from 'preact/hooks';
import { STATUS_COLORS, STATUS_KINDS, type StatusKind } from '../../shared/constants';
import { errorMessage, get, send } from '../lib/api';
import type { Status } from '../lib/types';
import { Icon, toast } from './ui';

const KIND_LABEL: Record<StatusKind, string> = {
  todo: 'Not started',
  active: 'In progress',
  blocked: 'Blocked',
  done: 'Done',
};

/** Add, rename, recolour, reorder and archive your workflow statuses. */
export function StatusSettings() {
  const [list, setList] = useState<Status[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<StatusKind>('active');
  const [busy, setBusy] = useState(false);

  const load = () => get<{ statuses: Status[] }>('/api/statuses').then((r) => setList(r.statuses), (e) => toast(errorMessage(e), 'error'));
  useEffect(() => {
    void load();
  }, []);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!list) return null;
  const live = list.filter((s) => !s.archived);
  const archived = list.filter((s) => s.archived);

  const reorder = (id: string, dir: -1 | 1) => {
    const ids = list.map((s) => s.id);
    const liveIds = live.map((s) => s.id);
    const i = liveIds.indexOf(id);
    const j = i + dir;
    if (j < 0 || j >= liveIds.length) return;
    [liveIds[i], liveIds[j]] = [liveIds[j]!, liveIds[i]!];
    // Archived ones keep their place at the end.
    const order = [...liveIds, ...ids.filter((x) => !liveIds.includes(x))];
    setList(order.map((x) => list.find((s) => s.id === x)!));
    void run(() => send('POST', '/api/statuses/order', { ids: order }));
  };

  const rename = (s: Status, value: string) => {
    const v = value.trim();
    if (!v || v === s.name) return;
    void run(() => send('PATCH', `/api/statuses/${s.id}`, { name: v }));
  };

  const row = (s: Status, i: number) => (
    <li key={s.id} class="status-row">
      <span class="stage" data-color={s.color} data-kind={s.kind}>
        <i aria-hidden="true" />
      </span>
      <input
        class="input small"
        aria-label={`Name of ${s.name}`}
        value={s.name}
        maxLength={30}
        disabled={busy || s.archived}
        onBlur={(e) => rename(s, e.currentTarget.value)}
        onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
      />
      <span class="faint status-kind">
        {KIND_LABEL[s.kind]}
        {s.isDefault && ' · default'}
        {!!s.inUse && ` · ${s.inUse} in use`}
      </span>
      <select
        class="select small"
        aria-label={`Colour of ${s.name}`}
        value={s.color}
        disabled={busy}
        onChange={(e) => void run(() => send('PATCH', `/api/statuses/${s.id}`, { color: e.currentTarget.value }))}
      >
        {STATUS_COLORS.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <span class="status-actions">
        {!s.archived && (
          <>
            <button type="button" class="icon-btn small" disabled={busy || i === 0} onClick={() => reorder(s.id, -1)} aria-label={`Move ${s.name} up`}>
              <Icon name="left" class="rot90" />
            </button>
            <button type="button" class="icon-btn small" disabled={busy || i === live.length - 1} onClick={() => reorder(s.id, 1)} aria-label={`Move ${s.name} down`}>
              <Icon name="right" class="rot90" />
            </button>
            {!s.isDefault && (
              <button type="button" class="btn quiet small" disabled={busy} onClick={() => void run(() => send('PATCH', `/api/statuses/${s.id}`, { isDefault: true }))}>
                Make default
              </button>
            )}
          </>
        )}
        <button
          type="button"
          class="btn quiet small"
          disabled={busy}
          onClick={() => void run(() => send('PATCH', `/api/statuses/${s.id}`, { archived: !s.archived }))}
        >
          {s.archived ? 'Restore' : 'Archive'}
        </button>
        {!s.inUse && (
          <button
            type="button"
            class="icon-btn small"
            disabled={busy}
            aria-label={`Delete ${s.name}`}
            onClick={() => {
              if (confirm(`Delete “${s.name}”?`)) void run(() => send('DELETE', `/api/statuses/${s.id}`));
            }}
          >
            <Icon name="trash" />
          </button>
        )}
      </span>
    </li>
  );

  return (
    <section class="section card" aria-labelledby="statuses-title">
      <h2 class="section-title" id="statuses-title">
        Statuses
      </h2>
      <p class="faint mb-4">
        The columns on your boards. A status in use can be archived but not deleted. You always keep one “to do” and one “done”, and the
        defaults are what the checkbox uses.
      </p>
      <ul class="list-plain status-list">{live.map(row)}</ul>
      {archived.length > 0 && (
        <details class="mt-2" open={showArchived} onToggle={(e) => setShowArchived((e.currentTarget as HTMLDetailsElement).open)}>
          <summary class="faint">Archived ({archived.length})</summary>
          <ul class="list-plain status-list">{archived.map(row)}</ul>
        </details>
      )}
      <form
        class="row mt-4 status-add"
        onSubmit={(e) => {
          e.preventDefault();
          const n = name.trim();
          if (!n) return;
          void run(async () => {
            await send('POST', '/api/statuses', { name: n, kind, color: kind === 'blocked' ? 'clay' : kind === 'done' ? 'sage' : 'sky' });
            setName('');
          });
        }}
      >
        <input class="input" placeholder="New status, e.g. Review" aria-label="New status name" maxLength={30} value={name} onInput={(e) => setName(e.currentTarget.value)} />
        <select class="select" aria-label="Kind" value={kind} onChange={(e) => setKind(e.currentTarget.value as StatusKind)}>
          {STATUS_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <button type="submit" class="btn" disabled={busy || !name.trim()}>
          <Icon name="plus" /> Add
        </button>
      </form>
    </section>
  );
}
