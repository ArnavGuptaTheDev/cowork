// One-way Google Calendar sync: todos with a due time become events in a dedicated "CoWork" calendar.
// Private todos go to their owner's calendar only; shared todos also to the partner's (if connected).
import { ruleFromColumns } from '../../shared/recurrence';
import { addDays } from '../../shared/time';
import { placeholders, type TodoRow, type UserRow } from '../db';
import { sha256Hex } from '../crypto';
import { open } from '../secretbox';
import { getPartner, getUser } from './access';

export const GCAL_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';
const API = 'https://www.googleapis.com/calendar/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface GcalEnv {
  DB: D1Database;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  CALENDAR_TOKEN_KEY?: string;
}

export interface LinkRow {
  user_id: string;
  google_sub: string;
  calendar_id: string | null;
  refresh_token_enc: string;
  scope: string;
  last_sync_at: number | null;
  last_error: string | null;
}

interface MappingRow {
  todo_id: string;
  user_id: string;
  event_id: string;
  synced_hash: string | null;
  updated_at: number;
}

const tokenCache = new Map<string, { token: string; expires: number }>();

export function clearTokenCache(userId?: string) {
  if (userId) tokenCache.delete(userId);
  else tokenCache.clear();
}

/** Exchanges the stored (encrypted) refresh token for an access token. */
export async function accessToken(env: GcalEnv, link: LinkRow, fetchFn: typeof fetch = fetch): Promise<string> {
  const hit = tokenCache.get(link.user_id);
  if (hit && hit.expires > Date.now() + 60_000) return hit.token;
  const refresh = await open(env.CALENDAR_TOKEN_KEY, link.refresh_token_enc, link.user_id);
  const res = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
    }),
  });
  if (!res.ok) {
    const err = res.status === 400 || res.status === 401 ? 'Google access was revoked. Reconnect in Settings' : `Token refresh failed (${res.status})`;
    await env.DB.prepare('UPDATE calendar_links SET last_error = ?, updated_at = ? WHERE user_id = ?').bind(err, Date.now(), link.user_id).run();
    throw new Error(err);
  }
  const body = (await res.json()) as { access_token: string; expires_in?: number };
  tokenCache.set(link.user_id, { token: body.access_token, expires: Date.now() + (body.expires_in ?? 3600) * 1000 });
  return body.access_token;
}

