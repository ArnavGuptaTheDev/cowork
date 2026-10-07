import { useEffect, useState } from 'preact/hooks';
import { errorMessage, get, send } from '../lib/api';
import type { Comment } from '../lib/types';
import { Avatar, Icon, toast } from './ui';

function when(ms: number): string {
  const d = new Date(ms);
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/** A short thread on a todo. Owner and partner only; never shown on private todos. */
export function CommentThread({ todoId, onChanged }: { todoId: string; onChanged?: () => void }) {
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => get<{ comments: Comment[] }>(`/api/todos/${todoId}/comments`).then((r) => setComments(r.comments), () => setComments([]));
  useEffect(() => {
    void load();
  }, [todoId]);

  const post = async (e: Event) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    try {
      await send('POST', `/api/todos/${todoId}/comments`, { body: text.trim() });
      setText('');
      await load();
      onChanged?.();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (c: Comment) => {
    try {
      await send('DELETE', `/api/comments/${c.id}`);
      await load();
      onChanged?.();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  return (
    <div class="comments">
      {comments === null ? (
        <p class="faint">Loading…</p>
      ) : comments.length === 0 ? (
        <p class="faint">No comments yet.</p>
      ) : (
        <ul class="comment-list">
          {comments.map((c) => (
            <li key={c.id} class={`comment ${c.mine ? 'mine' : ''}`}>
              <Avatar name={c.authorName} url={c.authorAvatar} partner={!c.mine} />
              <div class="comment-body">
                <div class="comment-meta">
                  <strong>{c.mine ? 'You' : c.authorName}</strong> <span class="faint">{when(c.createdAt)}</span>
                </div>
                <p class="notes">{c.body}</p>
              </div>
              {c.mine && (
                <button type="button" class="icon-btn small" onClick={() => remove(c)}>
                  <Icon name="trash" label="Delete comment" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <form class="comment-form" onSubmit={post}>
        <label class="sr-only" for={`c-${todoId}`}>
          Add a comment
        </label>
        <input
          id={`c-${todoId}`}
          class="input grow"
          maxLength={1000}
          placeholder="Say something…"
          value={text}
          onInput={(e) => setText(e.currentTarget.value)}
        />
        <button type="submit" class="btn" disabled={busy || !text.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
