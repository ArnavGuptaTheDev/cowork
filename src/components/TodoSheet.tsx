import { useEffect, useState } from 'preact/hooks';
import { canReact, nudgeTarget } from '../../shared/authz';
import { REACTIONS } from '../../shared/constants';
import { describeRule } from '../../shared/recurrence';
import { addDays } from '../../shared/time';
import { errorMessage, get, send } from '../lib/api';
import { percent, prettyTime, relativeDay } from '../lib/format';
import { assigneeLabel, nameFor } from '../lib/people';
import type { DayItem, Photo, Stage, TodoDetail } from '../lib/types';
import { CommentThread } from './CommentThread';
import { PhotoButtons, PhotoGrid, uploadPhotos } from './PhotoPicker';
import { SubtaskList } from './SubtaskList';
import { StatusPanel } from './StatusPanel';
import { DeadlineBadge, PriorityMark } from './marks';
import { TimerPanel } from './TimerPanel';
import { TodoForm } from './TodoForm';
import { ErrorBox, Icon, Loading, Sheet, toast } from './ui';
import { useMe } from './useMe';

/**
 * Detail sheet for one todo. Owners (and partners, on shared todos) can edit and act on it;
 * partners can react to completions, nudge open todos and comment.
 */
export function TodoSheet(props: {
  todoId: string | null;
  instanceId?: string | null;
  /** The row the sheet was opened from, when there is one (for its reactions). */
  item?: DayItem | null;
  /** Its workflow status, when known (lists without a DayItem pass it separately). */
  stage?: Stage | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const me = useMe();
  const [detail, setDetail] = useState<TodoDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [myReaction, setMyReaction] = useState<string | null>(null);
  const [moveTo, setMoveTo] = useState('');

  const load = async () => {
    if (!props.todoId) return;
    try {
      setDetail(await get<TodoDetail>(`/api/todos/${props.todoId}`));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  useEffect(() => {
    setDetail(null);
    setEditing(false);
    setMoveTo('');
    setMyReaction(props.item?.reactions.find((r) => r.userId === me?.user.id)?.emoji ?? null);
    void load();
  }, [props.todoId, me?.user.id]);

  const open = !!props.todoId && !editing;
  const d = detail;
  const canEdit = !!d?.canEdit;
  const instanceId = props.instanceId ?? null;
  const todoPhotos = d?.photos.filter((p) => !p.instanceId) ?? [];
  const proofPhotos = d?.photos.filter((p) => p.instanceId) ?? [];
  const thisInstance = d?.instances.find((i) => i.id === instanceId);
  const oneOff = d?.todo.recurrence.type === 'none';

  const viewer = me ? { id: me.user.id, partnerId: me.partner?.id ?? null } : null;
  const ownerPartnerId = d && me ? (d.todo.ownerId === me.user.id ? (me.partner?.id ?? null) : me.user.id) : null;
  const authz = d
    ? {
        userId: d.todo.ownerId,
        isPrivate: d.todo.isPrivate,
        projectPrivate: !!d.project?.isPrivate,
        isShared: d.todo.isShared,
        assignedTo: d.todo.assignedTo,
      }
    : null;
  const reactable =
    !!viewer && !!authz && !!thisInstance && canReact(viewer, authz, ownerPartnerId, { status: thisInstance.status, completedBy: thisInstance.completedBy });
  const nudgeTo = viewer && authz && thisInstance ? nudgeTarget(viewer, authz, ownerPartnerId, { status: thisInstance.status }) : null;

  const addPhotos = async (files: File[], target: { todoId?: string; instanceId?: string }) => {
    setBusy(true);
    const added = await uploadPhotos(files, target);
    setBusy(false);
    if (added.length) {
      toast(added.length === 1 ? 'Photo added' : `${added.length} photos added`);
      await load();
      props.onChanged();
    }
  };

  const delPhoto = async (p: Photo) => {
    if (!confirm('Delete this photo?')) return;
    try {
      await send('DELETE', `/api/photos/${p.id}`);
      await load();
      props.onChanged();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const delTodo = async () => {
    if (!d || !confirm(`Delete "${d.todo.title}"? Its history and photos go too.`)) return;
    try {
      await send('DELETE', `/api/todos/${d.todo.id}`);
      toast('Deleted');
      props.onChanged();
      props.onClose();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const stopRepeating = async () => {
    if (!d) return;
    try {
      await send('PATCH', `/api/todos/${d.todo.id}`, { endDate: d.today < d.todo.startDate ? d.todo.startDate : d.today });
      toast('It won’t repeat after today');
      await load();
      props.onChanged();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const reschedule = async (date: string) => {
    if (!instanceId || !date) return;
    try {
      await send('POST', `/api/instances/${instanceId}/reschedule`, { date });
      toast(`Moved to ${relativeDay(date, d?.today ?? date).toLowerCase()}`);
      props.onChanged();
      props.onClose();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const react = async (emoji: string | null) => {
    if (!instanceId) return;
    const prev = myReaction;
    setMyReaction(emoji);
    try {
      await send('POST', `/api/instances/${instanceId}/react`, { emoji });
      props.onChanged();
    } catch (e) {
      setMyReaction(prev);
      toast(errorMessage(e), 'error');
    }
  };

  const nudge = async () => {
    if (!instanceId) return;
    try {
      await send('POST', `/api/instances/${instanceId}/nudge`);
      toast(`Nudged ${nameFor(me, nudgeTo)} 👋`);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  return (
    <>
      <Sheet
        open={open}
        onClose={props.onClose}
        title={d?.todo.title ?? 'Todo'}
        footer={
          d && (canEdit || d.isOwner) ? (
            <>
              {d.isOwner && (
                <button type="button" class="btn danger" onClick={delTodo}>
                  <Icon name="trash" /> Delete
                </button>
              )}
              <span class="spacer" />
              {canEdit && (
                <button type="button" class="btn ghost" onClick={() => setEditing(true)}>
                  <Icon name="edit" /> Edit
                </button>
              )}
            </>
          ) : undefined
        }
      >
        {error && <ErrorBox message={error} onRetry={load} />}
        {!d && !error && <Loading />}
        {d && (
          <div>
            <div class="row">
              <span class="chip">{d.todo.category}</span>
              {d.project && (
                <span class="chip">
                  <i class="dot" data-color={d.project.color} aria-hidden="true" />
                  {d.project.name}
                </span>
              )}
              {d.todo.recurrence.type !== 'none' && (
                <span class="chip sky">
                  <Icon name="repeat" />
                  {describeRule(d.todo.recurrence)}
                </span>
              )}
              {d.todo.isShared && (
                <span class="chip plum">
                  <Icon name="users" />
                  Shared · for {assigneeLabel(me, d.todo.assignedTo)}
                </span>
              )}
              {d.todo.isPrivate && <span class="chip ink">Private</span>}
              {d.todo.priority !== 2 && (
                <span class="chip">
                  <PriorityMark value={d.todo.priority} always /> priority
                </span>
              )}
              <DeadlineBadge deadline={d.todo.deadline} today={d.today} done={thisInstance?.status === 'done'} />
              {d.suggestedBy && <span class="chip plum">Suggested by {d.suggestedBy}</span>}
              {me && d.todo.ownerId !== me.user.id && <span class="chip">{nameFor(me, d.todo.ownerId)}'s</span>}
            </div>

            <ul class="history mt-4 list-plain">
              <li>
                <span class="muted">{oneOff ? 'Day' : 'Since'}</span>
                <span>{relativeDay(d.todo.startDate, d.today)}</span>
              </li>
              {d.todo.endDate && (
                <li>
                  <span class="muted">Until</span>
                  <span>{relativeDay(d.todo.endDate, d.today)}</span>
                </li>
              )}
              {d.todo.dueTime && (
                <li>
                  <span class="muted">Due</span>
                  <span>{prettyTime(d.todo.dueTime)}</span>
                </li>
              )}
              {d.todo.reminderTime && (
                <li>
                  <span class="muted">Reminder</span>
                  <span>{prettyTime(d.todo.reminderTime)}</span>
                </li>
              )}
              {thisInstance?.status === 'done' && thisInstance.completedBy && (
                <li>
                  <span class="muted">Done by</span>
                  <span>{nameFor(me, thisInstance.completedBy)}</span>
                </li>
              )}
            </ul>

            {d.todo.notes && <p class="mt-4 notes">{d.todo.notes}</p>}

            {(reactable || nudgeTo) && (
              <div class="card mt-4 partner-actions">
                {reactable && (
                  <div>
                    <p class="label">React</p>
                    <div class="emoji-row" role="group" aria-label="React">
                      {REACTIONS.map((e) => (
                        <button
                          key={e}
                          type="button"
                          class="emoji-btn"
                          aria-pressed={myReaction === e}
                          onClick={() => react(myReaction === e ? null : e)}
                        >
                          {e}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {nudgeTo && (
                  <button type="button" class="btn plum" onClick={nudge}>
                    <Icon name="hand" /> Nudge {nameFor(me, nudgeTo)}
                  </button>
                )}
              </div>
            )}

            {canEdit && oneOff && thisInstance && thisInstance.status !== 'done' && (
              <section class="section">
                <h3 class="section-title">Move it</h3>
                <div class="row">
                  <button type="button" class="btn ghost" onClick={() => reschedule(addDays(d.today, 1))}>
                    Tomorrow
                  </button>
                  <button type="button" class="btn ghost" onClick={() => reschedule(addDays(d.today, 7))}>
                    Next week
                  </button>
                  <label class="sr-only" for="move-date">
                    Pick a date
                  </label>
                  <input id="move-date" class="input date-input" type="date" min={d.today} value={moveTo} onInput={(e) => setMoveTo(e.currentTarget.value)} />
                  <button type="button" class="btn" disabled={!moveTo} onClick={() => reschedule(moveTo)}>
                    Move
                  </button>
                </div>
              </section>
            )}

            <StatusPanel
              todoId={d.todo.id}
              title={d.todo.title}
              instanceId={instanceId}
              stage={props.stage ?? props.item?.stage}
              canEdit={canEdit}
              onChanged={() => {
                void load();
                props.onChanged();
              }}
            />

            <SubtaskList todoId={d.todo.id} instanceId={instanceId} canEdit={canEdit} onChanged={props.onChanged} />

            {canEdit && <TimerPanel todoId={d.todo.id} />}

            {d.stats && (
              <div class="card mt-4">
                <div class="row">
                  <div class="streak">
                    {d.stats.currentStreak}
                    <small>streak</small>
                  </div>
                  <span class="spacer" />
                  <div class="faint">
                    Best {d.stats.bestStreak} · {percent(d.stats.completionRate)} last 30 days
                  </div>
                </div>
              </div>
            )}

            <section class="section">
              <h3 class="section-title">Photos</h3>
              <PhotoGrid photos={todoPhotos} onDelete={canEdit ? delPhoto : undefined} />
              {!todoPhotos.length && !canEdit && <p class="faint">No photos.</p>}
              {canEdit && (
                <div class="mt-2">
                  <PhotoButtons disabled={busy} onFiles={(f) => addPhotos(f, { todoId: d.todo.id })} />
                </div>
              )}
            </section>

            {(proofPhotos.length > 0 || (canEdit && thisInstance?.status === 'done')) && (
              <section class="section">
                <h3 class="section-title">
                  Proof &amp; progress <small>attached to completions</small>
                </h3>
                <PhotoGrid photos={proofPhotos} onDelete={canEdit ? delPhoto : undefined} />
                {canEdit && thisInstance?.status === 'done' && (
                  <div class="mt-2">
                    <PhotoButtons disabled={busy} onFiles={(f) => addPhotos(f, { instanceId: thisInstance.id })} />
                  </div>
                )}
              </section>
            )}

            {d.canComment && (
              <section class="section">
                <h3 class="section-title">Comments</h3>
                <CommentThread todoId={d.todo.id} onChanged={props.onChanged} />
              </section>
            )}

            {d.todo.recurrence.type !== 'none' && d.instances.length > 0 && (
              <section class="section">
                <h3 class="section-title">History</h3>
                <ul class="history list-plain">
                  {d.instances.slice(0, 14).map((i) => (
                    <li key={i.id}>
                      <span>{relativeDay(i.date, d.today)}</span>
                      <span class={`chip ${i.status === 'done' ? 'sage' : i.status === 'missed' ? 'missed' : i.status === 'paused' ? 'sky' : ''}`}>
                        {i.status}
                        {i.status === 'done' && i.completedBy && me && i.completedBy !== me.user.id ? ` · ${nameFor(me, i.completedBy)}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
                {d.isOwner && !d.todo.endDate && (
                  <button type="button" class="btn quiet mt-2" onClick={stopRepeating}>
                    Stop repeating after today
                  </button>
                )}
              </section>
            )}
          </div>
        )}
      </Sheet>
      {d && canEdit && (
        <TodoForm
          open={editing}
          mode="edit"
          today={d.today}
          todo={d.todo}
          onClose={() => setEditing(false)}
          onSaved={() => {
            void load();
            props.onChanged();
          }}
        />
      )}
    </>
  );
}
