import { useEffect, useState } from 'preact/hooks';
import { errorMessage, get, getMe, send } from '../lib/api';
import { relativeDay } from '../lib/format';
import { currentSubscription, disablePush, enablePush, pushSupported } from '../lib/push';
import type { Me } from '../lib/types';
import { StatusSettings } from './StatusSettings';
import { TimeField } from './TimeField';
import { Avatar, ErrorBox, Icon, Loading, Toasts, toast, useLoad } from './ui';

const COMMON_ZONES = [
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'UTC',
];

function allZones(): string[] {
  try {
    const zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone');
    if (zones?.length) return zones;
  } catch {
    // ignore
  }
  return COMMON_ZONES;
}

type Theme = 'system' | 'light' | 'dark';

function readTheme(): Theme {
  try {
    const t = localStorage.getItem('theme');
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

function applyTheme(t: Theme) {
  try {
    if (t === 'system') localStorage.removeItem('theme');
    else localStorage.setItem('theme', t);
  } catch {
    // storage unavailable: still apply for this page
  }
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

export default function SettingsIsland() {
  const state = useLoad(() => getMe(true));
  if (state.loading && !state.data) return <Loading />;
  if (state.error || !state.data) return <ErrorBox message={state.error ?? 'Could not load'} onRetry={state.reload} />;
  const me = state.data;
  return (
    <>
      <header class="page-head">
        <div>
          <p class="eyebrow">You</p>
          <h1 class="page-title">Settings</h1>
        </div>
      </header>
      <Profile me={me} onSaved={state.reload} />
      <Appearance />
      <MoreLinks />
      <StatusSettings />
      <Wrapup me={me} />
      <Pause me={me} />
      <Calendar />
      <ExportData />
      <Notifications me={me} />
      <Pairing me={me} onChanged={state.reload} />
      <section class="section card">
        <h2 class="section-title">Account</h2>
        <p class="faint">Signed in as {me.user.email}</p>
        <div class="row mt-4">
          {me.isAdmin && (
            <a class="btn ghost" href="/admin">
              <Icon name="shield" /> Invites (admin)
            </a>
          )}
          <span class="spacer" />
          <button
            type="button"
            class="btn danger"
            onClick={async () => {
              await disablePush().catch(() => undefined);
              await send('POST', '/api/auth/logout').catch(() => undefined);
              location.href = '/';
            }}
          >
            <Icon name="logout" /> Sign out
          </button>
        </div>
      </section>
      <Toasts />
    </>
  );
}

function Profile({ me, onSaved }: { me: Me; onSaved: () => void }) {
  const [name, setName] = useState(me.user.name);
  const [tz, setTz] = useState(me.user.timezone);
  const [busy, setBusy] = useState(false);
  const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Compare canonical names so aliases (Asia/Calcutta vs Asia/Kolkata) don't count as different.
  const canonical = (z: string) => {
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone: z }).resolvedOptions().timeZone;
    } catch {
      return z;
    }
  };
  const save = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    try {
      await send('PATCH', '/api/me', { name: name.trim(), timezone: tz });
      await getMe(true);
      toast('Saved');
      onSaved();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="section card" onSubmit={save}>
      <h2 class="section-title">Profile</h2>
      <div class="field">
        <label class="label" for="s-name">
          Name
        </label>
        <input id="s-name" class="input" value={name} maxLength={80} onInput={(e) => setName(e.currentTarget.value)} />
      </div>
      <div class="field">
        <label class="label" for="s-tz">
          Time zone
        </label>
        <select id="s-tz" class="select" value={tz} onChange={(e) => setTz(e.currentTarget.value)}>
          {[...new Set([tz, ...allZones()])].map((z) => (
            <option key={z} value={z}>
              {z.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
        <span class="hint">
          Your day starts at midnight here, and reminders follow it.
          {deviceTz && canonical(deviceTz) !== canonical(tz) && (
            <>
              {' '}
              <button type="button" class="btn quiet" onClick={() => setTz(deviceTz)}>
                Use this device's ({deviceTz})
              </button>
            </>
          )}
        </span>
      </div>
      <div class="row mt-4">
        <span class="spacer" />
        <button type="submit" class="btn" disabled={busy}>
          Save
        </button>
      </div>
    </form>
  );
}

interface CalStatus {
  configured: boolean;
  connected: boolean;
  lastSyncAt: number | null;
  lastError: string | null;
  events: number;
}

const CAL_MESSAGES: Record<string, [string, 'info' | 'error']> = {
  connected: ['Google Calendar connected. Syncing your todos…', 'info'],
  cancelled: ['Calendar connection cancelled', 'error'],
  expired: ['That attempt expired. Please try again', 'error'],
  scope: ['Calendar access wasn’t granted. Tick the calendar box on Google’s screen', 'error'],
  account: ['Use the same Google account you sign in with', 'error'],
  google: ['Google didn’t accept the request. Please try again', 'error'],
  unavailable: ['Calendar sync isn’t set up on this server yet', 'error'],
};

function Calendar() {
  const [s, setS] = useState<CalStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => get<CalStatus>('/api/calendar/status').then(setS, () => undefined);
  useEffect(() => {
    void load();
    const flag = new URLSearchParams(location.search).get('calendar');
    if (flag && CAL_MESSAGES[flag]) {
      toast(...CAL_MESSAGES[flag]!);
      history.replaceState(null, '', '/settings#calendar');
    }
  }, []);
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    try {
      await fn();
      toast(msg);
      await load();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  if (!s) return null;
  return (
    <section class="section card" id="calendar">
      <h2 class="section-title">Google Calendar</h2>
      <p class="faint">
        One-way sync: todos with a due time appear in a separate “CoWork” calendar in your Google account. Private todos only ever go to your own calendar.{' '}
        <a href="/privacy">How we use your data</a>
      </p>
      {!s.configured ? (
        <p class="muted mt-2">Not available on this server yet.</p>
      ) : s.connected ? (
        <>
          <p class="mt-2">
            <span class="chip sage">Connected</span> {s.events} events
            {s.lastSyncAt ? <span class="faint"> · synced {new Date(s.lastSyncAt).toLocaleString()}</span> : null}
          </p>
          {s.lastError && <p class="error-text mt-2">{s.lastError}</p>}
          <div class="row mt-2">
            <button type="button" class="btn ghost" disabled={busy} onClick={() => run(() => send('POST', '/api/calendar/sync'), 'Synced')}>
              <Icon name="sync" /> Resync
            </button>
            <span class="spacer" />
            <button
              type="button"
              class="btn danger"
              disabled={busy}
              onClick={() => confirm('Disconnect Google Calendar? The CoWork calendar is deleted and access is revoked.') && run(() => send('POST', '/api/calendar/disconnect'), 'Disconnected')}
            >
              Disconnect
            </button>
          </div>
        </>
      ) : (
        <a class="btn ghost mt-2" href="/api/calendar/connect">
          <Icon name="calendar" /> Connect Google Calendar
        </a>
      )}
    </section>
  );
}

function ExportData() {
  return (
    <section class="section card">
      <h2 class="section-title">Your data</h2>
      <p class="faint">Everything of yours, plus items shared with you. Your partner's own data isn't included.</p>
      <div class="row mt-2">
        <a class="btn ghost" href="/api/export/json" download>
          <Icon name="download" /> All data (JSON)
        </a>
        <a class="btn ghost" href="/api/export/todos.csv" download>
          Todos (CSV)
        </a>
        <a class="btn ghost" href="/api/export/completions.csv" download>
          Completions (CSV)
        </a>
      </div>
    </section>
  );
}

function MoreLinks() {
  return (
    <nav class="section card more-links" aria-label="More">
      <a href="/board">
        <Icon name="grid" /> All work board
      </a>
      <a href="/review">
        <Icon name="chart" /> Weekly review
      </a>
      <a href="/photos">
        <Icon name="image" /> Photos
      </a>
      <a href="/templates">
        <Icon name="grid" /> Templates
      </a>
      <a href="/suggestions">
        <Icon name="inbox" /> Suggestions
      </a>
      <a href="/wrapup">
        <Icon name="moon" /> Wrap-up
      </a>
    </nav>
  );
}

interface PauseRow {
  id: string;
  startDate: string;
  endDate: string;
  note: string;
  active: boolean;
}

function Pause({ me }: { me: Me }) {
  const [list, setList] = useState<PauseRow[] | null>(null);
  const [start, setStart] = useState(me.today);
  const [end, setEnd] = useState(me.today);
  const [note, setNote] = useState('');
  const load = () => get<{ pauses: PauseRow[] }>('/api/pauses').then((r) => setList(r.pauses), () => setList([]));
  useEffect(() => {
    void load();
  }, []);
  const create = async (e: Event) => {
    e.preventDefault();
    try {
      await send('POST', '/api/pauses', { startDate: start, endDate: end, note });
      toast('Enjoy the break 🌴');
      setNote('');
      await load();
      await getMe(true);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  const end_ = async (p: PauseRow) => {
    try {
      await send('DELETE', `/api/pauses/${p.id}`);
      toast(p.active ? 'Welcome back' : 'Pause cancelled');
      await load();
      await getMe(true);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  return (
    <section class="section card">
      <h2 class="section-title">Take a break</h2>
      <p class="faint">Travelling or unwell? While paused, reminders and nudges stay quiet, habits are paused instead of missed (streaks freeze), and your partner sees you're on a break.</p>
      {list && list.length > 0 && (
        <ul class="list-plain mt-2">
          {list.map((p) => (
            <li key={p.id} class="row">
              <span class="grow">
                {relativeDay(p.startDate, me.today)} → {relativeDay(p.endDate, me.today)}
                {p.note ? <span class="faint"> · {p.note}</span> : null}
                {p.active && <span class="chip sky"> on now</span>}
              </span>
              <button type="button" class="btn quiet small" onClick={() => end_(p)}>
                {p.active ? 'End now' : 'Cancel'}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form class="mt-4" onSubmit={create}>
        <div class="field-row">
          <div class="field">
            <label class="label" for="pause-start">
              From
            </label>
            <input id="pause-start" class="input" type="date" value={start} onInput={(e) => setStart(e.currentTarget.value)} />
          </div>
          <div class="field">
            <label class="label" for="pause-end">
              Until
            </label>
            <input id="pause-end" class="input" type="date" min={start} value={end} onInput={(e) => setEnd(e.currentTarget.value)} />
          </div>
        </div>
        <div class="field">
          <label class="label" for="pause-note">
            Note <span class="faint">(your partner sees it)</span>
          </label>
          <input id="pause-note" class="input" maxLength={200} placeholder="Goa trip" value={note} onInput={(e) => setNote(e.currentTarget.value)} />
        </div>
        <div class="row mt-4">
          <span class="spacer" />
          <button type="submit" class="btn">
            <Icon name="pause" /> Pause
          </button>
        </div>
      </form>
    </section>
  );
}

function Wrapup({ me }: { me: Me }) {
  const [on, setOn] = useState(me.wrapupTime !== null);
  const [time, setTime] = useState(me.wrapupTime ?? '21:00');
  const save = async (enabled: boolean, t: string) => {
    try {
      await send('PATCH', '/api/me', { wrapupTime: enabled ? t : null });
      await getMe(true);
      toast(enabled ? `Wrap-up at ${t}` : 'Wrap-up off');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <section class="section card">
      <h2 class="section-title">Evening wrap-up</h2>
      <p class="faint">One push at the end of the day with what's done, what's left and how your partner did. Tap it to tidy up leftovers.</p>
      <label class="switch mt-2">
        <span>Send a wrap-up</span>
        <input
          type="checkbox"
          role="switch"
          checked={on}
          onChange={(e) => {
            setOn(e.currentTarget.checked);
            void save(e.currentTarget.checked, time);
          }}
        />
      </label>
      {on && (
        <div class="field mt-2">
          <label class="label" for="wrapup-time">
            At
          </label>
          <TimeField
            id="wrapup-time"
            value={time}
            onChange={(v) => {
              setTime(v);
              if (v) void save(true, v);
            }}
          />
        </div>
      )}
      <a class="btn quiet mt-2" href="/wrapup">
        Open today's wrap-up
      </a>
    </section>
  );
}

function Appearance() {
  const [theme, setTheme] = useState<Theme>('system');
  useEffect(() => setTheme(readTheme()), []);
  return (
    <section class="section card">
      <h2 class="section-title">Appearance</h2>
      <fieldset class="segmented">
        <legend>Theme</legend>
        {(['system', 'light', 'dark'] as const).map((t) => (
          <label key={t}>
            <input
              type="radio"
              name="theme"
              checked={theme === t}
              onChange={() => {
                setTheme(t);
                applyTheme(t);
              }}
            />
            <span>{t[0]!.toUpperCase() + t.slice(1)}</span>
          </label>
        ))}
      </fieldset>
    </section>
  );
}

function Notifications({ me }: { me: Me }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const supported = typeof window !== 'undefined' && pushSupported();
  useEffect(() => {
    currentSubscription().then((s) => setEnabled(!!s), () => setEnabled(false));
  }, []);
  const toggle = async () => {
    setBusy(true);
    try {
      if (enabled) {
        await disablePush();
        setEnabled(false);
        toast('Notifications off on this device');
      } else {
        if (!me.vapidPublicKey) throw new Error('Push is not configured on the server yet');
        await enablePush(me.vapidPublicKey);
        setEnabled(true);
        toast('Notifications on');
      }
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    try {
      const r = await send<{ delivered: number }>('POST', '/api/push/test');
      toast(r.delivered ? 'Sent. Check your notifications' : 'No devices received it', r.delivered ? 'info' : 'error');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <section class="section card">
      <h2 class="section-title">Notifications</h2>
      <p class="faint">Reminders, suggestions, and a cheer when your partner finishes their day.</p>
      {!supported ? (
        <p class="mt-2 muted">This browser can’t receive push notifications. On iPhone, add CoWork to your Home Screen (Share → Add to Home Screen), then open it from there.</p>
      ) : (
        <>
          <label class="switch mt-2">
            <span>Push on this device</span>
            <input type="checkbox" role="switch" checked={!!enabled} disabled={busy || enabled === null} onChange={toggle} />
          </label>
          {enabled && (
            <button type="button" class="btn ghost mt-2" onClick={test}>
              <Icon name="bell" /> Send a test
            </button>
          )}
        </>
      )}
    </section>
  );
}

function Pairing({ me, onChanged }: { me: Me; onChanged: () => void }) {
  const [code, setCode] = useState<{ code: string; url: string; expiresAt: number } | null>(null);
  const [entry, setEntry] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const p = new URLSearchParams(location.search).get('pair');
    if (p) setEntry(p.toUpperCase());
  }, []);

  const generate = async () => {
    setBusy(true);
    try {
      setCode(await send('POST', '/api/pairing/code'));
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const share = async () => {
    if (!code) return;
    const text = `Pair with me on CoWork: ${code.url}`;
    try {
      if (navigator.share) await navigator.share({ title: 'CoWork', text, url: code.url });
      else {
        await navigator.clipboard.writeText(code.url);
        toast('Link copied');
      }
    } catch {
      // share sheet dismissed
    }
  };
  const accept = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    try {
      await send('POST', '/api/pairing/accept', { code: entry });
      await getMe(true);
      toast('Paired! 💞');
      history.replaceState(null, '', '/settings');
      onChanged();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };
  const unpair = async () => {
    if (!me.partner || !confirm(`Unpair from ${me.partner.name}? You'll stop seeing each other's lists.`)) return;
    try {
      await send('DELETE', '/api/pairing');
      await getMe(true);
      toast('Unpaired');
      onChanged();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  return (
    <section class="section card" id="pairing">
      <h2 class="section-title">Partner</h2>
      {me.partner ? (
        <>
          <div class="row">
            <Avatar name={me.partner.name} url={me.partner.avatarUrl} partner />
            <div>
              <strong>{me.partner.name}</strong>
              <div class="faint">{me.partner.email}</div>
            </div>
          </div>
          <div class="row mt-4">
            <span class="spacer" />
            <button type="button" class="btn danger" onClick={unpair}>
              Unpair
            </button>
          </div>
        </>
      ) : (
        <>
          <p class="muted">One of you makes a code, the other enters it (or opens the link). Codes last 15 minutes.</p>
          {code ? (
            <div class="mt-4">
              <div class="code" aria-label={`Pairing code ${code.code.split('').join(' ')}`}>
                {code.code}
              </div>
              <div class="row mt-2">
                <span class="faint">Expires {new Date(code.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
                <span class="spacer" />
                <button type="button" class="btn plum" onClick={share}>
                  Share link
                </button>
              </div>
            </div>
          ) : (
            <button type="button" class="btn plum mt-4" onClick={generate} disabled={busy}>
              <Icon name="sparkle" /> Make a pairing code
            </button>
          )}
          <form class="mt-6" onSubmit={accept}>
            <div class="field">
              <label class="label" for="pair-code">
                Got a code?
              </label>
              <div class="row">
                <input
                  id="pair-code"
                  class="input code-input"
                  value={entry}
                  maxLength={8}
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellcheck={false}
                  placeholder="ABCD2345"
                  onInput={(e) => setEntry(e.currentTarget.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                />
                <button type="submit" class="btn" disabled={busy || entry.length !== 8}>
                  Pair
                </button>
              </div>
            </div>
          </form>
        </>
      )}
    </section>
  );
}
