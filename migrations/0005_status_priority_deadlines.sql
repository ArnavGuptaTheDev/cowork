-- Statuses (with blockers), priority, deadlines, board order, and per-instance overrides for tomorrow's habits.
-- Safe on existing data: new tables; new columns are nullable or defaulted; everything is backfilled.

-- Statuses are rows, per user. App logic keys off `kind`, never `name`.
CREATE TABLE statuses (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT 'ink',
  kind        TEXT NOT NULL CHECK (kind IN ('todo', 'active', 'blocked', 'done')),
  position    REAL NOT NULL,
  -- The status a kind maps to by default (ticking the checkbox -> default 'done', unticking -> default 'todo').
  is_default  INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  archived_at INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX statuses_user ON statuses(user_id, position);

-- Seed the four defaults for every existing user (ids are random v4 UUIDs).
INSERT INTO statuses (id, user_id, name, color, kind, position, is_default, created_at, updated_at)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-'
    || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
  u.id, d.name, d.color, d.kind, d.position, 1,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM users u
CROSS JOIN (
  SELECT 'To do' AS name, 'ink' AS color, 'todo' AS kind, 1000.0 AS position
  UNION ALL SELECT 'In progress', 'sky', 'active', 2000.0
  UNION ALL SELECT 'Blocked', 'clay', 'blocked', 3000.0
  UNION ALL SELECT 'Done', 'sage', 'done', 4000.0
) d;

-- Status per instance (recurring todos: per occurrence). Completed -> Done, everything else -> To do.
ALTER TABLE todo_instances ADD COLUMN status_id TEXT REFERENCES statuses(id) ON DELETE SET NULL;
UPDATE todo_instances SET status_id = (
  SELECT s.id FROM statuses s
   WHERE s.user_id = todo_instances.user_id AND s.is_default = 1
     AND s.kind = CASE WHEN todo_instances.status = 'done' THEN 'done' ELSE 'todo' END
);
CREATE INDEX instances_status ON todo_instances(status_id);

-- Tomorrow's habits: skip one occurrence (doesn't count, doesn't break streaks) or move it to another time.
ALTER TABLE todo_instances ADD COLUMN skipped INTEGER NOT NULL DEFAULT 0 CHECK (skipped IN (0, 1));
ALTER TABLE todo_instances ADD COLUMN override_time TEXT;

-- Blockers: history of what a todo was waiting on. An open blocker has resolved_at NULL.
CREATE TABLE blockers (
  id          TEXT PRIMARY KEY,
  todo_id     TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  instance_id TEXT REFERENCES todo_instances(id) ON DELETE CASCADE,
  note        TEXT NOT NULL,
  blocked_at  INTEGER NOT NULL,
  blocked_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at INTEGER,
  resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX blockers_todo ON blockers(todo_id, blocked_at);
CREATE UNIQUE INDEX blockers_open ON blockers(instance_id) WHERE resolved_at IS NULL;

-- Priority 1 Low, 2 Medium (default), 3 High, 4 Urgent.
ALTER TABLE todos ADD COLUMN priority INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 4);

-- Deadlines: when it must be finished (separate from start_date, the scheduled day).
ALTER TABLE todos ADD COLUMN deadline_date TEXT;
ALTER TABLE todos ADD COLUMN deadline_time TEXT;
ALTER TABLE projects ADD COLUMN deadline_date TEXT;
ALTER TABLE projects ADD COLUMN deadline_time TEXT;
CREATE INDEX todos_deadline ON todos(user_id, deadline_date);

-- Manual order (fractional index keys, byte-ordered). Backfill in creation order:
-- 'h' + 8 hex digits of creation seconds is a valid key; a random suffix ending in 'V' breaks ties.
ALTER TABLE todos ADD COLUMN position TEXT;
UPDATE todos SET position = 'h' || printf('%08x', created_at / 1000) || lower(hex(randomblob(2))) || 'V';
CREATE INDEX todos_position ON todos(user_id, position);