async function gapi(env: GcalEnv, link: LinkRow, method: string, path: string, body: unknown, fetchFn: typeof fetch) {
  const token = await accessToken(env, link, fetchFn);
  return fetchFn(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** RRULE matching the app's recurrence. "Monthly on the 31st" means the month's last day, as in the app. */
export function rrule(t: Pick<TodoRow, 'recurrence' | 'recurrence_weekdays' | 'recurrence_month_day' | 'end_date'>): string | null {
  const r = ruleFromColumns(t);
  let rule: string;
  if (r.type === 'none') return null;
  if (r.type === 'daily') rule = 'RRULE:FREQ=DAILY';
  else if (r.type === 'weekly') rule = `RRULE:FREQ=WEEKLY;BYDAY=${r.weekdays.map((d) => BYDAY[d]).join(',')}`;
  else if (r.monthDay <= 28) rule = `RRULE:FREQ=MONTHLY;BYMONTHDAY=${r.monthDay}`;
  else {
    // Clamp to the last day of short months: the last existing day out of 28..monthDay.
    const days = [];
    for (let d = 28; d <= r.monthDay; d++) days.push(d);
    rule = `RRULE:FREQ=MONTHLY;BYMONTHDAY=${days.join(',')};BYSETPOS=-1`;
  }
  if (t.end_date) rule += `;UNTIL=${t.end_date.replace(/-/g, '')}T235959Z`;
  return rule;
}

function plusMinutes(date: string, time: string, minutes: number): { date: string; time: string } {
  const [h, m] = time.split(':').map(Number) as [number, number];
  const total = h * 60 + m + minutes;
  const day = Math.floor(total / 1440);
  const rem = total % 1440;
  return { date: addDays(date, day), time: `${String(Math.floor(rem / 60)).padStart(2, '0')}:${String(rem % 60).padStart(2, '0')}` };
}

/** The Google event for a todo, or null when it shouldn't have one (no due time). */
export function eventBody(t: TodoRow, timeZone: string, done: boolean) {
  if (!t.due_time) return null;
  const end = plusMinutes(t.start_date, t.due_time, 30);
  const rule = rrule(t);
  return {
    summary: `${done ? '✓ ' : ''}${t.title}`,
    description: t.notes ? `${t.notes}\n\nFrom CoWork` : 'From CoWork',
    start: { dateTime: `${t.start_date}T${t.due_time}:00`, timeZone },
    end: { dateTime: `${end.date}T${end.time}:00`, timeZone },
    ...(rule ? { recurrence: [rule] } : {}),
    // CoWork sends its own reminders; don't double up with calendar alerts.
    reminders: { useDefault: false, overrides: [] as unknown[] },
    extendedProperties: { private: { coworkTodoId: t.id } },
    transparency: 'transparent',
  };
}

async function deleteEvent(env: GcalEnv, link: LinkRow, eventId: string, fetchFn: typeof fetch) {
  if (!link.calendar_id) return;
  const res = await gapi(env, link, 'DELETE', `/calendars/${encodeURIComponent(link.calendar_id)}/events/${encodeURIComponent(eventId)}`, undefined, fetchFn);
  if (!res.ok && res.status !== 404 && res.status !== 410) throw new Error(`Calendar delete failed (${res.status})`);
}

async function linksFor(db: D1Database, userIds: string[]): Promise<LinkRow[]> {
  if (!userIds.length) return [];
  const { results } = await db
    .prepare(`SELECT * FROM calendar_links WHERE user_id IN (${placeholders(userIds.length)})`)
    .bind(...userIds)
    .all<LinkRow>();
  return results;
}

/** Deletes events for mappings captured before a todo was deleted. */
export async function deleteMappedEvents(env: GcalEnv, mappings: MappingRow[], fetchFn: typeof fetch = fetch) {
  const links = await linksFor(env.DB, [...new Set(mappings.map((m) => m.user_id))]);
  for (const m of mappings) {
    const link = links.find((l) => l.user_id === m.user_id);
    if (link && m.event_id) await deleteEvent(env, link, m.event_id, fetchFn).catch((e) => console.warn('gcal delete', e));
  }
}

export async function mappingsForTodo(db: D1Database, todoId: string): Promise<MappingRow[]> {
  const { results } = await db.prepare('SELECT * FROM calendar_events WHERE todo_id = ?').bind(todoId).all<MappingRow>();
  return results;
}

/**
 * Brings every calendar's copy of one todo in line with the todo: create, update, or remove events,
 * and never leave a private todo in anyone's calendar but its owner's.
 */
export async function syncTodo(env: GcalEnv, todoId: string, fetchFn: typeof fetch = fetch): Promise<void> {
  const t = await env.DB.prepare(
    `SELECT t.*, p.is_private AS project_private, p.is_shared AS project_shared
       FROM todos t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = ?`,
  )
    .bind(todoId)
    .first<TodoRow & { project_private: number | null; project_shared: number | null }>();
  if (!t) return;
  const owner = await getUser(env.DB, t.user_id);
  if (!owner) return;
  const partner = await getPartner(env.DB, owner);
  const mappings = await mappingsForTodo(env.DB, todoId);
  const links = await linksFor(env.DB, [owner.id, ...(partner ? [partner.id] : []), ...mappings.map((m) => m.user_id)]);
  if (!links.length) {
    if (mappings.length) await env.DB.prepare('DELETE FROM calendar_events WHERE todo_id = ?').bind(todoId).run();
    return;
  }
  const isPrivate = t.is_private === 1 || t.project_private === 1;
  const shared = (t.is_shared === 1 || t.project_shared === 1) && !isPrivate;
  const entitled = new Set([owner.id, ...(partner && shared ? [partner.id] : [])]);
  const last = await env.DB.prepare('SELECT status FROM todo_instances WHERE todo_id = ? ORDER BY date DESC LIMIT 1')
    .bind(todoId)
    .first<{ status: string }>();
  const body = eventBody(t, owner.timezone, t.recurrence === 'none' && last?.status === 'done');
  const hash = body ? await sha256Hex(JSON.stringify(body)) : null;

  for (const link of links) {
    const map = mappings.find((m) => m.user_id === link.user_id);
    try {
      if (!link.calendar_id) continue;
      const cal = `/calendars/${encodeURIComponent(link.calendar_id)}/events`;
      if (!body || !entitled.has(link.user_id)) {
        if (map) {
          await deleteEvent(env, link, map.event_id, fetchFn);
          await env.DB.prepare('DELETE FROM calendar_events WHERE todo_id = ? AND user_id = ?').bind(todoId, link.user_id).run();
        }
        continue;
      }
      if (map && map.synced_hash === hash) continue;
      // An empty event id means another sync is creating this event right now: leave it to that one
      // (unless that claim is stale, e.g. the other sync crashed).
      if (map && !map.event_id && Date.now() - map.updated_at < 60_000) continue;
      let eventId: string | null = null;
      if (!map) {
        // Claim the mapping first so two concurrent syncs can't both create an event.
        const claim = await env.DB.prepare(
          `INSERT OR IGNORE INTO calendar_events (todo_id, user_id, event_id, synced_hash, updated_at) VALUES (?, ?, '', NULL, ?)`,
        )
          .bind(todoId, link.user_id, Date.now())
          .run();
        if (!claim.meta.changes) continue;
      }
      if (map) {
        const res = await gapi(env, link, 'PUT', `${cal}/${encodeURIComponent(map.event_id)}`, body, fetchFn);
        if (res.ok) eventId = map.event_id;
        else if (res.status !== 404 && res.status !== 410) throw new Error(`Calendar update failed (${res.status})`);
      }
      if (!eventId) {
        const res = await gapi(env, link, 'POST', cal, body, fetchFn);
        if (!res.ok) {
          await env.DB.prepare(`DELETE FROM calendar_events WHERE todo_id = ? AND user_id = ? AND event_id = ''`).bind(todoId, link.user_id).run();
          throw new Error(`Calendar insert failed (${res.status})`);
        }
        eventId = ((await res.json()) as { id: string }).id;
      }
      await env.DB.prepare(
        `INSERT INTO calendar_events (todo_id, user_id, event_id, synced_hash, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(todo_id, user_id) DO UPDATE SET event_id = excluded.event_id, synced_hash = excluded.synced_hash, updated_at = excluded.updated_at`,
      )
        .bind(todoId, link.user_id, eventId, hash, Date.now())
        .run();
      await env.DB.prepare('UPDATE calendar_links SET last_sync_at = ?, last_error = NULL WHERE user_id = ?').bind(Date.now(), link.user_id).run();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await env.DB.prepare('UPDATE calendar_links SET last_error = ? WHERE user_id = ?').bind(msg.slice(0, 200), link.user_id).run();
    }
  }
  // Mappings for people who have since disconnected: nothing to call, just forget them.
  for (const m of mappings) {
    if (!links.some((l) => l.user_id === m.user_id)) {
      await env.DB.prepare('DELETE FROM calendar_events WHERE todo_id = ? AND user_id = ?').bind(todoId, m.user_id).run();
    }
  }
}

/** Syncs every todo of a user (and their partner's shared ones). Used after connecting and by "Resync". */
export async function syncAllFor(env: GcalEnv, user: UserRow, fetchFn: typeof fetch = fetch): Promise<number> {
  const partner = await getPartner(env.DB, user);
  const { results } = await env.DB.prepare(
    `SELECT t.id FROM todos t LEFT JOIN projects p ON p.id = t.project_id
      WHERE t.user_id = ? OR (t.user_id = ? AND (t.is_shared = 1 OR COALESCE(p.is_shared, 0) = 1))
         OR t.id IN (SELECT todo_id FROM calendar_events WHERE user_id = ?)
      LIMIT 1000`,
  )
    .bind(user.id, partner?.id ?? '', user.id)
    .all<{ id: string }>();
  for (const r of results) await syncTodo(env, r.id, fetchFn);
  return results.length;
}

/**
 * Cron safety net: events in someone else's calendar for a todo they may no longer see
 * (unshared, made private, unpaired) are removed.
 */
export async function reconcileCalendars(env: GcalEnv, fetchFn: typeof fetch = fetch): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT ce.todo_id, ce.user_id, ce.event_id, ce.synced_hash, ce.updated_at
       FROM calendar_events ce
       JOIN todos t ON t.id = ce.todo_id
       JOIN users owner ON owner.id = t.user_id
       LEFT JOIN projects p ON p.id = t.project_id
      WHERE ce.user_id != t.user_id
        AND NOT (owner.partner_id = ce.user_id
                 AND EXISTS (SELECT 1 FROM users u WHERE u.id = ce.user_id AND u.partner_id = owner.id)
                 AND (t.is_shared = 1 OR COALESCE(p.is_shared, 0) = 1)
                 AND t.is_private = 0 AND COALESCE(p.is_private, 0) = 0)`,
  ).all<MappingRow>();
  if (!results.length) return 0;
  await deleteMappedEvents(env, results, fetchFn);
  for (const m of results) {
    await env.DB.prepare('DELETE FROM calendar_events WHERE todo_id = ? AND user_id = ?').bind(m.todo_id, m.user_id).run();
  }
  return results.length;
}
