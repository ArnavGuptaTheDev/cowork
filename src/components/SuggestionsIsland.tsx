import { useEffect, useState } from 'preact/hooks';
import { describeRule } from '../../shared/recurrence';
import { copy } from '../content/copy';
import { errorMessage, get, getMe, send } from '../lib/api';
import { prettyTime, relativeDay } from '../lib/format';
import type { Me, Project, Suggestion } from '../lib/types';
import { PhotoGrid } from './PhotoPicker';
import { TodoForm } from './TodoForm';
import { ErrorBox, Icon, Loading, Sheet, Toasts, toast, useLoad } from './ui';

const STATUS_CHIP: Record<Suggestion['status'], string> = {
  pending: 'honey',
  accepted: 'sage',
  denied: 'missed',
  withdrawn: '',
};

export default function SuggestionsIsland() {
  const [suggesting, setSuggesting] = useState(false);
  const [accepting, setAccepting] = useState<Suggestion | null>(null);
  const [denying, setDenying] = useState<Suggestion | null>(null);
  const state = useLoad(async () => {
    const [me, list] = await Promise.all([getMe(), get<{ incoming: Suggestion[]; outgoing: Suggestion[] }>('/api/suggestions')]);
    return { me, ...list };
  });

  if (state.loading && !state.data) return <Loading />;
  if (state.error || !state.data) return <ErrorBox message={state.error ?? 'Could not load'} onRetry={state.reload} />;
  const { me, incoming, outgoing } = state.data as { me: Me; incoming: Suggestion[]; outgoing: Suggestion[] };
  const pending = incoming.filter((s) => s.status === 'pending');
  const answered = incoming.filter((s) => s.status !== 'pending');

  const withdraw = async (s: Suggestion) => {
    try {
      await send('POST', `/api/suggestions/${s.id}/withdraw`, {});
      await state.reload();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  return (
    <>
      <header class="page-head">
        <div>
          <p class="eyebrow">Between you two</p>
          <h1 class="page-title">Suggestions</h1>
        </div>
        {me.partner && (
          <button type="button" class="btn plum" onClick={() => setSuggesting(true)}>
            <Icon name="heart" /> Suggest
          </button>
        )}
      </header>

      <section class="section">
        <h2 class="section-title">
          For you <small>{pending.length} waiting</small>
        </h2>
        {pending.length === 0 && <p class="faint">{copy.suggestions.emptyIn}</p>}
        <ul class="todo-list">
          {pending.map((s) => (
            <SuggestionCard key={s.id} s={s} today={me.today}>
              <button type="button" class="btn" onClick={() => setAccepting(s)}>
                <Icon name="check" /> Accept
              </button>
              <button type="button" class="btn ghost" onClick={() => setDenying(s)}>
                Not now
              </button>
            </SuggestionCard>
          ))}
        </ul>
      </section>

      <section class="section">
        <h2 class="section-title">From you</h2>
        {outgoing.length === 0 && <p class="faint">{copy.suggestions.emptyOut}</p>}
        <ul class="todo-list">
          {outgoing.map((s) => (
            <SuggestionCard key={s.id} s={s} today={me.today} outgoing>
              {s.status === 'pending' && (
                <button type="button" class="btn quiet" onClick={() => withdraw(s)}>
                  Withdraw
                </button>
              )}
            </SuggestionCard>
          ))}
        </ul>
      </section>

      {answered.length > 0 && (
        <section class="section">
          <h2 class="section-title">Answered</h2>
          <ul class="todo-list">
            {answered.map((s) => (
              <SuggestionCard key={s.id} s={s} today={me.today} />
            ))}
          </ul>
        </section>
      )}

      <AcceptSheet s={accepting} onClose={() => setAccepting(null)} onDone={state.reload} />
      <DenySheet s={denying} onClose={() => setDenying(null)} onDone={state.reload} />
      {me.partner && (
        <TodoForm open={suggesting} mode="suggest" today={me.today} partnerName={me.partner.name.split(' ')[0]} onClose={() => setSuggesting(false)} onSaved={state.reload} />
      )}
      <Toasts />
    </>
  );
}

function SuggestionCard({ s, today, outgoing, children }: { s: Suggestion; today: string; outgoing?: boolean; children?: preact.ComponentChildren }) {
  return (
    <li class="card suggestion">
      <div class="row">
        <span class={`chip ${STATUS_CHIP[s.status]}`}>{s.status}</span>
        <span class="faint">{outgoing ? `To ${s.to.name}` : `From ${s.from.name}`}</span>
      </div>
      <h3 class="mt-2">{s.title}</h3>
      <div class="todo-meta">
        <span>{relativeDay(s.startDate, today)}</span>
        {s.recurrence.type !== 'none' && (
          <span>
            <Icon name="repeat" />
            {describeRule(s.recurrence)}
          </span>
        )}
        {s.dueTime && (
          <span>
            <Icon name="clock" />
            {prettyTime(s.dueTime)}
          </span>
        )}
        <span>{s.category}</span>
      </div>
      {s.notes && <p class="notes mt-2 muted">{s.notes}</p>}
      {s.photos.length > 0 && (
        <div class="mt-2">
          <PhotoGrid photos={s.photos} />
        </div>
      )}
      {s.status === 'denied' && s.reason && <p class="quote">“{s.reason}”</p>}
      {children && <div class="actions">{children}</div>}
    </li>
  );
}

function AcceptSheet({ s, onClose, onDone }: { s: Suggestion | null; onClose: () => void; onDone: () => void }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectId, setProjectId] = useState('');
  const [isPrivate, setPrivate] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (s && projects === null) get<{ projects: Project[] }>('/api/projects').then((r) => setProjects(r.projects), () => setProjects([]));
  }, [s]);
  const accept = async () => {
    if (!s) return;
    setBusy(true);
    try {
      await send('POST', `/api/suggestions/${s.id}/accept`, { projectId: projectId || null, isPrivate });
      toast('Added to your list');
      onDone();
      onClose();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={!!s}
      onClose={onClose}
      title="Accept suggestion"
      footer={
        <>
          <button type="button" class="btn quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="button" class="btn" onClick={accept} disabled={busy}>
            Add to my list
          </button>
        </>
      }
    >
      {s && (
        <>
          <p>
            <strong>{s.title}</strong> goes on your list, marked as suggested by {s.from.name}.
          </p>
          <div class="field mt-4">
            <label class="label" for="acc-project">
              Project
            </label>
            <select id="acc-project" class="select" value={projectId} onChange={(e) => setProjectId(e.currentTarget.value)}>
              <option value="">No project</option>
              {(projects ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <label class="switch mt-4">
            <span>Keep it private</span>
            <input type="checkbox" role="switch" checked={isPrivate} onChange={(e) => setPrivate(e.currentTarget.checked)} />
          </label>
        </>
      )}
    </Sheet>
  );
}

function DenySheet({ s, onClose, onDone }: { s: Suggestion | null; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const deny = async () => {
    if (!s) return;
    setBusy(true);
    try {
      await send('POST', `/api/suggestions/${s.id}/deny`, { reason });
      toast(`Let ${s.from.name} know`);
      setReason('');
      onDone();
      onClose();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={!!s}
      onClose={onClose}
      title="Pass on this one?"
      footer={
        <>
          <button type="button" class="btn quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="button" class="btn danger" onClick={deny} disabled={busy}>
            Decline
          </button>
        </>
      }
    >
      {s && (
        <div class="field">
          <label class="label" for="deny-reason">
            Reason for {s.from.name} <span class="faint">(optional)</span>
          </label>
          <textarea id="deny-reason" class="textarea" maxLength={500} value={reason} onInput={(e) => setReason(e.currentTarget.value)} placeholder="Too much on this week…" />
        </div>
      )}
    </Sheet>
  );
}
