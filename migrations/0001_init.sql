-- CoWork initial schema.
-- Conventions: ids are UUID text; *_at columns are UTC epoch milliseconds;
-- *_date columns are local calendar dates (YYYY-MM-DD) in the owning user's time zone;
-- *_time columns are local wall-clock times (HH:MM).

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  google_sub    TEXT UNIQUE,
  name          TEXT NOT NULL DEFAULT '',
  avatar_url    TEXT,
  timezone      TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  partner_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  paired_at     INTEGER,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);
-- One partner per user: nobody can be the partner of two people.
CREATE UNIQUE INDEX users_partner_unique ON users(partner_id) WHERE partner_id IS NOT NULL;

CREATE TABLE invites (
  email      TEXT PRIMARY KEY COLLATE NOCASE,
  invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash   TEXT PRIMARY KEY,           -- HMAC-SHA256(SESSION_SECRET, token), hex
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  user_agent   TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expires ON sessions(expires_at);

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL CHECK (category IN ('personal', 'work', 'habit')),
  color       TEXT NOT NULL DEFAULT 'clay',
  is_private  INTEGER NOT NULL DEFAULT 0 CHECK (is_private IN (0, 1)),
  archived_at INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX projects_user ON projects(user_id, archived_at);

CREATE TABLE todos (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id           TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title                TEXT NOT NULL,
  notes                TEXT NOT NULL DEFAULT '',
  category             TEXT NOT NULL CHECK (category IN ('personal', 'work', 'habit')),
  start_date           TEXT NOT NULL,      -- the day of a one-off todo; first day of a recurring one
  end_date             TEXT,               -- optional last day of a recurring todo
  due_time             TEXT,
  reminder_time        TEXT,
  recurrence           TEXT NOT NULL DEFAULT 'none' CHECK (recurrence IN ('none', 'daily', 'weekly', 'monthly')),
  recurrence_weekdays  TEXT,               -- weekly: comma separated 0-6 (0 = Sunday)
  recurrence_month_day INTEGER CHECK (recurrence_month_day BETWEEN 1 AND 31),
  is_private           INTEGER NOT NULL DEFAULT 0 CHECK (is_private IN (0, 1)),
  suggested_by         TEXT REFERENCES users(id) ON DELETE SET NULL,
  materialized_through TEXT,               -- recurring: last local date instances were generated for
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE INDEX todos_user ON todos(user_id, recurrence);
CREATE INDEX todos_project ON todos(project_id);

CREATE TABLE todo_instances (
  id           TEXT PRIMARY KEY,
  todo_id      TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'missed')),
  completed_at INTEGER,
  completed_on TEXT,                       -- local date the user ticked it off
  note         TEXT NOT NULL DEFAULT '',
  reminder_at  INTEGER,
  reminded_at  INTEGER,
  created_at   INTEGER NOT NULL,
  UNIQUE (todo_id, date)
);
CREATE INDEX instances_user_date ON todo_instances(user_id, date);
CREATE INDEX instances_user_status ON todo_instances(user_id, status);
CREATE INDEX instances_due_reminders ON todo_instances(reminder_at)
  WHERE status = 'pending' AND reminded_at IS NULL AND reminder_at IS NOT NULL;

CREATE TABLE suggestions (
  id                   TEXT PRIMARY KEY,
  from_user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title                TEXT NOT NULL,
  notes                TEXT NOT NULL DEFAULT '',
  category             TEXT NOT NULL CHECK (category IN ('personal', 'work', 'habit')),
  start_date           TEXT NOT NULL,
  end_date             TEXT,
  due_time             TEXT,
  reminder_time        TEXT,
  recurrence           TEXT NOT NULL DEFAULT 'none' CHECK (recurrence IN ('none', 'daily', 'weekly', 'monthly')),
  recurrence_weekdays  TEXT,
  recurrence_month_day INTEGER CHECK (recurrence_month_day BETWEEN 1 AND 31),
  status               TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'denied', 'withdrawn')),
  reason               TEXT,
  todo_id              TEXT REFERENCES todos(id) ON DELETE SET NULL,
  created_at           INTEGER NOT NULL,
  responded_at         INTEGER
);
CREATE INDEX suggestions_to ON suggestions(to_user_id, status);
CREATE INDEX suggestions_from ON suggestions(from_user_id, status);

CREATE TABLE photos (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  todo_id       TEXT REFERENCES todos(id) ON DELETE CASCADE,
  instance_id   TEXT REFERENCES todo_instances(id) ON DELETE CASCADE,
  suggestion_id TEXT REFERENCES suggestions(id) ON DELETE SET NULL,
  r2_key        TEXT NOT NULL UNIQUE,
  content_type  TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  width         INTEGER,
  height        INTEGER,
  created_at    INTEGER NOT NULL,
  CHECK (todo_id IS NOT NULL OR suggestion_id IS NOT NULL)
);
CREATE INDEX photos_todo ON photos(todo_id);
CREATE INDEX photos_instance ON photos(instance_id);
CREATE INDEX photos_suggestion ON photos(suggestion_id);

CREATE TABLE pairing_codes (
  code_hash  TEXT PRIMARY KEY,             -- SHA-256 of the code, hex
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX pairing_codes_user ON pairing_codes(user_id);

CREATE TABLE push_subscriptions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint        TEXT NOT NULL UNIQUE,
  p256dh          TEXT NOT NULL,
  auth            TEXT NOT NULL,
  user_agent      TEXT,
  created_at      INTEGER NOT NULL,
  last_success_at INTEGER
);
CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);

-- De-duplicates one-shot notifications (e.g. "partner finished everything today").
CREATE TABLE notification_log (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  ref        TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, ref)
);
