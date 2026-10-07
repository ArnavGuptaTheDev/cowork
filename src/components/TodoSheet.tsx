import { useEffect, useState } from 'preact/hooks';
import { describeRule } from '../../shared/recurrence';
import { errorMessage, get, send } from '../lib/api';
import { percent, prettyTime, relativeDay } from '../lib/format';
import type { Photo, TodoDetail } from '../lib/types';
import { PhotoButtons, PhotoGrid, uploadPhotos } from './PhotoPicker';
import { TodoForm } from './TodoForm';
import { ErrorBox, Icon, Loading, Sheet, toast } from './ui';

/** Detail sheet for one todo. Owners can edit, delete and add photos; partners get a read-only view. */
export function TodoSheet(props: { todoId: string | null; instanceId?: string | null; onClose: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<TodoDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

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
    void load();
  }, [props.todoId]);

  const open = !!props.todoId && !editing;
  const d = detail;
  const canEdit = !!d?.canEdit;
  const instanceId = props.instanceId ?? null;
  const todoPhotos = d?.photos.filter((p) => !p.instanceId) ?? [];
  const proofPhotos = d?.photos.filter((p) => p.instanceId) ?? [];
  const thisInstance = d?.instances.find((i) => i.id === instanceId);

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

  return (
    <>
      <Sheet
        open={open}
        onClose={props.onClose}
        title={d?.todo.title ?? 'Todo'}
        footer={
          canEdit && d ? (
            <>
              <button type="button" class="btn danger" onClick={delTodo}>
                <Icon name="trash" /> Delete
              </button>
              <span class="spacer" />
              <button type="button" class="btn ghost" onClick={() => setEditing(true)}>
                <Icon name="edit" /> Edit
              </button>
            </>
          ) : undefined
        }
      >
        {error && <ErrorBox message={error} onRetry={load} />}
        {!d && !error && <Loading />}
        {d && (
          <div>
            <div class="row">
              <span class="chip" data-cat={d.todo.category}>
                {d.todo.category}
              </span>
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
              {d.todo.isPrivate && <span class="chip ink">Private</span>}
              {d.suggestedBy && <span class="chip plum">Suggested by {d.suggestedBy}</span>}
            </div>

            <ul class="history mt-4 list-plain">
              <li>
                <span class="muted">{d.todo.recurrence.type === 'none' ? 'Day' : 'Since'}</span>
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
            </ul>

            {d.todo.notes && <p class="mt-4 notes">{d.todo.notes}</p>}

            {d.stats && (
              <div class="card mt-4">
                <div class="row">
                  <div>
                    <div class="streak">
                      {d.stats.currentStreak}
                      <small>streak</small>
                    </div>
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
              {canEdit && <div class="mt-2"><PhotoButtons disabled={busy} onFiles={(f) => addPhotos(f, { todoId: d.todo.id })} /></div>}
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

            {d.todo.recurrence.type !== 'none' && d.instances.length > 0 && (
              <section class="section">
                <h3 class="section-title">History</h3>
                <ul class="history list-plain">
                  {d.instances.slice(0, 14).map((i) => (
                    <li key={i.id}>
                      <span>{relativeDay(i.date, d.today)}</span>
                      <span class={`chip ${i.status === 'done' ? 'sage' : i.status === 'missed' ? 'missed' : ''}`}>{i.status}</span>
                    </li>
                  ))}
                </ul>
                {canEdit && !d.todo.endDate && (
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
