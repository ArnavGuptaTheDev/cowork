import { useEffect, useState } from 'preact/hooks';
import { errorMessage, get, getMe, send } from '../lib/api';
import { Icon, toast } from './ui';

interface Entry {
  id: string;
  startedAt: number;
  endedAt: number | null;
  note: string;
  mine: boolean;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

function minutesLabel(min: number): string {
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)}h ${min % 60}m`;
}

/** "YYYY-MM-DDTHH:MM" in local time for <input type="datetime-local">. */
function toLocalInput(ms: number): string {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

/** Start/stop timer and time entries for one todo. The running start lives on the server, so reloads are fine. */
export function TimerPanel({ todoId }: { todoId: string }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [total, setTotal] = useState(0);
  const [running, setRunning] = useState<{ todoId: string; startedAt: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [editing, setEditing] = useState<Entry | null>(null);
  const [adding, setAdding] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const load = async () => {
    const [t, timer] = await Promise.all([
      get<{ entries: Entry[]; totalMinutes: number }>(`/api/todos/${todoId}/time`),
      get<{ timer: { todoId: string; startedAt: number } | null }>('/api/timer'),
    ]);
    setEntries(t.entries);
    setTotal(t.totalMinutes);
    setRunning(timer.timer);
  };
  useEffect(() => {
    load().catch(() => undefined);
  }, [todoId]);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load();
      await getMe(true);
      window.dispatchEvent(new Event('cowork:timer'));
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const here = running?.todoId === todoId;
  const elsewhere = running && !here;

  return (
    <section class="section">
      <h3 class="section-title">
        Time <small>{total ? minutesLabel(total) : 'none yet'}</small>
      </h3>
      <div class="row">
        {here ? (
          <button type="button" class="btn" onClick={() => act(() => send('POST', '/api/timer/stop'))}>
            <Icon name="pause" /> Stop · {formatDuration(now - running!.startedAt)}
          </button>
        ) : (
          <button type="button" class="btn ghost" onClick={() => act(() => send('POST', `/api/todos/${todoId}/timer/start`))}>
            <Icon name="play" /> {elsewhere ? 'Switch timer here' : 'Start timer'}
          </button>
        )}
        <button
          type="button"
          class="btn quiet small"
          aria-expanded={adding}
          onClick={() => {
            setAdding(!adding);
            setEditing(null);
            setFrom(toLocalInput(Date.now() - 3600_000));
            setTo(toLocalInput(Date.now()));
          }}
        >
          Add time
        </button>
      </div>
      {(adding || editing) && (
        <form
          class="time-form mt-2"
          onSubmit={(e) => {
            e.preventDefault();
            const startedAt = new Date(from).getTime();
            const endedAt = new Date(to).getTime();
            void act(async () => {
              if (editing) await send('PATCH', `/api/time-entries/${editing.id}`, { startedAt, endedAt });
              else await send('POST', `/api/todos/${todoId}/time`, { startedAt, endedAt });
              setAdding(false);
              setEditing(null);
            });
          }}
        >
          <label class="field">
            <span class="label">From</span>
            <input class="input" type="datetime-local" value={from} onInput={(e) => setFrom(e.currentTarget.value)} required />
          </label>
          <label class="field">
            <span class="label">To</span>
            <input class="input" type="datetime-local" value={to} onInput={(e) => setTo(e.currentTarget.value)} required />
          </label>
          <button type="submit" class="btn small">
            {editing ? 'Save' : 'Add'}
          </button>
        </form>
      )}
      {entries.length > 0 && (
        <ul class="list-plain time-entries mt-2">
          {entries.slice(0, 8).map((e) => (
            <li key={e.id} class="row">
              <span class="grow">
                {new Date(e.startedAt).toLocaleDateString([], { day: 'numeric', month: 'short' })} ·{' '}
                {new Date(e.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                {!e.mine && <span class="faint"> · partner</span>}
              </span>
              <span class="faint">{e.endedAt ? formatDuration(e.endedAt - e.startedAt) : 'running'}</span>
              {e.mine && e.endedAt && (
                <>
                  <button
                    type="button"
                    class="icon-btn small"
                    onClick={() => {
                      setEditing(e);
                      setAdding(false);
                      setFrom(toLocalInput(e.startedAt));
                      setTo(toLocalInput(e.endedAt!));
                    }}
                  >
                    <Icon name="edit" label="Edit entry" />
                  </button>
                  <button type="button" class="icon-btn small" onClick={() => act(() => send('DELETE', `/api/time-entries/${e.id}`))}>
                    <Icon name="trash" label="Delete entry" />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
