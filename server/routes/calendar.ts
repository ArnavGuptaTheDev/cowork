// Google Calendar connection (incremental authorisation, separate from sign-in) and sync controls.
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { fetchGoogleJwks, verifyIdToken, GOOGLE_AUTH_URL, GOOGLE_TOKEN_URL } from '../auth/google';
import { b64urlDecode, b64urlEncode, pkceChallenge, randomToken, sign, unsign } from '../crypto';
import { HttpError } from '../http';
import { open, seal } from '../secretbox';
import { clearTokenCache, GCAL_SCOPE, accessToken, syncAllFor, type LinkRow } from '../services/gcal';
import { defer, router } from './common';

export const calendarRoutes = router();

const COOKIE = 'cw_gcal';
const TTL_MS = 10 * 60_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

interface CalState {
  s: string;
  v: string;
  n: string;
  x: number;
  u: string; // user id the flow was started for
}

function configured(env: { CALENDAR_TOKEN_KEY?: string; GOOGLE_CLIENT_ID: string }) {
  return !!env.CALENDAR_TOKEN_KEY && !!env.GOOGLE_CLIENT_ID;
}

calendarRoutes.get('/calendar/status', async (c) => {
  const link = await c.env.DB.prepare('SELECT * FROM calendar_links WHERE user_id = ?').bind(c.get('user').id).first<LinkRow>();
  const events = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM calendar_events WHERE user_id = ?').bind(c.get('user').id).first<{ n: number }>();
  return c.json({
    configured: configured(c.env),
    connected: !!link,
    lastSyncAt: link?.last_sync_at ?? null,
    lastError: link?.last_error ?? null,
    events: events?.n ?? 0,
  });
});

/** Starts the incremental consent for the calendar scope. A GET navigation; the state cookie guards the callback. */
calendarRoutes.get('/calendar/connect', async (c) => {
  if (!configured(c.env)) return c.redirect('/settings?calendar=unavailable');
  const user = c.get('user');
  const st: CalState = { s: randomToken(16), v: randomToken(48), n: randomToken(16), x: c.get('now') + TTL_MS, u: user.id };
  setCookie(c, COOKIE, await sign(c.env.SESSION_SECRET, b64urlEncode(enc.encode(JSON.stringify(st)))), {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/api/calendar',
    maxAge: TTL_MS / 1000,
  });
  const origin = new URL(c.req.url).origin;
  const u = new URL(GOOGLE_AUTH_URL);
  u.search = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${origin}/api/calendar/callback`,
    response_type: 'code',
    scope: `openid email ${GCAL_SCOPE}`,
    include_granted_scopes: 'true',
    access_type: 'offline',
    prompt: 'consent',
    login_hint: user.email,
    state: st.s,
    nonce: st.n,
    code_challenge: await pkceChallenge(st.v),
    code_challenge_method: 'S256',
  }).toString();
  return c.redirect(u.toString());
});

calendarRoutes.get('/calendar/callback', async (c) => {
  const user = c.get('user');
  const back = (status: string) => c.redirect(`/settings?calendar=${status}#calendar`);
  if (c.req.query('error')) return back('cancelled');
  const raw = getCookie(c, COOKIE);
  deleteCookie(c, COOKIE, { path: '/api/calendar', secure: true, httpOnly: true, sameSite: 'Lax' });
  const unsigned = raw ? await unsign(c.env.SESSION_SECRET, raw) : null;
  if (!unsigned) return back('expired');
  let st: CalState;
  try {
    st = JSON.parse(dec.decode(b64urlDecode(unsigned))) as CalState;
  } catch {
    return back('expired');
  }
  const code = c.req.query('code');
  if (!code || c.req.query('state') !== st.s || st.x < c.get('now') || st.u !== user.id) return back('expired');

  const origin = new URL(c.req.url).origin;
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${origin}/api/calendar/callback`,
      grant_type: 'authorization_code',
      code_verifier: st.v,
    }),
  });
  if (!res.ok) return back('google');
  const tok = (await res.json()) as { access_token?: string; refresh_token?: string; id_token?: string; scope?: string };
  if (!tok.refresh_token || !tok.id_token || !tok.access_token) return back('google');
  if (!(tok.scope ?? '').split(' ').includes(GCAL_SCOPE)) return back('scope');
  try {
    const claims = await verifyIdToken(tok.id_token, { clientId: c.env.GOOGLE_CLIENT_ID, nonce: st.n, now: c.get('now'), getKeys: (f) => fetchGoogleJwks(fetch, Date.now(), f) });
    // Must be the same Google account the user signs in with.
    const sameAccount = user.google_sub ? claims.sub === user.google_sub : claims.email.toLowerCase() === user.email.toLowerCase();
    if (!sameAccount) return back('account');
  } catch {
    return back('google');
  }

  // A dedicated calendar the app created (the calendar.app.created scope only reaches calendars the app made).
  const calRes = await fetch('https://www.googleapis.com/calendar/v3/calendars', {
    method: 'POST',
    headers: { authorization: `Bearer ${tok.access_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ summary: 'CoWork', description: 'Todos with a due time, synced from CoWork.', timeZone: user.timezone }),
  });
  if (!calRes.ok) return back('google');
  const calendarId = ((await calRes.json()) as { id: string }).id;

  const now = c.get('now');
  await c.env.DB.prepare(
    `INSERT INTO calendar_links (user_id, google_sub, calendar_id, refresh_token_enc, scope, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET google_sub = excluded.google_sub, calendar_id = excluded.calendar_id,
       refresh_token_enc = excluded.refresh_token_enc, scope = excluded.scope, updated_at = excluded.updated_at, last_error = NULL`,
  )
    .bind(user.id, user.google_sub ?? 'unknown', calendarId, await seal(c.env.CALENDAR_TOKEN_KEY, tok.refresh_token, user.id), tok.scope ?? GCAL_SCOPE, now, now)
    .run();
  await c.env.DB.prepare('DELETE FROM calendar_events WHERE user_id = ?').bind(user.id).run();
  clearTokenCache(user.id);
  defer(c, syncAllFor(c.env, user));
  return back('connected');
});

calendarRoutes.post('/calendar/sync', async (c) => {
  const user = c.get('user');
  const link = await c.env.DB.prepare('SELECT 1 AS ok FROM calendar_links WHERE user_id = ?').bind(user.id).first();
  if (!link) throw new HttpError(409, 'not_connected', 'Connect Google Calendar first');
  const n = await syncAllFor(c.env, user);
  return c.json({ synced: n });
});

/** Disconnect: delete the CoWork calendar, revoke the token at Google, and delete it here. */
calendarRoutes.post('/calendar/disconnect', async (c) => {
  const user = c.get('user');
  const link = await c.env.DB.prepare('SELECT * FROM calendar_links WHERE user_id = ?').bind(user.id).first<LinkRow>();
  if (!link) return c.json({ ok: true });
  try {
    const token = await accessToken(c.env, link);
    if (link.calendar_id) {
      await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(link.calendar_id)}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      });
    }
    // Revoke the refresh token itself (this also invalidates its access tokens).
    const refresh = await open(c.env.CALENDAR_TOKEN_KEY, link.refresh_token_enc, user.id);
    await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refresh }),
    });
  } catch (e) {
    // Already revoked or unreachable: still forget everything locally.
    console.warn('calendar disconnect', e instanceof Error ? e.message : e);
  }
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM calendar_events WHERE user_id = ?').bind(user.id),
    c.env.DB.prepare('DELETE FROM calendar_links WHERE user_id = ?').bind(user.id),
  ]);
  clearTokenCache(user.id);
  return c.json({ ok: true });
});
