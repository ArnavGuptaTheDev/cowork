import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { prettyTime } from '../lib/format';
import { Icon } from './ui';

// A themed stand-in for <input type="time">, whose picker the browser draws in system colours.
// The panel is a popover, so it sits in the top layer above sheets and isn't clipped by their scrolling body.

const HOURS = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const MINUTE_STEP = 5;

const pad = (n: number) => String(n).padStart(2, '0');

function parts(value: string): { h12: number; m: number; pm: boolean } | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const h = Number(match[1]);
  return { h12: h % 12 === 0 ? 12 : h % 12, m: Number(match[2]), pm: h >= 12 };
}

function join(h12: number, m: number, pm: boolean): string {
  return `${pad((h12 % 12) + (pm ? 12 : 0))}:${pad(m)}`;
}

/** The next full hour, used to fill in the parts the user hasn't picked yet. */
function seed(): string {
  return `${pad((new Date().getHours() + 1) % 24)}:00`;
}

export function TimeField(props: { id: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  // Tapping the field while open: light dismiss closes the popover on pointerdown, so the click mustn't reopen it.
  const wasOpen = useRef(false);
  const current = parts(props.value);
  const base = current ?? parts(seed())!;

  const minutes = Array.from({ length: 60 / MINUTE_STEP }, (_, i) => i * MINUTE_STEP);
  if (current && !minutes.includes(current.m)) minutes.push(current.m), minutes.sort((a, b) => a - b);

  const place = () => {
    const b = btn.current?.getBoundingClientRect();
    const p = panel.current;
    if (!b || !p) return;
    const below = window.innerHeight - b.bottom;
    const h = p.offsetHeight;
    p.style.top = `${below >= h + 8 || b.top < h + 8 ? b.bottom + 6 : b.top - h - 6}px`;
    p.style.left = `${Math.max(8, Math.min(b.left, window.innerWidth - p.offsetWidth - 8))}px`;
  };

  useLayoutEffect(() => {
    const p = panel.current;
    if (!p) return;
    if (open && !p.matches(':popover-open')) {
      p.showPopover();
      place();
      // Centre each column on its selected (or suggested) entry.
      p.querySelectorAll<HTMLElement>('.tp-col').forEach((col) => {
        const sel = col.querySelector<HTMLElement>('[data-at="true"]');
        if (sel) col.scrollTop = sel.offsetTop - col.clientHeight / 2 + sel.offsetHeight / 2;
      });
      p.querySelector<HTMLElement>('[data-at="true"]')?.focus({ preventScroll: true });
    } else if (!open && p.matches(':popover-open')) {
      p.hidePopover();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  const pick = (next: Partial<{ h12: number; m: number; pm: boolean }>) => {
    const p = { ...base, ...next };
    props.onChange(join(p.h12, p.m, p.pm));
  };

  const close = () => {
    setOpen(false);
    btn.current?.focus();
  };

  const column = <T,>(label: string, items: T[], isSel: (v: T) => boolean, text: (v: T) => string, onPick: (v: T) => void) => (
    <div class="tp-col" role="listbox" aria-label={label}>
      {items.map((v) => (
        <button
          type="button"
          role="option"
          key={text(v)}
          class="tp-opt"
          aria-selected={!!current && isSel(v)}
          data-at={isSel(v)}
          onClick={() => onPick(v)}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            e.preventDefault();
            const sib = e.key === 'ArrowDown' ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling;
            (sib as HTMLElement | null)?.focus();
          }}
        >
          {text(v)}
        </button>
      ))}
    </div>
  );

  return (
    <>
      <button
        ref={btn}
        id={props.id}
        type="button"
        class={`input time-field ${current ? '' : 'is-unset'}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onPointerDown={() => (wasOpen.current = open)}
        onClick={() => {
          setOpen(!wasOpen.current && !open);
          wasOpen.current = false;
        }}
      >
        <span>{current ? prettyTime(props.value) : props.placeholder ?? 'Set a time'}</span>
        <Icon name="clock" />
      </button>
      <div
        ref={panel}
        popover="auto"
        class="time-panel"
        role="dialog"
        aria-label="Pick a time"
        onToggle={(e) => setOpen(e.newState === 'open')}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation(); // don't also close the sheet
            close();
          }
        }}
      >
        {open && (
          <>
            <div class="tp-cols">
              {column('Hour', HOURS, (h) => h === base.h12, String, (h) => pick({ h12: h }))}
              {column('Minute', minutes, (m) => m === base.m, pad, (m) => pick({ m }))}
              {column('AM or PM', [false, true], (pm) => pm === base.pm, (pm) => (pm ? 'PM' : 'AM'), (pm) => pick({ pm }))}
            </div>
            <div class="tp-foot">
              <button
                type="button"
                class="btn quiet"
                onClick={() => {
                  props.onChange('');
                  close();
                }}
              >
                Clear
              </button>
              <button
                type="button"
                class="btn"
                onClick={() => {
                  if (!current) pick({});
                  close();
                }}
              >
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
