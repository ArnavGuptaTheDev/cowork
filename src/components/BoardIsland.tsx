import { Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { errorMessage, get, getMe, send } from '../lib/api';
import { assigneeLabel } from '../lib/people';
import type { Board, BoardCard, Me } from '../lib/types';
import { BlockerLine, DeadlineBadge, PriorityMark, useBlockerPrompt } from './marks';
import { TodoSheet } from './TodoSheet';
import { Empty, ErrorBox, Icon, Loading, Sheet, Toasts, toast } from './ui';

type Cat = '' | 'personal' | 'work' | 'habit';

/** Where a dragged card would land. */
interface Target {
  columnId: string;
  index: number;
}

const LONG_PRESS_MS = 320;
const MOVE_SLOP = 8;
const EDGE = 56;

function readParams() {
  const p = new URLSearchParams(location.search);
  return { project: p.get('project'), category: (p.get('category') ?? '') as Cat };
}

/** Cards of one column, in board order. */
const inColumn = (cards: BoardCard[], columnId: string) => cards.filter((c) => c.columnId === columnId);

export default function BoardIsland() {
  const [params, setParams] = useState<{ project: string | null; category: Cat } | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<BoardCard | null>(null);
  const [menuFor, setMenuFor] = useState<BoardCard | null>(null);
  const [drag, setDrag] = useState<{ card: BoardCard; x: number; y: number; w: number; dx: number; dy: number; target: Target | null } | null>(null);
  const prompt = useBlockerPrompt();
  const scroller = useRef<HTMLDivElement>(null);
  // Mirrors `drag` for the window listeners, and swallows the click that ends a drag.
  const dragRef = useRef<typeof drag>(null);
  dragRef.current = drag;
  const justDragged = useRef(false);

  useEffect(() => {
    setParams(readParams());
    getMe().then(setMe, () => undefined);
  }, []);

  const load = async () => {
    if (!params) return;
    try {
      const q = params.project ? `projectId=${params.project}` : params.category ? `category=${params.category}` : '';
      setBoard(await get<Board>(`/api/board${q ? `?${q}` : ''}`));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  useEffect(() => {
    void load();
  }, [params?.project, params?.category]);

  // ---- moving a card (shared by drag-and-drop and the "Move to" menu) ----
  const move = async (card: BoardCard, target: Target) => {
    if (!board) return;
    const column = board.columns.find((c) => c.id === target.columnId);
    if (!column) return;
    const others = inColumn(board.cards, target.columnId).filter((c) => c.todoId !== card.todoId);
    const index = Math.max(0, Math.min(target.index, others.length));
    const sameColumn = card.columnId === target.columnId;
    const oldIndex = inColumn(board.cards, card.columnId ?? '').findIndex((c) => c.todoId === card.todoId);
    if (sameColumn && index === oldIndex) return;

    let blocker: string | undefined;
    if (!sameColumn && column.kind === 'blocked') {
      const note = await prompt.ask(card.title);
      if (note === null) return; // cancelled: the card stays where it was
      blocker = note;
    }
    const before = others[index - 1] ?? null;
    const after = others[index] ?? null;

    // Optimistic: move it locally first, roll back on failure.
    const snapshot = board;
    const moved: BoardCard = {
      ...card,
      columnId: target.columnId,
      stage: sameColumn ? card.stage : { id: column.id, name: column.name, color: column.color, kind: column.kind },
      status: column.kind === 'done' ? 'done' : card.status === 'done' && !sameColumn ? 'pending' : card.status,
      blocker: column.kind === 'blocked' && blocker ? { note: blocker, since: Date.now() } : column.kind === 'blocked' ? card.blocker : null,
    };
    const rest = board.cards.filter((c) => c.todoId !== card.todoId);
    const anchor = after ? rest.findIndex((c) => c.todoId === after.todoId) : before ? rest.findIndex((c) => c.todoId === before.todoId) + 1 : rest.length;
    rest.splice(anchor < 0 ? rest.length : anchor, 0, moved);
    setBoard({ ...board, cards: rest });

    try {
      const r = await send<{ completed: boolean; position: string | null }>('POST', `/api/board/cards/${card.instanceId}/move`, {
        ...(sameColumn ? {} : { statusId: target.columnId }),
        ...(blocker ? { blocker } : {}),
        beforeId: before?.todoId ?? null,
        afterId: after?.todoId ?? null,
      });
      if (r.completed) toast(`“${card.title}” done ✓`);
      if (r.position) setBoard((b) => b && { ...b, cards: b.cards.map((c) => (c.todoId === card.todoId ? { ...c, position: r.position } : c)) });
    } catch (e) {
      setBoard(snapshot);
      toast(errorMessage(e), 'error');
      void load(); // pick up whatever changed underneath
    }
  };

  // ---- pointer-driven drag and drop ----
  const press = useRef<{ card: BoardCard; startX: number; startY: number; timer: number | null; el: HTMLElement; pointerId: number; started: boolean } | null>(null);

  const targetAt = (x: number, y: number, card: BoardCard): Target | null => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const col = el?.closest<HTMLElement>('[data-col]');
    if (!col) return null;
    const columnId = col.dataset.col!;
    const cardEls = [...col.querySelectorAll<HTMLElement>('[data-card]')].filter((c) => c.dataset.card !== card.todoId);
    let index = cardEls.length;
    for (let i = 0; i < cardEls.length; i++) {
      const r = cardEls[i]!.getBoundingClientRect();
      if (y < r.top + r.height / 2) {
        index = i;
        break;
      }
    }
    return { columnId, index };
  };

  const startDrag = (x: number, y: number) => {
    const p = press.current;
    if (!p) return;
    p.started = true;
    const r = p.el.getBoundingClientRect();
    navigator.vibrate?.(8);
    setDrag({ card: p.card, x, y, w: r.width, dx: x - r.left, dy: y - r.top, target: targetAt(x, y, p.card) });
  };

  useEffect(() => {
    if (!drag) return;
    // Long-press drags on touch: stop the page from scrolling while a card is held.
    const stopScroll = (e: TouchEvent) => e.preventDefault();
    document.addEventListener('touchmove', stopScroll, { passive: false });
    // Auto-scroll near the edges of the board (sideways) and the window (up/down).
    let raf = 0;
    const tick = () => {
      setDrag((d) => {
        if (!d) return d;
        const sc = scroller.current;
        if (sc) {
          const r = sc.getBoundingClientRect();
          if (d.x < r.left + EDGE) sc.scrollLeft -= 12;
          else if (d.x > r.right - EDGE) sc.scrollLeft += 12;
        }
        if (d.y < EDGE) window.scrollBy(0, -12);
        else if (d.y > window.innerHeight - EDGE) window.scrollBy(0, 12);
        return d;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      document.removeEventListener('touchmove', stopScroll);
      cancelAnimationFrame(raf);
    };
  }, [!!drag]);

  const onPointerDown = (e: PointerEvent, card: BoardCard) => {
    if (!board?.canEdit || !card.canEdit || !card.instanceId) return;
    if (e.button !== 0 || (e.target as HTMLElement).closest('.card-menu')) return;
    const el = e.currentTarget as HTMLElement;
    press.current = { card, startX: e.clientX, startY: e.clientY, timer: null, el, pointerId: e.pointerId, started: false };
    if (e.pointerType !== 'mouse') {
      press.current.timer = window.setTimeout(() => {
        if (press.current && !press.current.started) {
          el.setPointerCapture?.(press.current.pointerId);
          startDrag(press.current.startX, press.current.startY);
        }
      }, LONG_PRESS_MS);
    }
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const p = press.current;
      if (!p) return;
      const moved = Math.hypot(e.clientX - p.startX, e.clientY - p.startY);
      if (!p.started) {
        if (e.pointerType === 'mouse' && moved > MOVE_SLOP) startDrag(e.clientX, e.clientY);
        else if (e.pointerType !== 'mouse' && moved > MOVE_SLOP) {
          // Moved before the long press fired: it's a scroll, not a drag.
          if (p.timer) clearTimeout(p.timer);
          press.current = null;
        }
        return;
      }
      setDrag((d) => d && { ...d, x: e.clientX, y: e.clientY, target: targetAt(e.clientX, e.clientY, p.card) });
    };
    const onUp = () => {
      const p = press.current;
      press.current = null;
      if (p?.timer) clearTimeout(p.timer);
      const d = dragRef.current;
      setDrag(null);
      if (p?.started) {
        justDragged.current = true;
        setTimeout(() => (justDragged.current = false), 0);
        if (d?.target) void move(d.card, d.target);
      }
    };
    const onCancel = () => {
      if (press.current?.timer) clearTimeout(press.current.timer);
      press.current = null;
      setDrag(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey);
    };
  }, [board]);

  if (error) return <ErrorBox message={error} onRetry={load} />;
  if (!board || !params) return <Loading />;

  const chooseCategory = (c: Cat) => {
    const url = new URL(location.href);
    if (c) url.searchParams.set('category', c);
    else url.searchParams.delete('category');
    history.replaceState(null, '', url);
    setParams({ ...params, category: c });
  };

  return (
    <>
      <header class="page-head">
        <div>
          <p class="eyebrow">{board.project ? 'Project board' : 'Everything you are working on'}</p>
          <h1 class="page-title">{board.project ? board.project.name : 'All work'}</h1>
        </div>
        {board.project ? (
          <nav class="tabs" aria-label="Project view">
            <a href={`/project?id=${board.project.id}`}>List</a>
            <a href={`/board?project=${board.project.id}`} aria-current="page">
              Board
            </a>
          </nav>
        ) : (
          <div class="tabs" role="radiogroup" aria-label="Category">
            {(
              [
                ['', 'All'],
                ['work', 'Work'],
                ['personal', 'Personal'],
                ['habit', 'Habits'],
              ] as [Cat, string][]
            ).map(([v, l]) => (
              <button key={v} type="button" role="radio" aria-checked={params.category === v} aria-selected={params.category === v} onClick={() => chooseCategory(v)}>
                {l}
              </button>
            ))}
          </div>
        )}
      </header>
      {!board.canEdit && <p class="faint mb-4">Read only. This is your partner's project, and it isn't shared.</p>}
      {board.canEdit && <p class="faint mb-4 board-hint">Drag cards between columns (long-press on touch), or use the menu button on a card.</p>}

      {board.cards.length === 0 ? (
        <Empty title="Nothing on the board" body="Todos show up here by status. Repeating ones appear on the days they're scheduled." icon="grid" />
      ) : (
        <div class={`board ${drag ? 'is-dragging' : ''}`} ref={scroller}>
          {board.columns.map((col) => {
            const cards = inColumn(board.cards, col.id);
            const over = drag?.target?.columnId === col.id;
            return (
              <section key={col.id} class={`board-col ${over ? 'col-over' : ''}`} data-col={col.id} data-kind={col.kind} aria-label={`${col.name}, ${cards.length} cards`}>
                <h2 class="board-col-head">
                  <span class="stage" data-color={col.color} data-kind={col.kind}>
                    <i aria-hidden="true" />
                    {col.name}
                  </span>
                  <span class="faint">{cards.length}</span>
                  {col.archived && <span class="chip">archived</span>}
                </h2>
                <ul class="board-cards">
                  {cards.map((card, i) => {
                    const lifted = drag?.card.todoId === card.todoId;
                    const gapHere = over && drag && drag.target?.index === i && !lifted;
                    return (
                      <Fragment key={card.todoId}>
                        {gapHere && <li class="drop-gap" aria-hidden="true" />}
                        <li
                          data-card={card.todoId}
                          class={`board-card ${lifted ? 'is-lifted' : ''} ${card.stage?.kind === 'blocked' ? 'is-blocked' : ''} ${card.status === 'done' ? 'is-done' : ''}`}
                          data-category={card.category}
                          onPointerDown={(e) => onPointerDown(e, card)}
                          onContextMenu={(e) => board.canEdit && card.canEdit && e.preventDefault()}
                        >
                          <CardBody card={card} today={board.today} me={me} showProject={!board.project} onOpen={() => !justDragged.current && setOpen(card)} />
                          {board.canEdit && card.canEdit && card.instanceId && (
                            <button type="button" class="icon-btn small card-menu" onClick={() => setMenuFor(card)} aria-label={`Move “${card.title}”`}>
                              <Icon name="list" />
                            </button>
                          )}
                        </li>
                      </Fragment>
                    );
                  })}
                  {over && drag && (drag.target?.index ?? 0) >= cards.filter((c) => c.todoId !== drag.card.todoId).length && (
                    <li class="drop-gap" aria-hidden="true" />
                  )}
                </ul>
              </section>
            );
          })}
        </div>
      )}

      {drag && (
        <div class="board-card board-ghost" data-category={drag.card.category} style={{ width: `${drag.w}px`, transform: `translate(${drag.x - drag.dx}px, ${drag.y - drag.dy}px)` }} aria-hidden="true">
          <CardBody card={drag.card} today={board.today} me={me} showProject={!board.project} />
        </div>
      )}

      <MoveMenu
        card={menuFor}
        board={board}
        onClose={() => setMenuFor(null)}
        onMove={(t) => {
          const c = menuFor;
          setMenuFor(null);
          if (c) void move(c, t);
        }}
      />
      {prompt.element}
      <TodoSheet
        todoId={open?.todoId ?? null}
        instanceId={open?.instanceId}
        item={open}
        onClose={() => setOpen(null)}
        onChanged={load}
      />
      <Toasts />
    </>
  );
}

function CardBody({ card, today, me, showProject, onOpen }: { card: BoardCard; today: string; me: Me | null; showProject: boolean; onOpen?: () => void }) {
  return (
    <button type="button" class="card-body" onClick={onOpen} tabIndex={onOpen ? 0 : -1}>
      <span class="card-title">
        <PriorityMark value={card.priority} />
        {card.title}
      </span>
      <span class="card-meta">
        <DeadlineBadge deadline={card.deadline} today={today} done={card.status === 'done'} />
        {card.subtasks && (
          <span>
            <Icon name="list" />
            {card.subtasks.done}/{card.subtasks.total}
          </span>
        )}
        {card.isShared && (
          <span class="chip plum">
            <Icon name="users" />
            {assigneeLabel(me, card.assignedTo)}
          </span>
        )}
        {showProject && card.project && (
          <span>
            <i class="dot" data-color={card.project.color} aria-hidden="true" /> {card.project.name}
          </span>
        )}
      </span>
      {card.blocker && <BlockerLine blocker={card.blocker} />}
    </button>
  );
}

/** Keyboard / screen-reader alternative to dragging: pick a column and a place in it. */
function MoveMenu({ card, board, onClose, onMove }: { card: BoardCard | null; board: Board; onClose: () => void; onMove: (t: Target) => void }) {
  if (!card) return <Sheet open={false} onClose={onClose} title="Move" children={null} />;
  const here = inColumn(board.cards, card.columnId ?? '');
  const idx = here.findIndex((c) => c.todoId === card.todoId);
  return (
    <Sheet open={!!card} onClose={onClose} title={`Move “${card.title}”`}>
      <p class="label">To column</p>
      <div class="move-columns">
        {board.columns
          .filter((c) => !c.archived)
          .map((c) => (
            <button
              key={c.id}
              type="button"
              class={`btn ${c.id === card.columnId ? 'ghost' : 'quiet'} move-col`}
              disabled={c.id === card.columnId}
              onClick={() => onMove({ columnId: c.id, index: 0 })}
            >
              <span class="stage" data-color={c.color} data-kind={c.kind}>
                <i aria-hidden="true" />
                {c.name}
              </span>
              {c.id === card.columnId && <span class="faint"> (here)</span>}
            </button>
          ))}
      </div>
      <p class="label mt-4">Within “{board.columns.find((c) => c.id === card.columnId)?.name}”</p>
      <div class="row">
        <button type="button" class="btn ghost small" disabled={idx <= 0} onClick={() => onMove({ columnId: card.columnId!, index: 0 })}>
          To top
        </button>
        <button type="button" class="btn ghost small" disabled={idx <= 0} onClick={() => onMove({ columnId: card.columnId!, index: idx - 1 })}>
          Up one
        </button>
        <button type="button" class="btn ghost small" disabled={idx >= here.length - 1} onClick={() => onMove({ columnId: card.columnId!, index: idx + 1 })}>
          Down one
        </button>
        <button type="button" class="btn ghost small" disabled={idx >= here.length - 1} onClick={() => onMove({ columnId: card.columnId!, index: here.length - 1 })}>
          To bottom
        </button>
      </div>
    </Sheet>
  );
}
