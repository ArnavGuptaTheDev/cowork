// Runs on every signed-in page: fills the header (avatar, suggestions badge) and registers the service worker.
import { getMe } from './api';
import { initials } from './format';
import { registerServiceWorker } from './push';

async function hydrateHeader() {
  const me = await getMe();
  const avatar = document.getElementById('me-avatar');
  if (avatar) {
    if (me.user.avatarUrl) {
      const img = document.createElement('img');
      img.src = me.user.avatarUrl;
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.className = 'avatar';
      img.onerror = () => img.replaceWith(Object.assign(document.createElement('span'), { className: 'avatar', textContent: initials(me.user.name) }));
      avatar.replaceWith(img);
    } else {
      avatar.textContent = initials(me.user.name);
    }
  }
  const badge = document.getElementById('suggestions-badge');
  const link = document.getElementById('nav-suggestions');
  if (badge && me.pendingSuggestions > 0) {
    badge.textContent = String(me.pendingSuggestions);
    badge.hidden = false;
    link?.setAttribute('aria-label', `Suggestions, ${me.pendingSuggestions} waiting`);
  }
}

let tick: ReturnType<typeof setInterval> | undefined;

/** A small live "⏱ Todo 12:34" pill while a timer runs (the start time comes from the server). */
async function timerPill(refresh = false) {
  const pill = document.getElementById('timer-pill') as HTMLAnchorElement | null;
  if (!pill) return;
  const me = await getMe(refresh);
  clearInterval(tick);
  const t = me.runningTimer;
  if (!t) {
    pill.hidden = true;
    return;
  }
  // Server and device clocks can differ; measure elapsed time on the server's clock.
  const skew = me.serverNow - Date.now();
  const render = () => {
    const s = Math.max(0, Math.floor((Date.now() + skew - t.startedAt) / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const clock = `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(s % 60).padStart(2, '0')}`;
    pill.textContent = `⏱ ${clock}`;
    pill.title = `Timer running: ${t.todoTitle}`;
    pill.setAttribute('aria-label', `Timer running on ${t.todoTitle}, ${clock}`);
  };
  pill.href = `/today?todo=${t.todoId}`;
  pill.hidden = false;
  render();
  tick = setInterval(render, 1000);
}

hydrateHeader().catch(() => undefined);
timerPill().catch(() => undefined);
window.addEventListener('cowork:timer', () => void timerPill(true).catch(() => undefined));
void registerServiceWorker();
