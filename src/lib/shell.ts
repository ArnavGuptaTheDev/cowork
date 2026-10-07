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

hydrateHeader().catch(() => undefined);
void registerServiceWorker();
