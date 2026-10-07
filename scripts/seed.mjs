// Seeds the LOCAL D1 database with two paired demo users and some projects, todos, habits and a suggestion.
//
//   npm run db:seed -- you@example.com partner@example.com
//
// Sign in as either email (Google, or /api/auth/dev-login?email=... with DEV_LOGIN=true) and the seeded
// account is picked up by email. The first email should be your SUPER_ADMIN_EMAIL; the second is invited.
// Running it again wipes and recreates the demo data for those two emails.
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const [a = 'you@example.com', b = 'partner@example.com'] = process.argv.slice(2);
const TZ = 'Asia/Kolkata';
const now = Date.now();
const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
const addDays = (d, n) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const yesterday = addDays(today, -1);
const q = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

const sql = [];
const ins = (table, row) => sql.push(`INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.values(row).map(q).join(', ')});`);

sql.push(`DELETE FROM users WHERE email IN (${q(a.toLowerCase())}, ${q(b.toLowerCase())});`);
sql.push(`DELETE FROM invites WHERE email = ${q(b.toLowerCase())};`);

const ua = randomUUID();
const ub = randomUUID();
ins('users', { id: ua, email: a.toLowerCase(), name: 'Arnav', timezone: TZ, created_at: now });
ins('users', { id: ub, email: b.toLowerCase(), name: 'Partner', timezone: TZ, created_at: now });
sql.push(`UPDATE users SET partner_id = ${q(ub)}, paired_at = ${now} WHERE id = ${q(ua)};`);
sql.push(`UPDATE users SET partner_id = ${q(ua)}, paired_at = ${now} WHERE id = ${q(ub)};`);
ins('invites', { email: b.toLowerCase(), invited_by: ua, created_at: now });

function project(user, name, category, color, extra = {}) {
  const id = randomUUID();
  ins('projects', { id, user_id: user, name, description: extra.description ?? '', category, color, is_private: extra.private ? 1 : 0, created_at: now, updated_at: now });
  return id;
}

function todo(user, title, opts = {}) {
  const id = randomUUID();
  const rec = opts.recurrence ?? 'none';
  ins('todos', {
    id,
    user_id: user,
    project_id: opts.project ?? null,
    title,
    notes: opts.notes ?? '',
    category: opts.category ?? 'personal',
    start_date: opts.start ?? today,
    due_time: opts.due ?? null,
    reminder_time: opts.remind ?? null,
    recurrence: rec,
    recurrence_weekdays: opts.weekdays ?? null,
    recurrence_month_day: opts.monthDay ?? null,
    is_private: opts.private ? 1 : 0,
    materialized_through: rec === 'none' ? null : yesterday,
    created_at: now,
    updated_at: now,
  });
  if (rec === 'none') {
    ins('todo_instances', { id: randomUUID(), todo_id: id, user_id: user, date: opts.start ?? today, status: opts.done ? 'done' : 'pending', completed_at: opts.done ? now : null, completed_on: opts.done ? today : null, created_at: now });
  }
  for (const [date, status] of opts.history ?? []) {
    ins('todo_instances', { id: randomUUID(), todo_id: id, user_id: user, date, status, completed_at: status === 'done' ? now : null, created_at: now });
  }
  return id;
}

const daily = (n, missEvery = 0) =>
  Array.from({ length: n }, (_, i) => [addDays(today, -(n - i)), missEvery && i % missEvery === missEvery - 1 ? 'missed' : 'done']);

// --- First user ---
const side = project(ua, 'CoWork (side project)', 'work', 'clay', { description: 'The app you are looking at.' });
const job = project(ua, 'Q4 launch', 'work', 'sky');
const gift = project(ua, 'Anniversary', 'personal', 'plum', { private: true });
todo(ua, 'Post project on LinkedIn', { project: side, category: 'work', due: '18:00', remind: '17:30', notes: 'Screenshots + a short write-up of the stack.' });
todo(ua, 'Write the README', { project: side, category: 'work', done: true });
todo(ua, 'Fix the flaky deploy step', { project: side, category: 'work', start: yesterday });
todo(ua, 'Standup', { project: job, category: 'work', recurrence: 'weekly', weekdays: '1,2,3,4,5', due: '10:00', remind: '09:50', start: addDays(today, -14), history: daily(10).filter(([d]) => { const w = new Date(`${d}T00:00:00Z`).getUTCDay(); return w > 0 && w < 6; }) });
todo(ua, 'Review launch checklist', { project: job, category: 'work', start: addDays(today, 2) });
todo(ua, 'Gym', { category: 'habit', recurrence: 'weekly', weekdays: '1,3,5', due: '07:00', remind: '06:30', start: addDays(today, -21), history: daily(21, 0).filter(([d]) => [1, 3, 5].includes(new Date(`${d}T00:00:00Z`).getUTCDay())) });
todo(ua, 'Read 20 pages', { category: 'habit', recurrence: 'daily', remind: '21:30', start: addDays(today, -12), history: daily(12, 5) });
todo(ua, 'Book the table', { project: gift, category: 'personal' });
todo(ua, 'Pay rent', { category: 'personal', recurrence: 'monthly', monthDay: 1, start: addDays(today, -40) });

// --- Partner ---
const pb = project(ub, 'Portfolio refresh', 'work', 'sage');
todo(ub, 'Pick three case studies', { project: pb, category: 'work', done: true });
todo(ub, 'Draft the about page', { project: pb, category: 'work' });
todo(ub, 'Yoga', { category: 'habit', recurrence: 'daily', remind: '07:15', start: addDays(today, -9), history: daily(9) });
todo(ub, 'Call grandma', { category: 'personal', due: '19:00' });
todo(ub, 'Birthday surprise planning', { category: 'personal', private: true });

ins('suggestions', {
  id: randomUUID(),
  from_user_id: ub,
  to_user_id: ua,
  title: 'Go for a sunset walk together',
  notes: 'No phones!',
  category: 'personal',
  start_date: today,
  due_time: '18:30',
  recurrence: 'none',
  status: 'pending',
  created_at: now,
});

mkdirSync('.wrangler', { recursive: true });
writeFileSync('.wrangler/seed.sql', sql.join('\n') + '\n');
execSync('npx wrangler d1 execute cowork --local --file=.wrangler/seed.sql', { stdio: 'inherit' });
console.log(`\nSeeded ${a} and ${b} (paired). ${b} is invited; make sure ${a} is your SUPER_ADMIN_EMAIL or invite it too.`);
