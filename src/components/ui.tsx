import type { ComponentChildren, TargetedMouseEvent } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { icons, type IconName } from './icons';

export function Icon({ name, label, class: cls }: { name: IconName; label?: string; class?: string }) {
  return (
    <svg
      class={cls}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.9"
      stroke-linecap="round"
      stroke-linejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : 'true'}
      dangerouslySetInnerHTML={{ __html: icons[name] }}
    />
  );
}

// ---------- Toasts ----------

type ToastMsg = { id: number; text: string; kind: 'info' | 'error' };
let toastListeners: ((t: ToastMsg[]) => void)[] = [];
let toasts: ToastMsg[] = [];
let toastId = 0;

export function toast(text: string, kind: 'info' | 'error' = 'info') {
  const t = { id: ++toastId, text, kind };
  toasts = [...toasts, t];
  toastListeners.forEach((l) => l(toasts));
  setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== t.id);
    toastListeners.forEach((l) => l(toasts));
  }, kind === 'error' ? 5000 : 3000);
}

export function Toasts() {
  const [list, setList] = useState<ToastMsg[]>(toasts);
  useEffect(() => {
    toastListeners.push(setList);
    return () => {
      toastListeners = toastListeners.filter((l) => l !== setList);
    };
  }, []);
  return (
    <div class="toast-wrap" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} class={`toast ${t.kind === 'error' ? 'error' : ''}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

// ---------- Sheet (native <dialog>: focus trap, Esc, inert background for free) ----------

export function Sheet(props: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ComponentChildren;
  footer?: ComponentChildren;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (props.open && !d.open) d.showModal();
    if (!props.open && d.open) d.close();
  }, [props.open]);
  const onClick = (e: TargetedMouseEvent<HTMLDialogElement>) => {
    if (e.target === ref.current) props.onClose(); // backdrop tap
  };
  return (
    <dialog
      ref={ref}
      class="sheet"
      aria-labelledby="sheet-title"
      onClose={props.onClose}
      onCancel={(e) => {
        e.preventDefault();
        props.onClose();
      }}
      onClick={onClick}
    >
      {props.open && (
        <>
          <div class="sheet-grip" aria-hidden="true" />
          <div class="sheet-head">
            <h2 id="sheet-title">{props.title}</h2>
            <button type="button" class="icon-btn" onClick={props.onClose}>
              <Icon name="x" label="Close" />
            </button>
          </div>
          <div class="sheet-body">{props.children}</div>
          {props.footer && <div class="sheet-foot">{props.footer}</div>}
        </>
      )}
    </dialog>
  );
}

// ---------- Checkbox ----------

export function Check(props: {
  checked: boolean;
  label: string;
  onToggle?: () => void;
  disabled?: boolean;
  variant?: 'missed' | 'upcoming';
}) {
  return (
    <button
      type="button"
      role="checkbox"
      class={`check ${props.variant ?? ''}`}
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={props.onToggle}
    >
      <span class="ring">
        <Icon name="check" />
      </span>
    </button>
  );
}

// ---------- Progress ----------

export function ProgressRing({ done, total, label }: { done: number; total: number; label?: string }) {
  const r = 32;
  const c = 2 * Math.PI * r;
  const frac = total === 0 ? 0 : done / total;
  return (
    <div
      class={`ring-progress ${total > 0 && done === total ? 'complete' : ''}`}
      role="img"
      aria-label={label ?? `${done} of ${total} done`}
    >
      <svg viewBox="0 0 76 76" aria-hidden="true">
        <circle class="track" cx="38" cy="38" r={r} fill="none" stroke-width="8" />
        <circle
          class="bar"
          cx="38"
          cy="38"
          r={r}
          fill="none"
          stroke-width="8"
          stroke-linecap="round"
          stroke-dasharray={c}
          stroke-dashoffset={c * (1 - frac)}
        />
      </svg>
      <span class="label" aria-hidden="true">
        {done}/{total}
      </span>
    </div>
  );
}

export function ProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div
      class={`bar-progress ${total > 0 && done === total ? 'complete' : ''}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label={`${done} of ${total} done`}
    >
      <svg width="100%" height="100%" preserveAspectRatio="none" aria-hidden="true">
        <rect width={`${pct}%`} height="100%" rx="4" />
      </svg>
    </div>
  );
}

// ---------- States ----------

export function Empty({ title, body, icon = 'sparkle', children }: { title: string; body: string; icon?: IconName; children?: ComponentChildren }) {
  return (
    <div class="empty">
      <Icon name={icon} />
      <h3>{title}</h3>
      <p>{body}</p>
      {children && <div class="row center mt-4">{children}</div>}
    </div>
  );
}

export function Loading() {
  return (
    <div class="stack" aria-busy="true" aria-label="Loading">
      <div class="skeleton" />
      <div class="skeleton" />
      <div class="skeleton" />
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div class="notice" role="alert">
      <p>{message}</p>
      {onRetry && (
        <button type="button" class="btn ghost mt-2" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Avatar({ name, url, partner }: { name: string; url: string | null; partner?: boolean }) {
  const [broken, setBroken] = useState(false);
  if (url && !broken) {
    return <img class={`avatar ${partner ? 'partner' : ''}`} src={url} alt="" referrerpolicy="no-referrer" onError={() => setBroken(true)} />;
  }
  return (
    <span class={`avatar ${partner ? 'partner' : ''}`} aria-hidden="true">
      {name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((p) => p[0]!.toUpperCase())
        .join('') || '?'}
    </span>
  );
}

/** Small hook: load async data with loading/error state and a reload function. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const load = async () => {
    const n = ++seq.current;
    setLoading(true);
    try {
      const d = await fn();
      if (n === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      if (n === seq.current) setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, deps);
  return { data, error, loading, reload: load, setData };
}
